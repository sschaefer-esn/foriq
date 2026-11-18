#!/bin/bash
# Builds the Mac app from this checkout – including your own changes – in one step.
#
#   ./build-app.sh          build everything, replace /Applications/Foriq.app, restart it
#                           (database, keys and settings are kept)
#   ./build-app.sh --dmg    only build foriq-app/dist/Foriq-<version>-arm64.dmg,
#                           e.g. to install it on another Mac
#
# First checks all build requirements and lists what is missing with the command to
# install it, then installs the project's own dependencies (npm packages, Python
# virtualenv in foriq-app/build/venv) and builds firmware, web UI, backend and app.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
APP="$ROOT/foriq-app"
MODE=install
case "${1:-}" in
  "") ;;
  --dmg) MODE=dmg ;;
  *) echo "usage: ./build-app.sh [--dmg]" >&2; exit 1 ;;
esac

# ── Requirements ────────────────────────────────────────────────
missing=()
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] \
  || { echo "build-app: needs a Mac with Apple silicon" >&2; exit 1; }
command -v brew >/dev/null || missing+=("Homebrew:        see https://brew.sh")
command -v node >/dev/null && command -v npm >/dev/null || missing+=("Node.js + npm:   brew install node")
PY=${FORIQ_PYTHON:-python3}
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null \
  || missing+=("Python 3.11+:    brew install python@3.13   (or set FORIQ_PYTHON)")
command -v pio >/dev/null || missing+=("PlatformIO Core: brew install platformio")
PG_TOOLS=${FORIQ_PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}
[ -x "$PG_TOOLS/pg_dump" ] || missing+=("PostgreSQL 18 tools (pg_dump for backups): brew install postgresql@18")
if [ ${#missing[@]} -gt 0 ]; then
  echo "build-app: missing requirements, install them and run again:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

# ── Project dependencies ────────────────────────────────────────
cd "$APP"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "[build-app] npm install (foriq-app)"
  npm install --no-audit --no-fund
fi
# The Python venv (backend requirements, PyInstaller, esptool) is needed by the
# firmware step as well, so create it first.
sh scripts/setup-python.sh

# ── Build ───────────────────────────────────────────────────────
if [ "$MODE" = dmg ]; then
  npm run dist
  VERSION=$(node -p 'require("./package.json").version')
  echo
  DMG="$APP/dist/Foriq-$VERSION-arm64.dmg"
  echo "✓ $DMG"
  echo "  Install it on this or another Mac (copy the DMG and install.sh there first):"
  echo "  bash \"$APP/scripts/install.sh\" \"file://$DMG\" $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
else
  sh scripts/release-local.sh
fi
