# Publishing changes and releases

For maintainers of `sschaefer-esn/foriq`: only accounts with write access to the
repository can publish releases. Contributors push to their fork and open a pull
request ([CONTRIBUTING.md](../CONTRIBUTING.md)); anyone can build the app themselves with
`npm run dist` (README › Commands).

Three separate things:

| | What | Command |
|---|---|---|
| **Push** | source code to GitHub (any time) | `./ship.sh "what changed"` |
| **Release** | downloadable Mac app for users | `cd foriq-app && npm run release:github` |
| **This Mac** | update the Foriq installed here | `cd foriq-app && npm run release:local` |

## Push

`./ship.sh "message"` stages everything (`git add -A`), refuses if a file that must not
be published is staged (`.env`, `secrets.json`, `ml/`, dumps, keys, the licensed
font), commits and pushes the current branch. `.gitignore` is the first line of defence;
the check in `ship.sh` is the second. It warns when firmware sources changed without a
new `firmware-cpp/VERSION`.

## Release of the Mac app

Requirements on the build Mac: everything `npm run dist` needs (README › Commands) and
the GitHub CLI (`brew install gh`, `gh auth login`).

1. Raise `"version"` in `foriq-app/package.json` (SemVer; the firmware has its own
   version in `firmware-cpp/VERSION`). Add a section to `CHANGELOG.md`.
2. `./ship.sh "Release x.y.z"`
3. `cd foriq-app && npm run release:github`

`scripts/release-github.sh` refuses uncommitted or unpushed changes and existing tags,
builds the DMG (firmware, web UI, backend, app), writes `SHA256SUMS` and creates the
GitHub release `vX.Y.Z` with three files: `Foriq-X.Y.Z-arm64.dmg`, `install.sh`,
`SHA256SUMS`.

Users install or update with one line (`foriq.de/install` redirects to
`https://github.com/sschaefer-esn/foriq/releases/latest/download/install.sh`):

```bash
curl -fsSL https://foriq.de/install | bash
```

`install.sh` without arguments reads `SHA256SUMS` of the newest release, downloads the
DMG, checks its checksum and copies `Foriq.app` to `/Applications`. The repository it
reads from is `GITHUB_REPO` in `foriq-app/scripts/install.sh` (override:
`FORIQ_GITHUB_REPO=owner/repo`).

## Why the Terminal and not a double-click download

The app is signed ad hoc and not notarised (no paid Apple Developer account). macOS
blocks such apps on the first start when they come from a browser download; `curl`
does not set the quarantine flag, so the Terminal install starts normally. A browser
download still works via System Settings › Privacy & Security › *Open Anyway*
([foriq-app/README.md › Signing](../foriq-app/README.md#signing)).

A normal double-click download needs a Developer ID certificate (Apple Developer
Program, 99 USD/year), `mac.identity` set to it, hardened runtime and notarisation in
`foriq-app/package.json` (`build.mac`), and the Apple credentials in the build
environment. The release script stays the same.

## Sensors

Every app release contains the firmware built from `firmware-cpp/`. Sensors with
auto-update install it on their next sync after the user updated the app; others
update from the web UI (Settings › Firmware or the device page).
