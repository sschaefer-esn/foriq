from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

from utils.db import make_con
from utils.dependencies import require_role
from utils.hit_aggregation import (
    canonical_timezone_name,
    counted_hit_predicate,
    local_day_range_utc,
    local_timestamp_sql,
    local_today,
    parse_local_date,
)
from utils.tz_utils import get_company_tz

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


@router.get("/overview")
async def overview(date: str | None = None, user=Depends(require_role("owner", "admin", "viewer"))):
    """All devices with stroke count, online status and hourly chart data.

    Optional ?date=YYYY-MM-DD shows a past day (company time zone); default is
    today. For a past day the live stroke rate is omitted.
    """
    company_id = user["company_id"]

    requested_day = None
    if date is not None:
        try:
            requested_day = parse_local_date(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date (expected YYYY-MM-DD)")

    with make_con() as con:
        tz = canonical_timezone_name(get_company_tz(con, company_id))
        selected_day = requested_day or local_today(tz)
        day_range = local_day_range_utc(selected_day, tz)

        # Devices (count_today is derived from the hourly data below - the former
        # per-device LATERAL COUNT was an N+1: one subquery per device).
        devices = con.execute(
            text(
                "SELECT d.id, d.name, d.serial_number, d.last_seen_at, "
                "d.sleep_mode, d.upload_interval_s, "
                "d.created_at "
                "FROM devices d "
                "WHERE d.company_id = :cid "
                "ORDER BY d.created_at DESC"
            ),
            {"cid": company_id},
        ).fetchall()

        # Hourly chart data for all devices (selected day), aggregated per
        # device and hour - count_today is exactly their sum.
        chart_rows = con.execute(
            text(
                "SELECT device_id, "
                f"date_trunc('hour', {local_timestamp_sql()}) AS bucket, "
                "COUNT(*) AS count, "
                "MAX(recorded_at) AS last_hit "
                "FROM device_hits "
                "WHERE device_id IN ("
                "  SELECT id FROM devices WHERE company_id = :cid"
                ") "
                f"AND {counted_hit_predicate()} "
                "AND recorded_at >= :range_start "
                "AND recorded_at < :range_end "
                "GROUP BY device_id, bucket ORDER BY bucket"
            ),
            {"cid": company_id, "tz": tz, **day_range.query_params()},
        ).fetchall()

        # Hits of the last 15 minutes (for the live stroke rate) - only relevant for today
        rate_rows = []
        if date is None:
            rate_rows = con.execute(
                text(
                    "SELECT device_id, COUNT(*) AS cnt FROM device_hits "
                    "WHERE device_id IN ("
                    "  SELECT id FROM devices WHERE company_id = :cid"
                    ") "
                    f"AND {counted_hit_predicate()} "
                    "AND recorded_at >= (NOW() AT TIME ZONE 'UTC') - interval '15 minutes' "
                    "GROUP BY device_id"
                ),
                {"cid": company_id},
            ).fetchall()

        active_incidents = con.execute(
            text(
                "SELECT device_id, alert_type, condition_since_at "
                "FROM notification_incidents "
                "WHERE company_id = :cid AND resolved_at IS NULL"
            ),
            {"cid": company_id},
        ).fetchall()

        production_rows = []
        if date is None:
            production_rows = con.execute(
                text(
                    "SELECT d.id, d.production_started_at, d.production_target_count, "
                    "d.production_material_count, COALESCE(p.cnt, 0) AS current_count "
                    "FROM devices d "
                    "LEFT JOIN LATERAL ("
                    "  SELECT COUNT(*) AS cnt FROM device_hits "
                    "  WHERE device_id = d.id AND counted IS TRUE "
                    "  AND recorded_at >= d.production_started_at"
                    ") p ON true "
                    "WHERE d.company_id = :cid AND d.production_started_at IS NOT NULL"
                ),
                {"cid": company_id},
            ).fetchall()

    # Group chart data per device + count_today as the sum of the hourly values
    chart_by_device = {}
    count_today_by_device = {}
    last_hit_by_device = {}
    for r in chart_rows:
        did = str(r.device_id)
        if did not in chart_by_device:
            chart_by_device[did] = []
        chart_by_device[did].append({
            "bucket": r.bucket.isoformat(),
            "count": r.count,
        })
        count_today_by_device[did] = count_today_by_device.get(did, 0) + r.count
        prev = last_hit_by_device.get(did)
        if prev is None or r.last_hit > prev:
            last_hit_by_device[did] = r.last_hit

    rate_by_device = {str(r.device_id): r.cnt for r in rate_rows}

    incident_by_device = {
        str(row.device_id): {
            "type": row.alert_type,
            "condition_since_at": row.condition_since_at.isoformat() + "Z",
        }
        for row in active_incidents
    }

    production_by_device = {
        str(row.id): {
            "started_at": row.production_started_at.isoformat() + "Z",
            "target_count": row.production_target_count,
            "material_count": row.production_material_count,
            "current_count": row.current_count,
            "remaining_count": max(0, row.production_target_count - row.current_count),
            "material_remaining": (
                None if row.production_material_count is None
                else max(0, row.production_material_count - row.current_count)
            ),
        }
        for row in production_rows
    }

    result = []
    for d in devices:
        did = str(d.id)
        last_hit = last_hit_by_device.get(did)
        result.append({
            "id": did,
            "name": d.name,
            "serial_number": d.serial_number,
            "last_seen_at": d.last_seen_at.isoformat() + "Z" if d.last_seen_at else None,
            "sleep_mode": d.sleep_mode or False,
            "upload_interval_s": d.upload_interval_s or 0,
            "created_at": d.created_at.isoformat() + "Z" if d.created_at else None,
            "count_today": count_today_by_device.get(did, 0),
            "chart": chart_by_device.get(did, []),
            "last_hit_at": last_hit.isoformat() + "Z" if last_hit else None,
            "hits_last_15m": None if date else rate_by_device.get(did, 0),
            "production": production_by_device.get(did) if date is None else None,
            "active_incident": incident_by_device.get(did) if date is None else None,
        })
    return result
