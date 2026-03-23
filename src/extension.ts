import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  analyzeSqlText,
  buildAliasMap,
  findTokenAtOffset,
  parseSql,
  type AnalysisResult,
  type ParsedSql
} from "./sqlParser";

type DatabaseProfile = {
  id: string;
  name: string;
  type: "sqlite" | "generic";
  path: string;
  lastUsedAt: string;
};

type WebviewState = {
  profiles: DatabaseProfile[];
  activeProfileId: string | null;
  openedFile: {
    path: string;
    name: string;
    isSqliteFile: boolean;
  } | null;
  sqliteSchema: SqliteSchema | null;
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "analyze"; sql?: string }
  | { type: "saveProfile"; payload?: SaveProfileInput }
  | { type: "selectProfile"; profileId?: string | null }
  | { type: "refreshSchema" };

type SaveProfileInput = {
  id?: string;
  name?: string;
  type?: "sqlite" | "generic";
  path?: string;
};

type SqliteTableColumn = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
};

type SqliteTable = {
  name: string;
  createSql: string;
  columns: SqliteTableColumn[];
};

type SqliteSchema = {
  path: string;
  tableCount: number;
  tables: SqliteTable[];
};

type SchemaDocument = {
  text: string;
  tableLines: Map<string, number>;
  columnLines: Map<string, number>;
};

const PROFILE_STORAGE_KEY = "sqlHelper.databaseProfiles";
const ACTIVE_PROFILE_KEY = "sqlHelper.activeProfileId";
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);
const SCHEMA_SCHEME = "sql-helper-schema";
const PREVIEW_SCHEME = "sql-helper-preview";

let sqlHelperDiagnostics: vscode.DiagnosticCollection | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("sqlHelper");
  sqlHelperDiagnostics = diagnostics;
  const schemaProvider = new MemoryDocumentProvider();
  const previewProvider = new MemoryDocumentProvider();

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, schemaProvider),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
    vscode.commands.registerCommand("sqlHelper.openAnalyzer", async () => {
      const panel = vscode.window.createWebviewPanel("sqlHelperAnalyzer", "SQL Helper", vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
      });

      await configureWebview(context, panel.webview, undefined);
    }),
    vscode.commands.registerCommand("sqlHelper.previewTable", async (tableName?: string) => {
      await previewTable(context, previewProvider, tableName);
    }),
    vscode.window.registerCustomEditorProvider(
      "sqlHelper.sqliteViewer",
      new SqliteViewerProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: "sql" },
      createSqlCompletionProvider(context),
      "."
    ),
    vscode.languages.registerHoverProvider({ language: "sql" }, createHoverProvider(context)),
    vscode.languages.registerDefinitionProvider(
      { language: "sql" },
      createDefinitionProvider(context, schemaProvider)
    ),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void refreshDiagnosticsForDocument(context, diagnostics, document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void refreshDiagnosticsForDocument(context, diagnostics, event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    void refreshDiagnosticsForDocument(context, diagnostics, document);
  }
}

export function deactivate(): void {}

class MemoryDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly contents = new Map<string, string>();
  onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "No content available.";
  }
}

class SqliteViewerProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => undefined
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.title = `SQL Helper · ${path.basename(document.uri.fsPath)}`;
    await configureWebview(this.context, webviewPanel.webview, document.uri);
  }
}

async function configureWebview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  openedFile: vscode.Uri | undefined
): Promise<void> {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
  };
  webview.html = await getWebviewHtml(webview, context.extensionUri);

  webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    if (message.type === "ready") {
      await ensureSqliteProfileForFile(context, openedFile);
      webview.postMessage({
        type: "init",
        payload: await getWebviewState(context, openedFile)
      });
      return;
    }

    if (message.type === "analyze") {
      try {
        const result = analyzeSqlText(message.sql ?? "");
        webview.postMessage({ type: "analysisResult", payload: result });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "analysisError", payload: text });
      }
      return;
    }

    if (message.type === "saveProfile") {
      try {
        const updated = await saveProfile(context, message.payload);
        webview.postMessage({
          type: "profilesUpdated",
          payload: {
            profiles: updated,
            activeProfileId: context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null),
            sqliteSchema: await getActiveSqliteSchema(context)
          }
        });
        await refreshDiagnosticsForOpenSqlDocuments(context);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "profileError", payload: text });
      }
      return;
    }

    if (message.type === "selectProfile") {
      await context.globalState.update(ACTIVE_PROFILE_KEY, message.profileId ?? null);
      webview.postMessage({
        type: "profilesUpdated",
        payload: {
          profiles: getProfiles(context),
          activeProfileId: context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null),
          sqliteSchema: await getActiveSqliteSchema(context)
        }
      });
      await refreshDiagnosticsForOpenSqlDocuments(context);
      return;
    }

    if (message.type === "refreshSchema") {
      try {
        webview.postMessage({
          type: "schemaLoaded",
          payload: await getActiveSqliteSchema(context)
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "schemaError", payload: text });
      }
    }
  });
}

async function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const distPath = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const htmlRaw = await fs.readFile(distPath.fsPath + "/index.html", "utf8");

  return htmlRaw.replace(/(?:\.\/)?assets\/([^"]+)/g, (_match, assetPath: string) => {
    const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, "assets", assetPath));
    return assetUri.toString();
  });
}

function getProfiles(context: vscode.ExtensionContext): DatabaseProfile[] {
  return context.globalState.get<DatabaseProfile[]>(PROFILE_STORAGE_KEY, []);
}

async function getWebviewState(
  context: vscode.ExtensionContext,
  openedFile: vscode.Uri | undefined
): Promise<WebviewState> {
  return {
    profiles: getProfiles(context),
    activeProfileId: context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null),
    openedFile: openedFile
      ? {
          path: openedFile.fsPath,
          name: path.basename(openedFile.fsPath),
          isSqliteFile: isSqliteFile(openedFile)
        }
      : null,
    sqliteSchema: await getActiveSqliteSchema(context)
  };
}

async function saveProfile(
  context: vscode.ExtensionContext,
  input: SaveProfileInput | undefined
): Promise<DatabaseProfile[]> {
  const name = input?.name?.trim();
  const profilePath = input?.path?.trim();

  if (!name || !profilePath) {
    throw new Error("Profile name and database path are required.");
  }

  const type = input?.type ?? inferProfileType(profilePath);
  const current = getProfiles(context);
  const id = input?.id ?? buildProfileId(profilePath);
  const nextProfile: DatabaseProfile = {
    id,
    name,
    type,
    path: profilePath,
    lastUsedAt: new Date().toISOString()
  };

  const nextProfiles = [nextProfile, ...current.filter((profile) => profile.id !== id)]
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, 12);

  await context.globalState.update(PROFILE_STORAGE_KEY, nextProfiles);
  await context.globalState.update(ACTIVE_PROFILE_KEY, id);
  return nextProfiles;
}

async function ensureSqliteProfileForFile(
  context: vscode.ExtensionContext,
  openedFile: vscode.Uri | undefined
): Promise<void> {
  if (!openedFile || !isSqliteFile(openedFile)) {
    return;
  }

  const profilePath = openedFile.fsPath;
  const id = buildProfileId(profilePath);
  const existing = getProfiles(context).find((profile) => profile.id === id);

  await saveProfile(context, {
    id,
    name: existing?.name ?? path.basename(profilePath),
    type: "sqlite",
    path: profilePath
  });
}

function buildProfileId(profilePath: string): string {
  return Buffer.from(profilePath).toString("base64url");
}

function inferProfileType(profilePath: string): "sqlite" | "generic" {
  return SQLITE_EXTENSIONS.has(path.extname(profilePath).toLowerCase()) ? "sqlite" : "generic";
}

function isSqliteFile(uri: vscode.Uri): boolean {
  return SQLITE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

async function getActiveSqliteSchema(context: vscode.ExtensionContext): Promise<SqliteSchema | null> {
  const activeId = context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null);

  if (!activeId) {
    return null;
  }

  const activeProfile = getProfiles(context).find((profile) => profile.id === activeId);

  if (!activeProfile || activeProfile.type !== "sqlite") {
    return null;
  }

  return loadSqliteSchema(activeProfile.path);
}

async function loadSqliteSchema(databasePath: string): Promise<SqliteSchema> {
  await fs.access(databasePath);

  type SqliteMasterRow = {
    name: string;
    sql: string | null;
  };

  type TableInfoRow = {
    name: string;
    type: string | null;
    notnull: number;
    pk: number;
  };

  const tables = await runSqliteJson<SqliteMasterRow>(
    databasePath,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  );

  const expandedTables = await Promise.all(
    tables.map(async (table) => {
      const columns = await runSqliteJson<TableInfoRow>(
        databasePath,
        `PRAGMA table_info(${quoteSqliteIdentifier(table.name)});`
      );

      return {
        name: table.name,
        createSql: table.sql ?? "",
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type ?? "",
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0
        }))
      };
    })
  );

  return {
    path: databasePath,
    tableCount: expandedTables.length,
    tables: expandedTables
  };
}

async function runSqliteJson<T>(databasePath: string, sql: string): Promise<T[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("sqlite3", ["-json", databasePath, sql]);
    let output = "";
    let errors = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim() || "[]");
        return;
      }

      reject(new Error(errors || `sqlite3 exited with code ${code ?? "unknown"}`));
    });
  });

  return JSON.parse(stdout) as T[];
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function quoteSqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function createSqlCompletionProvider(
  context: vscode.ExtensionContext
): vscode.CompletionItemProvider<vscode.CompletionItem> {
  return {
    provideCompletionItems(document, position) {
      return provideSqlCompletions(context, document, position);
    }
  };
}

function createHoverProvider(context: vscode.ExtensionContext): vscode.HoverProvider {
  return {
    async provideHover(document, position) {
      const schema = await getActiveSqliteSchema(context);

      if (!schema) {
        return null;
      }

      const text = document.getText();
      const parsed = parseSql(text);
      const offset = document.offsetAt(position);
      const token = findTokenAtOffset(parsed, offset);

      if (!token) {
        return null;
      }

      if (token.type === "table") {
        const table = schema.tables.find(
          (entry) => entry.name.toLowerCase() === token.reference.tableName.toLowerCase()
        );

        if (!table) {
          return null;
        }

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        markdown.appendMarkdown(`**${table.name}**  \n`);
        markdown.appendMarkdown(`SQLite table with ${table.columns.length} columns.  \n\n`);
        markdown.appendMarkdown(
          table.columns
            .slice(0, 8)
            .map((column) => `- \`${column.name}\` ${column.type || "TEXT"}`)
            .join("\n")
        );
        markdown.appendMarkdown("\n\n");
        markdown.appendMarkdown(
          `[Preview rows](command:sqlHelper.previewTable?${encodeURIComponent(JSON.stringify([table.name]))})`
        );
        return new vscode.Hover(markdown, createRangeFromOffsets(document, token.reference.range));
      }

      const aliases = buildAliasMap(parsed);
      const tableName =
        aliases.get(token.reference.qualifier.toLowerCase()) ?? token.reference.qualifier.toLowerCase();
      const table = schema.tables.find((entry) => entry.name.toLowerCase() === tableName);

      if (!table) {
        return null;
      }

      const column = table.columns.find(
        (entry) => entry.name.toLowerCase() === token.reference.columnName.toLowerCase()
      );

      if (!column) {
        return null;
      }

      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${table.name}.${column.name}**  \n`);
      markdown.appendMarkdown(`${column.type || "TEXT"}  \n`);
      markdown.appendMarkdown(column.primaryKey ? "Primary key  \n" : "");
      markdown.appendMarkdown(column.notNull ? "Not null" : "Nullable");
      return new vscode.Hover(markdown, createRangeFromOffsets(document, token.reference.columnRange));
    }
  };
}

function createDefinitionProvider(
  context: vscode.ExtensionContext,
  provider: MemoryDocumentProvider
): vscode.DefinitionProvider {
  return {
    async provideDefinition(document, position) {
      const schema = await getActiveSqliteSchema(context);

      if (!schema) {
        return null;
      }

      const parsed = parseSql(document.getText());
      const token = findTokenAtOffset(parsed, document.offsetAt(position));

      if (!token) {
        return null;
      }

      const schemaDoc = buildSchemaDocument(schema);
      const uri = vscode.Uri.parse(`${SCHEMA_SCHEME}:/${encodeURIComponent(path.basename(schema.path))}.sql`);
      provider.set(uri, schemaDoc.text);

      if (token.type === "table") {
        const line = schemaDoc.tableLines.get(token.reference.tableName.toLowerCase()) ?? 0;
        const targetRange = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0));
        return new vscode.Location(uri, targetRange);
      }

      const aliases = buildAliasMap(parsed);
      const tableName =
        aliases.get(token.reference.qualifier.toLowerCase()) ?? token.reference.qualifier.toLowerCase();
      const key = `${tableName.toLowerCase()}.${token.reference.columnName.toLowerCase()}`;
      const line = schemaDoc.columnLines.get(key) ?? schemaDoc.tableLines.get(tableName.toLowerCase()) ?? 0;
      const targetRange = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0));
      return new vscode.Location(uri, targetRange);
    }
  };
}

async function provideSqlCompletions(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.CompletionItem[]> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    return [];
  }

  const text = document.getText();
  const parsed = parseSql(text);
  const aliases = buildAliasMap(parsed);
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const dotMatch = linePrefix.match(/([a-z_][a-z0-9_]*)\.$/i);

  if (dotMatch) {
    const qualifier = dotMatch[1].toLowerCase();
    const tableName = aliases.get(qualifier) ?? qualifier;
    const table = schema.tables.find((entry) => entry.name.toLowerCase() === tableName);

    if (!table) {
      return [];
    }

    return table.columns.map((column) => toColumnCompletionItem(table, column));
  }

  const keywordContext = linePrefix.match(/\b(from|join|update|into|table)\s+[a-z_0-9]*$/i);

  if (keywordContext) {
    return schema.tables.map(toTableCompletionItem);
  }

  const matchedTableNames = new Set(parsed.tableReferences.map((reference) => reference.tableName.toLowerCase()));
  const preferredTables = schema.tables.filter((table) => matchedTableNames.has(table.name.toLowerCase()));
  const sourceTables = preferredTables.length ? preferredTables : schema.tables;
  const items = schema.tables.map(toTableCompletionItem);

  for (const table of sourceTables) {
    for (const column of table.columns) {
      items.push(toColumnCompletionItem(table, column));
    }
  }

  return items;
}

function toTableCompletionItem(table: SqliteTable): vscode.CompletionItem {
  const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Struct);
  item.detail = `SQLite table · ${table.columns.length} columns`;
  return item;
}

function toColumnCompletionItem(table: SqliteTable, column: SqliteTableColumn): vscode.CompletionItem {
  const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
  item.detail = [table.name, column.type || "TEXT"].filter(Boolean).join(" · ");
  item.insertText = column.name;
  return item;
}

async function previewTable(
  context: vscode.ExtensionContext,
  provider: MemoryDocumentProvider,
  explicitTableName?: string
): Promise<void> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    void vscode.window.showWarningMessage("No active SQLite database selected.");
    return;
  }

  const tableName =
    explicitTableName ??
    (await vscode.window.showQuickPick(schema.tables.map((table) => table.name), {
      title: "Preview SQLite Table"
    }));

  if (!tableName) {
    return;
  }

  const rows = await runSqliteJson<Record<string, unknown>>(
    schema.path,
    `SELECT * FROM ${quoteSqliteIdentifier(tableName)} LIMIT 20;`
  );
  const uri = vscode.Uri.parse(
    `${PREVIEW_SCHEME}:/${encodeURIComponent(tableName)}.json?db=${encodeURIComponent(schema.path)}`
  );
  provider.set(uri, JSON.stringify(rows, null, 2));

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function refreshDiagnosticsForOpenSqlDocuments(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = getSqlHelperDiagnosticCollection();

  for (const document of vscode.workspace.textDocuments) {
    await refreshDiagnosticsForDocument(context, diagnostics, document);
  }
}

function getSqlHelperDiagnosticCollection(): vscode.DiagnosticCollection {
  if (!sqlHelperDiagnostics) {
    sqlHelperDiagnostics = vscode.languages.createDiagnosticCollection("sqlHelper");
  }

  return sqlHelperDiagnostics;
}

async function refreshDiagnosticsForDocument(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
  document: vscode.TextDocument
): Promise<void> {
  if (document.languageId !== "sql") {
    return;
  }

  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    diagnostics.delete(document.uri);
    return;
  }

  const parsed = parseSql(document.getText());
  const aliases = buildAliasMap(parsed);
  const tableMap = new Map(schema.tables.map((table) => [table.name.toLowerCase(), table]));
  const items: vscode.Diagnostic[] = [];

  for (const reference of parsed.tableReferences) {
    const resolvedName = reference.tableName.toLowerCase();

    if (tableMap.has(resolvedName)) {
      continue;
    }

    items.push(
      new vscode.Diagnostic(
        createRangeFromOffsets(document, reference.range),
        `Table "${reference.tableName}" does not exist in the active SQLite database.`,
        vscode.DiagnosticSeverity.Error
      )
    );
  }

  for (const columnReference of parsed.columnReferences) {
    const resolvedTable =
      aliases.get(columnReference.qualifier.toLowerCase()) ?? columnReference.qualifier.toLowerCase();
    const table = tableMap.get(resolvedTable);

    if (!table) {
      continue;
    }

    const hasColumn = table.columns.some(
      (column) => column.name.toLowerCase() === columnReference.columnName.toLowerCase()
    );

    if (hasColumn) {
      continue;
    }

    const diagnostic = new vscode.Diagnostic(
      createRangeFromOffsets(document, columnReference.columnRange),
      `Column "${columnReference.columnName}" does not exist on table "${table.name}".`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.relatedInformation = [
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(document.uri, createRangeFromOffsets(document, columnReference.qualifierRange)),
        `Resolved from qualifier "${columnReference.qualifier}".`
      )
    ];
    items.push(diagnostic);
  }

  diagnostics.set(document.uri, items);
}

function buildSchemaDocument(schema: SqliteSchema): SchemaDocument {
  const lines: string[] = [];
  const tableLines = new Map<string, number>();
  const columnLines = new Map<string, number>();

  lines.push(`-- SQLite schema: ${schema.path}`);
  lines.push("");

  for (const table of schema.tables) {
    tableLines.set(table.name.toLowerCase(), lines.length);
    lines.push(`TABLE ${table.name}`);

    for (const column of table.columns) {
      columnLines.set(`${table.name.toLowerCase()}.${column.name.toLowerCase()}`, lines.length);
      lines.push(
        `  ${column.name} ${column.type || "TEXT"}${column.primaryKey ? " PRIMARY KEY" : ""}${
          column.notNull ? " NOT NULL" : ""
        }`
      );
    }

    if (table.createSql) {
      lines.push("");
      lines.push(table.createSql);
    }

    lines.push("");
  }

  return {
    text: lines.join("\n"),
    tableLines,
    columnLines
  };
}

function createRangeFromOffsets(document: vscode.TextDocument, range: { start: number; end: number }): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}
