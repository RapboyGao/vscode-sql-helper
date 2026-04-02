import * as vscode from "vscode";
import { ConnectionStore } from "./storage/connectionStore.js";
import { OperationLogStore } from "./storage/operationLogStore.js";
import { NativeBridge } from "./native/nativeBridge.js";
import { DatabaseExplorerProvider } from "./explorer/databaseExplorerProvider.js";
import { ConnectionDetailsPanel } from "./panels/connectionDetailsPanel.js";
import { TableDataPanel } from "./panels/tableDataPanel.js";
import { SqliteCustomEditorProvider } from "./panels/sqliteCustomEditorProvider.js";
import { registerCommands } from "./commands/registerCommands.js";

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);
  const logStore = new OperationLogStore(context);
  const nativeBridge = new NativeBridge(context, connectionStore);
  const output = vscode.window.createOutputChannel("Universal SQL Database Manager");
  const explorer = new DatabaseExplorerProvider(connectionStore);
  const connectionPanel = new ConnectionDetailsPanel(context, connectionStore, logStore, nativeBridge, () => explorer.refresh());
  const tablePanel = new TableDataPanel(context, nativeBridge, logStore, () => explorer.refresh(), output);

  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("databaseManager.savedConnections", explorer),
    vscode.window.registerCustomEditorProvider(
      SqliteCustomEditorProvider.viewType,
      new SqliteCustomEditorProvider(context, connectionStore, explorer, tablePanel, nativeBridge),
      {
        supportsMultipleEditorsPerDocument: false
      }
    ),
    ...registerCommands(context, connectionStore, explorer, connectionPanel, tablePanel, nativeBridge)
  );
}

export function deactivate(): void {}
