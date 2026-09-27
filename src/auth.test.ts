import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveProviderAuth, withOpenRouterAttribution, withSessionAffinity } from "./auth";
import { parseConfig, type Provider } from "./config";
import { invalidateOAuthToken } from "./oauth";

function provider(baseUrl: string): Provider {
  const config = parseConfig({
    providers: [{ name: "p", type: "both", baseUrl, apiKey: "test", models: ["m"] }],
  });
  const parsed = config.providers[0];
  if (!parsed) throw new Error("missing provider");
  return parsed;
}

describe("withSessionAffinity", () => {
  it("adds x-opencode-session for opencode providers", () => {
    const headers: Record<string, string> = {};
    withSessionAffinity(headers, provider("https://opencode.ai/zen/go/v1"), "sess-1", {});
    expect(headers["x-opencode-session"]).toBe("sess-1");

    const forwarded: Record<string, string> = {};
    withSessionAffinity(forwarded, provider("https://opencode.ai/zen/go/v1"), "sess-2", {
      "x-opencode-session": "client-session",
    });
    expect(forwarded["x-opencode-session"]).toBe("client-session");
  });

  it("leaves other providers untouched", () => {
    const headers: Record<string, string> = {};
    withSessionAffinity(headers, provider("https://api.deepseek.com/v1"), "sess-1", {});
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("withOpenRouterAttribution", () => {
  it("adds OpenRouter app attribution", () => {
    const headers: Record<string, string> = {};
    withOpenRouterAttribution(headers, "https://openrouter.ai/api/v1");
    expect(headers).toMatchObject({
      "HTTP-Referer": "https://github.com/kazuma761/Jevo-autorouting",
      "X-Title": "Jevo",
    });
  });

  it("leaves other providers untouched", () => {
    const headers: Record<string, string> = {};
    withOpenRouterAttribution(headers, "https://api.deepseek.com/v1");
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
  });

  it("keeps caller-provided attribution", () => {
    const headers: Record<string, string> = {
      "HTTP-Referer": "https://example.com/app",
      "X-Title": "Example",
    };
    withOpenRouterAttribution(headers, "https://openrouter.ai/api/v1");
    expect(headers["HTTP-Referer"]).toBe("https://example.com/app");
    expect(headers["X-Title"]).toBe("Example");
  });
});

describe("resolveProviderAuth", () => {
  let dir = "";
  let previousDevin: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jevonian-auth-"));
    previousDevin = process.env.JEVONIAN_DEVIN_CREDENTIALS;
  });

  afterEach(() => {
    invalidateOAuthToken("devin");
    if (previousDevin === undefined) delete process.env.JEVONIAN_DEVIN_CREDENTIALS;
    else process.env.JEVONIAN_DEVIN_CREDENTIALS = previousDevin;
    rmSync(dir, { recursive: true, force: true });
  });

  it("attributes OpenRouter model calls to Jevo", async () => {
    const auth = await resolveProviderAuth(provider("https://openrouter.ai/api/v1"), "openai");
    expect(auth.headers["HTTP-Referer"]).toBe("https://github.com/kazuma761/Jevo-autorouting");
    expect(auth.headers["X-Title"]).toBe("Jevo");
    expect(auth.headers.authorization).toBe("Bearer test");
    expect(auth.token).toBe("test");
  });

  it("returns the raw Devin token without building headers", async () => {
    const path = join(dir, "credentials.toml");
    writeFileSync(path, 'windsurf_api_key = "devin-session-token$abc"\n');
    process.env.JEVONIAN_DEVIN_CREDENTIALS = path;
    const config = parseConfig({
      providers: [
        {
          name: "devin-subscription",
          type: "devin",
          baseUrl: "https://server.codeium.com",
          auth: "oauth",
          oauthSource: "devin",
          models: [],
        },
      ],
    });
    const devin = config.providers[0];
    if (!devin) throw new Error("missing provider");
    const auth = await resolveProviderAuth(devin, "openai");
    expect(auth.error).toBeUndefined();
    expect(auth.headers).toEqual({});
    expect(auth.token).toBe("devin-session-token$abc");
  });

  it("surfaces a missing Devin login", async () => {
    process.env.JEVONIAN_DEVIN_CREDENTIALS = join(dir, "missing.toml");
    const config = parseConfig({
      providers: [
        {
          name: "devin-subscription",
          type: "devin",
          baseUrl: "https://server.codeium.com",
          auth: "oauth",
          oauthSource: "devin",
          models: [],
        },
      ],
    });
    const devin = config.providers[0];
    if (!devin) throw new Error("missing provider");
    const auth = await resolveProviderAuth(devin, "openai");
    expect(auth.error).toContain("devin auth login");
  });
});
