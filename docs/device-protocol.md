# Device protocol

How a sensor talks to the Foriq backend (firmware 14). The firmware is the source of
truth for the stroke count; the backend stores, aggregates and displays what the
sensor reports. Code references: `firmware-cpp/src/api_client.cpp`,
`firmware-cpp/src/device_identity.cpp`, `firmware-cpp/src/ota_updater.cpp`,
`webapp/backend/ingest.py`, `settings.py`, `devices.py`, `ota.py`.

## Transport

- Plain HTTP on the local network. The default server is `http://foriq.local:8420`.
  The firmware has no TLS and refuses `https://` and non-local hosts: only `*.local`
  names and private or link-local IPv4 addresses are accepted
  (`firmware-cpp/src/server_config.cpp`).
- The server address can be changed in the setup portal ("Server (optional)") or over
  USB by the Foriq app. A host without a scheme or
  port gets `http://` and port 8420 added.
- Authentication: header `X-Device-Token: fq_<48 hex chars>` on every request except
  activation.
- JSON for activation, settings sync, command results and OTA progress;
  `application/octet-stream` for hits and firmware files.
- The sensor never sends Wi-Fi SSIDs, Wi-Fi passwords, user or company data.

## Endpoints used by the firmware

| Method and path | Purpose |
|---|---|
| `POST /api/v1/devices/activate` | exchange serial number + setup code for a device token (no token) |
| `POST /api/v1/settings/sync` | status upstream, configuration and commands downstream |
| `POST /api/v1/ingest/hits-bin4` | detected strokes, binary v4 |
| `POST /api/v1/ingest/command-result` | result of a command |
| `GET /api/v1/ota/check?target=<target>` | firmware version and file list for a build target |
| `GET /api/v1/ota/files/firmware.bin?target=<target>` | firmware image |
| `POST /api/v1/ota/progress` | OTA progress report |

The only target is `m5sticks3`. A missing or unknown target (for example retired
hardware) is rejected with 400 and never receives an image; such devices stay in the
database but are never offered an OTA update.

## Identity and activation

Each sensor has:

- a **serial number**: a random UUID generated on first boot and kept in NVS (early
  factory-provisioned sensors keep their `FQ-C-YYWW-n` serial);
- a **setup code**: three random words joined by `-`, generated on first boot and kept
  in NVS. It is the password of the sensor's setup Wi-Fi and the proof of physical
  possession during activation. It survives a factory reset.

After joining Wi-Fi, an unactivated sensor calls activation every 10 s (up to 180
attempts, then it restarts):

```http
POST /api/v1/devices/activate
Content-Type: application/json

{"serial_number": "<uuid>", "setup_password": "<word-word-word>"}
```

Responses:

| Status | Meaning |
|---|---|
| 200 `{"device_token": "fq_..."}` | approved; the token is stored encrypted in NVS |
| 403 | unknown sensor: it is registered as **pending** and keeps polling |
| 401 | setup code does not match the stored claim |
| 410 | activation window expired |
| 429 | rate limit (20 requests per minute) |

Flow:

1. **Self-registration.** An unknown serial number is inserted into `devices` without a
   company, together with a hash of serial number + setup code.
2. **Approval.** An owner or admin approves the sensor in the web UI
   (`GET /api/v1/devices/pending`, `POST /api/v1/devices/pending/{id}/approve`) or
   rejects it (`DELETE /api/v1/devices/pending/{id}`; it reappears if it keeps
   polling). Approval opens a 7-day claim window.
3. **Token.** On the next poll the backend checks the claim and returns a token derived
   deterministically from device ID and setup code, so a lost response can be retried
   safely. With `DEVICE_TOKEN_HMAC_KEY` set (the app always sets it) only an HMAC of the
   token is stored.

Sensors set up over USB by the Foriq app skip step 2 when the installation has exactly
one company: the app registers serial number and setup code through the app-only
endpoint `POST /api/v1/devices/app/provision` and the sensor is approved immediately.

A previously activated sensor that was reset re-activates directly if its setup code
still matches the stored claim; otherwise it is shown as pending again with its
history kept.

Three consecutive 401 responses to settings sync make the firmware discard its token
(factory reset of runtime config; serial number and setup code are kept). Holding the
reset button for 3 s during boot clears Wi-Fi credentials and the token.

## Hits (binary v4)

`POST /api/v1/ingest/hits-bin4`, body = one or more 36-byte little-endian records
(Python `struct` format `<IHffHffQI`):

| Offset | Type | Field | Meaning |
|---:|---|---|---|
| 0 | `uint32` | `epoch_s` | UTC seconds |
| 4 | `uint16` | `epoch_ms` | milliseconds, 0-999 |
| 6 | `float32` | `energy` | peak boxcar energy of the stroke (see below) |
| 10 | `float32` | `gforce` | peak-to-peak acceleration in g |
| 14 | `uint16` | `duration_ms` | active duration of the stroke |
| 16 | `float32` | reserved | always `0`, ignored |
| 20 | `float32` | reserved | always `-1.0`, ignored |
| 24 | `uint64` | `boot_id` | random positive ID per boot |
| 32 | `uint32` | `event_sequence` | starts at 1 per boot, +1 per stroke |

Rules enforced by the backend:

- A body whose length is not a positive multiple of 36 is rejected with 400. Bodies over
  1 MiB get 413. An unknown or inactive token gets 401 before the body is read.
- `(device_id, boot_id, event_sequence)` is unique. A record that was already received
  is counted as a duplicate, not an error, so retries are idempotent.
- Records with non-finite or implausible values, `epoch_ms > 999`, or
  `boot_id`/`event_sequence` of 0 are skipped. In v3/v4, a reserved marker between
  -3 and -2 marks an old uncounted candidate and is skipped too.
- Timestamps older than 400 days or more than 10 minutes in the future are repaired:
  the affected records keep their relative spacing and are shifted so the newest one
  lands at arrival time (at most 24 h back).
- `energy` is stored as reported.

Response:

```json
{
  "status": "ok",
  "count": 4,
  "received": 5,
  "duplicates": 1,
  "skipped": 0,
  "repaired_timestamps": 0,
  "config": {"upload_interval_s": 0, "sleep_after_min": 10, "power_save": false},
  "server_processing_ms": 12
}
```

The firmware applies `config` the same way as the settings in a sync. Each stored hit is
broadcast to the web UI as an SSE `hit` event.

On the sensor, unsent hits are kept in RAM first and moved to the SPIFFS journal
`/spiffs/hits4.jrn` after 30 s without a successful upload or when the RAM queue runs
full; the journal survives reboots.

Older formats are still accepted for data buffered by old firmware:
`/api/v1/ingest/hits-bin3` (24-byte records, `<IHffHff`) and `/api/v1/ingest/hits-bin`
(16-byte `<IHffH` or 14-byte `<IffH` records). Firmware 14 only sends v4.

## Stroke detection (firmware)

There is exactly one counting path, `firmware-cpp/src/energy_detector.cpp`:

- Input: magnitude `g` of the accelerometer FIFO samples, processed at the native
  800 Hz rate of the BMI270 without resampling.
- `T = count_bridge_ms` is the expected stroke period (400-6000 ms, default 1500 ms).
- Boxcar energy `S = sqrt(sum((g - 1)^2))` over a causal window `w = max(20 ms, T/4)`.
- `count_sensitivity` (1000-9999, default 3594; higher counts less) maps
  logarithmically to a minimum amplitude `A_min` between 0.03 g and 0.80 g:
  `q = (count_sensitivity - 1000) / 8999`, `A_min = 0.03 * (0.80 / 0.03)^q`.
- Threshold `theta = A_min * R(T)`, where `R(T)` is the peak boxcar energy of an
  amplitude-normalised reference pulse of duration `T/3`.
- A stroke starts when `S > theta`. It is closed and counted once at least `T/2` has
  passed since its highest energy peak **and** `S` has fallen below the threshold again.
  Ringing and slow decay therefore do not count twice.
- Reported values: `gforce` = peak-to-peak acceleration, `energy` = peak boxcar energy
  scaled to the 250 Hz telemetry scale, `duration_ms` = active duration.

## Settings sync

`POST /api/v1/settings/sync`. The sensor syncs every 30 s by default; the backend can
ask for a faster cadence through `sync_interval_ms` (1 s for a short while after a
settings change and while someone has the device page open).

Upstream (firmware 14):

```json
{
  "firmware_version": "14.0.0",
  "firmware_target": "m5sticks3",
  "sleep_mode": false,
  "current_config": {
    "upload_interval_s": 0,
    "sleep_after_min": 10,
    "hit_drop_count": 0,
    "hit_spiffs_write_errors": 0,
    "hit_last_upload_ms": 85,
    "hit_max_upload_ms": 900,
    "hit_http_error_count": 0,
    "hit_queue_ram_count": 0,
    "hit_queue_flash_count": 0,
    "hit_queue_oldest_age_s": 0,
    "wifi_rssi": -61,
    "wifi_offline_s": 0,
    "wifi_reconnect_count": 0,
    "wifi_roam_count": 0
  }
}
```

The backend also accepts an optional `command_results` list
(`[{"command_id": "...", "success": true}]`); firmware 14 reports results through
`/api/v1/ingest/command-result` instead.

Downstream:

```json
{
  "settings": {
    "upload_interval_s": 0,
    "restart_schedule": {"days": [1, 3, 5], "time": "02:30"},
    "count_sensitivity": 3594,
    "count_bridge_ms": 1500,
    "sleep_after_min": 10,
    "power_save": false,
    "auto_update": true,
    "server_time_ms": 1788170400000,
    "sync_interval_ms": 30000
  },
  "commands": [
    {"id": "<uuid>", "command": "restart", "payload": {}}
  ]
}
```

| Field | Meaning |
|---|---|
| `upload_interval_s` | `0` = real time, otherwise duty-cycle interval |
| `restart_schedule` | planned restart: weekdays `1`-`7` and `HH:MM`, already converted to UTC; `null` = none |
| `count_sensitivity` | detection threshold, see above |
| `count_bridge_ms` | stroke period `T`, see above |
| `sleep_after_min` | inactivity before sleep; `0` disables sleep |
| `power_save` | power-save mode |
| `auto_update` | the backend queues OTA updates automatically (see OTA) |
| `server_time_ms` | UTC time in ms, used to set the sensor clock |
| `sync_interval_ms` | next sync interval |

Each sync is broadcast to the web UI as SSE `settings_sync` and `status` events.

## Commands

The web UI queues commands (`POST /api/v1/devices/{id}/commands/<name>`, owner or admin).
Pending commands are delivered in the next sync response and marked `delivered`. The
sensor reports the result with:

```http
POST /api/v1/ingest/command-result
{"command_id": "<uuid>", "success": true, "result": "optional text"}
```

| Command | Queued by | Firmware behaviour |
|---|---|---|
| `restart` | `commands/restart` | report result, then restart |
| `wifi_reset` | `commands/wifi-reset` | delete Wi-Fi credentials and restart into the setup portal |
| `get_setup_password` | `commands/get-setup-password` | return the setup code as `result` |
| `ota_update` | `commands/ota-update` or auto-update | run the OTA flow below |

`commands/ota-cancel` and `commands/reset-all` cancel open commands on the server side.
Status lifecycle: `pending` -> `delivered` -> `in_progress` -> `completed` or `failed`.

## OTA updates

The backend serves the firmware it finds locally: in development
`firmware-cpp/.pio/build/<target>/firmware.bin` (or `firmware-cpp/release/<target>/`),
in the app bundle the firmware shipped with the app (`FORIQ_FIRMWARE_DIR`). The version
is read from the `FORIQ_FW_VERSION=x.y.z` marker inside the binary, never from the
`VERSION` file.

1. `GET /api/v1/ota/check?target=<target>` returns
   `{"target", "version", "files": [{"filename": "firmware.bin", "checksum", "size"}]}`.
2. If the server version equals the installed one, the sensor reports
   `already_current`. A lower or invalid version is rejected (no downgrades).
3. The sensor reports `downloading`, streams
   `GET /api/v1/ota/files/firmware.bin?target=<target>` and verifies the SHA-256
   checksum, then reports `installing` and `restarting`.
4. After the reboot, the next sync with the new `firmware_version` completes the
   command on the server.

Progress reports:

```http
POST /api/v1/ota/progress
{"command_id": "<uuid>", "progress": "downloading", "percent": 40, "detail": "optional"}
```

Valid `progress` values: `downloading`, `installing`, `restarting`, `already_current`,
`completed`, `failed`. If the command was already cancelled or timed out, the response
is `{"status": "stale", "abort": true, ...}` and the sensor aborts the download.

With `auto_update` on, the backend queues `ota_update` during a sync whenever the
reported version differs from the available one. Failed attempts for the same target
version back off (2 min, 5 min, 15 min, 60 min, 1 day; only failures from the last 48 h
count). A background task marks orphaned OTA commands as failed: undelivered after 2 h,
no progress for 10 min, or 45 min while downloading.

## Firmware below 14 (`TRANSITION(fw<14)`)

Firmware 14 renamed the wire fields to English. Until every sensor runs firmware 14,
`webapp/backend/utils/legacy_protocol.py` translates; all call sites are marked
`TRANSITION(fw<14)` and will be removed together with the module.

- Upstream, `current_config` names `uebertragung_intervall_s`, `sleep_nach_min` and
  `neustart_plan` are mapped to `upload_interval_s`, `sleep_after_min` and
  `restart_schedule` (the new name wins if both are present).
- Downstream, sync and hit responses carry both the new and the old names, plus fixed
  zero values for the removed learning/calibration keys (`lernmodus`, `kalibrierung`,
  `kalibrierung_alle_events`, `kalibrierung_event_count`) so that old firmware stops
  any recording.
- Firmware below 13.25 additionally receives its old detector parameters
  (`std_window`, `sensitivity_ms`, `hysteresis_ms`, `min_peak_g`, `schlag_schwelle`);
  below 13.16 `count_sensitivity` is sent in its old -40..40 encoding.
- `POST /api/v1/ingest/learning-chunk-bin2` still exists only to read and discard
  uploads from old firmware.
