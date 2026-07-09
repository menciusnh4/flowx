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

      <el-table
        v-loading="publishStore.loading"
        :data="publishStore.history"
        border
        stripe
        style="margin-top: 12px"
      >
        <el-table-column label="任务ID" prop="id" width="170" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="contentTypeTagType(row.request?.contentType)">
              {{ contentTypeLabel(row.request?.contentType) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标题/备注" min-width="200">
          <template #default="{ row }">
            <div style="font-weight:500">{{ row.request?.title || row.request?.remark || '-' }}</div>
            <div style="color:#909399; font-size:12px">
              目标账号：{{ row.items.length }} 个
              <span v-if="row.request?.tags?.length" style="margin-left:8px">
                标签：{{ formatTags(row.request.tags) }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <div style="display:flex; flex-direction:column; gap:4px;">
              <el-tag v-if="row.status === 'success'" type="success">成功</el-tag>
              <el-tag v-else-if="row.status === 'failed'" type="danger">失败</el-tag>
              <el-tag v-else-if="row.status === 'running'" type="primary">发布中</el-tag>
              <el-tag v-else-if="row.status === 'cancelled'" type="info">已取消</el-tag>
              <el-tag v-else-if="row.status === 'scheduled'" type="warning">待发布</el-tag>
              <el-tag v-else type="info">{{ row.status }}</el-tag>
              <el-tag v-if="isTestTask(row)" type="warning" size="small" effect="plain">🔍 测试</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="各账号结果" min-width="240">
          <template #default="{ row }">
            <el-space wrap>
              <el-tag
                v-for="item in row.items.slice(0, 4)"
                :key="item.accountId"
                size="small"
                :type="itemStatusTagType(item.status)"
              >
                {{ nicknameOf(item.accountId) }}
                <span v-if="item.status === 'success'">✓</span>
                <span v-else-if="item.status === 'failed'">✗</span>
              </el-tag>
              <el-tooltip
                v-if="row.items.length > 4"
                :content="formatAccountList(row.items)"
              >
                <span style="color:#909399; font-size:12px; cursor:help">
                  +{{ row.items.length - 4 }}
                </span>
              </el-tooltip>
            </el-space>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            <div style="font-size:13px; color:#303133">创建：{{ fmt(row.createdAt) }}</div>
            <div v-if="row.request?.scheduledAt" style="font-size:12px; color:#e6a23c; margin-top:3px">
              定时：{{ fmt(row.request.scheduledAt) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="showDetail(row)">
              <el-icon><View /></el-icon>&nbsp;详情
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
              title="确定删除此历史记录？"
              @confirm="deleteTask(row)"
            >
              <template #reference>
                <el-button size="small" type="danger" link>
                  <el-icon><Delete /></el-icon>&nbsp;删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

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
        <!-- 基本信息 -->
        <el-descriptions :column="2" border size="small" style="margin-bottom:16px">
          <el-descriptions-item label="任务ID">{{ detailData.task.id }}</el-descriptions-item>
          <el-descriptions-item label="内容类型">
            {{ contentTypeLabel(detailData.task.request?.contentType) }}
          </el-descriptions-item>
          <el-descriptions-item label="整体状态">
            <div style="display:flex; align-items:center; gap:8px;">
              <el-tag :type="statusTagType(detailData.task.status)" size="small">
                {{ statusLabel(detailData.task.status) }}
              </el-tag>
              <el-tag v-if="isTestTask(detailData.task)" type="warning" size="small" effect="plain">
                🔍 测试模式
              </el-tag>
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="账号数量">
            {{ detailData.task.items.length }} 个
          </el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">
            {{ detailData.task.request?.title || '-' }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detailData.task.request?.remark" label="备注" :span="2">
            {{ detailData.task.request.remark }}
          </el-descriptions-item>
          <el-descriptions-item label="创建时间">
            {{ fmt(detailData.task.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="更新时间">
            {{ fmt(detailData.task.updatedAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detailData.task.request?.scheduledAt" label="定时发布" :span="2">
            <span style="color:#e6a23c; font-weight:600">{{ fmt(detailData.task.request.scheduledAt) }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="detailData.task.request?.tags?.length" label="标签" :span="2">
            <el-tag v-for="t in detailData.task.request.tags" :key="t" size="small" style="margin-right:4px">
              #{{ t }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

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
  return items.slice(4).map((i: PublishItemProgress) => nicknameOf(i.accountId)).join('、');
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
  color: #909399;
  padding: 60px 0;
  font-size: 14px;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 20px;
  padding: 16px 0;
}

.detail-content {
  max-height: 60vh;
  overflow-y: auto;
}

.detail-section {
  margin-top: 16px;
}

.detail-section-title {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #ebeef5;
}

.content-preview {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 12px;
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
}

.log-container {
  background: #1e1e1e;
  border-radius: 4px;
  padding: 10px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  max-height: 260px;
  overflow-y: auto;
}

.log-line {
  line-height: 1.6;
  word-break: break-all;
}

.log-time {
  color: #888;
  margin-right: 6px;
}

.log-level {
  margin-right: 4px;
}

.log-info .log-level { color: #4fc3f7; }
.log-warn .log-level { color: #ffb74d; }
.log-error .log-level { color: #ef5350; }
.log-debug .log-level { color: #888; }

.log-platform {
  color: #81c784;
  margin-right: 4px;
}

.log-account {
  color: #ba68c8;
  margin-right: 4px;
}

.log-stage {
  color: #ffd54f;
  margin-right: 4px;
}

.log-msg {
  color: #e0e0e0;
}

.log-error .log-msg {
  color: #ef9a9a;
}

/* 编辑重发表单样式 */
.edit-form {
  padding: 0 8px;
}

.edit-file-list {
  max-height: 160px;
  overflow-y: auto;
  background: #fafafa;
  border-radius: 4px;
  padding: 8px;
}

.edit-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid #ebeef5;
}

.edit-file-item:last-child {
  border-bottom: none;
}

.edit-file-item .file-name {
  font-size: 12px;
  color: #606266;
  word-break: break-all;
  flex: 1;
  margin-right: 8px;
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
