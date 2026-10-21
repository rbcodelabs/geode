#!/usr/bin/env python3
"""Render the iOS launch-screen PNGs (Splash.imageset) from the gem in resources/icon-ios.svg.

No image tooling is required beyond the Python standard library. Output is an opaque RGB PNG:
the dark background (#1e1e1e, the app's --color-base-05 dark theme) with the gem centred, so the
launch screen, the mobile.html boot splash and the first app frame all share one colour.

Usage: python3 scripts/generate-ios-splash.py
"""
import struct
import zlib
from pathlib import Path

SIZE = 2732
BG = (0x1E, 0x1E, 0x1E)
CHIP = (0x29, 0x48, 0x35)  # brand green, used for the facet shading
GEM_HEIGHT = 640  # px on the 2732 canvas
SS = 3  # supersampling per axis

# Geometry copied from resources/icon-ios.svg (1024 viewBox).
GEM = [(512, 254.5), (718, 409), (640.75, 769.5), (383.25, 769.5), (306, 409)]
RIGHT_FACET = ([(512, 254.5), (718, 409), (640.75, 769.5), (512, 512)], 0.24)
LEFT_FACET = ([(512, 254.5), (512, 512), (383.25, 769.5), (306, 409)], 0.08)
GRAD_FROM, GRAD_TO = (0xDB, 0xEA, 0x9D), (0x78, 0x93, 0x48)
GRAD_P0, GRAD_P1 = (306, 254.5), (718, 769.5)

OUT = Path(__file__).resolve().parent.parent / "ios/App/App/Assets.xcassets/Splash.imageset"
FILES = ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]


def inside(poly, x, y):
    hit = False
    j = len(poly) - 1
    for i, (xi, yi) in enumerate(poly):
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def gradient(x, y):
    dx, dy = GRAD_P1[0] - GRAD_P0[0], GRAD_P1[1] - GRAD_P0[1]
    t = ((x - GRAD_P0[0]) * dx + (y - GRAD_P0[1]) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return tuple(GRAD_FROM[k] + (GRAD_TO[k] - GRAD_FROM[k]) * t for k in range(3))


def sample(x, y):
    """Colour of the gem at icon-space (x, y), or None outside the gem."""
    if not inside(GEM, x, y):
        return None
    c = gradient(x, y)
    for poly, alpha in (RIGHT_FACET, LEFT_FACET):
        if inside(poly, x, y):
            c = tuple(c[k] * (1 - alpha) + CHIP[k] * alpha for k in range(3))
    return c


def render():
    scale = GEM_HEIGHT / (769.5 - 254.5)
    cx_icon, cy_icon = 512, (254.5 + 769.5) / 2
    x0, x1 = int(SIZE / 2 - 260 * scale) - 2, int(SIZE / 2 + 260 * scale) + 2
    y0, y1 = int(SIZE / 2 - GEM_HEIGHT / 2) - 2, int(SIZE / 2 + GEM_HEIGHT / 2) + 2
    bg_row = bytes([0]) + bytes(BG) * SIZE
    rows = []
    for y in range(SIZE):
        if y < y0 or y > y1:
            rows.append(bg_row)
            continue
        row = bytearray(bg_row)
        for x in range(x0, x1 + 1):
            acc, cov = [0.0, 0.0, 0.0], 0
            for sy in range(SS):
                for sx in range(SS):
                    ix = (x + (sx + 0.5) / SS - SIZE / 2) / scale + cx_icon
                    iy = (y + (sy + 0.5) / SS - SIZE / 2) / scale + cy_icon
                    c = sample(ix, iy)
                    if c:
                        cov += 1
                        for k in range(3):
                            acc[k] += c[k]
            if cov:
                f = cov / (SS * SS)
                for k in range(3):
                    gem = acc[k] / cov
                    row[1 + x * 3 + k] = round(gem * f + BG[k] * (1 - f))
        rows.append(bytes(row))
    return b"".join(rows)


def png(raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)  # 8-bit RGB, no alpha
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    data = png(render())
    for name in FILES:
        (OUT / name).write_bytes(data)
        print(f"wrote {OUT / name} ({len(data)} bytes)")
