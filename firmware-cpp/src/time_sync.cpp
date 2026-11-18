#include "time_sync.h"
#include "config.h"
#include <time.h>
#include <sys/time.h>

static uint32_t _calTicksMs = 0;
static time_t   _calEpochS = 0;
static int      _calSubMs = 0;
static bool     _serverCalibrated = false;
static uint32_t _lastNtpSync = 0;

void TimeSync::init() {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    Serial.println("NTP sync started...");
    // Wait up to 10 seconds for time to be set
    struct tm timeinfo;
    for (int i = 0; i < 20; i++) {
        if (getLocalTime(&timeinfo, 500)) {
            Serial.printf("NTP sync OK: %04d-%02d-%02d %02d:%02d:%02d\n",
                          timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
                          timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
            calibrateFromNtp();
            _lastNtpSync = millis();
            return;
        }
    }
    Serial.println("NTP sync failed - using rough calibration.");
    // Rough calibration with current time
    _calEpochS = time(nullptr);
    _calSubMs = 0;
    _calTicksMs = millis();
}

void TimeSync::calibrateFromNtp() {
    // Wait for second boundary for precise alignment
    time_t t = time(nullptr);
    int attempts = 0;
    while (time(nullptr) == t && attempts++ < 2000) {
        delayMicroseconds(500);
    }
    _calEpochS = time(nullptr);
    _calSubMs = 0;
    _calTicksMs = millis();
    Serial.printf("Ticks calibrated (NTP): epoch=%ld\n", (long)_calEpochS);
}

void TimeSync::calibrateFromServer(uint64_t serverTimeMs) {
    _calEpochS = (time_t)(serverTimeMs / 1000ULL);
    _calSubMs = (int)(serverTimeMs % 1000ULL);
    _calTicksMs = millis();
    _serverCalibrated = true;
    Serial.printf("Ticks calibrated (Server): epoch=%ld.%03d\n", (long)_calEpochS, _calSubMs);
}

String TimeSync::ticksToTimestamp(uint32_t ticksMs) {
    int32_t diffMs = (int32_t)(ticksMs - _calTicksMs); // unsigned subtraction handles wrap
    int32_t totalSub = _calSubMs + diffMs;
    time_t epochS = _calEpochS + totalSub / 1000;
    int ms = totalSub % 1000;
    if (ms < 0) {
        ms += 1000;
        epochS -= 1;
    }

    struct tm t;
    gmtime_r(&epochS, &t);

    char buf[30];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
             t.tm_hour, t.tm_min, t.tm_sec, ms);
    return String(buf);
}

uint32_t TimeSync::ticksToEpoch(uint32_t ticksMs) {
    int32_t diffMs = (int32_t)(ticksMs - _calTicksMs);
    int32_t totalSub = _calSubMs + diffMs;
    time_t epochS = _calEpochS + totalSub / 1000;
    return (uint32_t)epochS;
}

void TimeSync::ticksToEpochWithMs(uint32_t ticksMs, uint32_t& outEpochS, uint16_t& outMs) {
    int32_t diffMs = (int32_t)(ticksMs - _calTicksMs);
    int32_t totalSub = _calSubMs + diffMs;
    time_t epochS = _calEpochS + totalSub / 1000;
    int ms = totalSub % 1000;
    if (ms < 0) {
        ms += 1000;
        epochS -= 1;
    }
    outEpochS = (uint32_t)epochS;
    outMs = (uint16_t)ms;
}

void TimeSync::getCurrentUTC(int& hour, int& minute, int& wday) {
    if (_calEpochS == 0) {
        // Fallback before calibration
        struct tm t;
        time_t now = time(nullptr);
        gmtime_r(&now, &t);
        hour = t.tm_hour;
        minute = t.tm_min;
        wday = t.tm_wday == 0 ? 7 : t.tm_wday; // ISO weekday (1=Mon, 7=Sun)
        return;
    }
    int32_t diffMs = (int32_t)(millis() - _calTicksMs);
    time_t epochS = _calEpochS + (_calSubMs + diffMs) / 1000;
    struct tm t;
    gmtime_r(&epochS, &t);
    hour = t.tm_hour;
    minute = t.tm_min;
    wday = t.tm_wday == 0 ? 7 : t.tm_wday;
}

void TimeSync::ntpResync() {
    if (millis() - _lastNtpSync < NTP_RESYNC_MS) return;
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 5000)) {
        if (!_serverCalibrated) {
            calibrateFromNtp();
        }
        _lastNtpSync = millis();
    }
}

bool TimeSync::isServerCalibrated() {
    return _serverCalibrated;
}

bool TimeSync::isCalibrated() {
    // Calibrated if epoch is after 2020-01-01 (either NTP or server)
    return _calEpochS > 1577836800;
}
