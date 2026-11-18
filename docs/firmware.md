# Sensor firmware

The firmware in `firmware-cpp/` (C++/Arduino, PlatformIO) detects machine strokes on the
sensor and sends them to the local Foriq server. Protocol details:
[device-protocol.md](device-protocol.md).

## Supported hardware

| PlatformIO env | Device | MCU | Accelerometer |
|---|---|---|---|
| `m5sticks3` | M5Stick S3 | ESP32-S3 | BMI270 |

The M5Stick S3 is the only supported sensor. The build target is compiled in
(`FIRMWARE_TARGET`) and reported to the server, which offers OTA updates only for
supported targets.

Platform and library versions are pinned in `platformio.ini` (`espressif32 @ 6.13.0`,
Arduino-ESP32 2.0.17). A newer platform major is a separate migration that needs
testing on hardware.

## Building

Requires [PlatformIO Core](https://platformio.org/install/cli).

```bash
cd firmware-cpp
pio run -e m5sticks3
```

The image ends up in `.pio/build/<env>/firmware.bin`. In development the backend serves
OTA updates directly from there.

`read_version.py` embeds the contents of `VERSION` into the build. A post-build step
(`tools/check_firmware_size.py`) prints the share of the OTA app slot that the image
uses and fails the build at 70 % or more.

For the Foriq app, `npm run build:firmware` in `foriq-app/` builds the env and merges
bootloader, partition table, `boot_app0` and app into one USB image:
`foriq-app/build/firmware/<target>/factory.bin`.

### Debug builds

Diagnostics are compiled out by default (`FORIQ_DEBUG 0` in `include/config.h`). For a
local debug build append `-DFORIQ_DEBUG=1` to `build_flags` of the env in
`platformio.ini`; do not commit it. Serial output runs at 115200 baud
(`pio device monitor`).

### Unit test

The stroke detector has a host-side test:

```bash
cd firmware-cpp
c++ -std=c++17 -Iinclude test/test_energy_detector.cpp src/energy_detector.cpp -o /tmp/energy_test && /tmp/energy_test
```

## Setting up a sensor

### With the Foriq app (USB)

Connect the stick with USB-C. The status window shows a card for the connected sensor
with model and state. *Set up* erases the stick completely, flashes the bundled
`factory.bin` (about a minute), reads serial number and setup code, and registers the
sensor with the local server, so it is approved right away when the installation has
one company. Wi-Fi can then be entered in the app (transferred over USB and tested by
the sensor) or later through the setup portal. *Delete* erases the stick and removes the
sensor with all its data from Foriq after a confirmation.

The USB work is done by `firmware-cpp/tools/app_flasher.py`, which the app runs as a
child process (packaged: `foriq-backend flasher ...`, with esptool 5 built in). It
prints JSON lines and supports `ports`, `inspect`, `flash`, `scan`, `wifi` and `erase`.
It talks to the firmware over serial with `FORIQ-INFO`, `FORIQ-SCAN` and `FORIQ-WIFI`
(`include/serial_cmd.h`). Do not keep a serial monitor open on the same port.

If an M5Stick S3 hangs in download mode: hold the side reset button for about 2 s,
release it when the LED blinks green, and try again.

### With PlatformIO (USB)

```bash
cd firmware-cpp
pio run -e m5sticks3 -t erase      # optional: wipe flash including NVS first
pio run -e m5sticks3 -t upload
```

The sensor then starts the setup portal and registers itself; approve it in the web UI.

### Setup portal

Without stored Wi-Fi credentials the sensor opens the Wi-Fi network **`Foriq-Setup`**.
Its password is the sensor's **setup code** (three words joined by `-`), which the app
shows after USB setup and which an owner or admin can request from a running sensor on
its device page. Connect a phone or laptop, choose the Wi-Fi network for the sensor in
the captive portal page and, if needed, a different server under "Server (optional)".
The portal closes after 10 minutes without input and the sensor restarts.

After joining Wi-Fi the sensor registers itself with the server and appears in the
web UI as a new sensor waiting for approval. It sends data only after it was approved.

The portal also opens when an activated sensor repeatedly cannot join its Wi-Fi network
(for example after the router was replaced); in that case token and settings are kept.
The sensor has no button reset (the button may be held down permanently by the
enclosure); Wi-Fi is reset with the `wifi_reset` command or the portal's factory reset.

## Versioning

`firmware-cpp/VERSION` holds the firmware version (SemVer `MAJOR.MINOR.PATCH`). Bump it
with every firmware change: bug fix -> PATCH, new feature -> MINOR, breaking protocol
change -> MAJOR. The backend reads the version from the `FORIQ_FW_VERSION=` marker in
the binary and offers an update whenever it differs from the version a sensor reports;
sensors refuse downgrades.

## OTA partition headroom

An OTA update fails (`Update.begin` reports "Not enough space") if the new image does
not fit into the app slot of the partition table **already on the device**. The
partition table can only be changed by flashing over USB, never by OTA.

The M5Stick S3 uses the default 8 MB layout of the `m5stack-stamps3` board with two
OTA app slots of 3.1875 MiB (`0x330000`). Keep the image below 70 % of the slot; the
size check in the build enforces this.
