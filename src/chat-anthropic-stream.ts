import { anthropicToolId } from "./anthropic";
import type { Usage } from "./pricing";
import { splitSseEvents } from "./responses";

/**
 * OpenAI Chat Completions SSE → Anthropic Messages SSE, for Anthropic clients (Claude Code)
 * served by a Chat-shaped upstream that must stream (Devin always streams).
 *
 * Emits `message_start`, one content block per text run / thinking run (`reasoning_content`) /
 * tool call, `message_delta` with the stop reason and usage, then `message_stop`. An upstream
 * `{ error }` chunk becomes an Anthropic `error` event.
 */

const STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

export interface ChatToAnthropicStreamOptions {
  /**
   * Exact usage for the turn, read at flush time. Wins over the usage the chat chunks carry —
   * those have no cache-write field, so a caller holding exclusive upstream usage passes it here.
   */
  usage?: () => Usage | undefined;
  /** Called once with the usage reported to the client. */
  onFinish?: (usage: Usage) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** OpenAI usage is inclusive (`prompt_tokens` counts cached tokens); Anthropic's is not. */
function usageFromChat(raw: unknown): Usage {
  const usage = asRecord(raw);
  const cached = number(asRecord(usage.prompt_tokens_details).cached_tokens);
  return {
    input: Math.max(0, number(usage.prompt_tokens) - cached),
    output: number(usage.completion_tokens),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

function reasoningText(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  return "";
}

type OpenBlock = { kind: "text" | "thinking"; index: number };

interface PendingTool {
  id: string;
  name: string;
  /** Keep chunks split exactly as they arrived; emit them once the tool block opens. */
  args: string[];
}

export function chatToAnthropicStream(
  model: string,
  options: ChatToAnthropicStreamOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let buffer = "";
  let started = false;
  let nextIndex = 0;
  let open: OpenBlock | undefined;
  /** Chat tool index → pending call. Chat may interleave deltas for parallel tools; Anthropic
   * requires each content block to remain contiguous, so tool deltas are flushed in order. */
  const pendingTools = new Map<number, PendingTool>();
  let toolCount = 0;
  let finishReason: string | undefined;
  let chatUsage: Usage | undefined;
  let failure: { message: string; type: string } | undefined;

  const emit = (
    payload: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const type = typeof payload.type === "string" ? payload.type : "message";
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  };

  const start = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (started) return;
    started = true;
    emit(
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      controller,
    );
  };

  const close = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (!open) return;
    emit({ type: "content_block_stop", index: open.index }, controller);
    open = undefined;
  };

  const openBlock = (
    kind: "text" | "thinking",
    controller: TransformStreamDefaultController<Uint8Array>,
  ): number => {
    if (open?.kind === kind) return open.index;
    close(controller);
    const index = nextIndex++;
    open = { kind, index };
    emit(
      {
        type: "content_block_start",
        index,
        content_block:
          kind === "text"
            ? { type: "text", text: "" }
            : { type: "thinking", thinking: "", signature: "" },
      },
      controller,
    );
    return index;
  };

  const flushTools = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    close(controller);
    for (const [toolIndex, tool] of [...pendingTools].sort(([a], [b]) => a - b)) {
      const index = nextIndex++;
      emit(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: {},
          },
        },
        controller,
      );
      for (const argumentsDelta of tool.args) {
        emit(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: argumentsDelta },
          },
          controller,
        );
      }
      emit({ type: "content_block_stop", index }, controller);
      pendingTools.delete(toolIndex);
    }
  };

  const handle = (
    chunk: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (typeof chunk.error === "object" && chunk.error !== null) {
      const error = asRecord(chunk.error);
      failure = {
        message: typeof error.message === "string" ? error.message : "upstream error",
        type: typeof error.type === "string" ? error.type : "api_error",
      };
      return;
    }
    start(controller);
    if (chunk.usage) chatUsage = usageFromChat(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      const delta = asRecord(choice.delta);

      const thinking = reasoningText(delta);
      if (thinking.length > 0) {
        const index = openBlock("thinking", controller);
        emit(
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking },
          },
          controller,
        );
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        const index = openBlock("text", controller);
        emit(
          {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: delta.content },
          },
          controller,
        );
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of toolCalls) {
        const call = asRecord(rawCall);
        const toolIndex = typeof call.index === "number" ? call.index : 0;
        const fn = asRecord(call.function);
        let tool = pendingTools.get(toolIndex);
        if (!tool) {
          const rawId = typeof call.id === "string" && call.id.length > 0 ? call.id : "";
          tool = {
            id: rawId ? anthropicToolId(rawId) : `toolu_${crypto.randomUUID().slice(0, 8)}`,
            name: typeof fn.name === "string" ? fn.name : "",
            args: [],
          };
          pendingTools.set(toolIndex, tool);
          toolCount += 1;
        }
        if (typeof fn.name === "string" && fn.name.length > 0) tool.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          tool.args.push(fn.arguments);
        }
      }

      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason;
      }
    }
  };

  const consume = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    buffer += text;
    const { events, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const event of events) handle(event, controller);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(input, controller) {
      consume(decoder.decode(input, { stream: true }), controller);
    },
    flush(controller) {
      consume(`${decoder.decode()}\n\n`, controller);
      const usage = options.usage?.() ??
        chatUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      if (failure && !started) {
        emit({ type: "error", error: failure }, controller);
        options.onFinish?.(usage);
        return;
      }
      start(controller);
      flushTools(controller);
      if (failure) {
        emit({ type: "error", error: failure }, controller);
        options.onFinish?.(usage);
        return;
      }
      const stop =
        toolCount > 0 && (finishReason === undefined || finishReason === "stop")
          ? "tool_use"
          : (STOP_REASONS[finishReason ?? "stop"] ?? "end_turn");
      emit(
        {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheWrite,
          },
        },
        controller,
      );
      emit({ type: "message_stop" }, controller);
      options.onFinish?.(usage);
    },
  });
}
