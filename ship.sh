#!/bin/bash
# Commits everything and pushes it to GitHub in one step.
#
#   ./ship.sh "Short description of the change"
#
# Stages all changes (git add -A; .gitignore keeps secrets, builds and ml/ out),
# refuses if something that must never be published is staged, commits, pushes.
set -euo pipefail

cd "$(dirname "$0")"
MSG=${1:-}
[ -n "$MSG" ] || { echo "usage: ./ship.sh \"what changed\"" >&2; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { echo "ship: no remote 'origin' configured" >&2; exit 1; }

git add -A
if git diff --cached --quiet; then
  echo "ship: nothing to commit"
else
  # Last line of defence; .gitignore should already keep these out.
  BAD=$(git diff --cached --name-only | grep -E '(^|/)\.env$|(^|/)secrets\.json$|^ml/|\.dump$|\.pem$|ClashGrotesk' || true)
  if [ -n "$BAD" ]; then
    git reset -q
    echo "ship: refusing, these files must not be published:" >&2
    echo "$BAD" >&2
    exit 1
  fi
  if git diff --cached --name-only | grep -q '^firmware-cpp/\(src\|include\)/' \
     && ! git diff --cached --name-only | grep -q '^firmware-cpp/VERSION$'; then
    echo "ship: note: firmware sources changed but firmware-cpp/VERSION did not"
  fi
  git diff --cached --stat | tail -1
  git commit -q -m "$MSG"
fi
git push -q origin HEAD
echo "ship: pushed $(git rev-parse --short HEAD) to $(git remote get-url origin)"
