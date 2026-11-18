#include "api_client.h"
#include "config.h"
#include "server_config.h"
#include "device_identity.h"
#include "wifi_manager.h"
#include "commands.h"
#include "scheduler.h"
#include "time_sync.h"
#include "hit_buffer.h"
#include "power_manager.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_task_wdt.h>

// Plain HTTP to the local Foriq app (server address set at runtime, see
// server_config.h). One shared client keeps the connection alive for hit uploads.
static WiFiClient _plainClient;

static const int HTTP_TIMEOUT_MS = 5000;

static bool httpBegin(HTTPClient& http, const String& url) {
    return ServerConfig::httpBegin(http, _plainClient, url);
}

static int     _consecutive401s = 0;
static uint8_t _hitFailureStreak = 0;
static uint32_t _hitRetryAtMs = 0;
static uint32_t _hitLastUploadMs = 0;
static uint32_t _hitLastSuccessAtMs = 0;
static uint32_t _hitMaxUploadMs = 0;
static uint32_t _hitHttpErrorCount = 0;

static void resetHitBackoff() {
    _hitFailureStreak = 0;
    _hitRetryAtMs = 0;
}

static void scheduleHitBackoff(int code) {
    if (_hitFailureStreak < 8) _hitFailureStreak++;
    uint32_t baseMs = code == 429 ? 5000UL : 1000UL;
    uint32_t delayMs = baseMs << min((int)_hitFailureStreak - 1, 6);
    if (delayMs > HIT_RETRY_MAX_MS) delayMs = HIT_RETRY_MAX_MS;
    // Jitter so that several controllers do not hit the access point and the
    // backend in lockstep after a shop-floor WiFi outage.
    uint32_t jitterMax = delayMs / 4;
    uint32_t jitterMs = jitterMax > 0 ? esp_random() % (jitterMax + 1) : 0;
    delayMs = min((uint32_t)HIT_RETRY_MAX_MS, delayMs + jitterMs);
    _hitRetryAtMs = millis() + delayMs;
    Serial.printf("Hits: retry in %lums (failure streak %u, HTTP %d)\n",
                  (unsigned long)delayMs, (unsigned)_hitFailureStreak, code);
}

bool ApiClient::hitUploadReady() {
    return _hitRetryAtMs == 0 || (int32_t)(millis() - _hitRetryAtMs) >= 0;
}

uint32_t ApiClient::hitUploadRetryInMs() {
    if (hitUploadReady()) return 0;
    return _hitRetryAtMs - millis();
}

uint32_t ApiClient::getHitLastUploadMs() { return _hitLastUploadMs; }
uint32_t ApiClient::getHitLastSuccessMs() { return _hitLastSuccessAtMs; }
uint32_t ApiClient::getHitMaxUploadMs() { return _hitMaxUploadMs; }
uint32_t ApiClient::getHitHttpErrorCount() { return _hitHttpErrorCount; }

// Forward declarations for config update
extern volatile int   configUploadIntervalS;
extern volatile int   configSleepAfterMin;
extern volatile uint32_t configSyncIntervalMs;
extern volatile bool     inSleepMode;

extern volatile bool  configPowerSave;       // power-save master switch
extern volatile uint32_t hitQueueStagedCount;
extern volatile uint32_t hitQueueStagedOldestEpochS;
extern volatile uint32_t wifiOfflineS;

extern volatile int configCountSensitivity;
extern volatile int configCountBridgeMs;

static void updateConfig(JsonObject config);
static void processCommands(JsonArray commands, const String& deviceToken);

int ApiClient::getConsecutive401s() { return _consecutive401s; }
void ApiClient::resetConsecutive401s() { _consecutive401s = 0; }

// ─── Settings Sync (bidirectional) ──────────────────────────

bool ApiClient::settingsSync(const String& deviceToken) {
    HTTPClient http;
    String url = ServerConfig::url() + "/api/v1/settings/sync";
    if (!httpBegin(http, url)) return false;
    http.setReuse(true);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Token", deviceToken);
    http.setTimeout(HTTP_TIMEOUT_MS);

    JsonDocument doc;

    // Upstream: device status
    doc["firmware_version"] = FIRMWARE_VERSION;
    doc["firmware_target"] = FIRMWARE_TARGET;
    doc["sleep_mode"] = inSleepMode;

    // Current config (for frontend breadcrumb resolution)
    JsonObject cc = doc["current_config"].to<JsonObject>();
    cc["upload_interval_s"] = configUploadIntervalS;
    cc["sleep_after_min"] = configSleepAfterMin;
    // Diagnostics: make silently dropped/lost hits visible.
    // Monotonic and persisted in NVS — the backend stores the values per device.
    HitBuffer::persistDiagnostics();
    cc["hit_drop_count"] = HitBuffer::getDropCount();
    cc["hit_spiffs_write_errors"] = HitBuffer::getSpiffsWriteErrorCount();
    cc["hit_last_upload_ms"] = ApiClient::getHitLastUploadMs();
    cc["hit_max_upload_ms"] = ApiClient::getHitMaxUploadMs();
    cc["hit_http_error_count"] = ApiClient::getHitHttpErrorCount();
    cc["hit_queue_ram_count"] = HitBuffer::ramCount() + hitQueueStagedCount;
    cc["hit_queue_flash_count"] = HitBuffer::fileRecordCount();
    uint32_t oldestEpoch = HitBuffer::oldestPendingEpochS();
    uint32_t stagedEpoch = hitQueueStagedOldestEpochS;
    if (stagedEpoch != 0 && (oldestEpoch == 0 || stagedEpoch < oldestEpoch)) {
        oldestEpoch = stagedEpoch;
    }
    uint32_t currentEpoch = TimeSync::ticksToEpoch(millis());
    cc["hit_queue_oldest_age_s"] = oldestEpoch != 0 && currentEpoch >= oldestEpoch
        ? currentEpoch - oldestEpoch : 0;
    cc["wifi_offline_s"] = wifiOfflineS;
    cc["wifi_reconnect_count"] = WifiManager::getReconnectCount();
    cc["wifi_roam_count"] = WifiManager::getRoamCount();
    if (WifiManager::isConnected()) cc["wifi_rssi"] = WifiManager::getRSSI();
    String payload;
    serializeJson(doc, payload);
    Serial.println("[sync] UPSTREAM");

    int code = http.POST(payload);
    if (code == 200) {
        String body = http.getString();
        Serial.println("[sync] DOWNSTREAM ok");
        http.end();
        JsonDocument resp;
        if (deserializeJson(resp, body) == DeserializationError::Ok) {
            if (resp["settings"].is<JsonObject>()) {
                updateConfig(resp["settings"].as<JsonObject>());
            }
            if (resp["commands"].is<JsonArray>()) {
                processCommands(resp["commands"].as<JsonArray>(), deviceToken);
            }
        }
        _consecutive401s = 0;
        return true;
    } else if (code == 401) {
        _consecutive401s++;
        Serial.printf("401 on settings_sync (%d/%d)\n", _consecutive401s, FACTORY_RESET_AFTER_401);
        if (_consecutive401s >= FACTORY_RESET_AFTER_401) {
            DeviceIdentity::factoryReset();
        }
    } else {
        Serial.printf("HTTP error on settings_sync: %d\n", code);
    }
    http.end();
    return false;
}

// ─── Send Hits Binary (SPIFFS -> backend) ──────────────────

static String sendHitsBinaryToEndpoint(const uint8_t* data, int bytes,
                                       const String& deviceToken, const char* endpoint) {
    static HTTPClient http;
    String url = ServerConfig::url() + endpoint;
    if (!ApiClient::hitUploadReady()) return "backoff";
    if (!httpBegin(http, url)) {
        _hitHttpErrorCount++;
        scheduleHitBackoff(-1);
        return "error";
    }
    http.setReuse(true);
    http.addHeader("Content-Type", "application/octet-stream");
    http.addHeader("X-Device-Token", deviceToken);
    http.setTimeout(HTTP_TIMEOUT_MS);

    uint32_t requestStarted = millis();
    int code = http.POST((uint8_t*)data, bytes);
    _hitLastUploadMs = millis() - requestStarted;
    if (_hitLastUploadMs > _hitMaxUploadMs) _hitMaxUploadMs = _hitLastUploadMs;
    if (code == 200) {
        String body = http.getString();
        http.end();
        JsonDocument resp;
        if (deserializeJson(resp, body) == DeserializationError::Ok) {
            if (resp["config"].is<JsonObject>()) {
                updateConfig(resp["config"].as<JsonObject>());
            }
            int skipped = resp["skipped"] | 0;
            int repaired = resp["repaired_timestamps"] | 0;
            if (skipped > 0) {
                Serial.printf("Hits: backend rejected %d records as invalid\n", skipped);
            }
            if (repaired > 0) {
                Serial.printf("Hits: backend rebased %d timestamps to arrival time\n",
                              repaired);
            }
            int serverMs = resp["server_processing_ms"] | 0;
            if (_hitLastUploadMs >= 1000 || serverMs >= 500) {
                Serial.printf("Hits: upload took %lums (backend %dms, %d bytes)\n",
                              (unsigned long)_hitLastUploadMs, serverMs, bytes);
            }
        }
        _hitLastSuccessAtMs = millis();
        resetHitBackoff();
        _consecutive401s = 0;
        return "ok";
    } else if (code == 401) {
        http.end();
        _hitHttpErrorCount++;
        _consecutive401s++;
        Serial.printf("401 on hits-bin (%d/%d)\n", _consecutive401s, FACTORY_RESET_AFTER_401);
        if (_consecutive401s >= FACTORY_RESET_AFTER_401) {
            DeviceIdentity::factoryReset();
        }
        return "reactivate";
    }
    http.end();
    _hitHttpErrorCount++;
    Serial.printf("HTTP error on hits-bin: %d\n", code);
    scheduleHitBackoff(code);
    return "error";
}

String ApiClient::sendHitsBinary(const uint8_t* data, int bytes, const String& deviceToken) {
    // v4: 36-byte records with a stable (boot_id, event_sequence) identity, so
    // the server can accept a re-sent HTTP batch idempotently.
    return sendHitsBinaryToEndpoint(data, bytes, deviceToken, "/api/v1/ingest/hits-bin4");
}

// ─── Report Command Result ──────────────────────────────────

void ApiClient::reportCommandResult(const String& commandId, bool success,
                                     const String& deviceToken, const String& result) {
    if (commandId.length() == 0) return;
    HTTPClient http;
    String url = ServerConfig::url() + "/api/v1/ingest/command-result";
    if (!httpBegin(http, url)) return;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Token", deviceToken);
    http.setTimeout(HTTP_TIMEOUT_MS);

    JsonDocument doc;
    doc["command_id"] = commandId;
    doc["success"] = success;
    if (result.length() > 0) doc["result"] = result;
    String payload;
    serializeJson(doc, payload);

    http.POST(payload);
    http.end();
}

// ─── OTA Progress ───────────────────────────────────────────

bool ApiClient::reportOtaProgress(const String& commandId, const String& progress,
                                   const String& deviceToken, const String& detail) {
    JsonDocument doc;
    doc["command_id"] = commandId;
    doc["progress"] = progress;
    if (detail.length() > 0) doc["detail"] = detail;
    String payload;
    serializeJson(doc, payload);

    // Up to 3 attempts: if the 'failed' report itself is lost (which happens
    // exactly when the network is struggling), the update hangs in the backend
    // until the reaper timeout instead of going straight into the short retry
    // backoff. The WDT is fed along the way.
    bool active = true;
    for (int attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
            esp_task_wdt_reset();
            delay(500);
            esp_task_wdt_reset();
        }
        HTTPClient http;
        String url = ServerConfig::url() + "/api/v1/ota/progress";
        if (!httpBegin(http, url)) return false;
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-Device-Token", deviceToken);
        http.setTimeout(HTTP_TIMEOUT_MS);

        int code = http.POST(payload);
        if (code == 200) {
            // {"abort": true} = the command is terminal on the server (cancelled
            // by the user or reaped) → do not continue.
            String body = http.getString();
            JsonDocument resp;
            if (deserializeJson(resp, body) == DeserializationError::Ok &&
                resp["abort"].as<bool>()) {
                Serial.println("OTA: server requested abort — stopping update");
                active = false;
            }
            http.end();
            return active;
        }
        Serial.printf("OTA: progress report '%s' failed (HTTP %d)\n",
                      progress.c_str(), code);
        http.end();
    }
    return active;
}

// ─── Config Update ──────────────────────────────────────────

static void updateConfig(JsonObject config) {
    if (config["server_time_ms"].is<uint64_t>()) {
        uint64_t serverTimeMs = config["server_time_ms"].as<uint64_t>();
        TimeSync::calibrateFromServer(serverTimeMs);
    }
    if (config["upload_interval_s"].is<int>()) {
        configUploadIntervalS = config["upload_interval_s"].as<int>();
    }
    if (config["power_save"].is<bool>()) {
        bool newVal = config["power_save"].as<bool>();
        if (newVal != configPowerSave) {
            Serial.printf("Config: power_save %d -> %d\n", (int)configPowerSave, (int)newVal);
            configPowerSave = newVal;
            PowerManager::applyPowerSaveMode(newVal);
        }
    }
    if (config["restart_schedule"].is<JsonObject>()) {
        Scheduler::updatePlan(config["restart_schedule"].as<JsonObject>());
    }
    if (config["sleep_after_min"].is<int>()) {
        int newVal = config["sleep_after_min"].as<int>();
        if (newVal != configSleepAfterMin) {
            Serial.printf("Config: sleep_after_min %d -> %d\n", configSleepAfterMin, newVal);
            configSleepAfterMin = newVal;
        }
    }
    if (config["sync_interval_ms"].is<int>()) {
        uint32_t newVal = config["sync_interval_ms"].as<int>();
        if (newVal != configSyncIntervalMs) {
            Serial.printf("Config: sync_interval_ms %lu -> %lu\n", configSyncIntervalMs, (unsigned long)newVal);
            configSyncIntervalMs = newVal;
        }
    }
    if (config["count_sensitivity"].is<int>()) {
        int newVal = constrain(config["count_sensitivity"].as<int>(), 1000, 9999);
        if (newVal != configCountSensitivity) {
            Serial.printf("Config: count_sensitivity %d -> %d\n", configCountSensitivity, newVal);
            configCountSensitivity = newVal;
        }
    }
    if (!config["count_bridge_ms"].isNull()) {
        int newVal = constrain(config["count_bridge_ms"].as<int>(), 400, 6000);
        if (newVal != configCountBridgeMs) {
            Serial.printf("Config: count_bridge_ms %d -> %d\n", configCountBridgeMs, newVal);
            configCountBridgeMs = newVal;
        }
    }
}

static void processCommands(JsonArray commands, const String& deviceToken) {
    for (JsonObject cmd : commands) {
        Commands::processCommand(cmd, deviceToken);
    }
}
