#!/usr/bin/env bash
# Jevo with Von (https://github.com/wfzyx/von, open source, runs locally) as the decision brain
# instead of Jev. Von serves the same SystemOne API, so Jevo's "custom" brain channel talks to it
# unchanged. Everything lives in .von/ (gitignored): venv, API key, and the Jevo config to use.
#   scripts/von-brain.sh von    # start Von on 127.0.0.1:$VON_PORT (default 8100)
#   scripts/von-brain.sh jevo   # start the Jevo router with Von as its brain
#   JEVO_PORT=8788 scripts/von-brain.sh jevo   # same, on another port (test instance)
#   JEVO_PORT=8788 scripts/von-brain.sh claude # jevo-claude through that router
set -euo pipefail
HERE=$PWD  # where the user launched from: Claude Code works in that folder
cd "$(dirname "$0")/.."
D=$PWD/.von
PORT=${VON_PORT:-8100}

# The key only stops other local programs from using Von; it never leaves this machine.
chmod 700 "$D"  # von.env, config.json and the logs are for this user only
if [ ! -s "$D/von.env" ]; then
  KEY=$(openssl rand -hex 24)  # separate assignment so set -e stops on failure
  (umask 077 && echo "VON_API_KEY=$KEY" > "$D/von.env")
fi
set -a; . "$D/von.env"; set +a
: "${VON_API_KEY:?is empty in .von/von.env; Von would run without auth. Delete the file and rerun.}"
# Jevo calls Von from Node, not a browser: no web page gets a CORS grant (Von defaults to "*").
export VON_CORS_ORIGINS=http://127.0.0.1:$PORT

# Jevo's own config with the brain swapped for Von, one file per Jevo port so a test instance and
# the real one never overwrite each other. Regenerated so it follows changes to the original.
JPORT=${JEVO_PORT:-8787}
export JEVONIAN_CONFIG=$D/config-$JPORT.json
# dist needs Node >= 22.15 (node:zlib zstd); the nvm default here is v20.
NODE=$(command -v /usr/local/bin/node || command -v node)
write_config() {
  "$NODE" -e '
    const fs = require("fs"), [src, out, port, jport] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(src, "utf8"));
    c.routing.brains = [{ channel: "custom", baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
      model: "von-latest", apiKeyEnv: "VON_API_KEY" }];  // default 8 s; Von answers in ~0.2 s
    c.routing.brainPicksEffort = false;  // Von effort answers are erratic (routing-report.md)
    c.listen.port = Number(jport);
    fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  ' "${XDG_CONFIG_HOME:-$HOME/.config}/jevonian/config.json" "$JEVONIAN_CONFIG" "$PORT" "$JPORT"
}

case "${1:-}" in
  # CPU keeps the GPU free for answering models, as in the ollama-webui router.
  von) CUDA_VISIBLE_DEVICES= exec "$D/venv/bin/von" serve --host 127.0.0.1 --port "$PORT" --device cpu ;;
  jevo) write_config; exec "$NODE" dist/cli.mjs serve --foreground ;;
  # jevo-claude against the Jevo started above on the same JEVO_PORT.
  # The skill hook asks Von too (short recipe). Claude's tools can read VON_API_KEY; it only
  # unlocks the local Von, never a paid API.
  claude) shift; [ -s "$JEVONIAN_CONFIG" ] || write_config
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "Von is not running. Start it: $0 von" >&2; exit 1; }
    curl -s -o /dev/null "http://127.0.0.1:$JPORT/" || { echo "Jevo is not running. Start it: JEVO_PORT=$JPORT $0 jevo" >&2; exit 1; }
    export JEVO_SKILL_ROUTER_BASE_URL=http://127.0.0.1:$PORT
    cd "$HERE"
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 exec "$NODE" "$D/../dist/cli.mjs" launch claude --model jevonian/auto "$@" ;;
  *) echo "usage: [JEVO_PORT=8788] $0 von|jevo|claude" >&2; exit 2 ;;
esac
