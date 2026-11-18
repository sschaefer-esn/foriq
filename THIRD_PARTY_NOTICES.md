# Third-party notices

Foriq is licensed under the GNU Affero General Public License v3.0 only (see `LICENSE`
and `NOTICE`). The following third-party material is included in this repository under
its own license.

## Vendored source code

### BMI270 configuration file (Bosch Sensortec)

- File: `firmware-cpp/src/bmi270_config_file.h` (the `bmi270_config_file` byte array,
  8192 bytes)
- Origin: BMI270 Sensor API, `bmi270.c`,
  <https://github.com/boschsensortec/BMI270_SensorAPI>
- Copyright: Bosch Sensortec GmbH
- License: BSD 3-Clause License

The firmware uploads this blob to the BMI270 accelerometer on every initialization
(`firmware-cpp/src/accel_bmi270.cpp`). The blob is byte-identical to the one in
`bmi270.c` v2.86.1. Copyright and license notice, verbatim from the upstream
`LICENSE` file (also reproduced at the top of `bmi270_config_file.h`); it must
accompany every redistribution of this file, in source or binary form:

```text
Copyright (c) 2023 Bosch Sensortec GmbH. All rights reserved.

BSD-3-Clause

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived from
    this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Fonts

### Inter

- Files: `webapp/frontend/public/fonts/Inter-Variable.ttf`
- Origin: <https://github.com/rsms/inter>
- Copyright: 2020 The Inter Project Authors
- License: SIL Open Font License 1.1, full text in
  `webapp/frontend/public/fonts/Inter-OFL.txt`

Used as the default typeface of the web UI. The optional display font Clash Grotesk
is not part of this project and not distributed with it (see
`webapp/frontend/README.md`).

## Libraries linked into the firmware image (not vendored)

Fetched by PlatformIO at build time (`firmware-cpp/platformio.ini`) and compiled into
`firmware.bin` / `factory.bin`:

| Component | Origin | License |
|---|---|---|
| ArduinoJson | <https://github.com/bblanchon/ArduinoJson> | MIT |
| Arduino core for ESP32 2.0.17 (incl. precompiled ESP-IDF libraries) | <https://github.com/espressif/arduino-esp32> | core: LGPL-2.1-or-later; ESP-IDF components: mostly Apache-2.0 (see the upstream repository) |
