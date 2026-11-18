# Architecture

Foriq runs on a single Mac in the local network. The Electron app (`foriq-app/`)
supervises three child processes; sensors and browsers talk to one backend port.

```
 sensors (ESP32)            browsers in the LAN
      │  HTTP + X-Device-Token     │  HTTP + JWT
      └──────────────┬─────────────┘
                     ▼
        http://foriq.local:8420   (0.0.0.0:8420)
   ┌────────────────────────────────────────────┐
   │ backend: FastAPI / uvicorn, 1 worker        │
   │   /api/v1/*   REST API, SSE                 │
   │   /health     liveness + DB check           │
   │   /*          static web UI (Next.js export)│
   └──────────────────────┬─────────────────────┘
                          ▼
               PostgreSQL on 127.0.0.1:54329

 Foriq.app (Electron main process)
   supervisor: postgres · backend · mdns (dns-sd)
   status window, menu bar icon, USB sensor setup
```

## Processes

| Service | What runs | Code |
|---|---|---|
| `postgres` | bundled PostgreSQL binaries (`@embedded-postgres/darwin-arm64`), `listen_addresses=127.0.0.1`, no Unix socket | `foriq-app/src/supervisor/postgres.js` |
| `backend` | packaged: PyInstaller build `foriq-backend`; development: `python -m uvicorn main:app --workers 1` in `webapp/backend` | `foriq-app/src/supervisor/apps.js` |
| `mdns` | `/usr/bin/dns-sd -P Foriq _http._tcp local 8420 foriq.local <lan-ip>`, re-registered when the LAN IP changes | `foriq-app/src/supervisor/mdns.js` |

The supervisor (`service.js`) health-checks every service, restarts it with backoff
(1, 2, 5, 10, 30 s), cleans up orphaned processes after a crash using PID files, and
rotates each log at 5 MB while running (three generations, `<service>.log.1` … `.3`). It also checks whether the backend answers on the LAN IP; if
only `localhost` works (typically the macOS firewall), the status window says so.

On every start the supervisor creates the database if needed and applies
`webapp/sql/schema.sql`. The schema is idempotent, so this is also the migration step.

Once a day the app backs up the database with `pg_dump` (custom format) into
`backups/` and keeps the newest 14 (`foriq-app/src/supervisor/backup.js`). `pg_dump`
and `pg_restore` are copied from Homebrew's PostgreSQL 18 at build time. Restoring is
described in [self-hosting-macos.md](self-hosting-macos.md#restoring-a-backup).

The backend has background tasks of its own: an OTA reaper (every 60 s), a notification
worker (every 30 s) and a daily retention job (`main.py`, `maintenance.py`).

## Ports

| Port | Bind | Use |
|---|---|---|
| 8420 | `0.0.0.0` | backend: API, web UI, sensors. Fixed; if it is taken, Foriq reports an error and retries instead of choosing another port, because sensors store the address. |
| 54329 | `127.0.0.1` | PostgreSQL |
| 8005 | | development only: backend run by hand (`uvicorn ... --port 8005`) |
| 3000 | | development only: `next dev`, proxies `/api/*` to `http://localhost:8005` |

`npm run start:test` in `foriq-app/` uses 8421 and 54330, its own data directory and no
mDNS, so it can run next to a production instance.

## Data directory

`~/Library/Application Support/Foriq/` (override with `FORIQ_USER_DATA`):

| Path | Content |
|---|---|
| `postgres/data/` | database cluster |
| `secrets.json` | generated secrets (mode 0600) |
| `runtime.json` | current ports and address |
| `settings.json` | app settings (prevent sleep, autostart initialised) |
| `logs/<service>.log` | logs per service, rotated at 5 MB (`.log.1` … `.log.3`) |
| `backups/foriq-YYYYMMDD-HHMMSS.dump` | daily database backups, newest 14 kept |
| `run/<service>.pid` | PID files for orphan cleanup |

## Secrets

`foriq-app/src/supervisor/secrets.js` generates each missing key once with
`crypto.randomBytes(32)` and never changes it afterwards:

| Key in `secrets.json` | Passed to the backend as | Used for |
|---|---|---|
| `postgresPassword` | part of `DATABASE_URL` | database user `foriq` |
| `jwtSecret` | `JWT_SECRET` | signing user JWTs (HS256) |
| `deviceTokenHmacKey` | `DEVICE_TOKEN_HMAC_KEY` | storing device tokens and activation claims as HMAC |
| `apiKeyHmacKey` | `API_KEY_HMAC_KEY` | hashing keys of the external API |
| `appKey` | `FORIQ_APP_KEY` | app-only endpoints |

The backend refuses to start without `DATABASE_URL` or with an empty `JWT_SECRET`, and
rejects a `DEVICE_TOKEN_HMAC_KEY` shorter than 32 characters (`webapp/backend/config.py`).
The app starts the backend with a minimal environment so variables from a developer
shell do not leak in.

Losing `secrets.json` invalidates all logins and all sensor tokens.

## Authentication

| Client | Mechanism |
|---|---|
| Users (web UI) | `POST /api/v1/auth/login` returns a JWT (24 h, refresh via `/api/v1/auth/refresh`), sent as `Authorization: Bearer <jwt>`. Passwords are hashed with bcrypt. |
| Sensors | `X-Device-Token` header, issued by `POST /api/v1/devices/activate` (see [device-protocol.md](device-protocol.md)). |
| Foriq app | `/api/v1/devices/app*` (USB provisioning, sensor lookup and deletion, owner password reset). Only answered for loopback clients that send the correct `X-Foriq-App-Key`; everything else gets 404 (`webapp/backend/utils/app_only.py`). |
| External systems | read-only REST API under `/api/v1/external/v1/*` with `Authorization: Bearer frq_...` API keys. Disabled by default; enabled per installation with `webapp/backend/tools/api_access.py`. |

## Users and roles

An installation has exactly one company. On first start
`GET /api/v1/auth/setup-status` reports `needs_setup: true` and the web UI shows a
registration form; `POST /api/v1/auth/register` creates the first user as **owner**
together with the company and is refused once any user exists. Further users are
created by an owner or admin in the settings.

| Role | Can |
|---|---|
| `owner` | everything; additionally change roles, manage API keys, rename or delete the company |
| `admin` | manage devices, sensor approval, commands, notification rules and users |
| `viewer` | read data |

The schema still has `companies` and `memberships` tables; all queries are scoped to the
company in the JWT.

## UI language

The user interface is German by default and English on explicit choice; the system or
browser language is ignored. The web UI stores the choice in the browser
(`localStorage`, `foriq-locale`) and is prerendered in German; the app stores it in
`settings.json` (`language`). Text the backend writes itself (default names of the
company, new sensors, the floor plan and per-machine notification rules; export labels
without a `lang` parameter) uses `DEFAULT_LANG` from
`webapp/backend/utils/default_language.py`. API errors and logs are English. Details:
[development.md](development.md#internationalisation).

## Live updates

`GET /api/v1/events/stream` is a Server-Sent Events stream authenticated with the JWT
(the web UI reads it with `fetch`, not `EventSource`, so it can send the header).
Events are scoped to the company; a keepalive comment is sent every 30 s. Event types
include `hit`, `settings_sync`, `status`, `command_status`, `config_pushed`,
`notification` and `production_updated`. The event bus is in memory, which is one
reason the backend runs with a single worker.

## Firmware updates (OTA)

Sensors update from the local backend; nothing is downloaded from the internet. The
packaged app ships `firmware.bin` for the `m5sticks3` target in
`Contents/Resources/foriq/firmware/release/<target>/` and passes that directory as
`FORIQ_FIRMWARE_DIR`. In development the backend serves
`firmware-cpp/.pio/build/<target>/firmware.bin`. Details in
[device-protocol.md](device-protocol.md#ota-updates).
