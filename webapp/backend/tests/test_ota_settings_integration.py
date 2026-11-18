import json
import os
import unittest
import uuid

from sqlalchemy import text

from settings import SettingsSyncPayload, _settings_sync_db
from utils.db import make_con


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class OtaSettingsIntegrationTests(unittest.TestCase):
    """DB contract for completing and resuming in-flight OTA commands."""

    def setUp(self):
        suffix = uuid.uuid4().hex
        self.company_id = str(uuid.uuid4())
        self.device_id = str(uuid.uuid4())
        self.token = f"ota-settings-{suffix}"
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug) "
                    "VALUES (:cid, 'OTA Settings Test', :slug)"
                ),
                {"cid": self.company_id, "slug": f"ota-settings-{suffix}"},
            )
            con.execute(
                text(
                    "INSERT INTO devices "
                    "(id, company_id, name, serial_number, device_token, is_active, "
                    "firmware_version, firmware_target, auto_update) "
                    "VALUES (:did, :cid, 'OTA test device', :serial, :token, true, "
                    "'13.10.0', 'm5sticks3', false)"
                ),
                {
                    "did": self.device_id,
                    "cid": self.company_id,
                    "serial": f"OTA-SETTINGS-{suffix}",
                    "token": self.token,
                },
            )
            con.commit()

    def tearDown(self):
        with make_con() as con:
            con.execute(
                text("DELETE FROM companies WHERE id = :cid"),
                {"cid": self.company_id},
            )
            con.commit()

    def _insert_command(self, target, status="delivered"):
        with make_con() as con:
            command_id = con.execute(
                text(
                    "INSERT INTO device_commands "
                    "(device_id, command, payload, status, progress, delivered_at, last_progress_at) "
                    "VALUES (:did, 'ota_update', CAST(:payload AS jsonb), :status, "
                    "'downloading', NOW(), NOW()) RETURNING id"
                ),
                {
                    "did": self.device_id,
                    "payload": json.dumps({"target_version": target}),
                    "status": status,
                },
            ).scalar_one()
            con.commit()
        return str(command_id)

    def _sync(self, version, target="m5sticks3"):
        return _settings_sync_db(
            SettingsSyncPayload(
                firmware_version=version,
                firmware_target=target,
                ota_slot_size=3342336,  # FW 13.x still sends this field; it is ignored.
            ),
            self.token,
        )

    def test_newer_release_completes_older_queued_target(self):
        command_id = self._insert_command("13.12.4")
        result = self._sync("13.12.5")
        self.assertEqual(result["cmds"], [])
        with make_con() as con:
            row = con.execute(
                text(
                    "SELECT status, progress, completed_at FROM device_commands "
                    "WHERE id = :cid"
                ),
                {"cid": command_id},
            ).fetchone()
        self.assertEqual((row.status, row.progress), ("completed", "completed"))
        self.assertIsNotNone(row.completed_at)

    def test_open_ota_is_redelivered_after_reconnect(self):
        with make_con() as con:
            con.execute(
                text("UPDATE devices SET firmware_version = '13.12.5' WHERE id = :did"),
                {"did": self.device_id},
            )
            con.commit()
        command_id = self._insert_command("13.12.6", status="in_progress")
        result = self._sync("13.12.5")
        self.assertEqual([str(row.id) for row in result["cmds"]], [command_id])

    def test_unknown_reported_target_never_queues_or_overwrites_hardware(self):
        result = self._sync("13.12.5", target="unknown")
        self.assertEqual(result["cmds"], [])
        with make_con() as con:
            row = con.execute(
                text("SELECT firmware_target FROM devices WHERE id = :did"),
                {"did": self.device_id},
            ).fetchone()
        self.assertEqual(row.firmware_target, "m5sticks3")


if __name__ == "__main__":
    unittest.main()
