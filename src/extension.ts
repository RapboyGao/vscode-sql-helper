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
  host: "panel" | "sidebar";
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
  | { type: "refreshSchema" }
  | { type: "previewTable"; tableName?: string }
  | { type: "previewQuery" }
  | { type: "explainQuery" }
  | { type: "openAnalyzer" };

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
const QUERY_SCHEME = "sql-helper-query";
const DIAGNOSTIC_TABLE_CODE = "sqlHelper.missingTable";
const DIAGNOSTIC_COLUMN_CODE = "sqlHelper.missingColumn";

let sqlHelperDiagnostics: vscode.DiagnosticCollection | null = null;
let sqlHelperPreviewProvider: MemoryDocumentProvider | null = null;
let sqlHelperQueryProvider: MemoryDocumentProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("sqlHelper");
  sqlHelperDiagnostics = diagnostics;
  const schemaProvider = new MemoryDocumentProvider();
  const previewProvider = new MemoryDocumentProvider();
  const queryProvider = new MemoryDocumentProvider();
  sqlHelperPreviewProvider = previewProvider;
  sqlHelperQueryProvider = queryProvider;
  const sidebarProvider = new SqlHelperSidebarProvider(context);

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, schemaProvider),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
    vscode.workspace.registerTextDocumentContentProvider(QUERY_SCHEME, queryProvider),
    vscode.commands.registerCommand("sqlHelper.openAnalyzer", async () => {
      const panel = vscode.window.createWebviewPanel("sqlHelperAnalyzer", "SQL Helper", vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
      });

      await configureWebview(context, panel.webview, undefined, "panel");
    }),
    vscode.commands.registerCommand("sqlHelper.previewTable", async (tableName?: string) => {
      await previewTable(context, previewProvider, tableName);
    }),
    vscode.commands.registerCommand("sqlHelper.previewQuery", async () => {
      await previewQuery(context, queryProvider);
    }),
    vscode.commands.registerCommand("sqlHelper.explainQuery", async () => {
      await explainQuery(context, queryProvider);
    }),
    vscode.window.registerWebviewViewProvider("sqlHelper.sidebarView", sidebarProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
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
    vscode.languages.registerReferenceProvider({ language: "sql" }, createReferenceProvider()),
    vscode.languages.registerDocumentHighlightProvider(
      { language: "sql" },
      createDocumentHighlightProvider()
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: "sql" },
      createCodeActionsProvider(context),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.languages.registerRenameProvider({ language: "sql" }, createRenameProvider(context)),
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
    await configureWebview(this.context, webviewPanel.webview, document.uri, "panel");
  }
}

class SqlHelperSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewView.title = "SQL Helper";
    await configureWebview(this.context, webviewView.webview, undefined, "sidebar");
  }
}

async function configureWebview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  openedFile: vscode.Uri | undefined,
  host: "panel" | "sidebar"
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
        payload: await getWebviewState(context, openedFile, host)
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

    if (message.type === "previewTable") {
      await previewTable(context, getPreviewProvider(), message.tableName);
      return;
    }

    if (message.type === "previewQuery") {
      await previewQuery(context, getQueryProvider());
      return;
    }

    if (message.type === "explainQuery") {
      await explainQuery(context, getQueryProvider());
      return;
    }

    if (message.type === "openAnalyzer") {
      await vscode.commands.executeCommand("sqlHelper.openAnalyzer");
    }
  });
}

function getPreviewProvider(): MemoryDocumentProvider {
  if (!sqlHelperPreviewProvider) {
    sqlHelperPreviewProvider = new MemoryDocumentProvider();
  }

  return sqlHelperPreviewProvider;
}

function getQueryProvider(): MemoryDocumentProvider {
  if (!sqlHelperQueryProvider) {
    sqlHelperQueryProvider = new MemoryDocumentProvider();
  }

  return sqlHelperQueryProvider;
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
  openedFile: vscode.Uri | undefined,
  host: "panel" | "sidebar"
): Promise<WebviewState> {
  return {
    host,
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

function createCodeActionsProvider(context: vscode.ExtensionContext): vscode.CodeActionProvider {
  return {
    async provideCodeActions(document, range, actionContext) {
      const schema = await getActiveSqliteSchema(context);

      if (!schema) {
        return [];
      }

      const actions: vscode.CodeAction[] = [];

      for (const diagnostic of actionContext.diagnostics) {
        if (!diagnostic.range.intersection(range)) {
          continue;
        }

        if (diagnostic.code === DIAGNOSTIC_TABLE_CODE) {
          const diagnosticData = diagnostic as vscode.Diagnostic & { data?: { name?: string } };
          const original = typeof diagnosticData.data === "object" && diagnosticData.data && "name" in diagnosticData.data
            ? String(diagnosticData.data.name)
            : "";
          for (const suggestion of findClosestNames(original, schema.tables.map((table) => table.name))) {
            actions.push(createReplacementCodeAction(document, diagnostic, suggestion, `Replace with table "${suggestion}"`));
          }
        }

        if (diagnostic.code === DIAGNOSTIC_COLUMN_CODE) {
          const data = (diagnostic as vscode.Diagnostic & {
            data?: { tableName?: string; columnName?: string };
          }).data;
          const table = schema.tables.find((entry) => entry.name === data?.tableName);

          if (!table) {
            continue;
          }

          for (const suggestion of findClosestNames(data?.columnName ?? "", table.columns.map((column) => column.name))) {
            actions.push(createReplacementCodeAction(document, diagnostic, suggestion, `Replace with column "${suggestion}"`));
          }
        }
      }

      const batchActions = createBatchCodeActions(document, actionContext.diagnostics, schema);
      actions.push(...batchActions);

      return actions;
    }
  };
}

function createReferenceProvider(): vscode.ReferenceProvider {
  return {
    provideReferences(document, position) {
      const parsed = parseSql(document.getText());
      const symbol = resolveSymbolAtPosition(document, parsed, position);

      if (!symbol) {
        return [];
      }

      return findSymbolOccurrences(document, parsed, symbol).map(
        (range) => new vscode.Location(document.uri, range)
      );
    }
  };
}

function createDocumentHighlightProvider(): vscode.DocumentHighlightProvider {
  return {
    provideDocumentHighlights(document, position) {
      const parsed = parseSql(document.getText());
      const symbol = resolveSymbolAtPosition(document, parsed, position);

      if (!symbol) {
        return [];
      }

      return findSymbolOccurrences(document, parsed, symbol).map(
        (range) => new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Read)
      );
    }
  };
}

function createRenameProvider(context: vscode.ExtensionContext): vscode.RenameProvider {
  return {
    async prepareRename(document, position) {
      const schema = await getActiveSqliteSchema(context);

      if (!schema) {
        throw new Error("No active SQLite database selected.");
      }

      const parsed = parseSql(document.getText());
      const token = findTokenAtOffset(parsed, document.offsetAt(position));

      if (!token) {
        throw new Error("Place the cursor on a table or a qualified column.");
      }

      if (token.type === "table") {
        return createRangeFromOffsets(document, token.reference.range);
      }

      return createRangeFromOffsets(document, token.reference.columnRange);
    },
    async provideRenameEdits(document, position, newName) {
      const schema = await getActiveSqliteSchema(context);

      if (!schema) {
        throw new Error("No active SQLite database selected.");
      }

      if (!/^[a-z_][a-z0-9_]*$/i.test(newName)) {
        throw new Error("Use a valid SQL identifier.");
      }

      const text = document.getText();
      const parsed = parseSql(text);
      const symbol = resolveSymbolAtPosition(document, parsed, position);

      if (!symbol) {
        throw new Error("Place the cursor on a table or a qualified column.");
      }

      const edit = new vscode.WorkspaceEdit();

      for (const range of findSymbolOccurrences(document, parsed, symbol)) {
        edit.replace(document.uri, range, newName);
      }

      return edit;
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
    `${PREVIEW_SCHEME}:/${encodeURIComponent(tableName)}.md?db=${encodeURIComponent(schema.path)}`
  );
  provider.set(uri, renderQueryResultDocument(`Preview: ${tableName}`, schema.path, `SELECT * FROM ${tableName} LIMIT 20;`, rows));

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function previewQuery(context: vscode.ExtensionContext, provider: MemoryDocumentProvider): Promise<void> {
  await runQueryCommand(context, provider, false);
}

async function explainQuery(context: vscode.ExtensionContext, provider: MemoryDocumentProvider): Promise<void> {
  await runQueryCommand(context, provider, true);
}

async function runQueryCommand(
  context: vscode.ExtensionContext,
  provider: MemoryDocumentProvider,
  explain: boolean
): Promise<void> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    void vscode.window.showWarningMessage("No active SQLite database selected.");
    return;
  }

  const editor = vscode.window.activeTextEditor;

  if (!editor || editor.document.languageId !== "sql") {
    void vscode.window.showWarningMessage("Open a SQL document first.");
    return;
  }

  const selectedText = editor.document.getText(editor.selection).trim();
  const sql = selectedText || editor.document.getText().trim();

  if (!sql) {
    void vscode.window.showWarningMessage("No SQL text available.");
    return;
  }

  const commandSql = explain ? `EXPLAIN QUERY PLAN ${sql}` : sql;
  const rows = await runSqliteJson<Record<string, unknown>>(schema.path, commandSql);
  const label = explain ? "explain" : "preview";
  const uri = vscode.Uri.parse(
    `${QUERY_SCHEME}:/${label}-${Date.now()}.md?db=${encodeURIComponent(schema.path)}`
  );
  provider.set(uri, renderQueryResultDocument(explain ? "Explain Query Plan" : "Query Preview", schema.path, sql, rows));

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
    if (reference.isCte || parsed.cteNames.includes(reference.tableName)) {
      continue;
    }

    const resolvedName = reference.tableName.toLowerCase();

    if (tableMap.has(resolvedName)) {
      continue;
    }

    items.push(
      withDiagnosticData(
        new vscode.Diagnostic(
        createRangeFromOffsets(document, reference.range),
        `Table "${reference.tableName}" does not exist in the active SQLite database.`,
        vscode.DiagnosticSeverity.Error
        ),
        DIAGNOSTIC_TABLE_CODE,
        { name: reference.tableName }
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

    const diagnostic = withDiagnosticData(
      new vscode.Diagnostic(
        createRangeFromOffsets(document, columnReference.columnRange),
        `Column "${columnReference.columnName}" does not exist on table "${table.name}".`,
        vscode.DiagnosticSeverity.Warning
      ),
      DIAGNOSTIC_COLUMN_CODE,
      {
        tableName: table.name,
        columnName: columnReference.columnName
      }
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

function resolveSymbolAtPosition(
  document: vscode.TextDocument,
  parsed: ParsedSql,
  position: vscode.Position
):
  | { type: "table"; tableName: string }
  | { type: "column"; tableName: string; columnName: string }
  | null {
  const token = findTokenAtOffset(parsed, document.offsetAt(position));

  if (!token) {
    return null;
  }

  if (token.type === "table") {
    return {
      type: "table",
      tableName: token.reference.tableName.toLowerCase()
    };
  }

  const aliases = buildAliasMap(parsed);
  const tableName =
    aliases.get(token.reference.qualifier.toLowerCase()) ?? token.reference.qualifier.toLowerCase();

  return {
    type: "column",
    tableName,
    columnName: token.reference.columnName.toLowerCase()
  };
}

function findSymbolOccurrences(
  document: vscode.TextDocument,
  parsed: ParsedSql,
  symbol:
    | { type: "table"; tableName: string }
    | { type: "column"; tableName: string; columnName: string }
): vscode.Range[] {
  if (symbol.type === "table") {
    const ranges = parsed.tableReferences
      .filter((reference) => reference.tableName.toLowerCase() === symbol.tableName)
      .map((reference) => {
        const start = reference.range.end - reference.tableName.length;
        return createRangeFromOffsets(document, { start, end: reference.range.end });
      });

    for (const columnReference of parsed.columnReferences) {
      if (columnReference.qualifier.toLowerCase() !== symbol.tableName) {
        continue;
      }

      ranges.push(createRangeFromOffsets(document, columnReference.qualifierRange));
    }

    return dedupeRanges(ranges);
  }

  const aliases = buildAliasMap(parsed);
  const ranges = parsed.columnReferences
    .filter((reference) => {
      const resolvedTable =
        aliases.get(reference.qualifier.toLowerCase()) ?? reference.qualifier.toLowerCase();

      return resolvedTable === symbol.tableName && reference.columnName.toLowerCase() === symbol.columnName;
    })
    .map((reference) => createRangeFromOffsets(document, reference.columnRange));

  return dedupeRanges(ranges);
}

function dedupeRanges(ranges: vscode.Range[]): vscode.Range[] {
  const seen = new Set<string>();
  const deduped: vscode.Range[] = [];

  for (const range of ranges) {
    const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(range);
  }

  return deduped;
}

function createBatchCodeActions(
  document: vscode.TextDocument,
  diagnostics: readonly vscode.Diagnostic[],
  schema: SqliteSchema
): vscode.CodeAction[] {
  const tableFixes = new Map<string, string>();
  const columnFixes = new Map<string, string>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.code === DIAGNOSTIC_TABLE_CODE) {
      const data = (diagnostic as vscode.Diagnostic & { data?: { name?: string } }).data;
      const original = data?.name ?? "";
      const suggestion = findClosestNames(original, schema.tables.map((table) => table.name))[0];

      if (original && suggestion) {
        tableFixes.set(original, suggestion);
      }
    }

    if (diagnostic.code === DIAGNOSTIC_COLUMN_CODE) {
      const data = (diagnostic as vscode.Diagnostic & {
        data?: { tableName?: string; columnName?: string };
      }).data;
      const table = schema.tables.find((entry) => entry.name === data?.tableName);
      const suggestion = table
        ? findClosestNames(data?.columnName ?? "", table.columns.map((column) => column.name))[0]
        : undefined;

      if (data?.tableName && data.columnName && suggestion) {
        columnFixes.set(`${data.tableName}.${data.columnName}`, suggestion);
      }
    }
  }

  const actions: vscode.CodeAction[] = [];

  if (tableFixes.size > 0) {
    const action = new vscode.CodeAction("Fix all missing table names", vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [...diagnostics.filter((item) => item.code === DIAGNOSTIC_TABLE_CODE)];

    for (const diagnostic of action.diagnostics) {
      const data = (diagnostic as vscode.Diagnostic & { data?: { name?: string } }).data;
      const replacement = data?.name ? tableFixes.get(data.name) : undefined;

      if (replacement) {
        action.edit.replace(document.uri, diagnostic.range, replacement);
      }
    }

    actions.push(action);
  }

  if (columnFixes.size > 0) {
    const action = new vscode.CodeAction("Fix all missing column names", vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [...diagnostics.filter((item) => item.code === DIAGNOSTIC_COLUMN_CODE)];

    for (const diagnostic of action.diagnostics) {
      const data = (diagnostic as vscode.Diagnostic & {
        data?: { tableName?: string; columnName?: string };
      }).data;
      const key = data?.tableName && data.columnName ? `${data.tableName}.${data.columnName}` : "";
      const replacement = columnFixes.get(key);

      if (replacement) {
        action.edit.replace(document.uri, diagnostic.range, replacement);
      }
    }

    actions.push(action);
  }

  return actions;
}

function withDiagnosticData<T>(
  diagnostic: vscode.Diagnostic,
  code: string,
  data: T
): vscode.Diagnostic & { data: T } {
  diagnostic.code = code;
  (diagnostic as vscode.Diagnostic & { data: T }).data = data;
  return diagnostic as vscode.Diagnostic & { data: T };
}

function createReplacementCodeAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  replacement: string,
  title: string
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(document.uri, diagnostic.range, replacement);
  return action;
}

function findClosestNames(target: string, candidates: string[]): string[] {
  const normalizedTarget = target.toLowerCase();

  return candidates
    .map((candidate) => ({
      candidate,
      score: levenshtein(normalizedTarget, candidate.toLowerCase())
    }))
    .sort((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

function renderQueryResultDocument(
  title: string,
  databasePath: string,
  sql: string,
  rows: Record<string, unknown>[]
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Database: \`${databasePath}\``);
  lines.push("");
  lines.push("```sql");
  lines.push(sql);
  lines.push("```");
  lines.push("");
  lines.push(`Rows: ${rows.length}`);
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No rows returned._");
    return lines.join("\n");
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  lines.push(`| ${columns.join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);

  for (const row of rows.slice(0, 50)) {
    lines.push(`| ${columns.map((column) => escapeMarkdownTableCell(formatCellValue(row[column]))).join(" | ")} |`);
  }

  if (rows.length > 50) {
    lines.push("");
    lines.push(`_Showing first 50 of ${rows.length} rows._`);
  }

  return lines.join("\n");
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function levenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));

  for (let i = 0; i <= left.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}
