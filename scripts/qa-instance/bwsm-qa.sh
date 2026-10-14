#!/usr/bin/env bash
# Disposable Paperclip QA instance for the BWSM plugin (ALR-1337). Fully isolated from the live default instance.
# Usage: bwsm-qa.sh {init|start|stop|status|reset|teardown|cli <args>|install-plugin <sha>}
set -euo pipefail
ROOT=/home/paperclip/paperclip-qa/bwsm-qa
DATA=$ROOT/data
INST=bwsm-qa
PORT=3199          # live uses 3100
PGPORT=54399       # live uses 54329
UNIT=paperclip-bwsm-qa
CFG=$DATA/instances/$INST/config.json
BIN=/home/paperclip/.local/bin/paperclipai
# Never inherit live-instance routing/credentials.
CLEAN=(env -u PAPERCLIP_API_KEY -u PAPERCLIP_API_URL -u PAPERCLIP_RUNTIME_API_URL -u PAPERCLIP_AGENT_ID -u PAPERCLIP_COMPANY_ID
  -u PAPERCLIP_RUN_ID -u PAPERCLIP_TASK_ID -u PAPERCLIP_LISTEN_HOST -u PAPERCLIP_LISTEN_PORT HOME=$ROOT/home
  PAPERCLIP_INSTANCE_ID=$INST PORT=$PORT)
cmd=${1:-status}
case $cmd in
init)
  [ -f "$CFG" ] || { mkdir -p "$DATA"; timeout 60 "${CLEAN[@]}" "$BIN" onboard -d "$DATA" --no-install-service </dev/null >/dev/null 2>&1 || true; }
  [ -f "$CFG" ] || { echo "onboard did not create $CFG; run onboard manually" >&2; exit 1; }
  node -e '
const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));
c.server.port=+process.argv[2];c.server.host="127.0.0.1";c.server.bind="loopback";
c.database.embeddedPostgresPort=+process.argv[3];
c.telemetry={enabled:false};c.updates={checkEnabled:false};
fs.writeFileSync(p,JSON.stringify(c,null,2));' "$CFG" "$PORT" "$PGPORT"
  echo "initialised $CFG (port $PORT, pg $PGPORT)";;
start)
  mkdir -p "$ROOT/home"; [ -f "$CFG" ] || "$0" init
  systemctl --user is-active --quiet $UNIT && { echo already running; exit 0; }
  systemd-run --user --unit=$UNIT --collect --working-directory=$ROOT \
    "${CLEAN[@]}" "$BIN" run -d "$DATA" -i $INST --force --no-repair
  for i in $(seq 1 60); do curl -fs http://127.0.0.1:$PORT/api/health >/dev/null && { echo "healthy: http://127.0.0.1:$PORT"; exit 0; }; sleep 2; done
  echo "not healthy after 120s; journalctl --user -u $UNIT" >&2; exit 1;;
stop) systemctl --user stop $UNIT 2>/dev/null || true; echo stopped;;
status) systemctl --user is-active $UNIT || true; curl -s http://127.0.0.1:$PORT/api/health || echo " (no response)";;
cli) shift; "${CLEAN[@]}" "$BIN" "$@" --api-base http://127.0.0.1:$PORT;;   # e.g. cli plugin list
install-plugin)  # install-plugin <git-sha> : builds that SHA of the plugin repo and installs it into the QA instance
  SHA=${2:?sha}; REPO=${BWSM_REPO:-https://github.com/mzaferyahsi/paperclip-plugin-bitwarden-secrets-manager.git}
  SRC=$ROOT/plugin-$SHA; rm -rf "$SRC"; mkdir -p "$ROOT/plugin-git"
  [ -d "$ROOT/plugin-git/.git" ] || git clone -q --no-checkout "$REPO" "$ROOT/plugin-git"
  git -C "$ROOT/plugin-git" fetch -q origin; mkdir -p "$SRC"
  git -C "$ROOT/plugin-git" archive "$SHA" | tar -x -C "$SRC"
  (cd "$SRC" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  "${CLEAN[@]}" "$BIN" plugin install -l "$SRC" --api-base http://127.0.0.1:$PORT;;
reset) "$0" stop; sleep 3; rm -rf "$DATA"; "$0" init; "$0" start;;
teardown) "$0" stop; sleep 3; rm -rf "$ROOT"; echo "removed $ROOT";;
*) echo "usage: $0 {init|start|stop|status|reset|teardown}"; exit 2;;
esac
