import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
};

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

const PROFILE_STORAGE_KEY = "sqlHelper.databaseProfiles";
const ACTIVE_PROFILE_KEY = "sqlHelper.activeProfileId";
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sqlHelper.openAnalyzer", async () => {
      const panel = vscode.window.createWebviewPanel("sqlHelperAnalyzer", "SQL Helper", vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
      });

      await configureWebview(context, panel.webview, undefined);
    })
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "sqlHelper.sqliteViewer",
      new SqliteViewerProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );
}

export function deactivate(): void {}

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
        const result = await runAnalyzer(context.extensionPath, message.sql ?? "");
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

async function runAnalyzer(extensionPath: string, sql: string): Promise<AnalysisResult> {
  const analyzerPath = getAnalyzerPath(extensionPath);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(analyzerPath, [], {
      cwd: extensionPath
    });

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
        resolve(output);
        return;
      }

      reject(new Error(errors || `Analyzer exited with code ${code ?? "unknown"}`));
    });

    child.stdin.write(sql);
    child.stdin.end();
  });

  return JSON.parse(stdout) as AnalysisResult;
}

function getAnalyzerPath(extensionPath: string): string {
  const executable = process.platform === "win32" ? "sql-analyzer.exe" : "sql-analyzer";
  return path.join(extensionPath, "bin", executable);
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
