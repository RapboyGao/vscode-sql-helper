import * as vscode from "vscode";
import { SQLITE_FILE_EXTENSIONS, createEmptyConnectionForm } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { DatabaseExplorerProvider } from "../explorer/databaseExplorerProvider.js";
import { TableDataPanel } from "../panels/tableDataPanel.js";
import { NativeBridge } from "../native/nativeBridge.js";

export function isSupportedSqliteFile(uri: vscode.Uri): boolean {
  const ext = uri.fsPath.slice(uri.fsPath.lastIndexOf(".")).toLowerCase();
  return SQLITE_FILE_EXTENSIONS.has(ext);
}

export async function addSqliteFileConnection(
  fileUri: vscode.Uri,
  store: ConnectionStore,
  panel: TableDataPanel,
  provider: DatabaseExplorerProvider,
  bridge: NativeBridge,
  targetPanel?: vscode.WebviewPanel
): Promise<void> {
  if (!isSupportedSqliteFile(fileUri)) {
    void vscode.window.showErrorMessage("Selected file is not a supported SQLite database file.");
    return;
  }

  const existingConnection = store
    .list()
    .find((connection) => connection.kind === "file" && connection.filePath === fileUri.fsPath);
  const created = !existingConnection;
  const existing =
    existingConnection ??
    (await store.upsert({
      ...createEmptyConnectionForm("sqlite"),
      name: fileUri.path.split("/").pop() ?? "SQLite Database",
      readonly: true,
      filePath: fileUri.fsPath
    }));

  const validation = await bridge.call(existing, "validateSqliteFile", {});
  if (!validation.success) {
    if (created) {
      await store.delete(existing.id);
    }
    void vscode.window.showErrorMessage(validation.error?.message ?? "SQLite file validation failed.");
    return;
  }

  provider.refresh();
  await panel.open(existing, undefined, undefined, targetPanel, `SQLite: ${existing.name}`);
}
