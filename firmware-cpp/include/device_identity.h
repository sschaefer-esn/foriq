#pragma once
#include <Arduino.h>

namespace DeviceIdentity {
    String getOrCreateDeviceId();
    String loadDeviceToken();
    void   saveDeviceToken(const String& token);
    String activateDevice(const String& deviceId);
    void   factoryReset();

    // Recovery counter
    int  readRecoveryCount();
    void incrementRecovery(const char* reason);
    void resetRecovery();
}
