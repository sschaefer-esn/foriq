#!/usr/bin/env python3
"""USB helper for the Foriq app: detect, flash, configure WiFi on and erase sensors.

The app (foriq-app/src/sensor/) runs this program as a child process and reads
JSON lines from stdout:
    {"event": "log", "msg": "..."}
    {"event": "progress", "step": "write", "pct": 42}
    {"event": "result", ...}          exactly one, on success (exit 0)
    {"event": "error", "msg": "...", "hint": "..."}   on failure (exit 1)

Commands:
    ports                                   connected sticks (opens no port)
    inspect --port P --target T [--deep]    read state; --deep may restart the sensor
    flash   --port P --target T --image F   erase everything + write factory.bin
    scan    --port P                        WiFi networks seen by the sensor; setup portal only
    wifi    --port P --ssid S [--server U]  password via stdin; setup portal only
    erase   --port P --target T             erase the whole flash

In the app bundle it runs as `foriq-backend flasher ...` (scripts/backend_entry.py)
and esptool as `foriq-backend esptool ...`. PlatformIO is not required.

S3 quirks: first talk to it without a reset (the stick may already be in download
mode), then with usb-reset; afterwards use watchdog-reset, because an RTS reset can
leave the S3 in download mode. The port name often changes after usb-reset.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Firmware boot output (main.cpp): "Device-ID: ..." and
# "Setup-AP: Foriq-Setup / Password: ..." (firmware before 14.0.1 printed
# "Passwort"). Setup code: three words or, on older devices, 12 characters.
SETUP_CODE_PATTERN = r"(?:[a-z]{2,20}(?:-[a-z]{2,20}){2}|[A-HJ-NP-Z2-9]{12})"
SETUP_RE = re.compile(
    rf"Setup-AP:\s*(?P<ssid>\S+)\s*/\s*Passwor[dt]:\s*(?P<code>{SETUP_CODE_PATTERN})",
    re.IGNORECASE,
)
# Serial: a UUID generated on first boot (current firmware). FQ-C-YYWW-n are
# serials of early factory-provisioned sensors that keep them in NVS.
SERIAL_RE = re.compile(
    r"Device-ID:\s*(?P<serial>(?:FQ-C-\d{4}-\d+|"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))"
)
_MACOS_TTY_PREFIX = "/dev/tty."
_MACOS_CU_PREFIX = "/dev/cu."


def normalize_port_device(device):
    """On macOS use /dev/cu.* instead of /dev/tty.* (same interface)."""
    if device.startswith(_MACOS_TTY_PREFIX):
        return _MACOS_CU_PREFIX + device[len(_MACOS_TTY_PREFIX):]
    return device


def _open_serial_connection(serial, port):
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = 115200
    connection.timeout = 0.5
    # Deassert the lines before opening to avoid an accidental DTR/RTS
    # reset sequence on open.
    connection.dtr = False
    connection.rts = False
    connection.open()
    return connection


def _reset_into_application(connection):
    connection.reset_input_buffer()
    connection.dtr = False  # GPIO0 high -> normal app boot
    connection.rts = True   # EN low
    time.sleep(0.15)
    connection.rts = False  # EN high


TARGETS = {
    # USB VID -> build target. The S3 uses native USB (Espressif VID).
    0x303A: "m5sticks3",
}
CHIP = {"m5sticks3": "esp32s3"}
MODEL = {"m5sticks3": "M5Stick S3"}
APP_OFFSET = 0x10000

INFO_RE = re.compile(r"FORIQ-INFO\s+(\{.*\})")
FW_RE = re.compile(r"FORIQ_FW_VERSION=(\S+)")
WIFI_OK_RE = re.compile(r"FORIQ-WIFI-OK\s*(\S*)")
WIFI_FAIL_RE = re.compile(r"FORIQ-WIFI-FAIL\s*(.*)")
PCT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s?%")

S3_HINT = (
    "StickS3: hold the side reset button for about 2 seconds, release it when the "
    "LED flashes green, then try again."
)
# Fail reasons sent by the firmware (FORIQ-WIFI-FAIL <reason>, wifi_manager.cpp).
WIFI_REASONS = {
    "connect": "The sensor could not connect to the WiFi (check name/password; 2.4 GHz required).",
    "server": "Invalid server address. http:// is only allowed for local addresses.",
    "json": "The sensor did not understand the data.",
}


class FlashError(Exception):
    def __init__(self, msg, hint=None):
        super().__init__(msg)
        self.hint = hint


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def log(msg):
    emit("log", msg=msg)


# -- Ports -------------------------------------------------------------------

def _comports():
    from serial.tools import list_ports
    return list(list_ports.comports())


def list_sticks():
    """From the USB device list only; opens no port (that would reset the S3)."""
    sticks, seen = [], set()
    for entry in _comports():
        target = TARGETS.get(entry.vid)
        device = normalize_port_device(entry.device)
        if not target or device in seen:
            continue
        seen.add(device)
        sticks.append({
            "port": device,
            "target": target,
            "model": MODEL[target],
            "usb_id": str(entry.serial_number or "").strip().upper() or None,
        })
    return sticks


def refind_port(port, usb_id, wait_s=20.0):
    """Find the port again after a reset (its name may change)."""
    deadline = time.monotonic() + wait_s
    while True:
        sticks = list_sticks()
        for stick in sticks:
            if usb_id and stick["usb_id"] == usb_id:
                return stick["port"]
        if not usb_id:
            if any(s["port"] == port for s in sticks):
                return port
            if len(sticks) == 1:
                return sticks[0]["port"]
        if time.monotonic() >= deadline:
            raise FlashError("The sensor did not reappear on USB after the restart.")
        time.sleep(0.4)


def usb_id_of(port):
    for stick in list_sticks():
        if stick["port"] == normalize_port_device(port):
            return stick["usb_id"]
    return None


# -- esptool -----------------------------------------------------------------

def esptool_cmd():
    if getattr(sys, "frozen", False):
        return [sys.executable, "esptool"]
    return [sys.executable, "-m", "esptool"]


def run_esptool(target, port, before, after, args, step=None):
    """Run esptool as a child process; report its progress (\\r lines) as progress events."""
    command = [*esptool_cmd(), "--chip", CHIP[target], "--port", port,
               "--before", before, "--after", after, "--connect-attempts", "10"]
    command += args
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail, buf, last_pct = [], b"", -1
    while True:
        chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(1)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for raw in parts:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            tail = (tail + [line])[-15:]
            if step and ("Writing at" in line or "Erasing" in line):
                match = PCT_RE.search(line)
                if match:
                    pct = int(float(match.group(1)))
                    if pct != last_pct:
                        last_pct = pct
                        emit("progress", step=step, pct=pct)
    code = proc.wait()
    return code, tail


def esptool_with_befores(target, port, after, args, step=None):
    befores = ["no-reset", "usb-reset"]
    usb_id = usb_id_of(port)
    tail = []
    for index, before in enumerate(befores):
        if index:
            time.sleep(0.8)
            port = refind_port(port, usb_id, wait_s=8)
        code, tail = run_esptool(target, port, before, after, args, step)
        if code == 0:
            return port
    detail = next((l for l in reversed(tail) if "error" in l.lower() or "failed" in l.lower()), "")
    raise FlashError(
        "Could not connect to the sensor." + (f" ({detail})" if detail else ""),
        S3_HINT,
    )


def after_reset(target):
    return "watchdog-reset"


# -- Serial -------------------------------------------------------------------

class Reader:
    """Reads lines from the sensor; collects its identity from FORIQ-INFO and the boot output."""

    def __init__(self, port):
        import serial
        self.serial_mod = serial
        self.conn = _open_serial_connection(serial, port)
        self.conn.timeout = 0.2
        self.captured = ""
        self.info = None

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass

    def send(self, line):
        self.conn.write((line + "\n").encode("utf-8"))
        self.conn.flush()

    def poll(self):
        raw = self.conn.readline()
        if not raw:
            return None
        line = raw.decode("utf-8", errors="replace").strip()
        self.captured = (self.captured + line + "\n")[-20000:]
        match = INFO_RE.search(line)
        if match:
            try:
                self.info = json.loads(match.group(1))
            except ValueError:
                pass
        return line

    def identity(self):
        if self.info and self.info.get("serial"):
            return {
                "serial": self.info.get("serial"),
                "setup": self.info.get("setup"),
                "fw": self.info.get("fw"),
                "wifi": self.info.get("wifi"),
                "activated": self.info.get("activated"),
            }
        serial_match = SERIAL_RE.search(self.captured)
        setup_match = SETUP_RE.search(self.captured)
        if serial_match and setup_match:
            fw = FW_RE.search(self.captured)
            return {
                "serial": serial_match.group("serial"),
                "setup": setup_match.group("code"),
                "fw": fw.group(1) if fw else None,
                "wifi": None,
                "activated": None,
            }
        return None

    def is_blank(self):
        # ROM bootloader without an app loops on "invalid header: 0xffffffff".
        return "invalid header: 0xffffffff" in self.captured

    def in_download_mode(self):
        text = self.captured.lower()
        return "waiting for download" in text or "download(usb/uart0)" in text


def listen(port, seconds, ask_info=True, reset=False, info_grace=0.0):
    """Listen for up to `seconds`, sending FORIQ-INFO every ~0.8 s. Returns the Reader.

    On the S3 merely opening the port resets the chip, and the USB port may vanish
    briefly. In that case find it again and keep listening (keeping the output).
    info_grace: once a Foriq boot is seen, wait up to this long (from start) for
    FORIQ-INFO; the setup portal only answers after its WiFi scan (~8 s).
    """
    usb_id = usb_id_of(port)
    start = time.monotonic()
    deadline = start + seconds
    extended = False
    reader = Reader(port)
    captured = ""
    try:
        if reset:
            _reset_into_application(reader.conn)
        next_ask = time.monotonic() + (1.5 if reset else 0)
        while time.monotonic() < deadline:
            if ask_info and time.monotonic() >= next_ask:
                try:
                    reader.send("FORIQ-INFO")
                except (OSError, reader.serial_mod.SerialException):
                    pass
                next_ask = time.monotonic() + 0.8
            try:
                reader.poll()
            except (OSError, reader.serial_mod.SerialException):
                captured += reader.captured
                reader.close()
                try:
                    port = refind_port(port, usb_id, wait_s=max(0.5, deadline - time.monotonic()))
                    time.sleep(0.3)
                    reader = Reader(port)
                except (FlashError, OSError, reader.serial_mod.SerialException):
                    break
                continue
            if reader.info and reader.info.get("serial"):
                break
            if reader.is_blank():
                break
            if not ask_info and reader.identity():
                break
            if info_grace and not extended and reader.identity():
                deadline = max(deadline, start + info_grace)
                extended = True
    finally:
        reader.close()
    reader.captured = (captured + reader.captured)[-20000:]
    reader.port = port
    return reader


def flash_is_blank(target, port):
    """Read the app header at 0x10000. Restarts the sensor afterwards."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "head.bin"
        port = esptool_with_befores(
            target, port, after_reset(target), ["read-flash", hex(APP_OFFSET), "16", str(out)]
        )
        data = out.read_bytes() if out.exists() else b""
    return (not data or all(b == 0xFF for b in data)), port


def inspect(port, target, deep=False):
    usb_id = usb_id_of(port)
    reader = listen(port, 4.0, info_grace=12.0)
    port = reader.port
    ident = reader.identity()
    if ident:
        return {"state": "foriq", "port": port, **ident}
    if reader.is_blank():
        return {"state": "blank", "port": port}
    if not deep:
        return {"state": "download" if reader.in_download_mode() else "unknown", "port": port}

    log("Sensor does not answer directly - checking flash and restarting ...")
    blank, port = flash_is_blank(target, port)
    if blank:
        return {"state": "blank", "port": port}
    port = refind_port(port, usb_id)
    reader = listen(port, 12.0, info_grace=15.0)
    ident = reader.identity()
    if ident:
        return {"state": "foriq", "port": reader.port, **ident}
    return {"state": "unknown", "port": reader.port}


# -- Commands ---------------------------------------------------------------

def cmd_ports(_args):
    emit("result", sticks=list_sticks())


def cmd_inspect(args):
    emit("result", **inspect(args.port, args.target, deep=args.deep))


def cmd_flash(args):
    image = Path(args.image)
    if not image.is_file():
        raise FlashError(f"Firmware image missing: {image}")
    usb_id = usb_id_of(args.port)
    emit("progress", step="erase", pct=0)
    log("Erasing and rewriting flash ...")
    port = esptool_with_befores(
        args.target, args.port, after_reset(args.target),
        ["write-flash", "--erase-all", "0x0", str(image)], step="write",
    )
    emit("progress", step="boot", pct=0)
    log("Sensor is starting ...")
    time.sleep(1.5)
    port = refind_port(port, usb_id)
    reader = listen(port, 25.0, info_grace=45.0)
    port = reader.port
    ident = reader.identity()
    if not ident:
        raise FlashError("Firmware written, but the sensor does not respond.", S3_HINT)
    emit("result", state="foriq", port=port, **ident)


def wait_for_portal(reader):
    """Opening the port restarts the S3; portal commands only work once the setup
    portal is running (~8 s). Until then, keep polling with FORIQ-INFO."""
    log("Waiting for the sensor's setup mode ...")
    deadline = time.monotonic() + 40
    next_ask = 0.0
    while not reader.info and time.monotonic() < deadline:
        if time.monotonic() >= next_ask:
            reader.send("FORIQ-INFO")
            next_ask = time.monotonic() + 1.0
        reader.poll()
    if not reader.info:
        raise FlashError(
            "The sensor does not respond. Is firmware 13.29.0 or newer installed?",
            "Alternatively, set up WiFi from a phone via the \"Foriq-Setup\" portal.",
        )
    if reader.info.get("wifi"):
        raise FlashError(
            "The sensor already has a WiFi network saved and is not in setup mode.",
            "To set it up again, click \"Erase\" first, then \"Set up\".",
        )


SCAN_RE = re.compile(r"FORIQ-SCAN\s+(\[.*\])")


def cmd_scan(args):
    """WiFi networks the sensor can see (2.4 GHz only), strongest first."""
    reader = Reader(args.port)
    try:
        wait_for_portal(reader)
        deadline = time.monotonic() + 20
        next_ask = 0.0
        while time.monotonic() < deadline:
            if time.monotonic() >= next_ask:
                reader.send("FORIQ-SCAN")
                next_ask = time.monotonic() + 5.0
            line = reader.poll()
            match = SCAN_RE.search(line or "")
            if match:
                emit("result", networks=json.loads(match.group(1)))
                return
    finally:
        reader.close()
    raise FlashError("The sensor did not return a WiFi list.")


def cmd_wifi(args):
    password = sys.stdin.readline().rstrip("\n")
    payload = json.dumps({"ssid": args.ssid, "password": password, "server": args.server or ""})
    reader = Reader(args.port)
    try:
        wait_for_portal(reader)
        reader.send("FORIQ-WIFI " + payload)
        log("WiFi settings sent - the sensor is testing the connection ...")
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            line = reader.poll()
            if not line:
                continue
            ok = WIFI_OK_RE.search(line)
            if ok:
                emit("result", ip=ok.group(1) or None)
                return
            fail = WIFI_FAIL_RE.search(line)
            if fail:
                reason = fail.group(1).strip()
                raise FlashError(WIFI_REASONS.get(reason, f"WiFi setup failed ({reason})."))
    finally:
        reader.close()
    raise FlashError(
        "The sensor did not answer. Is it in setup mode (freshly flashed)?",
        "Alternatively, set up WiFi from a phone via the \"Foriq-Setup\" portal.",
    )


def cmd_erase(args):
    emit("progress", step="erase", pct=0)
    log("Erasing the whole flash ...")
    esptool_with_befores(args.target, args.port, after_reset(args.target), ["erase-flash"])
    emit("progress", step="erase", pct=100)
    emit("result", state="blank")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="flasher")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ports")
    for name in ("inspect", "flash", "erase"):
        p = sub.add_parser(name)
        p.add_argument("--port", required=True)
        p.add_argument("--target", required=True, choices=sorted(CHIP))
        if name == "inspect":
            p.add_argument("--deep", action="store_true")
        if name == "flash":
            p.add_argument("--image", required=True)
    p = sub.add_parser("scan")
    p.add_argument("--port", required=True)
    p = sub.add_parser("wifi")
    p.add_argument("--port", required=True)
    p.add_argument("--ssid", required=True)
    p.add_argument("--server", default="")
    args = parser.parse_args(argv)

    handlers = {"ports": cmd_ports, "inspect": cmd_inspect, "flash": cmd_flash,
                "wifi": cmd_wifi, "scan": cmd_scan, "erase": cmd_erase}
    try:
        handlers[args.cmd](args)
        return 0
    except FlashError as exc:
        emit("error", msg=str(exc), hint=exc.hint)
    except SystemExit as exc:  # sys.exit from helper functions
        if exc.code in (0, None):
            return 0
        emit("error", msg=str(exc.code))
    except Exception as exc:  # noqa: BLE001 - the app should always get a readable message
        emit("error", msg=f"{type(exc).__name__}: {exc}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
