import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { discoverProviderModels } from "./catalog";
import { parseConfig, type Config } from "./config";
import { devinPb, encodeConnectFrame } from "./devin";
import { devinModelMeta, resetDevinModelMeta } from "./devin-catalog";
import { readRecords, resetLedgerCache } from "./ledger";
import { invalidateOAuthToken } from "./oauth";
import { headerQuotas, providerQuotas, resetQuotaCache } from "./quota";
import { SessionStore } from "./routing";
import { createApp } from "./server";

const { bytesField: bytes, varintField: num, concat } = devinPb;
const encoder = new TextEncoder();
const MODEL = "swe-1-6-slow";

let dir = "";
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-devin-routing-"));
  const keys = ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER", "JEVONIAN_DEVIN_CREDENTIALS"];
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.JEVONIAN_DEVIN_CREDENTIALS = join(dir, "credentials.toml");
  writeFileSync(process.env.JEVONIAN_DEVIN_CREDENTIALS, 'windsurf_api_key = "test-devin-token"\n');
  invalidateOAuthToken("devin");
  resetQuotaCache();
  resetDevinModelMeta();
  resetLedgerCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateOAuthToken("devin");
  resetQuotaCache();
  resetDevinModelMeta();
  resetLedgerCache();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function config(fallback = false): Config {
  return parseConfig({
    defaultProvider: "devin-subscription",
    providers: [
      {
        name: "devin-subscription",
        type: "devin",
        baseUrl: "https://server.codeium.com",
        auth: "oauth",
        oauthSource: "devin",
        billing: "subscription",
        models: [MODEL],
      },
      ...(fallback
        ? [
            {
              name: "backup",
              type: "openai",
              baseUrl: "https://backup.example/v1",
              apiKey: "backup-key",
              models: ["fallback-model"],
            },
          ]
        : []),
    ],
    routing: {
      mode: "auto",
      brains: [],
      tiers: {
        plan: [MODEL, "fallback-model"],
        execute: [MODEL, "fallback-model"],
        utility: [MODEL, "fallback-model"],
        chat: [MODEL, "fallback-model"],
      },
    },
  });
}

function responseFrames(options: { tool?: boolean; thinking?: boolean } = {}): Uint8Array {
  const frames = [
    ...(options.thinking ? [encodeConnectFrame(bytes(9, "Checking the weather"))] : []),
    encodeConnectFrame(bytes(3, options.tool ? "Calling tool" : "pong")),
    ...(options.tool
      ? [
          encodeConnectFrame(
            bytes(6, concat([bytes(1, "call_abc"), bytes(2, "get_weather"), bytes(3, '{"city":')])),
          ),
          encodeConnectFrame(bytes(6, concat([bytes(3, '"Paris"}')]))),
        ]
      : []),
    encodeConnectFrame(
      concat([
        num(5, options.tool ? 10 : 2),
        bytes(7, concat([num(2, 4), num(3, 3), num(4, 2), num(5, 6), bytes(9, MODEL)])),
      ]),
    ),
    encodeConnectFrame(encoder.encode("{}"), 2),
  ];
  return concat(frames);
}

function chunkedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
      controller.close();
    },
  });
}

function routeFetch(frame: Uint8Array, onRequest?: (url: string, init?: RequestInit) => void) {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    onRequest?.(url, init);
    if (!url.includes("GetChatMessage")) return new Response(`unexpected ${url}`, { status: 500 });
    return new Response(chunkedStream(frame), {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
    });
  });
}

async function request(path: string, body: Record<string, unknown>, cfg = config()) {
  const app = createApp({ config: cfg }, new SessionStore(60_000));
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jevonian-session": "stable-session" },
    body: JSON.stringify({ model: "jevonian/chat", ...body }),
  });
}

function protobufFields(raw: Uint8Array): Array<{ number: number; value: Uint8Array | number }> {
  const result: Array<{ number: number; value: Uint8Array | number }> = [];
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 1;
    while (offset < raw.length) {
      const byte = raw[offset++] as number;
      value += (byte & 127) * shift;
      if (byte < 128) return value;
      shift *= 128;
    }
    throw new Error("truncated protobuf varint");
  };
  while (offset < raw.length) {
    const tag = varint();
    const wire = tag & 7;
    const number = tag >> 3;
    if (wire === 0) result.push({ number, value: varint() });
    else if (wire === 2) {
      const length = varint();
      result.push({ number, value: raw.slice(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      offset += length;
    } else throw new Error(`unexpected protobuf wire type ${wire}`);
  }
  return result;
}

function postedDevinTurns(body: RequestInit["body"]): Array<{
  role: number;
  text: string;
  images: Array<{ data: string; mime: string }>;
  toolCallId?: string;
}> {
  if (!(body instanceof Uint8Array)) throw new Error("expected Devin Connect request");
  const size = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, false);
  expect(body[0]).toBe(0);
  expect(body.byteLength).toBe(size + 5);
  const fields = protobufFields(body.subarray(5));
  const turns = fields.filter((field) => field.number === 3);
  return turns.map((field) => {
    const parts = protobufFields(field.value as Uint8Array);
    const text = (number: number): string =>
      decoder.decode(parts.find((part) => part.number === number)?.value as Uint8Array);
    const images = parts
      .filter((part) => part.number === 10)
      .map((part) => {
        const image = protobufFields(part.value as Uint8Array);
        const value = (number: number): string =>
          decoder.decode(image.find((entry) => entry.number === number)?.value as Uint8Array);
        return { data: value(1), mime: value(2) };
      });
    return {
      role: parts.find((part) => part.number === 2)?.value as number,
      text: text(3),
      images,
      ...(parts.some((part) => part.number === 7) ? { toolCallId: text(7) } : {}),
    };
  });
}

const decoder = new TextDecoder();

function events(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .filter((block) => block.split("\n").some((line) => line.startsWith("data: ")))
    .map((block) => {
      const data =
        block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? "{}";
      return data === "[DONE]" ? { done: true } : (JSON.parse(data) as Record<string, unknown>);
    });
}

describe("Devin subscription forwarding", () => {
  it("streams OpenAI chat deltas and records exclusive usage and cached cost", async () => {
    let posted = false;
    routeFetch(responseFrames({ thinking: true }), (url, init) => {
      expect(url).toBe(
        "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Basic test-devin-token-test-devin-token");
      expect(headers.get("content-type")).toBe("application/connect+proto");
      expect(init?.body).toBeInstanceOf(Uint8Array);
      posted = true;
    });
    const response = await request("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "say pong" }],
    });
    expect(response.status).toBe(200);
    expect(posted).toBe(true);
    const output = events(await response.text());
    expect(
      output.some((event) =>
        JSON.stringify(event).includes('"reasoning_content":"Checking the weather"'),
      ),
    ).toBe(true);
    expect(output.some((event) => JSON.stringify(event).includes('"content":"pong"'))).toBe(true);
    expect(output.some((event) => JSON.stringify(event).includes('"finish_reason":"stop"'))).toBe(
      true,
    );
    expect(output.at(-1)).toEqual({ done: true });
    const row = readRecords().find((record) => record.provider === "devin-subscription");
    expect(row).toMatchObject({
      status: 200,
      promptTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      completionTokens: 3,
      billing: "subscription",
    });
  });

  it("records a 499 when the client cancels a Devin stream", async () => {
    let cancelUpstream: (() => void) | undefined;
    vi.stubGlobal("fetch", async () => {
      const frame = encodeConnectFrame(bytes(3, "first"));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame);
        },
        cancel() {
          cancelUpstream?.();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const response = await request("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    const upstreamCancelled = new Promise<void>((resolve) => {
      cancelUpstream = resolve;
    });
    await reader?.cancel();
    await upstreamCancelled;
    const record = readRecords().find((entry) => entry.provider === "devin-subscription");
    expect(record?.status).toBe(499);
  });

  it("folds a Devin stream into non-stream OpenAI completion with tools", async () => {
    routeFetch(responseFrames({ tool: true, thinking: true }));
    const response = await request("/v1/chat/completions", {
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    const choice = (json.choices as Array<Record<string, unknown>>)[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message).toMatchObject({
      reasoning_content: "Checking the weather",
      tool_calls: [
        { id: "call_abc", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
      ],
    });
    expect(json.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 6 },
    });
  });

  it("streams Anthropic Messages SSE with thinking and tool-use blocks", async () => {
    routeFetch(responseFrames({ tool: true, thinking: true }));
    const response = await request("/v1/messages", {
      stream: true,
      max_tokens: 100,
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          name: "get_weather",
          description: "Get a forecast",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(response.status).toBe(200);
    const output = events(await response.text());
    expect(output.some((event) => event.type === "message_start")).toBe(true);
    expect(output.some((event) => JSON.stringify(event).includes('"type":"thinking_delta"'))).toBe(
      true,
    );
    expect(output.some((event) => JSON.stringify(event).includes('"type":"tool_use"'))).toBe(true);
    expect(
      output.some((event) => JSON.stringify(event).includes('"partial_json":"\\"Paris\\"}"')),
    ).toBe(true);
    expect(output.find((event) => event.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 2,
      },
    });
    expect(output.at(-1)?.type).toBe("message_stop");
  });

  it("streams Responses SSE with text, tools and a completed output", async () => {
    routeFetch(responseFrames({ tool: true }));
    const response = await request("/v1/responses", {
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(response.status).toBe(200);
    const output = events(await response.text());
    expect(output.some((event) => event.type === "response.output_text.delta")).toBe(true);
    expect(output.some((event) => event.type === "response.function_call_arguments.delta")).toBe(
      true,
    );
    expect(output.find((event) => event.type === "response.completed")?.response).toMatchObject({
      output: [
        { type: "message", content: [{ text: "Calling tool" }] },
        { type: "function_call", call_id: "call_abc", arguments: '{"city":"Paris"}' },
      ],
    });
  });

  it("encodes Anthropic inline images in ordered Devin turns alongside tool history", async () => {
    let turns: ReturnType<typeof postedDevinTurns> = [];
    let system = "";
    let toolCall = "";
    routeFetch(responseFrames(), (_url, init) => {
      turns = postedDevinTurns(init?.body);
      const frame = init?.body as Uint8Array;
      const envelope = protobufFields(frame.subarray(5));
      system = decoder.decode(envelope.find((field) => field.number === 2)?.value as Uint8Array);
      const assistant = protobufFields(
        envelope.find((field) => field.number === 3)?.value as Uint8Array,
      );
      const call = protobufFields(
        assistant.find((field) => field.number === 6)?.value as Uint8Array,
      );
      toolCall = decoder.decode(call.find((field) => field.number === 2)?.value as Uint8Array);
    });
    const response = await request("/v1/messages", {
      max_tokens: 100,
      system: "Describe precisely",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "inspect", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ready" }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Before" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
            { type: "text", text: "After" },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(turns.map((turn) => [turn.role, turn.text, turn.images])).toEqual([
      [2, "", []],
      [4, "ready", []],
      [1, "Before", []],
      [1, "", [{ data: "YWJj", mime: "image/png" }]],
      [1, "After", []],
    ]);
    expect(system).toBe("Describe precisely");
    expect(toolCall).toBe("inspect");
    expect(turns[1]?.toolCallId).toBe("call_1");
  });

  it("encodes Responses input_image bytes in order with function transcript", async () => {
    let turns: ReturnType<typeof postedDevinTurns> = [];
    routeFetch(responseFrames(), (_url, init) => {
      turns = postedDevinTurns(init?.body);
    });
    const response = await request("/v1/responses", {
      input: [
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ready" },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Before" },
            { type: "input_image", image_url: "data:image/jpeg;base64,ZGVm" },
            { type: "input_text", text: "After" },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(turns.map((turn) => [turn.role, turn.text, turn.images])).toEqual([
      [2, "", []],
      [4, "ready", []],
      [1, "Before", []],
      [1, "", [{ data: "ZGVm", mime: "image/jpeg" }]],
      [1, "After", []],
    ]);
  });

  it("keeps multiple inline images and intervening text in separate Devin turns", async () => {
    let turns: ReturnType<typeof postedDevinTurns> = [];
    routeFetch(responseFrames(), (_url, init) => {
      turns = postedDevinTurns(init?.body);
    });
    const response = await request("/v1/responses", {
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,YWJj" },
            { type: "input_text", text: "between" },
            { type: "input_image", image_url: "data:image/jpeg;base64,ZGVm" },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(turns.map((turn) => [turn.text, turn.images])).toEqual([
      ["", [{ mime: "image/png", data: "YWJj" }]],
      ["between", []],
      ["", [{ mime: "image/jpeg", data: "ZGVm" }]],
    ]);
  });

  it.each([
    ["remote image", { type: "input_image", image_url: "https://example.com/photo.png" }],
    ["file image", { type: "input_image", file_id: "file-123" }],
  ])("rejects Responses %s instead of posting incomplete Devin context", async (_name, image) => {
    const posted = vi.fn();
    routeFetch(responseFrames(), posted);
    const response = await request("/v1/responses", {
      input: [{ role: "user", content: [image] }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { type: "invalid_request_error" },
    });
    expect(posted).not.toHaveBeenCalled();
  });

  it("rejects Anthropic URL image sources instead of posting incomplete Devin context", async () => {
    const posted = vi.fn();
    routeFetch(responseFrames(), posted);
    const response = await request("/v1/messages", {
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.com/photo.png" } },
          ],
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(posted).not.toHaveBeenCalled();
  });

  it("classifies a leading Connect error trailer, marks spent and fails over", async () => {
    let devinHits = 0;
    let backupHits = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("GetChatMessage")) {
        devinHits += 1;
        const trailer = encodeConnectFrame(
          encoder.encode(
            JSON.stringify({
              error: { code: "resource_exhausted", message: "Rate limit. Resets in: 1h0m0s" },
            }),
          ),
          2,
        );
        return new Response(chunkedStream(trailer), { status: 200 });
      }
      if (url.includes("backup.example")) {
        backupHits += 1;
        return Response.json({
          id: "chatcmpl-backup",
          choices: [{ message: { role: "assistant", content: "backup" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const response = await request(
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "hi" }] },
      config(true),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jevonian-provider")).toBe("backup");
    expect(response.headers.get("x-jevonian-reason")).toContain("quota-failover");
    expect(devinHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(headerQuotas()["devin-subscription"]?.windows[0]).toMatchObject({
      usedPercent: 100,
      status: "rejected",
    });
  });

  it("folds a non-stream Anthropic reply with thinking, tools and exclusive usage", async () => {
    routeFetch(responseFrames({ tool: true, thinking: true }));
    const response = await request("/v1/messages", {
      max_tokens: 200,
      messages: [{ role: "user", content: "weather?" }],
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      type: "message",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "Checking the weather" },
        { type: "text", text: "Calling tool" },
        { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Paris" } },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 2,
      },
    });
  });

  it("folds a non-stream Responses reply with inclusive client usage", async () => {
    routeFetch(responseFrames());
    const response = await request("/v1/responses", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ text: "pong" }] }],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    });
  });

  it("retries a 401 with a freshly resolved token and rebuilt Connect body", async () => {
    const credential = process.env.JEVONIAN_DEVIN_CREDENTIALS as string;
    let attempts = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(url).toContain("GetChatMessage");
      attempts += 1;
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      expect(raw).toBeInstanceOf(Uint8Array);
      if (attempts === 1) {
        expect(headers.get("authorization")).toBe("Basic test-devin-token-test-devin-token");
        writeFileSync(credential, 'windsurf_api_key = "renewed-token"\n');
        return new Response('{"code":"unauthenticated","message":"invalid token"}', {
          status: 401,
        });
      }
      expect(headers.get("authorization")).toBe("Basic renewed-token-renewed-token");
      return new Response(chunkedStream(responseFrames()), { status: 200 });
    });
    const response = await request("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("returns classified content-policy JSON and records the failure", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"code":"permission_denied","message":"blocked by our content policy"}', {
          status: 403,
        }),
    );
    const response = await request("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { type: "invalid_request_error", code: "content_policy" },
    });
    expect(readRecords().find((record) => record.provider === "devin-subscription")).toMatchObject({
      status: 400,
    });
  });

  it("returns a classified 429 and records it when no failover exists", async () => {
    routeFetch(
      encodeConnectFrame(
        encoder.encode(
          JSON.stringify({
            error: { code: "resource_exhausted", message: "Rate limit. Resets in: 1h0m0s" },
          }),
        ),
        2,
      ),
    );
    const response = await request("/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(429);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limit" },
    });
    expect(readRecords().find((record) => record.provider === "devin-subscription")).toMatchObject({
      status: 429,
    });
  });
});

describe("Devin discovery and quota", () => {
  it("discovers only routable enabled models and persists their metadata", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      calls += 1;
      expect(url).toContain("GetCliModelConfigs");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/proto");
      const row = (id: string, disabled = false) =>
        bytes(
          1,
          concat([
            bytes(1, id),
            bytes(22, id),
            num(4, disabled ? 1 : 0),
            bytes(23, concat([num(4, 200_000), num(13, 32_000)])),
          ]),
        );
      return new Response(
        concat([
          row(MODEL),
          row("claude-opus-4-8-medium"),
          row("fusion-combo"),
          row("adaptive"),
          row("arena-blind"),
          row("disabled", true),
        ]),
      );
    });
    const provider = config().providers[0];
    if (!provider) throw new Error("missing provider");
    const entry = await discoverProviderModels(provider);
    expect(entry.error).toBeUndefined();
    expect(entry.models).toEqual([MODEL, "claude-opus-4-8-medium"]);
    expect(calls).toBe(1);
    expect(devinModelMeta(MODEL)).toMatchObject({ contextWindow: 200_000, maxOutput: 32_000 });
  });

  it("maps GetUserStatus remaining percentages into live daily and weekly windows", async () => {
    const dailyReset = Math.floor(Date.now() / 1000) + 3_600;
    const weeklyReset = dailyReset + 3 * 86_400;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(url).toContain("GetUserStatus");
      const info = bytes(1, bytes(2, "Pro"));
      const plan = bytes(
        13,
        concat([info, num(14, 1), num(15, 75), num(17, dailyReset), num(18, weeklyReset)]),
      );
      return new Response(bytes(1, plan));
    });
    const quotas = await providerQuotas(config(), { refresh: true });
    expect(quotas[0]).toMatchObject({ source: "live", plan: "Pro" });
    expect(quotas[0]?.windows).toEqual([
      {
        id: "devin-daily",
        label: "day",
        usedPercent: 99,
        resetsAt: new Date(dailyReset * 1000).toISOString(),
      },
      {
        id: "devin-weekly",
        label: "week",
        usedPercent: 25,
        resetsAt: new Date(weeklyReset * 1000).toISOString(),
      },
    ]);
  });
});
