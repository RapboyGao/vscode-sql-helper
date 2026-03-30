import * as vscode from "vscode";
import { createEmptyConnectionForm, type DatabaseType } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { DatabaseExplorerProvider } from "../explorer/databaseExplorerProvider.js";
import { ConnectionDetailsPanel } from "../panels/connectionDetailsPanel.js";
import { TableDataPanel } from "../panels/tableDataPanel.js";
import { NativeBridge } from "../native/nativeBridge.js";
import { addSqliteFileConnection } from "../connection/sqliteFileSupport.js";

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionStore: ConnectionStore,
  explorer: DatabaseExplorerProvider,
  connectionPanel: ConnectionDetailsPanel,
  tablePanel: TableDataPanel,
  nativeBridge: NativeBridge
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("extension.addConnection", async () => {
      const typePick = await vscode.window.showQuickPick<{ label: string; value: DatabaseType }>(
        [
          { label: "MySQL", value: "mysql" },
          { label: "PostgreSQL", value: "postgresql" },
          { label: "SQLite", value: "sqlite" }
        ],
        {
        placeHolder: "Select database type"
        }
      );
      const type = typePick?.value;
      if (!type) {
        return;
      }

      const form = createEmptyConnectionForm(type);
      const saved = await connectionStore.upsert({
        ...form,
        name: type === "sqlite" ? "New SQLite Connection" : `New ${type} Connection`
      });
      await connectionPanel.open(saved.id);
      explorer.refresh();
    }),
    vscode.commands.registerCommand("extension.editConnection", async (connectionId?: string) => {
      if (!connectionId) {
        return;
      }
      await connectionPanel.open(connectionId);
    }),
    vscode.commands.registerCommand("extension.removeConnection", async (connectionId?: string) => {
      if (!connectionId) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage("Remove this saved connection?", { modal: true }, "Remove");
      if (confirmed !== "Remove") {
        return;
      }
      await connectionStore.delete(connectionId);
      explorer.refresh();
    }),
    vscode.commands.registerCommand("extension.testConnection", async (connectionId?: string) => {
      const connection = connectionId ? connectionStore.get(connectionId) : undefined;
      if (!connection) {
        return;
      }
      const response = await nativeBridge.call(connection, "testConnection", {});
      if (response.success) {
        void vscode.window.showInformationMessage("Connection successful");
      } else {
        void vscode.window.showErrorMessage(response.error?.message ?? "Connection failed");
      }
    }),
    vscode.commands.registerCommand("extension.refreshExplorer", () => explorer.refresh()),
    vscode.commands.registerCommand("extension.openConnectionDetails", async (connectionId?: string) => {
      if (!connectionId) {
        return;
      }
      await connectionPanel.open(connectionId);
    }),
    vscode.commands.registerCommand("extension.openTableData", async (node?: { connection?: { id: string }; schema?: string; table?: string }) => {
      const connectionId = node?.connection?.id;
      const connection = connectionId ? connectionStore.get(connectionId) : undefined;
      if (!connection) {
        return;
      }
      await tablePanel.open(connection, node?.schema, node?.table);
    }),
    vscode.commands.registerCommand("extension.openSQLiteFile", async () => {
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: {
          SQLite: ["sqlite", "sqlite3", "db", "db3"]
        }
      });
      const fileUri = result?.[0];
      if (!fileUri) {
        return;
      }
      await addSqliteFileConnection(fileUri, connectionStore, tablePanel, explorer, nativeBridge);
    }),
    vscode.commands.registerCommand("extension.addSQLiteFileAsConnection", async (resource?: vscode.Uri) => {
      if (!resource) {
        return;
      }
      await addSqliteFileConnection(resource, connectionStore, tablePanel, explorer, nativeBridge);
    }),
    vscode.commands.registerCommand("extension.createTable", async () => tablePanel),
    vscode.commands.registerCommand("extension.deleteTable", async () => tablePanel),
    vscode.commands.registerCommand("extension.renameTable", async () => tablePanel),
    vscode.commands.registerCommand("extension.addColumn", async () => tablePanel),
    vscode.commands.registerCommand("extension.editColumn", async () => tablePanel),
    vscode.commands.registerCommand("extension.deleteColumn", async () => tablePanel),
    vscode.commands.registerCommand("extension.renameColumn", async () => tablePanel),
    vscode.commands.registerCommand("extension.insertRow", async () => tablePanel),
    vscode.commands.registerCommand("extension.updateRow", async () => tablePanel),
    vscode.commands.registerCommand("extension.deleteRow", async () => tablePanel)
  ];
}
