# Foriq app (macOS)

A Mac app that runs the complete Foriq stack on one computer: PostgreSQL and a single
backend process, plus `foriq.local` via mDNS. The backend serves both the API and the
web interface (a static Next.js export) on the same port; the interface itself runs in
the browser. Apple silicon (arm64) only for now.

```
Electron main process (src/main.js)  Dock app + menu bar icon + status window (src/ui/)
└─ Supervisor (src/supervisor/)
   ├─ postgres.js  EDB binaries from @embedded-postgres/darwin-arm64, initdb + schema.sql
   ├─ apps.js      backend (PyInstaller program or Python -m uvicorn) on 0.0.0.0:8420 (fixed):
   │               /api/v1/*, /health and the web UI (build/frontend, FORIQ_FRONTEND_DIR)
   ├─ mdns.js      dns-sd -P → foriq.local, re-registered when the IP changes (and after wake)
   ├─ backup.js    daily pg_dump → backups/, keeps the newest 14
   └─ service.js   health checks (2 s while starting, 10 s once healthy), restart with
                   backoff (1→30 s), hang detection, orphan cleanup, log rotation
src/sensor/        sensor on USB: set up (flash + Wi-Fi) and erase, via app_flasher.py
src/i18n.js        UI strings (German default via DEFAULT_LOCALE, English selectable; src/i18n/de.js, en.js)
```

**Address:** `http://foriq.local:8420` – a fixed, uncommon port so that port 80 stays free
for other services. If 8420 is in use, Foriq deliberately does not move to another port
(sensors have the address stored); the status window shows an error and Foriq keeps
retrying. PostgreSQL listens on `127.0.0.1:54329` only, sized for a small install
(`shared_buffers=64MB`, `max_connections=20`; the backend's pool uses at most 10).

The app endpoints `/api/v1/devices/app/*` (sensor via USB, owner password reset) are only
answered from `127.0.0.1` and only with the app key from `secrets.json`.

## Install (DMG)

```bash
cd foriq-app
npm install
npm run dist     # → dist/Foriq-<version>-arm64.dmg (+ dist/mac-arm64/Foriq.app)
```

The app is self-contained (PostgreSQL, backend including Python, web UI and sensor
firmware are in the bundle). Install it from the Terminal:

```bash
DMG=dist/Foriq-<version>-arm64.dmg
bash scripts/install.sh "file://$PWD/$DMG" "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
```

`scripts/install.sh` downloads the DMG with `curl` (also `file://`), checks its SHA-256,
mounts it read-only, copies `Foriq.app` to `/Applications` (it asks before replacing an
existing copy and refuses while Foriq is running) and unmounts it. It never touches the
data directory. Arguments or `FORIQ_DMG_URL` / `FORIQ_DMG_SHA256`; `FORIQ_INSTALL_DIR`
overrides `/Applications` (for tests). A Homebrew cask template for a personal tap is in
[`packaging/homebrew/`](packaging/homebrew/README.md).

The build copies `pg_dump`/`pg_restore` (for the backups) from Homebrew's PostgreSQL 18
into the bundle – the PostgreSQL npm package ships only the server. Once per build Mac:
`brew install postgresql@18` (other location: `FORIQ_PG_TOOLS_DIR=<dir with pg_dump>`).

## Signing

Foriq is **ad-hoc signed and not notarized**, on purpose: Developer ID signing and
notarization need a paid Apple Developer account, and the project distributes the app
via the Terminal instead. The build config is the `build` key in `package.json`
(`mac.identity: "-"`, no hardened runtime, `notarize: false`). The ad-hoc signature is
still required – arm64 code without any signature does not run.

Gatekeeper only checks files that carry the quarantine attribute, which browsers (and
Homebrew casks) add to downloads and `curl` does not. So:

- **Installed with `scripts/install.sh`:** starts normally.
- **DMG downloaded with a browser:** the first start is blocked. On macOS 26 the dialog
  reads *“Foriq” Not Opened – Apple could not verify “Foriq” is free of malware that may
  harm your Mac or compromise your privacy.* Click *Done*, open System Settings ›
  Privacy & Security, click *Open Anyway* next to *“Foriq” was blocked to protect your
  Mac.* and confirm. Alternatively, after checking the DMG's SHA-256, remove the
  attribute in the Terminal: `xattr -dr com.apple.quarantine /Applications/Foriq.app`.

There is deliberately no auto-update. To update, quit Foriq (menu bar icon › Quit), run
`scripts/install.sh` with the new DMG (or replace `Foriq.app` in Applications) and start
it again; the data directory is not touched and `schema.sql` migrates the database on
start.

## Usage

- The **Dock icon** opens the status window: services, address, sensor on USB and the
  settings (start at login, prevent sleep, language). The **menu bar icon** offers status,
  "Open in browser", start/stop services and logs.
- **Closing the window, Cmd+Q and "Quit" in the Dock only hide the app** – the services
  keep running so sensors can send. The same applies to `kill`/SIGTERM (Electron turns
  it into a normal quit that cannot be told apart).
- **Really quit:** menu bar icon › "Quit Foriq …" (with confirmation), automatically on
  logout/shutdown, or from the command line:
  `/Applications/Foriq.app/Contents/MacOS/Foriq --quit`
- **Start at login** (registered on the first start) and **prevent sleep** are on by
  default and can be switched off in the status window. After an automatic start at login
  the window stays closed. A closed MacBook lid still puts the Mac to sleep.
- **Language:** German by default (`DEFAULT_LOCALE` in `src/i18n.js`), regardless of the
  system language; English can be chosen in the status window. The choice is stored as
  `language` in `settings.json` and applies immediately; installs that never chose a
  language come up in German.
- **Forgot the owner password?** "Forgot password" in the status window sets a new one
  and shows it once.

## Updating this Mac

```bash
npm run release:local
```

Builds firmware, web UI, backend and app, quits Foriq cleanly, replaces
`/Applications/Foriq.app`, restarts it and checks that it is reachable from the LAN.
Downtime is about 10–20 s – sensors buffer and catch up. Database and keys are kept.

The app ships the sensor firmware (`Contents/Resources/foriq/firmware/`). Sensors with
**auto-update** enabled fetch a new version on their next sync; others update via the
update button on the device in the web UI.

To try app changes without sensors noticing:
`npm run start:test` (own data dir `Foriq-Test`, port 8421, PostgreSQL 54330, no foriq.local).

## Development

```bash
cd foriq-app
npm install
npm run build:frontend   # once, and after web UI changes (static export)
npm start                # Ctrl+C really quits here
```

Web UI with hot reload: start the backend on port 8005 with `DATABASE_URL` and
`JWT_SECRET` set (`cd webapp/backend && python3 main.py`; e.g. against a test instance's
PostgreSQL, password in its `secrets.json`), then run `npm run dev` in `webapp/frontend` –
the dev server proxies `/api/*` to `http://localhost:8005` (`FORIQ_DEV_BACKEND` for
another target).

In development the backend runs directly from `webapp/backend` with the interpreter of
the app's virtualenv `build/venv` (`npm run setup:python`, created from `FORIQ_PYTHON`,
default `python3`, 3.11+). Without a venv it falls back to `FORIQ_PYTHON`, which then
needs `webapp/backend/requirements.txt` itself. The USB helper, `build:backend` and
`build:firmware` use the venv as well; `icons` and `sim` run with `FORIQ_PYTHON`
(`icons` needs Pillow). To test the PyInstaller build:
`FORIQ_BACKEND_BIN=build/backend/foriq-backend/foriq-backend npm start`.

| Command | Purpose |
|---|---|
| `npm run build:frontend` | static export of `webapp/frontend` → `build/frontend/` |
| `npm run setup:python` | create/update the virtualenv `build/venv` (requirements + PyInstaller + esptool 5; re-installs only when they or the base interpreter change) |
| `npm run build:backend` | `setup:python`, then PyInstaller with the venv → `build/backend/foriq-backend/` |
| `npm run build:firmware` | sensor firmware for the M5Stick S3 (PlatformIO `pio`) → `build/firmware/m5sticks3/factory.bin` |
| `npm run pack` | bundle + DMG from the existing builds only |
| `npm run dist` | all three builds, then bundle + DMG |
| `npm run icons` | regenerate the icons in `assets/` from the logo geometry (needs Pillow) |
| `npm run sim` | simulated sensor against the running app |
| `node scripts/headless.js [dir]` | supervisor without a window (tests, debugging) |

Environment overrides:

| Variable | Effect |
|---|---|
| `FORIQ_USER_DATA` | data dir (test runs with their own data dir never register autostart) |
| `FORIQ_PORT`, `FORIQ_PG_PORT` | backend/PostgreSQL port – only for a test instance next to the running app |
| `FORIQ_NO_MDNS=1` | do not announce `foriq.local` (test instances) |
| `FORIQ_PYTHON` | base interpreter for the virtualenv; fallback for the backend and USB helper in development when there is no venv |
| `FORIQ_VENV` | location of the app's virtualenv (default `build/venv`) |
| `FORIQ_BACKEND_BIN`, `FORIQ_FRONTEND_DIR`, `FORIQ_FIRMWARE_DIR` | use a specific backend build / web UI export / firmware dir |
| `FORIQ_REPO` | repo root (default: parent of `foriq-app/`) |
| `FORIQ_BUILD_CACHE` | build cache / staging dir for the build scripts (default under `~/Library/Caches/Foriq`) |
| `FORIQ_DROPBOX_IGNORE=1` | if the repo lives in a Dropbox folder: exclude `build/` from syncing |

A headless test instance next to a running app, for example:

```bash
FORIQ_PORT=8421 FORIQ_PG_PORT=54330 FORIQ_NO_MDNS=1 node scripts/headless.js /tmp/foriq-test
```

Windows and Linux are not supported yet.

## Connecting sensors

New sensors use `http://foriq.local:8420`. In the sensor's setup portal, "Advanced" accepts
another address (e.g. `192.168.1.20`; port 8420 is added). Plain HTTP only to local
addresses.

After Wi-Fi setup the sensor registers itself and appears under **Sensors › New sensors**.
It only sends data after "Accept"; "Reject" removes the entry (if it keeps registering, it
shows up again). No factory registry is needed.

## Setting up or erasing a sensor via USB

Plug the stick into the Mac via USB-C. The status window shows the **Sensor on USB** card
with model and state (empty · "Press 3", FW … · unknown).

**Set up**
1. Click "Set up". The stick is erased completely and flashed (~1 minute, do not
   unplug). The app then reads the serial number and setup code and registers the sensor
   in Foriq – it is approved right away once the company is set up in the web UI;
   otherwise approve it under **Sensors › New sensors**.
2. Choose Wi-Fi:
   - **Connect:** enter Wi-Fi name and password in the app. The app transfers them via
     USB; the sensor tests the connection and reports success or failure. "Advanced"
     accepts another server address.
   - **Later via phone:** the app shows the setup code. Put the stick in its place,
     connect a phone to the Wi-Fi "Foriq-Setup" (password = setup code) and pick the Wi-Fi.

**Erase** – the app reads the sensor and asks for confirmation ("Permanently delete
'Press 3'?", with its stroke count). Then the stick is erased completely and the sensor
and its strokes are removed from Foriq. The stick is empty afterwards and can be set up
again.

Notes:
- Sticks with old firmware do not answer the USB query; the app then shows "State
  unknown", and erasing restarts the stick briefly to read it.
- Progress and error texts during flashing come from `firmware-cpp/tools/app_flasher.py`
  and are shown as-is (English).
- Technology: `firmware-cpp/tools/app_flasher.py` (in the bundle `foriq-backend flasher …`,
  esptool 5 built in), images from `npm run build:firmware`.

## Data

`~/Library/Application Support/Foriq/` (override: `FORIQ_USER_DATA`)

| Path | Contents |
|---|---|
| `postgres/data/` | database (kept across restarts and updates) |
| `secrets.json` | generated on first start: DB password, JWT/HMAC/app keys (mode 0600) – see below |
| `backups/foriq-YYYYMMDD-HHMMSS.dump` | daily database backup (`pg_dump -Fc`), newest 14 kept |
| `settings.json` | app settings (prevent sleep, language, …) |
| `runtime.json` | current ports (PostgreSQL, backend) + address |
| `logs/<service>.log` | log per service (rotated at 5 MB while running, 3 old generations `.1`–`.3`) |
| `run/<service>.pid` | PID + start time for cleanup after an app crash |

`schema.sql` is applied on **every** start (it is idempotent).

**Never delete or edit `secrets.json`.** Its `deviceTokenHmacKey` signs the tokens of all
paired sensors: a new key locks every sensor out until it is set up again, and a new
DB password no longer matches the database. Keep it together with the database (and
with any copy of `backups/`).

**Backups:** the status window shows the last backup; "Back up now" makes one
immediately, "Show" opens the folder. The first backup runs about a minute after start
if the newest is older than a day, then daily (checked hourly; a failed backup is
retried at the next check and shows a yellow light, the services keep running). Restore:
see [docs/self-hosting-macos.md](../docs/self-hosting-macos.md#backups).

## Simulating a sensor

```bash
npm run sim
```

Signs in (or creates the first account on a fresh install), registers a serial number,
approves and activates the device and sends strokes in the firmware's `hits-bin4` format.
Talks only to the local app over HTTP.

## Troubleshooting

- **"Port 8420 in use":** another Foriq instance (or another program) holds the port.
  Quit it, or use the test overrides above for a second instance.
- **"only reachable locally":** the macOS firewall blocks incoming connections to the
  ad-hoc signed app, so sensors and other computers cannot connect. Fix: System Settings ›
  Network › Firewall › Options → allow Foriq.
- **foriq.local does not resolve:** use the IP address shown in the status window.
  `dns-sd -P` registers only an A record; on the server Mac itself about 5 % of lookups
  fail briefly.
- **"PostgreSQL binaries missing":** run `npm install` in `foriq-app/` (the binaries come
  from the optional dependency `@embedded-postgres/darwin-arm64`).
- **StickS3 stuck in download mode:** hold the side reset button for about 2 s, release it
  when it flashes green, try again.
- **USB helper cannot open the port:** do not use the port with a serial monitor
  (`pio device monitor`) at the same time.
- **Anything else:** "Logs" in the status window opens `logs/`; hovering a service's
  status shows its last log line.
