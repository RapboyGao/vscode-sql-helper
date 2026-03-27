<script setup lang="ts">
import { computed } from "vue";
import type { DatabaseProfile, SqliteSchema } from "../types";

const props = defineProps<{
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

const profileItems = computed(() => [
  { title: "No active profile", value: "" },
  ...props.profiles.map((profile) => ({
    title: `${profile.name} · ${profile.type}`,
    value: profile.id
  }))
]);
</script>

<template>
  <div class="sidebar-shell">
    <v-card class="sidebar-card" variant="tonal">
      <v-card-text class="d-flex flex-column ga-4">
        <div class="d-flex align-start justify-space-between ga-4">
          <div>
            <div class="section-kicker">Active Database</div>
            <div class="text-h5 font-weight-bold">{{ activeProfile?.name ?? "No active profile" }}</div>
          </div>
          <v-chip :color="schemaPending ? 'info' : 'secondary'" variant="tonal" size="small">
            {{ schemaPending ? "Loading" : sqliteSchema ? `${sqliteSchema.tableCount} tables` : "Idle" }}
          </v-chip>
        </div>

        <v-select
          :model-value="activeProfileId ?? ''"
          :items="profileItems"
          label="Profile"
          prepend-inner-icon="mdi-database-outline"
          @update:model-value="emit('select-profile', String($event ?? ''))"
        />

        <v-alert
          v-if="activeProfile"
          type="info"
          variant="tonal"
          density="compact"
          icon="mdi-folder-outline"
          class="path-alert"
        >
          {{ activeProfile.path }}
        </v-alert>
      </v-card-text>
    </v-card>

    <v-card class="sidebar-card" variant="tonal">
      <v-card-item>
        <template #prepend>
          <v-icon icon="mdi-table-large" />
        </template>
        <v-card-title>Tables</v-card-title>
        <v-card-subtitle>Schema Explorer</v-card-subtitle>
      </v-card-item>
      <v-divider />
      <v-list
        v-if="sqliteSchema?.tables.length"
        class="table-list-v"
        density="compact"
        nav
        lines="two"
      >
        <v-list-item
          v-for="table in sqliteSchema.tables"
          :key="table.name"
          :active="table.name === selectedTableName"
          rounded="xl"
          @click="emit('select-table', table.name)"
        >
          <template #prepend>
            <v-icon icon="mdi-table" />
          </template>
          <v-list-item-title>{{ table.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ table.columns.length }} columns</v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <v-card-text v-else>
        <v-empty-state
          headline="No schema loaded"
          title=""
          text="Select a database profile to load tables."
          icon="mdi-database-off-outline"
        />
      </v-card-text>
    </v-card>

    <v-alert v-if="error" type="error" variant="tonal" icon="mdi-alert-circle-outline">
      {{ error }}
    </v-alert>
  </div>
</template>
