import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from typing import Optional

from utils.db import make_con
from utils.default_language import default_name
from utils.dependencies import require_role

router = APIRouter(prefix="/api/v1/layouts", tags=["layouts"])


# -- Pydantic Models --

class CreateLayoutRequest(BaseModel):
    name: str = default_name("layout")


class UpdateLayoutRequest(BaseModel):
    name: Optional[str] = None
    grid_cols: Optional[int] = None
    grid_rows: Optional[int] = None


class LayoutItem(BaseModel):
    device_id: str
    x: int
    y: int
    w: int = 3
    h: int = 2


class UpdateItemsRequest(BaseModel):
    items: list[LayoutItem]


# -- Endpoints --

@router.get("")
async def list_layouts(user=Depends(require_role("owner", "admin", "viewer"))):
    company_id = user["company_id"]

    with make_con() as con:
        rows = con.execute(
            text(
                "SELECT id, name, grid_cols, grid_rows, created_at "
                "FROM layouts WHERE company_id = :cid "
                "ORDER BY created_at"
            ),
            {"cid": company_id},
        ).fetchall()

    return [
        {
            "id": str(r.id),
            "name": r.name,
            "grid_cols": r.grid_cols,
            "grid_rows": r.grid_rows,
            "created_at": str(r.created_at),
        }
        for r in rows
    ]


@router.post("")
async def create_layout(body: CreateLayoutRequest, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]

    with make_con() as con:
        row = con.execute(
            text(
                "INSERT INTO layouts (company_id, name) "
                "VALUES (:cid, :name) RETURNING id, name, grid_cols, grid_rows, created_at"
            ),
            {"cid": company_id, "name": body.name.strip()},
        ).fetchone()
        con.commit()

    return {
        "id": str(row.id),
        "name": row.name,
        "grid_cols": row.grid_cols,
        "grid_rows": row.grid_rows,
        "items": [],
        "created_at": str(row.created_at),
    }


@router.get("/{layout_id}")
async def get_layout(layout_id: str, user=Depends(require_role("owner", "admin", "viewer"))):
    company_id = user["company_id"]

    with make_con() as con:
        row = con.execute(
            text(
                "SELECT id, name, grid_cols, grid_rows, items, created_at "
                "FROM layouts WHERE id = :lid AND company_id = :cid"
            ),
            {"lid": layout_id, "cid": company_id},
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Layout not found")

    return {
        "id": str(row.id),
        "name": row.name,
        "grid_cols": row.grid_cols,
        "grid_rows": row.grid_rows,
        # Live state deliberately comes from the same fleet source as the overview.
        "items": row.items or [],
        "created_at": str(row.created_at),
    }


@router.put("/{layout_id}")
async def update_layout(layout_id: str, body: UpdateLayoutRequest, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]

    updates = []
    params = {"lid": layout_id, "cid": company_id}

    if body.name is not None:
        updates.append("name = :name")
        params["name"] = body.name.strip()
    if body.grid_cols is not None:
        updates.append("grid_cols = :gc")
        params["gc"] = body.grid_cols
    if body.grid_rows is not None:
        updates.append("grid_rows = :gr")
        params["gr"] = body.grid_rows

    if not updates:
        raise HTTPException(status_code=400, detail="No changes specified")

    with make_con() as con:
        result = con.execute(
            text(
                f"UPDATE layouts SET {', '.join(updates)} "
                "WHERE id = :lid AND company_id = :cid "
                "RETURNING id, name, grid_cols, grid_rows, created_at"
            ),
            params,
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Layout not found")
        con.commit()

    return {
        "id": str(result.id),
        "name": result.name,
        "grid_cols": result.grid_cols,
        "grid_rows": result.grid_rows,
        "created_at": str(result.created_at),
    }


@router.put("/{layout_id}/items")
async def update_layout_items(layout_id: str, body: UpdateItemsRequest, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]
    items_json = json.dumps([item.model_dump() for item in body.items])

    with make_con() as con:
        # Tenant isolation: only the company's own devices may go into a
        # layout - otherwise foreign device_ids could be injected and their
        # metadata/charts read via get_layout (IDOR).
        device_ids = list({item.device_id for item in body.items})
        if device_ids:
            valid = con.execute(
                text(
                    "SELECT id FROM devices "
                    "WHERE id = ANY(CAST(:ids AS uuid[])) AND company_id = :cid"
                ),
                {"ids": device_ids, "cid": company_id},
            ).fetchall()
            if len(valid) != len(device_ids):
                raise HTTPException(status_code=403, detail="Invalid devices in layout")

        result = con.execute(
            text(
                "UPDATE layouts SET items = CAST(:items AS jsonb) "
                "WHERE id = :lid AND company_id = :cid "
                "RETURNING id"
            ),
            {"lid": layout_id, "cid": company_id, "items": items_json},
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Layout not found")
        con.commit()

    return {"status": "ok"}


@router.delete("/{layout_id}")
async def delete_layout(layout_id: str, user=Depends(require_role("owner", "admin"))):
    company_id = user["company_id"]

    with make_con() as con:
        result = con.execute(
            text("DELETE FROM layouts WHERE id = :lid AND company_id = :cid RETURNING id"),
            {"lid": layout_id, "cid": company_id},
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Layout not found")
        con.commit()

    return {"status": "deleted"}
