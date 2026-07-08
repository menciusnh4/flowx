<template>
  <div class="dashboard-container">
    <!-- 数据指标看板 -->
    <div class="panel header-panel">
      <h2 class="section-title">
        <el-icon class="title-icon"><DataLine /></el-icon>数据仪表盘
      </h2>
      <el-row :gutter="20">
        <el-col :span="6">
          <div class="stat-card card-indigo">
            <div class="stat-card-header">已授权账号</div>
            <div class="stat-card-content">
              <div class="stat-value-group">
                <span class="stat-value">{{ accountStore.accounts.length }}</span>
                <span class="stat-unit">全账号</span>
              </div>
              <div class="stat-icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-emerald">
            <div class="stat-card-header">活跃账号</div>
            <div class="stat-card-content">
              <div class="stat-value-group">
                <span class="stat-value">{{ accountStore.activeAccounts.length }}</span>
                <span class="stat-unit">个账号</span>
              </div>
              <div class="stat-icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </div>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-sky">
            <div class="stat-card-header">历史总发布</div>
            <div class="stat-card-content">
              <div class="stat-value-group">
                <span class="stat-value">{{ publishStore.stats.total }}</span>
                <span class="stat-unit">次</span>
              </div>
              <div class="stat-icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </div>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-orange">
            <div class="stat-card-header">今日成功数</div>
            <div class="stat-card-content">
              <div class="stat-value-group">
                <span class="stat-value">{{ publishStore.stats.todaySuccess }}</span>
                <span class="stat-unit">次</span>
              </div>
              <div class="stat-icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 快捷导航操作 -->
    <div class="panel quick-start-panel">
      <h2 class="section-title">
        <el-icon class="title-icon"><Guide /></el-icon>快捷导航
      </h2>
      <div class="quick-nav-grid">
        <div class="quick-nav-card card-purple-blue" @click="go('/accounts')">
          <div class="quick-nav-icon-wrap">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="16" x2="22" y1="11" y2="11"/></svg>
          </div>
          <div class="quick-nav-info">
            <div class="quick-nav-title">管理发布账号</div>
            <div class="quick-nav-desc">添加 / 编辑 / 管理账号</div>
          </div>
        </div>

        <div class="quick-nav-card card-green" @click="go('/publish')">
          <div class="quick-nav-icon-wrap">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </div>
          <div class="quick-nav-info">
            <div class="quick-nav-title">开启一键发布</div>
            <div class="quick-nav-desc">多平台内容一键发布</div>
          </div>
        </div>

        <div class="quick-nav-card card-white" @click="go('/history')">
          <div class="quick-nav-icon-wrap">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="quick-nav-info">
            <div class="quick-nav-title">浏览发布历史</div>
            <div class="quick-nav-desc">查看发布记录与状态</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 平台生态状态 -->
    <div class="panel platforms-panel">
      <h2 class="section-title">
        <el-icon class="title-icon"><Cpu /></el-icon>支持的自媒体平台
      </h2>
      <div class="platforms-grid">
        <div class="platform-card" :class="'hover-' + p.key" v-for="p in accountStore.platforms" :key="p.key">
          <div class="platform-icon-wrap" :class="'icon-' + p.key">
            <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-logo-img" />
            <span v-else class="platform-emoji">{{ p.icon }}</span>
          </div>
          <div class="platform-details">
            <span class="platform-name">{{ p.name }}</span>
            <span class="platform-count">已绑定：<strong class="highlight-count">{{ accountStore.byPlatform(p.key).length }}</strong> 个账号</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部小贴士 -->
    <div class="tips-banner">
      <div class="tips-left">
        <span class="tips-icon">🔔</span>
        <span class="tips-badge">小贴士</span>
        <span class="tips-text">绑定更多账号，可同时管理多个平台内容，提升发布效率。</span>
      </div>
      <div class="tips-right" @click="go('/accounts')">
        <span>了解更多</span>
        <div class="chevron-right-purple"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
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

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadStats();
});
</script>

<style scoped>
.dashboard-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.02);
  box-sizing: border-box;
}

.section-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 20px 0;
  color: #0f172a;
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  color: #6366f1;
  font-size: 16px;
}

/* ======== 数据卡片组 ======== */
.stat-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 20px 24px;
  height: 122px;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  background: #ffffff;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.015);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
}

.stat-card:hover {
  transform: translateY(-4px);
}

.stat-card-header {
  font-size: 12px;
  color: #64748b;
  font-weight: 600;
  letter-spacing: 0.01em;
  z-index: 2;
}

.stat-card-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  width: 100%;
  z-index: 2;
}

.stat-value-group {
  display: flex;
  align-items: flex-end;
  gap: 4px;
}

.stat-value {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 0.9;
}

.stat-unit {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 500;
  margin-bottom: 2px;
}

.stat-icon-wrapper {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
}

.stat-icon {
  width: 16px;
  height: 16px;
}

.stat-card:hover .stat-icon {
  transform: scale(1.1) rotate(5deg);
}

/* 统计卡片：Indigo (已授权账号) */
.card-indigo {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, #ffffff 100%);
  border-color: rgba(99, 102, 241, 0.12);
}
.card-indigo .stat-value { color: #6366f1; }
.card-indigo .stat-icon-wrapper { background: rgba(99, 102, 241, 0.08); color: #6366f1; }
.card-indigo::after {
  content: '';
  position: absolute;
  right: -25px;
  bottom: -35px;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.06) 0%, transparent 70%);
  z-index: 1;
}
.card-indigo:hover {
  border-color: rgba(99, 102, 241, 0.25);
  box-shadow: 0 12px 28px -4px rgba(99, 102, 241, 0.1), 0 4px 12px -2px rgba(99, 102, 241, 0.03);
}

/* 统计卡片：Emerald (活跃账号) */
.card-emerald {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.04) 0%, #ffffff 100%);
  border-color: rgba(16, 185, 129, 0.12);
}
.card-emerald .stat-value { color: #10b981; }
.card-emerald .stat-icon-wrapper { background: rgba(16, 185, 129, 0.08); color: #10b981; }
.card-emerald::after {
  content: '';
  position: absolute;
  right: -25px;
  bottom: -35px;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(16, 185, 129, 0.06) 0%, transparent 70%);
  z-index: 1;
}
.card-emerald:hover {
  border-color: rgba(16, 185, 129, 0.25);
  box-shadow: 0 12px 28px -4px rgba(16, 185, 129, 0.1), 0 4px 12px -2px rgba(16, 185, 129, 0.03);
}

/* 统计卡片：Sky (历史总发布) */
.card-sky {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.04) 0%, #ffffff 100%);
  border-color: rgba(14, 165, 233, 0.12);
}
.card-sky .stat-value { color: #0ea5e9; }
.card-sky .stat-icon-wrapper { background: rgba(14, 165, 233, 0.08); color: #0ea5e9; }
.card-sky::after {
  content: '';
  position: absolute;
  right: -25px;
  bottom: -35px;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.06) 0%, transparent 70%);
  z-index: 1;
}
.card-sky:hover {
  border-color: rgba(14, 165, 233, 0.25);
  box-shadow: 0 12px 28px -4px rgba(14, 165, 233, 0.1), 0 4px 12px -2px rgba(14, 165, 233, 0.03);
}

/* 统计卡片：Orange (今日成功数) */
.card-orange {
  background: linear-gradient(135deg, rgba(249, 115, 22, 0.04) 0%, #ffffff 100%);
  border-color: rgba(249, 115, 22, 0.12);
}
.card-orange .stat-value { color: #f97316; }
.card-orange .stat-icon-wrapper { background: rgba(249, 115, 22, 0.08); color: #f97316; }
.card-orange::after {
  content: '';
  position: absolute;
  right: -25px;
  bottom: -35px;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(249, 115, 22, 0.06) 0%, transparent 70%);
  z-index: 1;
}
.card-orange:hover {
  border-color: rgba(249, 115, 22, 0.25);
  box-shadow: 0 12px 28px -4px rgba(249, 115, 22, 0.1), 0 4px 12px -2px rgba(249, 115, 22, 0.03);
}

/* ======== 快捷导航 ======== */
.quick-nav-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.quick-nav-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
}

.quick-nav-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
}

.quick-nav-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quick-nav-title {
  font-size: 15px;
  font-weight: 700;
}

.quick-nav-desc {
  font-size: 11px;
}

/* 快捷导航：紫蓝渐变卡片 */
.card-purple-blue {
  background: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%);
  box-shadow: 0 8px 24px -4px rgba(99, 102, 241, 0.22);
}
.card-purple-blue .quick-nav-title { color: #ffffff; }
.card-purple-blue .quick-nav-desc { color: rgba(255, 255, 255, 0.78); }
.card-purple-blue .quick-nav-icon-wrap { background: rgba(255, 255, 255, 0.18); color: #ffffff; }
.card-purple-blue:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 36px -4px rgba(99, 102, 241, 0.38);
}

/* 快捷导航：绿色渐变卡片 */
.card-green {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  box-shadow: 0 8px 24px -4px rgba(16, 185, 129, 0.2);
}
.card-green .quick-nav-title { color: #ffffff; }
.card-green .quick-nav-desc { color: rgba(255, 255, 255, 0.78); }
.card-green .quick-nav-icon-wrap { background: rgba(255, 255, 255, 0.18); color: #ffffff; }
.card-green:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 36px -4px rgba(16, 185, 129, 0.35);
}

/* 快捷导航：磨砂白色卡片 */
.card-white {
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.015);
}
.card-white .quick-nav-title { color: #1e293b; }
.card-white .quick-nav-desc { color: #64748b; }
.card-white .quick-nav-icon-wrap { background: #f1f5f9; color: #475569; border: 1px solid rgba(0,0,0,0.02); }
.card-white:hover {
  transform: translateY(-4px);
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.04);
}

/* ======== 支持的自媒体平台 ======== */
.platforms-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.platform-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 12px;
  cursor: default;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
  position: relative;
}

.platform-card:hover {
  border-color: rgba(99, 102, 241, 0.28) !important;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.08) !important;
  background: rgba(99, 102, 241, 0.015) !important;
}

.platform-card:hover .platform-icon-wrap {
  transform: translateY(-3px);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1);
}

.platform-logo-img {
  width: 26px;
  height: 26px;
  object-fit: contain;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.platform-emoji {
  font-size: 20px;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.platform-icon-wrap {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.platform-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.platform-name {
  font-weight: 700;
  color: #1e293b;
  font-size: 14px;
}

.platform-count {
  font-size: 12px;
  color: #64748b;
}

.highlight-count {
  color: #6366f1;
  font-weight: 700;
}

.icon-douyin { background: rgba(6, 182, 212, 0.05); }
.icon-xiaohongshu { background: rgba(255, 77, 79, 0.05); }
.icon-kuaishou { background: rgba(249, 115, 22, 0.05); }
.icon-wechat_channels { background: rgba(16, 185, 129, 0.05); }
.icon-zhihu { background: rgba(0, 102, 255, 0.05); }
.icon-toutiao { background: rgba(240, 65, 52, 0.05); }
.icon-bilibili { background: rgba(244, 114, 182, 0.05); }
.icon-weibo { background: rgba(239, 68, 68, 0.05); }

/* ======== 底部小贴士横幅 ======== */
.tips-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.02) 0%, rgba(56, 189, 248, 0.01) 100%);
  border: 1px solid rgba(99, 102, 241, 0.05);
  margin-top: 8px;
  box-sizing: border-box;
}

.tips-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.tips-icon {
  font-size: 13px;
}

.tips-badge {
  color: #6366f1;
  font-weight: 700;
}

.tips-text {
  color: #64748b;
  font-weight: 500;
}

.tips-right {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #6366f1;
  font-weight: 700;
  transition: all 0.25s ease;
}

.tips-right:hover {
  color: #4f46e5;
}

.chevron-right-purple {
  width: 5px;
  height: 5px;
  border-top: 1.5px solid #6366f1;
  border-right: 1.5px solid #6366f1;
  transform: rotate(45deg);
  transition: transform 0.25s ease;
}

.tips-right:hover .chevron-right-purple {
  transform: rotate(45deg) translate(1.5px, -1.5px);
}
</style>
