<script setup lang="ts">
import { computed } from 'vue';
import type { ComplianceLevel } from '../../types/compliance';

const props = defineProps<{ level?: ComplianceLevel; count?: number }>();
const emit = defineEmits<{ (e: 'click'): void }>();
const cls = computed(() => (props.level ? `c-badge ${props.level}` : 'c-badge'));
</script>

<template>
  <span v-if="level" :class="cls" @click="emit('click')" title="合规提示">
    ⚠ {{ count }}
  </span>
</template>

<style scoped>
.c-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 10px;
  cursor: pointer;
  vertical-align: middle;
  user-select: none;
}
.c-badge.high { background: #fef2f2; color: #f43f5e; border: 1px solid #fecdd3; }
.c-badge.mid { background: #fffbeb; color: #f59e0b; border: 1px solid #fde68a; }
.c-badge.low { background: #eff6ff; color: #3b82f6; border: 1px solid #bfdbfe; }
</style>
