<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">环境配置</h2>
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>&nbsp;添加环境配置
        </el-button>
      </div>

      <!-- 环境卡片网格流 -->
      <div v-loading="envStore.loading" class="env-grid-flow">
        <div v-for="row in envStore.environments" :key="row.id" class="flow-env-card">
          <!-- 头部：环境名称与状态 -->
          <div class="env-card-header">
            <h3 class="env-title">{{ row.name }}</h3>
            <span class="env-status-indicator">已激活</span>
          </div>

          <!-- 主体：User-Agent 预览 -->
          <div class="env-card-body">
            <div class="ua-preview-box">
              <div class="ua-label">User-Agent:</div>
              <div class="ua-text" :title="row.userAgent">{{ row.userAgent }}</div>
            </div>
            <div class="env-proxy-info">
              <span class="info-label">关联代理:</span>
              <el-tag v-if="row.proxyId" type="success" size="small" effect="light" class="proxy-tag">
                {{ getProxyLabel(row.proxyId) }}
              </el-tag>
              <span v-else class="direct-span">本机直连 (未绑定代理)</span>
            </div>
          </div>

          <!-- 时间说明 -->
          <div class="env-card-time">
            <span>创建时间：{{ formatTime(row.createdAt) }}</span>
          </div>

          <!-- 底部操作按钮 -->
          <div class="card-actions-pills">
            <div class="action-pill pill-primary" @click="openEditDialog(asEnv(row))">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              <span>编辑配置</span>
            </div>
            <el-popconfirm width="280" title="确定删除此环境配置？（绑定了此环境的账号将变更为未绑定环境）" @confirm="handleDelete(asEnv(row).id)">
              <template #reference>
                <div class="action-pill pill-danger">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                  <span>删除</span>
                </div>
              </template>
            </el-popconfirm>
          </div>
        </div>
      </div>

      <!-- 动态环境指纹空态 -->
      <div v-if="envStore.environments.length === 0 && !envStore.loading" class="empty-glow-box">
        <div class="empty-3d-scene">
          <div class="empty-box-body">
            <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
        </div>
        <div class="empty-glow-text">
          <h3>配置您的专属隔离指纹</h3>
          <p>当前暂无环境配置，点击右上角 “添加环境配置” 开启防关联保护</p>
        </div>
      </div>
    </div>

    <!-- 环境配置添加/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑环境配置' : '添加环境配置'" width="500px" destroy-on-close>
      <el-form :model="form" :rules="rules" ref="formRef" label-width="100px" label-position="right">
        <el-form-item label="环境名称" prop="name">
          <el-input v-model="form.name" placeholder="如：主账号防关联配置" />
        </el-form-item>
        <el-form-item label="User-Agent" prop="userAgent">
          <div style="display:flex; width:100%; gap:8px">
            <el-input v-model="form.userAgent" type="textarea" :rows="3" placeholder="浏览器指纹标识(User-Agent)" />
            <el-button type="warning" size="small" style="align-self:flex-end" @click="generateRandomUA">
              随机生成
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="绑定代理 IP" prop="proxyId">
          <el-select v-model="form.proxyId" placeholder="使用本机直连 (不开启代理)" clearable style="width: 100%">
            <el-option label="使用本机直连" value="" />
            <el-option v-for="p in envStore.proxies" :key="p.id" :label="`${p.name} (${p.host}:${p.port})`" :value="p.id" />
          </el-select>
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
import { Plus, Edit, Delete } from '@element-plus/icons-vue';
import { useEnvStore } from '../stores/env';
import type { BrowserEnvironment } from '../../types';

// 内置的 5 个主流浏览器 UA 指纹模板，用于一键随机生成
const UA_TEMPLATES = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];

const envStore = useEnvStore();
const dialogVisible = ref(false);
const isEdit = ref(false);
const editingId = ref('');
const saving = ref(false);
const formRef = ref<any>(null);

const form = reactive({
  name: '',
  userAgent: '',
  proxyId: '' as string | null | undefined,
});

const rules = {
  name: [{ required: true, message: '请输入环境名称', trigger: 'blur' }],
  userAgent: [{ required: true, message: '请输入浏览器 User-Agent 标识', trigger: 'blur' }],
};

onMounted(async () => {
  await envStore.loadAll();
});

function getProxyLabel(proxyId: string): string {
  const p = envStore.proxies.find((x) => x.id === proxyId);
  return p ? `${p.name} [${p.host}:${p.port}]` : '未知代理';
}

function openAddDialog() {
  isEdit.value = false;
  editingId.value = '';
  form.name = '';
  form.userAgent = UA_TEMPLATES[0]; // 默认填入第一个
  form.proxyId = '';
  dialogVisible.value = true;
}

function openEditDialog(row: BrowserEnvironment) {
  isEdit.value = true;
  editingId.value = row.id;
  form.name = row.name;
  form.userAgent = row.userAgent;
  form.proxyId = row.proxyId || '';
  dialogVisible.value = true;
}

function generateRandomUA() {
  const idx = Math.floor(Math.random() * UA_TEMPLATES.length);
  form.userAgent = UA_TEMPLATES[idx];
  ElMessage.success('已随机生成 User-Agent 浏览器标识');
}

async function handleSave() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      userAgent: form.userAgent.trim(),
      proxyId: form.proxyId || null,
    };

    if (isEdit.value) {
      await envStore.updateEnvironment(editingId.value, payload);
      ElMessage.success('环境配置修改成功');
    } else {
      await envStore.createEnvironment(payload);
      ElMessage.success('环境配置添加成功');
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
    const ok = await envStore.deleteEnvironment(id);
    if (ok) {
      ElMessage.success('环境配置已成功删除');
    } else {
      ElMessage.error('环境配置删除失败');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

function asEnv(row: any): BrowserEnvironment {
  return row as BrowserEnvironment;
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
/* 高级渐变发光空态组件 */
.empty-glow-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  background: rgba(255, 255, 255, 0.45);
  border: 1px dashed rgba(99, 102, 241, 0.15);
  border-radius: 20px;
  margin-top: 30px;
  text-align: center;
}

.empty-3d-scene {
  width: 90px;
  height: 90px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.1) 0%, rgba(99, 102, 241, 0) 70%);
  border-radius: 50%;
  margin-bottom: 16px;
  position: relative;
}

.empty-3d-scene::before {
  content: '';
  position: absolute;
  width: 60px;
  height: 60px;
  border: 1.5px dashed rgba(99, 102, 241, 0.25);
  border-radius: 50%;
  animation: rotate-dashed 20s linear infinite;
}

@keyframes rotate-dashed {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.empty-box-body {
  color: #6366f1;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: float-slow 4s ease-in-out infinite;
}

@keyframes float-slow {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.empty-glow-text h3 {
  font-size: 16px;
  font-weight: 800;
  color: #0f172a;
  margin: 0 0 8px 0;
}

.empty-glow-text p {
  font-size: 13px;
  color: #64748b;
  margin: 0;
}

/* 浏览器指纹环境卡片流样式 */
.env-grid-flow {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  margin-top: 16px;
}

.flow-env-card {
  background: #ffffff;
  border-top: 1.5px solid rgba(99, 102, 241, 0.2);
  border-left: none;
  border-right: none;
  border-bottom: none;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 10px 30px -5px rgba(99, 102, 241, 0.04), 0 2px 10px -3px rgba(0, 0, 0, 0.02);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  position: relative;
  overflow: hidden;
}

.flow-env-card:hover {
  transform: translateY(-4px);
  border-top-color: rgba(99, 102, 241, 0.58);
  box-shadow: 0 16px 36px -4px rgba(99, 102, 241, 0.14), 0 4px 16px -2px rgba(99, 102, 241, 0.04);
  background: #ffffff;
}

.env-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.env-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.env-status-indicator {
  font-size: 10px;
  font-weight: 700;
  color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  padding: 2px 8px;
  border-radius: 10px;
}

.env-card-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}

.ua-preview-box {
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 10px;
  padding: 10px 12px;
}

.ua-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 700;
  margin-bottom: 4px;
}

.ua-text {
  font-size: 11px;
  font-family: monospace;
  color: #64748b;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}

.env-proxy-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-label {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 600;
}

.proxy-tag {
  font-weight: 700;
  border-radius: 6px;
}

.direct-span {
  font-size: 12px;
  color: #cbd5e1;
  font-weight: 500;
}

.env-card-time {
  font-size: 11px;
  color: #cbd5e1;
  font-weight: 500;
  margin-bottom: 14px;
}

.card-actions-pills {
  border-top: 1px dashed rgba(0, 0, 0, 0.05);
  padding-top: 14px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.action-pill {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 4px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.25s ease;
  border: 1px solid transparent;
}

.pill-primary {
  background: transparent;
  color: #6366f1;
}
.pill-primary:hover {
  background: rgba(99, 102, 241, 0.08);
  color: #4f46e5;
  border-color: rgba(99, 102, 241, 0.12);
}

.pill-danger {
  background: transparent;
  color: #ef4444;
}
.pill-danger:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.12);
}
</style>
