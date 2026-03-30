import * as vscode from "vscode";
import type { SavedConnection } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { NativeBridge } from "../native/nativeBridge.js";
import { DatabaseTreeNode } from "./explorerNodes.js";

export class DatabaseExplorerProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DatabaseTreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly nativeBridge: NativeBridge
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
        new DatabaseTreeNode(
          "savedConnections",
          "saved-connections",
          "Saved Connections",
          vscode.TreeItemCollapsibleState.Expanded
        )
      ];
    }

    if (element.kind === "savedConnections") {
      const actionNodes = [
        this.createActionNode("actionAddConnection", "add-connection", "Add Connection", "extension.addConnection"),
        this.createActionNode("actionOpenSqlite", "open-sqlite", "Open SQLite File", "extension.openSQLiteFile")
      ];
      return [...actionNodes, ...this.connectionStore.list().map((connection) => this.createConnectionNode(connection))];
    }

    if (element.kind === "connection" && element.connection) {
      const response = await this.nativeBridge.call<Record<string, never>, { schemas: string[] }>(element.connection, "listSchemas", {});
      const schemas = response.success ? response.data?.schemas ?? [] : [];

      if (!schemas.length) {
        return [new DatabaseTreeNode("tables", `${element.id}-tables`, "Tables", vscode.TreeItemCollapsibleState.Collapsed, element.connection)];
      }

      return schemas.map(
        (schema) => {
          const node = new DatabaseTreeNode(
            "schema",
            `${element.id}-schema-${schema}`,
            schema,
            vscode.TreeItemCollapsibleState.Collapsed,
            element.connection,
            schema
          );
          return node;
        }
      );
    }

    if (element.kind === "schema" && element.connection) {
      const response = await this.nativeBridge.call<{ schema?: string }, { tables: Array<{ name: string }> }>(element.connection, "listTables", { schema: element.schema });
      const tables = response.success ? response.data?.tables ?? [] : [];
      return tables.map(
        (entry: { name: string }) => {
          const node = new DatabaseTreeNode(
            "table",
            `${element.id}-table-${entry.name}`,
            entry.name,
            vscode.TreeItemCollapsibleState.None,
            element.connection,
            element.schema,
            entry.name
          );
          node.command = {
            command: "extension.openTableData",
            title: "Open Table Data",
            arguments: [{ connection: element.connection, schema: element.schema, table: entry.name }]
          };
          return node;
        }
      );
    }

    if (element.kind === "tables" && element.connection) {
      const response = await this.nativeBridge.call<Record<string, never>, { tables: Array<{ name: string }> }>(element.connection, "listTables", {});
      const tables = response.success ? response.data?.tables ?? [] : [];
      return tables.map(
        (entry: { name: string }) => {
          const node = new DatabaseTreeNode(
            "table",
            `${element.id}-table-${entry.name}`,
            entry.name,
            vscode.TreeItemCollapsibleState.None,
            element.connection,
            undefined,
            entry.name
          );
          node.command = {
            command: "extension.openTableData",
            title: "Open Table Data",
            arguments: [{ connection: element.connection, table: entry.name }]
          };
          return node;
        }
      );
    }

    return [];
  }

  private createConnectionNode(connection: SavedConnection): DatabaseTreeNode {
    const description = connection.kind === "file" ? connection.filePath : `${connection.type}://${connection.host}:${connection.port}`;
    const node = new DatabaseTreeNode(
      "connection",
      connection.id,
      connection.name,
      vscode.TreeItemCollapsibleState.Collapsed,
      connection
    );
    node.description = description;
    node.tooltip = description;
    node.command = {
      command: "extension.openConnectionDetails",
      title: "Open Connection Details",
      arguments: [connection.id]
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
    node.command = {
      command,
      title: label
    };
    return node;
  }
}
