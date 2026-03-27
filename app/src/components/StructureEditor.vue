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
  "delete-table": [];
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
  <div class="table-tab-panel structure-panel">
    <div class="structure-intro">
      <div class="structure-intro-icon">
        <v-icon icon="mdi-database-sync-outline" />
      </div>
      <div class="structure-intro-copy">
        <div class="section-kicker">Structure Editor</div>
        <div class="structure-intro-title">Schema changes rebuild the SQLite table</div>
        <div class="structure-intro-text">
          Existing rows are migrated into the new definition when you apply changes.
        </div>
      </div>
    </div>

    <v-alert v-if="structureError" type="error" variant="tonal" icon="mdi-alert-circle-outline">
      {{ structureError }}
    </v-alert>

    <v-card class="results-surface structure-surface" variant="tonal">
      <div class="structure-scroll">
        <table class="result-table structure-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Default</th>
              <th>Not Null</th>
              <th>Primary Key</th>
              <th>Unique</th>
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
              <td>
                <v-checkbox-btn v-model="column.unique" color="warning" :disabled="column.primaryKey" />
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

      <v-card-actions class="structure-actions">
        <div class="structure-actions-start">
          <v-btn prepend-icon="mdi-plus-box-outline" variant="tonal" @click="emit('add-column')">
            Add Column
          </v-btn>
        </div>
        <div class="structure-actions-end">
          <v-btn color="error" variant="text" prepend-icon="mdi-delete-outline" @click="emit('delete-table')">
            Delete Table
          </v-btn>
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
