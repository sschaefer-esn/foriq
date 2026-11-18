# Development

## Components

| Directory | Stack | README |
|---|---|---|
| `webapp/backend/` | Python 3.11+, FastAPI, SQLAlchemy (`text()` queries), psycopg2 | [webapp/backend/README.md](../webapp/backend/README.md) |
| `webapp/frontend/` | Next.js 16 (App Router, static export), React 19, JavaScript, Tailwind CSS 4, shadcn/ui, Recharts | [webapp/frontend/README.md](../webapp/frontend/README.md) |
| `webapp/sql/schema.sql` | PostgreSQL schema (idempotent) | — |
| `foriq-app/` | Electron app: supervisor, status window, USB setup | [foriq-app/README.md](../foriq-app/README.md) |
| `firmware-cpp/` | C++/Arduino, PlatformIO | [firmware-cpp/README.md](../firmware-cpp/README.md), [docs/firmware.md](firmware.md) |

## Running the stack for development

All commands (app, backend, frontend, tests, firmware, dependency updates) are in the
[README's Commands section](../README.md#commands); this page explains how they fit
together.

Option A, the app from source (`npm start` in `foriq-app/`): runs PostgreSQL, the
backend from `webapp/backend` and serves the last static frontend build
(`npm run build:frontend`). `npm run setup:python` (`scripts/setup-python.sh`) creates
the virtualenv `foriq-app/build/venv` from `FORIQ_PYTHON` (default `python3`, 3.11+)
with the backend requirements plus PyInstaller and esptool 5; it re-installs only when
`requirements.txt`, the build tools or the base interpreter changed, and `FORIQ_VENV`
sets another location. The supervisor and the USB helper use the venv's interpreter
when it exists, otherwise `FORIQ_PYTHON` (which then needs the requirements itself).
`npm run build:backend` runs the same setup before PyInstaller.

Option B, backend and web UI with hot reload: `./dev.sh` in the repository root starts
the backend on port 8005 (Python from `webapp/backend/.venv`, `webapp/backend/venv` or
`foriq-app/build/venv`, else `python3`; configuration from `webapp/.env`; apply
`schema.sql` yourself) and `npm run dev` in `webapp/frontend` on port 3000, which
proxies `/api/*` to it; Ctrl+C stops both. `./dev.sh app` uses the database of the Foriq
app running on this Mac instead (connection and keys from its `secrets.json`, background
workers off via `FORIQ_NO_WORKERS=1`); the app's schema is already applied. Ports:
`FORIQ_DEV_BACKEND_PORT`, `FORIQ_DEV_FRONTEND_PORT`. Started by hand,
`FORIQ_DEV_BACKEND` points the dev server at another backend. Without
`FORIQ_FRONTEND_DIR` the backend serves only the API.

To exercise the device API without hardware, `npm run sim` in `foriq-app/` runs
`scripts/sensor_sim.py`: it registers a simulated sensor against the running app,
approves it and sends `hits-bin4` records.

Publishing (`./ship.sh`) and releases of the Mac app: [releasing.md](releasing.md).
`./cleanup.sh` lists empty folders, caches and (with `--builds`) build outputs and
removes them with `--yes`.

## Tests

- Backend: `requirements-dev.txt` adds `httpx2` for `starlette.testclient`.
  `config.py` needs `DATABASE_URL` and `JWT_SECRET` even for unit tests (the database
  is not used by them).
- Integration tests (`*_integration.py`, `test_core_ingest_activation.py`,
  `test_device_protocol_transition.py` and others guarded by `FORIQ_INTEGRATION_DB=1`)
  write to the database in `DATABASE_URL`. It must be a disposable UTF-8 database with
  the current `schema.sql`, never a real install; the README shows how to create one
  with the bundled PostgreSQL. The tests do not depend on `DEVICE_TOKEN_HMAC_KEY` or
  other optional keys in the environment; tests that need a key patch it themselves.
- Frontend: `npm test` runs `node --test tests/*.test.mjs`.
- Firmware: `pio run -e m5sticks3` and the host-side detector test in
  [firmware.md](firmware.md#unit-test).

## Database schema

`webapp/sql/schema.sql` is the only migration mechanism. The app applies it on **every**
start, so it must run any number of times against an existing database without errors
or data loss:

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`;
- new columns and other changes inside `DO $$ ... IF NOT EXISTS ... END $$` blocks;
- never `DROP` or `TRUNCATE` without `IF EXISTS` and a guard.

```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'example'
    ) THEN
        ALTER TABLE devices ADD COLUMN example INTEGER DEFAULT 0;
    END IF;
END $$;
```

With the app, a schema change takes effect on the next start. A manually run backend
needs `psql "$DATABASE_URL" -f webapp/sql/schema.sql`.

## Internationalisation

All code, comments, logs and API error messages are in English. User-facing text is
translated with small dictionaries. The product currently targets the German market, so
**German is the default UI language** everywhere; English is available as an explicit
choice. The system or browser language is not used. Where the default lives:

- web UI: `DEFAULT_LOCALE` in `webapp/frontend/src/lib/i18n/defaultLocale.js`; the
  choice is stored in `localStorage` (`foriq-locale`). The static export is prerendered
  in the default language, so `<html lang>` in `src/app/layout.js`, `manifest.js` and
  the page `metadata` titles must match it;
- Electron app: `DEFAULT_LOCALE` in `foriq-app/src/i18n.js`; the choice is stored as
  `language` in `settings.json` (`null` = never chosen = default). The static text in
  `src/ui/index.html` carries the default language so nothing flashes before the
  strings arrive;
- backend: `DEFAULT_LANG` in `webapp/backend/utils/default_language.py` for text the
  backend writes itself (default names such as "Meine Firma", "Neuer Sensor …",
  "Halle 1", "… – Stillstand", and the labels of exported files when no `lang` is
  given). API error `detail` strings stay English; the web UI translates them;
- sensor setup portal: embedded in `firmware-cpp/include/captive_portal_html.h`; it
  follows the browser language (German for German browsers, English otherwise).

Lookup falls back chosen locale → default → English → key. Switching the product
default to English means changing these three constants and the prerendered markup
listed above (`npm test` in `webapp/frontend/` and `foriq-app/` checks it).

See the area READMEs for how to add keys.

## Conventions

- Frontend and app: JavaScript only, no TypeScript.
- Backend: SQLAlchemy Core with `text()` queries and bound parameters; no ORM models.
- English only in code, comments, commit messages and documentation.
- Keep the existing style; prefer small, focused changes over refactorings.
- Formatting basics are in [.editorconfig](../.editorconfig): 4 spaces for Python, C++
  and SQL, 2 spaces for JavaScript, JSON, CSS and shell, LF line endings.
- Firmware changes bump `firmware-cpp/VERSION` (see [firmware.md](firmware.md#versioning)).
- Protocol compatibility code for old firmware is marked `TRANSITION(fw<14)`.
