import * as vscode from "vscode";
import { addSqliteFileConnection } from "../connection/sqliteFileSupport.js";
import { ConnectionStore } from "../storage/connectionStore.js";
import { DatabaseExplorerProvider } from "../explorer/databaseExplorerProvider.js";
import { TableDataPanel } from "./tableDataPanel.js";
import { NativeBridge } from "../native/nativeBridge.js";

class SqliteDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}

  public dispose(): void {}
}

export class SqliteCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<SqliteDocument> {
  public static readonly viewType = "databaseManager.sqliteEditor";

  public constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly explorer: DatabaseExplorerProvider,
    private readonly tablePanel: TableDataPanel,
    private readonly nativeBridge: NativeBridge
  ) {}

  public async openCustomDocument(uri: vscode.Uri): Promise<SqliteDocument> {
    return new SqliteDocument(uri);
  }

  public async resolveCustomEditor(document: SqliteDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    await addSqliteFileConnection(
      document.uri,
      this.connectionStore,
      this.tablePanel,
      this.explorer,
      this.nativeBridge,
      webviewPanel
    );
  }
}

