export type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
};

export type DatabaseProfile = {
  id: string;
  name: string;
  type: "sqlite" | "generic";
  path: string;
  lastUsedAt: string;
};

export type SqliteTableColumn = {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
};

export type SqliteTable = {
  name: string;
  createSql: string;
  columns: SqliteTableColumn[];
};

export type SqliteSchema = {
  path: string;
  tableCount: number;
  tables: SqliteTable[];
};

export type InitState = {
  host: "panel" | "sidebar";
  profiles: DatabaseProfile[];
  activeProfileId: string | null;
  selectedTableName: string | null;
  openedFile: {
    path: string;
    name: string;
    isSqliteFile: boolean;
  } | null;
  sqliteSchema: SqliteSchema | null;
};

export type TableDataRow = {
  rowKey: Record<string, unknown>;
  values: Record<string, unknown>;
};

export type TableDataPayload = {
  tableName: string;
  page: number;
  pageSize: number;
  totalRows: number;
  keyColumns: string[];
  search: string;
  rows: TableDataRow[];
};

export type ColumnSchemaDraft = {
  sourceName: string;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string;
};
