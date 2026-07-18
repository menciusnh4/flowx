<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, type Component } from 'vue';
import { routeComponentMap } from '../router';
import { useWorkspaceStore } from '../stores/workspace';
import AccountWorkspace from './AccountWorkspace.vue';

const store = useWorkspaceStore();

/** 按 route 解析并缓存组件（与 <router-view> 解耦，确保每个 tab 独立实例） */
const componentCache: Record<string, Component> = {};
function getComponent(route: string): Component {
  if (!componentCache[route]) {
    const loader = routeComponentMap[route] as any;
    componentCache[route] = markRaw(defineAsyncComponent(loader));
  }
  return componentCache[route];
}

const activeIsAccount = computed(() => store.activeTab?.kind === 'account');

// 账号层用 v-show 常驻（见模板），切换 tab 仅切换可见性、webview 保活；
// 显隐/多账号不再需要主进程原生层调度（WebContentsView 已迁移为 <webview>）。
</script>

<template>
  <div class="ws-wrap">
    <!-- 账号层：边缘到边缘（原生 WebContentsView 叠在占位区之上） -->
    <template v-for="t in store.accountTabs" :key="t.id">
      <div v-show="t.id === store.activeId" class="ws-account-pane">
        <AccountWorkspace :tab="t" />
      </div>
    </template>

    <!-- 系统层：带内边距（仅系统 tab 激活时渲染，避免覆盖账号层） -->
    <div v-if="!activeIsAccount" class="ws-system-layer">
      <template v-for="t in store.systemTabs" :key="t.id">
        <div v-show="t.id === store.activeId" class="ws-pane">
          <component :is="t.route ? getComponent(t.route) : null" v-bind="t.props || {}" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ws-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}
.ws-account-pane {
  position: absolute;
  inset: 0;
}
.ws-system-layer {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px;
  background: var(--bg);
}
.ws-pane {
  min-height: 100%;
}
</style>
