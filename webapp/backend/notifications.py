"""Persistent, time-window-based downtime and offline alerts."""

import asyncio
import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from events import event_manager
from utils.db import make_con
from utils.default_language import default_name
from utils.dependencies import require_role


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])

WORKER_INTERVAL_S = 30
EVALUATION_LOCK_ID = 0x464F5249  # "FORI"
INCIDENT_RETENTION_DAYS = 180
MAX_RULE_DEVICES = 200


class WeeklyWindow(BaseModel):
    days: list[int] = Field(min_length=1, max_length=7)
    start: str
    end: str

    @field_validator("days")
    @classmethod
    def validate_days(cls, value):
        normalized = sorted(set(value))
        if any(day < 1 or day > 7 for day in normalized):
            raise ValueError("Weekdays must be between 1 and 7")
        return normalized

    @field_validator("start", "end")
    @classmethod
    def validate_clock(cls, value):
        try:
            datetime.strptime(value, "%H:%M")
        except ValueError as exc:
            raise ValueError("Time must be in HH:MM format") from exc
        return value


class NotificationRuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    threshold_minutes: int = Field(default=10, ge=1, le=1440)
    require_work_phase: bool = False
    minimum_work_minutes: int = Field(default=5, ge=1, le=1440)
    notify_activity_resumed: bool = True
    notify_device_offline: bool = False
    weekly_windows: list[WeeklyWindow] = Field(default_factory=list, max_length=12)


class NotificationRuleSetWrite(NotificationRuleUpdate):
    name: str = Field(min_length=1, max_length=255)
    device_ids: list[UUID] = Field(min_length=1, max_length=MAX_RULE_DEVICES)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value):
        normalized = value.strip()
        if not normalized:
            raise ValueError("Name must not be empty")
        return normalized

    @field_validator("device_ids")
    @classmethod
    def validate_device_ids(cls, value):
        unique = list(dict.fromkeys(value))
        if len(unique) != len(value):
            raise ValueError("Machines must not be selected twice")
        return unique


def _clock_minutes(value: str) -> int:
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)


def _validate_non_overlapping(windows: list[WeeklyWindow]):
    """Project windows onto an ISO week; overnight windows are split."""
    spans: list[tuple[int, int]] = []
    week_minutes = 7 * 24 * 60
    for window in windows:
        start_min = _clock_minutes(window.start)
        end_min = _clock_minutes(window.end)
        if start_min == end_min:
            raise HTTPException(status_code=422, detail="Start and end must not be equal")
        duration = (end_min - start_min) % (24 * 60)
        for day in window.days:
            start = (day - 1) * 24 * 60 + start_min
            end = start + duration
            if end <= week_minutes:
                spans.append((start, end))
            else:
                spans.append((start, week_minutes))
                spans.append((0, end - week_minutes))
    spans.sort()
    for previous, current in zip(spans, spans[1:]):
        if current[0] < previous[1]:
            raise HTTPException(status_code=422, detail="Time windows must not overlap")


def _validate_rule_schedule(body: NotificationRuleUpdate):
    _validate_non_overlapping(body.weekly_windows)
    if body.enabled and not body.weekly_windows:
        raise HTTPException(status_code=422, detail="At least one time window is required")
    shortest_window = min(
        (
            (_clock_minutes(window.end) - _clock_minutes(window.start)) % (24 * 60)
            for window in body.weekly_windows
        ),
        default=24 * 60,
    )
    required_minutes = body.threshold_minutes
    if body.require_work_phase:
        required_minutes += body.minimum_work_minutes
    if body.enabled and required_minutes >= shortest_window:
        raise HTTPException(
            status_code=422,
            detail=(
                "Work and idle duration together must be shorter than every time window"
                if body.require_work_phase
                else "The downtime duration must be shorter than every time window"
            ),
        )


def _serialize_rule(row, device_id: str):
    return {
        "device_id": device_id,
        "enabled": bool(row.enabled) if row else False,
        "threshold_minutes": row.threshold_minutes if row else 10,
        "require_work_phase": bool(row.require_work_phase) if row else False,
        "minimum_work_minutes": row.minimum_work_minutes if row else 5,
        "notify_activity_resumed": bool(row.notify_activity_resumed) if row else True,
        "notify_device_offline": bool(row.notify_device_offline) if row else False,
        "weekly_windows": (row.weekly_windows or []) if row else [],
        "revision": row.revision if row else 0,
        "updated_at": row.updated_at.isoformat() + "+00:00" if row and row.updated_at else None,
    }


def _device_ids_as_strings(device_ids):
    return [str(device_id) for device_id in device_ids]


def _load_company_devices(con, company_id: str, device_ids):
    ids = _device_ids_as_strings(device_ids)
    rows = con.execute(
        text(
            "SELECT id, name FROM devices "
            "WHERE company_id = :cid AND id = ANY(CAST(:device_ids AS UUID[])) "
            "ORDER BY name, id"
        ),
        {"cid": company_id, "device_ids": ids},
    ).fetchall()
    if len(rows) != len(ids):
        raise HTTPException(status_code=404, detail="At least one machine was not found")
    return rows


def _ensure_devices_available(con, company_id: str, device_ids, current_rule_id=None):
    ids = _device_ids_as_strings(device_ids)
    devices = _load_company_devices(con, company_id, ids)
    params = {"cid": company_id, "device_ids": ids}
    current_filter = ""
    if current_rule_id is not None:
        current_filter = "AND r.id <> :current_rule_id "
        params["current_rule_id"] = str(current_rule_id)
    conflict = con.execute(
        text(
            "SELECT d.name AS device_name, r.name AS rule_name "
            "FROM notification_rule_devices rd "
            "JOIN notification_rules r ON r.id = rd.rule_id "
            "JOIN devices d ON d.id = rd.device_id "
            "WHERE r.company_id = :cid "
            "AND rd.device_id = ANY(CAST(:device_ids AS UUID[])) "
            + current_filter
            + "ORDER BY d.name LIMIT 1"
        ),
        params,
    ).fetchone()
    if conflict:
        raise HTTPException(
            status_code=409,
            detail=f"{conflict.device_name} already belongs to rule {conflict.rule_name}",
        )
    return devices


def _rule_set_dict(rule, devices):
    return {
        "id": str(rule.id),
        "name": rule.name,
        "enabled": bool(rule.enabled),
        "threshold_minutes": rule.threshold_minutes,
        "require_work_phase": bool(rule.require_work_phase),
        "minimum_work_minutes": rule.minimum_work_minutes,
        "notify_activity_resumed": bool(rule.notify_activity_resumed),
        "notify_device_offline": bool(rule.notify_device_offline),
        "weekly_windows": rule.weekly_windows or [],
        "revision": rule.revision,
        "created_at": rule.created_at.isoformat() + "+00:00" if rule.created_at else None,
        "updated_at": rule.updated_at.isoformat() + "+00:00" if rule.updated_at else None,
        "device_ids": [str(device.id) for device in devices],
        "devices": [
            {"id": str(device.id), "name": device.name}
            for device in devices
        ],
    }


def _load_rule_set(con, rule_id: str, company_id: str):
    rule = con.execute(
        text(
            "SELECT id, name, enabled, threshold_minutes, require_work_phase, "
            "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
            "weekly_windows, revision, "
            "created_at, updated_at FROM notification_rules "
            "WHERE id = :rule_id AND company_id = :cid"
        ),
        {"rule_id": rule_id, "cid": company_id},
    ).fetchone()
    if not rule:
        raise HTTPException(status_code=404, detail="Notification rule not found")
    devices = con.execute(
        text(
            "SELECT d.id, d.name FROM notification_rule_devices rd "
            "JOIN devices d ON d.id = rd.device_id "
            "WHERE rd.rule_id = :rule_id ORDER BY d.name, d.id"
        ),
        {"rule_id": rule_id},
    ).fetchall()
    return rule, devices


def _mirror_legacy_rules(con, rule, device_ids, removed_device_ids=()):
    removed = _device_ids_as_strings(removed_device_ids)
    if removed:
        con.execute(
            text(
                "DELETE FROM device_notification_rules "
                "WHERE device_id = ANY(CAST(:device_ids AS UUID[]))"
            ),
            {"device_ids": removed},
        )
    selected = _device_ids_as_strings(device_ids)
    if not selected:
        return
    con.execute(
        text(
            "INSERT INTO device_notification_rules "
            "(device_id, enabled, threshold_minutes, require_work_phase, "
            "minimum_work_minutes, notify_activity_resumed, notify_device_offline, weekly_windows, "
            "revision, updated_at, updated_by) "
            "SELECT selected.device_id, :enabled, :threshold, :require_work_phase, "
            ":minimum_work_minutes, :notify_activity_resumed, :notify_device_offline, "
            "CAST(:windows AS JSONB), "
            ":revision, NOW(), :uid "
            "FROM unnest(CAST(:device_ids AS UUID[])) AS selected(device_id) "
            "ON CONFLICT (device_id) DO UPDATE SET enabled = EXCLUDED.enabled, "
            "threshold_minutes = EXCLUDED.threshold_minutes, "
            "require_work_phase = EXCLUDED.require_work_phase, "
            "minimum_work_minutes = EXCLUDED.minimum_work_minutes, "
            "notify_activity_resumed = EXCLUDED.notify_activity_resumed, "
            "notify_device_offline = EXCLUDED.notify_device_offline, "
            "weekly_windows = EXCLUDED.weekly_windows, revision = EXCLUDED.revision, "
            "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by"
        ),
        {
            "enabled": bool(rule.enabled),
            "threshold": rule.threshold_minutes,
            "require_work_phase": bool(rule.require_work_phase),
            "minimum_work_minutes": rule.minimum_work_minutes,
            "notify_activity_resumed": bool(rule.notify_activity_resumed),
            "notify_device_offline": bool(rule.notify_device_offline),
            "windows": json.dumps(rule.weekly_windows or []),
            "revision": rule.revision,
            "uid": str(rule.updated_by) if rule.updated_by else None,
            "device_ids": selected,
        },
    )


def _verify_device(con, device_id: str, company_id: str):
    row = con.execute(
        text("SELECT id FROM devices WHERE id = :did AND company_id = :cid"),
        {"did": device_id, "cid": company_id},
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")


def _insert_rule_devices(con, rule_id, device_ids):
    ids = _device_ids_as_strings(device_ids)
    if not ids:
        return
    con.execute(
        text(
            "INSERT INTO notification_rule_devices (rule_id, device_id) "
            "SELECT :rule_id, selected.device_id "
            "FROM unnest(CAST(:device_ids AS UUID[])) AS selected(device_id)"
        ),
        {"rule_id": str(rule_id), "device_ids": ids},
    )


def _resolve_incidents_for_devices(
    con,
    device_ids,
    resolution,
    alert_type=None,
):
    ids = _device_ids_as_strings(device_ids)
    if not ids:
        return []
    type_filter = "AND alert_type = :alert_type " if alert_type else ""
    params = {"resolution": resolution, "device_ids": ids}
    if alert_type:
        params["alert_type"] = alert_type
    rows = con.execute(
        text(
            "UPDATE notification_incidents SET resolved_at = NOW(), resolution = :resolution "
            "WHERE device_id = ANY(CAST(:device_ids AS UUID[])) AND resolved_at IS NULL "
            + type_filter
            + "RETURNING id, company_id"
        ),
        params,
    ).fetchall()
    return [(str(row.company_id), str(row.id)) for row in rows]


@router.get("/rule-sets")
async def list_rule_sets(user=Depends(require_role("owner", "admin", "viewer"))):
    with make_con() as con:
        rules = con.execute(
            text(
                "SELECT id, name, enabled, threshold_minutes, require_work_phase, "
                "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                "weekly_windows, revision, "
                "created_at, updated_at FROM notification_rules "
                "WHERE company_id = :cid ORDER BY name, created_at"
            ),
            {"cid": user["company_id"]},
        ).fetchall()
        mappings = con.execute(
            text(
                "SELECT rd.rule_id, d.id, d.name FROM notification_rule_devices rd "
                "JOIN notification_rules r ON r.id = rd.rule_id "
                "JOIN devices d ON d.id = rd.device_id AND d.company_id = r.company_id "
                "WHERE r.company_id = :cid ORDER BY d.name, d.id"
            ),
            {"cid": user["company_id"]},
        ).fetchall()
    devices_by_rule = {}
    for mapping in mappings:
        devices_by_rule.setdefault(str(mapping.rule_id), []).append(mapping)
    return [
        _rule_set_dict(rule, devices_by_rule.get(str(rule.id), []))
        for rule in rules
    ]


@router.post("/rule-sets", status_code=201)
async def create_rule_set(
    body: NotificationRuleSetWrite,
    user=Depends(require_role("owner", "admin")),
):
    _validate_rule_schedule(body)
    windows_json = json.dumps([window.model_dump() for window in body.weekly_windows])
    try:
        with make_con() as con:
            devices = _ensure_devices_available(
                con, user["company_id"], body.device_ids
            )
            rule = con.execute(
                text(
                    "INSERT INTO notification_rules "
                    "(company_id, name, enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, updated_by) "
                    "VALUES (:cid, :name, :enabled, :threshold, :require_work_phase, "
                    ":minimum_work_minutes, :notify_activity_resumed, :notify_device_offline, "
                    "CAST(:windows AS JSONB), :uid) "
                    "RETURNING id, name, enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, revision, "
                    "created_at, updated_at, updated_by"
                ),
                {
                    "cid": user["company_id"],
                    "name": body.name,
                    "enabled": body.enabled,
                    "threshold": body.threshold_minutes,
                    "require_work_phase": body.require_work_phase,
                    "minimum_work_minutes": body.minimum_work_minutes,
                    "notify_activity_resumed": body.notify_activity_resumed,
                    "notify_device_offline": body.notify_device_offline,
                    "windows": windows_json,
                    "uid": user["sub"],
                },
            ).fetchone()
            _insert_rule_devices(con, rule.id, body.device_ids)
            _mirror_legacy_rules(con, rule, body.device_ids)
            con.commit()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="At least one machine is already assigned") from exc
    return _rule_set_dict(rule, devices)


@router.get("/rule-sets/{rule_id}")
async def get_rule_set(
    rule_id: UUID,
    user=Depends(require_role("owner", "admin", "viewer")),
):
    with make_con() as con:
        rule, devices = _load_rule_set(con, str(rule_id), user["company_id"])
    return _rule_set_dict(rule, devices)


@router.put("/rule-sets/{rule_id}")
async def update_rule_set(
    rule_id: UUID,
    body: NotificationRuleSetWrite,
    user=Depends(require_role("owner", "admin")),
):
    _validate_rule_schedule(body)
    windows = [window.model_dump() for window in body.weekly_windows]
    broadcasts = []
    try:
        with make_con() as con:
            existing, existing_devices = _load_rule_set(
                con, str(rule_id), user["company_id"]
            )
            devices = _ensure_devices_available(
                con,
                user["company_id"],
                body.device_ids,
                current_rule_id=rule_id,
            )
            old_ids = {str(device.id) for device in existing_devices}
            new_ids = set(_device_ids_as_strings(body.device_ids))
            monitoring_changed = (
                bool(existing.enabled) != body.enabled
                or existing.threshold_minutes != body.threshold_minutes
                or bool(existing.require_work_phase) != body.require_work_phase
                or existing.minimum_work_minutes != body.minimum_work_minutes
                or _as_windows(existing.weekly_windows) != windows
            )
            affected_ids = old_ids if monitoring_changed else old_ids - new_ids
            broadcasts = _resolve_incidents_for_devices(
                con, affected_ids, "rule_changed"
            )
            offline_disabled = (
                bool(existing.notify_device_offline)
                and not body.notify_device_offline
            )
            if offline_disabled and not monitoring_changed:
                broadcasts.extend(_resolve_incidents_for_devices(
                    con,
                    old_ids & new_ids,
                    "rule_changed",
                    alert_type="device_offline",
                ))

            rule = con.execute(
                text(
                    "UPDATE notification_rules SET name = :name, enabled = :enabled, "
                    "threshold_minutes = :threshold, "
                    "require_work_phase = :require_work_phase, "
                    "minimum_work_minutes = :minimum_work_minutes, "
                    "notify_activity_resumed = :notify_activity_resumed, "
                    "notify_device_offline = :notify_device_offline, "
                    "weekly_windows = CAST(:windows AS JSONB), "
                    "revision = revision + 1, updated_at = NOW(), updated_by = :uid "
                    "WHERE id = :rule_id AND company_id = :cid "
                    "RETURNING id, name, enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, revision, "
                    "created_at, updated_at, updated_by"
                ),
                {
                    "rule_id": str(rule_id),
                    "cid": user["company_id"],
                    "name": body.name,
                    "enabled": body.enabled,
                    "threshold": body.threshold_minutes,
                    "require_work_phase": body.require_work_phase,
                    "minimum_work_minutes": body.minimum_work_minutes,
                    "notify_activity_resumed": body.notify_activity_resumed,
                    "notify_device_offline": body.notify_device_offline,
                    "windows": json.dumps(windows),
                    "uid": user["sub"],
                },
            ).fetchone()
            removed_ids = old_ids - new_ids
            added_ids = new_ids - old_ids
            if removed_ids:
                con.execute(
                    text(
                        "DELETE FROM notification_rule_devices "
                        "WHERE rule_id = :rule_id "
                        "AND device_id = ANY(CAST(:device_ids AS UUID[]))"
                    ),
                    {
                        "rule_id": str(rule_id),
                        "device_ids": list(removed_ids),
                    },
                )
            _insert_rule_devices(con, rule_id, added_ids)
            _mirror_legacy_rules(
                con, rule, body.device_ids, removed_device_ids=old_ids - new_ids
            )
            con.commit()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="At least one machine is already assigned") from exc
    for company_id, incident_id in broadcasts:
        event_manager.broadcast(company_id, "notification", {"id": incident_id})
    return _rule_set_dict(rule, devices)


@router.delete("/rule-sets/{rule_id}")
async def delete_rule_set(
    rule_id: UUID,
    user=Depends(require_role("owner", "admin")),
):
    with make_con() as con:
        _, devices = _load_rule_set(con, str(rule_id), user["company_id"])
        device_ids = [str(device.id) for device in devices]
        broadcasts = _resolve_incidents_for_devices(
            con, device_ids, "rule_changed"
        )
        _mirror_legacy_rules(con, None, [], device_ids)
        con.execute(
            text(
                "DELETE FROM notification_rules "
                "WHERE id = :rule_id AND company_id = :cid"
            ),
            {"rule_id": str(rule_id), "cid": user["company_id"]},
        )
        con.commit()
    for company_id, incident_id in broadcasts:
        event_manager.broadcast(company_id, "notification", {"id": incident_id})
    return {"status": "deleted"}


@router.get("/rules/{device_id}")
async def get_rule(device_id: str, user=Depends(require_role("owner", "admin", "viewer"))):
    with make_con() as con:
        _verify_device(con, device_id, user["company_id"])
        row = con.execute(
            text(
                "SELECT r.enabled, r.threshold_minutes, r.require_work_phase, "
                "r.minimum_work_minutes, r.notify_activity_resumed, r.notify_device_offline, "
                "r.weekly_windows, "
                "r.revision, r.updated_at FROM notification_rule_devices rd "
                "JOIN notification_rules r ON r.id = rd.rule_id "
                "WHERE rd.device_id = :did AND r.company_id = :cid"
            ),
            {"did": device_id, "cid": user["company_id"]},
        ).fetchone()
        if not row:
            # Rollout fallback in case an old backend deployment still wrote a
            # legacy row without a new mapping row.
            row = con.execute(
                text(
                    "SELECT enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, weekly_windows, "
                    "revision, updated_at "
                    "FROM device_notification_rules WHERE device_id = :did"
                ),
                {"did": device_id},
            ).fetchone()
    return _serialize_rule(row, device_id)


@router.put("/rules/{device_id}")
async def update_rule(
    device_id: str,
    body: NotificationRuleUpdate,
    user=Depends(require_role("owner", "admin")),
):
    _validate_rule_schedule(body)
    windows_json = json.dumps([window.model_dump() for window in body.weekly_windows])
    with make_con() as con:
        _verify_device(con, device_id, user["company_id"])
        existing = con.execute(
            text(
                "SELECT r.id, r.name, d.name AS device_name "
                "FROM notification_rule_devices rd "
                "JOIN notification_rules r ON r.id = rd.rule_id "
                "JOIN devices d ON d.id = rd.device_id "
                "WHERE rd.device_id = :did AND r.company_id = :cid"
            ),
            {"did": device_id, "cid": user["company_id"]},
        ).fetchone()
        device_count = 0
        if existing:
            device_count = con.execute(
                text("SELECT COUNT(*) FROM notification_rule_devices WHERE rule_id = :rid"),
                {"rid": str(existing.id)},
            ).scalar()

        if existing and device_count == 1:
            rule = con.execute(
                text(
                    "UPDATE notification_rules SET enabled = :enabled, "
                    "threshold_minutes = :threshold, "
                    "require_work_phase = :require_work_phase, "
                    "minimum_work_minutes = :minimum_work_minutes, "
                    "notify_activity_resumed = :notify_activity_resumed, "
                    "notify_device_offline = :notify_device_offline, "
                    "weekly_windows = CAST(:windows AS JSONB), "
                    "revision = revision + 1, updated_at = NOW(), updated_by = :uid "
                    "WHERE id = :rid RETURNING id, name, enabled, threshold_minutes, "
                    "require_work_phase, minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, revision, created_at, updated_at, updated_by"
                ),
                {
                    "rid": str(existing.id),
                    "enabled": body.enabled,
                    "threshold": body.threshold_minutes,
                    "require_work_phase": body.require_work_phase,
                    "minimum_work_minutes": body.minimum_work_minutes,
                    "notify_activity_resumed": body.notify_activity_resumed,
                    "notify_device_offline": body.notify_device_offline,
                    "windows": windows_json,
                    "uid": user["sub"],
                },
            ).fetchone()
        else:
            if existing:
                con.execute(
                    text(
                        "DELETE FROM notification_rule_devices "
                        "WHERE rule_id = :rid AND device_id = :did"
                    ),
                    {"rid": str(existing.id), "did": device_id},
                )
                device_name = existing.device_name
            else:
                device_name = con.execute(
                    text("SELECT name FROM devices WHERE id = :did"),
                    {"did": device_id},
                ).scalar()
            rule = con.execute(
                text(
                    "INSERT INTO notification_rules "
                    "(company_id, name, enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, updated_by) "
                    "VALUES (:cid, :name, :enabled, :threshold, :require_work_phase, "
                    ":minimum_work_minutes, :notify_activity_resumed, :notify_device_offline, "
                    "CAST(:windows AS JSONB), :uid) "
                    "RETURNING id, name, enabled, threshold_minutes, require_work_phase, "
                    "minimum_work_minutes, notify_activity_resumed, notify_device_offline, "
                    "weekly_windows, revision, "
                    "created_at, updated_at, updated_by"
                ),
                {
                    "cid": user["company_id"],
                    "name": default_name("downtime_rule", device=device_name),
                    "enabled": body.enabled,
                    "threshold": body.threshold_minutes,
                    "require_work_phase": body.require_work_phase,
                    "minimum_work_minutes": body.minimum_work_minutes,
                    "notify_activity_resumed": body.notify_activity_resumed,
                    "notify_device_offline": body.notify_device_offline,
                    "windows": windows_json,
                    "uid": user["sub"],
                },
            ).fetchone()
            _insert_rule_devices(con, rule.id, [device_id])

        _mirror_legacy_rules(con, rule, [device_id])
        broadcasts = _resolve_incidents_for_devices(
            con, [device_id], "rule_changed"
        )
        con.commit()
    for company_id, incident_id in broadcasts:
        event_manager.broadcast(company_id, "notification", {"id": incident_id})
    return _serialize_rule(rule, device_id)


def _incident_message(
    alert_type: str,
    device_name: str,
    resolved_at=None,
    resolution=None,
):
    if not resolved_at:
        if alert_type == "device_offline":
            return f"Sensor {device_name} is unreachable."
        return f"Machine {device_name} is idle during the monitored period."
    if resolution == "window_ended":
        return f"Monitoring period for {device_name} has ended."
    if resolution == "rule_changed":
        return f"Notification rule for {device_name} was changed."
    if resolution == "sensor_offline":
        return f"Downtime alert for {device_name} was replaced by the sensor status."
    if resolution == "sleep_mode":
        return f"Offline alert for {device_name} was closed because of sleep mode."
    if alert_type == "device_offline":
        return f"Sensor {device_name} is reachable again."
    return f"Machine {device_name} is counting again."


@router.get("")
async def list_notifications(user=Depends(require_role("owner", "admin", "viewer"))):
    with make_con() as con:
        rows = con.execute(
            text(
                "SELECT i.id, i.device_id, d.name AS device_name, i.rule_id, i.rule_name, i.alert_type, "
                "i.condition_since_at, i.triggered_at, i.resolved_at, i.resolution, "
                "i.notify_activity_resumed, "
                "(r.read_at IS NULL) AS unread "
                "FROM notification_incidents i "
                "JOIN devices d ON d.id = i.device_id "
                "LEFT JOIN notification_reads r ON r.incident_id = i.id AND r.user_id = :uid "
                "WHERE i.company_id = :cid "
                "AND i.triggered_at >= NOW() - CAST(:retention AS integer) * interval '1 day' "
                "ORDER BY (i.resolved_at IS NULL) DESC, i.triggered_at DESC LIMIT 100"
            ),
            {
                "uid": user["sub"],
                "cid": user["company_id"],
                "retention": INCIDENT_RETENTION_DAYS,
            },
        ).fetchall()
    return [
        {
            "id": str(row.id),
            "device_id": str(row.device_id),
            "device_name": row.device_name,
            "rule_id": str(row.rule_id) if row.rule_id else None,
            "rule_name": row.rule_name,
            "alert_type": row.alert_type,
            "severity": "critical" if row.alert_type == "device_offline" else "warning",
            "message": _incident_message(
                row.alert_type,
                row.device_name,
                row.resolved_at,
                row.resolution,
            ),
            "condition_since_at": row.condition_since_at.isoformat() + "+00:00",
            "triggered_at": row.triggered_at.isoformat() + "+00:00",
            "resolved_at": row.resolved_at.isoformat() + "+00:00" if row.resolved_at else None,
            "resolution": row.resolution,
            "notify_activity_resumed": bool(row.notify_activity_resumed),
            "unread": bool(row.unread),
        }
        for row in rows
    ]


@router.post("/{incident_id}/read")
async def mark_read(
    incident_id: str, user=Depends(require_role("owner", "admin", "viewer"))
):
    with make_con() as con:
        incident = con.execute(
            text("SELECT id FROM notification_incidents WHERE id = :id AND company_id = :cid"),
            {"id": incident_id, "cid": user["company_id"]},
        ).fetchone()
        if not incident:
            raise HTTPException(status_code=404, detail="Alert not found")
        con.execute(
            text(
                "INSERT INTO notification_reads (incident_id, user_id) VALUES (:id, :uid) "
                "ON CONFLICT (incident_id, user_id) DO UPDATE SET read_at = NOW()"
            ),
            {"id": incident_id, "uid": user["sub"]},
        )
        con.commit()
    return {"status": "read"}


@router.post("/read-all")
async def mark_all_read(user=Depends(require_role("owner", "admin", "viewer"))):
    with make_con() as con:
        result = con.execute(
            text(
                "INSERT INTO notification_reads (incident_id, user_id) "
                "SELECT id, :uid FROM notification_incidents WHERE company_id = :cid "
                "ON CONFLICT (incident_id, user_id) DO UPDATE SET read_at = NOW()"
            ),
            {"uid": user["sub"], "cid": user["company_id"]},
        )
        con.commit()
    return {"status": "read", "count": result.rowcount}


def _as_windows(value):
    if isinstance(value, list):
        return value
    return json.loads(value or "[]")


def _local_boundary(day: date, clock: str, tz: ZoneInfo) -> datetime:
    parsed = datetime.strptime(clock, "%H:%M").time()
    return datetime.combine(day, time(parsed.hour, parsed.minute), tzinfo=tz)


def active_window(now_utc: datetime, windows, timezone_name: str):
    """Active window as (naive UTC start, end), including overnight windows."""
    try:
        tz = ZoneInfo(timezone_name or "Europe/Berlin")
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("Europe/Berlin")
    now_local = now_utc.astimezone(tz)
    for base_day in (now_local.date(), now_local.date() - timedelta(days=1)):
        iso_day = base_day.isoweekday()
        for window in _as_windows(windows):
            if iso_day not in window.get("days", []):
                continue
            start = _local_boundary(base_day, window["start"], tz)
            end_day = base_day
            if _clock_minutes(window["end"]) <= _clock_minutes(window["start"]):
                end_day += timedelta(days=1)
            end = _local_boundary(end_day, window["end"], tz)
            if start <= now_local < end:
                return (
                    start.astimezone(timezone.utc).replace(tzinfo=None),
                    end.astimezone(timezone.utc).replace(tzinfo=None),
                )
    return None


def _resolve_open(
    con,
    device_id,
    alert_type,
    resolution,
    notify_resolution=True,
):
    row = con.execute(
        text(
            "UPDATE notification_incidents SET resolved_at = NOW(), resolution = :resolution, "
            "notify_activity_resumed = :notify_resolution "
            "WHERE device_id = :did AND alert_type = :type AND resolved_at IS NULL "
            "RETURNING id, company_id"
        ),
        {
            "did": device_id,
            "type": alert_type,
            "resolution": resolution,
            "notify_resolution": notify_resolution,
        },
    ).fetchone()
    return row


def _open_incident(
    con,
    row,
    alert_type,
    window_start,
    window_end,
    condition_since,
):
    incident = con.execute(
        text(
            "INSERT INTO notification_incidents "
            "(company_id, device_id, rule_id, rule_name, rule_revision, alert_type, "
            "window_start_at, window_end_at, condition_since_at, notify_activity_resumed) "
            "VALUES (:cid, :did, :rule_id, :rule_name, :revision, :type, :ws, :we, "
            ":since, :notify_activity_resumed) "
            "ON CONFLICT (device_id, alert_type) WHERE resolved_at IS NULL DO NOTHING "
            "RETURNING id"
        ),
        {
            "cid": str(row.company_id),
            "did": str(row.device_id),
            "rule_id": str(row.rule_id),
            "rule_name": row.rule_name,
            "revision": row.revision,
            "type": alert_type,
            "ws": window_start,
            "we": window_end,
            "since": condition_since,
            "notify_activity_resumed": bool(row.notify_activity_resumed),
        },
    ).fetchone()
    if incident:
        return str(incident.id)
    return None


def _latest_activity_block(con, device_id, start_at, end_at, pause_minutes):
    """Return the latest hit block; a pause-sized gap starts a new work phase."""
    return con.execute(
        text(
            "WITH ordered AS ("
            "  SELECT recorded_at, "
            "    LAG(recorded_at) OVER (ORDER BY recorded_at) AS previous_at "
            "  FROM device_hits WHERE device_id = :did "
            "  AND counted IS TRUE "
            "  AND recorded_at >= :start_at AND recorded_at <= :end_at"
            "), blocks AS ("
            "  SELECT recorded_at, SUM(CASE "
            "    WHEN previous_at IS NULL OR recorded_at - previous_at >= "
            "      CAST(:pause_minutes AS integer) * interval '1 minute' "
            "    THEN 1 ELSE 0 END"
            "  ) OVER (ORDER BY recorded_at) AS block_id FROM ordered"
            "), latest AS ("
            "  SELECT block_id FROM blocks ORDER BY recorded_at DESC LIMIT 1"
            ") SELECT MIN(recorded_at) AS started_at, "
            "MAX(recorded_at) AS ended_at FROM blocks "
            "WHERE block_id = (SELECT block_id FROM latest)"
        ),
        {
            "did": str(device_id),
            "start_at": start_at,
            "end_at": end_at,
            "pause_minutes": pause_minutes,
        },
    ).fetchone()


def _set_no_hits_notification_latch(con, rule_id, device_id, sent):
    result = con.execute(
        text(
            "UPDATE notification_rule_devices "
            "SET no_hits_notification_sent = :sent "
            "WHERE rule_id = :rule_id AND device_id = :device_id "
            "AND no_hits_notification_sent IS DISTINCT FROM :sent"
        ),
        {
            "rule_id": str(rule_id),
            "device_id": str(device_id),
            "sent": sent,
        },
    )
    return bool(result.rowcount)


def _claim_no_hits_notification(con, rule_id, device_id):
    return _set_no_hits_notification_latch(con, rule_id, device_id, True)


def evaluate_notification_rules(now_utc=None):
    now_aware = now_utc or datetime.now(timezone.utc)
    now = now_aware.astimezone(timezone.utc).replace(tzinfo=None)
    broadcasts = []
    with make_con() as con:
        got_lock = con.execute(
            text("SELECT pg_try_advisory_xact_lock(:lock_id)"),
            {"lock_id": EVALUATION_LOCK_ID},
        ).scalar()
        if not got_lock:
            return 0
        rows = con.execute(
            text(
                "SELECT r.id AS rule_id, r.name AS rule_name, rd.device_id, r.enabled, "
                "r.threshold_minutes, r.require_work_phase, r.minimum_work_minutes, "
                "r.notify_activity_resumed, "
                "r.notify_device_offline, r.weekly_windows, "
                "r.revision, r.updated_at, "
                "rd.no_hits_notification_sent, "
                "d.company_id, d.name, d.last_seen_at, d.upload_interval_s, "
                "d.sleep_mode, c.timezone, h.last_hit_at, "
                "latest_stall.condition_since_at AS notified_condition_since_at, "
                "recovery.online_recovered_at "
                "FROM notification_rules r "
                "JOIN notification_rule_devices rd ON rd.rule_id = r.id "
                "JOIN devices d ON d.id = rd.device_id AND d.company_id = r.company_id "
                "JOIN companies c ON c.id = d.company_id "
                "LEFT JOIN LATERAL ("
                "  SELECT MAX(recorded_at) AS last_hit_at FROM device_hits "
                "  WHERE device_id = d.id AND counted IS TRUE"
                ") h ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT condition_since_at FROM notification_incidents "
                "  WHERE device_id = d.id AND alert_type = 'no_hits' "
                "  ORDER BY triggered_at DESC LIMIT 1"
                ") latest_stall ON true "
                "LEFT JOIN LATERAL ("
                "  SELECT resolved_at AS online_recovered_at FROM notification_incidents "
                "  WHERE device_id = d.id AND alert_type = 'device_offline' "
                "  AND resolution = 'device_online' ORDER BY resolved_at DESC LIMIT 1"
                ") recovery ON true "
                "WHERE r.enabled = true AND d.is_active = true"
            )
        ).fetchall()

        for row in rows:
            # The lock belongs to the idle period, not to the incident. Even if an
            # incident was closed by a time window or a sensor outage, the same
            # downtime must not be reported again. Only a genuinely new counted
            # stroke releases the lock.
            if (
                row.no_hits_notification_sent
                and row.last_hit_at
                and row.notified_condition_since_at
                and row.last_hit_at > row.notified_condition_since_at
            ):
                _set_no_hits_notification_latch(
                    con, row.rule_id, row.device_id, False
                )

            window = active_window(now_aware, row.weekly_windows, row.timezone)
            if not window:
                for alert_type in ("no_hits", "device_offline"):
                    resolved = _resolve_open(
                        con, row.device_id, alert_type, "window_ended"
                    )
                    if resolved:
                        broadcasts.append((str(resolved.company_id), str(resolved.id)))
                continue
            window_start, window_end = window
            sync_seconds = max(30, int(row.upload_interval_s or 30))
            offline_after = (
                timedelta(hours=24)
                if row.sleep_mode
                else timedelta(seconds=max(90, sync_seconds * 3))
            )
            seen_since = (
                row.last_seen_at or window_start
                if row.sleep_mode
                else max(window_start, row.last_seen_at or window_start)
            )
            sensor_healthy = bool(row.last_seen_at and now - row.last_seen_at <= offline_after)

            if not row.notify_device_offline:
                muted = _resolve_open(
                    con, row.device_id, "device_offline", "rule_changed"
                )
                if muted:
                    broadcasts.append((str(muted.company_id), str(muted.id)))

            # Sleep is an expected device state after machine downtime: the
            # no_hits rule keeps running, but a previously open offline incident
            # is closed immediately and only re-evaluated after 24 h without sync.
            if row.sleep_mode and sensor_healthy:
                sleeping = _resolve_open(
                    con, row.device_id, "device_offline", "sleep_mode"
                )
                if sleeping:
                    broadcasts.append((str(sleeping.company_id), str(sleeping.id)))

            if not sensor_healthy:
                resolved = _resolve_open(
                    con, row.device_id, "no_hits", "sensor_offline"
                )
                if resolved:
                    broadcasts.append((str(resolved.company_id), str(resolved.id)))
                if row.notify_device_offline and now - seen_since >= offline_after:
                    incident_id = _open_incident(
                        con, row, "device_offline", window_start, window_end, seen_since
                    )
                    if incident_id:
                        broadcasts.append((str(row.company_id), incident_id))
                continue

            returned_online = _resolve_open(
                con,
                row.device_id,
                "device_offline",
                "device_online",
            )
            if returned_online:
                broadcasts.append(
                    (str(returned_online.company_id), str(returned_online.id))
                )
            open_stall = con.execute(
                text(
                    "SELECT id, triggered_at FROM notification_incidents "
                    "WHERE device_id = :did AND alert_type = 'no_hits' AND resolved_at IS NULL"
                ),
                {"did": str(row.device_id)},
            ).fetchone()
            if open_stall and row.last_hit_at and row.last_hit_at > open_stall.triggered_at:
                resumed = _resolve_open(
                    con,
                    row.device_id,
                    "no_hits",
                    "activity_resumed",
                    notify_resolution=bool(row.notify_activity_resumed),
                )
                if resumed:
                    _set_no_hits_notification_latch(
                        con, row.rule_id, row.device_id, False
                    )
                    broadcasts.append((str(resumed.company_id), str(resumed.id)))

            activity_floor = max(
                value
                for value in (
                    window_start,
                    row.updated_at,
                    row.online_recovered_at,
                    now if returned_online else None,
                )
                if value is not None
            )
            if row.require_work_phase:
                activity = _latest_activity_block(
                    con,
                    row.device_id,
                    activity_floor,
                    now,
                    row.threshold_minutes,
                )
                if (
                    not activity
                    or activity.started_at is None
                    or activity.ended_at is None
                    or activity.ended_at - activity.started_at
                    < timedelta(minutes=row.minimum_work_minutes)
                ):
                    continue
                condition_since = activity.ended_at
            else:
                condition_since = max(
                    value
                    for value in (
                        activity_floor,
                        row.last_hit_at
                        if row.last_hit_at and row.last_hit_at >= window_start
                        else None,
                    )
                    if value is not None
                )
            if (
                now - condition_since >= timedelta(minutes=row.threshold_minutes)
                and _claim_no_hits_notification(
                    con, row.rule_id, row.device_id
                )
            ):
                incident_id = _open_incident(
                    con, row, "no_hits", window_start, window_end, condition_since
                )
                if incident_id:
                    broadcasts.append((str(row.company_id), incident_id))

        con.execute(
            text(
                "DELETE FROM notification_incidents "
                "WHERE resolved_at IS NOT NULL "
                "AND resolved_at < NOW() - CAST(:days AS integer) * interval '1 day'"
            ),
            {"days": INCIDENT_RETENTION_DAYS},
        )
        con.commit()

    for company_id, incident_id in broadcasts:
        event_manager.broadcast(company_id, "notification", {"id": incident_id})
    return len(broadcasts)


def run_notification_cycle():
    return evaluate_notification_rules()


async def notification_worker_loop():
    while True:
        try:
            await asyncio.to_thread(run_notification_cycle)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Notification worker failed")
        await asyncio.sleep(WORKER_INTERVAL_S)
