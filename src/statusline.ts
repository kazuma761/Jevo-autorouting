/**
 * Claude Code status line for `jevonian launch claude`.
 *
 * Claude Code shows the model it asked for (`jevonian/auto`), never the one Jev routed the
 * turn to, so the routing decision is invisible in the terminal. Claude Code runs a status
 * line command after each turn and pipes the session as JSON on stdin; this reads the ledger
 * for that session and prints the model, scenario and Jev's confidence for the latest turn.
 *
 * @see https://code.claude.com/docs/en/statusline
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { ledgerPath } from "./paths";

/** The ledger fields the status line reads. */
export interface StatusRecord {
  ts?: string;
  kind?: string;
  session?: string;
  requestedModel?: string;
  model?: string;
  provider?: string;
  phase?: string;
  routed?: boolean;
  brain?: string;
  confidence?: number;
  effort?: string;
  latencyMs?: number;
  status?: number;
}

/** What Claude Code pipes to a status line command (the fields used here). */
export interface StatusInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string };
  context_window?: { used_percentage?: number };
}

const TAIL_BYTES = 512 * 1024;

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const FAMILY_COLOR: [RegExp, string][] = [
  [/haiku/i, "\x1b[32m"],
  [/sonnet/i, "\x1b[36m"],
  [/opus/i, "\x1b[35m"],
  [/fable|mythos/i, "\x1b[33m"],
  [/gpt|o\d/i, "\x1b[33m"],
];

function colorFor(model: string): string {
  return FAMILY_COLOR.find(([pattern]) => pattern.test(model))?.[1] ?? "";
}

/** The ledger's last `bytes`, split into parsed records; a partial first line is dropped. */
export function readLedgerTail(file = ledgerPath(), bytes = TAIL_BYTES): StatusRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const records: StatusRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StatusRecord);
      } catch {
        // A line being appended right now; it will be complete on the next render.
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The decision to show for a Claude Code session: its latest routed request. Claude Code
 * also makes small background calls (titles, summaries) that are pinned to a routing rather
 * than decided by Jev; those only count when nothing was routed yet.
 */
export function latestForSession(
  records: StatusRecord[],
  sessionId: string | undefined,
): StatusRecord | undefined {
  if (!sessionId) return undefined;
  const needle = `"session_id":"${sessionId}"`;
  let fallback: StatusRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    if (record.kind === "brain" || !record.session?.includes(needle)) continue;
    if (record.brain) return record;
    fallback ??= record;
  }
  return fallback;
}

function seconds(ms: number | undefined): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One status line: the routed model and why, then the folder and context use. */
export function renderStatusLine(input: StatusInput, record: StatusRecord | undefined): string {
  const dir = (input.workspace?.current_dir ?? input.cwd ?? "").split(/[\\/]/).pop() ?? "";
  const pct = Math.round(input.context_window?.used_percentage ?? 0);
  const tail = `${DIM}·${RESET} ${dir} ${DIM}· ${pct}% context${RESET}`;

  if (!record) return `${DIM}⚡ Jevo: waiting for the first prompt${RESET} ${tail}`;

  const model = record.model ?? "?";
  if (typeof record.status === "number" && record.status >= 400) {
    return `${RED}✖ Jevo: ${model} failed (HTTP ${record.status})${RESET} ${DIM}— see the Logs page${RESET} ${tail}`;
  }

  const routedByJev = record.brain === "jev" || record.brain === "jev-low-confidence";
  const parts = [`⚡ Jevo → ${colorFor(model)}${model}${RESET}`];
  if (record.phase) parts.push(record.phase);
  if (routedByJev) {
    const conf =
      typeof record.confidence === "number" ? ` ${Math.round(record.confidence * 100)}%` : "";
    parts.push(record.brain === "jev-low-confidence" ? `Jev low-confidence${conf}` : `Jev${conf}`);
  } else if (record.brain) {
    // Every brain channel failed and a fixed rule chose the routing instead.
    parts.push(`${RED}${record.brain} (Jev unavailable)${RESET}`);
  } else if (!record.requestedModel?.startsWith("jevonian/auto")) {
    parts.push(`pinned ${record.requestedModel ?? ""}`.trim());
  }
  if (record.effort) parts.push(`effort ${record.effort}`);
  const took = seconds(record.latencyMs);
  if (took) parts.push(took);
  return `${parts.join(` ${DIM}·${RESET} `)} ${tail}`;
}

/** `jevonian statusline`: read Claude Code's session JSON on stdin and print one line. */
export async function statusLineCommand(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let input: StatusInput = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as StatusInput;
  } catch {
    // Malformed input still gets the waiting line below.
  }
  const record = latestForSession(readLedgerTail(), input.session_id);
  process.stdout.write(`${renderStatusLine(input, record)}\n`);
}
