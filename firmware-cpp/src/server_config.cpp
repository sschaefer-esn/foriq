#include "server_config.h"
#include "config.h"
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiClient.h>

static String _url;

static String hostOf(const String& url) {
    int start = url.indexOf("://");
    if (start < 0) return "";
    start += 3;
    int end = start;
    while (end < (int)url.length() && url[end] != '/' && url[end] != ':') end++;
    String host = url.substring(start, end);
    host.toLowerCase();
    return host;
}

// Plain HTTP into the local network only: *.local and private/link-local IPv4.
bool ServerConfig::isLocalHost(const String& url) {
    String host = hostOf(url);
    if (host.endsWith(".local")) return true;
    int a, b, c, d;
    char tail;
    if (sscanf(host.c_str(), "%d.%d.%d.%d%c", &a, &b, &c, &d, &tail) != 4) return false;
    if (a == 10 || a == 127) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    if (a == 169 && b == 254) return true;
    return false;
}

String ServerConfig::normalize(const String& url) {
    String u = url;
    u.trim();
    while (u.endsWith("/")) u.remove(u.length() - 1);
    // Portal convenience: "foriq.local" or "192.168.1.5" without a scheme means
    // the local Foriq app; append the default port if none is given.
    if (u.length() > 0 && u.indexOf("://") < 0) {
        u = "http://" + u;
        if (hostOf(u).length() > 0 && u.indexOf(':', 7) < 0) {
            int slash = u.indexOf('/', 7);
            String port = String(":") + FORIQ_LOCAL_PORT;
            u = slash < 0 ? u + port : u.substring(0, slash) + port + u.substring(slash);
        }
    }
    return u;
}

// The firmware only speaks plain HTTP to the local Foriq app (no TLS):
// https:// and public hosts are rejected.
bool ServerConfig::isValidUrl(const String& url) {
    if (url.length() < 10 || url.length() > 120) return false;
    if (url.indexOf(' ') >= 0) return false;
    if (!url.startsWith("http://")) return false;
    if (hostOf(url).length() == 0) return false;
    return isLocalHost(url);
}

bool ServerConfig::httpBegin(HTTPClient& http, WiFiClient& client, const String& url) {
    if (!url.startsWith("http://") || !isLocalHost(url)) {
        Serial.printf("HTTP: address rejected (http:// into the local network only): %s\n", url.c_str());
        return false;
    }
    client.setNoDelay(true);
    return http.begin(client, url);
}

void ServerConfig::begin() {
    Preferences prefs;
    prefs.begin("foriq", true);
    String stored = prefs.getString("server_url", "");
    prefs.end();

    // Invalid stored addresses (e.g. https:// or a public host) are ignored —
    // the device looks for the Foriq app instead.
    if (stored.length() > 0 && isValidUrl(stored)) {
        _url = stored;
        Serial.printf("Server: %s (stored)\n", _url.c_str());
    } else {
        _url = FORIQ_LOCAL_URL;
        if (stored.length() > 0) {
            Serial.printf("Server: stored address %s invalid (local http:// only) - using default %s\n",
                          stored.c_str(), _url.c_str());
        } else {
            Serial.printf("Server: %s (default)\n", _url.c_str());
        }
    }
}

const String& ServerConfig::url() {
    return _url;
}

String ServerConfig::storedUrl() {
    Preferences prefs;
    prefs.begin("foriq", true);
    String stored = prefs.getString("server_url", "");
    prefs.end();
    return stored;
}

bool ServerConfig::save(const String& url) {
    String u = normalize(url);
    if (u.length() > 0 && !isValidUrl(u)) return false;
    Preferences prefs;
    prefs.begin("foriq", false);
    if (u.length() == 0) prefs.remove("server_url");
    else prefs.putString("server_url", u);
    prefs.end();
    begin();
    return true;
}

bool ServerConfig::probe(const String& url, const String& deviceToken, String& error) {
    String u = normalize(url);
    if (!isValidUrl(u)) {
        error = u.startsWith("https://") ? "https not supported (local http only)"
                                         : "invalid address";
        return false;
    }
    WiFiClient plain;
    HTTPClient http;
    // Authenticated, side-effect-free read: 200 only with a valid token.
    String checkUrl = u + "/api/v1/ota/check?target=" + String(FIRMWARE_TARGET);
    if (!httpBegin(http, plain, checkUrl)) {
        error = "connection not possible";
        return false;
    }
    http.addHeader("X-Device-Token", deviceToken);
    http.setTimeout(8000);
    int code = http.GET();
    http.end();
    if (code == 200) return true;
    error = code == 401 ? "server does not know this device (401)"
                        : "server unreachable (HTTP " + String(code) + ")";
    return false;
}
