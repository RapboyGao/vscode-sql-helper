#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/build-rust.sh"
"$ROOT_DIR/scripts/build-webview.sh"
"$ROOT_DIR/scripts/build-extension.sh"
