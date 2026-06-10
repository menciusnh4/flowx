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
            <div class="stat-value">{{ publishStore.history.length }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover">
            <div class="stat-title">今日成功</div>
            <div class="stat-value">{{ todaySuccess }}</div>
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
        <el-col :span="8" v-for="p in accountStore.platforms" :key="p.key">
          <el-card shadow="hover" class="platform-card">
            <div style="font-size: 24px">{{ p.icon }}</div>
            <div style="font-weight: 600; margin-top: 6px">{{ p.name }}</div>
            <div style="color: #909399; font-size: 12px">
              账号数：{{ accountStore.byPlatform(p.key).length }}
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAccountStore } from '../stores/account';
import { usePublishStore } from '../stores/publish';

const router = useRouter();
const accountStore = useAccountStore();
const publishStore = usePublishStore();

const todaySuccess = computed(() => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const ts = start.getTime();
  return publishStore.history.filter(
    (t) => t.updatedAt >= ts && t.status === 'success',
  ).length;
});

function go(path: string) {
  router.push(path);
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadHistory();
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
</style>
