#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGINAL_ROOT_DIR="$ROOT_DIR"
APP_NAME="fncode"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Install dependencies first, for example on Ubuntu/WSL:" >&2
    echo "  Install Go 1.23+ and Node.js 22+ with npm, then install tar." >&2
    exit 1
  fi
}

require_cmd node
require_cmd npm
require_cmd go
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
  WORK_ROOT="${FPK_WORK_ROOT:-${HOME}/.cache/fncode-fpk-src}"
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
    GO_ARCH="amd64"
    ;;
  aarch64 | arm64)
    GO_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $machine" >&2
    exit 1
    ;;
esac

cd "$ROOT_DIR"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
npm ci
npm run build:frontend

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/app/server"
cp -R "${TEMPLATE_DIR}/." "$STAGE_DIR/"
rm -f "${STAGE_DIR}/app/server/.gitkeep"

cp -R dist "${STAGE_DIR}/app/server/"
CGO_ENABLED=0 GOOS=linux GOARCH="$GO_ARCH" go build -trimpath \
  -ldflags="-s -w -X main.version=${VERSION}" \
  -o "${STAGE_DIR}/app/server/fneditor" ./server
printf '%s\n' "$VERSION" > "${STAGE_DIR}/app/server/VERSION"
sed -i "s/^version=.*/version=${VERSION}/" "${STAGE_DIR}/manifest"
case "$GO_ARCH" in
  amd64) sed -i 's/^platform=.*/platform=x86/' "${STAGE_DIR}/manifest" ;;
  arm64) sed -i 's/^platform=.*/platform=arm/' "${STAGE_DIR}/manifest" ;;
esac

chmod +x "${STAGE_DIR}"/cmd/*
chmod +x "${STAGE_DIR}/app/server/fneditor"
sed -i 's/\r$//' "${STAGE_DIR}/app/ui/index.cgi"
chmod +x "${STAGE_DIR}/app/ui/index.cgi"

echo "Native FPK staging directory prepared:"
echo "  ${STAGE_DIR}"
echo
echo "Next step: cd ${ROOT_DIR} && bash scripts/package-fpk-native.sh"
echo "Version: ${VERSION}, Go backend, arch: ${GO_ARCH}"
if [ "$ORIGINAL_ROOT_DIR" != "$ROOT_DIR" ]; then
  echo
  echo "Original Windows-mounted project was left untouched:"
  echo "  ${ORIGINAL_ROOT_DIR}"
fi
