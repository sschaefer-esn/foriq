# Foriq backend

FastAPI application: REST API for the web UI and the sensors, live updates (SSE),
firmware updates (OTA) and, when `FORIQ_FRONTEND_DIR` is set, the static web UI. One
process, one worker (the live-event bus is in memory). PostgreSQL via SQLAlchemy
`text()` queries, no ORM. The schema is `../sql/schema.sql`.

## Setup

```bash
cd webapp/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt          # requirements.txt + test-only packages
cp -n ../.env.example ../.env                # set DATABASE_URL and JWT_SECRET
```

Then start backend and web UI together from the repository root with `./dev.sh`
(or `./dev.sh app` against the database of the installed Foriq app), or the backend
alone with `python -m uvicorn main:app --reload --port 8005`. Configuration:
`../.env.example` (variables set in the shell win over the file).

## Modules

| File | Routes / role |
|---|---|
| `main.py` | app, routers, background workers (OTA reaper, notifications, retention); `FORIQ_NO_WORKERS=1` turns the workers off |
| `config.py` | environment variables |
| `auth.py`, `users.py` | `/api/v1/auth` (login, registration of the first account, JWT), `/api/v1/users` (roles owner/admin/viewer) |
| `devices.py` | `/api/v1/devices`: list, detail, settings, approval, USB app endpoints (`/app*`, loopback + app key) |
| `commands.py` | `/api/v1/devices/{id}/…` remote commands to a sensor (restart, Wi-Fi reset, OTA) |
| `ingest.py` | `/api/v1/ingest`: sensor registration, activation, stroke upload (`hits-bin4`) |
| `settings.py` | `/api/v1/settings/sync`: settings sync with the sensors, OTA bookkeeping |
| `ota.py` | `/api/v1/ota`: firmware version check and download |
| `data.py`, `dashboard.py` | stroke statistics per sensor and for the dashboard |
| `events.py` | `/api/v1/events/stream` (SSE live updates) |
| `export.py` | `/api/v1/export`: Excel, CSV and other formats |
| `layouts.py` | `/api/v1/layouts`: floor plan |
| `notifications.py` | `/api/v1/notifications`: standstill/offline rules and their worker |
| `maintenance.py` | retention of non-core data |
| `api_keys.py`, `external_api.py` | optional read-only API for ERP systems (off by default) |
| `counting_defaults.py` | defaults of the stroke detector settings |
| `frontend_static.py` | serves the static web UI with deep links |
| `utils/` | DB engine, auth helpers, device tokens, rate limits, logging, time zones, `legacy_protocol.py` (firmware < 14, `TRANSITION(fw<14)`) |
| `tools/api_access.py` | CLI to enable the external API for a company |

Protocol between sensors and backend: [docs/device-protocol.md](../../docs/device-protocol.md).

## Tests

```bash
DATABASE_URL=postgresql://u:p@127.0.0.1:5432/foriq_test JWT_SECRET=test \
  python -m unittest discover -s tests
```

Unit tests do not touch the database. Integration tests (`*_integration.py` and others)
run only with `FORIQ_INTEGRATION_DB=1` against a disposable database; how to create one:
[README › Backend](../../README.md#backend-webappbackend).
