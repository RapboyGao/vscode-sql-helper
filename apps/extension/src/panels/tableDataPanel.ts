import * as vscode from "vscode";
import type {
  DescribeTableResult,
  ExtensionToWebviewMessage,
  SavedConnection,
  TableQuery,
  WebviewToExtensionMessage
} from "@usd/shared";
import { NativeBridge } from "../native/nativeBridge.js";
import { OperationLogStore } from "../storage/operationLogStore.js";
import { renderWebviewHtml } from "./webviewHtml.js";

const DEFAULT_QUERY: TableQuery = {
  table: "",
  page: 0,
  pageSize: 50
};

export class TableDataPanel {
  private panel?: vscode.WebviewPanel;
  private connection?: SavedConnection;
  private selectedSchema?: string;
  private selectedTable?: string;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly nativeBridge: NativeBridge,
    private readonly logStore: OperationLogStore,
    private readonly refreshExplorer: () => void
  ) {}

  public async open(
    connection: SavedConnection,
    schema: string | undefined,
    table: string | undefined,
    targetPanel?: vscode.WebviewPanel,
    title?: string
  ): Promise<void> {
    this.connection = connection;
    this.selectedSchema = schema;
    this.selectedTable = table;

    const nextPanel =
      targetPanel ??
      this.panel ??
      vscode.window.createWebviewPanel("databaseManager.tableData", "Table Data", vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "webview")]
      });

    if (nextPanel !== this.panel) {
      this.panel = nextPanel;
      this.panel.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message as WebviewToExtensionMessage);
      });

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = title ?? (table ? `${connection.name}: ${table}` : `${connection.name}: Data`);
    this.panel.webview.html = await renderWebviewHtml(this.panel.webview, this.context.extensionUri, this.panel.title);
    void this.postBootstrap();
    if (!targetPanel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
  }

  private async postBootstrap(): Promise<void> {
    if (!this.panel || !this.connection) {
      return;
    }

    const schemasResponse = await this.nativeBridge.call<Record<string, never>, { schemas: string[] }>(this.connection, "listSchemas", {});
    const selectedSchema = this.selectedSchema ?? schemasResponse.data?.schemas?.[0];
    const tablesResponse = await this.nativeBridge.call<{ schema?: string }, { tables: Array<{ name: string }> }>(
      this.connection,
      "listTables",
      selectedSchema ? { schema: selectedSchema } : {}
    );
    const selectedTable = this.selectedTable;
    const query: TableQuery = {
      ...DEFAULT_QUERY,
      schema: selectedSchema,
      table: selectedTable ?? ""
    };

    const dataResponse =
      selectedTable && query.table
        ? await this.nativeBridge.call<TableQuery, import("@usd/shared").TableQueryResult>(this.connection, "queryTableData", query)
        : undefined;
    const structureResponse =
      selectedTable && query.table
        ? await this.nativeBridge.call<{ schema?: string; table: string }, DescribeTableResult>(this.connection, "describeTable", {
            schema: selectedSchema,
            table: selectedTable
          })
        : undefined;

    const message: ExtensionToWebviewMessage = {
      type: "tableData/bootstrap",
      payload: {
        connection: this.connection,
        schemas: { schemas: schemasResponse.data?.schemas ?? [] },
        tables: {
          schema: selectedSchema,
          tables: tablesResponse.data?.tables ?? []
        },
        selectedSchema,
        selectedTable,
        query,
        result: dataResponse?.data,
        structure: structureResponse?.data?.table,
        logs: this.logStore.listForConnection(this.connection.name)
      }
    };
    await this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    if (!this.panel || !this.connection) {
      return;
    }

    if (message.type === "tableData/query") {
      const response = await this.nativeBridge.call<TableQuery, import("@usd/shared").TableQueryResult>(
        this.connection,
        "queryTableData",
        message.payload
      );
      if (response.success && response.data) {
        await this.panel.webview.postMessage({
          type: "tableData/result",
          payload: {
            query: message.payload,
            result: response.data
          }
        } satisfies ExtensionToWebviewMessage);
      }
      return;
    }

    if (message.type === "schema/preview" || message.type === "schema/apply") {
      const operation = message.type === "schema/preview" ? "previewDDL" : "applyDDL";
      const response = await this.nativeBridge.call(this.connection, operation, message.payload);
      if (!response.success) {
        await this.panel.webview.postMessage({
          type: "ui/error",
          payload: response.error ?? { code: "UNKNOWN", message: "DDL failed" }
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      if (response.sqlPreview) {
        await this.panel.webview.postMessage({
          type: "schema/sqlPreview",
          payload: response.sqlPreview
        } satisfies ExtensionToWebviewMessage);
      }

      if (message.type === "schema/apply") {
        await this.logStore.append({
          connectionName: this.connection.name,
          objectName: message.payload.table,
          operation: message.payload.action,
          success: true
        });
        this.refreshExplorer();
        await this.postBootstrap();
      }
      return;
    }

    if (message.type === "tableData/insert" || message.type === "tableData/update" || message.type === "tableData/delete") {
      const operation = message.type === "tableData/insert" ? "insertRows" : message.type === "tableData/update" ? "updateRows" : "deleteRows";
      const response = await this.nativeBridge.call(this.connection, operation, message.payload);
      if (!response.success) {
        await this.panel.webview.postMessage({
          type: "ui/error",
          payload: response.error ?? { code: "UNKNOWN", message: "Data operation failed" }
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      await this.logStore.append({
        connectionName: this.connection.name,
        objectName: message.payload.table,
        operation,
        success: true
      });
      await this.postBootstrap();
    }
  }
}
