import logging
import re
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import text

from utils.db import make_con
from utils.auth_utils import check_new_password, hash_password, verify_password, create_token
from utils.default_language import default_name
from utils.dependencies import get_current_user
from utils.ratelimit import limiter, _client_ip

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
logger = logging.getLogger("foriq.auth")


def _audit(event_type: str, status: str, request: Request, user_id: str | None = None, email: str | None = None):
    """Write an auth event to audit_logs. Must never break the auth flow."""
    try:
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO audit_logs (user_id, email, event_type, ip_address, user_agent, status) "
                    "VALUES (:uid, :email, :et, :ip, :ua, :st)"
                ),
                {
                    "uid": user_id,
                    "email": email,
                    "et": event_type,
                    "ip": _client_ip(request),
                    "ua": (request.headers.get("user-agent") or "")[:500],
                    "st": status,
                },
            )
            con.commit()
    except Exception:
        logger.exception("Audit log failed (%s/%s)", event_type, status)


def normalize_username(value: str) -> str:
    """Local operation: sign-in by username instead of email. The field is still
    called `email` in the API and DB (existing accounts sign in with their old
    email address); case-insensitive."""
    name = (value or "").strip().lower()
    if not name:
        raise ValueError("Username missing")
    if len(name) > 255:
        raise ValueError("Username too long")
    return name


class RegisterRequest(BaseModel):
    company_name: str | None = None
    name: str
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def _username(cls, v: str) -> str:
        return normalize_username(v)


class LoginRequest(BaseModel):
    email: str
    password: str
    remember_me: bool = False

    @field_validator("email")
    @classmethod
    def _username(cls, v: str) -> str:
        return normalize_username(v)


def slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[äöüß]", lambda m: {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}[m.group()], slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")


def _load_memberships(con, user_id: str) -> list[dict]:
    """Load all memberships of a user."""
    rows = con.execute(
        text(
            "SELECT m.company_id, c.name AS company_name, m.role "
            "FROM memberships m JOIN companies c ON c.id = m.company_id "
            "WHERE m.user_id = :user_id ORDER BY m.created_at"
        ),
        {"user_id": user_id},
    ).fetchall()
    return [
        {"id": str(r.company_id), "name": r.company_name, "role": r.role}
        for r in rows
    ]


def _has_users(con) -> bool:
    return con.execute(text("SELECT 1 FROM users LIMIT 1")).fetchone() is not None


@router.get("/setup-status")
async def setup_status():
    """First start: as long as there is no user, /register creates the owner."""
    with make_con() as con:
        return {"needs_setup": not _has_users(con)}


@router.post("/register")
@limiter.limit("5/hour")
async def register(request: Request, body: RegisterRequest):
    """First start only: creates the first user as owner together with the company.
    Further users are created by the owner/admin under Settings > Users."""
    check_new_password(body.password)
    with make_con() as con:
        # Lock against two concurrent first registrations.
        con.execute(text("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE"))
        if _has_users(con):
            raise HTTPException(
                status_code=403,
                detail="Foriq is already set up. New users are created by the admin.",
            )

        pw_hash = hash_password(body.password)
        user = con.execute(
            text(
                "INSERT INTO users (email, password_hash, name) "
                "VALUES (:email, :pw_hash, :name) RETURNING id"
            ),
            {"email": body.email, "pw_hash": pw_hash, "name": body.name},
        ).fetchone()
        user_id = str(user[0])

        # Create the company (locally always exactly one)
        company_name = (body.company_name or "").strip() or default_name("company")
        company = con.execute(
            text("INSERT INTO companies (name, slug) VALUES (:name, :slug) RETURNING id"),
            {"name": company_name, "slug": slugify(company_name)},
        ).fetchone()
        con.execute(
            text(
                "INSERT INTO memberships (user_id, company_id, role) "
                "VALUES (:user_id, :company_id, 'owner')"
            ),
            {"user_id": user_id, "company_id": str(company[0])},
        )

        # Alle Memberships laden
        companies = _load_memberships(con, user_id)

        con.commit()

    _audit("register", "success", request, user_id, body.email)

    if companies:
        active = companies[0]
        token = create_token(
            user_id=user_id,
            email=body.email,
            role=active["role"],
            company_id=active["id"],
            name=body.name,
            company_name=active["name"],
        )
    else:
        active = None
        token = create_token(
            user_id=user_id,
            email=body.email,
            role="",
            company_id="",
            name=body.name,
            company_name="",
        )

    return {
        "token": token,
        "user": {
            "id": user_id,
            "email": body.email,
            "name": body.name,
            "role": active["role"] if active else "",
            "company_name": active["name"] if active else "",
        },
        "companies": companies,
    }


@router.post("/login")
@limiter.limit("10/15minutes")
async def login(request: Request, body: LoginRequest):
    with make_con() as con:
        row = con.execute(
            text(
                "SELECT id, email, name, password_hash, token_version FROM users "
                "WHERE lower(email) = :email"
            ),
            {"email": body.email},
        ).fetchone()

        if not row:
            _audit("login", "failed", request, None, body.email)
            raise HTTPException(status_code=401, detail="Invalid credentials")

        if not verify_password(body.password, row.password_hash):
            _audit("login", "failed", request, str(row.id), body.email)
            raise HTTPException(status_code=401, detail="Invalid credentials")

        user_id = str(row.id)

        # Alle Memberships laden
        companies = _load_memberships(con, user_id)

        con.commit()

    _audit("login", "success", request, user_id, row.email)

    exp_hours = 30 * 24 if body.remember_me else None

    if companies:
        active = companies[0]
        token = create_token(
            user_id=user_id,
            email=row.email,
            role=active["role"],
            company_id=active["id"],
            name=row.name,
            company_name=active["name"],
            expiration_hours=exp_hours,
            token_version=row.token_version,
        )
    else:
        active = None
        token = create_token(
            user_id=user_id,
            email=row.email,
            role="",
            company_id="",
            name=row.name,
            company_name="",
            expiration_hours=exp_hours,
            token_version=row.token_version,
        )

    return {
        "token": token,
        "user": {
            "id": user_id,
            "email": row.email,
            "name": row.name,
            "role": active["role"] if active else "",
            "company_name": active["name"] if active else "",
        },
        "companies": companies,
    }


class RenameCompanyRequest(BaseModel):
    name: str
    timezone: str | None = None


@router.put("/company")
async def rename_company(body: RenameCompanyRequest, current_user: dict = Depends(get_current_user)):
    user_id = current_user["sub"]
    company_id = current_user["company_id"]

    with make_con() as con:
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :user_id AND company_id = :company_id"
            ),
            {"user_id": user_id, "company_id": company_id},
        ).fetchone()

        if not membership or membership.role != "owner":
            raise HTTPException(status_code=403, detail="Only the owner can rename the company")

        if body.timezone is not None:
            try:
                ZoneInfo(body.timezone)
            except (KeyError, ValueError):
                raise HTTPException(status_code=400, detail="Invalid time zone")

        slug = slugify(body.name)
        if body.timezone is not None:
            con.execute(
                text("UPDATE companies SET name = :name, slug = :slug, timezone = :tz WHERE id = :cid"),
                {"name": body.name, "slug": slug, "tz": body.timezone, "cid": company_id},
            )
        else:
            con.execute(
                text("UPDATE companies SET name = :name, slug = :slug WHERE id = :cid"),
                {"name": body.name, "slug": slug, "cid": company_id},
            )
        con.commit()

    return {"status": "updated", "name": body.name}


@router.get("/company/settings")
async def get_company_settings(current_user: dict = Depends(get_current_user)):
    company_id = current_user["company_id"]
    with make_con() as con:
        row = con.execute(
            text("SELECT name, timezone FROM companies WHERE id = :cid"),
            {"cid": company_id},
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Company not found")
    return {
        "name": row.name,
        "timezone": row.timezone or "Europe/Berlin",
    }


@router.delete("/company")
async def delete_company(current_user: dict = Depends(get_current_user)):
    user_id = current_user["sub"]
    company_id = current_user["company_id"]

    with make_con() as con:
        # Check for owner
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :user_id AND company_id = :company_id"
            ),
            {"user_id": user_id, "company_id": company_id},
        ).fetchone()

        if not membership or membership.role != "owner":
            raise HTTPException(status_code=403, detail="Only the owner can delete the company")

        # CASCADE deletes devices, hits and memberships.
        con.execute(
            text("DELETE FROM companies WHERE id = :cid"),
            {"cid": company_id},
        )
        con.commit()

    return {"status": "deleted"}


@router.delete("/account")
async def delete_account(current_user: dict = Depends(get_current_user)):
    """Delete your own account, provided the user owns no company."""
    user_id = current_user["sub"]

    with make_con() as con:
        owned_companies = con.execute(
            text(
                "SELECT c.name FROM memberships m "
                "JOIN companies c ON c.id = m.company_id "
                "WHERE m.user_id = :uid AND m.role = 'owner' "
                "ORDER BY c.name"
            ),
            {"uid": user_id},
        ).fetchall()

        if owned_companies:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The account still owns at least one company. "
                    "Delete it first, or delete the active company "
                    "together with the account."
                ),
            )

        con.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        con.commit()

    return {"status": "deleted"}


@router.delete("/company-and-account")
async def delete_company_and_account(current_user: dict = Depends(get_current_user)):
    """Delete the active company and your own account atomically."""
    user_id = current_user["sub"]
    company_id = current_user["company_id"]

    with make_con() as con:
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :uid AND company_id = :cid"
            ),
            {"uid": user_id, "cid": company_id},
        ).fetchone()

        if not membership or membership.role != "owner":
            raise HTTPException(
                status_code=403,
                detail="Only the owner can delete the company and account together",
            )

        other_owned_company = con.execute(
            text(
                "SELECT 1 FROM memberships "
                "WHERE user_id = :uid AND role = 'owner' AND company_id != :cid "
                "LIMIT 1"
            ),
            {"uid": user_id, "cid": company_id},
        ).fetchone()

        if other_owned_company:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The account still owns another company. "
                    "Delete or transfer it first."
                ),
            )

        # Both DELETEs run in the same transaction. The foreign keys remove
        # company data and remaining memberships via CASCADE.
        con.execute(text("DELETE FROM companies WHERE id = :cid"), {"cid": company_id})
        con.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        con.commit()

    return {"status": "deleted"}


@router.post("/refresh")
async def refresh_token(request: Request, current_user: dict = Depends(get_current_user)):
    """Renew the token. Keeps the original lifetime."""
    _audit("refresh", "success", request, current_user.get("sub"), current_user.get("email"))
    exp = current_user.get("exp", 0)
    iat = current_user.get("iat", exp - 24 * 3600)
    original_hours = max(round((exp - iat) / 3600), 24)

    token = create_token(
        user_id=current_user["sub"],
        email=current_user["email"],
        role=current_user["role"],
        company_id=current_user["company_id"],
        name=current_user.get("name", ""),
        company_name=current_user.get("company_name", ""),
        expiration_hours=original_hours,
        token_version=current_user.get("token_version", 1),
    )
    return {"token": token}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/me/change-password")
async def change_password(request: Request, body: ChangePasswordRequest, current_user: dict = Depends(get_current_user)):
    """Change the password. Increments token_version -> all other sessions become
    invalid; the calling client receives a fresh token."""
    check_new_password(body.new_password)

    user_id = current_user["sub"]
    with make_con() as con:
        row = con.execute(
            text("SELECT password_hash FROM users WHERE id = :uid"),
            {"uid": user_id},
        ).fetchone()
        if not row or not verify_password(body.current_password, row.password_hash):
            _audit("change_password", "failed", request, user_id, current_user.get("email"))
            # 400 instead of 401: the frontend treats 401 as an expired session and signs out.
            raise HTTPException(status_code=400, detail="Current password is incorrect")

        new_hash = hash_password(body.new_password)
        new_version = con.execute(
            text(
                "UPDATE users SET password_hash = :ph, token_version = token_version + 1 "
                "WHERE id = :uid RETURNING token_version"
            ),
            {"ph": new_hash, "uid": user_id},
        ).scalar()
        con.commit()

    _audit("change_password", "success", request, user_id, current_user.get("email"))

    token = create_token(
        user_id=user_id,
        email=current_user["email"],
        role=current_user["role"],
        company_id=current_user["company_id"],
        name=current_user.get("name", ""),
        company_name=current_user.get("company_name", ""),
        token_version=new_version,
    )
    return {"status": "updated", "token": token}


@router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {
        "id": current_user["sub"],
        "email": current_user["email"],
        "name": current_user.get("name", ""),
        "role": current_user["role"],
        "company_id": current_user["company_id"],
        "company_name": current_user.get("company_name", ""),
    }
