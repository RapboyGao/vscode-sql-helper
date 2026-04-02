export type ConnectionKind = "server" | "file";
export type DatabaseType = "mysql" | "postgresql" | "sqlite" | "sqlserver" | "mariadb";
export type ConnectionStatus = "idle" | "connected" | "error";

export interface ConnectionBase {
  id: string;
  kind: ConnectionKind;
  type: DatabaseType;
  name: string;
  readonly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerConnection extends ConnectionBase {
  kind: "server";
  host: string;
  port: number;
  username: string;
  passwordRef?: string;
  database?: string;
  schema?: string;
  ssl?: {
    enabled: boolean;
    rejectUnauthorized?: boolean;
  };
}

export interface FileConnection extends ConnectionBase {
  kind: "file";
  filePath: string;
}

export type SavedConnection = ServerConnection | FileConnection;

export interface NativeRequest<TPayload = unknown> {
  requestId: string;
  operation:
    | "testConnection"
    | "listSchemas"
    | "listTables"
    | "describeTable"
    | "queryTableData"
    | "insertRows"
    | "updateRows"
    | "deleteRows"
    | "previewDDL"
    | "applyDDL"
    | "validateSqliteFile";
  connection: NativeConnectionInput;
  readonly?: boolean;
  payload?: TPayload;
}

export interface NativeResponse<TData = unknown> {
  requestId: string;
  success: boolean;
  data?: TData;
  error?: NativeError;
  sqlPreview?: SqlPreview;
  meta?: Record<string, unknown>;
}

export interface NativeError {
  code:
    | "CONNECTION_FAILED"
    | "AUTH_FAILED"
    | "SQLITE_INVALID"
    | "SQLITE_LOCKED"
    | "PERMISSION_DENIED"
    | "UNSUPPORTED"
    | "TIMEOUT"
    | "PLATFORM_BINARY_NOT_FOUND"
    | "READONLY"
    | "UNKNOWN";
  message: string;
  details?: string;
}

export interface NativeConnectionInput {
  kind: ConnectionKind;
  type: DatabaseType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  ssl?: {
    enabled: boolean;
    rejectUnauthorized?: boolean;
  };
  filePath?: string;
}

export interface ExplorerNode {
  id: string;
  kind: "root" | "savedConnections" | "connection" | "schema" | "folder" | "table" | "column";
  label: string;
  connectionId?: string;
  schema?: string;
  table?: string;
  column?: string;
}

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
}

export interface TableSchema {
  schema?: string;
  name: string;
  columns: ColumnSchema[];
  primaryKeys: string[];
}

export interface TableQuery {
  schema?: string;
  table: string;
  page: number;
  pageSize: number;
  orderBy?: {
    column: string;
    direction: "asc" | "desc";
  };
  filters?: Array<{
    column: string;
    operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "startsWith" | "endsWith" | "isNull";
    value?: string;
  }>;
  keyword?: string;
}

export interface TableQueryResult {
  schema?: string;
  table: string;
  page: number;
  pageSize: number;
  totalRows: number;
  rows: Array<Record<string, unknown>>;
  columns: ColumnSchema[];
  primaryKeys: string[];
}

export interface PendingTableInsert {
  kind: "insert";
  tempId: string;
  row: Record<string, unknown>;
}

export interface PendingTableUpdate {
  kind: "update";
  rowKey: string;
  key: Record<string, unknown>;
  originalRow: Record<string, unknown>;
  values: Record<string, unknown>;
}

export interface PendingTableDelete {
  kind: "delete";
  rowKey: string;
  key: Record<string, unknown>;
  row: Record<string, unknown>;
}

export type PendingTableChange = PendingTableInsert | PendingTableUpdate | PendingTableDelete;

export interface SqlPreview {
  title: string;
  statements: string[];
}

export interface OperationLogEntry {
  id: string;
  timestamp: string;
  connectionName: string;
  objectName: string;
  operation: string;
  success: boolean;
  errorMessage?: string;
}

export interface ConnectionFormState {
  id?: string;
  kind: ConnectionKind;
  type: DatabaseType;
  name: string;
  readonly: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  sslEnabled: boolean;
  sslRejectUnauthorized: boolean;
  filePath: string;
}

export interface SchemaListResult {
  schemas: string[];
}

export interface TableListResult {
  schema?: string;
  tables: Array<{ name: string }>;
}

export interface DescribeTableResult {
  schema?: string;
  table: TableSchema;
}

export type DdlAction =
  | "createTable"
  | "renameTable"
  | "deleteTable"
  | "addColumn"
  | "editColumn"
  | "deleteColumn"
  | "renameColumn";

export interface DdlPayload {
  action: DdlAction;
  schema?: string;
  table: string;
  nextTable?: string;
  column?: string;
  nextColumn?: string;
  definition?: Partial<TableSchema>;
}
