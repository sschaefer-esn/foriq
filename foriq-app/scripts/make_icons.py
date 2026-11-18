#!/usr/bin/env python3
"""Generates the app icons from the logo geometry (webapp/frontend/public/foriq-icon.svg).

  npm run icons   (or python3 scripts/make_icons.py; needs Pillow)

Output in assets/:
  icon.icns              app icon (Finder, Dock, About dialog)
  trayTemplate.png/@2x   menu bar icon (template: macOS tints it light/dark)
The rectangles are copied from the SVG (viewBox 0 0 100 100) so no SVG renderer
is needed. If the logo changes, update them here and regenerate.
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

# (x, y, w, h, rx) from foriq-icon.svg
RECTS = [
    (16, 12, 52, 12, 6),
    (16, 12, 12, 76, 6),
    (16, 44, 40, 12, 6),
    (58, 52, 12, 36, 6),
    (71, 26, 12, 62, 6),
    (84, 40, 12, 48, 6),
]
RED = (204, 0, 0, 255)
SS = 4  # supersampling against jagged edges

ASSETS = Path(__file__).resolve().parent.parent / "assets"


def draw_glyph(draw, ox, oy, scale, color):
    for x, y, w, h, rx in RECTS:
        draw.rounded_rectangle(
            (ox + x * scale, oy + y * scale, ox + (x + w) * scale, oy + (y + h) * scale),
            radius=rx * scale,
            fill=color,
        )


def app_icon(size):
    # macOS grid: 1024 canvas, 824 px tile with ~185 px corner radius, 100 px margin.
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tile = 824 / 1024 * big
    off = (big - tile) / 2
    d.rounded_rectangle((off, off, off + tile, off + tile), radius=tile * 0.225, fill=(250, 250, 248, 255))
    glyph = tile * 0.68  # logo area inside the tile
    g_off = off + (tile - glyph) / 2
    # The logo in the SVG spans x=16 to 96 → shift 6 units left to center it.
    draw_glyph(d, g_off - 6 * glyph / 100, g_off, glyph / 100, RED)
    return img.resize((size, size), Image.LANCZOS)


def tray_icon(px):
    # Template image: only alpha matters. The logo nearly fills the 16 pt height.
    big = px * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(img), -0.04 * big, 0, big / 100, (0, 0, 0, 255))
    return img.resize((px, px), Image.LANCZOS)


def main():
    ASSETS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for pt in (16, 32, 128, 256, 512):
            app_icon(pt).save(iconset / f"icon_{pt}x{pt}.png")
            app_icon(pt * 2).save(iconset / f"icon_{pt}x{pt}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "icon.icns")], check=True)
        app_icon(1024).save(ASSETS / "icon.png")
    tray_icon(16).save(ASSETS / "trayTemplate.png")
    tray_icon(32).save(ASSETS / "trayTemplate@2x.png")
    print(f"Icons written to {ASSETS}")


if __name__ == "__main__":
    main()
