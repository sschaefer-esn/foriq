"""Checks the built image against the actual OTA app partition size."""

Import("env")

from pathlib import Path


def check_size(target, source, env):
    binary = Path(str(target[0]))
    size = binary.stat().st_size
    pio_env = env.subst("$PIOENV")

    slot = 0x330000           # M5Stack StampS3 8 MB default: 3.1875 MiB

    usage = size / slot
    print(f"OTA partition check: {size} / {slot} bytes ({usage:.1%})")
    if usage >= 0.70:
        raise RuntimeError(
            f"Build {pio_env} uses {usage:.1%} of the OTA slot; release limit is <70%"
        )


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", check_size)
