# Foriq

Foriq counts machine strokes (for example of presses and forging machines) with small
accelerometer sensors mounted on the machine. Each sensor detects strokes on the device
and sends them over Wi-Fi to a server in your local network, which stores them and shows
live counts, rates and history in a web UI. Everything runs on your own Mac; no cloud
service is involved.

## Quick start (development)

Everything from the repository root, one terminal, Ctrl+C stops it:

```bash
./dev.sh app                # web UI + backend with hot reload, on the LIVE data of the Foriq app running on this Mac
./dev.sh                    # same, against the database in webapp/.env (your dev database)
```

Then open **http://localhost:3000** (API on :8005). Code changes reload by themselves.

```bash
./ship.sh "what changed"    # commit everything and push to GitHub
./cleanup.sh                # show leftovers (empty folders, caches); --yes removes, --builds adds build outputs
cd foriq-app && npm run release:local    # put the current state into /Applications/Foriq.app on this Mac
```

- `./dev.sh app` takes the connection and keys from the app's `secrets.json` and turns the
  backend's background workers off (`FORIQ_NO_WORKERS=1`), so notifications are not sent
  twice. **Changes made in the web UI change real data.**
- First time: Python packages for the backend ([webapp/backend/README.md](webapp/backend/README.md#setup));
  `./dev.sh` installs the web UI's npm packages itself. For `./dev.sh` without `app`:
  `cp webapp/.env.example webapp/.env` and set `DATABASE_URL`, `JWT_SECRET`.
- Other ports: `FORIQ_DEV_BACKEND_PORT`, `FORIQ_DEV_FRONTEND_PORT`. Only one web UI dev
  server can run per checkout.

### Release: make the Mac app downloadable

```bash
# 1. raise "version" in foriq-app/package.json (e.g. 0.2.0), then
./ship.sh "Release 0.2.0"
# 2. build the app and publish it as a GitHub release (DMG + install.sh + SHA256SUMS)
cd foriq-app && npm run release:github
```

3. Users install or update with one line (foriq.de/install points to the newest release):

```bash
curl -fsSL https://foriq.de/install | bash
```

Details, signing and why the Terminal: [docs/releasing.md](docs/releasing.md).

## How it works

```
 sensors (M5Stick, Wi-Fi)                 browsers in the LAN
        │ HTTP, device token                    │ HTTP, user login
        └──────────────────┬────────────────────┘
                           ▼
              http://foriq.local:8420
        ┌─────────────────────────────────────┐
        │ backend (FastAPI): API + web UI      │
        └──────────────────┬──────────────────┘
                           ▼
                 PostgreSQL (127.0.0.1)

 Foriq.app (Electron) supervises PostgreSQL, the backend and
 the foriq.local mDNS name, and sets up sensors over USB.
```

- Sensors detect strokes on-device and upload them in batches; they buffer data while
  the server is unreachable.
- The backend stores strokes in PostgreSQL, pushes live updates to the browser (SSE)
  and serves firmware updates to the sensors.
- The web UI shows dashboards, per-machine data, a floor plan, notifications for
  standstill or offline machines, and data export (Excel, CSV and more).
- The user interface (web UI and app) is German by default; English can be selected in
  the settings of each. Code, logs and documentation are in English. See
  [docs/development.md](docs/development.md#internationalisation) for where the default
  is defined.

## Supported hardware

| Sensor | MCU | Accelerometer |
|---|---|---|
| M5Stick S3 | ESP32-S3 | BMI270 |

Server: a Mac with Apple Silicon.

## Install

Once a release is published, one line in the Terminal installs or updates Foriq
(see [docs/releasing.md](docs/releasing.md)):

```bash
curl -fsSL https://foriq.de/install | bash
```

Until then, build the app yourself (see *App* below) and install it from the Terminal:

```bash
cd foriq-app
DMG=dist/Foriq-<version>-arm64.dmg
bash scripts/install.sh "file://$PWD/$DMG" "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
open /Applications/Foriq.app
```

1. The first start initialises the database and its secrets. Open
   `http://foriq.local:8420` and register the first account (it becomes the owner).
2. Connect a sensor via USB-C and click *Set up* in the Foriq status window. Enter the
   Wi-Fi credentials in the app, or later through the sensor's `Foriq-Setup` Wi-Fi
   network.
3. Sensors that registered themselves over Wi-Fi appear as new sensors in the web UI
   and start sending data once you approve them.

Full instructions (release installs, autostart, network, updates):
[docs/self-hosting-macos.md](docs/self-hosting-macos.md).

## Commands

The everyday commands (`./dev.sh`, `./ship.sh`, `./cleanup.sh`) are in
[Quick start](#quick-start-development) at the top.

Requirements for building: Node.js with npm, Python 3.11+, macOS 13+ on Apple Silicon,
[PlatformIO Core](https://platformio.org/install/cli) (`pio`) and Homebrew's
`postgresql@18` (the build bundles its `pg_dump`/`pg_restore`). All paths below are
relative to the repository root.

### App (`foriq-app/`)

```bash
cd foriq-app
npm install                 # Node dependencies (Electron, bundled PostgreSQL)
npm run setup:python        # venv build/venv: backend requirements + PyInstaller + esptool
npm run build:frontend      # static web UI export -> build/frontend
npm start                   # run from source (backend from webapp/backend, uses build/venv)
npm run start:test          # isolated instance: own data dir, ports 8421/54330, no mDNS
npm run dist                # web UI + backend + firmware + app -> dist/Foriq-<version>-arm64.dmg
npm run release:local       # builds everything, quits Foriq, replaces /Applications/Foriq.app, restarts it, checks :8420
npm run release:github      # builds the DMG and publishes a GitHub release (docs/releasing.md)
npm run sim                 # simulated sensor against the running app
npm test                    # i18n checks (plain node, no Electron)
```

`setup:python` uses `FORIQ_PYTHON` (default `python3`) as base interpreter and
re-installs only when `webapp/backend/requirements.txt` changed. `release:local` leaves
the data directory (`~/Library/Application Support/Foriq`) untouched. More variables
and scripts: [foriq-app/README.md](foriq-app/README.md).

### Backend (`webapp/backend/`)

```bash
cd webapp/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt                    # requirements.txt + test-only packages
cp -n ../.env.example ../.env                          # then set DATABASE_URL and JWT_SECRET
python -m uvicorn main:app --reload --port 8005       # API only (+ web UI if FORIQ_FRONTEND_DIR is set)
DATABASE_URL=postgresql://u:p@127.0.0.1:5432/foriq_test JWT_SECRET=test \
  python -m unittest discover -s tests                 # unit tests (integration tests skipped)
```

The backend reads `webapp/.env` (template: `webapp/.env.example`); variables already
set in the shell win. Integration tests need `FORIQ_INTEGRATION_DB=1` and a disposable
UTF-8 database, never a real install. One with the PostgreSQL bundled with the app:

```bash
PG=foriq-app/node_modules/@embedded-postgres/darwin-arm64/native/bin
"$PG/initdb" -D /tmp/foriq-pg -U postgres --auth=trust -E UTF8
"$PG/pg_ctl" -D /tmp/foriq-pg -o "-p 54399 -k ''" -l /tmp/foriq-pg.log start
psql postgresql://postgres@127.0.0.1:54399/postgres -c "CREATE DATABASE foriq_test"
psql postgresql://postgres@127.0.0.1:54399/foriq_test -f webapp/sql/schema.sql
cd webapp/backend && FORIQ_INTEGRATION_DB=1 JWT_SECRET=test \
  DATABASE_URL=postgresql://postgres@127.0.0.1:54399/foriq_test python -m unittest discover -s tests
"$PG/pg_ctl" -D /tmp/foriq-pg stop && rm -rf /tmp/foriq-pg   # throw it away
```

### Frontend (`webapp/frontend/`)

```bash
cd webapp/frontend
npm install
npm run dev                             # :3000 with hot reload, proxies /api/* to :8005
npm run lint && npm test && npm run build   # build = static export to out/
```

### Database of an installed app

```bash
DATA="$HOME/Library/Application Support/Foriq"   # database, secrets.json, logs, backups
ls -l "$DATA/backups"                             # daily pg_dump files, newest 14 kept
```

*Back up now* in the status window makes a backup immediately. Restoring:
[docs/self-hosting-macos.md](docs/self-hosting-macos.md#restoring-a-backup). The app
applies `webapp/sql/schema.sql` on every start; a hand-run backend needs
`psql "$DATABASE_URL" -f webapp/sql/schema.sql`.

### Firmware (`firmware-cpp/`, M5Stick S3)

```bash
cd firmware-cpp
pio device list                                     # serial ports (<port>)
pio run -e m5sticks3                                # build -> .pio/build/m5sticks3/firmware.bin
pio run -e m5sticks3 -t upload --upload-port <port> # flash over USB
pio run -e m5sticks3 -t erase --upload-port <port>  # erase the WHOLE flash ...
pio run -e m5sticks3 -t upload --upload-port <port> # ... then flash again (mandatory)
```

- Every firmware change bumps `firmware-cpp/VERSION` (SemVer); the build embeds it.
- OTA: sensors fetch `firmware.bin` from the local backend. The app ships the image
  built at `npm run dist` / `release:local` time; a backend run from source serves
  `firmware-cpp/.pio/build/m5sticks3/firmware.bin` directly. Sensors with auto-update
  install a version that differs from theirs (never a downgrade).
- A plain upload keeps the NVS (Wi-Fi, token). If the `Foriq-Setup` portal does not
  start, erase and upload as above; after an erase the flash is empty until the upload.
- The S3 runs USB-CDC on the chip's own USB port (`ARDUINO_USB_MODE=1`). Observed
  behaviour: opening the serial port (e.g. `pio device monitor`) resets it and can
  leave it in download mode (no app, no portal). Back into the app:
  `foriq-app/build/venv/bin/python -m esptool --chip esp32s3 --port <port> --after watchdog-reset run`.

Details: [docs/firmware.md](docs/firmware.md).

### Updating dependencies

```bash
cd foriq-app && npm outdated && npm install <pkg>@<version>          # app (exact pins)
cd webapp/frontend && npm outdated && npm install <pkg>@<version>    # web UI
# Python: edit the pins in webapp/backend/requirements.txt, then
cd foriq-app && npm run setup:python                                 # rebuilds build/venv
# PlatformIO: platform/library versions are pinned in firmware-cpp/platformio.ini
```

After an update run the backend tests (unit + integration), the frontend checks and
`pio run -e m5sticks3`.

## Documentation

- [Architecture](docs/architecture.md): processes, ports, data, authentication
- [Self-hosting on macOS](docs/self-hosting-macos.md): install, autostart, network, updates, backups
- [Sensor firmware](docs/firmware.md): building, flashing, setup portal, versioning
- [Device protocol](docs/device-protocol.md): sensor API, binary hit format, OTA
- [Development](docs/development.md): how the pieces fit together in development, schema rules, conventions
- [Publishing and releases](docs/releasing.md): push, GitHub release of the Mac app, signing
- [Foriq app](foriq-app/README.md), [backend](webapp/backend/README.md), [web UI](webapp/frontend/README.md), [firmware](firmware-cpp/README.md), [contributing](CONTRIBUTING.md)

### Working with a coding agent

Foriq is meant to be adapted with coding agents such as Claude Code. Start one in the
repository folder and describe your machine or your hardware; the agent finds the
project rules in [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) and these playbooks:

- [Fit stroke counting to your machines](docs/agents/tune-detector.md): what the agent
  asks, which settings it changes, how it checks the result, when it changes the algorithm.
- [Port the firmware to another ESP32 board](docs/agents/port-hardware.md).

In Claude Code they are also available as `/tune-detector` and `/port-hardware`.

## Repository layout

```
foriq-app/        Electron app: supervisor for PostgreSQL, backend and mDNS; USB sensor setup
webapp/backend/   FastAPI backend (API, SSE, OTA, static web UI)
webapp/frontend/  Next.js web UI, exported as static files
webapp/sql/       PostgreSQL schema (idempotent, applied on every start)
firmware-cpp/     Sensor firmware (PlatformIO)
assets/branding/  Logo and icon sources
docs/             Documentation (docs/agents/: playbooks for coding agents)
dev.sh, ship.sh, cleanup.sh   development start, push, clean-up
```

## Project status

Foriq is under active development. The server currently runs on macOS with Apple
Silicon only; Linux support is planned. The app is signed ad hoc and not notarised;
it is installed from the Terminal (`foriq-app/scripts/install.sh`), which avoids the
Gatekeeper block a browser download triggers. See
[docs/self-hosting-macos.md](docs/self-hosting-macos.md#installing-a-release-via-the-terminal).

Foriq uses plain HTTP and is meant for trusted local networks. Do not expose it to the
internet; see [SECURITY.md](SECURITY.md).

## License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`), see [LICENSE](LICENSE)
and [NOTICE](NOTICE). In plain terms: if you modify Foriq and let others use your
modified version over a network, you must offer them its complete source code under the
same license. The name "Foriq" and the Foriq logo are not covered by the license (see
NOTICE). Third-party components keep their own licenses, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
