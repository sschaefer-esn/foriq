#include "device_identity.h"
#include "config.h"
#include "server_config.h"
#include "wifi_manager.h"
#include "secret_store.h"
#include <Preferences.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <SPIFFS.h>

static WiFiClient _plainClient;

static Preferences prefs;

static String generateUUID() {
    uint8_t b[16];
    for (int i = 0; i < 16; i += 4) {
        uint32_t r = esp_random();
        memcpy(b + i, &r, 4);
    }
    b[6] = (b[6] & 0x0F) | 0x40; // Version 4
    b[8] = (b[8] & 0x3F) | 0x80; // Variant 1

    char hex[33];
    for (int i = 0; i < 16; i++) {
        sprintf(hex + i * 2, "%02x", b[i]);
    }
    char uuid[37];
    snprintf(uuid, sizeof(uuid), "%.8s-%.4s-%.4s-%.4s-%.12s",
             hex, hex + 8, hex + 12, hex + 16, hex + 20);
    return String(uuid);
}

String DeviceIdentity::getOrCreateDeviceId() {
    prefs.begin("foriq", false);
    String id = prefs.getString("device_id", "");
    if (id.length() == 0) {
        id = generateUUID();
        Serial.printf("New Device-ID generated: %s\n", id.c_str());
        prefs.putString("device_id", id);
    }
    prefs.end();
    return id;
}

String DeviceIdentity::loadDeviceToken() {
    prefs.begin("foriq", true);
    String stored = prefs.getString("device_token", "");
    prefs.end();

    String token = SecretStore::decrypt(stored);

    // One-time migration of a legacy plaintext token to encrypted storage.
    if (!SecretStore::isEncrypted(stored) && token.length() > 0) {
        saveDeviceToken(token);
        Serial.println("Device token migrated to encrypted storage.");
    }
    return token;
}

void DeviceIdentity::saveDeviceToken(const String& token) {
    prefs.begin("foriq", false);
    prefs.putString("device_token", SecretStore::encrypt(token));
    prefs.end();
    Serial.println("Device token saved.");
}

String DeviceIdentity::activateDevice(const String& deviceId) {
    Serial.printf("Waiting for activation (serial: %s)...\n", deviceId.c_str());

    for (int attempt = 0; attempt < MAX_ACTIVATE_ATTEMPTS; attempt++) {
        esp_task_wdt_reset();

        HTTPClient http;
        String url = ServerConfig::url() + "/api/v1/devices/activate";
        if (!ServerConfig::httpBegin(http, _plainClient, url)) {
            Serial.println("Activation: could not open connection");
            delay(ACTIVATE_INTERVAL_MS);
            continue;
        }
        http.addHeader("Content-Type", "application/json");
        http.setTimeout(5000);

        JsonDocument doc;
        doc["serial_number"] = deviceId;
        // Report the setup AP password too: the backend stores it so the UI can
        // show it even while the device is offline (local WiFi portal).
        doc["setup_password"] = WifiManager::getSetupPassword();
        String payload;
        serializeJson(doc, payload);

        int code = http.POST(payload);
        if (code == 200) {
            String body = http.getString();
            http.end();
            JsonDocument resp;
            if (deserializeJson(resp, body) == DeserializationError::Ok) {
                const char* token = resp["device_token"];
                if (token && strlen(token) > 0) {
                    saveDeviceToken(String(token));
                    Serial.println("Device activated!");
                    return String(token);
                }
            }
        } else {
            Serial.printf("Not registered yet (status %d). Attempt %d/%d...\n",
                          code, attempt + 1, MAX_ACTIVATE_ATTEMPTS);
            http.end();
        }

        delay(ACTIVATE_INTERVAL_MS);
    }

    Serial.println("Activation failed after max attempts - restarting...");
    delay(1000);
    ESP.restart();
    return ""; // unreachable
}

void DeviceIdentity::factoryReset() {
    Serial.println("FACTORY RESET - clearing runtime config, preserving factory identity...");
    WifiManager::clearCredentials();
    prefs.begin("foriq", false);
    // device_id (factory serial number) belongs to the factory identity and must
    // never be removed by a user reset. The separate foriq-setup namespace
    // (setup code) is left untouched as well.
    prefs.remove("device_token");
    prefs.remove("recovery_cnt");
    prefs.remove("recovery_rsn");
    prefs.end();
    // Also delete buffered measurements (they belong to the old registration)
    if (SPIFFS.format()) {
        Serial.println("SPIFFS formatted.");
    } else {
        Serial.println("SPIFFS format FAILED.");
    }
    Serial.println("Restarting...");
    delay(1000);
    ESP.restart();
}

int DeviceIdentity::readRecoveryCount() {
    prefs.begin("foriq", true);
    int count = prefs.getInt("recovery_cnt", 0);
    prefs.end();
    return count;
}

void DeviceIdentity::incrementRecovery(const char* reason) {
    prefs.begin("foriq", false);
    int count = prefs.getInt("recovery_cnt", 0) + 1;
    prefs.putInt("recovery_cnt", count);
    prefs.putString("recovery_rsn", reason);
    prefs.end();
    Serial.printf("Recovery counter: %d (reason: %s)\n", count, reason);
}

void DeviceIdentity::resetRecovery() {
    prefs.begin("foriq", false);
    prefs.remove("recovery_cnt");
    prefs.remove("recovery_rsn");
    prefs.end();
}
