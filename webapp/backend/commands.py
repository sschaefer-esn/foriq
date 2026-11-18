import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError


from utils.db import make_con
from utils.dependencies import require_role
from events import event_manager
from ota import _get_firmware_version, safe_target

router = APIRouter(prefix="/api/v1/devices", tags=["commands"])


def _queue_command(device_id: str, company_id: str, command: str, payload: dict = None):
    """Insert a command into the queue and send an SSE event."""
    with make_con() as con:
        # Check that the device belongs to the company
        device = con.execute(
            text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        row = con.execute(
            text(
                "INSERT INTO device_commands (device_id, command, payload) "
                "VALUES (:did, :cmd, :payload) "
                "RETURNING id, command, payload, status, created_at"
            ),
            {
                "did": device_id,
                "cmd": command,
                "payload": "{}" if payload is None else json.dumps(payload),
            },
        ).fetchone()
        con.commit()

    cmd_data = {
        "id": str(row.id),
        "device_id": device_id,
        "command": row.command,
        "status": row.status,
        "created_at": str(row.created_at),
    }
    event_manager.broadcast(company_id, "command_status", cmd_data)
    return cmd_data


@router.post("/{device_id}/commands/restart")
async def cmd_restart(device_id: str, user=Depends(require_role("owner", "admin"))):
    return _queue_command(device_id, user["company_id"], "restart")


@router.post("/{device_id}/commands/wifi-reset")
async def cmd_wifi_reset(device_id: str, user=Depends(require_role("owner", "admin"))):
    return _queue_command(device_id, user["company_id"], "wifi_reset")


@router.post("/{device_id}/commands/get-setup-password")
async def cmd_get_setup_password(device_id: str, user=Depends(require_role("owner", "admin"))):
    """Request the password live from the device only; the server never stores it."""
    return _queue_command(device_id, user["company_id"], "get_setup_password")


@router.post("/{device_id}/commands/ota-update")
async def cmd_ota_update(device_id: str, user=Depends(require_role("owner", "admin"))):
    """Queue an OTA update command. The device checks with the backend itself.

    Deliberately skips the auto-update backoff - a manual attempt must always
    be possible.
    """
    company_id = user["company_id"]
    with make_con() as con:
        device = con.execute(
            text("SELECT id, firmware_target FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        # Double click / parallel auto-queue: there may be only ONE open row
        # (enforced by the DB via uq_device_commands_open_ota). Return the
        # existing one instead of failing.
        open_cmd = con.execute(
            text(
                "SELECT id, status, progress FROM device_commands "
                "WHERE device_id = :did AND command = 'ota_update' "
                "AND status IN ('pending', 'delivered', 'in_progress') LIMIT 1"
            ),
            {"did": device_id},
        ).fetchone()

    if open_cmd:
        return {
            "id": str(open_cmd.id),
            "device_id": device_id,
            "command": "ota_update",
            "status": open_cmd.status,
            "progress": open_cmd.progress,
            "already_queued": True,
        }

    # Include target_version: otherwise the row drops out of backoff counting and
    # completion detection (both match on payload->>'target_version').
    target = safe_target(device.firmware_target)
    if not target:
        raise HTTPException(
            status_code=409,
            detail="Hardware target unknown; update blocked for safety",
        )
    version = _get_firmware_version(target)
    if version == "unknown":
        raise HTTPException(status_code=503, detail="No firmware available on the server")

    try:
        return _queue_command(
            device_id, company_id, "ota_update",
            {"target_version": version, "source": "manual"},
        )
    except IntegrityError:
        # Race with a parallel sync - the unique index won.
        raise HTTPException(status_code=409, detail="Update already in progress")


@router.post("/{device_id}/commands/ota-cancel")
async def cmd_ota_cancel(device_id: str, user=Depends(require_role("owner", "admin"))):
    """Cancel the active OTA update command."""
    company_id = user["company_id"]
    with make_con() as con:
        device = con.execute(
            text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        row = con.execute(
            text(
                "UPDATE device_commands SET status = 'failed', progress = 'cancelled', "
                "completed_at = NOW() "
                "WHERE device_id = :did AND command = 'ota_update' "
                "AND status IN ('pending', 'delivered', 'in_progress') "
                "RETURNING id"
            ),
            {"did": device_id},
        ).fetchone()
        con.commit()

    if not row:
        raise HTTPException(status_code=404, detail="No active update found")

    event_manager.broadcast(company_id, "command_status", {
        "device_id": device_id,
        "command": "ota_update",
        "progress": "cancelled",
    })
    return {"ok": True}



@router.post("/{device_id}/commands/reset-all")
async def cmd_reset_all(device_id: str, user=Depends(require_role("owner", "admin"))):
    """Cancel all pending commands (OTA, restart, Wi-Fi, etc.)."""
    company_id = user["company_id"]
    with make_con() as con:
        device = con.execute(
            text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        result = con.execute(
            text(
                "UPDATE device_commands SET status = 'failed', progress = 'cancelled', "
                "completed_at = NOW() "
                "WHERE device_id = :did AND status IN ('pending', 'delivered', 'in_progress') "
                "RETURNING id, command"
            ),
            {"did": device_id},
        ).fetchall()

        con.commit()

    cancelled = [{"id": str(r.id), "command": r.command} for r in result]

    # SSE event for every cancelled command
    for cmd in cancelled:
        event_manager.broadcast(company_id, "command_status", {
            "device_id": device_id,
            "command": cmd["command"],
            "progress": "cancelled",
        })

    return {"ok": True, "cancelled_count": len(cancelled), "cancelled": cancelled}


@router.get("/{device_id}/commands")
async def list_commands(device_id: str, user=Depends(require_role("owner", "admin", "viewer"))):
    """Recent commands + status for a device."""
    company_id = user["company_id"]
    with make_con() as con:
        # Check that the device belongs to the company
        device = con.execute(
            text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")

        rows = con.execute(
            text(
                "SELECT id, command, payload, status, created_at, delivered_at "
                "FROM device_commands WHERE device_id = :did "
                "ORDER BY created_at DESC LIMIT 20"
            ),
            {"did": device_id},
        ).fetchall()

    return [
        {
            "id": str(r.id),
            "command": r.command,
            "payload": r.payload,
            "status": r.status,
            "created_at": str(r.created_at),
            "delivered_at": str(r.delivered_at) if r.delivered_at else None,
        }
        for r in rows
    ]
