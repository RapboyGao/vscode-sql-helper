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
    <p class="status-meta structure-note">
      Applying structure changes rebuilds the SQLite table and migrates existing rows into the new definition.
    </p>
    <p v-if="structureError" class="error">{{ structureError }}</p>

    <div class="data-grid-wrap">
      <table class="data-grid structure-grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Default</th>
            <th>Not Null</th>
            <th>Primary Key</th>
            <th class="action-head">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(column, index) in structureDraft" :key="`${column.sourceName}:${index}`">
            <td><input v-model="column.name" class="grid-input" type="text" /></td>
            <td>
              <select v-model="column.type" class="grid-input">
                <option v-for="typeOption in typeOptionsFor(column.type)" :key="typeOption" :value="typeOption">
                  {{ typeOption }}
                </option>
              </select>
            </td>
            <td><input v-model="column.defaultValue" class="grid-input" type="text" placeholder="NULL / 'x' / 0" /></td>
            <td>
              <label class="checkbox-cell">
                <input v-model="column.notNull" type="checkbox" />
                <span>NOT NULL</span>
              </label>
            </td>
            <td>
              <label class="checkbox-cell">
                <input v-model="column.primaryKey" type="checkbox" />
                <span>PK</span>
              </label>
            </td>
            <td class="row-actions action-cell">
              <button
                type="button"
                class="icon-button icon-button-danger"
                title="Delete column"
                @click="emit('remove-column', index)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="structure-footer">
      <button type="button" class="button-ghost" @click="emit('add-column')">Add Column</button>
      <div class="structure-footer-actions">
        <button type="button" class="button-ghost" @click="emit('reset')">Reset Changes</button>
        <button type="button" class="button-secondary" :disabled="structurePending" @click="emit('apply')">
          {{ structurePending ? "Applying..." : "Apply Structure" }}
        </button>
      </div>
    </div>
  </div>
</template>
