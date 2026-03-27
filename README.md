# SQL Helper

`Vue + Rust + TypeScript` mixed VS Code extension scaffold.

## Current scope

- VS Code command opens a Vue webview.
- User pastes SQL into the panel.
- Extension calls a Rust binary for analysis.
- Rust returns detected database/schema references.

## Development

```bash
pnpm install
pnpm run build
```

Then open the workspace in VS Code and press `F5`.

The default debug profile is `Run SQL Helper Extension`, which will:

- run the `build-extension` task first
- start a VS Code Extension Development Host
- load this workspace as the extension under development

Useful debug entries:

- `Run SQL Helper Extension`: build first, then launch
- `Run SQL Helper Extension (No Build)`: launch immediately if you already built

## CI binaries

GitHub Actions builds Rust binaries for these platform folders:

- `bin/darwin-arm64/sql-analyzer`
- `bin/linux-x64/sql-analyzer`
- `bin/win32-x64/sql-analyzer.exe`

Workflow file:

- [.github/workflows/build-binaries.yml](/Users/albert/Documents/vscode-sql-helper/.github/workflows/build-binaries.yml)

The workflow uploads:

- one artifact per platform binary
- one combined `sql-helper-platform-bins` artifact
