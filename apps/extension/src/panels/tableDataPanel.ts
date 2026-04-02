import * as vscode from "vscode";
import type {
  DescribeTableResult,
  ExtensionToWebviewMessage,
  PendingTableChange,
  SavedConnection,
  TableQuery,
  WebviewToExtensionMessage
} from "@usd/shared";
import { NativeBridge } from "../native/nativeBridge.js";
import { OperationLogStore } from "../storage/operationLogStore.js";
import { toUserMessage } from "../utils/errors.js";
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

  public closeIfConnection(connectionId: string): void {
    if (!this.panel || !this.connection || this.connection.id !== connectionId) {
      return;
    }

    this.panel.dispose();
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
    const selectedTable = this.selectedTable ?? tablesResponse.data?.tables?.[0]?.name;
    this.selectedSchema = selectedSchema;
    this.selectedTable = selectedTable;
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
      const schemasResponse = await this.nativeBridge.call<Record<string, never>, { schemas: string[] }>(
        this.connection,
        "listSchemas",
        {}
      );

      const tablesResponse = await this.nativeBridge.call<{ schema?: string }, { tables: Array<{ name: string }> }>(
        this.connection,
        "listTables",
        message.payload.schema ? { schema: message.payload.schema } : {}
      );

      if (!message.payload.table) {
        const defaultTable = tablesResponse.success ? tablesResponse.data?.tables?.[0]?.name : undefined;
        if (defaultTable) {
          const nextQuery: TableQuery = {
            ...message.payload,
            table: defaultTable
          };
          this.selectedSchema = message.payload.schema;
          this.selectedTable = defaultTable;

          const response = await this.nativeBridge.call<TableQuery, import("@usd/shared").TableQueryResult>(
            this.connection,
            "queryTableData",
            nextQuery
          );

          const structureResponse = await this.nativeBridge.call<{ schema?: string; table: string }, DescribeTableResult>(
            this.connection,
            "describeTable",
            {
              schema: message.payload.schema,
              table: defaultTable
            }
          );

          await this.panel.webview.postMessage({
            type: "tableData/bootstrap",
            payload: {
              connection: this.connection,
              schemas: {
                schemas: schemasResponse.success ? schemasResponse.data?.schemas ?? [] : []
              },
              tables: {
                schema: message.payload.schema,
                tables: tablesResponse.success ? tablesResponse.data?.tables ?? [] : []
              },
              selectedSchema: message.payload.schema,
              selectedTable: defaultTable,
              query: nextQuery,
              result: response.success ? response.data : undefined,
              structure: structureResponse.success ? structureResponse.data?.table : undefined,
              logs: this.logStore.listForConnection(this.connection.name)
            }
          } satisfies ExtensionToWebviewMessage);
          return;
        }

        await this.panel.webview.postMessage({
          type: "tableData/bootstrap",
          payload: {
            connection: this.connection,
            schemas: {
              schemas: schemasResponse.success ? schemasResponse.data?.schemas ?? [] : []
            },
            tables: {
              schema: message.payload.schema,
              tables: tablesResponse.success ? tablesResponse.data?.tables ?? [] : []
            },
            selectedSchema: message.payload.schema,
            selectedTable: undefined,
            query: message.payload,
            result: undefined,
            structure: undefined,
            logs: this.logStore.listForConnection(this.connection.name)
          }
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      const response = await this.nativeBridge.call<TableQuery, import("@usd/shared").TableQueryResult>(
        this.connection,
        "queryTableData",
        message.payload
      );

      if (response.success && response.data) {
        const structureResponse = await this.nativeBridge.call<{ schema?: string; table: string }, DescribeTableResult>(
          this.connection,
          "describeTable",
          {
            schema: message.payload.schema,
            table: message.payload.table
          }
        );

        await this.panel.webview.postMessage({
          type: "tableData/bootstrap",
          payload: {
            connection: this.connection,
            schemas: {
              schemas: schemasResponse.success ? schemasResponse.data?.schemas ?? [] : []
            },
            tables: {
              schema: message.payload.schema,
              tables: tablesResponse.success ? tablesResponse.data?.tables ?? [] : []
            },
            selectedSchema: message.payload.schema,
            selectedTable: message.payload.table,
            query: message.payload,
            result: response.data,
            structure: structureResponse.success ? structureResponse.data?.table : undefined,
            logs: this.logStore.listForConnection(this.connection.name)
          }
        } satisfies ExtensionToWebviewMessage);
      }
      return;
    }

    if (message.type === "schema/preview" || message.type === "schema/apply") {
      try {
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
          await this.panel.webview.postMessage({
            type: "schema/applied",
            payload: {
              action: message.payload.action,
              table: message.payload.table
            }
          } satisfies ExtensionToWebviewMessage);
          this.refreshExplorer();
          try {
            await this.postBootstrap();
          } catch (error) {
            await this.panel.webview.postMessage({
              type: "ui/error",
              payload: { code: "UNKNOWN", message: toUserMessage(error) }
            } satisfies ExtensionToWebviewMessage);
          }
        }
        return;
      } catch (error) {
        await this.panel.webview.postMessage({
          type: "ui/error",
          payload: { code: "UNKNOWN", message: toUserMessage(error) }
        } satisfies ExtensionToWebviewMessage);
        return;
      }
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

    if (message.type === "tableData/applyChanges") {
      const appliedCount = await this.applyPendingChanges(message.payload.changes, message.payload.schema, message.payload.table);
      await this.panel.webview.postMessage({
        type: "tableData/appliedChanges",
        payload: {
          appliedCount
        }
      } satisfies ExtensionToWebviewMessage);
      await this.postBootstrap();
    }
  }

  private async applyPendingChanges(changes: PendingTableChange[], schema: string | undefined, table: string): Promise<number> {
    if (!this.connection) {
      return 0;
    }

    let appliedCount = 0;

    for (const change of changes) {
      const response =
        change.kind === "insert"
          ? await this.nativeBridge.call(this.connection, "insertRows", {
              schema,
              table,
              rows: [change.row]
            })
          : change.kind === "update"
            ? await this.nativeBridge.call(this.connection, "updateRows", {
                schema,
                table,
                key: change.key,
                values: change.values
              })
            : await this.nativeBridge.call(this.connection, "deleteRows", {
                schema,
                table,
                key: change.key
              });

      if (!response.success) {
        await this.panel?.webview.postMessage({
          type: "ui/error",
          payload: response.error ?? { code: "UNKNOWN", message: "Failed to apply pending changes" }
        } satisfies ExtensionToWebviewMessage);
        break;
      }

      appliedCount += 1;
      await this.logStore.append({
        connectionName: this.connection.name,
        objectName: table,
        operation: change.kind,
        success: true
      });
    }

    return appliedCount;
  }
}
