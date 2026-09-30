import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  latestForSession,
  readLedgerTail,
  renderStatusLine,
  type StatusRecord,
} from "./statusline";

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const session = (id: string) =>
  JSON.stringify({ device_id: "d", account_uuid: "", session_id: id });

const routed = (id: string, extra: Partial<StatusRecord> = {}): StatusRecord => ({
  session: session(id),
  requestedModel: "jevonian/auto",
  model: "claude-haiku-4-5",
  phase: "chat",
  routed: true,
  brain: "jev",
  confidence: 0.98,
  effort: "low",
  latencyMs: 1234,
  status: 200,
  ...extra,
});

describe("latestForSession", () => {
  it("returns the newest routed request for the session, ignoring other sessions", () => {
    const records = [
      routed("a", { model: "claude-opus-5-5" }),
      routed("b", { model: "gpt-5.5" }),
      routed("a", { model: "claude-sonnet-5" }),
    ];
    expect(latestForSession(records, "a")?.model).toBe("claude-sonnet-5");
  });

  it("prefers Jev's decision over a later background call pinned to a routing", () => {
    const records = [
      routed("a", { model: "claude-opus-5-5", phase: "plan" }),
      { session: session("a"), requestedModel: "jevonian/utility", model: "claude-haiku-4-5" },
      { kind: "brain", session: session("a") },
    ];
    expect(latestForSession(records, "a")?.model).toBe("claude-opus-5-5");
  });

  it("falls back to any request when nothing was routed yet, and to nothing without an id", () => {
    const pinned = {
      session: session("a"),
      requestedModel: "claude-opus-5-5",
      model: "claude-opus-5-5",
    };
    expect(latestForSession([pinned], "a")).toBe(pinned);
    expect(latestForSession([pinned], undefined)).toBeUndefined();
  });
});

describe("renderStatusLine", () => {
  const input = {
    workspace: { current_dir: "/Users/me/Shop-fly" },
    context_window: { used_percentage: 12.4 },
  };

  it("shows the routed model, scenario, Jev confidence, effort and latency", () => {
    expect(plain(renderStatusLine(input, routed("a")))).toBe(
      "⚡ Jevo → claude-haiku-4-5 · chat · Jev 98% · effort low · 1.2s · Shop-fly · 12% context",
    );
  });

  it("says when it is waiting, when Jev was unavailable, and when a request failed", () => {
    expect(plain(renderStatusLine(input, undefined))).toContain("waiting for the first prompt");
    expect(plain(renderStatusLine(input, routed("a", { brain: "heuristic" })))).toContain(
      "heuristic (Jev unavailable)",
    );
    expect(plain(renderStatusLine(input, routed("a", { status: 400 })))).toContain(
      "claude-haiku-4-5 failed (HTTP 400)",
    );
  });

  it("marks a model the user pinned instead of routing", () => {
    const pinned = {
      session: session("a"),
      requestedModel: "claude-opus-5-5",
      model: "claude-opus-5-5",
    };
    expect(plain(renderStatusLine(input, pinned))).toContain("pinned claude-opus-5-5");
  });
});

describe("readLedgerTail", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("parses complete lines and drops a partial first line when reading only the tail", () => {
    dir = mkdtempSync(join(tmpdir(), "jevo-statusline-"));
    const file = join(dir, "ledger.jsonl");
    const lines = [routed("a", { model: "first" }), routed("a", { model: "second" })].map((r) =>
      JSON.stringify(r),
    );
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(readLedgerTail(file).map((r) => r.model)).toEqual(["first", "second"]);
    expect(readLedgerTail(file, lines[1]!.length + 5).map((r) => r.model)).toEqual(["second"]);
    expect(readLedgerTail(join(dir, "missing.jsonl"))).toEqual([]);
  });
});
