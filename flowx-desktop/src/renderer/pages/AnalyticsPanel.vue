<template>
  <div class="analytics-panel">
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">账号分析</h2>
        <el-select
          v-model="selectedAccountId"
          placeholder="选择账号"
          style="width: 240px"
          @change="onAccountChange"
        >
          <el-option
            v-for="acc in accountStore.accounts"
            :key="acc.id"
            :label="`${acc.nickname || acc.id} (${getPlatformName(acc.platform)})`"
            :value="acc.id"
          />
        </el-select>
        <el-button
          type="primary"
          :loading="analyticsStore.isCollecting"
          :disabled="!selectedAccountId"
          @click="startCollect"
        >
          <el-icon v-if="!analyticsStore.isCollecting"><Refresh /></el-icon>
          &nbsp;{{ analyticsStore.isCollecting ? '采集中...' : '开始采集' }}
        </el-button>
      </div>

      <el-progress
        v-if="analyticsStore.currentProgress && analyticsStore.isCollecting"
        :percentage="analyticsStore.currentProgress.progress || 0"
        :status="analyticsStore.currentProgress.status === 'failed' ? 'exception' : ''"
        style="margin: 16px 0"
      >
        <template #default="{ percentage }">
          <span class="percentage-text">
            {{ percentage }}% - {{ analyticsStore.currentProgress?.message }}
          </span>
        </template>
      </el-progress>

      <el-row v-if="lastCollectInfo" :gutter="16" style="margin-bottom: 16px">
        <el-col :span="6">
          <div class="stat-card">
            <div class="stat-label">上次采集</div>
            <div class="stat-value">{{ formatDate(lastCollectInfo.lastCollectTime) }}</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="stat-card">
            <div class="stat-label">作品总数</div>
            <div class="stat-value">{{ analyticsStore.worksTotal }}</div>
          </div>
        </el-col>
      </el-row>

      <div class="filter-bar">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索作品标题..."
          style="width: 240px"
          clearable
          @keyup.enter="searchWorks"
          @clear="searchWorks"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="sortBy"
          placeholder="排序方式"
          style="width: 160px"
          @change="loadWorks"
        >
          <el-option label="发布时间" value="publishTime" />
          <el-option label="播放量" value="views" />
          <el-option label="点赞数" value="likes" />
          <el-option label="评论数" value="comments" />
          <el-option label="收藏数" value="favorites" />
          <el-option label="分享数" value="shares" />
        </el-select>
        <el-radio-group v-model="sortOrder" size="default" @change="loadWorks">
          <el-radio-button value="desc">降序</el-radio-button>
          <el-radio-button value="asc">升序</el-radio-button>
        </el-radio-group>
      </div>

      <el-table
        v-loading="analyticsStore.loading"
        :data="analyticsStore.works"
        style="width: 100%; margin-top: 16px"
      >
        <el-table-column prop="title" label="作品标题" min-width="240">
          <template #default="{ row }">
            <div class="work-title-cell">
              <img
                v-if="row.coverUrl"
                :src="row.coverUrl"
                class="work-cover"
                @error="onImgError"
              />
              <div class="work-info">
                <div class="work-title" :title="row.title">{{ row.title }}</div>
                <div class="work-meta">
                  {{ formatDate(row.publishTime) }}
                  <span v-if="row.duration"> · {{ formatDuration(row.duration) }}</span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="metrics.views" label="播放量" width="120" sortable>
          <template #default="{ row }">
            {{ formatNumber(row.metrics?.views || 0) }}
          </template>
        </el-table-column>
        <el-table-column prop="metrics.likes" label="点赞" width="100" sortable>
          <template #default="{ row }">
            {{ formatNumber(row.metrics?.likes || 0) }}
          </template>
        </el-table-column>
        <el-table-column prop="metrics.comments" label="评论" width="100" sortable>
          <template #default="{ row }">
            {{ formatNumber(row.metrics?.comments || 0) }}
          </template>
        </el-table-column>
        <el-table-column prop="metrics.favorites" label="收藏" width="100" sortable>
          <template #default="{ row }">
            {{ formatNumber(row.metrics?.favorites || 0) }}
          </template>
        </el-table-column>
        <el-table-column prop="metrics.shares" label="分享" width="100" sortable>
          <template #default="{ row }">
            {{ formatNumber(row.metrics?.shares || 0) }}
          </template>
        </el-table-column>
        <el-table-column label="互动率" width="100">
          <template #default="{ row }">
            {{ calcInteractionRate(row) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              :disabled="!row.detailUrl"
              @click="openDetail(row.detailUrl)"
            >
              查看
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="analyticsStore.worksPage"
          v-model:page-size="analyticsStore.worksPageSize"
          :total="analyticsStore.worksTotal"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="onPageChange"
          @size-change="onPageSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useAccountStore } from '../stores/account';
import { useAnalyticsStore } from '../stores/analytics';
import { electronApi } from '../utils/electron';
import { Search, Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import type { WorkItem, WorkMetrics } from '../../types';

const accountStore = useAccountStore();
const analyticsStore = useAnalyticsStore();

const selectedAccountId = ref('');
const searchKeyword = ref('');
const sortBy = ref('publishTime');
const sortOrder = ref<'asc' | 'desc'>('desc');
const lastCollectInfo = ref<{
  lastCollectTime: number;
  lastWorkId?: string;
  lastWorkPublishTime?: number;
} | null>(null);

const platformNames: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: '哔哩哔哩',
  wechat_channels: '视频号',
  wechat_official: '公众号',
  zhihu: '知乎',
  toutiao: '头条',
  weibo: '微博',
};

function getPlatformName(platform: string): string {
  return platformNames[platform] || platform;
}

function formatDate(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(n: number): string {
  if (n >= 10000) {
    return (n / 10000).toFixed(1) + 'w';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'k';
  }
  return String(n);
}

function calcInteractionRate(row: any): string {
  const views = row.metrics?.views || 0;
  if (views <= 0) return '0%';
  const likes = row.metrics?.likes || 0;
  const comments = row.metrics?.comments || 0;
  const shares = row.metrics?.shares || 0;
  const rate = ((likes + comments + shares) / views) * 100;
  return rate.toFixed(2) + '%';
}

async function onAccountChange(accountId: string) {
  analyticsStore.setSelectedAccount(accountId);
  selectedAccountId.value = accountId;
  await loadLastCollectInfo();
  await loadWorks();
}

async function loadLastCollectInfo() {
  if (!selectedAccountId.value) {
    lastCollectInfo.value = null;
    return;
  }
  try {
    lastCollectInfo.value = await electronApi.analytics.getLastCollectInfo(selectedAccountId.value);
  } catch {
    lastCollectInfo.value = null;
  }
}

async function loadWorks() {
  if (!selectedAccountId.value) return;
  await analyticsStore.loadWorks({
    accountId: selectedAccountId.value,
    page: analyticsStore.worksPage,
    pageSize: analyticsStore.worksPageSize,
    sortBy: sortBy.value as any,
    sortOrder: sortOrder.value,
    keyword: searchKeyword.value || undefined,
  });
}

function searchWorks() {
  analyticsStore.worksPage = 1;
  loadWorks();
}

async function startCollect() {
  if (!selectedAccountId.value) return;
  try {
    await analyticsStore.startCollect(selectedAccountId.value, 'all');
    ElMessage.success('采集任务已启动');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

function onPageChange(page: number) {
  analyticsStore.setPage(page);
}

function onPageSizeChange(size: number) {
  analyticsStore.worksPageSize = size;
  analyticsStore.worksPage = 1;
  loadWorks();
}

function openDetail(url?: string) {
  if (url) {
    electronApi.openExternal(url);
  }
}

function onImgError(e: Event) {
  const target = e.target as HTMLImageElement;
  target.style.display = 'none';
}

onMounted(async () => {
  await accountStore.refreshAccounts();
  if (accountStore.accounts.length > 0) {
    selectedAccountId.value = accountStore.accounts[0].id;
    analyticsStore.setSelectedAccount(accountStore.accounts[0].id);
    await loadLastCollectInfo();
    await loadWorks();
  }
  await analyticsStore.loadConfig();
});
</script>

<style scoped>
.analytics-panel {
  padding: 0;
}

.panel {
  padding: 16px 24px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.section-title {
  margin: 0;
  flex-shrink: 0;
}

.stat-card {
  background: #f5f7fa;
  border-radius: 8px;
  padding: 16px;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 6px;
}

.stat-value {
  font-size: 22px;
  font-weight: 600;
  color: #303133;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.work-title-cell {
  display: flex;
  gap: 12px;
  align-items: center;
}

.work-cover {
  width: 64px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.work-info {
  flex: 1;
  min-width: 0;
}

.work-title {
  font-size: 14px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.work-meta {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.pagination-wrap {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.percentage-text {
  font-size: 13px;
  color: #606266;
}
</style>
