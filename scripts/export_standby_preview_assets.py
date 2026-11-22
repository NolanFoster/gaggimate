#!/usr/bin/env python3
"""Export the display's standby-screen artwork for the web UI's live standby preview.

The preview (web/src/pages/Settings/StandbyPreview.jsx) mimics the LVGL standby screen, so it uses the same pixels:
- the EEZ alpha-only images (logo, status icons, tap icon) become white PNGs with that alpha; the preview tints them
  with the theme colour, exactly as LVGL's img_recolor does on the device;
- LVGL's Montserrat-Medium (the font of the built-in lv_font_montserrat_* and the standby clock font) is subset to
  the characters the standby screen shows.

Run after changing the EEZ images. Needs fontTools + brotli (pip install fonttools brotli) and a PlatformIO build that
fetched LVGL (for the TTF):  python3 scripts/export_standby_preview_assets.py
"""

import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "src/display/ui/default/eez/images"
OUT = ROOT / "web/src/assets/standby"
ICONS = {
    "logo": "ui_image_logo.c",
    "wifi": "ui_image_wifi_20x20.c",
    "bluetooth": "ui_image_bluetooth_alt_20x20.c",
    "update": "ui_image_refresh_20x20.c",
    "tap": "ui_image_tap_48x48.c",
}
FONT_TEXT = "0123456789: AMP°C-"


def read_alpha_image(path: Path):
    src = path.read_text()
    if "LV_IMG_CF_ALPHA_8BIT" not in src:
        sys.exit(f"{path.name}: expected an LV_IMG_CF_ALPHA_8BIT image")
    width = int(re.search(r"\.header\.w = (\d+)", src).group(1))
    height = int(re.search(r"\.header\.h = (\d+)", src).group(1))
    body = re.search(r"_map\[\] = \{(.*?)\};", src, re.S).group(1)
    alpha = bytes(int(v, 16) for v in re.findall(r"0x([0-9a-fA-F]{2})", body))
    if len(alpha) != width * height:
        sys.exit(f"{path.name}: {len(alpha)} bytes, expected {width * height}")
    return width, height, alpha


def write_png(path: Path, width: int, height: int, alpha: bytes):
    rows = b"".join(
        b"\x00" + b"".join(b"\xff\xff\xff" + bytes([a]) for a in alpha[y * width : (y + 1) * width])
        for y in range(height)
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))  # 8-bit RGBA
    png += chunk(b"IDAT", zlib.compress(rows, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def export_font():
    from fontTools import subset

    candidates = sorted(ROOT.glob(".pio/libdeps/*/lvgl/scripts/built_in_font/Montserrat-Medium.ttf"))
    if not candidates:
        sys.exit("Montserrat-Medium.ttf not found: run a PlatformIO display build first (it fetches LVGL)")
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["kern"]
    font = subset.load_font(str(candidates[0]), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=FONT_TEXT)
    subsetter.subset(font)
    out = OUT / "montserrat-medium-standby.woff2"
    subset.save_font(font, str(out), options)
    print(f"{out.relative_to(ROOT)}: {out.stat().st_size} bytes")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, source in ICONS.items():
        width, height, alpha = read_alpha_image(IMAGES / source)
        out = OUT / f"{name}.png"
        write_png(out, width, height, alpha)
        print(f"{out.relative_to(ROOT)}: {width}x{height}, {out.stat().st_size} bytes")
    export_font()


if __name__ == "__main__":
    main()
