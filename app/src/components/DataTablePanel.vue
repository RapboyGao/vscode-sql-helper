<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PaginationBar from "./PaginationBar.vue";
import type { SqliteTable, SqliteTableColumn, TableDataPayload, TableDataRow } from "../types";

const props = defineProps<{
  activeTable: SqliteTable | null;
  tableData: TableDataPayload | null;
  tableDataPending: boolean;
  tableDataError: string;
  tableSearch: string;
  newRowPending: boolean;
  rowSavePending: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "update:tableSearch": [value: string];
  search: [];
  page: [page: number];
  "insert-row": [values: Record<string, string>];
  "save-row": [row: TableDataRow, values: Record<string, string>];
  "delete-row": [row: TableDataRow];
}>();

const SEARCH_DEBOUNCE_MS = 300;
const ROW_HEIGHT = 76;
const OVERSCAN = 4;

const localSearch = ref(props.tableSearch);
const gridViewport = ref<HTMLElement | null>(null);
const viewportHeight = ref(520);
const scrollTop = ref(0);
const editingRowId = ref<string | null>(null);
const editingDraft = ref<Record<string, string>>({});
const draftRow = ref<Record<string, string> | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

const rows = computed(() => props.tableData?.rows ?? []);
const hasRows = computed(() => rows.value.length > 0);

const gridTemplateColumns = computed(() => {
  const columns = props.activeTable?.columns ?? [];
  const widths = columns.map(columnWidth);
  return [...widths, "120px"].join(" ");
});

const totalHeight = computed(() => rows.value.length * ROW_HEIGHT);
const visibleCount = computed(() => Math.max(1, Math.ceil(viewportHeight.value / ROW_HEIGHT)));
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN));
const endIndex = computed(() => Math.min(rows.value.length, startIndex.value + visibleCount.value + OVERSCAN * 2));
const visibleRows = computed(() => rows.value.slice(startIndex.value, endIndex.value));

watch(
  () => props.tableSearch,
  (value) => {
    localSearch.value = value;
  }
);

watch(
  () => [props.activeTable?.name, props.tableData?.page, props.tableData?.search, props.tableData?.rows.length].join(":"),
  async () => {
    editingRowId.value = null;
    editingDraft.value = {};
    draftRow.value = null;
    scrollTop.value = 0;
    await nextTick();
    if (gridViewport.value) {
      gridViewport.value.scrollTop = 0;
    }
  }
);

onMounted(() => {
  if (!gridViewport.value) {
    return;
  }

  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry) {
      viewportHeight.value = entry.contentRect.height;
    }
  });

  resizeObserver.observe(gridViewport.value);
  viewportHeight.value = gridViewport.value.clientHeight;
});

onBeforeUnmount(() => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  resizeObserver?.disconnect();
});

function columnWidth(column: SqliteTableColumn): string {
  const normalized = normalizeColumnType(column.type);
  if (column.autoIncrement || normalized.includes("int")) {
    return "140px";
  }
  if (normalized.includes("date") || normalized.includes("time")) {
    return "220px";
  }
  if (normalized.includes("text") || normalized.includes("char")) {
    return "180px";
  }
  return "160px";
}

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

function inputType(column: SqliteTableColumn): string {
  if (isDateTimeColumn(column.type)) return "datetime-local";
  if (isDateColumn(column.type)) return "date";
  if (isTimeColumn(column.type)) return "time";
  if (isIntegerColumn(column.type)) return "number";
  return "text";
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

function buildRowDraft(row: TableDataRow): Record<string, string> {
  return Object.fromEntries(
    (props.activeTable?.columns ?? []).map((column) => [column.name, displayValue(row.values[column.name])])
  );
}

function beginRowEdit(row: TableDataRow): void {
  editingRowId.value = rowKeyId(row);
  editingDraft.value = buildRowDraft(row);
}

function cancelRowEdit(): void {
  editingRowId.value = null;
  editingDraft.value = {};
}

function isEditingRow(row: TableDataRow): boolean {
  return editingRowId.value === rowKeyId(row);
}

function updateEditingCell(column: SqliteTableColumn, value: string): void {
  editingDraft.value = {
    ...editingDraft.value,
    [column.name]: value
  };
}

function currentCellValue(row: TableDataRow, column: SqliteTableColumn): string {
  if (isEditingRow(row)) {
    return editingDraft.value[column.name] ?? "";
  }
  return displayValue(row.values[column.name]);
}

function isEditingCellDirty(row: TableDataRow, column: SqliteTableColumn): boolean {
  if (!isEditingRow(row)) {
    return false;
  }
  return currentCellValue(row, column) !== displayValue(row.values[column.name]);
}

function canSaveRow(row: TableDataRow): boolean {
  if (!isEditingRow(row)) {
    return false;
  }
  return (props.activeTable?.columns ?? []).some((column) => isEditingCellDirty(row, column));
}

function saveEditingRow(row: TableDataRow): void {
  emit("save-row", row, { ...editingDraft.value });
}

function requestDeleteRow(row: TableDataRow): void {
  const confirmed = window.confirm("Delete this row?");

  if (!confirmed) {
    return;
  }

  emit("delete-row", row);
}

function buildNewRowDraft(): Record<string, string> {
  return Object.fromEntries(
    (props.activeTable?.columns ?? []).map((column) => [column.name, column.defaultValue ?? ""])
  );
}

function beginNewRow(): void {
  draftRow.value = buildNewRowDraft();
  cancelRowEdit();
}

function updateNewRowCell(column: SqliteTableColumn, value: string): void {
  draftRow.value = {
    ...(draftRow.value ?? {}),
    [column.name]: value
  };
}

function cancelNewRow(): void {
  draftRow.value = null;
}

function insertDraftRow(): void {
  if (!draftRow.value) {
    return;
  }
  emit("insert-row", { ...draftRow.value });
}

function handleViewportScroll(event: Event): void {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

function rowOffset(index: number): number {
  return (startIndex.value + index) * ROW_HEIGHT;
}

function rowAriaLabel(row: TableDataRow): string {
  return `Row ${Object.values(row.rowKey).join(" ") || "entry"}`;
}
</script>

<template>
  <div class="table-tab-panel">
    <div class="search-surface native-search-surface">
      <div class="search-toolbar">
        <div class="native-search-wrap">
          <span class="native-search-icon">⌕</span>
          <input
            :value="localSearch"
            type="text"
            class="native-search-input"
            placeholder="Fuzzy search current table"
            @input="handleSearchInput(($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="triggerSearch(localSearch, true)"
          />
          <button
            v-if="localSearch"
            type="button"
            class="native-icon-button subtle"
            aria-label="Clear search"
            @click="clearSearch"
          >
            ×
          </button>
        </div>

        <button type="button" class="native-primary-button" @click="beginNewRow">
          Add Row
        </button>
      </div>
    </div>

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

    <v-card v-else-if="draftRow || hasRows" class="results-surface" variant="tonal">
      <PaginationBar
        :page="tableData?.page ?? 0"
        :page-size="tableData?.pageSize ?? 30"
        :total-rows="tableData?.totalRows ?? 0"
        :pending="tableDataPending"
        @page="emit('page', $event)"
      />

      <div v-if="draftRow && activeTable" class="draft-row-surface">
        <div class="virtual-grid-row draft-grid-row" :style="{ gridTemplateColumns }">
          <div
            v-for="column in activeTable.columns"
            :key="`draft:${column.name}`"
            class="virtual-grid-cell"
          >
            <input
              :value="
                isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                  ? toTemporalInputValue(draftRow[column.name] ?? '', column.type)
                  : (draftRow[column.name] ?? '')
              "
              :type="inputType(column)"
              :disabled="column.autoIncrement"
              :inputmode="isIntegerColumn(column.type) ? 'numeric' : undefined"
              class="cell-editor"
              :placeholder="column.autoIncrement ? 'Auto increment' : ''"
              @input="
                updateNewRowCell(
                  column,
                  isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                    ? fromTemporalInputValue(($event.target as HTMLInputElement).value, column.type)
                    : ($event.target as HTMLInputElement).value
                )
              "
            />
          </div>
          <div class="virtual-grid-cell cell-actions">
            <div class="native-row-actions">
              <button
                type="button"
                class="native-icon-button success"
                :disabled="newRowPending"
                aria-label="Insert row"
                @click="insertDraftRow"
              >
                +
              </button>
              <button
                type="button"
                class="native-icon-button"
                aria-label="Cancel new row"
                @click="cancelNewRow"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      </div>

      <div ref="gridViewport" class="virtual-grid-shell" @scroll="handleViewportScroll">
        <div class="virtual-grid-frame" :style="{ minWidth: '100%', width: 'max-content' }">
          <div class="virtual-grid-row virtual-grid-header" :style="{ gridTemplateColumns }">
            <div
              v-for="column in activeTable?.columns ?? []"
              :key="`head:${column.name}`"
              class="virtual-grid-header-cell"
            >
              {{ column.name }}
            </div>
            <div class="virtual-grid-header-cell">Actions</div>
          </div>

          <div class="virtual-grid-body" :style="{ height: `${totalHeight}px` }">
            <div
              v-for="(row, index) in visibleRows"
              :key="rowKeyId(row)"
              class="virtual-grid-row virtual-grid-data-row"
              :style="{ gridTemplateColumns, transform: `translateY(${rowOffset(index)}px)` }"
              :aria-label="rowAriaLabel(row)"
            >
              <div
                v-for="column in activeTable?.columns ?? []"
                :key="`${rowKeyId(row)}:${column.name}`"
                class="virtual-grid-cell"
                :class="{ 'is-dirty': isEditingCellDirty(row, column) }"
              >
                <template v-if="isEditingRow(row)">
                  <input
                    :value="
                      isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                        ? toTemporalInputValue(currentCellValue(row, column), column.type)
                        : currentCellValue(row, column)
                    "
                    :type="inputType(column)"
                    :disabled="column.autoIncrement"
                    :inputmode="isIntegerColumn(column.type) ? 'numeric' : undefined"
                    class="cell-editor"
                    :placeholder="column.autoIncrement ? 'Auto increment' : ''"
                    @input="
                      updateEditingCell(
                        column,
                        isDateTimeColumn(column.type) || isDateColumn(column.type) || isTimeColumn(column.type)
                          ? fromTemporalInputValue(($event.target as HTMLInputElement).value, column.type)
                          : ($event.target as HTMLInputElement).value
                      )
                    "
                  />
                </template>
                <template v-else>
                  <div class="cell-display" :title="currentCellValue(row, column)">
                    {{ currentCellValue(row, column) || "—" }}
                  </div>
                </template>
              </div>

              <div class="virtual-grid-cell cell-actions">
                <div class="native-row-actions">
                  <template v-if="isEditingRow(row)">
                    <button
                      type="button"
                      class="native-icon-button success"
                      :disabled="!canSaveRow(row) || rowSavePending[rowKeyId(row)]"
                      aria-label="Save row"
                      @click="saveEditingRow(row)"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      class="native-icon-button"
                      aria-label="Reset row"
                      @click="cancelRowEdit"
                    >
                      ↺
                    </button>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="native-icon-button"
                      aria-label="Edit row"
                      @click="beginRowEdit(row)"
                    >
                      ✎
                    </button>
                  </template>
                  <button
                    type="button"
                    class="native-icon-button danger"
                    aria-label="Delete row"
                    @click="requestDeleteRow(row)"
                  >
                    🗑
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
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
