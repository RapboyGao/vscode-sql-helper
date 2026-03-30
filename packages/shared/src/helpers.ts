import type { ConnectionFormState, DatabaseType, FileConnection, SavedConnection, ServerConnection } from "./types.js";

export const SQLITE_FILE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

export function createEmptyConnectionForm(type: DatabaseType = "sqlite"): ConnectionFormState {
  return {
    kind: type === "sqlite" ? "file" : "server",
    type,
    name: "",
    readonly: false,
    host: "127.0.0.1",
    port: defaultPortForType(type),
    username: "",
    password: "",
    database: "",
    schema: "",
    sslEnabled: false,
    sslRejectUnauthorized: true,
    filePath: ""
  };
}

export function defaultPortForType(type: DatabaseType): number {
  switch (type) {
    case "mysql":
    case "mariadb":
      return 3306;
    case "postgresql":
      return 5432;
    case "sqlserver":
      return 1433;
    case "sqlite":
      return 0;
  }
}

export function isFileConnection(connection: SavedConnection): connection is FileConnection {
  return connection.kind === "file";
}

export function toConnectionForm(connection: SavedConnection, password = ""): ConnectionFormState {
  if (connection.kind === "file") {
    return {
      ...createEmptyConnectionForm(connection.type),
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      readonly: connection.readonly,
      filePath: connection.filePath
    };
  }

  const server = connection as ServerConnection;
  return {
    id: server.id,
    kind: server.kind,
    type: server.type,
    name: server.name,
    readonly: server.readonly,
    host: server.host,
    port: server.port,
    username: server.username,
    password,
    database: server.database ?? "",
    schema: server.schema ?? "",
    sslEnabled: server.ssl?.enabled ?? false,
    sslRejectUnauthorized: server.ssl?.rejectUnauthorized ?? true,
    filePath: ""
  };
}

