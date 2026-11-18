import asyncio
import hmac
import json
import re
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import text
from typing import Optional
from uuid import UUID

from utils.db import make_con
from utils.default_language import default_name
from utils.dependencies import require_role
from utils.tz_utils import get_company_tz
from utils.device_token import (
    derive_device_token,
    hash_activation_claim,
    hash_device_token,
    hashing_enabled,
)
from utils.activation_code import normalize_activation_code
from utils.ratelimit import limiter
from utils.app_only import require_app
from events import event_manager
from counting_defaults import (
    DEFAULT_COUNT_BRIDGE_MS,
    DEFAULT_COUNT_SENSITIVITY_BP,
    MAX_COUNT_SENSITIVITY_BP,
    MIN_COUNT_SENSITIVITY_BP,
    normalize_count_sensitivity,
)
from ota import _get_firmware_version, safe_target
from settings import ota_retry_state, OTA_NON_FAILURE_SQL, OTA_FAILURE_WINDOW

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])

# Unknown sensors register themselves and wait for approval. A pending device
# has company_id = NULL and is therefore invisible to all company-scoped
# queries.
PENDING_DETAIL = "Device is waiting for approval"
# Pending = new sensor (not yet assigned to a company) OR a known sensor that
# can no longer prove its code after a reset and must be approved again
# (claim set, but without a time window).
PENDING_NEW_SQL = "(company_id IS NULL AND activated_at IS NULL)"
PENDING_RECONNECT_SQL = (
    "(activated_at IS NOT NULL AND activation_claim_hash IS NOT NULL "
    "AND activation_claim_expires_at IS NULL AND company_id = :cid)"
)


# -- Pydantic models --

class UpdateDeviceRequest(BaseModel):
    """Small customer-facing surface; learning and R&D knobs are internal."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    auto_update: Optional[bool] = None
    restart_schedule: Optional[dict] = None
    # Minimum energy amplitude in basis points.
    count_sensitivity: Optional[int] = None
    # Stroke period T. An explicit NULL resets it to the product default.
    count_bridge_ms: Optional[int] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value):
        if value is None:
            return value
        value = value.strip()
        if not value or len(value) > 255:
            raise ValueError("Name must be 1 to 255 characters long")
        return value

    @field_validator("count_sensitivity")
    @classmethod
    def validate_count_sensitivity(cls, v):
        if v is not None and not (MIN_COUNT_SENSITIVITY_BP <= v <= MAX_COUNT_SENSITIVITY_BP):
            raise ValueError("Sensitivity must be between 0.03 g and 0.80 g")
        return v

    @field_validator("count_bridge_ms")
    @classmethod
    def validate_count_bridge_ms(cls, v):
        if v is not None and not (400 <= v <= 6000):
            raise ValueError("Stroke period must be between 400 and 6000 ms")
        return v

    @field_validator("restart_schedule")
    @classmethod
    def validate_restart_schedule(cls, v):
        if v is None:
            return v
        days = v.get("days")
        time_str = v.get("time")
        if not isinstance(days, list) or not days:
            raise ValueError("At least one day must be selected")
        if not all(isinstance(d, int) and 1 <= d <= 7 for d in days):
            raise ValueError("Days must be between 1 (Mon) and 7 (Sun)")
        if not isinstance(time_str, str) or not re.match(r"^\d{2}:\d{2}$", time_str):
            raise ValueError("Time must be in HH:MM format")
        h, m = int(time_str[:2]), int(time_str[3:5])
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError("Invalid time of day")
        tz = v.get("tz")
        if not isinstance(tz, str) or not tz:
            raise ValueError("Time zone (tz) missing")
        return v


class CopyCountingSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_device_id: UUID
    target_device_ids: list[UUID]

    @field_validator("target_device_ids")
    @classmethod
    def validate_targets(cls, values):
        unique = list(dict.fromkeys(values))
        if not unique:
            raise ValueError("Select at least one target machine")
        if len(unique) > 200:
            raise ValueError("Select at most 200 target machines")
        return unique

    @model_validator(mode="after")
    def validate_source_not_target(self):
        if self.source_device_id in self.target_device_ids:
            raise ValueError("The source machine must not be selected as a target")
        return self


class ProductionCounterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_count: int
    material_count: Optional[int] = None

    @field_validator("target_count", "material_count", mode="before")
    @classmethod
    def reject_boolean_counts(cls, value):
        if isinstance(value, bool):
            raise ValueError("Counts must be whole numbers")
        return value

    @field_validator("target_count")
    @classmethod
    def validate_target_count(cls, value):
        if isinstance(value, bool) or not (1 <= value <= 1_000_000_000):
            raise ValueError("Target quantity must be between 1 and 1,000,000,000")
        return value

    @field_validator("material_count")
    @classmethod
    def validate_material_count(cls, value):
        if value is not None and (
            isinstance(value, bool) or not (0 <= value <= 1_000_000_000)
        ):
            raise ValueError("Material quantity must be between 0 and 1,000,000,000")
        return value


class ActivateRequest(BaseModel):
    serial_number: str
    # The device-specific AP password doubles as the physical claim code.
    # The customer must enter the same code during registration.
    setup_password: str

    @field_validator("setup_password")
    @classmethod
    def validate_setup_password(cls, value):
        return normalize_activation_code(value)


def production_counter_payload(started_at, target_count, material_count, current_count=0):
    if not started_at or not target_count:
        return None
    current = max(0, int(current_count or 0))
    target = max(1, int(target_count))
    material = None if material_count is None else max(0, int(material_count))
    return {
        "started_at": started_at.isoformat() + "Z",
        "target_count": target,
        "material_count": material,
        "current_count": current,
        "remaining_count": max(0, target - current),
        "material_remaining": None if material is None else max(0, material - current),
    }


# -- Endpoints --

@router.get("")
async def list_devices(user=Depends(require_role("owner", "admin", "viewer"))):
    """List all devices of the company, including count_today."""
    company_id = user["company_id"]

    with make_con() as con:
        tz = get_company_tz(con, company_id)
        rows = con.execute(
            text(
                "SELECT d.id, d.name, d.serial_number, "
                "d.firmware_version, d.firmware_target, d.auto_update, "
                "d.upload_interval_s, d.restart_schedule,"
                "d.sleep_mode, d.count_sensitivity, "
                "d.count_bridge_ms, d.count_sensitivity_changed_at, "
                "d.count_bridge_changed_at, "
                "d.hit_drop_count, d.hit_spiffs_write_errors, d.hit_server_rejected_count, "
                "d.hit_last_upload_ms, d.hit_max_upload_ms, d.hit_http_error_count, d.wifi_rssi, "
                "d.hit_queue_ram_count, d.hit_queue_flash_count, d.hit_queue_oldest_age_s, "
                "d.wifi_offline_s, d.wifi_reconnect_count, d.wifi_roam_count, "
                "d.last_seen_at, d.is_active, d.created_at, "
                "COALESCE(h.cnt, 0) AS count_today, "
                # Fleet view: running update + failed attempts since the last
                # success. Without this a stuck or chronically failing rollout
                # would be invisible in the overview.
                "ota.id AS ota_id, ota.status AS ota_status, ota.progress AS ota_progress, "
                "ota.last_progress_at AS ota_last_progress_at, "
                "COALESCE(fails.cnt, 0) AS ota_fail_count, fails.last_error AS ota_last_error "
                "FROM devices d "
                "LEFT JOIN LATERAL ("
                "  SELECT COUNT(*) AS cnt FROM device_hits "
                "  WHERE device_id = d.id "
                "  AND counted IS TRUE "
                "  AND recorded_at >= (NOW() AT TIME ZONE :tz)::date AT TIME ZONE :tz "
                "  AND recorded_at < ((NOW() AT TIME ZONE :tz)::date + 1) AT TIME ZONE :tz"
                ") h ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT id, status, progress, last_progress_at FROM device_commands "
                "  WHERE device_id = d.id AND command = 'ota_update' "
                "  AND status IN ('pending', 'delivered', 'in_progress') "
                "  ORDER BY created_at DESC LIMIT 1"
                ") ota ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT COUNT(*) AS cnt, "
                "         (ARRAY_AGG(c.payload->>'error' ORDER BY c.completed_at DESC))[1] AS last_error "
                "  FROM device_commands c "
                "  WHERE c.device_id = d.id AND c.command = 'ota_update' "
                "  AND c.status = 'failed' AND c.completed_at IS NOT NULL "
                f"  AND COALESCE(c.progress, '') NOT IN ({OTA_NON_FAILURE_SQL}) "
                # Same time window as the backoff derivation, so the displayed
                # number matches the throttle that is actually in effect.
                f"  AND c.completed_at > NOW() - CAST('{OTA_FAILURE_WINDOW}' AS INTERVAL) "
                "  AND c.completed_at > COALESCE(("
                "        SELECT MAX(completed_at) FROM device_commands "
                "        WHERE device_id = d.id AND command = 'ota_update' AND status = 'completed'"
                "      ), '-infinity'::timestamp)"
                ") fails ON true "
                "WHERE d.company_id = :cid "
                "ORDER BY d.created_at DESC"
            ),
            {"cid": company_id, "tz": tz},
        ).fetchall()

    return [
        {
            "id": str(r.id),
            "name": r.name,
            "serial_number": r.serial_number,
            "firmware_version": r.firmware_version,
            "firmware_target": r.firmware_target,
            "auto_update": r.auto_update or False,
            "active_ota": {
                "command_id": str(r.ota_id),
                "status": r.ota_status,
                "progress": r.ota_progress,
                "last_progress_at": r.ota_last_progress_at.isoformat() + "Z"
                if r.ota_last_progress_at else None,
            } if r.ota_id else None,
            "ota_retry": {
                "fail_count": r.ota_fail_count,
                "last_error": r.ota_last_error,
            } if r.ota_fail_count else None,
            "upload_interval_s": r.upload_interval_s or 0,
            "restart_schedule": r.restart_schedule,
            "sleep_mode": r.sleep_mode or False,
            "count_sensitivity": normalize_count_sensitivity(r.count_sensitivity),
            "count_bridge_ms": r.count_bridge_ms,
            "count_sensitivity_changed_at": r.count_sensitivity_changed_at.isoformat() if r.count_sensitivity_changed_at else None,
            "count_bridge_changed_at": r.count_bridge_changed_at.isoformat() if r.count_bridge_changed_at else None,
            "hit_drop_count": r.hit_drop_count or 0,
            "hit_spiffs_write_errors": r.hit_spiffs_write_errors or 0,
            "hit_server_rejected_count": r.hit_server_rejected_count or 0,
            "hit_last_upload_ms": r.hit_last_upload_ms or 0,
            "hit_max_upload_ms": r.hit_max_upload_ms or 0,
            "hit_http_error_count": r.hit_http_error_count or 0,
            "hit_queue_ram_count": r.hit_queue_ram_count or 0,
            "hit_queue_flash_count": r.hit_queue_flash_count or 0,
            "hit_queue_oldest_age_s": r.hit_queue_oldest_age_s or 0,
            "wifi_rssi": r.wifi_rssi,
            "wifi_offline_s": r.wifi_offline_s or 0,
            "wifi_reconnect_count": r.wifi_reconnect_count or 0,
            "wifi_roam_count": r.wifi_roam_count or 0,
            "last_seen_at": r.last_seen_at.isoformat() + "Z" if r.last_seen_at else None,
            "is_active": r.is_active,
            "count_today": r.count_today,
            "created_at": str(r.created_at),
        }
        for r in rows
    ]


# -- Approval of new sensors --

@router.get("/pending")
async def list_pending_devices(user=Depends(require_role("owner", "admin"))):
    """Sensors that registered themselves and are waiting for approval."""
    with make_con() as con:
        rows = con.execute(
            text(
                "SELECT id, name, serial_number, created_at, activated_at IS NOT NULL AS reconnect "
                f"FROM devices WHERE {PENDING_NEW_SQL} OR {PENDING_RECONNECT_SQL} "
                "ORDER BY created_at"
            ),
            {"cid": user["company_id"]},
        ).fetchall()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "serial_number": r.serial_number,
            "reconnect": r.reconnect,
            "created_at": r.created_at.isoformat() + "Z" if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/pending/{device_id}/approve")
async def approve_pending_device(device_id: UUID, user=Depends(require_role("owner", "admin"))):
    """Assign a pending sensor to your own company. It fetches its token on the
    next activation attempt (every ~10 s)."""
    with make_con() as con:
        row = con.execute(
            text(
                "UPDATE devices SET company_id = COALESCE(company_id, :cid), "
                "activation_claim_expires_at = NOW() + INTERVAL '7 days' "
                f"WHERE id = :did AND ({PENDING_NEW_SQL} OR {PENDING_RECONNECT_SQL}) "
                "RETURNING id, name"
            ),
            {"cid": user["company_id"], "did": str(device_id)},
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No pending device found")
        con.commit()
    return {"id": str(row.id), "name": row.name, "status": "approved"}


@router.delete("/pending/{device_id}")
async def reject_pending_device(device_id: UUID, user=Depends(require_role("owner", "admin"))):
    """Reject a pending sensor. If it keeps registering, it shows up again.
    A known sensor is NOT deleted (its history stays) - only its new
    registration is discarded."""
    params = {"did": str(device_id), "cid": user["company_id"]}
    with make_con() as con:
        deleted = con.execute(
            text(f"DELETE FROM devices WHERE id = :did AND {PENDING_NEW_SQL}"), params
        ).rowcount
        if not deleted:
            deleted = con.execute(
                text(
                    "UPDATE devices SET activation_claim_hash = NULL "
                    f"WHERE id = :did AND {PENDING_RECONNECT_SQL}"
                ),
                params,
            ).rowcount
        con.commit()
    if not deleted:
        raise HTTPException(status_code=404, detail="No pending device found")
    return {"status": "deleted"}


def _register_pending_device(con, serial_number: str, setup_password: str) -> None:
    """Create an unknown sensor as pending. The claim hash binds the later
    activation to the setup code the device sends along here."""
    if not serial_number or len(serial_number) > 100:
        return
    con.execute(
        text(
            "INSERT INTO devices (company_id, name, serial_number, is_active, activation_claim_hash) "
            "VALUES (NULL, :name, :sn, false, :claim_hash) "
            "ON CONFLICT (serial_number) DO NOTHING"
        ),
        {
            "name": default_name("sensor", serial=serial_number[-6:]),
            "sn": serial_number,
            "claim_hash": hash_activation_claim(serial_number, setup_password),
        },
    )
    con.commit()


# -- The Foriq app sets up / deletes sensors over USB --
# Only for the Electron main process: loopback + key from secrets.json
# (FORIQ_APP_KEY), see utils/app_only.py. Otherwise -> 404.


@router.post("/app/reset-owner-password", dependencies=[Depends(require_app)])
async def app_reset_owner_password():
    """Forgotten owner password (local, no emails): the Foriq app on the Mac sets
    a new random password. Whoever operates the Mac is considered authorised.
    Lives under /devices/app/*: reachable only via 127.0.0.1 (utils/app_only.py)."""
    import secrets as _secrets
    from utils.auth_utils import hash_password

    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    password = "-".join(
        "".join(_secrets.choice(alphabet) for _ in range(4)) for _ in range(3)
    )
    with make_con() as con:
        row = con.execute(
            text(
                "SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id "
                "WHERE m.role = 'owner' ORDER BY m.created_at LIMIT 1"
            )
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No owner set up yet")
        con.execute(
            text(
                "UPDATE users SET password_hash = :ph, token_version = token_version + 1 "
                "WHERE id = :uid"
            ),
            {"ph": hash_password(password), "uid": str(row.id)},
        )
        con.commit()
    return {"username": row.email, "password": password}


class AppProvisionRequest(BaseModel):
    serial_number: str
    setup_password: str
    name: Optional[str] = None

    @field_validator("serial_number")
    @classmethod
    def validate_serial(cls, value):
        value = (value or "").strip()
        if not value or len(value) > 100:
            raise ValueError("Invalid serial number")
        return value

    @field_validator("setup_password")
    @classmethod
    def validate_setup_password(cls, value):
        return normalize_activation_code(value)


@router.post("/app/provision", dependencies=[Depends(require_app)])
async def app_provision_device(body: AppProvisionRequest):
    """Register a sensor set up over USB. With exactly one company it is approved
    right away: the claim (serial number + setup code) is valid and the sensor
    gets its token on the first /activate. Otherwise it waits under
    "New sensors", just like a self-registered one."""
    name = (body.name or "").strip()[:100] or None
    claim_hash = hash_activation_claim(body.serial_number, body.setup_password)
    with make_con() as con:
        companies = con.execute(text("SELECT id FROM companies LIMIT 2")).fetchall()
        cid = str(companies[0].id) if len(companies) == 1 else None
        row = con.execute(
            text(
                "SELECT id, activated_at FROM devices "
                "WHERE lower(serial_number) = lower(:sn) FOR UPDATE"
            ),
            {"sn": body.serial_number},
        ).fetchone()
        if row and row.activated_at is not None:
            raise HTTPException(status_code=409, detail="Device is already activated")
        params = {
            "cid": cid,
            "sn": body.serial_number,
            "name": name or default_name("sensor", serial=body.serial_number[-6:]),
            "h": claim_hash,
        }
        expires = (
            "CASE WHEN COALESCE({c}, CAST(:cid AS uuid)) IS NULL THEN NULL "
            "ELSE NOW() + INTERVAL '7 days' END"
        )
        if row:
            result = con.execute(
                text(
                    "UPDATE devices SET company_id = COALESCE(company_id, CAST(:cid AS uuid)), "
                    "name = COALESCE(:custom, name), activation_claim_hash = :h, "
                    f"activation_claim_expires_at = {expires.format(c='company_id')} "
                    "WHERE id = :did RETURNING id, name, company_id"
                ),
                {**params, "custom": name, "did": str(row.id)},
            ).fetchone()
        else:
            result = con.execute(
                text(
                    "INSERT INTO devices (company_id, name, serial_number, is_active, "
                    "activation_claim_hash, activation_claim_expires_at) "
                    "VALUES (CAST(:cid AS uuid), :name, :sn, false, :h, "
                    f"{expires.format(c='NULL')}) RETURNING id, name, company_id"
                ),
                params,
            ).fetchone()
        con.commit()
    return {
        "id": str(result.id),
        "name": result.name,
        "status": "approved" if result.company_id else "pending",
    }


@router.get("/app/lookup", dependencies=[Depends(require_app)])
async def app_lookup_device(serial: str):
    """Is this stick known to Foriq? For the sensor card and the delete confirmation."""
    with make_con() as con:
        row = con.execute(
            text(
                "SELECT d.id, d.name, d.last_seen_at, "
                "(SELECT COUNT(*) FROM device_hits h WHERE h.device_id = d.id AND h.counted IS TRUE) AS hits "
                "FROM devices d WHERE lower(d.serial_number) = lower(:sn)"
            ),
            {"sn": serial.strip()},
        ).fetchone()
    if not row:
        return {"known": False}
    return {
        "known": True,
        "id": str(row.id),
        "name": row.name,
        "hits": int(row.hits or 0),
        "last_seen": row.last_seen_at.isoformat() + "Z" if row.last_seen_at else None,
    }


@router.delete("/app/by-serial/{serial}", dependencies=[Depends(require_app)])
async def app_delete_device(serial: str):
    """Remove the sensor and its strokes after the app has wiped the stick."""
    with make_con() as con:
        row = con.execute(
            text("SELECT id FROM devices WHERE lower(serial_number) = lower(:sn)"),
            {"sn": serial.strip()},
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Device not found")
        _delete_device_row(con, str(row.id))
        con.commit()
    return {"status": "deleted"}


@router.post("/activate")
@limiter.limit("20/minute")
async def activate_device(request: Request, body: ActivateRequest):
    """Device claim against serial number + one-time code; token only in the response."""
    device_token, _ = await asyncio.to_thread(_activate_device_sync, body)
    return {"device_token": device_token}


def _activate_device_sync(body: ActivateRequest):
    entered_serial = body.serial_number.strip()

    with make_con() as con:
        row = con.execute(
            text(
                "SELECT id, company_id, serial_number, activation_claim_hash, activation_claim_expires_at, activated_at, "
                "activation_claim_expires_at > NOW() AS activation_claim_valid "
                "FROM devices WHERE lower(serial_number) = lower(:sn) FOR UPDATE"
            ),
            {"sn": entered_serial},
        ).fetchone()
        if not row:
            _register_pending_device(con, entered_serial, body.setup_password)
            raise HTTPException(status_code=403, detail=PENDING_DETAIL)
        if row.company_id is None and row.activated_at is None:
            raise HTTPException(status_code=403, detail=PENDING_DETAIL)
        claim_hash = hash_activation_claim(row.serial_number, body.setup_password)
        if not row.activation_claim_valid:
            if row.activated_at is None:
                raise HTTPException(status_code=410, detail="Activation window expired")
            # Known sensor after a reset: the setup code survives a factory
            # reset. If it matches the stored claim of an earlier approval ->
            # sign in again directly. Otherwise (hash missing/different) submit
            # it for approval again - keeping its history, deleting nothing.
            matches = bool(row.activation_claim_hash) and hmac.compare_digest(
                row.activation_claim_hash, claim_hash
            )
            if not (matches and row.activation_claim_expires_at is not None):
                if not matches:
                    con.execute(
                        text(
                            "UPDATE devices SET activation_claim_hash = :h, "
                            "activation_claim_expires_at = NULL WHERE id = :did"
                        ),
                        {"h": claim_hash, "did": str(row.id)},
                    )
                    con.commit()
                raise HTTPException(status_code=403, detail=PENDING_DETAIL)
        if not row.activation_claim_hash or not hmac.compare_digest(
            row.activation_claim_hash, claim_hash
        ):
            raise HTTPException(status_code=401, detail="Invalid activation code")

        device_token = derive_device_token(str(row.id), body.setup_password)
        con.execute(
            text(
                "UPDATE devices SET device_token = :device_token, "
                "device_token_hash = :token_hash, "
                "is_active = true, "
                "activated_at = COALESCE(activated_at, NOW()), "
                "activation_claim_expires_at = CASE WHEN activated_at IS NULL "
                "THEN NOW() + INTERVAL '10 minutes' ELSE activation_claim_expires_at END "
                "WHERE id = :did"
            ),
            {
                "device_token": None if hashing_enabled() else device_token,
                "token_hash": hash_device_token(device_token),
                "did": str(row.id),
            },
        )
        con.commit()
        return device_token, row


@router.get("/{device_id}")
async def get_device(device_id: str, user=Depends(require_role("owner", "admin", "viewer"))):
    """Device details."""
    company_id = user["company_id"]

    with make_con() as con:
        tz = get_company_tz(con, company_id)
        row = con.execute(
            text(
                "SELECT d.id, d.name, d.serial_number, "
                "d.firmware_version, d.firmware_target, d.auto_update, "
                "d.upload_interval_s, d.restart_schedule,"
                "d.sleep_mode, d.count_sensitivity, "
                "d.count_bridge_ms, d.count_sensitivity_changed_at, "
                "d.count_bridge_changed_at, "
                "d.hit_drop_count, d.hit_spiffs_write_errors, d.hit_server_rejected_count, "
                "d.hit_last_upload_ms, d.hit_max_upload_ms, d.hit_http_error_count, d.wifi_rssi, "
                "d.hit_queue_ram_count, d.hit_queue_flash_count, d.hit_queue_oldest_age_s, "
                "d.wifi_offline_s, d.wifi_reconnect_count, d.wifi_roam_count, "
                "d.production_started_at, d.production_target_count, "
                "d.production_material_count, "
                "d.last_seen_at, d.is_active, d.created_at, "
                "COALESCE(h.cnt, 0) AS count_today, "
                "h.last_hit AS last_hit_at, "
                "COALESCE(h15.cnt, 0) AS hits_last_15m, "
                "COALESCE(pc.cnt, 0) AS production_count, "
                "ni.alert_type AS active_incident_type, ni.condition_since_at AS active_incident_since "
                "FROM devices d "
                "LEFT JOIN LATERAL ("
                "  SELECT COUNT(*) AS cnt, MAX(recorded_at) AS last_hit FROM device_hits "
                "  WHERE device_id = d.id "
                "  AND counted IS TRUE "
                "  AND recorded_at >= (NOW() AT TIME ZONE :tz)::date AT TIME ZONE :tz "
                "  AND recorded_at < ((NOW() AT TIME ZONE :tz)::date + 1) AT TIME ZONE :tz"
                ") h ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT COUNT(*) AS cnt FROM device_hits "
                "  WHERE device_id = d.id "
                "  AND counted IS TRUE "
                "  AND recorded_at >= NOW() - interval '15 minutes'"
                ") h15 ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT COUNT(*) AS cnt FROM device_hits "
                "  WHERE device_id = d.id "
                "  AND counted IS TRUE "
                "  AND d.production_started_at IS NOT NULL "
                "  AND recorded_at >= d.production_started_at"
                ") pc ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT alert_type, condition_since_at FROM notification_incidents "
                "  WHERE device_id = d.id AND resolved_at IS NULL "
                "  ORDER BY triggered_at DESC LIMIT 1"
                ") ni ON true "
                "WHERE d.id = :did AND d.company_id = :cid"
            ),
            {"did": device_id, "cid": company_id, "tz": tz},
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Device not found")

        active_ota = con.execute(
            text(
                "SELECT id, status, progress, created_at, delivered_at, last_progress_at, "
                "payload->>'target_version' AS target_version, payload->>'error' AS error "
                "FROM device_commands "
                "WHERE device_id = :did AND command = 'ota_update' "
                "AND status IN ('pending', 'delivered', 'in_progress') "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            {"did": device_id},
        ).fetchone()

        # Backoff state for the UI: why is nothing happening, and when will it retry?
        # Replaces the former auto-lock as the visible signal for chronic failures.
        ota_retry = None
        if not active_ota and row.firmware_version:
            target = safe_target(row.firmware_target)
            server_version = _get_firmware_version(target) if target else "unknown"
            if server_version != "unknown" and server_version != row.firmware_version:
                fail_count, backoff, last_error = ota_retry_state(con, device_id, server_version)
                if fail_count:
                    next_at = con.execute(
                        text(
                            "SELECT MAX(completed_at) + CAST(:backoff AS INTERVAL) AS ts "
                            "FROM device_commands WHERE device_id = :did "
                            "AND command = 'ota_update' AND status = 'failed' "
                            f"AND COALESCE(progress, '') NOT IN ({OTA_NON_FAILURE_SQL}) "
                            "AND payload->>'target_version' = :tv"
                        ),
                        {"did": device_id, "backoff": backoff, "tv": server_version},
                    ).scalar()
                    ota_retry = {
                        "fail_count": fail_count,
                        "target_version": server_version,
                        "last_error": last_error,
                        "next_attempt_at": next_at.isoformat() + "Z" if next_at else None,
                    }

    return {
        "id": str(row.id),
        "name": row.name,
        "serial_number": row.serial_number,
        "firmware_version": row.firmware_version,
        "firmware_target": row.firmware_target,
        "auto_update": row.auto_update or False,
        "upload_interval_s": row.upload_interval_s or 0,
        "restart_schedule": row.restart_schedule,
        "sleep_mode": row.sleep_mode or False,
        "count_sensitivity": normalize_count_sensitivity(row.count_sensitivity),
        "count_bridge_ms": row.count_bridge_ms,
        "count_sensitivity_changed_at": row.count_sensitivity_changed_at.isoformat() if row.count_sensitivity_changed_at else None,
        "count_bridge_changed_at": row.count_bridge_changed_at.isoformat() if row.count_bridge_changed_at else None,
        "hit_drop_count": row.hit_drop_count or 0,
        "hit_spiffs_write_errors": row.hit_spiffs_write_errors or 0,
        "hit_server_rejected_count": row.hit_server_rejected_count or 0,
        "hit_last_upload_ms": row.hit_last_upload_ms or 0,
        "hit_max_upload_ms": row.hit_max_upload_ms or 0,
        "hit_http_error_count": row.hit_http_error_count or 0,
        "hit_queue_ram_count": row.hit_queue_ram_count or 0,
        "hit_queue_flash_count": row.hit_queue_flash_count or 0,
        "hit_queue_oldest_age_s": row.hit_queue_oldest_age_s or 0,
        "wifi_rssi": row.wifi_rssi,
        "wifi_offline_s": row.wifi_offline_s or 0,
        "wifi_reconnect_count": row.wifi_reconnect_count or 0,
        "wifi_roam_count": row.wifi_roam_count or 0,
        "last_seen_at": row.last_seen_at.isoformat() + "Z" if row.last_seen_at else None,
        "is_active": row.is_active,
        "count_today": row.count_today,
        "last_hit_at": row.last_hit_at.isoformat() + "Z" if row.last_hit_at else None,
        "hits_last_15m": row.hits_last_15m,
        "production": production_counter_payload(
            row.production_started_at,
            row.production_target_count,
            row.production_material_count,
            row.production_count,
        ),
        "active_incident": {
            "type": row.active_incident_type,
            "condition_since_at": row.active_incident_since.isoformat() + "Z",
        } if row.active_incident_type else None,
        "created_at": str(row.created_at),
        "active_ota": {
            "command_id": str(active_ota.id),
            "status": active_ota.status,
            "progress": active_ota.progress,
            "target_version": active_ota.target_version,
            "error": active_ota.error,
            "created_at": active_ota.created_at.isoformat() + "Z" if active_ota.created_at else None,
            "last_progress_at": (active_ota.last_progress_at or active_ota.delivered_at
                                 or active_ota.created_at).isoformat() + "Z"
            if (active_ota.last_progress_at or active_ota.delivered_at or active_ota.created_at) else None,
        } if active_ota else None,
        "ota_retry": ota_retry,
    }


@router.post("/{device_id}/production")
async def start_production_counter(
    device_id: str,
    body: ProductionCounterRequest,
    user=Depends(require_role("owner", "admin")),
):
    """Start the production counter at zero from now on."""
    company_id = user["company_id"]
    with make_con() as con:
        device = con.execute(
            text(
                "SELECT id, production_started_at FROM devices "
                "WHERE id = :did AND company_id = :cid FOR UPDATE"
            ),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")
        if device.production_started_at:
            raise HTTPException(status_code=409, detail="Production counter is already running")

        row = con.execute(
            text(
                "UPDATE devices SET "
                "production_started_at = NOW() AT TIME ZONE 'UTC', "
                "production_target_count = :target, "
                "production_material_count = :material "
                "WHERE id = :did AND company_id = :cid "
                "RETURNING production_started_at, production_target_count, "
                "production_material_count"
            ),
            {
                "did": device_id,
                "cid": company_id,
                "target": body.target_count,
                "material": body.material_count,
            },
        ).fetchone()
        con.commit()

    production = production_counter_payload(
        row.production_started_at,
        row.production_target_count,
        row.production_material_count,
    )
    event_manager.broadcast(company_id, "production_updated", {
        "device_id": device_id,
        "production": production,
    })
    return production


@router.put("/{device_id}/production")
async def update_production_counter(
    device_id: str,
    body: ProductionCounterRequest,
    user=Depends(require_role("owner", "admin")),
):
    """Change target and material quantity without resetting the running counter."""
    company_id = user["company_id"]
    with make_con() as con:
        device = con.execute(
            text(
                "SELECT id, production_started_at FROM devices "
                "WHERE id = :did AND company_id = :cid FOR UPDATE"
            ),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")
        if not device.production_started_at:
            raise HTTPException(
                status_code=409,
                detail="No production counter running",
            )
        production_count = con.execute(
            text(
                "SELECT COUNT(*) FROM device_hits WHERE device_id = :did "
                "AND counted IS TRUE AND recorded_at >= :started_at"
            ),
            {"did": device_id, "started_at": device.production_started_at},
        ).scalar()
        # When editing, the UI states the material available *now*. The total
        # range since the counter started is stored, so further live hits can
        # count down without additional writes.
        stored_material = (
            None if body.material_count is None
            else production_count + body.material_count
        )
        row = con.execute(
            text(
                "UPDATE devices SET production_target_count = :target, "
                "production_material_count = :material "
                "WHERE id = :did AND company_id = :cid "
                "RETURNING production_started_at, production_target_count, "
                "production_material_count"
            ),
            {
                "did": device_id,
                "cid": company_id,
                "target": body.target_count,
                "material": stored_material,
            },
        ).fetchone()
        con.commit()

    production = production_counter_payload(
        row.production_started_at,
        row.production_target_count,
        row.production_material_count,
        production_count,
    )
    event_manager.broadcast(company_id, "production_updated", {
        "device_id": device_id,
        "production": production,
    })
    return production


@router.delete("/{device_id}/production")
async def stop_production_counter(
    device_id: str,
    user=Depends(require_role("owner", "admin")),
):
    """Stop the active production counter; daily data stays unchanged."""
    company_id = user["company_id"]
    with make_con() as con:
        row = con.execute(
            text(
                "UPDATE devices SET production_started_at = NULL, "
                "production_target_count = NULL, production_material_count = NULL "
                "WHERE id = :did AND company_id = :cid RETURNING id"
            ),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Device not found")
        con.commit()

    event_manager.broadcast(company_id, "production_updated", {
        "device_id": device_id,
        "production": None,
    })
    return {"status": "stopped"}


@router.post("/counting-settings/copy")
async def copy_counting_settings(
    body: CopyCountingSettingsRequest,
    user=Depends(require_role("owner", "admin")),
):
    """Copy sensitivity and stroke period T atomically to other machines."""
    company_id = user["company_id"]
    target_params = {
        f"target_{index}": str(device_id)
        for index, device_id in enumerate(body.target_device_ids)
    }
    target_sql = ", ".join(
        f"CAST(:target_{index} AS uuid)"
        for index in range(len(body.target_device_ids))
    )

    with make_con() as con:
        source = con.execute(
            text(
                "SELECT count_sensitivity, count_bridge_ms FROM devices "
                "WHERE id = CAST(:source_id AS uuid) AND company_id = :cid"
            ),
            {"source_id": str(body.source_device_id), "cid": company_id},
        ).fetchone()
        if not source:
            raise HTTPException(status_code=404, detail="Source machine not found")

        targets = con.execute(
            text(
                f"SELECT id FROM devices WHERE company_id = :cid "
                f"AND id IN ({target_sql}) FOR UPDATE"
            ),
            {"cid": company_id, **target_params},
        ).fetchall()
        if len(targets) != len(body.target_device_ids):
            raise HTTPException(
                status_code=404,
                detail="One or more target machines were not found",
            )

        updated = con.execute(
            text(
                "UPDATE devices SET "
                "count_sensitivity = :sensitivity, "
                "count_sensitivity_changed_at = CASE "
                "WHEN :sensitivity = :sensitivity_default THEN NULL ELSE NOW() END, "
                "count_bridge_ms = :bridge_ms, "
                "count_bridge_changed_at = CASE WHEN :bridge_ms IS NULL THEN NULL ELSE NOW() END, "
                "fast_sync_until = NOW() + interval '2 minutes' "
                f"WHERE company_id = :cid AND id IN ({target_sql}) RETURNING id"
            ),
            {
                "cid": company_id,
                "sensitivity": normalize_count_sensitivity(source.count_sensitivity),
                "sensitivity_default": DEFAULT_COUNT_SENSITIVITY_BP,
                "bridge_ms": max(400, source.count_bridge_ms or DEFAULT_COUNT_BRIDGE_MS),
                **target_params,
            },
        ).fetchall()
        con.commit()

    fields = {
        "count_sensitivity": normalize_count_sensitivity(source.count_sensitivity),
        "count_bridge_ms": max(400, source.count_bridge_ms or DEFAULT_COUNT_BRIDGE_MS),
    }
    for row in updated:
        event_manager.broadcast(company_id, "config_pushed", {
            "device_id": str(row.id),
            "fields": fields,
        })

    return {
        "source_device_id": str(body.source_device_id),
        "target_count": len(updated),
        "fields": fields,
    }


@router.put("/{device_id}")
async def update_device(device_id: str, body: UpdateDeviceRequest, user=Depends(require_role("owner", "admin"))):
    """Change name/config."""
    company_id = user["company_id"]

    # Update only the fields that were set
    updates = []
    params = {"did": device_id, "cid": company_id}

    if body.name is not None:
        updates.append("name = :name")
        params["name"] = body.name
        # Duplicate check within the company
        with make_con() as con:
            dup = con.execute(
                text(
                    "SELECT id FROM devices "
                    "WHERE company_id = :cid AND name = :name AND id != :did"
                ),
                {"cid": company_id, "name": body.name, "did": device_id},
            ).fetchone()
            if dup:
                raise HTTPException(
                    status_code=409,
                    detail="A device with this name already exists"
                )
    if body.auto_update is not None:
        updates.append("auto_update = :au")
        params["au"] = body.auto_update
    if "restart_schedule" in body.model_fields_set:
        if body.restart_schedule is None:
            updates.append("restart_schedule = NULL")
        else:
            updates.append("restart_schedule = CAST(:rs AS jsonb)")
            params["rs"] = json.dumps(body.restart_schedule)
    if "count_sensitivity" in body.model_fields_set:
        updates.extend(["count_sensitivity = :cs",
                        "count_sensitivity_changed_at = CASE WHEN :cs = :cs_default THEN NULL ELSE NOW() END"])
        params["cs"] = (DEFAULT_COUNT_SENSITIVITY_BP if body.count_sensitivity is None
                        else int(body.count_sensitivity))
        params["cs_default"] = DEFAULT_COUNT_SENSITIVITY_BP
    if "count_bridge_ms" in body.model_fields_set:
        updates.extend([
            "count_bridge_ms = :cbm",
            "count_bridge_changed_at = CASE WHEN :cbm IS NULL THEN NULL ELSE NOW() END",
        ])
        params["cbm"] = body.count_bridge_ms
    if not updates:
        raise HTTPException(status_code=400, detail="No changes specified")

    # Only the two energy parameters need to be confirmed by the sensor.
    device_config_fields = {"count_sensitivity", "count_bridge_ms"}
    changed_config_fields = {f for f in body.model_fields_set if f in device_config_fields}
    if changed_config_fields:
        updates.append("fast_sync_until = NOW() + interval '2 minutes'")

    with make_con() as con:
        result = con.execute(
            text(
                f"UPDATE devices SET {', '.join(updates)} "
                "WHERE id = :did AND company_id = :cid "
                "RETURNING id, name, auto_update, restart_schedule, count_sensitivity, "
                "count_bridge_ms, count_sensitivity_changed_at, count_bridge_changed_at"
            ),
            params,
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Device not found")
        con.commit()

    # SSE: notify the frontend about the pending config
    if changed_config_fields:
        downstream = {}
        for f in changed_config_fields:
            downstream[f] = getattr(result, f, None)
        event_manager.broadcast(company_id, "config_pushed", {
            "device_id": device_id,
            "fields": downstream,
        })

    return {
        "id": str(result.id),
        "name": result.name,
        "auto_update": result.auto_update or False,
        "restart_schedule": result.restart_schedule,
        "count_sensitivity": normalize_count_sensitivity(result.count_sensitivity),
        "count_bridge_ms": result.count_bridge_ms,
        "count_sensitivity_changed_at": result.count_sensitivity_changed_at.isoformat() if result.count_sensitivity_changed_at else None,
        "count_bridge_changed_at": result.count_bridge_changed_at.isoformat() if result.count_bridge_changed_at else None,
    }


@router.delete("/{device_id}")
async def delete_device(device_id: str, user=Depends(require_role("owner", "admin"))):
    """Delete a device."""
    company_id = user["company_id"]

    with make_con() as con:
        owns = con.execute(
            text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not owns:
            raise HTTPException(status_code=404, detail="Device not found")
        _delete_device_row(con, device_id)
        con.commit()

    return {"status": "deleted"}


def _delete_device_row(con, device_id: str) -> None:
    # Delete the device -> device_hits etc. via ON DELETE CASCADE
    con.execute(text("DELETE FROM devices WHERE id = :did"), {"did": device_id})


@router.post("/{device_id}/watching")
async def device_watching(device_id: str, user=Depends(require_role("owner", "admin", "viewer"))):
    """Signal that a user has device management open -> fast settings sync."""
    company_id = user["company_id"]

    with make_con() as con:
        result = con.execute(
            text(
                "UPDATE devices SET fast_sync_until = NOW() + interval '60 seconds' "
                "WHERE id = :did AND company_id = :cid RETURNING id"
            ),
            {"did": device_id, "cid": company_id},
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Device not found")
        con.commit()

    return {"status": "ok"}
