import os
import unittest
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

import devices
from utils.auth_utils import create_token
from utils.db import make_con


test_app = FastAPI()
test_app.include_router(devices.router)
client = TestClient(test_app)


class CopyCountingSettingsValidationTests(unittest.TestCase):
    def test_targets_are_unique_and_source_is_rejected(self):
        source = uuid.uuid4()
        target = uuid.uuid4()
        request = devices.CopyCountingSettingsRequest(
            source_device_id=source,
            target_device_ids=[target, target],
        )
        self.assertEqual(request.target_device_ids, [target])

        with self.assertRaises(ValidationError):
            devices.CopyCountingSettingsRequest(
                source_device_id=source,
                target_device_ids=[source],
            )


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class CopyCountingSettingsIntegrationTests(unittest.TestCase):
    def setUp(self):
        suffix = uuid.uuid4().hex
        self.user_id = str(uuid.uuid4())
        self.company_id = str(uuid.uuid4())
        self.foreign_company_id = str(uuid.uuid4())
        self.source_id = str(uuid.uuid4())
        self.target_a_id = str(uuid.uuid4())
        self.target_b_id = str(uuid.uuid4())
        self.foreign_device_id = str(uuid.uuid4())
        self.email = f"copy-settings-{suffix}@foriq.test"

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug) VALUES "
                    "(:cid, :name, :slug), (:fcid, :fname, :fslug)"
                ),
                {
                    "cid": self.company_id,
                    "name": f"Copy Settings {suffix}",
                    "slug": f"copy-settings-{suffix}",
                    "fcid": self.foreign_company_id,
                    "fname": f"Foreign Copy {suffix}",
                    "fslug": f"foreign-copy-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, name) "
                    "VALUES (:uid, :email, 'unused', 'Copy Settings Test')"
                ),
                {"uid": self.user_id, "email": self.email},
            )
            con.execute(
                text(
                    "INSERT INTO memberships (user_id, company_id, role) "
                    "VALUES (:uid, :cid, 'admin')"
                ),
                {"uid": self.user_id, "cid": self.company_id},
            )
            con.execute(
                text(
                    "INSERT INTO devices "
                    "(id, company_id, name, serial_number, count_bridge_ms, "
                    "count_sensitivity) VALUES "
                    "(:source, :cid, 'Source', :source_serial, 275, 5500), "
                    "(:target_a, :cid, 'Target A', :a_serial, 900, 4000), "
                    "(:target_b, :cid, 'Target B', :b_serial, NULL, 6000), "
                    "(:foreign, :fcid, 'Fremd', :foreign_serial, 700, 7000)"
                ),
                {
                    "source": self.source_id,
                    "target_a": self.target_a_id,
                    "target_b": self.target_b_id,
                    "foreign": self.foreign_device_id,
                    "cid": self.company_id,
                    "fcid": self.foreign_company_id,
                    "source_serial": f"COPY-SOURCE-{suffix}",
                    "a_serial": f"COPY-A-{suffix}",
                    "b_serial": f"COPY-B-{suffix}",
                    "foreign_serial": f"COPY-FOREIGN-{suffix}",
                },
            )
            con.commit()

        token = create_token(
            user_id=self.user_id,
            email=self.email,
            role="admin",
            company_id=self.company_id,
            name="Copy Settings Test",
            company_name="Copy Settings",
        )
        self.headers = {"Authorization": f"Bearer {token}"}

    def tearDown(self):
        with make_con() as con:
            con.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": self.user_id})
            con.execute(
                text("DELETE FROM companies WHERE id IN (:cid, :fcid)"),
                {"cid": self.company_id, "fcid": self.foreign_company_id},
            )
            con.commit()

    def test_copies_sensitivity_and_period_to_multiple_targets(self):
        response = client.post(
            "/api/v1/devices/counting-settings/copy",
            headers=self.headers,
            json={
                "source_device_id": self.source_id,
                "target_device_ids": [self.target_a_id, self.target_b_id],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["target_count"], 2)
        with make_con() as con:
            rows = con.execute(
                text(
                    "SELECT count_bridge_ms, count_sensitivity, "
                    "count_sensitivity_changed_at IS NOT NULL AS sensitivity_changed, "
                    "fast_sync_until IS NOT NULL AS sync_queued FROM devices "
                    "WHERE id IN (:target_a, :target_b) ORDER BY name"
                ),
                {"target_a": self.target_a_id, "target_b": self.target_b_id},
            ).fetchall()

        self.assertEqual([row.count_bridge_ms for row in rows], [400, 400])
        self.assertEqual([row.count_sensitivity for row in rows], [5500, 5500])
        self.assertTrue(all(row.sensitivity_changed for row in rows))
        self.assertTrue(all(row.sync_queued for row in rows))

    def test_foreign_target_rejects_whole_copy(self):
        response = client.post(
            "/api/v1/devices/counting-settings/copy",
            headers=self.headers,
            json={
                "source_device_id": self.source_id,
                "target_device_ids": [self.target_a_id, self.foreign_device_id],
            },
        )

        self.assertEqual(response.status_code, 404)
        with make_con() as con:
            unchanged = con.execute(
                text(
                    "SELECT count_bridge_ms FROM devices "
                    "WHERE id = :target"
                ),
                {"target": self.target_a_id},
            ).fetchone()
        self.assertEqual(unchanged.count_bridge_ms, 900)


if __name__ == "__main__":
    unittest.main()
