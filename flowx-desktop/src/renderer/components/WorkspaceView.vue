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

// 浏览器 tab 需要边缘到边缘铺满（原生 WebContentsView 不受 24px padding 约束），
// 且其 flex 子项依赖父级有确定 height 才能正确解析 height:100%。
// 其它系统 tab 保留 padding + min-height（内容可滚动）。
const isBrowserActive = computed(() => store.activeTab?.route === '/browser');

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

    <!-- 系统层：带内边距（使用 v-show 常驻渲染，防组件反复重载状态丢失与 WebContentsView 泄漏遮挡） -->
    <!-- 浏览器 tab 去除 padding，边缘到边缘铺满 -->
    <div v-show="!activeIsAccount" class="ws-system-layer" :class="{ 'no-padding': isBrowserActive }">
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
.ws-system-layer.no-padding {
  padding: 0;
}
.ws-pane {
  /* height:100% 给浏览器等依赖 flex 高度链的页面提供确定高度基线；
     内容超出时由 .ws-system-layer 的 overflow-y:auto 滚动，不影响其它页面 */
  height: 100%;
  min-height: 100%;
}
</style>
