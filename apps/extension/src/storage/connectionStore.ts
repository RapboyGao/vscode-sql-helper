import * as vscode from "vscode";
import type { ConnectionFormState, NativeConnectionInput, SavedConnection, ServerConnection } from "@usd/shared";
import { createEmptyConnectionForm, toConnectionForm } from "@usd/shared";
import { createId } from "../utils/id.js";

const CONNECTIONS_KEY = "databaseManager.savedConnections";

export class ConnectionStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public list(): SavedConnection[] {
    return this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []);
  }

  public get(connectionId: string): SavedConnection | undefined {
    return this.list().find((connection) => connection.id === connectionId);
  }

  public async upsert(form: ConnectionFormState): Promise<SavedConnection> {
    const connections = this.list();
    const now = new Date().toISOString();
    const connectionId = form.id ?? createId("connection");
    const passwordRef = form.kind === "server" && form.password ? `db-password:${connectionId}` : undefined;

    const nextConnection: SavedConnection =
      form.kind === "file"
        ? {
            id: connectionId,
            kind: "file",
            type: "sqlite",
            name: form.name || form.filePath.split(/[\\/]/).pop() || "SQLite Database",
            readonly: form.readonly,
            filePath: form.filePath,
            createdAt: connections.find((entry) => entry.id === connectionId)?.createdAt ?? now,
            updatedAt: now
          }
        : {
            id: connectionId,
            kind: "server",
            type: form.type,
            name: form.name,
            readonly: form.readonly,
            host: form.host,
            port: form.port,
            username: form.username,
            passwordRef,
            database: form.database || undefined,
            schema: form.schema || undefined,
            ssl: form.sslEnabled
              ? {
                  enabled: true,
                  rejectUnauthorized: form.sslRejectUnauthorized
                }
              : undefined,
            createdAt: connections.find((entry) => entry.id === connectionId)?.createdAt ?? now,
            updatedAt: now
          };

    if (form.kind === "server" && form.password) {
      await this.context.secrets.store(passwordRef!, form.password);
    }

    const next = [...connections.filter((connection) => connection.id !== connectionId), nextConnection].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    await this.context.globalState.update(CONNECTIONS_KEY, next);
    return nextConnection;
  }

  public async delete(connectionId: string): Promise<void> {
    const existing = this.get(connectionId);
    if (existing?.kind === "server" && existing.passwordRef) {
      await this.context.secrets.delete(existing.passwordRef);
    }

    const next = this.list().filter((connection) => connection.id !== connectionId);
    await this.context.globalState.update(CONNECTIONS_KEY, next);
  }

  public async toForm(connectionId?: string): Promise<ConnectionFormState> {
    if (!connectionId) {
      return createEmptyConnectionForm("sqlite");
    }

    const connection = this.get(connectionId);
    if (!connection) {
      return createEmptyConnectionForm("sqlite");
    }

    const password =
      connection.kind === "server" && connection.passwordRef
        ? await this.context.secrets.get(connection.passwordRef)
        : "";
    return toConnectionForm(connection, password ?? "");
  }

  public async toNativeConnection(connection: SavedConnection): Promise<{
    kind: SavedConnection["kind"];
    type: SavedConnection["type"];
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: string;
    schema?: string;
    ssl?: ServerConnection["ssl"];
    filePath?: string;
  }> {
    if (connection.kind === "file") {
      return {
        kind: "file",
        type: "sqlite",
        filePath: connection.filePath
      };
    }

    return {
      kind: "server",
      type: connection.type,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.passwordRef ? await this.context.secrets.get(connection.passwordRef) ?? "" : "",
      database: connection.database,
      schema: connection.schema,
      ssl: connection.ssl
    };
  }

  public toNativeConnectionFromForm(form: ConnectionFormState): NativeConnectionInput {
    if (form.kind === "file") {
      return {
        kind: "file",
        type: "sqlite",
        filePath: form.filePath
      };
    }

    return {
      kind: "server",
      type: form.type,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
      database: form.database || undefined,
      schema: form.schema || undefined,
      ssl: form.sslEnabled
        ? {
            enabled: true,
            rejectUnauthorized: form.sslRejectUnauthorized
          }
        : undefined
    };
  }
}
