# Self-hosting on macOS

Foriq runs as a menu bar app on one Mac in the same network as the sensors. The app
bundles PostgreSQL, the backend (including Python) and the web UI.

## Requirements

- A Mac with Apple Silicon (the bundled PostgreSQL binaries are arm64 only). The Mac
  must stay on and awake while sensors are running; sensors buffer data while it is
  unreachable and send it later.
- Sensors and browsers in the same LAN, with multicast DNS (Bonjour) working, or a
  fixed IP address for the Mac (see below).

To build the app from source you also need:

- Node.js with npm
- Python 3.11 or newer for the backend build. Nothing needs to be installed into it:
  the build creates the virtualenv `foriq-app/build/venv` (`npm run setup:python`)
  with the pinned packages from `webapp/backend/requirements.txt` plus PyInstaller and
  esptool 5, downloaded from PyPI on the first build and re-used while the
  requirements are unchanged (`FORIQ_VENV` sets another location)
- [PlatformIO Core](https://platformio.org/install/cli) (`pio`) for the sensor firmware
- [Homebrew](https://brew.sh) `postgresql@18` – the build copies `pg_dump` and
  `pg_restore` from it into the app (the bundled PostgreSQL contains only the server)

## Build and install

```bash
git clone https://github.com/sschaefer-esn/foriq.git foriq
cd foriq/foriq-app
npm install
brew install postgresql@18

export FORIQ_PYTHON=$(command -v python3)          # base interpreter for build/venv, 3.11+
npm run dist
```

`npm run dist` builds the web UI, the backend (PyInstaller), the sensor firmware
(M5Stick S3) and the app, and writes `dist/Foriq-<version>-arm64.dmg` plus
`dist/mac-arm64/Foriq.app`. Install it from the Terminal:

```bash
DMG=dist/Foriq-<version>-arm64.dmg
bash scripts/install.sh "file://$PWD/$DMG" "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
```

## Installing a release via the Terminal

Foriq is installed from the Terminal rather than by downloading the DMG in a browser.
`foriq-app/scripts/install.sh` downloads the DMG of the newest
[release](https://github.com/sschaefer-esn/foriq/releases) with `curl`, checks the
SHA-256 published with it (`SHA256SUMS`), copies `Foriq.app` to `/Applications` (asking
before it replaces an existing copy) and leaves the data directory alone:

```bash
curl -fsSL https://foriq.de/install | bash
open /Applications/Foriq.app
```

A specific DMG: `FORIQ_DMG_URL=<DMG URL> FORIQ_DMG_SHA256=<sha256> bash install.sh`.
The same command updates an existing install (quit Foriq first).

**Why not notarised:** Developer ID signing and Apple's notarisation need a paid Apple
Developer account; Foriq does without. The app is signed ad hoc (required for Apple
Silicon code to run at all) and integrity is checked with the SHA-256 instead.
Gatekeeper only inspects files that carry the quarantine attribute, which browsers add
to downloads and `curl` does not – so an app installed this way starts normally.

**If you downloaded the DMG with a browser** (verified on macOS 26.4): the first start
is blocked with *“Foriq” Not Opened* – *Apple could not verify “Foriq” is free of
malware that may harm your Mac or compromise your privacy.* Click *Done*, open System
Settings › Privacy & Security, click *Open Anyway* next to *“Foriq” was blocked to
protect your Mac.* and confirm with *Open Anyway* and your password. Alternatively,
once you have checked the DMG's SHA-256, remove the attribute in the Terminal:
`xattr -dr com.apple.quarantine /Applications/Foriq.app`.

A Homebrew cask template for a personal tap is in
[foriq-app/packaging/homebrew/](../foriq-app/packaging/homebrew/README.md); Homebrew
quarantines its downloads, so the same first-start step applies there.

For details on the individual build steps see [foriq-app/README.md](../foriq-app/README.md).

## First start

1. Start Foriq. The status window shows PostgreSQL, the backend and `foriq.local`.
   On the first start the app creates its data directory, initialises the database and
   generates its secrets.
2. Open `http://foriq.local:8420` (or use *Open in browser* from the menu bar icon).
3. Register the first account. It becomes the **owner**; registration is closed after
   that, and further users are added under settings.
4. Set up sensors, see [firmware.md](firmware.md#setting-up-a-sensor).

## Running in the background

- Closing the window, Cmd+Q and *Quit* in the Dock only hide the app; the services keep
  running so sensors can send data. To stop everything use the menu bar icon's quit
  entry, log out or shut down the Mac, or run
  `/Applications/Foriq.app/Contents/MacOS/Foriq --quit`.
- **Autostart at login** is enabled on the first start of the packaged app and can be
  switched off in the status window (or in the macOS login items).
- **Prevent sleep** is on by default and can be switched off in the status window. A
  MacBook with the lid closed still sleeps. After waking up, Foriq checks the network
  right away and re-registers `foriq.local` if the IP address changed.

## Firewall

The backend listens on port 8420 on all interfaces. If the macOS firewall is enabled it
may block incoming connections to the unsigned app; Foriq then works only on the Mac
itself, and the status window reports that it is reachable only locally. Allow Foriq in
System Settings › Network › Firewall › Options.

## `foriq.local`

The app publishes `foriq.local` via `dns-sd` with the Mac's current LAN IP and
re-registers it when the IP changes. New sensors use `http://foriq.local:8420` by default.

If `foriq.local` does not resolve (networks that block multicast, guest or client
isolation, VLANs):

- open the web UI via the Mac's IP address: `http://<mac-ip>:8420`;
- give the Mac a fixed IP address (DHCP reservation in the router);
- enter that address in the sensor's setup portal under "Server (optional)", or in the
  advanced options of the USB setup in the app. A plain IP is enough; `http://` and
  port 8420 are added automatically. Sensors only accept `*.local` names and private
  or link-local IPv4 addresses over plain HTTP.

On the Mac itself, resolving `foriq.local` can occasionally fail for a moment; use
`http://localhost:8420` there.

## Updating

There is no automatic update. Quit Foriq completely (menu bar icon › Quit), then run
`install.sh` again with the new release's URL and SHA-256 (or with a DMG you built as
above); it asks before replacing the installed app. The database and secrets in the data directory are kept; the schema
is migrated automatically on start (`webapp/sql/schema.sql` is applied on every start).

On the build Mac, `npm run release:local` in `foriq-app/` does all of this in one go:
it builds everything, quits the running app, replaces `/Applications/Foriq.app`,
starts it and checks that `/health` answers on localhost and on the LAN IP.

The app ships the matching sensor firmware. Sensors with auto-update enabled install it
at their next sync; others can be updated from the device page.

## Data and logs

| Path (under `~/Library/Application Support/Foriq/`) | Content |
|---|---|
| `postgres/data/` | database |
| `secrets.json` | database password and keys; keep it with the database. **Never delete or edit it**: a new key locks out every paired sensor |
| `backups/` | daily database backups, see below |
| `logs/postgres.log`, `logs/backend.log`, `logs/mdns.log` | logs, rotated at 5 MB (3 old generations) |
| `runtime.json`, `settings.json`, `run/` | runtime state and app settings |

The logs can also be opened from the menu bar icon.

## Backups

Foriq backs up the database once a day with `pg_dump` into
`~/Library/Application Support/Foriq/backups/foriq-YYYYMMDD-HHMMSS.dump` (compressed
custom format, readable only by your user) and keeps the newest 14. The first backup
runs about a minute after start if the newest one is older than a day. The status
window shows the time of the last backup; *Back up now* makes one immediately and
*Show* opens the folder in Finder. If a backup fails, the light turns yellow and the
reason is shown (details in `logs/postgres.log`); the services keep running and the
backup is retried an hour later.

The backups live on the same disk as the database. Copy the `backups/` folder **and
`secrets.json`** somewhere else regularly (Time Machine does this if it includes your
Library). A restored database only works with the `secrets.json` it belongs to: without
it, sensors and users cannot sign in.

### Restoring a backup

Restoring replaces the whole database with the state of the backup; strokes received
after that backup are lost. Sensors buffer during the few minutes Foriq is down.

1. Quit Foriq completely: menu bar icon › *Quit Foriq …*.
2. In Terminal, start the bundled PostgreSQL on its own, restore, stop it again
   (replace the file name with the backup you want):

   ```bash
   BIN=/Applications/Foriq.app/Contents/Resources/app/node_modules/@embedded-postgres/darwin-arm64/native/bin
   DATA="$HOME/Library/Application Support/Foriq"
   FILE="$DATA/backups/foriq-20261113-030000.dump"
   export PGPASSWORD=$(plutil -extract postgresPassword raw "$DATA/secrets.json")

   "$BIN/pg_ctl" -D "$DATA/postgres/data" -l "$DATA/logs/restore.log" -w start \
     -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories="
   "$BIN/pg_restore" --host=127.0.0.1 --port=54329 --username=foriq \
     --dbname=postgres --clean --create "$FILE"
   "$BIN/pg_ctl" -D "$DATA/postgres/data" -w -m fast stop
   unset PGPASSWORD
   ```

   `--clean --create` drops the `foriq` database and recreates it from the backup.
   `pg_restore --list "$FILE"` shows what a backup contains without changing anything.
3. Start Foriq again. It applies `schema.sql` on start, so a backup from an older
   version is migrated automatically.

On a new Mac (or after losing the data directory), put the saved `secrets.json` into
`~/Library/Application Support/Foriq/` **before** the first start, start and quit Foriq
once (it creates the database with that password), then restore as above. To simply
move an intact installation, quit Foriq and copy the whole data directory instead.

## Security

Foriq is designed for a trusted local network: sensors and browsers use plain HTTP.
Do not expose port 8420 to the internet. See [SECURITY.md](../SECURITY.md).
