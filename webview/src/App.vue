<script setup lang="ts">
import { onMounted, ref } from "vue";

type AnalysisResult = {
  databases: string[];
  schemas: string[];
  references: Array<{
    kind: string;
    value: string;
  }>;
  note?: string;
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

function analyze(): void {
  pending.value = true;
  error.value = "";
  vscode?.postMessage({
    type: "analyze",
    sql: sql.value
  });
}

onMounted(() => {
  window.addEventListener("message", (event: MessageEvent) => {
    const { type, payload } = event.data ?? {};

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

  analyze();
});
</script>

<template>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">SQL Helper</p>
      <h1>Read database references from SQL</h1>
      <p class="subtitle">
        Vue renders the panel, the VS Code extension brokers requests, and Rust extracts likely
        database or schema references.
      </p>
    </section>

    <section class="panel">
      <label for="sql">SQL</label>
      <textarea id="sql" v-model="sql" spellcheck="false" />
      <div class="actions">
        <button type="button" :disabled="pending" @click="analyze">
          {{ pending ? "Analyzing..." : "Analyze SQL" }}
        </button>
      </div>
    </section>

    <section class="results">
      <div class="card">
        <h2>Databases</h2>
        <ul v-if="result?.databases.length">
          <li v-for="database in result.databases" :key="database">{{ database }}</li>
        </ul>
        <p v-else>No explicit database names detected.</p>
      </div>

      <div class="card">
        <h2>Schemas</h2>
        <ul v-if="result?.schemas.length">
          <li v-for="schema in result.schemas" :key="schema">{{ schema }}</li>
        </ul>
        <p v-else>No explicit schema names detected.</p>
      </div>

      <div class="card card-wide">
        <h2>References</h2>
        <ul v-if="result?.references.length">
          <li v-for="reference in result.references" :key="`${reference.kind}:${reference.value}`">
            <strong>{{ reference.kind }}</strong>
            <span>{{ reference.value }}</span>
          </li>
        </ul>
        <p v-else>No references found.</p>
        <p v-if="result?.note" class="note">{{ result.note }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
    </section>
  </main>
</template>
