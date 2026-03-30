<script setup lang="ts">
import { computed, ref } from "vue";
import type { SavedConnection, TableQuery, TableQueryResult, TableSchema } from "@usd/shared";

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
}>();

const emit = defineEmits<{
  query: [query: TableQuery];
  insert: [payload: { schema?: string; table: string; rows: Array<Record<string, unknown>> }];
  remove: [payload: { schema?: string; table: string; key: Record<string, unknown> }];
  preview: [payload: { action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn"; schema?: string; table: string; nextTable?: string; column?: string; nextColumn?: string; definition?: Partial<TableSchema> }];
  apply: [payload: { action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn"; schema?: string; table: string; nextTable?: string; column?: string; nextColumn?: string; definition?: Partial<TableSchema> }];
}>();

const activeTab = ref<"data" | "structure" | "logs">("data");
const keyword = ref(props.query.keyword ?? "");
const selectedSchema = ref(props.selectedSchema ?? props.schemas[0] ?? "");
const selectedTable = ref(props.selectedTable ?? props.tables[0] ?? "");

const insertDraft = ref<Record<string, string>>({});
const visibleColumns = computed(() => props.result?.columns ?? props.structure?.columns ?? []);

function submitQuery(): void {
  emit("query", {
    ...props.query,
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    keyword: keyword.value
  });
}

function submitInsert(): void {
  emit("insert", {
    schema: selectedSchema.value || undefined,
    table: selectedTable.value,
    rows: [{ ...insertDraft.value }]
  });
  insertDraft.value = {};
}
</script>

<template>
  <section class="panel-shell">
    <header class="panel-header">
      <div>
        <p class="eyebrow">Data Explorer</p>
        <h1>{{ connection.name }}</h1>
      </div>
      <div class="toolbar">
        <select v-model="selectedSchema" @change="submitQuery">
          <option v-for="schema in schemas" :key="schema" :value="schema">{{ schema }}</option>
        </select>
        <select v-model="selectedTable" @change="submitQuery">
          <option v-for="table in tables" :key="table" :value="table">{{ table }}</option>
        </select>
        <input v-model="keyword" placeholder="Search keyword" @keydown.enter="submitQuery" />
        <button @click="submitQuery">Refresh</button>
      </div>
    </header>

    <nav class="tabs">
      <button :class="{ active: activeTab === 'data' }" @click="activeTab = 'data'">Data</button>
      <button :class="{ active: activeTab === 'structure' }" @click="activeTab = 'structure'">Structure</button>
      <button :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">Logs</button>
    </nav>

    <section v-if="activeTab === 'data'" class="surface-stack">
      <div class="data-grid">
        <table v-if="result">
          <thead>
            <tr>
              <th v-for="column in result.columns" :key="column.name">{{ column.name }}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in result.rows" :key="index">
              <td v-for="column in result.columns" :key="column.name">{{ row[column.name] }}</td>
              <td>
                <button class="danger" @click="emit('remove', { schema: selectedSchema || undefined, table: selectedTable, key: result.primaryKeys.reduce((acc, key) => ({ ...acc, [key]: row[key] }), {}) })">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-state">Select a table to load rows.</p>
      </div>

      <div class="card">
        <div class="subheader">
          <h2>Insert Row</h2>
          <button @click="submitInsert">Insert</button>
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
            <button class="secondary" @click="emit('preview', { action: 'addColumn', schema: selectedSchema || undefined, table: selectedTable, column: 'new_column', definition: { columns: [{ name: 'new_column', dataType: 'TEXT', nullable: true, primaryKey: false, unique: false, autoIncrement: false }] } })">Preview Add Column</button>
            <button @click="emit('apply', { action: 'addColumn', schema: selectedSchema || undefined, table: selectedTable, column: 'new_column', definition: { columns: [{ name: 'new_column', dataType: 'TEXT', nullable: true, primaryKey: false, unique: false, autoIncrement: false }] } })">Apply Add Column</button>
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
      </div>

      <div v-if="sqlPreview" class="card preview-card">
        <div class="subheader">
          <h2>{{ sqlPreview.title }}</h2>
        </div>
        <pre>{{ sqlPreview.statements.join("\n\n") }}</pre>
      </div>
    </section>

    <section v-else class="card">
      <ul v-if="logs.length" class="log-list">
        <li v-for="log in logs" :key="log.id">
          <strong>{{ log.operation }}</strong>
          <span>{{ log.objectName }}</span>
          <em>{{ new Date(log.timestamp).toLocaleString() }}</em>
          <b :class="log.success ? 'ok' : 'bad'">{{ log.success ? "Success" : "Failed" }}</b>
        </li>
      </ul>
      <p v-else class="empty-state">No operations yet.</p>
    </section>
  </section>
</template>

