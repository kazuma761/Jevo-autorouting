/**
 * `jevonian skillroute`: the UserPromptSubmit hook that `launch claude` installs for its
 * session. It runs jev-skill-router (https://github.com/shimo4228/jev-skill-router), which
 * asks Jev which installed skill fits the prompt and, in inject mode, adds one line naming it.
 *
 * The router is a separate Python project, vendored under `vendor/jev-skill-router` (see
 * VENDORED.md there); this command only supplies what it needs from Jevo: the
 * TypeSafe key stored for the routing brain, passed to the router process alone so it never
 * enters Claude Code's environment, where its tools could read it. Model routing is untouched.
 *
 * Like the router itself, this fails open: a missing router, key or Python ends with exit 0
 * and no output, because a hook that blocks a prompt is worse than one that says nothing.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { brainCredentialName } from "./brain";
import { getCredential } from "./credentials";
import { dataDir } from "./paths";

/**
 * The router's hook script: `JEVO_SKILL_ROUTER_DIR`, else the vendored copy in this repo, else
 * a `jev-skill-router` checkout beside the repo.
 */
export function skillRouterScript(
  env: NodeJS.ProcessEnv = process.env,
  cli = process.argv[1],
): string | undefined {
  const override = env.JEVO_SKILL_ROUTER_DIR?.trim();
  let roots: string[];
  if (override) {
    roots = [override];
  } else {
    try {
      // <repo>/dist/cli.mjs -> <repo>
      const repo = dirname(dirname(realpathSync(cli ?? "")));
      roots = [join(repo, "vendor", "jev-skill-router"), join(dirname(repo), "jev-skill-router")];
    } catch {
      return undefined;
    }
  }
  return roots.map((root) => join(root, "scripts", "route.py")).find((path) => existsSync(path));
}

/** Environment for the router process: inject by default, Jevo's TypeSafe key, Jevo's log. */
export function skillRouterEnv(env: NodeJS.ProcessEnv, key: string | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    JEV_ROUTER: env.JEV_ROUTER?.trim() || "inject",
    JEV_ROUTER_LOG: env.JEV_ROUTER_LOG?.trim() || join(dataDir(), "skill-decisions.jsonl"),
    // Two Jev calls over ~120 skills take 2.5-3.2 s; the router's 3 s default dropped good picks.
    // Stays under HOOK_TIMEOUT_MS (6 s) and the hook's own 8 s timeout.
    JEV_ROUTER_INJECT_BUDGET_S: env.JEV_ROUTER_INJECT_BUDGET_S?.trim() || "5",
  };
  // The router only speaks to api.typesafe.ai; a base URL meant for another tool must not leak in.
  delete next.TYPESAFE_BASE_URL;
  // Opt-in local Von: jev_client still refuses any host but api.typesafe.ai or loopback. Von on
  // CPU is only fast and sure on a short request and a short menu, hence the short recipe.
  const local = env.JEVO_SKILL_ROUTER_BASE_URL?.trim();
  if (local) {
    next.TYPESAFE_BASE_URL = local;
    next.JEV_ROUTER_RECIPE = "short";
  }
  // python.org's macOS Python ships without root certificates until "Install Certificates" is
  // run, so every HTTPS call fails CERTIFICATE_VERIFY_FAILED; the system bundle fixes that.
  if (!next.SSL_CERT_FILE && existsSync(MACOS_CERT_BUNDLE)) next.SSL_CERT_FILE = MACOS_CERT_BUNDLE;
  if (key) next.TYPESAFE_API_KEY = key;
  return next;
}

const HOOK_TIMEOUT_MS = 6_000;
const MACOS_CERT_BUNDLE = "/etc/ssl/cert.pem";

export async function skillRouteCommand(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const script = skillRouterScript();
  if (!script) return;
  // A local Von gets its own key, never the TypeSafe one.
  const key = process.env.JEVO_SKILL_ROUTER_BASE_URL?.trim()
    ? process.env.VON_API_KEY?.trim()
    : process.env.TYPESAFE_API_KEY?.trim() || getCredential(brainCredentialName("typesafe"));
  if (!key) return;

  await new Promise<void>((resolve) => {
    const child = spawn("python3", [script], {
      env: skillRouterEnv(process.env, key),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Only a clean run may speak; the router prints nothing unless it has a suggestion.
      if (code === 0) process.stdout.write(Buffer.concat(out));
      resolve();
    });
    child.stdin.end(Buffer.concat(chunks));
  });
}
