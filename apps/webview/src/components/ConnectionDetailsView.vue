<script setup lang="ts">
import { mdiContentSave, mdiDeleteOutline, mdiDatabaseCheckOutline, mdiDatabaseOutline, mdiFileDocumentOutline, mdiFolderOpenOutline, mdiShieldCheckOutline } from "@mdi/js";
import type { ConnectionFormState, SavedConnection } from "@usd/shared";
import MdiIcon from "./MdiIcon.vue";

defineProps<{
  connection: SavedConnection;
  form: ConnectionFormState;
  logs: Array<{ id: string; timestamp: string; operation: string; success: boolean; objectName: string }>;
  busyAction: "save" | "test" | null;
  statusText: string;
}>();

const emit = defineEmits<{
  save: [form: ConnectionFormState];
  test: [form: ConnectionFormState];
  pickFile: [];
  remove: [connectionId: string];
  update: [form: ConnectionFormState];
}>();
</script>

<template>
  <section class="connection-layout">
    <header class="panel-shell connection-hero">
      <div class="connection-hero-copy">
        <p class="eyebrow">Connection Details</p>
        <h1 class="title-with-icon">
          <MdiIcon :path="mdiDatabaseOutline" :size="22" />
          <span>{{ connection.name }}</span>
        </h1>
        <p class="connection-subtitle">
          {{ form.kind === "file" ? "SQLite file connection" : "Server database connection" }}
        </p>
        <div class="connection-meta">
          <span class="status-chip" :class="{ busy: busyAction, readonly: form.readonly }">{{ statusText }}</span>
          <span class="meta-pill">{{ form.type.toUpperCase() }}</span>
        </div>
      </div>
      <div class="actions">
        <button
          class="secondary action-button"
          :disabled="busyAction !== null"
          :title="busyAction === 'test' ? 'Testing Connection' : 'Test Connection'"
          :aria-label="busyAction === 'test' ? 'Testing Connection' : 'Test Connection'"
          @click="emit('test', form)"
        >
          <MdiIcon :path="mdiDatabaseCheckOutline" />
          <span>{{ busyAction === "test" ? "Testing..." : "Test" }}</span>
        </button>
        <button
          class="action-button"
          :disabled="busyAction !== null"
          :title="busyAction === 'save' ? 'Saving Connection' : 'Save Connection'"
          :aria-label="busyAction === 'save' ? 'Saving Connection' : 'Save Connection'"
          @click="emit('save', form)"
        >
          <MdiIcon :path="mdiContentSave" />
          <span>{{ busyAction === "save" ? "Saving..." : "Save" }}</span>
        </button>
        <button
          class="danger action-button"
          :disabled="busyAction !== null"
          title="Delete Connection"
          aria-label="Delete Connection"
          @click="emit('remove', connection.id)"
        >
          <MdiIcon :path="mdiDeleteOutline" />
          <span>Delete</span>
        </button>
      </div>
    </header>

    <section class="connection-grid">
      <section class="card form-card">
        <div class="subheader">
          <h2 class="title-with-icon">
            <MdiIcon :path="mdiFileDocumentOutline" :size="18" />
            <span>Configuration</span>
          </h2>
        </div>

        <div class="grid connection-form-grid">
          <label>
            <span>Name</span>
            <input :value="form.name" @input="emit('update', { ...form, name: ($event.target as HTMLInputElement).value })" />
          </label>

          <label>
            <span>Type</span>
            <select :value="form.type" @change="emit('update', { ...form, type: ($event.target as HTMLSelectElement).value as ConnectionFormState['type'], kind: ($event.target as HTMLSelectElement).value === 'sqlite' ? 'file' : 'server' })">
              <option value="sqlite">SQLite</option>
              <option value="mysql">MySQL</option>
              <option value="postgresql">PostgreSQL</option>
            </select>
          </label>

          <template v-if="form.kind === 'server'">
            <label>
              <span>Host</span>
              <input :value="form.host" @input="emit('update', { ...form, host: ($event.target as HTMLInputElement).value })" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" :value="form.port" @input="emit('update', { ...form, port: Number(($event.target as HTMLInputElement).value) })" />
            </label>
            <label>
              <span>Username</span>
              <input :value="form.username" @input="emit('update', { ...form, username: ($event.target as HTMLInputElement).value })" />
            </label>
            <label>
              <span>Password</span>
              <input type="password" :value="form.password" @input="emit('update', { ...form, password: ($event.target as HTMLInputElement).value })" />
            </label>
            <label>
              <span>Database</span>
              <input :value="form.database" @input="emit('update', { ...form, database: ($event.target as HTMLInputElement).value })" />
            </label>
            <label>
              <span>Schema</span>
              <input :value="form.schema" @input="emit('update', { ...form, schema: ($event.target as HTMLInputElement).value })" />
            </label>
          </template>

          <template v-else>
            <label class="full-width">
              <span>SQLite File Path</span>
              <div class="file-input-row">
                <input :value="form.filePath" @input="emit('update', { ...form, filePath: ($event.target as HTMLInputElement).value })" />
                <button class="secondary icon-button" type="button" title="Choose SQLite File" aria-label="Choose SQLite File" @click="emit('pickFile')">
                  <MdiIcon :path="mdiFolderOpenOutline" />
                </button>
              </div>
            </label>
          </template>
        </div>
      </section>

      <aside class="connection-side">
        <section class="card connection-options">
          <div class="subheader">
            <h2 class="title-with-icon">
              <MdiIcon :path="mdiShieldCheckOutline" :size="18" />
              <span>Options</span>
            </h2>
          </div>

          <label class="checkbox option-toggle">
            <span>Readonly</span>
            <input type="checkbox" :checked="form.readonly" @change="emit('update', { ...form, readonly: ($event.target as HTMLInputElement).checked })" />
          </label>
          <label v-if="form.kind === 'server'" class="checkbox option-toggle">
            <span>SSL Enabled</span>
            <input type="checkbox" :checked="form.sslEnabled" @change="emit('update', { ...form, sslEnabled: ($event.target as HTMLInputElement).checked })" />
          </label>
        </section>

        <section class="card log-card">
          <div class="subheader">
            <h2>Recent Operations</h2>
          </div>
          <ul v-if="logs.length" class="log-list">
            <li v-for="log in logs" :key="log.id">
              <strong>{{ log.operation }}</strong>
              <span>{{ log.objectName }}</span>
              <em>{{ new Date(log.timestamp).toLocaleString() }}</em>
              <b :class="log.success ? 'ok' : 'bad'">{{ log.success ? "Success" : "Failed" }}</b>
            </li>
          </ul>
          <p v-else class="empty-state">No operations recorded for this connection yet.</p>
        </section>
      </aside>
    </section>
  </section>
</template>
