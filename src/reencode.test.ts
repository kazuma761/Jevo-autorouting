import { describe, expect, it } from "vite-plus/test";

import {
  applyDecisions,
  collectToolCalls,
  compact,
  normalizeTranscript,
  reencodeMessages,
} from "./compaction";

describe("reencodeMessages", () => {
  it("rewrites an OpenAI body without touching any other field", () => {
    const body = {
      model: "gpt-x",
      stream: true,
      tools: [{ type: "function", function: { name: "Read" } }],
      messages: [
        { role: "user", content: "fix it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "contents" },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    expect(out.model).toBe("gpt-x");
    expect(out.stream).toBe(true);
    expect(out.tools).toEqual(body.tools);
    expect(out.messages).toHaveLength(3);
    expect((out.messages as Array<Record<string, unknown>>)[2]).toEqual(body.messages[2]);
  });

  it("round-trips an Anthropic body into content blocks", () => {
    const body = {
      model: "claude-x",
      messages: [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "contents" }],
        },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    const messages = out.messages as Array<{ content: Array<{ type: string }> }>;
    expect(messages[0]?.content[0]?.type).toBe("text");
    expect(messages[1]?.content[0]?.type).toBe("tool_use");
    expect(messages[2]?.content[0]?.type).toBe("tool_result");
  });

  it("uses `input` for the Responses wire", () => {
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
        { type: "function_call", name: "Read", call_id: "c1", arguments: '{"file_path":"a.ts"}' },
        { type: "function_call_output", call_id: "c1", output: "contents" },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    expect(out.messages).toBeUndefined();
    expect(out.input).toHaveLength(3);
  });

  it("drops a tool result whose call was removed, so the pair is never split", () => {
    const body = {
      model: "gpt-x",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(500) },
      ],
    };
    const messages = normalizeTranscript(body);
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(
      messages,
      [
        {
          id: calls[0]!.id,
          tool: "Read",
          keepCall: 0,
          keepResult: 0,
          action: "drop_call",
          reason: "call_dropped",
        },
      ],
      calls,
      300,
    );
    const out = reencodeMessages(body, kept);
    const encoded = out.messages as Array<{ role: string; content: string }>;
    // The assistant message lost its only call and the tool result is gone with it.
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toEqual({ role: "user", content: "go" });
  });
});

describe("compaction over a re-encoded body", () => {
  it("preserves OpenAI and Anthropic multimodal blocks while changing only tool results", () => {
    const chat = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "large result" },
      ],
    };
    const chatMessages = normalizeTranscript(chat);
    const changed = chatMessages.map((message) =>
      message.toolResults?.length
        ? { ...message, toolResults: [{ ...message.toolResults[0]!, text: "short" }] }
        : message,
    );
    const out = reencodeMessages(chat, changed);
    expect((out.messages as unknown[])[0]).toEqual(chat.messages[0]);
    expect((out.messages as unknown[])[1]).toEqual(chat.messages[1]);
    expect((out.messages as unknown[])[2]).toEqual({ ...chat.messages[2], content: "short" });

    const anthropic = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "tool_use", id: "a", name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "large result" },
            { type: "image", source: { type: "base64", data: "abc" } },
          ],
        },
      ],
    };
    const edited = normalizeTranscript(anthropic).map((message) =>
      message.toolResults?.length
        ? { ...message, toolResults: [{ ...message.toolResults[0]!, text: "short" }] }
        : message,
    );
    const anthropicOut = reencodeMessages(anthropic, edited);
    expect((anthropicOut.messages as unknown[])[0]).toEqual(anthropic.messages[0]);
    const dropped = applyDecisions(
      normalizeTranscript(anthropic),
      [
        {
          id: "t1",
          tool: "Read",
          keepCall: 0.05,
          keepResult: 0.05,
          action: "drop_call",
          reason: "call_dropped",
        },
      ],
      collectToolCalls(normalizeTranscript(anthropic), 0),
      300,
    );
    const droppedBody = reencodeMessages(anthropic, dropped);
    expect((droppedBody.messages as Array<{ content: unknown[] }>)[1]?.content).toEqual([
      { type: "image", source: { type: "base64", data: "abc" } },
    ]);
    expect((anthropicOut.messages as Array<{ content: unknown[] }>)[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "short" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ]);
  });
  it("keeps the request usable after dropping a stale call", async () => {
    const body = {
      model: "gpt-x",
      messages: [
        { role: "user", content: "Never edit src/generated. Fix the test." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "a".repeat(4000) },
        { role: "user", content: "keep going" },
      ],
    };
    const messages = normalizeTranscript(body);
    const result = await compact(
      messages,
      {
        ask: async (_state, questions) => ({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { noul: key.startsWith("call_") ? 0.9 : 0.1 },
            ]),
          ),
        }),
      },
      { preserveRecentMessages: 0 },
    );
    expect(result.decisions[0]?.action).toBe("drop_result");
    const out = reencodeMessages(body, result.messages);
    const encoded = JSON.stringify(out);
    // The call survives, its long result is truncated rather than lost.
    expect(encoded).toContain('"tool_calls"');
    expect(encoded).toContain("jevonian truncated");
    expect(encoded).toContain("Never edit src/generated");
    // The original chat shape and tool-call arguments survive; only the result text shrinks.
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore / 2);
  });
});
