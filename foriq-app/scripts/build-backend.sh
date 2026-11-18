#!/bin/sh
# Bundles webapp/backend with PyInstaller into build/backend/foriq-backend/
# (onedir: fast start, no unpacking to /tmp on every run).
# Runs with the app's virtualenv (scripts/setup-python.sh: build/venv or
# $FORIQ_VENV, created from the base interpreter $FORIQ_PYTHON, Python 3.11+, with
# the pinned requirements, PyInstaller and esptool 5). The base interpreter's
# architecture determines the bundle's → use an arm64 Python.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO=${FORIQ_REPO:-$(cd "$APP_DIR/.." && pwd)}
BACKEND="$REPO/webapp/backend"
WORK="${FORIQ_BUILD_CACHE:-$HOME/Library/Caches/Foriq}/pyinstaller"
OUT="$APP_DIR/build/backend"
VENV=${FORIQ_VENV:-$APP_DIR/build/venv}

[ -f "$BACKEND/main.py" ] || { echo "Backend not found: $BACKEND" >&2; exit 1; }
sh "$APP_DIR/scripts/setup-python.sh"
PY="$VENV/bin/python"
"$PY" -c "import esptool, serial, sys; sys.exit(0 if esptool.__version__.startswith('5.') else 'esptool 5.x expected in $VENV')"

# uvicorn loads protocols/loops by string → collect submodules explicitly.
# Exclusions: packages from a global Python that would be pulled in optionally but
# are not needed by the backend (psycopg2 stays; openpyxl works without lxml).
"$PY" -m PyInstaller \
  --noconfirm --clean --log-level WARN \
  --name foriq-backend \
  --onedir \
  --paths "$BACKEND" \
  --workpath "$WORK/work" \
  --specpath "$WORK" \
  --distpath "$OUT" \
  --collect-submodules uvicorn \
  --collect-submodules utils \
  --paths "$REPO/firmware-cpp/tools" \
  --hidden-import app_flasher \
  --hidden-import serial.tools.list_ports \
  --collect-all esptool \
  --exclude-module tkinter \
  --exclude-module pytest \
  --exclude-module matplotlib \
  --exclude-module PIL \
  --exclude-module IPython \
  --exclude-module jedi \
  --exclude-module zmq \
  --exclude-module psycopg \
  --exclude-module psycopg_binary \
  --exclude-module lxml \
  "$APP_DIR/scripts/backend_entry.py"

# Optional: if the repo lives in a Dropbox folder, exclude build/ from syncing
# (otherwise hundreds of MB of PyInstaller files get synced).
if [ "${FORIQ_DROPBOX_IGNORE:-0}" = 1 ]; then
  xattr -w com.dropbox.ignored 1 "$APP_DIR/build" 2>/dev/null || true
fi
du -sh "$OUT/foriq-backend"
echo "[build] done: $OUT/foriq-backend"
