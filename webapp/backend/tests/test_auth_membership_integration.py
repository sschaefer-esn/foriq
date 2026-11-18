import os
import unittest
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
import devices
import users
from utils.auth_utils import create_token
from utils.db import make_con


test_app = FastAPI()
test_app.include_router(auth.router)
test_app.include_router(users.router)
test_app.include_router(devices.router)
client = TestClient(test_app)


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class AuthMembershipIntegrationTests(unittest.TestCase):
    def setUp(self):
        suffix = uuid.uuid4().hex
        self.user_id = str(uuid.uuid4())
        self.company_id = str(uuid.uuid4())
        self.foreign_company_id = str(uuid.uuid4())
        self.own_device_id = str(uuid.uuid4())
        self.foreign_device_id = str(uuid.uuid4())
        self.email = f"auth-membership-{suffix}@example.invalid"

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug) VALUES "
                    "(:own_id, :own_name, :own_slug), "
                    "(:foreign_id, :foreign_name, :foreign_slug)"
                ),
                {
                    "own_id": self.company_id,
                    "own_name": f"Auth Test {suffix}",
                    "own_slug": f"auth-{suffix}",
                    "foreign_id": self.foreign_company_id,
                    "foreign_name": f"Foreign Test {suffix}",
                    "foreign_slug": f"foreign-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, name) "
                    "VALUES (:id, :email, :password_hash, :name)"
                ),
                {
                    "id": self.user_id,
                    "email": self.email,
                    "password_hash": "unused-in-integration-test",
                    "name": "Auth Integration Test",
                },
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
                    "own_id": self.own_device_id,
                    "own_cid": self.company_id,
                    "own_serial": f"AUTH-OWN-{suffix}",
                    "foreign_id": self.foreign_device_id,
                    "foreign_cid": self.foreign_company_id,
                    "foreign_serial": f"AUTH-FOREIGN-{suffix}",
                },
            )
            con.commit()

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

    def _token(self, role: str, company_id: str | None = None) -> str:
        return create_token(
            user_id=self.user_id,
            email=self.email,
            role=role,
            company_id=company_id or self.company_id,
            name="Auth Integration Test",
            company_name="Token value must not be authoritative",
        )

    @staticmethod
    def _headers(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def _set_role(self, role: str):
        with make_con() as con:
            con.execute(
                text(
                    "UPDATE memberships SET role = :role "
                    "WHERE user_id = :uid AND company_id = :cid"
                ),
                {"role": role, "uid": self.user_id, "cid": self.company_id},
            )
            con.commit()

    def test_existing_jwt_loses_access_immediately_after_membership_removal(self):
        token = self._token("admin")
        self.assertEqual(
            client.get("/api/v1/users", headers=self._headers(token)).status_code,
            200,
        )

        with make_con() as con:
            con.execute(
                text(
                    "DELETE FROM memberships "
                    "WHERE user_id = :uid AND company_id = :cid"
                ),
                {"uid": self.user_id, "cid": self.company_id},
            )
            con.commit()

        denied = client.get("/api/v1/devices", headers=self._headers(token))
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(denied.json()["detail"], "Invalid token")

    def test_owner_and_admin_jwts_are_downgraded_to_viewer_immediately(self):
        for elevated_role in ("owner", "admin"):
            with self.subTest(elevated_role=elevated_role):
                self._set_role(elevated_role)
                token = self._token(elevated_role)
                self.assertEqual(
                    client.get(
                        "/api/v1/users", headers=self._headers(token)
                    ).status_code,
                    200,
                )

                self._set_role("viewer")

                admin_only = client.get(
                    "/api/v1/users", headers=self._headers(token)
                )
                self.assertEqual(admin_only.status_code, 403)
                self.assertEqual(admin_only.json()["detail"], "Permission denied")
                self.assertEqual(
                    client.get(
                        "/api/v1/devices", headers=self._headers(token)
                    ).status_code,
                    200,
                )

    def test_foreign_company_is_rejected_and_data_stays_isolated(self):
        token = self._token("admin")
        headers = self._headers(token)

        own = client.get(
            f"/api/v1/devices/{self.own_device_id}", headers=headers
        )
        foreign = client.get(
            f"/api/v1/devices/{self.foreign_device_id}", headers=headers
        )
        listing = client.get("/api/v1/devices", headers=headers)

        self.assertEqual(own.status_code, 200)
        self.assertEqual(foreign.status_code, 404)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(
            {device["id"] for device in listing.json()},
            {self.own_device_id},
        )

        signed_but_unowned_company_token = self._token(
            "owner", company_id=self.foreign_company_id
        )
        rejected = client.get(
            "/api/v1/devices",
            headers=self._headers(signed_but_unowned_company_token),
        )
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.json()["detail"], "Invalid token")

    def test_account_can_be_deleted_without_owned_company(self):
        response = client.delete(
            "/api/v1/auth/account",
            headers=self._headers(self._token("admin")),
        )
        self.assertEqual(response.status_code, 200)

        with make_con() as con:
            user = con.execute(
                text("SELECT 1 FROM users WHERE id = :uid"),
                {"uid": self.user_id},
            ).fetchone()
            company = con.execute(
                text("SELECT 1 FROM companies WHERE id = :cid"),
                {"cid": self.company_id},
            ).fetchone()
        self.assertIsNone(user)
        self.assertIsNotNone(company)

    def test_owned_company_blocks_account_only_deletion(self):
        self._set_role("owner")
        response = client.delete(
            "/api/v1/auth/account",
            headers=self._headers(self._token("owner")),
        )
        self.assertEqual(response.status_code, 409)

    def test_company_and_account_are_deleted_together(self):
        self._set_role("owner")
        response = client.delete(
            "/api/v1/auth/company-and-account",
            headers=self._headers(self._token("owner")),
        )
        self.assertEqual(response.status_code, 200)

        with make_con() as con:
            user = con.execute(
                text("SELECT 1 FROM users WHERE id = :uid"),
                {"uid": self.user_id},
            ).fetchone()
            company = con.execute(
                text("SELECT 1 FROM companies WHERE id = :cid"),
                {"cid": self.company_id},
            ).fetchone()
            foreign_company = con.execute(
                text("SELECT 1 FROM companies WHERE id = :cid"),
                {"cid": self.foreign_company_id},
            ).fetchone()
        self.assertIsNone(user)
        self.assertIsNone(company)
        self.assertIsNotNone(foreign_company)

    def test_other_owned_company_blocks_combined_deletion(self):
        self._set_role("owner")
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO memberships (user_id, company_id, role) "
                    "VALUES (:uid, :cid, 'owner')"
                ),
                {"uid": self.user_id, "cid": self.foreign_company_id},
            )
            con.commit()

        response = client.delete(
            "/api/v1/auth/company-and-account",
            headers=self._headers(self._token("owner")),
        )
        self.assertEqual(response.status_code, 409)

        with make_con() as con:
            user = con.execute(
                text("SELECT 1 FROM users WHERE id = :uid"),
                {"uid": self.user_id},
            ).fetchone()
            companies = con.execute(
                text("SELECT id FROM companies WHERE id IN (:cid, :foreign_cid)"),
                {"cid": self.company_id, "foreign_cid": self.foreign_company_id},
            ).fetchall()
        self.assertIsNotNone(user)
        self.assertEqual(len(companies), 2)


if __name__ == "__main__":
    unittest.main()
