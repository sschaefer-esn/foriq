import asyncio
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

import api_keys as api_keys_module
import utils.api_key_auth as api_key_auth
from api_keys import (
    CreateApiKeyRequest,
    create_api_key,
    list_api_keys,
    revoke_or_delete_api_key,
)
from external_api import router as external_api_router
from utils.db import make_con
from utils.ratelimit import limiter


test_app = FastAPI()
test_app.state.limiter = limiter
test_app.include_router(external_api_router)
client = TestClient(test_app)

_TEST_API_KEY_PEPPER = "external-api-integration-test-pepper-2026"


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class ExternalApiIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._auth_pepper = patch.object(
            api_key_auth, "API_KEY_HMAC_KEY", _TEST_API_KEY_PEPPER
        )
        self._keys_pepper = patch.object(
            api_keys_module, "API_KEY_HMAC_KEY", _TEST_API_KEY_PEPPER
        )
        self._auth_pepper.start()
        self._keys_pepper.start()

        suffix = uuid.uuid4().hex
        self.company_id = str(uuid.uuid4())
        self.foreign_company_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        self.own_device_id = str(uuid.uuid4())
        self.foreign_device_id = str(uuid.uuid4())
        self.user = {"company_id": self.company_id, "sub": self.user_id}

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug, external_api_enabled) VALUES "
                    "(:own_id, :own_name, :own_slug, false), "
                    "(:foreign_id, :foreign_name, :foreign_slug, true)"
                ),
                {
                    "own_id": self.company_id,
                    "own_name": f"API Test {suffix}",
                    "own_slug": f"api-{suffix}",
                    "foreign_id": self.foreign_company_id,
                    "foreign_name": f"Foreign API Test {suffix}",
                    "foreign_slug": f"foreign-api-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO users (id, email, password_hash, name) "
                    "VALUES (:id, :email, 'unused', 'API Integration Test')"
                ),
                {
                    "id": self.user_id,
                    "email": f"external-api-{suffix}@example.invalid",
                },
            )
            con.execute(
                text(
                    "INSERT INTO memberships (user_id, company_id, role) "
                    "VALUES (:uid, :cid, 'owner')"
                ),
                {"uid": self.user_id, "cid": self.company_id},
            )
            con.execute(
                text(
                    "INSERT INTO devices (id, company_id, name, serial_number) VALUES "
                    "(:own_id, :own_cid, 'Own press', :own_serial), "
                    "(:foreign_id, :foreign_cid, 'Foreign press', :foreign_serial)"
                ),
                {
                    "own_id": self.own_device_id,
                    "own_cid": self.company_id,
                    "own_serial": f"API-OWN-{suffix}",
                    "foreign_id": self.foreign_device_id,
                    "foreign_cid": self.foreign_company_id,
                    "foreign_serial": f"API-FOREIGN-{suffix}",
                },
            )
            con.execute(
                text(
                    "INSERT INTO device_hits "
                    "(device_id, gforce, energy, hit_duration_ms, recorded_at, counted) "
                    "VALUES "
                    "(:own_id, 2.5, 1.25, 80, NOW() - INTERVAL '5 minutes', true), "
                    "(:foreign_id, 99.0, 77.0, 900, NOW() - INTERVAL '5 minutes', true)"
                ),
                {
                    "own_id": self.own_device_id,
                    "foreign_id": self.foreign_device_id,
                },
            )
            con.commit()

    def tearDown(self):
        try:
            with make_con() as con:
                con.execute(
                    text("DELETE FROM users WHERE id = :id"),
                    {"id": self.user_id},
                )
                con.execute(
                    text(
                        "DELETE FROM companies WHERE id IN (:own_id, :foreign_id)"
                    ),
                    {
                        "own_id": self.company_id,
                        "foreign_id": self.foreign_company_id,
                    },
                )
                con.commit()
        finally:
            self._keys_pepper.stop()
            self._auth_pepper.stop()

    def _set_enabled(self, enabled: bool):
        with make_con() as con:
            con.execute(
                text(
                    "UPDATE companies SET external_api_enabled = :enabled "
                    "WHERE id = :cid"
                ),
                {"enabled": enabled, "cid": self.company_id},
            )
            con.commit()

    def _insert_key(self, company_id: str | None = None):
        raw_key, key_prefix = api_key_auth.generate_api_key()
        key_id = str(uuid.uuid4())
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO api_keys "
                    "(id, company_id, name, key_prefix, key_hash) "
                    "VALUES (:id, :cid, 'Integration', :prefix, :hash)"
                ),
                {
                    "id": key_id,
                    "cid": company_id or self.company_id,
                    "prefix": key_prefix,
                    "hash": api_key_auth.hash_api_key(raw_key),
                },
            )
            con.commit()
        return key_id, raw_key

    @staticmethod
    def _headers(raw_key: str):
        return {"Authorization": f"Bearer {raw_key}"}

    @staticmethod
    def _range_params(device_id: str | None = None):
        now = datetime.now(timezone.utc)
        params = {
            "from": (now - timedelta(days=1)).isoformat(),
            "to": (now + timedelta(days=1)).isoformat(),
        }
        if device_id:
            params["device_id"] = device_id
        return params

    def test_plaintext_key_is_only_returned_once_and_never_stored_or_listed(self):
        self._set_enabled(True)
        created = asyncio.run(
            create_api_key(CreateApiKeyRequest(name="ERP production"), user=self.user)
        )
        raw_key = created["key"]

        with make_con() as con:
            stored = con.execute(
                text(
                    "SELECT key_plain, key_hash, key_prefix FROM api_keys "
                    "WHERE id = :id"
                ),
                {"id": created["id"]},
            ).fetchone()

        self.assertIsNone(stored.key_plain)
        self.assertEqual(stored.key_hash, api_key_auth.hash_api_key(raw_key))
        self.assertNotEqual(stored.key_hash, raw_key)
        self.assertEqual(stored.key_prefix, created["key_prefix"])

        listed = asyncio.run(list_api_keys(user=self.user))
        listed_json = json.dumps(listed, default=str)
        self.assertNotIn(raw_key, listed_json)
        self.assertEqual(len(listed), 1)
        self.assertNotIn("key", listed[0])
        self.assertNotIn("key_hash", listed[0])
        self.assertNotIn("key_plain", listed[0])

    def test_valid_key_is_closed_until_company_entitlement_is_enabled(self):
        _, raw_key = self._insert_key()

        denied = client.get(
            "/api/v1/external/v1/devices", headers=self._headers(raw_key)
        )
        self.assertEqual(denied.status_code, 401)

        with make_con() as con:
            last_used_while_closed = con.execute(
                text(
                    "SELECT last_used_at FROM api_keys "
                    "WHERE key_hash = :hash"
                ),
                {"hash": api_key_auth.hash_api_key(raw_key)},
            ).scalar()
        self.assertIsNone(last_used_while_closed)

        self._set_enabled(True)
        allowed = client.get(
            "/api/v1/external/v1/devices", headers=self._headers(raw_key)
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(
            {row["id"] for row in allowed.json()}, {self.own_device_id}
        )

    def test_company_and_device_data_are_isolated(self):
        self._set_enabled(True)
        _, raw_key = self._insert_key()

        devices = client.get(
            "/api/v1/external/v1/devices", headers=self._headers(raw_key)
        )
        self.assertEqual(devices.status_code, 200)
        self.assertEqual(
            {row["id"] for row in devices.json()}, {self.own_device_id}
        )

        hits = client.get(
            "/api/v1/external/v1/hits",
            headers=self._headers(raw_key),
            params=self._range_params(),
        )
        self.assertEqual(hits.status_code, 200)
        self.assertEqual(len(hits.json()["hits"]), 1)
        self.assertEqual(hits.json()["hits"][0]["device_id"], self.own_device_id)
        self.assertEqual(hits.json()["hits"][0]["gforce"], 2.5)

        stats = client.get(
            "/api/v1/external/v1/stats",
            headers=self._headers(raw_key),
            params=self._range_params(),
        )
        self.assertEqual(stats.status_code, 200)
        self.assertEqual(stats.json()["count"], 1)
        self.assertEqual(stats.json()["gforce_peak"], 2.5)

        foreign_device = client.get(
            "/api/v1/external/v1/hits",
            headers=self._headers(raw_key),
            params=self._range_params(self.foreign_device_id),
        )
        self.assertEqual(foreign_device.status_code, 404)

    def test_revocation_takes_effect_on_the_next_request(self):
        self._set_enabled(True)
        key_id, raw_key = self._insert_key()
        headers = self._headers(raw_key)

        self.assertEqual(
            client.get("/api/v1/external/v1/devices", headers=headers).status_code,
            200,
        )
        revoked = asyncio.run(revoke_or_delete_api_key(key_id, user=self.user))
        self.assertEqual(revoked, {"status": "revoked"})

        denied = client.get("/api/v1/external/v1/devices", headers=headers)
        self.assertEqual(denied.status_code, 401)

        with make_con() as con:
            stored = con.execute(
                text(
                    "SELECT is_active, revoked_at FROM api_keys WHERE id = :id"
                ),
                {"id": key_id},
            ).fetchone()
        self.assertFalse(stored.is_active)
        self.assertIsNotNone(stored.revoked_at)


if __name__ == "__main__":
    unittest.main()
