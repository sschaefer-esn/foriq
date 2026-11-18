#include "serial_cmd.h"
#include "config.h"
#include "device_identity.h"
#include "wifi_manager.h"
#include <ArduinoJson.h>

static String _buf;
static bool   _overflow = false;
static const size_t MAX_LINE = 512;

bool SerialCmd::poll(String& line) {
    while (Serial.available() > 0) {
        char c = (char)Serial.read();
        if (c == '\r') continue;
        if (c == '\n') {
            bool ok = !_overflow && _buf.length() > 0;
            line = _buf;
            _buf = "";
            _overflow = false;
            if (ok) return true;
            continue;
        }
        if (_buf.length() >= MAX_LINE) {
            _overflow = true;   // line too long → discard until end of line
            continue;
        }
        _buf += c;
    }
    return false;
}

void SerialCmd::printInfo() {
    JsonDocument doc;
    doc["serial"] = DeviceIdentity::getOrCreateDeviceId();
    doc["setup"] = WifiManager::getSetupPassword();
    doc["fw"] = FIRMWARE_VERSION;
    doc["target"] = FIRMWARE_TARGET;
    doc["wifi"] = !WifiManager::loadNetworks().empty();
    doc["activated"] = DeviceIdentity::loadDeviceToken().length() > 0;
    String out;
    serializeJson(doc, out);
    Serial.printf("FORIQ-INFO %s\n", out.c_str());
}

void SerialCmd::handleIdle() {
    String line;
    if (poll(line) && line == "FORIQ-INFO") printInfo();
}
