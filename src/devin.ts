/**
 * Devin subscription wire core: Connect-RPC + protobuf against server.codeium.com, the
 * same transport the Devin CLI ("chisel") speaks. This module owns request encoding,
 * response-frame decoding, error classification, and the OpenAI Chat Completions
 * adapters; it holds no routing or credential state.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { Usage } from "./pricing";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

const CLIENT_NAME = "chisel";
const DEFAULT_CLIENT_VERSION = "3000.11.3";
const FINGERPRINT_BYTES = 366;
const DEFAULT_MAX_OUTPUT = 16_384;
const CONTEXT_WINDOW = 128_000;
const DEFAULT_TEMPERATURE = 1;
/** The server answers exactly 0 with "an internal error occurred". */
const MIN_TEMPERATURE = 0.001;
const TOP_K = 40;
const TOP_P = 0.95;
/** Tools with an empty system prompt are rejected upstream (Claude-family selectors). */
const TOOLS_SYSTEM_PROMPT =
  "You are a helpful assistant. Use the available tools when appropriate.";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const FLAG_GZIP = 0x01;
const FLAG_END_STREAM = 0x02;

const SOURCE_USER = 1;
const SOURCE_ASSISTANT = 2;
const SOURCE_TOOL = 4;

// ─── protobuf ───────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Unsigned varint; safe for any non-negative integer up to 2^53. */
function varint(value: number): Uint8Array {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(value));
  while (v > 0x7f) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

const tag = (field: number, wire: number): Uint8Array => varint(field * 8 + wire);

function varintField(field: number, value: number): Uint8Array {
  return concat([tag(field, 0), varint(value)]);
}

function bytesField(field: number, value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  return concat([tag(field, 2), varint(bytes.length), bytes]);
}

function doubleField(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat([tag(field, 1), bytes]);
}

/** Minimal protobuf encoder, exported so tests and other modules can synthesize upstream bytes. */
export const devinPb = { varintField, bytesField, concat };

interface PbField {
  num: number;
  wire: number;
  int?: number;
  bytes?: Uint8Array;
}

/** Decodes one protobuf message level. Throws on truncation or group wire types. */
function decodePb(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (pos >= buf.length) throw new Error("truncated varint");
      const byte = buf[pos++] as number;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 0x80;
    }
    throw new Error("varint too long");
  };
  const take = (length: number): Uint8Array => {
    if (pos + length > buf.length) throw new Error("truncated field");
    const bytes = buf.subarray(pos, pos + length);
    pos += length;
    return bytes;
  };
  while (pos < buf.length) {
    const key = readVarint();
    const num = Math.floor(key / 8);
    const wire = key % 8;
    if (num === 0) throw new Error("invalid field number 0");
    if (wire === 0) out.push({ num, wire, int: readVarint() });
    else if (wire === 2) out.push({ num, wire, bytes: take(readVarint()) });
    else if (wire === 1) out.push({ num, wire, bytes: take(8) });
    else if (wire === 5) out.push({ num, wire, bytes: take(4) });
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

function tryDecodePb(buf: Uint8Array | undefined): PbField[] | undefined {
  if (!buf) return undefined;
  try {
    return decodePb(buf);
  } catch {
    return undefined;
  }
}

const textDecoder = new TextDecoder();

function pbBytes(fields: PbField[], num: number): Uint8Array | undefined {
  return fields.find((f) => f.num === num && f.wire === 2)?.bytes;
}

function pbString(fields: PbField[], num: number): string | undefined {
  const bytes = pbBytes(fields, num);
  return bytes === undefined ? undefined : textDecoder.decode(bytes);
}

function pbInt(fields: PbField[], num: number): number | undefined {
  return fields.find((f) => f.num === num && f.wire === 0)?.int;
}

function pbFloat32(fields: PbField[], num: number): number | undefined {
  const bytes = fields.find((f) => f.num === num && f.wire === 5)?.bytes;
  if (!bytes) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}

function pbSub(fields: PbField[], num: number): PbField[] | undefined {
  return tryDecodePb(pbBytes(fields, num));
}

// ─── client identity ────────────────────────────────────────────────────────

function clientVersion(): string {
  return process.env.JEVONIAN_DEVIN_CLIENT_VERSION?.trim() || DEFAULT_CLIENT_VERSION;
}

function installationIdPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "devin", "cli", "installation_id");
}

/** SHA-256 counter expansion of a seed into `length` bytes. */
function expandSeed(seed: string, length: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  let produced = 0;
  for (let counter = 0; produced < length; counter += 1) {
    const block = createHash("sha256").update(`${seed}-${counter}`).digest();
    blocks.push(block);
    produced += block.length;
  }
  return concat(blocks).subarray(0, length);
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

let randomFingerprint: string | undefined;
let derivedFingerprint: { seed: string; hex: string } | undefined;

/**
 * ClientMetadata #31: 366 bytes as 732 hex chars. Stable per installation when the
 * Devin CLI's installation_id is readable, otherwise random once per process.
 */
function deviceFingerprint(): string {
  let seed = "";
  try {
    seed = readFileSync(installationIdPath(), "utf8");
  } catch {
    seed = "";
  }
  if (seed.trim().length > 0) {
    if (derivedFingerprint?.seed !== seed) {
      derivedFingerprint = { seed, hex: toHex(expandSeed(seed, FINGERPRINT_BYTES)) };
    }
    return derivedFingerprint.hex;
  }
  randomFingerprint ??= toHex(randomBytes(FINGERPRINT_BYTES));
  return randomFingerprint;
}

/** ClientMetadata; the token is embedded once here (doubled only in the auth header). */
function clientMetadata(token: string): Uint8Array {
  const version = clientVersion();
  return concat([
    bytesField(1, CLIENT_NAME),
    bytesField(2, version),
    bytesField(3, token),
    bytesField(4, "en"),
    bytesField(5, process.platform),
    bytesField(7, version),
    bytesField(12, CLIENT_NAME),
    bytesField(31, deviceFingerprint()),
  ]);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function devinChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}${CHAT_PATH}`;
}

export function devinHeaders(token: string, kind: "stream" | "unary"): Record<string, string> {
  const base: Record<string, string> = {
    authorization: `Basic ${token}-${token}`,
    "connect-protocol-version": "1",
    accept: "*/*",
    "user-agent": "connect-es/2.0.0",
  };
  if (kind === "unary") return { ...base, "content-type": "application/proto" };
  return {
    ...base,
    "content-type": "application/connect+proto",
    "connect-accept-encoding": "gzip",
    "sentry-trace": `${toHex(randomBytes(16))}-${toHex(randomBytes(8))}-1`,
  };
}

/** One Connect envelope: flags byte + 4-byte big-endian length + payload. */
export function encodeConnectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, flags);
  view.setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

// ─── request encoding ───────────────────────────────────────────────────────

export interface DevinChatOptions {
  sessionId?: string;
  maxOutput?: number;
}

interface DevinImage {
  data: string;
  mime: string;
}

interface DevinToolCallInput {
  id: string;
  name: string;
  args: string;
}

interface DevinTurn {
  source: number;
  text: string;
  images: DevinImage[];
  toolCalls: DevinToolCallInput[];
  toolCallId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flattens Chat Completions content (string or parts) into plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      const record = asRecord(part);
      if (typeof record.text === "string") return record.text;
      if (typeof part === "string") return part;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is;

/** Inline `data:` images only; remote URLs would need a fetch and are skipped. */
function contentImages(content: unknown): DevinImage[] {
  if (!Array.isArray(content)) return [];
  const images: DevinImage[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record.type !== "image_url") continue;
    const raw = record.image_url;
    const url = typeof raw === "string" ? raw : asString(asRecord(raw).url);
    const match = DATA_URL.exec(url.replace(/\s/g, ""));
    if (match?.[1] && match[2]) images.push({ mime: match[1].toLowerCase(), data: match[2] });
  }
  return images;
}

function argumentsJson(value: unknown): string {
  if (typeof value === "string") return value.trim().length > 0 ? value : "{}";
  return JSON.stringify(value ?? {});
}

function assistantToolCalls(raw: unknown): DevinToolCallInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const call = asRecord(entry);
    const fn = asRecord(call.function);
    const name = asString(fn.name) || asString(call.name);
    if (name.length === 0) return [];
    return [
      {
        id: asString(call.id) || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name,
        args: argumentsJson(fn.arguments ?? call.arguments),
      },
    ];
  });
}

function isPlainText(turn: DevinTurn): boolean {
  return (
    (turn.source === SOURCE_USER || turn.source === SOURCE_ASSISTANT) &&
    turn.images.length === 0 &&
    turn.toolCalls.length === 0 &&
    turn.toolCallId === undefined
  );
}

/** Splits Chat Completions messages into the system prompt and Devin turns. */
function toTurns(messages: unknown[]): { system: string; turns: DevinTurn[] } {
  const systemParts: string[] = [];
  const turns: DevinTurn[] = [];
  const push = (turn: DevinTurn): void => {
    const last = turns.at(-1);
    // The server rejects runs of >=3 same-source text-only turns; merging keeps the text.
    if (last && last.source === turn.source && isPlainText(last) && isPlainText(turn)) {
      last.text = [last.text, turn.text].filter((text) => text.length > 0).join("\n\n");
      return;
    }
    turns.push(turn);
  };

  for (const raw of messages) {
    const message = asRecord(raw);
    const role = message.role;
    const text = contentText(message.content);
    if (role === "system" || role === "developer") {
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const callId = asString(message.tool_call_id);
      const images = contentImages(message.content);
      if (callId.length === 0) {
        push({ source: SOURCE_USER, text: `[tool result]: ${text}`, images, toolCalls: [] });
      } else {
        push({
          source: SOURCE_TOOL,
          text: text.length > 0 ? text : "(no output)",
          images,
          toolCalls: [],
          toolCallId: callId,
        });
      }
      continue;
    }
    if (role === "assistant") {
      const toolCalls = assistantToolCalls(message.tool_calls);
      // Empty assistant turns carry nothing and upstream rejects them on some selectors.
      if (text.trim().length === 0 && toolCalls.length === 0) continue;
      push({ source: SOURCE_ASSISTANT, text, images: [], toolCalls });
      continue;
    }
    push({ source: SOURCE_USER, text, images: contentImages(message.content), toolCalls: [] });
  }
  return { system: systemParts.join("\n\n"), turns };
}

function encodeTurn(turn: DevinTurn): Uint8Array {
  const parts = [
    bytesField(1, randomUUID()),
    varintField(2, turn.source),
    bytesField(3, turn.text),
  ];
  for (const call of turn.toolCalls) {
    parts.push(
      bytesField(
        6,
        concat([bytesField(1, call.id), bytesField(2, call.name), bytesField(3, call.args)]),
      ),
    );
  }
  if (turn.toolCallId !== undefined) parts.push(bytesField(7, turn.toolCallId));
  for (const image of turn.images) {
    parts.push(bytesField(10, concat([bytesField(1, image.data), bytesField(2, image.mime)])));
  }
  return concat(parts);
}

/** Devin rejects some client tool-description annotations in its MCP validator. Keep the
 * parameter names and schema constraints, but move prose into the system prompt instead. */
function stripSchemaDescriptions(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchemaDescriptions(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => propertyMap || key !== "description")
      .map(([key, item]) => [key, stripSchemaDescriptions(item, key === "properties")]),
  );
}

function encodeTools(raw: unknown): { definitions: Uint8Array[]; descriptions: string[] } {
  if (!Array.isArray(raw)) return { definitions: [], descriptions: [] };
  const definitions: Uint8Array[] = [];
  const descriptions: string[] = [];
  for (const entry of raw) {
    const tool = asRecord(entry);
    if (tool.type !== undefined && tool.type !== "function") continue;
    const fn = asRecord(tool.function);
    const name = asString(fn.name);
    if (name.length === 0) continue;
    const description = asString(fn.description);
    if (description.length > 0) descriptions.push(`${name}: ${description}`);
    const parameters =
      fn.parameters === undefined ? { type: "object", properties: {} } : fn.parameters;
    definitions.push(
      bytesField(
        10,
        concat([
          bytesField(1, name),
          bytesField(2, name),
          bytesField(3, JSON.stringify(stripSchemaDescriptions(parameters))),
        ]),
      ),
    );
  }
  return { definitions, descriptions };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session ids ride as UUIDs; arbitrary caller keys map to a stable UUID-shaped digest. */
function sessionUuid(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim() ?? "";
  if (trimmed.length === 0) return randomUUID();
  if (UUID_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  const hex = createHash("sha256").update(trimmed).digest("hex");
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/** OpenAI Chat Completions request body -> enveloped GetChatMessage frame, ready to POST. */
export function buildDevinChatRequest(
  token: string,
  body: Record<string, unknown>,
  model: string,
  options: DevinChatOptions = {},
): Uint8Array {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const { system: joinedSystem, turns } = toTurns(messages);
  const tools = encodeTools(body.tools);
  const system = [
    joinedSystem || (tools.definitions.length > 0 ? TOOLS_SYSTEM_PROMPT : ""),
    tools.descriptions.length > 0
      ? `Available tools and when to use them:\n${tools.descriptions.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const maxTokens =
    positiveInt(body.max_completion_tokens) ??
    positiveInt(body.max_tokens) ??
    positiveInt(options.maxOutput) ??
    DEFAULT_MAX_OUTPUT;
  const rawTemperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? body.temperature
      : DEFAULT_TEMPERATURE;
  const temperature = Math.max(MIN_TEMPERATURE, rawTemperature);
  const session = sessionUuid(options.sessionId);

  const completionConfig = concat([
    varintField(1, 1),
    varintField(2, maxTokens),
    varintField(3, CONTEXT_WINDOW),
    doubleField(5, temperature),
    varintField(7, TOP_K),
    doubleField(8, TOP_P),
  ]);
  const proto = concat([
    bytesField(1, clientMetadata(token)),
    bytesField(2, system),
    ...turns.map((turn) => bytesField(3, encodeTurn(turn))),
    varintField(7, 5),
    bytesField(8, completionConfig),
    ...tools.definitions,
    bytesField(15, concat([bytesField(1, session), varintField(3, 4), varintField(4, 14)])),
    bytesField(16, session),
    varintField(20, 1),
    bytesField(21, model),
  ]);
  // The server rejects gzipped request frames, so the envelope flag is always 0.
  return encodeConnectFrame(proto, 0);
}

// ─── error classification ───────────────────────────────────────────────────

export type DevinErrorKind =
  | "quota"
  | "rate_limit"
  | "capacity"
  | "internal"
  | "content_policy"
  | "model_blocked"
  | "auth"
  | "other";

export interface DevinStreamError {
  status: number;
  kind: DevinErrorKind;
  message: string;
  resetsAt?: string;
}

const KIND_STATUS: Record<DevinErrorKind, number> = {
  quota: 429,
  rate_limit: 429,
  capacity: 503,
  internal: 502,
  content_policy: 400,
  model_blocked: 403,
  auth: 401,
  other: 502,
};

const KIND_DEFAULT_MESSAGE: Record<DevinErrorKind, string> = {
  quota: "Devin account is out of credit or quota",
  rate_limit: "Devin rate limit reached",
  capacity: "Devin model is temporarily at capacity",
  internal: "Devin upstream internal error",
  content_policy: "Request blocked by Devin content policy",
  model_blocked: "Model requires a paid Devin plan",
  auth: "Devin authentication failed",
  other: "Devin upstream error",
};

/** Max reset window honoured from a "Resets in: 3h0m0s" hint. */
const MAX_RESET_MS = 7 * 24 * 3_600_000;

/** Parses Go `time.Duration` reset hints ("Resets in: 3h0m0s", "resets in 45s") into ms. */
function resetDurationMs(text: string): number | undefined {
  const match = /resets? in[:\s]+((?:\d+h)?(?:\d+m(?!s))?(?:\d+(?:\.\d+)?s)?)/i.exec(text);
  const duration = match?.[1];
  if (!duration) return undefined;
  const hours = /(\d+)h/.exec(duration)?.[1];
  const minutes = /(\d+)m(?!s)/.exec(duration)?.[1];
  const seconds = /(\d+(?:\.\d+)?)s/.exec(duration)?.[1];
  const ms =
    Number(hours ?? 0) * 3_600_000 + Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1000;
  return ms > 0 ? Math.min(ms, MAX_RESET_MS) : undefined;
}

/** Pulls `{code,message}` out of unary (`{code,message}`) or trailer (`{error:{...}}`) JSON. */
function errorParts(text: string): { code: string; message: string } {
  const trimmed = text.trim();
  try {
    const parsed = asRecord(JSON.parse(trimmed));
    const inner = asRecord(parsed.error);
    const source = Object.keys(inner).length > 0 ? inner : parsed;
    const message =
      asString(source.message) || (typeof parsed.error === "string" ? parsed.error : "");
    return { code: asString(source.code).toLowerCase(), message: message || trimmed };
  } catch {
    return { code: "", message: trimmed };
  }
}

function classifyKind(status: number, code: string, lc: string): DevinErrorKind {
  // A hard per-model limit carries its reset window; it must beat the "try again later" capacity arm.
  if (/rate limit/.test(lc) && /resets? in[:\s]/.test(lc)) return "rate_limit";
  if (
    /insufficient.*(credit|quota|balance|funds)|out of (credits?|quota)|quota.*exceeded|exceeded.*quota|credits?.*exhausted/.test(
      lc,
    )
  ) {
    return "quota";
  }
  if (status === 429 || code === "resource_exhausted") return "rate_limit";
  // Transient faults often arrive in a 401/403 shell, so text patterns win over status.
  if (
    code === "unavailable" ||
    /high demand|try again later|currently (busy|overloaded|at capacity)|overloaded|temporarily (busy|unavailable)|server is busy|(service|backend|model|server) (is )?(temporarily )?unavailable|at capacity/.test(
      lc,
    )
  ) {
    return "capacity";
  }
  if (/internal error occurred/.test(lc)) return "internal";
  if (
    /blocked by (our |the )?content policy|remove (sensitive|unsafe) content|content[_ ]policy/.test(
      lc,
    )
  ) {
    return "content_policy";
  }
  if (
    /\/upgrade|upgrade to (access|pro|a paid)|insufficient.*entitlement|requires? (a )?(paid|pro|team|teams|enterprise)/.test(
      lc,
    )
  ) {
    return "model_blocked";
  }
  // A tool-schema gate the server reports as permission_denied; the token is fine.
  if (/mcp configuration issue/.test(lc)) return "other";
  if (
    status === 401 ||
    status === 403 ||
    code === "permission_denied" ||
    code === "unauthenticated" ||
    /permission_denied|unauthenticated|invalid.*token|token.*(expired|invalid|revoked)/.test(lc)
  ) {
    return "auth";
  }
  if (/rate.?limit|too many requests|resource_exhausted/.test(lc)) return "rate_limit";
  return "other";
}

/** Scrub credentials before upstream text can reach an exception, client, or ledger. */
function redactDevinCredentials(message: string, kind: DevinErrorKind, token?: string): string {
  let safe = message;
  if (token) {
    // Cover arbitrary local tokens, including regex metacharacters and JSON-escaped echoes.
    for (const secret of [token, JSON.stringify(token).slice(1, -1)]) {
      if (secret) safe = safe.split(secret).join("[REDACTED]");
    }
  }
  // A label may precede an unknown credential with arbitrary punctuation or escapes.
  // Do not guess its boundary: discard the entire message rather than risk a partial leak.
  if (/devin-session-token\$|\bBasic\s+/i.test(safe)) return KIND_DEFAULT_MESSAGE[kind];
  return safe;
}

/**
 * Maps an upstream failure (HTTP status plus body or trailer text) to a routing-relevant
 * kind and the HTTP status to surface. Pass status 0 for in-stream trailer errors.
 * Supply the local token when available so even nonstandard credential formats are scrubbed.
 */
export function classifyDevinError(status: number, text: string, token?: string): DevinStreamError {
  const { code, message } = errorParts(text);
  const lc = `${code} ${message}`.toLowerCase();
  const kind = classifyKind(status, code, lc);
  const error: DevinStreamError = {
    status: KIND_STATUS[kind],
    kind,
    message: redactDevinCredentials(message || KIND_DEFAULT_MESSAGE[kind], kind, token).slice(
      0,
      2000,
    ),
  };
  if (kind === "rate_limit" || kind === "quota") {
    const ms = resetDurationMs(message);
    if (ms !== undefined) error.resetsAt = new Date(Date.now() + ms).toISOString();
  }
  return error;
}

// ─── response frames ────────────────────────────────────────────────────────

interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
}

/** Incremental Connect envelope splitter; tolerates frames split across arbitrary chunks. */
class FrameSplitter {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): ConnectFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : concat([this.buffer, chunk]);
    const frames: ConnectFrame[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 5);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (length > MAX_FRAME_BYTES) throw new Error(`Devin frame of ${length} bytes exceeds limit`);
      if (this.buffer.length - offset < 5 + length) break;
      frames.push({ flags, payload: this.buffer.slice(offset + 5, offset + 5 + length) });
      offset += 5 + length;
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.slice(offset);
    return frames;
  }

  get pending(): number {
    return this.buffer.length;
  }
}

function framePayload(frame: ConnectFrame): Uint8Array {
  return frame.flags & FLAG_GZIP ? new Uint8Array(gunzipSync(frame.payload)) : frame.payload;
}

/** End-stream trailer JSON: `{}` on success, `{"error":{...}}` on failure. */
function trailerError(payload: Uint8Array, token?: string): DevinStreamError | undefined {
  const text = textDecoder.decode(payload).trim();
  if (text.length === 0 || text === "{}") return undefined;
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed.error === undefined) return undefined;
  } catch {
    return undefined;
  }
  return classifyDevinError(0, text, token);
}

interface ToolCallDelta {
  id: string;
  name: string;
  args: Uint8Array;
}

interface UsageDelta {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  model?: string;
}

interface FrameDelta {
  text?: Uint8Array;
  thinking?: Uint8Array;
  stop?: number;
  toolCalls: ToolCallDelta[];
  usage?: UsageDelta;
}

function decodeFrame(payload: Uint8Array): FrameDelta | undefined {
  const fields = tryDecodePb(payload);
  if (!fields) return undefined;
  const delta: FrameDelta = { toolCalls: [] };
  const texts: Uint8Array[] = [];
  const thoughts: Uint8Array[] = [];
  for (const field of fields) {
    if (field.wire === 2 && field.bytes) {
      if (field.num === 3) texts.push(field.bytes);
      else if (field.num === 9) thoughts.push(field.bytes);
      else if (field.num === 6) {
        const call = tryDecodePb(field.bytes);
        if (call) {
          delta.toolCalls.push({
            id: pbString(call, 1) ?? "",
            name: pbString(call, 2) ?? "",
            args: pbBytes(call, 3) ?? new Uint8Array(0),
          });
        }
      } else if (field.num === 7) {
        const usage = tryDecodePb(field.bytes);
        if (usage) {
          delta.usage = {
            input: pbInt(usage, 2),
            output: pbInt(usage, 3),
            cacheWrite: pbInt(usage, 4),
            cacheRead: pbInt(usage, 5),
            model: pbString(usage, 9),
          };
        }
      }
    } else if (field.wire === 0 && field.num === 5) delta.stop = field.int;
  }
  if (texts.length > 0) delta.text = concat(texts);
  if (thoughts.length > 0) delta.thinking = concat(thoughts);
  return delta;
}

/** Whether a data frame commits visible output (text, reasoning, or a tool call). */
function frameHasContent(payload: Uint8Array): boolean {
  const delta = decodeFrame(payload);
  if (!delta) return false;
  return (
    (delta.text?.length ?? 0) > 0 || (delta.thinking?.length ?? 0) > 0 || delta.toolCalls.length > 0
  );
}

// ─── stream assembly ────────────────────────────────────────────────────────

export interface DevinFinish {
  usage: Usage;
  model?: string;
  error?: DevinStreamError;
}

interface DevinCall {
  index: number;
  id: string;
  name: string;
  args: string;
  decoder: TextDecoder;
}

type DevinEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "call"; call: DevinCall; start: boolean; name?: string; args: string };

/** Top-level #5 values; only 2/4 (clean stop) and 10 (tool calls) are live-calibrated. */
const STOP_REASONS: Record<number, string> = { 2: "stop", 4: "stop", 10: "tool_calls" };

const truncatedError = (): DevinStreamError => ({
  status: 502,
  kind: "internal",
  message: "Devin stream ended without an end-of-stream trailer",
});

function newCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Folds Connect frames into text/reasoning/tool-call events plus terminal usage and status. */
class DevinStreamState {
  constructor(token?: string) {
    this.token = token;
  }

  private readonly token?: string;
  readonly calls: DevinCall[] = [];
  usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  model?: string;
  stop?: number;
  error?: DevinStreamError;
  ended = false;
  private readonly splitter = new FrameSplitter();
  private readonly text = new TextDecoder();
  private readonly thinking = new TextDecoder();

  push(chunk: Uint8Array): DevinEvent[] {
    if (this.ended || this.error) return [];
    const events: DevinEvent[] = [];
    try {
      for (const frame of this.splitter.push(chunk)) {
        if (frame.flags & FLAG_END_STREAM) {
          this.ended = true;
          this.error = trailerError(framePayload(frame), this.token);
          break;
        }
        const delta = decodeFrame(framePayload(frame));
        if (delta) this.apply(delta, events);
      }
    } catch {
      this.error = {
        status: 502,
        kind: "other",
        message: "Devin stream decode failed",
      };
    }
    return events;
  }

  /** Flushes split UTF-8 tails and records truncation when no trailer arrived. */
  finish(): DevinEvent[] {
    const events: DevinEvent[] = [];
    const thinking = this.thinking.decode();
    if (thinking.length > 0) events.push({ type: "thinking", text: thinking });
    const text = this.text.decode();
    if (text.length > 0) events.push({ type: "text", text });
    for (const call of this.calls) {
      const tail = call.decoder.decode();
      if (tail.length > 0) {
        call.args += tail;
        events.push({ type: "call", call, start: false, args: tail });
      }
    }
    if (!this.ended && !this.error) this.error = truncatedError();
    return events;
  }

  finishReason(): string {
    if (this.calls.length > 0) return "tool_calls";
    return (this.stop === undefined ? undefined : STOP_REASONS[this.stop]) ?? "stop";
  }

  result(): DevinFinish {
    return {
      usage: { ...this.usage },
      ...(this.model ? { model: this.model } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private apply(delta: FrameDelta, events: DevinEvent[]): void {
    if (delta.thinking) {
      const text = this.thinking.decode(delta.thinking, { stream: true });
      if (text.length > 0) events.push({ type: "thinking", text });
    }
    if (delta.text) {
      const text = this.text.decode(delta.text, { stream: true });
      if (text.length > 0) events.push({ type: "text", text });
    }
    for (const part of delta.toolCalls) this.applyCall(part, events);
    if (delta.stop !== undefined) this.stop = delta.stop;
    const usage = delta.usage;
    if (usage) {
      if (usage.input !== undefined) this.usage.input = usage.input;
      if (usage.output !== undefined) this.usage.output = usage.output;
      if (usage.cacheWrite !== undefined) this.usage.cacheWrite = usage.cacheWrite;
      if (usage.cacheRead !== undefined) this.usage.cacheRead = usage.cacheRead;
      if (usage.model) this.model = usage.model;
    }
  }

  /** A new id opens a call; an empty (or repeated) id continues the matching call. */
  private applyCall(part: ToolCallDelta, events: DevinEvent[]): void {
    const last = this.calls.at(-1);
    let call = part.id.length > 0 ? this.calls.find((c) => c.id === part.id) : last;
    let start = false;
    if (!call) {
      call = {
        index: this.calls.length,
        id: part.id || newCallId(),
        name: part.name,
        args: "",
        decoder: new TextDecoder(),
      };
      this.calls.push(call);
      start = true;
    }
    let name: string | undefined;
    if (!start && part.name.length > 0 && call.name.length === 0) {
      call.name = part.name;
      name = part.name;
    }
    const args = part.args.length > 0 ? call.decoder.decode(part.args, { stream: true }) : "";
    call.args += args;
    if (start || name !== undefined || args.length > 0) {
      events.push({ type: "call", call, start, ...(name !== undefined ? { name } : {}), args });
    }
  }
}

function openaiUsage(usage: Usage): Record<string, unknown> {
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  };
}

function completionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function streamedCallDelta(event: Extract<DevinEvent, { type: "call" }>): Record<string, unknown> {
  if (event.start) {
    return {
      index: event.call.index,
      id: event.call.id,
      type: "function",
      function: { name: event.call.name, arguments: event.args },
    };
  }
  return {
    index: event.call.index,
    function: { ...(event.name !== undefined ? { name: event.name } : {}), arguments: event.args },
  };
}

/**
 * Connect frames -> OpenAI chat.completion.chunk SSE. Emits the role chunk first, then
 * content / reasoning_content / tool_calls deltas, and a final chunk with finish_reason
 * and usage. A trailer error (or truncation) emits an SSE error event instead of the
 * final chunk. Calls onFinish exactly once, including on cancellation.
 */
export function devinToChatStream(
  model: string,
  onFinish?: (finish: DevinFinish) => void,
  token?: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const state = new DevinStreamState(token);
  let reported = false;

  const report = (): void => {
    if (reported) return;
    reported = true;
    onFinish?.(state.result());
  };
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const emit = (
    payload: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const emitEvents = (
    events: DevinEvent[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    for (const event of events) {
      if (event.type === "text") emit(chunk({ content: event.text }, null), controller);
      else if (event.type === "thinking") {
        emit(chunk({ reasoning_content: event.text }, null), controller);
      } else emit(chunk({ tool_calls: [streamedCallDelta(event)] }, null), controller);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      emit(chunk({ role: "assistant", content: "" }, null), controller);
    },
    transform(input, controller) {
      emitEvents(state.push(input), controller);
    },
    flush(controller) {
      emitEvents(state.finish(), controller);
      if (state.error) {
        emit({ error: { message: state.error.message, type: "upstream_error" } }, controller);
      } else {
        emit({ ...chunk({}, state.finishReason()), usage: openaiUsage(state.usage) }, controller);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      report();
    },
    cancel() {
      state.error ??= {
        status: 502,
        kind: "internal",
        message: "Devin stream aborted",
      };
      report();
    },
  });
}

/**
 * Collects a full stream into a non-streaming chat.completion. A trailer error or
 * truncation is reported on `finish.error`; the completion then holds partial output.
 */
export async function devinChatCompletion(
  body: ReadableStream<Uint8Array>,
  model: string,
  token?: string,
): Promise<{ completion: Record<string, unknown>; finish: DevinFinish }> {
  const state = new DevinStreamState(token);
  let content = "";
  let reasoning = "";
  const collect = (events: DevinEvent[]): void => {
    for (const event of events) {
      if (event.type === "text") content += event.text;
      else if (event.type === "thinking") reasoning += event.text;
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      collect(state.push(value));
      if (state.ended || state.error) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    state.error ??= {
      status: 502,
      kind: "internal",
      message: "Devin stream read failed",
    };
    await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  collect(state.finish());

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (state.calls.length > 0) {
    message.tool_calls = state.calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args },
    }));
  }
  const completion = {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason() }],
    usage: openaiUsage(state.usage),
  };
  return { completion, finish: state.result() };
}

/**
 * Reads until the first content-bearing data frame (text, reasoning, or tool call) or
 * the end-stream trailer. An error trailer or truncated stream before any content
 * returns `{ error }`; otherwise the returned stream replays every byte read so
 * far followed by the rest of the body.
 */
export async function peekDevinStream(
  body: ReadableStream<Uint8Array>,
  token?: string,
): Promise<{ stream: ReadableStream<Uint8Array> } | { error: DevinStreamError }> {
  const reader = body.getReader();
  const seen: Uint8Array[] = [];
  const splitter = new FrameSplitter();
  let handedOff = false;
  try {
    let decided = false;
    while (!decided) {
      const { value, done } = await reader.read();
      if (done) {
        // No content and no trailer is a truncated, unusable stream.
        return { error: truncatedError() };
      }
      seen.push(value);
      let frames: ConnectFrame[];
      try {
        frames = splitter.push(value);
      } catch {
        return { error: { status: 502, kind: "other", message: "Devin stream decode failed" } };
      }
      for (const frame of frames) {
        let payload: Uint8Array;
        try {
          payload = framePayload(frame);
        } catch {
          return {
            error: { status: 502, kind: "other", message: "Devin frame decompression failed" },
          };
        }
        if (frame.flags & FLAG_END_STREAM) {
          const error = trailerError(payload, token);
          if (error) return { error };
          decided = true;
          break;
        }
        if (frameHasContent(payload)) {
          decided = true;
          break;
        }
      }
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of seen) controller.enqueue(chunk);
      },
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            release();
          } else controller.enqueue(value);
        } catch {
          controller.error(new Error("Devin stream read failed"));
          await reader.cancel().catch(() => undefined);
          release();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });
    handedOff = true;
    return { stream };
  } catch {
    return { error: { status: 502, kind: "other", message: "Devin stream read failed" } };
  } finally {
    if (!handedOff) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

// ─── catalog and account status ─────────────────────────────────────────────

export interface DevinModel {
  id: string;
  label: string;
  vendor?: string;
  disabled: boolean;
  contextWindow?: number;
  maxOutput?: number;
  price?: { input: number; output: number; cacheRead?: number };
}

const PROVIDER_VENDORS: Record<number, string> = {
  1: "cognition",
  2: "openai",
  3: "anthropic",
  4: "google",
  7: "moonshot",
  9: "zhipu",
};

/** Float32 prices ("0.2000000029") rounded back to the decimal the server meant. */
function roundPrice(value: number): number {
  return Number(value.toPrecision(6));
}

function modelPrice(fields: PbField[]): DevinModel["price"] {
  const rows = new Map<string, number>();
  for (const field of fields) {
    if (field.num !== 32) continue;
    const row = tryDecodePb(field.bytes);
    if (!row) continue;
    const label = pbString(row, 1)?.trim().toLowerCase();
    const value = pbFloat32(row, 2);
    if (label && value !== undefined && Number.isFinite(value)) rows.set(label, roundPrice(value));
  }
  const input = rows.get("input");
  const output = rows.get("output");
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = rows.get("cached input");
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) };
}

/** Decodes GetCliModelConfigs; entries without a selector (#22) are dropped. */
export function parseDevinModels(raw: Uint8Array): DevinModel[] {
  const models: DevinModel[] = [];
  for (const entry of tryDecodePb(raw) ?? []) {
    if (entry.num !== 1) continue;
    const fields = tryDecodePb(entry.bytes);
    if (!fields) continue;
    const id = pbString(fields, 22)?.trim();
    if (!id) continue;
    const info = pbSub(fields, 23) ?? [];
    const provider = pbInt(fields, 10);
    const vendor = provider === undefined ? undefined : PROVIDER_VENDORS[provider];
    const contextWindow = pbInt(info, 4);
    const maxOutput = pbInt(info, 13);
    const price = modelPrice(fields);
    models.push({
      id,
      label: pbString(fields, 1)?.trim() || id,
      ...(vendor ? { vendor } : {}),
      disabled: pbInt(fields, 4) === 1,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(price ? { price } : {}),
    });
  }
  return models;
}

export interface DevinUserStatus {
  plan?: string;
  dailyRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  dailyResetsAt?: string;
  weeklyResetsAt?: string;
}

function unixIso(seconds: number | undefined): string | undefined {
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

/** Decodes GetUserStatus: #1 user_status → #13 plan_status. */
export function parseDevinUserStatus(raw: Uint8Array): DevinUserStatus {
  const status = pbSub(tryDecodePb(raw) ?? [], 1);
  const planStatus = status ? pbSub(status, 13) : undefined;
  if (!planStatus) return {};
  const planInfo = pbSub(planStatus, 1);
  const plan = planInfo ? pbString(planInfo, 2)?.trim() : undefined;
  const daily = pbInt(planStatus, 14);
  const weekly = pbInt(planStatus, 15);
  const dailyResetsAt = unixIso(pbInt(planStatus, 17));
  const weeklyResetsAt = unixIso(pbInt(planStatus, 18));
  return {
    ...(plan ? { plan } : {}),
    ...(daily !== undefined ? { dailyRemainingPercent: daily } : {}),
    ...(weekly !== undefined ? { weeklyRemainingPercent: weekly } : {}),
    ...(dailyResetsAt ? { dailyResetsAt } : {}),
    ...(weeklyResetsAt ? { weeklyResetsAt } : {}),
  };
}

/** Unary Connect call: raw protobuf body = ClientMetadata only; errors are JSON. */
async function devinUnary(
  token: string,
  baseUrl: string | undefined,
  path: string,
): Promise<Uint8Array> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: "POST",
    headers: devinHeaders(token, "unary"),
    body: bytesField(1, clientMetadata(token)),
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const error = classifyDevinError(response.status, textDecoder.decode(raw), token);
    const method = path.slice(path.lastIndexOf("/") + 1);
    throw new Error(
      `Devin ${method} failed (HTTP ${response.status}, ${error.kind}): ${error.message}`,
    );
  }
  return raw;
}

export async function fetchDevinModels(token: string, baseUrl?: string): Promise<DevinModel[]> {
  return parseDevinModels(await devinUnary(token, baseUrl, MODELS_PATH));
}

export async function fetchDevinUserStatus(
  token: string,
  baseUrl?: string,
): Promise<DevinUserStatus> {
  return parseDevinUserStatus(await devinUnary(token, baseUrl, USER_STATUS_PATH));
}
