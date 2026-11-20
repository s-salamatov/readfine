#!/usr/bin/env python3
"""Generate the iOS and iPadOS startup images using Pillow."""
from pathlib import Path

from PIL import Image

STATIC = Path(__file__).resolve().parents[1] / "backend" / "app" / "static"
DEVICES = (
    (440, 956, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3),
    (428, 926, 3), (390, 844, 3), (375, 812, 3), (414, 896, 3),
    (414, 896, 2), (375, 667, 2), (1032, 1376, 2), (1024, 1366, 2),
    (834, 1210, 2), (834, 1194, 2), (820, 1180, 2), (810, 1080, 2),
    (744, 1133, 2),
)
BACKGROUNDS = {"light": "#f9fafb", "dark": "#141414"}


def main() -> None:
    output = STATIC / "splash"
    output.mkdir(exist_ok=True)
    with Image.open(STATIC / "icons" / "icon-512.png") as source:
        icon = source.convert("RGBA")

    count = total_bytes = 0
    for width, height, dpr in DEVICES:
        portrait = (width * dpr, height * dpr)
        # Match the 22vmin mark on the launch page, rounded to a whole pixel.
        side = round(min(portrait) * 0.22)
        mark = icon.resize((side, side), Image.Resampling.LANCZOS)
        for orientation, size in (("portrait", portrait), ("landscape", portrait[::-1])):
            offset = ((size[0] - side) // 2, (size[1] - side) // 2)
            for scheme, color in BACKGROUNDS.items():
                splash = Image.new("RGB", size, color)
                splash.paste(mark, offset, mark)
                indexed = splash.quantize(colors=256, dither=Image.Dither.NONE)
                path = output / f"{width}x{height}-{dpr}x-{orientation}-{scheme}.png"
                indexed.save(path, optimize=True)
                count += 1
                total_bytes += path.stat().st_size
    print(f"Generated {count} indexed PNGs ({total_bytes} bytes total).")


if __name__ == "__main__":
    main()
