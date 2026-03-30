<script setup lang="ts">
import { mdiContentSave, mdiDeleteOutline, mdiDatabaseCheckOutline } from "@mdi/js";
import type { ConnectionFormState, SavedConnection } from "@usd/shared";
import MdiIcon from "./MdiIcon.vue";

defineProps<{
  connection: SavedConnection;
  form: ConnectionFormState;
  logs: Array<{ id: string; timestamp: string; operation: string; success: boolean; objectName: string }>;
}>();

const emit = defineEmits<{
  save: [form: ConnectionFormState];
  test: [form: ConnectionFormState];
  remove: [connectionId: string];
  update: [form: ConnectionFormState];
}>();
</script>

<template>
  <section class="panel-shell">
    <header class="panel-header">
      <div>
        <p class="eyebrow">Connection Details</p>
        <h1>{{ connection.name }}</h1>
      </div>
      <div class="actions">
        <button class="secondary icon-button" title="Test Connection" aria-label="Test Connection" @click="emit('test', form)">
          <MdiIcon :path="mdiDatabaseCheckOutline" />
        </button>
        <button class="icon-button" title="Save Connection" aria-label="Save Connection" @click="emit('save', form)">
          <MdiIcon :path="mdiContentSave" />
        </button>
      </div>
    </header>

    <div class="grid">
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
          <input :value="form.filePath" @input="emit('update', { ...form, filePath: ($event.target as HTMLInputElement).value })" />
        </label>
      </template>

      <label class="checkbox">
        <input type="checkbox" :checked="form.readonly" @change="emit('update', { ...form, readonly: ($event.target as HTMLInputElement).checked })" />
        <span>Readonly</span>
      </label>
      <label v-if="form.kind === 'server'" class="checkbox">
        <input type="checkbox" :checked="form.sslEnabled" @change="emit('update', { ...form, sslEnabled: ($event.target as HTMLInputElement).checked })" />
        <span>SSL Enabled</span>
      </label>
    </div>

    <section class="log-card">
      <div class="subheader">
        <h2>Recent Operations</h2>
        <button class="danger icon-button" title="Delete Connection" aria-label="Delete Connection" @click="emit('remove', connection.id)">
          <MdiIcon :path="mdiDeleteOutline" />
        </button>
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
  </section>
</template>
