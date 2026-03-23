<script setup lang="ts">
import DataTablePanel from "./DataTablePanel.vue";
import StructureEditor from "./StructureEditor.vue";
import type {
  ColumnSchemaDraft,
  DatabaseProfile,
  InitState,
  SqliteSchema,
  SqliteTable,
  TableDataPayload,
  TableDataRow
} from "../types";

defineProps<{
  openedFile: InitState["openedFile"];
  activeProfile: DatabaseProfile | null;
  sqliteSchema: SqliteSchema | null;
  selectedTableName: string;
  activeTable: SqliteTable | null;
  tableDetailTab: "data" | "structure";
  tableSearch: string;
  tableData: TableDataPayload | null;
  tableDataPending: boolean;
  tableDataError: string;
  newRowDraft: Record<string, string> | null;
  newRowPending: boolean;
  dirtyRows: Record<string, Record<string, string>>;
  rowSavePending: Record<string, boolean>;
  structureDraft: ColumnSchemaDraft[];
  structurePending: boolean;
  structureError: string;
}>();

const emit = defineEmits<{
  "select-table": [tableName: string];
  "update:tableDetailTab": [tab: "data" | "structure"];
  "update:tableSearch": [value: string];
  search: [];
  clear: [];
  "add-row": [];
  page: [page: number];
  "update-new-cell": [columnName: string, value: string];
  "insert-row": [];
  "reset-new-row": [];
  "update-cell": [row: TableDataRow, columnName: string, value: string];
  "save-row": [row: TableDataRow];
  "reset-row": [row: TableDataRow];
  "delete-row": [row: TableDataRow];
  "add-column": [];
  "remove-column": [index: number];
  "reset-structure": [];
  "apply-structure": [];
}>();
</script>

<template>
  <section class="db-studio">
    <aside class="studio-sidebar panel">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">SQLite Database</p>
          <h2>{{ openedFile?.name ?? activeProfile?.name ?? "Database" }}</h2>
        </div>
      </div>

      <p class="schema-path">{{ sqliteSchema?.path ?? openedFile?.path }}</p>
      <div class="status-badge">{{ sqliteSchema?.tableCount ?? 0 }} tables</div>

      <div class="table-list">
        <button
          v-for="table in sqliteSchema?.tables ?? []"
          :key="table.name"
          type="button"
          class="table-select-btn"
          :class="{ active: table.name === selectedTableName }"
          @click="emit('select-table', table.name)"
        >
          <div class="table-select-content">
            <strong class="table-item-title">{{ table.name }}</strong>
            <span class="table-item-meta">{{ table.columns.length }} columns</span>
          </div>
        </button>
      </div>
    </aside>

    <section class="sqlite-content panel">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">Table Workspace</p>
          <h2>{{ activeTable?.name ?? "Choose a table" }}</h2>
        </div>
        <div class="table-toolbar">
          <button
            type="button"
            class="tab-button"
            :class="{ active: tableDetailTab === 'data' }"
            @click="emit('update:tableDetailTab', 'data')"
          >
            Data
          </button>
          <button
            type="button"
            class="tab-button"
            :class="{ active: tableDetailTab === 'structure' }"
            @click="emit('update:tableDetailTab', 'structure')"
          >
            Structure
          </button>
        </div>
      </div>

      <DataTablePanel
        v-if="tableDetailTab === 'data'"
        :active-table="activeTable"
        :table-data="tableData"
        :table-data-pending="tableDataPending"
        :table-data-error="tableDataError"
        :table-search="tableSearch"
        :new-row-draft="newRowDraft"
        :new-row-pending="newRowPending"
        :dirty-rows="dirtyRows"
        :row-save-pending="rowSavePending"
        @update:table-search="emit('update:tableSearch', $event)"
        @search="emit('search')"
        @clear="emit('clear')"
        @add-row="emit('add-row')"
        @page="emit('page', $event)"
        @update-new-cell="(columnName, value) => emit('update-new-cell', columnName, value)"
        @insert-row="emit('insert-row')"
        @reset-new-row="emit('reset-new-row')"
        @update-cell="(row, columnName, value) => emit('update-cell', row, columnName, value)"
        @save-row="emit('save-row', $event)"
        @reset-row="emit('reset-row', $event)"
        @delete-row="emit('delete-row', $event)"
      />

      <StructureEditor
        v-else
        :structure-draft="structureDraft"
        :structure-error="structureError"
        :structure-pending="structurePending"
        @add-column="emit('add-column')"
        @remove-column="emit('remove-column', $event)"
        @reset="emit('reset-structure')"
        @apply="emit('apply-structure')"
      />
    </section>
  </section>
</template>
