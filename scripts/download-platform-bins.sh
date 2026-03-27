#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required to download GitHub Actions artifacts." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

REPO_URL="$(node -p "require('./package.json').repository?.url || ''")"
if [[ -z "$REPO_URL" ]]; then
  echo "package.json is missing repository.url" >&2
  exit 1
fi

REPO_SLUG="$(node -e "const url = process.argv[1]; const match = url.match(/github\\.com[/:]([^/]+\\/[^/.]+)(?:\\.git)?$/); if (!match) process.exit(1); console.log(match[1]);" "$REPO_URL")"
if [[ -z "$REPO_SLUG" ]]; then
  echo "Could not derive GitHub repository slug from: $REPO_URL" >&2
  exit 1
fi

WORKFLOW_FILE="build-binaries.yml"
ARTIFACT_NAME="sql-helper-platform-bins"
TEMP_DIR="$(mktemp -d)"
RUN_JSON="$TEMP_DIR/run.json"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

gh api "repos/$REPO_SLUG/actions/workflows/$WORKFLOW_FILE/runs?status=success&per_page=1" > "$RUN_JSON"

RUN_ID="$(node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const run = data.workflow_runs?.[0]; if (!run) process.exit(1); console.log(run.id);" "$RUN_JSON" || true)"
if [[ -z "$RUN_ID" ]]; then
  echo "No successful workflow runs found for $WORKFLOW_FILE in $REPO_SLUG" >&2
  exit 1
fi

DOWNLOAD_DIR="$TEMP_DIR/artifact"
mkdir -p "$DOWNLOAD_DIR"

echo "Downloading artifact '$ARTIFACT_NAME' from run $RUN_ID in $REPO_SLUG..."
gh run download "$RUN_ID" --repo "$REPO_SLUG" --name "$ARTIFACT_NAME" --dir "$DOWNLOAD_DIR"

rm -rf "$ROOT_DIR/bin"
mkdir -p "$ROOT_DIR/bin"

while IFS= read -r artifact_dir; do
  artifact_name="$(basename "$artifact_dir")"
  if [[ "$artifact_name" =~ ^sql-helper-bin-(.+)$ ]]; then
    target_dir="${BASH_REMATCH[1]}"
    mkdir -p "$ROOT_DIR/bin/$target_dir"
    cp -R "$artifact_dir/." "$ROOT_DIR/bin/$target_dir/"
  fi
done < <(find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

HOST_PLATFORM="$(node -p "process.platform")"
HOST_ARCH="$(node -p "process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch")"
HOST_BIN_DIR="$ROOT_DIR/bin/$HOST_PLATFORM-$HOST_ARCH"

if [[ "$HOST_PLATFORM" == "win32" ]]; then
  HOST_BINARY="$HOST_BIN_DIR/sql-analyzer.exe"
  LEGACY_BINARY="$ROOT_DIR/bin/sql-analyzer.exe"
else
  HOST_BINARY="$HOST_BIN_DIR/sql-analyzer"
  LEGACY_BINARY="$ROOT_DIR/bin/sql-analyzer"
fi

if [[ -f "$HOST_BINARY" ]]; then
  cp "$HOST_BINARY" "$LEGACY_BINARY"
fi

echo "Downloaded platform binaries into $ROOT_DIR/bin"
