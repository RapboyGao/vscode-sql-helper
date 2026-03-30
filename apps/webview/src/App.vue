<script setup lang="ts">
import { onMounted, ref } from "vue";
import type {
  ConnectionFormState,
  ExtensionToWebviewMessage,
  PendingTableChange,
  SavedConnection,
  TableQuery,
  TableQueryResult,
  TableSchema,
  WebviewToExtensionMessage
} from "@usd/shared";
import ConnectionDetailsView from "./components/ConnectionDetailsView.vue";
import TableDataView from "./components/TableDataView.vue";
import { getVsCodeApi } from "./composables/vscode";

const vscode = getVsCodeApi();

const mode = ref<"idle" | "connection" | "tableData">("idle");
const connection = ref<SavedConnection | null>(null);
const form = ref<ConnectionFormState | null>(null);
const logs = ref<Array<{ id: string; timestamp: string; operation: string; success: boolean; objectName: string }>>([]);
const schemas = ref<string[]>([]);
const tables = ref<string[]>([]);
const selectedSchema = ref<string | undefined>();
const selectedTable = ref<string | undefined>();
const query = ref<TableQuery>({ table: "", page: 0, pageSize: 50 });
const result = ref<TableQueryResult | undefined>();
const structure = ref<TableSchema | undefined>();
const sqlPreview = ref<{ title: string; statements: string[] } | null>(null);
const message = ref<string>("");
const isError = ref(false);
const applySignal = ref(0);

function post(payload: WebviewToExtensionMessage): void {
  vscode?.postMessage(payload);
}

function showNotice(text: string, error = false): void {
  message.value = text;
  isError.value = error;
}

onMounted(() => {
  window.addEventListener("message", (event) => {
    const next = event.data as ExtensionToWebviewMessage;
    switch (next.type) {
      case "connection/bootstrap":
        mode.value = "connection";
        connection.value = next.payload.connection;
        form.value = next.payload.form;
        logs.value = next.payload.logs;
        break;
      case "connection/saved":
        connection.value = next.payload.connection;
        form.value = next.payload.form;
        showNotice("Connection saved");
        break;
      case "connection/testResult":
        showNotice(next.payload.message, !next.payload.success);
        break;
      case "tableData/bootstrap":
        mode.value = "tableData";
        connection.value = next.payload.connection;
        schemas.value = next.payload.schemas.schemas;
        tables.value = next.payload.tables.tables.map((entry) => entry.name);
        selectedSchema.value = next.payload.selectedSchema;
        selectedTable.value = next.payload.selectedTable;
        query.value = next.payload.query;
        result.value = next.payload.result;
        structure.value = next.payload.structure;
        logs.value = next.payload.logs;
        break;
      case "tableData/result":
        query.value = next.payload.query;
        result.value = next.payload.result;
        break;
      case "schema/result":
        structure.value = next.payload.table.table;
        break;
      case "tableData/appliedChanges":
        applySignal.value += 1;
        showNotice(`${next.payload.appliedCount} pending change(s) applied`);
        break;
      case "schema/sqlPreview":
        sqlPreview.value = next.payload;
        break;
      case "logs/result":
        logs.value = next.payload.logs;
        break;
      case "ui/error":
        showNotice(next.payload.message, true);
        break;
    }
  });

  post({ type: "ui/ready" });
});
</script>

<template>
  <main class="app-shell">
    <section v-if="message" class="banner" :class="{ error: isError }">{{ message }}</section>

    <ConnectionDetailsView
      v-if="mode === 'connection' && connection && form"
      :connection="connection"
      :form="form"
      :logs="logs"
      @update="form = $event"
      @save="post({ type: 'connection/save', payload: $event })"
      @test="post({ type: 'connection/test', payload: $event })"
      @remove="post({ type: 'connection/delete', payload: { connectionId: $event } })"
    />

    <TableDataView
      v-else-if="mode === 'tableData' && connection"
      :connection="connection"
      :schemas="schemas"
      :tables="tables"
      :selected-schema="selectedSchema"
      :selected-table="selectedTable"
      :query="query"
      :result="result"
      :structure="structure"
      :logs="logs"
      :sql-preview="sqlPreview"
      :apply-signal="applySignal"
      @query="post({ type: 'tableData/query', payload: $event })"
      @applyChanges="post({ type: 'tableData/applyChanges', payload: $event })"
      @preview="post({ type: 'schema/preview', payload: $event })"
      @apply="post({ type: 'schema/apply', payload: $event })"
    />

    <section v-else class="empty-state empty-root">
      Loading database metadata...
    </section>
  </main>
</template>
