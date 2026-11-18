"""External REST API for ERP integrations (e.g. BIS): API key auth, read-only
access to the hit data of the whole company. Completely independent of the
user JWT and device token integrations (see utils/api_key_auth.py)."""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import text

from utils.db import make_con
from utils.api_key_auth import require_api_key
from utils.ratelimit import (
    EXTERNAL_API_IP_LIMIT,
    api_key_rate_key,
    client_ip_key,
    limiter,
)

router = APIRouter(prefix="/api/v1/external/v1", tags=["external-api"])

MAX_HITS_LIMIT = 5000
MAX_RANGE_DAYS = 400


def _parse_iso_utc(value: str):
    """ISO-8601 -> naive UTC datetime (DB timestamps are naive UTC)."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _parse_range(from_ts: str, to_ts: str):
    try:
        from_dt = _parse_iso_utc(from_ts)
        to_dt = _parse_iso_utc(to_ts)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid time format (expected ISO-8601)")
    if to_dt <= from_dt:
        raise HTTPException(status_code=400, detail="'to' must be after 'from'")
    if to_dt - from_dt > timedelta(days=MAX_RANGE_DAYS):
        raise HTTPException(status_code=400, detail=f"Time range too large (max. {MAX_RANGE_DAYS} days)")
    return from_dt, to_dt


def _verify_device_in_company(con, device_id: str, company_id: str):
    row = con.execute(
        text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
        {"did": device_id, "cid": company_id},
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")


@router.get("/devices")
@limiter.limit("120/minute", key_func=api_key_rate_key)
@limiter.shared_limit(
    EXTERNAL_API_IP_LIMIT, scope="external-api-ip", key_func=client_ip_key
)
async def list_devices(request: Request, auth=Depends(require_api_key)):
    with make_con() as con:
        rows = con.execute(
            text(
                "SELECT id, name, serial_number, is_active FROM devices "
                "WHERE company_id = :cid ORDER BY name"
            ),
            {"cid": auth["company_id"]},
        ).fetchall()

    return [
        {
            "id": str(r.id),
            "name": r.name,
            "serial_number": r.serial_number,
            "is_active": r.is_active,
        }
        for r in rows
    ]


@router.get("/hits")
@limiter.limit("120/minute", key_func=api_key_rate_key)
@limiter.shared_limit(
    EXTERNAL_API_IP_LIMIT, scope="external-api-ip", key_func=client_ip_key
)
async def list_hits(
    request: Request,
    from_ts: str = Query(alias="from"),
    to_ts: str = Query(alias="to"),
    device_id: str | None = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=MAX_HITS_LIMIT),
    auth=Depends(require_api_key),
):
    """Individual hits in the window [from, to] (ISO-8601 UTC), sorted
    ascending, company-wide or filtered to one device. With more than `limit`
    matches the NEWEST are returned with truncated=true."""
    from_dt, to_dt = _parse_range(from_ts, to_ts)

    with make_con() as con:
        if device_id:
            _verify_device_in_company(con, device_id, auth["company_id"])
        rows = con.execute(
            text(
                "SELECT h.id, h.device_id, d.serial_number, h.gforce, h.energy, "
                "h.hit_duration_ms, h.recorded_at "
                "FROM device_hits h JOIN devices d ON d.id = h.device_id "
                "WHERE d.company_id = :cid "
                "AND h.counted IS TRUE "
                "AND (:did IS NULL OR h.device_id = :did) "
                "AND h.recorded_at >= :f AND h.recorded_at <= :t "
                "ORDER BY h.recorded_at DESC LIMIT :lim"
            ),
            {
                "cid": auth["company_id"],
                "did": device_id,
                "f": from_dt,
                "t": to_dt,
                "lim": limit + 1,
            },
        ).fetchall()

    truncated = len(rows) > limit
    rows = list(reversed(rows[:limit]))

    return {
        "hits": [
            {
                "id": r.id,
                "device_id": str(r.device_id),
                "serial_number": r.serial_number,
                "gforce": r.gforce,
                "energy": r.energy,
                "hit_duration_ms": r.hit_duration_ms,
                "recorded_at": r.recorded_at.isoformat() + "+00:00",
            }
            for r in rows
        ],
        "truncated": truncated,
    }


@router.get("/stats")
@limiter.limit("120/minute", key_func=api_key_rate_key)
@limiter.shared_limit(
    EXTERNAL_API_IP_LIMIT, scope="external-api-ip", key_func=client_ip_key
)
async def get_stats(
    request: Request,
    from_ts: str = Query(alias="from"),
    to_ts: str = Query(alias="to"),
    device_id: str | None = Query(default=None),
    auth=Depends(require_api_key),
):
    """Summary metrics (count, average, peak) for a time window, company-wide
    or filtered to one device."""
    from_dt, to_dt = _parse_range(from_ts, to_ts)

    with make_con() as con:
        if device_id:
            _verify_device_in_company(con, device_id, auth["company_id"])
        row = con.execute(
            text(
                "SELECT COUNT(*) AS cnt, "
                "AVG(h.gforce) AS gforce_avg, MAX(h.gforce) AS gforce_peak, "
                "AVG(h.energy) AS energy_avg, MAX(h.energy) AS energy_peak, "
                "AVG(h.hit_duration_ms) AS duration_avg "
                "FROM device_hits h JOIN devices d ON d.id = h.device_id "
                "WHERE d.company_id = :cid "
                "AND h.counted IS TRUE "
                "AND (:did IS NULL OR h.device_id = :did) "
                "AND h.recorded_at >= :f AND h.recorded_at <= :t"
            ),
            {"cid": auth["company_id"], "did": device_id, "f": from_dt, "t": to_dt},
        ).fetchone()

    def _r(v, nd=4):
        return round(v, nd) if v is not None else None

    return {
        "from": from_ts,
        "to": to_ts,
        "count": row.cnt,
        "gforce_avg": _r(row.gforce_avg),
        "gforce_peak": _r(row.gforce_peak),
        "energy_avg": _r(row.energy_avg),
        "energy_peak": _r(row.energy_peak),
        "duration_avg_ms": _r(row.duration_avg, 1),
    }
