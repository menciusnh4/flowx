<template>
  <div class="dash">
    <!-- 欢迎横幅 -->
    <section class="welcome">
      <div class="welcome-text">
        <h1>欢迎回来 👋</h1>
        <p>用 FlowX 把一条内容，轻松分发到所有平台。</p>
      </div>
      <el-button type="primary" size="large" round @click="go('/publish/video')">
        <el-icon><Promotion /></el-icon>&nbsp; 开始一键发布
      </el-button>
    </section>

    <!-- 指标卡 -->
    <section class="stats">
      <div class="stat-card" v-for="s in stats" :key="s.label">
        <div class="stat-ic" :style="{ background: s.bg }">{{ s.icon }}</div>
        <div class="stat-meta">
          <div class="stat-value">{{ s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </div>
      </div>
    </section>

    <!-- 快捷操作 -->
    <section class="panel">
      <h2 class="section-title">快速开始</h2>
      <div class="quick">
        <button class="quick-card" @click="go('/accounts')">
          <span class="quick-ic">👤</span>
          <span class="quick-t">管理账号</span>
          <span class="quick-s">授权与维护你的平台账号</span>
        </button>
        <button class="quick-card" @click="go('/publish/video')">
          <span class="quick-ic">🚀</span>
          <span class="quick-t">新建发布任务</span>
          <span class="quick-s">图文 / 视频 / 文章一键分发</span>
        </button>
        <button class="quick-card" @click="go('/browser')">
          <span class="quick-ic">🌐</span>
          <span class="quick-t">浏览器提取</span>
          <span class="quick-s">从网页一键抓取正文与配图</span>
        </button>
        <button class="quick-card" @click="go('/publish/history')">
          <span class="quick-ic">🕘</span>
          <span class="quick-t">查看历史</span>
          <span class="quick-s">追踪每次发布的结果</span>
        </button>
      </div>
    </section>

    <!-- 平台生态 -->
    <section class="panel">
      <h2 class="section-title">支持的平台</h2>
      <div class="platforms">
        <div class="platform-card" v-for="p in accountStore.platforms" :key="p.key">
          <div class="platform-icon-wrap">
            <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-icon" />
          </div>
          <div class="platform-name">{{ p.name }}</div>
          <div class="platform-count">{{ accountStore.byPlatform(p.key).length }} 个账号</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAccountStore } from '../stores/account';
import { usePublishStore } from '../stores/publish';
import iconXiaohongshu from '../assets/xiaohongshu.svg';
import iconDouyin from '../assets/douyin.svg';
import iconKuaishou from '../assets/kuaishou.svg';
import iconBilibili from '../assets/bilibili.svg';
import iconWechatChannels from '../assets/wechat_channels.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';

const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu: iconXiaohongshu,
  douyin: iconDouyin,
  kuaishou: iconKuaishou,
  bilibili: iconBilibili,
  wechat_channels: iconWechatChannels,
  weibo: iconWeibo,
  zhihu: iconZhihu,
  toutiao: iconToutiao,
};

function getPlatformIcon(p: string): string {
  return PLATFORM_ICONS[p] || '';
}

const router = useRouter();
const accountStore = useAccountStore();
const publishStore = usePublishStore();

function go(path: string) {
  router.push(path);
}

const stats = computed(() => [
  { icon: '👤', label: '已授权账号', value: accountStore.accounts.length, bg: 'rgba(99,102,241,.12)' },
  { icon: '⚡', label: '活跃账号', value: accountStore.activeAccounts.length, bg: 'rgba(56,189,248,.14)' },
  { icon: '📊', label: '历史发布', value: publishStore.stats.total, bg: 'rgba(16,185,129,.12)' },
  { icon: '✅', label: '今日成功', value: publishStore.stats.todaySuccess, bg: 'rgba(245,158,11,.14)' },
]);

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadStats();
});
</script>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 欢迎横幅 */
.welcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 26px;
  border-radius: var(--r-lg);
  background: var(--brand-grad);
  color: #fff;
  box-shadow: var(--shadow-md);
}
.welcome h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.welcome p {
  margin: 6px 0 0;
  font-size: 13.5px;
  opacity: 0.9;
}
.welcome :deep(.el-button) {
  --el-button-bg-color: #fff;
  --el-button-text-color: var(--brand-indigo);
  --el-button-hover-bg-color: #f5f6ff;
  --el-button-hover-text-color: var(--brand-indigo);
  font-weight: 700;
}

/* 指标卡 */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}
.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-xs);
  transition: box-shadow var(--t), transform var(--t) var(--ease);
}
.stat-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.stat-ic {
  width: 46px;
  height: 46px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}
.stat-value {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--ink);
}
.stat-label {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 2px;
}

/* 快捷操作 */
.quick {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
.quick-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 16px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: all var(--t) var(--ease);
  font-family: inherit;
}
.quick-card:hover {
  border-color: var(--brand-indigo);
  background: var(--brand-grad-soft);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.quick-ic {
  font-size: 22px;
}
.quick-t {
  font-weight: 700;
  color: var(--ink);
  font-size: 14px;
}
.quick-s {
  font-size: 12px;
  color: var(--muted);
}

/* 平台网格 */
.platforms {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 14px;
}
.platform-card {
  text-align: center;
  padding: 16px 10px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--line);
  transition: all var(--t) var(--ease);
}
.platform-card:hover {
  border-color: var(--brand-indigo);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.platform-icon-wrap {
  width: 46px;
  height: 46px;
  margin: 0 auto;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--line);
}
.platform-icon {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.platform-name {
  font-weight: 600;
  margin-top: 10px;
  color: var(--ink);
  font-size: 13.5px;
}
.platform-count {
  color: var(--muted);
  font-size: 12px;
  margin-top: 3px;
}

@media (max-width: 1100px) {
  .stats,
  .quick {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
