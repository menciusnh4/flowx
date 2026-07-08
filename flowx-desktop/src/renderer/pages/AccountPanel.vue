<template>
  <div class="accounts-container">
    <div class="panel header-actions-panel">
      <div class="header-flex">
        <div class="title-wrap">
          <h2 class="section-title" style="margin: 0">
            <el-icon><User /></el-icon>账号管理
          </h2>
          <el-tag v-if="accountStore.healthCheckConfig" size="small" :type="accountStore.healthCheckConfig.enabled ? 'success' : 'info'" effect="plain" class="health-tag">
            {{ accountStore.healthCheckConfig.enabled ? `自动检测：每 ${Math.round(accountStore.healthCheckConfig.intervalMs / 60000)} 分钟` : '自动检测：已禁用' }}
          </el-tag>
        </div>
        <div class="actions-wrap">
          <el-button type="primary" @click="openAuthDialog" class="action-btn">
            <el-icon><Plus /></el-icon>&nbsp; 授权新账号
          </el-button>
          <el-button @click="openCategoryDialog" class="action-btn">
            <el-icon><Folder /></el-icon>&nbsp; 分类管理
          </el-button>
          <el-button @click="openHealthCheckConfigDialog" class="action-btn">
            <el-icon><Setting /></el-icon>&nbsp; 定时设置
          </el-button>
          <el-button type="success" @click="checkAllHealth" :loading="checkAllLoading" class="action-btn">
            <el-icon><Monitor /></el-icon>&nbsp; 批量检测健康
          </el-button>
          <el-button @click="refresh" class="action-btn refresh-btn" circle>
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label"><el-icon><Filter /></el-icon>按分类筛选：</span>
        <el-select v-model="filterCategoryId" placeholder="全部" clearable class="filter-select" size="default">
          <el-option label="全部分类" value="" />
          <el-option label="未分类" value="unclassified" />
          <el-option v-for="cat in accountStore.categories" :key="cat.id" :label="cat.name" :value="cat.id" />
        </el-select>
      </div>

      <!-- 账号卡片网格流 -->
      <div v-loading="accountStore.loading" class="account-grid-flow">
        <div v-for="row in filteredAccounts" :key="row.id" class="flow-account-card">
          <!-- 头部：平台标识与健康状态 -->
          <div class="card-header">
            <div class="platform-badge" :class="'badge-' + row.platform">
              <img v-if="getPlatformIcon(row.platform)" :src="getPlatformIcon(row.platform)" class="badge-icon" />
              <span>{{ platformName(row.platform) }}</span>
            </div>
            <div class="status-indicator">
              <span class="status-dot" :class="'dot-' + row.status"></span>
              <span class="status-text">{{ row.status === 'active' ? '正常' : row.status === 'expired' ? '已过期' : '未激活' }}</span>
            </div>
          </div>

          <!-- 主体：头像与昵称 -->
          <div class="card-profile">
            <el-avatar
              :size="52"
              :src="row.avatar"
              :style="{ background: row.avatar ? 'transparent' : '#6366f1', color: '#fff', fontWeight: 800, fontSize: '18px' }"
              class="profile-avatar"
            >
              {{ (row.nickname || 'U').slice(0, 1).toUpperCase() }}
            </el-avatar>
            <div class="profile-info">
              <div class="profile-name" :title="row.nickname">{{ row.nickname }}</div>
              <div class="profile-remark" v-if="row.remark">{{ row.remark }}</div>
              <div class="profile-id" v-if="row.platformAccountId">
                {{ accountStore.platforms.find((x) => x.key === row.platform)?.platformAccountLabel || '号' }}: {{ row.platformAccountId }}
              </div>
            </div>
          </div>

          <!-- 数据展示三栏 -->
          <div class="card-stats" v-if="row.fansCount !== undefined || row.followCount !== undefined || row.likeCount !== undefined">
            <div class="stat-item">
              <span class="stat-num">{{ formatCount(row.fansCount) }}</span>
              <span class="stat-label">粉丝</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item">
              <span class="stat-num">{{ formatCount(row.followCount) }}</span>
              <span class="stat-label">关注</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item">
              <span class="stat-num">{{ formatCount(row.likeCount) }}</span>
              <span class="stat-label">获赞</span>
            </div>
          </div>

          <!-- 标签区：分类与环境 -->
          <div class="card-tags">
            <div class="tag-row">
              <span class="tag-label">分类:</span>
              <div class="tag-group" v-if="row.categoryIds && row.categoryIds.length > 0">
                <el-tag v-for="cid in row.categoryIds" :key="cid" class="category-tag" size="small">
                  {{ getCategoryName(cid) }}
                </el-tag>
              </div>
              <span class="tag-empty" v-else>未分类</span>
            </div>
            <div class="tag-row">
              <span class="tag-label">环境:</span>
              <el-tag v-if="row.envId" type="success" size="small" effect="light" class="env-tag">
                {{ getEnvName(row.envId) }}
              </el-tag>
              <span class="tag-empty" v-else>本机直连</span>
            </div>
          </div>

          <!-- 时间说明 -->
          <div class="card-time">
            <span>授权：{{ fmt(row.authorizedAt) }}</span>
            <span v-if="row.lastChecked">检测：{{ fmt(row.lastChecked) }}</span>
          </div>

          <!-- 底部操作按钮 -->
          <div class="card-actions">
            <el-button size="small" type="success" link @click="openCreator(asAccount(row))" :loading="openingId === asAccount(row).id">
              <el-icon><Link /></el-icon>&nbsp;创作中心
            </el-button>
            <el-button size="small" type="primary" link @click="editRemark(asAccount(row))">
              <el-icon><Edit /></el-icon>&nbsp;编辑
            </el-button>
            <el-button size="small" type="warning" link @click="refreshToken(asAccount(row))" :loading="refreshingId === asAccount(row).id" title="刷新数据">
              <el-icon><Refresh /></el-icon>&nbsp;刷新
            </el-button>
            <el-button size="small" type="danger" link @click="remove(asAccount(row))">
              <el-icon><Delete /></el-icon>&nbsp;删除
            </el-button>
          </div>
        </div>
      </div>

      <div v-if="filteredAccounts.length === 0 && !accountStore.loading" class="empty-hint">
        {{ filterCategoryId ? '当前分类下没有账号。' : '还没有账号，点击右上角"授权新账号"开始。' }}
        <div v-if="!filterCategoryId" style="font-size:12px; color:#909399; margin-top:6px">
          授权会弹出平台登录窗口，扫码完成后点击右上角红色"✅ 登录完成，保存账号"按钮，或直接关闭窗口即可。
        </div>
      </div>
    </div>

    <!-- 健康检测配置对话框 -->
    <el-dialog v-model="healthCheckDialogVisible" title="定时检测设置" width="500px">
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
          <div style="width: 100%; display: flex; flex-direction: column; gap: 6px;">
            <el-input-number v-model="healthCheckForm.initialDelayMinutes" :min="1" :max="60" :disabled="!healthCheckForm.enabled" style="width:100%" />
            <span style="font-size:12px; color:#94a3b8; line-height: 1.4; display:block; font-weight: 500;">
              应用启动后多少分钟开始第一次检测（默认为 5 分钟）
            </span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="healthCheckDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveHealthCheckConfig" :loading="savingConfig">保存</el-button>
      </template>
    </el-dialog>

    <!-- 选择平台授权对话框 -->
    <el-dialog v-model="authVisible" title="选择平台授权" width="480px">
      <el-radio-group v-model="authPlatform" class="platform-radio-group">
        <el-radio v-for="p in accountStore.platforms" :key="p.key" :value="p.key" class="platform-radio">
          <div class="platform-option">
            <div class="platform-main-info">
              <div class="platform-icon-wrap">
                <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-icon" />
              </div>
              <span class="platform-name">{{ p.name }}</span>
            </div>
            <span class="platform-count">
              已授权 {{ accountStore.byPlatform(p.key).length }} 个账号
            </span>
          </div>
        </el-radio>
      </el-radio-group>
      <div style="margin-top: 20px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px;">
        <span style="font-size:13px; font-weight:600; display:block; margin-bottom:8px; color: #475569">绑定浏览器环境（隔离指纹与代理 IP）</span>
        <el-select v-model="authEnvId" placeholder="选择绑定的浏览器指纹与代理（可选）" clearable style="width:100%">
          <el-option label="使用本机直连出网" value="" />
          <el-option v-for="env in envStore.environments" :key="env.id" :label="env.name" :value="env.id" />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="authVisible = false">取消</el-button>
        <el-button type="primary" @click="startAuth" :loading="authing">开始授权</el-button>
      </template>
    </el-dialog>

    <!-- 编辑账号对话框 -->
    <el-dialog v-model="editVisible" title="编辑账号" width="500px">
      <el-form label-width="100px">
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
        <el-form-item label="浏览器环境">
          <el-select v-model="editRow.envId" placeholder="选择关联的浏览器环境与代理 IP" clearable style="width:100%">
            <el-option label="使用本机直连" value="" />
            <el-option v-for="env in envStore.environments" :key="env.id" :label="env.name" :value="env.id" />
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
      <!-- 分类条目列表 -->
      <div v-loading="accountStore.loading" class="category-item-list" style="max-height: 300px; overflow-y: auto; margin-top: 12px;margin-bottom:18px">
        <div v-if="accountStore.categories.length === 0" class="category-empty">
          暂无分类数据，请输入名称并新建
        </div>
        <div v-else v-for="cat in accountStore.categories" :key="cat.id" class="category-item-row">
          <div class="category-item-content">
            <el-input 
              v-if="editingCategoryId === asCategory(cat).id" 
              v-model="editingCategoryName" 
              size="small" 
              style="width: 200px" 
              @keyup.enter="saveCategoryName(asCategory(cat))" 
            />
            <span v-else class="category-name-text">{{ asCategory(cat).name }}</span>
          </div>
          
          <div class="category-item-actions">
            <template v-if="editingCategoryId === asCategory(cat).id">
              <el-button size="small" type="success" link @click="saveCategoryName(asCategory(cat))">保存</el-button>
              <el-button size="small" link @click="editingCategoryId = ''">取消</el-button>
            </template>
            <template v-else>
              <el-button size="small" type="primary" link @click="startEditCategory(asCategory(cat))">编辑</el-button>
              <el-button size="small" type="danger" link @click="deleteCategory(asCategory(cat))">删除</el-button>
            </template>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, Link, Monitor, Setting, Folder, Delete } from '@element-plus/icons-vue';
import { useAccountStore } from '../stores/account';
import { useEnvStore } from '../stores/env';
import { electronApi } from '../utils/electron';
import type { AccountInfo, AccountCategory } from '../../types';

// 平台图标（SVG/PNG，通过 Vite import 引入
import iconXiaohongshu from '../assets/xiaohongshu.svg';
import iconDouyin from '../assets/douyin.svg';
import iconKuaishou from '../assets/kuaishou.svg';
import iconBilibili from '../assets/bilibili.svg';
import iconWechatChannels from '../assets/wechat_channels.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';

const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu: iconXiaohongshu,
  douyin: iconDouyin,
  kuaishou: iconKuaishou,
  bilibili: iconBilibili,
  wechat_channels: iconWechatChannels,
  weibo: iconWeibo,
  zhihu: iconZhihu,
  toutiao: iconToutiao,
};

/** 获取平台图标 URL，找不到则返回空字符串 */
function getPlatformIcon(p: string): string {
  return PLATFORM_ICONS[p] || '';
}

const accountStore = useAccountStore();
const envStore = useEnvStore();

const authVisible = ref(false);
const authPlatform = ref<string>('xiaohongshu');
const authEnvId = ref<string>(''); // 授权绑定的环境 id
const authing = ref(false);
const refreshingId = ref<string>('');
const openingId = ref<string>('');
const editVisible = ref(false);
const editRow = reactive<{ id: string; nickname: string; remark: string; categoryIds: string[]; envId: string }>({
  id: '',
  nickname: '',
  remark: '',
  categoryIds: [],
  envId: '',
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
function getEnvName(envId: string) {
  return envStore.environments.find((e) => e.id === envId)?.name || '未知环境';
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
  authEnvId.value = ''; // 重置授权时绑定的环境
  authVisible.value = true;
}

async function startAuth() {
  authing.value = true;
  try {
    const acc = await electronApi.beginAuth(authPlatform.value as any, authEnvId.value || null);
    ElMessage.success(`已授权: ${acc.nickname}`);
    authVisible.value = false;
    await accountStore.refreshAccounts();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 用户主动关闭窗口取消授权，不弹错误提示
    if (msg !== '用户取消授权') {
      ElMessage.error(msg);
    }
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
  editRow.envId = row.envId || '';
  editVisible.value = true;
}

async function saveEdit() {
  saving.value = true;
  try {
    await accountStore.updateAccount(editRow.id, {
      nickname: editRow.nickname,
      remark: editRow.remark,
      categoryIds: [...editRow.categoryIds],
      envId: editRow.envId || null,
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
  envStore.loadAll().catch(() => {});
  // 异步加载健康检测配置（不阻塞 UI）
  accountStore.loadHealthCheckConfig().catch(() => {});
});
</script>

<style scoped>
.accounts-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.header-flex {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
}

.title-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}

.health-tag {
  border-radius: 6px;
  font-weight: 600;
}

.actions-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.action-btn {
  height: 36px !important;
  font-size: 13px !important;
}

.refresh-btn {
  width: 36px !important;
  height: 36px !important;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
}

.filter-label {
  font-size: 13px;
  color: #64748b;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}

.filter-select {
  width: 150px;
}

/* 授权对话框中的平台选择美化为卡片式 */
.platform-radio-group {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.platform-radio {
  width: 100% !important;
  margin-right: 0 !important;
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  border-radius: 10px !important;
  padding: 10px 16px !important;
  height: auto !important;
  box-sizing: border-box;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

.platform-radio:hover {
  background: rgba(99, 102, 241, 0.03);
  border-color: rgba(99, 102, 241, 0.2) !important;
}

.platform-radio :deep(.el-radio__input.is-checked + .el-radio__label) {
  width: 100%;
}

.platform-radio :deep(.el-radio__label) {
  padding-left: 12px;
  width: 100%;
  box-sizing: border-box;
}

.platform-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.platform-main-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.platform-icon-wrap {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  box-shadow: 0 2px 4px rgba(0,0,0,0.03);
}

.platform-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.platform-name {
  font-size: 14px;
  color: #1e293b;
  font-weight: 700;
}

.platform-count {
  color: #64748b;
  font-size: 12px;
  font-weight: 500;
}

/* 账号卡片流样式 */
.account-grid-flow {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 20px;
  margin-top: 16px;
}

.flow-account-card {
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 16px;
  padding: 20px;
  box-shadow: var(--glow-shadow-sm);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.flow-account-card:hover {
  border-color: rgba(99, 102, 241, 0.18);
  background: rgba(99, 102, 241, 0.04);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -4px rgba(99, 102, 241, 0.08), 0 4px 12px -6px rgba(0, 0, 0, 0.04);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

/* 平台微徽章 */
.platform-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 700;
}

.badge-icon {
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.badge-xiaohongshu { background: rgba(255, 77, 79, 0.08); color: #ff4d4f; }
.badge-douyin { background: rgba(6, 182, 212, 0.08); color: #06b6d4; }
.badge-kuaishou { background: rgba(249, 115, 22, 0.08); color: #f97316; }
.badge-wechat_channels { background: rgba(16, 185, 129, 0.08); color: #10b981; }
.badge-zhihu { background: rgba(0, 102, 255, 0.08); color: #0066ff; }
.badge-toutiao { background: rgba(240, 65, 52, 0.08); color: #f04134; }

/* 状态灯与文字 */
.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.dot-active {
  background-color: #10b981;
  box-shadow: 0 0 8px #10b981;
  animation: pulse 2s infinite;
}

.dot-expired {
  background-color: #f59e0b;
}

.dot-disabled {
  background-color: #94a3b8;
}

.status-text {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
}

/* 个人信息 */
.card-profile {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.profile-avatar {
  border: 2px solid rgba(255, 255, 255, 0.8);
  box-shadow: var(--glow-shadow-sm);
}

.profile-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  flex: 1;
}

.profile-name {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-remark {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
}

.profile-id {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
}

/* 数据展示栏 */
.card-stats {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0, 0, 0, 0.015);
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 16px;
  border: 1px solid rgba(0, 0, 0, 0.02);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}

.stat-num {
  font-size: 15px;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.02em;
}

.stat-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  margin-top: 1px;
}

.stat-divider {
  width: 1px;
  height: 24px;
  background-color: rgba(0, 0, 0, 0.05);
}

/* 标签区 */
.card-tags {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag-label {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 600;
  min-width: 32px;
}

.tag-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag-empty {
  font-size: 12px;
  color: #cbd5e1;
  font-weight: 500;
}

.env-tag {
  font-weight: 600;
  border-radius: 6px;
}

.category-tag {
  background-color: rgba(99, 102, 241, 0.06) !important;
  color: #6366f1 !important;
  border: 1px solid rgba(99, 102, 241, 0.15) !important;
  border-radius: 6px;
  font-weight: 700;
}

/* 时间 */
.card-time {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 16px;
  font-weight: 500;
}

/* 操作面板 */
.card-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
}

.card-actions :deep(.el-button) {
  margin: 0 !important;
  font-weight: 700 !important;
  font-size: 12px !important;
  padding: 4px 6px !important;
  border-radius: 6px !important;
  transition: all 0.2s ease !important;
}

.card-actions :deep(.el-button--success:hover) {
  color: #10b981 !important;
  background-color: rgba(16, 185, 129, 0.06) !important;
}

.card-actions :deep(.el-button--primary:hover) {
  color: #6366f1 !important;
  background-color: rgba(99, 102, 241, 0.06) !important;
}

.card-actions :deep(.el-button--warning:hover) {
  color: #e6a23c !important;
  background-color: rgba(230, 162, 60, 0.06) !important;
}

.card-actions :deep(.el-button--danger:hover) {
  color: #f56c6c !important;
  background-color: rgba(245, 108, 108, 0.06) !important;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}

/* 分类管理列表样式 */
.category-item-list {
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.015);
  padding: 8px 12px;
  box-sizing: border-box;
}

.category-empty {
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
  padding: 24px 0;
  font-weight: 500;
}

.category-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.03);
  transition: all 0.2s ease;
}

.category-item-row:last-child {
  border-bottom: none;
}

.category-item-row:hover {
  background: rgba(99, 102, 241, 0.02);
  border-radius: 8px;
}

.category-name-text {
  font-size: 14px;
  font-weight: 700;
  color: #1e293b;
}

.category-item-actions {
  display: flex;
  gap: 12px;
}

.category-item-actions :deep(.el-button) {
  margin: 0 !important;
  font-weight: 700 !important;
  font-size: 13px !important;
}
</style>
