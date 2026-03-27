<script setup lang="ts">
import { computed } from "vue";
import type { ColumnSchemaDraft } from "../types";

const props = defineProps<{
  structureDraft: ColumnSchemaDraft[];
  structureError: string;
  structurePending: boolean;
  databaseType?: "sqlite" | "generic";
}>();

const emit = defineEmits<{
  "add-column": [];
  "remove-column": [index: number];
  reset: [];
  apply: [];
}>();

const TYPE_OPTIONS: Record<"sqlite" | "generic", string[]> = {
  sqlite: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME", "TIMESTAMP", "JSON"],
  generic: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"]
};

const databaseType = computed(() => props.databaseType ?? "sqlite");

function typeOptionsFor(currentType: string): string[] {
  const baseOptions = TYPE_OPTIONS[databaseType.value] ?? TYPE_OPTIONS.sqlite;
  const normalizedCurrent = currentType.trim().toUpperCase();
  if (!normalizedCurrent || baseOptions.includes(normalizedCurrent)) {
    return baseOptions;
  }
  return [normalizedCurrent, ...baseOptions];
}
</script>

<template>
  <div class="table-tab-panel">
    <v-alert type="warning" variant="tonal" icon="mdi-database-sync-outline">
      Applying structure changes rebuilds the SQLite table and migrates existing rows into the new definition.
    </v-alert>

    <v-alert v-if="structureError" type="error" variant="tonal" icon="mdi-alert-circle-outline">
      {{ structureError }}
    </v-alert>

    <v-card class="results-surface" variant="tonal">
      <div class="grid-scroll structure-scroll">
        <table class="result-table structure-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Default</th>
              <th>Not Null</th>
              <th>Primary Key</th>
              <th class="sticky-action-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(column, index) in structureDraft" :key="`${column.sourceName}:${index}`">
              <td><v-text-field v-model="column.name" density="compact" class="grid-field" /></td>
              <td>
                <v-select
                  v-model="column.type"
                  :items="typeOptionsFor(column.type)"
                  density="compact"
                  class="grid-field"
                />
              </td>
              <td>
                <v-text-field
                  v-model="column.defaultValue"
                  density="compact"
                  class="grid-field"
                  placeholder="NULL / 'x' / 0"
                />
              </td>
              <td>
                <v-checkbox-btn v-model="column.notNull" color="primary" />
              </td>
              <td>
                <v-checkbox-btn v-model="column.primaryKey" color="secondary" />
              </td>
              <td class="sticky-action-col">
                <div class="row-action-group">
                  <v-btn
                    icon="mdi-delete-outline"
                    color="error"
                    variant="text"
                    @click="emit('remove-column', index)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <v-divider />

      <v-card-actions class="justify-space-between flex-wrap ga-3 pa-4">
        <v-btn prepend-icon="mdi-plus-box-outline" variant="tonal" @click="emit('add-column')">
          Add Column
        </v-btn>
        <div class="d-flex flex-wrap ga-3">
          <v-btn variant="text" @click="emit('reset')">Reset Changes</v-btn>
          <v-btn
            color="secondary"
            prepend-icon="mdi-content-save-cog-outline"
            :loading="structurePending"
            @click="emit('apply')"
          >
            Apply Structure
          </v-btn>
        </div>
      </v-card-actions>
    </v-card>
  </div>
</template>
