<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{
  page: number;
  pageSize: number;
  totalRows: number;
  pending: boolean;
}>();

const emit = defineEmits<{
  page: [page: number];
}>();

const jumpInput = ref("1");

const totalPages = computed(() => Math.max(1, Math.ceil(props.totalRows / props.pageSize)));
const pageStart = computed(() => (props.totalRows === 0 ? 0 : props.page * props.pageSize + 1));
const pageEnd = computed(() => (props.totalRows === 0 ? 0 : Math.min(props.totalRows, props.page * props.pageSize + props.pageSize)));
const leadingPages = computed(() => Array.from({ length: Math.min(3, totalPages.value) }, (_, index) => index));
const trailingPages = computed(() => (totalPages.value <= 5 ? [] : [totalPages.value - 2, totalPages.value - 1]));

watch(
  () => props.page,
  (page) => {
    jumpInput.value = String(page + 1);
  },
  { immediate: true }
);

function goToPage(page: number): void {
  const normalizedPage = Math.min(Math.max(0, page), totalPages.value - 1);
  jumpInput.value = String(normalizedPage + 1);
  emit("page", normalizedPage);
}

function submitPageJump(): void {
  const parsedPage = Number.parseInt(jumpInput.value, 10);

  if (!Number.isFinite(parsedPage)) {
    jumpInput.value = String(props.page + 1);
    return;
  }

  goToPage(parsedPage - 1);
}
</script>

<template>
  <div class="pagination-bar">
    <div class="pagination-meta">
      <span class="pagination-range">{{ pageStart }}-{{ pageEnd }}</span>
      <span class="status-meta">of {{ totalRows }} rows</span>
    </div>
    <div class="pagination-controls">
      <button
        type="button"
        class="pagination-button"
        :disabled="pending || page === 0"
        @click="goToPage(page - 1)"
      >
        &lt;
      </button>
      <button
        v-for="pageNumber in leadingPages"
        :key="`leading-${pageNumber}`"
        type="button"
        class="pagination-button pagination-number"
        :class="{ active: pageNumber === page }"
        :disabled="pending"
        @click="goToPage(pageNumber)"
      >
        {{ pageNumber + 1 }}
      </button>
      <template v-if="totalPages > 5">
        <input
          v-model="jumpInput"
          class="page-jump-input"
          type="text"
          inputmode="numeric"
          :disabled="pending"
          :aria-label="`Jump to page, current page ${page + 1}`"
          @keydown.enter.prevent="submitPageJump"
          @blur="submitPageJump"
        />
        <template v-for="pageNumber in trailingPages" :key="`trailing-${pageNumber}`">
          <button
            type="button"
            class="pagination-button pagination-number"
            :class="{ active: pageNumber === page }"
            :disabled="pending"
            @click="goToPage(pageNumber)"
          >
            {{ pageNumber + 1 }}
          </button>
        </template>
      </template>
      <div v-else class="pagination-page">
        <strong>{{ page + 1 }}</strong>
        <span>/ {{ totalPages }}</span>
      </div>
      <button
        type="button"
        class="pagination-button"
        :disabled="pending || page + 1 >= totalPages"
        @click="goToPage(page + 1)"
      >
        &gt;
      </button>
    </div>
  </div>
</template>
