import * as vscode from "vscode";
import { l10n } from "../l10n/index.js";
import { createEmptyConnectionForm, type DatabaseType } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { DatabaseExplorerProvider } from "../explorer/databaseExplorerProvider.js";
import { ConnectionDetailsPanel } from "../panels/connectionDetailsPanel.js";
import { TableDataPanel } from "../panels/tableDataPanel.js";
import { NativeBridge } from "../native/nativeBridge.js";
import { addSqliteFileConnection } from "../connection/sqliteFileSupport.js";
import type { DatabaseTreeNode } from "../explorer/explorerNodes.js";

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
          { label: l10n.t("databaseType.mysql", "MySQL"), value: "mysql" },
          { label: l10n.t("databaseType.postgresql", "PostgreSQL"), value: "postgresql" },
          { label: l10n.t("databaseType.sqlite", "SQLite"), value: "sqlite" }
        ],
        {
        placeHolder: l10n.t("selectDatabaseType", "Select database type")
        }
      );
      const type = typePick?.value;
      if (!type) {
        return;
      }

      const form = createEmptyConnectionForm(type);
      const saved = await connectionStore.upsert({
        ...form,
        name: type === "sqlite" ? l10n.t("New SQLite Connection") : l10n.t(`New ${type} Connection`)
      });
      await connectionPanel.open(saved.id);
      explorer.refresh();
    }),
    vscode.commands.registerCommand("extension.editConnection", async (arg?: string | DatabaseTreeNode) => {
      const connectionId = resolveConnectionId(arg);
      if (!connectionId) {
        return;
      }
      await connectionPanel.open(connectionId);
    }),
    vscode.commands.registerCommand("extension.removeConnection", async (arg?: string | DatabaseTreeNode) => {
      const connectionId = resolveConnectionId(arg);
      if (!connectionId) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(l10n.t("removeConnectionWarning", "Remove this saved connection?"), { modal: true }, l10n.t("removeButton", "Remove"));
      if (confirmed !== l10n.t("removeButton", "Remove")) {
        return;
      }
      await connectionStore.delete(connectionId);
      connectionPanel.closeIfConnection(connectionId);
      tablePanel.closeIfConnection(connectionId);
      explorer.refresh();
    }),
    vscode.commands.registerCommand("extension.testConnection", async (arg?: string | DatabaseTreeNode) => {
      const connectionId = resolveConnectionId(arg);
      const connection = connectionId ? connectionStore.get(connectionId) : undefined;
      if (!connection) {
        return;
      }
      const response = await nativeBridge.call(connection, "testConnection", {});
      if (response.success) {
        void vscode.window.showInformationMessage(l10n.t("connectionSuccessful", "Connection successful"));
      } else {
        void vscode.window.showErrorMessage(response.error?.message ?? l10n.t("connectionFailed", "Connection failed"));
      }
    }),
    vscode.commands.registerCommand("extension.refreshExplorer", () => explorer.refresh()),
    vscode.commands.registerCommand("extension.openConnectionDetails", async (arg?: string | DatabaseTreeNode) => {
      const connectionId = resolveConnectionId(arg);
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

function resolveConnectionId(arg?: string | DatabaseTreeNode): string | undefined {
  if (!arg) {
    return undefined;
  }

  if (typeof arg === "string") {
    return arg;
  }

  return arg.connection?.id ?? (arg.kind === "connection" ? arg.idValue : undefined);
}
