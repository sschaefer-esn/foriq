#pragma once
#include <Arduino.h>

namespace TimeSync {
    void   init();
    void   calibrateFromNtp();
    void   calibrateFromServer(uint64_t serverTimeMs);
    String ticksToTimestamp(uint32_t ticksMs);
    uint32_t ticksToEpoch(uint32_t ticksMs);
    void     ticksToEpochWithMs(uint32_t ticksMs, uint32_t& outEpochS, uint16_t& outMs);
    void   getCurrentUTC(int& hour, int& minute, int& wday);
    void   ntpResync();
    bool   isServerCalibrated();
    bool   isCalibrated();
}
