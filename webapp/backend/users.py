from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy import text

from auth import normalize_username
from utils.auth_utils import check_new_password, hash_password
from utils.db import make_con
from utils.dependencies import require_role, get_current_user

router = APIRouter(prefix="/api/v1/users", tags=["users"])


class CreateUserRequest(BaseModel):
    """Local operation: the admin creates users directly with a password (no emails).
    `email` holds the username (field name kept for compatibility)."""
    email: str
    name: str
    password: str
    role: str = "viewer"

    @field_validator("email")
    @classmethod
    def _username(cls, v: str) -> str:
        return normalize_username(v)


class ResetPasswordRequest(BaseModel):
    password: str


class UpdateRoleRequest(BaseModel):
    role: str


@router.get("")
async def list_users(user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]

    with make_con() as con:
        members = con.execute(
            text(
                "SELECT u.id, u.email, u.name, m.role, m.created_at "
                "FROM memberships m JOIN users u ON u.id = m.user_id "
                "WHERE m.company_id = :cid ORDER BY m.created_at"
            ),
            {"cid": company_id},
        ).fetchall()

    return {
        "members": [
            {
                "id": str(m.id),
                "email": m.email,
                "name": m.name,
                "role": m.role,
                "created_at": str(m.created_at) if m.created_at else None,
            }
            for m in members
        ],
    }


@router.post("")
async def create_user(body: CreateUserRequest, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]

    if body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'viewer'")
    check_new_password(body.password)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name missing")

    with make_con() as con:
        existing = con.execute(
            text("SELECT 1 FROM users WHERE lower(email) = :email"),
            {"email": body.email},
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username is already taken")

        new_id = con.execute(
            text(
                "INSERT INTO users (email, password_hash, name) "
                "VALUES (:email, :pw_hash, :name) RETURNING id"
            ),
            {"email": body.email, "pw_hash": hash_password(body.password), "name": name},
        ).scalar()
        con.execute(
            text(
                "INSERT INTO memberships (user_id, company_id, role) "
                "VALUES (:user_id, :cid, :role)"
            ),
            {"user_id": str(new_id), "cid": company_id, "role": body.role},
        )
        con.commit()

    return {"status": "created", "id": str(new_id)}


@router.put("/{user_id}/password")
async def reset_user_password(user_id: str, body: ResetPasswordRequest, user=Depends(require_role("owner", "admin"))):
    """Reset a member's password (forgotten password, no email).
    Same hierarchy as for removal; signs the user out of all sessions."""
    company_id = user["company_id"]
    check_new_password(body.password)
    if user_id == user["sub"]:
        raise HTTPException(status_code=400, detail="Change your own password under Account")

    with make_con() as con:
        membership = con.execute(
            text("SELECT role FROM memberships WHERE user_id = :user_id AND company_id = :cid"),
            {"user_id": user_id, "cid": company_id},
        ).fetchone()
        if not membership:
            raise HTTPException(status_code=404, detail="Member not found")
        if membership.role == "owner" or (user["role"] == "admin" and membership.role == "admin"):
            raise HTTPException(status_code=403, detail="Permission denied")

        con.execute(
            text(
                "UPDATE users SET password_hash = :ph, token_version = token_version + 1 "
                "WHERE id = :uid"
            ),
            {"ph": hash_password(body.password), "uid": user_id},
        )
        con.commit()

    return {"status": "updated"}


@router.put("/{user_id}/role")
async def update_role(user_id: str, body: UpdateRoleRequest, user=Depends(require_role("owner"))):
    company_id = user["company_id"]

    if body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'viewer'")

    with make_con() as con:
        # Check that the target user is a member
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"user_id": user_id, "cid": company_id},
        ).fetchone()

        if not membership:
            raise HTTPException(status_code=404, detail="Member not found")

        if membership.role == "owner":
            raise HTTPException(status_code=403, detail="Owner role cannot be changed")

        con.execute(
            text(
                "UPDATE memberships SET role = :role "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"role": body.role, "user_id": user_id, "cid": company_id},
        )
        con.commit()

    return {"status": "updated"}


@router.delete("/{user_id}")
async def remove_user(user_id: str, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]
    current_role = user["role"]

    with make_con() as con:
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"user_id": user_id, "cid": company_id},
        ).fetchone()

        if not membership:
            raise HTTPException(status_code=404, detail="Member not found")

        if membership.role == "owner":
            raise HTTPException(status_code=403, detail="Owner cannot be removed")

        # Admins can only remove viewers; owners can remove anyone
        if current_role == "admin" and membership.role == "admin":
            raise HTTPException(status_code=403, detail="Admins cannot remove other admins")

        con.execute(
            text(
                "DELETE FROM memberships "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"user_id": user_id, "cid": company_id},
        )
        # Locally there are no invitations any more: without a membership the
        # account is orphaned and would only block the username -> delete it too.
        con.execute(
            text(
                "DELETE FROM users WHERE id = :user_id "
                "AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = :user_id)"
            ),
            {"user_id": user_id},
        )
        con.commit()

    return {"status": "removed"}


@router.post("/leave")
async def leave_company(user=Depends(get_current_user)):
    company_id = user["company_id"]
    user_id = user["sub"]

    with make_con() as con:
        membership = con.execute(
            text(
                "SELECT role FROM memberships "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"user_id": user_id, "cid": company_id},
        ).fetchone()

        if not membership:
            raise HTTPException(status_code=404, detail="No membership found")

        if membership.role == "owner":
            raise HTTPException(status_code=403, detail="The owner cannot leave the company")

        con.execute(
            text(
                "DELETE FROM memberships "
                "WHERE user_id = :user_id AND company_id = :cid"
            ),
            {"user_id": user_id, "cid": company_id},
        )
        con.commit()

    return {"status": "left"}
