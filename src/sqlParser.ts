export type OffsetRange = {
  start: number;
  end: number;
};

export type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
};

export type TableReference = {
  databaseName: string | null;
  schemaName: string | null;
  tableName: string;
  alias: string | null;
  range: OffsetRange;
};

export type ColumnReference = {
  qualifier: string;
  columnName: string;
  qualifierRange: OffsetRange;
  columnRange: OffsetRange;
  fullRange: OffsetRange;
};

export type ParsedSql = {
  tableReferences: TableReference[];
  columnReferences: ColumnReference[];
  useDatabases: Array<{
    value: string;
    range: OffsetRange;
  }>;
};

const TABLE_PATTERN =
  /\b(from|join|into|update|table|truncate\s+table|delete\s+from)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?(?:\.([a-z_][a-z0-9_]*))?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
const COLUMN_PATTERN = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
const USE_PATTERN = /\buse\s+([a-z_][a-z0-9_]*)\b/gi;

export function parseSql(sql: string): ParsedSql {
  const tableReferences: TableReference[] = [];
  const columnReferences: ColumnReference[] = [];
  const useDatabases: Array<{ value: string; range: OffsetRange }> = [];

  for (const match of sql.matchAll(TABLE_PATTERN)) {
    const keyword = match[1] ?? "";
    const first = match[2] ?? "";
    const second = match[3] ?? null;
    const third = match[4] ?? null;
    const alias = match[5] ?? null;
    const fullMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;

    let databaseName: string | null = null;
    let schemaName: string | null = null;
    let tableName = first;

    if (third) {
      databaseName = first;
      schemaName = second;
      tableName = third;
    } else if (second) {
      schemaName = first;
      tableName = second;
    }

    const objectName = [databaseName, schemaName, tableName].filter(Boolean).join(".");
    const objectOffset = fullMatch.toLowerCase().indexOf(objectName.toLowerCase(), keyword.length);
    const start = matchIndex + Math.max(objectOffset, 0);

    tableReferences.push({
      databaseName,
      schemaName,
      tableName,
      alias,
      range: {
        start,
        end: start + objectName.length
      }
    });
  }

  for (const match of sql.matchAll(COLUMN_PATTERN)) {
    const qualifier = match[1] ?? "";
    const columnName = match[2] ?? "";
    const start = match.index ?? 0;

    columnReferences.push({
      qualifier,
      columnName,
      qualifierRange: {
        start,
        end: start + qualifier.length
      },
      columnRange: {
        start: start + qualifier.length + 1,
        end: start + qualifier.length + 1 + columnName.length
      },
      fullRange: {
        start,
        end: start + qualifier.length + 1 + columnName.length
      }
    });
  }

  for (const match of sql.matchAll(USE_PATTERN)) {
    const value = match[1] ?? "";
    const fullMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;
    const valueOffset = fullMatch.toLowerCase().indexOf(value.toLowerCase());
    const start = matchIndex + Math.max(valueOffset, 0);

    useDatabases.push({
      value,
      range: {
        start,
        end: start + value.length
      }
    });
  }

  return {
    tableReferences,
    columnReferences,
    useDatabases
  };
}

export function analyzeSqlText(sql: string): AnalysisResult {
  const parsed = parseSql(sql);
  const databases = new Set<string>();
  const schemas = new Set<string>();
  const references = new Map<string, { kind: string; value: string }>();

  for (const entry of parsed.useDatabases) {
    databases.add(entry.value);
    references.set(`database:${entry.value}`, {
      kind: "database",
      value: entry.value
    });
  }

  for (const table of parsed.tableReferences) {
    if (table.databaseName) {
      databases.add(table.databaseName);
    }

    if (table.schemaName) {
      schemas.add(table.schemaName);
    }

    const objectPath = [table.databaseName, table.schemaName, table.tableName].filter(Boolean).join(".");
    references.set(`table:${objectPath}`, {
      kind: "table",
      value: objectPath
    });
  }

  for (const column of parsed.columnReferences) {
    references.set(`qualified:${column.qualifier}.${column.columnName}`, {
      kind: "qualified_name",
      value: `${column.qualifier}.${column.columnName}`
    });
  }

  return {
    databases: [...databases].sort(),
    schemas: [...schemas].sort(),
    references: [...references.values()],
    note: "Current parser is shared across the webview and editor features. Next step is upgrading to a full SQL AST."
  };
}

export function buildAliasMap(parsed: ParsedSql): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const table of parsed.tableReferences) {
    const normalizedTable = table.tableName.toLowerCase();
    aliases.set(normalizedTable, normalizedTable);

    if (table.alias) {
      aliases.set(table.alias.toLowerCase(), normalizedTable);
    }
  }

  return aliases;
}

export function findTokenAtOffset(
  parsed: ParsedSql,
  offset: number
):
  | { type: "table"; reference: TableReference }
  | { type: "column"; reference: ColumnReference }
  | null {
  for (const reference of parsed.tableReferences) {
    if (offset >= reference.range.start && offset <= reference.range.end) {
      return { type: "table", reference };
    }
  }

  for (const reference of parsed.columnReferences) {
    if (offset >= reference.qualifierRange.start && offset <= reference.columnRange.end) {
      return { type: "column", reference };
    }
  }

  return null;
}
