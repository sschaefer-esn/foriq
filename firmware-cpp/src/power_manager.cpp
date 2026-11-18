#include "power_manager.h"
#include "config.h"
#include "wifi_manager.h"
#include "api_client.h"
#include "hit_buffer.h"
#include "time_sync.h"
#include "scheduler.h"
#include <WiFi.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include <esp_sleep.h>
#include <SPIFFS.h>

// External config variables (defined in main.cpp)
extern volatile int  configUploadIntervalS;
extern volatile int  configSleepAfterMin;
extern volatile bool configPowerSave;
extern String globalDeviceToken;
extern int dutyCycleFailures;

static void flushDutyCycleHitFile(const char* path, int recordSize,
                                  const String& deviceToken) {
    FILE* f = fopen(path, "rb");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long fileSize = ftell(f);
    fseek(f, 0, SEEK_SET);
    static uint8_t binBuf[4088];
    long sent = 0;
    bool allOk = true;

    while (sent < fileSize) {
        esp_task_wdt_reset();
        int toRead = min((long)sizeof(binBuf), fileSize - sent);
        toRead = (toRead / recordSize) * recordSize;
        if (toRead <= 0) break;
        int rd = fread(binBuf, 1, toRead, f);
        if (rd <= 0) break;

        String result = ApiClient::sendHitsBinary(binBuf, rd, deviceToken);
        if (result == "reactivate") {
            fclose(f);
            Serial.println("Token invalid - restarting...");
            delay(1000);
            ESP.restart();
        } else if (result != "ok") {
            allOk = false;
            break;
        }
        sent += rd;
    }
    fclose(f);
    if (allOk && sent == fileSize) remove(path);
}

static void flushDutyCycleJournal(const String& deviceToken) {
    static BinaryHit batch[HIT_UPLOAD_BATCH_CAPACITY];
    while (HitBuffer::hasPendingFile() && ApiClient::hitUploadReady()) {
        esp_task_wdt_reset();
        int count = HitBuffer::readPendingFile(batch, HIT_UPLOAD_BATCH_CAPACITY);
        if (count <= 0) return;
        String result = ApiClient::sendHitsBinary(
            reinterpret_cast<uint8_t*>(batch), count * sizeof(BinaryHit), deviceToken);
        if (result == "reactivate") {
            HitBuffer::persistDiagnostics();
            Serial.println("Token invalid - journal hits are safe, restarting...");
            delay(1000);
            ESP.restart();
        }
        if (result != "ok" || !HitBuffer::commitPendingFile(count)) return;
    }
}

// M5PM1: LiPo charging is permanently disabled — a safety/compliance
// decision. The built-in battery is not used (devices run from a power supply),
// must NOT be kept charged and may self-discharge. Do NOT re-enable this in
// later changes. Register PWR_CFG (0x06) is volatile (PM1 reset => charging
// back on by default), but every PM1 reset also resets the ESP32, so
// re-asserting once per boot in setup() is enough; no periodic refresh needed.
// Read-modify-write on bit 0 (CHG_EN) only — bits 1-4 (DCDC/LDO/BOOST/LED)
// power the system and must stay untouched.
void PowerManager::disableCharging() {
    const uint8_t PM1_ADDR = 0x6E;      // M5PM1_DEFAULT_ADDR
    const uint8_t REG_PWR_CFG = 0x06;   // [0] CHG_EN: 0=off, 1=on

    // PM1 default is 100 kHz; the slow clock is safe for all slaves
    // (the bus otherwise runs at 400 kHz for the BMI270).
    Wire.setClock(100000);

    bool ok = false;
    // Up to 5 attempts: a failed attempt acts as a wake pulse if the PM1 is
    // in I2C auto-sleep (same behavior as the official M5PM1 library).
    for (int attempt = 0; attempt < 5 && !ok; attempt++) {
        if (attempt > 0) delay(10);

        Wire.beginTransmission(PM1_ADDR);
        Wire.write(REG_PWR_CFG);
        if (Wire.endTransmission(false) != 0) continue;
        if (Wire.requestFrom(PM1_ADDR, (uint8_t)1) < 1) continue;
        uint8_t before = Wire.read();

        Wire.beginTransmission(PM1_ADDR);
        Wire.write(REG_PWR_CFG);
        Wire.write(before & ~0x01);     // clear CHG_EN only
        if (Wire.endTransmission() != 0) continue;

        // Read back to verify
        Wire.beginTransmission(PM1_ADDR);
        Wire.write(REG_PWR_CFG);
        if (Wire.endTransmission(false) != 0) continue;
        if (Wire.requestFrom(PM1_ADDR, (uint8_t)1) < 1) continue;
        uint8_t after = Wire.read();

        if ((after & 0x01) == 0) {
            Serial.printf("PM1: charging disabled (PWR_CFG 0x%02X -> 0x%02X)\n", before, after);
            ok = true;
        }
    }
    if (!ok) Serial.println("PM1: disabling charging FAILED (I2C)");

    Wire.setClock(400000);
}

void PowerManager::displayOff() {
    pinMode(PIN_BACKLIGHT, OUTPUT);
    digitalWrite(PIN_BACKLIGHT, LOW);
}

void PowerManager::init() {
    // Default is full performance: CPU at full frequency.
    // Power save is enabled via applyPowerSaveMode() on the first settings
    // sync if the backend reports power_save=true.
    setCpuFrequencyMhz(ACTIVE_CPU_MHZ);

    // The display stays off permanently (see config.h).
    pinMode(PIN_BACKLIGHT, OUTPUT);
    digitalWrite(PIN_BACKLIGHT, LOW);

    Serial.printf("CPU frequency: %d MHz\n", getCpuFrequencyMhz());
}

void PowerManager::applyPowerSaveMode(bool enabled) {
    if (enabled) {
        setCpuFrequencyMhz(SLEEP_CPU_MHZ);
        digitalWrite(PIN_BACKLIGHT, LOW);
        WiFi.setSleep(WIFI_PS_MIN_MODEM);
        Serial.printf("Power save ON (CPU %dMHz, backlight off, WiFi PS_MIN_MODEM)\n",
                      getCpuFrequencyMhz());
    } else {
        setCpuFrequencyMhz(ACTIVE_CPU_MHZ);
        WiFi.setSleep(WIFI_PS_NONE);
        Serial.printf("Power save OFF (CPU %dMHz, backlight on, WiFi PS_NONE)\n",
                      getCpuFrequencyMhz());
    }
}

void PowerManager::enterSleep(const String& deviceToken) {
    // Connect if needed (e.g. duty-cycle mode where WiFi is off)
    if (!WifiManager::isConnected()) {
        WifiManager::connectAnyNetwork();
    }
    // Report sleep_mode to backend before going dark
    if (WifiManager::isConnected()) {
        ApiClient::settingsSync(deviceToken);
    }
    // Disconnect WiFi
    WifiManager::disableRadio();
    Serial.printf("Sleep mode activated (CPU: %dMHz, WiFi: off)\n", getCpuFrequencyMhz());
}

void PowerManager::exitSleep() {
    WifiManager::enableSTA();
    WifiManager::startReconnect(0);
    Serial.printf("Sleep mode ended (CPU: %dMHz, WiFi: reconnect)\n", getCpuFrequencyMhz());
}

void PowerManager::sleepWifiCheck(const String& deviceToken) {
    bool connected = WifiManager::connectAnyNetwork();
    if (connected) {
        ApiClient::settingsSync(deviceToken);
        esp_task_wdt_reset();
    }
    // Disconnect again
    WifiManager::disableRadio();
}

String PowerManager::wifiDutyCycle(const String& deviceToken) {
    String currentToken = deviceToken;

    bool connected = WifiManager::connectAnyNetwork();
    if (connected) {
        dutyCycleFailures = 0;
        // Legacy v4 file first (one-time), then the journal.
        if (SPIFFS.exists("/hits4.bin")) {
            flushDutyCycleHitFile("/spiffs/hits4.bin", sizeof(BinaryHit), currentToken);
        }
        if (HitBuffer::hasPendingFile()) {
            flushDutyCycleJournal(currentToken);
        }
        esp_task_wdt_reset();
        // Settings sync (replaces checkCommands + battery heartbeat)
        ApiClient::settingsSync(currentToken);
        esp_task_wdt_reset();
        // NTP resync
        TimeSync::ntpResync();
        // Scheduled restart
        if (Scheduler::hasPlan()) {
            Scheduler::check(currentToken);
        }
    } else {
        dutyCycleFailures++;
        Serial.printf("Duty-cycle: WiFi connection failed (%d/5)\n", dutyCycleFailures);
        if (dutyCycleFailures >= 5) {
            // No ESP restart: the boot path blocks on Wi-Fi and would record no
            // hits meanwhile. Reset the radio instead; the network task persists
            // new RAM hits and retries at the next interval/buffer threshold.
            Serial.println("Duty-cycle: 5 consecutive failures - radio reset without restart");
            WifiManager::hardResetRadio();
            dutyCycleFailures = 0;
        }
    }

    // Radio off
    WifiManager::disableRadio();
    return currentToken;
}


uint32_t PowerManager::getSleepWifiCheckMs() {
    return SLEEP_MODE_INFO_CYCLE_MS;
}
