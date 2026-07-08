<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { usePublishStore } from '../stores/publish'
import { useAccountStore } from '../stores/account'
import { useDraftStore } from '../stores/draft'
import { electronApi } from '../utils/electron'
import type { PublishRequest, PlatformType, PublishDraft } from '../../types'
import PublishForm from '../components/PublishForm.vue'

const route = useRoute()
const accountStore = useAccountStore()
const publishStore = usePublishStore()
const draftStore = useDraftStore()

// ============ UI ============
const showDebug = ref(false)
const loadingDraft = ref(false)
// el-collapse 在 accordion=false 时接收 string[]，用 Set 也不行；
// 这里用数组 + 响应式替换来保证 UI 同步
const openTaskIds = ref<string[]>([])

// ============ PublishForm 引用 ============
const publishFormRef = ref<InstanceType<typeof PublishForm> | null>(null)

// ============ 初始化 ============
onMounted(async () => {
  console.log('[Publish.vue] mounted, ensuring listener + loading accounts')
  publishStore.ensureListener()
  try {
    if (accountStore.accounts.length === 0) {
      console.log('[Publish.vue] accountStore is empty, calling refreshAccounts')
      await accountStore.refreshAccounts()
    }
    if (accountStore.platforms.length === 0) {
      await accountStore.loadPlatforms()
    }
  } catch (e) {
    console.error('[Publish.vue] account refresh failed', e)
  }
  console.log('[Publish.vue] init done. accountsCount=', accountStore.accounts.length)

  // 如果 URL 带了 draftId，加载草稿
  const draftId = route.query.draftId as string
  if (draftId) {
    await loadDraft(draftId)
  }
})

// ============ 加载草稿 ============
async function loadDraft(draftId: string) {
  loadingDraft.value = true
  try {
    const draft = await draftStore.getDraft(draftId)
    if (!draft) {
      ElMessage.warning('草稿不存在或已被删除')
      return
    }
    // 等待 PublishForm 组件就绪
    await nextTick()
    if (!publishFormRef.value) return

    const fd = draft.formData as Record<string, unknown> || {}
    publishFormRef.value.fillForm({
      contentType: (draft.contentType as 'video' | 'image' | 'article') || 'video',
      title: draft.title || '',
      content: (fd.content as string) || '',
      tags: (fd.tagsRaw as string)?.split(/[,，\s]+/).map((t: string) => t.trim()).filter(Boolean) || [],
      mediaFiles: (fd.mediaFiles as string[]) || [],
      coverImage: (fd.coverImage as string) || '',
      accountIds: (fd.selectedAccountIds as string[]) || [],
    })

    // 设置当前草稿 ID，用于自动保存
    draftStore.setCurrentDraft(draftId)
    ElMessage.success('已加载草稿')
  } catch (e) {
    console.error('[Publish.vue] load draft error', e)
    ElMessage.error('加载草稿失败')
  } finally {
    loadingDraft.value = false
  }
}

// ============ 提交发布 ============
async function handleSubmit(req: PublishRequest) {
  try {
    publishStore.ensureListener()
    const taskId = await publishStore.submit(req)
    ElMessage.success(`任务已提交：${taskId}`)
    // 让新任务在折叠面板里默认展开
    openTaskIds.value = [...new Set([...openTaskIds.value, taskId])]
  } catch (e) {
    console.error('[Publish.vue] submit error', e)
    ElMessage.error(`发布失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ============ 提交测试发布 ============
async function handleTestSubmit(req: PublishRequest) {
  try {
    publishStore.ensureListener()
    const taskId = await publishStore.submit(req)
    ElMessage.success(`测试任务已提交：${taskId}`)
    // 让新任务在折叠面板里默认展开
    openTaskIds.value = [...new Set([...openTaskIds.value, taskId])]
  } catch (e) {
    console.error('[Publish.vue] test submit error', e)
    ElMessage.error(`测试失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
// ============ 工具函数 ============
function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function statusLabel(s?: string): string {
  switch (s) {
    case 'queued': return '排队中'
    case 'running': return '发布中'
    case 'success': return '成功'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return s || '-'
  }
}

function platformName(p?: string): string {
  if (!p) return '-'
  const map: Record<string, string> = {
    douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书',
    bilibili: '哔哩哔哩', wechat_channels: '微信视频号', video: '视频号',
    zhihu: '知乎', toutiao: '今日头条',
  }
  return map[p] || p
}

function iconOf(platform?: string): string {
  const map: Record<string, string> = {
    douyin: '🎵', kuaishou: '⚡', xiaohongshu: '📕', bilibili: '📺', wechat_channels: '🎬',
    zhihu: '💡', toutiao: '📰',
  }
  return map[platform ?? ''] || '🔘'
}

function nicknameOf(accountId: string): string {
  const a = accountStore.accounts.find((x) => x.id === accountId)
  return a?.nickname || accountId
}

function toggleDebug() {
  showDebug.value = !showDebug.value
  console.log('[Publish.vue] showDebug=', showDebug.value, 'logCount=', publishStore.logs.length)
}

function clearTask(taskId: string) {
  console.log('[Publish.vue] clearTask', taskId)
  publishStore.remove(taskId)
  openTaskIds.value = openTaskIds.value.filter((x) => x !== taskId)
}

function platformFromAccountId(accountId: string): PlatformType | undefined {
  const a = accountStore.accounts.find((x) => x.id === accountId)
  return a?.platform
}
</script>

<template>
  <div class="publish-page">
    <PublishForm ref="publishFormRef" @submit="handleSubmit" @test-submit="handleTestSubmit">
      <template #footer-extra>
        <el-button @click="toggleDebug" :type="showDebug ? 'warning' : 'default'">
          {{ showDebug ? '隐藏调试日志' : '调试模式' }}（{{ publishStore.logs.length }}）
        </el-button>
      </template>
    </PublishForm>

    <!-- ==================== 任务进行中 ==================== -->
    <div v-if="publishStore.hasLiveTasks" class="panel">
      <h2 class="section-title">任务进行中（{{ Object.keys(publishStore.liveTasks).length }}）</h2>
      <el-collapse v-model="openTaskIds">
        <el-collapse-item
          v-for="t in publishStore.liveList"
          :key="t.taskId"
          :name="t.taskId"
          :title="`任务 ${t.taskId.slice(0, 14)} | ${statusLabel(t.status)} | ${Math.round(t.overallProgress)}% | ${formatTime(t.startedAt)}`"
        >
          <div class="task-meta">
            <span>标题：{{ t.request.title }}</span>
            <span>类型：{{ t.request.contentType }}</span>
            <span>账号数：{{ t.request.accountIds.length }}</span>
            <el-button size="small" type="danger" link @click.stop="clearTask(t.taskId)">移除</el-button>
          </div>
          <el-progress
            :percentage="Math.round(t.overallProgress)"
            :status="t.status === 'success' ? 'success' : t.status === 'failed' ? 'exception' : undefined"
          />
          <el-table :data="t.items" size="small" style="margin-top: 10px;">
            <el-table-column label="账号" min-width="200">
              <template #default="{ row }">
                <span>{{ iconOf(platformFromAccountId(row.accountId)) }} {{ nicknameOf(row.accountId) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="平台" width="120">
              <template #default="{ row }">{{ platformName(platformFromAccountId(row.accountId)) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'success'" type="success" size="small">成功</el-tag>
                <el-tag v-else-if="row.status === 'failed'" type="danger" size="small">失败</el-tag>
                <el-tag v-else-if="row.status === 'running'" type="primary" size="small">发布中</el-tag>
                <el-tag v-else size="small">队列</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" width="200">
              <template #default="{ row }">
                <el-progress :percentage="Math.round(row.progress ?? 0)" :stroke-width="10" />
              </template>
            </el-table-column>
            <el-table-column prop="message" label="详情" min-width="220" show-overflow-tooltip />
            <el-table-column label="链接" width="120">
              <template #default="{ row }">
                <el-link v-if="row.resultUrl" type="primary" :href="row.resultUrl" target="_blank" :disabled="false">查看</el-link>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="测试结果" width="140">
              <template #default="{ row }">
                <el-tag v-if="row.testResult" type="success" size="small">测试完成</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>

          <!-- 测试结果详情 -->
          <div v-if="t.items.some((item: any) => item.testResult)" class="test-results">
            <h3 class="test-results-title">🔍 测试结果详情</h3>
            <div v-for="item in t.items.filter((i: any) => i.testResult)" :key="item.accountId" class="test-result-item">
              <div class="test-result-header">
                <span class="test-result-account">
                  {{ iconOf(platformFromAccountId(item.accountId)) }} {{ nicknameOf(item.accountId) }}
                  （{{ platformName(platformFromAccountId(item.accountId)) }}）
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
              <div v-if="item.testResult?.formFields && item.testResult?.formFields.length > 0" class="test-fields-detail">
                <div class="test-fields-detail-title">检测到的表单字段：</div>
                <div class="test-fields-list">
                  <span v-for="(field, idx) in item.testResult?.formFields" :key="idx"
                        class="test-field-chip" :class="{ filled: field.filled }">
                    {{ field.label || field.type }}：{{ field.filled ? '✓' : '✗' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- ==================== 调试日志面板 ==================== -->
    <div v-if="showDebug" class="panel">
      <h2 class="section-title">实时调试日志（最近 {{ publishStore.logs.length }} 条）</h2>
      <div class="debug-hint">
        打开浏览器 DevTools (Ctrl+Shift+I) 可查看 console 实时日志；这里同时记录关键事件。
      </div>
      <div class="debug-actions">
        <el-button size="small" @click="() => { console.log('[Publish.vue] store dump:', { liveTasks: publishStore.liveTasks, logs: publishStore.logs }); ElMessage.info('已输出到 console'); }">
          把 store 打印到 console
        </el-button>
        <el-button size="small" @click="() => { console.log('[Publish.vue] accountStore:', accountStore.accounts); }">
          打印账号列表
        </el-button>
      </div>
      <div class="debug-log">
        <div v-for="(l, idx) in publishStore.logs" :key="idx" class="log-line" :class="l.level">
          <span class="log-time">{{ formatTime(l.ts) }}</span>
          <span class="log-level">[{{ l.level === 'info' ? 'INFO' : l.level === 'warn' ? 'WARN' : 'ERR' }}]</span>
          <span class="log-msg">{{ l.msg }}</span>
          <span v-if="l.data" class="log-data">{{ JSON.stringify(l.data) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.publish-page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #303133;
}

/* 调试日志 */
.debug-hint { font-size: 12px; color: #909399; margin-bottom: 6px; }
.debug-actions { margin-bottom: 10px; display: flex; gap: 8px; }
.debug-log {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 10px;
  border-radius: 4px;
  max-height: 420px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.7;
}
.log-line { display: flex; gap: 6px; flex-wrap: wrap; }
.log-line.warn { color: #e5c07b; }
.log-line.error { color: #f48771; }
.log-time { color: #858585; flex-shrink: 0; }
.log-level { color: #6a9955; flex-shrink: 0; }
.log-msg { color: #d4d4d4; }
.log-data { color: #858585; margin-left: 4px; word-break: break-all; }
.empty { padding: 20px 0; }
.task-meta { display: flex; gap: 20px; color: #606266; font-size: 13px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }

/* 测试结果 */
.test-results {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed #e4e7ed;
}
.test-results-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #e6a23c;
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
.test-fields-detail {
  margin-top: 10px;
}
.test-fields-detail-title {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}
.test-fields-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.test-field-chip {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 10px;
  background: #fef0f0;
  color: #f56c6c;
  border: 1px solid #fbc4c4;
}
.test-field-chip.filled {
  background: #f0f9eb;
  color: #67c23a;
  border-color: #c2e7b0;
}
</style>