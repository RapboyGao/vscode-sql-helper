<script setup lang="ts">
import { onMounted, ref } from "vue";
import type {
  ConnectionFormState,
  DdlPayload,
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
const connectionBusyAction = ref<"save" | "test" | null>(null);
const connectionStatusText = ref("Ready");
const pendingSchemaAction = ref<string | null>(null);
let connectionBusyTimer: number | undefined;
let schemaBusyTimer: number | undefined;

function post(payload: WebviewToExtensionMessage): void {
  vscode?.postMessage(payload);
}

function toPlainConnectionForm(value: ConnectionFormState): ConnectionFormState {
  return {
    ...value
  };
}

function showNotice(text: string, error = false): void {
  message.value = text;
  isError.value = error;
}

function clearConnectionBusy(): void {
  connectionBusyAction.value = null;
  if (connectionBusyTimer !== undefined) {
    window.clearTimeout(connectionBusyTimer);
    connectionBusyTimer = undefined;
  }
}

function clearSchemaBusy(): void {
  pendingSchemaAction.value = null;
  if (schemaBusyTimer !== undefined) {
    window.clearTimeout(schemaBusyTimer);
    schemaBusyTimer = undefined;
  }
}

function startConnectionBusy(action: "save" | "test", statusText: string): void {
  clearConnectionBusy();
  connectionBusyAction.value = action;
  connectionStatusText.value = statusText;
  connectionBusyTimer = window.setTimeout(() => {
    if (connectionBusyAction.value !== action) {
      return;
    }

    clearConnectionBusy();
    connectionStatusText.value = "No response";
    showNotice(`Connection ${action} did not finish. Please try again.`, true);
  }, 8000);
}

function requestConnectionSave(nextForm: ConnectionFormState): void {
  startConnectionBusy("save", "Saving connection...");
  post({
    type: "connection/save",
    payload: toPlainConnectionForm(nextForm)
  });
}

function requestConnectionTest(nextForm: ConnectionFormState): void {
  startConnectionBusy("test", "Testing connection...");
  post({
    type: "connection/test",
    payload: toPlainConnectionForm(nextForm)
  });
}

function requestConnectionFilePick(): void {
  post({
    type: "connection/pickFile",
    payload: {
      filters: {
        SQLite: ["sqlite", "sqlite3", "db", "db3"],
        All: ["*"]
      }
    }
  });
}

function requestSchemaApply(payload: {
  action: "createTable" | "renameTable" | "deleteTable" | "addColumn" | "editColumn" | "deleteColumn" | "renameColumn";
  schema?: string;
  table: string;
  nextTable?: string;
  column?: string;
  nextColumn?: string;
  definition?: Partial<TableSchema>;
}): void {
  clearSchemaBusy();
  pendingSchemaAction.value = payload.action;
  showNotice(`Applying ${payload.action}...`);
  schemaBusyTimer = window.setTimeout(() => {
    if (pendingSchemaAction.value !== payload.action) {
      return;
    }

    clearSchemaBusy();
    showNotice(`${payload.action} did not finish. Please try again.`, true);
  }, 8000);
  post({ type: "schema/apply", payload });
}

function requestColumnsPreview(payload: {
  schema?: string;
  table: string;
  actions: DdlPayload[];
}): void {
  post({
    type: "columns/preview",
    payload
  });
}

function requestColumnsApply(payload: {
  schema?: string;
  table: string;
  actions: DdlPayload[];
}): void {
  post({
    type: "columns/apply",
    payload
  });
}

function requestApplyChanges(payload: {
  schema?: string;
  table: string;
  changes: PendingTableChange[];
}): void {
  const plainPayload = JSON.parse(
    JSON.stringify({
      schema: payload.schema,
      table: payload.table,
      changes: payload.changes
    })
  ) as {
    schema?: string;
    table: string;
    changes: PendingTableChange[];
  };

  post({
    type: "tableData/applyChanges",
    payload: plainPayload
  });
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
        clearConnectionBusy();
        connectionStatusText.value = next.payload.connection.readonly ? "Readonly" : "Read / Write";
        break;
      case "connection/saved":
        connection.value = next.payload.connection;
        form.value = next.payload.form;
        clearConnectionBusy();
        connectionStatusText.value = next.payload.connection.readonly ? "Readonly" : "Read / Write";
        showNotice("Connection saved");
        break;
      case "connection/testResult":
        clearConnectionBusy();
        connectionStatusText.value = next.payload.success ? "Connection verified" : "Connection failed";
        showNotice(next.payload.message, !next.payload.success);
        break;
      case "connection/filePicked":
        if (form.value) {
          form.value = {
            ...form.value,
            filePath: next.payload.filePath
          };
        }
        connectionStatusText.value = "File selected";
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
        if (pendingSchemaAction.value) {
          const action = pendingSchemaAction.value;
          clearSchemaBusy();
          showNotice(`${action} applied`);
        }
        break;
      case "tableData/result":
        query.value = next.payload.query;
        result.value = next.payload.result;
        break;
      case "schema/result":
        structure.value = next.payload.table.table;
        break;
      case "tableData/appliedChanges":
        if (next.payload.appliedCount > 0) {
          applySignal.value += 1;
          showNotice(`${next.payload.appliedCount} pending change(s) applied`);
        } else {
          showNotice("No pending changes to apply.", true);
        }
        break;
      case "schema/sqlPreview":
        sqlPreview.value = next.payload;
        break;
      case "schema/applied": {
        const action = next.payload.action;
        clearSchemaBusy();
        showNotice(`${action} applied on ${next.payload.table}`);
        break;
      }
      case "logs/result":
        logs.value = next.payload.logs;
        break;
      case "ui/error":
        clearConnectionBusy();
        clearSchemaBusy();
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
      :busy-action="connectionBusyAction"
      :status-text="connectionStatusText"
      @update="form = $event"
      @save="requestConnectionSave($event)"
      @test="requestConnectionTest($event)"
      @pick-file="requestConnectionFilePick()"
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
      @applyChanges="requestApplyChanges($event)"
      @preview="post({ type: 'schema/preview', payload: $event })"
      @apply="requestSchemaApply($event)"
      @previewColumns="requestColumnsPreview($event)"
      @applyColumns="requestColumnsApply($event)"
    />

    <section v-else class="empty-state empty-root">
      Loading database metadata...
    </section>
  </main>
</template>
