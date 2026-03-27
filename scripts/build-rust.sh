#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cargo build --manifest-path crates/sql-analyzer/Cargo.toml --release
"$ROOT_DIR/scripts/copy-rust-binary.sh"
