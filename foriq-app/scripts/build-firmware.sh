#!/bin/sh
# Builds the sensor firmware (M5Stick S3) and creates a complete USB image
# build/firmware/<target>/factory.bin (bootloader, partition table, boot_app0,
# app) for flashing a new sensor from the app.
# firmware.bin for OTA stays in firmware-cpp/.pio/build/<target>/ as before.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO=${FORIQ_REPO:-$(cd "$APP_DIR/.." && pwd)}
# esptool (merge-bin) comes from the app's virtualenv (scripts/setup-python.sh).
VENV=${FORIQ_VENV:-$APP_DIR/build/venv}
if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; else PY=${FORIQ_PYTHON:-python3}; fi
FW="$REPO/firmware-cpp"
BOOT_APP0="$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"
OUT="$APP_DIR/build/firmware"

# Capture instead of piping into grep: a pipe would hide a failed build (or the size
# check) and the stale firmware.bin from an earlier build would be bundled.
PIO_LOG=$(cd "$FW" && pio run -e m5sticks3 2>&1) || {
  echo "$PIO_LOG" | tail -40 >&2; echo "Firmware build failed" >&2; exit 1; }
echo "$PIO_LOG" | grep -E "SUCCESS|Flash:" || true
[ -f "$BOOT_APP0" ] || { echo "boot_app0.bin missing: $BOOT_APP0" >&2; exit 1; }

for TARGET in m5sticks3; do
  B="$FW/.pio/build/$TARGET"
  CHIP=esp32s3; BOOT_AT=0x0
  mkdir -p "$OUT/$TARGET"
  # keep: flash mode/frequency/size are already correct in the headers that
  # PlatformIO wrote during the build.
  "$PY" -m esptool --chip "$CHIP" merge-bin -o "$OUT/$TARGET/factory.bin" \
    --flash-mode keep --flash-freq keep --flash-size keep \
    "$BOOT_AT" "$B/bootloader.bin" \
    0x8000 "$B/partitions.bin" \
    0xe000 "$BOOT_APP0" \
    0x10000 "$B/firmware.bin" >/dev/null
  echo "  • $TARGET/factory.bin $(du -h "$OUT/$TARGET/factory.bin" | cut -f1)"
done
