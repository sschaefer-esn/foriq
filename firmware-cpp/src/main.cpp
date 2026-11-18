#include <Arduino.h>
#include <math.h>
#include <esp_task_wdt.h>
#include <esp_sleep.h>

#include "config.h"
#include "server_config.h"
#include "device_identity.h"
#include "accel.h"
#include "wifi_manager.h"
#include "api_client.h"
#include "energy_detector.h"
#include "hit_buffer.h"
#include "commands.h"
#include "ota_updater.h"
#include "power_manager.h"
#include "time_sync.h"
#include "scheduler.h"
#include "task_sync.h"
#include "serial_cmd.h"
#include <SPIFFS.h>
#include <unistd.h>

// ─── Global Config (updated from backend via network task) ──
volatile int   configUploadIntervalS = 0;  // 0 = realtime
volatile bool  configPowerSave = false;            // false = high-performance mode (default)
volatile int   configSleepAfterMin = 0;             // 0 = sleep mode off (default)
volatile uint32_t configSyncIntervalMs = SETTINGS_SYNC_MS;  // set by the backend: 1 s while the UI is open (fast sync), otherwise 30 s

volatile int configCountSensitivity = 3594; // sensitivity level 5/10 → A_min
volatile int configCountBridgeMs = -1;   // -1 = 1500 ms (40/min), otherwise absolute 400..6000 ms

String globalDeviceToken;
int    dutyCycleFailures = 0;

// ─── Shared State (sensor writes, network reads) ────────────
volatile bool     inSleepMode = false;
// Transport diagnostics for settings_sync (written/read by the network task).
volatile uint32_t hitQueueStagedCount = 0;
volatile uint32_t hitQueueStagedOldestEpochS = 0;
volatile uint32_t wifiOfflineS = 0; // current or most recently ended outage

// ─── Sensor-only State ──────────────────────────────────────
static uint32_t    lastHitTime;
static float    sleepPrevAccel = 1.0f;

// ─── Flush Logic (network task only) ────────────────────────
// The staging buffer holds a drained batch until HTTP confirms it OR the whole
// batch is verifiably in SPIFFS. That way neither a 401/restart nor a full or
// faulty flash loses hits that were already removed from the ring.
static BinaryHit stagedHits[HIT_UPLOAD_BATCH_CAPACITY];
static int stagedHitCount = 0;

static bool stageRamHits() {
    if (stagedHitCount > 0) return true;
    stagedHitCount = HitBuffer::drainRam(stagedHits, HIT_UPLOAD_BATCH_CAPACITY);
    hitQueueStagedCount = stagedHitCount;
    hitQueueStagedOldestEpochS = stagedHitCount > 0 ? stagedHits[0].epoch_s : 0;
    return stagedHitCount > 0;
}

static bool hasCurrentRamHits() {
    return stagedHitCount > 0 || HitBuffer::ramCount() > 0;
}

static String sendRamHits(const String& deviceToken) {
    if (!stageRamHits()) return deviceToken;

    String result = ApiClient::sendHitsBinary((uint8_t*)stagedHits,
                                              stagedHitCount * sizeof(BinaryHit),
                                              deviceToken);
    if (result == "ok") {
        stagedHitCount = 0;
        hitQueueStagedCount = 0;
        hitQueueStagedOldestEpochS = 0;
        return deviceToken;
    }
    if (result == "backoff") {
        return deviceToken; // batch stays in staging RAM
    }

    if (result == "reactivate") {
        // An auth reset must not lose the batch already removed from the ring.
        bool secured = HitBuffer::appendToFile(stagedHits, stagedHitCount);
        if (secured) {
            stagedHitCount = 0;
            hitQueueStagedCount = 0;
            hitQueueStagedOldestEpochS = 0;
        }
        if (!secured) {
            Serial.println("Token invalid, but saving hits failed - restart postponed");
            return deviceToken;
        }
        HitBuffer::persistDiagnostics();
        Serial.println("Token invalid - hits saved, restarting...");
        delay(1000);
        ESP.restart();
    }
    // Transport errors stay in RAM at first. The network task writes to the
    // journal only after HIT_FLASH_DELAY_MS or at the high-water mark.
    return deviceToken;
}

// Drain RAM into the SPIFFS file (duty cycle or WiFi offline)
static bool persistRamToSpiffs() {
    if (!stageRamHits()) return true;
    if (!HitBuffer::appendToFile(stagedHits, stagedHitCount)) return false;
    stagedHitCount = 0;
    hitQueueStagedCount = 0;
    hitQueueStagedOldestEpochS = 0;
    return true;
}

static bool persistAllRamToSpiffs() {
    while (hasCurrentRamHits()) {
        if (!persistRamToSpiffs()) return false;
        esp_task_wdt_reset();
    }
    return true;
}

static String flushHitFilePath(const char* path, int recordSize,
                               const String& deviceToken) {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    FILE* f = fopen(path, "rb");
    if (!f) {
        xSemaphoreGive(TaskSync::getBufferMutex());
        return deviceToken;
    }
    fseek(f, 0, SEEK_END);
    long fileSize = ftell(f);
    if (fileSize <= 0) {
        fclose(f);
        xSemaphoreGive(TaskSync::getBufferMutex());
        return deviceToken;
    }
    fseek(f, 0, SEEK_SET);

    static uint8_t binBuf[4088];
    long sent = 0;
    bool allOk = true;

    while (sent < fileSize) {
        int toRead = min((long)sizeof(binBuf), fileSize - sent);
        toRead = (toRead / recordSize) * recordSize;
        if (toRead <= 0) break;

        int rd = fread(binBuf, 1, toRead, f);
        if (rd <= 0) break;

        String result = ApiClient::sendHitsBinary(binBuf, rd, deviceToken);
        if (result == "reactivate") {
            fclose(f);
            xSemaphoreGive(TaskSync::getBufferMutex());
            Serial.println("Token invalid - restarting...");
            delay(1000);
            ESP.restart();
            return deviceToken;
        } else if (result != "ok") {
            allOk = false;
            break;
        }
        sent += rd;
    }
    fclose(f);

    if (allOk) {
        remove(path);
    } else {
        Serial.printf("Flush partial: %ld/%ld bytes sent\n", sent, fileSize);
    }

    xSemaphoreGive(TaskSync::getBufferMutex());
    return deviceToken;
}

static String flushHitFile(const String& deviceToken) {
    // Send only one journal chunk per network cycle. The persistent tail is
    // advanced atomically only after HTTP 200.
    static BinaryHit fileHits[HIT_UPLOAD_BATCH_CAPACITY];
    int count = HitBuffer::readPendingFile(fileHits, HIT_UPLOAD_BATCH_CAPACITY);
    if (count <= 0) return deviceToken;

    String result = ApiClient::sendHitsBinary(
        reinterpret_cast<uint8_t*>(fileHits), count * sizeof(BinaryHit), deviceToken);
    if (result == "reactivate") {
        HitBuffer::persistDiagnostics();
        Serial.println("Token invalid - file hits are safe in the journal, restarting...");
        delay(1000);
        ESP.restart();
        return deviceToken;
    }
    if (result != "ok") return deviceToken;
    if (!HitBuffer::commitPendingFile(count)) {
        Serial.println("Hit journal: sent chunk could not be committed; retry will be deduplicated");
    }
    return deviceToken;
}

// Upgrade compatibility: older firmware buffered v4 records in a plain file
// instead of the journal. Send them once.
static String flushLegacyV4HitFile(const String& deviceToken) {
    return flushHitFilePath("/spiffs/hits4.bin", sizeof(BinaryHit), deviceToken);
}

// While the runtime portal runs (blocking on core 0), core 1 keeps detecting
// strokes — without persisting, the RAM ring would overflow in ~1 min. Called
// from the portal loop; SPIFFS access is throttled (5 s).
static void portalIdlePersist() {
    static uint32_t lastPersist = 0;
    uint32_t now = millis();
    if (now - lastPersist < 5000) return;
    lastPersist = now;
    esp_task_wdt_reset();
    if (hasCurrentRamHits()) {
        persistRamToSpiffs();
    }
}

// ─── Network Task (Core 0) ─────────────────────────────────
static void networkTask(void* param) {
    esp_task_wdt_add(NULL);

    // Network-only timing state
    uint32_t lastFlush = millis();
    uint32_t lastSettingsSync = millis();
    uint32_t lastRestartCheck = millis();
    uint32_t lastDutyCycle = millis();
    uint32_t lastSleepWifiCheck = 0;
    uint32_t lastReconnect = 0;
    int  reconnectIndex = 0;
    uint32_t wifiDownSince = 0;
    bool wifiWasDown = false;
    bool radioResetDone = false;
    int  portalCycles = 0;      // unsuccessful recovery portal cycles
    uint32_t serverFailSince = 0;
    bool serverWasFailing = false;
    uint32_t hitBatchPendingSince = 0;
    uint32_t hitUnsentSince = 0;

    Serial.println("[net] Network task started on Core 0");

    // WiFi reports WL_CONNECTED, but settingsSync() keeps failing (server down,
    // routing/DNS problem) — the WiFi reconnect escalation below does not
    // catch this because it depends only on the link status. If the sync fails
    // for MAX_SERVER_DOWN_MS, force a WiFi reconnect; the existing phased
    // reconnect logic then takes over automatically.
    auto trackSyncResult = [&](bool ok, uint32_t now) {
        if (ok) {
            if (serverWasFailing) {
                Serial.printf("Server reachable again (outage: %lums)\n",
                              now - serverFailSince);
            }
            serverWasFailing = false;
            serverFailSince = 0;
            return;
        }
        if (!serverWasFailing) {
            serverFailSince = now;
            serverWasFailing = true;
        } else if (now - serverFailSince >= MAX_SERVER_DOWN_MS) {
            Serial.printf("Server unreachable for %lus despite WiFi link - forcing reconnect\n",
                          MAX_SERVER_DOWN_MS / 1000);
            WifiManager::disconnect();
            serverWasFailing = false;
            serverFailSince = 0;
        }
    };

    while (true) {
        esp_task_wdt_reset();
        uint32_t now = millis();
        bool wifiDutyMode = configUploadIntervalS > 0;

        // ─── Handle sleep request from sensor task ──────────
        if (TaskSync::sleepRequested) {
            TaskSync::sleepRequested = false;
            lastSleepWifiCheck = now;
            TaskSync::networkBusy = true;
            persistAllRamToSpiffs();
            if (SPIFFS.exists("/hits4.bin") && WifiManager::isConnected()) {
                flushLegacyV4HitFile(globalDeviceToken);
            }
            if (HitBuffer::hasPendingFile() && WifiManager::isConnected()) {
                flushHitFile(globalDeviceToken);
            }
            PowerManager::enterSleep(globalDeviceToken);
            TaskSync::networkBusy = false;
        }

        // ─── Handle wake request from sensor task ───────────
        if (TaskSync::wakeRequested) {
            TaskSync::wakeRequested = false;
            TaskSync::networkBusy = true;
            if (!wifiDutyMode) {
                PowerManager::exitSleep();
                wifiWasDown = false;
                wifiDownSince = 0;
            } else {
                Serial.println("Sleep mode ended (duty-cycle, WiFi stays off)");
            }
            TaskSync::networkBusy = false;
        }

        // ─── Sleep mode ─────────────────────────────────────
        if (inSleepMode) {
            if (now - lastSleepWifiCheck >= PowerManager::getSleepWifiCheckMs()) {
                lastSleepWifiCheck = now;
                TaskSync::networkBusy = true;
                PowerManager::sleepWifiCheck(globalDeviceToken);
                TaskSync::networkBusy = false;
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
            continue;
        }

        // ─── Duty cycle mode ────────────────────────────────
        if (wifiDutyMode) {
            if (WifiManager::isConnected()) {
                WifiManager::disableRadio();
            }
            bool currentHits = hasCurrentRamHits();
            if (currentHits && hitUnsentSince == 0) hitUnsentSince = now;
            int currentRamCount = HitBuffer::ramCount() + stagedHitCount;
            // Keep short intervals in the large RAM ring only. Write to the
            // preallocated journal in blocks only after 30 s or at high water.
            if (currentHits &&
                (now - hitUnsentSince >= HIT_FLASH_DELAY_MS ||
                 currentRamCount >= HitBuffer::ramHighWater())) {
                persistAllRamToSpiffs();
                if (!hasCurrentRamHits()) hitUnsentSince = 0;
            }
            bool intervalReached = now - lastDutyCycle >= (uint32_t)configUploadIntervalS * 1000UL;
            bool bufferFull = HitBuffer::size() + stagedHitCount >= BUFFER_FLUSH_THRESHOLD;
            if (intervalReached || bufferFull) {
                esp_task_wdt_reset();
                // The duty-cycle uploader reads the journal, so commit all RAM
                // hits before switching the radio on.
                persistAllRamToSpiffs();
                if (!hasCurrentRamHits()) hitUnsentSince = 0;
                lastDutyCycle = now;
                TaskSync::networkBusy = true;
                globalDeviceToken = PowerManager::wifiDutyCycle(globalDeviceToken);
                lastFlush = now;
                lastSettingsSync = now;
                TaskSync::networkBusy = false;
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
        } else {
            // ─── Always-on WiFi mode ────────────────────────
            bool wifiOk = WifiManager::isConnected();
            if (!wifiOk) {
                bool currentHits = hasCurrentRamHits();
                if (currentHits && hitUnsentSince == 0) hitUnsentSince = now;
                if (!wifiWasDown) {
                    wifiDownSince = now;
                    wifiWasDown = true;
                    radioResetDone = false;
                    Serial.println("WiFi disconnected - reconnect phases active");
                }

                uint32_t downMs = now - wifiDownSince;
                wifiOfflineS = downMs / 1000UL;
                int currentRamCount = HitBuffer::ramCount() + stagedHitCount;
                if (currentHits &&
                    (now - hitUnsentSince >= HIT_FLASH_DELAY_MS ||
                     currentRamCount >= HitBuffer::ramHighWater())) {
                    persistAllRamToSpiffs();
                    if (!hasCurrentRamHits()) hitUnsentSince = 0;
                }

                if (downMs >= MAX_WIFI_DOWN_MS) {
                    // No reboot: the hit journal would survive, but detection
                    // would stall during the blocking boot-time WiFi path.
                    Serial.printf("WiFi down for %lus - radio reset, detection continues\n",
                                  MAX_WIFI_DOWN_MS / 1000);
                    persistAllRamToSpiffs();
                    HitBuffer::persistDiagnostics();
                    WifiManager::hardResetRadio();
                    WifiManager::startReconnect(0);
                    wifiDownSince = millis();
                    radioResetDone = true;
                    lastReconnect = wifiDownSince;
                    continue;
                }

                // Phased reconnect strategy
                if (downMs < 5000) {
                    // Phase 1 (0-5s): Auto-reconnect grace period
                } else if (downMs < 30000) {
                    // Phase 2 (5-30s): Manual reconnect every 3s
                    if (now - lastReconnect >= 3000) {
                        WifiManager::startReconnect(reconnectIndex);
                        reconnectIndex++;
                        lastReconnect = now;
                    }
                } else {
                    // Phase 3 (30s+): One hard reset, then reconnect every 10s
                    if (!radioResetDone) {
                        WifiManager::hardResetRadio();
                        radioResetDone = true;
                        reconnectIndex = 0;
                        WifiManager::startReconnect(reconnectIndex);
                        reconnectIndex++;
                        lastReconnect = now;
                    } else if (now - lastReconnect >= 10000) {
                        WifiManager::startReconnect(reconnectIndex);
                        reconnectIndex++;
                        lastReconnect = now;
                    }
                }

                // ─── Recovery portal ────────────────────────
                // Phased reconnect has not succeeded for PORTAL_AFTER_DOWN_MS →
                // open the portal (blocks core 0 only; detection continues on
                // core 1, portalIdlePersist saves to SPIFFS). The background
                // reconnect inside the portal closes it by itself as soon as a
                // known network is reachable again.
                if (downMs >= PORTAL_AFTER_DOWN_MS) {
                    Serial.printf("WiFi down %lus - opening recovery portal\n", downMs / 1000);
                    TaskSync::networkBusy = true;
                    WifiManager::startPortal(PORTAL_RUNTIME_TIMEOUT_MS, true, portalIdlePersist);
                    TaskSync::networkBusy = false;
                    if (WifiManager::factoryResetRequested()) {
                        DeviceIdentity::factoryReset();   // wipes everything + restarts
                    }
                    if (WifiManager::isConnected()) {
                        portalCycles = 0;
                        // the wifiOk branch cleans up on the next pass
                    } else {
                        portalCycles++;
                        if (portalCycles >= PORTAL_CYCLES_BEFORE_RESTART) {
                            // Don't block detection with a WiFi reboot.
                            // Hard-reinitialise the radio and keep counting offline.
                            Serial.println("Recovery portal cycles exhausted - radio reset without restart");
                            persistAllRamToSpiffs();
                            HitBuffer::persistDiagnostics();
                            WifiManager::hardResetRadio();
                            portalCycles = 0;
                        }
                        // Fresh cycle: phased reconnect first, then the portal again
                        wifiDownSince = millis();
                        radioResetDone = false;
                    }
                }
            } else {
                if (wifiWasDown) {
                    uint32_t downDuration = now - wifiDownSince;
                    if (downDuration >= 1000UL) wifiOfflineS = downDuration / 1000UL;
                    Serial.printf("WiFi reconnected (outage: %lums, RSSI: %d)\n",
                                  downDuration, WifiManager::getRSSI());
                }
                reconnectIndex = 0;
                wifiWasDown = false;
                wifiDownSince = 0;
                radioResetDone = false;
                WifiManager::applyRssiPowerSave();
                if (WifiManager::maybeRoam()) {
                    // Start active requests only on the next cycle, once the
                    // new AP has completed association/DHCP.
                    wifiWasDown = true;
                    wifiDownSince = now;
                    lastReconnect = now;
                    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(250));
                    continue;
                }

                // ─── Flush decision: current hits before offline backlog ───
                // Good WiFi: low latency. Weak WiFi: coalesce up to 8 s or
                // 32 hits so far fewer HTTP requests are needed. The persisted
                // backlog then gets one chunk per cycle.
                bool currentHits = hasCurrentRamHits();
                if (currentHits && hitUnsentSince == 0) hitUnsentSince = now;
                if (!currentHits) {
                    hitUnsentSince = 0;
                    hitBatchPendingSince = 0;
                }
                if (currentHits && hitBatchPendingSince == 0) {
                    hitBatchPendingSince = now;
                }
                bool weakWifi = WifiManager::getRSSI() < WIFI_RSSI_WEAK_DBM;
                uint32_t batchDelayMs = weakWifi ? HIT_BATCH_WEAK_DELAY_MS : HIT_BATCH_DELAY_MS;
                int batchTarget = weakWifi ? HIT_BATCH_WEAK_COUNT : HIT_UPLOAD_BATCH_CAPACITY;
                bool batchDue = currentHits &&
                    (now - hitBatchPendingSince >= batchDelayMs ||
                     HitBuffer::ramCount() + stagedHitCount >= batchTarget ||
                     stagedHitCount > 0);
                bool currentBatchSucceeded = false;
                if (batchDue && ApiClient::hitUploadReady()) {
                    esp_task_wdt_reset();
                    globalDeviceToken = sendRamHits(globalDeviceToken);
                    currentBatchSucceeded = stagedHitCount == 0;
                    lastFlush = millis();
                    hitBatchPendingSince = hasCurrentRamHits() ? millis() : 0;
                } else if (currentHits && !ApiClient::hitUploadReady() &&
                           (now - hitUnsentSince >= HIT_FLASH_DELAY_MS ||
                            HitBuffer::ramCount() + stagedHitCount >= HitBuffer::ramHighWater())) {
                    persistAllRamToSpiffs();
                    if (!hasCurrentRamHits()) {
                        hitBatchPendingSince = 0;
                        hitUnsentSince = 0;
                    }
                }

                // Drain the persisted backlog fairly: after a successful current
                // batch, one old chunk may follow even if new hits arrived in
                // the ring during the HTTP request.
                bool allowBacklog = ApiClient::hitUploadReady() &&
                    (!hasCurrentRamHits() || currentBatchSucceeded) &&
                    HitBuffer::ramCount() + stagedHitCount < HitBuffer::ramHighWater();
                if (allowBacklog) {
                    if (SPIFFS.exists("/hits4.bin")) {
                        esp_task_wdt_reset();
                        globalDeviceToken = flushLegacyV4HitFile(globalDeviceToken);
                        lastFlush = millis();
                    } else if (HitBuffer::hasPendingFile()) {
                        esp_task_wdt_reset();
                        globalDeviceToken = flushHitFile(globalDeviceToken);
                        lastFlush = millis();
                    }
                }

                bool syncDue = now - lastSettingsSync >= configSyncIntervalMs;
                bool skipForRecentHit = false;
                if (syncDue && configSyncIntervalMs == SETTINGS_SYNC_MS) {
                    uint32_t lastHitOk = ApiClient::getHitLastSuccessMs();
                    if (lastHitOk != 0 && (now - lastHitOk) < 2000UL) {
                        skipForRecentHit = true;
                    }
                }
                if (syncDue && !skipForRecentHit) {
                    esp_task_wdt_reset();
                    trackSyncResult(ApiClient::settingsSync(globalDeviceToken), now);
                    lastSettingsSync = now;
                } else if (Scheduler::hasPlan() &&
                           now - lastRestartCheck >= RESTART_CHECK_MS) {
                    lastRestartCheck = now;
                    Scheduler::check(globalDeviceToken);
                }
            }
            uint32_t waitMs = 1000;
            if (hasCurrentRamHits() && hitBatchPendingSince != 0) {
                uint32_t elapsed = millis() - hitBatchPendingSince;
                uint32_t delayMs = WifiManager::isConnected() &&
                    WifiManager::getRSSI() < WIFI_RSSI_WEAK_DBM
                    ? HIT_BATCH_WEAK_DELAY_MS : HIT_BATCH_DELAY_MS;
                waitMs = elapsed >= delayMs ? 20 : delayMs - elapsed;
            } else if (HitBuffer::hasPendingFile() && ApiClient::hitUploadReady()) {
                waitMs = 50; // drain backlog quickly, but only one HTTP chunk per cycle
            } else if (!ApiClient::hitUploadReady()) {
                waitMs = min((uint32_t)1000, ApiClient::hitUploadRetryInMs());
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(max((uint32_t)20, waitMs)));
        }
    }
}

// ─── Setup ──────────────────────────────────────────────────
static EnergyDetector energyDetector;
// Sleep polling must not discard the FIFO block that triggered the wake:
// it is replayed before the newer samples on the next active pass.
static float wakeReplayMags[FIFO_DRAIN_SAMPLES];
static int wakeReplayCount = 0;
static AccelFifoStatus wakeReplayStatus;
static bool energyGapPending = false;
static uint32_t energyGapSinceMs = 0;
static uint32_t lastEnergyFeedMs = 0;

void setup() {
    Serial.begin(115200);
    delay(100);
    // Journal and legacy file access already use this mutex during the boot
    // sync, before the network task starts.
    TaskSync::init();

    // Display off immediately — the backlight must stay dark even during the
    // captive portal / WiFi connect (init() only runs after setup).
    PowerManager::displayOff();

    // 1. Device ID
    String deviceId = DeviceIdentity::getOrCreateDeviceId();
    Serial.printf("Device-ID: %s\n", deviceId.c_str());

    // 2. SPIFFS for the hit journal (offline buffer)
    if (!SPIFFS.begin(true)) {
        Serial.println("SPIFFS mount FAILED — offline hit buffering unavailable");
    } else {
        Serial.printf("SPIFFS mounted: total=%u, used=%u bytes\n",
                      (unsigned)SPIFFS.totalBytes(), (unsigned)SPIFFS.usedBytes());
    }
    energyDetector.reset();
    energyDetector.setOp((int)configCountSensitivity, (int)configCountBridgeMs);
    // Free leftovers of a removed feature from older firmware.
    if (SPIFFS.exists("/learn.bin")) {
        SPIFFS.remove("/learn.bin");
        Serial.println("Removed stale /learn.bin");
    }
    if (SPIFFS.exists("/hits4.bin")) {
        Serial.println("Found unsent legacy hits (v4 file)");
    }

    // 3. Watchdog (60s timeout)
    esp_task_wdt_init(60, true);
    esp_task_wdt_add(NULL);

    // Load the server address (NVS) before the first request and before the portal.
    ServerConfig::begin();

    // 4. WiFi
    WifiManager::begin(deviceId);
    // Initialise exactly one stable, random hit identity per boot. WiFi STA is
    // now active as an entropy source, SPIFFS is mounted and the sensor loop
    // has not started yet. The backend rejects boot_id=0.
    HitBuffer::init();
    // Factory/label output: readable only from the running device, not
    // derivable from a public hardware ID. Parsed by tools/app_flasher.py.
    Serial.printf("Setup-AP: %s / Password: %s\n", AP_SSID,
                  WifiManager::getSetupPassword().c_str());
    auto savedNetworks = WifiManager::loadNetworks();
    bool hasCredentials = !savedNetworks.empty();

    // Decides the portal mode — activated devices get the non-destructive
    // portal (token/config are kept, reset only after confirmation).
    bool everActivated = DeviceIdentity::loadDeviceToken().length() > 0;

    if (!hasCredentials) {
        // No WiFi stored: first-time setup OR an activated device after a
        // wifi_reset from the UI (deliberately reconfiguring WiFi).
        Serial.println("No WiFi credentials - starting setup (Captive Portal)...");
        WifiManager::startPortal(600000, everActivated); // 10 min timeout
        if (WifiManager::factoryResetRequested()) {
            DeviceIdentity::factoryReset();   // wipes everything + restarts
        }
        if (!WifiManager::isConnected()) {
            ESP.restart();
        }
    } else {
        int bootFails = DeviceIdentity::readRecoveryCount();
        // First-time setup (no token): portal after PORTAL_RECOVERY_FAILS failed
        // boots. Activated devices: portal after PORTAL_RECOVERY_FAILS_ACTIVATED
        // failed boots, but NON-destructive — token/config are kept, only WiFi
        // is re-entered (or the user explicitly confirms a factory reset).

        if (bootFails >= PORTAL_RECOVERY_FAILS && !everActivated) {
            // First-time setup failed repeatedly (wrong password, WiFi out of
            // range, ...): reopen the setup portal so the user can reconfigure
            // WiFi, instead of an endless silent reboot loop.
            Serial.printf("WiFi failed %dx (never activated) - reopening Captive Portal...\n", bootFails);
            WifiManager::hardResetRadio();
            WifiManager::startPortal(600000); // 10 min timeout
            if (!WifiManager::isConnected()) {
                ESP.restart();
            }
        } else if (bootFails >= PORTAL_RECOVERY_FAILS_ACTIVATED && everActivated) {
            // Activated device cannot join WiFi at boot (SSID changed, router
            // replaced): open the recovery portal. The background reconnect keeps
            // running inside the portal — a network that was only temporarily
            // down closes the portal by itself.
            Serial.printf("WiFi failed %dx (activated) - opening recovery portal...\n", bootFails);
            WifiManager::hardResetRadio();
            WifiManager::startPortal(PORTAL_RUNTIME_TIMEOUT_MS, true);
            if (WifiManager::factoryResetRequested()) {
                DeviceIdentity::factoryReset();   // wipes everything + restarts
            }
            if (!WifiManager::isConnected()) {
                ESP.restart();   // next cycle: reconnect attempts + portal
            }
        } else {
            if (bootFails >= 5) {
                WifiManager::hardResetRadio();
            }
            if (!WifiManager::connect()) {
                DeviceIdentity::incrementRecovery("wifi_connect_failed");
                int backoffS = min(5 * (bootFails + 1), 30);
                Serial.printf("WiFi failed (attempt %d) - restart in %ds...\n", bootFails + 1, backoffS);
                for (int i = 0; i < backoffS * 2; i++) {
                    esp_task_wdt_reset();
                    delay(500);
                }
                ESP.restart();
            }
        }
    }

    // WiFi successful — reset recovery
    DeviceIdentity::resetRecovery();

    // 5. NTP sync
    TimeSync::init();

    // 6. Token — load or activate
    globalDeviceToken = DeviceIdentity::loadDeviceToken();
    if (globalDeviceToken.length() == 0) {
        globalDeviceToken = DeviceIdentity::activateDevice(deviceId);
        // Pin the address of the server the device activated with, so it stays
        // with that server even if the default changes.
        if (ServerConfig::storedUrl().length() == 0) {
            ServerConfig::save(ServerConfig::url());
        }
    }

    // 7. Power saving + sensor
    PowerManager::init();
    if (!Accel::init()) {
        Serial.println("ERROR: Sensor not available - restarting...");
        delay(1000);
        ESP.restart();
    }
    if (!Accel::enableFifo()) {
        Serial.println("ERROR: sensor FIFO could not be verified - restarting...");
        delay(1000);
        ESP.restart();
    }
    // Disable LiPo charging in the M5PM1 (safety/compliance decision, see
    // power_manager.cpp). Requires Wire.begin() from Accel::init().
    PowerManager::disableCharging();

    // This marker is also where the backend reads the version of a firmware
    // binary (ota.py). As a genuinely referenced literal it survives
    // --gc-sections. Do not rely on incidental linker layout instead: if the
    // extracted version ever differs from what the flashed device reports, the
    // server keeps offering the same update — an OTA reboot loop.
    Serial.println("Foriq Sensor started. FORIQ_FW_VERSION=" FIRMWARE_VERSION);
    Serial.printf("API: %s\n", ServerConfig::url().c_str());
    if (globalDeviceToken.length() > 12) {
        Serial.printf("Token: %.8s...%s\n", globalDeviceToken.c_str(),
                      globalDeviceToken.substring(globalDeviceToken.length() - 4).c_str());
    }

    // 8. Report online via settings sync — retry in case network/DNS is not ready right after the WiFi connect
    bool online = false;
    for (int i = 0; i < 3 && !online; i++) {
        if (i > 0) delay(2000);
        online = ApiClient::settingsSync(globalDeviceToken);
    }
    if (online) {
        Serial.printf("Online status reported. RSSI: %d\n", WifiManager::getRSSI());
    } else {
        Serial.println("Boot API call failed — will sync in main loop");
    }

    // 9. Duty cycle mode: disconnect after setup
    bool wifiDutyMode = configUploadIntervalS > 0;
    if (wifiDutyMode) {
        Serial.printf("WiFi duty-cycle active (interval: %ds) - WiFi off\n",
                      configUploadIntervalS);
        WifiManager::disableRadio();
    }

    energyDetector.setOp((int)configCountSensitivity, (int)configCountBridgeMs);
    Serial.printf("Energy detector: %.0f Hz (native FIFO), IMU: %d Hz\n",
                  EnergyDetector::kFs, Accel::odrHz());

    // Init timing
    uint32_t now = millis();
    lastHitTime = now;

    // 10. Network task on Core 0
    TaskHandle_t netHandle;
    xTaskCreatePinnedToCore(networkTask, "net", 16384, NULL, 3, &netHandle, 0);
    TaskSync::setNetworkTaskHandle(netHandle);

    Serial.println("Waiting for hits (energy detector)...");
}

// ─── Loop (Sensor Task — Core 1) ───────────────────────────
void loop() {
    esp_task_wdt_reset();
    SerialCmd::handleIdle();   // FORIQ-INFO for the Foriq app (USB)
    static float fifoMags[FIFO_DRAIN_SAMPLES];
    static uint32_t sleepSensorErrorSinceMs = 0;
    static uint32_t sleepLastSensorRecoveryMs = 0;
    static uint32_t sleepLastSensorErrorLogMs = 0;

    // ─── Sleep mode: constant 50 ms polling ────────────────
    // This is only the power wake, not a second stroke counter. The threshold
    // is fixed locally; all counted hits are decided by the energy detector.
    if (inSleepMode) {
        if (configSleepAfterMin == 0) {
            inSleepMode = false;
            lastHitTime = millis();
            sleepSensorErrorSinceMs = 0;
            sleepLastSensorRecoveryMs = 0;
            sleepLastSensorErrorLogMs = 0;
            Serial.println("Sleep disabled (sleep_after_min=0) — exiting sleep mode");
            TaskSync::wakeRequested = true;
            TaskSync::notifyNetworkTask();
            return;
        }
        // Drain the FIFO in sleep too. The block that triggers the wake is kept
        // below for detection instead of being discarded.
        AccelFifoStatus sleepFifoStatus;
        int sleepSamples = Accel::drainFifo(fifoMags, FIFO_DRAIN_SAMPLES, &sleepFifoStatus);
        if (sleepSamples == 0) {
            fifoMags[0] = Accel::readTotalAccel();
            sleepSamples = 1;
        }
        bool validSleepSamples = sleepSamples > 0;
        for (int i = 0; i < sleepSamples && validSleepSamples; i++) {
            if (isnan(fifoMags[i]) || fifoMags[i] < 0.0f || fifoMags[i] > 100.0f) {
                validSleepSamples = false;
            }
        }

        bool motionDetected = false;
        if (!validSleepSamples) {
            const uint32_t errNow = millis();
            if (sleepSensorErrorSinceMs == 0) {
                sleepSensorErrorSinceMs = errNow;
                sleepLastSensorErrorLogMs = errNow;
                Serial.println("IMU I2C error in sleep - no motion wake, recovery started");
            }
            if (sleepLastSensorRecoveryMs == 0
                    || errNow - sleepLastSensorRecoveryMs >= SENSOR_RECOVERY_RETRY_MS) {
                sleepLastSensorRecoveryMs = errNow;
                Accel::recoverI2C();
            }
            const uint32_t outageMs = errNow - sleepSensorErrorSinceMs;
            if (errNow - sleepLastSensorErrorLogMs >= 5000UL) {
                Serial.printf("IMU still unreadable in sleep (outage: %lums)\n",
                              (unsigned long)outageMs);
                sleepLastSensorErrorLogMs = errNow;
            }
            if (outageMs >= SENSOR_RESTART_AFTER_MS) {
                Serial.printf("IMU unreadable in sleep for %lums - restarting\n",
                              (unsigned long)outageMs);
                delay(1000);
                ESP.restart();
            }
        } else if (sleepSensorErrorSinceMs != 0) {
            Serial.printf("IMU readable again in sleep (outage: %lums)\n",
                          (unsigned long)(millis() - sleepSensorErrorSinceMs));
            // Re-baseline after reinitialisation, otherwise the first valid
            // value could trigger a false motion wake.
            sleepPrevAccel = fifoMags[sleepSamples - 1];
            sleepSensorErrorSinceMs = 0;
            sleepLastSensorRecoveryMs = 0;
            sleepLastSensorErrorLogMs = 0;
        } else {
            for (int i = 0; i < sleepSamples; i++) {
                const float accel = fifoMags[i];
                const float delta = accel - sleepPrevAccel;
                sleepPrevAccel = accel;
                if (delta * delta >= WAKE_MOTION_DELTA_SQ) {
                    motionDetected = true;
                    break;
                }
            }
        }
        if (motionDetected) {
            sleepSensorErrorSinceMs = 0;
            sleepLastSensorRecoveryMs = 0;
            sleepLastSensorErrorLogMs = 0;
            inSleepMode = false;
            lastHitTime = millis();
            wakeReplayCount = sleepSamples;
            wakeReplayStatus = sleepFifoStatus;
            for (int i = 0; i < sleepSamples; i++) wakeReplayMags[i] = fifoMags[i];
            if (!energyGapPending) {
                energyGapPending = true;
                energyGapSinceMs = lastEnergyFeedMs != 0 ? lastEnergyFeedMs : millis();
            }
            Serial.println("Wake from sleep (motion)");
            TaskSync::wakeRequested = true;
            TaskSync::notifyNetworkTask();
            return;
        }

        if (configPowerSave && !TaskSync::networkBusy) {
            esp_sleep_enable_timer_wakeup((uint64_t)POLL_SLEEP_MS * 1000ULL);
            // Re-check after configuring timer to narrow TOCTOU race window
            if (!TaskSync::networkBusy) {
                esp_light_sleep_start();
            }
        } else {
            // Power save off: regular poll, no light sleep (USB powered).
            delay(POLL_SLEEP_MS);
        }
        return;
    }

    uint32_t loopStart = millis();

    // Drain the FIFO completely: the counter sees the whole curve (not just the peak).
    static uint32_t sensorErrorSinceMs = 0;
    static uint32_t lastSensorRecoveryMs = 0;
    static uint32_t lastSensorErrorLogMs = 0;
    uint32_t drainStart = millis();
    AccelFifoStatus fifoStatus;
    int nFifo = Accel::drainFifo(fifoMags, FIFO_DRAIN_SAMPLES, &fifoStatus);
    uint32_t drainMs = millis() - drainStart;
    if (drainMs >= 100) {
        Serial.printf("IMU drain slow: %lums n=%d\n",
                      (unsigned long)drainMs, nFifo);
    }
    if (nFifo == 0) {
        fifoMags[0] = Accel::readTotalAccel();
        nFifo = 1;
    } else if (nFifo < 0) {
        // Keep I2C errors explicit. A failed read
        // must not reach the energy detector as a plausible-looking 0 g value
        // and open an episode lasting minutes.
        fifoMags[0] = NAN;
        nFifo = 1;
    }
    bool validSamples = true;
    for (int i = 0; i < nFifo; i++) {
        if (isnan(fifoMags[i]) || fifoMags[i] > 100.0f || fifoMags[i] < 0.0f) {
            validSamples = false;
            break;
        }
    }
    // Check for garbage reads (NaN or extreme values indicate I2C failure)
    if (!validSamples) {
        uint32_t errNow = millis();
        if (!energyGapPending) {
            energyGapPending = true;
            energyGapSinceMs = lastEnergyFeedMs != 0 ? lastEnergyFeedMs : errNow;
        }
        if (sensorErrorSinceMs == 0) {
            sensorErrorSinceMs = errNow;
            lastSensorErrorLogMs = errNow;
            Serial.println("IMU I2C error - sample discarded, recovery started");
        }
        if (lastSensorRecoveryMs == 0 ||
                errNow - lastSensorRecoveryMs >= SENSOR_RECOVERY_RETRY_MS) {
            lastSensorRecoveryMs = errNow;
            Accel::recoverI2C();
        }
        uint32_t outageMs = errNow - sensorErrorSinceMs;
        if (errNow - lastSensorErrorLogMs >= 5000UL) {
            Serial.printf("IMU still unreadable (outage: %lums, recovering)\n",
                          (unsigned long)outageMs);
            lastSensorErrorLogMs = errNow;
        }
        if (outageMs >= SENSOR_RESTART_AFTER_MS) {
            Serial.printf("IMU unreadable for %lums - restarting\n",
                          (unsigned long)outageMs);
            delay(1000);
            ESP.restart();
        }
        return; // Never feed invalid samples into the detector.
    } else {
        if (sensorErrorSinceMs != 0) {
            Serial.printf("IMU readable again (outage: %lums)\n",
                          (unsigned long)(millis() - sensorErrorSinceMs));
        }
        sensorErrorSinceMs = 0;
        lastSensorRecoveryMs = 0;
    }

    const float latestAccel = fifoMags[nFifo - 1];
    uint32_t now = millis();

    // Energy counting natively at the 800 Hz FIFO rate.
    energyDetector.setOp((int)configCountSensitivity, (int)configCountBridgeMs);
    int energyHits = 0;
    auto commitEnergyHit = [&]() {
        lastHitTime = now;
        // The native 800 Hz envelope energy is reported as a dimensionless
        // stroke value.
        HitBuffer::addHit(energyDetector.lastPeakG, energyDetector.lastDurMs, 0.0f,
                          energyDetector.lastEnergy, energyDetector.lastDurMs,
                          -1.0f);
        TaskSync::notifyNetworkTask();
    };
    auto applyEnergyGap = [&](float gapMs) {
        if (gapMs < 80.0f) gapMs = 80.0f;
        int gapHits = energyDetector.noteWallGap(gapMs);
        for (int k = 0; k < gapHits; k++) commitEnergyHit();
        energyHits += gapHits;
    };
    auto feedEnergySample = [&](float g) {
        int c = energyDetector.pushNative(g);
        for (int k = 0; k < c; k++) commitEnergyHit();
        energyHits += c;
    };

    // A slow loop is not a measurement gap as long as the FIFO delivered all
    // samples. Only explicit I2C/FIFO losses break the detector's continuity.
    if (energyGapPending) {
        applyEnergyGap((float)(now - energyGapSinceMs));
        energyGapPending = false;
        energyGapSinceMs = 0;
    }
    if (wakeReplayCount > 0) {
        if (wakeReplayStatus.gapBefore) applyEnergyGap(80.0f);
        for (int i = 0; i < wakeReplayCount; i++) feedEnergySample(wakeReplayMags[i]);
        if (wakeReplayStatus.gapAfter) applyEnergyGap(80.0f);
        wakeReplayCount = 0;
        wakeReplayStatus = AccelFifoStatus{};
    }
    if (fifoStatus.gapBefore) applyEnergyGap(80.0f);
    for (int fi = 0; fi < nFifo; fi++) {
        feedEnergySample(fifoMags[fi]);
    }
    if (fifoStatus.gapAfter) applyEnergyGap(80.0f);
    lastEnergyFeedMs = now;
    const bool hitDetected = energyHits > 0;

    // ─── Sleep mode entry ───────────────────────────────────
    uint32_t idleMs = now - lastHitTime;
    uint32_t sleepTimeoutMs = (uint32_t)configSleepAfterMin * 60000UL;
    if (!inSleepMode && !hitDetected && configSleepAfterMin > 0 && idleMs >= sleepTimeoutMs) {
        inSleepMode = true;
        sleepPrevAccel = latestAccel;
        wakeReplayCount = 0;
        wakeReplayStatus = AccelFifoStatus{};
        energyGapPending = true;
        energyGapSinceMs = now;
        sleepSensorErrorSinceMs = 0;
        sleepLastSensorRecoveryMs = 0;
        sleepLastSensorErrorLogMs = 0;
        Serial.printf("Sleep (poll %dms)\n", POLL_SLEEP_MS);
        TaskSync::sleepRequested = true;
        TaskSync::notifyNetworkTask();
    }

    // ─── Polling ──────────────────────────────────────────────
    // Target period POLL_ACTIVE_MS: wait for the remaining time. If the loop
    // took longer, continue immediately; the IMU FIFO keeps samples meanwhile.
    const uint32_t periodMs = POLL_ACTIVE_MS;
    uint32_t elapsed = millis() - loopStart;
    uint32_t remain = (elapsed < periodMs) ? (periodMs - elapsed) : 0;

    bool wifiDutyMode = configUploadIntervalS > 0;
    bool lightSleep = configPowerSave && wifiDutyMode && !TaskSync::networkBusy;

    if (remain == 0) {
        return;
    }
    if (lightSleep) {
        esp_sleep_enable_timer_wakeup((uint64_t)remain * 1000ULL);
        if (!TaskSync::networkBusy) {
            esp_light_sleep_start();
        }
    } else {
        delay(remain);
    }
}
