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
  emit("update:tableSearch", nextValue);

  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  if (immediate) {
    emit("search");
    return;
  }

  searchTimer = setTimeout(() => {
    emit("search");
    searchTimer = null;
  }, SEARCH_DEBOUNCE_MS);
}

function handleSearchInput(value: string): void {
  localSearch.value = value;
  triggerSearch(value);
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
</script>

<template>
  <div class="table-tab-panel">
    <div class="table-search-bar">
      <div class="search-input-wrap">
        <input
          :value="localSearch"
          class="input search-input"
          type="text"
          placeholder="Fuzzy search current table"
          @input="handleSearchInput(($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="triggerSearch(localSearch, true)"
        />
        <button
          v-if="localSearch"
          type="button"
          class="search-clear-button"
          title="Clear search"
          @click="clearSearch"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      <button type="button" class="button-ghost" @click="emit('add-row')">Add Row</button>
    </div>

    <PaginationBar
      :page="tableData?.page ?? 0"
      :page-size="tableData?.pageSize ?? 30"
      :total-rows="tableData?.totalRows ?? 0"
      :pending="tableDataPending"
      @page="emit('page', $event)"
    />

    <p v-if="tableDataError" class="error">{{ tableDataError }}</p>
    <p v-else-if="tableDataPending" class="empty">Loading rows…</p>

    <div v-else-if="newRowDraft || tableData?.rows.length" class="data-grid-wrap">
      <table class="data-grid data-grid-rows">
        <thead>
          <tr>
            <th v-for="column in activeTable?.columns ?? []" :key="column.name">{{ column.name }}</th>
            <th class="action-head">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="newRowDraft">
            <td v-for="column in activeTable?.columns ?? []" :key="`new:${column.name}`">
              <input
                v-if="isIntegerColumn(column.type)"
                :value="newRowDraft[column.name] ?? ''"
                class="grid-input integer-input dirty"
                type="number"
                step="1"
                @input="emit('update-new-cell', column.name, ($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)"
                :value="toTemporalInputValue(newRowDraft[column.name] ?? '', column.type)"
                class="grid-input temporal-input dirty"
                :type="isDateTimeColumn(column.type) ? 'datetime-local' : isDateColumn(column.type) ? 'date' : 'time'"
                :step="isDateTimeColumn(column.type) || isTimeColumn(column.type) ? 1 : undefined"
                @input="emit(
                  'update-new-cell',
                  column.name,
                  fromTemporalInputValue(($event.target as HTMLInputElement).value, column.type)
                )"
              />
              <input
                v-else
                :value="newRowDraft[column.name] ?? ''"
                class="grid-input dirty"
                type="text"
                @input="emit('update-new-cell', column.name, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td class="row-actions action-cell">
              <button
                type="button"
                class="icon-button icon-button-save"
                :disabled="newRowPending"
                title="Insert row"
                @click="emit('insert-row')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="icon-button"
                title="Cancel new row"
                @click="emit('reset-new-row')"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </td>
          </tr>
          <tr v-for="row in tableData.rows" :key="rowKeyId(row)">
            <td v-for="column in activeTable?.columns ?? []" :key="`${rowKeyId(row)}:${column.name}`">
              <input
                v-if="isIntegerColumn(column.type)"
                :value="editableValue(row, column.name)"
                class="grid-input integer-input"
                :class="{ dirty: isCellDirty(row, column.name) }"
                :title="editableValue(row, column.name)"
                type="number"
                step="1"
                @input="emit('update-cell', row, column.name, ($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)"
                :value="toTemporalInputValue(editableValue(row, column.name), column.type)"
                class="grid-input temporal-input"
                :class="{ dirty: isCellDirty(row, column.name) }"
                :title="editableValue(row, column.name)"
                :type="isDateTimeColumn(column.type) ? 'datetime-local' : isDateColumn(column.type) ? 'date' : 'time'"
                :step="isDateTimeColumn(column.type) || isTimeColumn(column.type) ? 1 : undefined"
                @input="emit(
                  'update-cell',
                  row,
                  column.name,
                  fromTemporalInputValue(($event.target as HTMLInputElement).value, column.type)
                )"
              />
              <input
                v-else
                :value="editableValue(row, column.name)"
                class="grid-input"
                :class="{ dirty: isCellDirty(row, column.name) }"
                :title="editableValue(row, column.name)"
                type="text"
                @input="emit('update-cell', row, column.name, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td class="row-actions action-cell">
              <template v-if="isRowDirty(row)">
                <button
                  type="button"
                  class="icon-button icon-button-save"
                  :disabled="rowSavePending[rowKeyId(row)]"
                  title="Save changes"
                  @click="emit('save-row', row)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6M6 8V5h9v3z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-button"
                  title="Reset changes"
                  @click="emit('reset-row', row)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 5a7 7 0 1 1-6.93 8h2.02A5 5 0 1 0 12 7c-1.38 0-2.63.56-3.54 1.46L11 11H4V4l2.03 2.03A8.96 8.96 0 0 1 12 5"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </template>
              <button
                type="button"
                class="icon-button icon-button-danger"
                title="Delete row"
                @click="emit('delete-row', row)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="empty">No rows loaded for this table.</p>
  </div>
</template>
