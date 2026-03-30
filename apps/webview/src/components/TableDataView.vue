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
  sqlPreview?: { title: string; statements: string[] } | null;
  applySignal: number;
}>();

const emit = defineEmits<{
  query: [query: TableQuery];
  applyChanges: [payload: { schema?: string; table: string; changes: PendingTableChange[] }];
  preview: [payload: { action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn"; schema?: string; table: string; nextTable?: string; column?: string; nextColumn?: string; definition?: Partial<TableSchema> }];
  apply: [payload: { action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn"; schema?: string; table: string; nextTable?: string; column?: string; nextColumn?: string; definition?: Partial<TableSchema> }];
}>();

const activeTab = ref<"structure" | "data" | "pending" | "logs">("data");
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
const searchableColumns = computed(() =>
  visibleColumns.value.filter((column) => /(char|text|clob|json|uuid|varchar)/i.test(column.dataType))
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
      Object.entries(draft).filter(([column, value]) => String(row[column] ?? "") !== value)
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
  pendingInserts.value = [
    ...pendingInserts.value,
    {
      kind: "insert",
      tempId: `insert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      row: { ...insertDraft.value }
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
  const changes = pendingChanges.value.map((change) =>
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
  );
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
          <span class="badge">{{ tables.length }}</span>
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
        </div>

        <nav class="tabs">
          <button :class="{ active: activeTab === 'structure' }" title="Structure" aria-label="Structure" @click="activeTab = 'structure'">
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
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id]) || !isEditableColumn(column.name)"
                      placeholder="Set datetime"
                      @update:model-value="entry.kind === 'existing' && isEditableColumn(column.name) && setDraftValue(entry.row, column.name, $event)"
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
            <button class="icon-button" title="Add To Pending" aria-label="Add To Pending" @click="stageInsert">
              <MdiIcon :path="mdiPlusCircleOutline" />
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
                :disabled="!isEditableColumn(column.name)"
                placeholder="Set datetime"
                @update:model-value="isEditableColumn(column.name) && setInsertDraftValue(column.name, $event)"
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

      <section v-else-if="activeTab === 'structure'" class="surface-stack">
        <div class="card">
          <div class="subheader">
            <h2>Columns</h2>
            <div class="actions">
              <button
                class="secondary icon-button"
                title="Preview Add Column"
                aria-label="Preview Add Column"
                @click="emit('preview', { action: 'addColumn', schema: selectedSchema || undefined, table: selectedTable, column: 'new_column', definition: { columns: [{ name: 'new_column', dataType: 'TEXT', nullable: true, primaryKey: false, unique: false, autoIncrement: false }] } })"
              >
                <MdiIcon :path="mdiMagnify" />
              </button>
              <button
                class="icon-button"
                title="Apply Add Column"
                aria-label="Apply Add Column"
                @click="emit('apply', { action: 'addColumn', schema: selectedSchema || undefined, table: selectedTable, column: 'new_column', definition: { columns: [{ name: 'new_column', dataType: 'TEXT', nullable: true, primaryKey: false, unique: false, autoIncrement: false }] } })"
              >
                <MdiIcon :path="mdiCheckCircleOutline" />
              </button>
            </div>
          </div>
          <table v-if="structure">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
                <th>PK</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="column in structure.columns" :key="column.name">
                <td>{{ column.name }}</td>
                <td>{{ column.dataType }}</td>
                <td>{{ column.nullable ? "YES" : "NO" }}</td>
                <td>{{ column.defaultValue ?? "" }}</td>
                <td>{{ column.primaryKey ? "YES" : "NO" }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty-state">Choose a table to inspect its structure.</p>
        </div>

        <div v-if="sqlPreview" class="card preview-card">
          <div class="subheader">
            <h2>{{ sqlPreview.title }}</h2>
          </div>
          <pre>{{ sqlPreview.statements.join("\n\n") }}</pre>
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
    </section>
  </section>
</template>
