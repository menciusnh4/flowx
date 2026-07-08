<template>
  <div class="dashboard-container">
    <!-- 数据指标看板 -->
    <div class="panel header-panel">
      <h2 class="section-title">
        <el-icon><DataLine /></el-icon>数据仪表盘
      </h2>
      <el-row :gutter="20">
        <el-col :span="6">
          <div class="stat-card card-indigo">
            <div class="stat-info">
              <span class="stat-title">已授权账号</span>
              <span class="stat-value">{{ accountStore.accounts.length }}</span>
            </div>
            <div class="stat-icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-emerald">
            <div class="stat-info">
              <span class="stat-title">活跃账号</span>
              <span class="stat-value">{{ accountStore.activeAccounts.length }}</span>
            </div>
            <div class="stat-icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-sky">
            <div class="stat-info">
              <span class="stat-title">历史总发布</span>
              <span class="stat-value">{{ publishStore.stats.total }}</span>
            </div>
            <div class="stat-icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card card-orange">
            <div class="stat-info">
              <span class="stat-title">今日成功数</span>
              <span class="stat-value">{{ publishStore.stats.todaySuccess }}</span>
            </div>
            <div class="stat-icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stat-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 快捷导航操作 -->
    <div class="panel quick-start-panel">
      <h2 class="section-title">
        <el-icon><Guide /></el-icon>快捷导航
      </h2>
      <div class="btn-group">
        <el-button type="primary" size="large" @click="go('/accounts')" class="glow-btn">
          <el-icon><UserFilled /></el-icon>&nbsp; 管理发布账号
        </el-button>
        <el-button type="success" size="large" @click="go('/publish')" class="glow-btn">
          <el-icon><Promotion /></el-icon>&nbsp; 开启一键发布
        </el-button>
        <el-button size="large" @click="go('/history')" class="plain-btn">
          <el-icon><Clock /></el-icon>&nbsp; 浏览发布历史
        </el-button>
      </div>
    </div>

    <!-- 平台生态状态 -->
    <div class="panel platforms-panel">
      <h2 class="section-title">
        <el-icon><Cpu /></el-icon>支持的自媒体平台
      </h2>
      <el-row :gutter="16">
        <el-col :span="8" v-for="p in accountStore.platforms" :key="p.key">
          <div class="platform-card" :class="'hover-' + p.key">
            <div class="platform-icon-wrap" :class="'icon-' + p.key">
              <span class="platform-emoji">{{ p.icon }}</span>
            </div>
            <div class="platform-details">
              <span class="platform-name">{{ p.name }}</span>
              <span class="platform-count">已绑定：<strong>{{ accountStore.byPlatform(p.key).length }}</strong> 个账号</span>
            </div>
          </div>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAccountStore } from '../stores/account';
import { usePublishStore } from '../stores/publish';

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
  gap: 8px;
}

/* 统计卡片美化 */
.stat-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  background: #ffffff;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

.stat-card:hover {
  transform: translateY(-4px);
}

.stat-card:hover .stat-icon {
  transform: scale(1.15) rotate(5deg);
}

.stat-icon {
  transition: transform 0.3s ease;
}

.stat-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat-title {
  color: #64748b;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.stat-value {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
}

.stat-icon-wrapper {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  transition: all 0.3s ease;
}

/* 独立的主题色彩 */
.card-indigo {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(255, 255, 255, 0.85) 100%);
  border-color: rgba(99, 102, 241, 0.15);
}
.card-indigo .stat-value { color: #6366f1; }
.card-indigo .stat-icon-wrapper { background: rgba(99, 102, 241, 0.08); color: #6366f1; }
.card-indigo:hover {
  border-color: rgba(99, 102, 241, 0.3);
  box-shadow: 0 12px 24px -4px rgba(99, 102, 241, 0.12), 0 4px 12px -2px rgba(99, 102, 241, 0.04);
}

.card-emerald {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(255, 255, 255, 0.85) 100%);
  border-color: rgba(16, 185, 129, 0.15);
}
.card-emerald .stat-value { color: #10b981; }
.card-emerald .stat-icon-wrapper { background: rgba(16, 185, 129, 0.08); color: #10b981; }
.card-emerald:hover {
  border-color: rgba(16, 185, 129, 0.3);
  box-shadow: 0 12px 24px -4px rgba(16, 185, 129, 0.12), 0 4px 12px -2px rgba(16, 185, 129, 0.04);
}

.card-sky {
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(255, 255, 255, 0.85) 100%);
  border-color: rgba(56, 189, 248, 0.15);
}
.card-sky .stat-value { color: #0ea5e9; }
.card-sky .stat-icon-wrapper { background: rgba(56, 189, 248, 0.08); color: #0ea5e9; }
.card-sky:hover {
  border-color: rgba(56, 189, 248, 0.3);
  box-shadow: 0 12px 24px -4px rgba(56, 189, 248, 0.12), 0 4px 12px -2px rgba(56, 189, 248, 0.04);
}

.card-orange {
  background: linear-gradient(135deg, rgba(249, 115, 22, 0.08) 0%, rgba(255, 255, 255, 0.85) 100%);
  border-color: rgba(249, 115, 22, 0.15);
}
.card-orange .stat-value { color: #f97316; }
.card-orange .stat-icon-wrapper { background: rgba(249, 115, 22, 0.08); color: #f97316; }
.card-orange:hover {
  border-color: rgba(249, 115, 22, 0.3);
  box-shadow: 0 12px 24px -4px rgba(249, 115, 22, 0.12), 0 4px 12px -2px rgba(249, 115, 22, 0.04);
}

/* 按钮组 */
.btn-group {
  display: flex;
  gap: 16px;
  margin-top: 4px;
}

.glow-btn {
  padding: 12px 24px !important;
  font-size: 14px !important;
  height: auto !important;
}

.plain-btn {
  padding: 12px 24px !important;
  font-size: 14px !important;
  height: auto !important;
  border: 1px solid rgba(0, 0, 0, 0.08) !important;
  background: rgba(255, 255, 255, 0.8) !important;
  color: #475569 !important;
}

.plain-btn:hover {
  background: #ffffff !important;
  color: #6366f1 !important;
  border-color: rgba(99, 102, 241, 0.3) !important;
  transform: translateY(-1.5px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);
}

/* 平台卡片列表 */
.platforms-panel {
  margin-bottom: 0 !important;
}

.platform-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 12px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  margin-bottom: 16px;
}

.platform-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.03);
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

.platform-count strong {
  color: #6366f1;
}

/* 平台 Hover 特效及专属高光 */
.hover-douyin:hover { border-color: rgba(6, 182, 212, 0.3) !important; box-shadow: 0 4px 15px rgba(6, 182, 212, 0.08) !important; transform: translateY(-2px); }
.hover-xiaohongshu:hover { border-color: rgba(255, 77, 79, 0.3) !important; box-shadow: 0 4px 15px rgba(255, 77, 79, 0.08) !important; transform: translateY(-2px); }
.hover-kuaishou:hover { border-color: rgba(249, 115, 22, 0.3) !important; box-shadow: 0 4px 15px rgba(249, 115, 22, 0.08) !important; transform: translateY(-2px); }
.hover-wechat_channels:hover { border-color: rgba(16, 185, 129, 0.3) !important; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.08) !important; transform: translateY(-2px); }
.hover-zhihu:hover { border-color: rgba(0, 102, 255, 0.3) !important; box-shadow: 0 4px 15px rgba(0, 102, 255, 0.08) !important; transform: translateY(-2px); }
.hover-toutiao:hover { border-color: rgba(240, 65, 52, 0.3) !important; box-shadow: 0 4px 15px rgba(240, 65, 52, 0.08) !important; transform: translateY(-2px); }

.icon-douyin { background: rgba(6, 182, 212, 0.08); }
.icon-xiaohongshu { background: rgba(255, 77, 79, 0.08); }
.icon-kuaishou { background: rgba(249, 115, 22, 0.08); }
.icon-wechat_channels { background: rgba(16, 185, 129, 0.08); }
.icon-zhihu { background: rgba(0, 102, 255, 0.08); }
.icon-toutiao { background: rgba(240, 65, 52, 0.08); }
</style>
