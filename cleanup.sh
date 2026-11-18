#!/bin/bash
# Removes leftovers that nothing needs: empty folders, Python caches, .DS_Store,
# old Foriq temp folders under /tmp – and with --builds also the build outputs.
#
#   ./cleanup.sh             show what would be removed (nothing is deleted)
#   ./cleanup.sh --yes       remove it
#   ./cleanup.sh --builds    also list build outputs (combine with --yes)
#
# Never touched: .git, ml/, webapp/.env, virtualenvs, node_modules, source files.
# Build outputs (~1.7 GB) are recreated by the next build; until then `./dev.sh`
# serves no OTA firmware (pio run -e m5sticks3) and the app has no DMG.
set -euo pipefail

cd "$(dirname "$0")"
YES=0; BUILDS=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --builds) BUILDS=1 ;;
    *) echo "usage: ./cleanup.sh [--builds] [--yes]" >&2; exit 1 ;;
  esac
done

PRUNE=(-path ./.git -o -path ./ml -o -name node_modules -o -name venv -o -name .venv
       -o -path ./foriq-app/build -o -path ./foriq-app/dist -o -name .next -o -name .pio
       -o -path ./webapp/frontend/out)

list() {
  find . \( "${PRUNE[@]}" \) -prune -o -type d -name __pycache__ -print
  find . \( "${PRUNE[@]}" \) -prune -o -type f -name .DS_Store -print
  # empty folders
  find . \( "${PRUNE[@]}" \) -prune -o -type d -empty -print
  find /private/tmp -maxdepth 1 -name 'foriq*' -mtime +1 2>/dev/null || true
  if [ "$BUILDS" = 1 ]; then
    for d in foriq-app/build foriq-app/dist webapp/frontend/.next webapp/frontend/out firmware-cpp/.pio; do
      [ -e "$d" ] && echo "./$d"
    done
  fi
  return 0
}

ITEMS=$(list | sort -u)
if [ -z "$ITEMS" ]; then echo "cleanup: nothing to remove"; exit 0; fi

echo "$ITEMS" | while read -r p; do printf '  %-70s %s\n' "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"; done
if [ "$YES" != 1 ]; then
  echo "cleanup: dry run – add --yes to remove"
  exit 0
fi
echo "$ITEMS" | while read -r p; do rm -rf -- "$p"; done
# removing caches can leave further empty folders behind
find . \( "${PRUNE[@]}" \) -prune -o -type d -empty -print -exec rmdir {} + 2>/dev/null || true
echo "cleanup: done"
