<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { useWorkspaceStore, ROUTE_META, SYSTEM_ROUTES } from '../stores/workspace';

const store = useWorkspaceStore();
const search = ref('');
const addOpen = ref(false);

const tabs = computed(() => store.tabs);
const activeId = computed(() => store.activeId);
const canAdd = computed(() => store.canAdd);

/** 「+」菜单：尚未打开的系统路由 */
const addableRoutes = computed(() =>
  SYSTEM_ROUTES.filter((r) => !store.tabs.some((t) => t.id === `sys:${r}`)).map((r) => ({
    route: r,
    title: ROUTE_META[r]?.title ?? r,
    icon: ROUTE_META[r]?.icon ?? '•',
  })),
);

function activate(id: string) {
  store.activate(id);
}
async function close(id: string, e: MouseEvent) {
  e.stopPropagation();
  const t = store.tabs.find((x) => x.id === id);
  // M4：有未保存内容（如发布页已填但未提交）时，关闭前二次确认
  if (t && t.dirty && t.closable !== false) {
    try {
      await ElMessageBox.confirm(
        '当前页面有未保存的内容，关闭后将丢失。确定关闭吗？',
        '未保存内容',
        {
          confirmButtonText: '关闭',
          cancelButtonText: '取消',
          type: 'warning',
          confirmButtonClass: 'el-button--danger',
        },
      );
    } catch {
      return; // 取消：不关闭
    }
  }
  store.close(id);
}
function addRoute(route: string) {
  addOpen.value = false;
  const ok = store.openSystemTab(route);
  if (!ok) ElMessage.warning(`任务页签已达上限（${store.MAX}）`);
}

// 横向滚动条上/下鼠标滚轮改为横向滚动，贴合浏览器 tab 习惯
function onWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (e.deltaY === 0) return;
  el.scrollLeft += e.deltaY;
}
</script>

<template>
  <header class="ws-tabbar">
    <!-- 左侧：横向滚动 tab 区 -->
    <div class="ws-tabs" @wheel.prevent="onWheel">
      <div
        v-for="t in tabs"
        :key="t.id"
        class="ws-tab"
        :class="{ active: t.id === activeId }"
        @click="activate(t.id)"
        :title="t.title"
      >
        <span class="ws-tab-ic">{{ t.icon }}</span>
        <span class="ws-tab-title">{{ t.title }}</span>
        <span v-if="t.kind === 'account' && t.envBadge" class="ws-env" :title="t.envBadge">🔒</span>
        <span v-if="t.dirty" class="ws-dot" title="有未保存内容"></span>
        <button
          v-if="t.closable !== false"
          class="ws-close"
          :class="{ show: t.id === activeId || t.dirty }"
          @click="close(t.id, $event)"
          title="关闭"
        >×</button>
      </div>

      <!-- 「+」新增页签 -->
      <el-dropdown trigger="click" placement="bottom-start" :disabled="!canAdd" @visible-change="(v: boolean) => (addOpen = v)">
        <button class="ws-add" :class="{ disabled: !canAdd, open: addOpen }" :disabled="!canAdd" title="打开页面">+</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="m in addableRoutes"
              :key="m.route"
              :command="m.route"
              @click="addRoute(m.route)"
            >
              <span class="ws-add-ic">{{ m.icon }}</span>{{ m.title }}
            </el-dropdown-item>
            <el-dropdown-item v-if="addableRoutes.length === 0" disabled>已全部打开</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 右侧：搜索 + 窗口控制点 -->
    <div class="ws-right">
      <el-input v-model="search" class="ws-search" placeholder="搜索…" :prefix-icon="Search" clearable />
      <div class="win-dots">
        <i class="r"></i><i class="y"></i><i class="g"></i>
      </div>
    </div>
  </header>
</template>

<style scoped>
.ws-tabbar {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px 0 8px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--line);
  position: relative;
  z-index: 15;
}
.ws-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  /* 两侧渐隐遮罩：溢出时提示可滚动 */
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
}
.ws-tabs::-webkit-scrollbar {
  display: none;
}
.ws-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px 0 12px;
  border-radius: var(--r-sm);
  color: var(--slate);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  position: relative;
  flex-shrink: 0;
}
.ws-tab:hover {
  background: rgba(99, 102, 241, 0.07);
  color: var(--brand-indigo);
}
.ws-tab.active {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}
/* 激活指示条 */
.ws-tab.active::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -8px;
  height: 2px;
  border-radius: 2px;
  background: var(--brand-grad);
}
.ws-tab-ic {
  font-size: 15px;
  line-height: 1;
}
.ws-tab-title {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ws-env {
  font-size: 11px;
  filter: saturate(0.8);
}
.ws-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-indigo);
  flex-shrink: 0;
}
.ws-close {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all var(--t-fast) var(--ease);
  flex-shrink: 0;
}
.ws-tab:hover .ws-close,
.ws-close.show {
  opacity: 1;
}
.ws-close:hover {
  background: rgba(244, 63, 94, 0.14);
  color: var(--danger);
}
.ws-add {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  margin-left: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--slate);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
}
.ws-add:hover:not(:disabled) {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
  background: var(--brand-grad-soft);
}
.ws-add.open {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
}
.ws-add.disabled,
.ws-add:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ws-add-ic {
  margin-right: 8px;
}
.ws-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.ws-search {
  width: 240px;
  max-width: 30vw;
}
.ws-search :deep(.el-input__wrapper) {
  border-radius: var(--r-pill);
  background: var(--surface-2);
  box-shadow: 0 0 0 1px var(--line) inset;
}
.ws-search :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--brand-indigo) inset;
}
.win-dots {
  display: flex;
  gap: 8px;
}
.win-dots i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}
.win-dots .r {
  background: #ff5f57;
}
.win-dots .y {
  background: #febc2e;
}
.win-dots .g {
  background: #28c840;
}
</style>
