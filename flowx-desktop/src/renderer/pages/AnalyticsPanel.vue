<template>
  <div class="analytics-panel">
    <!-- 账号概览区 -->
    <div class="panel profile-section">
      <div class="section-header">
        <h2 class="section-title">账号概览</h2>
        <div class="header-actions">
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
          <el-button
            :disabled="!selectedAccountId || analyticsStore.isCollecting"
            @click="clearData"
          >
            清空数据
          </el-button>
        </div>
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

      <div v-if="currentAccount" class="profile-content">
        <div class="profile-left">
          <div class="profile-avatar">
            <img
              v-if="currentAccount.avatar"
              :src="currentAccount.avatar"
              class="avatar-lg"
              @error="onAvatarError"
            />
            <span v-else class="avatar-placeholder-lg">
              {{ (currentAccount.nickname || '?').charAt(0) }}
            </span>
          </div>
          <div class="profile-info">
            <div class="profile-name">
              <img
                v-if="getPlatformIcon(currentAccount.platform)"
                :src="getPlatformIcon(currentAccount.platform)"
                class="inline-platform-icon"
              />
              {{ currentAccount.nickname || currentAccount.id }}
            </div>
            <div class="profile-meta">
              <span class="platform-badge">{{ getPlatformName(currentAccount.platform) }}</span>
              <span class="meta-text">
                {{ getPlatformAccountLabel(currentAccount.platform) }}: {{ currentAccount.platformAccountId || '—' }}
              </span>
            </div>
          </div>
        </div>
        <div class="profile-stats">
          <div class="stat-card profile-stat">
            <div class="stat-label">粉丝数</div>
            <div class="stat-value">{{ formatNumber(analyticsStore.latestAccountStats?.fansCount || 0) }}</div>
          </div>
          <div class="stat-card profile-stat">
            <div class="stat-label">关注数</div>
            <div class="stat-value">{{ formatNumber(analyticsStore.latestAccountStats?.followCount || 0) }}</div>
          </div>
          <div class="stat-card profile-stat">
            <div class="stat-label">总获赞</div>
            <div class="stat-value">{{ formatNumber(analyticsStore.latestAccountStats?.totalLikeCount || 0) }}</div>
          </div>
          <div class="stat-card profile-stat">
            <div class="stat-label">账号作品数</div>
            <div class="stat-value">{{ formatNumber(accountWorksCount) }}</div>
          </div>
          <div class="stat-card profile-stat">
            <div class="stat-label">最近采集</div>
            <div class="stat-value small">
              {{ analyticsStore.latestAccountStats?.collectedAt ? formatDateTime(analyticsStore.latestAccountStats.collectedAt) : '—' }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty-profile">
        <el-empty description="请选择一个账号查看概览数据" :image-size="100" />
      </div>
    </div>

    <!-- 作品分析区 -->
    <div class="panel">
      <div class="section-header">
        <h2 class="section-title">作品分析</h2>
        <div class="section-summary">
          共 <span class="summary-num">{{ analyticsStore.worksTotal }}</span> 条作品
          <span v-if="analyticsStore.filterPlatform || localFilterPlatformAccountIds.length > 0">
            · 已筛选
          </span>
        </div>
      </div>

      <div class="filter-bar">
        <el-select
          v-model="filterPlatform"
          placeholder="按平台筛选"
          style="width: 180px"
          clearable
        >
          <el-option
            v-for="p in accountStore.platforms"
            :key="p.key"
            :label="p.name"
            :value="p.key"
          >
            <div class="platform-option-item">
              <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-option-icon" />
              <span class="platform-option-name">{{ p.name }}</span>
            </div>
          </el-option>
        </el-select>
        <el-select
          v-model="localFilterPlatformAccountIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="按账号筛选"
          style="width: 320px"
          clearable
        >
          <el-option
            v-for="acc in accountStore.accounts"
            :key="acc.id"
            :label="acc.nickname || acc.id"
            :value="String(acc.platformAccountId || acc.id)"
          >
            <div class="account-option-item">
              <div class="account-option-avatar">
                <img v-if="acc.avatar" :src="acc.avatar" class="option-avatar-img" />
                <span v-else class="option-avatar-text">
                  {{ (acc.nickname || '?').charAt(0) }}
                </span>
              </div>
              <div class="account-option-info">
                <div class="account-option-name">{{ acc.nickname || acc.id }}</div>
                <div class="account-option-id">
                  {{ getPlatformAccountLabel(acc.platform) }}: {{ acc.platformAccountId || '—' }}
                </div>
              </div>
            </div>
          </el-option>
        </el-select>
        <el-input
          v-model="searchKeyword"
          placeholder="搜索作品标题..."
          style="width: 240px"
          clearable
          @keyup.enter="searchWorks"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="sortBy"
          placeholder="排序方式"
          style="width: 160px"
        >
          <el-option label="发布时间" value="publishTime" />
          <el-option label="播放量" value="views" />
          <el-option label="点赞数" value="likes" />
          <el-option label="评论数" value="comments" />
          <el-option label="收藏数" value="favorites" />
          <el-option label="分享数" value="shares" />
        </el-select>
        <el-radio-group v-model="sortOrder" size="default">
          <el-radio-button value="desc">降序</el-radio-button>
          <el-radio-button value="asc">升序</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="searchWorks">
          <el-icon><Search /></el-icon>
          &nbsp;搜索
        </el-button>
        <el-button @click="resetFilter">重置</el-button>
      </div>

      <el-table
        v-loading="analyticsStore.loading"
        :data="analyticsStore.works"
        style="width: 100%; margin-top: 16px"
      >
        <el-table-column label="账号" width="280" fixed="left">
          <template #default="{ row }">
            <div class="account-cell">
              <div class="account-avatar">
                <img
                  v-if="getAccountInfo(row.accountId)?.avatar"
                  :src="getAccountInfo(row.accountId)?.avatar"
                  class="avatar-img"
                  @error="onAvatarError"
                />
                <span v-else class="avatar-placeholder">
                  {{ (getAccountInfo(row.accountId)?.nickname || '?').charAt(0) }}
                </span>
              </div>
              <div class="account-info">
                <div class="account-name" :title="getAccountInfo(row.accountId)?.nickname || row.accountId">
                  <img
                    v-if="getPlatformIcon(row.platform)"
                    :src="getPlatformIcon(row.platform)"
                    class="inline-platform-icon"
                  />
                  {{ getAccountInfo(row.accountId)?.nickname || row.accountId }}
                </div>
                <div class="account-id-row">
                  <span class="platform-name">{{ getPlatformName(row.platform) }}</span>
                  <span class="account-id-sep">·</span>
                  <span class="account-id-text" :title="getPlatformAccountId(row.accountId)">
                    {{ getPlatformAccountLabel(row.platform) }}: {{ getPlatformAccountId(row.accountId) || '—' }}
                  </span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="作品标题" min-width="280">
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
                  <span class="content-type-tag">
                    {{ getContentTypeName(row.contentType) }}
                  </span>
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
              @click="openDetail(row)"
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
import type { WorkItem, WorkMetrics, AccountInfo } from '../../types';
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

const accountStore = useAccountStore();
const analyticsStore = useAnalyticsStore();

const selectedAccountId = ref('');
const localFilterPlatformAccountIds = ref<string[]>([]);

const currentAccount = computed(() => {
  if (!selectedAccountId.value) return null;
  return accountStore.accounts.find(acc => acc.id === selectedAccountId.value) || null;
});

const accountWorksCount = computed(() => {
  if (!selectedAccountId.value) return 0;
  return analyticsStore.latestAccountStats?.worksCount || 0;
});
const sortBy = computed({
  get: () => analyticsStore.sortBy,
  set: (val: string) => { analyticsStore.sortBy = val as typeof analyticsStore.sortBy; },
});
const sortOrder = computed({
  get: () => analyticsStore.sortOrder as 'asc' | 'desc',
  set: (val: 'asc' | 'desc') => { analyticsStore.sortOrder = val; },
});
const filterPlatform = computed({
  get: () => analyticsStore.filterPlatform,
  set: (val: string) => { analyticsStore.filterPlatform = val; },
});
const searchKeyword = computed({
  get: () => analyticsStore.filterKeyword,
  set: (val: string) => { analyticsStore.filterKeyword = val; },
});

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

const availablePlatforms = computed(() => {
  const platforms = new Set<string>();
  accountStore.accounts.forEach(acc => platforms.add(acc.platform));
  return Array.from(platforms).map(key => ({ key, name: platformNames[key] || key }));
});

function getPlatformName(platform: string): string {
  const p = accountStore.platforms.find(x => x.key === platform);
  return p?.name || platform;
}

function getPlatformIcon(platform: string): string {
  return PLATFORM_ICONS[platform] || '';
}

function getContentTypeName(type: string): string {
  const map: Record<string, string> = {
    video: '视频',
    image: '图文',
    article: '文章',
  };
  return map[type] || type;
}

function getAccountInfo(accountId: string): AccountInfo | undefined {
  return accountStore.accounts.find(a => a.id === accountId);
}

function getPlatformAccountLabel(platform: string): string {
  const p = accountStore.platforms.find(x => x.key === platform);
  return p?.platformAccountLabel || '账号';
}

function getPlatformAccountId(accountId: string): string {
  const acc = getAccountInfo(accountId);
  return acc?.platformAccountId || '';
}

function formatDate(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateTime(ts: number): string {
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

function onAccountChange(accountId: string) {
  analyticsStore.setSelectedAccount(accountId);
  selectedAccountId.value = accountId;
  if (accountId) {
    analyticsStore.loadAccountStats(accountId);
  }
}

async function loadWorks() {
  const params: any = {
    page: analyticsStore.worksPage,
    pageSize: analyticsStore.worksPageSize,
    sortBy: analyticsStore.sortBy,
    sortOrder: analyticsStore.sortOrder,
  };

  if (analyticsStore.filterPlatform) {
    params.platform = analyticsStore.filterPlatform;
  }
  if (localFilterPlatformAccountIds.value && localFilterPlatformAccountIds.value.length > 0) {
    params.platformAccountIds = localFilterPlatformAccountIds.value.map(String);
  }
  if (analyticsStore.filterKeyword) {
    params.keyword = analyticsStore.filterKeyword;
  }

  await analyticsStore.loadWorks(params);
}

async function searchWorks() {
  analyticsStore.worksPage = 1;
  await loadWorks();
}

async function resetFilter() {
  analyticsStore.filterPlatform = '';
  analyticsStore.filterAccountIds = [];
  analyticsStore.filterPlatformAccountIds = [];
  analyticsStore.filterKeyword = '';
  analyticsStore.sortBy = 'publishTime';
  analyticsStore.sortOrder = 'desc';
  analyticsStore.worksPage = 1;
  localFilterPlatformAccountIds.value = [];
  await loadWorks();
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

async function clearData() {
  if (!selectedAccountId.value) return;
  try {
    await analyticsStore.clearData(selectedAccountId.value);
    ElMessage.success('数据已清空');
    loadWorks();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function openDetail(row: any) {
  if (!row.detailUrl || !row.accountId) return;
  try {
    await electronApi.analytics.openWorkInWindow(
      row.accountId,
      row.detailUrl,
      row.title || '作品详情'
    );
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
    electronApi.openExternal(row.detailUrl);
  }
}

function onImgError(e: Event) {
  const target = e.target as HTMLImageElement;
  target.style.display = 'none';
}

function onAvatarError(e: Event) {
  const target = e.target as HTMLImageElement;
  target.style.display = 'none';
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  if (accountStore.accounts.length > 0) {
    selectedAccountId.value = accountStore.accounts[0].id;
    analyticsStore.setSelectedAccount(accountStore.accounts[0].id);
    await analyticsStore.loadAccountStats(accountStore.accounts[0].id);
  }
  await analyticsStore.loadConfig();
  await loadWorks();
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

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-summary {
  font-size: 14px;
  color: #909399;
}

.summary-num {
  color: #409eff;
  font-weight: 600;
  margin: 0 4px;
}

.profile-section {
  margin-bottom: 16px;
}

.profile-content {
  display: flex;
  align-items: center;
  gap: 40px;
  padding: 8px 0;
}

.profile-left {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
}

.profile-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar-lg {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-placeholder-lg {
  color: #fff;
  font-size: 28px;
  font-weight: 600;
}

.profile-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-name {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: #909399;
}

.platform-badge {
  padding: 2px 8px;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.meta-text {
  color: #606266;
}

.profile-stats {
  display: flex;
  gap: 16px;
  flex: 1;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.profile-stat {
  min-width: 120px;
  text-align: center;
}

.empty-profile {
  padding: 32px 0;
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

.stat-value.small {
  font-size: 14px;
  font-weight: 500;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.platform-option-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.platform-option-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
  flex-shrink: 0;
}

.platform-option-name {
  font-size: 14px;
  color: #303133;
}

.account-option-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  margin: 0;
}

.account-option-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: #ec4899;
  color: #fff;
  font-weight: 500;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.option-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.option-avatar-text {
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
}

.account-option-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.account-option-name {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.account-option-id {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Consolas', 'Monaco', monospace;
  line-height: 1.4;
}

:deep(.el-select-dropdown__item) {
  height: auto;
  padding: 8px 12px;
  line-height: normal;
}

:deep(.el-select-dropdown__item .account-option-item) {
  pointer-events: none;
}

.account-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.account-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e4e7ed;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-placeholder {
  font-size: 14px;
  font-weight: 600;
  color: #909399;
}

.account-info {
  flex: 1;
  min-width: 0;
}

.account-name {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
}

.inline-platform-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
  margin-right: 6px;
  flex-shrink: 0;
}

.account-id-row {
  font-size: 12px;
  color: #909399;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 4px;
}

.account-id-row .platform-name {
  color: #909399;
}

.account-id-sep {
  color: #dcdfe6;
}

.account-id-text {
  font-family: 'Consolas', 'Monaco', monospace;
  color: #606266;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

.content-type-tag {
  margin-left: 8px;
  padding: 1px 6px;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 3px;
  font-size: 11px;
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
