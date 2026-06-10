<template>
  <div>
    <div class="panel">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <h2 class="section-title" style="margin:0">账号管理</h2>
        <el-space>
          <el-button type="primary" @click="openAuthDialog">
            <el-icon><Plus /></el-icon>&nbsp; 授权新账号
          </el-button>
          <el-button @click="refresh">
            <el-icon><Refresh /></el-icon>&nbsp; 刷新
          </el-button>
        </el-space>
      </div>

      <el-table
        v-loading="accountStore.loading"
        :data="accountStore.accounts"
        border
        stripe
        style="margin-top: 12px"
      >
        <el-table-column label="平台" width="100">
          <template #default="{ row }">
            <span>{{ platformIcon(row.platform) }} {{ platformName(row.platform) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="账号" min-width="240">
          <template #default="{ row }">
            <div style="display:flex; align-items:center; gap:10px">
              <el-avatar
                :size="36"
                :src="row.avatar"
                :style="{ background: row.avatar ? 'transparent' : '#ec4899', color: '#fff', fontWeight: 600 }"
              >
                {{ (row.nickname || 'U').slice(0, 1) }}
              </el-avatar>
              <div style="line-height:1.3">
                <div style="font-size:14px; color:#303133; font-weight:500">{{ row.nickname }}</div>
                <div v-if="row.userId" style="font-size:11px; color:#909399; margin-top:2px">
                  ID: {{ row.userId }}
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'active'" type="success" size="small">正常</el-tag>
            <el-tag v-else-if="row.status === 'expired'" type="warning" size="small">已过期</el-tag>
            <el-tag v-else type="info" size="small">未激活</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="授权时间" width="170">
          <template #default="{ row }">
            {{ fmt(row.authorizedAt) }}
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140">
          <template #default="{ row }">
            <span style="color:#606266">{{ row.remark || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="340" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="success" @click="openCreator(row)" :loading="openingId === row.id">
              <el-icon><Link /></el-icon>&nbsp;创作中心
            </el-button>
            <el-button size="small" @click="editRemark(row)">编辑</el-button>
            <el-button size="small" type="warning" @click="refreshToken(row)" :loading="refreshingId === row.id">刷新</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="accountStore.accounts.length === 0 && !accountStore.loading" class="empty-hint">
        还没有账号，点击右上角"授权新账号"开始。
        <div style="font-size:12px; color:#909399; margin-top:6px">
          授权会弹出平台登录窗口，扫码完成后点击右上角红色"✅ 登录完成，保存账号"按钮，或直接关闭窗口即可。
        </div>
      </div>
    </div>

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

    <!-- 编辑备注对话框 -->
    <el-dialog v-model="editVisible" title="编辑账号" width="400px">
      <el-form label-width="70px">
        <el-form-item label="昵称">
          <el-input v-model="editRow.nickname" placeholder="自定义昵称" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editRow.remark" placeholder="如：日常号/广告号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, Link } from '@element-plus/icons-vue';
import { useAccountStore } from '../stores/account';
import { electronApi } from '../utils/electron';
import type { AccountInfo } from '../../types';

const accountStore = useAccountStore();
const authVisible = ref(false);
const authPlatform = ref<string>('xiaohongshu');
const authing = ref(false);
const refreshingId = ref<string>('');
const openingId = ref<string>('');
const editVisible = ref(false);
const editRow = reactive<{ id: string; nickname: string; remark: string }>({ id: '', nickname: '', remark: '' });
const saving = ref(false);

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
  editVisible.value = true;
}

async function saveEdit() {
  saving.value = true;
  try {
    await electronApi.updateAccount(editRow.id, { nickname: editRow.nickname, remark: editRow.remark });
    await accountStore.refreshAccounts();
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

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
});
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 20px; }
.section-title { font-size: 16px; font-weight: 600; color: #303133; }
.empty-hint { padding: 60px 16px; text-align: center; color: #909399; font-size: 14px; }
</style>
