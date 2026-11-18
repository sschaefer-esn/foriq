from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text

from utils.db import make_con
from utils.dependencies import require_role
from utils.hit_aggregation import (
    canonical_timezone_name,
    counted_hit_predicate,
    local_date_range_utc,
    local_day_range_utc,
    local_timestamp_sql,
    local_today,
    parse_local_date,
)
from utils.tz_utils import get_company_tz

router = APIRouter(prefix="/api/v1/devices/{device_id}/data", tags=["data"])


def verify_device_access(con, device_id: str, company_id: str):
    row = con.execute(
        text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
        {"did": device_id, "cid": company_id},
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    return row


@router.get("/rhythm")
async def get_rhythm_times(
    device_id: str,
    date: str,
    limit: int = Query(default=50000, ge=1, le=200000),
    user=Depends(require_role("owner", "admin", "viewer")),
):
    """Counted timestamps of one local company day for the rhythm view."""
    try:
        selected_day = parse_local_date(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date") from exc

    with make_con() as con:
        verify_device_access(con, device_id, user["company_id"])
        tz = canonical_timezone_name(get_company_tz(con, user["company_id"]))
        day_range = local_day_range_utc(selected_day, tz)
        rows = con.execute(
            text(
                "SELECT CAST(EXTRACT(EPOCH FROM recorded_at AT TIME ZONE 'UTC') * 1000 AS bigint) AS ms, "
                "energy "
                "FROM device_hits WHERE device_id = :did "
                f"AND {counted_hit_predicate()} "
                "AND recorded_at >= :range_start AND recorded_at < :range_end "
                "ORDER BY recorded_at DESC LIMIT :lim"
            ),
            {"did": device_id, "lim": limit + 1, **day_range.query_params()},
        ).fetchall()

    ordered = list(reversed(rows[:limit]))
    return {
        "ts": [row.ms for row in ordered],
        "energy": [
            {"ts": row.ms, "value": row.energy}
            for row in ordered
            if row.energy is not None
        ],
        "truncated": len(rows) > limit,
    }


@router.get("/day")
async def get_day(
    device_id: str,
    date: str = None,
    user=Depends(require_role("owner", "admin", "viewer")),
):
    with make_con() as con:
        verify_device_access(con, device_id, user["company_id"])
        tz = canonical_timezone_name(get_company_tz(con, user["company_id"]))
        try:
            selected_day = parse_local_date(date) if date else local_today(tz)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid date") from exc
        day_range = local_day_range_utc(selected_day, tz)
        rows = con.execute(
            text(
                f"SELECT date_trunc('hour', {local_timestamp_sql()}) "
                f"+ (EXTRACT(minute FROM {local_timestamp_sql()})::int / 10) * interval '10 min' AS bucket, "
                "COUNT(*) AS count FROM device_hits "
                "WHERE device_id = :did "
                f"AND {counted_hit_predicate()} "
                "AND recorded_at >= :range_start AND recorded_at < :range_end "
                "GROUP BY bucket ORDER BY bucket"
            ),
            {"did": device_id, "tz": tz, **day_range.query_params()},
        ).fetchall()
    return [{"bucket": row.bucket.isoformat(), "count": row.count} for row in rows]


@router.get("/week")
async def get_week(
    device_id: str,
    date: str = None,
    user=Depends(require_role("owner", "admin", "viewer")),
):
    company_id = user["company_id"]
    with make_con() as con:
        verify_device_access(con, device_id, company_id)
        tz = canonical_timezone_name(get_company_tz(con, company_id))
        try:
            reference = parse_local_date(date) if date else local_today(tz)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid date") from exc
        monday = reference - timedelta(days=reference.weekday())
        sunday = monday + timedelta(days=6)
        week_range = local_date_range_utc(monday, sunday + timedelta(days=1), tz)
        rows = con.execute(
            text(
                f"SELECT {local_timestamp_sql()}::date AS local_date, COUNT(*) AS count "
                "FROM device_hits "
                "WHERE device_id = :did "
                f"AND {counted_hit_predicate()} "
                "AND recorded_at >= :range_start AND recorded_at < :range_end "
                "GROUP BY local_date ORDER BY local_date"
            ),
            {"did": device_id, "tz": tz, **week_range.query_params()},
        ).fetchall()

    counts = {str(row.local_date): row.count for row in rows}
    labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days = []
    for index in range(7):
        day = monday + timedelta(days=index)
        days.append({
            "date": str(day),
            "label": f"{labels[index]} {day.day:02d}.{day.month:02d}.",
            "total": counts.get(str(day), 0),
        })
    return {"week_start": str(monday), "week_end": str(sunday), "days": days}


@router.get("/month")
async def get_month(
    device_id: str,
    date: str = None,
    user=Depends(require_role("owner", "admin", "viewer")),
):
    with make_con() as con:
        verify_device_access(con, device_id, user["company_id"])
        tz = canonical_timezone_name(get_company_tz(con, user["company_id"]))
        try:
            reference = parse_local_date(date) if date else local_today(tz)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid date") from exc
        first_day = reference.replace(day=1)
        if reference.month == 12:
            last_day = reference.replace(year=reference.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            last_day = reference.replace(month=reference.month + 1, day=1) - timedelta(days=1)
        month_range = local_date_range_utc(first_day, last_day + timedelta(days=1), tz)
        rows = con.execute(
            text(
                f"SELECT {local_timestamp_sql()}::date AS local_date, COUNT(*) AS count "
                "FROM device_hits "
                "WHERE device_id = :did "
                f"AND {counted_hit_predicate()} "
                "AND recorded_at >= :range_start AND recorded_at < :range_end "
                "GROUP BY local_date ORDER BY local_date"
            ),
            {"did": device_id, "tz": tz, **month_range.query_params()},
        ).fetchall()

    counts = {str(row.local_date): row.count for row in rows}
    day_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    month_names = [
        "", "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    days = []
    current = first_day
    while current <= last_day:
        days.append({
            "date": str(current),
            "label": f"{current.day}.",
            "weekday": day_labels[current.weekday()],
            "count": counts.get(str(current), 0),
        })
        current += timedelta(days=1)
    return {"month": month_names[reference.month], "year": reference.year, "days": days}


# ─── Data overview (weekly/monthly totals) ───────────────────────────────

DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


@router.get("/summary")
async def get_summary(
    device_id: str,
    period: str = Query(...),
    date: Optional[str] = None,
    user=Depends(require_role("owner", "admin", "viewer")),
):
    """Read-only daily counts for the data overview."""
    if period not in ("week", "month"):
        raise HTTPException(status_code=400, detail="period must be 'week' or 'month'")

    company_id = user["company_id"]
    with make_con() as con:
        if device_id != "all":
            verify_device_access(con, device_id, company_id)

        tz = get_company_tz(con, company_id)
        if date:
            try:
                ref = datetime.strptime(date, "%Y-%m-%d").date()
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid date") from exc
        else:
            ref = con.execute(
                text("SELECT (NOW() AT TIME ZONE :tz)::date AS today"), {"tz": tz}
            ).fetchone().today

        if period == "week":
            range_start = ref - timedelta(days=ref.weekday())
            range_end = range_start + timedelta(days=6)
            label = (
                f"{range_start.day:02d}.{range_start.month:02d}.–"
                f"{range_end.day:02d}.{range_end.month:02d}.{range_end.year}"
            )
        else:
            range_start = ref.replace(day=1)
            next_month = (
                ref.replace(year=ref.year + 1, month=1, day=1)
                if ref.month == 12
                else ref.replace(month=ref.month + 1, day=1)
            )
            range_end = next_month - timedelta(days=1)
            label = f"{MONTH_NAMES[ref.month]} {ref.year}"

        scope_sql = "d.company_id = :cid"
        params = {
            "cid": company_id,
            "start": str(range_start),
            "end": str(range_end),
            "tz": tz,
        }
        if device_id != "all":
            scope_sql += " AND h.device_id = :did"
            params["did"] = device_id

        rows = con.execute(
            text(
                "SELECT (h.recorded_at AT TIME ZONE 'UTC' AT TIME ZONE :tz)::date AS local_date, "
                "COUNT(*) AS count FROM device_hits h "
                "JOIN devices d ON d.id = h.device_id "
                f"WHERE {scope_sql} "
                "AND h.counted IS TRUE "
                "AND h.recorded_at >= (CAST(:start AS date) AT TIME ZONE :tz) "
                "AND h.recorded_at < ((CAST(:end AS date) + 1) AT TIME ZONE :tz) "
                "GROUP BY local_date ORDER BY local_date"
            ),
            params,
        ).fetchall()

    counts = {str(row.local_date): row.count for row in rows}
    days = []
    current = range_start
    while current <= range_end:
        key = str(current)
        days.append({
            "date": key,
            "label": f"{current.day:02d}.{current.month:02d}.",
            "weekday": DAY_LABELS[current.weekday()],
            "total": counts.get(key, 0),
        })
        current += timedelta(days=1)

    return {
        "period": period,
        "range_start": str(range_start),
        "range_end": str(range_end),
        "label": label,
        "days": days,
    }
