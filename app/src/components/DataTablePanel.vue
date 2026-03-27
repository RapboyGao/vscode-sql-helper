<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import PaginationBar from "./PaginationBar.vue";
import type { SqliteTable, TableDataPayload, TableDataRow } from "../types";

const props = defineProps<{
  activeTable: SqliteTable | null;
  tableData: TableDataPayload | null;
  tableDataPending: boolean;
  tableDataError: string;
  tableSearch: string;
  newRowDraft: Record<string, string> | null;
  newRowPending: boolean;
  dirtyRows: Record<string, Record<string, string>>;
  rowSavePending: Record<string, boolean>;
}>();

const emit = defineEmits<{
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
}>();

const SEARCH_DEBOUNCE_MS = 300;
const localSearch = ref(props.tableSearch);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.tableSearch,
  (value) => {
    localSearch.value = value;
  }
);

onBeforeUnmount(() => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
});

function triggerSearch(nextValue: string, immediate = false): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  if (immediate) {
    emit("update:tableSearch", nextValue);
    emit("search");
    return;
  }

  searchTimer = setTimeout(() => {
    emit("update:tableSearch", nextValue);
    emit("search");
    searchTimer = null;
  }, SEARCH_DEBOUNCE_MS);
}

function handleSearchInput(value: string | null): void {
  const nextValue = value ?? "";
  localSearch.value = nextValue;
  triggerSearch(nextValue);
}

function clearSearch(): void {
  localSearch.value = "";
  triggerSearch("", true);
}

function rowKeyId(row: TableDataRow): string {
  return JSON.stringify(row.rowKey);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function editableValue(row: TableDataRow, columnName: string): string {
  return props.dirtyRows[rowKeyId(row)]?.[columnName] ?? displayValue(row.values[columnName]);
}

function normalizeColumnType(type: string | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

function isIntegerColumn(type: string | undefined): boolean {
  return normalizeColumnType(type).includes("int");
}

function isDateColumn(type: string | undefined): boolean {
  return normalizeColumnType(type) === "date";
}

function isTimeColumn(type: string | undefined): boolean {
  return normalizeColumnType(type) === "time";
}

function isDateTimeColumn(type: string | undefined): boolean {
  const normalized = normalizeColumnType(type);
  return normalized.includes("datetime") || normalized.includes("timestamp");
}

function toTemporalInputValue(value: string, type: string | undefined): string {
  if (!value) {
    return "";
  }
  if (isDateColumn(type)) {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? value;
  }
  if (isTimeColumn(type)) {
    const timePart = value.includes("T") ? value.split("T")[1] : value.includes(" ") ? value.split(" ")[1] : value;
    return timePart.replace(/([+-]\d{2}:\d{2}|Z)$/i, "");
  }
  if (isDateTimeColumn(type)) {
    const normalized = value.replace(" ", "T").replace(/([+-]\d{2}:\d{2}|Z)$/i, "");
    return normalized.slice(0, 19);
  }
  return value;
}

function fromTemporalInputValue(value: string, type: string | undefined): string {
  if (!value) {
    return "";
  }
  if (isDateTimeColumn(type)) {
    return value.replace("T", " ");
  }
  return value;
}

function isCellDirty(row: TableDataRow, columnName: string): boolean {
  return Object.prototype.hasOwnProperty.call(props.dirtyRows[rowKeyId(row)] ?? {}, columnName);
}

function isRowDirty(row: TableDataRow): boolean {
  return Object.keys(props.dirtyRows[rowKeyId(row)] ?? {}).length > 0;
}

function isReadonlyColumn(column: SqliteTable["columns"][number]): boolean {
  return column.autoIncrement;
}

function inputType(column: SqliteTable["columns"][number]): string {
  if (isDateTimeColumn(column.type)) return "datetime-local";
  if (isDateColumn(column.type)) return "date";
  if (isTimeColumn(column.type)) return "time";
  if (isIntegerColumn(column.type)) return "number";
  return "text";
}
</script>

<template>
  <div class="table-tab-panel">
    <v-card class="search-surface" variant="tonal">
      <v-card-text class="d-flex flex-wrap align-center ga-4">
        <v-text-field
          :model-value="localSearch"
          class="search-field"
          prepend-inner-icon="mdi-magnify"
          clearable
          label="Fuzzy search current table"
          @update:model-value="handleSearchInput(($event as string | null) ?? '')"
          @click:clear="clearSearch"
          @keydown.enter.prevent="triggerSearch(localSearch, true)"
        />
        <v-btn color="secondary" prepend-icon="mdi-table-row-plus-after" @click="emit('add-row')">
          Add Row
        </v-btn>
      </v-card-text>
    </v-card>

    <v-alert v-if="tableDataError" type="error" variant="tonal" icon="mdi-alert-circle-outline">
      {{ tableDataError }}
    </v-alert>
    <v-alert
      v-else-if="tableDataPending"
      type="info"
      variant="tonal"
      icon="mdi-database-sync-outline"
    >
      Loading rows…
    </v-alert>

    <v-card v-else-if="newRowDraft || tableData?.rows.length" class="results-surface" variant="tonal">
      <PaginationBar
        :page="tableData?.page ?? 0"
        :page-size="tableData?.pageSize ?? 30"
        :total-rows="tableData?.totalRows ?? 0"
        :pending="tableDataPending"
        @page="emit('page', $event)"
      />

      <div class="grid-scroll">
        <table class="result-table">
          <thead>
            <tr>
              <th v-for="column in activeTable?.columns ?? []" :key="column.name">{{ column.name }}</th>
              <th class="sticky-action-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="newRowDraft">
              <td v-for="column in activeTable?.columns ?? []" :key="`new:${column.name}`">
                <v-text-field
                  :model-value="
                    isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                      ? toTemporalInputValue(newRowDraft[column.name] ?? '', column.type)
                      : (newRowDraft[column.name] ?? '')
                  "
                  :type="inputType(column)"
                  :disabled="isReadonlyColumn(column)"
                  :placeholder="isReadonlyColumn(column) ? 'Auto increment' : ''"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="grid-field"
                  @update:model-value="
                    emit(
                      'update-new-cell',
                      column.name,
                      isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                        ? fromTemporalInputValue(String($event ?? ''), column.type)
                        : String($event ?? '')
                    )
                  "
                />
              </td>
              <td class="sticky-action-col">
                <div class="row-action-group">
                  <v-btn
                    icon="mdi-plus"
                    color="secondary"
                    variant="tonal"
                    :loading="newRowPending"
                    @click="emit('insert-row')"
                  />
                  <v-btn icon="mdi-close" variant="text" @click="emit('reset-new-row')" />
                </div>
              </td>
            </tr>

            <tr v-for="row in tableData?.rows ?? []" :key="rowKeyId(row)">
              <td v-for="column in activeTable?.columns ?? []" :key="`${rowKeyId(row)}:${column.name}`">
                <v-text-field
                  :model-value="
                    isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                      ? toTemporalInputValue(editableValue(row, column.name), column.type)
                      : editableValue(row, column.name)
                  "
                  :type="inputType(column)"
                  :disabled="isReadonlyColumn(column)"
                  :class="{ 'dirty-field': isCellDirty(row, column.name) }"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="grid-field"
                  @update:model-value="
                    emit(
                      'update-cell',
                      row,
                      column.name,
                      isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                        ? fromTemporalInputValue(String($event ?? ''), column.type)
                        : String($event ?? '')
                    )
                  "
                />
              </td>
              <td class="sticky-action-col">
                <div class="row-action-group">
                  <template v-if="isRowDirty(row)">
                    <v-btn
                      icon="mdi-content-save-outline"
                      color="secondary"
                      variant="tonal"
                      :loading="rowSavePending[rowKeyId(row)]"
                      @click="emit('save-row', row)"
                    />
                    <v-btn icon="mdi-restore" variant="text" @click="emit('reset-row', row)" />
                  </template>
                  <v-btn icon="mdi-delete-outline" color="error" variant="text" @click="emit('delete-row', row)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </v-card>

    <v-empty-state
      v-else
      class="empty-state-surface"
      icon="mdi-table-off"
      headline="No rows loaded"
      text="Load a table or add a row to start editing."
      title=""
    />
  </div>
</template>
