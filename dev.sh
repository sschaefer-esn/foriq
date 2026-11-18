#!/bin/bash
# Starts the development stack in one terminal: backend (FastAPI, :8005, auto-reload)
# and web UI (Next.js dev server, :3000, hot reload, proxies /api/* to the backend).
# Ctrl+C stops both.
#
#   ./dev.sh          database from webapp/.env (DATABASE_URL, JWT_SECRET)
#   ./dev.sh app      database of the Foriq app installed on this Mac (must be running);
#                     connection and keys come from its secrets.json, background
#                     workers are off. Writes in the UI change real data.
#
# Python: webapp/backend/.venv, webapp/backend/venv, foriq-app/build/venv, else python3.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
MODE=${1:-env}
BACKEND_PORT=${FORIQ_DEV_BACKEND_PORT:-8005}
FRONTEND_PORT=${FORIQ_DEV_FRONTEND_PORT:-3000}

die() { echo "dev: $*" >&2; exit 1; }

PY=""
for p in "$ROOT/webapp/backend/.venv/bin/python" "$ROOT/webapp/backend/venv/bin/python" \
         "$ROOT/foriq-app/build/venv/bin/python"; do
  [ -x "$p" ] && { PY=$p; break; }
done
PY=${PY:-python3}
"$PY" -c "import fastapi, uvicorn" 2>/dev/null \
  || die "$PY lacks the backend packages. See webapp/backend/README.md (Setup)."

case "$MODE" in
  env)
    [ -f "$ROOT/webapp/.env" ] || die "webapp/.env missing: cp webapp/.env.example webapp/.env and set DATABASE_URL, JWT_SECRET"
    echo "dev: database from webapp/.env"
    ;;
  app)
    SECRETS="$HOME/Library/Application Support/Foriq/secrets.json"
    [ -f "$SECRETS" ] || die "no installed Foriq app found ($SECRETS)"
    nc -z 127.0.0.1 54329 2>/dev/null || die "PostgreSQL of the Foriq app is not running (127.0.0.1:54329). Start Foriq.app first."
    eval "$("$PY" - "$SECRETS" <<'EOF'
import json, shlex, sys, urllib.parse
s = json.load(open(sys.argv[1]))
pw = urllib.parse.quote(s["postgresPassword"], safe="")
print("export DATABASE_URL=" + shlex.quote(f"postgresql://foriq:{pw}@127.0.0.1:54329/foriq"))
print("export JWT_SECRET=" + shlex.quote(s["jwtSecret"]))
print("export DEVICE_TOKEN_HMAC_KEY=" + shlex.quote(s["deviceTokenHmacKey"]))
print("export API_KEY_HMAC_KEY=" + shlex.quote(s["apiKeyHmacKey"]))
EOF
)"
    export FORIQ_NO_WORKERS=1
    echo "dev: database of the installed Foriq app (LIVE DATA, background workers off)"
    ;;
  *) die "unknown mode '$MODE' (use: ./dev.sh  or  ./dev.sh app)" ;;
esac

[ -d "$ROOT/webapp/frontend/node_modules" ] || (cd "$ROOT/webapp/frontend" && npm install)

BPID=""; FPID=""
cleanup() {
  trap - INT TERM EXIT
  # SIGINT is what uvicorn's reloader and next dev handle cleanly; TERM as fallback.
  kill -INT $BPID $FPID 2>/dev/null || true
  for _ in 1 2 3 4 5; do kill -0 $BPID $FPID 2>/dev/null || break; sleep 1; done
  kill -TERM $BPID $FPID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(cd "$ROOT/webapp/backend" && exec "$PY" -m uvicorn main:app --reload --port "$BACKEND_PORT") &
BPID=$!
(cd "$ROOT/webapp/frontend" && FORIQ_DEV_BACKEND="http://localhost:$BACKEND_PORT" \
  exec npm run dev -- -p "$FRONTEND_PORT") &
FPID=$!

echo "dev: web UI http://localhost:$FRONTEND_PORT  ·  API http://localhost:$BACKEND_PORT  ·  Ctrl+C stops both"
# macOS ships bash 3.2 (no `wait -n`): stop everything as soon as one of the two exits.
while kill -0 "$BPID" 2>/dev/null && kill -0 "$FPID" 2>/dev/null; do sleep 1; done
