import * as vscode from "vscode";
import { l10n } from "../l10n/index.js";
import type { SavedConnection } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { DatabaseTreeNode } from "./explorerNodes.js";

export class DatabaseExplorerProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DatabaseTreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly connectionStore: ConnectionStore
  ) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: DatabaseTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    if (!element) {
      return [
        this.createActionNode("actionAddConnection", "add-connection", l10n.t("addConnection", "Add Connection"), "extension.addConnection"),
        this.createActionNode("actionOpenSqlite", "open-sqlite", l10n.t("openSqliteFile", "Open SQLite File"), "extension.openSQLiteFile"),
        new DatabaseTreeNode(
          "savedConnections",
          "saved-connections",
          l10n.t("savedConnections", "Saved Connections"),
          vscode.TreeItemCollapsibleState.Expanded
        )
      ];
    }

    if (element.kind === "savedConnections") {
      return this.connectionStore.list().map((connection) => this.createConnectionNode(connection));
    }

    return [];
  }

  private createConnectionNode(connection: SavedConnection): DatabaseTreeNode {
    const description = connection.kind === "file" ? connection.filePath : `${connection.type}://${connection.host}:${connection.port}`;
    const node = new DatabaseTreeNode(
      "connection",
      connection.id,
      connection.name,
      vscode.TreeItemCollapsibleState.None,
      connection
    );
    node.description = description;
    node.tooltip = description;
    node.accessibilityInformation = {
      label: connection.name,
      role: "treeitem"
    };
    node.command = {
      command: "extension.openTableData",
      title: l10n.t("openDatabase", "Open Database"),
      arguments: [{ connection: { id: connection.id } }]
    };
    return node;
  }

  private createActionNode(
    kind: "actionAddConnection" | "actionOpenSqlite",
    id: string,
    label: string,
    command: string
  ): DatabaseTreeNode {
    const node = new DatabaseTreeNode(kind, id, label, vscode.TreeItemCollapsibleState.None);
    node.actionCommand = command;
    node.tooltip = label;
    node.accessibilityInformation = {
      label,
      role: "button"
    };
    node.command = {
      command,
      title: label
    };
    return node;
  }
}
