#include "scheduler.h"
#include "config.h"
#include "time_sync.h"
#include "hit_buffer.h"

// Stored plan
static bool _hasPlan = false;
static int  _planDays[7];
static int  _planDayCount = 0;
static int  _planHour = 0;
static int  _planMinute = 0;

void Scheduler::updatePlan(JsonObject plan) {
    if (plan.isNull()) {
        _hasPlan = false;
        return;
    }
    JsonArray days = plan["days"].as<JsonArray>();
    const char* timeStr = plan["time"];
    if (!timeStr || days.isNull()) {
        _hasPlan = false;
        return;
    }

    _planDayCount = 0;
    for (JsonVariant d : days) {
        if (_planDayCount < 7) {
            _planDays[_planDayCount++] = d.as<int>();
        }
    }

    // Parse "HH:MM"
    String t(timeStr);
    int colonIdx = t.indexOf(':');
    if (colonIdx > 0) {
        _planHour = t.substring(0, colonIdx).toInt();
        _planMinute = t.substring(colonIdx + 1).toInt();
    }

    _hasPlan = (_planDayCount > 0);
    if (_hasPlan) {
        Serial.printf("Restart plan: days=[");
        for (int i = 0; i < _planDayCount; i++) {
            Serial.printf("%d%s", _planDays[i], (i < _planDayCount - 1) ? "," : "");
        }
        Serial.printf("] time=%02d:%02d\n", _planHour, _planMinute);
    }
}

bool Scheduler::hasPlan() {
    return _hasPlan;
}

void Scheduler::check(const String& deviceToken) {
    if (!_hasPlan) return;

    TimeSync::ntpResync();

    if (!TimeSync::isCalibrated()) {
        Serial.println("Scheduler: skipping — time not calibrated");
        return;
    }

    int hour, minute, wday;
    TimeSync::getCurrentUTC(hour, minute, wday);

    // Check if current day matches
    bool dayMatch = false;
    for (int i = 0; i < _planDayCount; i++) {
        if (_planDays[i] == wday) {
            dayMatch = true;
            break;
        }
    }
    if (!dayMatch) return;

    // Check time within +-1 minute
    int planMinutes = _planHour * 60 + _planMinute;
    int currentMinutes = hour * 60 + minute;
    int diff = abs(currentMinutes - planMinutes);
    if (diff > 720) diff = 1440 - diff; // Midnight wrap

    if (diff <= 1) {
        Serial.printf("Scheduled restart (%02d:%02d UTC, current %02d:%02d)\n",
                      _planHour, _planMinute, hour, minute);
        // Flush buffer before restart
        // Note: flushing is handled by main.cpp before calling ESP.restart()
        delay(2000);
        ESP.restart();
    }
}
