import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { JevResponse } from "./compaction";
import { parseConfig } from "./config";
import { resetQuotaCache } from "./quota";
import { compactionEstimate, SessionStore } from "./routing";
import { createApp } from "./server";
import { isContextOverflowResponse } from "./upstream";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-overflow-"));
  for (const key of ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER", "TYPESAFE_API_KEY"]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  resetQuotaCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuotaCache();
  rmSync(dir, { recursive: true, force: true });
});

/** A conversation with one stale tool call and one the assistant is still working from. */
function longBody() {
  return {
    model: "auto",
    messages: [
      { role: "user", content: "Never edit src/generated. Fix the failing test." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "old", function: { name: "Read", arguments: '{"file_path":"huge.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "old", content: "stale ".repeat(3_000) },
      { role: "assistant", content: "That file was unrelated; checking the real one." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "new", function: { name: "Bash", arguments: '{"command":"npm test"}' } },
        ],
      },
      { role: "tool", tool_call_id: "new", content: "FAIL b.test.ts: expected 2 to be 3" },
      { role: "user", content: "go ahead and fix it" },
    ],
  };
}

const config = () =>
  parseConfig({
    defaultProvider: "sub",
    providers: [
      {
        name: "sub",
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        models: ["tiny-model"],
      },
    ],
    routing: {
      mode: "auto",
      tiers: { plan: ["tiny-model"], execute: ["tiny-model"] },
      brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }],
      // A window far smaller than the conversation, so overflow is guaranteed.
      capacities: { "tiny-model": { contextWindow: 2_000 } },
    },
  });

describe("context overflow", () => {
  it("counts tool schemas and instructions with a bridge safety margin", () => {
    const messages = [{ role: "user", content: "hello" }];
    const bare = compactionEstimate({ messages });
    const withTools = compactionEstimate({
      messages,
      tools: [
        { type: "function", function: { name: "Read", description: "Read a file".repeat(200) } },
      ],
      instructions: "Keep all paths exact".repeat(200),
    });
    expect(withTools).toBeGreaterThan(bare + 1_000);
    expect(compactionEstimate({ messages })).toBe(bare);
  });

  it("fits a 1750-message agent transcript into Jev's default 25k state", async () => {
    const { compact, normalizeTranscript, reductionRatio, reencodeMessages } =
      await import("./compaction");
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "Keep the original task" },
    ];
    for (let index = 0; index < 870; index += 1) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `call-${index}`,
            function: { name: "Read", arguments: JSON.stringify({ path: `src/${index}.ts` }) },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: "stale result ".repeat(100),
      });
    }
    messages.push({ role: "user", content: "Fix the latest test" });
    const body = { model: "auto", messages };
    let maxStateTokens = 0;
    const output = await compact(
      normalizeTranscript(body),
      {
        ask: async (state, questions) => {
          maxStateTokens = Math.max(maxStateTokens, JSON.stringify(state).length);
          return {
            answers: Object.fromEntries(
              Object.keys(questions).map((key) => [
                key,
                { noul: key.startsWith("call_") ? 0.9 : 0.05 },
              ]),
            ),
          };
        },
      },
      { preserveRecentMessages: 4 },
    );
    const rewritten = reencodeMessages(body, output.messages);
    expect(["recent context only", "old calls merged"]).toContain(output.stats.stateStage);
    expect(output.stats.stateTokens).toBeLessThanOrEqual(25_000);
    expect(maxStateTokens).toBeGreaterThan(0);
    expect(reductionRatio(output)).toBeGreaterThan(0.25);
    expect(compactionEstimate(rewritten)).toBeLessThan(compactionEstimate(body) * 0.9);
    expect((rewritten.messages as unknown[]).at(-1)).toEqual(messages.at(-1));
  });

  it("recognizes context errors but never compacts on unrelated invalid requests", () => {
    expect(
      isContextOverflowResponse(
        400,
        '{"message":"prompt is too long: 1002620 tokens > 1000000 maximum"}',
      ),
    ).toBe(true);
    expect(isContextOverflowResponse(400, '{"type":"context_length_exceeded"}')).toBe(true);
    expect(isContextOverflowResponse(400, '{"message":"Invalid API key"}')).toBe(false);
    expect(isContextOverflowResponse(429, '{"message":"prompt is too long"}')).toBe(false);
  });

  it("compacts a rejected request once, reroutes, and sends valid Chat Completions tools", async () => {
    const cfg = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          models: ["tiny-model"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["tiny-model"], execute: ["tiny-model"] },
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }],
        capacities: { "tiny-model": { contextWindow: 100_000 } },
      },
    });
    const messages = [
      { role: "user", content: "Keep this instruction" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "old", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "old", content: "stale ".repeat(3_000) },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "I'll check the recent files." },
      { role: "user", content: "Look at the test" },
      { role: "assistant", content: "Checking now" },
      { role: "user", content: "Proceed" },
    ];
    let upstreamHits = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (!url.includes("example.test")) {
        const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          questions: Record<string, unknown>;
        };
        const answers: Record<string, unknown> = {
          model: { choice: "tiny-model", confidence: 0.9 },
          effort: { choice: "low", confidence: 0.9 },
        };
        for (const key of Object.keys(request.questions)) {
          if (key.startsWith("call_") || key.startsWith("result_")) answers[key] = { noul: 0.05 };
        }
        return new Response(JSON.stringify({ model: "jev", answers }), { status: 200 });
      }
      upstreamHits += 1;
      const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        messages: Array<Record<string, unknown>>;
      };
      if (upstreamHits === 1) {
        expect(sent.messages).toHaveLength(8);
        return new Response(
          '{"error":{"message":"prompt is too long: 1002620 tokens > 1000000 maximum"}}',
          { status: 400 },
        );
      }
      expect(sent.messages).toEqual([messages[0], ...messages.slice(3)]);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    const app = createApp({ config: cfg }, new SessionStore(60_000));
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "jevonian/auto", messages }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jevonian-reason")).toContain("context-retry");
    expect(upstreamHits).toBe(2);
    const records = readFileSync(join(dir, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((entry) => entry.path === "/chat/completions")).toHaveLength(1);
  });

  it("never retries the same request repeatedly when compaction cannot shrink it", async () => {
    const cfg = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          models: ["tiny-model"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["tiny-model"], execute: ["tiny-model"] },
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }],
      },
    });
    let hits = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (!url.includes("example.test"))
        return new Response(
          JSON.stringify({
            model: "jev",
            answers: { model: { choice: "tiny-model", confidence: 0.9 } },
          }),
          { status: 200 },
        );
      hits += 1;
      return new Response('{"error":{"message":"prompt is too long"}}', { status: 400 });
    });
    const response = await createApp({ config: cfg }, new SessionStore(60_000)).request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "jevonian/auto",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(hits).toBe(1);
  });

  it("flags the overflow and compacts the history before routing again", async () => {
    const seen: Array<{ keys: string[]; messageCount: number }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as {
        questions?: Record<string, unknown>;
        state?: { candidates?: Array<{ model: string }>; history?: unknown[] };
      };
      const keys = Object.keys(body.questions ?? {});
      seen.push({ keys, messageCount: body.state?.history?.length ?? 0 });
      // Model choice or the two compaction probes per tool call.
      const answers: Record<string, unknown> = {
        model: { choice: "tiny-model", confidence: 0.9 },
        effort: { choice: "low", confidence: 0.9 },
      };
      for (const key of keys) {
        if (key.startsWith("call_")) answers[key] = { noul: key === "call_t1" ? 0.05 : 0.95 };
        if (key.startsWith("result_")) answers[key] = { noul: 0.05 };
      }
      return new Response(JSON.stringify({ model: "jev", answers }), { status: 200 });
    });

    const { decideRoute } = await import("./routing");
    const decision = await decideRoute({
      config: config(),
      body: longBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.contextOverflow).toBe(true);
    expect(decision.skipped?.[0]).toMatchObject({ model: "tiny-model", reason: "context" });
    // The brain still answered, so the turn is routed rather than failed.
    expect(decision.model).toBe("tiny-model");
    expect(seen[0]?.keys).toEqual(["model", "effort"]);
  });

  it("compacts by dropping only what Jev rejects, keeping prose verbatim", async () => {
    const { normalizeTranscript, compact } = await import("./compaction");
    const { askJevRaw } = await import("./brain");
    let captured: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      captured = body;
      const keys = Object.keys((body.questions as Record<string, unknown>) ?? {});
      const answers: Record<string, unknown> = {};
      for (const key of keys) {
        // The stale call is rejected; the live one is kept.
        answers[key] = { noul: key.includes("t1") ? 0.05 : 0.95 };
      }
      return new Response(JSON.stringify({ model: "jev", answers }), { status: 200 });
    });

    const messages = normalizeTranscript(longBody());
    const brain = config().routing.brains[0];
    if (!brain) throw new Error("missing brain");
    const result = await compact(
      messages,
      {
        ask: async (state, questions) => {
          const { answers } = await askJevRaw(
            brain,
            state as unknown as Record<string, unknown>,
            questions,
          );
          return { answers: answers as JevResponse["answers"] };
        },
      },
      { preserveRecentMessages: 0 },
    );

    // Prose survives untouched, in order.
    const text = result.messages.map((message) => message.text).filter(Boolean);
    expect(text).toEqual([
      "Never edit src/generated. Fix the failing test.",
      "That file was unrelated; checking the real one.",
      "go ahead and fix it",
    ]);
    // The stale call and its result are gone; the live pair is intact.
    const remaining = result.messages.flatMap((message) =>
      message.toolUses.map((t) => t.tool_use_id),
    );
    expect(remaining).toEqual(["new"]);
    expect(result.stats.callsDropped).toBeGreaterThan(0);
    // The state sent to Jev carried the results as notes, never their contents.
    expect(JSON.stringify(captured.state)).not.toContain("stale stale");
  });
});
