import * as vscode from "vscode";
import type { SavedConnection } from "@usd/shared";

export type TreeNodeKind = "savedConnections" | "actionAddConnection" | "actionOpenSqlite" | "connection" | "schema" | "tables" | "table" | "column";

export class DatabaseTreeNode extends vscode.TreeItem {
  public constructor(
    public readonly kind: TreeNodeKind,
    public readonly idValue: string,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly connection?: SavedConnection,
    public readonly schema?: string,
    public readonly table?: string
  ) {
    super(label, collapsibleState);
    this.id = idValue;
    this.contextValue = kind === "connection" ? "connection" : kind === "table" ? "table" : kind;
    this.iconPath = iconForKind(kind);
  }
}

function iconForKind(kind: TreeNodeKind): vscode.ThemeIcon {
  switch (kind) {
    case "savedConnections":
      return new vscode.ThemeIcon("server-environment");
    case "actionAddConnection":
      return new vscode.ThemeIcon("add");
    case "actionOpenSqlite":
      return new vscode.ThemeIcon("folder-opened");
    case "connection":
      return new vscode.ThemeIcon("database");
    case "schema":
    case "tables":
      return new vscode.ThemeIcon("folder");
    case "table":
      return new vscode.ThemeIcon("table");
    case "column":
      return new vscode.ThemeIcon("symbol-field");
  }
}
