"""TRANSITION(fw<14): backend release A speaks both the old (13.x) and the new (14.x) device protocol.

Release B deletes the 13.x cases together with utils/legacy_protocol.py.
"""
import json
import os
import struct
import time
import unittest
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

import ingest
import settings
from settings import CurrentConfig, _energy_wire_config
from utils.db import make_con
from utils.legacy_protocol import upstream_aliases

app = FastAPI()
app.include_router(settings.router)
app.include_router(ingest.router)
client = TestClient(app)

OLD_KEYS = ("uebertragung_intervall_s", "sleep_nach_min", "neustart_plan")
NEW_KEYS = ("upload_interval_s", "sleep_after_min", "restart_schedule")


def _hits_v4(count, boot_id):
    now = time.time() - count
    out = bytearray()
    for i in range(count):
        ts = now + i
        out += struct.pack("<IHffHffQI", int(ts), int((ts % 1) * 1000), 1200.0, 3.5,
                           180, 0.0, 0.0, boot_id, i + 1)
    return bytes(out)


class LegacyMappingTests(unittest.TestCase):
    def test_old_upstream_names_map_to_new(self):
        cfg = CurrentConfig.model_validate({
            "uebertragung_intervall_s": 60, "sleep_nach_min": 5,
            "lernmodus": -1, "kalibrierung_wartend": True, "wifi_rssi": -60,
        })
        self.assertEqual((cfg.upload_interval_s, cfg.sleep_after_min, cfg.wifi_rssi), (60, 5, -60))

    def test_new_name_wins_over_old(self):
        self.assertEqual(
            upstream_aliases({"sleep_nach_min": 1, "sleep_after_min": 2}),
            {"sleep_after_min": 2},
        )

    def test_pre_13_25_firmware_gets_legacy_stroke_threshold_key(self):
        device = SimpleNamespace(count_sensitivity=5000, count_bridge_ms=901, std_window=19,
                                 sensitivity_ms=50, hysteresis_ms=120, min_peak_g=0,
                                 stroke_threshold=0.7)
        _, config = _energy_wire_config(device, "13.20.0")
        self.assertEqual(config["schlag_schwelle"], 0.7)
        self.assertNotIn("stroke_threshold", config)


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class DeviceProtocolTransitionTests(unittest.TestCase):
    def setUp(self):
        suffix = uuid.uuid4().hex
        self.company_id = str(uuid.uuid4())
        self.device_id = str(uuid.uuid4())
        self.token = f"proto-{suffix}"
        with make_con() as con:
            con.execute(
                text("INSERT INTO companies (id, name, slug) VALUES (:cid, 'Proto', :slug)"),
                {"cid": self.company_id, "slug": f"proto-{suffix}"},
            )
            con.execute(
                text(
                    "INSERT INTO devices (id, company_id, name, serial_number, device_token, "
                    "is_active, firmware_version, firmware_target, auto_update, "
                    "upload_interval_s, sleep_after_min, restart_schedule) "
                    "VALUES (:did, :cid, 'Proto', :serial, :token, true, '13.28.0', "
                    "'m5sticks3', false, 60, 5, CAST(:plan AS jsonb))"
                ),
                {"did": self.device_id, "cid": self.company_id, "serial": f"PROTO-{suffix}",
                 "token": self.token,
                 "plan": json.dumps({"days": [1, 3], "time": "02:00", "tz": "UTC"})},
            )
            self.command_id = str(con.execute(
                text("INSERT INTO device_commands (device_id, command) "
                     "VALUES (:did, 'restart') RETURNING id"),
                {"did": self.device_id},
            ).scalar_one())
            con.commit()

    def tearDown(self):
        with make_con() as con:
            con.execute(text("DELETE FROM companies WHERE id = :cid"), {"cid": self.company_id})
            con.commit()

    def _headers(self, binary=False):
        h = {"X-Device-Token": self.token}
        if binary:
            h["Content-Type"] = "application/octet-stream"
        return h

    def _command_status(self):
        with make_con() as con:
            return con.execute(
                text("SELECT status FROM device_commands WHERE id = :id"), {"id": self.command_id}
            ).scalar_one()

    def _cycle(self, firmware_version, current_config):
        sync = client.post("/api/v1/settings/sync", headers=self._headers(), json={
            "firmware_version": firmware_version, "firmware_target": "m5sticks3",
            "sleep_mode": False, "current_config": current_config,
        })
        self.assertEqual(sync.status_code, 200, sync.text)
        body = sync.json()
        self.assertEqual([c["id"] for c in body["commands"]], [self.command_id])
        self.assertEqual(body["commands"][0]["command"], "restart")
        self.assertEqual(self._command_status(), "delivered")

        hits = client.post("/api/v1/ingest/hits-bin4", headers=self._headers(binary=True),
                           content=_hits_v4(3, 4242))
        self.assertEqual(hits.status_code, 200, hits.text)
        self.assertEqual(hits.json()["count"], 3)

        result = client.post("/api/v1/ingest/command-result", headers=self._headers(),
                             json={"command_id": self.command_id, "success": True})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self._command_status(), "completed")
        return body["settings"], hits.json()["config"]

    def _assert_values(self, cfg, keys):
        interval, sleep, plan = (cfg[k] for k in keys)
        self.assertEqual((interval, sleep), (60, 5))
        self.assertEqual(plan, {"days": [1, 3], "time": "02:00"})

    def test_firmware_13_cycle_with_old_names(self):
        settings_cfg, hit_cfg = self._cycle("13.28.0", {
            "uebertragung_intervall_s": 60, "sleep_nach_min": 5, "lernmodus": -1,
            "lern_grund": "events", "kalibrierung": -1, "kalibrierung_wartend": True,
            "kalibrierung_event_count": 17, "hit_drop_count": 2, "wifi_rssi": -61,
        })
        self._assert_values(settings_cfg, OLD_KEYS)
        for key in ("lernmodus", "kalibrierung", "kalibrierung_alle_events",
                    "kalibrierung_event_count"):
            self.assertEqual(settings_cfg[key], 0)
        self.assertEqual((hit_cfg["uebertragung_intervall_s"], hit_cfg["sleep_nach_min"],
                          hit_cfg["lernmodus"]), (60, 5, 0))
        with make_con() as con:
            row = con.execute(text("SELECT hit_drop_count, wifi_rssi FROM devices WHERE id = :d"),
                              {"d": self.device_id}).fetchone()
        self.assertEqual((row.hit_drop_count, row.wifi_rssi), (2, -61))

    def test_firmware_14_cycle_with_new_names(self):
        settings_cfg, hit_cfg = self._cycle("14.0.0", {
            "upload_interval_s": 60, "sleep_after_min": 5, "hit_drop_count": 1,
        })
        self._assert_values(settings_cfg, NEW_KEYS)
        self.assertEqual((hit_cfg["upload_interval_s"], hit_cfg["sleep_after_min"]), (60, 5))
        self.assertEqual(hit_cfg["power_save"], False)

    def test_settings_sync_command_results_complete_command(self):
        client.post("/api/v1/settings/sync", headers=self._headers(),
                    json={"firmware_version": "14.0.0", "firmware_target": "m5sticks3"})
        res = client.post("/api/v1/settings/sync", headers=self._headers(), json={
            "firmware_version": "14.0.0", "firmware_target": "m5sticks3",
            "command_results": [{"command_id": self.command_id, "success": True}],
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._command_status(), "completed")


if __name__ == "__main__":
    unittest.main()
