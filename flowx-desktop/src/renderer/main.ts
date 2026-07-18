import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

import App from './App.vue';
import { router } from './router';

// 本地自托管字体（@fontsource）：运行时零网络、不受 CSP 约束，避免 Google Fonts 外网不可靠导致整页白屏
import '@fontsource/baloo-2/500.css';
import '@fontsource/baloo-2/600.css';
import '@fontsource/baloo-2/700.css';
import '@fontsource/baloo-2/800.css';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './assets/styles.css';

const app = createApp(App);

// 注册全部 Element Plus 图标（按需也可改为注册部分）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as any);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus);

app.mount('#app');
