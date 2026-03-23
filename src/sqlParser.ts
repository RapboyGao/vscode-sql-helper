const { Parser } = require("node-sql-parser") as {
  Parser: new () => {
    astify(sql: string, options?: { database?: string }): unknown;
  };
};

const parser = new Parser();

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
  isCte: boolean;
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
  cteNames: string[];
};

type AstTableReference = {
  databaseName: string | null;
  schemaName: string | null;
  tableName: string;
  alias: string | null;
  isCte: boolean;
};

type AstColumnReference = {
  qualifier: string;
  columnName: string;
};

const TABLE_PATTERN =
  /\b(from|join|into|update|table|truncate\s+table|delete\s+from)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?(?:\.([a-z_][a-z0-9_]*))?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
const COLUMN_PATTERN = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
const USE_PATTERN = /\buse\s+([a-z_][a-z0-9_]*)\b/gi;

export function parseSql(sql: string): ParsedSql {
  const tableRanges = parseTableRanges(sql);
  const columnReferences = parseColumnRanges(sql);
  const useDatabases = parseUseRanges(sql);
  const semantic = parseSqlAst(sql);
  const tableReferences = mergeTableReferences(tableRanges, semantic.tableReferences);

  return {
    tableReferences,
    columnReferences,
    useDatabases,
    cteNames: [...semantic.cteNames]
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
    if (table.isCte) {
      references.set(`cte:${table.tableName}`, {
        kind: "cte",
        value: table.tableName
      });
      continue;
    }

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
    note: "Parser now uses a shared SQL AST with text-range fallback for editor interactions."
  };
}

export function buildAliasMap(parsed: ParsedSql): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const cteName of parsed.cteNames) {
    aliases.set(cteName.toLowerCase(), cteName.toLowerCase());
  }

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

function parseSqlAst(sql: string): {
  tableReferences: AstTableReference[];
  columnReferences: AstColumnReference[];
  cteNames: Set<string>;
} {
  try {
    const ast = parser.astify(sql, { database: "sqlite" });
    const statements = Array.isArray(ast) ? ast : [ast];
    const tableReferences: AstTableReference[] = [];
    const columnReferences: AstColumnReference[] = [];
    const cteNames = new Set<string>();

    for (const statement of statements) {
      walkStatement(statement, cteNames, tableReferences, columnReferences);
    }

    return {
      tableReferences,
      columnReferences,
      cteNames
    };
  } catch {
    return {
      tableReferences: [],
      columnReferences: [],
      cteNames: new Set<string>()
    };
  }
}

function walkStatement(
  node: unknown,
  cteNames: Set<string>,
  tableReferences: AstTableReference[],
  columnReferences: AstColumnReference[]
): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const current = node as Record<string, unknown>;
  const withEntries = Array.isArray(current.with) ? current.with : [];

  for (const entry of withEntries) {
    const withItem = entry as Record<string, unknown>;
    const cteName =
      typeof withItem.name === "object" &&
      withItem.name &&
      "value" in (withItem.name as Record<string, unknown>)
        ? String((withItem.name as Record<string, unknown>).value)
        : null;

    if (cteName) {
      cteNames.add(cteName);
    }

    if (typeof withItem.stmt === "object" && withItem.stmt && "ast" in withItem.stmt) {
      walkStatement(
        (withItem.stmt as Record<string, unknown>).ast,
        cteNames,
        tableReferences,
        columnReferences
      );
    }
  }

  const fromEntries = Array.isArray(current.from) ? current.from : [];

  for (const entry of fromEntries) {
    const fromItem = entry as Record<string, unknown>;

    if (typeof fromItem.table === "string") {
      const tableName = fromItem.table;
      tableReferences.push({
        databaseName: typeof fromItem.db === "string" ? fromItem.db : null,
        schemaName: typeof fromItem.schema === "string" ? fromItem.schema : null,
        tableName,
        alias: typeof fromItem.as === "string" ? fromItem.as : null,
        isCte: cteNames.has(tableName)
      });
    }

    if (typeof fromItem.expr === "object" && fromItem.expr && "ast" in (fromItem.expr as Record<string, unknown>)) {
      walkStatement(
        (fromItem.expr as Record<string, unknown>).ast,
        cteNames,
        tableReferences,
        columnReferences
      );
    }

    if (typeof fromItem.on === "object" && fromItem.on) {
      walkExpressions(fromItem.on, columnReferences);
    }
  }

  walkExpressions(current.columns, columnReferences);
  walkExpressions(current.where, columnReferences);
  walkExpressions(current.groupby, columnReferences);
  walkExpressions(current.having, columnReferences);
  walkExpressions(current.orderby, columnReferences);
  walkExpressions(current.limit, columnReferences);
}

function walkExpressions(node: unknown, columnReferences: AstColumnReference[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkExpressions(item, columnReferences);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const current = node as Record<string, unknown>;

  if (current.type === "column_ref" && typeof current.table === "string" && typeof current.column === "string") {
    columnReferences.push({
      qualifier: current.table,
      columnName: current.column
    });
  }

  for (const value of Object.values(current)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    walkExpressions(value, columnReferences);
  }
}

function parseTableRanges(sql: string): TableReference[] {
  const references: TableReference[] = [];

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

    references.push({
      databaseName,
      schemaName,
      tableName,
      alias,
      isCte: false,
      range: {
        start,
        end: start + objectName.length
      }
    });
  }

  return references;
}

function parseColumnRanges(sql: string): ColumnReference[] {
  const columnReferences: ColumnReference[] = [];

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

  return columnReferences;
}

function parseUseRanges(sql: string): Array<{ value: string; range: OffsetRange }> {
  const useDatabases: Array<{ value: string; range: OffsetRange }> = [];

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

  return useDatabases;
}

function mergeTableReferences(rangeRefs: TableReference[], astRefs: AstTableReference[]): TableReference[] {
  if (astRefs.length === 0) {
    return rangeRefs;
  }

  const merged: TableReference[] = [];
  const fallback = [...rangeRefs];

  for (const astRef of astRefs) {
    const index = fallback.findIndex((candidate) => {
      return (
        candidate.tableName.toLowerCase() === astRef.tableName.toLowerCase() &&
        normalizeNullable(candidate.alias) === normalizeNullable(astRef.alias)
      );
    });

    if (index >= 0) {
      const matched = fallback.splice(index, 1)[0];
      merged.push({
        ...matched,
        databaseName: astRef.databaseName,
        schemaName: astRef.schemaName,
        tableName: astRef.tableName,
        alias: astRef.alias,
        isCte: astRef.isCte
      });
      continue;
    }

    const looseIndex = fallback.findIndex((candidate) => candidate.tableName.toLowerCase() === astRef.tableName.toLowerCase());

    if (looseIndex >= 0) {
      const matched = fallback.splice(looseIndex, 1)[0];
      merged.push({
        ...matched,
        databaseName: astRef.databaseName,
        schemaName: astRef.schemaName,
        tableName: astRef.tableName,
        alias: astRef.alias,
        isCte: astRef.isCte
      });
      continue;
    }
  }

  for (const leftover of rangeRefs) {
    const known = merged.some((item) => item.range.start === leftover.range.start && item.range.end === leftover.range.end);

    if (!known) {
      merged.push(leftover);
    }
  }

  return merged.sort((left, right) => left.range.start - right.range.start);
}

function normalizeNullable(value: string | null): string {
  return (value ?? "").toLowerCase();
}
