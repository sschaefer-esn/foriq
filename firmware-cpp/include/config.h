#pragma once

// ─── Firmware ────────────────────────────────────────────────
// FIRMWARE_VERSION is injected from VERSION file via read_version.py
#ifndef FIRMWARE_TARGET
#define FIRMWARE_TARGET "unknown"
#endif

// Debug diagnostics (DBG printf, sample jitter, etc.) — 0 in production. For a
// local debug build, append -DFORIQ_DEBUG=1 to build_flags (platformio.ini).
#ifndef FORIQ_DEBUG
#define FORIQ_DEBUG 0
#endif

// ─── Server ──────────────────────────────────────────────────
// The address comes from ServerConfig at runtime (NVS, setup portal, USB).
// Default for devices without a stored address: the local Foriq app.
// Plain HTTP on the local network only (no TLS in the firmware).
#define FORIQ_LOCAL_PORT "8420"   // fixed port of the Foriq app (browser + sensors)
#define FORIQ_LOCAL_URL "http://foriq.local:" FORIQ_LOCAL_PORT

// ─── Board: M5Stick S3 ──────────────────────────────────────
// ESP32-S3-PICO-1 + BMI270 + M5PM1 (proprietary power chip).
// I2C on GPIO 47/48, buttons KEY1/KEY2 = 11/12.
// The stick has a built-in battery, but the firmware does not use it
// (devices are mains-powered).
#define BMI270_ADDR      0x68
#define ACCEL_SCALE      2048.0f       // 16-bit / ±16 g
#define PIN_SDA          47            // M5 StickS3 internal I2C: SDA=GPIO47
#define PIN_SCL          48            // M5 StickS3 internal I2C: SCL=GPIO48
#define PIN_BACKLIGHT    38
// No reset button handling: when the stick is built in or potted, KEY1
// (GPIO11) is held down permanently by the enclosure, and a boot-time
// button reset would wipe WiFi + token on every boot → boot loop. WiFi is
// reset only via the wifi_reset remote command or the factory-reset option
// of the setup portal.
// The display stays off permanently: the S3 ships built in/potted, so the
// panel is never visible. The backlight is therefore never switched on.

// ─── Timing ─────────────────────────────────────────────────
#define SETTINGS_SYNC_MS       30000UL
#define RECONNECT_INTERVAL_MS  3000UL
#define NTP_RESYNC_MS      21600000UL   // 6 hours
#define ACTIVATE_INTERVAL_MS  10000UL
#define MAX_ACTIVATE_ATTEMPTS   180
#define RESTART_CHECK_MS      60000UL

// ─── Hit Buffer ─────────────────────────────────────────────
#define BUFFER_FLUSH_THRESHOLD 100   // early flush before overflow
#define HIT_BATCH_DELAY_MS  1000UL   // small intentional latency in exchange for fewer HTTP requests
#define HIT_BATCH_WEAK_DELAY_MS 8000UL // weak WiFi: larger batches, less HTTP overhead
#define HIT_BATCH_WEAK_COUNT      32
#define HIT_FLASH_DELAY_MS     30000UL // buffer short outages in RAM first to avoid flash wear
#define HIT_RETRY_MAX_MS       60000UL

// ─── Sleep / Power ──────────────────────────────────────────
// Kept for power-bank operation (no internal battery module any more, but
// power saving still pays off on a USB power bank).
#define POLL_SLEEP_MS            50
#define WAKE_MOTION_DELTA_SQ 0.000225f // (0.015 g)^2; power wake only
#define SLEEP_MODE_INFO_CYCLE_MS 900000UL  // 15 min
#define SLEEP_CPU_MHZ           80
#define ACTIVE_CPU_MHZ         240

// ─── Polling ────────────────────────────────────────────────
// The IMU samples internally at 800 Hz. The loop drains the FIFO and
// passes every sample to the energy detector. A delay() after the work would
// artificially stretch the target period.
#define POLL_ACTIVE_MS    2
// 384 > 2048 B / 6 B = 341 BMI270 samples: even a full S3 FIFO can be
// drained in a single pass without truncation.
#define FIFO_DRAIN_SAMPLES 384
// Pin the I2C timeout explicitly (currently also the Arduino-ESP32 default).
// Equally important: never treat a failed read as a measurement.
#define I2C_TIMEOUT_MS   50
#define SENSOR_RECOVERY_RETRY_MS 250UL
#define SENSOR_RESTART_AFTER_MS 60000UL

// ─── WiFi ───────────────────────────────────────────────────
#define MAX_WIFI_DOWN_MS    300000UL    // 5 min → restart
#define AP_SSID             "Foriq-Setup"
#define AP_IP_STR           "192.168.4.1"
#define CONNECT_TIMEOUT_S     20
#define MAX_RETRIES            3
#define WIFI_RSSI_WEAK_DBM       -72
#define WIFI_RSSI_GOOD_DBM       -65
#define WIFI_RSSI_PS_RESTORE_MS 10000UL
#define WIFI_ROAM_RSSI_DBM        -78
#define WIFI_ROAM_HOLD_MS       30000UL
#define WIFI_ROAM_SCAN_INTERVAL_MS 300000UL
#define WIFI_ROAM_MIN_GAIN_DB       8

// ─── Recovery portal for activated devices ──────────────────
// WiFi is managed locally only (portal/USB): if an activated device can no
// longer join its WiFi (SSID changed etc.), it opens its setup portal
// NON-destructively — token/config are kept, the background reconnect keeps
// running and closes the portal by itself as soon as the old network is back.
// In the portal: store a new WiFi network OR do a confirmed factory reset.
#define PORTAL_AFTER_DOWN_MS       120000UL // runtime: 2 min without WiFi → open portal
#define PORTAL_RUNTIME_TIMEOUT_MS  600000UL // portal window; then a fresh reconnect cycle
#define PORTAL_CYCLES_BEFORE_RESTART  3     // after N unsuccessful portal cycles: restart (radio hygiene)
// Boot path: failed WiFi starts before the setup portal opens (again).
#define PORTAL_RECOVERY_FAILS           8   // never-activated devices (first-time setup)
#define PORTAL_RECOVERY_FAILS_ACTIVATED 3   // activated devices (non-destructive portal)

// WiFi.status() reports WL_CONNECTED, but settingsSync() keeps failing
// (server down, routing/DNS problem, association without a route) — the WiFi
// reconnect in networkTask does NOT catch this, because its trigger depends
// only on the WiFi link. If the sync keeps failing for this long, networkTask
// forces a WiFi.disconnect(); the existing phased reconnect (+ ESP.restart()
// after another MAX_WIFI_DOWN_MS) takes over from there.
#define MAX_SERVER_DOWN_MS  300000UL    // 5 min without a successful sync despite a WiFi link

// ─── Recovery / Auth ────────────────────────────────────────
#define FACTORY_RESET_AFTER_401  3
