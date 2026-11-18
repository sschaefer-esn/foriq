"""Static frontend export (frontend_static.py) and loopback protection of the
app endpoints (utils/app_only.py). No database required."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import Depends, FastAPI, HTTPException
from starlette.testclient import TestClient

from frontend_static import install_frontend
from utils.app_only import AppOnlyGuard, is_app_only_path, is_loopback_host, require_app


def _with_client(app, host):
    """Set the client's socket address (TestClient reports 'testclient' otherwise)."""

    async def wrapper(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "client": (host, 50000)}
        await app(scope, receive, send)

    return wrapper


def _write(root: Path, rel: str, text: str):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class FrontendStaticTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        _write(root, "index.html", "ROOT")
        _write(root, "404.html", "NOTFOUND")
        _write(root, "devices.html", "DEVICES")
        _write(root, "devices.txt", "RSC")
        _write(root, "settings.html", "SETTINGS")
        _write(root, "settings/users.html", "USERS")
        _write(root, "_next/static/chunks/app.js", "JS")
        _write(root, "foriq-icon.svg", "<svg/>")
        _write(root, "apple-touch-icon.png", "PNG")
        (Path(self.tmp.name).parent / "foriq-secret.txt").write_text("SECRET")

        app = FastAPI()

        @app.get("/api/v1/thing")
        async def thing():
            return {"ok": True}

        @app.get("/api/v1/missing")
        async def missing():
            raise HTTPException(status_code=404, detail="Device not found")

        @app.get("/health")
        async def health():
            return {"status": "ok"}

        with patch.dict(os.environ, {"FORIQ_FRONTEND_DIR": str(root)}):
            self.assertTrue(install_frontend(app))
        self.client = TestClient(app, follow_redirects=False)

    def tearDown(self):
        self.tmp.cleanup()
        (Path(self.tmp.name).parent / "foriq-secret.txt").unlink(missing_ok=True)

    def test_root_and_deep_links_serve_html(self):
        for path, body in (("/", "ROOT"), ("/devices", "DEVICES"), ("/settings", "SETTINGS"),
                           ("/settings/users", "USERS"), ("/devices?device=abc", "DEVICES")):
            with self.subTest(path=path):
                res = self.client.get(path)
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.text, body)
                self.assertEqual(res.headers["cache-control"], "no-cache")
                self.assertTrue(res.headers["content-type"].startswith("text/html"))

    def test_precomposed_touch_icon_alias(self):
        res = self.client.get("/apple-touch-icon-precomposed.png")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.text, "PNG")
        self.assertEqual(res.headers["content-type"], "image/png")

    def test_static_assets_are_immutable(self):
        res = self.client.get("/_next/static/chunks/app.js")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.text, "JS")
        self.assertIn("immutable", res.headers["cache-control"])
        self.assertEqual(self.client.get("/foriq-icon.svg").headers["cache-control"], "no-cache")
        self.assertEqual(self.client.get("/devices.txt").text, "RSC")

    def test_unknown_page_serves_404_html(self):
        res = self.client.get("/does-not-exist")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.text, "NOTFOUND")
        self.assertEqual(self.client.get("/_next/static/missing.js").headers["cache-control"], "no-cache")

    def test_trailing_slash_redirects(self):
        res = self.client.get("/settings/users/?x=1")
        self.assertEqual(res.status_code, 308)
        self.assertEqual(res.headers["location"], "/settings/users?x=1")

    def test_renamed_pages_redirect(self):
        for old, new in (("/daten", "/data"), ("/hallenlayout/", "/floor-plan"),
                         ("/daten?device=abc", "/data?device=abc")):
            with self.subTest(path=old):
                res = self.client.get(old)
                self.assertEqual(res.status_code, 308)
                self.assertEqual(res.headers["location"], new)

    def test_api_is_never_shadowed(self):
        self.assertEqual(self.client.get("/api/v1/thing").json(), {"ok": True})
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        for path in ("/api/v1/x", "/api", "/api/", "/healthz"):
            with self.subTest(path=path):
                res = self.client.get(path)
                self.assertEqual(res.status_code, 404)
                self.assertEqual(res.headers["content-type"], "application/json")
        res = self.client.get("/api/v1/missing")
        self.assertEqual(res.json(), {"detail": "Device not found"})
        # Wrong method on an API route stays 405.
        self.assertEqual(self.client.post("/api/v1/thing").status_code, 405)
        self.assertEqual(self.client.post("/devices").status_code, 405)

    def test_no_path_traversal(self):
        for path in ("/../foriq-secret.txt", "/%2e%2e/foriq-secret.txt", "/..%2fforiq-secret.txt"):
            with self.subTest(path=path):
                res = self.client.get(path)
                self.assertNotEqual(res.text, "SECRET")

    def test_missing_dir_serves_api_only(self):
        app = FastAPI()
        with patch.dict(os.environ, {"FORIQ_FRONTEND_DIR": "/nonexistent/out"}):
            self.assertFalse(install_frontend(app))
        with patch.dict(os.environ, {"FORIQ_FRONTEND_DIR": ""}):
            self.assertFalse(install_frontend(app))
        res = TestClient(app).get("/")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.headers["content-type"], "application/json")


class AppOnlyGuardTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_middleware(AppOnlyGuard)

        @app.get("/api/v1/devices/app/lookup", dependencies=[Depends(require_app)])
        async def lookup():
            return {"ok": True}

        @app.get("/api/v1/devices/{device_id}")
        async def device(device_id: str):
            return {"id": device_id}

        self.app = app
        self.env = patch.dict(os.environ, {"FORIQ_APP_KEY": "k" * 64})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def _client(self, host):
        return TestClient(_with_client(self.app, host))

    def test_loopback_with_key_is_accepted(self):
        for host in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            with self.subTest(host=host):
                res = self._client(host).get("/api/v1/devices/app/lookup", headers={"X-Foriq-App-Key": "k" * 64})
                self.assertEqual(res.status_code, 200)

    def test_loopback_without_valid_key_is_rejected(self):
        client = self._client("127.0.0.1")
        self.assertEqual(client.get("/api/v1/devices/app/lookup").status_code, 404)
        res = client.get("/api/v1/devices/app/lookup", headers={"X-Foriq-App-Key": "wrong"})
        self.assertEqual(res.status_code, 404)
        with patch.dict(os.environ, {"FORIQ_APP_KEY": ""}):
            res = client.get("/api/v1/devices/app/lookup", headers={"X-Foriq-App-Key": ""})
            self.assertEqual(res.status_code, 404)

    def test_lan_is_rejected_even_with_key_and_forwarded_header(self):
        client = self._client("192.168.1.20")
        headers = {"X-Foriq-App-Key": "k" * 64, "X-Forwarded-For": "127.0.0.1"}
        for path in ("/api/v1/devices/app/lookup", "/api/v1/devices/app", "/API/v1/Devices/App/lookup",
                     "/api/v1//devices/app/lookup", "/api/v1/devices/%61pp/lookup"):
            with self.subTest(path=path):
                res = client.get(path, headers=headers)
                self.assertEqual(res.status_code, 404)
                self.assertEqual(res.json(), {"detail": "Not Found"})
        # Other device paths remain reachable from the LAN.
        self.assertEqual(client.get("/api/v1/devices/abc").json(), {"id": "abc"})

    def test_helpers(self):
        self.assertTrue(is_loopback_host("127.0.0.5"))
        self.assertFalse(is_loopback_host("10.0.0.1"))
        self.assertFalse(is_loopback_host(None))
        self.assertFalse(is_loopback_host("testclient"))
        self.assertTrue(is_app_only_path("/api/v1/devices/app/provision"))
        self.assertFalse(is_app_only_path("/api/v1/devices/pending"))


class MainAppWiringTests(unittest.TestCase):
    def test_main_app_has_guard_and_no_cors(self):
        import main

        classes = [m.cls for m in main.app.user_middleware]
        self.assertIn(AppOnlyGuard, classes)
        self.assertFalse(any(c.__name__ == "CORSMiddleware" for c in classes))

    def test_main_app_rejects_app_endpoints_from_lan(self):
        import main

        with patch.dict(os.environ, {"FORIQ_APP_KEY": "k" * 64}):
            client = TestClient(_with_client(main.app, "192.168.1.20"))
            res = client.post("/api/v1/devices/app/reset-owner-password", headers={"X-Foriq-App-Key": "k" * 64})
            self.assertEqual(res.status_code, 404)


if __name__ == "__main__":
    unittest.main()
