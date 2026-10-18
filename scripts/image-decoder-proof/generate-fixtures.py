"""Regenerate tiny synthetic fixtures with an already installed Pillow; no network.

This optional authoring tool is not a runtime or npm dependency. Native Electron
decoding is verified separately; Pillow verification is only generation hygiene.
"""
from pathlib import Path
import hashlib
import json
import PIL
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "tests/fixtures/image-decoder"
OUTPUT.mkdir(parents=True, exist_ok=True)
SIZE = (8, 8)
image = Image.new("RGB", SIZE)
image.putdata([(x * 31, y * 31, (x + y) * 15) for y in range(8) for x in range(8)])
cases = [
    ("png", "PNG", "image/png", {}),
    ("jpeg", "JPEG", "image/jpeg", {"quality": 90, "subsampling": 0, "optimize": False, "progressive": False}),
    ("gif", "GIF", "image/gif", {}),
    ("webp", "WEBP", "image/webp", {"lossless": True, "method": 6}),
    ("bmp", "BMP", "image/bmp", {}),
    ("avif", "AVIF", "image/avif", {"quality": 90, "speed": 6, "max_threads": 1}),
]
rows = []
for family, format_name, mime, options in cases:
    destination = OUTPUT / ("synthetic." + family)
    image.save(destination, format=format_name, **options)
    with Image.open(destination) as decoded:
        assert decoded.size == SIZE
        decoded.verify()
    data = destination.read_bytes()
    rows.append({"family": family, "mime": mime, "path": destination.relative_to(ROOT).as_posix(),
                 "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "width": 8, "height": 8})
corrupt = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000")
(OUTPUT / "corrupt.png").write_bytes(corrupt)
manifest = {
    "schema": 1,
    "generator": {"pillow": PIL.__version__, "webp": features.version("webp"), "avif": features.version("avif"),
                  "source": "scripts/image-decoder-proof/generate-fixtures.py", "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "rgbAlgorithm": "row-major RGB(x*31,y*31,(x+y)*15), x,y in [0,7]", "rgbSha256": hashlib.sha256(image.tobytes()).hexdigest()},
    "fixtures": rows,
    "corruptPNG": {"path": "tests/fixtures/image-decoder/corrupt.png", "mime": "image/png", "bytes": len(corrupt), "sha256": hashlib.sha256(corrupt).hexdigest()},
    "limits": "Tiny static family positives only; no animated, expensive-middecode, memory, OS or GC claim.",
}
(OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"families": len(rows), "bytes": sum(row["bytes"] for row in rows), "pillow": PIL.__version__}))
