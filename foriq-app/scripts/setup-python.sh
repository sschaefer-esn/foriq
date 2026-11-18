#!/bin/sh
# Creates or updates the app's Python virtualenv (default build/venv, override with
# FORIQ_VENV) from the base interpreter $FORIQ_PYTHON (default python3, 3.11+) and
# installs the backend requirements plus the build tools into it. Re-installs only
# when the requirements, the tools or the base interpreter changed.
# Used by build-backend.sh and, when running from source, by the supervisor
# (src/supervisor/paths.js) and the USB helper. Nothing is installed globally.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO=${FORIQ_REPO:-$(cd "$APP_DIR/.." && pwd)}
REQUIREMENTS="$REPO/webapp/backend/requirements.txt"
PY=${FORIQ_PYTHON:-python3}
VENV=${FORIQ_VENV:-$APP_DIR/build/venv}
# Build tools: PyInstaller for the bundle, and esptool 5 for the USB helper
# (app_flasher.py uses the esptool 5 commands write-flash, usb-reset …).
BUILD_TOOLS="pyinstaller==6.22.3 esptool==5.1.0"

"$PY" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 'Python 3.11+ required: $PY')"

STAMP="$VENV/.foriq-requirements"
WANT=$( { cat "$REQUIREMENTS"; echo "$BUILD_TOOLS"
          "$PY" -c "import platform, sys; print(sys.version, platform.machine())"; } \
        | shasum -a 256 | cut -d" " -f1)
if [ -x "$VENV/bin/python" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$WANT" ]; then
  echo "[python] venv up to date: $VENV"
  exit 0
fi

if [ -d "$VENV" ] && [ ! -f "$VENV/pyvenv.cfg" ] && [ -n "$(ls -A "$VENV")" ]; then
  echo "$VENV exists and is not a virtualenv – refusing to replace it" >&2
  exit 1
fi
echo "[python] setting up venv: $VENV"
# --clear: start from scratch, so removed or downgraded packages do not linger.
"$PY" -m venv --clear "$VENV"
# shellcheck disable=SC2086
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check --no-input \
  -r "$REQUIREMENTS" $BUILD_TOOLS
echo "$WANT" > "$STAMP"
echo "[python] done: $("$VENV/bin/python" --version)"
