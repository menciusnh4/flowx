<template>
  <div class="app-container">
    <!-- 左侧极简磨砂侧边栏 -->
    <aside class="app-sidebar">
      <div class="sidebar-logo">
        <svg class="logo-icon-img" width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="logo-bg-grad" x1="0" y1="0" x2="38" y2="38" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#6366f1" />
              <stop offset="100%" stop-color="#3b82f6" />
            </linearGradient>
            <filter id="logo-text-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="1" flood-color="#000000" flood-opacity="0.12" />
            </filter>
          </defs>
          <rect width="38" height="38" rx="11" fill="url(#logo-bg-grad)" />
          <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#FFFFFF" font-size="14" font-weight="900" font-family="system-ui, -apple-system, sans-serif" letter-spacing="-0.03em" filter="url(#logo-text-shadow)">FX</text>
        </svg>
        <div class="logo-text-wrapper">
          <div class="logo-main">
            <span class="logo-text">FlowX</span>
          </div>
          <div class="logo-sub">多平台内容发布助手</div>
        </div>
      </div>
      
      <el-menu
        mode="vertical"
        :default-active="activeMenu"
        @select="onMenuSelect"
        :router="false"
        class="sidebar-menu"
      >
        <el-menu-item index="/dashboard">
          <div class="menu-icon-circle"><el-icon><House /></el-icon></div>
          <span>仪表盘</span>
        </el-menu-item>
        
        <el-menu-item index="/accounts">
          <div class="menu-icon-circle"><el-icon><UserFilled /></el-icon></div>
          <span>账号管理</span>
        </el-menu-item>
        
        <el-menu-item index="/publish">
          <div class="menu-icon-circle"><el-icon><Promotion /></el-icon></div>
          <span>一键发布</span>
        </el-menu-item>
        <el-menu-item index="/drafts">
          <div class="menu-icon-circle"><el-icon><Document /></el-icon></div>
          <span>草稿箱</span>
        </el-menu-item>
        <el-menu-item index="/browser">
          <div class="menu-icon-circle"><el-icon><Monitor /></el-icon></div>
          <span>浏览器</span>
        </el-menu-item>
        
        <el-menu-item index="/history">
          <div class="menu-icon-circle"><el-icon><Clock /></el-icon></div>
          <span>发布历史</span>
        </el-menu-item>
        
        <el-sub-menu index="/settings">
          <template #title>
            <div class="menu-icon-circle"><el-icon><Setting /></el-icon></div>
            <span>系统配置</span>
          </template>
          <el-menu-item index="/settings/environments">
            <span class="sub-menu-dot">•</span>
            <span>环境配置</span>
          </el-menu-item>
          <el-menu-item index="/settings/proxies">
            <span class="sub-menu-dot">•</span>
            <span>代理 IP 设置</span>
          </el-menu-item>
          <el-menu-item index="/settings/api">
            <span class="sub-menu-dot">•</span>
            <span>对外接口</span>
          </el-menu-item>
          <el-menu-item index="/settings/logs">
            <span class="sub-menu-dot">•</span>
            <span>日志管理</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>

      <div class="sidebar-footer">
        <el-icon class="version-icon"><InfoFilled /></el-icon>
        <span>v{{ version || '0.1.0' }}</span>
      </div>
    </aside>

    <!-- 右侧内容主视口 -->
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="slide-fade" mode="out-in">
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

const activeMenu = computed(() => {
  return route.path;
});

function onMenuSelect(idx: string) {
  router.push(idx);
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
.app-sidebar {
  width: 220px;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  border-right: 1px solid rgba(0, 0, 0, 0.05);
  display: flex;
  flex-direction: column;
  height: 100vh;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 24px 12px 16px 12px;
  z-index: 10;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 10px;
  margin-bottom: 32px;
  user-select: none;
}

.logo-icon-img {
  filter: drop-shadow(0 4px 10px rgba(99, 102, 241, 0.28));
  flex-shrink: 0;
}

.logo-text-wrapper {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.logo-main {
  display: flex;
  align-items: baseline;
}

.logo-sub {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.logo-text {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #1e293b;
}

.sidebar-menu {
  border-right: none !important;
  background: transparent !important;
  flex: 1;
}

:deep(.el-menu-item),
:deep(.el-sub-menu__title) {
  height: 50px !important;
  line-height: 50px !important;
  margin-bottom: 8px;
  border-radius: 25px !important; /* 全圆角胶囊状 */
  color: #1e293b !important;
  font-weight: 700;
  font-size: 14px;
  background: transparent !important;
  border: 1px solid transparent;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px !important;
}

/* 菜单图标外层圆形容器 */
.menu-icon-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #ffffff;
  border: 1px solid transparent;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.menu-icon-circle :deep(.el-icon) {
  margin: 0 !important;
  font-size: 16px;
  color: #475569;
  transition: color 0.3s ease;
}

/* 一级导航 Hover */
:deep(.el-menu-item:hover),
:deep(.el-sub-menu__title:hover) {
  background: rgba(99, 102, 241, 0.03) !important;
  border-color: rgba(99, 102, 241, 0.06);
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.02);
  color: #6366f1 !important;
}

:deep(.el-menu-item:hover) .menu-icon-circle :deep(.el-icon),
:deep(.el-sub-menu__title:hover) .menu-icon-circle :deep(.el-icon) {
  color: #6366f1;
}

:deep(.el-menu-item:hover) .menu-icon-circle,
:deep(.el-sub-menu__title:hover) .menu-icon-circle {
  background: #ffffff;
}

/* 一级导航 Active 状态 */
:deep(.el-menu-item.is-active) {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.16) 0%, rgba(56, 189, 248, 0.08) 100%) !important;
  color: #6366f1 !important;
  border: 1px solid transparent !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.03) !important;
  padding-left: 16px !important;
}

:deep(.el-menu-item.is-active) .menu-icon-circle {
  background: rgba(99, 102, 241, 0.16) !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

:deep(.el-menu-item.is-active) .menu-icon-circle :deep(.el-icon) {
  color: #6366f1 !important;
  font-size: 16px !important;
}

/* 系统配置被激活时的样式重置（防止其在二级项选中时显示选中状态） */
:deep(.el-sub-menu.is-active .el-sub-menu__title) {
  color: #1e293b !important;
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

:deep(.el-sub-menu.is-active .el-sub-menu__title) .menu-icon-circle {
  background: #ffffff !important;
  border-color: rgba(0, 0, 0, 0.04) !important;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02) !important;
}

:deep(.el-sub-menu.is-active .el-sub-menu__title) .menu-icon-circle :deep(.el-icon) {
  color: #475569 !important;
}

/* 二级子菜单样式 */
:deep(.el-sub-menu .el-menu-item) {
  height: 44px !important;
  line-height: 44px !important;
  padding-left: 36px !important; /* 二级菜单缩进 */
  font-weight: 600;
  font-size: 13px;
  color: #64748b !important;
  background: transparent !important;
  border: 1px solid transparent !important;
  box-shadow: none !important;
  border-radius: 22px !important; /* 胶囊圆角 */
  margin-bottom: 4px;
}

/* 二级菜单 Hover */
:deep(.el-sub-menu .el-menu-item:hover) {
  background: rgba(99, 102, 241, 0.03) !important;
  border-color: rgba(99, 102, 241, 0.05) !important;
  color: #6366f1 !important;
}

/* 二级子菜单 Active 状态 */
:deep(.el-sub-menu .el-menu-item.is-active) {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.16) 0%, rgba(56, 189, 248, 0.08) 100%) !important;
  border-color: transparent !important;
  color: #6366f1 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.03) !important;
  padding-left: 36px !important;
}

.sub-menu-dot {
  margin-right: 12px;
  font-size: 16px;
  color: #cbd5e1; /* 默认灰色点 */
  display: inline-block;
  transition: all 0.25s ease;
  line-height: 1;
}

:deep(.el-sub-menu .el-menu-item:hover) .sub-menu-dot {
  color: #64748b;
}

:deep(.el-sub-menu .el-menu-item.is-active) .sub-menu-dot {
  color: #6366f1; /* 激活蓝色点 */
  transform: scale(1.2);
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
  display: flex;
  align-items: center;
  gap: 8px;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 500;
}

.version-icon {
  font-size: 14px;
}

/* 优雅平滑的页面切换过渡动效 */
.slide-fade-enter-active {
  transition: all 0.25s ease-out;
}
.slide-fade-leave-active {
  transition: all 0.2s ease-in;
}
.slide-fade-enter-from {
  transform: translateY(8px);
  opacity: 0;
}
.slide-fade-leave-to {
  transform: translateY(-8px);
  opacity: 0;
}
</style>
