import json
import os
import re
import hashlib
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse

from utils.device_token import device_token_lookup_params
from pydantic import BaseModel
from sqlalchemy import text

from utils.db import make_con
from utils.dependencies import require_role
from events import event_manager

router = APIRouter(prefix="/api/v1/ota", tags=["ota"])

# FORIQ_FIRMWARE_DIR: firmware bundled with the Foriq app (same layout as
# firmware-cpp/, i.e. <dir>/release/<build>/firmware.bin). Otherwise the repo.
FIRMWARE_CPP_DIR = os.getenv("FORIQ_FIRMWARE_DIR") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "firmware-cpp")
)

# Build target -> PlatformIO build directory. Only the M5Stick S3 is supported;
# devices of retired hardware keep their stored target but are never offered
# an image.
TARGET_BUILD_DIRS = {
    "m5sticks3": "m5sticks3",
}
DEFAULT_TARGET = "m5sticks3"


def _resolve_target(target, required=False):
    """Validate the build target and return the PlatformIO build folder.

    Device endpoints pass required=True: firmware without a target parameter
    predates the S3 and must never receive an S3 image.
    """
    if not target:
        if required:
            raise HTTPException(status_code=400, detail="Firmware target missing")
        return DEFAULT_TARGET
    if target not in TARGET_BUILD_DIRS:
        raise HTTPException(status_code=400, detail=f"Unknown firmware target: {target}")
    return target


def safe_target(target):
    """Validate stored/sent device targets without raising HTTPException.

    A missing or unknown target (e.g. retired hardware) must never fall back to
    a served image: binaries of different chips are incompatible. None
    therefore tells the caller "no safe OTA possible".
    """
    return target if target in TARGET_BUILD_DIRS else None


def _target_bin_dirs(target):
    """Candidate directories for a target's firmware.bin, in search order."""
    build = TARGET_BUILD_DIRS[target]
    return [
        os.path.join(FIRMWARE_CPP_DIR, ".pio", "build", build),
        os.path.join(FIRMWARE_CPP_DIR, "release", build),
    ]


def _extract_version_from_bytes(data):
    """Version number from the compiled binary. Prefers the explicit marker
    (FW >= 13.3); for older binaries (9.x-13.2.x) the old regex, which relies on
    the JSON key and the version literal happening to be adjacent."""
    match = re.search(rb"FORIQ_FW_VERSION=(\d+\.\d+\.\d+)", data)
    if not match:
        match = re.search(rb"firmware_version\x00(\d+\.\d+\.\d+)", data)
    return match.group(1).decode("ascii") if match else None


def firmware_version_at_least(installed, target):
    """True if both values are SemVer and installed >= target.

    If the server artifact is replaced during a rollout, a device may report a
    higher version than the one in the already queued command. That is a
    successful update, not a zombie command.
    """
    pattern = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
    installed_match = pattern.fullmatch(installed or "")
    target_match = pattern.fullmatch(target or "")
    if not installed_match or not target_match:
        return False
    return tuple(map(int, installed_match.groups())) >= tuple(
        map(int, target_match.groups())
    )


def ota_target_reached(installed, previously_reported, command_target):
    """Decide terminal OTA success without falsely confirming a rollback."""
    if installed == command_target:
        return True
    version_changed = bool(installed and installed != previously_reported)
    return version_changed and (
        command_target is None
        or firmware_version_at_least(installed, command_target)
    )


# Metadata per target, invalidated by (mtime, size). Otherwise version + SHA256
# would be recomputed over the full ~1.1 MB file on EVERY settings sync or
# /check - with fast sync every second per device, the most expensive path.
_fw_cache = {}


def _fw_meta(target):
    """Path, size, version and SHA256 of a target's firmware.bin.
    Returns None if no servable binary exists."""
    for bin_dir in _target_bin_dirs(target):
        path = os.path.join(bin_dir, "firmware.bin")
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = (st.st_mtime_ns, st.st_size)
        cached = _fw_cache.get(target)
        if cached and cached[0] == key:
            return cached[1]
        with open(path, "rb") as f:
            content = f.read()
        meta = {
            "path": path,
            "size": st.st_size,
            "version": _extract_version_from_bytes(content),
            "checksum": hashlib.sha256(content).hexdigest(),
        }
        _fw_cache[target] = (key, meta)
        return meta
    return None


def _get_firmware_version(target=DEFAULT_TARGET):
    """Firmware version for a build target - taken from the binary only.

    Deliberately NO fallback to the VERSION file: it can differ from the version
    in the served binary. The device would flash, then report a different
    version than announced, and the cycle starts over - a flash/reboot loop.
    Better to offer no OTA than a wrong one.
    """
    meta = _fw_meta(target)
    return meta["version"] if meta and meta["version"] else "unknown"


def _list_firmware_files(target=DEFAULT_TARGET):
    """List the firmware.bin of the given build target including SHA256."""
    meta = _fw_meta(target)
    if not meta or not meta["version"]:
        return []
    return [{
        "filename": "firmware.bin",
        "checksum": meta["checksum"],
        "size": meta["size"],
    }]


def _verify_device(x_device_token: str):
    """Verify the device token."""
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Device token missing")

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
        raise HTTPException(status_code=401, detail="Invalid device token")
    return device


# --- Dashboard endpoints (JWT auth) ---

@router.get("/version")
async def get_version(
    target: str | None = Query(None),
    user=Depends(require_role("owner", "admin", "viewer")),
):
    """Current server firmware version for a build target.

    `targets` additionally returns all build targets at once - the fleet view
    needs them without one request per target. A device of retired hardware
    asks with its stored target and gets "unknown" (no release) instead of an
    error.
    """
    targets = {t: _get_firmware_version(t) for t in TARGET_BUILD_DIRS}
    if target and not safe_target(target):
        return {"target": target, "version": "unknown", "files": [], "targets": targets}
    resolved = _resolve_target(target)
    return {
        "target": resolved,
        "version": _get_firmware_version(resolved),
        "files": _list_firmware_files(resolved),
        "targets": targets,
    }


# --- Device endpoints (device token auth) ---

@router.get("/check")
async def check_update(
    request: Request,
    target: str | None = Query(None),
    x_device_token: str = Header(None),
):
    """Version + file list with checksums (for the firmware update check).

    The firmware sends its build target as a query param; requests without
    it or with an unsupported target get 400 and no image.
    """
    _verify_device(x_device_token)
    resolved = _resolve_target(target, required=True)
    return {
        "target": resolved,
        "version": _get_firmware_version(resolved),
        "files": _list_firmware_files(resolved),
    }


@router.get("/files/{filename}")
async def download_file(
    request: Request,
    filename: str,
    target: str | None = Query(None),
    x_device_token: str = Header(None),
):
    """Download a single firmware file. The .bin is served per target -
    binaries of different chips are incompatible."""
    _verify_device(x_device_token)
    resolved = _resolve_target(target, required=True)

    # firmware-cpp/ build artifact, target-specific. FileResponse instead of
    # Response(content=...): otherwise the ~1.1 MB would pass entirely through
    # the backend's RAM on every download.
    meta = _fw_meta(resolved)
    if meta and filename == "firmware.bin" and os.path.isfile(meta["path"]):
        return FileResponse(
            meta["path"],
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Checksum-SHA256": meta["checksum"],
                "ETag": f'"{meta["checksum"]}"',
            },
        )

    raise HTTPException(status_code=404, detail="File not found")


class ProgressPayload(BaseModel):
    command_id: str
    progress: str
    # Optional from FW 13.3. Pre-13.3 devices send only the first two fields.
    percent: int | None = None
    detail: str | None = None   # failure cause (Update.errorString(), HTTP code, heap)


@router.post("/progress")
async def report_progress(
    request: Request,
    payload: ProgressPayload,
    x_device_token: str = Header(None),
):
    """Firmware reports OTA progress (downloading/installing/restarting/already_current)."""
    device = _verify_device(x_device_token)
    valid = ("downloading", "installing", "restarting", "already_current", "failed", "completed")
    if payload.progress not in valid:
        raise HTTPException(status_code=400, detail="Invalid progress value")

    if payload.progress in ("already_current", "completed"):
        cmd_status = "completed"
    elif payload.progress == "failed":
        cmd_status = "failed"
    else:
        cmd_status = "in_progress"

    terminal = cmd_status in ("completed", "failed")
    extra = {}
    if payload.percent is not None:
        extra["percent"] = payload.percent
    if payload.detail:
        extra["error" if cmd_status == "failed" else "detail"] = payload.detail[:500]

    with make_con() as con:
        result = con.execute(
            text(
                # completed_at MUST be set for terminal reports - the retry
                # backoff in settings.py measures against it. Without the
                # timestamp every reported failure was re-queued immediately.
                # The status guard makes aborts sticky: a late report must not
                # revive a row that is already terminal (cancelled/timeout/superseded).
                "UPDATE device_commands SET status = :status, progress = :progress, "
                "last_progress_at = NOW(), "
                "completed_at = CASE WHEN :terminal THEN NOW() ELSE completed_at END, "
                "payload = COALESCE(payload, '{}'::jsonb) || CAST(:extra AS JSONB) "
                "WHERE id = :cid AND device_id = :did AND command = 'ota_update' "
                "AND status IN ('pending', 'delivered', 'in_progress') "
                "RETURNING id"
            ),
            {
                "status": cmd_status,
                "progress": payload.progress,
                "terminal": terminal,
                "extra": json.dumps(extra),
                "cid": payload.command_id,
                "did": str(device.id),
            },
        ).fetchone()

        if not result:
            # The row exists but is already terminal -> not an error but an abort
            # signal. Old firmware ignores the body; FW >= 13.3 then aborts the
            # running download.
            existing = con.execute(
                text("SELECT status, progress FROM device_commands "
                     "WHERE id = :cid AND device_id = :did AND command = 'ota_update'"),
                {"cid": payload.command_id, "did": str(device.id)},
            ).fetchone()
            con.commit()
            if existing:
                return {
                    "status": "stale",
                    "abort": True,
                    "command_status": existing.status,
                    "command_progress": existing.progress,
                }
            raise HTTPException(status_code=404, detail="Command not found")

        con.commit()

    event_manager.broadcast(
        str(device.company_id),
        "command_status",
        {
            "device_id": str(device.id),
            "command_id": payload.command_id,
            "command": "ota_update",
            "status": cmd_status,
            "progress": payload.progress,
            "percent": payload.percent,
            "error": extra.get("error"),
        },
    )
    return {"status": "ok"}
