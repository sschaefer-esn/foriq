import asyncio
import struct
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from starlette.testclient import TestClient

from ingest import router as ingest_router
from ingest import (
    MAX_HITS_BYTES,
    _decode_hits,
    _read_limited_body,
    receive_hits_binary_v3,
    receive_hits_binary_v4,
    report_command_result,
    receive_hits_binary,
)
from auth import login, register
from devices import activate_device
from external_api import get_stats, list_devices, list_hits
from ota import check_update, download_file, report_progress
from settings import settings_sync
from utils.ratelimit import (
    api_key_rate_key,
    client_ip_key,
    limiter,
)


def _request(*headers):
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": ("203.0.113.10", 12345),
    })


class _StreamingRequest:
    def __init__(self, chunks=()):
        self.headers = {}
        self.chunks = chunks
        self.body_read = False

    async def stream(self):
        self.body_read = True
        for chunk in self.chunks:
            yield chunk


class RateLimitSecurityTests(unittest.TestCase):
    @staticmethod
    def _limits(endpoint):
        name = f"{endpoint.__module__}.{endpoint.__name__}"
        return limiter._route_limits[name]

    def test_api_key_bucket_is_stable_and_opaque(self):
        api_secret = "frq_super-secret-api-key"
        api_request = _request(("authorization", f"Bearer {api_secret}"))

        api_key = api_key_rate_key(api_request)

        self.assertNotIn(api_secret, api_key)
        self.assertEqual(api_key, api_key_rate_key(api_request))

    def test_missing_secret_falls_back_to_socket_ip_bucket(self):
        # No proxy in front of the backend: X-Forwarded-For must not select the bucket.
        request = _request(("x-forwarded-for", "198.51.100.7, 10.0.0.1"))
        self.assertEqual(api_key_rate_key(request), "ip:203.0.113.10")

    def test_credential_routes_are_limited(self):
        for endpoint in (login, register, activate_device):
            with self.subTest(endpoint=endpoint.__name__):
                self.assertTrue(self._limits(endpoint))

    def test_device_routes_are_not_limited(self):
        endpoints = (
            receive_hits_binary,
            receive_hits_binary_v3,
            receive_hits_binary_v4,
            report_command_result,
            settings_sync,
            check_update,
            download_file,
            report_progress,
        )
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint.__name__):
                name = f"{endpoint.__module__}.{endpoint.__name__}"
                self.assertFalse(limiter._route_limits.get(name))

    def test_all_external_api_routes_have_key_and_shared_ip_limits(self):
        for endpoint in (list_devices, list_hits, get_stats):
            with self.subTest(endpoint=endpoint.__name__):
                limits = self._limits(endpoint)
                self.assertTrue(any(l.key_func is api_key_rate_key for l in limits))
                self.assertTrue(
                    any(
                        l.key_func is client_ip_key and l.scope == "external-api-ip"
                        for l in limits
                    )
                )


class IngestBodySecurityTests(unittest.TestCase):
    def test_legacy_candidate_field_is_accepted_but_not_counted(self):
        now = datetime.now(timezone.utc)
        body = struct.pack(
            "<IHffHff", 10, 0, 1.0, 2.0, 40, 0.0, -2.4,
        )

        received, skipped, repaired, records = _decode_hits(body, 3, now)

        self.assertEqual((received, skipped, repaired), (1, 1, 0))
        self.assertEqual(records, [])

    def test_v4_hit_with_uncalibrated_clock_is_rebased_not_dropped(self):
        now = datetime.now(timezone.utc)
        body = b"".join([
            struct.pack("<IHffHffQI", 10, 0, 1.0, 2.0, 40, 0.0, 0.9, 42, 1),
            struct.pack("<IHffHffQI", 12, 0, 1.0, 2.0, 40, 0.0, 0.9, 42, 2),
        ])

        received, skipped, repaired, records = _decode_hits(body, 4, now)

        self.assertEqual((received, skipped, repaired), (2, 0, 2))
        self.assertEqual(len(records), 2)
        self.assertEqual(records[1]["recorded_at"], now)
        self.assertEqual(
            (records[1]["recorded_at"] - records[0]["recorded_at"]).total_seconds(),
            2.0,
        )

    def test_public_hit_endpoint_rejects_invalid_token_without_reading_body(self):
        app = FastAPI()
        app.state.limiter = limiter
        app.include_router(ingest_router)

        with (
            TestClient(app) as client,
            patch("ingest._authenticate_hit_device_sync", return_value=None),
            patch("ingest._read_limited_body") as body_reader,
        ):
            response = client.post(
                "/api/v1/ingest/hits-bin4",
                headers={"X-Device-Token": "invalid"},
                content=b"should-not-be-read",
            )

        self.assertEqual(response.status_code, 401)
        body_reader.assert_not_called()

    def test_learning_upload_of_fw13_is_accepted_and_discarded(self):
        # TRANSITION(fw<14): remove once all sensors run firmware 14.
        app = FastAPI()
        app.include_router(ingest_router)

        with TestClient(app) as client:
            ok = client.post(
                "/api/v1/ingest/learning-chunk-bin2",
                headers={"X-Device-Token": "any"},
                content=b"\x51\x46" + b"\0" * 64,
            )
            missing = client.post(
                "/api/v1/ingest/learning-chunk-bin2", content=b"x",
            )

        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["samples_received"], 0)
        self.assertEqual(missing.status_code, 401)

    def test_streaming_reader_enforces_one_megabyte_without_content_length(self):
        request = _StreamingRequest([b"x" * MAX_HITS_BYTES, b"y"])

        async def exercise():
            with self.assertRaises(HTTPException) as raised:
                await _read_limited_body(request, MAX_HITS_BYTES)
            self.assertEqual(raised.exception.status_code, 413)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
