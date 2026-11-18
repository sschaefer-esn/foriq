# Playbook: port the sensor firmware to another ESP32 board

For coding agents working in this repository. Goal: Foriq runs on a board the user
owns (another ESP32 / ESP32-S3 / ESP32-C3 board, another accelerometer) without
breaking the M5Stick S3 build or the server.

## 1. Interview first

- Exact board (vendor, model, link or datasheet) and chip (ESP32, -S3, -C3, -C6 …),
  flash size, PSRAM.
- Accelerometer: model (ADXL345, LIS3DH, MPU6050, BMI270, ICM-42688, …), interface
  (I2C/SPI), pins, address, built in or external module.
- Power: USB mains supply, power bank, battery with a PMIC? Display, LEDs, buttons
  that must be handled (or kept off)?
- How the user flashes it (USB-C native USB, USB-UART bridge such as CP210x/CH340).
- Keep the M5Stick S3 working too? (Default: yes, add a second target.)

Do not start coding before you know chip, accelerometer and pins.

## 2. What is hardware-specific

| Place | What | Port action |
|---|---|---|
| `firmware-cpp/platformio.ini` | `[env:m5sticks3]`: board, flags, `FIRMWARE_TARGET` | add `[env:<target>]` with its own board and `-DFIRMWARE_TARGET=\"<target>\"` |
| `firmware-cpp/include/config.h` | board block: I2C pins, accel address/scale, backlight pin | wrap in `#if` per target (e.g. on `FIRMWARE_TARGET` via a `-DFORIQ_BOARD_<X>` flag) |
| `firmware-cpp/include/accel.h` + `src/accel_bmi270.cpp` | sensor driver: init, FIFO drain, magnitude in g | new `src/accel_<chip>.cpp` implementing the same `Accel::` interface; select per env with `build_src_filter` |
| `firmware-cpp/src/power_manager.cpp` | M5PM1 PMIC (charging off), backlight off, light sleep | guard the M5PM1/backlight part per board |
| `firmware-cpp/src/energy_detector.h` | `kFs = 800` Hz sample rate | the new driver must deliver a steady rate; if it is not 800 Hz, make `kFs` a per-target constant and re-run the host test |
| `firmware-cpp/tools/check_firmware_size.py` | OTA slot size of the S3 8 MB layout (`0x330000`) | per-target slot size; 4 MB boards have ~1.9 MB slots (default layout) |
| `firmware-cpp/tools/app_flasher.py` | USB VID → target, chip, model name | add the board's USB VID/PID (bridge chips have their own VIDs) |
| `foriq-app/scripts/build-firmware.sh`, `foriq-app/scripts/after-pack.js` | targets built and bundled into the app | add the target, its chip and bootloader offset (`0x0` on S3/C3, `0x1000` on classic ESP32) |
| `webapp/backend/ota.py` | `TARGET_BUILD_DIRS` – which firmware the backend serves | add `"<target>": "<target>"` |
| `webapp/frontend/src/app/(dashboard)/settings/firmware/page.js` | firmware page, default target | show the new target |
| `webapp/backend/tests/test_retired_hardware.py` | asserts the target list | update |

Hardware-independent and normally untouched: Wi-Fi/setup portal (`wifi_manager.cpp`,
`captive_portal_html.h`), server API (`api_client.cpp`), hit buffering, OTA updater,
time sync, the stroke detector logic.

## 3. The accelerometer interface

`Accel::drainFifo()` must return **acceleration magnitudes in g** at a constant rate,
plus a gap flag when samples were lost. The detector relies on:

- magnitude `≈ 1.0` at rest (calibrate scale: LSB per g from the datasheet and range);
- range at least ±8 g, better ±16 g (forging impacts saturate small ranges);
- a hardware FIFO, so the main loop can be late without losing samples; without FIFO
  the sample rate collapses while Wi-Fi is busy;
- the rate the detector expects (`EnergyDetector::kFs`).

Example: an ADXL345 at 800 Hz ODR, ±16 g full resolution (3.9 mg/LSB), FIFO in stream
mode (32 samples) drained every loop, magnitude computed in the driver.

## 4. Procedure

1. Add the env and the board block; build the unchanged firmware for both targets
   (`pio run -e m5sticks3 -e <target>`).
2. Write the driver; first print magnitudes over serial (debug build) and check ≈ 1 g
   at rest and a sensible peak when tapping the board.
3. Wire the board-specific power code; nothing must depend on M5 parts.
4. Set up a board by USB (`pio run -e <target> -t upload`), connect it through the
   `Foriq-Setup` portal, approve it in the web UI, check counts against a reference.
5. Add the target to OTA (`ota.py`), the app build and the flasher; test an OTA update.
6. Run the host detector test, backend tests, frontend checks
   ([CONTRIBUTING.md › Checks](../../CONTRIBUTING.md#checks-before-submitting)).
7. Bump `firmware-cpp/VERSION` (MINOR: new hardware), document the board in
   `docs/firmware.md` (*Supported hardware*), `README.md` (*Supported hardware*) and
   `CHANGELOG.md`.

## Pitfalls

- The partition table can only change by USB flashing, never by OTA.
- The image must stay below 70 % of the OTA slot (`check_firmware_size.py`).
- Native-USB chips (S3, C3) reset when the serial port opens; boards with a UART bridge
  behave differently in `app_flasher.py` (reset/boot sequence).
- Never use a boot-time button for resets on a board that may be built into an
  enclosure (see the comment in `config.h`).
- Device protocol and server stay the same for every board; the target name is the only
  thing the server needs to know.
