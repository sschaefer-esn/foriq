import asyncio
import os
import struct
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import text

from devices import (
    ActivateRequest,
    _activate_device_sync,
    approve_pending_device,
)
from ingest import _authenticate_hit_device_sync, _insert_hits_sync
from maintenance import run_retention_once
from utils.db import make_con
import utils.device_token as device_token_module
from utils.device_token import hash_activation_claim, hash_device_token


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class CoreIngestActivationIntegrationTests(unittest.TestCase):
    activation_code = "ABCDEFGH2345"

    def setUp(self):
        # Pin the hardened mode (the app always sets DEVICE_TOKEN_HMAC_KEY) instead of
        # depending on the caller's environment; the plaintext test overrides it.
        key_patch = patch.object(device_token_module, "_KEY", b"t" * 32)
        key_patch.start()
        self.addCleanup(key_patch.stop)
        self.company_id = str(uuid.uuid4())
        self.serial = str(uuid.uuid4())
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug) "
                    "VALUES (:id, :name, :slug)"
                ),
                {
                    "id": self.company_id,
                    "name": f"Test {self.company_id}",
                    "slug": f"test-{self.company_id}",
                },
            )
            con.commit()

        # Self-registration: an unknown sensor waits for approval.
        with self.assertRaises(HTTPException) as pending:
            self._activate()
        self.assertEqual(pending.exception.status_code, 403)
        with make_con() as con:
            self.device_id = con.execute(
                text("SELECT id FROM devices WHERE serial_number = :sn"),
                {"sn": self.serial},
            ).scalar()
        asyncio.run(approve_pending_device(
            self.device_id, user={"company_id": self.company_id},
        ))

    def tearDown(self):
        with make_con() as con:
            con.execute(
                text("DELETE FROM companies WHERE id = :id"),
                {"id": self.company_id},
            )
            con.execute(
                text("DELETE FROM devices WHERE serial_number IN (:sn, :unknown)"),
                {"sn": self.serial, "unknown": getattr(self, "unknown_serial", "")},
            )
            con.commit()

    def _activate(self):
        result = _activate_device_sync(ActivateRequest(
            serial_number=self.serial,
            setup_password=self.activation_code,
        ))
        self.assertIsNotNone(result)
        return result[0]

    def test_claim_requires_physical_code_and_never_stores_plain_token(self):
        with make_con() as con:
            pending = con.execute(
                text(
                    "SELECT device_token, device_token_hash, is_active, "
                    "activation_claim_hash FROM devices WHERE serial_number = :sn"
                ),
                {"sn": self.serial},
            ).fetchone()
        self.assertIsNone(pending.device_token)
        self.assertIsNone(pending.device_token_hash)
        self.assertFalse(pending.is_active)
        self.assertNotEqual(pending.activation_claim_hash, self.activation_code)

        with self.assertRaises(HTTPException) as invalid:
            _activate_device_sync(ActivateRequest(
                serial_number=self.serial,
                setup_password="ZZZZZZZZ9999",
            ))
        self.assertEqual(invalid.exception.status_code, 401)

        token = self._activate()
        retry_token = self._activate()
        self.assertEqual(retry_token, token)

        with make_con() as con:
            activated = con.execute(
                text(
                    "SELECT device_token, device_token_hash, is_active, activated_at "
                    "FROM devices WHERE serial_number = :sn"
                ),
                {"sn": self.serial},
            ).fetchone()
        self.assertIsNone(activated.device_token)
        self.assertEqual(activated.device_token_hash, hash_device_token(token))
        self.assertTrue(activated.is_active)
        self.assertIsNotNone(activated.activated_at)

    def test_unknown_serial_waits_for_approval(self):
        self.unknown_serial = str(uuid.uuid4())
        request = ActivateRequest(
            serial_number=self.unknown_serial,
            setup_password=self.activation_code,
        )
        for _ in range(2):
            with self.assertRaises(HTTPException) as pending:
                _activate_device_sync(request)
            self.assertEqual(pending.exception.status_code, 403)
        with make_con() as con:
            row = con.execute(
                text(
                    "SELECT company_id, is_active, activated_at FROM devices "
                    "WHERE serial_number = :sn"
                ),
                {"sn": self.unknown_serial},
            ).fetchone()
        self.assertIsNone(row.company_id)
        self.assertFalse(row.is_active)
        self.assertIsNone(row.activated_at)

    def test_serial_number_is_case_insensitive(self):
        token, _ = _activate_device_sync(ActivateRequest(
            serial_number=self.serial.upper(),
            setup_password=self.activation_code.lower(),
        ))
        self.assertTrue(token.startswith("fq_"))

    def test_reset_sensor_reconnects_with_same_setup_code(self):
        token = self._activate()
        with make_con() as con:
            con.execute(
                text(
                    "UPDATE devices SET activation_claim_expires_at = "
                    "NOW() - INTERVAL '1 day' WHERE serial_number = :sn"
                ),
                {"sn": self.serial},
            )
            con.commit()
        self.assertEqual(self._activate(), token)

        with self.assertRaises(HTTPException) as other_code:
            _activate_device_sync(ActivateRequest(
                serial_number=self.serial,
                setup_password="ZZZZZZZZ9999",
            ))
        self.assertEqual(other_code.exception.status_code, 403)

    def test_optional_plaintext_mode_activates_and_authenticates(self):
        with patch.object(device_token_module, "_KEY", b""):
            plain_claim = hash_activation_claim(self.serial, self.activation_code)
            with make_con() as con:
                con.execute(
                    text(
                        "UPDATE devices SET activation_claim_hash = :claim "
                        "WHERE serial_number = :sn"
                    ),
                    {"claim": plain_claim, "sn": self.serial},
                )
                con.commit()

            token = self._activate()
            device = _authenticate_hit_device_sync(token)
            self.assertIsNotNone(device)

            with make_con() as con:
                stored = con.execute(
                    text(
                        "SELECT device_token, device_token_hash FROM devices "
                        "WHERE serial_number = :sn"
                    ),
                    {"sn": self.serial},
                ).fetchone()
            self.assertEqual(stored.device_token, token)
            self.assertIsNone(stored.device_token_hash)

    def test_v4_batch_is_atomic_and_http_retry_is_deduplicated(self):
        token = self._activate()
        epoch_s = int(datetime.now(timezone.utc).timestamp())
        payload = b"".join([
            struct.pack(
                "<IHffHffQI",
                epoch_s, 100, 1.5, 2.5, 50, 0.0, 0.98, 123456789, 1,
            ),
            struct.pack(
                "<IHffHffQI",
                epoch_s, 200, 0.8, 1.2, 40, 0.0, -2.4, 123456789, 2,
            ),
        ])

        first_context = _authenticate_hit_device_sync(token)
        retry_context = _authenticate_hit_device_sync(token)
        self.assertIsNotNone(first_context)
        self.assertIsNotNone(retry_context)
        first = _insert_hits_sync(first_context, payload, 4)
        retry = _insert_hits_sync(retry_context, payload, 4)

        self.assertEqual(first["received"], 2)
        self.assertEqual(first["count"], 1)
        self.assertEqual(first["skipped"], 1)
        self.assertEqual(first["duplicates"], 0)
        self.assertEqual(retry["count"], 0)
        self.assertEqual(retry["duplicates"], 1)

        with make_con() as con:
            totals = con.execute(
                text(
                    "SELECT COUNT(*) AS hits, COUNT(*) FILTER (WHERE counted) AS counted "
                    "FROM device_hits h JOIN devices d ON d.id = h.device_id "
                    "WHERE d.serial_number = :sn"
                ),
                {"sn": self.serial},
            ).fetchone()
            receipts = con.execute(
                text(
                    "SELECT COUNT(*) FROM device_hit_receipts r "
                    "JOIN devices d ON d.id = r.device_id WHERE d.serial_number = :sn"
                ),
                {"sn": self.serial},
            ).scalar()

        self.assertEqual(totals.hits, 1)
        self.assertEqual(totals.counted, 1)
        self.assertEqual(receipts, 1)

    def test_hit_receipts_are_retained_for_410_days(self):
        token = self._activate()
        device = _authenticate_hit_device_sync(token)
        self.assertIsNotNone(device)

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO device_hit_receipts "
                    "(device_id, boot_id, event_sequence, recorded_at) VALUES "
                    "(:did, 9001, 1, NOW() - INTERVAL '411 days'), "
                    "(:did, 9002, 1, NOW() - INTERVAL '409 days')"
                ),
                {"did": str(device.id)},
            )
            con.commit()

        run_retention_once()

        with make_con() as con:
            remaining = con.execute(
                text(
                    "SELECT boot_id FROM device_hit_receipts "
                    "WHERE device_id = :did ORDER BY boot_id"
                ),
                {"did": str(device.id)},
            ).scalars().all()
        self.assertEqual(remaining, [9002])


if __name__ == "__main__":
    unittest.main()
