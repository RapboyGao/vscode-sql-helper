#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm exec esbuild src/extension.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --external:vscode \
  --external:node-sql-parser \
  --outfile=dist/extension.js
