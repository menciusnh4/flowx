<template>
  <div>
    <div class="panel">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <div style="display:flex; align-items:center; gap:12px">
          <h2 class="section-title" style="margin:0">账号管理</h2>
          <el-tag v-if="accountStore.healthCheckConfig" size="small" :type="accountStore.healthCheckConfig.enabled ? 'success' : 'info'">
            {{ accountStore.healthCheckConfig.enabled ? `定时检测：${Math.round(accountStore.healthCheckConfig.intervalMs / 60000)} 分钟` : '定时检测：已关闭' }}
          </el-tag>
        </div>
        <el-space>
          <el-button type="primary" @click="openAuthDialog">
            <el-icon><Plus /></el-icon>&nbsp; 授权新账号
          </el-button>
          <el-button @click="openCategoryDialog">
            <el-icon><Folder /></el-icon>&nbsp; 分类管理
          </el-button>
          <el-button @click="refresh">
            <el-icon><Refresh /></el-icon>&nbsp; 刷新
          </el-button>
          <el-button @click="openHealthCheckConfigDialog">
            <el-icon><Setting /></el-icon>&nbsp; 检测设置
          </el-button>
          <el-button type="success" @click="checkAllHealth" :loading="checkAllLoading">
            <el-icon><Monitor /></el-icon>&nbsp; 批量检测
          </el-button>
        </el-space>
      </div>

      <div style="display:flex; align-items:center; gap:8px; margin-top: 16px;">
        <span style="font-size: 13px; color: #606266;">分类筛选：</span>
        <el-select v-model="filterCategoryId" placeholder="全部" clearable style="width: 140px" size="small">
          <el-option label="全部分类" value="" />
          <el-option label="未分类" value="unclassified" />
          <el-option v-for="cat in accountStore.categories" :key="cat.id" :label="cat.name" :value="cat.id" />
        </el-select>
      </div>

      <el-table
        v-loading="accountStore.loading"
        :data="filteredAccounts"
        border
        stripe
        style="margin-top: 12px"
      >
        <el-table-column label="平台" width="90">
          <template #default="{ row }">
            <span>{{ platformIcon(row.platform) }} {{ platformName(row.platform) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="账号" min-width="200">
          <template #default="{ row }">
            <div style="display:flex; align-items:center; gap:10px">
              <el-avatar
                :size="40"
                :src="row.avatar"
                :style="{ background: row.avatar ? 'transparent' : '#ec4899', color: '#fff', fontWeight: 600 }"
              >
                {{ (row.nickname || 'U').slice(0, 1) }}
              </el-avatar>
              <div style="line-height:1.4; flex:1">
                <div style="font-size:14px; color:#303133; font-weight:500">{{ row.nickname }}</div>
                <div v-if="row.userId" style="font-size:11px; color:#909399; margin-top:3px">
                  ID: {{ row.userId?.slice(0, 16) }}{{ row.userId && row.userId.length > 16 ? '...' : '' }}
                </div>
                <div v-if="row.fansCount !== undefined || row.followCount !== undefined || row.likeCount !== undefined"
                     style="font-size:11px; color:#606266; margin-top:3px">
                  <span style="margin-right:12px">粉丝: {{ formatCount(row.fansCount) }}</span>
                  <span style="margin-right:12px">关注: {{ formatCount(row.followCount) }}</span>
                  <span>获赞: {{ formatCount(row.likeCount) }}</span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="平台账号" width="110">
          <template #default="{ row }">
            <div v-if="row.platformAccountId" style="font-size:13px; color:#303133">
              <span style="color:#909399; font-size:12px">{{ accountStore.platforms.find((x) => x.key === row.platform)?.platformAccountLabel || '账号' }}</span>
              <br/>
              <span style="font-weight:500">{{ row.platformAccountId }}</span>
            </div>
            <span v-else style="color:#c0c4cc; font-size:12px">—</span>
          </template>
        </el-table-column>
        <el-table-column label="分类" min-width="120">
          <template #default="{ row }">
            <template v-if="row.categoryIds && row.categoryIds.length > 0">
              <el-space wrap :size="4">
                <el-tag v-for="cid in row.categoryIds" :key="cid" type="info" size="small">
                  {{ getCategoryName(cid) }}
                </el-tag>
              </el-space>
            </template>
            <span v-else style="color:#c0c4cc; font-size:12px">未分类</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'active'" type="success" size="small">正常</el-tag>
            <el-tag v-else-if="row.status === 'expired'" type="warning" size="small">已过期</el-tag>
            <el-tag v-else type="info" size="small">未激活</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="授权时间" width="150">
          <template #default="{ row }">
            {{ fmt(row.authorizedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="最近检测" width="140">
          <template #default="{ row }">
            <span v-if="row.lastChecked" style="font-size:12px; color:#606266">
              {{ fmt(row.lastChecked) }}
            </span>
            <span v-else style="font-size:12px; color:#c0c4cc">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; gap: 6px;">
                <el-button size="small" type="success" style="width: 105px; margin: 0;" @click="openCreator(asAccount(row))" :loading="openingId === asAccount(row).id">
                  <el-icon><Link /></el-icon>&nbsp;创作中心
                </el-button>
                <el-button size="small" type="primary" style="width: 75px; margin: 0;" @click="editRemark(asAccount(row))">
                  编辑
                </el-button>
              </div>
              <div style="display: flex; gap: 6px;">
                <el-button size="small" type="warning" style="width: 105px; margin: 0;" @click="refreshToken(asAccount(row))" :loading="refreshingId === asAccount(row).id" title="打开平台页面，刷新账号信息/粉丝数/关注数/获赞数">刷新</el-button>
                <el-button size="small" type="danger" style="width: 75px; margin: 0;" @click="remove(asAccount(row))">删除</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="filteredAccounts.length === 0 && !accountStore.loading" class="empty-hint">
        {{ filterCategoryId ? '当前分类下没有账号。' : '还没有账号，点击右上角"授权新账号"开始。' }}
        <div v-if="!filterCategoryId" style="font-size:12px; color:#909399; margin-top:6px">
          授权会弹出平台登录窗口，扫码完成后点击右上角红色"✅ 登录完成，保存账号"按钮，或直接关闭窗口即可。
        </div>
      </div>
    </div>

    <!-- 健康检测配置对话框 -->
    <el-dialog v-model="healthCheckDialogVisible" title="定时检测设置" width="440px">
      <el-form :model="healthCheckForm" label-width="110px">
        <el-form-item label="启用定时检测">
          <el-switch v-model="healthCheckForm.enabled" />
        </el-form-item>
        <el-form-item label="检测间隔">
          <el-select v-model="healthCheckForm.intervalMinutes" :disabled="!healthCheckForm.enabled" style="width:100%">
            <el-option v-for="opt in healthCheckIntervalOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="首次延迟">
          <el-input-number v-model="healthCheckForm.initialDelayMinutes" :min="1" :max="60" :disabled="!healthCheckForm.enabled" style="width:100%" />
          <span style="font-size:12px; color:#909399; margin-left:110px; display:block; margin-top:-10px">应用启动后多少分钟开始第一次检测（默认为 5 分钟）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="healthCheckDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveHealthCheckConfig" :loading="savingConfig">保存</el-button>
      </template>
    </el-dialog>

    <!-- 选择平台授权对话框 -->
    <el-dialog v-model="authVisible" title="选择平台授权" width="460px">
      <el-radio-group v-model="authPlatform" style="width:100%">
        <el-space direction="vertical" style="width:100%">
          <el-radio v-for="p in accountStore.platforms" :key="p.key" :value="p.key" style="width:100%">
            <span style="font-size:15px; margin-right:4px">{{ p.icon }}</span>
            {{ p.name }}
            <span style="color:#909399; font-size:12px; margin-left:8px">
              已授权 {{ accountStore.byPlatform(p.key).length }} 个账号
            </span>
          </el-radio>
        </el-space>
      </el-radio-group>
      <template #footer>
        <el-button @click="authVisible = false">取消</el-button>
        <el-button type="primary" @click="startAuth" :loading="authing">开始授权</el-button>
      </template>
    </el-dialog>

    <!-- 编辑账号对话框 -->
    <el-dialog v-model="editVisible" title="编辑账号" width="400px">
      <el-form label-width="80px">
        <el-form-item label="昵称">
          <el-input v-model="editRow.nickname" placeholder="自定义昵称" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editRow.remark" placeholder="如：日常号/广告号" />
        </el-form-item>
        <el-form-item label="所属分类">
          <el-select v-model="editRow.categoryIds" placeholder="选择所属分类（最多5个）" multiple :multiple-limit="5" clearable style="width:100%">
            <el-option v-for="cat in accountStore.categories" :key="cat.id" :label="cat.name" :value="cat.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit" :loading="saving">保存</el-button>
      </template>
    </el-dialog>

    <!-- 分类管理对话框 -->
    <el-dialog v-model="categoryDialogVisible" title="分类管理" width="500px" destroy-on-close>
      <div style="margin-bottom: 16px; display: flex; gap: 8px;">
        <el-input v-model="newCategoryName" placeholder="输入新分类名称" @keyup.enter="createCategory" />
        <el-button type="primary" @click="createCategory" :loading="creatingCategory">新建分类</el-button>
      </div>
      <el-table :data="accountStore.categories" border size="small" style="width: 100%" max-height="300px">
        <el-table-column label="分类名称">
          <template #default="{ row }">
            <el-input v-if="editingCategoryId === asCategory(row).id" v-model="editingCategoryName" size="small" @keyup.enter="saveCategoryName(asCategory(row))" />
            <span v-else>{{ asCategory(row).name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center">
          <template #default="{ row }">
            <template v-if="editingCategoryId === asCategory(row).id">
              <el-button size="small" type="success" link @click="saveCategoryName(asCategory(row))">保存</el-button>
              <el-button size="small" link @click="editingCategoryId = ''">取消</el-button>
            </template>
            <template v-else>
              <el-button size="small" type="primary" link @click="startEditCategory(asCategory(row))">编辑</el-button>
              <el-button size="small" type="danger" link @click="deleteCategory(asCategory(row))">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, Link, Monitor, Setting, Folder } from '@element-plus/icons-vue';
import { useAccountStore } from '../stores/account';
import { electronApi } from '../utils/electron';
import type { AccountInfo, AccountCategory } from '../../types';

const accountStore = useAccountStore();
const authVisible = ref(false);
const authPlatform = ref<string>('xiaohongshu');
const authing = ref(false);
const refreshingId = ref<string>('');
const openingId = ref<string>('');
const editVisible = ref(false);
const editRow = reactive<{ id: string; nickname: string; remark: string; categoryIds: string[] }>({
  id: '',
  nickname: '',
  remark: '',
  categoryIds: [],
});
const saving = ref(false);
const checkAllLoading = ref(false);
const healthCheckDialogVisible = ref(false);
const savingConfig = ref(false);
const healthCheckIntervalOptions = [
  { label: '15 分钟', value: 15 },
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '2 小时', value: 120 },
  { label: '6 小时', value: 360 },
  { label: '12 小时', value: 720 },
  { label: '24 小时', value: 1440 },
];
const healthCheckForm = reactive({
  enabled: true,
  intervalMinutes: 60,
  initialDelayMinutes: 5,
});

// 分类管理相关的状态
const filterCategoryId = ref<string>('');
const categoryDialogVisible = ref(false);
const newCategoryName = ref('');
const creatingCategory = ref(false);
const editingCategoryId = ref('');
const editingCategoryName = ref('');

// 根据分类过滤账号
const filteredAccounts = computed(() => {
  if (!filterCategoryId.value) {
    return accountStore.accounts;
  }
  if (filterCategoryId.value === 'unclassified') {
    return accountStore.accounts.filter((a) => !a.categoryIds || a.categoryIds.length === 0);
  }
  return accountStore.accounts.filter((a) => a.categoryIds && a.categoryIds.includes(filterCategoryId.value));
});

// 获取分类名称辅助函数
function getCategoryName(id: string) {
  return accountStore.categories.find((c) => c.id === id)?.name || '未知分类';
}

function fmt(t: number) {
  if (!t) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function platformName(p: string) {
  return accountStore.platforms.find((x) => x.key === p)?.name || p;
}
function platformIcon(p: string) {
  return accountStore.platforms.find((x) => x.key === p)?.icon || '';
}
function formatCount(n: number | undefined): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** 类型辅助：将 el-table 默认的 DefaultRow 断言为 AccountInfo */
function asAccount(row: unknown): AccountInfo {
  return row as AccountInfo;
}

/** 类型辅助：将 el-table 默认的 DefaultRow 断言为 AccountCategory */
function asCategory(row: unknown): AccountCategory {
  return row as AccountCategory;
}

async function openAuthDialog() {
  await accountStore.loadPlatforms();
  if (accountStore.platforms.length === 0) {
    ElMessage.error('暂无可用平台');
    return;
  }
  authPlatform.value = accountStore.platforms[0].key;
  authVisible.value = true;
}

async function startAuth() {
  authing.value = true;
  try {
    const acc = await electronApi.beginAuth(authPlatform.value as any);
    ElMessage.success(`已授权: ${acc.nickname}`);
    authVisible.value = false;
    await accountStore.refreshAccounts();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    authing.value = false;
  }
}

async function refresh() {
  await accountStore.refreshAccounts();
  ElMessage.success('账号列表已刷新');
}

// 用已保存的登录态打开平台创作中心
async function openCreator(row: AccountInfo) {
  openingId.value = row.id;
  try {
    const r = await electronApi.openCreator(row.id);
    if (r.ok) {
      ElMessage.success(
        `已打开创作中心（注入 cookies=${r.injected}，跳过反爬 cookie=${r.skipped}，失败=${r.failed}）`,
      );
    } else {
      ElMessage.error(`打开失败: ${r.error || '未知错误'}`);
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    openingId.value = '';
  }
}

async function remove(row: AccountInfo) {
  try {
    await ElMessageBox.confirm(`确定删除账号「${row.nickname}」吗？`, '删除账号', { type: 'warning' });
  } catch { return; }
  await electronApi.deleteAccount(row.id);
  await accountStore.refreshAccounts();
  ElMessage.success('已删除');
}

function editRemark(row: AccountInfo) {
  editRow.id = row.id;
  editRow.nickname = row.nickname;
  editRow.remark = row.remark || '';
  editRow.categoryIds = row.categoryIds ? [...row.categoryIds] : [];
  editVisible.value = true;
}

async function saveEdit() {
  saving.value = true;
  try {
    await accountStore.updateAccount(editRow.id, {
      nickname: editRow.nickname,
      remark: editRow.remark,
      categoryIds: [...editRow.categoryIds],
    });
    editVisible.value = false;
    ElMessage.success('已更新');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function refreshToken(row: AccountInfo) {
  refreshingId.value = row.id;
  try {
    const acc = await electronApi.refreshToken(row.id);
    ElMessage.success(`已刷新: ${acc.nickname}`);
    await accountStore.refreshAccounts();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    refreshingId.value = '';
  }
}

/** 批量检测所有账号 */
async function checkAllHealth() {
  if (accountStore.accounts.length === 0) {
    ElMessage.warning('暂无账号，无需检测');
    return;
  }
  checkAllLoading.value = true;
  try {
    ElMessage.info(`开始检测 ${accountStore.accounts.length} 个账号，这可能需要几分钟...`);
    await accountStore.checkAllAccountsHealth();
    ElMessage.success('所有账号检测完成');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    checkAllLoading.value = false;
  }
}

/** 打开健康检测设置对话框 */
async function openHealthCheckConfigDialog() {
  try {
    const cfg = await accountStore.loadHealthCheckConfig();
    healthCheckForm.enabled = cfg.enabled;
    healthCheckForm.intervalMinutes = Math.round(cfg.intervalMs / 60000);
    healthCheckForm.initialDelayMinutes = Math.max(1, Math.round(cfg.initialDelayMs / 60000));
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
  healthCheckDialogVisible.value = true;
}

/** 保存健康检测配置 */
async function saveHealthCheckConfig() {
  savingConfig.value = true;
  try {
    await accountStore.setHealthCheckConfig({
      intervalMs: healthCheckForm.intervalMinutes * 60000,
      initialDelayMs: healthCheckForm.initialDelayMinutes * 60000,
      enabled: healthCheckForm.enabled,
    });
    ElMessage.success(
      healthCheckForm.enabled
        ? `已保存：定时检测间隔 ${healthCheckForm.intervalMinutes} 分钟`
        : '已关闭定时检测',
    );
    healthCheckDialogVisible.value = false;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingConfig.value = false;
  }
}

// 分类管理操作
function openCategoryDialog() {
  categoryDialogVisible.value = true;
}

async function createCategory() {
  const name = newCategoryName.value.trim();
  if (!name) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  creatingCategory.value = true;
  try {
    await accountStore.createCategory(name);
    newCategoryName.value = '';
    ElMessage.success('创建成功');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    creatingCategory.value = false;
  }
}

function startEditCategory(row: { id: string; name: string }) {
  editingCategoryId.value = row.id;
  editingCategoryName.value = row.name;
}

async function saveCategoryName(row: { id: string }) {
  const name = editingCategoryName.value.trim();
  if (!name) {
    ElMessage.warning('分类名称不能为空');
    return;
  }
  try {
    await accountStore.updateCategory(row.id, name);
    editingCategoryId.value = '';
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function deleteCategory(row: { id: string; name: string }) {
  try {
    await ElMessageBox.confirm(
      `确定删除分类「${row.name}」吗？\n删除后绑定该分类的账号将变更为"未分类"。`,
      '删除分类',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await accountStore.deleteCategory(row.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await accountStore.loadCategories();
  // 异步加载健康检测配置（不阻塞 UI）
  accountStore.loadHealthCheckConfig().catch(() => {});
});
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 20px; }
.section-title { font-size: 16px; font-weight: 600; color: #303133; }
.empty-hint { padding: 60px 16px; text-align: center; color: #909399; font-size: 14px; }
</style>
