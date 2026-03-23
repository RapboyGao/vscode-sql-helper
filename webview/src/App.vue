<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
};

type DatabaseProfile = {
  id: string;
  name: string;
  type: "sqlite" | "generic";
  path: string;
  lastUsedAt: string;
};

type InitState = {
  host: "panel" | "sidebar";
  profiles: DatabaseProfile[];
  activeProfileId: string | null;
  openedFile: {
    path: string;
    name: string;
    isSqliteFile: boolean;
  } | null;
  sqliteSchema: SqliteSchema | null;
};

type SqliteTableColumn = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
};

type SqliteTable = {
  name: string;
  createSql: string;
  columns: SqliteTableColumn[];
};

type SqliteSchema = {
  path: string;
  tableCount: number;
  tables: SqliteTable[];
};

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

const activeProfile = computed(() => {
  if (!activeProfileId.value) {
    return null;
  }

  return profiles.value.find((profile) => profile.id === activeProfileId.value) ?? null;
});

const isSidebar = computed(() => host.value === "sidebar");

const schemaInsights = computed(() => {
  if (!sqliteSchema.value) {
    return {
      missingTables: [] as string[],
      missingColumns: [] as string[],
      suggestedTables: [] as string[],
      suggestedColumns: [] as string[]
    };
  }

  const normalizedSql = sql.value.toLowerCase();
  const tableMap = new Map(sqliteSchema.value.tables.map((table) => [table.name.toLowerCase(), table]));
  const existingTables = new Set(tableMap.keys());
  const missingTables = new Set<string>();
  const matchedTables = new Set<string>();
  const missingColumns = new Set<string>();
  const usedColumnNames = new Set<string>();
  const tablePattern =
    /\b(?:from|join|into|update|table|truncate\s+table|delete\s+from)\s+([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?\b/gi;

  for (const match of normalizedSql.matchAll(tablePattern)) {
    const tableName = (match[2] ?? match[1] ?? "").toLowerCase();

    if (!tableName) {
      continue;
    }

    if (existingTables.has(tableName)) {
      matchedTables.add(tableName);
    } else {
      missingTables.add(tableName);
    }
  }

  const explicitColumnPattern = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;

  for (const match of normalizedSql.matchAll(explicitColumnPattern)) {
    const tableName = match[1].toLowerCase();
    const columnName = match[2].toLowerCase();
    const table = tableMap.get(tableName);

    if (!table) {
      continue;
    }

    usedColumnNames.add(columnName);
    const hasColumn = table.columns.some((column) => column.name.toLowerCase() === columnName);

    if (!hasColumn) {
      missingColumns.add(`${table.name}.${columnName}`);
    }
  }

  const suggestedTables = sqliteSchema.value.tables
    .filter((table) => !matchedTables.has(table.name.toLowerCase()))
    .filter((table) => normalizedSql.length === 0 || table.name.toLowerCase().includes(normalizedSql.split(/\W+/).at(-1) ?? ""))
    .slice(0, 6)
    .map((table) => table.name);

  const relevantTables = matchedTables.size
    ? sqliteSchema.value.tables.filter((table) => matchedTables.has(table.name.toLowerCase()))
    : sqliteSchema.value.tables;

  const suggestedColumns = relevantTables
    .flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`))
    .filter((columnName) => !usedColumnNames.has(columnName.split(".")[1].toLowerCase()))
    .slice(0, 8);

  return {
    missingTables: [...missingTables],
    missingColumns: [...missingColumns],
    suggestedTables,
    suggestedColumns
  };
});

function referenceLabel(kind: string): string {
  if (kind === "table") {
    return "TABLE";
  }

  if (kind === "database") {
    return "DATABASE";
  }

  return "QUALIFIED";
}

function analyze(): void {
  pending.value = true;
  error.value = "";
  vscode?.postMessage({
    type: "analyze",
    sql: sql.value
  });
}

function previewTable(tableName: string): void {
  vscode?.postMessage({
    type: "previewTable",
    tableName
  });
}

function previewQuery(): void {
  vscode?.postMessage({
    type: "previewQuery"
  });
}

function explainQuery(): void {
  vscode?.postMessage({
    type: "explainQuery"
  });
}

function openAnalyzer(): void {
  vscode?.postMessage({
    type: "openAnalyzer"
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

function applyState(state: InitState): void {
  host.value = state.host;
  profiles.value = state.profiles;
  activeProfileId.value = state.activeProfileId;
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
      analyze();
      return;
    }

    if (type === "profilesUpdated") {
      const state = {
        profiles: (payload?.profiles ?? []) as DatabaseProfile[],
        activeProfileId: (payload?.activeProfileId ?? null) as string | null,
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

    <template v-if="isSidebar">
      <section class="sidebar-shell">
        <div class="sidebar-hero panel">
          <p class="eyebrow">SQL Helper</p>
          <h2>Workspace Database Explorer</h2>
          <p class="subtitle sidebar-subtitle">
            Keep a SQLite database active, preview tables, and jump into the full analyzer only when needed.
          </p>

          <div class="sidebar-actions">
            <button type="button" @click="openAnalyzer">Open Analyzer</button>
            <button type="button" class="button-secondary" @click="previewQuery">Preview SQL</button>
            <button type="button" class="button-secondary" @click="explainQuery">Explain</button>
          </div>
        </div>

        <section class="panel sidebar-panel">
          <div class="panel-head compact">
            <div>
              <p class="panel-kicker">Active Database</p>
              <h2>{{ activeProfile?.name ?? "No active profile" }}</h2>
            </div>
            <span class="status-pill" :class="{ active: schemaPending }">
              {{ schemaPending ? "Loading" : sqliteSchema ? `${sqliteSchema.tableCount} tables` : "Idle" }}
            </span>
          </div>

          <select
            id="sidebar-profile-select"
            class="input"
            :value="activeProfileId ?? ''"
            @change="selectProfile(($event.target as HTMLSelectElement).value)"
          >
            <option value="">No active profile</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
              {{ profile.name }} · {{ profile.type }}
            </option>
          </select>

          <p v-if="activeProfile" class="sidebar-path">{{ activeProfile.path }}</p>
          <p v-else class="empty">Choose a saved database or open a SQLite file from the workspace.</p>
        </section>

        <section class="panel sidebar-panel">
          <div class="panel-head compact">
            <div>
              <p class="panel-kicker">Recent Databases</p>
              <h2>Saved targets</h2>
            </div>
          </div>

          <div v-if="profiles.length" class="sidebar-profile-list">
            <button
              v-for="profile in profiles"
              :key="profile.id"
              type="button"
              class="sidebar-profile"
              :class="{ active: profile.id === activeProfileId }"
              @click="selectProfile(profile.id)"
            >
              <strong>{{ profile.name }}</strong>
              <span>{{ profile.type }}</span>
            </button>
          </div>
          <p v-else class="empty">No saved profiles yet.</p>
        </section>

        <section class="panel sidebar-panel">
          <div class="panel-head compact">
            <div>
              <p class="panel-kicker">Schema Explorer</p>
              <h2>Tables</h2>
            </div>
          </div>

          <div v-if="sqliteSchema?.tables.length" class="sidebar-table-list">
            <article v-for="table in sqliteSchema.tables" :key="table.name" class="sidebar-table-card">
              <div class="sidebar-table-head">
                <div>
                  <strong>{{ table.name }}</strong>
                  <span>{{ table.columns.length }} columns</span>
                </div>
                <button type="button" class="sidebar-link" @click="previewTable(table.name)">Preview</button>
              </div>
              <ul class="sidebar-column-list">
                <li v-for="column in table.columns.slice(0, 6)" :key="`${table.name}:${column.name}`">
                  <span>{{ column.name }}</span>
                  <small>{{ column.type || "TEXT" }}</small>
                </li>
              </ul>
            </article>
          </div>
          <p v-else class="empty">No schema loaded.</p>
        </section>

        <p v-if="error" class="error">{{ error }}</p>
      </section>
    </template>

    <template v-else>

    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">SQL Helper</p>
        <h1>Remember database context and open SQLite files as a proper tool view.</h1>
        <p class="subtitle">
          Saved database profiles persist across sessions, and SQLite files opened from the
          workspace are attached automatically.
        </p>
        <div v-if="openedFile" class="opened-file">
          <span class="opened-file-label">Opened file</span>
          <strong>{{ openedFile.name }}</strong>
          <span class="opened-file-path">{{ openedFile.path }}</span>
        </div>
      </div>

      <div class="hero-metrics">
        <div class="metric">
          <span class="metric-label">Saved Profiles</span>
          <strong>{{ profiles.length }}</strong>
        </div>
        <div class="metric">
          <span class="metric-label">SQLite Tables</span>
          <strong>{{ sqliteSchema?.tableCount ?? 0 }}</strong>
        </div>
        <div class="metric">
          <span class="metric-label">Databases</span>
          <strong>{{ result?.databases.length ?? 0 }}</strong>
        </div>
        <div class="metric">
          <span class="metric-label">References</span>
          <strong>{{ result?.references.length ?? 0 }}</strong>
        </div>
      </div>
    </section>

    <section class="workspace">
      <section class="panel panel-input">
        <div class="panel-head">
          <div>
            <p class="panel-kicker">Query Input</p>
            <h2>SQL source</h2>
          </div>
          <button type="button" :disabled="pending" @click="analyze">
            {{ pending ? "Analyzing..." : "Analyze SQL" }}
          </button>
        </div>

        <label for="sql">Paste or edit the statement</label>
        <textarea id="sql" v-model="sql" spellcheck="false" />

        <div class="status-row">
          <span class="status-pill" :class="{ active: pending }">
            {{ pending ? "Rust parser running" : "Ready" }}
          </span>
          <span class="status-meta">{{ sql.length }} characters</span>
        </div>
      </section>

      <section class="panel panel-summary">
        <div class="panel-head compact">
          <div>
            <p class="panel-kicker">Database Context</p>
            <h2>Saved targets</h2>
          </div>
        </div>

        <label for="profile-select">Recent databases</label>
        <select
          id="profile-select"
          class="input"
          :value="activeProfileId ?? ''"
          @change="selectProfile(($event.target as HTMLSelectElement).value)"
        >
          <option value="">No active profile</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} · {{ profile.type }}
          </option>
        </select>

        <div class="field-grid">
          <div>
            <label for="profile-name">Display name</label>
            <input id="profile-name" v-model="profileName" class="input" type="text" />
          </div>

          <div>
            <label for="profile-type">Type</label>
            <select id="profile-type" v-model="profileType" class="input">
              <option value="sqlite">SQLite</option>
              <option value="generic">Generic</option>
            </select>
          </div>
        </div>

        <label for="profile-path">Database path</label>
        <input id="profile-path" v-model="profilePath" class="input" type="text" spellcheck="false" />

        <div class="actions-row">
          <button type="button" class="button-secondary" @click="saveProfile">Save Profile</button>
          <span v-if="profileMessage" class="mini-note">{{ profileMessage }}</span>
        </div>

        <div class="token-group">
          <h3>Detected databases</h3>
          <div v-if="result?.databases.length" class="token-list">
            <span v-for="database in result.databases" :key="database" class="token token-database">
              {{ database }}
            </span>
          </div>
          <p v-else class="empty">No explicit database names detected.</p>
        </div>

        <div class="token-group">
          <h3>Detected schemas</h3>
          <div v-if="result?.schemas.length" class="token-list">
            <span v-for="schema in result.schemas" :key="schema" class="token token-schema">
              {{ schema }}
            </span>
          </div>
          <p v-else class="empty">No explicit schema names detected.</p>
        </div>
      </section>
    </section>

    <section class="panel panel-results">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">Reference Map</p>
          <h2>Qualified objects</h2>
        </div>
      </div>

      <div v-if="result?.references.length" class="reference-grid">
        <article
          v-for="reference in result.references"
          :key="`${reference.kind}:${reference.value}`"
          class="reference-card"
        >
          <span class="reference-kind">{{ referenceLabel(reference.kind) }}</span>
          <strong>{{ reference.value }}</strong>
        </article>
      </div>
      <p v-else class="empty">No references found.</p>

      <p v-if="result?.note" class="note">{{ result.note }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section class="panel panel-validation">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">SQLite Checks</p>
          <h2>Validation and suggestions</h2>
        </div>
      </div>

      <div v-if="sqliteSchema" class="validation-grid">
        <article class="validation-card">
          <h3>Missing tables</h3>
          <div v-if="schemaInsights.missingTables.length" class="token-list">
            <span
              v-for="table in schemaInsights.missingTables"
              :key="table"
              class="token token-warning"
            >
              {{ table }}
            </span>
          </div>
          <p v-else class="empty">No missing table references detected.</p>
        </article>

        <article class="validation-card">
          <h3>Missing columns</h3>
          <div v-if="schemaInsights.missingColumns.length" class="token-list">
            <span
              v-for="column in schemaInsights.missingColumns"
              :key="column"
              class="token token-warning"
            >
              {{ column }}
            </span>
          </div>
          <p v-else class="empty">No missing qualified columns detected.</p>
        </article>

        <article class="validation-card">
          <h3>Suggested tables</h3>
          <div v-if="schemaInsights.suggestedTables.length" class="token-list">
            <span
              v-for="table in schemaInsights.suggestedTables"
              :key="table"
              class="token token-suggest"
            >
              {{ table }}
            </span>
          </div>
          <p v-else class="empty">No additional table suggestions.</p>
        </article>

        <article class="validation-card">
          <h3>Suggested columns</h3>
          <div v-if="schemaInsights.suggestedColumns.length" class="token-list">
            <span
              v-for="column in schemaInsights.suggestedColumns"
              :key="column"
              class="token token-suggest"
            >
              {{ column }}
            </span>
          </div>
          <p v-else class="empty">No column suggestions available.</p>
        </article>
      </div>
      <p v-else class="empty">Load a SQLite database first to enable schema-aware validation.</p>
    </section>

    <section class="panel panel-schema">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">SQLite Schema</p>
          <h2>Tables and columns</h2>
        </div>
        <span class="status-pill" :class="{ active: schemaPending }">
          {{ schemaPending ? "Loading schema" : sqliteSchema ? `${sqliteSchema.tableCount} tables` : "No schema" }}
        </span>
      </div>

      <p v-if="sqliteSchema" class="schema-path">{{ sqliteSchema.path }}</p>
      <p v-else class="empty">Select a SQLite profile or open a `.sqlite` file to inspect its schema.</p>

      <div v-if="sqliteSchema?.tables.length" class="schema-grid">
        <article v-for="table in sqliteSchema.tables" :key="table.name" class="schema-card">
          <div class="schema-card-head">
            <h3>{{ table.name }}</h3>
            <span class="token token-schema">{{ table.columns.length }} cols</span>
          </div>

          <ul class="column-list">
            <li v-for="column in table.columns" :key="`${table.name}:${column.name}`" class="column-row">
              <div>
                <strong>{{ column.name }}</strong>
                <span class="column-type">{{ column.type || "TEXT" }}</span>
              </div>
              <div class="column-flags">
                <span v-if="column.primaryKey" class="flag">PK</span>
                <span v-if="column.notNull" class="flag flag-soft">NOT NULL</span>
              </div>
            </li>
          </ul>

          <details v-if="table.createSql" class="ddl-block">
            <summary>DDL</summary>
            <pre>{{ table.createSql }}</pre>
          </details>
        </article>
      </div>
    </section>
    </template>
  </main>
</template>
