import asyncio
import math
import struct
import time
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text

from utils.db import make_con
from utils.device_token import device_token_lookup_params
from utils.legacy_protocol import add_legacy_hit_keys
from events import event_manager

router = APIRouter(prefix="/api/v1/ingest", tags=["ingest"])
logger = logging.getLogger("foriq.ingest")

# Size limits against OOM/DB DoS with a (leaked) device token. Deliberately
# generous compared to real payloads: one v4 hit is 36 B.
MAX_HITS_BYTES = 1024 * 1024              # ~29k v4 hits; firmware sends 50 per batch
MAX_HIT_AGE = timedelta(days=400)
MAX_HIT_FUTURE_SKEW = timedelta(minutes=10)


@dataclass(frozen=True)
class HitDeviceContext:
    id: object
    company_id: object
    upload_interval_s: int | None
    sleep_after_min: int | None
    power_save_mode: bool | None


def _reject_if_too_large(request: Request, body: bytes | None, max_bytes: int):
    """413 if the Content-Length header OR the actual body exceeds the limit.
    body=None checks only the header (before reading), otherwise the real body."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > max_bytes:
                raise HTTPException(status_code=413, detail="Payload too large")
        except ValueError:
            pass
    if body is not None and len(body) > max_bytes:
        raise HTTPException(status_code=413, detail="Payload too large")


async def _read_limited_body(request: Request, max_bytes: int) -> bytes:
    """Read the body as a stream and enforce the limit even without Content-Length."""
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > max_bytes:
            raise HTTPException(status_code=413, detail="Payload too large")
        body.extend(chunk)
    return bytes(body)


def _authenticate_hit_device_sync(device_token: str) -> HitDeviceContext | None:
    """Check the token once and return only the context needed for the hit insert."""
    if not device_token:
        return None
    with make_con() as con:
        row = con.execute(
            text(
                "SELECT id, company_id, upload_interval_s, "
                "sleep_after_min, power_save_mode "
                "FROM devices WHERE (device_token_hash = :token_hash "
                "OR device_token = :device_token) "
                "AND is_active = true"
            ),
            device_token_lookup_params(device_token),
        ).fetchone()
    if not row:
        return None
    return HitDeviceContext(
        id=row.id,
        company_id=row.company_id,
        upload_interval_s=row.upload_interval_s,
        sleep_after_min=row.sleep_after_min,
        power_save_mode=row.power_save_mode,
    )


def _decode_hits(body, version, now):
    """Validate binary records and convert them into DB-ready dicts.

    During the OTA rollout v3/v4 still carry two legacy floats, which are
    ignored. Only the old negative encoding of an uncounted diagnostic
    candidate is dropped, so old devices cannot deliver it as a production hit
    after the fact.
    """
    if version == 4:
        hit_size, hit_fmt = 36, "<IHffHffQI"
    elif version == 3:
        hit_size, hit_fmt = 24, "<IHffHff"
    elif len(body) % 16 == 0:
        hit_size, hit_fmt = 16, "<IHffH"
    else:
        hit_size, hit_fmt = 14, "<IffH"

    received = len(body) // hit_size
    records = []
    skipped = 0
    timestamp_repairs = []
    oldest = now - MAX_HIT_AGE
    newest = now + MAX_HIT_FUTURE_SKEW

    for values in struct.iter_unpack(hit_fmt, body[:received * hit_size]):
        boot_id = None
        event_sequence = None

        if version == 4:
            (epoch_s, epoch_ms, energy, gforce, duration_ms, _legacy_aux, legacy_marker,
             boot_id, event_sequence) = values
        elif version == 3:
            (epoch_s, epoch_ms, energy, gforce, duration_ms,
             _legacy_aux, legacy_marker) = values
        elif hit_size == 16:
            epoch_s, epoch_ms, energy, gforce, duration_ms = values
        else:
            epoch_s, energy, gforce, duration_ms = values
            epoch_ms = 0

        if (version >= 3 and math.isfinite(legacy_marker)
                and -3.001 <= legacy_marker <= -1.999):
            skipped += 1
            continue

        # Never persist corrupt sensor data or implausible identities.
        if (not math.isfinite(gforce) or not math.isfinite(energy)
                or gforce < 0 or energy < 0
                or gforce > 1000 or energy > 1e9
                or epoch_ms > 999
                or (version == 4 and (boot_id <= 0 or event_sequence <= 0))):
            skipped += 1
            continue

        raw_timestamp_ms = int(epoch_s) * 1000 + int(epoch_ms)
        try:
            timestamp = datetime.fromtimestamp(
                epoch_s + epoch_ms / 1000.0, tz=timezone.utc
            )
        except (OSError, OverflowError, ValueError):
            timestamp = None
        timestamp_needs_repair = (
            timestamp is None or timestamp < oldest or timestamp > newest
        )

        record = {
            "gforce": gforce,
            "energy": energy,
            "recorded_at": timestamp if not timestamp_needs_repair else now,
            "hit_duration_ms": duration_ms,
            "boot_id": boot_id,
            "event_sequence": event_sequence,
        }
        records.append(record)
        if timestamp_needs_repair:
            timestamp_repairs.append((record, raw_timestamp_ms))

    # A missing NTP/server time sync must not destroy real strokes. Keep the
    # affected part of the batch relative to each other and shift it so its
    # newest hit lands at the arrival time. Capping the shift at 24 h keeps a
    # corrupt epoch value from filling old partitions.
    if timestamp_repairs:
        anchor_ms = max(raw_ms for _, raw_ms in timestamp_repairs)
        for record, raw_ms in timestamp_repairs:
            delta_ms = max(0, min(anchor_ms - raw_ms, 24 * 60 * 60 * 1000))
            record["recorded_at"] = now - timedelta(milliseconds=delta_ms)

    return received, skipped, len(timestamp_repairs), records


def _insert_hits_sync(device: HitDeviceContext, body: bytes, version=2):
    with make_con() as con:
        now = datetime.now(timezone.utc)
        device_id_str = str(device.id)
        company_id_str = str(device.company_id)

        received, skipped, repaired_timestamps, records = _decode_hits(body, version, now)

        # v4: reserve the global identity. ON CONFLICT filters retries before
        # any statistic or live event sees the stroke a second time.
        valid_before_dedupe = len(records)
        if version == 4 and records:
            new_keys = con.execute(
                text(
                    "INSERT INTO device_hit_receipts "
                    "(device_id, boot_id, event_sequence, recorded_at) "
                    "SELECT CAST(:did AS UUID), x.boot_id, x.event_sequence, x.recorded_at "
                    "FROM unnest(CAST(:boot_ids AS BIGINT[]), "
                    "            CAST(:event_sequences AS BIGINT[]), "
                    "            CAST(:recorded_ats AS TIMESTAMP[])) "
                    "AS x(boot_id, event_sequence, recorded_at) "
                    "ON CONFLICT DO NOTHING RETURNING boot_id, event_sequence"
                ),
                {
                    "did": device_id_str,
                    "boot_ids": [r["boot_id"] for r in records],
                    "event_sequences": [r["event_sequence"] for r in records],
                    "recorded_ats": [r["recorded_at"] for r in records],
                },
            ).fetchall()
            allowed = {(r.boot_id, r.event_sequence) for r in new_keys}
            seen = set()
            deduped = []
            for record in records:
                key = (record["boot_id"], record["event_sequence"])
                if key in allowed and key not in seen:
                    deduped.append(record)
                    seen.add(key)
            records = deduped

        inserted_rows = []
        if records:
            inserted_rows = con.execute(
                text(
                    "INSERT INTO device_hits "
                    "(device_id, gforce, energy, recorded_at, hit_duration_ms, "
                    " boot_id, event_sequence) "
                    "SELECT CAST(:did AS UUID), x.gforce, x.energy, x.recorded_at, "
                    "       x.hit_duration_ms, x.boot_id, x.event_sequence "
                    "FROM unnest(CAST(:gforces AS DOUBLE PRECISION[]), "
                    "            CAST(:energies AS DOUBLE PRECISION[]), "
                    "            CAST(:recorded_ats AS TIMESTAMP[]), "
                    "            CAST(:durations AS INTEGER[]), "
                    "            CAST(:boot_ids AS BIGINT[]), "
                    "            CAST(:event_sequences AS BIGINT[])) "
                    "AS x(gforce, energy, recorded_at, hit_duration_ms, "
                    "     boot_id, event_sequence) "
                    "RETURNING id, gforce, energy, recorded_at, hit_duration_ms"
                ),
                {
                    "did": device_id_str,
                    "gforces": [r["gforce"] for r in records],
                    "energies": [r["energy"] for r in records],
                    "recorded_ats": [r["recorded_at"] for r in records],
                    "durations": [r["hit_duration_ms"] for r in records],
                    "boot_ids": [r["boot_id"] for r in records],
                    "event_sequences": [r["event_sequence"] for r in records],
                },
            ).fetchall()

        con.execute(
            text(
                "UPDATE devices SET last_seen_at = :now, "
                "hit_server_rejected_count = COALESCE(hit_server_rejected_count, 0) + :skipped "
                "WHERE id = :did"
            ),
            {"now": now, "skipped": skipped, "did": device_id_str},
        )
        con.commit()

    for hit in inserted_rows:
        recorded_at = hit.recorded_at
        if recorded_at.tzinfo is None:
            recorded_at = recorded_at.replace(tzinfo=timezone.utc)
        event_manager.broadcast(company_id_str, "hit", {
            "id": hit.id,
            "device_id": device_id_str,
            "gforce": hit.gforce,
            "energy": hit.energy,
            "hit_duration_ms": hit.hit_duration_ms,
            "recorded_at": recorded_at.isoformat(),
            "last_seen_at": now.isoformat(),
        })

    config = {
        "upload_interval_s": device.upload_interval_s or 0,
        "sleep_after_min": device.sleep_after_min if device.sleep_after_min is not None else 0,
        "power_save": bool(device.power_save_mode),
    }
    # TRANSITION(fw<14): remove once all sensors run firmware 14.
    add_legacy_hit_keys(config)
    return {
        "status": "ok",
        "count": len(inserted_rows),
        "received": received,
        "duplicates": valid_before_dedupe - len(inserted_rows),
        "skipped": skipped,
        "repaired_timestamps": repaired_timestamps,
        "config": config,
    }


async def _receive_hits(request: Request, device_token: str | None, version: int):
    """Shared flow: size header, auth, bounded body, insert."""
    started = time.perf_counter()
    if not device_token:
        raise HTTPException(status_code=401, detail="Device token missing")

    _reject_if_too_large(request, None, MAX_HITS_BYTES)
    device = await asyncio.to_thread(_authenticate_hit_device_sync, device_token)
    if device is None:
        # Important: with an invalid token the body is not read.
        raise HTTPException(status_code=401, detail="Invalid device token")

    body = await _read_limited_body(request, MAX_HITS_BYTES)
    if version == 4:
        valid_length = len(body) >= 36 and len(body) % 36 == 0
    elif version == 3:
        valid_length = len(body) >= 24 and len(body) % 24 == 0
    else:
        valid_length = len(body) >= 14 and (len(body) % 16 == 0 or len(body) % 14 == 0)
    if not valid_length:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid data length: {len(body)} bytes",
        )

    result = await asyncio.to_thread(_insert_hits_sync, device, body, version)
    processing_ms = round((time.perf_counter() - started) * 1000)
    result["server_processing_ms"] = processing_ms
    if processing_ms >= 500:
        logger.warning(
            "Slow hit ingest device=%s version=%s bytes=%s ms=%s",
            device.id, version, len(body), processing_ms,
        )
    return result


@router.post("/hits-bin")
async def receive_hits_binary(request: Request, x_device_token: str = Header(None)):
    """Receive hits as binary data (16 bytes/hit: uint32 epoch_s + uint16 epoch_ms + float32 energy + float32 gforce + uint16 duration_ms, little-endian). Falls back to 14 bytes (without epoch_ms) for older firmware."""
    return await _receive_hits(request, x_device_token, 2)


@router.post("/hits-bin3")
async def receive_hits_binary_v3(request: Request, x_device_token: str = Header(None)):
    """24-byte rollout format; the two legacy floats are ignored."""
    return await _receive_hits(request, x_device_token, 3)


@router.post("/hits-bin4")
async def receive_hits_binary_v4(request: Request, x_device_token: str = Header(None)):
    """Deduplicatable 36-byte format with boot ID and event sequence.

    Boot ID and event sequence together with device_id form the event ID.
    """
    return await _receive_hits(request, x_device_token, 4)


# TRANSITION(fw<14): remove once all sensors run firmware 14.
# Firmware 13.x still uploads detail recordings (learning mode) here and
# retries on every non-200, keeping the file in flash. The feature is gone:
# read the full body (otherwise the device's keep-alive connection breaks)
# and discard it.
MAX_DISCARD_BYTES = 16 * 1024 * 1024


@router.post("/learning-chunk-bin2")
async def discard_learning_chunk(request: Request, x_device_token: str = Header(None)):
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Device token missing")
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_DISCARD_BYTES:
            raise HTTPException(status_code=413, detail="Payload too large")
    return {"status": "ok", "samples_received": 0, "discarded": True}


class CommandResultPayload(BaseModel):
    command_id: str
    success: bool
    result: str | None = None  # optional result text (e.g. setup AP password)


@router.post("/command-result")
async def report_command_result(
    request: Request,
    payload: CommandResultPayload,
    x_device_token: str = Header(None),
):
    """Firmware reports the result of a command (fire-and-forget ack).
    Primary delivery is now via command_results in settings sync."""
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Device token missing")

    def _sync():
        with make_con() as con:
            device = con.execute(
                text(
                    "SELECT id, company_id FROM devices WHERE "
                    "(device_token_hash = :token_hash OR device_token = :device_token) "
                    "AND is_active = true"
                ),
                device_token_lookup_params(x_device_token),
            ).fetchone()

            if not device:
                return None

            status = "completed" if payload.success else "failed"
            result = con.execute(
                text(
                    "UPDATE device_commands SET status = :status, completed_at = NOW(), "
                    "progress = COALESCE(:result, progress) "
                    "WHERE id = :cid AND device_id = :did "
                    "RETURNING id, command"
                ),
                {"status": status, "result": payload.result,
                 "cid": payload.command_id, "did": str(device.id)},
            ).fetchone()
            con.commit()
            return device, result, status

    res = await asyncio.to_thread(_sync)
    if res is None:
        raise HTTPException(status_code=401, detail="Invalid device token")

    device, result, status = res
    if result:
        event_manager.broadcast(
            str(device.company_id),
            "command_status",
            {
                "device_id": str(device.id),
                "command_id": payload.command_id,
                "command": result.command,
                "status": status,
                "result": payload.result,
            },
        )
    return {"status": "ok"}
