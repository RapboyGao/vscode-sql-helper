import * as vscode from "vscode";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "@usd/shared";
import { ConnectionStore } from "../storage/connectionStore.js";
import { OperationLogStore } from "../storage/operationLogStore.js";
import { NativeBridge } from "../native/nativeBridge.js";
import { renderWebviewHtml } from "./webviewHtml.js";

export class ConnectionDetailsPanel {
  public static readonly viewType = "databaseManager.connectionDetails";
  private panel?: vscode.WebviewPanel;
  private currentConnectionId?: string;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly logStore: OperationLogStore,
    private readonly nativeBridge: NativeBridge,
    private readonly refreshExplorer: () => void
  ) {}

  public async open(connectionId: string): Promise<void> {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) {
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        ConnectionDetailsPanel.viewType,
        `Connection: ${connection.name}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "webview")]
        }
      );

      this.panel.onDidDispose(() => {
        this.currentConnectionId = undefined;
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message as WebviewToExtensionMessage);
      });
    }

    this.currentConnectionId = connection.id;
    this.panel.title = `Connection: ${connection.name}`;
    this.panel.webview.html = await renderWebviewHtml(this.panel.webview, this.context.extensionUri, connection.name);
    await this.postBootstrap(connection.id);
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  private async postBootstrap(connectionId: string): Promise<void> {
    const connection = this.connectionStore.get(connectionId);
    if (!connection || !this.panel) {
      return;
    }

    const form = await this.connectionStore.toForm(connection.id);
    const message: ExtensionToWebviewMessage = {
      type: "connection/bootstrap",
      payload: {
        connection,
        form,
        logs: this.logStore.listForConnection(connection.name)
      }
    };
    this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      if (message.type === "connection/save") {
        const savedConnection = await this.connectionStore.upsert(message.payload);
        const connection = this.connectionStore.get(savedConnection.id);
        if (!connection) {
          throw new Error("Connection save could not be verified");
        }

        const form = await this.connectionStore.toForm(connection.id);
        if (form.readonly !== message.payload.readonly) {
          throw new Error("Connection save did not persist the latest readonly setting");
        }

        this.currentConnectionId = connection.id;
        this.panel.title = `Connection: ${connection.name}`;
        await this.panel.webview.postMessage({
          type: "connection/saved",
          payload: {
            connection,
            form
          }
        } satisfies ExtensionToWebviewMessage);
        void this.logStore.append({
          connectionName: connection.name,
          objectName: connection.name,
          operation: "saveConnection",
          success: true
        });
        this.refreshExplorer();
        return;
      }

      if (message.type === "connection/test") {
        const response = await this.nativeBridge.callWithInput(
          this.connectionStore.toNativeConnectionFromForm(message.payload),
          message.payload.readonly,
          "testConnection",
          {}
        );
        await this.panel.webview.postMessage({
          type: "connection/testResult",
          payload: {
            success: response.success,
            message: response.success ? "Connection successful" : response.error?.message ?? "Connection failed"
          }
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      if (message.type === "connection/pickFile") {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: message.payload.filters ?? {
            SQLite: ["sqlite", "sqlite3", "db", "db3"],
            All: ["*"]
          }
        });
        const fileUri = result?.[0];
        if (!fileUri) {
          return;
        }

        await this.panel.webview.postMessage({
          type: "connection/filePicked",
          payload: {
            filePath: fileUri.fsPath
          }
        } satisfies ExtensionToWebviewMessage);
        return;
      }

      if (message.type === "connection/delete") {
        await this.connectionStore.delete(message.payload.connectionId);
        this.refreshExplorer();
        this.panel.dispose();
      }
    } catch (error) {
      await this.panel.webview.postMessage({
        type: "ui/error",
        payload: {
          code: "UNKNOWN",
          message: error instanceof Error ? error.message : "Connection operation failed"
        }
      } satisfies ExtensionToWebviewMessage);
    }
  }

  public closeIfConnection(connectionId: string): void {
    if (!this.panel || this.currentConnectionId !== connectionId) {
      return;
    }

    this.panel.dispose();
  }
}
