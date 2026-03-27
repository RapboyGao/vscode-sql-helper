# SQL Helper

![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vue.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Analyzer-000000?logo=rust&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Workspace-003B57?logo=sqlite&logoColor=white)
![Platforms](https://img.shields.io/badge/Platforms-macOS%20%7C%20Linux%20%7C%20Windows-6E40C9)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)

SQL Helper is a VS Code extension for exploring SQLite databases, editing table data and schema, exporting database content, and analyzing SQL from inside the editor. ✨

It combines a native VS Code explorer, a custom SQLite editor, a Vue-powered workbench UI, and a Rust SQL analyzer binary with platform-aware loading.

## ✨ Highlights

- Open `.sqlite`, `.sqlite3`, `.db`, and `.db3` files directly inside VS Code. 📂
- Browse tables from the Sidebar explorer and jump straight into a focused table workspace.
- Edit table rows inline with type-aware inputs for integers, dates, times, and datetimes.
- Change table structure, including column add, remove, rename, and type updates.
- Add and save connections from the Sidebar:
  - SQLite file connections
  - server-style saved connections with protocol, host, database, username, and password
- Export:
  - a whole database to `.xlsx`, `.json`, or per-table `.csv`
  - a single table to `.xlsx`, `.csv`, or `.json`
- Analyze SQL from a dedicated panel and from editor-integrated language features.
- Build and ship per-platform Rust analyzer binaries through GitHub Actions. 🚀

## 🖥️ What It Looks Like

SQL Helper is designed as a working database tool, not just a preview panel:

- `SQL Helper` Activity Bar icon
- `Explorer` tree in the Sidebar
- custom SQLite editor for table data and structure
- SQL analysis panel for ad hoc query inspection

## 🧰 Main Capabilities

### 1. 🧭 Sidebar Explorer

The Sidebar gives you a compact database navigator inside VS Code:

- active database section
- saved databases list
- add connection entry
- per-table actions:
  - rename table
  - delete table
  - export table
- per-database actions:
  - add table
  - remove saved record
  - export database

### 2. 🗃️ SQLite Workspace

Opening a SQLite file launches a purpose-built editor with two modes:

- `Data`
  - inline row editing
  - add row
  - delete row
  - debounced fuzzy search
  - pagination
- `Structure`
  - add column
  - delete column
  - rename column
  - update type / `NOT NULL` / `PRIMARY KEY` / `DEFAULT`

### 3. 🔎 SQL Analysis

The extension also includes SQL-aware tooling:

- open the standalone SQL analyzer panel
- preview current SQL
- explain current SQL
- diagnostics, completion, hover, references, and rename support for `.sql` files

The runtime tries to use the bundled Rust analyzer first and falls back to the TypeScript parser if the binary is unavailable.

## 🏗️ Project Structure

```text
.
├── crates/sql-analyzer/         # Rust analyzer binary
├── src/                         # VS Code extension host
├── webview/src/                 # Vue UI for custom editor / panel
├── media/                       # extension icon assets
├── scripts/                     # local build helpers
├── bin/                         # platform-specific analyzer binaries
└── .github/workflows/           # CI build pipelines
```

## 👨‍💻 Development

### Requirements

- Node.js 20+
- pnpm 10+
- Rust stable
- VS Code 1.90+

### Install

```bash
pnpm install
```

### Build

```bash
pnpm run build
```

### Type Check

```bash
pnpm run check
```

### Run In VS Code

1. Open this repository in VS Code.
2. Press `F5`.
3. Launch the `Run SQL Helper Extension` debug target.

Useful debug entries:

- `Run SQL Helper Extension`
- `Run SQL Helper Extension (No Build)`

## 📦 Binary Layout

The Rust analyzer is stored in platform-specific folders so the extension can resolve the correct executable at runtime.

Current layout:

- `bin/darwin-x64/sql-analyzer`
- `bin/darwin-arm64/sql-analyzer`
- `bin/linux-x64/sql-analyzer`
- `bin/linux-arm64/sql-analyzer`
- `bin/win32-x64/sql-analyzer.exe`

For local development on the current machine, the build also keeps a compatibility copy at:

- `bin/sql-analyzer`

## ⚙️ CI: Multi-Platform Rust Binaries

GitHub Actions builds the Rust analyzer on multiple runners and uploads platform artifacts automatically.

Workflow:

- `.github/workflows/build-binaries.yml`

Current targets:

- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-pc-windows-msvc`

Artifacts:

- one artifact per platform binary
- one combined `sql-helper-platform-bins` artifact

## 📤 Export Formats

### Database export

- `.xlsx`
  one sheet per table
- `.json`
  all tables in one file
- `.csv`
  one file per table in a chosen folder

### Table export

- `.xlsx`
- `.csv`
- `.json`

## 📝 Notes

- SQLite editing is implemented directly against the database file.
- Structural changes rebuild the target table and migrate data into the new definition.
- Saved server-style connections currently store connection metadata, but remote schema/data browsing is not wired yet. 🔌
- Saved connection passwords are currently stored in extension state; moving them to VS Code SecretStorage would be the next hardening step. 🔐

## 🚧 Status

This project already works well as a local SQLite workbench inside VS Code, and its packaging layout is being prepared for proper multi-platform distribution. 🌍
