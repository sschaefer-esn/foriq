# Foriq sensor firmware

C++/Arduino firmware for the M5Stick S3 (ESP32-S3, BMI270), built with PlatformIO.
The sensor reads the accelerometer at 800 Hz, detects strokes on the device, buffers
them and uploads them to the Foriq backend over Wi-Fi. Version: [`VERSION`](VERSION)
(bump it with every change).

```bash
pio run -e m5sticks3                                   # build (+ size check)
pio run -e m5sticks3 -t upload --upload-port <port>    # flash over USB
```

| Path | Contents |
|---|---|
| `src/main.cpp` | setup, main loop, sampling → detector → buffer → upload |
| `src/energy_detector.cpp` | the stroke detector (the only counting path) |
| `src/accel_bmi270.cpp` | accelerometer driver (FIFO, magnitude in g) |
| `src/wifi_manager.cpp`, `include/captive_portal_html.h` | Wi-Fi, `Foriq-Setup` portal |
| `src/api_client.cpp`, `src/hit_buffer.cpp` | server API, settings sync, stroke buffer |
| `src/ota_updater.cpp` | firmware updates from the local backend |
| `src/power_manager.cpp` | M5PM1 power chip, display off, light sleep |
| `include/config.h` | pins, timings, defaults |
| `test/test_energy_detector.cpp` | host-side detector test |
| `tools/app_flasher.py` | USB set-up/erase used by the Foriq app |
| `tools/check_firmware_size.py` | fails the build above 70 % of the OTA slot |

Details (flashing, setup portal, versioning, OTA headroom): [docs/firmware.md](../docs/firmware.md).
Detector and protocol: [docs/device-protocol.md](../docs/device-protocol.md).
Adapting the detector to a machine: [docs/agents/tune-detector.md](../docs/agents/tune-detector.md).
Another board: [docs/agents/port-hardware.md](../docs/agents/port-hardware.md).
