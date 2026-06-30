<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">环境配置</h2>
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>&nbsp;添加环境配置
        </el-button>
      </div>

      <el-table v-loading="envStore.loading" :data="envStore.environments" border stripe style="margin-top: 16px">
        <el-table-column label="环境名称" prop="name" min-width="150" />
        <el-table-column label="浏览器 User-Agent" prop="userAgent" min-width="260" show-overflow-tooltip />
        <el-table-column label="绑定的代理 IP" min-width="180">
          <template #default="{ row }">
            <el-tag v-if="row.proxyId" type="success" size="small">
              {{ getProxyLabel(row.proxyId) }}
            </el-tag>
            <span v-else style="color:#c0c4cc; font-size:12px">未绑定代理（使用本机直连）</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openEditDialog(asEnv(row))">编辑</el-button>
            <el-popconfirm title="确定删除此环境配置？（绑定了此环境的账号将变更为未绑定环境）" @confirm="handleDelete(asEnv(row).id)">
              <template #reference>
                <el-button size="small" type="danger" link>删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="envStore.environments.length === 0 && !envStore.loading" class="empty-hint">
        暂无环境配置，点击右上角“添加环境配置”创建。
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
import { Plus } from '@element-plus/icons-vue';
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
.empty-hint {
  text-align: center;
  color: #909399;
  font-size: 14px;
  padding: 40px 0;
}
</style>
