from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from utils.db import make_con
from utils.dependencies import require_role
from utils.api_key_auth import generate_api_key, hash_api_key
from config import API_KEY_HMAC_KEY

router = APIRouter(prefix="/api/v1/api-keys", tags=["api-keys"])


class CreateApiKeyRequest(BaseModel):
    name: str


@router.get("")
async def list_api_keys(user=Depends(require_role("owner"))):
    with make_con() as con:
        rows = con.execute(
            text(
                "SELECT id, name, key_prefix, is_active, created_at, last_used_at "
                "FROM api_keys WHERE company_id = :cid ORDER BY created_at DESC"
            ),
            {"cid": user["company_id"]},
        ).fetchall()

    return [
        {
            "id": str(r.id),
            "name": r.name,
            "key_prefix": r.key_prefix,
            "is_active": r.is_active,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "last_used_at": r.last_used_at.isoformat() if r.last_used_at else None,
        }
        for r in rows
    ]


@router.post("")
async def create_api_key(body: CreateApiKeyRequest, user=Depends(require_role("owner"))):
    if not API_KEY_HMAC_KEY:
        raise HTTPException(status_code=503, detail="API_KEY_HMAC_KEY is not set")
    full_key, key_prefix = generate_api_key()
    name = body.name.strip()
    if not name or len(name) > 255:
        raise HTTPException(status_code=422, detail="Name must be 1 to 255 characters long")

    with make_con() as con:
        enabled = con.execute(
            text("SELECT external_api_enabled FROM companies WHERE id = :cid"),
            {"cid": user["company_id"]},
        ).scalar()
        if not enabled:
            raise HTTPException(status_code=403, detail="External API is not enabled for this company")
        row = con.execute(
            text(
                "INSERT INTO api_keys (company_id, name, key_prefix, key_hash, created_by) "
                "VALUES (:cid, :name, :prefix, :key_hash, :uid) "
                "RETURNING id, created_at"
            ),
            {
                "cid": user["company_id"],
                "name": name,
                "prefix": key_prefix,
                "key_hash": hash_api_key(full_key),
                "uid": user["sub"],
            },
        ).fetchone()
        con.commit()

    return {
        "id": str(row.id),
        "name": name,
        "key": full_key,
        "key_prefix": key_prefix,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.patch("/{key_id}")
async def rename_api_key(
    key_id: str, body: CreateApiKeyRequest, user=Depends(require_role("owner"))
):
    with make_con() as con:
        row = con.execute(
            text(
                "UPDATE api_keys SET name = :name "
                "WHERE id = :kid AND company_id = :cid RETURNING id"
            ),
            {"name": body.name, "kid": key_id, "cid": user["company_id"]},
        ).fetchone()
        con.commit()

    if not row:
        raise HTTPException(status_code=404, detail="API key not found")

    return {"status": "renamed"}


@router.delete("/{key_id}")
async def revoke_or_delete_api_key(key_id: str, user=Depends(require_role("owner"))):
    """Active keys are revoked; already revoked keys are deleted permanently."""
    with make_con() as con:
        row = con.execute(
            text("SELECT is_active FROM api_keys WHERE id = :kid AND company_id = :cid"),
            {"kid": key_id, "cid": user["company_id"]},
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="API key not found")

        if row.is_active:
            con.execute(
                text("UPDATE api_keys SET is_active = false, revoked_at = NOW() WHERE id = :kid"),
                {"kid": key_id},
            )
            status = "revoked"
        else:
            con.execute(text("DELETE FROM api_keys WHERE id = :kid"), {"kid": key_id})
            status = "deleted"
        con.commit()

    return {"status": status}
