#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! "$ROOT_DIR/scripts/download-platform-bins.sh"; then
  echo "Warning: failed to download GitHub Actions binaries; continuing with local binaries." >&2
fi
"$ROOT_DIR/scripts/build.sh"
pnpm dlx @vscode/vsce package --no-dependencies --out dist/sql-helper.vsix
