"""Device authentication and activation with optional HMAC hardening.

Devices authenticate with a bearer token in the `Device-Token` header.
If DEVICE_TOKEN_HMAC_KEY is set, HMAC-SHA256(server_key, token) is stored and
looked up via an index. Without the optional key the compatible plaintext path
stays active; that keeps small installations simple to run but offers less
protection if the database leaks.

Activation binds the serial number and the device-specific setup code; once
verified, the token is derived deterministically, so the device can safely
retry after a lost HTTP response.
"""
import hashlib
import hmac

from config import DEVICE_TOKEN_HMAC_KEY
from utils.activation_code import activation_claim_digest

_KEY = DEVICE_TOKEN_HMAC_KEY.encode("utf-8")


def hashing_enabled() -> bool:
    return len(_KEY) >= 32


def hash_device_token(token: str | None) -> str | None:
    """HMAC-SHA256 of the token as hex."""
    if not token or not hashing_enabled():
        return None
    return hmac.new(_KEY, token.encode("utf-8"), hashlib.sha256).hexdigest()


def device_token_lookup_params(token: str) -> dict:
    """Parameters for the hash lookup plus the compatible plaintext fallback."""
    return {"token_hash": hash_device_token(token), "device_token": token}


def hash_activation_claim(serial_number: str, activation_code: str) -> str:
    """Domain-separated hash for the one-time device claim."""
    return activation_claim_digest(serial_number, activation_code, _KEY)


def derive_device_token(device_id: str, activation_code: str) -> str:
    """Repeatable only within the server-side claim window."""
    material = f"device-token\0{device_id}\0{activation_code.strip().upper()}"
    encoded = material.encode("utf-8")
    if hashing_enabled():
        digest = hmac.new(_KEY, encoded, hashlib.sha256).hexdigest()
    else:
        digest = hashlib.sha256(encoded).hexdigest()
    return f"fq_{digest[:48]}"
