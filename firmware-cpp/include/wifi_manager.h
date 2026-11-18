#pragma once
#include <Arduino.h>
#include <vector>

namespace WifiManager {
    struct Network {
        String ssid;
        String password;
    };

    void   begin(const String& deviceId);
    // Random WPA2 password, persisted in its own NVS namespace.
    String getSetupPassword();
    bool   connect();
    bool   connectAnyNetwork(uint32_t timeoutPerNet = 8000);
    void   startReconnect(int networkIndex = 0);
    // activatedMode: portal for already activated devices — non-destructive
    // (token/config are kept); the page additionally offers a factory reset
    // (result via factoryResetRequested()).
    // idleCb is called on every portal loop iteration (core 0) so the caller
    // can e.g. persist RAM hits to SPIFFS.
    void   startPortal(uint32_t timeoutMs = 600000, bool activatedMode = false,
                       void (*idleCb)() = nullptr);
    // true once the user has confirmed a factory reset in the portal.
    // The caller runs DeviceIdentity::factoryReset() (layering).
    bool   factoryResetRequested();
    void   hardResetRadio();
    void   configureRadio();
    void   applyRssiPowerSave();
    // On persistently very weak signal, switch to a clearly better known
    // AP/BSSID. Returns true if a roam was started.
    bool   maybeRoam();
    bool   isConnected();
    int    getRSSI();
    uint32_t getReconnectCount();
    uint32_t getRoamCount();

    // Credential management (local only — setup portal / USB)
    std::vector<Network> loadNetworks();
    void saveNetworks(const std::vector<Network>& networks);
    void addNetwork(const String& ssid, const String& password);
    void clearCredentials();

    void disconnect();
    void disableRadio();
    void enableSTA();
}
