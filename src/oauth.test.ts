import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasOAuthCredential,
  invalidateOAuthToken,
  oauthCredentialLabel,
  resolveDevinServerUrl,
  resolveOAuthToken,
  type OAuthFailure,
} from "./oauth";

let dir = "";
let claudePath = "";
let codexPath = "";
let previousClaude: string | undefined;
let previousCodex: string | undefined;
let previousAntigravity: string | undefined;
let previousDevin: string | undefined;

beforeEach(() => {
  previousDevin = process.env.JEVONIAN_DEVIN_CREDENTIALS;
  dir = mkdtempSync(join(tmpdir(), "jevonian-oauth-"));
  claudePath = join(dir, "claude-credentials.json");
  codexPath = join(dir, "codex-auth.json");
  previousClaude = process.env.JEVONIAN_CLAUDE_CREDENTIALS;
  previousCodex = process.env.JEVONIAN_CODEX_AUTH;
  previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  process.env.JEVONIAN_CLAUDE_CREDENTIALS = claudePath;
  process.env.JEVONIAN_CODEX_AUTH = codexPath;
});

afterEach(() => {
  invalidateOAuthToken("claude-code");
  invalidateOAuthToken("codex");
  invalidateOAuthToken("antigravity");
  invalidateOAuthToken("devin");
  if (previousDevin === undefined) delete process.env.JEVONIAN_DEVIN_CREDENTIALS;
  else process.env.JEVONIAN_DEVIN_CREDENTIALS = previousDevin;
  if (previousClaude === undefined) delete process.env.JEVONIAN_CLAUDE_CREDENTIALS;
  else process.env.JEVONIAN_CLAUDE_CREDENTIALS = previousClaude;
  if (previousCodex === undefined) delete process.env.JEVONIAN_CODEX_AUTH;
  else process.env.JEVONIAN_CODEX_AUTH = previousCodex;
  if (previousAntigravity === undefined) delete process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
  else process.env.JEVONIAN_ANTIGRAVITY_TOKEN = previousAntigravity;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function jwt(expSeconds: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
}

function failure(result: { token?: string } | OAuthFailure): OAuthFailure {
  if ("error" in result) return result;
  throw new Error(`expected failure, got ${result.token ?? "token"}`);
}

describe("Claude Code credentials", () => {
  it("uses a fresh access token without refreshing", async () => {
    writeFileSync(
      claudePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-token",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect("token" in result && result.token).toBe("fresh-token");
  });

  it("refreshes an expired token and writes it back", async () => {
    writeFileSync(
      claudePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh-1",
          expiresAt: Date.now() - 1_000,
        },
      }),
    );
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "refresh-2", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect(requestedUrl).toBe("https://console.anthropic.com/v1/oauth/token");
    expect("token" in result && result.token).toBe("new-token");
    const written = JSON.parse(readFileSync(claudePath, "utf8")) as {
      claudeAiOauth: { accessToken: string; refreshToken: string };
    };
    expect(written.claudeAiOauth.accessToken).toBe("new-token");
    expect(written.claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  it("reports missing credentials", async () => {
    const result = await resolveOAuthToken({ source: "claude-code" });
    expect(failure(result).error).toContain("Claude Code credentials not found");
  });
});

describe("Antigravity credentials", () => {
  it("does not refresh an expired token (Jevo ships no Google OAuth client)", async () => {
    const path = join(dir, "antigravity.json");
    writeFileSync(
      path,
      JSON.stringify({
        token: {
          access_token: "old",
          refresh_token: "refresh-1",
          expiry: new Date(Date.now() - 60_000).toISOString(),
        },
        auth_method: "consumer",
      }),
    );
    previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
    process.env.JEVONIAN_ANTIGRAVITY_TOKEN = path;
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
        status: 200,
      });
    });
    const result = await resolveOAuthToken({ source: "antigravity" });
    expect(requestedUrl).toBe("");
    expect("error" in result && result.error).toMatch(/not included in Jevo/);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      token: { access_token: string; refresh_token: string };
    };
    expect(written.token.access_token).toBe("old");
  });

  it("uses a fresh access token without refreshing", async () => {
    const path = join(dir, "antigravity-fresh.json");
    writeFileSync(
      path,
      JSON.stringify({
        token: {
          access_token: "fresh",
          refresh_token: "refresh-1",
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    previousAntigravity = process.env.JEVONIAN_ANTIGRAVITY_TOKEN;
    process.env.JEVONIAN_ANTIGRAVITY_TOKEN = path;
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "antigravity" });
    expect("token" in result && result.token).toBe("fresh");
  });
});

describe("Devin credentials", () => {
  it("reads the session token from credentials.toml", async () => {
    const path = join(dir, "credentials.toml");
    writeFileSync(
      path,
      [
        "# written by devin auth login",
        'windsurf_api_key = "devin-session-token$abc\\"def\\\\ghi"',
        'api_server_url = "https://server.example.com/"',
        'devin_webapp_host = "https://app.devin.ai"',
        "",
      ].join("\n"),
    );
    process.env.JEVONIAN_DEVIN_CREDENTIALS = path;
    vi.stubGlobal("fetch", async () => {
      throw new Error("devin tokens never refresh");
    });
    const result = await resolveOAuthToken({ source: "devin" });
    expect("token" in result && result.token).toBe('devin-session-token$abc"def\\ghi');
    expect("token" in result && result.expiresAt).toBeUndefined();
    expect(hasOAuthCredential("devin")).toBe(true);
    expect(oauthCredentialLabel("devin")).toBe("Devin credentials");
  });

  it("re-reads the file after invalidation", async () => {
    const path = join(dir, "credentials.toml");
    writeFileSync(path, 'windsurf_api_key = "devin-session-token$one"\n');
    process.env.JEVONIAN_DEVIN_CREDENTIALS = path;
    const first = await resolveOAuthToken({ source: "devin" });
    expect("token" in first && first.token).toBe("devin-session-token$one");
    writeFileSync(path, 'windsurf_api_key = "devin-session-token$two"\n');
    invalidateOAuthToken("devin");
    const second = await resolveOAuthToken({ source: "devin" });
    expect("token" in second && second.token).toBe("devin-session-token$two");
  });

  it("reports a missing credentials file", async () => {
    process.env.JEVONIAN_DEVIN_CREDENTIALS = join(dir, "missing.toml");
    const result = await resolveOAuthToken({ source: "devin" });
    expect(failure(result).error).toBe(
      "Devin credentials not found. Sign in with `devin auth login`, or set JEVONIAN_DEVIN_CREDENTIALS.",
    );
    expect(hasOAuthCredential("devin")).toBe(false);
  });

  it("reports a file without windsurf_api_key", async () => {
    const path = join(dir, "credentials.toml");
    writeFileSync(path, 'api_server_url = "https://server.codeium.com"\n');
    process.env.JEVONIAN_DEVIN_CREDENTIALS = path;
    const result = await resolveOAuthToken({ source: "devin" });
    expect(failure(result).error).toContain("unexpected shape");
    expect(hasOAuthCredential("devin")).toBe(false);
  });

  it("resolves the API server url from the file or the default", () => {
    const path = join(dir, "credentials.toml");
    process.env.JEVONIAN_DEVIN_CREDENTIALS = path;
    expect(resolveDevinServerUrl()).toBe("https://server.codeium.com");
    writeFileSync(path, 'windsurf_api_key = "t"\napi_server_url = "https://server.example.com/"\n');
    expect(resolveDevinServerUrl()).toBe("https://server.example.com");
    writeFileSync(path, 'windsurf_api_key = "t"\n');
    expect(resolveDevinServerUrl()).toBe("https://server.codeium.com");
  });
});

describe("Codex credentials", () => {
  it("reads the token and account id from auth.json", async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3_600);
    writeFileSync(
      codexPath,
      JSON.stringify({
        tokens: { access_token: token, refresh_token: "refresh-1", account_id: "acct_1" },
      }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not refresh a fresh token");
    });
    const result = await resolveOAuthToken({ source: "codex" });
    expect("token" in result && result.token).toBe(token);
    expect("token" in result && result.accountId).toBe("acct_1");
  });

  it("refreshes an expired token and stores the rotation", async () => {
    const expired = jwt(Math.floor(Date.now() / 1000) - 10);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 3_600);
    writeFileSync(
      codexPath,
      JSON.stringify({
        tokens: { access_token: expired, refresh_token: "refresh-1", account_id: "acct_1" },
      }),
    );
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: "refresh-2" }), {
        status: 200,
      });
    });
    const result = await resolveOAuthToken({ source: "codex" });
    expect(requestedUrl).toBe("https://auth.openai.com/oauth/token");
    expect("token" in result && result.token).toBe(fresh);
    expect("token" in result && result.accountId).toBe("acct_1");
    const written = JSON.parse(readFileSync(codexPath, "utf8")) as {
      tokens: { access_token: string; refresh_token: string };
      last_refresh: string;
    };
    expect(written.tokens.access_token).toBe(fresh);
    expect(written.tokens.refresh_token).toBe("refresh-2");
    expect(typeof written.last_refresh).toBe("string");
  });
});
