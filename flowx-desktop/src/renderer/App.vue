<template>
  <div class="app-shell">
    <!-- ============ 左侧竖栏导航 ============ -->
    <aside class="sidebar">
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
          @click="go(item.index)"
        >
          <span class="ic">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </button>

        <!-- 工作台：可展开二级菜单（草稿准备 + 平台浏览） -->
        <button
          class="nav-item"
          :class="{ active: isWorkbenchActive, expanded: workbenchOpen }"
          @click="toggleWorkbench"
        >
          <span class="ic">🧰</span>
          <span>工作台</span>
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
          class="nav-item"
          :class="{ active: isPubActive, expanded: pubOpen }"
          @click="togglePub"
        >
          <span class="ic">🚀</span>
          <span>一键发布</span>
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
          class="nav-item"
          :class="{ active: isSettingsActive, expanded: settingsOpen }"
          @click="toggleSettings"
        >
          <span class="ic">⚙️</span>
          <span>系统配置</span>
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
        <button class="nav-item" :class="{ active: route.path === '/about' }" @click="go('/about')">
          <span class="ic">ℹ️</span>
          <span>关于</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <div class="side-user">
          <span class="side-avatar">A</span>
          <span class="side-user-name">管理员</span>
        </div>
        <div class="side-ver">v{{ version || '0.1.0' }}</div>
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
