#include "ota_updater.h"
#include "config.h"
#include "server_config.h"
#include "api_client.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <Update.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <mbedtls/sha256.h>

static WiFiClient _plainClient;

static bool httpBegin(HTTPClient& http, const String& url) {
    return ServerConfig::httpBegin(http, _plainClient, url);
}

static void reportFailed(const String& commandId, const String& deviceToken,
                         const String& detail = "") {
    if (commandId.length() > 0) {
        ApiClient::reportOtaProgress(commandId, "failed", deviceToken, detail);
    }
}

static bool parseSemVer(const String& value, uint32_t parts[3]) {
    int start = 0;
    for (int i = 0; i < 3; i++) {
        int end = (i < 2) ? value.indexOf('.', start) : value.length();
        if (end <= start) return false;
        uint64_t number = 0;
        for (int pos = start; pos < end; pos++) {
            char c = value[pos];
            if (c < '0' || c > '9') return false;
            number = number * 10 + (uint32_t)(c - '0');
            if (number > UINT32_MAX) return false;
        }
        parts[i] = (uint32_t)number;
        start = end + 1;
    }
    return start == value.length() + 1;
}

// Older releases must never be installed as a downgrade. An intentional
// rollback is built from the old source with a new SemVer.
static bool isStrictlyNewerVersion(const String& candidate, const String& current) {
    uint32_t next[3], installed[3];
    if (!parseSemVer(candidate, next) || !parseSemVer(current, installed)) return false;
    for (int i = 0; i < 3; i++) {
        if (next[i] != installed[i]) return next[i] > installed[i];
    }
    return false;
}

// Diagnostic suffix for error details: without the free heap there is no way
// to tell afterwards whether the download ran out of RAM or the image did not
// fit the partition.
static String otaDiag() {
    return String(" heap=") + String((unsigned)ESP.getFreeHeap()) +
           String(" maxblk=") + String((unsigned)ESP.getMaxAllocHeap());
}

// Network errors happen on both hardware types. With a single attempt, a brief
// WiFi dropout turns straight into a server-side failure with growing backoff.
static const int OTA_HTTP_ATTEMPTS = 3;

// Full download passes (GET + stream + SHA) within ONE command. Covers the most
// common failure mode — a stream torn down by weak WiFi — without the
// complexity and brick risk of a range resume.
static const int OTA_DOWNLOAD_ATTEMPTS = 3;
// Hard limit without a SINGLE new byte. Combining readBytes() with a 60 s
// stream timeout lets one empty read block as long as the 60 s task watchdog
// and reboot the controller mid-OTA; a nominal 6 s window could then stretch
// to an hour in the worst case.
static const uint32_t OTA_STREAM_STALL_MS = 15000;
// Stay below the 60 s watchdog. The actual stall is additionally measured
// non-blocking via available() + OTA_STREAM_STALL_MS.
static const uint32_t OTA_DOWNLOAD_TIMEOUT_MS = 10000;

// GET with retries. Retries only connection errors (code < 0) and 5xx —
// a retry is pointless on 4xx (invalid token, missing file).
static int httpGetWithRetry(HTTPClient& http, const String& url,
                            const String& deviceToken, uint32_t timeoutMs) {
    int code = -1;
    for (int attempt = 0; attempt < OTA_HTTP_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            http.end();
            Serial.printf("OTA: GET failed (%d) — retry %d/%d in 2s\n",
                          code, attempt + 1, OTA_HTTP_ATTEMPTS);
            for (int i = 0; i < 4; i++) {
                esp_task_wdt_reset();
                delay(500);
            }
        }
        // After a link dropout, give the WiFi auto-reconnect a moment before
        // opening the next connection.
        uint32_t wifiWaitStarted = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - wifiWaitStarted < 10000) {
            esp_task_wdt_reset();
            delay(250);
        }
        if (!httpBegin(http, url)) {
            code = -1;
            continue;
        }
        http.addHeader("X-Device-Token", deviceToken);
        http.setTimeout(timeoutMs);
        code = http.GET();
        if (code >= 0 && code < 500) return code;
    }
    return code;
}

static bool doCheckAndUpdate(const String& deviceToken, const String& commandId) {
    // 1. Check version
    HTTPClient http;
    String url = ServerConfig::url() + "/api/v1/ota/check?target=" + String(FIRMWARE_TARGET);

    // The task WDT is 60 s with panic=true (main.cpp). The network calls below
    // can take ~90 s in the worst case — without these resets the device
    // reboots in the MIDDLE of the update and the failure looks like a
    // hardware problem. So feed it before and after every call.
    esp_task_wdt_reset();
    int code = httpGetWithRetry(http, url, deviceToken, 10000);
    esp_task_wdt_reset();
    if (code != 200) {
        Serial.printf("OTA: Check error (status %d)\n", code);
        http.end();
        reportFailed(commandId, deviceToken, String("check HTTP ") + code + otaDiag());
        return false;
    }

    String body = http.getString();
    http.end();
    esp_task_wdt_reset();

    JsonDocument doc;
    if (deserializeJson(doc, body) != DeserializationError::Ok) {
        Serial.println("OTA: JSON parse error");
        reportFailed(commandId, deviceToken, "check: JSON parse error");
        return false;
    }

    String serverVersion = doc["version"].as<String>();

    if (serverVersion == FIRMWARE_VERSION) {
        Serial.printf("OTA: Firmware up to date (v%s)\n", FIRMWARE_VERSION);
        if (commandId.length() > 0) {
            ApiClient::reportOtaProgress(commandId, "already_current", deviceToken);
        }
        return false;
    }

    if (!isStrictlyNewerVersion(serverVersion, FIRMWARE_VERSION)) {
        Serial.printf("OTA: downgrade/invalid version rejected (%s -> %s)\n",
                      FIRMWARE_VERSION, serverVersion.c_str());
        reportFailed(commandId, deviceToken, "downgrade or invalid SemVer rejected");
        return false;
    }

    Serial.printf("OTA: Update v%s -> v%s\n", FIRMWARE_VERSION, serverVersion.c_str());

    // No settingsSync() here: the call would be re-entrant
    // (sync → processCommands → ota_update → sync) and cost ~10 s of the WDT
    // budget on the critical path. The backend detects completion via
    // payload.target_version, not via an intermediate report.

    // Look for .bin file in the files list
    String binFilename;
    String expectedChecksum;
    JsonArray files = doc["files"].as<JsonArray>();
    for (JsonObject f : files) {
        String fn = f["filename"].as<String>();
        if (fn.endsWith(".bin")) {
            binFilename = fn;
            expectedChecksum = f["checksum"].as<String>();
            break;
        }
    }

    if (binFilename.length() == 0) {
        Serial.println("OTA: No .bin file found on server");
        reportFailed(commandId, deviceToken, "server provides no .bin");
        return false;
    }

    if (commandId.length() > 0) {
        // false = the command is terminal on the server (cancelled/reaped).
        if (!ApiClient::reportOtaProgress(commandId, "downloading", deviceToken)) return false;
    }
    esp_task_wdt_reset();

    // 2. Download the .bin with SHA256 verification. Several passes within the
    // same command: a torn-down stream (weak WiFi) is the most common failure
    // mode, and another attempt costs ~6 s — far cheaper than a new command
    // cycle including backoff.
    String dlUrl = ServerConfig::url() + "/api/v1/ota/files/" + binFilename + "?target=" + String(FIRMWARE_TARGET);
    uint8_t hash[32];
    bool downloadOk = false;
    bool fatal = false;              // out of space etc. — retry pointless
    String failDetail;

    for (int dlAttempt = 0; dlAttempt < OTA_DOWNLOAD_ATTEMPTS && !downloadOk && !fatal; dlAttempt++) {
        if (dlAttempt > 0) {
            Update.abort();          // reset the partition cleanly
            Serial.printf("OTA: download attempt %d/%d after error: %s\n",
                          dlAttempt + 1, OTA_DOWNLOAD_ATTEMPTS, failDetail.c_str());
            for (int i = 0; i < 4; i++) { esp_task_wdt_reset(); delay(500); }
        }

        esp_task_wdt_reset();
        code = httpGetWithRetry(http, dlUrl, deviceToken, OTA_DOWNLOAD_TIMEOUT_MS);
        esp_task_wdt_reset();
        if (code != 200) {
            failDetail = String("download HTTP ") + code + otaDiag();
            Serial.printf("OTA: Download error (status %d)\n", code);
            http.end();
            continue;
        }

        int contentLen = http.getSize();
        if (contentLen <= 0) {
            failDetail = String("content-length ") + contentLen;
            Serial.printf("OTA: Invalid content length (%d)\n", contentLen);
            http.end();
            continue;
        }

        Serial.printf("OTA: Downloading %d bytes...\n", contentLen);

        if (!Update.begin(contentLen)) {
            // Not only lack of space: Update.begin also fails if an update is
            // already running or there is no OTA partition. errorString()
            // says which.
            failDetail = String("Update.begin: ") + Update.errorString() +
                         " need=" + contentLen + otaDiag();
            Serial.printf("OTA: %s\n", failDetail.c_str());
            http.end();
            fatal = true;            // a retry would not change this
            break;
        }

        WiFiClient* stream = http.getStreamPtr();
        mbedtls_sha256_context sha256_ctx;
        mbedtls_sha256_init(&sha256_ctx);
        mbedtls_sha256_starts(&sha256_ctx, 0);

        uint8_t buf[1024];
        int remaining = contentLen;
        int lastProgress = 0;
        bool writeError = false;
        uint32_t lastByteAt = millis();

        while (remaining > 0) {
            esp_task_wdt_reset();
            int available = stream->available();
            if (available <= 0) {
                if (!stream->connected()) {
                    failDetail = String("connection lost at ") +
                                 (contentLen - remaining) + "/" + contentLen + " bytes";
                    break;
                }
                if (millis() - lastByteAt >= OTA_STREAM_STALL_MS) {
                    failDetail = String("no data for 15 s at ") +
                                 (contentLen - remaining) + "/" + contentLen + " bytes";
                    break;
                }
                delay(25);
                continue;
            }

            int toRead = (remaining > (int)sizeof(buf)) ? sizeof(buf) : remaining;
            if (toRead > available) toRead = available;
            int bytesRead = stream->read(buf, toRead);
            if (bytesRead <= 0) {
                delay(25);
                continue;
            }
            lastByteAt = millis();

            // Detect flash write errors immediately instead of only at
            // Update.end() after the full download.
            if (Update.write(buf, bytesRead) != (size_t)bytesRead) {
                failDetail = String("Update.write: ") + Update.errorString();
                writeError = true;
                break;
            }
            mbedtls_sha256_update(&sha256_ctx, buf, bytesRead);
            remaining -= bytesRead;

            int progress = ((contentLen - remaining) * 100) / contentLen;
            if (progress / 10 > lastProgress / 10) {
                Serial.printf("OTA: %d%%\n", progress);
                lastProgress = progress;
            }
        }
        http.end();
        esp_task_wdt_reset();

        mbedtls_sha256_finish(&sha256_ctx, hash);
        mbedtls_sha256_free(&sha256_ctx);

        if (writeError) {
            Serial.printf("OTA: %s\n", failDetail.c_str());
            fatal = true;            // flash defective/full — retry pointless
            break;
        }
        if (remaining > 0) {
            if (failDetail.length() == 0) {
                failDetail = String("aborted at ") + (contentLen - remaining) +
                             "/" + contentLen + " bytes";
            }
            Serial.printf("OTA: Download incomplete (%d bytes remaining)\n", remaining);
            continue;
        }

        // A checksum is mandatory — nothing is flashed without one.
        if (expectedChecksum.length() == 0) {
            failDetail = "server sent no checksum";
            Serial.println("OTA: No checksum from server - aborting (unsafe)!");
            fatal = true;
            break;
        }

        char hexHash[65];
        for (int i = 0; i < 32; i++) sprintf(hexHash + i * 2, "%02x", hash[i]);
        hexHash[64] = 0;

        if (String(hexHash) != expectedChecksum) {
            failDetail = "checksum mismatch";
            Serial.println("OTA: Checksum mismatch!");
            continue;
        }
        Serial.println("OTA: Checksum verified.");
        downloadOk = true;
    }

    if (!downloadOk) {
        Update.abort();
        reportFailed(commandId, deviceToken, failDetail);
        return false;
    }

    if (commandId.length() > 0) {
        esp_task_wdt_reset();
        if (!ApiClient::reportOtaProgress(commandId, "installing", deviceToken)) {
            // Server cancelled — discard the image instead of booting it.
            Update.abort();
            return false;
        }
        esp_task_wdt_reset();
    }

    if (Update.end(true)) {
        Serial.printf("OTA: Update to v%s successful! Restarting...\n", serverVersion.c_str());
        if (commandId.length() > 0) {
            ApiClient::reportOtaProgress(commandId, "restarting", deviceToken);
        }
        delay(1000);
        ESP.restart();
    } else {
        Serial.printf("OTA: Update failed: %s\n", Update.errorString());
        reportFailed(commandId, deviceToken, String("Update.end: ") + Update.errorString() + otaDiag());
    }

    return false;
}

bool OtaUpdater::checkAndUpdate(const String& deviceToken, const String& commandId) {
    Serial.printf("OTA: free heap before check: %u bytes\n", (unsigned)ESP.getFreeHeap());
    return doCheckAndUpdate(deviceToken, commandId);
}
