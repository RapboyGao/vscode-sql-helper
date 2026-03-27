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
  "export-database": [];
  "export-table": [];
  "reset-structure": [];
  "apply-structure": [];
}>();
</script>

<template>
  <div class="studio-layout">
    <v-card class="studio-sidebar-card" variant="tonal">
      <v-card-item>
        <template #prepend>
          <v-avatar color="primary" variant="tonal">
            <v-icon icon="mdi-database" />
          </v-avatar>
        </template>
        <v-card-title>{{ openedFile?.name ?? activeProfile?.name ?? "Database" }}</v-card-title>
        <v-card-subtitle>SQLite workspace</v-card-subtitle>
      </v-card-item>

      <v-card-text class="d-flex flex-column ga-4">
        <v-alert type="info" variant="tonal" density="compact" icon="mdi-folder-outline" class="path-alert">
          {{ sqliteSchema?.path ?? openedFile?.path }}
        </v-alert>

        <v-list class="table-list-v" density="compact" nav lines="two">
          <v-list-item
            v-for="table in sqliteSchema?.tables ?? []"
            :key="table.name"
            :active="table.name === selectedTableName"
            rounded="xl"
            @click="emit('select-table', table.name)"
          >
            <template #prepend>
              <v-icon icon="mdi-table" />
            </template>
            <v-list-item-title>{{ table.name }}</v-list-item-title>
            <v-list-item-subtitle>{{ table.columns.length }} columns</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>

    <v-card class="studio-content-card d-flex flex-column" variant="flat">
      <v-card-item>
        <template #prepend>
          <v-avatar color="secondary" variant="tonal">
            <v-icon :icon="tableDetailTab === 'data' ? 'mdi-table-edit' : 'mdi-table-cog'" />
          </v-avatar>
        </template>
        <v-card-title>{{ activeTable?.name ?? "Choose a table" }}</v-card-title>
        <v-card-subtitle>Table workspace</v-card-subtitle>
        <template #append>
          <div class="d-flex flex-wrap ga-2 justify-end">
            <v-btn variant="tonal" prepend-icon="mdi-file-excel-outline" @click="emit('export-database')">
              Export DB
            </v-btn>
            <v-btn
              variant="tonal"
              prepend-icon="mdi-export"
              :disabled="!activeTable"
              @click="emit('export-table')"
            >
              Export Table
            </v-btn>
          </div>
        </template>
      </v-card-item>

      <v-tabs
        :model-value="tableDetailTab"
        color="primary"
        density="comfortable"
        @update:model-value="emit('update:tableDetailTab', $event as 'data' | 'structure')"
      >
        <v-tab value="data" prepend-icon="mdi-table-eye">Data</v-tab>
        <v-tab value="structure" prepend-icon="mdi-table-cog">Structure</v-tab>
      </v-tabs>

      <v-divider />

      <v-card-text class="studio-content-body d-flex flex-column">
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
          database-type="sqlite"
          @add-column="emit('add-column')"
          @remove-column="emit('remove-column', $event)"
          @reset="emit('reset-structure')"
          @apply="emit('apply-structure')"
        />
      </v-card-text>
    </v-card>
  </div>
</template>
