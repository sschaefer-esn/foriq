#!/usr/bin/env python3
"""Simulated sensor against the running Foriq app (end-to-end smoke test).

Same flow as a real device, everything via the backend's public port:
  1. Create the first account (fresh install) or sign in
  2. Sensor registers with serial number + setup code -> waits for approval
  3. Approve it under "New sensors" (as in the UI)
  4. Activate again -> device token
  5. Send strokes in the hits-bin4 binary format
  6. Check that they show up in the device list (count_today)

  python3 scripts/sensor_sim.py [--hits 25] [--data DIR | --url URL]
      [--email USERNAME --password PASSWORD]

Only reads the backend port from the app's data folder (runtime.json);
everything else goes through the HTTP API. On an installation that is already
set up, pass the credentials of an owner/admin - the simulator adds an extra
device there.
"""
import argparse
import json
import os
import secrets
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA = Path.home() / "Library" / "Application Support" / "Foriq"


def request(base, method, path, body=None, token=None, headers=None, raw=False):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        if raw:
            data = body
        else:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        text = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(text)
        except ValueError:
            return err.code, text


def ensure_account(base, email, password):
    status, setup = request(base, "GET", "/api/v1/auth/setup-status")
    if status == 200 and setup.get("needs_setup"):
        status, resp = request(base, "POST", "/api/v1/auth/register", {
            "name": "Sensor-Simulator",
            "email": email,
            "password": password,
            "company_name": "Simulator Ltd",
        })
    else:
        status, resp = request(base, "POST", "/api/v1/auth/login", {
            "email": email, "password": password,
        })
    if status != 200:
        sys.exit(f"Sign-in failed ({status}): {resp}")
    return resp["token"]


def activate(base, serial, code):
    return request(base, "POST", "/api/v1/devices/activate", {
        "serial_number": serial, "setup_password": code,
    })


def hits_bin4(count, boot_id):
    """36 bytes/stroke: <IHffHffQI (epoch_s, epoch_ms, energy, gforce, duration_ms,
    legacy_aux, legacy_marker, boot_id, event_sequence) - same as the firmware."""
    now = time.time() - count  # one stroke per second, ending "now"
    out = bytearray()
    for i in range(count):
        ts = now + i
        out += struct.pack(
            "<IHffHffQI",
            int(ts), int((ts % 1) * 1000),
            1200.0 + i,      # energy
            3.5,             # gforce
            180,             # duration_ms
            0.0, 0.0,        # legacy fields (marker outside -2...-3)
            boot_id, i + 1,  # event ID
        )
    return bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.environ.get("FORIQ_USER_DATA", DEFAULT_DATA))
    ap.add_argument("--url", help="Base URL (default: http://localhost:<backend port>)")
    ap.add_argument("--hits", type=int, default=25)
    ap.add_argument("--email", default="sensor-sim")
    ap.add_argument("--password", default="Simulator-Passwort-123")
    args = ap.parse_args()

    if args.url:
        base = args.url.rstrip("/")
    else:
        runtime = json.loads((Path(args.data) / "runtime.json").read_text())
        port = runtime["ports"]["backend"]
        base = f"http://localhost:{port}" if port != 80 else "http://localhost"
    print(f"App: {base}")

    token = ensure_account(base, args.email, args.password)
    print("✓ Account ready")

    serial = f"FQ-SIM-{secrets.token_hex(4).upper()}"
    code = "amber-falcon-river"
    status, act = activate(base, serial, code)
    if status != 403:
        sys.exit(f"Self-registration: expected 403 (waiting for approval), got {status}: {act}")
    print(f"✓ Sensor {serial} is waiting for approval")

    status, pending = request(base, "GET", "/api/v1/devices/pending", token=token)
    dev = next((p for p in pending if p["serial_number"] == serial), None) if status == 200 else None
    if not dev:
        sys.exit(f"Sensor not listed under 'New sensors' ({status}): {pending}")
    status, res = request(base, "POST", f"/api/v1/devices/pending/{dev['id']}/approve", token=token)
    if status != 200:
        sys.exit(f"Approval failed ({status}): {res}")
    print(f"✓ Device approved ({dev['id']})")

    status, act = activate(base, serial, code)
    if status != 200:
        sys.exit(f"Activation failed ({status}): {act}")
    device_token = act["device_token"]
    print("✓ Activated, device token received")

    status, sync = request(
        base, "POST", "/api/v1/settings/sync",
        {"firmware_version": "14.0.0", "firmware_target": "m5sticks3", "sleep_mode": False,
         "current_config": {"upload_interval_s": 0, "sleep_after_min": 0, "wifi_rssi": -55}},
        headers={"X-Device-Token": device_token},
    )
    if status != 200 or "upload_interval_s" not in sync.get("settings", {}):
        sys.exit(f"Settings sync failed ({status}): {sync}")
    print(f"✓ Settings sync (upload_interval_s={sync['settings']['upload_interval_s']})")

    status, res = request(
        base, "POST", "/api/v1/ingest/hits-bin4", hits_bin4(args.hits, secrets.randbits(31) + 1),
        headers={"X-Device-Token": device_token, "Content-Type": "application/octet-stream"},
        raw=True,
    )
    if status != 200:
        sys.exit(f"Ingest failed ({status}): {res}")
    print(f"✓ {res['count']} strokes sent (received={res['received']}, skipped={res['skipped']})")

    status, devices = request(base, "GET", "/api/v1/devices", token=token)
    mine = next((d for d in devices if d["id"] == dev["id"]), None) if status == 200 else None
    if not mine:
        sys.exit(f"Device not in the list ({status}): {devices}")
    print(f"✓ Dashboard list: {mine['name']} count_today={mine['count_today']} last_seen={mine['last_seen_at']}")
    if mine["count_today"] < res["count"]:
        sys.exit("✗ count_today lower than the strokes sent")
    print("OK")


if __name__ == "__main__":
    main()
