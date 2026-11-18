#pragma once
#include <Arduino.h>

namespace OtaUpdater {
    bool checkAndUpdate(const String& deviceToken, const String& commandId = "");
}
