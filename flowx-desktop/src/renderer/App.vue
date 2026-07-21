<template>
  <div class="app-container" :class="{ 'no-header': hideHeader }">
    <header v-if="!hideHeader" class="app-header">
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
        <!-- 系统配置：使用原生菜单，避免 WebContentsView 遮挡 HTML 下拉 -->
        <div class="native-menu-trigger" @click.stop="openSettingsMenu">
          <el-icon><Setting /></el-icon>
          <span>系统配置</span>
          <el-icon class="el-icon--right"><arrow-down /></el-icon>
        </div>
        <el-menu-item index="/about" @click="openAboutWindow">
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { electronApi } from './utils/electron';

const route = useRoute();
const router = useRouter();
const version = ref<string>('');

const activeMenu = computed(() => route.path);
const hideHeader = computed(() => !!route.meta?.hideHeader);

function onMenuSelect(idx: string) {
  // /about 不跳转路由，打开独立窗口
  if (idx === '/about') return;
  router.push(idx);
}

// 打开系统配置原生菜单（避免 WebContentsView 遮挡 HTML 下拉）
async function openSettingsMenu(e: MouseEvent) {
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();

  const menuItems = [
    { id: '/settings/environments', label: '环境配置' },
    { id: '/settings/proxies', label: '代理 IP 设置' },
    { id: '/settings/rules', label: '提取规则' },
    { id: '/settings/api', label: '对外接口' },
    { id: '/settings/logs', label: '日志管理' },
  ];

  try {
    console.log('[App.vue] 弹出原生菜单, x:', rect.left, 'y:', rect.bottom);
    const selectedId = await electronApi.popupNativeMenu(
      menuItems,
      Math.round(rect.left),
      Math.round(rect.bottom),
    );
    console.log('[App.vue] 原生菜单选中:', selectedId);
    if (selectedId) {
      router.push(selectedId);
    }
  } catch (err) {
    console.error('[App.vue] 弹出原生菜单失败', err);
  }
}

// 打开关于窗口（独立 BrowserWindow，避免 WebContentsView 遮挡）
async function openAboutWindow() {
  try {
    await electronApi.openAboutWindow();
  } catch (err) {
    console.error('[App.vue] 打开关于窗口失败', err);
  }
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

/* 原生菜单触发器样式 - 模拟 el-menu-item */
.native-menu-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 20px;
  font-size: 14px;
  color: #606266;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.2s;
}
.native-menu-trigger:hover {
  color: #409eff;
}
.native-menu-trigger .el-icon--right {
  margin-left: 2px;
  font-size: 12px;
}

/* 无 header 模式（关于窗口等独立窗口使用） */
.no-header .app-main {
  padding: 0;
}
</style>
