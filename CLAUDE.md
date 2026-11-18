# Foriq – agent and contributor guide

Foriq counts machine strokes with ESP32-S3 accelerometer sensors (M5Stick S3,
BMI270). Sensors detect strokes on-device and send them over HTTP to a FastAPI
backend with PostgreSQL; the backend also serves the static Next.js web UI. Everything
is self-hosted on one Mac through the Electron app `foriq-app/`. License: AGPL-3.0-only
(`LICENSE`, `NOTICE`); third-party material in `THIRD_PARTY_NOTICES.md`.

## Working style

**Keep answers short.** To the point, no filler. Explain only when needed or asked.

## Structure

```
foriq-app/        Electron app: supervisor (postgres, backend, mdns), status window, USB sensor setup
webapp/backend/   FastAPI backend: API, SSE, OTA, static UI; tests in tests/
webapp/frontend/  Next.js web UI (static export, JavaScript)
webapp/sql/       schema.sql – idempotent, applied on every app start
firmware-cpp/     Sensor firmware (PlatformIO); VERSION holds the firmware version
docs/             architecture, self-hosting, firmware, device protocol, development
```

## Tech stack

| Part | Technology |
|---|---|
| Backend | Python 3.11+ (3.13 in `.python-version`), FastAPI, SQLAlchemy `text()` queries, psycopg2, PyJWT, bcrypt, slowapi |
| Frontend | Next.js 16 (App Router, `output: "export"`), React 19, **JavaScript**, Tailwind CSS 4, shadcn/ui, Recharts, SWR |
| Database | PostgreSQL 18 (bundled via `@embedded-postgres/darwin-arm64`) |
| App | Electron 45, electron-builder, macOS arm64 |
| Firmware | C++/Arduino, PlatformIO (`espressif32 @ 6.13.0`), env `m5sticks3` (BMI270) |

## Architecture

```
sensors ── HTTP + X-Device-Token ──┐
browsers ── HTTP + JWT Bearer ─────┤
                                   ▼
            backend 0.0.0.0:8420 (http://foriq.local:8420): /api/v1, /health, static UI
                                   ▼
            PostgreSQL 127.0.0.1:54329
Foriq.app supervises both plus dns-sd (foriq.local); secrets in ~/Library/Application Support/Foriq/secrets.json
```

- One company per installation (created at first registration); roles owner/admin/viewer.
- `/api/v1/devices/app*` is loopback-only with `X-Foriq-App-Key` (`utils/app_only.py`).
- Live updates: SSE at `/api/v1/events/stream`; in-memory event bus, single worker.
- OTA: sensors fetch `firmware.bin` from the local backend (`ota.py`).
- Firmware < 14 compatibility lives only in `utils/legacy_protocol.py`, call sites marked `TRANSITION(fw<14)`.

Details: `docs/architecture.md`, `docs/device-protocol.md`.

## Critical rules

1. **`webapp/sql/schema.sql` must stay idempotent.** The app applies it on every start.
   Use `CREATE TABLE/INDEX IF NOT EXISTS`, new columns via `DO $$ ... IF NOT EXISTS ... END $$`,
   never `DROP`/`TRUNCATE` without `IF EXISTS` and a guard.
2. **Bump `firmware-cpp/VERSION`** (SemVer) with every firmware change: fix → PATCH,
   feature → MINOR, breaking protocol change → MAJOR.
3. **Report at the end whether schema changes were made.** The app applies them on its
   next start; a manually run backend needs `psql "$DATABASE_URL" -f webapp/sql/schema.sql`.
4. **OTA partition headroom.** Images must stay below 70 % of the OTA app slot
   (`tools/check_firmware_size.py` fails the build otherwise). The S3 uses the default
   8 MB layout (~3.2 MB slots). The partition table changes only via USB flash, never
   via OTA.

## Commands

Full, verified list: `README.md` → *Commands*. Keep both in sync.

```bash
# Everyday (from the repository root)
./dev.sh                                # backend :8005 + web UI :3000 (DB from webapp/.env)
./dev.sh app                            # same against the running Foriq app's DB (live data, workers off)
./build-app.sh [--dmg]                  # check requirements, build the app, replace /Applications/Foriq.app (or DMG only)
./ship.sh "message"                     # git add -A, commit, push (refuses secrets/ml/)
./cleanup.sh [--builds] [--yes]         # empty folders, caches, build outputs

# App (from foriq-app/)
npm install
npm run setup:python                    # venv build/venv from FORIQ_PYTHON (3.11+): requirements + pyinstaller + esptool
npm run build:frontend && npm start     # run from source (uses build/venv if present)
npm run start:test                      # separate data dir, ports 8421/54330, no mDNS
npm run build:backend                   # setup:python, then PyInstaller
npm run dist                            # DMG; needs PlatformIO, brew postgresql@18
npm run release:local                   # rebuild, replace /Applications/Foriq.app, restart
npm run release:github                  # DMG + install.sh + SHA256SUMS as GitHub release (docs/releasing.md)
npm run sim                             # simulated sensor against the running app
npm test                                # i18n checks (plain node)

# Backend (from webapp/backend/; env from webapp/.env, see webapp/.env.example)
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt
python -m uvicorn main:app --reload --port 8005
DATABASE_URL=postgresql://u:p@127.0.0.1:5432/foriq_test JWT_SECRET=test python -m unittest discover -s tests
# integration tests additionally need FORIQ_INTEGRATION_DB=1 and a disposable UTF-8 test DB (README)

# Frontend (from webapp/frontend/)
npm run dev        # :3000, proxies /api/* to :8005
npm run lint && npm test && npm run build

# Firmware (from firmware-cpp/)
pio run -e m5sticks3
pio run -e m5sticks3 -t upload --upload-port <port>
pio run -e m5sticks3 -t erase --upload-port <port>   # whole flash incl. NVS (portal does not start); upload again afterwards
```

## Agent playbooks

- User describes a machine or wrong counts → `docs/agents/tune-detector.md` (skill `/tune-detector`).
- Other ESP32 board or accelerometer → `docs/agents/port-hardware.md` (skill `/port-hardware`).

## Conventions

- English only in code, comments, logs and docs; UI text via the i18n dictionaries
  (`webapp/frontend/src/lib/i18n/`, `foriq-app/src/i18n.js`). **German is the default UI
  language** (English selectable); defaults live in `webapp/frontend/src/lib/i18n/defaultLocale.js`,
  `foriq-app/src/i18n.js` (`DEFAULT_LOCALE`) and `webapp/backend/utils/default_language.py`
  (`DEFAULT_LANG`, default names and export labels). Prerendered markup must match.
- No TypeScript – JavaScript only.
- SQLAlchemy only with `text()` queries, no ORM.
- Keep the existing style; surgical changes, no unrequested refactoring.
- Python dependencies live in virtualenvs (`foriq-app/build/venv`, `webapp/backend/.venv`),
  never in a global interpreter.
