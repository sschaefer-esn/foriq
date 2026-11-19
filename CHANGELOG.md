# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Firmware versions follow `firmware-cpp/VERSION`.

## [Unreleased]

## [0.2.0] – 2026-11-19

### Added

- The Mac app checks once a day for a new release (switch in the status window) and
  updates itself on a click: download, SHA-256 check, quit, install via the bundled
  `install.sh`, restart. Data stays; a failed install keeps the previous version and is
  reported at the next start (`logs/update.log`). Version 0.1.0 has no updater: update
  it once with `curl -fsSL https://foriq.de/install | bash`.
- `./build-app.sh`: checks the build requirements, then builds and installs the Mac app
  from the checkout (or only the DMG with `--dmg`).
- `docs/agents/getting-started.md` and the Claude Code skill `/getting-started`: a coding
  agent leads non-technical users from an empty Mac to counting sensors.

## [0.1.0] – 2026-11-18

First open-source release. Foriq is restructured from a hosted service into a
self-hosted application that runs entirely in the local network.

### Added

- Repository scripts: `./dev.sh` (backend and web UI with hot reload in one terminal,
  optionally against the running app's database), `./ship.sh` (commit and push with a
  check against publishing secrets), `./cleanup.sh` (empty folders, caches, builds).
- `npm run release:github` in `foriq-app/`: builds the DMG and publishes it with
  `install.sh` and `SHA256SUMS` as a GitHub release; `install.sh` without arguments
  installs the newest release.
- Backend: `FORIQ_NO_WORKERS=1` disables the background workers.
- Playbooks for coding agents (`docs/agents/`, `AGENTS.md`, Claude Code skills
  `/tune-detector` and `/port-hardware`); READMEs for the backend and the firmware;
  `docs/releasing.md`.

### Changed

- Hosting is local only: the macOS app `foriq-app/` supervises PostgreSQL
  (`127.0.0.1:54329`), the backend and the `foriq.local` mDNS name. No Docker, no
  external services.
- One backend process serves the API and the web UI on `http://foriq.local:8420`. The
  web UI is a static Next.js export; the separate Next.js server and the reverse proxy
  are gone.
- Login is handled by the backend (JWT); NextAuth was removed.
- Endpoints for the app (`/api/v1/devices/app*`) are protected in the backend: loopback
  only plus an app key.
- One company per installation, created at first registration; roles owner, admin and
  viewer remain.
- Firmware 14.0.0: English field names in the device protocol, API, database columns and
  routes (for example `upload_interval_s`, `sleep_after_min`, `restart_schedule`;
  `/data`, `/floor-plan`). The backend still understands firmware 13.x during the
  transition (`TRANSITION(fw<14)`, `webapp/backend/utils/legacy_protocol.py`).
- Sensors use plain HTTP to local addresses only; the server address is set at runtime
  (setup portal or USB) and defaults to `http://foriq.local:8420`.
- OTA updates are served from the firmware bundled with the app.
- Code, comments, logs and documentation are in English. The user interface (web UI and
  macOS app) defaults to German regardless of system or browser language; English is
  available as an explicit choice. Default names the backend creates ("Meine Firma",
  "Neuer Sensor …", "Halle 1", "… – Stillstand") and export labels are German too
  (`webapp/backend/utils/default_language.py`).
- macOS app: daily database backup (`pg_dump`, newest 14 kept, "Back up now" in the status window), log rotation while running, slower health checks once healthy, smaller PostgreSQL footprint, network re-check after wake, and `secrets.json` kept at mode 0600.
- macOS app distribution: ad-hoc signed, not notarised; installed from the Terminal with
  `foriq-app/scripts/install.sh` (curl download, SHA-256 check, asks before replacing,
  never touches the data directory). Homebrew cask template for a personal tap in
  `foriq-app/packaging/homebrew/`. The electron-builder config is back in
  `package.json`; the Developer ID/notarization option and `entitlements.plist` were
  removed.
- Web UI font: Inter (SIL Open Font License 1.1) replaces the previous typeface.
- Web UI font: Clash Grotesk is used again when a licensed `ClashGrotesk-Variable.ttf` is
  placed in `webapp/frontend/public/fonts/` before the build (git-ignored, not
  distributed); otherwise Inter. `/favicon.ico` and `/apple-touch-icon-precomposed.png`
  no longer answer 404.
- License: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) replaces the
  previous permissive license. The copyright holder and the trademark notice are unchanged; third-party
  material is listed in `THIRD_PARTY_NOTICES.md` (now including Inter and the verbatim
  Bosch BSD-3-Clause notice for the BMI270 configuration blob).
- Firmware 14.1.0: the earlier ESP32-based stick is no longer supported; the M5Stick S3 is the
  only sensor and the only image built, bundled and served over OTA. Devices of
  retired hardware stay in the database but are never offered an update. PlatformIO
  platform and library versions are pinned in `platformio.ini`.
- Firmware 14.1.1: license notice in the BMI270 configuration header only (no
  functional change).
- Python dependencies: FastAPI 0.164, Pydantic 2.14, uvicorn 0.54, SQLAlchemy 2.1 (the
  engine pins the psycopg2 driver), psycopg2-binary 2.9.13, PyJWT 2.15, bcrypt 5,
  python-dotenv 1.2, slowapi 0.1.10, tzdata 2026.6. The app build and the app run from
  source use a virtualenv `foriq-app/build/venv` (`npm run setup:python`) instead of
  packages installed into the system Python. Test-only packages are in
  `webapp/backend/requirements-dev.txt`.
- Backend: startup/shutdown via a FastAPI lifespan handler instead of the deprecated
  `on_event` hooks. New passwords longer than 72 bytes (bcrypt's limit) are rejected
  with a clear error; logins with such passwords no longer risk a server error.
- Web UI: the stroke energy panel and the minimum-peak value assume the S3's 800 Hz
  detector unconditionally.
- Commands for the app, backend, web UI, database and firmware are collected in the
  README.
- Dependencies: Next.js 16.4, React 19.3, lucide-react 1.x, framer-motion 14, shadcn
  CLI 4, Electron 45 (requires macOS 13 or later), electron-builder 26.18, bundled
  PostgreSQL 18.6.

### Removed

- Cloud deployment, database target switching, Sentry and other hosted-service plumbing.
- Management of multiple companies and invitations.
- Web push notifications (the in-app notification centre remains).
- Learning mode, labeling and raw-data recording.
- TLS and OTA signature checking in the firmware.
- Factory registry; sensors register themselves and are approved in the web UI.
- Private, obsolete and generated files.
