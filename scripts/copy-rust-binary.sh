#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win32" ;;
    *)
      echo "Unsupported host platform: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported host architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

BIN_PLATFORM="${BIN_PLATFORM:-$(detect_platform)}"
BIN_ARCH="${BIN_ARCH:-$(detect_arch)}"
TARGET_TRIPLE="${TARGET_TRIPLE:-}"

TARGET_DIR="$ROOT_DIR/bin"
PLATFORM_DIR="$TARGET_DIR/${BIN_PLATFORM}-${BIN_ARCH}"

if [[ "$BIN_PLATFORM" == "win32" ]]; then
  EXECUTABLE="sql-analyzer.exe"
else
  EXECUTABLE="sql-analyzer"
fi

if [[ -n "$TARGET_TRIPLE" ]]; then
  SOURCE="$ROOT_DIR/crates/sql-analyzer/target/$TARGET_TRIPLE/release/$EXECUTABLE"
else
  SOURCE="$ROOT_DIR/crates/sql-analyzer/target/release/$EXECUTABLE"
fi

FALLBACK="$ROOT_DIR/target/release/$EXECUTABLE"
if [[ -f "$SOURCE" ]]; then
  RESOLVED_SOURCE="$SOURCE"
elif [[ -f "$FALLBACK" ]]; then
  RESOLVED_SOURCE="$FALLBACK"
else
  echo "Rust binary not found at either:" >&2
  echo "  $SOURCE" >&2
  echo "  $FALLBACK" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$PLATFORM_DIR"
cp "$RESOLVED_SOURCE" "$PLATFORM_DIR/$EXECUTABLE"
chmod +x "$PLATFORM_DIR/$EXECUTABLE" 2>/dev/null || true
echo "Copied $RESOLVED_SOURCE -> $PLATFORM_DIR/$EXECUTABLE"

HOST_PLATFORM="$(detect_platform)"
HOST_ARCH="$(detect_arch)"
if [[ "$BIN_PLATFORM" == "$HOST_PLATFORM" && "$BIN_ARCH" == "$HOST_ARCH" ]]; then
  cp "$RESOLVED_SOURCE" "$TARGET_DIR/$EXECUTABLE"
  chmod +x "$TARGET_DIR/$EXECUTABLE" 2>/dev/null || true
  echo "Copied $RESOLVED_SOURCE -> $TARGET_DIR/$EXECUTABLE"
fi
