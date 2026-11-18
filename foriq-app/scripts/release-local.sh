#!/bin/sh
# Puts a new version into service on THIS Mac: builds firmware, frontend, backend
# and app, replaces /Applications/Foriq.app and restarts it.
#
# Downtime only for the restart (~10–20 s). Sensors buffer meanwhile and catch up.
# Database, keys and settings live in ~/Library/Application Support/Foriq and are
# left untouched. Sensors with auto-update fetch the bundled firmware afterwards.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO=${FORIQ_REPO:-$(cd "$APP_DIR/.." && pwd)}
TARGET=/Applications/Foriq.app
BUILT="$APP_DIR/dist/mac-arm64/Foriq.app"
PORT=8420

cd "$APP_DIR"
echo "[release] 1/4 Firmware"
sh scripts/build-firmware.sh
echo "[release] 2/4 Frontend"
sh scripts/build-frontend.sh >/dev/null
echo "[release] 3/4 Backend"
sh scripts/build-backend.sh | tail -1
echo "[release] 4/4 App-Bundle"
npx electron-builder --mac dir 2>&1 | grep -E "copied|error" || true
[ -x "$BUILT/Contents/MacOS/Foriq" ] || { echo "Bundle missing: $BUILT" >&2; exit 1; }

# Quit the running app cleanly (Postgres shuts down properly).
if pgrep -f "$TARGET/Contents/MacOS/Foriq" >/dev/null; then
  echo "[release] Quitting Foriq …"
  "$TARGET/Contents/MacOS/Foriq" --quit || true
  n=0
  while pgrep -f "$TARGET/Contents/MacOS/Foriq" >/dev/null; do
    n=$((n + 1)); [ "$n" -gt 60 ] && { echo "Foriq does not quit – aborted, nothing replaced." >&2; exit 1; }
    sleep 1
  done
fi

echo "[release] Replacing $TARGET"
rm -rf "$TARGET"
ditto "$BUILT" "$TARGET"
open "$TARGET"

# Wait until everything is green, then check reachability from the LAN.
n=0
until curl -fsS -m 2 -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 90 ] && { echo "Foriq not responding after 3 min – check the status window/logs." >&2; exit 1; }
  sleep 2
done
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
IP=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null || true)
if [ -n "$IP" ] && ! curl -fsS -m 4 -o /dev/null "http://$IP:$PORT/health"; then
  echo "⚠ Foriq is running but not reachable from outside ($IP:$PORT)."
  echo "  Probably the macOS firewall: System Settings › Network › Firewall › Options → allow Foriq."
  exit 1
fi
echo "✓ New version is running (port $PORT${IP:+, LAN $IP})."
