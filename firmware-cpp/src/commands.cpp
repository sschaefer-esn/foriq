#include "commands.h"
#include "config.h"
#include "wifi_manager.h"
#include "ota_updater.h"
#include "api_client.h"
#include <esp_task_wdt.h>

void Commands::processCommand(JsonObject cmd, const String& deviceToken) {
    String command = cmd["command"].as<String>();
    String commandId = cmd["id"].as<String>();

    Serial.printf("Command: %s\n", command.c_str());

    if (command == "restart") {
        Serial.println("Restart via remote command...");
        ApiClient::reportCommandResult(commandId, true, deviceToken);
        delay(1000);
        ESP.restart();

    } else if (command == "ota_update") {
        OtaUpdater::checkAndUpdate(deviceToken, commandId);

    } else if (command == "wifi_reset") {
        Serial.println("WiFi reset via remote command...");
        WifiManager::clearCredentials();
        delay(1000);
        ESP.restart();

    } else if (command == "get_setup_password") {
        ApiClient::reportCommandResult(commandId, true, deviceToken,
                                       WifiManager::getSetupPassword());

    } else {
        Serial.printf("Unknown command: %s\n", command.c_str());
    }
}
