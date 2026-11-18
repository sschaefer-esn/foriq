"""Protection of the app endpoints /api/v1/devices/app* (set up/delete a sensor
over USB, reset the owner password).

Only the Electron main process of the Foriq app may call them. It talks to the
backend via 127.0.0.1 and sends the key from secrets.json (FORIQ_APP_KEY).
Two layers:

- AppOnlyGuard (middleware): rejects every path with this prefix that does not
  come from the loopback address - decoded, repeated slashes collapsed,
  case-insensitive (as the app's former reverse proxy did).
- require_app (route dependency): loopback AND a valid key.

Both answer 404 so the endpoints are invisible from outside. Only the socket
address counts; X-Forwarded-For is never evaluated.
"""
import hmac
import ipaddress
import json
import os
import re
from urllib.parse import unquote

from fastapi import HTTPException, Request
from starlette.types import ASGIApp, Receive, Scope, Send

APP_PREFIX = "/api/v1/devices/app"


def app_key() -> str:
    return os.getenv("FORIQ_APP_KEY", "")


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def _client_host(scope: Scope) -> str | None:
    client = scope.get("client")
    return client[0] if client else None


def is_app_only_path(path: str) -> bool:
    try:
        decoded = unquote(path, errors="strict")
    except UnicodeDecodeError:
        return True
    return re.sub(r"/+", "/", decoded).lower().startswith(APP_PREFIX)


class AppOnlyGuard:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] in ("http", "websocket")
            and is_app_only_path(scope.get("path", ""))
            and not is_loopback_host(_client_host(scope))
        ):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
                return
            body = json.dumps({"detail": "Not Found"}).encode()
            await send({
                "type": "http.response.start",
                "status": 404,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def require_app(request: Request):
    """Dependency: loopback with a valid app key only, otherwise 404."""
    key = app_key()
    sent = request.headers.get("X-Foriq-App-Key", "")
    if (
        not key
        or not is_loopback_host(request.client.host if request.client else None)
        or not hmac.compare_digest(sent.encode(), key.encode())
    ):
        raise HTTPException(status_code=404, detail="Not available")
