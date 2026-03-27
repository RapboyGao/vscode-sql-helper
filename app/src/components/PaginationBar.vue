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
  <div class="pagination-shell">
    <div class="d-flex align-center ga-3 flex-wrap">
      <v-chip color="primary" variant="tonal" size="small">
        {{ pageStart }}-{{ pageEnd }}
      </v-chip>
      <span class="text-medium-emphasis">of {{ totalRows }} rows</span>
    </div>

    <div class="d-flex align-center ga-2 flex-wrap justify-end">
      <v-btn icon="mdi-chevron-left" variant="text" :disabled="pending || page === 0" @click="goToPage(page - 1)" />
      <v-btn
        v-for="pageNumber in leadingPages"
        :key="`leading-${pageNumber}`"
        :active="pageNumber === page"
        :color="pageNumber === page ? 'primary' : undefined"
        variant="tonal"
        min-width="40"
        @click="goToPage(pageNumber)"
      >
        {{ pageNumber + 1 }}
      </v-btn>
      <v-text-field
        v-if="totalPages > 5"
        v-model="jumpInput"
        class="page-jump-field"
        max-width="76"
        inputmode="numeric"
        @keydown.enter.prevent="submitPageJump"
        @blur="submitPageJump"
      />
      <template v-if="totalPages > 5">
        <v-btn
          v-for="pageNumber in trailingPages"
          :key="`trailing-${pageNumber}`"
          :active="pageNumber === page"
          :color="pageNumber === page ? 'primary' : undefined"
          variant="tonal"
          min-width="40"
          @click="goToPage(pageNumber)"
        >
          {{ pageNumber + 1 }}
        </v-btn>
      </template>
      <div v-else class="d-flex align-center ga-1 text-medium-emphasis">
        <strong>{{ page + 1 }}</strong>
        <span>/ {{ totalPages }}</span>
      </div>
      <v-btn
        icon="mdi-chevron-right"
        variant="text"
        :disabled="pending || page + 1 >= totalPages"
        @click="goToPage(page + 1)"
      />
    </div>
  </div>
</template>
