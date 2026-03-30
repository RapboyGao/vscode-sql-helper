<script setup lang="ts">
defineProps<{
  path: string;
  size?: number;
  title?: string;
}>();
</script>

<template>
  <svg
    class="mdi-icon"
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <title v-if="title">{{ title }}</title>
    <path :d="path" />
  </svg>
</template>
