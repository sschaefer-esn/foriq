#!/bin/sh
# Publishes a downloadable release of the Mac app on GitHub.
#
#   1. raise "version" in foriq-app/package.json, ./ship.sh "Release x.y.z"
#   2. npm run release:github
#
# Builds the DMG (npm run dist), writes SHA256SUMS and creates the GitHub release
# v<version> with three assets: the DMG, install.sh and SHA256SUMS. The one-line
# installer (install.sh without arguments) always picks the newest release.
# Needs the GitHub CLI (gh, logged in) and everything `npm run dist` needs.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$APP_DIR"
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
DMG="dist/Foriq-$VERSION-arm64.dmg"

command -v gh >/dev/null || { echo "release: GitHub CLI missing (brew install gh, gh auth login)" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: uncommitted changes – run ./ship.sh first" >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "release: HEAD is not pushed – run ./ship.sh first" >&2; exit 1; }
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release: $TAG exists already – raise \"version\" in foriq-app/package.json" >&2; exit 1
fi

echo "[release] building Foriq $VERSION"
npm run dist
[ -f "$DMG" ] || { echo "release: $DMG not found" >&2; exit 1; }

OUT=$(mktemp -d)
cp "$DMG" scripts/install.sh "$OUT/"
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > SHA256SUMS)

gh release create "$TAG" "$OUT/$(basename "$DMG")" "$OUT/install.sh" "$OUT/SHA256SUMS" \
  --title "Foriq $VERSION" --generate-notes --target "$(git rev-parse HEAD)"
rm -rf "$OUT"
echo "[release] done: $(gh release view "$TAG" --json url -q .url)"
