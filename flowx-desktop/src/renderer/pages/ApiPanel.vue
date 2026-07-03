<template>
  <div class="api-panel">
    <div class="panel">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <h2 class="section-title" style="margin: 0;">对外接口</h2>
        <el-tag :type="apiRunning ? 'success' : 'info'" size="small">
          {{ apiRunning ? '服务运行中' : '服务未启动' }}
        </el-tag>
      </div>

      <!-- 服务配置 -->
      <div class="config-card">
        <div class="config-title">服务配置</div>
        <el-form label-width="100px" style="max-width: 500px; margin-top: 16px;">
          <el-form-item label="启用服务">
            <el-switch v-model="config.enabled" @change="onEnabledChange" />
            <span style="margin-left: 12px; font-size: 12px; color: #909399;">
              启用后，本机应用将在指定端口提供 HTTP API 接口
            </span>
          </el-form-item>

          <el-form-item label="监听端口">
            <el-input-number
              v-model="config.port"
              :min="1024"
              :max="65535"
              :disabled="apiRunning"
              style="width: 200px;"
            />
            <span style="margin-left: 12px; font-size: 12px; color: #909399;">
              运行时不可修改
            </span>
          </el-form-item>

          <el-form-item label="API Key">
            <el-input
              v-model="config.apiKey"
              placeholder="留空则不验证（不推荐）"
              show-password
              style="width: 300px;"
            />
            <span style="margin-left: 12px; font-size: 12px; color: #909399;">
              请求时通过 X-API-Key 请求头或 Authorization: Bearer 传递
            </span>
          </el-form-item>

          <el-form-item>
            <el-button type="primary" @click="saveConfig" :loading="saving">
              保存配置
            </el-button>
            <el-button v-if="apiRunning" type="danger" @click="stopServer">
              停止服务
            </el-button>
            <el-button v-else type="success" @click="startServer">
              启动服务
            </el-button>
          </el-form-item>
        </el-form>
      </div>

      <!-- 接口文档 -->
      <div class="config-card">
        <div class="config-title">
          接口文档
          <span style="margin-left: 12px; font-size: 12px; font-weight: normal; color: #909399;">
            Base URL: http://127.0.0.1:{{ config.port }}
          </span>
        </div>

        <div class="api-list">
          <!-- 健康检查 -->
          <div class="api-item">
            <div class="api-header">
              <span class="method method-get">GET</span>
              <span class="api-path">/api/health</span>
              <span class="api-desc">健康检查</span>
            </div>
            <div class="api-detail">
              <div class="detail-section">
                <div class="detail-label">响应示例：</div>
                <pre class="code-block">{
  "status": "ok",
  "timestamp": 1719999999999
}</pre>
              </div>
            </div>
          </div>

          <!-- 获取账号列表 -->
          <div class="api-item">
            <div class="api-header" @click="toggleApi('accounts')">
              <span class="method method-get">GET</span>
              <span class="api-path">/api/accounts</span>
              <span class="api-desc">获取账号列表</span>
              <el-icon class="expand-icon">{{ expandedApis.includes('accounts') ? 'ArrowUp' : 'ArrowDown' }}</el-icon>
            </div>
            <div v-show="expandedApis.includes('accounts')" class="api-detail">
              <div class="detail-section">
                <div class="detail-label">查询参数：</div>
                <table class="param-table">
                  <thead>
                    <tr><th>参数名</th><th>类型</th><th>必填</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>platform</td><td>string</td><td>否</td><td>按平台过滤，如 douyin、kuaishou、xiaohongshu</td></tr>
                    <tr><td>status</td><td>string</td><td>否</td><td>按状态过滤：active / expired / disabled</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="detail-section">
                <div class="detail-label">响应示例：</div>
                <pre class="code-block">{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "acc_xxxxxxxx",
      "platform": "douyin",
      "nickname": "测试账号",
      "avatar": "https://...",
      "userId": "MS4wLjAB...",
      "platformAccountId": "抖音号",
      "fansCount": 1000,
      "followCount": 100,
      "likeCount": 5000,
      "status": "active",
      "remark": "",
      "categoryIds": [],
      "categoryNames": [],
      "envId": "",
      "capabilities": {
        "publishVideo": true,
        "publishImage": true,
        "publishArticle": false
      },
      "authorizedAt": 1719999999999
    }
  ],
  "total": 1
}</pre>
              </div>
            </div>
          </div>

          <!-- 提交发布任务 -->
          <div class="api-item">
            <div class="api-header" @click="toggleApi('publish')">
              <span class="method method-post">POST</span>
              <span class="api-path">/api/publish</span>
              <span class="api-desc">提交一键发布任务</span>
              <el-icon class="expand-icon">{{ expandedApis.includes('publish') ? 'ArrowUp' : 'ArrowDown' }}</el-icon>
            </div>
            <div v-show="expandedApis.includes('publish')" class="api-detail">
              <div class="detail-section">
                <div class="detail-label">请求体（JSON）：</div>
                <table class="param-table">
                  <thead>
                    <tr><th>参数名</th><th>类型</th><th>必填</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>accountIds</td><td>string[]</td><td>是</td><td>目标账号 ID 列表</td></tr>
                    <tr><td>title</td><td>string</td><td>是</td><td>发布标题</td></tr>
                    <tr><td>content</td><td>string</td><td>否</td><td>正文/描述内容</td></tr>
                    <tr><td>mediaFiles</td><td>string[]</td><td>是</td><td>媒体文件路径数组，支持本地文件路径和远程 URL（http/https）</td></tr>
                    <tr><td>contentType</td><td>string</td><td>是</td><td>内容类型：video / image / article</td></tr>
                    <tr><td>tags</td><td>string[]</td><td>否</td><td>话题标签列表</td></tr>
                    <tr><td>scheduledAt</td><td>number</td><td>否</td><td>定时发布时间戳（毫秒），不填则立即发布</td></tr>
                    <tr><td>remark</td><td>string</td><td>否</td><td>备注/草稿名</td></tr>
                    <tr><td>coverImage</td><td>string</td><td>否</td><td>封面图路径</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="detail-section">
                <div class="detail-label">请求示例：</div>
                <pre class="code-block">{
  "accountIds": ["acc_xxxxxxxx", "acc_yyyyyyyy"],
  "title": "测试发布标题",
  "content": "这是发布描述内容",
  "mediaFiles": ["D:\\videos\\test.mp4", "https://example.com/images/photo.jpg"],
  "contentType": "video",
  "tags": ["测试", "日常"],
  "remark": "API发布测试"
}</pre>
              </div>
              <div class="detail-section">
                <div class="detail-label">响应示例（成功）：</div>
                <pre class="code-block">{
  "code": 0,
  "message": "发布任务创建成功",
  "data": {
    "taskId": "task_abc12345",
    "accountCount": 2,
    "skippedAccounts": 0
  }
}</pre>
              </div>
              <div class="detail-section">
                <div class="detail-label">响应示例（验证失败）：</div>
                <pre class="code-block">{
  "code": 400,
  "message": "内容验证失败",
  "errors": [
    "小红书标题不能超过 20 字，当前 25 字",
    "抖音正文/描述不能超过 1000 字，当前 1200 字",
    "账号 \"测试账号\" (抖音) 不支持发布文章"
  ]
}</pre>
              </div>
              <div class="detail-section">
                <div class="detail-label">内容验证规则：</div>
                <ul style="font-size: 13px; color: #606266; line-height: 1.8; margin: 0; padding-left: 20px;">
                  <li>根据所选账号所属平台，自动校验标题、正文长度限制</li>
                  <li>文章类型会校验正文最小字数要求</li>
                  <li>校验账号是否支持发布对应内容类型（视频/图文/文章）</li>
                  <li>任一平台验证不通过，整个任务不会创建</li>
                </ul>
              </div>
            </div>
          </div>

          <!-- 查询任务状态 -->
          <div class="api-item">
            <div class="api-header" @click="toggleApi('status')">
              <span class="method method-get">GET</span>
              <span class="api-path">/api/publish/:taskId</span>
              <span class="api-desc">查询发布任务状态</span>
              <el-icon class="expand-icon">{{ expandedApis.includes('status') ? 'ArrowUp' : 'ArrowDown' }}</el-icon>
            </div>
            <div v-show="expandedApis.includes('status')" class="api-detail">
              <div class="detail-section">
                <div class="detail-label">路径参数：</div>
                <table class="param-table">
                  <thead>
                    <tr><th>参数名</th><th>类型</th><th>必填</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>taskId</td><td>string</td><td>是</td><td>发布任务 ID</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="detail-section">
                <div class="detail-label">任务状态枚举：</div>
                <div style="font-size: 13px; color: #606266; line-height: 1.8;">
                  <el-tag size="small" type="info" style="margin-right: 8px;">queued</el-tag>排队中
                  <el-tag size="small" type="warning" style="margin: 0 8px 0 16px;">running</el-tag>发布中
                  <el-tag size="small" type="success" style="margin: 0 8px 0 16px;">success</el-tag>成功
                  <el-tag size="small" type="danger" style="margin: 0 8px 0 16px;">failed</el-tag>失败
                  <el-tag size="small" type="info" style="margin: 0 8px 0 16px;">cancelled</el-tag>已取消
                  <el-tag size="small" type="warning" effect="plain" style="margin: 0 8px 0 16px;">scheduled</el-tag>待发布
                </div>
              </div>
              <div class="detail-section">
                <div class="detail-label">响应示例：</div>
                <pre class="code-block">{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "task_abc12345",
    "status": "running",
    "overallProgress": 50,
    "title": "测试发布标题",
    "contentType": "video",
    "createdAt": 1719999999999,
    "updatedAt": 1719999999999,
    "errorMessage": "",
    "totalAccounts": 2,
    "successCount": 1,
    "failedCount": 0,
    "runningCount": 1,
    "pendingCount": 0,
    "cancelledCount": 0,
    "items": [
      {
        "accountId": "acc_xxxxxxxx",
        "platform": "douyin",
        "status": "success",
        "progress": 100,
        "message": "",
        "resultUrl": "https://www.douyin.com/video/...",
        "startedAt": 1719999999999,
        "finishedAt": 1719999999999
      },
      {
        "accountId": "acc_yyyyyyyy",
        "platform": "kuaishou",
        "status": "running",
        "progress": 30,
        "message": "正在上传视频...",
        "resultUrl": "",
        "startedAt": 1719999999999,
        "finishedAt": null
      }
    ]
  }
}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 注意事项 -->
      <div class="config-card">
        <div class="config-title">注意事项</div>
        <ul class="notice-list">
          <li>API 服务仅监听本机（127.0.0.1），不对外网开放</li>
          <li>建议设置 API Key，防止未授权访问</li>
          <li>mediaFiles 支持本地文件路径和远程 URL（http/https 链接），远程文件会自动下载到本地后发布</li>
          <li>不影响应用内正常的发布功能，两者共享同一套发布引擎</li>
          <li>关闭应用后 API 服务也会停止</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { ArrowUp, ArrowDown } from '@element-plus/icons-vue';
import { electronApi } from '../utils/electron';

const config = ref({
  enabled: false,
  port: 37652,
  apiKey: '',
});

const apiRunning = ref(false);
const saving = ref(false);
const expandedApis = ref<string[]>(['accounts', 'publish', 'status']);

function toggleApi(key: string) {
  const idx = expandedApis.value.indexOf(key);
  if (idx === -1) {
    expandedApis.value.push(key);
  } else {
    expandedApis.value.splice(idx, 1);
  }
}

async function loadConfig() {
  try {
    const r = await electronApi.getApiServerStatus();
    config.value = { ...r.config };
    apiRunning.value = r.running;
  } catch (e) {
    ElMessage.error('加载配置失败');
  }
}

function onEnabledChange() {
  // 只改变配置，不立即保存，等用户点保存按钮
}

async function saveConfig() {
  if (config.value.port < 1024 || config.value.port > 65535) {
    ElMessage.warning('端口号必须在 1024-65535 之间');
    return;
  }

  saving.value = true;
  try {
    const r = await electronApi.saveApiServerConfig({
      enabled: config.value.enabled,
      port: config.value.port,
      apiKey: config.value.apiKey,
    });
    apiRunning.value = r.running;
    config.value = { ...r.config };
    ElMessage.success('配置已保存');
  } catch (e) {
    ElMessage.error('保存失败: ' + (e as Error).message);
  } finally {
    saving.value = false;
  }
}

async function startServer() {
  try {
    const r = await electronApi.startApiServer();
    apiRunning.value = r.running;
    ElMessage.success('服务已启动');
  } catch (e) {
    ElMessage.error('启动失败: ' + (e as Error).message);
  }
}

async function stopServer() {
  try {
    const r = await electronApi.stopApiServer();
    apiRunning.value = r.running;
    ElMessage.success('服务已停止');
  } catch (e) {
    ElMessage.error('停止失败: ' + (e as Error).message);
  }
}

onMounted(() => {
  loadConfig();
});
</script>

<style scoped>
.api-panel {
  padding: 20px;
}

.panel {
  max-width: 1000px;
  margin: 0 auto;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.config-card {
  margin-top: 20px;
  padding: 20px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--el-border-color-lighter);
}

.config-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.api-list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.api-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  overflow: hidden;
}

.api-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: #fafafa;
  cursor: pointer;
  gap: 12px;
}

.api-header:hover {
  background: #f5f5f5;
}

.method {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}

.method-get { background: #67c23a; }
.method-post { background: #409eff; }
.method-put { background: #e6a23c; }
.method-delete { background: #f56c6c; }

.api-path {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  color: #303133;
  font-weight: 500;
}

.api-desc {
  flex: 1;
  font-size: 13px;
  color: #606266;
  margin-left: 8px;
}

.expand-icon {
  color: #909399;
  flex-shrink: 0;
}

.api-detail {
  padding: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: #fff;
}

.detail-section {
  margin-bottom: 16px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-label {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 8px;
}

.param-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.param-table th,
.param-table td {
  border: 1px solid var(--el-border-color-lighter);
  padding: 8px 12px;
  text-align: left;
}

.param-table th {
  background: #f5f7fa;
  font-weight: 500;
  color: #606266;
}

.param-table td {
  color: #303133;
}

.code-block {
  background: #282c34;
  color: #abb2bf;
  padding: 12px 16px;
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}

.notice-list {
  margin: 12px 0 0 0;
  padding-left: 20px;
  font-size: 13px;
  color: #606266;
  line-height: 2;
}
</style>
