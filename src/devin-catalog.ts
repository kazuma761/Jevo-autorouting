import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DevinModel } from "./devin";
import { dataDir } from "./paths";

/**
 * Per-model metadata from Devin's `GetCliModelConfigs`, kept on disk so pricing and capability
 * lookups work for Devin-only ids (`swe-1-6-slow`, `MODEL_PRIVATE_11`, effort-suffixed Claude /
 * GPT ids) that models.dev does not list.
 */
export interface DevinModelMeta {
  label?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** USD per 1M tokens. */
  price?: { input: number; output: number; cacheRead?: number };
}

interface DevinCatalogFile {
  fetchedAt: string;
  models: Record<string, DevinModelMeta>;
}

export function devinModelsPath(): string {
  return join(dataDir(), "devin-models.json");
}

/**
 * Whether a catalog entry is a model a router should offer. Devin also lists ~hundreds of
 * `fusion-*` combos and server-side routers (`adaptive*`, `arena-*`) that are not a single
 * model with a stable price or window, so they stay out of the provider's model list.
 */
export function isRoutableDevinModel(model: Pick<DevinModel, "id" | "disabled">): boolean {
  if (model.disabled) return false;
  const id = model.id;
  if (id.length === 0) return false;
  if (id.startsWith("fusion-")) return false;
  if (/^adaptive/i.test(id)) return false;
  if (id.startsWith("arena-")) return false;
  return true;
}

let cache: { path: string; models: Record<string, DevinModelMeta> } | undefined;

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function metaOf(raw: unknown): DevinModelMeta | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const contextWindow = positive(value.contextWindow);
  const maxOutput = positive(value.maxOutput);
  const label = typeof value.label === "string" && value.label.length > 0 ? value.label : undefined;
  const rawPrice =
    typeof value.price === "object" && value.price !== null
      ? (value.price as Record<string, unknown>)
      : undefined;
  const input = nonNegative(rawPrice?.input);
  const output = nonNegative(rawPrice?.output);
  const cacheRead = nonNegative(rawPrice?.cacheRead);
  const price =
    input !== undefined && output !== undefined
      ? { input, output, ...(cacheRead === undefined ? {} : { cacheRead }) }
      : undefined;
  return {
    ...(label ? { label } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(price ? { price } : {}),
  };
}

/** Persist catalog metadata for the given models, replacing the previous snapshot. */
export function saveDevinModelMeta(models: DevinModel[]): void {
  const entries: Record<string, DevinModelMeta> = {};
  for (const model of models) {
    const meta = metaOf(model);
    if (meta) entries[model.id] = meta;
  }
  const path = devinModelsPath();
  const file: DevinCatalogFile = { fetchedAt: new Date().toISOString(), models: entries };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // Metadata is a pricing/capability hint; failing to cache it must not fail discovery.
  }
  cache = { path, models: entries };
}

/**
 * Cached catalog metadata keyed by Devin model id. Read from disk once per data dir; a
 * {@link saveDevinModelMeta} call refreshes the in-memory copy.
 */
export function loadDevinModelMeta(): Record<string, DevinModelMeta> {
  const path = devinModelsPath();
  if (cache && cache.path === path) return cache.models;
  const models: Record<string, DevinModelMeta> = {};
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
      const entries =
        typeof raw.models === "object" && raw.models !== null
          ? Object.entries(raw.models as Record<string, unknown>)
          : [];
      for (const [id, value] of entries) {
        const meta = metaOf(value);
        if (meta) models[id] = meta;
      }
    } catch {
      // A corrupt cache reads as empty; the next discovery pass rewrites it.
    }
  }
  cache = { path, models };
  return models;
}

/** Metadata for one Devin model id (a `provider/` prefix is ignored), or undefined. */
export function devinModelMeta(model: string): DevinModelMeta | undefined {
  const models = loadDevinModelMeta();
  const direct = models[model];
  if (direct) return direct;
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return models[tail];
}

/** Drop the in-memory copy so the next lookup re-reads disk. For tests. */
export function resetDevinModelMeta(): void {
  cache = undefined;
}
