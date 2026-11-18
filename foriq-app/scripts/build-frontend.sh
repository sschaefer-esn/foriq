#!/bin/sh
# Builds webapp/frontend as a static Next.js export into foriq-app/build/frontend.
# The backend serves it (FORIQ_FRONTEND_DIR, see src/supervisor/apps.js); the
# browser calls the API relatively under /api/v1 (same origin).
#
# Built in a copy outside the repo (~/Library/Caches) so that the
# webapp/frontend/.next of a running `next dev` is not overwritten.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO=${FORIQ_REPO:-$(cd "$APP_DIR/.." && pwd)}
SRC="$REPO/webapp/frontend"
STAGE="${FORIQ_BUILD_CACHE:-$HOME/Library/Caches/Foriq}/frontend-build"
OUT="$APP_DIR/build/frontend"

[ -f "$SRC/package.json" ] || { echo "Frontend not found: $SRC" >&2; exit 1; }

echo "[build] Source:  $SRC"
echo "[build] Staging: $STAGE"
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude out --exclude '.env*' \
  "$SRC/" "$STAGE/"

cd "$STAGE"
npm ci --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 npm run build
[ -f out/index.html ] || { echo "Export missing: $STAGE/out/index.html" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R out/. "$OUT/"

# Optional: if the repo lives in a Dropbox folder, exclude build/ from syncing.
if [ "${FORIQ_DROPBOX_IGNORE:-0}" = 1 ]; then
  xattr -w com.dropbox.ignored 1 "$APP_DIR/build" 2>/dev/null || true
fi

echo "[build] done: $OUT"
