"""Normalisation and format validation of device activation codes."""
import re
import hashlib
import hmac


# Old devices keep their printed 12-character codes. New devices use three
# easy-to-type words separated by hyphens.
LEGACY_ACTIVATION_CODE_RE = re.compile(r"[A-HJ-NP-Z2-9]{12}", re.IGNORECASE)
WORD_ACTIVATION_CODE_RE = re.compile(r"[a-z]{2,20}(?:-[a-z]{2,20}){2}")


def activation_claim_digest(serial_number: str, activation_code: str, key: bytes = b"") -> str:
    """Digest of serial number + activation code as stored for the activation claim."""
    material = f"claim\0{serial_number.strip()}\0{activation_code.strip().upper()}".encode("utf-8")
    if len(key) >= 32:
        return hmac.new(key, material, hashlib.sha256).hexdigest()
    return hashlib.sha256(material).hexdigest()


def normalize_activation_code(value: str) -> str:
    """Accept new word codes and historical codes in any letter case."""
    code = value.strip()
    lowered = code.lower()
    if WORD_ACTIVATION_CODE_RE.fullmatch(lowered):
        return lowered

    legacy = code.upper()
    if LEGACY_ACTIVATION_CODE_RE.fullmatch(legacy):
        return legacy

    raise ValueError(
        "Activation code must consist of three hyphen-separated words "
        "or a 12-character legacy code"
    )
