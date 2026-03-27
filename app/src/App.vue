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
const tableDataNotice = ref("");
const newRowPending = ref(false);
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

const profileSelectItems = computed(() => [
  { title: "No active profile", value: "" },
  ...profiles.value.map((profile) => ({
    title: `${profile.name} · ${profile.type}`,
    value: profile.id
  }))
]);

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
  tableDataNotice.value = "";
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

function saveRow(row: TableDataRow, values: Record<string, string>): void {
  if (!selectedTableName.value) {
    return;
  }

  const key = rowKeyId(row);
  rowSavePending.value = {
    ...rowSavePending.value,
    [key]: true
  };
  tableDataError.value = "";
  tableDataNotice.value = "";
  vscode?.postMessage({
    type: "updateTableRow",
    tableName: selectedTableName.value,
    page: tableData.value?.page ?? 0,
    search: tableSearch.value,
    rowKey: row.rowKey,
    values
  });
}

function insertRow(values: Record<string, string>): void {
  if (!selectedTableName.value) {
    return;
  }

  newRowPending.value = true;
  tableDataError.value = "";
  tableDataNotice.value = "";
  vscode?.postMessage({
    type: "insertTableRow",
    tableName: selectedTableName.value,
    page: 0,
    search: tableSearch.value,
    values
  });
}

function deleteRow(row: TableDataRow): void {
  if (!selectedTableName.value) {
    return;
  }

  tableDataError.value = "";
  tableDataNotice.value = "";
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
    unique: column.unique,
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
      unique: false,
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

function exportDatabase(): void {
  vscode?.postMessage({
    type: "exportDatabase"
  });
}

function exportTable(): void {
  vscode?.postMessage({
    type: "exportTable",
    tableName: selectedTableName.value
  });
}

function deleteTable(): void {
  vscode?.postMessage({
    type: "deleteTable",
    tableName: selectedTableName.value
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
      rowSavePending.value = {};
      tableDataNotice.value = type === "rowUpdated"
        ? "Row saved."
        : type === "rowInserted"
          ? "Row inserted."
          : type === "rowDeleted"
            ? "Row deleted."
            : "";
      return;
    }

    if (type === "tableDataError") {
      tableDataPending.value = false;
      newRowPending.value = false;
      rowSavePending.value = {};
      tableDataError.value = String(payload ?? "Failed to load table data");
      tableDataNotice.value = "";
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
  <v-app class="app-shell">
    <v-main>
      <v-container fluid class="app-main pa-4 pa-md-5">
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
          :table-data-notice="tableDataNotice"
          :new-row-pending="newRowPending"
          :row-save-pending="rowSavePending"
          :structure-draft="structureDraft"
          :structure-pending="structurePending"
          :structure-error="structureError"
          @select-table="loadTableData($event, 0)"
          @update:table-detail-tab="tableDetailTab = $event"
          @update:table-search="tableSearch = $event"
          @search="loadTableData(selectedTableName, 0, tableSearch)"
          @page="loadTableData(selectedTableName, $event, tableSearch)"
          @insert-row="insertRow"
          @save-row="saveRow"
          @delete-row="deleteRow"
          @add-column="addStructureColumn"
          @remove-column="removeStructureColumn"
          @delete-table="deleteTable"
          @export-database="exportDatabase"
          @export-table="exportTable"
          @reset-structure="resetStructureDraft"
          @apply-structure="applyStructure"
        />

        <div v-else class="generic-shell">
          <v-row dense>
            <v-col cols="12" lg="8">
              <v-card class="analyzer-card" variant="flat">
                <v-card-item>
                  <template #prepend>
                    <v-avatar color="primary" variant="tonal">
                      <v-icon icon="mdi-code-braces" />
                    </v-avatar>
                  </template>
                  <v-card-title>SQL Analyzer</v-card-title>
                  <v-card-subtitle>Analyze SQL text against the current workspace context</v-card-subtitle>
                  <template #append>
                    <v-btn color="primary" :loading="pending" prepend-icon="mdi-play-circle-outline" @click="analyze">
                      Analyze
                    </v-btn>
                  </template>
                </v-card-item>
                <v-card-text class="d-flex flex-column ga-4">
                  <v-textarea v-model="sql" rows="16" auto-grow spellcheck="false" />
                  <v-alert v-if="error" type="error" variant="tonal" icon="mdi-alert-circle-outline">
                    {{ error }}
                  </v-alert>
                  <v-card v-if="result" variant="tonal" class="analysis-result-card">
                    <v-card-item>
                      <v-card-title>Analysis Result</v-card-title>
                    </v-card-item>
                    <v-card-text class="d-flex flex-column ga-4">
                      <div class="d-flex flex-column ga-2">
                        <div class="section-kicker">Databases</div>
                        <div class="d-flex flex-wrap ga-2">
                          <v-chip v-for="database in result.databases" :key="database" color="primary" variant="tonal">
                            {{ database }}
                          </v-chip>
                          <span v-if="!result.databases.length" class="text-medium-emphasis">None</span>
                        </div>
                      </div>
                      <div class="d-flex flex-column ga-2">
                        <div class="section-kicker">Schemas</div>
                        <div class="d-flex flex-wrap ga-2">
                          <v-chip v-for="schema in result.schemas" :key="schema" color="secondary" variant="tonal">
                            {{ schema }}
                          </v-chip>
                          <span v-if="!result.schemas.length" class="text-medium-emphasis">None</span>
                        </div>
                      </div>
                      <div class="d-flex flex-column ga-2">
                        <div class="section-kicker">References</div>
                        <v-list density="compact" bg-color="transparent">
                          <v-list-item
                            v-for="reference in result.references"
                            :key="`${reference.kind}:${reference.value}`"
                          >
                            <template #prepend>
                              <v-icon icon="mdi-link-variant" />
                            </template>
                            <v-list-item-title>{{ reference.value }}</v-list-item-title>
                            <v-list-item-subtitle>{{ reference.kind }}</v-list-item-subtitle>
                          </v-list-item>
                        </v-list>
                      </div>
                    </v-card-text>
                  </v-card>
                </v-card-text>
              </v-card>
            </v-col>

            <v-col cols="12" lg="4">
              <v-card class="targets-card" variant="tonal">
                <v-card-item>
                  <template #prepend>
                    <v-avatar color="secondary" variant="tonal">
                      <v-icon icon="mdi-database-cog-outline" />
                    </v-avatar>
                  </template>
                  <v-card-title>Saved Databases</v-card-title>
                  <v-card-subtitle>Targets</v-card-subtitle>
                </v-card-item>
                <v-card-text class="d-flex flex-column ga-4">
                  <v-select
                    :model-value="activeProfileId ?? ''"
                    :items="profileSelectItems"
                    label="Active profile"
                    prepend-inner-icon="mdi-database-outline"
                    @update:model-value="selectProfile(String($event ?? ''))"
                  />
                  <v-text-field v-model="profileName" label="Display name" prepend-inner-icon="mdi-form-textbox" />
                  <v-text-field v-model="profilePath" label="Database path" prepend-inner-icon="mdi-folder-outline" />
                  <v-select
                    v-model="profileType"
                    :items="[
                      { title: 'SQLite', value: 'sqlite' },
                      { title: 'Generic', value: 'generic' }
                    ]"
                    label="Connection type"
                    prepend-inner-icon="mdi-shape-outline"
                  />
                  <v-btn color="secondary" prepend-icon="mdi-content-save-outline" @click="saveProfile">
                    Save Profile
                  </v-btn>
                  <v-alert v-if="profileMessage" type="success" variant="tonal" icon="mdi-check-circle-outline">
                    {{ profileMessage }}
                  </v-alert>
                  <v-alert v-if="error" type="error" variant="tonal" icon="mdi-alert-circle-outline">
                    {{ error }}
                  </v-alert>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
        </div>
      </v-container>
    </v-main>
  </v-app>
</template>
