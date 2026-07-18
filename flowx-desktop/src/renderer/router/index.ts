import { createRouter, createWebHashHistory, RouteRecordRaw } from 'vue-router';

// 直接使用 dynamic import，不再用 defineAsyncComponent 包一层
// （defineAsyncComponent 用于普通组件；路由本身已经是懒加载机制，
//  双套一层会导致 Vue Router 警告并影响加载状态提示）
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: () => import('@/pages/Dashboard.vue'), meta: { title: '仪表盘' } },
  { path: '/accounts', name: 'accounts', component: () => import('@/pages/AccountPanel.vue'), meta: { title: '账号管理' } },
  { path: '/publish', name: 'publish', component: () => import('@/pages/Publish.vue'), meta: { title: '一键发布' } },
  { path: '/drafts', name: 'drafts', component: () => import('@/pages/DraftBox.vue'), meta: { title: '草稿箱' } },
  { path: '/browser', name: 'browser', component: () => import('@/pages/Browser.vue'), meta: { title: '浏览器' } },
  { path: '/history', name: 'history', component: () => import('@/pages/History.vue'), meta: { title: '发布历史' } },
  { path: '/settings/environments', name: 'environments', component: () => import('@/pages/BrowserEnvPanel.vue'), meta: { title: '环境配置' } },
  { path: '/settings/proxies', name: 'proxies', component: () => import('@/pages/ProxyPanel.vue'), meta: { title: '代理 IP 设置' } },
  { path: '/settings/rules', name: 'rules', component: () => import('@/pages/RulesPanel.vue'), meta: { title: '提取规则' } },
  { path: '/settings/api', name: 'api', component: () => import('@/pages/ApiPanel.vue'), meta: { title: '对外接口' } },
  { path: '/settings/logs', name: 'logs', component: () => import('@/pages/LogPanel.vue'), meta: { title: '日志管理' } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to, _from, next) => {
  if (to.meta?.title) {
    document.title = `${to.meta.title as string} - FlowX`;
  }
  next();
});
