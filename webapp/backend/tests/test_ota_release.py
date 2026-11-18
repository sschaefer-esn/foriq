import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ota


class OtaReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.binary = b"header\0FORIQ_FW_VERSION=13.11.0\0payload"

    def tearDown(self):
        ota._fw_cache.clear()
        self.tmp.cleanup()

    def meta(self):
        ota._fw_cache.clear()
        with patch.object(ota, "FIRMWARE_CPP_DIR", str(self.root)):
            return ota._fw_meta("m5sticks3"), ota._list_firmware_files("m5sticks3")

    def test_pio_build_is_deliverable(self):
        build = self.root / ".pio" / "build" / "m5sticks3"
        build.mkdir(parents=True)
        (build / "firmware.bin").write_bytes(self.binary)
        meta, files = self.meta()
        self.assertEqual(meta["version"], "13.11.0")
        self.assertEqual(
            files,
            [{
                "filename": "firmware.bin",
                "checksum": hashlib.sha256(self.binary).hexdigest(),
                "size": len(self.binary),
            }],
        )

    def test_bundled_release_dir_is_deliverable(self):
        # Layout of the bundled Foriq app (FORIQ_FIRMWARE_DIR/release/<target>).
        build = self.root / "release" / "m5sticks3"
        build.mkdir(parents=True)
        (build / "firmware.bin").write_bytes(self.binary)
        meta, _files = self.meta()
        self.assertEqual(meta["version"], "13.11.0")

    def test_missing_binary_is_not_deliverable(self):
        meta, files = self.meta()
        self.assertIsNone(meta)
        self.assertEqual(files, [])
        with patch.object(ota, "FIRMWARE_CPP_DIR", str(self.root)):
            self.assertEqual(ota._get_firmware_version("m5sticks3"), "unknown")

    def test_unknown_device_target_never_falls_back(self):
        self.assertIsNone(ota.safe_target("unknown"))
        self.assertIsNone(ota.safe_target(None))

    def test_newer_installed_version_completes_older_queued_target(self):
        self.assertTrue(ota.firmware_version_at_least("13.12.5", "13.12.4"))
        self.assertTrue(ota.firmware_version_at_least("14.0.0", "13.99.99"))
        self.assertFalse(ota.firmware_version_at_least("13.12.3", "13.12.4"))
        self.assertFalse(ota.firmware_version_at_least("unknown", "13.12.4"))
        self.assertTrue(
            ota.ota_target_reached("13.12.5", "13.10.0", "13.12.4")
        )
        self.assertFalse(
            ota.ota_target_reached("13.10.0", "13.12.5", "13.12.4")
        )
        # Reflashing the same target version counts as success even without a version change.
        self.assertTrue(
            ota.ota_target_reached("13.12.4", "13.12.4", "13.12.4")
        )


if __name__ == "__main__":
    unittest.main()
