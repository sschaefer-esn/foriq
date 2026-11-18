#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace Commands {
    void processCommand(JsonObject cmd, const String& deviceToken);
}
