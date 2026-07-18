<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { useWorkspaceStore, ROUTE_META, SYSTEM_ROUTES } from '../stores/workspace';

const store = useWorkspaceStore();
const search = ref('');
const addOpen = ref(false);

const tabs = computed(() => store.tabs);
const activeId = computed(() => store.activeId);
const canAdd = computed(() => store.canAdd);

// 溢出翻页状态：仅当标签总宽超过可视区时出现 ◀ ▶
const trackRef = ref<HTMLElement | null>(null);
const overflowLeft = ref(false);
const overflowRight = ref(false);

function updateOverflow() {
  const el = trackRef.value;
  if (!el) return;
  const overflow = el.scrollWidth - el.clientWidth > 1;
  overflowLeft.value = overflow && el.scrollLeft > 1;
  overflowRight.value = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

function scrollByDir(dir: number) {
  const el = trackRef.value;
  if (!el) return;
  el.scrollBy({ left: dir * 240, behavior: 'smooth' });
}

/** 激活标签时，若其不在可视区内，平滑滚动使其进入视野 */
function ensureVisible(id: string) {
  const el = trackRef.value;
  if (!el) return;
  const node = el.querySelector<HTMLElement>(`.ws-tab[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  const left = node.offsetLeft;
  const right = left + node.offsetWidth;
  if (left < el.scrollLeft) el.scrollTo({ left, behavior: 'smooth' });
  else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: 'smooth' });
}

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
  nextTick(() => {
    updateOverflow();
    ensureVisible(id);
  });
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
  nextTick(updateOverflow);
}
function addRoute(route: string) {
  addOpen.value = false;
  const ok = store.openSystemTab(route);
  if (!ok) ElMessage.warning(`任务页签已达上限（${store.MAX}）`);
  nextTick(updateOverflow);
}

// 横向滚动条上/下鼠标滚轮改为横向滚动，贴合浏览器 tab 习惯
function onWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (e.deltaY === 0) return;
  el.scrollLeft += e.deltaY;
}

onMounted(() => {
  updateOverflow();
  window.addEventListener('resize', updateOverflow);
});
onBeforeUnmount(() => window.removeEventListener('resize', updateOverflow));

// 标签增删后重算溢出（nextTick 等 DOM 渲染完成）
watch(
  () => store.tabs.length,
  () => nextTick(updateOverflow),
);
</script>

<template>
  <header class="ws-tabbar">
    <!-- 中部：弹性任务选项卡区（永不挤压右侧搜索栏）。开再多只在区内横向滚动 -->
    <div class="ws-tabs-zone">
      <button
        class="ws-nav"
        :class="{ hidden: !overflowLeft }"
        @click="scrollByDir(-1)"
        title="向左滚动"
        aria-label="向左滚动任务选项卡"
      >‹</button>

      <div class="ws-tabs" ref="trackRef" @scroll="updateOverflow" @wheel.prevent="onWheel">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="ws-tab"
          :data-id="t.id"
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
      </div>

      <button
        class="ws-nav"
        :class="{ hidden: !overflowRight }"
        @click="scrollByDir(1)"
        title="向右滚动"
        aria-label="向右滚动任务选项卡"
      >›</button>

      <!-- 「+」新增页签（常驻，始终可见） -->
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

    <!-- 与右侧搜索栏的恒定分隔线 + 间距（不随标签数量变化） -->
    <div class="ws-divider" aria-hidden="true"></div>

    <!-- 右侧：搜索 + 窗口控制点（位置恒定） -->
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
  gap: 0;
  padding: 0 16px 0 8px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--line);
  position: relative;
  z-index: 15;
}

/* —— 中部弹性区：承载任务选项卡 + 翻页按钮 + 新增按钮 —— */
.ws-tabs-zone {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
}

.ws-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  scroll-behavior: smooth;
}
.ws-tabs::-webkit-scrollbar {
  display: none;
}

/* 溢出翻页按钮：仅溢出时出现，到头自动隐藏 */
.ws-nav {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  color: var(--slate);
  background: var(--surface);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
}
.ws-nav:hover {
  color: var(--brand-indigo);
  border-color: rgba(99, 102, 241, 0.4);
}
.ws-nav.hidden {
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

/* —— 与搜索栏的恒定分隔线 + 间距 —— */
.ws-divider {
  width: 1px;
  height: 24px;
  background: var(--line);
  margin: 0 16px;
  flex-shrink: 0;
}

/* 右侧固定区 */
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

/* 窄屏：搜索栏收窄，保持与标签区的美观距离 */
@media (max-width: 1080px) {
  .ws-search {
    width: 200px;
  }
  .ws-divider {
    margin: 0 12px;
  }
}
@media (max-width: 760px) {
  .ws-search {
    width: 160px;
    max-width: 40vw;
  }
}
</style>
