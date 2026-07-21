<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { useWorkspaceStore, ROUTE_META, SYSTEM_ROUTES, type WorkspaceTab } from '../stores/workspace';
import { useGlobalSearch } from '../composables/useGlobalSearch';
import { electronApi } from '../utils/electron';
import GlobalSearchPanel from './GlobalSearchPanel.vue';

const store = useWorkspaceStore();
const {
  query,
  loading: gsLoading,
  open: gsOpen,
  results: gsResults,
  activeIndex: gsActive,
  onInput: gsOnInput,
  onFocus: gsOnFocus,
  select: gsSelect,
  close: gsClose,
  move: gsMove,
  setActive: gsSetActive,
  selectActive: gsSelectActive,
} = useGlobalSearch();

// 搜索框锚点（视口坐标），用于结果面板定位
const searchWrapRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<InstanceType<typeof import('element-plus')['ElInput']> | null>(null);
const anchor = ref({ left: 0, top: 0, width: 0 });
function updateAnchor() {
  const el = searchWrapRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  anchor.value = { left: r.left, top: r.bottom + 8, width: r.width };
}
function onSearchFocus() {
  updateAnchor();
  gsOnFocus();
}
function onSearchKeydown(e: Event | KeyboardEvent) {
  const ke = e as KeyboardEvent;
  if (ke.key === 'ArrowDown') {
    e.preventDefault();
    gsMove(1);
  } else if (ke.key === 'ArrowUp') {
    e.preventDefault();
    gsMove(-1);
  } else if (ke.key === 'Enter') {
    e.preventDefault();
    if (gsOpen.value && gsResults.value.length) gsSelectActive();
  } else if (ke.key === 'Escape') {
    e.preventDefault();
    gsClose();
    (ke.target as HTMLInputElement | null)?.blur();
  }
}

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

// ============ 原生菜单（「+」新增页签 / 右键任务选项卡） ============
// 顶栏弹层位于浏览器 WebContentsView 原生层之上，HTML 下拉会被原生层遮挡。
// 参考 main 分支方案：改用 Electron 原生菜单（popupNativeMenu），原生层级高于 WebContentsView，
// 从结构上消除遮挡，无需再依赖隐藏原生视图的脆弱竞态逻辑。

/** 「+」新增页签：弹出原生菜单，列出尚未打开的系统路由 */
function openAddMenu(e: MouseEvent) {
  if (!canAdd.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const items = addableRoutes.value.length
    ? addableRoutes.value.map((m) => ({ id: m.route, label: `${m.icon}  ${m.title}` }))
    : [{ id: '__none__', label: '已全部打开', enabled: false }]
  electronApi
    .popupNativeMenu(items, Math.round(rect.left), Math.round(rect.bottom + 4))
    .then((id) => {
      if (id && id !== '__none__') addRoute(id)
    })
    .catch((err) => console.error('[WorkspaceTabBar] 新增菜单失败', err))
}

/** 右键任务选项卡：弹出原生上下文菜单（关闭 / 关闭其他 / 关闭右侧 / 关闭全部） */
function openTabCtxMenu(e: MouseEvent, id: string) {
  e.preventDefault()
  e.stopPropagation()
  const tab = store.tabs.find((t) => t.id === id)
  const closable = tab?.closable !== false
  const idx = store.tabs.findIndex((t) => t.id === id)
  const items = [
    { id: 'close', label: '关闭', enabled: closable },
    { id: 'closeOthers', label: '关闭其他标签页', enabled: store.tabs.some((t) => t.id !== id && t.closable !== false) },
    { id: 'closeRight', label: '关闭右侧标签页', enabled: idx >= 0 && store.tabs.some((t, i) => i > idx && t.closable !== false) },
    { id: 'closeAll', label: '关闭所有标签页', enabled: store.tabs.some((t) => t.closable !== false) },
  ]
  electronApi
    .popupNativeMenu(items, e.clientX, e.clientY)
    .then((action) => {
      if (!action) return
      if (action === 'close') void requestClose(id)
      else if (action === 'closeOthers') void closeOthers(id)
      else if (action === 'closeRight') void closeRight(id)
      else if (action === 'closeAll') void closeAll()
    })
    .catch((err) => console.error('[WorkspaceTabBar] 右键菜单失败', err))
}

// 全局搜索面板：点搜索框/面板外部关闭（右键菜单已是原生，无需此处理）
function onDocPointer(e: MouseEvent) {
  if (gsOpen.value) {
    const panelEl = document.getElementById('gs-panel')
    const t = e.target as Node
    const insidePanel = panelEl && panelEl.contains(t)
    const insideSearch = searchWrapRef.value && searchWrapRef.value.contains(t)
    if (!insidePanel && !insideSearch) gsClose()
  }
}

/** 未保存内容二次确认：批量关闭前若有脏 tab 提示一次 */
async function confirmDirty(targets: WorkspaceTab[], title: string): Promise<boolean> {
  const dirtyN = targets.filter((t) => t.dirty).length;
  if (dirtyN === 0) return true;
  try {
    await ElMessageBox.confirm(
      `有 ${dirtyN} 个页面含未保存内容，关闭后将丢失。确定继续吗？`,
      title,
      {
        confirmButtonText: '关闭',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** 单个关闭（含未保存内容二次确认），× 按钮与「关闭」菜单项共用 */
async function requestClose(id: string) {
  const t = store.tabs.find((x) => x.id === id);
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
      return;
    }
  }
  store.close(id);
  nextTick(updateOverflow);
}

// —— 菜单动作（供原生右键菜单调用） ——
async function closeOthers(id: string) {
  const targets = store.tabs.filter((t) => t.id !== id && t.closable !== false);
  if (!(await confirmDirty(targets, '关闭其他标签页'))) return;
  store.closeOthers(id);
  nextTick(updateOverflow);
}
async function closeRight(id: string) {
  const idx = store.tabs.findIndex((t) => t.id === id);
  const targets = store.tabs.filter((t, i) => i > idx && t.closable !== false);
  if (!(await confirmDirty(targets, '关闭右侧标签页'))) return;
  store.closeRight(id);
  nextTick(updateOverflow);
}
async function closeAll() {
  const targets = store.tabs.filter((t) => t.closable !== false);
  if (!(await confirmDirty(targets, '关闭所有标签页'))) return;
  store.closeAll();
  nextTick(updateOverflow);
}

function activate(id: string) {
  // 滚动交给 scrollNonce watch 统一处理（store.activate 会自增 scrollNonce）
  store.activate(id);
}
async function close(id: string, e: MouseEvent) {
  e.stopPropagation();
  await requestClose(id);
}
function addRoute(route: string) {
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

// 全局搜索面板打开时，通知 Browser.vue 隐藏 WebContentsView 原生层（右键菜单/「+」菜单已改为原生菜单，无需此处理）
watch(gsOpen, (v) => { v ? store.pushTopbarOverlay() : store.popTopbarOverlay() })

onMounted(() => {
  updateOverflow();
  window.addEventListener('resize', updateOverflow);
  window.addEventListener('resize', updateAnchor);
  window.addEventListener('click', onDocPointer);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateOverflow);
  window.removeEventListener('resize', updateAnchor);
  window.removeEventListener('click', onDocPointer);
});

// 标签增删后重算溢出（nextTick 等 DOM 渲染完成）
watch(
  () => store.tabs.length,
  () => nextTick(updateOverflow),
);

// 激活/打开 tab 时（无论来自点顶栏还是点左侧菜单栏，含重新点击已激活模块）
// 自动滚动到可视区，确保当前选中的 tab 始终可见。
// 用 scrollNonce 而非 activeId：重新点击已激活模块时 activeId 不变，纯 watch activeId 不会触发。
watch(
  () => store.scrollNonce,
  () => {
    const id = store.activeId;
    if (!id) return;
    nextTick(() => {
      updateOverflow();
      ensureVisible(id);
    });
  },
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
          @contextmenu.prevent="openTabCtxMenu($event, t.id)"
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

      <!-- 「+」新增页签（原生菜单，避免 WebContentsView 遮挡，参考 main 分支方案） -->
      <button
        class="ws-add"
        :class="{ disabled: !canAdd }"
        :disabled="!canAdd"
        title="打开页面"
        @click="openAddMenu($event)"
      >+</button>
    </div>

    <!-- 与右侧搜索栏的恒定分隔线 + 间距（不随标签数量变化） -->
    <div class="ws-divider" aria-hidden="true"></div>

    <!-- 右侧：搜索 + 窗口控制点（位置恒定） -->
    <div class="ws-right">
      <div class="ws-search" ref="searchWrapRef">
        <el-input
          ref="searchInputRef"
          v-model="query"
          placeholder="搜索草稿、账号、书签、历史、功能…"
          :prefix-icon="Search"
          clearable
          @input="gsOnInput"
          @focus="onSearchFocus"
          @keydown="onSearchKeydown"
          @clear="gsClose"
        />
      </div>
      <div class="win-dots">
        <i class="r"></i><i class="y"></i><i class="g"></i>
      </div>
    </div>

    <!-- 全局搜索结果面板：Teleport 到 body，脱离顶栏 backdrop-filter 包含块，fixed 精确相对视口定位 -->
    <GlobalSearchPanel
      v-if="gsOpen"
      :results="gsResults"
      :active-index="gsActive"
      :loading="gsLoading"
      :query="query"
      :anchor="anchor"
      @hover="gsSetActive"
      @select="gsSelect"
      @close="gsClose"
    />

    <!-- 右键上下文菜单已改为 Electron 原生菜单（openTabCtxMenu → popupNativeMenu），无需 HTML 节点 -->
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
  z-index: 100;
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
  width: 340px;
  max-width: 42vw;
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
