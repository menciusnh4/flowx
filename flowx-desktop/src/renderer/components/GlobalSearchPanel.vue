<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { SearchResult } from '../composables/useGlobalSearch';

const props = defineProps<{
  results: SearchResult[];
  activeIndex: number;
  loading: boolean;
  query: string;
  /** 锚点：搜索框的视口坐标（left/top/width），由父组件实时计算 */
  anchor: { left: number; top: number; width: number };
}>();

const emit = defineEmits<{
  (e: 'hover', index: number): void;
  (e: 'select', result: SearchResult): void;
  (e: 'close'): void;
}>();

const PANEL_W = 460;

const rootRef = ref<HTMLElement | null>(null);

/** 按分组聚合（保持 results 顺序：功能模块→草稿→账号→书签→历史） */
const groups = computed(() => {
  const map: { group: string; icon: string; items: { result: SearchResult; index: number }[] }[] = [];
  props.results.forEach((r, index) => {
    let g = map.find((m) => m.group === r.group);
    if (!g) {
      g = { group: r.group, icon: r.icon, items: [] };
      map.push(g);
    }
    g.items.push({ result: r, index });
  });
  return map;
});

const panelStyle = computed(() => ({
  left: props.anchor.left + 'px',
  top: props.anchor.top + 'px',
  minWidth: Math.max(PANEL_W, props.anchor.width) + 'px',
}));

// 键盘移动高亮项时，确保其在面板内可见
watch(
  () => props.activeIndex,
  () => {
    nextTick(() => {
      const el = rootRef.value?.querySelector('.gs-item.active');
      el?.scrollIntoView({ block: 'nearest' });
    });
  },
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="results.length > 0 || loading"
      id="gs-panel"
      ref="rootRef"
      class="gs-panel"
      :style="panelStyle"
      role="listbox"
      @click.stop
      @contextmenu.prevent
    >
      <div class="gs-head">
        <span class="gs-count" v-if="!loading">{{ results.length }} 条结果</span>
        <span class="gs-count" v-else>搜索中…</span>
        <span class="gs-kbd">↑↓ 选择 · ↵ 打开 · Esc 关闭</span>
      </div>

      <template v-if="!loading">
        <div v-for="g in groups" :key="g.group" class="gs-group">
          <div class="gs-group-h">
            <span class="gs-g-ic">{{ g.icon }}</span>{{ g.group }}
            <span class="gs-g-count">{{ g.items.length }}</span>
          </div>
          <button
            v-for="it in g.items"
            :key="it.result.key"
            type="button"
            class="gs-item"
            :class="{ active: it.index === activeIndex }"
            role="option"
            :aria-selected="it.index === activeIndex"
            @mousemove="emit('hover', it.index)"
            @click="emit('select', it.result)"
          >
            <span class="gs-ic">{{ it.result.icon }}</span>
            <span class="gs-text">
              <span class="gs-title">{{ it.result.title }}</span>
              <span class="gs-sub" v-if="it.result.subtitle">{{ it.result.subtitle }}</span>
            </span>
            <span class="gs-open" v-if="it.index === activeIndex">↵ 打开</span>
          </button>
        </div>

        <div v-if="results.length === 0 && query" class="gs-empty">
          未找到与“{{ query }}”相关的结果
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.gs-panel {
  position: fixed;
  /* 必须高于浏览器任务选项卡的高层遮罩（Browser.vue .sidebar-mask z-index:9999），否则会被浏览器内容盖住 */
  z-index: 99999;
  max-height: 60vh;
  overflow-y: auto;
  padding: 8px;
  background: var(--surface-strong, #fff);
  border: 1px solid var(--line, #e2e8f0);
  border-radius: var(--r-md, 12px);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(15, 23, 42, 0.18));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 8px;
  border-bottom: 1px solid var(--line, #e2e8f0);
  margin-bottom: 4px;
}
.gs-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--slate, #475569);
}
.gs-kbd {
  font-size: 11px;
  color: var(--muted, #94a3b8);
}

.gs-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.gs-group-h {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted, #94a3b8);
  text-transform: none;
}
.gs-g-ic {
  font-size: 12px;
}
.gs-g-count {
  margin-left: auto;
  font-weight: 600;
  color: var(--faint, #cbd5e1);
}

.gs-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--r-sm, 9px);
  background: transparent;
  color: var(--ink-2, #1e293b);
  text-align: left;
  cursor: pointer;
  transition: background var(--t-fast, 0.15s) var(--ease, ease), color var(--t-fast, 0.15s) var(--ease, ease);
}
.gs-item:hover,
.gs-item.active {
  background: var(--brand-grad-soft, rgba(99, 102, 241, 0.1));
  color: var(--brand-indigo, #6366f1);
}
.gs-item.active {
  box-shadow: inset 2px 0 0 var(--brand-indigo, #6366f1);
}

.gs-ic {
  font-size: 15px;
  line-height: 1;
  flex-shrink: 0;
}
.gs-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.gs-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-sub {
  font-size: 11px;
  color: var(--muted, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-open {
  font-size: 11px;
  font-weight: 600;
  color: var(--brand-indigo, #6366f1);
  flex-shrink: 0;
}

.gs-empty {
  padding: 18px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--muted, #94a3b8);
}
</style>
