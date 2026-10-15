"""Generate the Syntax Download Manager tray icon (Phase 17): rounded dark tile + download arrow.

Matches the shell window's dark aesthetic (#202020 tile) with a Fluent-style accent
arrow. Drawn once at build time; the PNG is committed as a real asset, not generated
at runtime. 256x256 (Windows tray scales down to 16x16 dip).
"""
from PIL import Image, ImageDraw

SIZE = 256
TILE_BG = (32, 32, 32, 255)        # #202020 — the shell window background
ARROW = (0, 120, 212, 255)         # Windows 11 accent blue
TRAY_RADIUS = 56
ARROW_SHAFT_W = 36
ARROW_HEAD_H = 64
ARROW_HEAD_W = 112
TOP = 52
SHAFT_BOTTOM = 148
BASELINE_Y = 196
BASELINE_W = 112
BASELINE_H = 14

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded tile.
d.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=TRAY_RADIUS, fill=TILE_BG)

cx = SIZE // 2
# Shaft.
d.rectangle([cx - ARROW_SHAFT_W // 2, TOP, cx + ARROW_SHAFT_W // 2, SHAFT_BOTTOM], fill=ARROW)
# Head (triangle).
d.polygon(
    [
        (cx - ARROW_HEAD_W // 2, SHAFT_BOTTOM),
        (cx + ARROW_HEAD_W // 2, SHAFT_BOTTOM),
        (cx, SHAFT_BOTTOM + ARROW_HEAD_H),
    ],
    fill=ARROW,
)
# Base line.
d.rounded_rectangle(
    [cx - BASELINE_W // 2, BASELINE_Y, cx + BASELINE_W // 2, BASELINE_Y + BASELINE_H],
    radius=BASELINE_H // 2,
    fill=ARROW,
)

out = "/home/z/my-project/apps/desktop/resources/icons/syntaxdm-tray.png"
img.save(out)
print("wrote", out, img.size)
