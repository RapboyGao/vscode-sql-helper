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

    if (message.type === "connection/save") {
      const connection = await this.connectionStore.upsert(message.payload);
      await this.logStore.append({
        connectionName: connection.name,
        objectName: connection.name,
        operation: "saveConnection",
        success: true
      });
      this.refreshExplorer();
      await this.postBootstrap(connection.id);
      return;
    }

    if (message.type === "connection/test") {
      const tempConnection = await this.connectionStore.upsert({
        ...message.payload,
        id: message.payload.id ?? undefined
      });
      const response = await this.nativeBridge.call(tempConnection, "testConnection", {});
      await this.panel.webview.postMessage({
        type: "connection/testResult",
        payload: {
          success: response.success,
          message: response.success ? "Connection successful" : response.error?.message ?? "Connection failed"
        }
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    if (message.type === "connection/delete") {
      await this.connectionStore.delete(message.payload.connectionId);
      this.refreshExplorer();
      this.panel.dispose();
    }
  }

  public closeIfConnection(connectionId: string): void {
    if (!this.panel || this.currentConnectionId !== connectionId) {
      return;
    }

    this.panel.dispose();
  }
}
