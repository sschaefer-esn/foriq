import csv
import html
import io
import json
import re
import zipfile
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from tempfile import SpooledTemporaryFile
from starlette.background import BackgroundTask

from utils.db import make_con
from utils.default_language import DEFAULT_LANG
from utils.dependencies import require_role
from utils.tz_utils import get_company_tz

router = APIRouter(prefix="/api/v1/export", tags=["export"])

# Hard caps keep a single export from exhausting the worker.
# XLSX is more CPU-intensive despite write-only mode and therefore capped lower.
MAX_EXPORT_ROWS = 200_000
MAX_XLSX_ROWS = 100_000
MAX_EXPORT_DEVICES = 100
EXPORT_FETCH_BATCH_SIZE = 2_000
SPOOL_MEMORY_LIMIT = 8 * 1024 * 1024

# Supported formats: id -> (file extension, MIME type)
FORMATS = {
    "xlsx": (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "csv": (".csv", "text/csv; charset=utf-8"),
    "html": (".html", "text/html; charset=utf-8"),
    "txt": (".txt", "text/plain; charset=utf-8"),
    "json": (".json", "application/json"),
    "md": (".md", "text/markdown; charset=utf-8"),
}

# Human-readable labels in the exported files, selected by the optional `lang`
# query parameter (default DEFAULT_LANG). Record keys and JSON output are not localised.
_LABELS = {
    "en": {
        "html_lang": "en",
        "device": "Device",
        "serial_number": "Serial number",
        "date": "Date",
        "time": "Time",
        "gforce": "G-Force",
        "timestamp": "Timestamp",
        "report": "Report",
        "records": "records",
        "no_records": "No records",
        "generated": "Generated with Foriq",
    },
    "de": {
        "html_lang": "de",
        "device": "Gerät",
        "serial_number": "Seriennummer",
        "date": "Datum",
        "time": "Uhrzeit",
        "gforce": "G-Force",
        "timestamp": "Zeitstempel",
        "report": "Auswertung",
        "records": "Datensätze",
        "no_records": "Keine Datensätze",
        "generated": "Erzeugt mit Foriq",
    },
}

_SINGLE_KEYS = ["device", "serial_number", "date", "time", "gforce", "timestamp"]
_DEVICE_KEYS = ["date", "time", "gforce", "timestamp"]


def _columns(keys, lang=DEFAULT_LANG):
    """Column definitions: (record key, display label)."""
    return [(key, _LABELS[lang][key]) for key in keys]


_SINGLE_COLS = _columns(_SINGLE_KEYS)
_DEVICE_COLS = _columns(_DEVICE_KEYS)


@router.get("")
def export_data(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
    device_ids: str = Query(..., description="Comma-separated device IDs"),
    mode: str = Query("single", description="'single' = combined, 'multi' = one sheet/file per device"),
    format: str = Query("xlsx", description="xlsx | csv | html | txt | json | md"),
    lang: str = Query(DEFAULT_LANG, description="Language of labels in the file: en | de"),
    user=Depends(require_role("owner", "admin", "viewer")),
):
    company_id = user["company_id"]
    lang = lang if lang in _LABELS else DEFAULT_LANG
    labels = _LABELS[lang]

    fmt = (format or "xlsx").lower()
    if fmt not in FORMATS:
        raise HTTPException(status_code=400, detail=f"Unknown format: {format}")
    if mode not in {"single", "multi"}:
        raise HTTPException(status_code=400, detail="Mode must be 'single' or 'multi'")

    try:
        start_date = datetime.strptime(start, "%Y-%m-%d").date()
        end_date = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format (YYYY-MM-DD)")

    if end_date < start_date:
        raise HTTPException(status_code=400, detail="End date must be after start date")

    if (end_date - start_date).days > 366:
        raise HTTPException(status_code=400, detail="At most 1 year can be exported")

    ids = list(dict.fromkeys(d.strip() for d in device_ids.split(",") if d.strip()))
    if not ids:
        raise HTTPException(status_code=400, detail="Select at least one device")
    if len(ids) > MAX_EXPORT_DEVICES:
        raise HTTPException(
            status_code=400,
            detail=f"At most {MAX_EXPORT_DEVICES} devices can be selected per export",
        )

    with make_con() as con:
        tz = get_company_tz(con, company_id)

        # Load devices + verify ownership
        placeholders = ", ".join(f":id{i}" for i in range(len(ids)))
        params = {f"id{i}": did for i, did in enumerate(ids)}
        params["cid"] = company_id

        devices = con.execute(
            text(
                f"SELECT id, name, serial_number FROM devices "
                f"WHERE id IN ({placeholders}) AND company_id = :cid "
                f"ORDER BY name"
            ),
            params,
        ).fetchall()

        if not devices:
            raise HTTPException(status_code=404, detail="No devices found")

        # Volume cap: check the total number of hits in the range before
        # loading anything into memory.
        dev_placeholders = ", ".join(f":d{i}" for i in range(len(devices)))
        count_params = {f"d{i}": str(d.id) for i, d in enumerate(devices)}
        count_params.update({"start": str(start_date), "end": str(end_date), "tz": tz})
        total_rows = con.execute(
            text(
                f"SELECT COUNT(*) FROM device_hits "
                f"WHERE device_id IN ({dev_placeholders}) "
                "AND counted IS TRUE "
                f"AND recorded_at >= (CAST(:start AS date) AT TIME ZONE :tz) "
                f"AND recorded_at < ((CAST(:end AS date) + 1) AT TIME ZONE :tz)"
            ),
            count_params,
        ).scalar()
        row_limit = MAX_XLSX_ROWS if fmt == "xlsx" else MAX_EXPORT_ROWS
        if total_rows and total_rows > row_limit:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Too many records ({total_rows:,}) for {fmt.upper()}. "
                    f"At most {row_limit:,} per export - please shorten the time range "
                    "or select fewer devices."
                ),
            )

        # One canonical query for all formats. fetchmany bounds the transient
        # DB/driver memory and avoids N+1 queries.
        hits_by_device = {
            str(device.id): {
                "name": device.name,
                "serial": device.serial_number,
                "rows": [],
            }
            for device in devices
        }
        hit_query = text(
            f"SELECT device_id, "
            "(recorded_at AT TIME ZONE 'UTC' AT TIME ZONE :tz)::date AS local_date, "
            "(recorded_at AT TIME ZONE 'UTC' AT TIME ZONE :tz)::time AS local_time, "
            "gforce, recorded_at FROM device_hits "
            f"WHERE device_id IN ({dev_placeholders}) "
            "AND counted IS TRUE "
            "AND recorded_at >= (CAST(:start AS date) AT TIME ZONE :tz) "
            "AND recorded_at < ((CAST(:end AS date) + 1) AT TIME ZONE :tz) "
            "ORDER BY device_id, recorded_at"
        ).execution_options(
            stream_results=True,
            max_row_buffer=EXPORT_FETCH_BATCH_SIZE,
        )
        hit_result = con.execute(
            hit_query,
            count_params,
        )
        while True:
            batch = hit_result.fetchmany(EXPORT_FETCH_BATCH_SIZE)
            if not batch:
                break
            for hit in batch:
                hits_by_device[str(hit.device_id)]["rows"].append(hit)

    title = f"{labels['report']} {start} – {end}"

    # Excel: separate path (openpyxl, single = one sheet, multi = one sheet per device)
    if fmt == "xlsx":
        buffer = _build_xlsx(hits_by_device, mode, lang)
        filename = f"Foriq_Export_{start}_{end}.xlsx"
        return _stream(buffer, FORMATS["xlsx"][1], filename)

    ext, media = FORMATS[fmt]

    # Text-based formats. multi -> ZIP with one file per device.
    if mode == "multi":
        zbuf = _spooled_buffer()
        with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as zf:
            used = set()
            for info in hits_by_device.values():
                records = _device_records(info)
                content = _render(
                    fmt, _columns(_DEVICE_KEYS, lang), records,
                    f"{info['name']} · {start} – {end}", labels,
                )
                fname = _unique_filename(info["name"], ext, used)
                zf.writestr(fname, content.encode("utf-8"))
        zbuf.seek(0)
        return _stream(zbuf, "application/zip", f"Foriq_Export_{start}_{end}.zip")

    records = _single_records(hits_by_device)
    content = _render(fmt, _columns(_SINGLE_KEYS, lang), records, title, labels)
    buffer = _spooled_buffer()
    buffer.write(content.encode("utf-8"))
    buffer.seek(0)
    return _stream(buffer, media, f"Foriq_Export_{start}_{end}{ext}")


def _stream(buffer, media_type, filename):
    return StreamingResponse(
        _iter_buffer_chunks(buffer),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        background=BackgroundTask(buffer.close),
    )


def _iter_buffer_chunks(buffer, chunk_size=64 * 1024):
    while chunk := buffer.read(chunk_size):
        yield chunk


def _spooled_buffer():
    """Stays in RAM for small exports and spills to /tmp for large ones."""
    return SpooledTemporaryFile(max_size=SPOOL_MEMORY_LIMIT, mode="w+b")


# ─── Record preparation ──────────────────────────────────────────────────

def _iter_single_records(hits_by_device):
    for info in hits_by_device.values():
        for hit in info["rows"]:
            yield {
                "device": info["name"],
                "serial_number": info["serial"],
                "date": str(hit.local_date),
                "time": str(hit.local_time),
                "gforce": round(hit.gforce, 2),
                "timestamp": str(hit.recorded_at),
            }


def _single_records(hits_by_device):
    return list(_iter_single_records(hits_by_device))


def _iter_device_records(info):
    for hit in info["rows"]:
        yield {
            "date": str(hit.local_date),
            "time": str(hit.local_time),
            "gforce": round(hit.gforce, 2),
            "timestamp": str(hit.recorded_at),
        }


def _device_records(info):
    return list(_iter_device_records(info))


def _cell(v):
    """Uniform string representation; floats with 2 decimal places."""
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


_FORMULA_PREFIX = re.compile(r"^\s*[=+\-@]")


def _spreadsheet_cell(value):
    """Neutralise formulas in customer-controllable CSV/XLSX cells."""
    if not isinstance(value, str):
        return value
    if value.startswith(("\t", "\r", "\n")) or _FORMULA_PREFIX.match(value):
        return "'" + value
    return value


def _unique_filename(name, ext, used):
    base = re.sub(r"[^\w\-]+", "_", name, flags=re.UNICODE).strip("_") or "device"
    candidate = base + ext
    i = 2
    while candidate in used:
        candidate = f"{base}_{i}{ext}"
        i += 1
    used.add(candidate)
    return candidate


# ─── Format renderers ─────────────────────────────────────────────────────────

def _render(fmt, cols, records, title, labels=_LABELS[DEFAULT_LANG]):
    if fmt == "csv":
        return _to_csv(cols, records)
    if fmt == "html":
        return _to_html(cols, records, title, labels)
    if fmt == "txt":
        return _to_txt(cols, records, title, labels)
    if fmt == "json":
        return _to_json(records)
    if fmt == "md":
        return _to_md(cols, records, title, labels)
    raise HTTPException(status_code=400, detail=f"Unknown format: {fmt}")


def _to_csv(cols, records):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow([label for _, label in cols])
    for rec in records:
        w.writerow([_cell(_spreadsheet_cell(rec[key])) for key, _ in cols])
    # BOM so that Excel detects UTF-8 (non-ASCII characters) correctly
    return "﻿" + buf.getvalue()


def _to_json(records):
    return json.dumps(records, ensure_ascii=False, indent=2)


def _to_md(cols, records, title, labels=_LABELS[DEFAULT_LANG]):
    header = [label for _, label in cols]
    lines = [
        f"# Foriq · {title}",
        "",
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    for rec in records:
        lines.append("| " + " | ".join(_cell(rec[key]) for key, _ in cols) + " |")
    lines.append("")
    lines.append(f"_{len(records)} {labels['records']}_")
    lines.append("")
    return "\n".join(lines)


def _to_txt(cols, records, title, labels=_LABELS[DEFAULT_LANG]):
    header = [label for _, label in cols]
    rows = [[_cell(rec[key]) for key, _ in cols] for rec in records]
    widths = [len(h) for h in header]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(c))

    def line(cells):
        return "| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(cells)) + " |"

    sep = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    out = [f"Foriq · {title}", ""]
    out.append(sep)
    out.append(line(header))
    out.append(sep)
    for r in rows:
        out.append(line(r))
    out.append(sep)
    out.append(f"{len(rows)} {labels['records']}")
    out.append("")
    return "\n".join(out)


def _to_html(cols, records, title, labels=_LABELS[DEFAULT_LANG]):
    head_cells = "".join(f"<th>{html.escape(label)}</th>" for _, label in cols)
    body_rows = []
    for rec in records:
        tds = "".join(f"<td>{html.escape(_cell(rec[key]))}</td>" for key, _ in cols)
        body_rows.append(f"      <tr>{tds}</tr>")
    body = "\n".join(body_rows) if body_rows else (
        f'      <tr><td colspan="{len(cols)}" class="empty">{html.escape(labels["no_records"])}</td></tr>'
    )
    safe_title = html.escape(title)
    return f"""<!DOCTYPE html>
<html lang="{labels['html_lang']}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foriq · {safe_title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 2.5rem 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f6f6f7; color: #18181b;
  }}
  .wrap {{ max-width: 1000px; margin: 0 auto; }}
  header {{ margin-bottom: 1.5rem; }}
  .brand {{ font-weight: 700; letter-spacing: -0.02em; color: #b01e28; font-size: 0.8rem; text-transform: uppercase; }}
  h1 {{ margin: 0.25rem 0 0.25rem; font-size: 1.4rem; font-weight: 650; letter-spacing: -0.02em; }}
  .meta {{ color: #6b7280; font-size: 0.85rem; }}
  .card {{ background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }}
  .scroll {{ overflow-x: auto; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 0.875rem; }}
  thead th {{
    position: sticky; top: 0; background: #b01e28; color: #fff; text-align: left;
    padding: 0.7rem 1rem; font-weight: 600; white-space: nowrap;
  }}
  tbody td {{ padding: 0.55rem 1rem; border-top: 1px solid #f0f0f1; white-space: nowrap; }}
  tbody tr:nth-child(even) {{ background: #fbf3f4; }}
  tbody tr:hover {{ background: #f6e7e9; }}
  td.empty {{ text-align: center; color: #9ca3af; padding: 2rem; }}
  footer {{ margin-top: 1rem; color: #9ca3af; font-size: 0.8rem; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #0b0b0c; color: #e5e5e7; }}
    .meta {{ color: #9ca3af; }}
    .card {{ background: #161617; border-color: #262628; box-shadow: none; }}
    tbody td {{ border-top-color: #232325; }}
    tbody tr:nth-child(even) {{ background: #1b1516; }}
    tbody tr:hover {{ background: #241618; }}
  }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">Foriq</div>
      <h1>{safe_title}</h1>
      <div class="meta">{len(records)} {html.escape(labels['records'])}</div>
    </header>
    <div class="card scroll">
      <table>
        <thead><tr>{head_cells}</tr></thead>
        <tbody>
{body}
        </tbody>
      </table>
    </div>
    <footer>{html.escape(labels['generated'])}</footer>
  </div>
</body>
</html>
"""


# ─── Excel (openpyxl) ────────────────────────────────────────────────────────

def _build_xlsx(hits_by_device, mode, lang=DEFAULT_LANG):
    # Write-only mode does not keep all cells in RAM. The records come from the
    # same canonical record generators as all text formats.
    wb = Workbook(write_only=True)

    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_alignment = Alignment(horizontal="center", vertical="center")
    thin_border = Border(
        left=Side(style="thin", color="D9D9D9"),
        right=Side(style="thin", color="D9D9D9"),
        top=Side(style="thin", color="D9D9D9"),
        bottom=Side(style="thin", color="D9D9D9"),
    )
    alt_fill = PatternFill(start_color="F2F7FB", end_color="F2F7FB", fill_type="solid")

    if mode == "multi":
        # One sheet per device
        used = set()
        for info in hits_by_device.values():
            sheet_name = _unique_sheet_name(info["name"], used, _LABELS[lang]["device"])
            ws = wb.create_sheet(title=sheet_name)
            _write_xlsx_sheet(
                ws,
                _columns(_DEVICE_KEYS, lang),
                _iter_device_records(info),
                [12, 10, 10, 22],
                header_font,
                header_fill,
                header_alignment,
                thin_border,
                alt_fill,
            )
    else:
        # One shared sheet
        ws = wb.create_sheet(title="Export")
        _write_xlsx_sheet(
            ws,
            _columns(_SINGLE_KEYS, lang),
            _iter_single_records(hits_by_device),
            [20, 18, 12, 10, 10, 22],
            header_font,
            header_fill,
            header_alignment,
            thin_border,
            alt_fill,
        )

    buffer = _spooled_buffer()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


def _unique_sheet_name(name, used, fallback="Device"):
    base = re.sub(r"[\x00-\x1f\\/*?:\[\]]", "_", name or fallback).strip()[:31] or fallback
    candidate = base
    i = 2
    while candidate in used:
        suffix = f" ({i})"
        candidate = base[: 31 - len(suffix)] + suffix
        i += 1
    used.add(candidate)
    return candidate


def _write_xlsx_sheet(
    ws,
    cols,
    records,
    widths,
    header_font,
    header_fill,
    header_alignment,
    thin_border,
    alt_fill,
):
    """Write canonical records into a worksheet with low memory use."""
    for index, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(index)].width = width

    header_cells = []
    for _, label in cols:
        cell = WriteOnlyCell(ws, value=label)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border
        header_cells.append(cell)
    ws.append(header_cells)

    row_count = 0
    for row_number, record in enumerate(records, 2):
        cells = []
        for key, _ in cols:
            value = _spreadsheet_cell(record[key])
            cell = WriteOnlyCell(ws, value=value)
            cell.border = thin_border
            if isinstance(value, float):
                cell.number_format = "0.00"
            if row_number % 2 == 0:
                cell.fill = alt_fill
            cells.append(cell)
        ws.append(cells)
        row_count += 1

    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{max(row_count + 1, 1)}"
