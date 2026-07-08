<template>
  <div>
    <div class="panel">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <h2 class="section-title" style="margin:0">发布历史</h2>
        <el-space>
          <el-button @click="refresh">
            <el-icon><Refresh /></el-icon>&nbsp; 刷新
          </el-button>
        </el-space>
      </div>

      <!-- 任务历史卡片列表 -->
      <div v-loading="publishStore.loading" class="task-card-list">
        <div v-for="row in publishStore.history" :key="row.id" class="flow-task-card">
          <!-- 头部：任务ID、发布类型与时间 -->
          <div class="task-card-header">
            <div class="header-left">
              <span class="task-id-tag">ID: {{ row.id }}</span>
              <el-tag size="small" :type="contentTypeTagType(row.request?.contentType)">
                {{ contentTypeLabel(row.request?.contentType) }}
              </el-tag>
              <el-tag v-if="isTestTask(row)" type="warning" size="small" effect="plain">🔍 测试</el-tag>
            </div>
            <div class="header-right">
              <div class="task-status-badge">
                <el-tag :type="statusTagType(row.status)" size="small" effect="dark">
                  {{ statusLabel(row.status) }}
                </el-tag>
              </div>
              <div class="task-time-info">
                <span>创建：{{ fmt(row.createdAt) }}</span>
                <span v-if="row.request?.scheduledAt" class="scheduled-time">
                  定时：{{ fmt(row.request.scheduledAt) }}
                </span>
              </div>
            </div>
          </div>

          <!-- 主体：发布内容与目标账号执行状况 -->
          <div class="task-card-body">
            <div class="task-main-info">
              <h3 class="task-title">{{ row.request?.title || row.request?.remark || '无标题发布' }}</h3>
              <p class="task-desc-preview" v-if="row.request?.content">
                {{ row.request.content.slice(0, 80) }}{{ row.request.content.length > 80 ? '...' : '' }}
              </p>
              <div class="task-meta-info" style="margin-top: 10px; font-size: 12px; color: #64748b; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                <span style="font-weight: 500; display: inline-flex; align-items: center; gap: 4px;">
                  <span style="font-size: 14px; line-height: 1;">🎯</span>目标账号：{{ row.items.length }} 个
                </span>
                <span v-if="row.request?.tags && row.request.tags.length > 0" class="task-meta-tags" style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 0 !important;">
                  <span class="meta-tag" v-for="tag in row.request.tags" :key="tag">#{{ tag }}</span>
                </span>
              </div>
            </div>

            <div class="task-accounts-section">
              <div class="section-label">分发账号 ({{ row.items.length }})</div>
              <div class="accounts-badge-grid">
                <div v-for="item in row.items.slice(0, 6)" :key="item.accountId" class="account-result-badge" :class="'result-' + item.status">
                  <img v-if="getPlatformIcon(item.platform)" :src="getPlatformIcon(item.platform)" class="badge-icon" />
                  <span class="badge-name">{{ nicknameOf(item.accountId) }}</span>
                  <span class="badge-status-icon" v-if="item.status === 'success'">✓</span>
                  <span class="badge-status-icon" v-else-if="item.status === 'failed'">✗</span>
                </div>
                <el-tooltip v-if="row.items.length > 6" :content="formatAccountList(row.items)">
                  <div class="accounts-more-badge">
                    +{{ row.items.length - 6 }}
                  </div>
                </el-tooltip>
              </div>
            </div>
          </div>

          <!-- 尾部：动作按钮区 -->
          <div class="task-card-footer">
            <div class="task-actions-group">
              <el-button size="small" type="primary" link @click="showDetail(row)">
                <el-icon><View /></el-icon>&nbsp;查看详情
              </el-button>
              <el-button
                v-if="row.status === 'scheduled'"
                size="small"
                type="danger"
                link
                @click="cancelTask(row)"
              >
                <el-icon><CircleClose /></el-icon>&nbsp;取消发布
              </el-button>
              <el-button
                v-if="hasFailedItems(row)"
                size="small"
                type="warning"
                link
                :loading="retryingId === row.id"
                @click="retryTask(row)"
              >
                <el-icon><RefreshRight /></el-icon>&nbsp;重试
              </el-button>
              <el-button
                v-if="hasFailedItems(row)"
                size="small"
                type="success"
                link
                @click="openEditDialog(row)"
              >
                <el-icon><Edit /></el-icon>&nbsp;编辑重发
              </el-button>
              <!-- 测试任务：重新测试 -->
              <el-button
                v-if="isTestTask(row) && row.status !== 'running' && row.status !== 'queued'"
                size="small"
                type="primary"
                link
                :loading="retryingId === row.id"
                @click="retryTest(row)"
              >
                <el-icon><Refresh /></el-icon>&nbsp;重新测试
              </el-button>
              <!-- 测试任务：立即发布 -->
              <el-button
                v-if="isTestTask(row) && row.status !== 'running' && row.status !== 'queued'"
                size="small"
                type="success"
                link
                @click="retryAsPublish(row)"
              >
                <el-icon><Promotion /></el-icon>&nbsp;立即发布
              </el-button>
              <el-popconfirm
                width="200"
                title="确定删除此发布记录？"
                @confirm="deleteTask(row)"
              >
                <template #reference>
                  <el-button size="small" type="danger" link>
                    <el-icon><Delete /></el-icon>&nbsp;删除
                  </el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </div>
      </div>

      <div v-if="publishStore.history.length === 0 && !publishStore.loading" class="empty-hint">
        暂无发布记录，请到「一键发布」创建第一个任务。
      </div>

      <!-- 分页控件 -->
      <div v-if="publishStore.historyTotal > 0" class="pagination-wrapper">
        <el-pagination
          v-model:current-page="publishStore.historyPage"
          v-model:page-size="publishStore.historyPageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="publishStore.historyTotal"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </div>

    <!-- 详情弹窗 -->
    <el-dialog
      v-model="detailVisible"
      :title="'任务详情 - ' + (detailData?.task?.id || '')"
      width="760px"
      destroy-on-close
    >
      <div v-if="detailData?.task" class="detail-content">
        <!-- 基本信息 (Grouped Card Dashboard) -->
        <!-- 任务基本信息扁平化网格 (Flat Metadata Grid) -->
        <div class="task-metadata-grid">
          <div class="meta-item">
            <div class="meta-label">任务ID</div>
            <div class="meta-value mono">{{ detailData.task.id }}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">内容类型</div>
            <div class="meta-value">
              <el-tag size="small" :type="contentTypeTagType(detailData.task.request?.contentType)">
                {{ contentTypeLabel(detailData.task.request?.contentType) }}
              </el-tag>
            </div>
          </div>
          <div class="meta-item">
            <div class="meta-label">整体状态</div>
            <div class="meta-value">
              <el-tag :type="statusTagType(detailData.task.status)" size="small" effect="dark">
                {{ statusLabel(detailData.task.status) }}
              </el-tag>
              <el-tag v-if="isTestTask(detailData.task)" type="warning" size="small" effect="plain" style="margin-left: 4px;">
                🔍 测试模式
              </el-tag>
            </div>
          </div>
          <div class="meta-item">
            <div class="meta-label">分发账号数</div>
            <div class="meta-value font-semibold">{{ detailData.task.items.length }} 个</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">创建时间</div>
            <div class="meta-value">{{ fmt(detailData.task.createdAt) }}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">更新时间</div>
            <div class="meta-value">{{ fmt(detailData.task.updatedAt) }}</div>
          </div>
          <div class="meta-item" v-if="detailData.task.request?.scheduledAt">
            <div class="meta-label">定时发布</div>
            <div class="meta-value scheduled-time">{{ fmt(detailData.task.request.scheduledAt) }}</div>
          </div>
          <div class="meta-item" v-if="detailData.task.request?.tags?.length">
            <div class="meta-label">标签</div>
            <div class="meta-value">
              <span class="meta-tag-bubble" v-for="t in detailData.task.request.tags" :key="t">
                #{{ t }}
              </span>
            </div>
          </div>
        </div>

        <!-- 标题与备注 -->
        <div class="task-title-banner" v-if="detailData.task.request?.title">
          <div class="banner-label">发布标题</div>
          <h3 class="banner-title">{{ detailData.task.request.title }}</h3>
        </div>

        <div class="task-title-banner remark" v-if="detailData.task.request?.remark">
          <div class="banner-label">发布备注</div>
          <div class="banner-remark">{{ detailData.task.request.remark }}</div>
        </div>

        <!-- 正文预览 -->
        <div v-if="detailData.task.request?.content" class="detail-section">
          <div class="detail-section-title">正文内容</div>
          <div class="content-preview">
            {{ detailData.task.request.content.slice(0, 500) }}
            <span v-if="detailData.task.request.content.length > 500">...</span>
          </div>
        </div>

        <!-- 各账号详情 -->
        <div class="detail-section">
          <div class="detail-section-title">各账号执行结果</div>
          <el-table :data="detailData.task.items" border size="small">
            <el-table-column label="平台" width="80">
              <template #default="{ row }">
                {{ platformLabel(row.platform) }}
              </template>
            </el-table-column>
            <el-table-column label="账号" min-width="120">
              <template #default="{ row }">{{ nicknameOf(row.accountId) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="itemStatusTagType(row.status)">
                  {{ statusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" width="80">
              <template #default="{ row }">{{ row.progress }}%</template>
            </el-table-column>
            <el-table-column label="结果/消息" min-width="200">
              <template #default="{ row }">
                <div v-if="row.resultUrl">
                  <el-link type="primary" :href="row.resultUrl" target="_blank" @click.stop="openUrl(row.resultUrl)">
                    查看作品
                  </el-link>
                </div>
                <div v-else-if="row.message" style="color:#F56C6C; font-size:12px; word-break:break-all">
                  {{ row.message }}
                </div>
                <span v-else style="color:#909399">-</span>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="100">
              <template #default="{ row }">
                {{ row.startedAt && row.finishedAt ? formatDuration(row.finishedAt - row.startedAt) : '-' }}
              </template>
            </el-table-column>
            <el-table-column label="测试结果" width="120">
              <template #default="{ row }">
                <el-tag v-if="row.testResult" type="warning" size="small" effect="plain">测试完成</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>

          <!-- 测试结果详情 -->
          <div v-if="hasTestResult(detailData.task)" class="test-results-detail">
            <div class="detail-section-title">🔍 测试结果详情</div>
            <div v-for="item in detailData.task.items.filter((i: any) => i.testResult)" :key="item.accountId" class="test-result-item">
              <div class="test-result-header">
                <span class="test-result-account">
                  {{ platformLabel(item.platform) }} - {{ nicknameOf(item.accountId) }}
                </span>
                <el-tag :type="item.testResult?.publishButtonFound ? 'success' : 'danger'" size="small">
                  {{ item.testResult?.publishButtonFound ? '✓ 已找到发布按钮' : '✗ 未找到发布按钮' }}
                </el-tag>
              </div>
              <div class="test-result-grid">
                <div class="test-field" :class="{ filled: item.testResult?.titleFilled }">
                  <span class="test-field-label">标题</span>
                  <span class="test-field-value">
                    {{ item.testResult?.titleFilled ? '✓ 已填写' : '✗ 未填写' }}
                  </span>
                </div>
                <div class="test-field" :class="{ filled: item.testResult?.contentFilled }">
                  <span class="test-field-label">内容/正文</span>
                  <span class="test-field-value">
                    {{ item.testResult?.contentFilled ? '✓ 已填写' : '✗ 未填写' }}
                  </span>
                </div>
                <div class="test-field" :class="{ filled: item.testResult?.tagsFilled }">
                  <span class="test-field-label">标签/话题</span>
                  <span class="test-field-value">
                    {{ item.testResult?.tagsFilled ? '✓ 已填写' : '✗ 未填写' }}
                  </span>
                </div>
                <div class="test-field" :class="{ filled: item.testResult?.coverUploaded }">
                  <span class="test-field-label">封面</span>
                  <span class="test-field-value">
                    {{ item.testResult?.coverUploaded ? '✓ 已上传' : '✗ 未上传' }}
                  </span>
                </div>
              </div>
              <div v-if="item.testResult?.note" class="test-result-note">
                💡 {{ item.testResult?.note }}
              </div>
            </div>
          </div>
        </div>

        <!-- 执行日志 -->
        <div v-if="detailData.logs && detailData.logs.length > 0" class="detail-section">
          <div class="detail-section-title">
            执行日志 ({{ detailData.logs.length }} 条)
          </div>
          <div class="log-container">
            <div
              v-for="(log, idx) in detailData.logs.slice(-50)"
              :key="idx"
              class="log-line"
              :class="'log-' + log.level"
            >
              <span class="log-time">{{ fmt(log.ts) }}</span>
              <span class="log-level">[{{ log.level.toUpperCase() }}]</span>
              <span v-if="log.platform" class="log-platform">[{{ platformLabel(log.platform) }}]</span>
              <span v-if="log.accountId" class="log-account">[{{ nicknameOf(log.accountId) }}]</span>
              <span class="log-stage">[{{ log.stage }}]</span>
              <span class="log-msg">{{ log.message }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <el-space>
          <el-button @click="detailVisible = false">关闭</el-button>
          <el-button
            v-if="detailData?.task && hasFailedItems(detailData.task)"
            type="success"
            @click="openEditDialog(detailData.task)"
          >
            <el-icon><Edit /></el-icon>&nbsp;编辑重发
          </el-button>
          <el-button
            v-if="detailData?.task && hasFailedItems(detailData.task)"
            type="warning"
            :loading="retryingId === detailData.task.id"
            @click="retryTask(detailData.task)"
          >
            <el-icon><RefreshRight /></el-icon>&nbsp;重试失败账号
          </el-button>
        </el-space>
      </template>
    </el-dialog>

    <!-- 编辑重发弹窗 -->
    <el-dialog
      v-model="editDialogVisible"
      title="编辑后重新发布"
      width="560px"
      destroy-on-close
    >
      <div v-if="editTask" class="edit-form">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 16px;"
        >
          <template #title>
            将对以下 {{ failedAccounts.length }} 个失败账号重新发布：{{ failedAccountNames }}
          </template>
        </el-alert>

        <el-form label-width="80px" label-position="right">
          <el-form-item label="内容类型">
            <el-tag :type="contentTypeTagType(editTask.request?.contentType)">
              {{ contentTypeLabel(editTask.request?.contentType) }}
            </el-tag>
            <span style="margin-left: 12px; color: #909399; font-size: 12px;">（不可修改）</span>
          </el-form-item>

          <el-form-item label="标题">
            <el-input
              v-model="editForm.title"
              placeholder="请输入标题"
              maxlength="100"
              show-word-limit
            />
          </el-form-item>

          <el-form-item v-if="editForm.contentType !== 'article'" label="素材">
            <div class="edit-file-list">
              <div v-for="(f, idx) in editForm.mediaFiles" :key="idx" class="edit-file-item">
                <span class="file-name">{{ f }}</span>
                <el-button size="small" type="danger" link @click="removeEditMediaFile(f)">删除</el-button>
              </div>
            </div>
            <el-button size="small" @click="addEditMediaFiles" style="margin-top: 8px;">
              <el-icon><Plus /></el-icon>&nbsp;添加文件
            </el-button>
          </el-form-item>

          <el-form-item v-if="editForm.contentType === 'article'" label="封面图">
            <div class="edit-file-list">
              <div v-for="(f, idx) in editForm.mediaFiles" :key="idx" class="edit-file-item">
                <span class="file-name">{{ idx === 0 ? '📌 封面：' : '' }}{{ f }}</span>
                <el-button size="small" type="danger" link @click="removeEditMediaFile(f)">删除</el-button>
              </div>
            </div>
            <el-button size="small" @click="addEditMediaFiles" style="margin-top: 8px;">
              <el-icon><Plus /></el-icon>&nbsp;添加图片
            </el-button>
          </el-form-item>

          <el-form-item label="描述">
            <el-input
              v-model="editForm.content"
              type="textarea"
              :rows="editForm.contentType === 'article' ? 8 : 4"
              :placeholder="editForm.contentType === 'article'
                ? '请输入文章正文'
                : editForm.contentType === 'image'
                  ? '可选：为图文添加描述文案'
                  : '可选：为视频添加描述文案'"
              maxlength="5000"
              show-word-limit
            />
          </el-form-item>

          <el-form-item label="话题">
            <el-input
              v-model="editForm.tagsRaw"
              placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活"
            />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-space>
          <el-button @click="editDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="editSubmitting" @click="submitEditAndPublish">
            <el-icon><Promotion /></el-icon>&nbsp;发布
          </el-button>
        </el-space>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { View, RefreshRight, Delete, Refresh, CircleClose, Edit, Plus, Promotion } from '@element-plus/icons-vue';
import { usePublishStore } from '../stores/publish';
import { useAccountStore } from '../stores/account';
import { electronApi } from '../utils/electron';
import type { PublishTask, PlatformType, PublishStatus, PublishLogEntry, PublishItemProgress, PublishRequest, ContentType } from '../../types';

const publishStore = usePublishStore();
const accountStore = useAccountStore();

function getPlatformIcon(p?: string | null): string {
  if (!p) return '';
  return accountStore.platforms.find((x) => x.key === p)?.icon || '';
}

const detailVisible = ref(false);
const detailData = ref<{ task: PublishTask | null; logs: PublishLogEntry[] } | null>(null);
const retryingId = ref<string | null>(null);

// ========== 编辑重发相关 ==========
const editDialogVisible = ref(false);
const editTask = ref<PublishTask | null>(null);
const editSubmitting = ref(false);
const editForm = ref({
  title: '',
  content: '',
  tagsRaw: '',
  mediaFiles: [] as string[],
  contentType: 'video' as ContentType,
});

const failedAccounts = computed(() => {
  if (!editTask.value) return [];
  return editTask.value.items.filter(
    (i) => i.status === 'failed' || i.status === 'cancelled'
  );
});

const failedAccountNames = computed(() => {
  return failedAccounts.value
    .map((i) => nicknameOf(i.accountId))
    .join('、');
});

function openEditDialog(task: any) {
  editTask.value = task as PublishTask;
  const req = task.request;
  editForm.value = {
    title: req?.title || '',
    content: req?.content || '',
    tagsRaw: (req?.tags || []).join(' '),
    mediaFiles: [...(req?.mediaFiles || [])],
    contentType: req?.contentType || 'video',
  };
  editDialogVisible.value = true;
}

async function addEditMediaFiles() {
  try {
    const isArticle = editForm.value.contentType === 'article';
    const filters = isArticle
      ? [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
      : undefined;
    const r = await electronApi.openFileDialog({ mode: 'files', filters });
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      editForm.value.mediaFiles = [...editForm.value.mediaFiles, ...r.filePaths];
      ElMessage.success(`已添加 ${r.filePaths.length} 个文件`);
    }
  } catch (e) {
    ElMessage.error('选择文件失败');
  }
}

function removeEditMediaFile(path: string) {
  editForm.value.mediaFiles = editForm.value.mediaFiles.filter((x) => x !== path);
}

async function submitEditAndPublish() {
  if (!editTask.value) return;

  if (!editForm.value.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }

  const failedAccountIds = failedAccounts.value.map((i) => i.accountId);
  if (failedAccountIds.length === 0) {
    ElMessage.warning('没有需要重发的失败账号');
    return;
  }

  if (editForm.value.contentType !== 'article' && editForm.value.mediaFiles.length === 0) {
    ElMessage.warning('请上传素材文件');
    return;
  }

  const tags = editForm.value.tagsRaw
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0);

  const req: PublishRequest = {
    accountIds: failedAccountIds,
    title: editForm.value.title.trim(),
    content: editForm.value.content,
    mediaFiles: [...editForm.value.mediaFiles],
    contentType: editForm.value.contentType,
    tags: tags.length > 0 ? tags : undefined,
    remark: editTask.value.request?.remark,
    coverImage: editTask.value.request?.coverImage,
    category: editTask.value.request?.category,
  };

  editSubmitting.value = true;
  try {
    const newTaskId = await electronApi.submitPublish(req);
    ElMessage.success(`已创建发布任务，任务ID: ${newTaskId}`);
    editDialogVisible.value = false;
    detailVisible.value = false;
    await refresh();
  } catch (err) {
    ElMessage.error('发布失败: ' + (err as Error).message);
  } finally {
    editSubmitting.value = false;
  }
}

async function refresh() {
  await Promise.all([
    publishStore.loadHistoryPaged(),
    publishStore.loadStats(),
  ]);
}

function handlePageChange(page: number) {
  publishStore.loadHistoryPaged(page);
}

function handleSizeChange(size: number) {
  publishStore.loadHistoryPaged(1, size);
}

function nicknameOf(id: string): string {
  return accountStore.accounts.find((a) => a.id === id)?.nickname || id.slice(0, 8);
}

function fmt(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function contentTypeLabel(type?: string): string {
  switch (type) {
    case 'video': return '视频';
    case 'image': return '图文';
    case 'article': return '文章';
    default: return type || '-';
  }
}

function contentTypeTagType(type?: string): 'success' | 'warning' | 'info' | undefined {
  switch (type) {
    case 'video': return undefined;
    case 'image': return 'success';
    case 'article': return 'warning';
    default: return 'info';
  }
}

function platformLabel(p: PlatformType): string {
  switch (p) {
    case 'douyin': return '抖音';
    case 'xiaohongshu': return '小红书';
    case 'kuaishou': return '快手';
    default: return p;
  }
}

function statusLabel(s: PublishStatus): string {
  switch (s) {
    case 'success': return '成功';
    case 'failed': return '失败';
    case 'running': return '发布中';
    case 'queued': return '等待中';
    case 'cancelled': return '已取消';
    case 'scheduled': return '待发布';
    default: return s;
  }
}

function statusTagType(s: PublishStatus): 'success' | 'danger' | 'primary' | 'warning' | 'info' | undefined {
  switch (s) {
    case 'success': return 'success';
    case 'failed': return 'danger';
    case 'running': return 'primary';
    case 'queued': return 'info';
    case 'cancelled': return 'info';
    case 'scheduled': return 'warning';
    default: return 'info';
  }
}

function itemStatusTagType(s: PublishStatus): 'success' | 'danger' | 'primary' | 'warning' | 'info' | undefined {
  return statusTagType(s);
}

function hasFailedItems(task: any): boolean {
  if (task.status === 'running' || task.status === 'queued' || task.status === 'scheduled') return false;
  return task.items.some((i: PublishItemProgress) => i.status === 'failed' || i.status === 'cancelled');
}

/** 判断是否为测试任务 */
function isTestTask(task: any): boolean {
  return !!(task?.request?.testMode || task?.items?.some((i: any) => i.testResult));
}

/** 判断是否有测试结果 */
function hasTestResult(task: any): boolean {
  return !!(task?.items?.some((i: any) => i.testResult));
}

function formatTags(tags?: string[]): string {
  if (!tags || tags.length === 0) return '';
  return tags.map((t: string) => '#' + t).join(' ');
}

function formatAccountList(items: PublishItemProgress[]): string {
  return items.slice(6).map((i: PublishItemProgress) => nicknameOf(i.accountId)).join('、');
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}分${sec}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

async function openUrl(url: string) {
  try {
    await electronApi.openExternal(url);
  } catch {
    window.open(url, '_blank');
  }
}

async function showDetail(row: any) {
  try {
    const data = await electronApi.getTaskDetail(row.id as string);
    detailData.value = data;
    detailVisible.value = true;
  } catch (err) {
    ElMessage.error('获取详情失败: ' + (err as Error).message);
  }
}

async function retryTask(task: any) {
  try {
    await ElMessageBox.confirm(
      `将重试此任务中失败的账号（成功的账号不会重复发布），确定继续？`,
      '重试发布',
      { type: 'warning' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryPublish(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建重试任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.info('没有需要重试的失败账号');
    }
  } catch (err) {
    ElMessage.error('重试失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

/** 重新测试（测试任务专用） */
async function retryTest(task: any) {
  try {
    await ElMessageBox.confirm(
      `将对所有账号重新执行测试（不真正发布），确定继续？`,
      '重新测试',
      { type: 'info', confirmButtonText: '重新测试' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryAsTest(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建重新测试任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.warning('无法创建重新测试任务');
    }
  } catch (err) {
    ElMessage.error('重新测试失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

/** 立即发布（测试任务转正式发布） */
async function retryAsPublish(task: any) {
  try {
    await ElMessageBox.confirm(
      `将对所有账号立即执行正式发布（会真的发布内容），确定继续？`,
      '立即发布',
      { type: 'warning', confirmButtonText: '立即发布' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryAsPublish(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建发布任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.warning('无法创建发布任务');
    }
  } catch (err) {
    ElMessage.error('发布失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

async function deleteTask(task: any) {
  try {
    await electronApi.deleteTask(task.id as string);
    ElMessage.success('已删除');
    await refresh();
  } catch (err) {
    ElMessage.error('删除失败: ' + (err as Error).message);
  }
}

/**
 * 取消定时发布任务
 */
async function cancelTask(row: any) {
  try {
    await ElMessageBox.confirm(`确定取消任务「${row.id}」的定时发布吗？`, '取消定时发布', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await publishStore.cancelTask(row.id as string);
    ElMessage.success('已取消发布');
    await refresh();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadHistoryPaged(1);
});
</script>

<style scoped>
.empty-hint {
  text-align: center;
  color: #64748b;
  padding: 60px 0;
  font-size: 14px;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 24px;
  padding: 16px 0;
}

/* 美化分页组件 */
.pagination-wrapper :deep(.el-pagination) {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 总条数文本 */
.pagination-wrapper :deep(.el-pagination__total) {
  font-size: 13px;
  color: #64748b;
  font-weight: 600;
  margin-right: 12px;
}

/* 下拉页码选择器 */
.pagination-wrapper :deep(.el-select .el-input__wrapper) {
  border-radius: 8px !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  box-shadow: none !important;
  background: #ffffff !important;
  transition: all 0.25s ease;
  padding: 4px 12px !important;
}

.pagination-wrapper :deep(.el-select .el-input__wrapper:hover),
.pagination-wrapper :deep(.el-select .el-input.is-focus .el-input__wrapper) {
  border-color: rgba(99, 102, 241, 0.3) !important;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.08) !important;
}

/* 按钮及页码通用样式 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next),
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li) {
  background: #ffffff !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  border-radius: 8px !important;
  color: #64748b !important;
  font-weight: 600;
  min-width: 32px !important;
  height: 32px !important;
  line-height: 30px !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
  box-sizing: border-box;
}

/* 页码/按钮 Hover 状态 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev:hover),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next:hover),
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li:not(.is-active):hover) {
  color: #6366f1 !important;
  background: rgba(99, 102, 241, 0.04) !important;
  border-color: rgba(99, 102, 241, 0.2) !important;
  transform: translateY(-1px);
}

/* 激活选中的页码 */
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li.is-active) {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
  color: #ffffff !important;
  border-color: transparent !important;
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.2) !important;
  transform: translateY(-1px);
}

/* 禁用状态 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev:disabled),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next:disabled) {
  background: #f8fafc !important;
  border-color: rgba(0, 0, 0, 0.03) !important;
  color: #cbd5e1 !important;
  cursor: not-allowed;
  transform: none !important;
}

/* 前往页码输入框 */
.pagination-wrapper :deep(.el-pagination__jump) {
  font-size: 13px;
  color: #64748b;
  font-weight: 600;
  margin-left: 12px;
}

.pagination-wrapper :deep(.el-pagination__jump .el-input__wrapper) {
  border-radius: 8px !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  box-shadow: none !important;
  background: #ffffff !important;
  transition: all 0.25s ease;
  width: 44px !important;
  box-sizing: border-box;
}

.pagination-wrapper :deep(.el-pagination__jump .el-input__wrapper:hover),
.pagination-wrapper :deep(.el-pagination__jump .el-input.is-focus .el-input__wrapper) {
  border-color: rgba(99, 102, 241, 0.3) !important;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.08) !important;
}

.detail-content {
  max-height: 60vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding-right: 8px;
}

/* 扁平化元数据网格 */
.task-metadata-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  background: rgba(99, 102, 241, 0.03);
  border: 1px solid rgba(99, 102, 241, 0.12);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-sizing: border-box;
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.02);
}

@media (max-width: 600px) {
  .task-metadata-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-label {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.meta-value {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.meta-value.mono {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  color: #475569;
  font-weight: 500;
}

.task-title-banner {
  background: rgba(99, 102, 241, 0.03);
  border: 1px solid rgba(99, 102, 241, 0.06);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
}

.task-title-banner.remark {
  background: rgba(15, 23, 42, 0.02);
  border-color: rgba(15, 23, 42, 0.04);
}

.banner-label {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.banner-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #6366f1;
}

.banner-remark {
  font-size: 13px;
  color: #1e293b;
  line-height: 1.5;
}

.scheduled-time {
  color: #e6a23c;
  font-weight: 600;
}

.meta-tag-bubble {
  display: inline-block;
  background: rgba(99, 102, 241, 0.06);
  color: #6366f1;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  margin-right: 6px;
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.detail-section {
  margin-top: 16px;
}

.detail-section-title {
  font-weight: 700;
  font-size: 14px;
  color: #1e293b;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.content-preview {
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
  color: #334155;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 150px;
  overflow-y: auto;
}

/* 终端风格日志区 */
.log-container {
  background: #0f172a;
  border-radius: 12px;
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.8;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2);
}

.log-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.log-line:last-child {
  border-bottom: none;
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-level {
  font-weight: 700;
  flex-shrink: 0;
}

.log-info .log-level { color: #38bdf8; }
.log-warn .log-level { color: #f59e0b; }
.log-error .log-level { color: #ef4444; }
.log-debug .log-level { color: #94a3b8; }

.log-platform {
  color: #34d399;
  font-weight: 600;
  flex-shrink: 0;
}

.log-account {
  color: #c084fc;
  font-weight: 600;
  flex-shrink: 0;
}

.log-stage {
  color: #fb7185;
  font-weight: 600;
  flex-shrink: 0;
}

.log-msg {
  color: #e2e8f0;
}

.log-error .log-msg {
  color: #fca5a5;
}

/* 编辑重发表单样式 */
.edit-form {
  padding: 0 8px;
}

.edit-file-list {
  max-height: 160px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  padding: 8px 12px;
}

.edit-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.02);
}

.edit-file-item:last-child {
  border-bottom: none;
}

.edit-file-item .file-name {
  font-size: 13px;
  color: #475569;
  word-break: break-all;
  flex: 1;
  margin-right: 8px;
  font-weight: 500;
}

/* 历史发布卡片流 */
.task-card-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}

.flow-task-card {
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: var(--glass-border);
  border-radius: 16px;
  padding: 20px;
  box-shadow: var(--glow-shadow-sm);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.flow-task-card:hover {
  border-color: rgba(99, 102, 241, 0.18);
  background: rgba(99, 102, 241, 0.04);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -4px rgba(99, 102, 241, 0.08), 0 4px 12px -6px rgba(0, 0, 0, 0.04);
}

.task-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  padding-bottom: 12px;
  margin-bottom: 14px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-id-tag {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-time-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.4;
  font-weight: 500;
}

.scheduled-time {
  color: #d97706;
  font-weight: 600;
}

.task-card-body {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.task-main-info {
  flex: 1;
  min-width: 280px;
}

.task-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 6px 0;
  line-height: 1.4;
}

.task-desc-preview {
  font-size: 13px;
  color: #64748b;
  margin: 0;
  line-height: 1.6;
}

.task-meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.meta-tag {
  font-size: 11px;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.06);
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
}

.task-accounts-section {
  min-width: 250px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.accounts-badge-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 账号结果小徽章 */
.account-result-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid rgba(0, 0, 0, 0.04);
  background: rgba(255, 255, 255, 0.6);
}

.badge-icon {
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.result-success {
  color: #10b981;
  background: rgba(16, 185, 129, 0.04);
  border-color: rgba(16, 185, 129, 0.1);
}

.result-failed,
.result-cancelled {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.04);
  border-color: rgba(239, 68, 68, 0.1);
}

.result-running,
.result-queued {
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.04);
  border-color: rgba(59, 130, 246, 0.1);
}

.badge-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-status-icon {
  font-size: 11px;
  font-weight: 800;
}

.accounts-more-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  background: rgba(0, 0, 0, 0.04);
  color: #64748b;
  cursor: help;
}

.task-card-footer {
  border-top: 1px solid rgba(0, 0, 0, 0.03);
  padding-top: 12px;
  margin-top: auto;
}

.task-actions-group {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.task-actions-group :deep(.el-button) {
  margin: 0 !important;
  font-weight: 700 !important;
  font-size: 12px !important;
  transition: all 0.2s ease !important;
}

.task-actions-group :deep(.el-button--primary:hover) {
  color: #6366f1 !important;
  background-color: rgba(99, 102, 241, 0.06) !important;
}

.task-actions-group :deep(.el-button--warning:hover) {
  color: #e6a23c !important;
  background-color: rgba(230, 162, 60, 0.06) !important;
}

.task-actions-group :deep(.el-button--success:hover) {
  color: #10b981 !important;
  background-color: rgba(16, 185, 129, 0.06) !important;
}

.task-actions-group :deep(.el-button--danger:hover) {
  color: #f56c6c !important;
  background-color: rgba(245, 108, 108, 0.06) !important;
}

/* 测试结果详情 */
.test-results-detail {
  margin-top: 16px;
}
.test-result-item {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 10px;
}
.test-result-item:last-child {
  margin-bottom: 0;
}
.test-result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.test-result-account {
  font-weight: 500;
  color: #606266;
  font-size: 13px;
}
.test-result-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}
.test-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 4px;
  border: 1px solid #f0d9a8;
}
.test-field.filled {
  border-color: #67c23a;
  background: #f0f9eb;
}
.test-field-label {
  font-size: 12px;
  color: #909399;
}
.test-field-value {
  font-size: 13px;
  font-weight: 500;
  color: #606266;
}
.test-field.filled .test-field-value {
  color: #67c23a;
}
.test-result-note {
  font-size: 12px;
  color: #e6a23c;
  margin-top: 8px;
  padding: 6px 10px;
  background: #fffbe6;
  border-radius: 4px;
}
</style>