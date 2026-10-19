import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { skillRouterEnv, skillRouterScript } from "./skillroute";

describe("skillroute", () => {
  let root: string;

  beforeEach(() => {
    // <root>/jevo/dist/cli.mjs next to <root>/jev-skill-router/scripts/route.py
    // Real path: macOS /var is /private/var, and the script path comes back resolved.
    root = realpathSync(mkdtempSync(join(tmpdir(), "jevo-skillroute-")));
    mkdirSync(join(root, "jevo", "dist"), { recursive: true });
    writeFileSync(join(root, "jevo", "dist", "cli.mjs"), "");
    vi.stubEnv("JEVONIAN_DATA_DIR", join(root, "data"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the router beside the repo, honours the override, and is absent when missing", () => {
    const cli = join(root, "jevo", "dist", "cli.mjs");
    expect(skillRouterScript({}, cli)).toBeUndefined();
    mkdirSync(join(root, "jev-skill-router", "scripts"), { recursive: true });
    writeFileSync(join(root, "jev-skill-router", "scripts", "route.py"), "");
    expect(skillRouterScript({}, cli)).toBe(join(root, "jev-skill-router", "scripts", "route.py"));
    // The vendored copy inside the repo wins over a checkout beside it.
    mkdirSync(join(root, "jevo", "vendor", "jev-skill-router", "scripts"), { recursive: true });
    writeFileSync(join(root, "jevo", "vendor", "jev-skill-router", "scripts", "route.py"), "");
    expect(skillRouterScript({}, cli)).toBe(
      join(root, "jevo", "vendor", "jev-skill-router", "scripts", "route.py"),
    );
    mkdirSync(join(root, "elsewhere", "scripts"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "scripts", "route.py"), "");
    expect(skillRouterScript({ JEVO_SKILL_ROUTER_DIR: join(root, "elsewhere") }, cli)).toBe(
      join(root, "elsewhere", "scripts", "route.py"),
    );
  });

  it("runs inject mode with Jevo's key and drops a foreign base URL", () => {
    const env = skillRouterEnv(
      { TYPESAFE_BASE_URL: "https://openrouter.ai/api", HOME: "/h" },
      "k1",
    );
    expect(env.JEV_ROUTER).toBe("inject");
    expect(env.JEV_ROUTER_INJECT_BUDGET_S).toBe("5");
    expect(env.TYPESAFE_API_KEY).toBe("k1");
    expect(env.TYPESAFE_BASE_URL).toBeUndefined();
    expect(env.JEV_ROUTER_LOG).toBe(join(root, "data", "skill-decisions.jsonl"));
    expect(skillRouterEnv({ JEV_ROUTER: "shadow" }, "k1").JEV_ROUTER).toBe("shadow");
    // A user's own certificate bundle is kept; otherwise the system one is used when present.
    expect(skillRouterEnv({ SSL_CERT_FILE: "/mine.pem" }, "k1").SSL_CERT_FILE).toBe("/mine.pem");
  });

  it("points the router at a local Von with the short recipe only when asked", () => {
    const env = skillRouterEnv({ JEVO_SKILL_ROUTER_BASE_URL: " http://127.0.0.1:8100 " }, "v1");
    expect(env.TYPESAFE_BASE_URL).toBe("http://127.0.0.1:8100");
    expect(env.JEV_ROUTER_RECIPE).toBe("short");
    expect(skillRouterEnv({}, "k1").JEV_ROUTER_RECIPE).toBeUndefined();
  });
});
