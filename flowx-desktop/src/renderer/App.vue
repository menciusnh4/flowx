<template>
  <div class="app-shell">
    <!-- ============ 左侧竖栏导航 ============ -->
    <aside class="sidebar" :class="{ collapsed }">
      <div class="sidebar-logo">
        <div class="logo-mark">F</div>
        <div class="logo-text">
          <span class="name">FlowX</span>
          <small>多平台内容发布助手</small>
        </div>
      </div>

      <nav class="nav-group">
        <button
          v-for="item in primaryNav"
          :key="item.index"
          class="nav-item"
          :class="{ active: route.path === item.index }"
          :data-tip="item.label"
          @click="go(item.index)"
        >
          <span class="ic">{{ item.icon }}</span>
          <span class="label">{{ item.label }}</span>
        </button>

        <!-- 工作台：可展开二级菜单（草稿准备 + 平台浏览） -->
        <button
          class="nav-item has-sub"
          :class="{ active: isWorkbenchActive, expanded: workbenchOpen }"
          data-tip="工作台"
          @click="onParentClick('workbench', $event)"
          @mouseenter="onParentEnter('workbench', $event)"
          @mouseleave="onParentLeave"
        >
          <span class="ic">🧰</span>
          <span class="label">工作台</span>
          <span class="caret">▸</span>
        </button>
        <div class="nav-sub" :class="{ open: workbenchOpen }">
          <div class="nav-sub-inner">
            <button
              v-for="sub in workbenchNav"
              :key="sub.index"
              class="nav-sub-item"
              :class="{ active: route.path === sub.index }"
              @click="go(sub.index)"
            >
              <span v-if="sub.icon" class="ic">{{ sub.icon }}</span><span v-else class="dot"></span>
              <span>{{ sub.label }}</span>
            </button>
          </div>
        </div>

        <!-- 一键发布：可展开二级菜单 -->
        <button
          class="nav-item has-sub"
          :class="{ active: isPubActive, expanded: pubOpen }"
          data-tip="一键发布"
          @click="onParentClick('pub', $event)"
          @mouseenter="onParentEnter('pub', $event)"
          @mouseleave="onParentLeave"
        >
          <span class="ic">🚀</span>
          <span class="label">一键发布</span>
          <span class="caret">▸</span>
        </button>
        <div class="nav-sub" :class="{ open: pubOpen }">
          <div class="nav-sub-inner">
            <button
              v-for="sub in publishNav"
              :key="sub.index"
              class="nav-sub-item"
              :class="{ active: route.path === sub.index }"
              @click="go(sub.index)"
            >
              <span v-if="sub.icon" class="ic">{{ sub.icon }}</span><span v-else class="dot"></span>
              <span>{{ sub.label }}</span>
            </button>
          </div>
        </div>

        <!-- 系统配置：可展开二级菜单 -->
        <button
          class="nav-item has-sub"
          :class="{ active: isSettingsActive, expanded: settingsOpen }"
          data-tip="系统配置"
          @click="onParentClick('settings', $event)"
          @mouseenter="onParentEnter('settings', $event)"
          @mouseleave="onParentLeave"
        >
          <span class="ic">⚙️</span>
          <span class="label">系统配置</span>
          <span class="caret">▸</span>
        </button>
        <div class="nav-sub" :class="{ open: settingsOpen }">
          <div class="nav-sub-inner">
            <button
              v-for="sub in settingsNav"
              :key="sub.index"
              class="nav-sub-item"
              :class="{ active: route.path === sub.index }"
              @click="go(sub.index)"
            >
              <span v-if="sub.icon" class="ic">{{ sub.icon }}</span><span v-else class="dot"></span>
              <span>{{ sub.label }}</span>
            </button>
          </div>
        </div>

        <!-- 关于 FlowX（右侧页面，与左侧菜单其它系统页一致） -->
        <button class="nav-item" :data-tip="'关于'" :class="{ active: route.path === '/about' }" @click="go('/about')">
          <span class="ic">ℹ️</span>
          <span class="label">关于</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <div class="side-user">
          <span class="side-avatar">A</span>
          <span class="side-user-name">管理员</span>
        </div>
        <div class="side-ver">v{{ version || '0.1.0' }}</div>
        <button
          class="collapse-toggle"
          type="button"
          :title="collapsed ? '展开菜单' : '收起菜单'"
          :aria-label="collapsed ? '展开菜单' : '收起菜单'"
          @click="toggleCollapsed"
        >
          <span class="tg-ic">{{ collapsed ? '»' : '«' }}</span>
          <span class="tg-label">{{ collapsed ? '展开菜单' : '收起菜单' }}</span>
        </button>
      </div>
    </aside>

    <!-- ============ 内容区 ============ -->
    <div class="content">
      <!-- 顶部任务选项卡栏 + 按 tabId 实例渲染（状态保持核心） -->
      <WorkspaceTabBar />
      <WorkspaceView />
    </div>

    <!-- 自定义窗口边缘缩放热区（frame:false 后替代 OS 原生边框缩放） -->
    <WindowResizeFrame />

    <!-- 收起态：父级菜单悬浮飞出子面板 -->
    <div
      class="flyout"
      :class="{ show: flyout.show }"
      :style="{ left: flyout.x + 'px', top: flyout.y + 'px' }"
      @mouseenter="onFlyoutEnter"
      @mouseleave="onFlyoutLeave"
    >
      <div class="fly-title">{{ flyout.label }}</div>
      <button
        v-for="sub in flyout.subs"
        :key="sub.index"
        class="nav-sub-item"
        :class="{ active: route.path === sub.index }"
        @click="navigateFromFlyout(sub.index)"
      >
        <span v-if="sub.icon" class="ic">{{ sub.icon }}</span><span v-else class="dot"></span>
        <span>{{ sub.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { electronApi } from './utils/electron';
import { useWorkspaceStore } from './stores/workspace';
import WorkspaceTabBar from './components/WorkspaceTabBar.vue';
import WorkspaceView from './components/WorkspaceView.vue';
import WindowResizeFrame from './components/WindowResizeFrame.vue';

const route = useRoute();
const router = useRouter();
const version = ref<string>('');
const settingsOpen = ref(true);
const tabStore = useWorkspaceStore();

// 侧栏收起状态（持久化到 localStorage，刷新后保留偏好）
const SIDEBAR_COLLAPSED_KEY = 'flowx:sidebar-collapsed';
const collapsed = ref(false);

// 收起态：父级菜单悬浮飞出子面板
interface FlyoutState {
  show: boolean;
  label: string;
  subs: NavSubItem[];
  x: number;
  y: number;
}
const flyout = ref<FlyoutState>({ show: false, label: '', subs: [], x: 0, y: 0 });
const flyoutPinned = ref(false);
let flyoutHideTimer: number | undefined;

function showParentFlyout(ev: MouseEvent, group: 'workbench' | 'pub' | 'settings') {
  const g = parentGroups[group];
  const el = ev.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  flyout.value = {
    show: true,
    label: g.label,
    subs: g.subs,
    x: r.right + 12,
    y: Math.max(8, r.top - 6),
  };
}
function onParentEnter(group: 'workbench' | 'pub' | 'settings', ev: MouseEvent) {
  if (!collapsed.value) return;
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
  showParentFlyout(ev, group);
}
function onParentLeave() {
  if (flyoutPinned.value) return;
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
  flyoutHideTimer = window.setTimeout(() => {
    flyout.value = { ...flyout.value, show: false };
  }, 140);
}
function onFlyoutEnter() {
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
}
function onFlyoutLeave() {
  if (flyoutPinned.value) return;
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
  flyoutHideTimer = window.setTimeout(() => {
    flyout.value = { ...flyout.value, show: false };
  }, 140);
}
function onParentClick(group: 'workbench' | 'pub' | 'settings', ev: MouseEvent) {
  if (collapsed.value) {
    // 收起态：点击父级 = 钉住/取消飞出面板
    if (flyoutPinned.value && flyout.value.label === parentGroups[group].label) {
      flyoutPinned.value = false;
      flyout.value = { ...flyout.value, show: false };
    } else {
      flyoutPinned.value = true;
      showParentFlyout(ev, group);
    }
  } else {
    // 展开态：保持原有内联展开/收起行为
    if (group === 'workbench') toggleWorkbench();
    else if (group === 'pub') togglePub();
    else toggleSettings();
  }
}
function navigateFromFlyout(index: string) {
  flyoutPinned.value = false;
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
  flyout.value = { ...flyout.value, show: false };
  go(index);
}
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed.value ? '1' : '0');
  } catch {
    /* localStorage 不可用时静默降级 */
  }
  // 收起/展开时复位飞出面板
  flyoutPinned.value = false;
  if (flyoutHideTimer) window.clearTimeout(flyoutHideTimer);
  flyout.value = { ...flyout.value, show: false };
}

const primaryNav = [
  { index: '/dashboard', label: '仪表盘', icon: '🏠' },
  { index: '/accounts', label: '账号管理', icon: '👤' },
];

// 二级菜单项（icon 可选：一键发布对齐原型带 emoji 图标，系统配置留空用圆点）
interface NavSubItem { index: string; label: string; icon?: string }

// 一键发布：可展开二级菜单
const publishNav: NavSubItem[] = [
  { index: '/publish/video', label: '发布视频', icon: '🎬' },
  { index: '/publish/image', label: '发布图文', icon: '🖼️' },
  { index: '/publish/article', label: '发布文章', icon: '📄' },
  { index: '/publish/history', label: '发布历史', icon: '🕘' },
];
const pubOpen = ref(true);

const settingsNav: NavSubItem[] = [
  { index: '/settings/environments', label: '环境配置', icon: '🌍' },
  { index: '/settings/proxies', label: '代理 IP 设置', icon: '🔀' },
  { index: '/settings/api', label: '对外接口', icon: '🔌' },
  { index: '/settings/logs', label: '日志管理', icon: '📜' },
  { index: '/settings/rules', label: '提取规则', icon: '📋' },
];

// 工作台：可展开二级菜单（草稿准备 + 平台浏览）
const workbenchNav: NavSubItem[] = [
  { index: '/drafts', label: '草稿箱', icon: '📝' },
  { index: '/browser', label: '浏览器', icon: '🌐' },
];
const workbenchOpen = ref(true);

// 收起态父级 → 飞出子面板的数据映射（定义在导航数组之后，避免 TDZ）
const parentGroups: Record<'workbench' | 'pub' | 'settings', { label: string; subs: NavSubItem[] }> = {
  workbench: { label: '工作台', subs: workbenchNav },
  pub: { label: '一键发布', subs: publishNav },
  settings: { label: '系统配置', subs: settingsNav },
};

const isPubActive = computed(() => route.path.startsWith('/publish'));
const isSettingsActive = computed(() => route.path.startsWith('/settings'));
const isWorkbenchActive = computed(() => route.path === '/drafts' || route.path === '/browser');

function go(index: string) {
  if (index.startsWith('/publish')) pubOpen.value = true;
  if (index.startsWith('/settings')) settingsOpen.value = true;
  if (index === '/drafts' || index === '/browser') workbenchOpen.value = true;
  // URL 同步（深链/高亮）+ 任务 tab 开/激活
  router.push(index);
  const ok = tabStore.openSystemTab(index);
  if (!ok) ElMessage.warning(`任务页签已达上限（${tabStore.MAX}）`);
}
function togglePub() {
  pubOpen.value = !pubOpen.value;
}
function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
}
function toggleWorkbench() {
  workbenchOpen.value = !workbenchOpen.value;
}

onMounted(async () => {
  // 恢复侧栏收起偏好
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') collapsed.value = true;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  // 不再恢复上次的选项卡状态；每次启动只开默认仪表盘
  tabStore.ensureDefault();
  try {
    const info = await electronApi.getSystemInfo();
    version.value = info.version;
  } catch {
    version.value = '0.1.0';
  }
});

// 不再自动保存/恢复任务选项卡状态（用户要求完全去掉自动恢复）
</script>
