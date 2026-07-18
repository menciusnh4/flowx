<template>
  <div class="acct">
    <!-- 概览指标 -->
    <section class="overview">
      <div class="ov-card" v-for="m in overview" :key="m.label">
        <div class="ov-ic" :style="{ background: m.tint }">{{ m.icon }}</div>
        <div class="ov-meta">
          <div class="ov-value">{{ m.value }}</div>
          <div class="ov-label">{{ m.label }}</div>
        </div>
      </div>
    </section>

    <!-- 工具条：分类筛选 + 搜索 + 操作 -->
    <section class="toolbar panel">
      <div class="tb-left">
        <div class="pills">
          <button class="pill" :class="{ active: filterCategoryId === '' }" @click="setCat('')">全部分类</button>
          <button class="pill" :class="{ active: filterCategoryId === 'unclassified' }" @click="setCat('unclassified')">未分类</button>
          <button
            class="pill"
            v-for="c in accountStore.categories"
            :key="c.id"
            :class="{ active: filterCategoryId === c.id }"
            @click="setCat(c.id)"
          >{{ c.name }}</button>
        </div>
        <el-input
          v-model="searchText"
          class="tb-search"
          placeholder="搜索昵称 / 账号 / 平台"
          clearable
          :prefix-icon="Search"
        />
        <el-tag
          v-if="accountStore.healthCheckConfig"
          size="small"
          :type="accountStore.healthCheckConfig.enabled ? 'success' : 'info'"
          effect="plain"
          class="hc-tag"
        >
          {{ accountStore.healthCheckConfig.enabled ? `定时检测 ${Math.round(accountStore.healthCheckConfig.intervalMs / 60000)} 分钟` : '定时检测已关闭' }}
        </el-tag>
      </div>

      <div class="tb-right">
        <el-button type="primary" @click="openAuthDialog">
          <el-icon><Plus /></el-icon>&nbsp; 授权新账号
        </el-button>
        <el-button @click="openCategoryDialog">
          <el-icon><Folder /></el-icon>&nbsp; 分类管理
        </el-button>
        <el-button @click="openHealthCheckConfigDialog">
          <el-icon><Setting /></el-icon>&nbsp; 检测设置
        </el-button>
        <el-button type="success" @click="checkAllHealth" :loading="checkAllLoading">
          <el-icon><Monitor /></el-icon>&nbsp; 批量检测
        </el-button>
        <el-button @click="refresh">
          <el-icon><Refresh /></el-icon>&nbsp; 刷新
        </el-button>
        <span class="tb-sep" aria-hidden="true"></span>
        <div class="view-toggle" role="group" aria-label="展示方式">
          <button type="button" class="vt-btn" :class="{ active: viewMode === 'grid' }" @click="setView('grid')" title="平铺视图">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
            <span>平铺</span>
          </button>
          <button type="button" class="vt-btn" :class="{ active: viewMode === 'list' }" @click="setView('list')" title="列表视图">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.5" y2="6"/><line x1="3.5" y1="12" x2="3.5" y2="12"/><line x1="3.5" y1="18" x2="3.5" y2="18"/></svg>
            <span>列表</span>
          </button>
        </div>
      </div>
    </section>

    <!-- 账号展示：平铺 / 列表 可切换 -->
    <section class="acct-body" v-loading="accountStore.loading">
      <!-- 平铺（卡片网格） -->
      <div class="grid" v-if="viewMode === 'grid'">
        <article class="acct-card" v-for="a in filteredAccounts" :key="a.id">
          <header class="ac-top">
            <div class="ac-plat" :style="platChipStyle(a.platform)">
              <img v-if="getPlatformIcon(a.platform)" :src="getPlatformIcon(a.platform)" class="ac-plat-ic" />
              <span>{{ platformName(a.platform) }}</span>
            </div>
            <el-tag :type="statusType(a.status)" size="small" effect="light">{{ statusText(a.status) }}</el-tag>
          </header>

          <div class="ac-body">
            <el-avatar :size="48" :src="a.avatar" :style="avatarStyle(a)">{{ (a.nickname || 'U').slice(0, 1) }}</el-avatar>
            <div class="ac-id">
              <div class="ac-name" :title="a.nickname">{{ a.nickname }}</div>
              <div class="ac-sub" v-if="a.platformAccountId">
                {{ platformAccountLabel(a.platform) }}：{{ a.platformAccountId }}
              </div>
              <div class="ac-sub" v-else-if="a.userId">
                ID: {{ a.userId.slice(0, 16) }}{{ a.userId.length > 16 ? '…' : '' }}
              </div>
            </div>
          </div>

          <div class="ac-stats">
            <div class="ac-stat"><b>{{ formatCount(a.fansCount) }}</b><span>粉丝</span></div>
            <div class="ac-stat"><b>{{ formatCount(a.followCount) }}</b><span>关注</span></div>
            <div class="ac-stat"><b>{{ formatCount(a.likeCount) }}</b><span>获赞</span></div>
          </div>

          <div class="ac-meta">
            <div class="ac-cats">
              <el-tag v-for="cid in (a.categoryIds || [])" :key="cid" size="small" type="info" effect="plain">{{ getCategoryName(cid) }}</el-tag>
              <span v-if="!a.categoryIds || a.categoryIds.length === 0" class="ac-uncat">未分类</span>
            </div>
            <div class="ac-env">
              <span v-if="a.envId" class="ac-env-on">🔒 {{ getEnvName(a.envId) }}</span>
              <span v-else class="ac-env-off">本机直连</span>
            </div>
          </div>

          <div class="ac-time">
            <span>授权 {{ fmt(a.authorizedAt) }}</span>
            <span v-if="a.lastChecked">· 检测 {{ fmt(a.lastChecked) }}</span>
          </div>

          <footer class="ac-actions">
            <el-button size="small" type="success" @click="openCreator(a)" :loading="openingId === a.id">
              <el-icon><Link /></el-icon> 创作中心
            </el-button>
            <el-button size="small" type="primary" @click="editRemark(a)">
              <el-icon><Setting /></el-icon> 编辑
            </el-button>
            <el-button size="small" type="warning" @click="refreshToken(a)" :loading="refreshingId === a.id">
              <el-icon><Refresh /></el-icon> 刷新
            </el-button>
            <el-button size="small" type="danger" @click="remove(a)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </footer>
        </article>
      </div>

      <!-- 列表（紧凑行） -->
      <div class="acct-list" v-else>
        <header class="list-head">
          <div class="lr-plat">平台 / 状态</div>
          <div class="lr-id">账号</div>
          <div class="lr-stats"><span>粉丝</span><span>关注</span><span>获赞</span></div>
          <div class="lr-meta">分类 / 环境</div>
          <div class="lr-time">授权 / 检测</div>
          <div class="lr-actions">操作</div>
        </header>

        <article class="list-row" v-for="a in filteredAccounts" :key="a.id">
          <div class="lr-plat">
            <span class="ac-plat" :style="platChipStyle(a.platform)">
              <img v-if="getPlatformIcon(a.platform)" :src="getPlatformIcon(a.platform)" class="ac-plat-ic" />
              {{ platformName(a.platform) }}
            </span>
            <el-tag :type="statusType(a.status)" size="small" effect="light">{{ statusText(a.status) }}</el-tag>
          </div>

          <div class="lr-id">
            <el-avatar :size="38" :src="a.avatar" :style="avatarStyle(a)">{{ (a.nickname || 'U').slice(0, 1) }}</el-avatar>
            <div class="lr-idtext">
              <div class="ac-name" :title="a.nickname">{{ a.nickname }}</div>
              <div class="ac-sub" v-if="a.platformAccountId">{{ platformAccountLabel(a.platform) }}：{{ a.platformAccountId }}</div>
              <div class="ac-sub" v-else-if="a.userId">ID: {{ a.userId.slice(0, 16) }}{{ a.userId.length > 16 ? '…' : '' }}</div>
            </div>
          </div>

          <div class="lr-stats">
            <span><b>{{ formatCount(a.fansCount) }}</b> 粉丝</span>
            <span><b>{{ formatCount(a.followCount) }}</b> 关注</span>
            <span><b>{{ formatCount(a.likeCount) }}</b> 获赞</span>
          </div>

          <div class="lr-meta">
            <div class="ac-cats">
              <el-tag v-for="cid in (a.categoryIds || [])" :key="cid" size="small" type="info" effect="plain">{{ getCategoryName(cid) }}</el-tag>
              <span v-if="!a.categoryIds || a.categoryIds.length === 0" class="ac-uncat">未分类</span>
            </div>
            <div class="ac-env">
              <span v-if="a.envId" class="ac-env-on">🔒 {{ getEnvName(a.envId) }}</span>
              <span v-else class="ac-env-off">本机直连</span>
            </div>
          </div>

          <div class="lr-time">
            <span>授权 {{ fmt(a.authorizedAt) }}</span>
            <span v-if="a.lastChecked">· 检测 {{ fmt(a.lastChecked) }}</span>
          </div>

          <div class="lr-actions">
            <el-button size="small" type="success" @click="openCreator(a)" :loading="openingId === a.id" title="创作中心">
              <el-icon><Link /></el-icon>
            </el-button>
            <el-button size="small" type="primary" @click="editRemark(a)" title="编辑">
              <el-icon><Setting /></el-icon>
            </el-button>
            <el-button size="small" type="warning" @click="refreshToken(a)" :loading="refreshingId === a.id" title="刷新">
              <el-icon><Refresh /></el-icon>
            </el-button>
            <el-button size="small" type="danger" @click="remove(a)" title="删除">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </article>
      </div>

      <div v-if="filteredAccounts.length === 0 && !accountStore.loading" class="empty-hint">
        {{ filterCategoryId || searchText ? '没有匹配的账号。' : '还没有账号，点击右上角"授权新账号"开始。' }}
        <div v-if="!filterCategoryId && !searchText" style="font-size:12px; color:var(--muted); margin-top:6px">
          授权会弹出平台登录窗口，扫码完成后点击右上角红色"✅ 登录完成，保存账号"按钮，或直接关闭窗口即可。
        </div>
      </div>
    </section>

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
          <span style="font-size:12px; color:var(--muted); margin-left:110px; display:block; margin-top:-10px">应用启动后多少分钟开始第一次检测（默认为 5 分钟）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="healthCheckDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveHealthCheckConfig" :loading="savingConfig">保存</el-button>
      </template>
    </el-dialog>

    <!-- 选择平台授权对话框 -->
    <el-dialog v-model="authVisible" title="选择平台授权" width="460px">
      <el-radio-group v-model="authPlatform" class="platform-radio-group">
        <el-space direction="vertical" style="width:100%">
          <el-radio v-for="p in accountStore.platforms" :key="p.key" :value="p.key" class="platform-radio">
            <div class="platform-option">
              <div class="platform-icon-wrap">
                <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-icon" />
              </div>
              <span class="platform-name">{{ p.name }}</span>
              <span class="platform-count">
                已授权 {{ accountStore.byPlatform(p.key).length }} 个账号
              </span>
            </div>
          </el-radio>
        </el-space>
      </el-radio-group>
      <div style="margin-top: 20px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px;">
        <span style="font-size:13px; font-weight:500; display:block; margin-bottom:8px; color: var(--slate)">绑定浏览器环境（隔离指纹与代理 IP）</span>
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
import { Plus, Refresh, Link, Monitor, Setting, Folder, Delete, Search } from '@element-plus/icons-vue';
import { useAccountStore } from '../stores/account';
import { useEnvStore } from '../stores/env';
import { useWorkspaceStore } from '../stores/workspace';
import { electronApi } from '../utils/electron';
import type { AccountInfo, AccountCategory } from '../../types';

// 平台图标（SVG/PNG，通过 Vite import 引入）
import iconXiaohongshu from '../assets/xiaohongshu.svg';
import iconDouyin from '../assets/douyin.svg';
import iconKuaishou from '../assets/kuaishou.svg';
import iconBilibili from '../assets/bilibili.svg';
import iconWechatChannels from '../assets/wechat_channels.svg';
import iconWechatOfficial from '../assets/wechat_official.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';

const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu: iconXiaohongshu,
  douyin: iconDouyin,
  kuaishou: iconKuaishou,
  bilibili: iconBilibili,
  wechat_channels: iconWechatChannels,
  wechat_official: iconWechatOfficial,
  weibo: iconWeibo,
  zhihu: iconZhihu,
  toutiao: iconToutiao,
};

/** 获取平台图标 URL，找不到则返回空字符串 */
function getPlatformIcon(p: string): string {
  return PLATFORM_ICONS[p] || '';
}

/** 平台品牌色（用于卡片内的平台标签着色） */
const PLATFORM_COLORS: Record<string, string> = {
  xiaohongshu: '#ff2442',
  douyin: '#fe2c55',
  kuaishou: '#ff4906',
  bilibili: '#00a1d6',
  wechat_channels: '#07c160',
  weibo: '#e6162d',
  zhihu: '#0084ff',
  toutiao: '#f04142',
};
function platColor(p: string): string {
  return PLATFORM_COLORS[p] || '#6366f1';
}
/** 平台标签的浅色背景 + 品牌字色（hex + alpha 后缀实现柔光） */
function platChipStyle(p: string): Record<string, string> {
  const c = platColor(p);
  return { background: c + '14', color: c, borderColor: c + '33' };
}

const accountStore = useAccountStore();
const envStore = useEnvStore();
const workspaceStore = useWorkspaceStore();

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
const searchText = ref<string>('');
const categoryDialogVisible = ref(false);
const newCategoryName = ref('');
const creatingCategory = ref(false);
const editingCategoryId = ref('');
const editingCategoryName = ref('');

// 概览指标（summary 同时驱动页面级状态条）
const summary = computed(() => {
  const total = accountStore.accounts.length;
  const active = accountStore.activeAccounts.length;
  const expired = accountStore.accounts.filter((a) => a.status === 'expired').length;
  const platforms = new Set(accountStore.accounts.map((a) => a.platform)).size;
  return { total, active, expired, platforms };
});
const overview = computed(() => [
  { icon: '👥', label: '账号总数', value: summary.value.total, tint: 'rgba(99,102,241,.12)' },
  { icon: '✅', label: '活跃可用', value: summary.value.active, tint: 'rgba(16,185,129,.12)' },
  { icon: '⚠️', label: '已过期', value: summary.value.expired, tint: 'rgba(244,63,94,.12)' },
  { icon: '🌐', label: '覆盖平台', value: summary.value.platforms, tint: 'rgba(56,189,248,.14)' },
]);

// 展示方式：平铺(grid) / 列表(list)，持久化到 localStorage
const VIEW_STORAGE_KEY = 'flowx-acct-viewmode';
function loadViewMode(): 'grid' | 'list' {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
const viewMode = ref<'grid' | 'list'>(loadViewMode());
function setView(m: 'grid' | 'list') {
  viewMode.value = m;
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, m);
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}

/** 头像兜底样式：无图时用品牌色填充并显示首字母 */
function avatarStyle(a: AccountInfo): Record<string, string> {
  return {
    background: a.avatar ? 'transparent' : 'var(--brand-indigo)',
    color: '#fff',
    fontWeight: '600',
    flexShrink: '0',
  };
}

// 根据分类 + 搜索过滤账号
const filteredAccounts = computed(() => {
  let list = accountStore.accounts;
  if (filterCategoryId.value) {
    if (filterCategoryId.value === 'unclassified') {
      list = list.filter((a) => !a.categoryIds || a.categoryIds.length === 0);
    } else {
      list = list.filter((a) => a.categoryIds && a.categoryIds.includes(filterCategoryId.value));
    }
  }
  const q = searchText.value.trim().toLowerCase();
  if (q) {
    list = list.filter((a) =>
      (a.nickname || '').toLowerCase().includes(q) ||
      (a.platformAccountId || '').toLowerCase().includes(q) ||
      (a.userId || '').toLowerCase().includes(q) ||
      platformName(a.platform).toLowerCase().includes(q),
    );
  }
  return list;
});

function setCat(id: string) {
  filterCategoryId.value = id;
}

// 获取分类名称辅助函数
function getCategoryName(id: string) {
  return accountStore.categories.find((c) => c.id === id)?.name || '未知分类';
}

function statusType(s: AccountInfo['status']): 'success' | 'warning' | 'info' {
  return s === 'active' ? 'success' : s === 'expired' ? 'warning' : 'info';
}
function statusText(s: AccountInfo['status']): string {
  return s === 'active' ? '正常' : s === 'expired' ? '已过期' : '未激活';
}
function platformAccountLabel(p: string): string {
  return accountStore.platforms.find((x) => x.key === p)?.platformAccountLabel || '账号';
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

// 用已保存的登录态打开平台创作中心（M3：内嵌主窗口，替代弹窗）
async function openCreator(row: AccountInfo) {
  openingId.value = row.id;
  try {
    // 1) 在全局任务选项卡内打开/激活该账号的创作中心 tab（渲染端）
    workspaceStore.openAccountTab(row.id, {
      title: row.nickname,
      icon: PLATFORM_EMOJI[row.platform] || '📕',
      envBadge: row.envId ? '🔒' : undefined,
    });
    // 2) 通知主进程预创建/复用内嵌隔离视图
    const r = await electronApi.openAccountTab(row.id);
    if (!r.ok) {
      ElMessage.error(`打开失败: ${r.error || '未知错误'}`);
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    openingId.value = '';
  }
}

/** 平台 → tab 图标 emoji（与信息条/任务条视觉一致） */
const PLATFORM_EMOJI: Record<string, string> = {
  xiaohongshu: '📕',
  douyin: '🎵',
  kuaishou: '⚡',
  bilibili: '📺',
  wechat_channels: '🎬',
  wechat_official: '💬',
  weibo: '🔶',
  zhihu: '💡',
  toutiao: '📰',
};

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
.acct {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 概览指标 */
.overview {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}
.ov-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-xs);
  transition: box-shadow var(--t), transform var(--t) var(--ease);
}
.ov-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.ov-ic {
  width: 44px;
  height: 44px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  flex-shrink: 0;
}
.ov-value {
  font-family: var(--font-display);
  font-size: 25px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--ink);
}
.ov-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

/* 工具条 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px;
}
.tb-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.tb-right {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pill {
  height: 34px;
  padding: 0 15px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--slate);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  font-family: inherit;
  white-space: nowrap;
}
.pill:hover {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
  background: var(--brand-grad-soft);
}
.pill.active {
  background: var(--brand-grad);
  border-color: transparent;
  color: #fff;
  box-shadow: var(--shadow-sm);
}
.tb-search {
  width: 230px;
  max-width: 40vw;
}
.tb-search :deep(.el-input__wrapper) {
  border-radius: var(--r-pill);
  background: var(--surface-2);
  box-shadow: 0 0 0 1px var(--line) inset;
}
.tb-search :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--brand-indigo) inset;
}
.hc-tag {
  font-weight: 600;
}

/* 工具条右侧：操作按钮与展示方式切换之间的分隔竖线 */
.tb-sep {
  width: 1px;
  align-self: stretch;
  margin: 4px 2px;
  background: var(--line-strong);
}

/* 展示方式切换（平铺 / 列表） */
.view-toggle {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-pill);
  background: var(--surface);
  padding: 4px;
  gap: 2px;
  flex-shrink: 0;
}
.vt-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: calc(var(--r-pill) - 4px);
  background: transparent;
  color: var(--slate);
  font-size: 13px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  white-space: nowrap;
}
.vt-btn:hover {
  color: var(--brand-indigo);
}
.vt-btn.active {
  background: var(--brand-grad);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

/* 顶部 5 个操作按钮 → 原型 .btn 风格 */
.tb-right :deep(.el-button) {
  margin: 0;
  height: 38px;
  padding: 0 15px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--slate);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  transition: all var(--t-fast) var(--ease);
}
.tb-right :deep(.el-button:hover) {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
  background: var(--brand-grad-soft);
}
.tb-right :deep(.el-button--primary) {
  background: var(--brand-grad);
  border-color: transparent;
  color: #fff;
  box-shadow: var(--shadow-sm);
}
.tb-right :deep(.el-button--primary:hover) {
  filter: brightness(1.05);
  color: #fff;
}
.tb-right :deep(.el-button--success) {
  border-color: rgba(16, 185, 129, 0.4);
  color: var(--success);
  background: var(--surface);
}
.tb-right :deep(.el-button--success:hover) {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}

/* 账号卡片网格 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  min-height: 120px;
}
.acct-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-xs);
  transition: box-shadow var(--t), transform var(--t) var(--ease), border-color var(--t);
}
.acct-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-3px);
  border-color: var(--line-strong);
}
.ac-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ac-plat {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 11px;
  border-radius: var(--r-pill);
  border: 1px solid transparent;
  font-size: 12.5px;
  font-weight: 700;
}
.ac-plat-ic {
  width: 16px;
  height: 16px;
  object-fit: contain;
}
.ac-body {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ac-id {
  min-width: 0;
}
.ac-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ac-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ac-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.ac-stat {
  text-align: center;
}
.ac-stat b {
  display: block;
  font-family: var(--font-display);
  font-size: 17px;
  color: var(--ink);
  line-height: 1.2;
}
.ac-stat span {
  font-size: 11.5px;
  color: var(--muted);
}
.ac-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ac-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-height: 22px;
}
.ac-uncat {
  font-size: 12px;
  color: var(--faint);
}
.ac-env {
  font-size: 12px;
}
.ac-env-on {
  color: var(--slate);
  font-weight: 600;
}
.ac-env-off {
  color: var(--faint);
}
.ac-time {
  font-size: 11.5px;
  color: var(--muted);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ac-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-top: 2px;
}
/* 卡片内 4 操作 → 原型 .act 风格 */
.ac-actions :deep(.el-button) {
  margin: 0;
  justify-content: center;
  font-weight: 600;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--slate);
  font-size: 12.5px;
  font-family: inherit;
  transition: all var(--t-fast) var(--ease);
}
.ac-actions :deep(.el-button:hover) {
  background: var(--surface-2);
}
.ac-actions :deep(.el-button--success) {
  color: var(--success);
  border-color: rgba(16, 185, 129, 0.35);
  background: var(--surface);
}
.ac-actions :deep(.el-button--success:hover) {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}
.ac-actions :deep(.el-button--primary) {
  color: var(--brand-indigo);
  border-color: rgba(99, 102, 241, 0.35);
  background: var(--surface);
}
.ac-actions :deep(.el-button--primary:hover) {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}
.ac-actions :deep(.el-button--warning) {
  color: var(--warning);
  border-color: rgba(245, 158, 11, 0.35);
  background: var(--surface);
}
.ac-actions :deep(.el-button--warning:hover) {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning);
}
.ac-actions :deep(.el-button--danger) {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.35);
  background: var(--surface);
}
.ac-actions :deep(.el-button--danger:hover) {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

/* 列表视图 */
.acct-body {
  min-height: 120px;
}
/* 列表视图：统一网格表格，表头与行严格对齐 */
.acct-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface);
}
.list-head,
.list-row {
  display: grid;
  grid-template-columns:
    160px
    minmax(190px, 1.7fr)
    minmax(220px, 1.9fr)
    minmax(150px, 1.3fr)
    minmax(150px, 1.2fr)
    140px;
  align-items: center;
  column-gap: 18px;
  padding: 13px 20px;
}
.list-head {
  background: var(--brand-grad-soft);
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
  font-weight: 800;
  color: var(--brand-indigo);
  letter-spacing: 0.04em;
}
.list-row {
  border-bottom: 1px solid var(--line);
  transition: background var(--t);
}
.list-row:last-child {
  border-bottom: none;
}
.list-row:hover {
  background: var(--surface-2);
}
.list-head .lr-id {
  padding-left: 48px;
}
.list-head .lr-stats,
.list-head .lr-time,
.list-head .lr-meta {
  color: var(--brand-indigo);
}
.list-head .lr-stats span {
  font-size: 11.5px;
  font-weight: 800;
}
.list-head .lr-actions,
.list-row .lr-actions {
  justify-self: end;
}
.lr-plat {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.lr-id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.lr-idtext {
  min-width: 0;
}
.lr-stats {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  font-size: 12.5px;
  color: var(--muted);
}
.lr-stats b {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--ink);
  margin-right: 3px;
}
.lr-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  min-width: 130px;
}
.lr-time {
  font-size: 11.5px;
  color: var(--muted);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.lr-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
/* 列表行 4 个图标按钮 → 原型 .icon-btn 风格 */
.lr-actions :deep(.el-button) {
  margin: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--slate);
  font-family: inherit;
  transition: all var(--t-fast) var(--ease);
}
.lr-actions :deep(.el-button:hover) {
  background: var(--surface-2);
}
.lr-actions :deep(.el-button--success) {
  color: var(--success);
  border-color: rgba(16, 185, 129, 0.35);
  background: var(--surface);
}
.lr-actions :deep(.el-button--success:hover) {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}
.lr-actions :deep(.el-button--primary) {
  color: var(--brand-indigo);
  border-color: rgba(99, 102, 241, 0.35);
  background: var(--surface);
}
.lr-actions :deep(.el-button--primary:hover) {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}
.lr-actions :deep(.el-button--warning) {
  color: var(--warning);
  border-color: rgba(245, 158, 11, 0.35);
  background: var(--surface);
}
.lr-actions :deep(.el-button--warning:hover) {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning);
}
.lr-actions :deep(.el-button--danger) {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.35);
  background: var(--surface);
}
.lr-actions :deep(.el-button--danger:hover) {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

/* 列表响应式：窄屏隐藏表头、行退化为卡片堆叠 */
@media (max-width: 880px) {
  .list-head {
    display: none;
  }
  .list-row {
    grid-template-columns: 1fr;
    row-gap: 10px;
    padding: 14px 16px;
  }
  .list-row .lr-id {
    padding-left: 0;
  }
  .list-row .lr-actions {
    justify-self: start;
  }
}

.empty-hint {
  color: var(--muted);
  text-align: center;
  padding: 60px 16px;
  font-size: 14px;
}

/* 授权对话框 - 平台选项统一样式 */
.platform-radio-group {
  width: 100%;
}
.platform-radio {
  width: 100%;
  margin-right: 0;
  height: auto;
  padding: 6px 0;
}
.platform-radio :deep(.el-radio__label) {
  padding-left: 8px;
  width: calc(100% - 20px);
}
.platform-option {
  display: flex;
  align-items: center;
  height: 32px;
}
.platform-icon-wrap {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  border-radius: 6px;
  overflow: hidden;
  margin-right: 10px;
}
.platform-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: left center;
  display: block;
}
.platform-name {
  font-size: 14px;
  color: var(--ink);
  font-weight: 600;
  min-width: 72px;
}
.platform-count {
  color: var(--muted);
  font-size: 12px;
  margin-left: 8px;
}

@media (max-width: 1100px) {
  .overview {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .overview {
    grid-template-columns: repeat(2, 1fr);
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
