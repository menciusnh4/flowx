<template>
  <div>
    <div class="panel">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <h2 class="section-title" style="margin:0">发布历史</h2>
        <el-button @click="refresh">
          <el-icon><Refresh /></el-icon>&nbsp; 刷新
        </el-button>
      </div>

      <el-table
        v-loading="publishStore.loading"
        :data="publishStore.history"
        border
        stripe
        style="margin-top: 12px"
      >
        <el-table-column label="任务ID" prop="id" width="200" />
        <el-table-column label="标题/备注" min-width="240">
          <template #default="{ row }">
            <div style="font-weight:500">{{ row.request?.title || row.request?.remark || '-' }}</div>
            <div style="color:#909399; font-size:12px">
              目标账号：{{ row.items.length }} 个
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'success'" type="success">成功</el-tag>
            <el-tag v-else-if="row.status === 'failed'" type="danger">失败</el-tag>
            <el-tag v-else-if="row.status === 'running'" type="primary">发布中</el-tag>
            <el-tag v-else-if="row.status === 'scheduled'" type="warning">待发布</el-tag>
            <el-tag v-else type="info">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ fmt(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="详情" min-width="320">
          <template #default="{ row }">
            <el-space wrap>
              <el-tag
                v-for="item in row.items.slice(0, 5)"
                :key="item.accountId"
                :type="item.status === 'success' ? 'success' : item.status === 'failed' ? 'danger' : 'info'"
              >
                {{ nicknameOf(item.accountId) }} ({{ item.progress }}%)
              </el-tag>
              <span v-if="row.items.length > 5" style="color:#909399; font-size:12px">
                +{{ row.items.length - 5 }}
              </span>
            </el-space>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="publishStore.history.length === 0 && !publishStore.loading" class="empty-hint">
        暂无发布记录，请到「一键发布」创建第一个任务。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { usePublishStore } from '../stores/publish';
import { useAccountStore } from '../stores/account';

const publishStore = usePublishStore();
const accountStore = useAccountStore();

async function refresh() {
  await publishStore.loadHistory();
}

function nicknameOf(id: string): string {
  return accountStore.accounts.find((a) => a.id === id)?.nickname || id;
}

function fmt(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadHistory();
});
</script>
