"""Devices of retired or unknown hardware targets stay in the database but are
never offered an OTA image."""
import asyncio
import os
import struct
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import ingest
import ota
import settings
from utils.db import make_con

RETIRED_TARGET = "retired-esp32"  # any build target that is no longer served

app = FastAPI()
app.include_router(settings.router)
app.include_router(ingest.router)
app.include_router(ota.router)
client = TestClient(app)


class TargetResolutionTests(unittest.TestCase):
    def test_retired_target_is_not_servable(self):
        self.assertEqual(list(ota.TARGET_BUILD_DIRS), ["m5sticks3"])
        self.assertIsNone(ota.safe_target(RETIRED_TARGET))
        self.assertEqual(ota.safe_target("m5sticks3"), "m5sticks3")

    def test_device_endpoints_reject_missing_or_retired_target(self):
        for target in (None, "", RETIRED_TARGET):
            with self.assertRaises(HTTPException) as ctx:
                ota._resolve_target(target, required=True)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_dashboard_defaults_to_s3(self):
        self.assertEqual(ota._resolve_target(None), "m5sticks3")

    def test_dashboard_version_reports_no_release_for_retired_target(self):
        result = asyncio.run(ota.get_version(target=RETIRED_TARGET, user={}))
        self.assertEqual((result["target"], result["version"], result["files"]),
                         (RETIRED_TARGET, "unknown", []))
        self.assertEqual(list(result["targets"]), ["m5sticks3"])


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class RetiredHardwareIntegrationTests(unittest.TestCase):
    def setUp(self):
        # A servable S3 image at a newer version than the device reports, so an
        # auto-update WOULD be queued if the target were treated as S3.
        self.tmp = tempfile.TemporaryDirectory()
        build = Path(self.tmp.name) / "release" / "m5sticks3"
        build.mkdir(parents=True)
        (build / "firmware.bin").write_bytes(b"x\0FORIQ_FW_VERSION=99.0.0\0y")
        self.fw_dir = patch.object(ota, "FIRMWARE_CPP_DIR", self.tmp.name)
        self.fw_dir.start()
        ota._fw_cache.clear()

        suffix = uuid.uuid4().hex
        self.company_id = str(uuid.uuid4())
        self.device_id = str(uuid.uuid4())
        self.token = f"retired-{suffix}"
        with make_con() as con:
            con.execute(
                text("INSERT INTO companies (id, name, slug) VALUES (:cid, 'Retired', :slug)"),
                {"cid": self.company_id, "slug": f"retired-{suffix}"},
            )
            con.execute(
                text(
                    "INSERT INTO devices (id, company_id, name, serial_number, device_token, "
                    "is_active, firmware_version, firmware_target, auto_update) "
                    "VALUES (:did, :cid, 'Retired', :serial, :token, true, '13.20.0', "
                    ":target, true)"
                ),
                {"did": self.device_id, "cid": self.company_id,
                 "serial": f"RETIRED-{suffix}", "token": self.token,
                 "target": RETIRED_TARGET},
            )
            con.commit()

    def tearDown(self):
        with make_con() as con:
            con.execute(text("DELETE FROM companies WHERE id = :cid"), {"cid": self.company_id})
            con.commit()
        self.fw_dir.stop()
        ota._fw_cache.clear()
        self.tmp.cleanup()

    def _headers(self):
        return {"X-Device-Token": self.token}

    def test_sync_offers_no_ota_and_keeps_stored_target(self):
        for reported in (RETIRED_TARGET, None):
            payload = {"firmware_version": "13.20.0"}
            if reported:
                payload["firmware_target"] = reported
            res = client.post("/api/v1/settings/sync", headers=self._headers(), json=payload)
            self.assertEqual(res.status_code, 200, res.text)
            self.assertFalse(
                [c for c in res.json()["commands"] if c["command"] == "ota_update"]
            )
        with make_con() as con:
            row = con.execute(
                text("SELECT firmware_target, "
                     "(SELECT COUNT(*) FROM device_commands WHERE device_id = :did "
                     " AND command = 'ota_update') AS ota_rows "
                     "FROM devices WHERE id = :did"),
                {"did": self.device_id},
            ).fetchone()
        self.assertEqual((row.firmware_target, row.ota_rows), (RETIRED_TARGET, 0))

    def test_ota_check_and_download_return_400_not_an_image(self):
        for query in (f"?target={RETIRED_TARGET}", ""):
            check = client.get(f"/api/v1/ota/check{query}", headers=self._headers())
            self.assertEqual(check.status_code, 400, check.text)
            download = client.get(f"/api/v1/ota/files/firmware.bin{query}",
                                  headers=self._headers())
            self.assertEqual(download.status_code, 400, download.text)
        # Sanity: the S3 channel itself is servable in this setup.
        check = client.get("/api/v1/ota/check?target=m5sticks3", headers=self._headers())
        self.assertEqual(check.status_code, 200, check.text)
        self.assertEqual(check.json()["version"], "99.0.0")

    def test_hits_are_still_accepted(self):
        ts = time.time()
        body = struct.pack("<IHffHffQI", int(ts), 0, 0.0, 2.0, 120, 0.0, 0.0, 77, 1)
        res = client.post("/api/v1/ingest/hits-bin4",
                          headers={**self._headers(), "Content-Type": "application/octet-stream"},
                          content=body)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["count"], 1)


if __name__ == "__main__":
    unittest.main()
