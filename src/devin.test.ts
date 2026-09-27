import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildDevinChatRequest,
  classifyDevinError,
  DEVIN_DEFAULT_BASE_URL,
  devinChatCompletion,
  devinChatUrl,
  devinHeaders,
  devinPb,
  devinToChatStream,
  encodeConnectFrame,
  fetchDevinModels,
  fetchDevinUserStatus,
  parseDevinModels,
  parseDevinUserStatus,
  peekDevinStream,
} from "./devin";

const { concat, bytesField: bytes, varintField: int } = devinPb;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Field {
  num: number;
  wire: number;
  value: number | Uint8Array;
}

/** Independent one-level protobuf decoder for wire round-trip assertions. */
function parse(raw: Uint8Array): Field[] {
  const result: Field[] = [];
  let offset = 0;
  const readVarint = () => {
    let num = 0;
    let shift = 1;
    for (;;) {
      const digit = raw[offset++];
      if (digit === undefined) throw new Error("truncated varint");
      num += (digit & 0x7f) * shift;
      if (!(digit & 0x80)) return num;
      shift *= 128;
    }
  };
  while (offset < raw.length) {
    const tag = readVarint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) result.push({ num, wire, value: readVarint() });
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? readVarint() : wire === 1 ? 8 : 4;
      result.push({ num, wire, value: raw.slice(offset, offset + length) });
      offset += length;
    } else throw new Error(`unknown wire type ${wire}`);
  }
  return result;
}

const fields = (raw: Uint8Array, num: number) => parse(raw).filter((f) => f.num === num);
const field = (raw: Uint8Array, num: number) => fields(raw, num)[0]?.value;
const sub = (raw: Uint8Array, num: number) => field(raw, num) as Uint8Array;
const str = (raw: Uint8Array, num: number) => decoder.decode(sub(raw, num));
const num = (raw: Uint8Array, n: number) => field(raw, n) as number;
const double = (raw: Uint8Array, n: number) => {
  const value = sub(raw, n);
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat64(0, true);
};
const float = (n: number, value: number) => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setFloat32(0, value, true);
  return concat([Uint8Array.of(n * 8 + 5), data]);
};

function unframe(frame: Uint8Array): Uint8Array {
  expect(frame[0]).toBe(0);
  const length = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, false);
  expect(frame.length).toBe(length + 5);
  return frame.subarray(5);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return concat(chunks);
}

function sseEvents(bytesRaw: Uint8Array): Array<Record<string, unknown> | string> {
  return decoder
    .decode(bytesRaw)
    .split("\n\n")
    .filter(Boolean)
    .map((line) => {
      expect(line.startsWith("data: ")).toBe(true);
      const content = line.slice("data: ".length);
      return content === "[DONE]" ? content : (JSON.parse(content) as Record<string, unknown>);
    });
}

function sseDelta(event: Record<string, unknown>): Record<string, unknown> {
  return ((event.choices as Array<Record<string, unknown>>)[0]?.delta ?? {}) as Record<
    string,
    unknown
  >;
}

function sseFinish(event: Record<string, unknown>): unknown {
  return (event.choices as Array<Record<string, unknown>>)[0]?.finish_reason;
}

function upstreamStream(): Uint8Array {
  const usage = concat([int(2, 11), int(3, 7), int(4, 5), int(5, 9), bytes(9, "actual-model")]);
  const toolStart = concat([bytes(1, "call_weather"), bytes(2, "weather"), bytes(3, '{"city":')]);
  const toolEnd = bytes(3, '"Paris"}');
  return concat([
    encodeConnectFrame(bytes(9, "think")),
    encodeConnectFrame(gzipSync(bytes(3, "Hello ")), 1),
    encodeConnectFrame(concat([bytes(3, "world"), bytes(6, toolStart)])),
    encodeConnectFrame(concat([bytes(6, toolEnd), int(5, 10), bytes(7, usage)])),
    encodeConnectFrame(encoder.encode("{}"), 2),
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe("Devin request wire", () => {
  it("builds metadata, headers, paths and an uncompressed Connect request", () => {
    expect(devinChatUrl(`${DEVIN_DEFAULT_BASE_URL}///`)).toBe(
      `${DEVIN_DEFAULT_BASE_URL}/exa.api_server_pb.ApiServerService/GetChatMessage`,
    );
    const headers = devinHeaders("secret", "stream");
    expect(headers.authorization).toBe("Basic secret-secret");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers["connect-accept-encoding"]).toBe("gzip");
    expect(headers["sentry-trace"]).toMatch(/^[a-f0-9]{32}-[a-f0-9]{16}-1$/);
    expect(devinHeaders("secret", "unary")["content-type"]).toBe("application/proto");

    const request = unframe(buildDevinChatRequest("secret", { messages: [] }, "swe-1-6-slow"));
    const meta = sub(request, 1);
    const version = process.env.JEVONIAN_DEVIN_CLIENT_VERSION || "3000.11.3";
    expect(fields(meta, 3)).toHaveLength(1);
    expect(str(meta, 1)).toBe("chisel");
    expect(str(meta, 2)).toBe(version);
    expect(str(meta, 3)).toBe("secret");
    expect(str(meta, 4)).toBe("en");
    expect(str(meta, 5)).toBe(process.platform);
    expect(str(meta, 7)).toBe(version);
    expect(str(meta, 12)).toBe("chisel");
    expect(str(meta, 31)).toMatch(/^[a-f0-9]{732}$/);
    expect(str(meta, 31)).toBe(
      str(sub(unframe(buildDevinChatRequest("secret", {}, "swe-1-6-slow")), 1), 31),
    );
    expect(num(request, 7)).toBe(5);
    expect(num(request, 20)).toBe(1);
    expect(str(request, 21)).toBe("swe-1-6-slow");
    const config = sub(request, 8);
    expect(num(config, 1)).toBe(1);
    expect(num(config, 2)).toBe(16384);
    expect(num(config, 3)).toBe(128000);
    expect(double(config, 5)).toBe(1);
    expect(num(config, 7)).toBe(40);
    expect(double(config, 8)).toBe(0.95);
  });

  it("maps all roles, images, tools, limits and a stable session id", () => {
    const body = {
      messages: [
        { role: "system", content: "Be concise" },
        { role: "developer", content: "No markup" },
        { role: "user", content: "First" },
        { role: "user", content: [{ type: "text", text: "Second" }] },
        { role: "user", content: "Third" },
        {
          role: "user",
          content: [
            { type: "text", text: "See picture" },
            { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
            { type: "image_url", image_url: { url: "https://example.test/image.jpg" } },
          ],
        },
        {
          role: "assistant",
          content: "Calling",
          tool_calls: [
            {
              id: "call1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", content: "sunny", tool_call_id: "call1" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Look up weather",
            parameters: { type: "object" },
          },
        },
      ],
      max_tokens: 100,
      max_completion_tokens: 128,
      temperature: 0,
    };
    const request = unframe(
      buildDevinChatRequest("secret", body, "model", {
        sessionId: "conversation-1",
        maxOutput: 500,
      }),
    );
    expect(str(request, 2)).toContain("Be concise\n\nNo markup");
    expect(str(request, 2)).toContain("weather: Look up weather");
    const turns = fields(request, 3).map((f) => f.value as Uint8Array);
    expect(turns.map((turn) => num(turn, 2))).toEqual([1, 1, 2, 4]);
    expect(str(turns[0] as Uint8Array, 3)).toBe("First\n\nSecond\n\nThird");
    expect(str(turns[1] as Uint8Array, 3)).toBe("See picture");
    const images = fields(turns[1] as Uint8Array, 10);
    expect(images).toHaveLength(1);
    expect(str(images[0]?.value as Uint8Array, 1)).toBe("YWJj");
    expect(str(images[0]?.value as Uint8Array, 2)).toBe("image/png");
    const call = sub(turns[2] as Uint8Array, 6);
    expect([str(call, 1), str(call, 2), str(call, 3)]).toEqual([
      "call1",
      "weather",
      '{"city":"Paris"}',
    ]);
    expect(str(turns[3] as Uint8Array, 7)).toBe("call1");
    const tool = sub(request, 10);
    expect([str(tool, 1), str(tool, 2), JSON.parse(str(tool, 3))]).toEqual([
      "weather",
      "weather",
      { type: "object" },
    ]);
    expect(num(sub(request, 8), 2)).toBe(128);
    expect(double(sub(request, 8), 5)).toBe(0.001);
    const session = str(request, 16);
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(str(sub(request, 15), 1)).toBe(session);
    expect(num(sub(request, 15), 3)).toBe(4);
    expect(num(sub(request, 15), 4)).toBe(14);
    expect(
      str(
        unframe(buildDevinChatRequest("secret", body, "model", { sessionId: "conversation-1" })),
        16,
      ),
    ).toBe(session);
  });

  it("keeps tool descriptions as context but strips description annotations from the wire schema", () => {
    const request = unframe(
      buildDevinChatRequest(
        "secret",
        {
          messages: [
            { role: "system", content: "Keep existing instructions" },
            { role: "user", content: "hi" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "Shell",
                description: "Run a shell command safely",
                parameters: {
                  type: "object",
                  description: "Top-level instructions",
                  properties: {
                    command: { type: "string", description: "The command to run" },
                    description: {
                      type: "string",
                      description: "A parameter literally named description",
                    },
                  },
                  required: ["command"],
                },
              },
            },
          ],
        },
        "swe-2-max",
      ),
    );
    const system = str(request, 2);
    expect(system).toContain("Keep existing instructions");
    expect(system).toContain("Shell: Run a shell command safely");
    const tool = sub(request, 10);
    expect(str(tool, 1)).toBe("Shell");
    expect(str(tool, 2)).toBe("Shell");
    expect(JSON.parse(str(tool, 3))).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
      },
      required: ["command"],
    });
  });

  it("injects a system prompt when tools are present and none was supplied", () => {
    const request = unframe(
      buildDevinChatRequest(
        "secret",
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "search" } }],
        },
        "model",
        { maxOutput: 1000 },
      ),
    );
    expect(str(request, 2)).toContain(
      "You are a helpful assistant. Use the available tools when appropriate.",
    );
    expect(num(sub(request, 8), 2)).toBe(1000);
  });
});

describe("Devin stream translation", () => {
  it("handles split frames, gzip, reasoning, tool-call deltas, usage and finish", async () => {
    const wire = upstreamStream();
    const chunks: Uint8Array[] = [];
    for (let pos = 0; pos < wire.length; pos += 3) chunks.push(wire.slice(pos, pos + 3));
    const onFinish = vi.fn();
    const stream = streamOf(chunks).pipeThrough(devinToChatStream("requested-model", onFinish));
    const events = sseEvents(await readBytes(stream));
    expect(sseDelta(events[0] as Record<string, unknown>)).toEqual({
      role: "assistant",
      content: "",
    });
    expect(
      events
        .map((event) => (typeof event === "string" ? event : sseDelta(event).reasoning_content))
        .filter(Boolean),
    ).toContain("think");
    expect(
      events
        .map((event) => (typeof event === "string" ? undefined : sseDelta(event).content))
        .filter(Boolean),
    ).toEqual(["Hello ", "world"]);
    const calls = events.filter(
      (event): event is Record<string, unknown> =>
        typeof event !== "string" && Array.isArray(sseDelta(event).tool_calls),
    );
    expect(calls).toHaveLength(2);
    const firstCall = (
      sseDelta(calls[0] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    const secondCall = (
      sseDelta(calls[1] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    expect(firstCall).toMatchObject({
      index: 0,
      id: "call_weather",
      type: "function",
      function: { name: "weather", arguments: '{"city":' },
    });
    expect(secondCall).toMatchObject({ index: 0, function: { arguments: '"Paris"}' } });
    const last = events.at(-2) as Record<string, unknown>;
    expect(sseFinish(last)).toBe("tool_calls");
    expect(last.usage).toEqual({
      prompt_tokens: 25,
      completion_tokens: 7,
      total_tokens: 32,
      prompt_tokens_details: { cached_tokens: 9 },
    });
    expect(events.at(-1)).toBe("[DONE]");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({
      usage: { input: 11, output: 7, cacheWrite: 5, cacheRead: 9 },
      model: "actual-model",
    });
  });

  it("surfaces mid-stream error trailers before DONE and reports it once", async () => {
    const wire = concat([
      encodeConnectFrame(bytes(3, "partial")),
      encodeConnectFrame(
        encoder.encode('{"error":{"code":"unavailable","message":"high demand"}}'),
        2,
      ),
    ]);
    const onFinish = vi.fn();
    const events = sseEvents(
      await readBytes(streamOf([wire]).pipeThrough(devinToChatStream("model", onFinish))),
    );
    expect(sseDelta(events[1] as Record<string, unknown>).content).toBe("partial");
    expect(events.at(-2)).toEqual({ error: { message: "high demand", type: "upstream_error" } });
    expect(events.at(-1)).toBe("[DONE]");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0]).toMatchObject({ error: { kind: "capacity", status: 503 } });
  });

  it("maps known stop reasons and reports truncated streams", async () => {
    const normal = concat([
      encodeConnectFrame(concat([bytes(3, "ok"), int(5, 4)])),
      encodeConnectFrame(encoder.encode("{}"), 2),
    ]);
    const events = sseEvents(
      await readBytes(streamOf([normal]).pipeThrough(devinToChatStream("model"))),
    );
    expect(sseFinish(events.at(-2) as Record<string, unknown>)).toBe("stop");
    const truncated = sseEvents(
      await readBytes(
        streamOf([encodeConnectFrame(bytes(3, "partial"))]).pipeThrough(devinToChatStream("model")),
      ),
    );
    expect(truncated.at(-2)).toMatchObject({ error: { type: "upstream_error" } });
  });

  it("peeks through metadata frames and replays every original byte", async () => {
    const wire = concat([encodeConnectFrame(int(4, 2)), upstreamStream()]);
    const chunks = [wire.slice(0, 2), wire.slice(2, 18), wire.slice(18, 39), wire.slice(39)];
    const result = await peekDevinStream(streamOf(chunks));
    expect("stream" in result).toBe(true);
    if ("stream" in result) expect(await readBytes(result.stream)).toEqual(wire);
  });

  it("handles a rejected initial read without exposing its cause and releases the lock", async () => {
    const token = "devin-session-token$read-secret";
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`failed to read Basic ${token}-${token}`);
      },
    });
    const result = await peekDevinStream(body, token);
    expect(result).toEqual({
      error: { status: 502, kind: "other", message: "Devin stream read failed" },
    });
    expect(body.locked).toBe(false);
  });

  it("releases the reader after truncated, malformed and early-error streams", async () => {
    const cases = [
      [],
      [Uint8Array.of(0, 255, 255, 255, 255)],
      [encodeConnectFrame(encoder.encode('{"error":{"message":"invalid token"}}'), 2)],
    ];
    for (const chunks of cases) {
      const body = streamOf(chunks);
      expect(await peekDevinStream(body)).toHaveProperty("error");
      expect(body.locked).toBe(false);
    }
  });

  it("redacts early trailer credentials with the supplied token", async () => {
    const token = "opaque-secret";
    const body = streamOf([
      encodeConnectFrame(
        encoder.encode(
          JSON.stringify({ error: { message: `echo ${token} and Basic ${token}-${token}` } }),
        ),
        2,
      ),
    ]);
    const result = await peekDevinStream(body, token);
    expect(result).toMatchObject({ error: { message: "Devin upstream error" } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(body.locked).toBe(false);
  });

  it("releases the handed-off reader on completion and cancellation", async () => {
    const completed = streamOf([encodeConnectFrame(bytes(3, "ok"))]);
    const first = await peekDevinStream(completed);
    if (!("stream" in first)) throw new Error("Expected a stream");
    await readBytes(first.stream);
    expect(completed.locked).toBe(false);

    const cancelled = streamOf([encodeConnectFrame(bytes(3, "ok"))]);
    const second = await peekDevinStream(cancelled);
    if (!("stream" in second)) throw new Error("Expected a stream");
    await second.stream.cancel();
    expect(cancelled.locked).toBe(false);
  });

  it("sanitizes a read rejection after the peek handoff", async () => {
    const token = "devin-session-token$after-peek";
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (reads++ === 0) controller.enqueue(encodeConnectFrame(bytes(3, "ok")));
          else throw new Error(`read failed: Basic ${token}-${token}`);
        },
      },
      { highWaterMark: 0 },
    );
    const peeked = await peekDevinStream(body, token);
    if (!("stream" in peeked)) throw new Error("Expected a stream");
    await expect(readBytes(peeked.stream)).rejects.toThrow("Devin stream read failed");
    expect(body.locked).toBe(false);
  });

  it("keeps stream read and trailer secrets out of completion and SSE errors", async () => {
    const token = "devin-session-token$my-secret";
    const trailer = encodeConnectFrame(
      encoder.encode(JSON.stringify({ error: { message: `echo ${token}` } })),
      2,
    );
    const { finish } = await devinChatCompletion(streamOf([trailer]), "model", token);
    expect(finish.error?.message).toBe("echo [REDACTED]");
    const events = sseEvents(
      await readBytes(
        streamOf([trailer]).pipeThrough(devinToChatStream("model", undefined, token)),
      ),
    );
    expect(JSON.stringify(events)).not.toContain(token);
    expect(events.at(-2)).toMatchObject({
      error: { message: "echo [REDACTED]" },
    });

    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`read failed: ${token}`);
      },
    });
    const failed = await devinChatCompletion(body, "model", token);
    expect(failed.finish.error?.message).toBe("Devin stream read failed");
    expect(body.locked).toBe(false);
  });

  it("classifies early error trailer and does not replay it", async () => {
    const earlyError = concat([
      encodeConnectFrame(int(4, 2)),
      encodeConnectFrame(
        encoder.encode(
          '{"error":{"code":"resource_exhausted","message":"Reached message rate limit for this model. Resets in: 3h0m0s"}}',
        ),
        2,
      ),
    ]);
    const result = await peekDevinStream(streamOf([earlyError.slice(0, 7), earlyError.slice(7)]));
    expect(result).toMatchObject({ error: { kind: "rate_limit", status: 429 } });
    if ("error" in result)
      expect(Date.parse(result.error.resetsAt as string) - Date.now()).toBeGreaterThan(
        2 * 60 * 60 * 1000,
      );
  });

  it("collects a complete response and preserves exclusive usage", async () => {
    const { completion, finish } = await devinChatCompletion(
      streamOf([upstreamStream()]),
      "requested-model",
    );
    expect(finish).toEqual({
      usage: { input: 11, output: 7, cacheWrite: 5, cacheRead: 9 },
      model: "actual-model",
    });
    expect(completion).toMatchObject({
      object: "chat.completion",
      model: "requested-model",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Hello world",
            reasoning_content: "think",
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 7,
        total_tokens: 32,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    });
  });
});

describe("Devin unary calls", () => {
  it("parses catalog selectors, metadata, disabled flags and float32 price rows", () => {
    const row = (label: string, price: number) =>
      bytes(32, concat([bytes(1, label), float(2, price)]));
    const model = concat([
      bytes(1, "Test Model"),
      int(4, 1),
      int(10, 3),
      bytes(22, "test-model"),
      bytes(23, concat([int(4, 200000), int(13, 32000)])),
      row("Input", 1.2),
      row("Cached input", 0.2),
      row("Output", 5.5),
    ]);
    expect(
      parseDevinModels(concat([bytes(1, model), bytes(1, bytes(1, "Missing selector"))])),
    ).toEqual([
      {
        id: "test-model",
        label: "Test Model",
        vendor: "anthropic",
        disabled: true,
        contextWindow: 200000,
        maxOutput: 32000,
        price: { input: 1.2, output: 5.5, cacheRead: 0.2 },
      },
    ]);
  });

  it("parses plan, percentages and UTC reset times", () => {
    const plan = concat([
      bytes(1, bytes(2, "Free")),
      int(14, 55),
      int(15, 20),
      int(17, 1700000000),
      int(18, 1700003600),
    ]);
    expect(parseDevinUserStatus(bytes(1, bytes(13, plan)))).toEqual({
      plan: "Free",
      dailyRemainingPercent: 55,
      weeklyRemainingPercent: 20,
      dailyResetsAt: "2023-11-14T22:13:20.000Z",
      weeklyResetsAt: "2023-11-14T23:13:20.000Z",
    });
    expect(parseDevinUserStatus(new Uint8Array())).toEqual({});
  });

  it("sends unframed ClientMetadata for both unary requests", async () => {
    const model = bytes(1, concat([bytes(1, "Free"), bytes(22, "swe-1-6-slow")]));
    const status = bytes(1, bytes(13, bytes(1, bytes(2, "Free"))));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const raw = url.includes("GetCliModelConfigs") ? model : status;
      return new Response(raw, { status: 200 });
    });
    expect((await fetchDevinModels("my-token", "https://example.test/"))[0]?.id).toBe(
      "swe-1-6-slow",
    );
    expect(await fetchDevinUserStatus("my-token", "https://example.test/")).toEqual({
      plan: "Free",
    });
    for (const call of calls) {
      expect(call.url.startsWith("https://example.test/exa.")).toBe(true);
      expect(call.init.method).toBe("POST");
      expect(call.init.headers).toMatchObject({
        authorization: "Basic my-token-my-token",
        "content-type": "application/proto",
      });
      const raw = call.init.body as Uint8Array;
      expect(fields(raw, 1)).toHaveLength(1);
      expect(parse(raw)).toHaveLength(1);
      expect(str(sub(raw, 1), 3)).toBe("my-token");
    }
  });

  it("never throws echoed credentials from unary failures", async () => {
    const token = "opaque$secret-123";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            code: "permission_denied",
            message: `echo ${token} Basic ${token}-${token}`,
          }),
          { status: 403 },
        ),
    );
    for (const call of [fetchDevinModels, fetchDevinUserStatus]) {
      try {
        await call(token);
        throw new Error("Expected Devin unary request to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("Devin authentication failed");
        expect(error.message).not.toContain(token);
      }
    }
  });

  it("throws a readable message on non-200 unary JSON errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"code":"permission_denied","message":"Please sign in"}', { status: 403 }),
    );
    await expect(fetchDevinModels("bad")).rejects.toThrow(
      /GetCliModelConfigs failed \(HTTP 403, auth\): Please sign in/,
    );
  });
});

describe("Devin error classification", () => {
  it("redacts local tokens and unknown session or Basic credentials", () => {
    const token = 'arbitrary"secret\\value';
    const echoed = JSON.stringify({
      message: `local ${token}, ${devinHeaders(token, "unary").authorization}`,
    });
    const local = classifyDevinError(500, echoed, token);
    expect(local.message).not.toContain("arbitrary");
    expect(local.message).not.toContain("secret");
    expect(local.message).not.toContain("Basic");

    for (const text of [
      "failure devin-session-token$abc.def:ghi and more",
      "failure Basic some-unknown-secret-with-hyphens and more",
      '{"message":"failure Basic unknown\\\"embedded-token"}',
      "failure Basic a-b-a-b",
    ]) {
      expect(classifyDevinError(500, text).message).toBe("Devin upstream error");
    }
    expect(classifyDevinError(500, "ordinary failure").message).toBe("ordinary failure");
  });

  it.each([
    [
      401,
      "Reached message rate limit for this model. Please try again later. Resets in: 3h0m0s",
      "rate_limit",
      429,
    ],
    [429, '{"code":"resource_exhausted","message":"try again later"}', "rate_limit", 429],
    [401, '{"code":"unavailable","message":"high demand, try again later"}', "capacity", 503],
    [403, "an internal error occurred (trace ID: abc)", "internal", 502],
    [
      403,
      '{"code":"permission_denied","message":"blocked by our content policy"}',
      "content_policy",
      400,
    ],
    [403, "insufficient credit / quota exceeded", "quota", 429],
    [401, "Please visit /upgrade to access this model", "model_blocked", 403],
    [403, "Upgrade to Pro; this model requires paid access", "model_blocked", 403],
    [403, '{"code":"permission_denied","message":"not allowed"}', "auth", 401],
    [401, '{"code":"unauthenticated","message":"invalid token"}', "auth", 401],
    [500, "something went wrong", "other", 502],
  ])("classifies HTTP %s %s", (status, text, kind, surfacedStatus) => {
    expect(classifyDevinError(status as number, text as string)).toMatchObject({
      kind,
      status: surfacedStatus,
    });
  });
});
