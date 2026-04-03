<script setup lang="ts">
import { computed, ref, watch } from "vue";

type DateTimeParts = {
  date: string;
  hour: string;
  minute: string;
  second: string;
  millisecond: string;
};

type CalendarCell = {
  key: string;
  label: number;
  value: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
  placeholder?: string;
  onCommit?: (value: string) => void;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);
const draft = ref<DateTimeParts>(parseDateTimeParts(props.modelValue));
const calendarMonth = ref(inferCalendarMonth(draft.value.date));
const initialValue = ref(props.modelValue ?? "");

watch(
  () => props.modelValue,
  (value) => {
    draft.value = parseDateTimeParts(value);
    calendarMonth.value = inferCalendarMonth(draft.value.date);
  }
);

const summary = computed(() => props.modelValue || props.placeholder || "Set datetime");

const calendarTitle = computed(() =>
  calendarMonth.value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long"
  })
);

const calendarCells = computed<CalendarCell[]>(() => {
  const year = calendarMonth.value.getFullYear();
  const month = calendarMonth.value.getMonth();
  const monthStart = new Date(year, month, 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(gridStart);
    current.setDate(gridStart.getDate() + index);
    const value = formatCalendarDate(current);
    const today = formatCalendarDate(new Date());

    return {
      key: `${value}-${index}`,
      label: current.getDate(),
      value,
      inMonth: current.getMonth() === month,
      isToday: value === today,
      isSelected: value === draft.value.date
    };
  });
});

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

function inferCalendarMonth(dateText: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    const [yearText, monthText] = dateText.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    return new Date(year, month - 1, 1);
  }

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function formatCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampSegment(value: string, max: number, pad: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "".padStart(pad, "0");
  }

  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return "".padStart(pad, "0");
  }

  return String(Math.min(Math.max(Math.trunc(numeric), 0), max)).padStart(pad, "0");
}

function openEditor(): void {
  if (props.disabled) {
    return;
  }

  initialValue.value = props.modelValue ?? "";
  draft.value = parseDateTimeParts(props.modelValue);
  calendarMonth.value = inferCalendarMonth(draft.value.date);
  open.value = true;
}

function closeEditor(): void {
  open.value = false;
}

function shiftMonth(delta: number): void {
  calendarMonth.value = new Date(
    calendarMonth.value.getFullYear(),
    calendarMonth.value.getMonth() + delta,
    1
  );
}

function selectDate(value: string): void {
  draft.value = {
    ...draft.value,
    date: value
  };
  commitCurrentDraft();
}

function updateDateText(value: string): void {
  draft.value = {
    ...draft.value,
    date: value
  };
  commitCurrentDraft();
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
  props.onCommit?.("");
  closeEditor();
}

function commitCurrentDraft(): void {
  const nextValue = draft.value.date
    ? [
        draft.value.date,
        "T",
        clampSegment(draft.value.hour, 23, 2),
        ":",
        clampSegment(draft.value.minute, 59, 2),
        ":",
        clampSegment(draft.value.second, 59, 2),
        ".",
        clampSegment(draft.value.millisecond, 999, 3)
      ].join("")
    : "";

  emit("update:modelValue", nextValue);
  props.onCommit?.(nextValue);
}

function updateTimeSegment(segment: keyof Omit<DateTimeParts, "date">, value: string): void {
  draft.value = {
    ...draft.value,
    [segment]: value
  };
  commitCurrentDraft();
}

function cancel(): void {
  draft.value = parseDateTimeParts(initialValue.value);
  emit("update:modelValue", initialValue.value);
  props.onCommit?.(initialValue.value);
  closeEditor();
}
</script>

<template>
  <div class="datetime-editor">
    <button
      type="button"
      class="datetime-trigger"
      :class="{ disabled }"
      :disabled="disabled"
      @click="openEditor"
    >
      {{ summary }}
    </button>

    <div v-if="open" class="datetime-backdrop" @click.self="closeEditor">
      <div class="datetime-modal">
        <div class="datetime-topbar">
          <button type="button" class="secondary" @click="closeEditor">Done</button>
        </div>

        <div class="datetime-layout">
          <section class="calendar-panel">
            <div class="calendar-header">
              <button type="button" class="secondary icon-button" aria-label="Previous month" @click="shiftMonth(-1)">
                ‹
              </button>
              <strong>{{ calendarTitle }}</strong>
              <button type="button" class="secondary icon-button" aria-label="Next month" @click="shiftMonth(1)">
                ›
              </button>
            </div>

            <div class="calendar-grid weekday-row">
              <span v-for="weekday in WEEKDAY_LABELS" :key="weekday">{{ weekday }}</span>
            </div>

            <div class="calendar-grid day-grid">
              <button
                v-for="cell in calendarCells"
                :key="cell.key"
                type="button"
                class="calendar-day"
                :class="{
                  outside: !cell.inMonth,
                  today: cell.isToday,
                  selected: cell.isSelected
                }"
                @click="selectDate(cell.value)"
              >
                {{ cell.label }}
              </button>
            </div>
          </section>

          <section class="time-panel">
            <label class="datetime-field">
              <span>Date</span>
              <input
                :value="draft.date"
                type="text"
                placeholder="YYYY-MM-DD"
                @input="updateDateText(($event.target as HTMLInputElement).value)"
              />
            </label>

            <div class="datetime-grid">
              <label class="datetime-field">
                <span>Hour</span>
                <input
                  :value="draft.hour"
                  type="number"
                  min="0"
                  max="23"
                  placeholder="00"
                  @input="updateTimeSegment('hour', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="datetime-field">
                <span>Minute</span>
                <input
                  :value="draft.minute"
                  type="number"
                  min="0"
                  max="59"
                  placeholder="00"
                  @input="updateTimeSegment('minute', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="datetime-field">
                <span>Second</span>
                <input
                  :value="draft.second"
                  type="number"
                  min="0"
                  max="59"
                  placeholder="00"
                  @input="updateTimeSegment('second', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="datetime-field">
                <span>Millisecond</span>
                <input
                  :value="draft.millisecond"
                  type="number"
                  min="0"
                  max="999"
                  placeholder="000"
                  @input="updateTimeSegment('millisecond', ($event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
          </section>
        </div>

        <div class="datetime-actions">
          <button class="secondary" type="button" @click="clear">Clear</button>
          <button class="secondary" type="button" @click="cancel">Cancel</button>
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
  background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent);
  z-index: 12;
}

.datetime-modal {
  width: min(780px, 100%);
  display: grid;
  gap: 18px;
  padding: 20px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 14px;
  background: var(--vscode-editorWidget-background);
  box-shadow: 0 12px 32px color-mix(in srgb, black 18%, transparent);
}

.datetime-layout {
  display: grid;
  grid-template-columns: minmax(300px, 1.1fr) minmax(260px, 0.9fr);
  gap: 18px;
}

.datetime-topbar {
  display: flex;
  justify-content: flex-end;
}

.calendar-panel,
.time-panel {
  display: grid;
  gap: 12px;
}

.calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.weekday-row span {
  padding: 4px 0;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  font-size: 12px;
}

.calendar-day {
  min-height: 38px;
  padding: 6px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.calendar-day:hover {
  background: var(--vscode-list-hoverBackground);
}

.calendar-day.outside {
  opacity: 0.55;
}

.calendar-day.today {
  border-color: color-mix(in srgb, var(--vscode-focusBorder) 70%, var(--vscode-panel-border));
}

.calendar-day.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-color: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 70%, var(--vscode-focusBorder));
}

.datetime-field {
  display: grid;
  gap: 6px;
}

.datetime-field span {
  color: var(--vscode-editor-foreground);
}

.datetime-field input {
  width: 100%;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.datetime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.datetime-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-width: 820px) {
  .datetime-layout {
    grid-template-columns: 1fr;
  }
}
</style>
