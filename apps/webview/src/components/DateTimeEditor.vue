<script setup lang="ts">
import { computed, ref, watch } from "vue";

type DateTimeParts = {
  date: string;
  hour: string;
  minute: string;
  second: string;
  millisecond: string;
};

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);
const draft = ref<DateTimeParts>(parseDateTimeParts(props.modelValue));

watch(
  () => props.modelValue,
  (value) => {
    draft.value = parseDateTimeParts(value);
  }
);

const summary = computed(() => props.modelValue || props.placeholder || "Set datetime");

function parseDateTimeParts(value: string): DateTimeParts {
  const normalized = String(value ?? "").trim().replace(" ", "T").replace(/Z$/, "");
  const [datePart = "", timePart = ""] = normalized.split("T");
  const [timeWithoutMs = "", millisecondPart = ""] = timePart.split(".");
  const [hour = "", minute = "", second = ""] = timeWithoutMs.split(":");

  return {
    date: datePart,
    hour,
    minute,
    second,
    millisecond: millisecondPart.slice(0, 3)
  };
}

function clampSegment(value: string, max: number, pad: number): string {
  if (!value.trim()) {
    return "".padStart(pad, "0");
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "".padStart(pad, "0");
  }

  return String(Math.min(Math.max(Math.trunc(numeric), 0), max)).padStart(pad, "0");
}

function apply(): void {
  if (!draft.value.date) {
    emit("update:modelValue", "");
    open.value = false;
    return;
  }

  const nextValue = [
    draft.value.date,
    "T",
    clampSegment(draft.value.hour, 23, 2),
    ":",
    clampSegment(draft.value.minute, 59, 2),
    ":",
    clampSegment(draft.value.second, 59, 2),
    ".",
    clampSegment(draft.value.millisecond, 999, 3)
  ].join("");

  emit("update:modelValue", nextValue);
  open.value = false;
}

function clear(): void {
  draft.value = {
    date: "",
    hour: "",
    minute: "",
    second: "",
    millisecond: ""
  };
  emit("update:modelValue", "");
  open.value = false;
}
</script>

<template>
  <div class="datetime-editor">
    <button
      type="button"
      class="datetime-trigger"
      :class="{ disabled }"
      :disabled="disabled"
      @click="open = true"
    >
      {{ summary }}
    </button>

    <div v-if="open" class="datetime-backdrop" @click.self="open = false">
      <div class="datetime-modal">
        <div class="datetime-grid">
          <label>
            <span>Date</span>
            <input v-model="draft.date" type="date" />
          </label>
          <label>
            <span>Hour</span>
            <input v-model="draft.hour" type="number" min="0" max="23" />
          </label>
          <label>
            <span>Minute</span>
            <input v-model="draft.minute" type="number" min="0" max="59" />
          </label>
          <label>
            <span>Second</span>
            <input v-model="draft.second" type="number" min="0" max="59" />
          </label>
          <label>
            <span>Millisecond</span>
            <input v-model="draft.millisecond" type="number" min="0" max="999" />
          </label>
        </div>

        <div class="datetime-actions">
          <button class="secondary" type="button" @click="clear">Clear</button>
          <button class="secondary" type="button" @click="open = false">Cancel</button>
          <button type="button" @click="apply">Apply</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.datetime-editor {
  width: 100%;
}

.datetime-trigger {
  display: block;
  width: 100%;
  min-height: 42px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.datetime-trigger.disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.datetime-trigger:hover {
  background: color-mix(in srgb, var(--vscode-input-background) 80%, var(--vscode-list-hoverBackground));
}

.datetime-trigger:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.datetime-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--vscode-editor-background) 60%, transparent);
  z-index: 12;
}

.datetime-modal {
  width: min(640px, 100%);
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 14px;
  background: var(--vscode-editorWidget-background);
  box-shadow: 0 12px 32px color-mix(in srgb, black 18%, transparent);
}

.datetime-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) repeat(4, minmax(84px, 1fr));
  gap: 12px;
}

.datetime-grid label {
  display: grid;
  gap: 6px;
}

.datetime-grid span {
  color: var(--vscode-editor-foreground);
}

.datetime-grid input {
  width: 100%;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.datetime-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-width: 800px) {
  .datetime-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
