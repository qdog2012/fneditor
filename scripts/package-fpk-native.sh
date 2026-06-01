#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-fncode}"
PACKAGE_NAME="${PACKAGE_NAME:-fneditor}"
VERSION="${VERSION:-$(grep -m1 '^version=' "${ROOT_DIR}/packaging/fpk-native/manifest" | cut -d= -f2-)}"
STAGE_DIR="${STAGE_DIR:-${ROOT_DIR}/build/fpk-native/${APP_NAME}}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/build/fpk-output}"
OUTPUT_FILE="${OUTPUT_FILE:-${OUTPUT_DIR}/${PACKAGE_NAME}-${VERSION}.fpk}"

if [ ! -d "$STAGE_DIR/app" ]; then
  echo "Missing app directory in staging path: $STAGE_DIR" >&2
  echo "Run scripts/prepare-fpk-native.sh first." >&2
  exit 1
fi

if [ ! -f "$STAGE_DIR/manifest" ]; then
  echo "Missing manifest in staging path: $STAGE_DIR" >&2
  exit 1
fi

if [ ! -x "$STAGE_DIR/app/server/runtime/node/bin/node" ]; then
  echo "Missing Linux Node runtime: $STAGE_DIR/app/server/runtime/node/bin/node" >&2
  exit 1
fi

generate_png() {
  local output_path="$1"
  local size="$2"
  python3 - "$output_path" "$size" <<'PY'
import struct
import sys
import zlib

path = sys.argv[1]
size = int(sys.argv[2])
bg = (23, 105, 170, 255)
white = (247, 251, 255, 255)
accent = (134, 225, 195, 255)

def distance_to_segment(px, py, ax, ay, bx, by):
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    length_sq = vx * vx + vy * vy
    if length_sq == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0, min(1, (wx * vx + wy * vy) / length_sq))
    qx = ax + t * vx
    qy = ay + t * vy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5

def on_segment(px, py, start, end, width):
    return distance_to_segment(px, py, start[0], start[1], end[0], end[1]) <= width

rows = []
radius = size * 0.22
line_width = max(3, size * 0.045)
slash_width = max(3, size * 0.04)
for y in range(size):
    row = bytearray()
    for x in range(size):
        px = x + 0.5
        py = y + 0.5
        color = bg
        corner_x = min(px, size - px)
        corner_y = min(py, size - py)
        if corner_x < radius and corner_y < radius:
            if (corner_x - radius) ** 2 + (corner_y - radius) ** 2 > radius ** 2:
                color = (0, 0, 0, 0)

        left_top = (size * 0.42, size * 0.31)
        left_mid = (size * 0.26, size * 0.50)
        left_bottom = (size * 0.42, size * 0.69)
        right_top = (size * 0.58, size * 0.31)
        right_mid = (size * 0.74, size * 0.50)
        right_bottom = (size * 0.58, size * 0.69)
        slash_top = (size * 0.55, size * 0.24)
        slash_bottom = (size * 0.45, size * 0.76)

        if (
            on_segment(px, py, left_top, left_mid, line_width)
            or on_segment(px, py, left_mid, left_bottom, line_width)
            or on_segment(px, py, right_top, right_mid, line_width)
            or on_segment(px, py, right_mid, right_bottom, line_width)
        ):
            color = white
        if on_segment(px, py, slash_top, slash_bottom, slash_width):
            color = accent
        row.extend(color)
    rows.append(b"\x00" + bytes(row))

def chunk(name, data):
    return (
        struct.pack(">I", len(data))
        + name
        + data
        + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)
    )

png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + chunk(b"IEND", b"")
)
with open(path, "wb") as f:
    f.write(png)
PY
}

mkdir -p "$OUTPUT_DIR"
rm -f "$STAGE_DIR/app.tgz" "$OUTPUT_FILE"
mkdir -p "$STAGE_DIR/app/ui/images"

if [ -f "$STAGE_DIR/ICON.PNG" ]; then
  [ -f "$STAGE_DIR/ICON_256.PNG" ] || cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/ICON_256.PNG"
  [ -f "$STAGE_DIR/app/ui/images/icon_256.png" ] || cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/app/ui/images/icon_256.png"
  [ -f "$STAGE_DIR/app/ui/images/icon-256.png" ] || cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/app/ui/images/icon-256.png"
else
  generate_png "$STAGE_DIR/ICON.PNG" 256
  cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/ICON_256.PNG"
  cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/app/ui/images/icon_256.png"
  cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/app/ui/images/icon-256.png"
fi

if [ ! -f "$STAGE_DIR/app/ui/images/icon_64.png" ]; then
  generate_png "$STAGE_DIR/app/ui/images/icon_64.png" 64
fi

if [ ! -f "$STAGE_DIR/app/ui/images/icon-64.png" ]; then
  cp "$STAGE_DIR/app/ui/images/icon_64.png" "$STAGE_DIR/app/ui/images/icon-64.png"
fi

if [ ! -f "$STAGE_DIR/app/ui/images/icon.png" ]; then
  cp "$STAGE_DIR/app/ui/images/icon_256.png" "$STAGE_DIR/app/ui/images/icon.png"
fi

if [ -f "$STAGE_DIR/ICON_128.PNG" ]; then
  [ -f "$STAGE_DIR/app/ui/images/icon_128.png" ] || cp "$STAGE_DIR/ICON_128.PNG" "$STAGE_DIR/app/ui/images/icon_128.png"
  [ -f "$STAGE_DIR/app/ui/images/icon-128.png" ] || cp "$STAGE_DIR/ICON_128.PNG" "$STAGE_DIR/app/ui/images/icon-128.png"
fi

if [ -f "$STAGE_DIR/ICON_512.PNG" ]; then
  [ -f "$STAGE_DIR/app/ui/images/icon_512.png" ] || cp "$STAGE_DIR/ICON_512.PNG" "$STAGE_DIR/app/ui/images/icon_512.png"
  [ -f "$STAGE_DIR/app/ui/images/icon-512.png" ] || cp "$STAGE_DIR/ICON_512.PNG" "$STAGE_DIR/app/ui/images/icon-512.png"
fi

find "$STAGE_DIR/cmd" -type f -exec sed -i 's/\r$//' {} \;
sed -i 's/\r$//' "$STAGE_DIR/manifest"
chmod +x "$STAGE_DIR"/cmd/*
chmod +x "$STAGE_DIR/app/server/runtime/node/bin/node"
if [ -f "$STAGE_DIR/app/ui/proxy.cgi" ]; then
  sed -i 's/\r$//' "$STAGE_DIR/app/ui/proxy.cgi"
  chmod +x "$STAGE_DIR/app/ui/proxy.cgi"
fi

(
  cd "$STAGE_DIR"
  sed -i '/^[[:space:]]*checksum[[:space:]]*=/d' manifest
  tar --transform='s,app/,,g' -cf - app/server app/ui config | gzip -9 > app.tgz
  checksum="$(md5sum app.tgz | awk '{print $1}')"
  printf 'checksum=%s\n' "$checksum" >> manifest
  tar --exclude='app' --exclude='*.fpk' --exclude='README.md' -cf - * | gzip -9 > "$OUTPUT_FILE"
)

echo "$OUTPUT_FILE"
