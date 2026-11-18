"""API key auth for ERP integrations, enabled server-side per company."""
import hashlib
import hmac
import secrets

from fastapi import Header, HTTPException
from sqlalchemy import text

from utils.db import make_con
from config import API_KEY_HMAC_KEY

_PREFIX = "frq_"


def generate_api_key() -> tuple[str, str]:
    """Generate a new key. Returns (full_key, key_prefix)."""
    full_key = f"{_PREFIX}{secrets.token_urlsafe(32)}"
    return full_key, full_key[:12]


def hash_api_key(key: str) -> str:
    if not API_KEY_HMAC_KEY:
        raise RuntimeError("API_KEY_HMAC_KEY is not set for the external API")
    return hmac.new(
        API_KEY_HMAC_KEY.encode("utf-8"), key.encode("utf-8"), hashlib.sha256
    ).hexdigest()


async def require_api_key(authorization: str = Header(None)) -> dict:
    """FastAPI dependency for the external router. Expects
    'Authorization: Bearer frq_...'. Returns {'company_id', 'api_key_id'}."""
    if not API_KEY_HMAC_KEY:
        raise HTTPException(status_code=503, detail="External API is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="API key missing")

    key = authorization.split(" ", 1)[1].strip()
    key_hash = hash_api_key(key)

    with make_con() as con:
        row = con.execute(
            text(
                "SELECT k.id, k.company_id FROM api_keys k "
                "JOIN companies c ON c.id = k.company_id "
                "WHERE k.key_hash = :k AND k.is_active = true "
                "AND c.external_api_enabled = true"
            ),
            {"k": key_hash},
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Invalid or revoked API key")
        con.execute(
            text("UPDATE api_keys SET last_used_at = NOW() WHERE id = :id"),
            {"id": str(row.id)},
        )
        con.commit()

    return {"company_id": str(row.company_id), "api_key_id": str(row.id)}
