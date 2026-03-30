import type {
  ConnectionFormState,
  DescribeTableResult,
  NativeError,
  OperationLogEntry,
  PendingTableChange,
  SavedConnection,
  SchemaListResult,
  SqlPreview,
  TableListResult,
  TableQuery,
  TableQueryResult,
  TableSchema
} from "./types.js";

export type WebviewReadyMessage = { type: "ui/ready" };

export type ExtensionToWebviewMessage =
  | {
      type: "connection/bootstrap";
      payload: {
        connection: SavedConnection;
        form: ConnectionFormState;
        logs: OperationLogEntry[];
      };
    }
  | {
      type: "connection/saved";
      payload: {
        connection: SavedConnection;
        form: ConnectionFormState;
      };
    }
  | {
      type: "connection/testResult";
      payload: {
        success: boolean;
        message: string;
      };
    }
  | {
      type: "tableData/bootstrap";
      payload: {
        connection: SavedConnection;
        schemas: SchemaListResult;
        tables: TableListResult;
        selectedSchema?: string;
        selectedTable?: string;
        query: TableQuery;
        result?: TableQueryResult;
        structure?: TableSchema;
        logs: OperationLogEntry[];
      };
    }
  | {
      type: "tableData/result";
      payload: {
        query: TableQuery;
        result: TableQueryResult;
      };
    }
  | {
      type: "tableData/appliedChanges";
      payload: {
        appliedCount: number;
      };
    }
  | {
      type: "schema/result";
      payload: {
        table: DescribeTableResult;
      };
    }
  | {
      type: "schema/sqlPreview";
      payload: SqlPreview;
    }
  | {
      type: "logs/result";
      payload: {
        logs: OperationLogEntry[];
      };
    }
  | {
      type: "ui/error";
      payload: NativeError | { code: string; message: string };
    };

export type WebviewToExtensionMessage =
  | WebviewReadyMessage
  | {
      type: "connection/save";
      payload: ConnectionFormState;
    }
  | {
      type: "connection/test";
      payload: ConnectionFormState;
    }
  | {
      type: "connection/delete";
      payload: { connectionId: string };
    }
  | {
      type: "tableData/query";
      payload: TableQuery;
    }
  | {
      type: "tableData/insert";
      payload: {
        schema?: string;
        table: string;
        rows: Array<Record<string, unknown>>;
      };
    }
  | {
      type: "tableData/update";
      payload: {
        schema?: string;
        table: string;
        key: Record<string, unknown>;
        values: Record<string, unknown>;
      };
    }
  | {
      type: "tableData/delete";
      payload: {
        schema?: string;
        table: string;
        key: Record<string, unknown>;
      };
    }
  | {
      type: "tableData/applyChanges";
      payload: {
        schema?: string;
        table: string;
        changes: PendingTableChange[];
      };
    }
  | {
      type: "schema/preview";
      payload: {
        action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn";
        schema?: string;
        table: string;
        nextTable?: string;
        column?: string;
        nextColumn?: string;
        definition?: Partial<TableSchema>;
      };
    }
  | {
      type: "schema/apply";
      payload: {
        action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn";
        schema?: string;
        table: string;
        nextTable?: string;
        column?: string;
        nextColumn?: string;
        definition?: Partial<TableSchema>;
      };
    };
