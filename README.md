# SQL Helper

`Vue + Rust + TypeScript` mixed VS Code extension scaffold.

## Current scope

- VS Code command opens a Vue webview.
- User pastes SQL into the panel.
- Extension calls a Rust binary for analysis.
- Rust returns detected database/schema references.

## Development

```bash
npm install
npm run build
```

Then press `F5` in VS Code to run the extension host.
