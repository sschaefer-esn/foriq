# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's private vulnerability
reporting ("Report a vulnerability" in the Security tab). If that is not available,
open an issue that only asks for a private contact, without technical details.

Include the affected component (firmware, backend, web UI, app), the version or commit,
and steps to reproduce. We will acknowledge the report and keep you informed about the
fix.

## Scope and threat model

Foriq is designed for a **trusted local network**:

- Sensors, browsers and the backend communicate over plain HTTP on port 8420. Device
  tokens, JWTs and passwords travel unencrypted within the LAN.
- The firmware only talks to local addresses (`*.local`, private and link-local IPv4)
  and has no TLS.
- PostgreSQL listens on `127.0.0.1` only. App-only endpoints (`/api/v1/devices/app*`)
  answer loopback clients with the app key only.
- OTA images are verified by SHA-256 checksum, not by signature.

Do not expose Foriq to the internet or to untrusted networks. Exposure to the
internet, attacks that require access to the trusted LAN segment, and attacks that
require local access to the server Mac (for example reading
`~/Library/Application Support/Foriq/secrets.json`) are outside the intended
deployment; reports that improve defence in depth are still welcome.
