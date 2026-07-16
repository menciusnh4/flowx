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

      <!-- 接口文档：左目录 + 右详情 -->
      <div class="config-card">
        <div class="config-title">
          接口文档
          <span style="margin-left: 12px; font-size: 12px; font-weight: normal; color: #909399;">
            Base URL: http://127.0.0.1:{{ config.port }}
          </span>
        </div>

        <div class="api-doc">
          <!-- 左侧目录 -->
          <aside class="api-nav">
            <el-input
              v-model="apiSearch"
              placeholder="搜索接口、方法、路径…"
              :prefix-icon="Search"
              clearable
              class="api-search"
            />
            <nav class="api-nav-list">
              <template v-for="grp in filteredGroups" :key="grp.name">
                <div class="api-group">{{ grp.name }}</div>
                <button
                  v-for="api in grp.items"
                  :key="api.id"
                  type="button"
                  class="api-link"
                  :class="{ active: api.id === selectedApiId }"
                  @click="selectApi(api.id)"
                >
                  <span class="method" :class="methodClass(api.method)">{{ api.method }}</span>
                  <span class="api-link-path">{{ api.path }}</span>
                </button>
              </template>
              <div v-if="filteredGroups.length === 0" class="api-empty">无匹配接口</div>
            </nav>
          </aside>

          <!-- 右侧详情 -->
          <div class="api-detail" v-if="selectedApi">
            <div class="api-d-head">
              <span class="method" :class="methodClass(selectedApi.method)">{{ selectedApi.method }}</span>
              <code class="api-d-path">{{ selectedApi.path }}</code>
            </div>
            <h3 class="api-d-title">{{ selectedApi.title }}</h3>
            <p class="api-d-desc">{{ selectedApi.desc }}</p>

            <template v-for="(sec, i) in selectedApi.sections" :key="i">
              <!-- 请求参数 -->
              <div class="detail-section" v-if="sec.kind === 'params'">
                <div class="detail-label">{{ sec.label }}</div>
                <table class="param-table">
                  <thead><tr><th>参数名</th><th>类型</th><th>必填</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr v-for="p in sec.rows" :key="p.name">
                      <td><code>{{ p.name }}</code></td>
                      <td>{{ p.type }}</td>
                      <td>{{ p.required ? '是' : '否' }}</td>
                      <td>{{ p.desc }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- 代码块 -->
              <div class="detail-section" v-else-if="sec.kind === 'code'">
                <div class="detail-label">{{ sec.label }}</div>
                <pre class="code-block">{{ sec.code }}</pre>
              </div>

              <!-- 列表 -->
              <div class="detail-section" v-else-if="sec.kind === 'list'">
                <div class="detail-label">{{ sec.label }}</div>
                <ul class="rule-list">
                  <li v-for="(item, j) in sec.items" :key="j">{{ item }}</li>
                </ul>
              </div>

              <!-- 标签组 -->
              <div class="detail-section" v-else-if="sec.kind === 'tags'">
                <div class="detail-label">{{ sec.label }}</div>
                <div class="tag-row">
                  <template v-for="(t, j) in sec.tags" :key="j">
                    <el-tag size="small" :type="t.type" :effect="t.plain ? 'plain' : 'light'">{{ t.text }}</el-tag>
                    <span class="tag-note">{{ t.note }}</span>
                  </template>
                </div>
              </div>
            </template>
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
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { electronApi } from '../utils/electron';

const config = ref({
  enabled: false,
  port: 37652,
  apiKey: '',
});

const apiRunning = ref(false);
const saving = ref(false);

/* ============ 接口文档：数据驱动（目录 + 搜索 + 详情） ============ */
interface ApiParam { name: string; type: string; required: boolean; desc: string; }
type TagType = 'info' | 'success' | 'warning' | 'danger';
interface ApiTag { text: string; type: TagType; plain?: boolean; note: string; }
type ApiSection =
  | { kind: 'params'; label: string; rows: ApiParam[] }
  | { kind: 'code'; label: string; code: string }
  | { kind: 'list'; label: string; items: string[] }
  | { kind: 'tags'; label: string; tags: ApiTag[] };
interface ApiDoc {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  group: string;
  title: string;
  desc: string;
  sections: ApiSection[];
}

const apiDocs: ApiDoc[] = [
  {
    id: 'health',
    method: 'GET',
    path: '/api/health',
    group: '系统',
    title: '健康检查',
    desc: '返回服务运行状态，常用于健康检查与探针，无需鉴权。',
    sections: [
      {
        kind: 'code',
        label: '响应示例：',
        code: '{\n  "status": "ok",\n  "timestamp": 1719999999999\n}',
      },
    ],
  },
  {
    id: 'accounts',
    method: 'GET',
    path: '/api/accounts',
    group: '账号',
    title: '获取账号列表',
    desc: '返回当前已授权且健康的平台账号列表，支持按平台与状态筛选。',
    sections: [
      {
        kind: 'params',
        label: '查询参数：',
        rows: [
          { name: 'platform', type: 'string', required: false, desc: '按平台过滤，如 douyin、kuaishou、xiaohongshu、zhihu、toutiao' },
          { name: 'status', type: 'string', required: false, desc: '按状态过滤：active / expired / disabled' },
        ],
      },
      {
        kind: 'code',
        label: '响应示例：',
        code: '{\n  "code": 0,\n  "message": "success",\n  "data": [\n    {\n      "id": "acc_xxxxxxxx",\n      "platform": "douyin",\n      "nickname": "测试账号",\n      "avatar": "https://...",\n      "userId": "MS4wLjAB...",\n      "platformAccountId": "抖音号",\n      "fansCount": 1000,\n      "followCount": 100,\n      "likeCount": 5000,\n      "status": "active",\n      "remark": "",\n      "categoryIds": [],\n      "categoryNames": [],\n      "envId": "",\n      "capabilities": {\n        "publishVideo": true,\n        "publishImage": true,\n        "publishArticle": false\n      },\n      "authorizedAt": 1719999999999\n    }\n  ],\n  "total": 1\n}',
      },
    ],
  },
  {
    id: 'publish',
    method: 'POST',
    path: '/api/publish',
    group: '发布',
    title: '提交一键发布任务',
    desc: '提交一条发布任务，支持视频 / 图文 / 文章三种内容类型，可指定目标账号。',
    sections: [
      {
        kind: 'params',
        label: '请求体（JSON）：',
        rows: [
          { name: 'accountIds', type: 'string[]', required: true, desc: '目标账号 ID 列表' },
          { name: 'title', type: 'string', required: true, desc: '发布标题' },
          { name: 'content', type: 'string', required: false, desc: '正文/描述内容' },
          { name: 'mediaFiles', type: 'string[]', required: true, desc: '媒体文件路径数组，支持本地文件路径和远程 URL（http/https）' },
          { name: 'contentType', type: 'string', required: true, desc: '内容类型：video / image / article' },
          { name: 'tags', type: 'string[]', required: false, desc: '话题标签列表' },
          { name: 'scheduledAt', type: 'number', required: false, desc: '定时发布时间戳（毫秒），不填则立即发布' },
          { name: 'remark', type: 'string', required: false, desc: '备注/草稿名' },
          { name: 'coverImage', type: 'string', required: false, desc: '封面图路径' },
        ],
      },
      {
        kind: 'code',
        label: '请求示例：',
        code: '{\n  "accountIds": ["acc_xxxxxxxx", "acc_yyyyyyyy"],\n  "title": "测试发布标题",\n  "content": "这是发布描述内容",\n  "mediaFiles": ["D:\\\\videos\\\\test.mp4", "https://example.com/images/photo.jpg"],\n  "contentType": "video",\n  "tags": ["测试", "日常"],\n  "remark": "API发布测试"\n}',
      },
      {
        kind: 'code',
        label: '响应示例（成功）：',
        code: '{\n  "code": 0,\n  "message": "发布任务创建成功",\n  "data": {\n    "taskId": "task_abc12345",\n    "accountCount": 2,\n    "skippedAccounts": 0\n  }\n}',
      },
      {
        kind: 'code',
        label: '响应示例（验证失败）：',
        code: '{\n  "code": 400,\n  "message": "内容验证失败",\n  "errors": [\n    "小红书标题不能超过 20 字，当前 25 字",\n    "抖音正文/描述不能超过 1000 字，当前 1200 字",\n    "账号 \\"测试账号\\" (抖音) 不支持发布文章"\n  ]\n}',
      },
      {
        kind: 'list',
        label: '内容验证规则：',
        items: [
          '根据所选账号所属平台，自动校验标题、正文长度限制',
          '文章类型会校验正文最小字数要求',
          '校验账号是否支持发布对应内容类型（视频/图文/文章）',
          '任一平台验证不通过，整个任务不会创建',
        ],
      },
    ],
  },
  {
    id: 'status',
    method: 'GET',
    path: '/api/publish/:taskId',
    group: '发布',
    title: '查询发布任务状态',
    desc: '返回指定发布任务的进度与各账号的执行结果。',
    sections: [
      {
        kind: 'params',
        label: '路径参数：',
        rows: [
          { name: 'taskId', type: 'string', required: true, desc: '发布任务 ID' },
        ],
      },
      {
        kind: 'tags',
        label: '任务状态枚举：',
        tags: [
          { text: 'queued', type: 'info', note: '排队中' },
          { text: 'running', type: 'warning', note: '发布中' },
          { text: 'success', type: 'success', note: '成功' },
          { text: 'failed', type: 'danger', note: '失败' },
          { text: 'cancelled', type: 'info', note: '已取消' },
          { text: 'scheduled', type: 'info', plain: true, note: '待发布' },
        ],
      },
      {
        kind: 'code',
        label: '响应示例：',
        code: '{\n  "code": 0,\n  "message": "success",\n  "data": {\n    "taskId": "task_abc12345",\n    "status": "running",\n    "overallProgress": 50,\n    "title": "测试发布标题",\n    "contentType": "video",\n    "createdAt": 1719999999999,\n    "updatedAt": 1719999999999,\n    "errorMessage": "",\n    "totalAccounts": 2,\n    "successCount": 1,\n    "failedCount": 0,\n    "runningCount": 1,\n    "pendingCount": 0,\n    "cancelledCount": 0,\n    "items": [\n      {\n        "accountId": "acc_xxxxxxxx",\n        "platform": "douyin",\n        "status": "success",\n        "progress": 100,\n        "message": "",\n        "resultUrl": "https://www.douyin.com/video/...",\n        "startedAt": 1719999999999,\n        "finishedAt": 1719999999999\n      },\n      {\n        "accountId": "acc_yyyyyyyy",\n        "platform": "kuaishou",\n        "status": "running",\n        "progress": 30,\n        "message": "正在上传视频...",\n        "resultUrl": "",\n        "startedAt": 1719999999999,\n        "finishedAt": null\n      }\n    ]\n  }\n}',
      },
    ],
  },
];

const apiSearch = ref('');
const selectedApiId = ref(apiDocs[0].id);

const selectedApi = computed(() => apiDocs.find(d => d.id === selectedApiId.value) || apiDocs[0]);

const filteredGroups = computed(() => {
  const kw = apiSearch.value.trim().toLowerCase();
  const groups: { name: string; items: ApiDoc[] }[] = [];
  for (const d of apiDocs) {
    if (kw && !`${d.method} ${d.path} ${d.title} ${d.desc}`.toLowerCase().includes(kw)) continue;
    let g = groups.find(x => x.name === d.group);
    if (!g) { g = { name: d.group, items: [] }; groups.push(g); }
    g.items.push(d);
  }
  return groups;
});

function methodClass(m: string) {
  return {
    'method-get': m === 'GET',
    'method-post': m === 'POST',
    'method-put': m === 'PUT',
    'method-delete': m === 'DELETE',
  };
}

function selectApi(id: string) {
  selectedApiId.value = id;
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
  padding: 0;
}
.panel {
  max-width: 1000px;
  margin: 0 auto;
}
.section-title {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--font-display);
  color: var(--ink);
}
.config-card {
  margin-top: 20px;
  padding: 20px;
  background: var(--surface);
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-xs);
}
.config-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

/* ===== 接口文档：两栏（目录 + 详情） ===== */
.api-doc {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}
.api-nav {
  position: sticky;
  top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100vh - 120px);
  overflow: auto;
  min-width: 0;
}
.api-search {
  width: 100%;
}
.api-nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.api-group {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-transform: uppercase;
  padding: 10px 8px 4px;
}
.api-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12.5px;
  color: var(--slate);
  transition: all 150ms ease;
}
.api-link:hover {
  background: #eef1fb;
  color: var(--ink);
}
.api-link.active {
  background: var(--brand-indigo);
  color: #fff;
}
.api-link-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.api-empty {
  padding: 12px 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.api-detail {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  min-width: 0;
}
.api-d-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.api-d-path {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}
.api-d-title {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--font-display);
  color: var(--ink);
  margin: 0 0 6px;
}
.api-d-desc {
  font-size: 13px;
  color: var(--slate);
  line-height: 1.7;
  margin: 0 0 8px;
}

.method {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
}
.method-get { background: var(--success); }
.method-post { background: var(--brand-indigo); }
.method-put { background: var(--warning); }
.method-delete { background: var(--danger); }

.detail-section {
  margin-bottom: 16px;
}
.detail-section:last-child {
  margin-bottom: 0;
}
.detail-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  margin-bottom: 8px;
}
.param-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.param-table th,
.param-table td {
  border: 1px solid var(--line);
  padding: 8px 12px;
  text-align: left;
}
.param-table th {
  background: var(--surface-2);
  font-weight: 500;
  color: var(--slate);
}
.param-table td {
  color: var(--ink);
}
.param-table code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12.5px;
  color: var(--brand-indigo);
}
.code-block {
  background: #282c34;
  color: #abb2bf;
  padding: 12px 16px;
  border-radius: var(--r-sm);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}
.rule-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: #606266;
  line-height: 1.8;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 4px;
}
.tag-note {
  font-size: 13px;
  color: #606266;
  margin-right: 12px;
}

.notice-list {
  margin: 12px 0 0 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--slate);
  line-height: 2;
}

@media (max-width: 860px) {
  .api-doc { grid-template-columns: 1fr; }
  .api-nav { position: static; max-height: none; }
}
</style>
