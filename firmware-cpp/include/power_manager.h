#pragma once
#include <Arduino.h>

namespace PowerManager {
    // Turns the backlight off immediately (GPIO LOW). Called at the very start
    // of setup() so the display is already dark during the captive portal and
    // Wi-Fi connect (init() only runs after setup is complete).
    void displayOff();
    void init();
    // Disables LiPo charging in the M5PM1.
    // Must run once per boot after Wire.begin() (Accel::init()).
    void disableCharging();
    // Switches all power-save paths at runtime (CPU frequency, backlight,
    // Wi-Fi modem sleep). Called by the settings sync when power_save_mode
    // changes.
    void applyPowerSaveMode(bool enabled);
    void enterSleep(const String& deviceToken);
    void exitSleep();
    void sleepWifiCheck(const String& deviceToken);
    String wifiDutyCycle(const String& deviceToken);
    uint32_t getSleepWifiCheckMs();
}
