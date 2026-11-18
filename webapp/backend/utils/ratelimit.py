"""Central rate-limiting configuration (slowapi).

Only login/registration, device activation and the external ERP API are
limited. Storage is in-memory; the backend runs with a single worker.
"""
import hashlib
import hmac

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from config import API_KEY_HMAC_KEY

# A shared limit prevents bucket rotation with changing invalid keys.
EXTERNAL_API_IP_LIMIT = "600/minute"


def _client_ip(request: Request) -> str:
    """Client IP = socket address. There is no proxy in front of the backend, so
    X-Forwarded-For is deliberately ignored (a client could set it freely). Uvicorn
    runs with proxy_headers=False so it does not apply the header itself."""
    return get_remote_address(request)


def client_ip_key(request: Request) -> str:
    """Explicit IP key for additional abuse limits."""
    return f"ip:{_client_ip(request)}"


def _secret_rate_key(namespace: str, secret: str, pepper: str) -> str:
    """Opaque, stable bucket key that keeps the access token out of the rate-limit store."""
    material = f"ratelimit\0{namespace}\0{secret}".encode("utf-8")
    if pepper:
        digest = hmac.new(pepper.encode("utf-8"), material, hashlib.sha256).hexdigest()
    else:
        # Without a pepper the external API is closed anyway. The hash still
        # keeps an accidentally sent key out of storage and logs.
        digest = hashlib.sha256(material).hexdigest()
    return f"{namespace}:{digest}"


def api_key_rate_key(request: Request) -> str:
    """Rate-limit key for the external API, without the plaintext key."""
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        key = auth[7:].strip()
        if key:
            return _secret_rate_key("apikey", key, API_KEY_HMAC_KEY)
    return client_ip_key(request)


limiter = Limiter(key_func=_client_ip, default_limits=[])
