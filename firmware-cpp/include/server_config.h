#pragma once
#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClient.h>

// Server address configured at runtime (NVS "foriq"/"server_url") instead of
// being compiled in.
//
// Set via the setup portal ("Server" field, optional) or USB (FORIQ-WIFI). Without a valid stored address FORIQ_LOCAL_URL
// applies (http://foriq.local:8420, the Foriq app). Plain HTTP into the local
// network only; https:// is rejected (no TLS in the firmware).
namespace ServerConfig {
    void begin();                       // once, early in setup(), before any request
    const String& url();                // effective base URL without trailing '/'
    String storedUrl();                 // stored address only ("" = default)
    bool isValidUrl(const String& url); // http://host[:port], local hosts only
    bool isLocalHost(const String& url);// *.local or private/link-local IPv4
    String normalize(const String& url);
    bool save(const String& url);       // "" clears → default
    // Starts an HTTP request; rejects anything but http:// into the local network.
    bool httpBegin(HTTPClient& http, WiFiClient& client, const String& url);
    // Checks whether the server at `url` accepts this device token. Guards
    // against switching to a server that does not know the device (its 401s
    // would trigger a factory reset after FACTORY_RESET_AFTER_401).
    // Not called at the moment (the remote server switch was removed in 14.0.2);
    // kept for a future server-switch path.
    bool probe(const String& url, const String& deviceToken, String& error);
}
