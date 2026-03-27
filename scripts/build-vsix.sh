#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/build.sh"
pnpm dlx @vscode/vsce package --no-dependencies --out dist/sql-helper.vsix
