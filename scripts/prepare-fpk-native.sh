#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGINAL_ROOT_DIR="$ROOT_DIR"
APP_NAME="fneditor"
NODE_VERSION="${NODE_VERSION:-22.16.0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Install dependencies first, for example on Ubuntu/WSL:" >&2
    echo "  sudo apt update && sudo apt install -y nodejs npm curl xz-utils tar" >&2
    exit 1
  fi
}

require_cmd node
require_cmd npm
require_cmd curl
require_cmd tar

is_wsl_mnt_path() {
  [ -r /proc/version ] || return 1
  grep -qiE "microsoft|wsl" /proc/version || return 1
  case "$ROOT_DIR" in
    /mnt/*) return 0 ;;
    *) return 1 ;;
  esac
}

if is_wsl_mnt_path; then
  WORK_ROOT="${FPK_WORK_ROOT:-${HOME}/.cache/fneditor-fpk-src}"
  echo "Detected WSL project path under /mnt."
  echo "Copying source to Linux filesystem before npm install:"
  echo "  ${WORK_ROOT}"
  rm -rf "$WORK_ROOT"
  mkdir -p "$WORK_ROOT"
  (
    cd "$ROOT_DIR"
    tar \
      --exclude="./node_modules" \
      --exclude="./dist" \
      --exclude="./build" \
      --exclude="./.git" \
      --exclude="./.fneditor-state.json" \
      -cf - .
  ) | (
    cd "$WORK_ROOT"
    tar -xf -
  )
  ROOT_DIR="$WORK_ROOT"
fi

TEMPLATE_DIR="${ROOT_DIR}/packaging/fpk-native"
STAGE_DIR="${ROOT_DIR}/build/fpk-native/${APP_NAME}"

machine="${TARGET_ARCH:-$(uname -m)}"
case "$machine" in
  x86_64 | amd64)
    NODE_ARCH="x64"
    ;;
  aarch64 | arm64)
    NODE_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $machine" >&2
    exit 1
    ;;
esac

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
CACHE_DIR="${ROOT_DIR}/build/cache"

cd "$ROOT_DIR"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
npm ci
npm run build

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$CACHE_DIR"
cp -R "${TEMPLATE_DIR}/." "$STAGE_DIR/"
rm -f "${STAGE_DIR}/app/server/.gitkeep"

cp -R dist server "${STAGE_DIR}/app/server/"
cat > "${STAGE_DIR}/app/server/package.json" <<EOF
{
  "name": "${APP_NAME}-server",
  "version": "${VERSION}",
  "private": true,
  "type": "module",
  "dependencies": {
    "express": "$(node -p "require('./package.json').dependencies.express")"
  }
}
EOF
npm install --omit=dev --no-audit --no-fund --package-lock=false --prefix "${STAGE_DIR}/app/server"

if [ ! -f "${CACHE_DIR}/${NODE_TARBALL}" ]; then
  curl -fL "$NODE_URL" -o "${CACHE_DIR}/${NODE_TARBALL}"
fi

TMP_NODE_DIR="${ROOT_DIR}/build/tmp-node-runtime"
rm -rf "$TMP_NODE_DIR" "${STAGE_DIR}/app/server/runtime"
mkdir -p "$TMP_NODE_DIR" "${STAGE_DIR}/app/server/runtime/node/bin"
tar -xJf "${CACHE_DIR}/${NODE_TARBALL}" -C "$TMP_NODE_DIR" "node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node"
cp "${TMP_NODE_DIR}/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" "${STAGE_DIR}/app/server/runtime/node/bin/node"
rm -rf "$TMP_NODE_DIR"

chmod +x "${STAGE_DIR}"/cmd/*
chmod +x "${STAGE_DIR}/app/server/runtime/node/bin/node"

echo "Native FPK staging directory prepared:"
echo "  ${STAGE_DIR}"
echo
echo "Next step: build the .fpk with fnOS fnpack/Fnpackup from this staging directory."
echo "Version: ${VERSION}, Node: ${NODE_VERSION}, arch: ${NODE_ARCH}"
if [ "$ORIGINAL_ROOT_DIR" != "$ROOT_DIR" ]; then
  echo
  echo "Original Windows-mounted project was left untouched:"
  echo "  ${ORIGINAL_ROOT_DIR}"
fi
