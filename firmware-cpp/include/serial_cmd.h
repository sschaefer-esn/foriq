#pragma once
#include <Arduino.h>

// Line-based USB commands from the Foriq app (firmware-cpp/tools/app_flasher.py):
//   FORIQ-INFO                       → FORIQ-INFO {"serial","setup","fw","target","wifi","activated"}
//   FORIQ-SCAN                       → FORIQ-SCAN [{"ssid","rssi"}]  setup portal only
//   FORIQ-WIFI {"ssid","password","server"}  setup portal only (wifi_manager.cpp)
//                                    → FORIQ-WIFI-OK <ip> | FORIQ-WIFI-FAIL <reason>
namespace SerialCmd {
    // Non-blocking: true once a complete line is in `line`.
    bool poll(String& line);
    void printInfo();
    // For the main loop: answers FORIQ-INFO, ignores everything else.
    void handleIdle();
}
