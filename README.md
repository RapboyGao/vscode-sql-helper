# Universal SQL Database Manager for VS Code

Universal SQL Database Manager is a VS Code extension workspace for browsing and editing SQL databases from the sidebar and editor area. The MVP ships a TypeScript extension host, a Vue webview app, and a Rust native CLI bridge.

## Workspace Layout

```text
.
├── apps/
│   ├── extension/        # VS Code extension host, tree view, panels, commands
│   └── webview/          # Vue 3 webview UI bundled into the extension
├── packages/
│   └── shared/           # Shared types, message contracts, helpers
├── native/
│   └── rust-backend/     # Native CLI for database operations
├── .github/workflows/    # CI for native binaries and VSIX packaging
└── .vscode/              # F5 launch and build tasks
```

## MVP Coverage

- Saved Connections tree in the Activity Bar sidebar
- Connection details editor in the main area
- SQLite file import as a first-class connection
- Table data explorer with pagination inputs and insert/delete actions
- Structure tab with SQL preview for common DDL actions
- Native bridge scaffolding for SQLite, MySQL, and PostgreSQL
- SecretStorage integration for server passwords
- Platform binary resolution for:
  - `darwin-x64`
  - `darwin-arm64`
  - `linux-x64`
  - `linux-arm64`
  - `win32-x64`

## Development

### Requirements

- Node.js 20+
- pnpm 10+
- Rust stable toolchain
- VS Code 1.90+

### Install dependencies

```bash
pnpm install
```

### Build everything

```bash
pnpm build
```

### Build the Rust native CLI

```bash
pnpm build:native
```

The local development resolver also looks for the native executable in:

- `native/rust-backend/target/release/usd-native`
- `native/rust-backend/target/release/usd-native.exe`

### Run the webview in dev mode

```bash
pnpm dev:webview
```

### Launch the extension with F5

1. Open the repository root in VS Code.
2. Run `pnpm install`.
3. Optionally run `pnpm build:native` if you want the Rust backend available locally.
4. Press `F5`.
5. VS Code executes the `build-workspace` task and launches a new Extension Development Host.

## Packaging

Build a VSIX package with:

```bash
pnpm package:vsix
```

The command runs from `apps/extension` and expects webview assets to already be bundled.

## Native Protocol

The extension and Rust backend communicate over JSON `stdin/stdout`.

Request fields:

- `requestId`
- `operation`
- `connection`
- `readonly`
- `payload`

Response fields:

- `success`
- `data`
- `error`
- `sqlPreview`
- `meta`

## SQLite Support

Supported file extensions:

- `.sqlite`
- `.sqlite3`
- `.db`
- `.db3`

Open SQLite databases with:

- command palette: `Database Manager: Open SQLite File`
- Explorer context menu: `Database Manager: Add SQLite File As Connection`
- direct open: double-click `.sqlite`, `.sqlite3`, `.db`, or `.db3` and VS Code opens it with the Database Manager custom editor

## Screenshot Placeholders

Add screenshots later under `docs/screenshots/` and reference:

- `saved-connections.png`
- `connection-details.png`
- `table-data.png`
- `schema-preview.png`

## Known MVP Gaps

- MySQL and PostgreSQL currently implement connection test and metadata listing in the Rust layer, but not full CRUD/DDL parity yet.
- SQLite column type changes that require table rebuild are not automated in this first cut.
- The table data UI currently supports insert and delete flows directly; richer row editing and advanced filter builders are next-step work.

## Next Extensions

- SQL Server and MariaDB adapters
- richer DDL forms for table and column editing
- safer production connection guardrails
- custom editor registration for SQLite files
- downloadable platform binaries on first run
