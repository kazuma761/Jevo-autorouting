import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { modelCapabilities } from "./capabilities";
import {
  devinModelMeta,
  devinModelsPath,
  isRoutableDevinModel,
  loadDevinModelMeta,
  resetDevinModelMeta,
  saveDevinModelMeta,
} from "./devin-catalog";
import { costOf, priceFor, usePriceTable } from "./pricing";

let dir = "";
let previousData: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-devin-catalog-"));
  previousData = process.env.JEVONIAN_DATA_DIR;
  process.env.JEVONIAN_DATA_DIR = dir;
  resetDevinModelMeta();
});

afterEach(() => {
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  resetDevinModelMeta();
  usePriceTable({}, "bundled-fallback");
  rmSync(dir, { recursive: true, force: true });
});

describe("isRoutableDevinModel", () => {
  it("drops disabled, fusion combos, and server-side routers", () => {
    const ids = [
      "swe-1-6-slow",
      "claude-opus-4-8-medium",
      "MODEL_PRIVATE_11",
      "fusion-claude-opus-4-8-medium-gpt-6-sol-medium",
      "adaptive",
      "adaptive-fast",
      "arena-blind",
    ];
    const routable = ids.filter((id) => isRoutableDevinModel({ id, disabled: false }));
    expect(routable).toEqual(["swe-1-6-slow", "claude-opus-4-8-medium", "MODEL_PRIVATE_11"]);
    expect(isRoutableDevinModel({ id: "swe-1-6-slow", disabled: true })).toBe(false);
  });
});

describe("Devin model metadata cache", () => {
  it("round-trips through disk and backs pricing / capability fallbacks", () => {
    saveDevinModelMeta([
      {
        id: "swe-1-6-slow",
        label: "SWE-1.6 Slow",
        disabled: false,
        contextWindow: 200_000,
        maxOutput: 32_000,
        price: { input: 2, output: 8, cacheRead: 0.2 },
      },
      { id: "MODEL_PRIVATE_11", label: "Private", disabled: false },
    ]);
    resetDevinModelMeta();
    expect(loadDevinModelMeta()["swe-1-6-slow"]).toEqual({
      label: "SWE-1.6 Slow",
      contextWindow: 200_000,
      maxOutput: 32_000,
      price: { input: 2, output: 8, cacheRead: 0.2 },
    });
    expect(devinModelMeta("devin-subscription/swe-1-6-slow")?.contextWindow).toBe(200_000);

    // models.dev does not list Devin-only ids; the Devin catalog price fills in.
    expect(priceFor("swe-1-6-slow", "devin-subscription")).toMatchObject({
      input: 2,
      output: 8,
      cacheRead: 0.2,
      cacheWrite: 2,
    });
    const cost = costOf(
      "swe-1-6-slow",
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      new Date(),
      "devin-subscription",
    );
    expect(cost.known).toBe(true);
    expect(cost.usd).toBeCloseTo(2 + 8 + 0.2 + 2, 10);
    expect(priceFor("MODEL_PRIVATE_11")).toBeUndefined();

    expect(modelCapabilities("swe-1-6-slow")).toEqual({
      contextWindow: 200_000,
      maxOutput: 32_000,
    });
    expect(modelCapabilities("MODEL_PRIVATE_11")).toEqual({});
  });

  it("prefers the exact Devin catalog rate over vendor and stripped model prices", () => {
    saveDevinModelMeta([
      {
        id: "claude-opus-4-8-medium",
        label: "Opus medium",
        disabled: false,
        price: { input: 4, output: 18, cacheRead: 0.4 },
      },
    ]);
    usePriceTable({
      "claude-opus-4-8": { provider: "anthropic", input: 5, output: 25 },
      "claude-opus-4-8-medium": { provider: "anthropic", input: 6, output: 30 },
      "reseller/claude-opus-4-8-medium": { provider: "reseller", input: 9, output: 45 },
      "devin-subscription/claude-opus-4-8": {
        provider: "devin-subscription",
        input: 8,
        output: 40,
      },
    });

    expect(priceFor("claude-opus-4-8-medium", "custom-provider", "devin")?.input).toBe(4);
    expect(priceFor("claude-opus-4-8-medium", "devin-subscription")).toMatchObject({
      provider: "devin",
      input: 4,
      output: 18,
      cacheRead: 0.4,
      cacheWrite: 4,
    });
    expect(priceFor("devin-subscription/claude-opus-4-8-medium", "devin-subscription")?.input).toBe(
      4,
    );
    expect(
      costOf(
        "claude-opus-4-8-medium",
        { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        new Date(),
        "devin-subscription",
      ).usd,
    ).toBe(4);
    expect(priceFor("claude-opus-4-8-medium", "anthropic")?.input).toBe(6);
    expect(priceFor("claude-opus-4-8-medium", "reseller")?.input).toBe(9);
    expect(priceFor("claude-opus-4-8-medium", "custom-subscription")?.input).toBe(6);
  });

  it("keeps vendor pricing for non-Devin providers when only the stripped base is listed", () => {
    saveDevinModelMeta([
      {
        id: "gpt-6-sol-medium",
        label: "GPT medium",
        disabled: false,
        price: { input: 3, output: 12 },
      },
    ]);
    usePriceTable({ "gpt-6-sol": { provider: "openai", input: 2, output: 8 } });

    expect(priceFor("gpt-6-sol-medium", "devin-subscription")?.input).toBe(3);
    expect(priceFor("gpt-6-sol-medium", "openai")?.input).toBe(2);
    expect(priceFor("gpt-6-sol-medium")?.input).toBe(2);
  });

  it("refreshes the in-memory copy when a new snapshot is saved", () => {
    saveDevinModelMeta([
      { id: "gpt-6-sol-medium", label: "a", disabled: false, price: { input: 1, output: 2 } },
    ]);
    expect(priceFor("gpt-6-sol-medium-custom")).toBeUndefined();
    saveDevinModelMeta([
      {
        id: "gpt-6-sol-medium-custom",
        label: "b",
        disabled: false,
        price: { input: 3, output: 4 },
      },
    ]);
    expect(priceFor("gpt-6-sol-medium-custom")?.input).toBe(3);
  });

  it("reads a corrupt cache as empty", () => {
    writeFileSync(devinModelsPath(), "{ nope");
    expect(loadDevinModelMeta()).toEqual({});
  });
});
