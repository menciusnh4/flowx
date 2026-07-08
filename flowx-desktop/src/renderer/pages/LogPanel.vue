<template>
  <div class="log-panel">
    <div class="panel">
      <div class="header">
        <h2 class="section-title">日志管理</h2>
        <div class="header-actions">
          <el-button size="small" @click="openLogDir">
            <el-icon><FolderOpened /></el-icon>
            <span>打开日志目录</span>
          </el-button>
          <el-button size="small" type="primary" @click="exportAll">
            <el-icon><Download /></el-icon>
            <span>导出全部日志</span>
          </el-button>
        </div>
      </div>

      <!-- 日志概览 -->
      <div class="config-card">
        <div class="config-title">日志概览</div>
        <div class="log-overview">
          <div class="overview-item">
            <div class="overview-label">主日志</div>
            <div class="overview-value">{{ formatSize(logInfo.mainSize) }}</div>
            <el-tooltip :content="logInfo.mainPath" placement="top" effect="dark" :show-after="100">
              <div class="overview-path">{{ logInfo.mainPath }}</div>
            </el-tooltip>
          </div>
          <div class="overview-item">
            <div class="overview-label">发布日志</div>
            <div class="overview-value">{{ formatSize(logInfo.publishSize) }}</div>
            <el-tooltip :content="logInfo.publishPath" placement="top" effect="dark" :show-after="100">
              <div class="overview-path">{{ logInfo.publishPath }}</div>
            </el-tooltip>
          </div>
          <div class="overview-item">
            <div class="overview-label">日志目录</div>
            <div class="overview-value" @click="openLogDir">
              {{ logInfo.logsDir ? '点击打开' : '-' }}
            </div>
            <el-tooltip :content="logInfo.logsDir" placement="top" effect="dark" :show-after="100">
              <div class="overview-path">{{ logInfo.logsDir }}</div>
            </el-tooltip>
          </div>
        </div>
      </div>

      <!-- 日志查看 -->
      <div class="config-card">
        <div class="config-title">
          日志查看
          <span style="margin-left: 12px; font-size: 12px; font-weight: normal; color: #909399;">
            显示最新 {{ lineLimit }} 行
          </span>
        </div>

        <!-- 工具栏 -->
        <div class="log-toolbar">
          <el-radio-group v-model="activeTab" size="small" @change="onTabChange">
            <el-radio-button value="publish">发布日志</el-radio-button>
            <el-radio-button value="main">主日志</el-radio-button>
          </el-radio-group>

          <div class="toolbar-right">
            <el-select v-model="selectedDate" size="small" style="width: 140px; margin-right: 8px;" @change="loadLogs">
              <el-option
                v-for="f in logFileList"
                :key="f.date"
                :label="f.date + ' (' + formatSize(f.size) + ')'"
                :value="f.date"
              />
            </el-select>
            <el-select v-model="lineLimit" size="small" style="width: 120px; margin-right: 8px;" @change="loadLogs">
              <el-option label="最近 100 行" :value="100" />
              <el-option label="最近 500 行" :value="500" />
              <el-option label="最近 1000 行" :value="1000" />
              <el-option label="最近 2000 行" :value="2000" />
            </el-select>
            <el-input
              v-model="searchKeyword"
              size="small"
              placeholder="搜索关键词..."
              style="width: 200px; margin-right: 8px;"
              clearable
              @keyup.enter="applyFilter"
              @clear="applyFilter"
            />
            <el-button size="small" @click="refreshLogs" :loading="loading">
              <el-icon><Refresh /></el-icon>
              <span>刷新</span>
            </el-button>
            <el-button size="small" type="primary" @click="exportCurrent" style="margin-left: 8px;">
              <el-icon><Download /></el-icon>
              <span>导出</span>
            </el-button>
            <el-button v-if="activeTab === 'publish'" size="small" type="danger" plain @click="clearPublishLogs" style="margin-left: 8px;">
              <el-icon><Delete /></el-icon>
              <span>清空内存日志</span>
            </el-button>
          </div>
        </div>

        <!-- 日志内容 -->
        <div class="log-content" ref="logContentRef">
          <div v-if="loading" class="log-loading-wrap">
            <el-icon class="is-loading" :size="32"><Loading /></el-icon>
            <div style="margin-top: 12px; color: #94a3b8;">加载中...</div>
          </div>
          <pre v-else class="log-text" v-html="highlightedContent"></pre>
        </div>
      </div>

      <!-- 使用说明 -->
      <div class="config-card">
        <div class="config-title">使用说明</div>
        <ul class="notice-list">
          <li>主日志记录应用运行时的所有常规日志，包括启动、错误、警告等信息</li>
          <li>发布日志记录一键发布流程的详细日志，包括每个平台的发布步骤和调试信息</li>
          <li>日志文件有大小限制（主日志 10MB，发布日志 20MB），超出会自动滚动覆盖</li>
          <li>遇到问题时，可以导出日志文件发给技术支持排查</li>
          <li>"清空内存日志"仅清空内存中的发布日志缓冲，不影响磁盘上的日志文件</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Download, FolderOpened, Delete, Loading } from '@element-plus/icons-vue';
import { electronApi } from '../utils/electron';

const activeTab = ref<'publish' | 'main'>('publish');
const lineLimit = ref(500);
const searchKeyword = ref('');
const loading = ref(true);
const rawContent = ref('');
const logContentRef = ref<HTMLElement | null>(null);
const selectedDate = ref<string>('');
const logFileList = ref<{ date: string; path: string; size: number }[]>([]);

const logInfo = ref({
  mainSize: 0,
  publishSize: 0,
  logsDir: '',
  mainPath: '',
  publishPath: '',
});

const filteredContent = computed(() => {
  if (!searchKeyword.value) return rawContent.value;
  const kw = searchKeyword.value.toLowerCase();
  return rawContent.value
    .split('\n')
    .filter(line => line.toLowerCase().includes(kw))
    .join('\n');
});

const highlightedContent = computed(() => {
  let text = filteredContent.value;
  if (!text) return '<span style="color: #64748b;">（暂无日志）</span>';
  
  // HTML 转义，防止原始日志中包含 HTML 特殊字符（如 <, >, &）导致渲染错乱
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 精准正则匹配高亮日志等级与常见关键词
  // 1. [info]/[INFO]
  text = text.replace(/(\[info\]|\[INFO\])/ig, '<span class="lvl-info">$1</span>');
  // 2. [warn]/[WARN]/[warning]
  text = text.replace(/(\[warn\]|\[WARN\]|\[warning\]|\[WARNING\])/ig, '<span class="lvl-warn">$1</span>');
  // 3. [error]/[ERROR]/[err]/[ERR]
  text = text.replace(/(\[error\]|\[ERROR\]|\[err\]|\[ERR\])/ig, '<span class="lvl-error">$1</span>');
  // 4. [success]/[SUCCESS]
  text = text.replace(/(\[success\]|\[SUCCESS\])/ig, '<span class="lvl-success">$1</span>');
  
  // 常见的时间戳高亮（支持 2026-07-10 12:34:56 以及 [12:34:56.789]）
  text = text.replace(/(\b\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\.\d{3})?\b)/g, '<span class="lvl-time">$1</span>');
  text = text.replace(/(\[\d{2}:\d{2}:\d{2}(?:\.\d{3})?\])/g, '<span class="lvl-time">$1</span>');

  return text;
});

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadLogInfo() {
  try {
    const info = await electronApi.getLogFileInfo();
    logInfo.value = info;
  } catch (e) {
    console.error('加载日志信息失败', e);
  }
}

async function loadLogFileList() {
  try {
    const files = await electronApi.listLogFiles(activeTab.value);
    logFileList.value = files;
    // 默认选择最新的（第一个）
    if (files.length > 0 && !selectedDate.value) {
      selectedDate.value = files[0].date;
    }
  } catch (e) {
    console.error('加载日志文件列表失败', e);
  }
}

async function loadLogs() {
  loading.value = true;
  try {
    const options: { limit: number; date?: string } = { limit: lineLimit.value };
    if (selectedDate.value) {
      options.date = selectedDate.value;
    }
    if (activeTab.value === 'publish') {
      rawContent.value = await electronApi.readPublishLog(options);
    } else {
      rawContent.value = await electronApi.readMainLog(options);
    }
    await nextTick();
    scrollToBottom();
  } catch (e) {
    ElMessage.error('加载日志失败: ' + (e as Error).message);
  } finally {
    loading.value = false;
  }
}

function scrollToBottom() {
  if (logContentRef.value) {
    const pre = logContentRef.value.querySelector('.log-text');
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
    }
  }
}

function onTabChange() {
  searchKeyword.value = '';
  selectedDate.value = '';
  loadLogFileList();
  loadLogs();
}

function applyFilter() {
  // 搜索通过 computed 自动应用
}

async function refreshLogs() {
  await loadLogInfo();
  await loadLogFileList();
  await loadLogs();
  ElMessage.success('已刷新');
}

async function openLogDir() {
  try {
    await electronApi.openLogDirectory();
  } catch (e) {
    ElMessage.error('打开日志目录失败');
  }
}

async function exportCurrent() {
  try {
    const type = activeTab.value;
    const result = await electronApi.exportLog(type);
    if (result.ok) {
      ElMessage.success('导出成功');
    } else if (result.error !== '用户取消') {
      ElMessage.error('导出失败: ' + result.error);
    }
  } catch (e) {
    ElMessage.error('导出失败: ' + (e as Error).message);
  }
}

async function exportAll() {
  try {
    const result = await electronApi.exportLog('all');
    if (result.ok) {
      ElMessage.success('导出成功，日志已保存到: ' + result.path);
    } else if (result.error !== '用户取消') {
      ElMessage.error('导出失败: ' + result.error);
    }
  } catch (e) {
    ElMessage.error('导出失败: ' + (e as Error).message);
  }
}

async function clearPublishLogs() {
  try {
    await ElMessageBox.confirm(
      '确定要清空内存中的发布日志吗？此操作不会删除磁盘上的日志文件。',
      '确认清空',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    await electronApi.clearPublishLogMemory();
    ElMessage.success('已清空内存日志');
    loadLogs();
  } catch {
    // 用户取消
  }
}

onMounted(async () => {
  try {
    await loadLogFileList();
    await loadLogs();
    loadLogInfo(); // 概览信息后台加载，不阻塞
  } catch (e) {
    console.error('初始化日志页面失败', e);
  }
});
</script>

<style scoped>
.log-panel {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
  background: transparent;
}

.panel {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.header-actions {
  display: flex;
  gap: 10px;
}

/* 按钮统一精细样式 */
.header-actions :deep(.el-button),
.toolbar-right :deep(.el-button) {
  border-radius: 20px !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  padding: 8px 16px !important;
  height: auto !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.header-actions :deep(.el-button:first-child) {
  border: 1px solid rgba(99, 102, 241, 0.15) !important;
  background: rgba(99, 102, 241, 0.03) !important;
  color: #6366f1 !important;
}

.header-actions :deep(.el-button:first-child:hover) {
  background: #6366f1 !important;
  color: #ffffff !important;
  border-color: #6366f1 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2) !important;
}

.header-actions :deep(.el-button--primary) {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
  border: none !important;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.25) !important;
}

.header-actions :deep(.el-button--primary:hover) {
  transform: translateY(-1.5px);
  box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4) !important;
}

/* ======== 配置卡片 ======== */
.config-card {
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.02);
  box-sizing: border-box;
}

.config-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

/* ======== 日志概览 ======== */
.log-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.overview-item {
  padding: 18px 22px;
  border-radius: 14px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.01);
  box-sizing: border-box;
  min-width: 0;
}

.overview-item:hover {
  transform: translateY(-3px);
}

.overview-item:first-child {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, #ffffff 100%);
  border: 1px solid rgba(99, 102, 241, 0.12);
}
.overview-item:first-child:hover {
  border-color: rgba(99, 102, 241, 0.25);
  box-shadow: 0 10px 24px -4px rgba(99, 102, 241, 0.1);
}

.overview-item:nth-child(2) {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.04) 0%, #ffffff 100%);
  border: 1px solid rgba(16, 185, 129, 0.12);
}
.overview-item:nth-child(2):hover {
  border-color: rgba(16, 185, 129, 0.25);
  box-shadow: 0 10px 24px -4px rgba(16, 185, 129, 0.1);
}

.overview-item:nth-child(3) {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.04) 0%, #ffffff 100%);
  border: 1px solid rgba(14, 165, 233, 0.12);
}
.overview-item:nth-child(3):hover {
  border-color: rgba(14, 165, 233, 0.25);
  box-shadow: 0 10px 24px -4px rgba(14, 165, 233, 0.1);
}

.overview-label {
  font-size: 11px;
  color: #64748b;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
  letter-spacing: 0.02em;
}

.overview-value {
  font-size: 24px;
  font-weight: 800;
  color: #1e293b;
  margin-bottom: 6px;
  line-height: 1.1;
}

.overview-item:nth-child(3) .overview-value {
  color: #6366f1;
  font-weight: 800;
  transition: all 0.25s ease;
}
.overview-item:nth-child(3) .overview-value:hover {
  color: #4f46e5;
  text-decoration: underline;
}

.overview-path {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ======== 工具栏与操作 ======== */
.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 升级 Element 输入选单圆角 */
.toolbar-right :deep(.el-input__wrapper) {
  border-radius: 8px !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04) inset !important;
  background: #ffffff !important;
  padding: 4px 10px !important;
}

.toolbar-right :deep(.el-input__wrapper.is-focus),
.toolbar-right :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px #6366f1 inset, 0 0 0 4px rgba(99, 102, 241, 0.12) !important;
}

/* 控制台普通操作按钮美化 */
.toolbar-right :deep(.el-button) {
  border: 1px solid rgba(0, 0, 0, 0.06) !important;
  background: #ffffff !important;
  color: #475569 !important;
}

.toolbar-right :deep(.el-button:hover) {
  color: #6366f1 !important;
  border-color: rgba(99, 102, 241, 0.2) !important;
  background: rgba(99, 102, 241, 0.03) !important;
}

/* 导出当前按钮美化 */
.toolbar-right :deep(.el-button--primary) {
  border: 1px solid rgba(99, 102, 241, 0.15) !important;
  background: rgba(99, 102, 241, 0.03) !important;
  color: #6366f1 !important;
}

.toolbar-right :deep(.el-button--primary:hover) {
  background: #6366f1 !important;
  color: #ffffff !important;
  border-color: #6366f1 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2) !important;
}

/* 危险删除按钮美化 */
.toolbar-right :deep(.el-button--danger) {
  border: 1px solid rgba(239, 68, 68, 0.15) !important;
  background: rgba(239, 68, 68, 0.03) !important;
  color: #ef4444 !important;
}

.toolbar-right :deep(.el-button--danger:hover) {
  background: #ef4444 !important;
  color: #ffffff !important;
  border-color: #ef4444 !important;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2) !important;
}

/* ======== 极客暗黑控制台 ======== */
.log-content {
  position: relative;
  height: 520px;
  background: #0f172a !important; /* 深邃太空暗蓝 */
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5), 0 10px 30px rgba(0, 0, 0, 0.15);
}

.log-loading-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #94a3b8;
  background: #0f172a;
}

.log-loading-wrap .el-icon.is-loading {
  animation: rotating 1s linear infinite;
  color: #6366f1 !important;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.log-text {
  margin: 0;
  padding: 16px 20px;
  height: 100%;
  overflow: auto;
  font-family: "Fira Code", "JetBrains Mono", "Consolas", "Monaco", monospace;
  font-size: 12px;
  line-height: 1.65;
  color: #cbd5e1;
  white-space: pre-wrap;
  word-break: break-all;
  box-sizing: border-box;
}

/* 彩色等级语法高亮 */
:deep(.lvl-info) {
  color: #38bdf8 !important; /* 淡蓝 */
  font-weight: 600;
}
:deep(.lvl-warn) {
  color: #fbbf24 !important; /* 亮金黄 */
  font-weight: 600;
}
:deep(.lvl-error) {
  color: #f87171 !important; /* 玫瑰红 */
  font-weight: 700;
}
:deep(.lvl-success) {
  color: #4ade80 !important; /* 薄荷绿 */
  font-weight: 600;
}
:deep(.lvl-time) {
  color: #475569 !important; /* 优雅的暗银时间 */
  font-family: monospace;
}

/* 扁平化滚动条 */
.log-text::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.log-text::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  transition: background 0.2s ease;
}

.log-text::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}

.log-text::-webkit-scrollbar-track {
  background: transparent;
}

/* ======== 使用说明 ======== */
.notice-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: #475569;
  line-height: 2.1;
}

.notice-list li {
  margin-bottom: 6px;
  position: relative;
}

.notice-list li::marker {
  color: #6366f1;
}
</style>
