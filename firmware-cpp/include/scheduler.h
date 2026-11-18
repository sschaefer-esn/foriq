#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace Scheduler {
    void updatePlan(JsonObject plan);
    void check(const String& deviceToken);
    bool hasPlan();
}
