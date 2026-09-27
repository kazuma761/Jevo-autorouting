import { describe, expect, it } from "vite-plus/test";

import { chatToAnthropicStream } from "./chat-anthropic-stream";
import type { Usage } from "./pricing";

async function run(
  chunks: unknown[],
  options: Parameters<typeof chatToAnthropicStream>[1] = {},
): Promise<Array<Record<string, unknown>>> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const text = await new Response(
    source.pipeThrough(chatToAnthropicStream("claude-opus-4-8-medium", options)),
  ).text();
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data?.slice(6) ?? "{}") as Record<string, unknown>;
    });
}

const delta = (value: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: value, finish_reason: finish }],
});

describe("chatToAnthropicStream", () => {
  it("emits thinking, text, and a closing message_delta with usage", async () => {
    let finished: Usage | undefined;
    const events = await run(
      [
        delta({ role: "assistant", content: "" }),
        delta({ reasoning_content: "Let me think" }),
        delta({ reasoning_content: " harder." }),
        delta({ content: "pong" }),
        delta({}, "stop"),
        { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      ],
      {
        usage: () => ({ input: 4, output: 3, cacheRead: 6, cacheWrite: 2 }),
        onFinish: (usage) => {
          finished = usage;
        },
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]).toMatchObject({ index: 0, content_block: { type: "thinking" } });
    expect(events[2]).toMatchObject({
      delta: { type: "thinking_delta", thinking: "Let me think" },
    });
    expect(events[5]).toMatchObject({ index: 1, content_block: { type: "text" } });
    expect(events[6]).toMatchObject({ delta: { type: "text_delta", text: "pong" } });
    expect(events[8]).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 2,
      },
    });
    expect(finished).toEqual({ input: 4, output: 3, cacheRead: 6, cacheWrite: 2 });
  });

  it("streams tool calls as tool_use blocks with input_json_delta", async () => {
    const events = await run([
      delta({ content: "Checking." }),
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      delta({}, "tool_calls"),
    ]);
    const start = events.find(
      (event) =>
        event.type === "content_block_start" &&
        (event.content_block as Record<string, unknown>).type === "tool_use",
    );
    expect(start).toMatchObject({
      index: 1,
      content_block: { type: "tool_use", id: "call_abc", name: "get_weather", input: {} },
    });
    const json = events
      .filter(
        (event) =>
          event.type === "content_block_delta" &&
          (event.delta as Record<string, unknown>).type === "input_json_delta",
      )
      .map((event) => (event.delta as Record<string, unknown>).partial_json)
      .join("");
    expect(JSON.parse(json)).toEqual({ city: "Paris" });
    const stop = events.find((event) => event.type === "message_delta");
    expect(stop).toMatchObject({ delta: { stop_reason: "tool_use" } });
    // Every opened block is closed before message_delta.
    const opened = events.filter((event) => event.type === "content_block_start").length;
    const closed = events.filter((event) => event.type === "content_block_stop").length;
    expect(closed).toBe(opened);
  });

  it("keeps parallel tool-call blocks contiguous when deltas interleave", async () => {
    const events = await run([
      delta({
        tool_calls: [
          { index: 0, id: "call_a", function: { name: "a", arguments: '{"a":' } },
          { index: 1, id: "call_b", function: { name: "b", arguments: '{"b":' } },
        ],
      }),
      delta({
        tool_calls: [
          { index: 1, function: { arguments: "2}" } },
          { index: 0, function: { arguments: "1}" } },
        ],
      }),
      delta({}, "tool_calls"),
    ]);
    const starts = events.filter((event) => event.type === "content_block_start");
    expect(starts.map((event) => (event.content_block as Record<string, unknown>).name)).toEqual([
      "a",
      "b",
    ]);
    const firstStop = events.findIndex((event) => event.type === "content_block_stop");
    const secondStart = events.findIndex(
      (event, index) => index > 0 && event.type === "content_block_start" && event.index === 1,
    );
    expect(firstStop).toBeLessThan(secondStart);
    const args = events
      .filter((event) => event.type === "content_block_delta")
      .map((event) => ({
        index: event.index,
        delta: (event.delta as Record<string, unknown>).partial_json,
      }));
    expect(args).toEqual([
      { index: 0, delta: '{"a":' },
      { index: 0, delta: "1}" },
      { index: 1, delta: '{"b":' },
      { index: 1, delta: "2}" },
    ]);
  });

  it("falls back to inclusive chat usage split into uncached and cached input", async () => {
    const events = await run([
      delta({ content: "hi" }),
      {
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    ]);
    expect(events.find((event) => event.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "max_tokens" },
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 },
    });
  });

  it("turns an upstream error chunk into an Anthropic error event", async () => {
    const events = await run([
      delta({ content: "partial" }),
      { error: { message: "rate limited", type: "rate_limit_error" } },
    ]);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: { message: "rate limited", type: "rate_limit_error" },
    });
    expect(events.some((event) => event.type === "message_stop")).toBe(false);
  });
});
