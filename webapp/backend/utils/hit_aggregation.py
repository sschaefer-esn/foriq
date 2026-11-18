"""Canonical contract for customer-facing stroke statistics.

``device_hits.recorded_at`` is a naive UTC timestamp in PostgreSQL.
All product views use half-open UTC intervals derived from local company days,
so a stroke belongs to exactly one day even on DST transition days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_COMPANY_TIMEZONE = "Europe/Berlin"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$")


@dataclass(frozen=True)
class UtcRange:
    """Half-open, naive UTC interval for ``recorded_at``."""

    start: datetime
    end: datetime

    def query_params(self) -> dict[str, datetime]:
        return {"range_start": self.start, "range_end": self.end}


def canonical_timezone_name(value: str | None) -> str:
    """Return a valid IANA name; broken stored values fall back safely."""

    candidate = (value or "").strip() or DEFAULT_COMPANY_TIMEZONE
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError):
        return DEFAULT_COMPANY_TIMEZONE
    return candidate


def parse_local_date(value: str) -> date:
    """Strictly parse the API format YYYY-MM-DD."""

    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise ValueError("Expected YYYY-MM-DD")
    return date.fromisoformat(value)


def local_today(timezone_name: str, now: datetime | None = None) -> date:
    """Current company day, independent of the DB/process time zone."""

    zone = ZoneInfo(canonical_timezone_name(timezone_name))
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(zone).date()


def local_date_range_utc(
    start: date,
    end_exclusive: date,
    timezone_name: str,
) -> UtcRange:
    """Convert local date bounds into a naive UTC interval.

    Converting both midnights separately is intentional: a local day can be
    23 or 25 hours long across a DST change.
    """

    if end_exclusive <= start:
        raise ValueError("End must be after start")
    zone = ZoneInfo(canonical_timezone_name(timezone_name))
    start_utc = datetime.combine(start, time.min, zone).astimezone(timezone.utc)
    end_utc = datetime.combine(end_exclusive, time.min, zone).astimezone(timezone.utc)
    return UtcRange(
        start=start_utc.replace(tzinfo=None),
        end=end_utc.replace(tzinfo=None),
    )


def local_day_range_utc(day: date, timezone_name: str) -> UtcRange:
    return local_date_range_utc(day, date.fromordinal(day.toordinal() + 1), timezone_name)


def local_timestamp_sql(column: str = "recorded_at") -> str:
    """Express a naive UTC DB timestamp as local company wall time."""

    if not _SQL_IDENTIFIER_RE.fullmatch(column):
        raise ValueError("Invalid SQL column name")
    return f"({column} AT TIME ZONE 'UTC' AT TIME ZONE :tz)"


def counted_hit_predicate(alias: str | None = None) -> str:
    """Canonical filter for production stroke counts.

    Historical firmware could store uncounted diagnostic candidates as
    ``counted=false``. Those existing rows must never show up as strokes in any
    customer statistic. New energy hits are always stored at ingest with the
    DB default ``true``.
    """

    if alias is None:
        return "counted IS TRUE"
    if not _SQL_IDENTIFIER_RE.fullmatch(alias):
        raise ValueError("Invalid SQL alias")
    return f"{alias}.counted IS TRUE"
