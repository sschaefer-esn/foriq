import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from utils.ratelimit import limiter
from utils.observability import setup_logging
import auth
import users
import devices
import data
import ingest
import settings
import dashboard
import events
import export
import commands
import ota
import layouts
import api_keys
import external_api
import notifications
import maintenance
from frontend_static import install_frontend
from utils.app_only import AppOnlyGuard

logger = setup_logging()


def _log_ota_channels():
    # A missing build artifact must not first surface as "-> unknown" at the
    # customer. Ingest and UI stay available, but every startup logs the error
    # with the target and the expected build directory.
    for target, build_dir in ota.TARGET_BUILD_DIRS.items():
        version = ota._get_firmware_version(target)
        if version == "unknown":
            logger.error(
                "OTA channel cannot be served: target=%s build=%s",
                target,
                build_dir,
            )
        else:
            logger.info(
                "OTA channel ready: target=%s build=%s version=%s",
                target,
                build_dir,
                version,
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    _log_ota_channels()
    # FORIQ_NO_WORKERS=1: a development backend that shares the database of a
    # running Foriq app must not run a second set of background workers.
    if os.getenv("FORIQ_NO_WORKERS") == "1":
        logger.warning("Background workers disabled (FORIQ_NO_WORKERS=1)")
        yield
        return
    # Process-wide OTA reaper: cleans up orphaned update commands even when the
    # affected device never syncs again (bricked, battery, Wi-Fi).
    app.state.ota_reaper = asyncio.create_task(settings.ota_reaper_loop())
    app.state.notification_worker = asyncio.create_task(
        notifications.notification_worker_loop()
    )
    app.state.retention_worker = asyncio.create_task(maintenance.retention_loop())
    try:
        yield
    finally:
        app.state.ota_reaper.cancel()
        app.state.notification_worker.cancel()
        app.state.retention_worker.cancel()


app = FastAPI(title="Foriq API", version="0.1.0", lifespan=lifespan)

# Rate limiting (slowapi): register the limiter and the 429 handler.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# No CORS: UI and API share one origin (development: rewrite in
# next.config.mjs).

# /api/v1/devices/app* only from 127.0.0.1 (Foriq app), see utils/app_only.py.
app.add_middleware(AppOnlyGuard)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(devices.router)
app.include_router(data.router)
app.include_router(ingest.router)
app.include_router(settings.router)
app.include_router(dashboard.router)
app.include_router(events.router)
app.include_router(export.router)
app.include_router(commands.router)
app.include_router(ota.router)
app.include_router(layouts.router)
app.include_router(api_keys.router)
app.include_router(external_api.router)
app.include_router(notifications.router)


@app.get("/health")
async def health():
    """Liveness + DB connectivity (health check used by the Foriq app supervisor)."""
    from sqlalchemy import text as _text
    from utils.db import make_con
    try:
        with make_con() as con:
            con.execute(_text("SELECT 1"))
        db_ok = True
    except Exception:
        logger.exception("Health check: DB unreachable")
        db_ok = False
    status = "ok" if db_ok else "degraded"
    return JSONResponse(
        status_code=200 if db_ok else 503,
        content={"status": status, "db": db_ok},
    )


# Static frontend export as the router fallback - only applies when no API
# route matches (FORIQ_FRONTEND_DIR, otherwise API only).
install_frontend(app)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8005, reload=True, proxy_headers=False)
