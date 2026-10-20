# Setting up Jevo on a new machine

This guide is written to be followed step by step, including by Claude Code itself.
Each step says what to run and how to check it worked. Do the steps in order.

**What you get:** `jevo-claude`, a Claude Code session in which, on every turn,

1. **Model routing**: Jev (TypeSafe's decision model) picks the model for the turn.
   Simple questions go to a small fast model (Haiku), coding to Sonnet, hard design and
   review to Opus. The bottom line of Claude Code shows the choice live:
   `⚡ Jevo → claude-haiku-4-5 · chat · Jev 97% · 1.9s · my-project · 12% context`
2. **Skill routing**: Jev picks the best fit among your installed Claude Code skills
   (global `~/.claude/skills`, enabled plugins, and the project's `.claude/skills`) and loads
   that skill's instructions into the turn, once per session. The status line shows it:
   `… · skill ponytail:ponytail-review · …`

Plain `claude` is not changed. Only `jevo-claude` goes through the router.

## Ports

| Port   | What                                                 | Reachable from                               |
| ------ | ---------------------------------------------------- | -------------------------------------------- |
| `8787` | Dashboard, admin API, and the agent endpoint (`/v1`) | this machine only                            |
| `8788` | Public surface (`/v1` only, needs a `sk-jev-…` key)  | this machine only, unless you start a tunnel |

Both listen on `127.0.0.1`. Nothing is exposed to the network by default.

## Rules for an agent following this guide

- **Never invent, guess, or commit keys.** Every key below comes from the human. Ask for it.
  Keys are stored under `~/.config/jevonian/` (mode `0600`), never in this repository.
- Ask before installing system packages (Node.js, pnpm, Python) on the human's machine.
- Each step has a check. Do not move on until the check passes.

## 1. Prerequisites

| Tool        | Version                                | Check               |
| ----------- | -------------------------------------- | ------------------- |
| Node.js     | 22 or newer                            | `node --version`    |
| pnpm        | 12 (the repo pins `pnpm@12.4.1`)       | `pnpm --version`    |
| Python      | 3.10 or newer (only for skill routing) | `python3 --version` |
| Claude Code | current                                | `claude --version`  |
| git         | any                                    | `git --version`     |

If pnpm is missing: `npm install -g pnpm`. Corepack also works: `corepack enable`.

## 2. Get the code and build it

```bash
git clone https://github.com/kazuma761/Jevo-autorouting.git
cd Jevo-autorouting
pnpm install
pnpm build
pnpm test
```

**Check:** `pnpm test` ends with `Tests  N passed (N)` and no failures, and
`dist/cli.mjs` exists.

In the commands below, `jevo` means `node <path-to-repo>/dist/cli.mjs`. Section 6 makes that a
real command.

## 3. Add model providers

Jevo needs at least one provider that serves Claude models. Ask the human which they have.

| The human has                                           | Run                                             |
| ------------------------------------------------------- | ----------------------------------------------- |
| An Anthropic API key                                    | `jevo add anthropic --key <key from the human>` |
| An OpenAI API key (optional, GPT fallbacks)             | `jevo add openai --key <key from the human>`    |
| A Claude Pro/Max subscription, logged in to Claude Code | `jevo add claude-subscription`                  |

`claude-subscription` reuses the Claude Code login on this machine. It is outside Anthropic's
official clients; Jevo's own docs (`docs/providers.md`) say to use it at your own risk.
Prefer an Anthropic API key when the human has one.

**Check:** `jevo providers` lists the provider(s) with a model count above zero.

## 4. Start the router

| OS            | Run                                                                                |
| ------------- | ---------------------------------------------------------------------------------- |
| macOS         | `jevo` (installs a background service that survives reboots, then returns)         |
| Linux / other | `jevo serve --foreground` (keep it running, for example in tmux or a systemd unit) |

**Check:**

```bash
curl -s http://127.0.0.1:8787/healthz
```

returns `{"ok":true,...}`. The dashboard is at http://127.0.0.1:8787/.

If port 8787 is busy, another router (or an old Jevo) is running: `jevo stop`, or find it with
`lsof -nP -iTCP:8787 -sTCP:LISTEN`.

## 5. Connect the routing brain (TypeSafe Jev)

Routing needs a TypeSafe API key. Ask the human for it (keys come from
https://console.typesafe.ai). Without it, Jevo still answers, but it sends every turn to a
fixed fallback (usually Opus), and skill routing is skipped.

Do this in the dashboard, because it stores the key in Jevo's credential file:

1. Open http://127.0.0.1:8787/providers
2. Under **Routing brain**, add a brain with channel **typesafe** (model `jev-latest`).
   Paste the key **yourself, as the human**.
3. Press **Test & measure**. It must show a verdict, not "No verdict".
4. Save.

Linux, headless alternative: add `{"channel": "typesafe", "apiKeyEnv": "TYPESAFE_API_KEY"}`
to `routing.brains` in `~/.config/jevonian/config.json`, and export `TYPESAFE_API_KEY` in the
shell that runs `jevo serve --foreground`.

**Check:** `jevo doctor` lists the brain, and this request is answered by a small model:

```bash
curl -s -D - -o /dev/null http://127.0.0.1:8787/v1/messages \
  -H 'x-api-key: jevonian-local' -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"jevonian/auto","max_tokens":20,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-jevonian-\(brain\|model\)'
```

Expect `x-jevonian-brain: jev` and a Haiku model. (`jevonian-local` is Jevo's built-in key for
requests from this machine.) `x-jevonian-brain: heuristic` means the brain key is not working.

## 6. Routing scenarios

`jevo add` derives default tiers from prices. The setup this repo was tested with is below;
set it on the dashboard's **Routing** page, or under `routing.routings` in
`~/.config/jevonian/config.json` (then restart the router). Use model ids your providers
actually list (`jevo models`).

| Scenario  | First model      | Fallback     | Jev picks it for                                   |
| --------- | ---------------- | ------------ | -------------------------------------------------- |
| `plan`    | claude-opus-5.5  | gpt-5.5      | planning, architecture, system design, code review |
| `execute` | claude-sonnet-5  | gpt-5.5      | implementation, debugging, agentic tool loops      |
| `utility` | claude-haiku-4.5 | gpt-5.4-mini | background calls, titles, summaries, compaction    |
| `chat`    | claude-haiku-4.5 | gpt-5.4-mini | casual chat, greetings, quick factual answers      |

Jev reads each scenario's description, so keep them meaningful.

## 7. Make the `jevo-claude` command

Add to `~/.zshrc` (or `~/.bashrc`), with the real path to this repo:

```bash
alias jevo-claude='CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 node /path/to/Jevo-autorouting/dist/cli.mjs launch claude --model jevonian/auto'
```

Then open a new terminal (or `source ~/.zshrc`).

`launch claude` passes its settings to Claude Code for that session only, with `--settings`.
That covers the router address and key, tool search, the status line, and the skill-router
hook. Nothing is written to `~/.claude/settings.json`, so plain `claude` is unaffected.

## 8. Skill routing (included, on by default)

The skill router is vendored in `vendor/jev-skill-router/` (MIT, see `VENDORED.md` there).
`jevo-claude` runs it before every prompt with the same TypeSafe key as the brain. It only
needs `python3`.

How it works, per prompt:

1. Jev ranks every installed skill on one short line each (`skills-index.json`, below), then
   judges the top three on the start of their `SKILL.md`. Skills installed twice with identical
   text (for example globally and by a plugin) are shown to Jev once. Skills whose author marked
   them `disable-model-invocation` (you run them yourself with `/name`) are left out.
2. If one fits, its `SKILL.md` is put into the turn, as the Skill tool would load it (cut at
   9,000 characters, with a pointer to read the rest). Claude follows it.
3. A skill is loaded once per session. Later prompts that fit the same skill add nothing.
   A prompt that fits a different skill loads that one.
4. After the conversation is compacted, or every 20 prompts, the next prompt is a **review**:
   Jev reads the last 3 prompts. The same skill still fits → it is reloaded if compaction
   removed it. Another fits → that one is loaded. Nothing fits → Claude is told to stop
   following the old skill.
5. Prompts longer than 4,000 characters are routed on their first and last 2,000.

| Variable                     | Effect                                               |
| ---------------------------- | ---------------------------------------------------- |
| `JEVO_SKILL_ROUTER=off`      | do not install the hooks                             |
| `JEV_ROUTER=shadow`          | ask Jev and log, but add nothing to the turn         |
| `JEV_ROUTER_HINT=suggest`    | add only a one-line hint instead of the skill's text |
| `JEV_ROUTER_INJECT_BUDGET_S` | time limit per prompt, default `5` (seconds)         |
| `JEVO_SKILL_ROUTER_DIR`      | use another jev-skill-router checkout                |

Files in `~/.local/share/jevonian/`:

| File                    | What                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `skills-index.json`     | one line per skill that Jev ranks on. Edit a `line` to help Jev find a skill it misses; your wording is kept when the skill changes. |
| `skill-sessions/`       | which skill each Claude Code session has loaded                                                                                      |
| `skill-decisions.jsonl` | every decision: picked skill, action (`load`, `drop`, `none`), time, Jev tokens                                                      |

What leaves the machine: each routed prompt (on a review, the last 3), every skill's index
line, and the first 1,500 characters of the top three candidates' `SKILL.md` go to TypeSafe.

**Check:**

```bash
printf '{"session_id":"t","cwd":"%s","prompt":"review the last commit for bugs"}' "$PWD" \
  | node dist/cli.mjs skillroute
```

prints JSON whose `additionalContext` contains `<skill name="…">` for a review skill, if one
is installed. No output at all means no key, no `python3`, or no skill fit well enough.

To watch picks live while you use `jevo-claude`, in a second terminal:

```bash
tail -n0 -f ~/.local/share/jevonian/skill-decisions.jsonl | jq -r '"\(.suggestion // "no skill") · \(.action // "-") · \(.elapsed_ms) ms"'
```

## 9. Final check

```bash
jevo-claude
```

1. Type `hi`. The bottom line should show `⚡ Jevo → claude-haiku-… · chat`.
2. Ask for a system design. It should switch to `claude-opus-…` (or Sonnet) on the same line.
3. The dashboard's **Logs** page shows each decision.

## Troubleshooting

These all happened during testing.

| Symptom                                                           | Cause                                                                                                            | Fix                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `401 Invalid bearer token` / "Please run /login" in `jevo-claude` | An old Jevo build. Another tool's `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` overrode the router address. | Rebuild (`pnpm build`). `launch claude` now passes its own settings, which take priority.                        |
| Every turn goes to Opus; "100% context used"; slow                | Tool search was off behind a router, so every MCP tool definition was sent on every turn (300k+ tokens).         | Rebuild. `launch claude` now turns tool search on (`ENABLE_TOOL_SEARCH=true`).                                   |
| `prompt is too long: … > 200000` on Haiku                         | A turn larger than Haiku's window was routed to it.                                                              | Fixed in routing: scenarios whose models are all too small are no longer offered.                                |
| `Provider "openai" speaks responses, not anthropic`               | A Claude Code request was sent to an OpenAI-only provider.                                                       | Fixed in routing: incompatible providers are never offered.                                                      |
| Skill hint never appears; log shows `URLError`                    | python.org Python on macOS ships without root certificates.                                                      | Jevo now passes `SSL_CERT_FILE=/etc/ssl/cert.pem`. Running the Python "Install Certificates" command also works. |
| Skill hint missing; log shows `over budget`                       | Jev took longer than the time limit.                                                                             | Raise `JEV_ROUTER_INJECT_BUDGET_S` (up to 10).                                                                   |
| `x-jevonian-brain: heuristic`, everything on one model            | The brain key is missing or rejected.                                                                            | Step 5: re-enter the TypeSafe key and press **Test & measure**.                                                  |
| `jevo-claude` stops at "Do you trust this folder?"                | First Claude Code session in that folder.                                                                        | Choose "Yes, I trust this folder".                                                                               |

Logs: `~/.local/share/jevonian/serve.log` (server), `~/.local/share/jevonian/ledger.jsonl`
(every routed request), `~/.local/share/jevonian/skill-decisions.jsonl` (skill routing).
