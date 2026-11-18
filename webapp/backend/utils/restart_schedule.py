from datetime import datetime
from zoneinfo import ZoneInfo


def restart_schedule_to_utc(plan):
    """Convert restart_schedule (local time + time zone) to UTC for the firmware."""
    if not plan:
        return None
    try:
        tz = ZoneInfo(plan.get("tz", "UTC"))
    except Exception:
        return plan
    local_time = plan["time"]
    h, m = int(local_time[:2]), int(local_time[3:5])
    offset_sec = datetime.now(tz).utcoffset().total_seconds()
    offset_min = int(offset_sec / 60)
    utc_min = h * 60 + m - offset_min
    day_shift = 0
    if utc_min >= 24 * 60:
        utc_min -= 24 * 60
        day_shift = 1
    elif utc_min < 0:
        utc_min += 24 * 60
        day_shift = -1
    utc_days = plan["days"]
    if day_shift != 0:
        utc_days = [((d - 1 + day_shift) % 7) + 1 for d in plan["days"]]
    return {
        "days": utc_days,
        "time": f"{utc_min // 60:02d}:{utc_min % 60:02d}",
    }
