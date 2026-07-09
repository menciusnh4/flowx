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
            <div class="overview-path" :title="logInfo.mainPath">{{ logInfo.mainPath }}</div>
          </div>
          <div class="overview-item">
            <div class="overview-label">发布日志</div>
            <div class="overview-value">{{ formatSize(logInfo.publishSize) }}</div>
            <div class="overview-path" :title="logInfo.publishPath">{{ logInfo.publishPath }}</div>
          </div>
          <div class="overview-item">
            <div class="overview-label">日志目录</div>
            <div class="overview-value" style="cursor: pointer; color: #409eff;" @click="openLogDir">
              {{ logInfo.logsDir ? '点击打开' : '-' }}
            </div>
            <div class="overview-path" :title="logInfo.logsDir">{{ logInfo.logsDir }}</div>
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
            <div style="margin-top: 12px; color: #909399;">加载中...</div>
          </div>
          <pre v-else class="log-text">{{ filteredContent || '（暂无日志）' }}</pre>
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
  background: #f5f7fa;
}

.panel {
  max-width: 1200px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.config-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.config-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}

.log-overview {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.overview-item {
  padding: 16px;
  background: #f5f7fa;
  border-radius: 6px;
}

.overview-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 8px;
}

.overview-value {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}

.overview-path {
  font-size: 12px;
  color: #c0c4cc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
}

.log-content {
  position: relative;
  height: 500px;
  background: #1e1e1e;
  border-radius: 6px;
  overflow: hidden;
}

.log-loading-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
}

.log-loading-wrap .el-icon.is-loading {
  animation: rotating 1s linear infinite;
  color: #409eff;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.log-text {
  margin: 0;
  padding: 12px;
  height: 100%;
  overflow: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-text::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.log-text::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 4px;
}

.log-text::-webkit-scrollbar-track {
  background: #2d2d2d;
}

.notice-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: #606266;
  line-height: 2;
}

.notice-list li {
  margin-bottom: 4px;
}
</style>
