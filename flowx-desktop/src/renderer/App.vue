<template>
  <div class="app-container">
    <header class="app-header" @mouseenter="handleHeaderMouseEnter" @mouseleave="handleHeaderMouseLeave">
      <div class="app-logo">
        FlowX<small>多平台内容发布助手</small>
      </div>
      <el-menu
        mode="horizontal"
        :default-active="activeMenu"
        @select="onMenuSelect"
        :router="false"
        :ellipsis="false"
      >
        <el-menu-item index="/dashboard">
          <el-icon><House /></el-icon>
          <span>仪表盘</span>
        </el-menu-item>
        <el-menu-item index="/accounts">
          <el-icon><UserFilled /></el-icon>
          <span>账号管理</span>
        </el-menu-item>
        <el-menu-item index="/publish">
          <el-icon><Promotion /></el-icon>
          <span>一键发布</span>
        </el-menu-item>
        <el-menu-item index="/drafts">
          <el-icon><Document /></el-icon>
          <span>草稿箱</span>
        </el-menu-item>
        <el-menu-item index="/browser">
          <el-icon><Monitor /></el-icon>
          <span>浏览器</span>
        </el-menu-item>
        <el-menu-item index="/history">
          <el-icon><Clock /></el-icon>
          <span>发布历史</span>
        </el-menu-item>
        <el-sub-menu index="/settings">
          <template #title>
            <el-icon><Setting /></el-icon>
            <span>系统配置</span>
          </template>
          <el-menu-item index="/settings/environments">环境配置</el-menu-item>
          <el-menu-item index="/settings/proxies">代理 IP 设置</el-menu-item>
          <el-menu-item index="/settings/rules">提取规则</el-menu-item>
          <el-menu-item index="/settings/api">对外接口</el-menu-item>
          <el-menu-item index="/settings/logs">日志管理</el-menu-item>
        </el-sub-menu>
        <el-menu-item index="/about" @click="openAboutDialog">
          <el-icon><InfoFilled /></el-icon>
          <span>关于</span>
        </el-menu-item>
      </el-menu>
      <div style="font-size: 12px; color: #909399">
        v{{ version || '0.1.0' }}
      </div>
    </header>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- 关于对话框 -->
    <el-dialog
      v-model="aboutDialogVisible"
      title="关于 FlowX"
      width="680px"
      :close-on-click-modal="false"
      class="about-dialog"
    >
      <div class="about-content">
        <div class="about-header">
          <div class="about-logo">
            <el-icon :size="48" color="#409eff"><Promotion /></el-icon>
          </div>
          <div class="about-info">
            <h2>FlowX Desktop</h2>
            <p class="about-subtitle">多平台内容发布工具</p>
            <p class="about-version">版本：v{{ version || '0.1.0' }}</p>
          </div>
        </div>

        <div class="about-desc">
          <p>
            FlowX 是一款基于 Electron 的跨平台桌面客户端，旨在帮助内容创作者高效管理多平台账号，
            一键发布内容到多个平台，省去重复登录和重复发布的繁琐流程。
          </p>
          <p>支持抖音、小红书、快手、微信视频号、知乎、今日头条等主流内容平台。</p>
        </div>

        <el-tabs v-model="aboutActiveTab" class="about-tabs">
          <el-tab-pane label="功能特性" name="features">
            <div class="feature-list">
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>多账号管理，独立 session，互不影响</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>一键发布，多平台同步完成</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>定时发布，重启自动恢复调度</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>指纹 UA 与代理 IP 隔离，防关联</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>内置浏览器，一键提取网页内容</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>自定义站点规则，可视化元素拾取</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>测试发布模式，降低误发风险</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>本地加密存储，保障账号安全</span>
              </div>
              <div class="feature-item">
                <el-icon color="#67c23a"><CircleCheck /></el-icon>
                <span>对外 API 接口，支持第三方集成</span>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="更新日志" name="changelog">
            <div class="changelog-content" v-html="changelogHtml"></div>
          </el-tab-pane>
        </el-tabs>
      </div>

      <template #footer>
        <el-button @click="aboutDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { electronApi } from './utils/electron';
import { useUiStore } from './stores/ui';

const route = useRoute();
const router = useRouter();
const uiStore = useUiStore();
const version = ref<string>('');
const aboutDialogVisible = ref(false);
const aboutActiveTab = ref('features');
const changelogHtml = ref('');

const activeMenu = computed(() => route.path);

function onMenuSelect(idx: string) {
  // /about 不跳转路由，直接打开对话框
  if (idx === '/about') return;
  router.push(idx);
}

// 顶部导航栏鼠标进入/离开时，更新全局弹层计数
// 因为 horizontal 模式下 el-sub-menu 是 hover 触发的，visible-change 事件不可靠
// 用 header 的 mouseenter/mouseleave 更可靠：鼠标在顶部区域时，隐藏浏览器视图
let headerHoverTimer: ReturnType<typeof setTimeout> | null = null

function handleHeaderMouseEnter() {
  if (headerHoverTimer) {
    clearTimeout(headerHoverTimer)
    headerHoverTimer = null
  }
  // 立即推入（鼠标进入顶部区域，可能要展开下拉菜单）
  uiStore.pushOverlay('header-hover')
}

function handleHeaderMouseLeave() {
  if (headerHoverTimer) {
    clearTimeout(headerHoverTimer)
  }
  // 延迟 300ms 再移除，给下拉菜单收起动画留时间，也防止鼠标快速滑过时闪烁
  headerHoverTimer = setTimeout(() => {
    uiStore.popOverlay('header-hover')
    headerHoverTimer = null
  }, 300)
}

// 系统配置子菜单展开/收起（兜底：如果 visible-change 能触发也加上）
// 注：horizontal 模式下主要靠 header hover 检测，此处保留用于兼容

// 打开关于对话框
function openAboutDialog() {
  aboutDialogVisible.value = true;
  // 加载 CHANGELOG
  loadChangelog();
}

// 监听关于对话框的显示/隐藏，更新全局弹层计数
watch(aboutDialogVisible, (visible) => {
  if (visible) {
    uiStore.pushOverlay('about-dialog');
  } else {
    uiStore.popOverlay('about-dialog');
  }
});

// 加载 CHANGELOG.md 内容
async function loadChangelog() {
  if (changelogHtml.value) return;
  try {
    const content = await electronApi.readChangelog();
    if (content) {
      // 简单的 Markdown 转 HTML（处理标题、列表、粗体等）
      changelogHtml.value = simpleMarkdownToHtml(content);
    }
  } catch (e) {
    changelogHtml.value = '<p style="color: #909399;">加载更新日志失败</p>';
  }
}

// 简易 Markdown 转 HTML
function simpleMarkdownToHtml(md: string): string {
  let html = md;
  // 转义 HTML
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 列表项
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  // 引用
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // 段落
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  // 包裹在容器中
  html = '<div class="md-content">' + html + '</div>';
  return html;
}

onMounted(async () => {
  try {
    const info = await electronApi.getSystemInfo();
    version.value = info.version;
  } catch {
    version.value = '0.1.0';
  }
});
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.about-content {
  padding: 0 10px;
}

.about-header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 16px;
}

.about-logo {
  width: 72px;
  height: 72px;
  background: #ecf5ff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.about-info h2 {
  margin: 0 0 4px 0;
  font-size: 22px;
  color: #303133;
}

.about-subtitle {
  margin: 0 0 4px 0;
  color: #606266;
  font-size: 14px;
}

.about-version {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.about-desc {
  color: #606266;
  font-size: 14px;
  line-height: 1.7;
  margin-bottom: 16px;
}

.about-desc p {
  margin: 0 0 8px 0;
}

.about-tabs {
  margin-top: 10px;
}

.feature-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 20px;
  padding: 10px 0;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #606266;
}

.changelog-content {
  max-height: 400px;
  overflow-y: auto;
  padding: 10px 4px;
  font-size: 14px;
  line-height: 1.7;
  color: #606266;
}

.changelog-content :deep(h1) {
  font-size: 20px;
  margin: 16px 0 12px 0;
  color: #303133;
}

.changelog-content :deep(h2) {
  font-size: 17px;
  margin: 14px 0 10px 0;
  color: #303133;
}

.changelog-content :deep(h3) {
  font-size: 15px;
  margin: 12px 0 8px 0;
  color: #303133;
}

.changelog-content :deep(li) {
  margin: 4px 0 4px 20px;
}

.changelog-content :deep(blockquote) {
  margin: 10px 0;
  padding: 8px 12px;
  background: #f5f7fa;
  border-left: 4px solid #409eff;
  color: #606266;
}

.changelog-content :deep(strong) {
  color: #303133;
}
</style>
