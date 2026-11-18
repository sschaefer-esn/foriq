import asyncio
import json
import math
from datetime import datetime, timezone
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, model_validator
from sqlalchemy import text

from utils.db import make_con
from utils.restart_schedule import restart_schedule_to_utc
from utils.legacy_protocol import (
    LEGACY_STROKE_THRESHOLD_KEY,
    add_legacy_sync_keys,
    upstream_aliases,
)
from utils.device_token import device_token_lookup_params
from events import event_manager
from counting_defaults import (
    DEFAULT_COUNT_BRIDGE_MS,
    USER_TIMING_FACTOR,
    normalize_count_sensitivity,
    sensitivity_to_legacy_offset,
)
from ota import (
    _get_firmware_version,
    _list_firmware_files,
    firmware_version_at_least,
    ota_target_reached,
    safe_target,
)

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

# OTA robustness: a delivered/running OTA update without a sign of life
# (last_progress_at) is considered orphaned after this time - device crashed
# mid-update, rebooted or lost the network - and is set to 'timeout'. Sized
# generously: HTTP retries (3x ~12 s) + slow download + reboot + Wi-Fi
# association + first sync afterwards. The former 5-minute value cut off exactly
# the "slow but alive" case.
OTA_STALE_AFTER = "10 minutes"
# A running DOWNLOAD gets considerably more time: the device cannot send a
# heartbeat while the stream is open (a second HTTPS request would mean a second
# TLS context on the heap - a collision that once broke OTA). On weak
# Wi-Fi 1.1 MB easily takes > 10 min; if the command had already been reaped by
# then, the device would discard its finished image at the end.
# 45 min corresponds to ~400 bytes/s - generous enough for any still usable
# connection. A genuinely stuck download is visible in the UI ("X min in this
# phase") and can be cancelled manually at any time.
OTA_DOWNLOAD_STALE_AFTER = "45 minutes"
# A 'pending' command was never delivered (device offline/asleep). Only reap it
# after this time - devices in duty cycle/sleep do not sync for up to ~15 min,
# and an open row blocks any further queuing.
OTA_UNDELIVERED_AFTER = "2 hours"
# Growing retry backoff after genuine failures for the SAME target version.
# Policy: NEVER lock automatically, only throttle - down to once a day. The index
# follows from the failure history since the last success (no counter in the
# DB). A success or a new target version starts again at step 1.
OTA_BACKOFF_STEPS = ["2 minutes", "5 minutes", "15 minutes", "60 minutes", "1 day"]
# Only failures within this window drive the backoff step. Without it, a device
# that once went through a bad phase would stay on the daily step forever - even
# if the cause (Wi-Fi, location) was fixed long ago. With the window it works
# its way back up by itself.
# MUST be larger than the last backoff step: otherwise the failures drop out of
# the window before the wait has elapsed, and the highest step would never be
# reachable.
OTA_FAILURE_WINDOW = "48 hours"
# progress values that do NOT count as an update failure: a user cancel and a
# never-delivered command say nothing about the device's OTA capability.
OTA_NON_FAILURE_PROGRESS = ("cancelled", "undelivered", "superseded")
# As an SQL literal list (fixed code constants, no input data) - psycopg2 does
# not reliably adapt Python lists in text() queries to ARRAY.
OTA_NON_FAILURE_SQL = ", ".join(f"'{p}'" for p in OTA_NON_FAILURE_PROGRESS)
# Interval of the process-wide reaper (main.py). Covers devices that never come
# back after an update - the sync path alone would never see them again.
OTA_REAPER_INTERVAL_S = 60
# Settings sync interval. While a fast-sync window is active (a user has the
# device page open -> /watching, or a settings change was saved; devices.py sets
# fast_sync_until), the device polls every second instead of every 30 s so new
# parameters arrive almost immediately. Queuing a command does not open the
# window: the command is picked up at the next regular sync.
FAST_SYNC_INTERVAL_MS = 1000
NORMAL_SYNC_INTERVAL_MS = 30000


def _energy_wire_config(device, installed_fw):
    """Counting configuration plus a temporary adapter for old firmware.

    From 13.25 only energy (sensitivity + stroke period T) is sent. Older field
    devices keep receiving their stored values until they have actually
    reported the energy OTA.
    """

    stored_sensitivity = normalize_count_sensitivity(device.count_sensitivity)
    # TRANSITION(fw<14): the < 13.16 / < 13.25 branches serve S3 sensors that
    # still run firmware 13.x until their OTA to 14 has completed.
    downstream_sensitivity = (
        stored_sensitivity
        if firmware_version_at_least(installed_fw, "13.16.0")
        else sensitivity_to_legacy_offset(stored_sensitivity)
    )
    bridge_ms = max(
        400,
        device.count_bridge_ms
        if device.count_bridge_ms is not None
        else DEFAULT_COUNT_BRIDGE_MS,
    ) * USER_TIMING_FACTOR
    result = {
        "count_sensitivity": downstream_sensitivity,
        "count_bridge_ms": int(math.floor(bridge_ms + 0.5)),
    }
    if not firmware_version_at_least(installed_fw, "13.25.0"):
        result.update({
            "std_window": device.std_window if device.std_window is not None else 19,
            "sensitivity_ms": device.sensitivity_ms if device.sensitivity_ms is not None else 50,
            "hysteresis_ms": device.hysteresis_ms if device.hysteresis_ms is not None else 120,
            "min_peak_g": device.min_peak_g if device.min_peak_g is not None else 0,
            # TRANSITION(fw<14): old firmware reads the German name.
            LEGACY_STROKE_THRESHOLD_KEY: (
                device.stroke_threshold if device.stroke_threshold is not None else 0.5
            ),
        })
    return stored_sensitivity, result


class CurrentConfig(BaseModel):
    upload_interval_s: int | None = None
    sleep_after_min: int | None = None
    hit_drop_count: int | None = None            # diagnostics: dropped hits; persistent in NVS from 13.18
    hit_spiffs_write_errors: int | None = None   # diagnostics: failed persistent hit backups
    hit_last_upload_ms: int | None = None
    hit_max_upload_ms: int | None = None
    hit_http_error_count: int | None = None
    hit_queue_ram_count: int | None = None
    hit_queue_flash_count: int | None = None
    hit_queue_oldest_age_s: int | None = None
    wifi_rssi: int | None = None
    wifi_offline_s: int | None = None
    wifi_reconnect_count: int | None = None
    wifi_roam_count: int | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_names(cls, data):
        # TRANSITION(fw<14): firmware 13.x reports German field names.
        return upstream_aliases(data)


class CommandResult(BaseModel):
    command_id: str
    success: bool


# ─── OTA state maintenance (shared by the sync path and the background reaper) ───

def _reap_stale_ota(con, device_id=None):
    """Set orphaned OTA commands to a terminal state. device_id=None -> process-wide.

    Two clocks: a never-delivered command ('pending') gets plenty of time (the
    device may be asleep), a running one is measured against the last heartbeat.
    Returns the SSE events; the caller broadcasts them so the DB transaction
    does not depend on it.
    """
    rows = con.execute(
        text(
            "UPDATE device_commands c "
            "SET status = 'failed', "
            "    progress = CASE WHEN c.status = 'pending' THEN 'undelivered' ELSE 'timeout' END, "
            "    completed_at = NOW() "
            "FROM devices d "
            "WHERE d.id = c.device_id AND c.command = 'ota_update' "
            "  AND c.status IN ('pending', 'delivered', 'in_progress') "
            "  AND (CAST(:did AS UUID) IS NULL OR c.device_id = CAST(:did AS UUID)) "
            "  AND COALESCE(c.last_progress_at, c.delivered_at, c.created_at) < "
            "      NOW() - (CASE WHEN c.status = 'pending' "
            "                    THEN CAST(:undeliv AS INTERVAL) "
            "                    WHEN c.progress = 'downloading' "
            "                    THEN CAST(:dlstale AS INTERVAL) "
            "                    ELSE CAST(:stale AS INTERVAL) END) "
            "RETURNING c.id, c.device_id, d.company_id, c.progress"
        ),
        {"did": device_id, "stale": OTA_STALE_AFTER,
         "dlstale": OTA_DOWNLOAD_STALE_AFTER, "undeliv": OTA_UNDELIVERED_AFTER},
    ).fetchall()
    return [
        {
            "company_id": str(r.company_id),
            "device_id": str(r.device_id),
            "command_id": str(r.id),
            "command": "ota_update",
            "status": "failed",
            "progress": r.progress,
        }
        for r in rows
    ]


def _reap_stale_ota_global():
    """One process-wide reap pass (synchronous, for the thread pool)."""
    with make_con() as con:
        events = _reap_stale_ota(con, None)
        con.commit()
    return events


async def ota_reaper_loop():
    """Process-wide reaper, started from main.py.

    Needed because _reap_stale_ota in the sync path only runs when the affected
    device checks in again - a device that never returns after an update
    (bricked, battery empty, Wi-Fi gone) would otherwise stay 'delivered' forever
    and block any further queuing.
    """
    while True:
        try:
            await asyncio.sleep(OTA_REAPER_INTERVAL_S)
            events = await asyncio.to_thread(_reap_stale_ota_global)
            for ev in events:
                company_id = ev.pop("company_id")
                event_manager.broadcast(company_id, "command_status", ev)
                print(f"[OTA-Reaper] {ev['device_id']}: {ev['command_id']} → {ev['progress']}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # The loop must NEVER die
            print(f"[OTA-Reaper] Error ignored: {exc}")


def ota_retry_state(con, device_id, target_version):
    """Failure history for a target version -> (fail_count, backoff, last_error).

    Only *genuine* failures count (no cancel, no 'undelivered'), only since the
    last successful update and only within OTA_FAILURE_WINDOW - so both a success
    and the mere passage of time reset the backoff, without persisting a counter
    anywhere.
    """
    row = con.execute(
        text(
            "WITH last_ok AS ("
            "  SELECT MAX(completed_at) AS ts FROM device_commands "
            "  WHERE device_id = :did AND command = 'ota_update' AND status = 'completed'"
            ") "
            "SELECT COUNT(*) AS n, MAX(c.completed_at) AS last_fail, "
            "       (ARRAY_AGG(c.payload->>'error' ORDER BY c.completed_at DESC))[1] AS last_error "
            "FROM device_commands c, last_ok "
            "WHERE c.device_id = :did AND c.command = 'ota_update' "
            "  AND c.status = 'failed' "
            f"  AND COALESCE(c.progress, '') NOT IN ({OTA_NON_FAILURE_SQL}) "
            "  AND c.payload->>'target_version' = :tv "
            "  AND c.completed_at IS NOT NULL "
            "  AND c.completed_at > NOW() - CAST(:window AS INTERVAL) "
            "  AND (last_ok.ts IS NULL OR c.completed_at > last_ok.ts)"
        ),
        {"did": device_id, "tv": target_version, "window": OTA_FAILURE_WINDOW},
    ).fetchone()

    fail_count = (row.n if row else 0) or 0
    idx = min(max(fail_count, 1) - 1, len(OTA_BACKOFF_STEPS) - 1)
    return fail_count, OTA_BACKOFF_STEPS[idx], (row.last_error if row else None)


class SettingsSyncPayload(BaseModel):
    firmware_version: str | None = None
    firmware_target: str | None = None     # build target, e.g. 'm5sticks3'
    sleep_mode: bool | None = None
    current_config: CurrentConfig | None = None
    command_results: list[CommandResult] | None = None


def _settings_sync_db(payload, device_token):
    """Synchronous DB work for settings_sync - runs in the thread pool."""
    with make_con() as con:
        device = con.execute(
            text(
                "SELECT devices.id AS id, company_id, upload_interval_s, restart_schedule, "
                "firmware_version, auto_update, sleep_after_min, "
                "fast_sync_until, "
                "count_sensitivity, count_bridge_ms, "
                "std_window, sensitivity_ms, hysteresis_ms, min_peak_g, stroke_threshold, "
                "power_save_mode "
                "FROM devices "
                "WHERE (device_token_hash = :token_hash "
                "OR device_token = :device_token) AND is_active = true"
            ),
            device_token_lookup_params(device_token),
        ).fetchone()

        if not device:
            return None

        now = datetime.now(timezone.utc)
        device_id_str = str(device.id)
        # Determine the served server version once (reads the binary) and reuse
        # it for reset (1) + auto-update (4). ALWAYS target-specific: a missing
        # or unsupported target (firmware that predates the S3, retired
        # hardware) gets no OTA at all - binaries of different chips are
        # incompatible.
        fw_target = safe_target(payload.firmware_target)
        server_version = _get_firmware_version(fw_target) if fw_target else "unknown"
        # Without a servable binary (version unreadable, firmware-cpp/ not in the
        # image) an OTA must NEVER be queued - otherwise a command is created
        # with a target version no device can ever satisfy.
        ota_deliverable = bool(
            fw_target
            and server_version != "unknown"
            and _list_firmware_files(fw_target)
        )

        # 1. Update device metadata
        updates = ["last_seen_at = :now"]
        params = {"now": now, "did": device_id_str}
        if payload.firmware_version is not None:
            updates.append("firmware_version = :fv")
            params["fv"] = payload.firmware_version
        # Persist only supported targets. An image accidentally built with the
        # config.h fallback "unknown" must not overwrite the hardware class
        # already known for the device.
        if safe_target(payload.firmware_target):
            updates.append("firmware_target = :ft")
            params["ft"] = payload.firmware_target
        if payload.sleep_mode is not None:
            updates.append("sleep_mode = :sm")
            params["sm"] = payload.sleep_mode

        # Persist diagnostic counters. From FW 13.18 the drop/SPIFFS counters are
        # monotonic across reboots on the device; older counters count since boot.
        if payload.current_config:
            for field, col in (("hit_drop_count", "hit_drop_count"),
                               ("hit_spiffs_write_errors", "hit_spiffs_write_errors"),
                               ("hit_last_upload_ms", "hit_last_upload_ms"),
                               ("hit_max_upload_ms", "hit_max_upload_ms"),
                               ("hit_http_error_count", "hit_http_error_count"),
                               ("hit_queue_ram_count", "hit_queue_ram_count"),
                               ("hit_queue_flash_count", "hit_queue_flash_count"),
                               ("hit_queue_oldest_age_s", "hit_queue_oldest_age_s"),
                               ("wifi_offline_s", "wifi_offline_s"),
                               ("wifi_reconnect_count", "wifi_reconnect_count"),
                               ("wifi_roam_count", "wifi_roam_count")):
                val = getattr(payload.current_config, field)
                if val is not None and math.isfinite(val):
                    updates.append(f"{col} = :{col}")
                    params[col] = max(0, val)

            wifi_rssi = payload.current_config.wifi_rssi
            if wifi_rssi is not None and math.isfinite(wifi_rssi):
                updates.append("wifi_rssi = :wifi_rssi")
                params["wifi_rssi"] = max(-127, min(0, int(wifi_rssi)))

        con.execute(
            text(f"UPDATE devices SET {', '.join(updates)} WHERE id = :did"),
            params,
        )

        # 2. Process command_results
        command_events = []
        if payload.command_results:
            for cr in payload.command_results:
                status = "completed" if cr.success else "failed"
                result = con.execute(
                    text(
                        "UPDATE device_commands SET status = :status, completed_at = NOW() "
                        "WHERE id = :cid AND device_id = :did "
                        "RETURNING id, command"
                    ),
                    {"status": status, "cid": cr.command_id, "did": device_id_str},
                ).fetchone()
                if result:
                    command_events.append({
                        "device_id": device_id_str,
                        "command_id": cr.command_id,
                        "command": result.command,
                        "status": status,
                    })

        # 3. OTA completion detection. While a command is waiting, a newer server
        # artifact may already have been deployed. The firmware always installs
        # the image currently served, so installed > command target is a success
        # too. Previously such an update hung until the reaper, even though the
        # controller had already been updated correctly.
        ota_event = None
        if payload.firmware_version:
            active_row = con.execute(
                text(
                    "SELECT id, payload->>'target_version' AS target_version "
                    "FROM device_commands WHERE device_id = :did "
                    "AND command = 'ota_update' "
                    "AND status IN ('delivered', 'in_progress') "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"did": device_id_str},
            ).fetchone()
            target_reached = bool(
                active_row
                and ota_target_reached(
                    payload.firmware_version,
                    device.firmware_version,
                    active_row.target_version,
                )
            )
            active_ota = None
            if target_reached:
                active_ota = con.execute(
                    text(
                        "UPDATE device_commands SET status = 'completed', "
                        "progress = 'completed', completed_at = NOW(), "
                        "last_progress_at = NOW() "
                        "WHERE id = :cid AND device_id = :did "
                        "AND status IN ('delivered', 'in_progress') RETURNING id"
                    ),
                    {"cid": str(active_row.id), "did": device_id_str},
                ).fetchone()
            if active_ota:
                ota_event = {
                    "device_id": device_id_str,
                    "command_id": str(active_ota.id),
                    "command": "ota_update",
                    "status": "completed",
                    "progress": "completed",
                    "firmware_version": payload.firmware_version,
                }

        # 3b. Clean up orphaned OTA commands (robustness against hangs).
        # Same logic as the process-wide reaper (main.py) - additionally run in
        # the sync so a returning device is cleaned up without delay.
        reap_events = [
            {k: v for k, v in ev.items() if k != "company_id"}
            for ev in _reap_stale_ota(con, device_id_str)
        ]

        # 4. Auto-update (server_version determined once above)
        if (
            payload.firmware_version
            and device.auto_update
            and ota_deliverable
            and payload.firmware_version != server_version
        ):
            fail_count, backoff, _last_error = ota_retry_state(con, device_id_str, server_version)
            blocking_ota = con.execute(
                text(
                    "SELECT id FROM device_commands "
                    "WHERE device_id = :did AND command = 'ota_update' "
                    "AND (status IN ('pending', 'delivered', 'in_progress') "
                    "     OR (status = 'completed' AND payload->>'target_version' = :tv) "
                    "     OR (status = 'failed' "
                    f"         AND COALESCE(progress, '') NOT IN ({OTA_NON_FAILURE_SQL}) "
                    "         AND payload->>'target_version' = :tv "
                    "         AND completed_at > NOW() - CAST(:backoff AS INTERVAL))) "
                    "LIMIT 1"
                ),
                {"did": device_id_str, "tv": server_version, "backoff": backoff},
            ).fetchone()
            if not blocking_ota:
                # ON CONFLICT against the partial unique index: two parallel syncs
                # of the same device must not create a second open row - and a
                # unique violation must NEVER raise a 500 on /settings/sync (the
                # firmware treats that as a sync failure and escalates up to a
                # restart).
                con.execute(
                    text(
                        "INSERT INTO device_commands (device_id, command, payload) "
                        "VALUES (:did, 'ota_update', :pl) "
                        "ON CONFLICT (device_id) WHERE command = 'ota_update' "
                        "AND status IN ('pending', 'delivered', 'in_progress') DO NOTHING"
                    ),
                    {"did": device_id_str, "pl": json.dumps({"target_version": server_version})},
                )
                if fail_count:
                    print(f"[OTA] Device {device_id_str}: Retry #{fail_count + 1} "
                          f"to {server_version} (backoff was {backoff})")

        # 5. Load commands. Redeliver a still open OTA command: the device sync
        # runs serially in the same network task, so a new sync proves that no
        # old OTA handler is running any more. If its final failed report was
        # lost together with the Wi-Fi, the device can continue the same attempt
        # right after reconnecting instead of appearing stuck until the
        # 10/45-minute reaper. Other commands (restart in particular) must never
        # be executed twice.
        cmds = con.execute(
            text(
                "SELECT id, command, payload, status FROM device_commands "
                "WHERE device_id = :did AND (status = 'pending' OR "
                "(command = 'ota_update' AND status IN ('delivered', 'in_progress'))) "
                "ORDER BY created_at"
            ),
            {"did": device_id_str},
        ).fetchall()

        pending_cmds = [c for c in cmds if c.status == "pending"]
        if pending_cmds:
            placeholders = ", ".join(f":id_{i}" for i in range(len(pending_cmds)))
            id_params = {f"id_{i}": str(c.id) for i, c in enumerate(pending_cmds)}
            con.execute(
                text(
                    # last_progress_at starts the reaper's heartbeat clock: from
                    # delivery, not from creation.
                    "UPDATE device_commands SET status = 'delivered', delivered_at = NOW(), "
                    "last_progress_at = NOW() "
                    f"WHERE id IN ({placeholders})"
                ),
                id_params,
            )

        con.commit()

    return {
        "device": device,
        "device_id_str": device_id_str,
        "now": now,
        "cmds": cmds,
        "command_events": command_events,
        "ota_event": ota_event,
        "reap_events": reap_events,
    }


@router.post("/sync")
async def settings_sync(
    request: Request,
    payload: SettingsSyncPayload,
    x_device_token: str = Header(None),
):
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Device token missing")

    result = await asyncio.to_thread(_settings_sync_db, payload, x_device_token)

    if result is None:
        raise HTTPException(status_code=401, detail="Invalid device token")

    device = result["device"]
    device_id_str = result["device_id_str"]
    now = result["now"]
    cmds = result["cmds"]

    # Send SSE events (non-blocking, no DB access)
    for ce in result["command_events"]:
        event_manager.broadcast(str(device.company_id), "command_status", ce)
    if result["ota_event"]:
        event_manager.broadcast(str(device.company_id), "command_status", result["ota_event"])
    for re_ev in result["reap_events"]:
        event_manager.broadcast(str(device.company_id), "command_status", re_ev)

    # 6. Build downstream response
    fast_sync_active = (
        device.fast_sync_until is not None
        and device.fast_sync_until.replace(tzinfo=timezone.utc) > now
    )
    sync_interval_ms = FAST_SYNC_INTERVAL_MS if fast_sync_active else NORMAL_SYNC_INTERVAL_MS
    installed_fw = payload.firmware_version or device.firmware_version
    stored_count_sensitivity, energy_config = _energy_wire_config(device, installed_fw)

    config = {
        "upload_interval_s": device.upload_interval_s or 0,
        "restart_schedule": restart_schedule_to_utc(device.restart_schedule),
        **energy_config,
        "sleep_after_min": device.sleep_after_min if device.sleep_after_min is not None else 0,
        "power_save": bool(device.power_save_mode),
        "auto_update": device.auto_update or False,
        "server_time_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
        "sync_interval_ms": sync_interval_ms,
    }
    # TRANSITION(fw<14): remove once all sensors run firmware 14.
    device_config = add_legacy_sync_keys(dict(config))

    commands = [
        {"id": str(c.id), "command": c.command, "payload": c.payload}
        for c in cmds
    ] if cmds else []

    # 7. Broadcast SSE events
    sync_data = {
        "device_id": device_id_str,
        "last_seen_at": now.isoformat(),
        "sleep_mode": payload.sleep_mode,
        "firmware_version": payload.firmware_version,
        "downstream_config": {
            "upload_interval_s": config["upload_interval_s"],
            "sleep_after_min": config["sleep_after_min"],
            "count_sensitivity": stored_count_sensitivity,
            # SSE keeps the DB semantics: NULL = auto (sent downstream to the device as -1).
            "count_bridge_ms": device.count_bridge_ms,
        },
    }
    if payload.current_config:
        sync_data["current_config"] = payload.current_config.model_dump()
    event_manager.broadcast(str(device.company_id), "settings_sync", sync_data)
    event_manager.broadcast(str(device.company_id), "status", {
        "device_id": device_id_str,
        "last_seen_at": now.isoformat(),
        "sleep_mode": payload.sleep_mode,
    })

    print(f"[settings_sync] UPSTREAM device={device_id_str} fw={payload.firmware_version} sleep={payload.sleep_mode} config={payload.current_config.model_dump() if payload.current_config else None}")
    print(f"[settings_sync] DOWNSTREAM device={device_id_str} settings={device_config} commands={commands}")

    return {"settings": device_config, "commands": commands}
