#include "wifi_manager.h"
#include "config.h"
#include "server_config.h"
#include "captive_portal_html.h"
#include "secret_store.h"
#include "serial_cmd.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_wifi.h>

static String _deviceId;
static Preferences _wifiPrefs;
static String _setupPassword;
static void initializeSetupPassword();

// Portal state
static bool     _portalConnected = false;
static int      _connectResult = 0; // 0=idle, 1=pending, 2=success, 3=fail
static String   _connectSSID;
static String   _connectIP;

// Result page state
static bool     _showingResult = false;
static uint32_t _resultShownAt = 0;
static uint32_t _doneAt = 0;   // millis() of the /done click, 0 = not requested

// Activated mode: portal opened on a device that is already activated
static bool     _activatedMode = false;
static bool     _factoryResetRequested = false;
static uint32_t _resetGoAt = 0;   // millis() of the reset confirmation (grace to flush the response)

// Cached scan results
static String   _cachedScanHtml;
static String   _cachedScanJson = "[]";   // same list, for FORIQ-SCAN over USB
static uint32_t _cacheTime = 0;
static uint32_t _reconnectCount = 0;
static uint32_t _roamCount = 0;
static uint32_t _weakSince = 0;
static uint32_t _lastRoamScan = 0;

void WifiManager::begin(const String& deviceId) {
    _deviceId = deviceId;
    WiFi.mode(WIFI_STA);
    initializeSetupPassword();
}

// ─── Setup AP password ──────────────────────────────────────
// Older devices already stored a 12-character code in NVS (originally derived
// from the MAC and printed on labels). That format stays valid so those devices
// keep their code, but it is no longer generated.
static bool isValidLegacySetupPassword(const String& value) {
    if (value.length() != 12) return false;
    static const char CHARSET[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (int i = 0; i < 12; i++) {
        if (strchr(CHARSET, value[i]) == nullptr) return false;
    }
    return true;
}

// The code must consist of three simple lowercase ASCII words. The check is
// deliberately independent of the word pool, so existing codes stay valid if
// the pool ever changes.
static bool isValidWordSetupPassword(const String& value) {
    uint8_t words = 1;
    uint8_t wordLength = 0;
    for (size_t i = 0; i < value.length(); i++) {
        const char c = value[i];
        if (c >= 'a' && c <= 'z') {
            if (++wordLength > 20) return false;
        } else if (c == '-' && wordLength >= 2 && words < 3) {
            words++;
            wordLength = 0;
        } else {
            return false;
        }
    }
    return words == 3 && wordLength >= 2;
}

static bool isValidSetupPassword(const String& value) {
    return isValidLegacySetupPassword(value) || isValidWordSetupPassword(value);
}

// 280 easy-to-read words give over 21 million possible three-word codes; each
// position is drawn independently with esp_random().
// Do NOT translate or edit this list: the words are German on purpose, and the
// generated codes are printed on device labels and stored on existing devices.
static const char* const SETUP_WORD_POOL[] = {
    "acker", "ameise", "apfel", "auge", "bach", "balkon", "ball", "baum",
    "biene", "bild", "blatt", "blume", "boden", "boot", "brief", "brot",
    "bruecke", "buch", "bus", "dach", "dame", "dank", "decke", "dorf",
    "draht", "drache", "ecke", "eimer", "eisen", "ente", "erde", "faden",
    "falke", "feld", "fenster", "feuer", "fisch", "fluss", "form", "frage",
    "freund", "frost", "fuchs", "gabel", "garten", "gast", "glas", "gras",
    "hafen", "hammer", "hand", "haus", "hecke", "himmel", "holz", "hund",
    "insel", "jacke", "kaffee", "kabel", "kiste", "klang", "knopf", "lampe",
    "land", "licht", "luft", "loeffel", "loch", "mond", "morgen", "motor",
    "maus", "meer", "messer", "milch", "minute", "muenze", "nacht", "nase",
    "nest", "netz", "nord", "ohr", "paket", "papier", "pferd", "pflanze",
    "platz", "punkt", "rad", "regen", "ring", "rose", "rucksack", "sand",
    "schaf", "schale", "schiff", "schnee", "schrank", "schraube", "see", "seil",
    "stern", "stift", "strom", "stuhl", "tasse", "teller", "tier", "tor",
    "turm", "uhr", "vogel", "wagen", "wald", "wasser", "wind", "winter",
    "wolke", "wort", "wurzel", "zaun", "zeit", "zelt", "zug", "zweig",
    "aktiv", "anders", "arm", "bald", "bunt", "direkt", "dunkel", "ehrlich",
    "einfach", "eilig", "fein", "fest", "frisch", "froh", "ganz", "glatt",
    "gross", "gut", "hell", "hoch", "jung", "klar", "klein", "klug",
    "kurz", "langsam", "leer", "leicht", "leise", "neu", "offen", "ruhig",
    "sauber", "schnell", "schoen", "stark", "still", "warm", "weich", "weit",
    "wild", "zart", "zusammen", "zuerst", "kommen", "gehen", "fahren", "laufen",
    "drehen", "halten", "heben", "legen", "lesen", "machen", "messen", "malen",
    "merken", "oeffnen", "packen", "pruefen", "rechnen", "reden", "rollen", "sagen",
    "schauen", "schieben", "schreiben", "setzen", "singen", "spielen", "tragen", "teilen",
    "testen", "tippen", "treffen", "warten", "wechseln", "zeigen", "zahlen", "bauen",
    "bringen", "denken", "finden", "fragen", "hoeren", "holen", "kaufen", "kochen",
    "lachen", "lernen", "lieben", "liegen", "nehmen", "planen", "putzen", "reisen",
    "richtig", "sicher", "freundlich", "gemeinsam", "heute", "gestern", "immer", "wieder",
    "oben", "unten", "innen", "aussen", "links", "rechts", "vorne", "hinten",
    "eins", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht",
    "neun", "zehn", "sonne", "regenbogen", "sommer", "herbst", "fruehling", "abend",
    "aktivierung", "mittag", "pause", "runde", "seite", "mitte", "anfang", "ende",
    "start", "ziel", "weg", "pfad", "ort", "raum", "reihe", "gruppe",
    "farbe", "ton", "note", "zahl", "zeichen", "name", "plan", "idee"
};

static String generateRandomSetupPassword() {
    const size_t poolSize = sizeof(SETUP_WORD_POOL) / sizeof(SETUP_WORD_POOL[0]);
    String code;
    for (int i = 0; i < 3; i++) {
        if (i > 0) code += '-';
        code += SETUP_WORD_POOL[esp_random() % poolSize];
    }
    return code;
}

static void initializeSetupPassword() {
    Preferences setupPrefs;
    setupPrefs.begin("foriq-setup", false);
    String stored = setupPrefs.getString("code", "");
    String code = SecretStore::decrypt(stored);

    if (!isValidSetupPassword(code)) {
        code = generateRandomSetupPassword();
        setupPrefs.putString("code", SecretStore::encrypt(code));
        String persisted = SecretStore::decrypt(setupPrefs.getString("code", ""));
        if (persisted != code) {
            Serial.println("Setup code: failed to persist");
            code = "";
        } else {
            Serial.println("Setup code: generated (cryptographically random) and stored");
        }
    } else if (!SecretStore::isEncrypted(stored)) {
        setupPrefs.putString("code", SecretStore::encrypt(code));
    }
    setupPrefs.end();
    _setupPassword = code;
}

String WifiManager::getSetupPassword() {
    return _setupPassword;
}

// ─── Credential Storage (NVS JSON) ─────────────────────────

std::vector<WifiManager::Network> WifiManager::loadNetworks() {
    std::vector<Network> networks;
    _wifiPrefs.begin("wifi", true);
    String stored = _wifiPrefs.getString("networks", "[]");
    _wifiPrefs.end();

    // Detect legacy plaintext (stored by older firmware) -> migrate once.
    bool needsMigration = !SecretStore::isEncrypted(stored) && stored != "[]";
    String json = SecretStore::decrypt(stored);

    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return networks;

    JsonArray arr = doc.as<JsonArray>();
    for (JsonObject obj : arr) {
        Network n;
        n.ssid = obj["ssid"].as<String>();
        n.password = obj["password"].as<String>();
        if (n.ssid.length() > 0) networks.push_back(n);
    }

    // One-time encryption migration: plaintext -> ENC1 (first boot after the
    // update; afterwards the prefix matches and nothing is rewritten).
    if (needsMigration && !networks.empty()) {
        saveNetworks(networks);
        Serial.println("WiFi credentials migrated to encrypted storage.");
    }
    return networks;
}

void WifiManager::saveNetworks(const std::vector<Network>& networks) {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto& n : networks) {
        JsonObject obj = arr.add<JsonObject>();
        obj["ssid"] = n.ssid;
        obj["password"] = n.password;
    }
    String json;
    serializeJson(doc, json);
    _wifiPrefs.begin("wifi", false);
    _wifiPrefs.putString("networks", SecretStore::encrypt(json));
    _wifiPrefs.end();
}

void WifiManager::addNetwork(const String& ssid, const String& password) {
    auto networks = loadNetworks();
    // Remove existing with same SSID
    networks.erase(std::remove_if(networks.begin(), networks.end(),
        [&ssid](const Network& n) { return n.ssid == ssid; }), networks.end());
    networks.push_back({ssid, password});
    saveNetworks(networks);
    Serial.printf("Network '%s' added.\n", ssid.c_str());
}

void WifiManager::clearCredentials() {
    _wifiPrefs.begin("wifi", false);
    _wifiPrefs.clear();
    _wifiPrefs.end();
    Serial.println("WiFi credentials cleared.");
}

// ─── Radio Configuration ────────────────────────────────────

extern volatile bool configPowerSave;

void WifiManager::configureRadio() {
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    WiFi.setAutoReconnect(true);
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
    // Default is PS_NONE (no modem-sleep latency); PowerManager::applyPowerSaveMode()
    // switches to modem sleep later if power_save=true.
    WiFi.setSleep(configPowerSave ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
}

void WifiManager::applyRssiPowerSave() {
    if (!isConnected()) return;

    static bool _rssiBoostActive = false;
    static uint32_t _rssiGoodSince = 0;

    int rssi = getRSSI();
    uint32_t now = millis();

    if (rssi < WIFI_RSSI_WEAK_DBM) {
        if (!_rssiBoostActive) {
            WiFi.setSleep(WIFI_PS_NONE);
            _rssiBoostActive = true;
            _rssiGoodSince = 0;
            Serial.printf("WiFi: weak signal (%d dBm) -> PS_NONE\n", rssi);
        }
        return;
    }

    if (!_rssiBoostActive) return;

    if (rssi > WIFI_RSSI_GOOD_DBM) {
        if (_rssiGoodSince == 0) _rssiGoodSince = now;
        if (now - _rssiGoodSince >= WIFI_RSSI_PS_RESTORE_MS) {
            _rssiBoostActive = false;
            _rssiGoodSince = 0;
            WiFi.setSleep(configPowerSave ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
            Serial.printf("WiFi: signal good again (%d dBm) -> power save restored\n", rssi);
        }
    } else {
        _rssiGoodSince = 0;
    }
}

bool WifiManager::maybeRoam() {
    if (!isConnected()) {
        _weakSince = 0;
        return false;
    }

    uint32_t now = millis();
    int currentRssi = getRSSI();
    if (currentRssi >= WIFI_ROAM_RSSI_DBM) {
        _weakSince = 0;
        return false;
    }
    if (_weakSince == 0) _weakSince = now;
    if (now - _weakSince < WIFI_ROAM_HOLD_MS) return false;
    if (_lastRoamScan != 0 && now - _lastRoamScan < WIFI_ROAM_SCAN_INTERVAL_MS) return false;
    _lastRoamScan = now;

    auto saved = loadNetworks();
    if (saved.empty()) return false;
    uint8_t currentBssid[6] = {};
    const uint8_t* connectedBssid = WiFi.BSSID();
    if (connectedBssid) memcpy(currentBssid, connectedBssid, sizeof(currentBssid));

    Serial.printf("WiFi: %d dBm for %lus - looking for a better known AP\n",
                  currentRssi, (unsigned long)((now - _weakSince) / 1000UL));
    int found = WiFi.scanNetworks(false, true, false, 120);
    if (found <= 0) {
        WiFi.scanDelete();
        return false;
    }

    int bestScan = -1;
    int bestSaved = -1;
    int bestRssi = currentRssi;
    for (int i = 0; i < found; i++) {
        String ssid = WiFi.SSID(i);
        int rssi = WiFi.RSSI(i);
        const uint8_t* candidateBssid = WiFi.BSSID(i);
        if (!candidateBssid || memcmp(candidateBssid, currentBssid, sizeof(currentBssid)) == 0) {
            continue;
        }
        if (rssi < currentRssi + WIFI_ROAM_MIN_GAIN_DB) continue;
        for (size_t s = 0; s < saved.size(); s++) {
            if (saved[s].ssid == ssid && rssi > bestRssi) {
                bestScan = i;
                bestSaved = (int)s;
                bestRssi = rssi;
            }
        }
    }
    if (bestScan < 0) {
        WiFi.scanDelete();
        return false;
    }

    uint8_t targetBssid[6];
    const uint8_t* scannedBssid = WiFi.BSSID(bestScan);
    if (!scannedBssid) {
        WiFi.scanDelete();
        return false;
    }
    memcpy(targetBssid, scannedBssid, sizeof(targetBssid));
    int channel = WiFi.channel(bestScan);
    String targetSsid = saved[bestSaved].ssid;
    String targetPassword = saved[bestSaved].password;
    WiFi.scanDelete();

    _roamCount++;
    _reconnectCount++;
    _weakSince = 0;
    Serial.printf("WiFi: roaming to '%s' (%d -> %d dBm, channel %d)\n",
                  targetSsid.c_str(), currentRssi, bestRssi, channel);
    WiFi.begin(targetSsid.c_str(), targetPassword.c_str(), channel, targetBssid, true);
    return true;
}

void WifiManager::hardResetRadio() {
    Serial.println("WiFi radio hard reset...");
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    delay(2000);
}

bool WifiManager::isConnected() {
    return WiFi.status() == WL_CONNECTED;
}

int WifiManager::getRSSI() {
    if (WiFi.status() == WL_CONNECTED) {
        return WiFi.RSSI();
    }
    return 0;
}

uint32_t WifiManager::getReconnectCount() { return _reconnectCount; }
uint32_t WifiManager::getRoamCount() { return _roamCount; }

void WifiManager::disconnect() {
    WiFi.disconnect();
}

void WifiManager::disableRadio() {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
}

void WifiManager::enableSTA() {
    WiFi.mode(WIFI_STA);
}

// ─── Connection ─────────────────────────────────────────────

bool WifiManager::connect() {
    auto networks = loadNetworks();
    if (networks.empty()) {
        Serial.println("No WiFi credentials saved.");
        return false;
    }

    WiFi.mode(WIFI_STA);
    configureRadio();

    for (const auto& net : networks) {
        for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
            Serial.printf("Connecting to '%s' (attempt %d/%d)...\n",
                          net.ssid.c_str(), attempt + 1, MAX_RETRIES);
            WiFi.begin(net.ssid.c_str(), net.password.c_str());

            for (int i = 0; i < CONNECT_TIMEOUT_S; i++) {
                esp_task_wdt_reset();
                if (WiFi.status() == WL_CONNECTED) {
                    String ip = WiFi.localIP().toString();
                    if (ip != "0.0.0.0") {
                        Serial.printf("WiFi connected: %s\n", ip.c_str());
                        return true;
                    }
                }
                delay(1000);
            }

            Serial.printf("Connection to '%s' failed (attempt %d).\n",
                          net.ssid.c_str(), attempt + 1);
            WiFi.disconnect();
            delay(1000);
        }
    }

    Serial.println("No network reachable.");
    return false;
}

bool WifiManager::connectAnyNetwork(uint32_t timeoutPerNet) {
    auto networks = loadNetworks();
    if (networks.empty()) return false;

    if (WiFi.getMode() == WIFI_OFF) {
        WiFi.mode(WIFI_STA);
    }

    for (size_t i = 0; i < networks.size(); i++) {
        startReconnect(i);
        uint32_t start = millis();
        while (WiFi.status() != WL_CONNECTED) {
            esp_task_wdt_reset();
            if (millis() - start > timeoutPerNet) break;
            delay(500);
        }
        if (WiFi.status() == WL_CONNECTED) return true;
    }

    // All failed — hard reset and retry first
    hardResetRadio();
    startReconnect(0);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        esp_task_wdt_reset();
        if (millis() - start > 10000) break;
        delay(500);
    }
    return WiFi.status() == WL_CONNECTED;
}

void WifiManager::startReconnect(int networkIndex) {
    if (WiFi.status() == WL_CONNECTED) return;

    auto networks = loadNetworks();
    if (networks.empty()) return;

    int index = networkIndex % networks.size();
    const auto& net = networks[index];

    WiFi.disconnect();
    if (WiFi.getMode() == WIFI_OFF) {
        WiFi.mode(WIFI_STA);
    }
    configureRadio();
    _reconnectCount++;
    WiFi.begin(net.ssid.c_str(), net.password.c_str());
    Serial.printf("Reconnect started: '%s'\n", net.ssid.c_str());
}

// ─── Captive Portal ─────────────────────────────────────────
// Portal pages are localised client-side (see captive_portal_html.h): fragments
// built here are English and tag translatable text with data-t keys.

static void sendStatusPage(WebServer& server, const char* message) {
    String page = FPSTR(STATUS_PAGE);
    page.replace("%MESSAGE%", message);
    server.send(200, "text/html", page);
}

static String htmlEscape(const String& s) {
    String out;
    out.reserve(s.length());
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '&') out += "&amp;";
        else if (c == '<') out += "&lt;";
        else if (c == '>') out += "&gt;";
        else if (c == '"') out += "&quot;";
        else if (c == '\'') out += "&#39;";
        else out += c;
    }
    return out;
}

static String signalLabel(int rssi) {
    if (rssi > -60) return "<span class=\"sig\" style=\"color:#4CAF50\" data-t=\"sg\">good</span>";
    if (rssi > -70) return "<span class=\"sig\" style=\"color:#FFC107\" data-t=\"sm\">fair</span>";
    return "<span class=\"sig\" style=\"color:#F44336\" data-t=\"sw\">weak</span>";
}

static String scanNetworksHtml() {
    if (millis() - _cacheTime < 15000 && _cachedScanHtml.length() > 0) {
        return _cachedScanHtml;
    }

    int n = WiFi.scanNetworks();
    if (n < 0) return "<p style=\"color:#888;text-align:center\" data-t=\"nn\">No networks found.</p>";

    // Deduplicate by SSID, keep strongest signal
    struct NetEntry { String ssid; int rssi; };
    std::vector<NetEntry> unique;
    for (int i = 0; i < n; i++) {
        String ssid = WiFi.SSID(i);
        int rssi = WiFi.RSSI(i);
        if (ssid.length() == 0 || rssi < -85) continue;
        bool found = false;
        for (auto& e : unique) {
            if (e.ssid == ssid) {
                if (rssi > e.rssi) e.rssi = rssi;
                found = true;
                break;
            }
        }
        if (!found) unique.push_back({ssid, rssi});
    }

    // Sort by signal strength (strongest first)
    std::sort(unique.begin(), unique.end(),
        [](const NetEntry& a, const NetEntry& b) { return a.rssi > b.rssi; });

    String html;
    JsonDocument scanDoc;
    JsonArray scanArr = scanDoc.to<JsonArray>();
    for (const auto& e : unique) {
        JsonObject o = scanArr.add<JsonObject>();
        o["ssid"] = e.ssid;
        o["rssi"] = e.rssi;
        String escaped = htmlEscape(e.ssid);
        html += "<div class=\"net\" data-ssid=\"" + escaped + "\"><span>" +
                escaped + "<span class=\"chk\">&#10003;</span></span>" +
                signalLabel(e.rssi) + "</div>\n";
    }
    if (html.length() == 0) {
        html = "<p style=\"color:#888;text-align:center\" data-t=\"nr\">No networks found. Reload the page.</p>";
    }

    WiFi.scanDelete();
    _cachedScanJson = "";
    serializeJson(scanDoc, _cachedScanJson);
    _cachedScanHtml = html;
    _cacheTime = millis();
    return html;
}

static String urlDecode(const String& s) {
    String result;
    result.reserve(s.length());
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '+') {
            result += ' ';
        } else if (c == '%' && i + 2 < s.length()) {
            char hi = s[i + 1];
            char lo = s[i + 2];
            int val = 0;
            if (isxdigit(hi) && isxdigit(lo)) {
                val = (isdigit(hi) ? hi - '0' : toupper(hi) - 'A' + 10) * 16 +
                      (isdigit(lo) ? lo - '0' : toupper(lo) - 'A' + 10);
                result += (char)val;
                i += 2;
            } else {
                result += c;
            }
        } else {
            result += c;
        }
    }
    return result;
}

bool WifiManager::factoryResetRequested() {
    return _factoryResetRequested;
}

// Connection test inside the portal (blocks up to CONNECT_TIMEOUT_S). Used by
// the web form (/connect) and by the USB command FORIQ-WIFI.
static bool testConnection(const String& ssid, const String& password) {
    Serial.printf("Testing connection to '%s'...\n", ssid.c_str());
    WiFi.begin(ssid.c_str(), password.c_str());
    for (int i = 0; i < CONNECT_TIMEOUT_S; i++) {
        esp_task_wdt_reset();
        if (WiFi.status() == WL_CONNECTED) return true;
        delay(1000);
    }
    return false;
}

// FORIQ-WIFI {"ssid","password","server"} sent by the Foriq app over USB.
// On success it behaves like /connect + /done: save, close the portal, restart.
// The FORIQ-WIFI-OK/-FAIL lines and the fail reasons are parsed by app_flasher.py.
static void handleSerialWifi(const String& json) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) {
        Serial.println("FORIQ-WIFI-FAIL json");
        return;
    }
    String ssid = doc["ssid"] | "";
    String password = doc["password"] | "";
    String serverUrl = ServerConfig::normalize(doc["server"] | "");
    if (ssid.length() == 0) {
        Serial.println("FORIQ-WIFI-FAIL json");
        return;
    }
    if (serverUrl.length() > 0 && !ServerConfig::isValidUrl(serverUrl)) {
        Serial.println("FORIQ-WIFI-FAIL server");
        return;
    }
    if (!testConnection(ssid, password)) {
        WiFi.disconnect(false);
        Serial.println("FORIQ-WIFI-FAIL connect");
        return;
    }
    WifiManager::addNetwork(ssid, password);
    ServerConfig::save(serverUrl);   // empty = default
    _connectSSID = ssid;
    _connectIP = WiFi.localIP().toString();
    _connectResult = 2;
    _portalConnected = true;
    Serial.printf("FORIQ-WIFI-OK %s\n", _connectIP.c_str());
    Serial.flush();
}

void WifiManager::startPortal(uint32_t timeoutMs, bool activatedMode, void (*idleCb)()) {
    Serial.printf("Starting Captive Portal%s...\n", activatedMode ? " (activated mode)" : "");
    _activatedMode = activatedMode;
    _factoryResetRequested = false;
    _resetGoAt = 0;
    String apPass = getSetupPassword();
    if (!isValidSetupPassword(apPass)) {
        Serial.println("Captive portal refused: no persisted setup code");
        return;
    }

    // Initial scan before AP takes radio
    WiFi.mode(WIFI_STA);
    scanNetworksHtml();

    // Start AP: WPA2-PSK with a per-device password (EN 18031: no open
    // provisioning channel). In the Arduino core, softAP() with a passphrase of
    // at least 8 characters selects WIFI_AUTH_WPA2_PSK.
    WiFi.mode(WIFI_AP_STA);
    IPAddress apIP(192, 168, 4, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    WiFi.softAP(AP_SSID, apPass.c_str());
    delay(500);
    Serial.printf("AP started: %s (WPA2, setup password: %s)\n", AP_SSID, apPass.c_str());

    // DNS server — redirect all domains to portal
    DNSServer dnsServer;
    dnsServer.start(53, "*", apIP);

    // Web server
    WebServer server(80);
    _portalConnected = false;
    _connectResult = 0;
    _doneAt = 0;

    // GET / — scan page
    server.on("/", HTTP_GET, [&server]() {
        String networks = scanNetworksHtml();
        String page = FPSTR(PORTAL_PAGE);
        page.replace("%NETWORKS%", networks);
        page.replace("%SERVER%", htmlEscape(ServerConfig::storedUrl()));
        // Activated devices: offer the local reset (e.g. when replacing a device).
        page.replace("%RESET_SECTION%", _activatedMode
            ? "<a class=\"reset\" href=\"/reset\" data-t=\"rl\">Replace device (resets the registration)</a>"
            : "");
        server.send(200, "text/html", page);
    });

    // Reset flow (activated devices only): confirmation page + execution.
    // factoryReset() itself runs in the caller (layering); here we only set the
    // flag and leave the portal loop.
    server.on("/reset", HTTP_GET, [&server]() {
        if (!_activatedMode) {
            server.sendHeader("Location", "/");
            server.send(302, "text/plain", "");
            return;
        }
        server.send(200, "text/html", FPSTR(RESET_CONFIRM_PAGE));
    });
    server.on("/reset-go", HTTP_POST, [&server]() {
        if (!_activatedMode) {
            server.sendHeader("Location", "/");
            server.send(302, "text/plain", "");
            return;
        }
        sendStatusPage(server, "<span data-t=\"rr\">Deleting the local registration. The device is restarting...</span>");
        Serial.println("Portal: factory reset confirmed by user");
        _resetGoAt = millis();
    });

    // POST /connect — start connection test
    server.on("/connect", HTTP_POST, [&server]() {
        String ssid = urlDecode(server.arg("ssid"));
        String password = urlDecode(server.arg("password"));
        String serverUrl = ServerConfig::normalize(urlDecode(server.arg("server")));

        if (ssid.length() == 0) {
            String page = FPSTR(RESULT_PAGE);
            page.replace("%STATUS_CLASS%", "err");
            page.replace("%MESSAGE%", "<span data-t=\"ns\">No network selected.</span>");
            page.replace("%EXTRA%", "<a href=\"/\" data-t=\"bk\">Back</a>");
            server.send(200, "text/html", page);
            return;
        }
        if (serverUrl.length() > 0 && !ServerConfig::isValidUrl(serverUrl)) {
            String page = FPSTR(RESULT_PAGE);
            page.replace("%STATUS_CLASS%", "err");
            page.replace("%MESSAGE%", "<span data-t=\"is\">Invalid server address. Only http:// to local addresses (foriq.local, 192.168.x.x), no https.</span>");
            page.replace("%EXTRA%", "<a href=\"/\" data-t=\"bk\">Back</a>");
            server.send(200, "text/html", page);
            return;
        }

        _connectSSID = ssid;
        _connectResult = 1; // pending

        String page = FPSTR(CONNECTING_PAGE);
        String escaped = htmlEscape(ssid);
        page.replace("%SSID%", escaped);
        server.send(200, "text/html", page);

        // Test connection (blocking ~20s)
        bool success = testConnection(ssid, password);

        if (success) {
            addNetwork(ssid, password);
            ServerConfig::save(serverUrl);   // empty = default
            _connectIP = WiFi.localIP().toString();
            _connectResult = 2; // success
        } else {
            _connectResult = 3; // fail
        }
    });

    // GET /result — show connection result
    server.on("/result", HTTP_GET, [&server]() {
        if (_connectResult <= 1) {
            // Still pending
            String page = FPSTR(CONNECTING_PAGE);
            page.replace("%SSID%", "...");
            server.send(200, "text/html", page);
            return;
        }

        String page = FPSTR(RESULT_PAGE);
        if (_connectResult == 2) {
            page.replace("%STATUS_CLASS%", "ok");
            page.replace("%MESSAGE%", "<span data-t=\"ok\">Connected to</span> '" + htmlEscape(_connectSSID) +
                         "'!<br>IP: " + _connectIP);
            String extra;
            if (_activatedMode) {
                // Activated device: stays registered and keeps its configuration,
                // so no serial-number instructions are needed.
                extra = "<div class=\"hint\" data-t=\"ah\"><b>Done!</b> The device keeps its "
                        "existing configuration and will be back online shortly.</div>"
                        "<a class=\"done\" href=\"/done\" data-t=\"dn\">Done</a>";
            } else if (_deviceId.length() > 0) {
                // The device registers itself with the Foriq app, where it is
                // approved under "New sensors". The serial number is shown for matching.
                extra = "<div class=\"device-add\">"
                        "<div class=\"serial-row\"><span data-t=\"sn\">Serial number:</span>"
                        "<strong id=\"sn-value\">" + _deviceId + "</strong></div>"
                        "<div class=\"copy-actions\">"
                        "<button type=\"button\" class=\"cp\" onclick=\"cp('sn-value',this)\" data-t=\"cs\">Copy serial number</button>"
                        "</div></div>"
                        "<div class=\"hint\" data-t=\"nh\">Then close this window, disconnect "
                        "from the <b>Foriq-Setup</b> WiFi and approve the sensor in the Foriq "
                        "app under <b>New sensors</b>.</div>"
                        "<a class=\"done\" href=\"/done\" data-t=\"fs\">Finish setup</a>"
                        "<script>"
                        "function cp(id,b){"
                        "var t=document.getElementById(id).textContent;"
                        "function ok(){var o=b.textContent;b.textContent=D.cpd||'Copied!';"
                        "setTimeout(function(){b.textContent=o},2000)}"
                        "if(navigator.clipboard&&navigator.clipboard.writeText){"
                        "navigator.clipboard.writeText(t).then(ok).catch(fb)}else{fb()}"
                        "function fb(){"
                        "var a=document.createElement('textarea');"
                        "a.value=t;a.style.position='fixed';a.style.left='-9999px';"
                        "document.body.appendChild(a);a.select();"
                        "document.execCommand('copy');document.body.removeChild(a);ok()}"
                        "}"
                        "</script>";
            }
            page.replace("%EXTRA%", extra);
            server.send(200, "text/html", page);
            _showingResult = true;
            _resultShownAt = millis();
        } else {
            page.replace("%STATUS_CLASS%", "err");
            page.replace("%MESSAGE%", "<span data-t=\"f1\">Could not connect to</span> '" +
                         htmlEscape(_connectSSID) + "'<span data-t=\"f2\">.</span><br>"
                         "<span data-t=\"f3\">Check the password and try again.</span>");
            page.replace("%EXTRA%", "<a href=\"/\" data-t=\"bk\">Back</a>");
            server.send(200, "text/html", page);
            _connectResult = 0;
        }
    });

    // GET /done — user finished copying serial number
    server.on("/done", HTTP_GET, [&server]() {
        sendStatusPage(server, "<span data-t=\"rs\">Restarting the device...</span>");
        _doneAt = millis();   // start the grace period so the response reaches the client
    });

    // Catch-all for captive portal detection
    server.onNotFound([&server, &apIP]() {
        server.sendHeader("Location", "http://" + apIP.toString() + "/");
        server.send(302, "text/plain", "");
    });

    server.begin();

    // Background reconnect state
    auto credentials = loadNetworks();
    int retryIndex = 0;
    int retryCount = 0;
    uint32_t retryStart = 0;
    bool retryActive = false;
    uint32_t lastRetry = millis();
    const uint32_t RETRY_INTERVAL = 10000;
    const uint32_t RETRY_TIMEOUT = 10000;

    if (!credentials.empty()) {
        Serial.printf("Background reconnect active (%d network(s))\n", credentials.size());
    }

    uint32_t portalStart = millis();

    while (!_portalConnected) {
        if (millis() - portalStart >= timeoutMs) {
            Serial.printf("Portal timeout (%lus) - closing.\n", timeoutMs / 1000);
            break;
        }

        esp_task_wdt_reset();
        dnsServer.processNextRequest();
        server.handleClient();

        // USB commands from the Foriq app (FORIQ-INFO, FORIQ-SCAN, FORIQ-WIFI)
        String cmdLine;
        if (SerialCmd::poll(cmdLine)) {
            if (cmdLine == "FORIQ-INFO") {
                SerialCmd::printInfo();
            } else if (cmdLine == "FORIQ-SCAN") {
                scanNetworksHtml();   // refreshes the cache after 15 s
                Serial.printf("FORIQ-SCAN %s\n", _cachedScanJson.c_str());
            } else if (cmdLine.startsWith("FORIQ-WIFI ")) {
                handleSerialWifi(cmdLine.substring(11));
                if (_portalConnected) break;
            }
        }

        // Caller hook (e.g. persist RAM hits to SPIFFS so that counting, which
        // keeps running on core 1, loses nothing while the portal is open)
        if (idleCb) idleCb();

        // Factory reset confirmed: let the response flush, then leave the
        // portal; the caller checks factoryResetRequested().
        if (_resetGoAt != 0) {
            if (millis() - _resetGoAt >= 800) {
                _factoryResetRequested = true;
                break;
            }
            delay(1);
            continue;
        }

        // Result page shown — keep serving but skip reconnect
        if (_showingResult) {
            if (_doneAt != 0) {                       // "Finish setup" clicked
                if (millis() - _doneAt >= 800) {      // flush the response for ~0.8 s, then close
                    _portalConnected = true;
                }
                delay(1);
                continue;
            }
            if (millis() - _resultShownAt >= 120000) {
                _portalConnected = true;
            }
            delay(1);
            continue;
        }

        // Background reconnect
        if (credentials.empty()) continue;

        uint32_t now = millis();
        if (retryActive) {
            if (WiFi.status() == WL_CONNECTED) {
                Serial.printf("Reconnect successful: %s\n", WiFi.localIP().toString().c_str());
                _portalConnected = true;
                break;
            }
            if (now - retryStart >= RETRY_TIMEOUT) {
                retryActive = false;
                retryCount++;
                if (retryCount >= MAX_RETRIES) {
                    retryCount = 0;
                    retryIndex = (retryIndex + 1) % credentials.size();
                }
                lastRetry = now;
            }
        } else if (now - lastRetry >= RETRY_INTERVAL) {
            // Don't retry right after a scan
            if (now - _cacheTime < 5000) continue;
            const auto& cred = credentials[retryIndex];
            if (cred.ssid.length() > 0) {
                Serial.printf("Reconnect attempt: '%s' (%d/%d)...\n",
                              cred.ssid.c_str(), retryCount + 1, MAX_RETRIES);
                WiFi.begin(cred.ssid.c_str(), cred.password.c_str());
                retryStart = now;
                retryActive = true;
            } else {
                retryIndex = (retryIndex + 1) % credentials.size();
                retryCount = 0;
            }
        }

        delay(1);
    }

    server.stop();
    dnsServer.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    _showingResult = false;
    Serial.println("Captive Portal closed.");

    if (_portalConnected && _connectResult == 2) {
        ESP.restart();
    }
}
