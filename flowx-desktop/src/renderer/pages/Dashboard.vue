<template>
  <div>
    <div class="panel">
      <h2 class="section-title">仪表盘</h2>
      <el-row :gutter="16">
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-title">已授权账号</div>
            <div class="stat-value">{{ accountStore.accounts.length }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-title">活跃账号</div>
            <div class="stat-value">{{ accountStore.activeAccounts.length }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-title">历史发布</div>
            <div class="stat-value">{{ publishStore.stats.total }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-title">今日成功</div>
            <div class="stat-value">{{ publishStore.stats.todaySuccess }}</div>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <div class="panel">
      <h2 class="section-title">快速开始</h2>
      <el-space>
        <el-button type="primary" size="large" @click="go('/accounts')">
          <el-icon><UserFilled /></el-icon>&nbsp; 管理账号
        </el-button>
        <el-button type="success" size="large" @click="go('/publish')">
          <el-icon><Promotion /></el-icon>&nbsp; 新建发布任务
        </el-button>
        <el-button size="large" @click="go('/history')">
          <el-icon><Clock /></el-icon>&nbsp; 查看历史
        </el-button>
      </el-space>
    </div>

    <div class="panel">
      <h2 class="section-title">支持的平台</h2>
      <el-row :gutter="12">
        <el-col :span="4" v-for="p in accountStore.platforms" :key="p.key">
          <el-card shadow="hover" class="platform-card">
            <div class="platform-icon-wrap">
              <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-icon" />
            </div>
            <div style="font-weight: 600; margin-top: 8px">{{ p.name }}</div>
            <div style="color: #909399; font-size: 12px; margin-top: 4px">
              账号数：{{ accountStore.byPlatform(p.key).length }}
            </div>
          </el-card>
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
import iconXiaohongshu from '../assets/xiaohongshu.svg';
import iconDouyin from '../assets/douyin.svg';
import iconKuaishou from '../assets/kuaishou.svg';
import iconBilibili from '../assets/bilibili.svg';
import iconWechatChannels from '../assets/wechat_channels.svg';
import iconWechatOfficial from '../assets/wechat_official.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';

const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu: iconXiaohongshu,
  douyin: iconDouyin,
  kuaishou: iconKuaishou,
  bilibili: iconBilibili,
  wechat_channels: iconWechatChannels,
  wechat_official: iconWechatOfficial,
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
.stat-title {
  color: #909399;
  font-size: 13px;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: #303133;
}
.platform-card {
  text-align: center;
}
.platform-icon-wrap {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}
.platform-icon {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
</style>
