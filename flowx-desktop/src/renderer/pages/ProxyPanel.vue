<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">代理 IP 设置</h2>
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>&nbsp;添加代理 IP
        </el-button>
      </div>

      <!-- 代理IP卡片网格流 -->
      <div v-loading="envStore.loading" class="proxy-grid-flow">
        <div v-for="row in envStore.proxies" :key="row.id" class="flow-proxy-card">
          <!-- 头部：代理名称与协议标签 -->
          <div class="proxy-card-header">
            <h3 class="proxy-title">{{ row.name }}</h3>
            <el-tag :type="row.type === 'socks5' ? 'success' : 'info'" size="small" effect="light" class="protocol-tag">
              {{ row.type.toUpperCase() }}
            </el-tag>
          </div>

          <!-- 主体：服务器地址 -->
          <div class="proxy-card-body">
            <div class="address-box">
              <span class="address-host">{{ row.host }}</span>
              <span class="address-colon">:</span>
              <span class="address-port">{{ row.port }}</span>
            </div>
            
            <div class="auth-info" v-if="row.username">
              <span class="info-label">用户名:</span>
              <span class="info-val">{{ row.username }}</span>
            </div>
            
            <!-- 状态测试结果 -->
            <div class="proxy-status-cell">
              <span class="info-label">代理状态:</span>
              <div class="status-cell">
                <template v-if="testingIds.has(row.id)">
                  <el-icon class="loading-icon"><Loading /></el-icon>
                  <span class="status-text">正在测试...</span>
                </template>
                <template v-else-if="testResults[row.id]">
                  <template v-if="testResults[row.id].ok">
                    <el-tag type="success" size="small" effect="light" class="status-tag">
                      <el-icon><Check /></el-icon>&nbsp;可用
                    </el-tag>
                    <span class="latency-text">{{ testResults[row.id].latency }}ms</span>
                  </template>
                  <template v-else>
                    <el-tooltip :content="testResults[row.id].error" placement="top">
                      <el-tag type="danger" size="small" effect="light" class="status-tag">
                        <el-icon><Close /></el-icon>&nbsp;不可用
                      </el-tag>
                    </el-tooltip>
                  </template>
                  <template v-if="testResults[row.id].outboundIp">
                    <el-tooltip :content="'出口IP: ' + testResults[row.id].outboundIp" placement="top">
                      <span class="ip-text">{{ testResults[row.id].outboundIp }}</span>
                    </el-tooltip>
                  </template>
                </template>
                <template v-else>
                  <el-tag type="info" size="small" effect="plain" class="status-tag">未测试</el-tag>
                </template>
              </div>
            </div>
          </div>

          <!-- 时间说明 -->
          <div class="proxy-card-time">
            <span>创建时间：{{ formatTime(row.createdAt) }}</span>
          </div>

          <!-- 底部操作按钮 -->
          <div class="proxy-card-footer">
            <el-button
              size="small"
              type="success"
              link
              :loading="testingIds.has(row.id)"
              @click="handleTest(asProxy(row).id)"
            >
              <el-icon><Refresh /></el-icon>&nbsp;测试连接
            </el-button>
            <el-button size="small" type="primary" link @click="openEditDialog(asProxy(row))">
              <el-icon><Edit /></el-icon>&nbsp;编辑
            </el-button>
            <el-popconfirm width="280" title="删除该代理，会同时解除所有关联环境的代理配置，确认删除？" @confirm="handleDelete(asProxy(row).id)">
              <template #reference>
                <el-button size="small" type="danger" link>
                  <el-icon><Delete /></el-icon>&nbsp;删除
                </el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>

      <div v-if="envStore.proxies.length === 0 && !envStore.loading" class="empty-hint">
        暂无代理配置，点击右上角"添加代理 IP"创建。
      </div>
    </div>

    <!-- 代理 IP 编辑/添加弹窗 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑代理 IP' : '添加代理 IP'" width="450px" destroy-on-close>
      <el-form :model="form" :rules="rules" ref="formRef" label-width="100px" label-position="right">
        <el-form-item label="代理名称" prop="name">
          <el-input v-model="form.name" placeholder="如：小红书1号出网IP" />
        </el-form-item>
        <el-form-item label="代理协议" prop="type">
          <el-select v-model="form.type" placeholder="选择协议" style="width: 100%">
            <el-option label="HTTP" value="http" />
            <el-option label="SOCKS5" value="socks5" />
          </el-select>
        </el-form-item>
        <el-form-item label="服务器主机" prop="host">
          <el-input v-model="form.host" placeholder="如：123.45.67.89 或 proxy.local" />
        </el-form-item>
        <el-form-item label="服务器端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" controls-position="right" />
        </el-form-item>
        <el-form-item label="用户名(可选)" prop="username">
          <el-input v-model="form.username" placeholder="留空则不开启身份验证" />
        </el-form-item>
        <el-form-item label="密码(可选)" prop="password">
          <el-input v-model="form.password" type="password" show-password placeholder="输入代理认证密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSave" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Loading, Check, Close, Edit, Delete, Refresh } from '@element-plus/icons-vue';
import { useEnvStore } from '../stores/env';
import type { ProxyConfig, ProxyTestResult } from '../../types';

const envStore = useEnvStore();
const dialogVisible = ref(false);
const isEdit = ref(false);
const editingId = ref('');
const saving = ref(false);
const formRef = ref<any>(null);

// 测试相关状态
const testingIds = ref<Set<string>>(new Set());
const testResults = ref<Record<string, ProxyTestResult>>({});

const form = reactive({
  name: '',
  type: 'http' as 'http' | 'socks5',
  host: '',
  port: 1080,
  username: '',
  password: '',
});

const rules = {
  name: [{ required: true, message: '请输入代理名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择协议类型', trigger: 'change' }],
  host: [{ required: true, message: '请输入服务器主机', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口', trigger: 'blur' }],
};

onMounted(async () => {
  await envStore.loadAll();
});

function openAddDialog() {
  isEdit.value = false;
  editingId.value = '';
  form.name = '';
  form.type = 'http';
  form.host = '';
  form.port = 1080;
  form.username = '';
  form.password = '';
  dialogVisible.value = true;
}

function openEditDialog(row: ProxyConfig) {
  isEdit.value = true;
  editingId.value = row.id;
  form.name = row.name;
  form.type = row.type;
  form.host = row.host;
  form.port = row.port;
  form.username = row.username || '';
  form.password = row.password || '';
  dialogVisible.value = true;
}

async function handleSave() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      type: form.type,
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim() || undefined,
      password: form.password || undefined,
    };

    if (isEdit.value) {
      await envStore.updateProxy(editingId.value, payload);
      // 编辑后清除旧的测试结果
      delete testResults.value[editingId.value];
      ElMessage.success('代理 IP 修改成功');
    } else {
      await envStore.createProxy(payload);
      ElMessage.success('代理 IP 添加成功');
    }
    dialogVisible.value = false;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function handleDelete(id: string) {
  try {
    const ok = await envStore.deleteProxy(id);
    if (ok) {
      // 删除测试结果缓存
      delete testResults.value[id];
      ElMessage.success('代理 IP 已成功删除');
    } else {
      ElMessage.error('代理 IP 删除失败');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function handleTest(id: string) {
  if (testingIds.value.has(id)) return;

  testingIds.value.add(id);
  try {
    const result = await envStore.testProxy(id);
    testResults.value[id] = result;
    if (result.ok) {
      ElMessage.success(`代理测试成功，延迟 ${result.latency}ms`);
    } else {
      ElMessage.error(`代理测试失败：${result.error}`);
    }
  } catch (err) {
    testResults.value[id] = {
      ok: false,
      latency: -1,
      targetUrl: '',
      error: err instanceof Error ? err.message : String(err),
    };
    ElMessage.error(`测试异常：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    testingIds.value.delete(id);
  }
}

function asProxy(row: any): ProxyConfig {
  return row as ProxyConfig;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<style scoped>
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--el-border-color-light);
  padding-bottom: 12px;
}
.empty-hint {
  text-align: center;
  color: #909399;
  font-size: 14px;
  padding: 40px 0;
}
.status-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.loading-icon {
  animation: rotate 1s linear infinite;
  color: #6366f1;
}
.status-text {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 600;
}
.latency-text {
  font-size: 12px;
  color: #10b981;
  font-family: monospace;
  font-weight: 700;
}
.ip-text {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
  background: rgba(0, 0, 0, 0.04);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}
@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 代理IP配置卡片网格流 */
.proxy-grid-flow {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  margin-top: 16px;
}

.flow-proxy-card {
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

.flow-proxy-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--glow-shadow-lg);
  background: #ffffff;
}

.proxy-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.proxy-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.protocol-tag {
  font-weight: 700;
  border-radius: 6px;
}

.proxy-card-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}

.address-box {
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 10px;
  padding: 10px 14px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 14px;
  color: #0f172a;
  font-weight: 700;
}

.address-colon {
  color: #94a3b8;
  margin: 0 4px;
}

.address-port {
  color: #6366f1;
}

.auth-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-label {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 600;
  min-width: 56px;
}

.info-val {
  font-size: 12px;
  color: #475569;
  font-weight: 700;
}

.proxy-status-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-tag {
  font-weight: 700;
  border-radius: 6px;
}

.proxy-card-time {
  font-size: 11px;
  color: #cbd5e1;
  font-weight: 500;
  margin-bottom: 14px;
}

.proxy-card-footer {
  border-top: 1px solid rgba(0, 0, 0, 0.03);
  padding-top: 12px;
  display: flex;
  justify-content: space-between;
  margin-top: auto;
}

.proxy-card-footer :deep(.el-button) {
  margin: 0 !important;
  font-weight: 700 !important;
  font-size: 12px !important;
  transition: all 0.2s ease !important;
}

.proxy-card-footer :deep(.el-button--success:hover) {
  color: #10b981 !important;
  background-color: rgba(16, 185, 129, 0.06) !important;
}

.proxy-card-footer :deep(.el-button--primary:hover) {
  color: #6366f1 !important;
  background-color: rgba(99, 102, 241, 0.06) !important;
}

.proxy-card-footer :deep(.el-button--danger:hover) {
  color: #f56c6c !important;
  background-color: rgba(245, 108, 108, 0.06) !important;
}
</style>
