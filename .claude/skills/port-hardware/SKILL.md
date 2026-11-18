---
name: port-hardware
description: Port the Foriq sensor firmware to another ESP32 board or accelerometer (ESP32, ESP32-S3, ESP32-C3, ADXL345, LIS3DH, MPU6050 …). Use when the user wants to run Foriq on hardware other than the M5Stick S3.
---

Follow `docs/agents/port-hardware.md`: interview the user about board, chip,
accelerometer and pins first, then add a second PlatformIO target without breaking
`m5sticks3`. Read the file completely before starting.
