<template>
  <div class="pager" v-if="total > 0">
    <div class="pager-info">
      共 <b>{{ total }}</b> {{ unit }}，第 <b>{{ page }}</b>/<b>{{ totalPages }}</b> 页
    </div>
    <div class="pager-ctrl">
      <button class="pg-btn" :disabled="page <= 1" title="首页" @click="goPage(1)">«</button>
      <button class="pg-btn" :disabled="page <= 1" title="上一页" @click="goPage(page - 1)">‹</button>
      <template v-for="p in pageNumbers" :key="p.key">
        <span v-if="p.ellipsis" class="pg-ellipsis">…</span>
        <button v-else class="pg-btn" :class="{ active: p.page === page }" @click="goPage(p.page ?? 1)">{{ p.page }}</button>
      </template>
      <button class="pg-btn" :disabled="page >= totalPages" title="下一页" @click="goPage(page + 1)">›</button>
      <button class="pg-btn" :disabled="page >= totalPages" title="末页" @click="goPage(totalPages)">»</button>
    </div>
    <div class="pager-size">
      <span>每页</span>
      <el-select :model-value="pageSize" class="pg-select" @change="onSizeChange">
        <el-option v-for="opt in pageSizeOptions" :key="opt" :value="opt" :label="String(opt)" />
      </el-select>
      <span>条</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    total: number;
    page: number;
    pageSize: number;
    pageSizeOptions?: number[];
    unit?: string;
  }>(),
  {
    pageSizeOptions: () => [10, 20, 50],
    unit: '条',
  },
);

const emit = defineEmits<{
  (e: 'update:page', v: number): void;
  (e: 'update:pageSize', v: number): void;
  (e: 'change', page: number, pageSize: number): void;
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

/**
 * 页码按钮：始终显示首页、末页、当前页±1，其余用省略号折叠，最多 7 个按钮。
 * 每项带唯一 key 以便 v-for 稳定渲染。
 */
const pageNumbers = computed<{ key: string; page?: number; ellipsis?: boolean }[]>(() => {
  const max = totalPages.value;
  const cur = props.page;
  const out: { key: string; page?: number; ellipsis?: boolean }[] = [];
  if (max <= 7) {
    for (let i = 1; i <= max; i++) out.push({ key: String(i), page: i });
  } else {
    out.push({ key: '1', page: 1 });
    if (cur > 3) out.push({ key: 'e1', ellipsis: true });
    for (let i = Math.max(2, cur - 1); i <= Math.min(max - 1, cur + 1); i++) {
      out.push({ key: String(i), page: i });
    }
    if (cur < max - 2) out.push({ key: 'e2', ellipsis: true });
    out.push({ key: String(max), page: max });
  }
  return out;
});

/** 跳转到指定页（自动夹取到合法范围） */
function goPage(p: number) {
  const np = Math.min(Math.max(1, p), totalPages.value);
  emit('update:page', np);
  emit('change', np, props.pageSize);
}

/** 切换每页条数后回到首页 */
function onSizeChange(v: number) {
  emit('update:pageSize', v);
  emit('update:page', 1);
  emit('change', 1, v);
}
</script>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 14px 18px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-xs);
}
.pager-info {
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.pager-info b {
  color: var(--ink);
  font-weight: 800;
}
.pager-ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pg-btn {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--slate);
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  line-height: 1;
}
.pg-btn:hover:not(:disabled) {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
  background: var(--brand-grad-soft);
}
.pg-btn.active {
  background: var(--brand-grad);
  color: #fff;
  border-color: transparent;
  box-shadow: var(--shadow-sm);
}
.pg-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pg-ellipsis {
  padding: 0 4px;
  color: var(--faint);
  font-weight: 700;
  font-size: 13px;
}
.pager-size {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 600;
}
.pg-select {
  width: 76px;
}
</style>
