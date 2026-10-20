import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadedSkill, runRouter, skillRouterEnv, skillRouterScript } from "./skillroute";

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
    expect(env.JEV_ROUTER_HINT).toBe("directive");
    expect(skillRouterEnv({ JEV_ROUTER_HINT: "suggest" }, "k1").JEV_ROUTER_HINT).toBe("suggest");
    expect(env.TYPESAFE_API_KEY).toBe("k1");
    expect(env.TYPESAFE_BASE_URL).toBeUndefined();
    expect(env.JEV_ROUTER_LOG).toBe(join(root, "data", "skill-decisions.jsonl"));
    expect(skillRouterEnv({ JEV_ROUTER: "shadow" }, "k1").JEV_ROUTER).toBe("shadow");
    // A user's own certificate bundle is kept; otherwise the system one is used when present.
    expect(skillRouterEnv({ SSL_CERT_FILE: "/mine.pem" }, "k1").SSL_CERT_FILE).toBe("/mine.pem");
  });

  it("passes a clean router's output through and stays silent when it fails, hangs or is missing", async () => {
    const script = (name: string, body: string) => {
      const path = join(root, `${name}.py`);
      writeFileSync(path, body);
      return path;
    };
    const env = { PATH: process.env.PATH };
    const ok = script("ok", "import sys; sys.stdin.read(); print('hint')");
    expect((await runRouter(ok, Buffer.from("{}"), env))?.toString()).toBe("hint\n");
    const fails = script("fails", "print('half a hint'); raise SystemExit(1)");
    expect(await runRouter(fails, Buffer.from("{}"), env)).toBeUndefined();
    const hangs = script("hangs", "import time; print('late'); time.sleep(30)");
    expect(await runRouter(hangs, Buffer.from("{}"), env, 300)).toBeUndefined();
    expect(
      await runRouter(ok, Buffer.from("{}"), { PATH: join(root, "no-python") }),
    ).toBeUndefined();
  });

  it("passes a clean router's output through and stays silent when it fails, hangs or is missing", async () => {
    const script = (name: string, body: string) => {
      const path = join(root, `${name}.py`);
      writeFileSync(path, body);
      return path;
    };
    const env = { PATH: process.env.PATH };
    const ok = script("ok", "import sys; sys.stdin.read(); print('hint')");
    expect((await runRouter(ok, Buffer.from("{}"), env))?.toString()).toBe("hint\n");
    const fails = script("fails", "print('half a hint'); raise SystemExit(1)");
    expect(await runRouter(fails, Buffer.from("{}"), env)).toBeUndefined();
    const hangs = script("hangs", "import time; print('late'); time.sleep(30)");
    expect(await runRouter(hangs, Buffer.from("{}"), env, 300)).toBeUndefined();
    expect(
      await runRouter(ok, Buffer.from("{}"), { PATH: join(root, "no-python") }),
    ).toBeUndefined();
  });

  it.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
    "ranks plugin skills from plugin.json paths, from the install that applies here",
    () => {
      const skill = (dir: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), "---\ndescription: d\n---\nbody\n");
      };
      // A stale project install for another folder is listed first; the user install declares a
      // nested skill folder and a whole directory, as mattpocock-skills and cole-medin do.
      const stale = join(root, "cache", "stale");
      skill(join(stale, "skills", "old"));
      const current = join(root, "cache", "current");
      mkdirSync(join(current, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(current, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          skills: ["./skills/group/nested", "./.claude/skills", "../stale/skills"],
        }),
      );
      skill(join(current, "skills", "group", "nested"));
      skill(join(current, ".claude", "skills", "flat"));
      const manifest = join(root, "installed_plugins.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          plugins: {
            "p@m": [
              { scope: "project", projectPath: join(root, "other"), installPath: stale },
              { scope: "user", installPath: current },
            ],
          },
        }),
      );
      const settings = join(root, "settings.json");
      writeFileSync(settings, JSON.stringify({ enabledPlugins: { "p@m": true } }));
      mkdirSync(join(root, "work"));

      const vendored = fileURLToPath(new URL("../vendor/jev-skill-router", import.meta.url));
      const run = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          "import json, sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; " +
            "from scripts import roster; print(json.dumps([s.name for s in roster.build_roster(" +
            "user_skills_dir=None, plugins_manifest=Path(sys.argv[2]), " +
            "settings_path=Path(sys.argv[3]), cwd=Path(sys.argv[4]))]))",
          vendored,
          manifest,
          settings,
          join(root, "work"),
        ],
        { encoding: "utf8" },
      );
      expect(run.stderr).toBe("");
      // `../stale/skills` escapes the install, so it is not followed.
      expect(JSON.parse(run.stdout)).toEqual(["p:flat", "p:nested"]);
    },
  );

  it.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
    "loads a skill once per session and reviews it after compaction or 20 prompts",
    () => {
      const test = fileURLToPath(
        new URL("../vendor/jev-skill-router/tests/test_jevo_session.py", import.meta.url),
      );
      const run = spawnSync("python3", ["-I", test], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("jevo session ok");
    },
  );

  it("reads the loaded skill of a session for the status line", () => {
    vi.stubEnv("JEV_ROUTER_STATE_DIR", join(root, "sessions"));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "sessions", "abc-1.json"), JSON.stringify({ loaded: "unlazy" }));
    expect(loadedSkill("abc-1")).toBe("unlazy");
    expect(loadedSkill("missing")).toBeUndefined();
    expect(loadedSkill("../abc-1")).toBeUndefined();
  });
});
