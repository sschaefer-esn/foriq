import jwt
import bcrypt
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from sqlalchemy import text

from config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRATION_HOURS
from utils.db import make_con


# bcrypt only uses the first 72 bytes of a password; bcrypt 5 raises on longer ones.
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_BYTES = 72


def check_new_password(password: str) -> None:
    """400 for a new password that is too short or longer than bcrypt can hash."""
    if len(password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Password must be at most 72 bytes")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    # bcrypt < 5 silently used only the first 72 bytes; truncating here keeps
    # passwords set back then working and avoids bcrypt 5's ValueError (a 500).
    secret = password.encode("utf-8")[:PASSWORD_MAX_BYTES]
    return bcrypt.checkpw(secret, password_hash.encode("utf-8"))


def create_token(user_id: str, email: str, role: str, company_id: str, name: str = "", company_name: str = "", expiration_hours: int | None = None, token_version: int = 1) -> str:
    hours = expiration_hours if expiration_hours is not None else JWT_EXPIRATION_HOURS
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "company_id": company_id,
        "name": name,
        "company_name": company_name,
        "token_version": token_version,
        "exp": datetime.now(timezone.utc) + timedelta(hours=hours),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict:
    """Signature/expiry check only (no DB)."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def verify_token_and_version(token: str) -> dict:
    """Check the token version and the current company membership/role."""
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    with make_con() as con:
        row = con.execute(
            text(
                "SELECT u.token_version, m.role, c.name AS company_name "
                "FROM users u "
                "LEFT JOIN memberships m ON m.user_id = u.id AND m.company_id = :cid "
                "LEFT JOIN companies c ON c.id = m.company_id "
                "WHERE u.id = :uid"
            ),
            {"uid": payload.get("sub"), "cid": payload.get("company_id") or None},
        ).fetchone()
    if row is None:
        raise jwt.InvalidTokenError("User no longer exists")
    if int(payload.get("token_version", 0)) != int(row.token_version):
        raise jwt.InvalidTokenError("Token revoked")
    if payload.get("company_id"):
        if not row.role:
            raise jwt.InvalidTokenError("Company access revoked")
        # The DB is authoritative: role changes take effect without a new login.
        payload["role"] = row.role
        payload["company_name"] = row.company_name
    return payload
