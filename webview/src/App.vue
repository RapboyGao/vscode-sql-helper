<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import SidebarExplorer from "./components/SidebarExplorer.vue";
import SqliteStudio from "./components/SqliteStudio.vue";
import type {
  AnalysisResult,
  ColumnSchemaDraft,
  DatabaseProfile,
  InitState,
  SqliteSchema,
  TableDataPayload,
  TableDataRow
} from "./types";

type VsCodeApi = {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const vscode = window.acquireVsCodeApi?.();
const sql = ref("SELECT * FROM analytics.sales.orders o JOIN warehouse.dim_users u ON o.user_id = u.id;");
const result = ref<AnalysisResult | null>(null);
const error = ref("");
const pending = ref(false);
const host = ref<InitState["host"]>("panel");
const profiles = ref<DatabaseProfile[]>([]);
const activeProfileId = ref<string | null>(null);
const openedFile = ref<InitState["openedFile"]>(null);
const sqliteSchema = ref<SqliteSchema | null>(null);
const profileName = ref("");
const profilePath = ref("");
const profileType = ref<DatabaseProfile["type"]>("sqlite");
const profileMessage = ref("");
const schemaPending = ref(false);
const selectedTableName = ref("");
const tableData = ref<TableDataPayload | null>(null);
const tableDataPending = ref(false);
const tableDataError = ref("");
const newRowDraft = ref<Record<string, string> | null>(null);
const newRowPending = ref(false);
const dirtyRows = ref<Record<string, Record<string, string>>>({});
const rowSavePending = ref<Record<string, boolean>>({});
const tableSearch = ref("");
const tableDetailTab = ref<"data" | "structure">("data");
const structureDraft = ref<ColumnSchemaDraft[]>([]);
const structurePending = ref(false);
const structureError = ref("");

const activeProfile = computed(() => {
  if (!activeProfileId.value) {
    return null;
  }

  return profiles.value.find((profile) => profile.id === activeProfileId.value) ?? null;
});

const isSidebar = computed(() => host.value === "sidebar");
const isSqliteEditor = computed(() => !isSidebar.value && Boolean(openedFile.value?.isSqliteFile));
const activeTable = computed(
  () => sqliteSchema.value?.tables.find((table) => table.name === selectedTableName.value) ?? null
);

watch(
  () => sqliteSchema.value?.tables.map((table) => table.name).join(","),
  () => {
    if (!sqliteSchema.value?.tables.length) {
      selectedTableName.value = "";
      tableData.value = null;
      newRowDraft.value = null;
      dirtyRows.value = {};
      structureDraft.value = [];
      return;
    }

    if (!selectedTableName.value || !sqliteSchema.value.tables.some((table) => table.name === selectedTableName.value)) {
      selectedTableName.value = sqliteSchema.value.tables[0].name;
    }

    if (isSqliteEditor.value && selectedTableName.value) {
      resetStructureDraft();
      void loadTableData(selectedTableName.value, 0, tableSearch.value);
    }
  }
);

function analyze(): void {
  pending.value = true;
  error.value = "";
  vscode?.postMessage({
    type: "analyze",
    sql: sql.value
  });
}

function selectProfile(profileId: string): void {
  activeProfileId.value = profileId || null;
  schemaPending.value = true;
  const profile = profiles.value.find((item) => item.id === profileId);

  if (profile) {
    profileName.value = profile.name;
    profilePath.value = profile.path;
    profileType.value = profile.type;
  }

  vscode?.postMessage({
    type: "selectProfile",
    profileId: profileId || null
  });
}

function saveProfile(): void {
  profileMessage.value = "";
  error.value = "";
  vscode?.postMessage({
    type: "saveProfile",
    payload: {
      id: activeProfile.value?.path === profilePath.value ? activeProfile.value.id : undefined,
      name: profileName.value,
      path: profilePath.value,
      type: profileType.value
    }
  });
}

function loadTableData(tableName = selectedTableName.value, page = 0, search = tableSearch.value): void {
  if (!tableName) {
    return;
  }

  tableDataPending.value = true;
  tableDataError.value = "";
  newRowDraft.value = null;
  selectedTableName.value = tableName;
  tableSearch.value = search;
  resetStructureDraft();
  vscode?.postMessage({
    type: "loadTableData",
    tableName,
    page,
    search
  });
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

function originalValue(row: TableDataRow, columnName: string): string {
  return displayValue(row.values[columnName]);
}

function updateDraft(row: TableDataRow, columnName: string, value: string): void {
  const key = rowKeyId(row);
  const original = originalValue(row, columnName);
  const nextRowDraft = {
    ...(dirtyRows.value[key] ?? {})
  };

  if (value === original) {
    delete nextRowDraft[columnName];
  } else {
    nextRowDraft[columnName] = value;
  }

  const nextDirtyRows = {
    ...dirtyRows.value
  };

  if (Object.keys(nextRowDraft).length === 0) {
    delete nextDirtyRows[key];
  } else {
    nextDirtyRows[key] = nextRowDraft;
  }

  dirtyRows.value = nextDirtyRows;
}

function resetRowDraft(row: TableDataRow): void {
  const next = { ...dirtyRows.value };
  delete next[rowKeyId(row)];
  dirtyRows.value = next;
}

function beginNewRow(): void {
  if (!activeTable.value) {
    return;
  }

  newRowDraft.value = Object.fromEntries(
    activeTable.value.columns.map((column) => [column.name, column.defaultValue ?? ""])
  );
}

function updateNewRowDraft(columnName: string, value: string): void {
  newRowDraft.value = {
    ...(newRowDraft.value ?? {}),
    [columnName]: value
  };
}

function resetNewRowDraft(): void {
  newRowDraft.value = null;
  newRowPending.value = false;
}

function saveRow(row: TableDataRow): void {
  if (!selectedTableName.value) {
    return;
  }

  const key = rowKeyId(row);
  const values = Object.fromEntries(
    Object.entries(row.values).map(([columnName, value]) => [columnName, displayValue(value)])
  );

  Object.assign(values, dirtyRows.value[key] ?? {});

  rowSavePending.value = {
    ...rowSavePending.value,
    [key]: true
  };
  tableDataError.value = "";
  vscode?.postMessage({
    type: "updateTableRow",
    tableName: selectedTableName.value,
    page: tableData.value?.page ?? 0,
    search: tableSearch.value,
    rowKey: row.rowKey,
    values
  });
}

function insertRow(): void {
  if (!selectedTableName.value || !newRowDraft.value) {
    return;
  }

  newRowPending.value = true;
  tableDataError.value = "";
  vscode?.postMessage({
    type: "insertTableRow",
    tableName: selectedTableName.value,
    page: 0,
    search: tableSearch.value,
    values: newRowDraft.value
  });
}

function deleteRow(row: TableDataRow): void {
  if (!selectedTableName.value) {
    return;
  }

  vscode?.postMessage({
    type: "deleteTableRow",
    tableName: selectedTableName.value,
    page: tableData.value?.page ?? 0,
    search: tableSearch.value,
    rowKey: row.rowKey
  });
}

function resetStructureDraft(): void {
  structureDraft.value = (activeTable.value?.columns ?? []).map((column) => ({
    sourceName: column.name,
    name: column.name,
    type: column.type || "",
    notNull: column.notNull,
    primaryKey: column.primaryKey,
    defaultValue: column.defaultValue ?? ""
  }));
  structureError.value = "";
}

function addStructureColumn(): void {
  structureDraft.value = [
    ...structureDraft.value,
    {
      sourceName: "",
      name: `column_${structureDraft.value.length + 1}`,
      type: "TEXT",
      notNull: false,
      primaryKey: false,
      defaultValue: ""
    }
  ];
}

function removeStructureColumn(index: number): void {
  structureDraft.value = structureDraft.value.filter((_, entryIndex) => entryIndex !== index);
}

function applyStructure(): void {
  if (!selectedTableName.value) {
    return;
  }

  structurePending.value = true;
  structureError.value = "";
  vscode?.postMessage({
    type: "applyTableSchema",
    tableName: selectedTableName.value,
    search: tableSearch.value,
    columns: structureDraft.value.map((column) => ({
      ...column,
      defaultValue: column.defaultValue.trim() || null
    }))
  });
}

function applyState(state: InitState): void {
  host.value = state.host;
  profiles.value = state.profiles;
  activeProfileId.value = state.activeProfileId;
  selectedTableName.value = state.selectedTableName ?? "";
  openedFile.value = state.openedFile;
  sqliteSchema.value = state.sqliteSchema;
  schemaPending.value = false;

  const current = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;

  if (current) {
    profileName.value = current.name;
    profilePath.value = current.path;
    profileType.value = current.type;
  } else if (state.openedFile) {
    profileName.value = state.openedFile.name;
    profilePath.value = state.openedFile.path;
    profileType.value = state.openedFile.isSqliteFile ? "sqlite" : "generic";
  }
}

onMounted(() => {
  window.addEventListener("message", (event: MessageEvent) => {
    const { type, payload } = event.data ?? {};

    if (type === "init") {
      applyState(payload as InitState);

      if (openedFile.value?.isSqliteFile) {
        const state = payload as InitState;
        const targetTable = state.selectedTableName ?? state.sqliteSchema?.tables[0]?.name;

        if (targetTable) {
          selectedTableName.value = targetTable;
          resetStructureDraft();
          loadTableData(targetTable, 0);
        }
      } else {
        analyze();
      }
      return;
    }

    if (type === "profilesUpdated") {
      const state = {
        host: host.value,
        profiles: (payload?.profiles ?? []) as DatabaseProfile[],
        activeProfileId: (payload?.activeProfileId ?? null) as string | null,
        selectedTableName: selectedTableName.value,
        openedFile: openedFile.value,
        sqliteSchema: (payload?.sqliteSchema ?? null) as SqliteSchema | null
      };

      applyState(state);
      profileMessage.value = activeProfile.value
        ? `Saved ${activeProfile.value.name}`
        : "Saved database profile";
      return;
    }

    if (type === "profileError") {
      schemaPending.value = false;
      error.value = String(payload ?? "Failed to save profile");
      return;
    }

    if (type === "schemaLoaded") {
      schemaPending.value = false;
      sqliteSchema.value = (payload ?? null) as SqliteSchema | null;
      return;
    }

    if (type === "schemaError") {
      schemaPending.value = false;
      error.value = String(payload ?? "Failed to load SQLite schema");
      return;
    }

    if (type === "tableDataLoaded" || type === "rowUpdated" || type === "rowInserted" || type === "rowDeleted") {
      tableDataPending.value = false;
      newRowPending.value = false;
      tableData.value = payload as TableDataPayload;
      selectedTableName.value = tableData.value.tableName;
      tableSearch.value = tableData.value.search;
      newRowDraft.value = null;
      dirtyRows.value = {};
      rowSavePending.value = {};
      return;
    }

    if (type === "tableDataError") {
      tableDataPending.value = false;
      newRowPending.value = false;
      rowSavePending.value = {};
      tableDataError.value = String(payload ?? "Failed to load table data");
      return;
    }

    if (type === "tableSchemaApplied") {
      structurePending.value = false;
      sqliteSchema.value = (payload?.sqliteSchema ?? null) as SqliteSchema | null;
      tableData.value = (payload?.tableData ?? null) as TableDataPayload | null;
      tableSearch.value = tableData.value?.search ?? "";
      resetStructureDraft();
      return;
    }

    if (type === "tableSchemaError") {
      structurePending.value = false;
      structureError.value = String(payload ?? "Failed to update table structure");
      return;
    }

    if (type === "analysisResult") {
      pending.value = false;
      result.value = payload as AnalysisResult;
      return;
    }

    if (type === "analysisError") {
      pending.value = false;
      error.value = String(payload ?? "Unknown error");
    }
  });

  vscode?.postMessage({ type: "ready" });
});
</script>

<template>
  <main class="shell" :class="{ 'shell-sidebar': isSidebar }">
    <div class="ambient ambient-a" />
    <div class="ambient ambient-b" />

    <SidebarExplorer
      v-if="isSidebar"
      :active-profile="activeProfile"
      :active-profile-id="activeProfileId"
      :profiles="profiles"
      :sqlite-schema="sqliteSchema"
      :selected-table-name="selectedTableName"
      :schema-pending="schemaPending"
      :error="error"
      @select-profile="selectProfile"
      @select-table="loadTableData($event, 0)"
    />

    <SqliteStudio
      v-else-if="isSqliteEditor"
      :opened-file="openedFile"
      :active-profile="activeProfile"
      :sqlite-schema="sqliteSchema"
      :selected-table-name="selectedTableName"
      :active-table="activeTable"
      :table-detail-tab="tableDetailTab"
      :table-search="tableSearch"
      :table-data="tableData"
      :table-data-pending="tableDataPending"
      :table-data-error="tableDataError"
      :new-row-draft="newRowDraft"
      :new-row-pending="newRowPending"
      :dirty-rows="dirtyRows"
      :row-save-pending="rowSavePending"
      :structure-draft="structureDraft"
      :structure-pending="structurePending"
      :structure-error="structureError"
      @select-table="loadTableData($event, 0)"
      @update:table-detail-tab="tableDetailTab = $event"
      @update:table-search="tableSearch = $event"
      @search="loadTableData(selectedTableName, 0, tableSearch)"
      @clear="loadTableData(selectedTableName, 0, '')"
      @add-row="beginNewRow"
      @page="loadTableData(selectedTableName, $event, tableSearch)"
      @update-new-cell="updateNewRowDraft"
      @insert-row="insertRow"
      @reset-new-row="resetNewRowDraft"
      @update-cell="(row, columnName, value) => updateDraft(row, columnName, value)"
      @save-row="saveRow"
      @reset-row="resetRowDraft"
      @delete-row="deleteRow"
      @add-column="addStructureColumn"
      @remove-column="removeStructureColumn"
      @reset-structure="resetStructureDraft"
      @apply-structure="applyStructure"
    />

    <section v-else class="generic-shell">
      <section class="panel panel-input">
        <div class="panel-head">
          <div>
            <p class="panel-kicker">SQL Analyzer</p>
            <h2>Analyze SQL text against the current workspace context</h2>
          </div>
          <button type="button" :disabled="pending" @click="analyze">
            {{ pending ? "Analyzing..." : "Analyze" }}
          </button>
        </div>

        <textarea v-model="sql" class="input-area" spellcheck="false" />
      </section>

      <section class="panel panel-summary">
        <div class="panel-head compact">
          <div>
            <p class="panel-kicker">Saved Databases</p>
            <h2>Targets</h2>
          </div>
        </div>

        <select
          class="input"
          :value="activeProfileId ?? ''"
          @change="selectProfile(($event.target as HTMLSelectElement).value)"
        >
          <option value="">No active profile</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} · {{ profile.type }}
          </option>
        </select>
        <input v-model="profileName" class="input" type="text" placeholder="Display name" />
        <input v-model="profilePath" class="input" type="text" placeholder="Database path" />
        <select v-model="profileType" class="input">
          <option value="sqlite">SQLite</option>
          <option value="generic">Generic</option>
        </select>
        <button type="button" class="button-secondary" @click="saveProfile">Save Profile</button>
        <p v-if="error" class="error">{{ error }}</p>
      </section>
    </section>
  </main>
</template>
