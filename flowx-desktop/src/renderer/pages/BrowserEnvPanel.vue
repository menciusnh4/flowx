<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">环境配置</h2>
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>&nbsp;添加环境配置
        </el-button>
      </div>

      <div v-loading="envStore.loading || listLoading" class="data-list" style="--cols: minmax(150px,1.4fr) minmax(260px,2.4fr) minmax(180px,1.8fr) 160px 150px; margin-top: 16px">
        <header class="data-list__head">
          <div>环境名称</div>
          <div>浏览器 User-Agent</div>
          <div>绑定的代理 IP</div>
          <div>创建时间</div>
          <div class="data-list__actions">操作</div>
        </header>

        <article class="data-list__row" v-for="env in pagedResult.items" :key="env.id">
          <div class="cell-name">{{ env.name }}</div>
          <div class="cell-mono" :title="env.userAgent">{{ env.userAgent }}</div>
          <div>
            <el-tag v-if="env.proxyId" type="success" size="small">
              {{ getProxyLabel(env.proxyId) }}
            </el-tag>
            <span v-else style="color:#c0c4cc; font-size:12px">未绑定代理（使用本机直连）</span>
          </div>
          <div>{{ formatTime(env.createdAt) }}</div>
          <div class="data-list__actions">
            <button class="icon-btn primary" type="button" title="编辑" @click="openEditDialog(asEnv(env))">
              <el-icon><Edit /></el-icon>
            </button>
            <button class="icon-btn danger" type="button" title="删除" @click="handleDelete(env.id)">
              <el-icon><Delete /></el-icon>
            </button>
          </div>
        </article>
      </div>

      <ListPager
        v-if="pagedResult.total > 0"
        v-model:page="currentPage"
        v-model:pageSize="pageSize"
        :total="pagedResult.total"
        unit="个环境"
        @change="onPagerChange"
      />

      <div v-if="pagedResult.items.length === 0 && !listLoading && !envStore.loading" class="empty-hint">
        暂无环境配置，点击右上角"添加环境配置"创建。
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
import { ref, onMounted, reactive, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { useEnvStore } from '../stores/env';
import type { BrowserEnvironment, PagedResult } from '../../types';
import ListPager from '../components/ListPager.vue';

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
  loadList(1, pageSize.value);
});

// ============ 服务端分页（筛选下推主进程，列表走 queryEnvironments） ============
const currentPage = ref(1);
const pageSize = ref(10);
const listLoading = ref(false);
const pagedResult = ref<PagedResult<BrowserEnvironment>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 10,
  totalPages: 1,
});

/** 加载某一页（服务端分页）；越界页码回退到末页，避免删除/刷新后空白 */
async function loadList(page: number, size: number) {
  listLoading.value = true;
  try {
    let res = await envStore.loadEnvironmentsPaged({}, page, size);
    if (res.items.length === 0 && res.total > 0 && page !== res.totalPages) {
      res = await envStore.loadEnvironmentsPaged({}, res.totalPages, size);
    }
    pagedResult.value = res;
    currentPage.value = res.page;
  } finally {
    listLoading.value = false;
  }
}

/** 翻页 / 改每页大小：由 ListPager 的 @change 触发 */
function onPagerChange(page: number, size: number) {
  loadList(page, size);
}

// 全量环境变化（删除 / 新增 / 编辑）后同步列表当前页
watch(
  () => envStore.environments,
  () => loadList(currentPage.value, pageSize.value),
);

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
    await ElMessageBox.confirm(
      '确定删除此环境配置？（绑定了此环境的账号将变更为未绑定环境）',
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
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
