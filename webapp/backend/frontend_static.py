"""Static frontend export (webapp/frontend/out) served from the same origin as the API.

Only applies when NO API route matches (router fallback instead of a mount): API
routes and 405 responses stay unchanged, unknown /api/... paths still answer
with a JSON 404.

Path resolution (Next.js export with trailingSlash: false):
  1. exact file               /_next/static/…, /foriq-icon.svg, /devices.txt
  2. <path>.html              /devices -> devices.html (deep link, reload)
  3. <path>/index.html        / -> index.html
  4. otherwise 404.html with status 404
Caching: /_next/static/* is content-addressed -> one year, immutable; everything
else (HTML, RSC .txt, icons) no-cache so an update takes effect immediately.

FORIQ_FRONTEND_DIR empty or missing -> API only (development with `next dev`).
"""
import logging
import os
from pathlib import Path
from urllib.parse import quote

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("foriq.frontend")

IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"

# Renamed pages (phase 4): redirect old bookmarks.
RENAMED_PAGES = {"/daten": "/data", "/hallenlayout": "/floor-plan"}

# Conventional icon URLs that browsers request without a <link> (iOS Safari):
# served from the existing export file instead of answering 404.
ICON_ALIASES = {"/apple-touch-icon-precomposed.png": "/apple-touch-icon.png"}


def is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/") or path.startswith("/health")


class FrontendFallback:
    """ASGI fallback of the router: serves the export from `root`."""

    def __init__(self, root: Path, not_found: ASGIApp):
        self.root = root.resolve()
        self.not_found = not_found

    def _resolve(self, path: str) -> Path | None:
        rel = path.lstrip("/")
        parts = rel.split("/") if rel else []
        if any(p in ("..", ".") or "\x00" in p or "\\" in p for p in parts):
            return None
        base = self.root.joinpath(*parts) if parts else self.root
        candidates = [base] if parts else []
        if parts and not rel.endswith("/"):
            candidates.append(base.with_name(base.name + ".html"))
        candidates.append(base / "index.html")
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if resolved.is_file() and resolved.is_relative_to(self.root):
                return resolved
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or is_api_path(path):
            await self.not_found(scope, receive, send)
            return
        if scope["method"] not in ("GET", "HEAD"):
            raise HTTPException(status_code=405)

        renamed = RENAMED_PAGES.get(path.rstrip("/"))
        if renamed:
            query = scope.get("query_string", b"").decode("latin-1")
            target = renamed + (f"?{query}" if query else "")
            await RedirectResponse(target, status_code=308)(scope, receive, send)
            return

        # /settings/ -> /settings (export without trailing slash)
        if path != "/" and path.endswith("/") and self._resolve(path.rstrip("/")):
            query = scope.get("query_string", b"").decode("latin-1")
            # A single leading slash: "//host" would be a protocol-relative redirect to a foreign host.
            target = quote("/" + path.strip("/")) + (f"?{query}" if query else "")
            await RedirectResponse(target, status_code=308)(scope, receive, send)
            return

        file = self._resolve(ICON_ALIASES.get(path, path))
        status = 200
        if file is None:
            status = 404
            file = self.root / "404.html"
            if not file.is_file():
                await PlainTextResponse("Not Found", status_code=404)(scope, receive, send)
                return

        cache = IMMUTABLE if path.startswith("/_next/static/") and status == 200 else NO_CACHE
        response = FileResponse(file, status_code=status, headers={"Cache-Control": cache})
        await response(scope, receive, send)


def install_frontend(app) -> bool:
    """Register the export as the router fallback. Must run after all API routers
    (it only applies when no route matches anyway). Returns True if the export is active."""
    raw = os.getenv("FORIQ_FRONTEND_DIR", "").strip()
    if not raw:
        logger.info("FORIQ_FRONTEND_DIR not set - API only (development)")
        return False
    root = Path(raw)
    if not (root / "index.html").is_file():
        logger.error("Frontend export missing: %s (index.html not found) - API only", root)
        return False
    app.router.default = FrontendFallback(root, app.router.not_found)
    logger.info("Frontend export active: %s", root)
    return True
