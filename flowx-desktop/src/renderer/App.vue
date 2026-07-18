<template>
  <div class="app-container">
    <header class="app-header">
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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
