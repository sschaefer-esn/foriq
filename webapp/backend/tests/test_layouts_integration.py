import os
import unittest
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

import layouts
from utils.auth_utils import create_token
from utils.db import make_con


test_app = FastAPI()
test_app.include_router(layouts.router)


client = TestClient(test_app)


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class LayoutIntegrationTests(unittest.TestCase):
    def setUp(self):
        suffix = uuid.uuid4().hex
        self.user_id = str(uuid.uuid4())
        self.company_id = str(uuid.uuid4())
        self.foreign_company_id = str(uuid.uuid4())
        self.device_id = str(uuid.uuid4())
        self.foreign_device_id = str(uuid.uuid4())
        self.layout_id = str(uuid.uuid4())
        self.foreign_layout_id = str(uuid.uuid4())
        self.email = f"layout+{suffix}@example.com"

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug) VALUES "
                    "(:own_id, :own_name, :own_slug), "
                    "(:foreign_id, :foreign_name, :foreign_slug)"
                ),
                {
                    "own_id": self.company_id,
                    "own_name": f"Layout Test {suffix}",
                    "own_slug": f"layout-{suffix}",
                    "foreign_id": self.foreign_company_id,
                    "foreign_name": f"Foreign Layout Test {suffix}",
                    "foreign_slug": f"foreign-layout-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, name) "
                    "VALUES (:id, :email, 'unused', 'Internal Access Test')"
                ),
                {"id": self.user_id, "email": self.email},
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
                    "INSERT INTO devices (id, company_id, name, serial_number) VALUES "
                    "(:own_id, :own_cid, 'Own machine', :own_serial), "
                    "(:foreign_id, :foreign_cid, 'Foreign machine', :foreign_serial)"
                ),
                {
                    "own_id": self.device_id,
                    "own_cid": self.company_id,
                    "own_serial": f"LAYOUT-OWN-{suffix}",
                    "foreign_id": self.foreign_device_id,
                    "foreign_cid": self.foreign_company_id,
                    "foreign_serial": f"LAYOUT-FOREIGN-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO layouts (id, company_id, name, items) VALUES "
                    "(:own_id, :own_cid, 'Own hall', '[]'::jsonb), "
                    "(:foreign_id, :foreign_cid, 'Foreign hall', '[]'::jsonb)"
                ),
                {
                    "own_id": self.layout_id,
                    "own_cid": self.company_id,
                    "foreign_id": self.foreign_layout_id,
                    "foreign_cid": self.foreign_company_id,
                },
            )
            con.commit()

        self.token = create_token(
            user_id=self.user_id,
            email=self.email,
            role="admin",
            company_id=self.company_id,
            name="Internal Access Test",
            company_name="Layout Test",
        )

    def tearDown(self):
        with make_con() as con:
            con.execute(text("DELETE FROM users WHERE id = :id"), {"id": self.user_id})
            con.execute(
                text("DELETE FROM companies WHERE id IN (:own_id, :foreign_id)"),
                {
                    "own_id": self.company_id,
                    "foreign_id": self.foreign_company_id,
                },
            )
            con.commit()

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"}

    def test_layout_items_are_saved_and_returned(self):
        items = [
            {
                "device_id": self.device_id,
                "x": 4,
                "y": 5,
                "w": 6,
                "h": 3,
            }
        ]

        saved = client.put(
            f"/api/v1/layouts/{self.layout_id}/items",
            headers=self._headers(),
            json={"items": items},
        )
        loaded = client.get(
            f"/api/v1/layouts/{self.layout_id}", headers=self._headers()
        )

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json(), {"status": "ok"})
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()["items"], items)

        with make_con() as con:
            persisted = con.execute(
                text("SELECT items FROM layouts WHERE id = :id"),
                {"id": self.layout_id},
            ).scalar_one()
        self.assertEqual(persisted, items)

    def test_layout_and_device_ids_are_isolated_by_company(self):
        original_items = [
            {
                "device_id": self.device_id,
                "x": 1,
                "y": 2,
                "w": 3,
                "h": 2,
            }
        ]
        self.assertEqual(
            client.put(
                f"/api/v1/layouts/{self.layout_id}/items",
                headers=self._headers(),
                json={"items": original_items},
            ).status_code,
            200,
        )

        foreign_device = client.put(
            f"/api/v1/layouts/{self.layout_id}/items",
            headers=self._headers(),
            json={
                "items": [
                    {
                        "device_id": self.foreign_device_id,
                        "x": 8,
                        "y": 8,
                        "w": 2,
                        "h": 2,
                    }
                ]
            },
        )
        foreign_layout = client.put(
            f"/api/v1/layouts/{self.foreign_layout_id}/items",
            headers=self._headers(),
            json={"items": original_items},
        )

        self.assertEqual(foreign_device.status_code, 403)
        self.assertEqual(foreign_device.json()["detail"], "Invalid devices in layout")
        self.assertEqual(foreign_layout.status_code, 404)
        self.assertEqual(foreign_layout.json()["detail"], "Layout not found")

        own = client.get(
            f"/api/v1/layouts/{self.layout_id}", headers=self._headers()
        )
        hidden = client.get(
            f"/api/v1/layouts/{self.foreign_layout_id}", headers=self._headers()
        )
        self.assertEqual(own.json()["items"], original_items)
        self.assertEqual(hidden.status_code, 404)


if __name__ == "__main__":
    unittest.main()
