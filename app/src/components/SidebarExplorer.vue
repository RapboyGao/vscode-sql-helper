<script setup lang="ts">
import type { DatabaseProfile, SqliteSchema } from "../types";

defineProps<{
  activeProfile: DatabaseProfile | null;
  activeProfileId: string | null;
  profiles: DatabaseProfile[];
  sqliteSchema: SqliteSchema | null;
  selectedTableName: string;
  schemaPending: boolean;
  error: string;
}>();

const emit = defineEmits<{
  "select-profile": [profileId: string];
  "select-table": [tableName: string];
}>();
</script>

<template>
  <section class="sidebar-shell">
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
        class="input"
        :value="activeProfileId ?? ''"
        @change="emit('select-profile', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">No active profile</option>
        <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
          {{ profile.name }} · {{ profile.type }}
        </option>
      </select>

      <p v-if="activeProfile" class="sidebar-path">{{ activeProfile.path }}</p>
    </section>

    <section class="panel sidebar-panel">
      <div class="panel-head compact">
        <div>
          <p class="panel-kicker">Schema Explorer</p>
          <h2>Tables</h2>
        </div>
      </div>

      <div v-if="sqliteSchema?.tables.length" class="sidebar-table-list">
        <button
          v-for="table in sqliteSchema.tables"
          :key="table.name"
          type="button"
          class="table-nav-item"
          :class="{ active: table.name === selectedTableName }"
          @click="emit('select-table', table.name)"
        >
          <strong class="table-item-title">{{ table.name }}</strong>
          <span class="table-item-meta">{{ table.columns.length }} columns</span>
        </button>
      </div>
      <p v-else class="empty">No schema loaded.</p>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>
