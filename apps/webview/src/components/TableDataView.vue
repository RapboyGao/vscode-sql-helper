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

type RowDraftMap = Record<string, Record<string, string>>;
type DeleteMap = Record<string, boolean>;

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
const selectedSchema = ref(props.selectedSchema ?? props.schemas[0] ?? "");
const selectedTable = ref(props.selectedTable ?? props.tables[0] ?? "");
const pageInput = ref(String((props.query.page ?? 0) + 1));
const pageSize = ref(String(props.query.pageSize ?? 50));
const insertDraft = ref<Record<string, string>>({});
const rowDrafts = ref<RowDraftMap>({});
const pendingDeletes = ref<DeleteMap>({});
const pendingInserts = ref<PendingTableInsert[]>([]);
const applyingPending = ref(false);

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
    pageInput.value = String((value.page ?? 0) + 1);
    pageSize.value = String(value.pageSize ?? 50);
  },
  { deep: true }
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
const visibleColumns = computed(() => props.result?.columns ?? props.structure?.columns ?? []);

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

function setDraftValue(row: Record<string, unknown>, columnName: string, value: string): void {
  const key = rowKey(row);
  rowDrafts.value = {
    ...rowDrafts.value,
    [key]: {
      ...(rowDrafts.value[key] ?? {}),
      [columnName]: value
    }
  };
}

function draftValue(row: Record<string, unknown>, columnName: string): string {
  const key = rowKey(row);
  return rowDrafts.value[key]?.[columnName] ?? String(row[columnName] ?? "");
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

function emitQuery(nextPage = 0): void {
  emit("query", {
    ...props.query,
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    keyword: keyword.value,
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
  emit("applyChanges", {
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    changes: pendingChanges.value
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
    "changed-cell": Object.prototype.hasOwnProperty.call(change.values, column)
  };
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
              <input v-model="keyword" placeholder="Search keyword" @keydown.enter="emitQuery(0)" />
              <button class="icon-button" title="Run Query" aria-label="Run Query" @click="emitQuery(0)">
                <MdiIcon :path="mdiMagnify" />
              </button>
            </div>
          </div>

          <div class="subheader">
            <h2>Rows</h2>
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
                <label class="page-input">
                  <span>Page</span>
                  <input v-model="pageInput" @keydown.enter="goToPage" />
                </label>
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
                  <th v-for="column in visibleColumns" :key="column.name">{{ column.name }}</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in rowsForDisplay"
                  :key="entry.id"
                  :class="{
                    'pending-delete-row': entry.kind === 'existing' && pendingDeletes[entry.id],
                    'pending-insert-row': entry.kind === 'insert'
                  }"
                >
                  <td
                    v-for="column in visibleColumns"
                    :key="column.name"
                    :class="{
                      'changed-cell': entry.kind === 'insert'
                        ? String(entry.row[column.name] ?? '') !== ''
                        : changeColumnsForRow(entry.row).has(column.name),
                      'deleted-cell': entry.kind === 'existing' && pendingDeletes[entry.id]
                    }"
                  >
                    <input
                      :value="entry.kind === 'insert' ? String(entry.row[column.name] ?? '') : draftValue(entry.row, column.name)"
                      :class="{
                        'changed-input': entry.kind === 'insert'
                          ? String(entry.row[column.name] ?? '') !== ''
                          : changeColumnsForRow(entry.row).has(column.name),
                        'deleted-input': entry.kind === 'existing' && pendingDeletes[entry.id]
                      }"
                      :disabled="entry.kind === 'insert' || Boolean(pendingDeletes[entry.id])"
                      @input="entry.kind === 'existing' && setDraftValue(entry.row, column.name, ($event.target as HTMLInputElement).value)"
                    />
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
              <button class="icon-button" title="Apply All" aria-label="Apply All" :disabled="!pendingChanges.length" @click="applyAllPending">
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
                          <div class="pending-diff-cell">
                            <span class="before">{{ change.originalRow[column.name] ?? "" }}</span>
                            <span class="after">{{ change.values[column.name] ?? change.originalRow[column.name] ?? "" }}</span>
                          </div>
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
          <div class="grid">
            <label v-for="column in visibleColumns" :key="column.name">
              <span>{{ column.name }}</span>
              <input v-model="insertDraft[column.name]" />
            </label>
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
    </section>
  </section>
</template>
