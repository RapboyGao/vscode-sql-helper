<script setup lang="ts">
import {
  mdiCheckCircleOutline,
  mdiChevronLeft,
  mdiChevronRight,
  mdiDatabaseOutline,
  mdiDeleteOutline,
  mdiFileTableOutline,
  mdiFormatListBulletedSquare,
  mdiMagnify,
  mdiPlayCircleOutline,
  mdiPlusCircleOutline,
  mdiRestore,
  mdiTableColumn,
  mdiTableEdit,
  mdiTextBoxSearchOutline
} from "@mdi/js";
import { computed, ref, watch } from "vue";
import type {
  ColumnSchema,
  DdlPayload,
  PendingTableChange,
  PendingTableDelete,
  PendingTableInsert,
  PendingTableUpdate,
  SavedConnection,
  TableQuery,
  TableQueryResult,
  TableSchema
} from "@usd/shared";
import MdiIcon from "./MdiIcon.vue";
import DateTimeEditor from "./DateTimeEditor.vue";

type RowDraftMap = Record<string, Record<string, unknown>>;
type DeleteMap = Record<string, boolean>;
type InputKind = "text" | "number" | "date" | "datetime-local" | "checkbox" | "textarea";
type TextEditorState = {
  source: "existing" | "insert";
  row?: Record<string, unknown>;
  columnName: string;
  value: string;
} | null;
type TableActionModal = "create" | "rename" | "delete" | null;
type TableCreateColumnDraft = {
  id: string;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
};
type ColumnDraft = ColumnSchema & {
  id: string;
  originalName?: string;
  isNew?: boolean;
  markedForDelete?: boolean;
};

const props = defineProps<{
  connection: SavedConnection;
  schemas: string[];
  tables: string[];
  selectedSchema?: string;
  selectedTable?: string;
  query: TableQuery;
  result?: TableQueryResult;
  structure?: TableSchema;
  logs: Array<{ id: string; timestamp: string; operation: string; success: boolean; objectName: string }>;
  applySignal: number;
  sqlPreview?: { title: string; statements: string[] } | null;
}>();

const emit = defineEmits<{
  query: [query: TableQuery];
  applyChanges: [payload: { schema?: string; table: string; changes: PendingTableChange[] }];
  preview: [payload: DdlPayload];
  apply: [payload: DdlPayload];
  previewColumns: [payload: { schema?: string; table: string; actions: DdlPayload[] }];
  applyColumns: [payload: { schema?: string; table: string; actions: DdlPayload[] }];
}>();

const activeTab = ref<"columns" | "data" | "pending" | "logs">("data");
const keyword = ref(props.query.keyword ?? "");
const selectedSearchColumn = ref<string>("__all__");
const selectedSchema = ref(props.selectedSchema ?? props.schemas[0] ?? "");
const selectedTable = ref(props.selectedTable ?? props.tables[0] ?? "");
const pageInput = ref(String((props.query.page ?? 0) + 1));
const pageSize = ref(String(props.query.pageSize ?? 50));
const insertDraft = ref<Record<string, string>>({});
const rowDrafts = ref<RowDraftMap>({});
const pendingDeletes = ref<DeleteMap>({});
const pendingInserts = ref<PendingTableInsert[]>([]);
const applyingPending = ref(false);
const textEditor = ref<TextEditorState>(null);
const tableActionModal = ref<TableActionModal>(null);
const tableNameDraft = ref("");
const deleteConfirmationDraft = ref("");
const createTableColumns = ref<TableCreateColumnDraft[]>([]);
const columnDrafts = ref<ColumnDraft[]>([]);

watch(
  () => props.selectedSchema,
  (value) => {
    if (value !== undefined) {
      selectedSchema.value = value;
    }
  }
);

watch(
  () => props.selectedTable,
  (value) => {
    if (value !== undefined) {
      selectedTable.value = value;
    }
  }
);

watch(
  () => props.query,
  (value) => {
    keyword.value = value.keyword ?? "";
    const selectedFilter = value.filters?.find((filter) => filter.operator === "contains" && typeof filter.value === "string");
    selectedSearchColumn.value = selectedFilter?.column ?? "__all__";
    pageInput.value = String((value.page ?? 0) + 1);
    pageSize.value = String(value.pageSize ?? 50);
  },
  { deep: true }
);

watch(
  () => [props.connection.id, props.selectedSchema, props.selectedTable] as const,
  (next, previous) => {
    if (!previous) {
      return;
    }

    if (next[0] === previous[0] && next[1] === previous[1] && next[2] === previous[2]) {
      return;
    }

    clearAllPending();
    selectedSearchColumn.value = "__all__";
    textEditor.value = null;
    resetColumnDrafts();
    activeTab.value = "data";
  }
);

watch(
  () => props.applySignal,
  () => {
    if (!applyingPending.value) {
      return;
    }

    clearAllPending();
    applyingPending.value = false;
  }
);

const totalPages = computed(() => {
  if (!props.result) {
    return 1;
  }

  return Math.max(1, Math.ceil(props.result.totalRows / props.result.pageSize));
});

const currentPage = computed(() => (props.result?.page ?? props.query.page ?? 0) + 1);
const pageOffset = computed(() => (props.result?.page ?? props.query.page ?? 0) * (props.result?.pageSize ?? props.query.pageSize ?? 50));
const visibleColumns = computed(() => props.result?.columns ?? props.structure?.columns ?? []);
const effectiveStructureColumns = computed<ColumnDraft[]>(() => columnDrafts.value);
const searchableColumns = computed(() =>
  visibleColumns.value.filter((column) => /(char|text|clob|json|uuid|varchar)/i.test(column.dataType))
);
const isReadonlyConnection = computed(() => props.connection.readonly);
const dbType = computed(() => props.connection.type);
const selectedSchemaValue = computed(() => selectedSchema.value || undefined);
const canRenameExistingColumns = computed(() => true);
const canDeleteExistingColumns = computed(() => dbType.value !== "sqlite");
const canBasicEditExistingColumns = computed(() => dbType.value === "mysql" || dbType.value === "postgresql");
const tableTypeOptions = computed(() => columnTypeOptions(dbType.value));
const hasSelectedTable = computed(() => Boolean(selectedTable.value));
const hasColumnDraftChanges = computed(() => buildColumnActions().length > 0);

watch(
  () => props.structure,
  () => {
    resetColumnDrafts();
  },
  { deep: true, immediate: true }
);

const pendingUpdates = computed<PendingTableUpdate[]>(() => {
  if (!props.result) {
    return [];
  }

  return props.result.rows.flatMap((row) => {
    const key = rowKey(row);
    const draft = rowDrafts.value[key];
    if (!draft) {
      return [];
    }

    const changedValues = Object.fromEntries(
      Object.entries(draft).filter(([column, value]) => normalizeCellValue(column, row[column]) !== normalizeCellValue(column, value))
    );

    if (!Object.keys(changedValues).length) {
      return [];
    }

    return [
      {
        kind: "update",
        rowKey: key,
        key: rowKeyPayload(row),
        originalRow: row,
        values: changedValues
      }
    ];
  });
});

const pendingDeletesList = computed<PendingTableDelete[]>(() => {
  if (!props.result) {
    return [];
  }

  return props.result.rows
    .filter((row) => pendingDeletes.value[rowKey(row)])
    .map((row) => ({
      kind: "delete",
      rowKey: rowKey(row),
      key: rowKeyPayload(row),
      row
    }));
});

const pendingChanges = computed<PendingTableChange[]>(() => [
  ...pendingInserts.value,
  ...pendingUpdates.value,
  ...pendingDeletesList.value
]);

const rowsForDisplay = computed(() => {
  const resultRows = props.result?.rows ?? [];
  return [
    ...pendingInserts.value.map((entry) => ({
      kind: "insert" as const,
      id: entry.tempId,
      row: entry.row
    })),
    ...resultRows.map((row) => ({
      kind: "existing" as const,
      id: rowKey(row),
      row
    }))
  ];
});

const hasInsertDraftValues = computed(() =>
  Object.values(insertDraft.value).some((value) => {
    if (typeof value === "boolean") {
      return value;
    }

    return String(value ?? "").trim() !== "";
  })
);

function rowKey(row: Record<string, unknown>): string {
  if (!props.result) {
    return JSON.stringify(row);
  }

  const primaryKeyValues = props.result.primaryKeys.map((key) => row[key]);
  return primaryKeyValues.length ? JSON.stringify(primaryKeyValues) : JSON.stringify(row);
}

function rowKeyPayload(row: Record<string, unknown>): Record<string, unknown> {
  if (!props.result) {
    return row;
  }

  return props.result.primaryKeys.reduce<Record<string, unknown>>((accumulator, key) => {
    accumulator[key] = row[key];
    return accumulator;
  }, {});
}

function setDraftValue(row: Record<string, unknown>, columnName: string, value: unknown): void {
  const key = rowKey(row);
  rowDrafts.value = {
    ...rowDrafts.value,
    [key]: {
      ...(rowDrafts.value[key] ?? {}),
      [columnName]: value
    }
  };
}

function draftValue(row: Record<string, unknown>, columnName: string): unknown {
  const key = rowKey(row);
  return rowDrafts.value[key]?.[columnName] ?? row[columnName] ?? "";
}

function changeColumnsForRow(row: Record<string, unknown>): Set<string> {
  const key = rowKey(row);
  const draft = rowDrafts.value[key];
  if (!draft) {
    return new Set();
  }

  return new Set(
    Object.entries(draft)
      .filter(([column, value]) => String(row[column] ?? "") !== value)
      .map(([column]) => column)
  );
}

function columnSchema(columnName: string) {
  return visibleColumns.value.find((column) => column.name === columnName);
}

function columnInputKind(columnName: string): InputKind {
  const column = columnSchema(columnName);
  const normalized = column?.dataType.toLowerCase() ?? "";

  if (/(bool|bit)/.test(normalized)) {
    return "checkbox";
  }

  if (/(datetime|timestamp)/.test(normalized)) {
    return "datetime-local";
  }

  if (/(^date$)/.test(normalized)) {
    return "date";
  }

  if (/(int|real|float|double|decimal|numeric)/.test(normalized)) {
    return "number";
  }

  if (/(json|text|clob)/.test(normalized)) {
    return "textarea";
  }

  return "text";
}

function isEditableColumn(columnName: string): boolean {
  const column = columnSchema(columnName);
  return !column?.autoIncrement;
}

function isWideIdentityColumn(columnName: string): boolean {
  const column = columnSchema(columnName);
  return Boolean(column?.primaryKey || column?.autoIncrement || /^id$/i.test(columnName) || /_id$/i.test(columnName));
}

function normalizeCellValue(columnName: string, value: unknown): string | boolean {
  const kind = columnInputKind(columnName);
  if (kind === "checkbox") {
    if (typeof value === "boolean") {
      return value;
    }

    const normalized = String(value ?? "").toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }

  if (kind === "date") {
    return formatDateValue(value);
  }

  if (kind === "datetime-local") {
    return formatDateTimeValue(value);
  }

  return String(value ?? "");
}

function formatDateValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  return text.length >= 10 ? text.slice(0, 10) : text;
}

function formatDateTimeValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  const normalized = text.replace(" ", "T").replace(/Z$/, "");
  return normalized.length >= 23 ? normalized.slice(0, 23) : normalized;
}

function cellDisplayValue(row: Record<string, unknown>, columnName: string): string | boolean {
  return normalizeCellValue(columnName, draftValue(row, columnName));
}

function cellChanged(row: Record<string, unknown>, columnName: string): boolean {
  return normalizeCellValue(columnName, draftValue(row, columnName)) !== normalizeCellValue(columnName, row[columnName]);
}

function handleCellInput(row: Record<string, unknown>, columnName: string, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const kind = columnInputKind(columnName);

  if (kind === "checkbox") {
    setDraftValue(row, columnName, (target as HTMLInputElement).checked);
    return;
  }

  if (kind === "number") {
    const raw = target.value.trim();
    setDraftValue(row, columnName, raw === "" ? "" : Number(raw));
    return;
  }

  setDraftValue(row, columnName, target.value);
}

function handleInsertDraftInput(columnName: string, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const kind = columnInputKind(columnName);

  if (kind === "checkbox") {
    insertDraft.value = {
      ...insertDraft.value,
      [columnName]: (target as HTMLInputElement).checked ? "true" : ""
    };
    return;
  }

  insertDraft.value = {
    ...insertDraft.value,
    [columnName]: target.value
  };
}

function setInsertDraftValue(columnName: string, value: string): void {
  insertDraft.value = {
    ...insertDraft.value,
    [columnName]: value
  };
}

function createDraftId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function columnTypeOptions(type: SavedConnection["type"]): string[] {
  switch (type) {
    case "mysql":
      return ["VARCHAR(255)", "TEXT", "INT", "BIGINT", "DECIMAL(10,2)", "BOOLEAN", "DATE", "DATETIME", "TIMESTAMP", "JSON"];
    case "postgresql":
      return ["text", "varchar", "integer", "bigint", "numeric", "boolean", "date", "timestamp", "jsonb", "uuid"];
    default:
      return ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "date", "datetime"];
  }
}

function resetTableCreateDraft(): void {
  tableNameDraft.value = "";
  deleteConfirmationDraft.value = "";
  createTableColumns.value = [createEmptyTableColumnDraft()];
}

function createEmptyTableColumnDraft(): TableCreateColumnDraft {
  return normalizeCreateTableColumnDraft({
    id: createDraftId("table-column"),
    name: "",
    dataType: tableTypeOptions.value[0] ?? "TEXT",
    nullable: true,
    defaultValue: "",
    primaryKey: false,
    unique: false,
    autoIncrement: false
  });
}

function openTableModal(mode: TableActionModal): void {
  tableActionModal.value = mode;
  if (mode === "create") {
    resetTableCreateDraft();
    return;
  }

  tableNameDraft.value = selectedTable.value ?? "";
  deleteConfirmationDraft.value = "";
}

function closeTableModal(): void {
  tableActionModal.value = null;
}

function addCreateTableColumn(): void {
  createTableColumns.value = [...createTableColumns.value, createEmptyTableColumnDraft()];
}

function removeCreateTableColumn(id: string): void {
  if (createTableColumns.value.length <= 1) {
    return;
  }
  createTableColumns.value = createTableColumns.value.filter((column) => column.id !== id);
}

function isIntegerLikeDataType(type: string, dbType: SavedConnection["type"]): boolean {
  const normalized = type.trim().toLowerCase();

  switch (dbType) {
    case "sqlite":
      return normalized === "integer";
    case "mysql":
      return /(^|[^a-z])(tinyint|smallint|mediumint|int|integer|bigint)([^a-z]|$)/.test(normalized);
    case "postgresql":
      return /(^|[^a-z])(smallint|integer|bigint|serial|bigserial)([^a-z]|$)/.test(normalized);
    default:
      return /(int|integer|bigint)/.test(normalized);
  }
}

function createColumnSupportsAutoIncrement(column: TableCreateColumnDraft): boolean {
  return isIntegerLikeDataType(column.dataType, props.connection.type);
}

function createColumnSupportsDefault(column: TableCreateColumnDraft): boolean {
  return !column.autoIncrement;
}

function normalizeCreateTableColumnDraft(column: TableCreateColumnDraft): TableCreateColumnDraft {
  const normalized: TableCreateColumnDraft = { ...column };

  if (!createColumnSupportsAutoIncrement(normalized)) {
    normalized.autoIncrement = false;
  }

  if (normalized.autoIncrement) {
    normalized.primaryKey = true;
    normalized.nullable = false;
    normalized.unique = false;
    normalized.defaultValue = "";
  }

  if (normalized.primaryKey) {
    normalized.nullable = false;
  }

  if (!createColumnSupportsDefault(normalized)) {
    normalized.defaultValue = "";
  }

  return normalized;
}

function updateCreateTableColumn(id: string, patch: Partial<TableCreateColumnDraft>): void {
  createTableColumns.value = createTableColumns.value.map((column) =>
    column.id === id ? normalizeCreateTableColumnDraft({ ...column, ...patch }) : column
  );
}

function toColumnSchemaDraft(column: TableCreateColumnDraft): ColumnSchema {
  return {
    name: column.name.trim(),
    dataType: column.dataType,
    nullable: column.nullable,
    defaultValue: column.defaultValue.trim() || undefined,
    primaryKey: column.primaryKey,
    unique: column.unique,
    autoIncrement: column.autoIncrement
  };
}

function createTablePayload(): DdlPayload | null {
  const name = tableNameDraft.value.trim();
  if (!name) {
    return null;
  }
  const columns = createTableColumns.value
    .map(toColumnSchemaDraft)
    .filter((column) => column.name && column.dataType);
  if (!columns.length) {
    return null;
  }

  return {
    action: "createTable",
    schema: selectedSchemaValue.value,
    table: name,
    definition: {
      name,
      columns,
      primaryKeys: columns.filter((column) => column.primaryKey).map((column) => column.name)
    }
  };
}

function previewCurrentTableAction(): void {
  const payload = currentTableActionPayload();
  if (payload) {
    emit("preview", payload);
  }
}

function applyCurrentTableAction(): void {
  const payload = currentTableActionPayload();
  if (payload) {
    emit("apply", payload);
    closeTableModal();
  }
}

function currentTableActionPayload(): DdlPayload | null {
  if (tableActionModal.value === "create") {
    return createTablePayload();
  }

  if (!selectedTable.value) {
    return null;
  }

  if (tableActionModal.value === "rename") {
    const nextTable = tableNameDraft.value.trim();
    if (!nextTable || nextTable === selectedTable.value) {
      return null;
    }
    return {
      action: "renameTable",
      schema: selectedSchemaValue.value,
      table: selectedTable.value,
      nextTable
    };
  }

  if (tableActionModal.value === "delete") {
    if (deleteConfirmationDraft.value.trim() !== selectedTable.value) {
      return null;
    }
    return {
      action: "deleteTable",
      schema: selectedSchemaValue.value,
      table: selectedTable.value
    };
  }

  return null;
}

function resetColumnDrafts(): void {
  columnDrafts.value = (props.structure?.columns ?? []).map((column) => ({
    ...column,
    id: createDraftId("column"),
    originalName: column.name,
    markedForDelete: false,
    isNew: false
  }));
}

function addColumnDraft(): void {
  columnDrafts.value = [
    ...columnDrafts.value,
    {
      id: createDraftId("column"),
      name: "",
      dataType: tableTypeOptions.value[0] ?? "TEXT",
      nullable: true,
      defaultValue: undefined,
      primaryKey: false,
      unique: false,
      autoIncrement: false,
      isNew: true,
      markedForDelete: false
    }
  ];
}

function updateColumnDraft(id: string, patch: Partial<ColumnDraft>): void {
  columnDrafts.value = columnDrafts.value.map((column) => (column.id === id ? { ...column, ...patch } : column));
}

function toggleColumnDelete(id: string): void {
  const target = columnDrafts.value.find((column) => column.id === id);
  if (!target) {
    return;
  }

  if (target.isNew) {
    columnDrafts.value = columnDrafts.value.filter((column) => column.id !== id);
    return;
  }

  columnDrafts.value = columnDrafts.value.map((column) =>
    column.id === id ? { ...column, markedForDelete: !column.markedForDelete } : column
  );
}

function resetColumns(): void {
  resetColumnDrafts();
}

function normalizeDefaultValue(value: string | null | undefined): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function originalColumn(name?: string): ColumnSchema | undefined {
  return props.structure?.columns.find((column) => column.name === name);
}

function isColumnFieldEditable(column: ColumnDraft, field: "name" | "dataType" | "nullable" | "defaultValue" | "primaryKey" | "unique" | "autoIncrement"): boolean {
  if (isReadonlyConnection.value) {
    return false;
  }
  if (column.isNew) {
    return true;
  }
  if (field === "name") {
    return canRenameExistingColumns.value;
  }
  if (field === "dataType" || field === "nullable" || field === "defaultValue") {
    return canBasicEditExistingColumns.value;
  }
  return false;
}

function canDeleteColumn(column: ColumnDraft): boolean {
  if (isReadonlyConnection.value) {
    return false;
  }
  if (column.isNew) {
    return true;
  }
  if (column.primaryKey || column.autoIncrement) {
    return false;
  }
  return canDeleteExistingColumns.value;
}

function buildColumnActions(): DdlPayload[] {
  if (!selectedTable.value) {
    return [];
  }

  const schema = selectedSchemaValue.value;
  const actions: DdlPayload[] = [];

  for (const column of columnDrafts.value) {
    if (column.isNew && !column.markedForDelete && column.name.trim()) {
      actions.push({
        action: "addColumn",
        schema,
        table: selectedTable.value,
        definition: {
          name: selectedTable.value,
          columns: [
            {
              name: column.name.trim(),
              dataType: column.dataType,
              nullable: column.nullable,
              defaultValue: normalizeDefaultValue(column.defaultValue),
              primaryKey: column.primaryKey,
              unique: column.unique,
              autoIncrement: column.autoIncrement
            }
          ],
          primaryKeys: []
        }
      });
      continue;
    }

    if (!column.originalName) {
      continue;
    }

    if (column.markedForDelete) {
      actions.push({
        action: "deleteColumn",
        schema,
        table: selectedTable.value,
        column: column.originalName
      });
      continue;
    }

    const original = originalColumn(column.originalName);
    if (!original) {
      continue;
    }

    if (column.name.trim() && column.name.trim() !== column.originalName) {
      actions.push({
        action: "renameColumn",
        schema,
        table: selectedTable.value,
        column: column.originalName,
        nextColumn: column.name.trim()
      });
    }

    const basicChanged =
      column.dataType !== original.dataType ||
      column.nullable !== original.nullable ||
      normalizeDefaultValue(column.defaultValue) !== normalizeDefaultValue(original.defaultValue ?? undefined);

    if (basicChanged && canBasicEditExistingColumns.value) {
      actions.push({
        action: "editColumn",
        schema,
        table: selectedTable.value,
        column: column.name.trim() || column.originalName,
        definition: {
          name: selectedTable.value,
          columns: [
            {
              name: column.name.trim() || column.originalName,
              dataType: column.dataType,
              nullable: column.nullable,
              defaultValue: normalizeDefaultValue(column.defaultValue),
              primaryKey: original.primaryKey,
              unique: original.unique,
              autoIncrement: original.autoIncrement
            }
          ],
          primaryKeys: []
        }
      });
    }
  }

  const weight = (action: DdlPayload["action"]): number => {
    switch (action) {
      case "renameColumn":
        return 1;
      case "editColumn":
        return 2;
      case "addColumn":
        return 3;
      case "deleteColumn":
        return 4;
      default:
        return 9;
    }
  };

  return actions.sort((left, right) => weight(left.action) - weight(right.action));
}

function previewColumnActions(): void {
  const actions = buildColumnActions();
  if (!actions.length || !selectedTable.value) {
    return;
  }
  emit("previewColumns", {
    schema: selectedSchemaValue.value,
    table: selectedTable.value,
    actions
  });
}

function applyColumnActions(): void {
  const actions = buildColumnActions();
  if (!actions.length || !selectedTable.value) {
    return;
  }
  emit("applyColumns", {
    schema: selectedSchemaValue.value,
    table: selectedTable.value,
    actions
  });
}

function columnCellChanged(column: ColumnDraft, field: "name" | "dataType" | "nullable" | "defaultValue" | "primaryKey" | "unique" | "autoIncrement"): boolean {
  if (column.isNew) {
    return true;
  }
  const original = originalColumn(column.originalName);
  if (!original) {
    return false;
  }
  if (field === "defaultValue") {
    return normalizeDefaultValue(column.defaultValue) !== normalizeDefaultValue(original.defaultValue ?? undefined);
  }
  return column[field] !== original[field];
}

function buildInsertRow(): Record<string, unknown> {
  return visibleColumns.value.reduce<Record<string, unknown>>((row, column) => {
    if (!isEditableColumn(column.name)) {
      return row;
    }

    const raw = insertDraft.value[column.name];
    const kind = columnInputKind(column.name);

    if (kind === "checkbox") {
      if (raw === "true") {
        row[column.name] = true;
      }
      return row;
    }

    const text = String(raw ?? "").trim();
    if (!text) {
      return row;
    }

    if (kind === "number") {
      row[column.name] = Number(text);
      return row;
    }

    row[column.name] = text;
    return row;
  }, {});
}

function openTextEditor(row: Record<string, unknown>, columnName: string): void {
  textEditor.value = {
    source: "existing",
    row,
    columnName,
    value: String(cellDisplayValue(row, columnName))
  };
}

function closeTextEditor(): void {
  textEditor.value = null;
}

function applyTextEditor(): void {
  if (!textEditor.value) {
    return;
  }

  if (textEditor.value.source === "insert") {
    setInsertDraftValue(textEditor.value.columnName, textEditor.value.value);
  } else if (textEditor.value.row) {
    setDraftValue(textEditor.value.row, textEditor.value.columnName, textEditor.value.value);
  }
  textEditor.value = null;
}

function textButtonLabel(row: Record<string, unknown>, columnName: string): string {
  const value = String(cellDisplayValue(row, columnName)).trim();
  return value || "Edit text";
}

function openInsertTextEditor(columnName: string): void {
  textEditor.value = {
    source: "insert",
    columnName,
    value: String(insertDraft.value[columnName] ?? "")
  };
}

function emitQuery(nextPage = 0): void {
  const useAllColumns = selectedSearchColumn.value === "__all__";
  emit("query", {
    ...props.query,
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    keyword: useAllColumns ? keyword.value : "",
    filters: !useAllColumns && keyword.value
      ? [
          {
            column: selectedSearchColumn.value,
            operator: "contains",
            value: keyword.value
          }
        ]
      : undefined,
    page: nextPage,
    pageSize: Number(pageSize.value)
  });
}

function handleSchemaChange(): void {
  selectedTable.value = "";
  emit("query", {
    ...props.query,
    schema: selectedSchema.value || undefined,
    table: "",
    keyword: keyword.value,
    page: 0,
    pageSize: Number(pageSize.value)
  });
}

function selectTable(table: string): void {
  selectedTable.value = table;
  emitQuery(0);
}

function goToPage(): void {
  const requested = Number(pageInput.value);
  const safePage = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), totalPages.value) : 1;
  pageInput.value = String(safePage);
  emitQuery(safePage - 1);
}

function stageInsert(): void {
  if (!hasInsertDraftValues.value) {
    return;
  }

  const row = buildInsertRow();
  if (!Object.keys(row).length) {
    return;
  }

  pendingInserts.value = [
    ...pendingInserts.value,
    {
      kind: "insert",
      tempId: `insert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      row
    }
  ];
  insertDraft.value = {};
  activeTab.value = "pending";
}

function stageDelete(row: Record<string, unknown>): void {
  const key = rowKey(row);
  const nextDrafts = { ...rowDrafts.value };
  delete nextDrafts[key];
  rowDrafts.value = nextDrafts;
  pendingDeletes.value = {
    ...pendingDeletes.value,
    [key]: true
  };
  activeTab.value = "pending";
}

function cancelPendingChange(change: PendingTableChange): void {
  if (change.kind === "insert") {
    pendingInserts.value = pendingInserts.value.filter((entry) => entry.tempId !== change.tempId);
    return;
  }

  if (change.kind === "delete") {
    const next = { ...pendingDeletes.value };
    delete next[change.rowKey];
    pendingDeletes.value = next;
    return;
  }

  const nextDrafts = { ...rowDrafts.value };
  delete nextDrafts[change.rowKey];
  rowDrafts.value = nextDrafts;
}

function clearAllPending(): void {
  rowDrafts.value = {};
  pendingDeletes.value = {};
  pendingInserts.value = [];
}

function applyAllPending(): void {
  if (!selectedTable.value || !pendingChanges.value.length) {
    return;
  }

  applyingPending.value = true;
  const changes = JSON.parse(
    JSON.stringify(
      pendingChanges.value.map((change) =>
        change.kind === "insert"
          ? {
              kind: "insert" as const,
              tempId: change.tempId,
              row: { ...change.row }
            }
          : change.kind === "update"
            ? {
                kind: "update" as const,
                rowKey: change.rowKey,
                key: { ...change.key },
                originalRow: { ...change.originalRow },
                values: { ...change.values }
              }
            : {
                kind: "delete" as const,
                rowKey: change.rowKey,
                key: { ...change.key },
                row: { ...change.row }
              }
      )
    )
  ) as PendingTableChange[];
  emit("applyChanges", {
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    changes
  });
}

function pendingCellClass(change: PendingTableChange, column: string): Record<string, boolean> {
  if (change.kind === "insert") {
    return {
      "changed-cell": change.row[column] !== undefined && String(change.row[column] ?? "") !== ""
    };
  }

  if (change.kind === "delete") {
    return {
      "changed-cell": true,
      "deleted-cell": true
    };
  }

  return {
    "changed-cell": Object.prototype.hasOwnProperty.call(change.values, column),
    "pending-updated-cell": Object.prototype.hasOwnProperty.call(change.values, column)
  };
}

function displayRowNumber(entryIndex: number, entryKind: "insert" | "existing"): string {
  if (entryKind === "insert") {
    return "New";
  }

  return String(pageOffset.value + (entryIndex - pendingInserts.value.length) + 1);
}

</script>

<template>
  <section class="db-layout">
    <aside class="db-sidebar card">
      <div class="db-sidebar-header">
        <p class="eyebrow">Connection</p>
        <h1 class="title-with-icon">
          <MdiIcon :path="mdiDatabaseOutline" :size="20" />
          <span>{{ connection.name }}</span>
        </h1>
      </div>

      <label>
        <span>Database / Schema</span>
        <select v-model="selectedSchema" @change="handleSchemaChange">
          <option v-for="schema in schemas" :key="schema" :value="schema">{{ schema }}</option>
        </select>
      </label>

      <div class="table-menu">
        <div class="subheader">
          <h2>Tables</h2>
          <div class="actions">
            <span class="badge">{{ tables.length }}</span>
            <button
              class="secondary icon-button"
              title="New Table"
              aria-label="New Table"
              :disabled="isReadonlyConnection"
              @click="openTableModal('create')"
            >
              <MdiIcon :path="mdiPlusCircleOutline" />
            </button>
          </div>
        </div>
        <button
          v-for="table in tables"
          :key="table"
          class="table-menu-item"
          :class="{ active: table === selectedTable }"
          @click="selectTable(table)"
        >
          <MdiIcon :path="mdiFileTableOutline" :size="16" />
          <span>{{ table }}</span>
        </button>
      </div>
    </aside>

    <section class="db-content">
      <header class="panel-shell">
        <div class="panel-header compact">
          <div>
            <p class="eyebrow">Table Workspace</p>
            <h1 class="title-with-icon">
              <MdiIcon :path="mdiTableEdit" :size="20" />
              <span>{{ selectedTable || "Choose a table" }}</span>
            </h1>
          </div>
          <div class="actions" v-if="selectedSchema">
            <button class="secondary action-button" :disabled="isReadonlyConnection || !hasSelectedTable" @click="openTableModal('rename')">
              <MdiIcon :path="mdiTableEdit" />
              <span>Rename</span>
            </button>
            <button class="danger action-button" :disabled="isReadonlyConnection || !hasSelectedTable" @click="openTableModal('delete')">
              <MdiIcon :path="mdiDeleteOutline" />
              <span>Delete</span>
            </button>
            <button class="secondary action-button" :disabled="!hasSelectedTable" @click="activeTab = 'columns'">
              <MdiIcon :path="mdiTableColumn" />
              <span>Open Columns</span>
            </button>
          </div>
        </div>

        <nav class="tabs">
          <button :class="{ active: activeTab === 'columns' }" title="Columns" aria-label="Columns" @click="activeTab = 'columns'">
            <MdiIcon :path="mdiTableColumn" />
          </button>
          <button :class="{ active: activeTab === 'data' }" title="Data" aria-label="Data" @click="activeTab = 'data'">
            <MdiIcon :path="mdiFileTableOutline" />
          </button>
          <button :class="{ active: activeTab === 'pending' }" @click="activeTab = 'pending'">
            <MdiIcon :path="mdiFormatListBulletedSquare" />
            <span class="badge">{{ pendingChanges.length }}</span>
          </button>
          <button :class="{ active: activeTab === 'logs' }" title="Logs" aria-label="Logs" @click="activeTab = 'logs'">
            <MdiIcon :path="mdiTextBoxSearchOutline" />
          </button>
        </nav>
      </header>

      <section v-if="activeTab === 'data'" class="surface-stack">
        <div class="card">
          <div class="data-tools">
            <div class="search-toolbar">
              <select v-model="selectedSearchColumn">
                <option value="__all__">All</option>
                <option v-for="column in searchableColumns" :key="column.name" :value="column.name">
                  {{ column.name }}
                </option>
              </select>
              <input v-model="keyword" placeholder="Search keyword" @keydown.enter="emitQuery(0)" />
              <button class="icon-button" title="Run Query" aria-label="Run Query" @click="emitQuery(0)">
                <MdiIcon :path="mdiMagnify" />
              </button>
            </div>
          </div>

          <div class="subheader">
            <div class="rows-meta">
              <select v-model="pageSize" @change="emitQuery(0)">
                <option value="25">25 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
                <option value="200">200 rows</option>
              </select>
              <div class="pagination">
                <button class="secondary icon-button" title="Previous Page" aria-label="Previous Page" :disabled="currentPage <= 1" @click="emitQuery(currentPage - 2)">
                  <MdiIcon :path="mdiChevronLeft" />
                </button>
                <div class="page-input">
                  <input v-model="pageInput" @keydown.enter="goToPage" />
                </div>
                <span class="page-total">/ {{ totalPages }}</span>
                <button class="secondary icon-button" title="Next Page" aria-label="Next Page" :disabled="currentPage >= totalPages" @click="emitQuery(currentPage)">
                  <MdiIcon :path="mdiChevronRight" />
                </button>
              </div>
            </div>
          </div>

          <div class="data-grid">
            <table v-if="visibleColumns.length">
              <thead>
                <tr>
                  <th class="index-column">#</th>
                  <th
                    v-for="column in visibleColumns"
                    :key="column.name"
                    :class="{ 'identity-cell': isWideIdentityColumn(column.name) }"
                  >
                    {{ column.name }}
                  </th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(entry, entryIndex) in rowsForDisplay"
                  :key="entry.id"
                  :class="{
                    'pending-delete-row': entry.kind === 'existing' && pendingDeletes[entry.id],
                    'pending-insert-row': entry.kind === 'insert'
                  }"
                >
                  <td class="index-column">{{ displayRowNumber(entryIndex, entry.kind) }}</td>
                  <td
                    v-for="column in visibleColumns"
                    :key="column.name"
                    :class="{
                      'changed-cell': entry.kind === 'insert'
                        ? String(entry.row[column.name] ?? '') !== ''
                        : cellChanged(entry.row, column.name),
                      'deleted-cell': entry.kind === 'existing' && pendingDeletes[entry.id],
                      'identity-cell': isWideIdentityColumn(column.name)
                    }"
                  >
                    <DateTimeEditor
                      v-if="columnInputKind(column.name) === 'datetime-local'"
                      :model-value="String(cellDisplayValue(entry.row, column.name))"
                      :on-commit="(value) => entry.kind === 'existing' && isEditableColumn(column.name) && setDraftValue(entry.row, column.name, value)"
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id]) || !isEditableColumn(column.name)"
                      placeholder="Set datetime"
                      @update:modelValue="entry.kind === 'existing' && isEditableColumn(column.name) && setDraftValue(entry.row, column.name, $event)"
                    />
                    <input
                      v-else-if="columnInputKind(column.name) !== 'textarea' && columnInputKind(column.name) !== 'checkbox'"
                      :type="columnInputKind(column.name)"
                      :value="String(cellDisplayValue(entry.row, column.name))"
                      :class="{
                        'changed-input': entry.kind === 'insert'
                          ? String(entry.row[column.name] ?? '') !== ''
                          : cellChanged(entry.row, column.name),
                        'deleted-input': entry.kind === 'existing' && pendingDeletes[entry.id],
                        'readonly-input': !isEditableColumn(column.name),
                        'identity-input': isWideIdentityColumn(column.name)
                      }"
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id]) || !isEditableColumn(column.name)"
                      @input="entry.kind === 'existing' && isEditableColumn(column.name) && handleCellInput(entry.row, column.name, $event)"
                    />
                    <input
                      v-else-if="columnInputKind(column.name) === 'checkbox'"
                      type="checkbox"
                      :checked="Boolean(cellDisplayValue(entry.row, column.name))"
                      :class="{
                        'changed-input': entry.kind === 'insert'
                          ? Boolean(entry.row[column.name])
                          : cellChanged(entry.row, column.name),
                        'deleted-input': entry.kind === 'existing' && pendingDeletes[entry.id],
                        'readonly-input': !isEditableColumn(column.name)
                      }"
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id]) || !isEditableColumn(column.name)"
                      @change="entry.kind === 'existing' && isEditableColumn(column.name) && handleCellInput(entry.row, column.name, $event)"
                    />
                    <button
                      v-else
                      type="button"
                      class="text-link-button"
                      :class="{
                        'changed-input': entry.kind === 'insert'
                          ? String(entry.row[column.name] ?? '') !== ''
                          : cellChanged(entry.row, column.name),
                        'deleted-input': entry.kind === 'existing' && pendingDeletes[entry.id],
                        'readonly-input': !isEditableColumn(column.name)
                      }"
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id]) || !isEditableColumn(column.name)"
                      @click="entry.kind === 'existing' && isEditableColumn(column.name) && openTextEditor(entry.row, column.name)"
                    >
                      {{ textButtonLabel(entry.row, column.name) }}
                    </button>
                  </td>
                  <td class="row-actions">
                    <button class="danger icon-button" title="Delete" aria-label="Delete" @click="entry.kind === 'insert'
                      ? cancelPendingChange({ kind: 'insert', tempId: entry.id, row: entry.row })
                      : stageDelete(entry.row)">
                      <MdiIcon :path="mdiDeleteOutline" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty-state">Select a table from the left menu to load data.</p>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'pending'" class="surface-stack">
        <div class="card">
          <div class="subheader">
            <h2>Pending Changes</h2>
            <div class="actions">
              <button class="secondary icon-button" title="Restore All" aria-label="Restore All" @click="clearAllPending">
                <MdiIcon :path="mdiRestore" />
              </button>
              <button
                class="icon-button"
                :title="applyingPending ? 'Applying Changes' : 'Apply All'"
                :aria-label="applyingPending ? 'Applying Changes' : 'Apply All'"
                :disabled="!pendingChanges.length || applyingPending"
                @click="applyAllPending"
              >
                <MdiIcon :path="mdiPlayCircleOutline" />
              </button>
            </div>
          </div>

          <div v-if="pendingChanges.length" class="pending-stack">
            <div v-for="change in pendingChanges" :key="change.kind === 'insert' ? change.tempId : change.rowKey" class="pending-card">
                <div class="subheader">
                  <div class="pending-title">
                  <strong class="title-with-icon">
                    <MdiIcon :path="change.kind === 'insert' ? mdiPlusCircleOutline : change.kind === 'delete' ? mdiDeleteOutline : mdiTableEdit" :size="16" />
                    <span>{{ change.kind.toUpperCase() }}</span>
                  </strong>
                  <span class="badge">{{ selectedTable }}</span>
                  </div>
                <button class="secondary icon-button" title="Cancel Pending Change" aria-label="Cancel Pending Change" @click="cancelPendingChange(change)">
                  <MdiIcon :path="mdiRestore" />
                </button>
                </div>

              <div class="data-grid">
                <table>
                  <thead>
                    <tr>
                      <th v-for="column in visibleColumns" :key="column.name">{{ column.name }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td
                        v-for="column in visibleColumns"
                        :key="column.name"
                        :class="pendingCellClass(change, column.name)"
                      >
                        <template v-if="change.kind === 'insert'">
                          {{ change.row[column.name] ?? "" }}
                        </template>
                        <template v-else-if="change.kind === 'delete'">
                          {{ change.row[column.name] ?? "" }}
                        </template>
                        <template v-else>
                          {{ change.values[column.name] ?? change.originalRow[column.name] ?? "" }}
                        </template>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <p v-else class="empty-state">No pending inserts, updates, or deletes.</p>
        </div>

        <div class="card">
          <div class="subheader">
            <h2>Stage New Row</h2>
            <button
              class="action-button"
              title="Add To Pending"
              aria-label="Add To Pending"
              :disabled="!hasInsertDraftValues"
              @click="stageInsert"
            >
              <MdiIcon :path="mdiPlusCircleOutline" />
              <span>Stage Row</span>
            </button>
          </div>
          <div class="data-grid">
            <table v-if="visibleColumns.length">
              <thead>
                <tr>
                  <th class="index-column">#</th>
                  <th
                    v-for="column in visibleColumns"
                    :key="column.name"
                    :class="{ 'identity-cell': isWideIdentityColumn(column.name) }"
                  >
                    {{ column.name }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="index-column">New</td>
                  <td
                    v-for="column in visibleColumns"
                    :key="column.name"
                    :class="{ 'identity-cell': isWideIdentityColumn(column.name) }"
                  >
                    <input
                      v-if="columnInputKind(column.name) !== 'textarea' && columnInputKind(column.name) !== 'checkbox' && columnInputKind(column.name) !== 'datetime-local'"
                      :type="columnInputKind(column.name)"
                      :value="String(insertDraft[column.name] ?? '')"
                      :disabled="!isEditableColumn(column.name)"
                      :class="{ 'readonly-input': !isEditableColumn(column.name), 'identity-input': isWideIdentityColumn(column.name) }"
                      @input="isEditableColumn(column.name) && handleInsertDraftInput(column.name, $event)"
                    />
              <DateTimeEditor
                v-else-if="columnInputKind(column.name) === 'datetime-local'"
                :model-value="String(insertDraft[column.name] ?? '')"
                :on-commit="(value) => isEditableColumn(column.name) && setInsertDraftValue(column.name, value)"
                :disabled="!isEditableColumn(column.name)"
                placeholder="Set datetime"
                @update:modelValue="isEditableColumn(column.name) && setInsertDraftValue(column.name, $event)"
              />
                    <input
                      v-else-if="columnInputKind(column.name) === 'checkbox'"
                      type="checkbox"
                      :checked="Boolean(insertDraft[column.name])"
                      :disabled="!isEditableColumn(column.name)"
                      :class="{ 'readonly-input': !isEditableColumn(column.name) }"
                      @change="isEditableColumn(column.name) && handleInsertDraftInput(column.name, $event)"
                    />
                    <button
                      v-else
                      type="button"
                      class="text-link-button"
                      :disabled="!isEditableColumn(column.name)"
                      :class="{ 'readonly-input': !isEditableColumn(column.name) }"
                      @click="isEditableColumn(column.name) && openInsertTextEditor(column.name)"
                    >
                      {{ String(insertDraft[column.name] ?? '').trim() || "Edit text" }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-else-if="activeTab === 'columns'" class="surface-stack">
        <div class="card">
          <div class="subheader">
            <h2>Columns</h2>
            <div class="actions">
              <button class="secondary action-button" :disabled="isReadonlyConnection || !hasSelectedTable" @click="addColumnDraft">
                <MdiIcon :path="mdiPlusCircleOutline" />
                <span>Add Column</span>
              </button>
              <button class="secondary action-button" :disabled="!hasColumnDraftChanges" @click="previewColumnActions">
                <MdiIcon :path="mdiMagnify" />
                <span>Preview</span>
              </button>
              <button class="action-button" :disabled="isReadonlyConnection || !hasColumnDraftChanges" @click="applyColumnActions">
                <MdiIcon :path="mdiPlayCircleOutline" />
                <span>Apply</span>
              </button>
              <button class="secondary action-button" :disabled="!hasColumnDraftChanges" @click="resetColumns">
                <MdiIcon :path="mdiRestore" />
                <span>Reset</span>
              </button>
            </div>
          </div>
          <table v-if="effectiveStructureColumns.length">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
                <th>PK</th>
                <th>Unique</th>
                <th>Auto Increment</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="column in effectiveStructureColumns" :key="column.id" :class="{ 'pending-insert-row': column.isNew, 'pending-delete-row': column.markedForDelete }">
                <td :class="{ 'changed-cell': columnCellChanged(column, 'name') }">
                  <input
                    :value="column.name"
                    :disabled="!isColumnFieldEditable(column, 'name')"
                    :class="{ 'changed-input': columnCellChanged(column, 'name'), 'readonly-input': !isColumnFieldEditable(column, 'name') }"
                    @input="updateColumnDraft(column.id, { name: ($event.target as HTMLInputElement).value })"
                  />
                </td>
                <td :class="{ 'changed-cell': columnCellChanged(column, 'dataType') }">
                  <select
                    :value="column.dataType"
                    :disabled="!isColumnFieldEditable(column, 'dataType')"
                    :class="{ 'changed-input': columnCellChanged(column, 'dataType'), 'readonly-input': !isColumnFieldEditable(column, 'dataType') }"
                    @change="updateColumnDraft(column.id, { dataType: ($event.target as HTMLSelectElement).value })"
                  >
                    <option v-for="option in tableTypeOptions" :key="option" :value="option">{{ option }}</option>
                  </select>
                </td>
                <td :class="{ 'changed-cell': columnCellChanged(column, 'nullable') }">
                  <input
                    type="checkbox"
                    :checked="column.nullable"
                    :disabled="!isColumnFieldEditable(column, 'nullable')"
                    :class="{ 'changed-input': columnCellChanged(column, 'nullable'), 'readonly-input': !isColumnFieldEditable(column, 'nullable') }"
                    @change="updateColumnDraft(column.id, { nullable: ($event.target as HTMLInputElement).checked })"
                  />
                </td>
                <td :class="{ 'changed-cell': columnCellChanged(column, 'defaultValue') }">
                  <input
                    :value="column.defaultValue ?? ''"
                    :disabled="!isColumnFieldEditable(column, 'defaultValue')"
                    :class="{ 'changed-input': columnCellChanged(column, 'defaultValue'), 'readonly-input': !isColumnFieldEditable(column, 'defaultValue') }"
                    @input="updateColumnDraft(column.id, { defaultValue: ($event.target as HTMLInputElement).value })"
                  />
                </td>
                <td>{{ column.primaryKey ? "YES" : "NO" }}</td>
                <td>{{ column.unique ? "YES" : "NO" }}</td>
                <td>{{ column.autoIncrement ? "YES" : "NO" }}</td>
                <td class="row-actions">
                  <button
                    class="danger icon-button"
                    title="Delete Column"
                    aria-label="Delete Column"
                    :disabled="!canDeleteColumn(column)"
                    @click="toggleColumnDelete(column.id)"
                  >
                    <MdiIcon :path="mdiDeleteOutline" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty-state">Choose a table to inspect and manage its columns.</p>
        </div>

      </section>

      <section v-else class="card">
        <div class="subheader">
          <h2>Operation Logs</h2>
          <span class="badge">{{ logs.length }}</span>
        </div>
        <ul v-if="logs.length" class="log-list">
          <li v-for="log in logs" :key="log.id">
            <strong class="title-with-icon">
              <MdiIcon :path="log.success ? mdiCheckCircleOutline : mdiDeleteOutline" :size="16" />
              <span>{{ log.operation }}</span>
            </strong>
            <span>{{ log.objectName }}</span>
            <em>{{ new Date(log.timestamp).toLocaleString() }}</em>
            <b :class="log.success ? 'ok' : 'bad'">{{ log.success ? "Success" : "Failed" }}</b>
          </li>
        </ul>
        <p v-else class="empty-state">No operations yet.</p>
      </section>

      <div v-if="textEditor" class="modal-backdrop" @click.self="closeTextEditor">
        <div class="modal-card">
          <div class="subheader">
            <h2>{{ textEditor.columnName }}</h2>
            <div class="actions">
              <button class="secondary" type="button" @click="closeTextEditor">Cancel</button>
              <button type="button" @click="applyTextEditor">Apply</button>
            </div>
          </div>
          <textarea v-model="textEditor.value" rows="12" class="modal-textarea" />
        </div>
      </div>

      <div v-if="tableActionModal" class="modal-backdrop" @click.self="closeTableModal">
        <div class="modal-card">
          <div class="subheader">
            <h2>
              {{
                tableActionModal === 'create'
                  ? 'Create Table'
                  : tableActionModal === 'rename'
                    ? 'Rename Table'
                    : 'Delete Table'
              }}
            </h2>
            <div class="actions">
              <button class="secondary" type="button" @click="closeTableModal">Cancel</button>
              <button class="secondary" type="button" @click="previewCurrentTableAction">Preview SQL</button>
              <button type="button" @click="applyCurrentTableAction">
                {{ tableActionModal === 'delete' ? 'Delete' : tableActionModal === 'create' ? 'Create' : 'Rename' }}
              </button>
            </div>
          </div>

          <div v-if="tableActionModal === 'create'" class="surface-stack">
            <label>
              <span>Table Name</span>
              <input v-model="tableNameDraft" placeholder="users" />
            </label>
            <div class="subheader">
              <h2>Columns</h2>
              <button class="secondary action-button" type="button" @click="addCreateTableColumn">
                <MdiIcon :path="mdiPlusCircleOutline" />
                <span>Add Column</span>
              </button>
            </div>
            <div class="modal-grid" v-for="column in createTableColumns" :key="column.id">
              <input :value="column.name" placeholder="Column name" @input="updateCreateTableColumn(column.id, { name: ($event.target as HTMLInputElement).value })" />
              <select :value="column.dataType" @change="updateCreateTableColumn(column.id, { dataType: ($event.target as HTMLSelectElement).value })">
                <option v-for="option in tableTypeOptions" :key="option" :value="option">{{ option }}</option>
              </select>
              <input
                :value="column.defaultValue"
                placeholder="Default value"
                :disabled="!createColumnSupportsDefault(column)"
                @input="updateCreateTableColumn(column.id, { defaultValue: ($event.target as HTMLInputElement).value })"
              />
              <label class="inline-check">
                <input
                  type="checkbox"
                  :checked="column.nullable"
                  :disabled="column.primaryKey || column.autoIncrement"
                  @change="updateCreateTableColumn(column.id, { nullable: ($event.target as HTMLInputElement).checked })"
                />
                Nullable
              </label>
              <label class="inline-check">
                <input
                  type="checkbox"
                  :checked="column.primaryKey"
                  @change="updateCreateTableColumn(column.id, { primaryKey: ($event.target as HTMLInputElement).checked })"
                />
                PK
              </label>
              <label class="inline-check">
                <input
                  type="checkbox"
                  :checked="column.unique"
                  :disabled="column.autoIncrement"
                  @change="updateCreateTableColumn(column.id, { unique: ($event.target as HTMLInputElement).checked })"
                />
                Unique
              </label>
              <label class="inline-check">
                <input
                  type="checkbox"
                  :checked="column.autoIncrement"
                  :disabled="!createColumnSupportsAutoIncrement(column)"
                  @change="updateCreateTableColumn(column.id, { autoIncrement: ($event.target as HTMLInputElement).checked })"
                />
                Auto
              </label>
              <button class="danger icon-button" type="button" :disabled="createTableColumns.length <= 1" @click="removeCreateTableColumn(column.id)">
                <MdiIcon :path="mdiDeleteOutline" />
              </button>
            </div>
          </div>

          <div v-else-if="tableActionModal === 'rename'" class="surface-stack">
            <label>
              <span>New Table Name</span>
              <input v-model="tableNameDraft" />
            </label>
          </div>

          <div v-else class="surface-stack">
            <p>Type <strong>{{ selectedTable }}</strong> to confirm table deletion.</p>
            <input v-model="deleteConfirmationDraft" :placeholder="selectedTable" />
          </div>
        </div>
      </div>

      <div v-if="sqlPreview?.statements?.length" class="card preview-card">
        <div class="subheader">
          <h2>{{ sqlPreview.title }}</h2>
          <span class="badge">{{ sqlPreview.statements.length }}</span>
        </div>
        <pre>{{ sqlPreview.statements.join('\n') }}</pre>
      </div>
    </section>
  </section>
</template>
