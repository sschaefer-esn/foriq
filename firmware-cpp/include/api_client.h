#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace ApiClient {
    // Settings sync (bidirectional)
    bool settingsSync(const String& deviceToken);

    // Binary hit transmission v4 (36 B, boot_id + event_sequence)
    String sendHitsBinary(const uint8_t* data, int bytes, const String& deviceToken);

    // Shared retry backoff for hit uploads (429/5xx/network errors).
    bool hitUploadReady();
    uint32_t hitUploadRetryInMs();
    uint32_t getHitLastUploadMs();
    uint32_t getHitLastSuccessMs();
    uint32_t getHitMaxUploadMs();
    uint32_t getHitHttpErrorCount();

    // Command result (result: optional result text, e.g. the setup password)
    void reportCommandResult(const String& commandId, bool success, const String& deviceToken,
                             const String& result = "");

    // OTA progress. detail = optional failure cause (Update.errorString(),
    // HTTP code, free heap) — stored with the command in the backend and shown in the UI.
    // Returns true while the server still considers the update active. false =
    // abort signal (command cancelled/timed out) → abort the running OTA.
    bool reportOtaProgress(const String& commandId, const String& progress,
                           const String& deviceToken, const String& detail = "");

    // 401 tracking
    int  getConsecutive401s();
    void resetConsecutive401s();
}
