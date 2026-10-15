#!/usr/bin/env python3
"""Generate the Windows application icon (build/icon.ico) for Syntax Download Manager.

Phase 19 packaging input. The installer and the portable exe both embed this icon; it is
derived from the same provenance script that produced the Phase 17 tray artwork
(gen-tray-icon.py) so the two assets can never drift apart visually.

Output: apps/desktop/build/icon.ico containing the classic Windows size ladder
(16, 24, 32, 48, 64, 128, 256). 256 px is stored as PNG inside the ICO (Vista+),
smaller sizes as BMP - the standard, maximally compatible layout.

Usage: python3 scripts/gen-app-icon.py [--source <png>]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "apps/desktop/resources/icons/syntaxdm-tray.png"
DEFAULT_OUTPUT = ROOT / "apps/desktop/build/icon.ico"

# Same geometry language as gen-tray-icon.py: dark rounded tile + accent arrow.
TILE_RGB = (32, 32, 32)
ACCENT_RGB = (0, 120, 212)  # Windows accent blue


def draw_base(size: int) -> Image.Image:
    """Render the app mark at an arbitrary square size (always > 0 padding)."""
    scale = max(1, size // 256)
    big = 256 * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square tile (same radius ratio as the tray icon).
    radius = 48 * scale
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=TILE_RGB + (255,))

    # Accent download arrow: shaft + head, centered, sized relative to the tile.
    cx = big // 2
    shaft_w = 28 * scale
    shaft_top = 56 * scale
    head_top = 136 * scale
    head_half = 56 * scale
    head_bottom = 200 * scale
    d.rounded_rectangle(
        [cx - shaft_w // 2, shaft_top, cx + shaft_w // 2, head_top + 8 * scale],
        radius=shaft_w // 2,
        fill=ACCENT_RGB + (255,),
    )
    d.polygon(
        [(cx - head_half, head_top), (cx + head_half, head_top), (cx, head_bottom)],
        fill=ACCENT_RGB + (255,),
    )
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate build/icon.ico")
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                    help="source PNG (default: the Phase 17 tray icon)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = ap.parse_args()

    # Provenance first: the tray artwork must exist, and we render our own
    # high-resolution base from the same geometry so upscaling never blurs.
    if not args.source.is_file():
        raise SystemExit(f"source PNG missing: {args.source}")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    base_256 = draw_base(256)

    # ICO container written by hand: BMP (32bpp BGRA + AND mask) entries for the
    # classic ladder, PNG-compressed entry for 256 px - the maximally compatible
    # layout every Windows toolchain (rcedit, NSIS, Explorer) understands.
    # PIL's own ICO writer cannot mix bitmap formats, hence the manual pack.
    import io
    import struct

    def bmp_frame(img: Image.Image) -> bytes:
        w, h = img.size
        px = img.convert("RGBA").tobytes("raw", "BGRA")
        rows = [px[y * w * 4 : (y + 1) * w * 4] for y in range(h - 1, -1, -1)]
        pixel_data = b"".join(rows)
        mask_row = ((w + 31) // 32) * 4
        and_mask = b"\x00" * (mask_row * h)
        header = struct.pack(
            "<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(pixel_data) + len(and_mask),
            0, 0, 0, 0,
        )
        return header + pixel_data + and_mask

    def png_frame(img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    entries: list[tuple[int, bytes]] = [(s, bmp_frame(base_256.resize((s, s), Image.LANCZOS))) for s in sizes[:-1]]
    entries.append((256, png_frame(base_256)))

    out = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    body = b""
    for s, data in entries:
        dim = 0 if s >= 256 else s  # 0 encodes 256 in ICO directory entries
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(out + body)
    print(f"wrote {args.out} ({args.out.stat().st_size} bytes), sizes={sizes}")


if __name__ == "__main__":
    main()
