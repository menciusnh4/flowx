<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">代理 IP 设置</h2>
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>&nbsp;添加代理 IP
        </el-button>
      </div>

      <el-table v-loading="envStore.loading" :data="envStore.proxies" border stripe style="margin-top: 16px">
        <el-table-column label="代理名称" prop="name" min-width="150" />
        <el-table-column label="协议" prop="type" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === 'socks5' ? 'success' : 'info'" size="small">
              {{ row.type.toUpperCase() }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="服务器地址" prop="host" min-width="180" />
        <el-table-column label="端口" prop="port" width="90" />
        <el-table-column label="认证用户名" prop="username" min-width="130">
          <template #default="{ row }">
            <span>{{ row.username || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="认证密码" min-width="130">
          <template #default="{ row }">
            <span v-if="row.password" style="font-family: monospace">******</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openEditDialog(asProxy(row))">编辑</el-button>
            <el-popconfirm title="删除该代理，会同时解除所有关联环境的代理配置，确认删除？" @confirm="handleDelete(asProxy(row).id)">
              <template #reference>
                <el-button size="small" type="danger" link>删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="envStore.proxies.length === 0 && !envStore.loading" class="empty-hint">
        暂无代理配置，点击右上角“添加代理 IP”创建。
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
import { Plus } from '@element-plus/icons-vue';
import { useEnvStore } from '../stores/env';
import type { ProxyConfig } from '../../types';

const envStore = useEnvStore();
const dialogVisible = ref(false);
const isEdit = ref(false);
const editingId = ref('');
const saving = ref(false);
const formRef = ref<any>(null);

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
      ElMessage.success('代理 IP 已成功删除');
    } else {
      ElMessage.error('代理 IP 删除失败');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
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
</style>
