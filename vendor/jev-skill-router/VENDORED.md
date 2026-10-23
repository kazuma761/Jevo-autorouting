# Vendored: jev-skill-router

Source: https://github.com/shimo4228/jev-skill-router (MIT, see LICENSE), commit `ad3b942`.
Only `scripts/` is vendored; upstream's tests, evals and plugin wrapper stay upstream.
`tests/test_jevo_session.py` is Jevo's own test of its changes below.

Jevo runs `scripts/route.py` as the `UserPromptSubmit` hook of `launch claude`
(see `src/skillroute.ts`), so a fresh clone needs nothing besides `python3`.

Local change to upstream:

- `scripts/route.py`: `JEV_ROUTER_INJECT_BUDGET_S` overrides the 3 s inject budget
  (`inject_budget_s`). Two Jev calls over a ~120-skill roster took 2.5-3.4 s, so the
  fixed 3 s dropped good suggestions. Jevo sets 5 s.
- `scripts/router.py`, `scripts/route.py`: `JEV_ROUTER_HINT=directive` loads the chosen skill's
  `SKILL.md` into the turn (`loaded_skill_block`, cut at 9,000 characters) instead of the
  advisory line. The advisory line was followed about 5% of the time upstream; in Jevo's tests
  Claude also ignored a line telling it to call the Skill tool, but followed loaded instructions.
- `scripts/roster.py`: plugin skills also come from the paths in the plugin's
  `.claude-plugin/plugin.json` `skills` field (mattpocock-skills, cole-medin), and a plugin
  installed twice resolves to the install that applies in the cwd, else the user one.
- `scripts/jevo_session.py` (new, wired in `route.py`). These apply to every run, set or not:
  identical duplicate skills are shown once; long prompts are routed on their first and last
  2,000 characters instead of skipped; a failed or over-budget Jev answer leaves session state
  untouched; each logged row records its `action` (`load` / `drop` / `none`);
  `ROUTER_VERSION` is `0.2.0+jevo.1` so logged rows can be told apart.
  These need Jevo's variables: with `JEV_ROUTER_INDEX`, Jev ranks on a short editable index
  line per skill and judges the first 1,500 characters of the finalists (same picks as full
  text on 7/7 probes, ~65% fewer Jev tokens); with `JEV_ROUTER_STATE_DIR`, a skill is loaded
  once per session, changes only at a review after compaction (SessionStart `compact` hook)
  or 20 prompts after the last load or review. Without it every fitting prompt loads.
- `tests/test_jevo_session.py`: Jevo's own test of the above, run by `src/skillroute.test.ts`.
