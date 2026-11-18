#!/bin/bash
# Installs Foriq.app from a release DMG, from the Terminal.
#
#   bash install.sh                      newest GitHub release (curl -fsSL <url>/install.sh | bash)
#   FORIQ_DMG_URL=<url> FORIQ_DMG_SHA256=<sha256> bash install.sh
#   bash install.sh <url> <sha256>
#
# Why the Terminal: Foriq is ad-hoc signed and not notarized. curl does not set the
# quarantine attribute that browsers add, so Gatekeeper does not block the first
# start. The SHA-256 published with the release is the integrity check instead.
#
# What it does: download → verify SHA-256 → mount read-only → copy Foriq.app to
# /Applications (asks before replacing an existing copy) → unmount.
# It never touches the data directory (~/Library/Application Support/Foriq).
#
# Overrides (mainly for testing): FORIQ_INSTALL_DIR (default /Applications), FORIQ_RELEASE_BASE,
# FORIQ_ASSUME_YES=1 (replace an existing Foriq.app without asking).
set -euo pipefail

# Without arguments: the newest release of this GitHub repository. Its SHA256SUMS
# (written by foriq-app/scripts/release-github.sh) names the DMG and its checksum.
GITHUB_REPO=${FORIQ_GITHUB_REPO:-sschaefer-esn/foriq}

URL=${1:-${FORIQ_DMG_URL:-}}
SHA256=${2:-${FORIQ_DMG_SHA256:-}}
if [ -z "$URL" ] && [ -z "$SHA256" ]; then
  BASE=${FORIQ_RELEASE_BASE:-https://github.com/$GITHUB_REPO/releases/latest/download}
  SUMS=$(curl -fsSL "$BASE/SHA256SUMS") || { echo "Error: cannot fetch $BASE/SHA256SUMS" >&2; exit 1; }
  LINE=$(printf '%s\n' "$SUMS" | grep -E '[[:space:]]Foriq-.*-arm64\.dmg$' | head -1 || true)
  SHA256=$(printf '%s' "$LINE" | awk '{print $1}')
  [ -n "$SHA256" ] && URL="$BASE/$(printf '%s' "$LINE" | awk '{print $2}')"
fi
INSTALL_DIR=${FORIQ_INSTALL_DIR:-/Applications}
APP_NAME="Foriq.app"

die() { echo "Error: $*" >&2; exit 1; }

# Questions go to the terminal, so this also works as `curl … | bash`.
ask() {
  local answer=""
  if [ "${FORIQ_ASSUME_YES:-0}" = 1 ]; then return 0; fi
  if { exec 3</dev/tty; } 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer <&3 || true
    exec 3<&-
  else
    printf '%s [y/N] ' "$1"
    read -r answer || true
  fi
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

[ "$(uname -s)" = Darwin ] || die "Foriq for macOS needs a Mac."
[ "$(uname -m)" = arm64 ] || die "Foriq needs a Mac with Apple silicon (arm64)."
[ -n "$URL" ] || die "no download URL. Pass it as the first argument or set FORIQ_DMG_URL."
[ -n "$SHA256" ] || die "no SHA-256. Pass it as the second argument or set FORIQ_DMG_SHA256 (published with the release)."
[ -d "$INSTALL_DIR" ] || die "install directory does not exist: $INSTALL_DIR"

TARGET="$INSTALL_DIR/$APP_NAME"
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  die "Foriq is running. Quit it first (menu bar icon › Quit), then run this again."
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/foriq-install.XXXXXX")
MOUNT="$WORK/mnt"
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" = 1 ]; then
    hdiutil detach -quiet "$MOUNT" || hdiutil detach -quiet -force "$MOUNT" || true
  fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

DMG="$WORK/Foriq.dmg"
echo "Downloading $URL"
curl -fL --proto '=https,file' --progress-bar -o "$DMG" "$URL"

ACTUAL=$(shasum -a 256 "$DMG" | awk '{print $1}')
EXPECTED=$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')
[ "$ACTUAL" = "$EXPECTED" ] || die "SHA-256 mismatch – not installing.
  expected: $EXPECTED
  got:      $ACTUAL"
echo "SHA-256 ok"

mkdir "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MOUNT" "$DMG"
MOUNTED=1
[ -d "$MOUNT/$APP_NAME" ] || die "$APP_NAME not found in the disk image."

if [ -e "$TARGET" ]; then
  OLD_VERSION=$(defaults read "$TARGET/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
  NEW_VERSION=$(defaults read "$MOUNT/$APP_NAME/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
  ask "Replace $TARGET (version $OLD_VERSION) with version $NEW_VERSION? Your data is kept." \
    || die "cancelled, nothing changed."
fi

# Copy next to the target first, then swap, so a failed copy leaves the old app intact.
STAGED="$INSTALL_DIR/.Foriq.app.installing"
rm -rf "${STAGED:?}"
ditto "$MOUNT/$APP_NAME" "$STAGED" || { rm -rf "${STAGED:?}"; die "copy failed (permissions? try: sudo bash $0 …)"; }
if [ -e "$TARGET" ]; then
  mv "$TARGET" "$WORK/old.app"
fi
mv "$STAGED" "$TARGET"

echo
echo "Installed: $TARGET"
echo "Start it with:  open \"$TARGET\""
echo "The web interface is then at http://foriq.local:8420 (see the status window)."
