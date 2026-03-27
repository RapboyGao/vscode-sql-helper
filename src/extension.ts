import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
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
  connection?: {
    protocol: string;
    host: string;
    port: string;
    database: string;
    username: string;
    password?: string;
  };
};

type WebviewState = {
  host: "panel" | "sidebar";
  profiles: DatabaseProfile[];
  activeProfileId: string | null;
  selectedTableName: string | null;
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
  | { type: "loadTableData"; tableName?: string; page?: number; search?: string }
  | {
      type: "updateTableRow";
      tableName?: string;
      page?: number;
      search?: string;
      rowKey?: Record<string, unknown>;
      values?: Record<string, unknown>;
    }
  | {
      type: "insertTableRow";
      tableName?: string;
      page?: number;
      search?: string;
      values?: Record<string, unknown>;
    }
  | {
      type: "deleteTableRow";
      tableName?: string;
      page?: number;
      search?: string;
      rowKey?: Record<string, unknown>;
    }
  | {
      type: "applyTableSchema";
      tableName?: string;
      search?: string;
      columns?: ColumnSchemaInput[];
    }
  | { type: "previewTable"; tableName?: string }
  | { type: "previewQuery" }
  | { type: "explainQuery" }
  | { type: "exportDatabase" }
  | { type: "exportTable"; tableName?: string }
  | { type: "openAnalyzer" };

type SaveProfileInput = {
  id?: string;
  name?: string;
  type?: "sqlite" | "generic";
  path?: string;
  connection?: DatabaseProfile["connection"];
};

type SqliteTableColumn = {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
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

type TableDataRow = {
  rowKey: Record<string, unknown>;
  values: Record<string, unknown>;
};

type TableDataPayload = {
  tableName: string;
  page: number;
  pageSize: number;
  totalRows: number;
  keyColumns: string[];
  search: string;
  rows: TableDataRow[];
};

type ColumnSchemaInput = {
  sourceName: string;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
};

type SchemaDocument = {
  text: string;
  tableLines: Map<string, number>;
  columnLines: Map<string, number>;
};

type CachedSchemaEntry = {
  mtimeMs: number;
  schema: SqliteSchema;
};

type PreviewPanelState = {
  title: string;
  databasePath: string;
  sourceSql: string;
  page: number;
  pageSize: number;
  totalRows: number | null;
  rows: Record<string, unknown>[];
  columns: string[];
  warning?: string;
};

type ExportScope = "database" | "table";
type ExportFormat = "xlsx" | "csv" | "json";

const PROFILE_STORAGE_KEY = "sqlHelper.databaseProfiles";
const ACTIVE_PROFILE_KEY = "sqlHelper.activeProfileId";
const SELECTED_TABLE_KEY = "sqlHelper.selectedTableName";
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);
const SCHEMA_SCHEME = "sql-helper-schema";
const QUERY_SCHEME = "sql-helper-query";
const DIAGNOSTIC_TABLE_CODE = "sqlHelper.missingTable";
const DIAGNOSTIC_COLUMN_CODE = "sqlHelper.missingColumn";
const DIAGNOSTIC_DEBOUNCE_MS = 180;
const PREVIEW_PAGE_SIZE = 30;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const ANALYZER_EXECUTABLE = process.platform === "win32" ? "sql-analyzer.exe" : "sql-analyzer";

let sqlHelperDiagnostics: vscode.DiagnosticCollection | null = null;
let sqlHelperQueryProvider: MemoryDocumentProvider | null = null;
let sqlHelperExplorerProvider: SqlHelperExplorerProvider | null = null;
const sqliteSchemaCache = new Map<string, CachedSchemaEntry>();
const parsedDocumentCache = new Map<string, { version: number; parsed: ParsedSql }>();
const diagnosticTimers = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("sqlHelper");
  sqlHelperDiagnostics = diagnostics;
  const schemaProvider = new MemoryDocumentProvider();
  const queryProvider = new MemoryDocumentProvider();
  sqlHelperQueryProvider = queryProvider;
  const explorerProvider = new SqlHelperExplorerProvider(context);
  sqlHelperExplorerProvider = explorerProvider;

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, schemaProvider),
    vscode.workspace.registerTextDocumentContentProvider(QUERY_SCHEME, queryProvider),
    vscode.commands.registerCommand("sqlHelper.openAnalyzer", async () => {
      const panel = vscode.window.createWebviewPanel("sqlHelperAnalyzer", "SQL Helper", vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "app")]
      });

      await configureWebview(context, panel.webview, undefined, "panel");
    }),
    vscode.commands.registerCommand("sqlHelper.addConnection", async () => {
      await promptAndSaveConnection(context);
      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.previewTable", async (tableName?: string) => {
      await previewTable(context, tableName);
    }),
    vscode.commands.registerCommand("sqlHelper.openProfileNode", async (profileIdOrNode?: string | ExplorerNode) => {
      const profile = resolveProfileArgument(context, profileIdOrNode);

      if (!profile || profile.type !== "sqlite") {
        return;
      }

      await context.globalState.update(ACTIVE_PROFILE_KEY, profile.id);
      await context.globalState.update(SELECTED_TABLE_KEY, null);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.file(profile.path),
        "sqlHelper.sqliteViewer",
        {
          viewColumn: vscode.ViewColumn.Active,
          preview: false
        }
      );
      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.openTableNode", async (tableOrNode?: string | ExplorerNode) => {
      const table = resolveTableArgument(tableOrNode);
      const activeProfileId = context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null);
      const activeProfile = activeProfileId
        ? getProfiles(context).find((profile) => profile.id === activeProfileId) ?? null
        : null;

      if (!table || !activeProfile || activeProfile.type !== "sqlite") {
        return;
      }

      await context.globalState.update(SELECTED_TABLE_KEY, table.name);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.file(activeProfile.path),
        "sqlHelper.sqliteViewer",
        {
          viewColumn: vscode.ViewColumn.Active,
          preview: false
        }
      );
    }),
    vscode.commands.registerCommand("sqlHelper.previewQuery", async () => {
      await previewQuery(context);
    }),
    vscode.commands.registerCommand("sqlHelper.explainQuery", async () => {
      await explainQuery(context, queryProvider);
    }),
    vscode.commands.registerCommand("sqlHelper.exportDatabaseNode", async (profileIdOrNode?: string | ExplorerNode) => {
      const profile = resolveProfileArgument(context, profileIdOrNode)
        ?? getProfiles(context).find((profile) => profile.id === context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null))
        ?? null;

      if (!profile || profile.type !== "sqlite") {
        void vscode.window.showWarningMessage("Only SQLite databases can be exported.");
        return;
      }

      await exportSqliteDatabase(profile.path, profile.name);
    }),
    vscode.commands.registerCommand("sqlHelper.exportTableNode", async (tableOrNode?: string | ExplorerNode) => {
      const table = resolveTableArgument(tableOrNode);
      const activeSchema = await getActiveSqliteSchema(context);

      if (!table || !activeSchema) {
        return;
      }

      await exportSqliteTable(activeSchema.path, table.name);
    }),
    vscode.commands.registerCommand("sqlHelper.selectProfileNode", async (profileId?: string) => {
      await context.globalState.update(ACTIVE_PROFILE_KEY, profileId ?? null);
      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.deleteProfileNode", async (profileIdOrNode?: string | ExplorerNode) => {
      const profile = resolveProfileArgument(context, profileIdOrNode);

      if (!profile) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Remove "${profile.name}" from SQL Helper saved databases? The SQLite file itself will not be deleted.`,
        { modal: true },
        "Remove"
      );

      if (confirmed !== "Remove") {
        return;
      }

      const nextProfiles = getProfiles(context).filter((entry) => entry.id !== profile.id);
      await context.globalState.update(PROFILE_STORAGE_KEY, nextProfiles);

      const activeProfileId = context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null);

      if (activeProfileId === profile.id) {
        await context.globalState.update(ACTIVE_PROFILE_KEY, nextProfiles[0]?.id ?? null);
        await context.globalState.update(SELECTED_TABLE_KEY, null);
        await refreshDiagnosticsForOpenSqlDocuments(context);
      }

      await explorerProvider.refresh();
    }),
    vscode.commands.registerCommand("sqlHelper.addTableNode", async (profileIdOrNode?: string | ExplorerNode) => {
      const profile = resolveProfileArgument(context, profileIdOrNode);

      if (!profile) {
        return;
      }

      if (profile.type !== "sqlite") {
        void vscode.window.showWarningMessage("Only SQLite databases support table creation.");
        return;
      }

      const schema = await loadSqliteSchema(profile.path);
      const tableName = await vscode.window.showInputBox({
        title: "Add table",
        prompt: `Create a new table in ${profile.name}`,
        placeHolder: "new_table_name",
        validateInput: (value) => {
          const trimmed = value.trim();

          if (!trimmed) {
            return "Table name is required.";
          }

          if (!/^[a-z_][a-z0-9_]*$/i.test(trimmed)) {
            return "Use a valid SQL identifier.";
          }

          if (schema.tables.some((entry) => entry.name.toLowerCase() === trimmed.toLowerCase())) {
            return "A table with this name already exists.";
          }

          return null;
        }
      });

      if (!tableName) {
        return;
      }

      await runSqliteStatement(
        profile.path,
        `CREATE TABLE ${quoteSqliteIdentifier(tableName.trim())} ("id" INTEGER PRIMARY KEY AUTOINCREMENT);`
      );
      invalidateSchemaCache(profile.path);
      await context.globalState.update(SELECTED_TABLE_KEY, tableName.trim());

      if (context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null) !== profile.id) {
        await context.globalState.update(ACTIVE_PROFILE_KEY, profile.id);
      }

      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.renameTableNode", async (tableOrNode?: string | ExplorerNode) => {
      const table = resolveTableArgument(tableOrNode);
      const activeSchema = await getActiveSqliteSchema(context);

      if (!table || !activeSchema) {
        return;
      }

      const nextName = await vscode.window.showInputBox({
        title: "Rename table",
        prompt: `Rename SQLite table "${table.name}"`,
        value: table.name,
        validateInput: (value) => {
          const trimmed = value.trim();

          if (!trimmed) {
            return "Table name is required.";
          }

          if (!/^[a-z_][a-z0-9_]*$/i.test(trimmed)) {
            return "Use a valid SQL identifier.";
          }

          if (activeSchema.tables.some((entry) => entry.name.toLowerCase() === trimmed.toLowerCase() && entry.name !== table.name)) {
            return "A table with this name already exists.";
          }

          return null;
        }
      });

      if (!nextName || nextName.trim() === table.name) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Rename table "${table.name}" to "${nextName.trim()}" in ${path.basename(activeSchema.path)}?`,
        { modal: true },
        "Rename"
      );

      if (confirmed !== "Rename") {
        return;
      }

      await runSqliteStatement(
        activeSchema.path,
        `ALTER TABLE ${quoteSqliteIdentifier(table.name)} RENAME TO ${quoteSqliteIdentifier(nextName.trim())};`
      );
      if (context.globalState.get<string | null>(SELECTED_TABLE_KEY, null) === table.name) {
        await context.globalState.update(SELECTED_TABLE_KEY, nextName.trim());
      }
      invalidateSchemaCache(activeSchema.path);
      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.deleteTableNode", async (tableOrNode?: string | ExplorerNode) => {
      const table = resolveTableArgument(tableOrNode);
      const activeSchema = await getActiveSqliteSchema(context);

      if (!table || !activeSchema) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete table "${table.name}" from ${path.basename(activeSchema.path)}?`,
        { modal: true },
        "Delete"
      );

      if (confirmed !== "Delete") {
        return;
      }

      await runSqliteStatement(
        activeSchema.path,
        `DROP TABLE ${quoteSqliteIdentifier(table.name)};`
      );
      if (context.globalState.get<string | null>(SELECTED_TABLE_KEY, null) === table.name) {
        await context.globalState.update(SELECTED_TABLE_KEY, null);
      }
      invalidateSchemaCache(activeSchema.path);
      await explorerProvider.refresh();
      await refreshDiagnosticsForOpenSqlDocuments(context);
    }),
    vscode.commands.registerCommand("sqlHelper.refreshExplorer", async () => {
      await explorerProvider.refresh();
    }),
    vscode.window.createTreeView("sqlHelper.explorerView", {
      treeDataProvider: explorerProvider,
      showCollapseAll: true
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
      scheduleDiagnosticsRefresh(context, diagnostics, event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      clearScheduledDiagnostics(document);
      parsedDocumentCache.delete(document.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void explorerProvider.refresh();
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

async function configureWebview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  openedFile: vscode.Uri | undefined,
  host: "panel" | "sidebar"
): Promise<void> {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "app")]
  };
  webview.html = await getWebviewHtml(webview, context.extensionUri);

  webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    if (message.type === "ready") {
      await ensureSqliteProfileForFile(context, openedFile);
      await sqlHelperExplorerProvider?.refresh();
      webview.postMessage({
        type: "init",
        payload: await getWebviewState(context, openedFile, host)
      });
      return;
    }

    if (message.type === "analyze") {
      try {
        const result = await analyzeSqlWithRuntimeBinary(message.sql ?? "");
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
        await sqlHelperExplorerProvider?.refresh();
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
      await sqlHelperExplorerProvider?.refresh();
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

    if (message.type === "loadTableData") {
      try {
        const payload = await loadActiveTableData(
          context,
          message.tableName,
          message.page ?? 0,
          message.search ?? ""
        );
        webview.postMessage({
          type: "tableDataLoaded",
          payload
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "tableDataError", payload: text });
      }
      return;
    }

    if (message.type === "updateTableRow") {
      try {
        const payload = await updateActiveTableRow(
          context,
          message.tableName,
          message.page ?? 0,
          message.search ?? "",
          message.rowKey ?? {},
          message.values ?? {}
        );
        webview.postMessage({
          type: "rowUpdated",
          payload
        });
        await sqlHelperExplorerProvider?.refresh();
        await refreshDiagnosticsForOpenSqlDocuments(context);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "tableDataError", payload: text });
      }
      return;
    }

    if (message.type === "insertTableRow") {
      try {
        const payload = await insertActiveTableRow(
          context,
          message.tableName,
          message.page ?? 0,
          message.search ?? "",
          message.values ?? {}
        );
        webview.postMessage({
          type: "rowInserted",
          payload
        });
        await sqlHelperExplorerProvider?.refresh();
        await refreshDiagnosticsForOpenSqlDocuments(context);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "tableDataError", payload: text });
      }
      return;
    }

    if (message.type === "deleteTableRow") {
      try {
        const payload = await deleteActiveTableRow(
          context,
          message.tableName,
          message.page ?? 0,
          message.search ?? "",
          message.rowKey ?? {}
        );
        webview.postMessage({
          type: "rowDeleted",
          payload
        });
        await sqlHelperExplorerProvider?.refresh();
        await refreshDiagnosticsForOpenSqlDocuments(context);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "tableDataError", payload: text });
      }
      return;
    }

    if (message.type === "applyTableSchema") {
      try {
        const payload = await applyActiveTableSchema(
          context,
          message.tableName,
          message.search ?? "",
          message.columns ?? []
        );
        webview.postMessage({
          type: "tableSchemaApplied",
          payload
        });
        await sqlHelperExplorerProvider?.refresh();
        await refreshDiagnosticsForOpenSqlDocuments(context);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        webview.postMessage({ type: "tableSchemaError", payload: text });
      }
      return;
    }

    if (message.type === "previewTable") {
      await previewTable(context, message.tableName);
      return;
    }

    if (message.type === "previewQuery") {
      await previewQuery(context);
      return;
    }

    if (message.type === "explainQuery") {
      await explainQuery(context, getQueryProvider());
      return;
    }

    if (message.type === "exportDatabase") {
      const activeProfileId = context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null);
      const activeProfile = activeProfileId
        ? getProfiles(context).find((profile) => profile.id === activeProfileId) ?? null
        : null;

      if (!activeProfile || activeProfile.type !== "sqlite") {
        void vscode.window.showWarningMessage("No active SQLite database selected.");
        return;
      }

      await exportSqliteDatabase(activeProfile.path, activeProfile.name);
      return;
    }

    if (message.type === "exportTable") {
      const activeSchema = await getActiveSqliteSchema(context);
      const selectedName = message.tableName ?? context.globalState.get<string | null>(SELECTED_TABLE_KEY, null) ?? undefined;

      if (!activeSchema || !selectedName) {
        void vscode.window.showWarningMessage("No SQLite table selected for export.");
        return;
      }

      await exportSqliteTable(activeSchema.path, selectedName);
      return;
    }

    if (message.type === "openAnalyzer") {
      await vscode.commands.executeCommand("sqlHelper.openAnalyzer");
    }
  });
}

type ExplorerNode =
  | {
      kind: "section";
      id: string;
      label: string;
      description?: string;
    }
  | {
      kind: "profile";
      profile: DatabaseProfile;
      active: boolean;
    }
  | {
      kind: "table";
      table: SqliteTable;
    }
  | {
      kind: "column";
      tableName: string;
      column: SqliteTableColumn;
    }
  | {
      kind: "action";
      id: string;
      label: string;
      command: string;
      icon: string;
      description?: string;
    };

class SqlHelperExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly emitter = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async refresh(): Promise<void> {
    this.emitter.fire();
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    const profiles = getProfiles(this.context);
    const activeProfileId = this.context.globalState.get<string | null>(ACTIVE_PROFILE_KEY, null);
    const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
    const activeSchema = activeProfile?.type === "sqlite" ? await getActiveSqliteSchema(this.context) : null;

    if (!element) {
      return [
        {
          kind: "section",
          id: "active",
          label: "Active Database",
          description: activeProfile?.name ?? "None"
        },
        {
          kind: "section",
          id: "saved",
          label: "Saved Databases",
          description: profiles.length ? `${profiles.length}` : "Empty"
        },
        {
          kind: "action",
          id: "add-connection",
          label: "Add Connection",
          command: "sqlHelper.addConnection",
          icon: "add"
        },
        {
          kind: "action",
          id: "open-analyzer",
          label: "Open Analyzer",
          command: "sqlHelper.openAnalyzer",
          icon: "search-view-icon"
        },
        {
          kind: "action",
          id: "preview-query",
          label: "Preview Current SQL",
          command: "sqlHelper.previewQuery",
          icon: "play"
        },
        {
          kind: "action",
          id: "explain-query",
          label: "Explain Current SQL",
          command: "sqlHelper.explainQuery",
          icon: "symbol-event"
        }
      ];
    }

    if (element.kind === "section" && element.id === "active") {
      if (!activeProfile) {
        return [];
      }

      const nodes: ExplorerNode[] = [
        {
          kind: "profile",
          profile: activeProfile,
          active: true
        }
      ];

      if (activeSchema) {
        nodes.push(
          ...activeSchema.tables.map(
            (table): ExplorerNode => ({ kind: "table", table })
          )
        );
      }

      return nodes;
    }

    if (element.kind === "section" && element.id === "saved") {
      return profiles.map((profile) => ({
        kind: "profile",
        profile,
        active: profile.id === activeProfileId
      }));
    }

    if (element.kind === "table") {
      return element.table.columns.map((column) => ({
        kind: "column",
        tableName: element.table.name,
        column
      }));
    }

    return [];
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    if (element.kind === "section") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = element.id;
      item.description = element.description;
      item.contextValue = "sqlHelper.section";
      return item;
    }

    if (element.kind === "profile") {
      const item = new vscode.TreeItem(
        element.profile.name,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = element.active ? "active" : element.profile.type;
      item.tooltip = element.profile.path;
      item.contextValue = "sqlHelper.profile";
      item.iconPath = new vscode.ThemeIcon(element.profile.type === "sqlite" ? "database" : "symbol-namespace");
      item.command = {
        command: element.profile.type === "sqlite" ? "sqlHelper.openProfileNode" : "sqlHelper.selectProfileNode",
        title: element.profile.type === "sqlite" ? "Open Database" : "Activate Profile",
        arguments: [element]
      };
      return item;
    }

    if (element.kind === "table") {
      const item = new vscode.TreeItem(element.table.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.table.columns.length} cols`;
      item.tooltip = element.table.createSql || element.table.name;
      item.contextValue = "sqlHelper.table";
      item.iconPath = new vscode.ThemeIcon("table");
      item.command = {
        command: "sqlHelper.openTableNode",
        title: "Open Table",
        arguments: [element]
      };
      return item;
    }

    if (element.kind === "column") {
      const item = new vscode.TreeItem(element.column.name, vscode.TreeItemCollapsibleState.None);
      item.description = element.column.type || "TEXT";
      item.contextValue = "sqlHelper.column";
      item.iconPath = new vscode.ThemeIcon(element.column.primaryKey ? "key" : "symbol-field");
      item.tooltip = `${element.tableName}.${element.column.name}`;
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command: element.command,
      title: element.label
    };
    item.description = element.description;
    item.contextValue = "sqlHelper.action";
    item.iconPath = new vscode.ThemeIcon(element.icon);
    return item;
  }
}

function getQueryProvider(): MemoryDocumentProvider {
  if (!sqlHelperQueryProvider) {
    sqlHelperQueryProvider = new MemoryDocumentProvider();
  }

  return sqlHelperQueryProvider;
}

function getParsedDocument(document: vscode.TextDocument): ParsedSql {
  const key = document.uri.toString();
  const cached = parsedDocumentCache.get(key);

  if (cached && cached.version === document.version) {
    return cached.parsed;
  }

  const parsed = parseSql(document.getText());
  parsedDocumentCache.set(key, {
    version: document.version,
    parsed
  });
  return parsed;
}

async function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const distPath = vscode.Uri.joinPath(extensionUri, "dist", "app");
  const htmlRaw = await fs.readFile(distPath.fsPath + "/index.html", "utf8");

  return htmlRaw.replace(/(?:\.\/)?assets\/([^"]+)/g, (_match, assetPath: string) => {
    const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, "assets", assetPath));
    return assetUri.toString();
  });
}

function getProfiles(context: vscode.ExtensionContext): DatabaseProfile[] {
  return context.globalState.get<DatabaseProfile[]>(PROFILE_STORAGE_KEY, []);
}

async function analyzeSqlWithRuntimeBinary(sql: string): Promise<AnalysisResult> {
  const binaryPath = await resolveBundledSqlAnalyzerPath();

  if (!binaryPath) {
    return analyzeSqlText(sql);
  }

  try {
    return await runRustSqlAnalyzer(binaryPath, sql);
  } catch {
    return analyzeSqlText(sql);
  }
}

async function resolveBundledSqlAnalyzerPath(): Promise<string | null> {
  const platformDir = `${process.platform}-${process.arch}`;
  const candidates = [
    path.resolve(__dirname, "..", "bin", platformDir, ANALYZER_EXECUTABLE),
    path.resolve(__dirname, "..", "bin", ANALYZER_EXECUTABLE)
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function runRustSqlAnalyzer(binaryPath: string, sql: string): Promise<AnalysisResult> {
  return new Promise<AnalysisResult>((resolve, reject) => {
    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `sql-analyzer exited with code ${code ?? "unknown"}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as AnalysisResult);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(sql);
  });
}

function resolveProfileArgument(
  context: vscode.ExtensionContext,
  profileIdOrNode?: string | ExplorerNode
): DatabaseProfile | null {
  if (!profileIdOrNode) {
    return null;
  }

  if (typeof profileIdOrNode === "object" && profileIdOrNode.kind === "profile") {
    return profileIdOrNode.profile;
  }

  const profileId = typeof profileIdOrNode === "string" ? profileIdOrNode : null;
  return profileId ? getProfiles(context).find((profile) => profile.id === profileId) ?? null : null;
}

function resolveTableArgument(tableOrNode?: string | ExplorerNode): SqliteTable | null {
  if (!tableOrNode) {
    return null;
  }

  if (typeof tableOrNode === "object" && tableOrNode.kind === "table") {
    return tableOrNode.table;
  }

  if (typeof tableOrNode === "string") {
    return {
      name: tableOrNode,
      createSql: "",
      columns: []
    };
  }

  return null;
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
    selectedTableName: context.globalState.get<string | null>(SELECTED_TABLE_KEY, null),
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
  invalidateSchemaCache(profilePath);
  const current = getProfiles(context);
  const id = input?.id ?? buildProfileId(profilePath);
  const nextProfile: DatabaseProfile = {
    id,
    name,
    type,
    path: profilePath,
    lastUsedAt: new Date().toISOString(),
    connection: input?.connection
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

async function promptAndSaveConnection(context: vscode.ExtensionContext): Promise<void> {
  const target = await vscode.window.showQuickPick(
    [
      {
        label: "SQLite File",
        description: "Choose a local .sqlite/.db file",
        value: "sqlite"
      },
      {
        label: "Server Connection",
        description: "Protocol + host + username/password",
        value: "server"
      }
    ],
    {
      title: "Add Connection",
      placeHolder: "Choose the connection type"
    }
  );

  if (!target) {
    return;
  }

  if (target.value === "sqlite") {
    const file = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Select SQLite Database",
      filters: {
        SQLite: ["sqlite", "sqlite3", "db", "db3"],
        All: ["*"]
      }
    });

    if (!file?.[0]) {
      return;
    }

    const profilePath = file[0].fsPath;
    const profileName = await vscode.window.showInputBox({
      title: "Connection name",
      prompt: "Name for this SQLite connection",
      value: path.basename(profilePath)
    });

    if (!profileName) {
      return;
    }

    await saveProfile(context, {
      name: profileName.trim(),
      type: "sqlite",
      path: profilePath
    });
    return;
  }

  const protocolPick = await vscode.window.showQuickPick(
    [
      { label: "PostgreSQL", value: "postgresql", port: "5432" },
      { label: "MySQL", value: "mysql", port: "3306" },
      { label: "MariaDB", value: "mariadb", port: "3306" },
      { label: "SQL Server", value: "sqlserver", port: "1433" }
    ],
    {
      title: "Server protocol",
      placeHolder: "Choose the database protocol"
    }
  );

  if (!protocolPick) {
    return;
  }

  const host = await promptRequiredInput("Host", "Database server host", "127.0.0.1");
  if (!host) {
    return;
  }

  const port = await vscode.window.showInputBox({
    title: "Port",
    prompt: "Server port",
    value: protocolPick.port
  });
  if (port === undefined) {
    return;
  }

  const database = await promptRequiredInput("Database", "Database name", "");
  if (!database) {
    return;
  }

  const username = await promptRequiredInput("Username", "Username for this connection", "");
  if (!username) {
    return;
  }

  const password = await vscode.window.showInputBox({
    title: "Password",
    prompt: "Password for this connection",
    password: true
  });
  if (password === undefined) {
    return;
  }

  const defaultName = `${database}@${host}`;
  const profileName = await promptRequiredInput("Connection name", "Name for this saved connection", defaultName);
  if (!profileName) {
    return;
  }

  const connection = {
    protocol: protocolPick.value,
    host: host.trim(),
    port: port.trim(),
    database: database.trim(),
    username: username.trim(),
    password
  };

  await saveProfile(context, {
    name: profileName.trim(),
    type: "generic",
    path: buildConnectionTargetString(connection),
    connection
  });
}

async function promptRequiredInput(title: string, prompt: string, value: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    value,
    validateInput: (inputValue) => inputValue.trim() ? null : `${title} is required.`
  });
}

function buildConnectionTargetString(connection: NonNullable<DatabaseProfile["connection"]>): string {
  const authority = connection.port.trim()
    ? `${connection.host.trim()}:${connection.port.trim()}`
    : connection.host.trim();
  const userPrefix = connection.username.trim()
    ? `${connection.username.trim()}@`
    : "";
  return `${connection.protocol}://${userPrefix}${authority}/${connection.database.trim()}`;
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
  const stats = await fs.stat(databasePath);
  const cached = sqliteSchemaCache.get(databasePath);

  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached.schema;
  }

  type SqliteMasterRow = {
    name: string;
    sql: string | null;
  };

  type TableInfoRow = {
    cid: number;
    name: string;
    type: string | null;
    notnull: number;
    pk: number;
    dflt_value: string | null;
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
          cid: column.cid,
          name: column.name,
          type: column.type ?? "",
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
          autoIncrement: isAutoIncrementColumn(table.sql ?? "", column.name),
          defaultValue: column.dflt_value
        }))
      };
    })
  );

  const schema = {
    path: databasePath,
    tableCount: expandedTables.length,
    tables: expandedTables
  };

  sqliteSchemaCache.set(databasePath, {
    mtimeMs: stats.mtimeMs,
    schema
  });

  return schema;
}

function isAutoIncrementColumn(createSql: string, columnName: string): boolean {
  if (!/autoincrement/i.test(createSql)) {
    return false;
  }

  const escapedName = escapeRegExp(columnName);
  const patterns = [
    new RegExp(`["\`]${escapedName}["\`][^,)]*autoincrement`, "i"),
    new RegExp(`\\b${escapedName}\\b[^,)]*autoincrement`, "i")
  ];

  return patterns.some((pattern) => pattern.test(createSql));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runSqliteJson<T>(databasePath: string, sql: string): Promise<T[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("sqlite3", buildSqliteCommandArgs(databasePath, sql, true));
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

      reject(new Error(formatSqliteError(errors, code)));
    });
  });

  return JSON.parse(stdout) as T[];
}

async function runSqliteCount(databasePath: string, sql: string): Promise<number | null> {
  const rows = await runSqliteJson<Record<string, unknown>>(databasePath, sql);
  const value = rows[0] ? Object.values(rows[0])[0] : null;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? count : null;
}

async function loadActiveTableData(
  context: vscode.ExtensionContext,
  requestedTableName: string | undefined,
  requestedPage: number,
  search: string
): Promise<TableDataPayload> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    throw new Error("No active SQLite database selected.");
  }

  const table = resolveRequestedTable(schema, requestedTableName);
  const keyColumns = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const page = Math.max(0, requestedPage);
  const normalizedSearch = search.trim();
  const selectColumns = keyColumns.length > 0
    ? "*"
    : `"rowid" AS "__sqlhelper_rowid__", *`;
  const whereClause = buildTableSearchWhereClause(table.columns, normalizedSearch);
  const rows = await runSqliteJson<Record<string, unknown>>(
    schema.path,
    `SELECT ${selectColumns} FROM ${quoteSqliteIdentifier(table.name)}${whereClause} LIMIT ${PREVIEW_PAGE_SIZE} OFFSET ${page * PREVIEW_PAGE_SIZE};`
  );
  const totalRows = await runSqliteCount(
    schema.path,
    `SELECT COUNT(*) AS total FROM ${quoteSqliteIdentifier(table.name)}${whereClause};`
  );

  return {
    tableName: table.name,
    page,
    pageSize: PREVIEW_PAGE_SIZE,
    totalRows: totalRows ?? rows.length,
    keyColumns: keyColumns.length > 0 ? keyColumns : ["__sqlhelper_rowid__"],
    search: normalizedSearch,
    rows: rows.map((row) => {
      const rowKeySource = keyColumns.length > 0 ? keyColumns : ["__sqlhelper_rowid__"];
      const rowKey = Object.fromEntries(rowKeySource.map((columnName) => [columnName, row[columnName]]));
      const values = { ...row };
      delete values.__sqlhelper_rowid__;
      return {
        rowKey,
        values
      };
    })
  };
}

async function updateActiveTableRow(
  context: vscode.ExtensionContext,
  requestedTableName: string | undefined,
  requestedPage: number,
  search: string,
  rowKey: Record<string, unknown>,
  values: Record<string, unknown>
): Promise<TableDataPayload> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    throw new Error("No active SQLite database selected.");
  }

  const table = resolveRequestedTable(schema, requestedTableName);
  const rowKeyEntries = Object.entries(rowKey);

  if (rowKeyEntries.length === 0) {
    throw new Error("Missing row identity for update.");
  }

  const allowedColumns = new Set(table.columns.map((column) => column.name));
  const updateEntries = Object.entries(values).filter(([columnName]) => allowedColumns.has(columnName));

  if (updateEntries.length === 0) {
    throw new Error("No editable columns provided.");
  }

  const setClause = updateEntries
    .map(([columnName, value]) => `${quoteSqliteIdentifier(columnName)} = ${toSqliteValue(value)}`)
    .join(", ");
  const whereClause = rowKeyEntries
    .map(([columnName, value]) => {
      if (value === null || value === undefined) {
        return columnName === "__sqlhelper_rowid__"
          ? `"rowid" IS NULL`
          : `${quoteSqliteIdentifier(columnName)} IS NULL`;
      }

      return columnName === "__sqlhelper_rowid__"
        ? `"rowid" = ${toSqliteValue(value)}`
        : `${quoteSqliteIdentifier(columnName)} = ${toSqliteValue(value)}`;
    })
    .join(" AND ");

  const changedRows = await runSqliteCount(
    schema.path,
    `UPDATE ${quoteSqliteIdentifier(table.name)} SET ${setClause} WHERE ${whereClause}; SELECT changes() AS changed;`
  );

  if (!changedRows) {
    throw new Error("No rows were updated. The row identity may be stale or the target record no longer exists.");
  }

  invalidateSchemaCache(schema.path);
  return loadActiveTableData(context, table.name, requestedPage, search);
}

async function insertActiveTableRow(
  context: vscode.ExtensionContext,
  requestedTableName: string | undefined,
  requestedPage: number,
  search: string,
  values: Record<string, unknown>
): Promise<TableDataPayload> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    throw new Error("No active SQLite database selected.");
  }

  const table = resolveRequestedTable(schema, requestedTableName);
  const columnMap = new Map(table.columns.map((column) => [column.name, column]));
  const providedEntries = Object.entries(values).filter(([, value]) => value !== undefined);
  const insertEntries = providedEntries
    .filter(([columnName]) => columnMap.has(columnName))
    .flatMap(([columnName, value]) => {
      const column = columnMap.get(columnName);

      if (!column) {
        return [];
      }

      const normalizedValue = typeof value === "string" ? value.trim() : value;
      const isBlankString = normalizedValue === "";
      const isIntegerPrimaryKey = column.primaryKey && /int/i.test(column.type);

      if (isBlankString && isIntegerPrimaryKey) {
        return [];
      }

      if (isBlankString && column.defaultValue !== null) {
        return [];
      }

      return [[columnName, value] as const];
    });

  if (insertEntries.length === 0) {
    await runSqliteStatement(
      schema.path,
      `INSERT INTO ${quoteSqliteIdentifier(table.name)} DEFAULT VALUES;`
    );
  } else {
    const columnSql = insertEntries.map(([columnName]) => quoteSqliteIdentifier(columnName)).join(", ");
    const valueSql = insertEntries.map(([, value]) => toSqliteValue(value)).join(", ");
    await runSqliteStatement(
      schema.path,
      `INSERT INTO ${quoteSqliteIdentifier(table.name)} (${columnSql}) VALUES (${valueSql});`
    );
  }

  invalidateSchemaCache(schema.path);
  return loadActiveTableData(context, table.name, requestedPage, search);
}

async function deleteActiveTableRow(
  context: vscode.ExtensionContext,
  requestedTableName: string | undefined,
  requestedPage: number,
  search: string,
  rowKey: Record<string, unknown>
): Promise<TableDataPayload> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    throw new Error("No active SQLite database selected.");
  }

  const table = resolveRequestedTable(schema, requestedTableName);
  const rowKeyEntries = Object.entries(rowKey);

  if (rowKeyEntries.length === 0) {
    throw new Error("Missing row identity for delete.");
  }

  const whereClause = rowKeyEntries
    .map(([columnName, value]) => {
      if (value === null || value === undefined) {
        return columnName === "__sqlhelper_rowid__"
          ? `"rowid" IS NULL`
          : `${quoteSqliteIdentifier(columnName)} IS NULL`;
      }

      return columnName === "__sqlhelper_rowid__"
        ? `"rowid" = ${toSqliteValue(value)}`
        : `${quoteSqliteIdentifier(columnName)} = ${toSqliteValue(value)}`;
    })
    .join(" AND ");

  await runSqliteStatement(
    schema.path,
    `DELETE FROM ${quoteSqliteIdentifier(table.name)} WHERE ${whereClause};`
  );

  invalidateSchemaCache(schema.path);
  const nextPayload = await loadActiveTableData(context, table.name, requestedPage, search);

  if (requestedPage > 0 && nextPayload.rows.length === 0) {
    return loadActiveTableData(context, table.name, requestedPage - 1, search);
  }

  return nextPayload;
}

async function exportSqliteDatabase(databasePath: string, databaseName: string): Promise<void> {
  const schema = await loadSqliteSchema(databasePath);
  const format = await pickExportFormat("database");

  if (!format) {
    return;
  }

  if (format === "csv") {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Export CSV files here"
    });

    if (!folder?.[0]) {
      return;
    }

    const prefix = await vscode.window.showInputBox({
      title: "CSV file prefix",
      prompt: `Prefix for CSV files exported from ${databaseName}`,
      value: sanitizeFilename(path.parse(databaseName).name)
    });

    if (prefix === undefined) {
      return;
    }

    for (const table of schema.tables) {
      const rows = await loadAllTableRows(databasePath, table.name);
      const csv = rowsToCsv(rows);
      const filename = `${sanitizeFilename(prefix || path.parse(databaseName).name)}-${sanitizeFilename(table.name)}.csv`;
      await fs.writeFile(path.join(folder[0].fsPath, filename), csv, "utf8");
    }

    void vscode.window.showInformationMessage(`Exported ${schema.tables.length} tables to CSV in ${folder[0].fsPath}`);
    return;
  }

  const saveUri = await vscode.window.showSaveDialog({
    saveLabel: format === "xlsx" ? "Export Excel workbook" : "Export JSON",
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(databasePath), `${sanitizeFilename(path.parse(databaseName).name)}.${format}`)
    ),
    filters: format === "xlsx"
      ? { Excel: ["xlsx"] }
      : { JSON: ["json"] }
  });

  if (!saveUri) {
    return;
  }

  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();

    for (const table of schema.tables) {
      const rows = await loadAllTableRows(databasePath, table.name);
      const worksheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(table.name));
    }

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await fs.writeFile(saveUri.fsPath, buffer);
    void vscode.window.showInformationMessage(`Exported database to ${saveUri.fsPath}`);
    return;
  }

  const payload = Object.fromEntries(
    await Promise.all(
      schema.tables.map(async (table) => [table.name, await loadAllTableRows(databasePath, table.name)] as const)
    )
  );
  await fs.writeFile(saveUri.fsPath, JSON.stringify(payload, null, 2), "utf8");
  void vscode.window.showInformationMessage(`Exported database to ${saveUri.fsPath}`);
}

async function exportSqliteTable(databasePath: string, tableName: string): Promise<void> {
  const format = await pickExportFormat("table");

  if (!format) {
    return;
  }

  const defaultName = sanitizeFilename(tableName);
  const saveUri = await vscode.window.showSaveDialog({
    saveLabel: format === "xlsx" ? "Export Excel file" : format === "csv" ? "Export CSV" : "Export JSON",
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(databasePath), `${defaultName}.${format}`)
    ),
    filters:
      format === "xlsx"
        ? { Excel: ["xlsx"] }
        : format === "csv"
          ? { CSV: ["csv"] }
          : { JSON: ["json"] }
  });

  if (!saveUri) {
    return;
  }

  const rows = await loadAllTableRows(databasePath, tableName);

  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(tableName));
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await fs.writeFile(saveUri.fsPath, buffer);
  } else if (format === "csv") {
    await fs.writeFile(saveUri.fsPath, rowsToCsv(rows), "utf8");
  } else {
    await fs.writeFile(saveUri.fsPath, JSON.stringify(rows, null, 2), "utf8");
  }

  void vscode.window.showInformationMessage(`Exported ${tableName} to ${saveUri.fsPath}`);
}

async function pickExportFormat(scope: ExportScope): Promise<ExportFormat | null> {
  const items = scope === "database"
    ? [
        { label: "Excel workbook (.xlsx)", description: "One sheet per table", format: "xlsx" as const },
        { label: "JSON (.json)", description: "All tables in one JSON file", format: "json" as const },
        { label: "CSV files", description: "One CSV file per table in a folder", format: "csv" as const }
      ]
    : [
        { label: "Excel workbook (.xlsx)", description: "Single worksheet export", format: "xlsx" as const },
        { label: "CSV (.csv)", description: "Comma-separated values", format: "csv" as const },
        { label: "JSON (.json)", description: "Array of row objects", format: "json" as const }
      ];

  const picked = await vscode.window.showQuickPick(items, {
    title: scope === "database" ? "Export database as..." : "Export table as...",
    placeHolder: "Choose an export format"
  });

  return picked?.format ?? null;
}

async function loadAllTableRows(databasePath: string, tableName: string): Promise<Record<string, unknown>[]> {
  return runSqliteJson<Record<string, unknown>>(
    databasePath,
    `SELECT * FROM ${quoteSqliteIdentifier(tableName)};`
  );
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  const columnNames = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  if (columnNames.length === 0) {
    return "";
  }

  const header = columnNames.map(escapeCsvCell).join(",");
  const body = rows
    .map((row) => columnNames.map((columnName) => escapeCsvCell(row[columnName])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, "\"\"")}"`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function sanitizeSheetName(value: string): string {
  const sanitized = value.replace(/[\\/?*\[\]:]/g, "_").slice(0, 31);
  return sanitized || "Sheet1";
}

async function applyActiveTableSchema(
  context: vscode.ExtensionContext,
  requestedTableName: string | undefined,
  search: string,
  columns: ColumnSchemaInput[]
): Promise<{ sqliteSchema: SqliteSchema; tableData: TableDataPayload }> {
  const schema = await getActiveSqliteSchema(context);

  if (!schema) {
    throw new Error("No active SQLite database selected.");
  }

  const table = resolveRequestedTable(schema, requestedTableName);
  const normalizedColumns = normalizeColumnSchemaInputs(table, columns);
  const tempTableName = `__sqlhelper_rebuild_${Date.now()}`;
  const createColumnsSql = normalizedColumns.map(toColumnDefinitionSql).join(", ");
  const insertTargetColumns = normalizedColumns.map((column) => quoteSqliteIdentifier(column.name)).join(", ");
  const selectSourceColumns = normalizedColumns
    .map((column) => {
      const sourceExists = table.columns.some((entry) => entry.name === column.sourceName);

      if (!sourceExists) {
        return column.defaultValue ? `${column.defaultValue} AS ${quoteSqliteIdentifier(column.name)}` : `NULL AS ${quoteSqliteIdentifier(column.name)}`;
      }

      return `${quoteSqliteIdentifier(column.sourceName)} AS ${quoteSqliteIdentifier(column.name)}`;
    })
    .join(", ");

  await runSqliteStatement(
    schema.path,
    [
      "BEGIN IMMEDIATE;",
      `ALTER TABLE ${quoteSqliteIdentifier(table.name)} RENAME TO ${quoteSqliteIdentifier(tempTableName)};`,
      `CREATE TABLE ${quoteSqliteIdentifier(table.name)} (${createColumnsSql});`,
      `INSERT INTO ${quoteSqliteIdentifier(table.name)} (${insertTargetColumns}) SELECT ${selectSourceColumns} FROM ${quoteSqliteIdentifier(tempTableName)};`,
      `DROP TABLE ${quoteSqliteIdentifier(tempTableName)};`,
      "COMMIT;"
    ].join(" ")
  );

  invalidateSchemaCache(schema.path);
  const nextSchema = await loadSqliteSchema(schema.path);
  const tableData = await loadActiveTableData(context, table.name, 0, search);
  return {
    sqliteSchema: nextSchema,
    tableData
  };
}

function normalizeColumnSchemaInputs(table: SqliteTable, columns: ColumnSchemaInput[]): ColumnSchemaInput[] {
  if (columns.length === 0) {
    throw new Error("At least one column definition is required.");
  }

  const usedNames = new Set<string>();

  return columns.map((column, index) => {
    const name = column.name.trim();
    const type = column.type.trim().toUpperCase();
    const sourceName = (column.sourceName || table.columns[index]?.name || name).trim();

    if (!name) {
      throw new Error("Column name is required.");
    }

    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`Invalid column name "${name}".`);
    }

    const normalizedName = name.toLowerCase();

    if (usedNames.has(normalizedName)) {
      throw new Error(`Duplicate column name "${name}".`);
    }

    usedNames.add(normalizedName);

    return {
      sourceName,
      name,
      type,
      notNull: Boolean(column.notNull),
      primaryKey: Boolean(column.primaryKey),
      defaultValue: column.defaultValue?.trim() ? column.defaultValue.trim() : null
    };
  });
}

function toColumnDefinitionSql(column: ColumnSchemaInput): string {
  const parts = [quoteSqliteIdentifier(column.name)];

  if (column.type) {
    parts.push(column.type);
  }

  if (column.primaryKey) {
    parts.push("PRIMARY KEY");
  }

  if (column.notNull) {
    parts.push("NOT NULL");
  }

  if (column.defaultValue) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }

  return parts.join(" ");
}

function buildTableSearchWhereClause(columns: SqliteTableColumn[], search: string): string {
  if (!search) {
    return "";
  }

  const pattern = quoteSqliteLiteral(`%${search}%`);
  const conditions = columns.map(
    (column) => `CAST(${quoteSqliteIdentifier(column.name)} AS TEXT) LIKE ${pattern}`
  );

  return conditions.length ? ` WHERE ${conditions.join(" OR ")}` : "";
}

function resolveRequestedTable(schema: SqliteSchema, requestedTableName: string | undefined): SqliteTable {
  const tableName = requestedTableName ?? schema.tables[0]?.name;
  const table = tableName
    ? schema.tables.find((entry) => entry.name.toLowerCase() === tableName.toLowerCase())
    : undefined;

  if (!table) {
    throw new Error("No SQLite table available.");
  }

  return table;
}

async function runSqliteStatement(databasePath: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sqlite3", buildSqliteCommandArgs(databasePath, sql, false));
    let errors = "";

    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(formatSqliteError(errors, code)));
    });
  });
}

function buildSqliteCommandArgs(databasePath: string, sql: string, jsonMode: boolean): string[] {
  return [
    "-cmd",
    `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
    ...(jsonMode ? ["-json"] : []),
    databasePath,
    sql
  ];
}

function formatSqliteError(stderr: string, code: number | null): string {
  const text = stderr.trim();

  if (/database is locked/i.test(text)) {
    return `Database is locked. SQL Helper waited ${SQLITE_BUSY_TIMEOUT_MS}ms but another process still holds the write lock. Close the other writer or retry.`;
  }

  return text || `sqlite3 exited with code ${code ?? "unknown"}`;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function quoteSqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toSqliteValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (typeof value === "object") {
    return quoteSqliteLiteral(JSON.stringify(value));
  }

  return quoteSqliteLiteral(String(value));
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

      const parsed = getParsedDocument(document);
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

      const parsed = getParsedDocument(document);
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
      const parsed = getParsedDocument(document);
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
      const parsed = getParsedDocument(document);
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

      const parsed = getParsedDocument(document);
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

      const parsed = getParsedDocument(document);
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

  const parsed = getParsedDocument(document);
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

  const panel = vscode.window.createWebviewPanel(
    "sqlHelperTablePreview",
    `Preview: ${tableName}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const pageSql = (page: number) =>
    `SELECT * FROM ${quoteSqliteIdentifier(tableName)} LIMIT ${PREVIEW_PAGE_SIZE} OFFSET ${page * PREVIEW_PAGE_SIZE};`;
  const totalRows = await runSqliteCount(
    schema.path,
    `SELECT COUNT(*) AS total FROM ${quoteSqliteIdentifier(tableName)};`
  );

  await openPreviewPanel(panel, {
    title: `Preview: ${tableName}`,
    databasePath: schema.path,
    sourceSql: `SELECT * FROM ${quoteSqliteIdentifier(tableName)};`,
    totalRows,
    loadPage: async (page) => runSqliteJson<Record<string, unknown>>(schema.path, pageSql(page))
  });
}

async function previewQuery(context: vscode.ExtensionContext): Promise<void> {
  await runQueryCommand(context, false);
}

async function explainQuery(context: vscode.ExtensionContext, provider: MemoryDocumentProvider): Promise<void> {
  await runQueryCommand(context, provider, true);
}

async function runQueryCommand(
  context: vscode.ExtensionContext,
  explainOrProvider: boolean | MemoryDocumentProvider,
  maybeExplain?: boolean
): Promise<void> {
  const explain = typeof explainOrProvider === "boolean" ? explainOrProvider : Boolean(maybeExplain);
  const provider = typeof explainOrProvider === "boolean" ? null : explainOrProvider;
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

  if (!explain) {
    const panel = vscode.window.createWebviewPanel(
      "sqlHelperQueryPreview",
      "Query Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS ${quoteSqliteIdentifier("_sql_helper_count")};`;
    const pageSql = (page: number) =>
      `SELECT * FROM (${sql}) AS ${quoteSqliteIdentifier("_sql_helper_preview")} LIMIT ${PREVIEW_PAGE_SIZE} OFFSET ${page * PREVIEW_PAGE_SIZE};`;

    let totalRows: number | null = null;
    let warning: string | undefined;

    try {
      totalRows = await runSqliteCount(schema.path, countSql);
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
    }

    await openPreviewPanel(panel, {
      title: "Query Preview",
      databasePath: schema.path,
      sourceSql: sql,
      totalRows,
      warning,
      loadPage: async (page) => runSqliteJson<Record<string, unknown>>(schema.path, pageSql(page))
    });
    return;
  }

  if (!provider) {
    throw new Error("Explain query requires a document provider.");
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

  const parsed = getParsedDocument(document);
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

function scheduleDiagnosticsRefresh(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
  document: vscode.TextDocument
): void {
  if (document.languageId !== "sql") {
    return;
  }

  clearScheduledDiagnostics(document);
  const key = document.uri.toString();
  const timer = setTimeout(() => {
    diagnosticTimers.delete(key);
    void refreshDiagnosticsForDocument(context, diagnostics, document);
  }, DIAGNOSTIC_DEBOUNCE_MS);
  diagnosticTimers.set(key, timer);
}

function clearScheduledDiagnostics(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const timer = diagnosticTimers.get(key);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  diagnosticTimers.delete(key);
}

function invalidateSchemaCache(databasePath: string): void {
  sqliteSchemaCache.delete(databasePath);
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

async function openPreviewPanel(
  panel: vscode.WebviewPanel,
  options: {
    title: string;
    databasePath: string;
    sourceSql: string;
    totalRows: number | null;
    warning?: string;
    loadPage: (page: number) => Promise<Record<string, unknown>[]>;
  }
): Promise<void> {
  const renderPage = async (page: number) => {
    try {
      const safePage = Math.max(0, page);
      const rows = await options.loadPage(safePage);
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const state: PreviewPanelState = {
        title: options.title,
        databasePath: options.databasePath,
        sourceSql: options.sourceSql,
        page: safePage,
        pageSize: PREVIEW_PAGE_SIZE,
        totalRows: options.totalRows,
        rows,
        columns,
        warning: options.warning
      };
      panel.webview.html = renderPreviewPanelHtml(panel.webview, state);
    } catch (error) {
      const state: PreviewPanelState = {
        title: options.title,
        databasePath: options.databasePath,
        sourceSql: options.sourceSql,
        page: Math.max(0, page),
        pageSize: PREVIEW_PAGE_SIZE,
        totalRows: options.totalRows,
        rows: [],
        columns: [],
        warning: error instanceof Error ? error.message : String(error)
      };
      panel.webview.html = renderPreviewPanelHtml(panel.webview, state);
    }
  };

  panel.webview.onDidReceiveMessage(async (message: { type?: string; page?: number }) => {
    if (message.type !== "page") {
      return;
    }

    await renderPage(message.page ?? 0);
  });

  await renderPage(0);
}

function renderPreviewPanelHtml(webview: vscode.Webview, state: PreviewPanelState): string {
  const totalPages = state.totalRows === null ? null : Math.max(1, Math.ceil(state.totalRows / state.pageSize));
  const canGoPrev = state.page > 0;
  const canGoNext = totalPages === null ? state.rows.length === state.pageSize : state.page + 1 < totalPages;
  const startRow = state.rows.length === 0 ? 0 : state.page * state.pageSize + 1;
  const endRow = state.page * state.pageSize + state.rows.length;
  const nonce = String(Date.now());
  const headerCells = state.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const bodyRows = state.rows.length
    ? state.rows
        .map((row) => {
          const cells = state.columns
            .map((column) => `<td title="${escapeHtml(formatCellValue(row[column]))}">${escapeHtml(formatCellValue(row[column]))}</td>`)
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("")
    : `<tr><td colspan="${Math.max(state.columns.length, 1)}" class="empty-cell">No rows returned on this page.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(state.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 72%, transparent);
      --border: var(--vscode-panel-border);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-focusBorder);
      --badge: color-mix(in srgb, var(--vscode-badge-background) 80%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 18%, transparent), transparent 28%),
        linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, black 8%), var(--bg));
      min-height: 100vh;
    }
    .shell {
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
      padding: 16px;
      min-height: 100vh;
    }
    .card {
      background: var(--panel);
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      border-radius: 14px;
      backdrop-filter: blur(16px);
      overflow: hidden;
    }
    .hero {
      padding: 16px 18px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
    }
    .meta, .warning, .sql {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: var(--badge);
      font-size: 12px;
      white-space: nowrap;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 0 18px 16px;
    }
    button {
      border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
      background: color-mix(in srgb, var(--panel) 82%, transparent);
      color: var(--fg);
      padding: 8px 12px;
      border-radius: 10px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .sql {
      padding: 0 18px 16px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .warning {
      margin: 0 18px 16px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground) 45%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
      color: var(--fg);
    }
    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 220px);
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: color-mix(in srgb, var(--bg) 88%, black 12%);
      text-align: left;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
      border-right: 1px solid color-mix(in srgb, var(--border) 35%, transparent);
      white-space: nowrap;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    tr:nth-child(even) td {
      background: color-mix(in srgb, var(--panel) 55%, transparent);
    }
    .empty-cell {
      text-align: center;
      color: var(--muted);
      padding: 36px 12px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="card">
      <div class="hero">
        <div>
          <h1>${escapeHtml(state.title)}</h1>
          <div class="meta">${escapeHtml(state.databasePath)}</div>
        </div>
        <div class="badge">
          ${state.totalRows === null ? `Page ${state.page + 1}` : `${startRow}-${endRow} / ${state.totalRows}`}
        </div>
      </div>
      <div class="toolbar">
        <button id="prev" ${canGoPrev ? "" : "disabled"}>Previous</button>
        <button id="next" ${canGoNext ? "" : "disabled"}>Next</button>
        <span class="meta">${totalPages === null ? `Page ${state.page + 1}` : `Page ${state.page + 1} of ${totalPages}`}</span>
      </div>
      <div class="sql">${escapeHtml(state.sourceSql)}</div>
      ${state.warning ? `<div class="warning">Count unavailable: ${escapeHtml(state.warning)}</div>` : ""}
    </section>
    <section class="card table-wrap">
      <table>
        <thead><tr>${headerCells || "<th>Result</th>"}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById("prev")?.addEventListener("click", () => vscode.postMessage({ type: "page", page: ${state.page - 1} }));
    document.getElementById("next")?.addEventListener("click", () => vscode.postMessage({ type: "page", page: ${state.page + 1} }));
  </script>
</body>
</html>`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
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
