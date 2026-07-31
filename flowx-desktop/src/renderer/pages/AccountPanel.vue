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
        <el-table-column label="平台" width="110">
          <template #default="{ row }">
            <div style="display: flex; align-items: center; gap: 6px;">
              <img v-if="getPlatformIcon(row.platform)" :src="getPlatformIcon(row.platform)" style="width: 18px; height: 18px; flex-shrink: 0;" />
              <span style="font-size: 13px;">{{ platformName(row.platform) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="账号" min-width="200">
          <template #default="{ row }">
            <div style="display:flex; align-items:center; gap:10px">
              <el-avatar
                :size="40"
                :style="avatarSlotStyle(asAccount(row))"
              >
                <template v-if="avatarSlotRenderImg(asAccount(row))">
                  <img
                    :src="avatarSlotImgSrc(asAccount(row))"
                    :alt="(row.nickname || 'U').slice(0, 1)"
                    referrerpolicy="no-referrer"
                    crossorigin="anonymous"
                    style="width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 50%; background: transparent;"
                    @load="onAvatarSlotImgLoaded(asAccount(row))"
                    @error="onAvatarSlotImgFailed(asAccount(row))"
                  />
                </template>
                <template v-else>
                  {{ (row.nickname || 'U').slice(0, 1) }}
                </template>
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
        <el-table-column label="浏览器环境" min-width="140">
          <template #default="{ row }">
            <el-tag v-if="row.envId" type="success" size="small" effect="plain">
              {{ getEnvName(row.envId) }}
            </el-tag>
            <span v-else style="color:#c0c4cc; font-size:12px">本机直连</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'active'" type="success" size="small">正常</el-tag>
            <el-tag v-else-if="row.status === 'expired'" type="warning" size="small">已过期</el-tag>
            <el-tag v-else type="info" size="small">未激活</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="授权/检测时间" width="170">
          <template #default="{ row }">
            <div style="display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.6;">
              <div>
                <span style="color: #909399;">授权：</span>
                <span style="color: #303133;">{{ fmt(row.authorizedAt) }}</span>
              </div>
              <div>
                <span style="color: #909399;">检测：</span>
                <span v-if="row.lastChecked" style="color: #606266;">{{ fmt(row.lastChecked) }}</span>
                <span v-else style="color: #c0c4cc;">—</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; gap: 6px;">
                <el-button size="small" type="success" style="width: 108px; margin: 0; justify-content: center;" @click="openCreator(asAccount(row))" :loading="openingId === asAccount(row).id">
                  <el-icon><Link /></el-icon>创作中心
                </el-button>
                <el-button size="small" type="primary" style="width: 108px; margin: 0; justify-content: center;" @click="editRemark(asAccount(row))">
                  <el-icon><Setting /></el-icon>编辑
                </el-button>
              </div>
              <div style="display: flex; gap: 6px;">
                <el-button size="small" type="warning" style="width: 108px; margin: 0; justify-content: center;" @click="refreshToken(asAccount(row))" :loading="refreshingId === asAccount(row).id" title="打开平台页面，刷新账号信息/粉丝数/关注数/获赞数">
                  <el-icon><Refresh /></el-icon>刷新
                </el-button>
                <el-button size="small" type="danger" style="width: 108px; margin: 0; justify-content: center;" @click="remove(asAccount(row))">
                  <el-icon><Delete /></el-icon>删除
                </el-button>
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
    <el-dialog v-model="authVisible" title="选择平台授权" width="600px">
      <el-radio-group v-model="authPlatform" class="platform-radio-group">
        <el-row :gutter="12" style="width:100%; margin:0;">
          <el-col :span="12" v-for="p in accountStore.platforms" :key="p.key">
            <el-radio :value="p.key" class="platform-radio">
              <div class="platform-option">
                <div class="platform-icon-wrap">
                  <img v-if="getPlatformIcon(p.key)" :src="getPlatformIcon(p.key)" class="platform-icon" />
                </div>
                <span class="platform-name">{{ p.name }}</span>
                <span class="platform-count">
                  已授权 {{ accountStore.byPlatform(p.key).length }}
                </span>
              </div>
            </el-radio>
          </el-col>
        </el-row>
      </el-radio-group>
      <div style="margin-top: 20px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px;">
        <span style="font-size:13px; font-weight:500; display:block; margin-bottom:8px; color: #606266">绑定浏览器环境（隔离指纹与代理 IP）</span>
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
import iconWechatOfficial from '../assets/wechat_official.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';
import iconX from '../assets/x.svg';

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
  x: iconX,
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

/** 类引号字符黑名单（与平台层 bilibili.ts QUOTE_LIKE_CHARCODES 保持一致，两层逻辑必须同步）。
 *  逐字符 charCode 查表去掉引号族字符（ASCII 反引号 U+0060 只是 28 种之一；之前用 /[`"'\\]/g 只覆盖其中 4 种，所以一直洗不掉）。*/
const QUOTE_LIKE_CHARCODES_FRONTEND = new Set<number>([
  0x0027, 0x0022, 0x0060, 0x00b4, 0x005c, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2039, 0x203a, 0x00ab, 0x00bb, 0x02cb, 0x02ca, 0x0300, 0x0301, 0xff07,
  0xff02, 0xff40, 0x300c, 0x300d, 0x300e, 0x300f, 0x201a, 0x201e, 0x201b, 0x201f,
]);

/** 前端层的 _cleanStr（和平台层同算法，避免两处逻辑漂移） */
function cleanAvatarStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (QUOTE_LIKE_CHARCODES_FRONTEND.has(c)) continue;
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
      out += ' ';
      continue;
    }
    out += s.charAt(i);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** 前端层的头像 URL 提取 + 规范化（与平台层 _normalizeUrl 对齐）：
 *  1. cleanAvatarStr 逐字符去引号
 *  2. 协议相对路径补 https
 *  3. 正则从噪音中提取首个 http(s) URL
 *  4. B 站自有域名 http→https
 *  5. 最后按 RFC3986 合法 URL 字符截一次（去除末尾粘的中文标点/括号等） */
function normalizeAvatarSrc(rawInput: string): string {
  const cleaned = cleanAvatarStr(rawInput);
  if (!cleaned) return '';
  if (cleaned.indexOf('data:') === 0) return cleaned; // dataURI 原样返回（前端的默认图偶尔是 dataURL）
  if (cleaned.indexOf('1x1') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  if (cleaned.indexOf('transparent') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  let url = cleaned;
  if (url.indexOf('//') === 0) url = 'https:' + url;
  if (url.indexOf('http:') !== 0 && url.indexOf('https:') !== 0) {
    const m = url.match(/https?:\/\/[^\s"'`<>【】《》（）()[\]{}，,。;；:：]+/i);
    if (m && m[0]) url = m[0];
  }
  url = cleanAvatarStr(url);
  if (url.indexOf('/') === 0 && url.indexOf('//') !== 0) return '';
  if (url.indexOf('http:') === 0 || url.indexOf('https:') === 0) {
    try {
      const protoEnd = url.indexOf('//');
      if (protoEnd !== -1) {
        const afterProto = url.substring(protoEnd + 2);
        const hostEndIdx = afterProto.search(/[\/?#:]/);
        const host = (hostEndIdx === -1 ? afterProto : afterProto.substring(0, hostEndIdx)).toLowerCase();
        const biliDomains = [
          'hdslb.com',
          'bilibili.com',
          'bilibili.cn',
          'bilibili.co.id',
          'bilibili.tv',
          'biligame.com',
          'bilibiliw.com',
        ];
        const isBili = biliDomains.some((d) => host === d || host.endsWith('.' + d));
        if (isBili && url.indexOf('http:') === 0) {
          url = 'https:' + url.substring(5);
        }
      }
    } catch {
      /* ignore */
    }
    // 最后一道：合法 URL 字符边界截齐
    const m2 = url.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i);
    if (m2 && m2[0]) url = m2[0];
    return url;
  }
  return '';
}

/** 【B 站反引号专项："三重保险"硬清反引号字符（U+0060 半角 / U+FF40 全角）】
 *  之前用逐字符 charCodeAt 查表 + 正则替换两层都没把字符串里的反引号去掉（见你最新 DOM 快照里 <img src="`https://...jpg`"> 两端真的包着反引号）。
 *  现在在最脏的入口 raw 字符串上再加 3 道独立的硬处理：
 *   1) while + indexOf 循环替换 —— 对连续嵌套反引号绝对有效（有些场景字符串被多层反引号包裹，单次 replaceAll 会漏下一层）
 *   2) 两端再分别"如果首字符是反引号就 slice(1)" + "如果尾字符是反引号就 slice(0,-1)" —— 即使正则和查表全漏，末端一定干净
 *   3) 对于 B 站头像路径（包含 "/bfs/face/"），从字符串里抽取最后一次出现的 "/bfs/face/" 到第一次 ".jpg"/".png"/".webp" 之后那一段 —— 即使两端都有噪音字符，路径本体也能被完整截出来
 */
function hardStripBackticks(raw: string, platform?: string): string {
  if (!raw) return '';
  let s = String(raw);
  // ------ 第 1 层：循环替换（U+0060 + U+FF40）------
  while (s.indexOf('`') !== -1) s = s.replace(/`/g, '');
  while (s.indexOf('｀') !== -1) s = s.replace(/｀/g, '');
  // 顺便把所有"看起来像反引号/弯引号"的字符也再剥一次（和平台层的 SET 表对齐，用 replaceAll 双保险）
  s = s.replace(/[\u2018\u2019\u201c\u201d\u2039\u203a\u00ab\u00bb\u02cb\u02ca\u0300\u0301\uff07\uff02\u300c\u300d\u300e\u300f\u201a\u201e\u201b\u201f]/g, '');
  // ------ 第 2 层：两端字符检查，再剥一次（即使前面全漏了也能把首尾各一个反引号吃掉）------
  if (s.length >= 2 && (s.charAt(0) === '`' || s.charAt(0) === '｀')) s = s.substring(1);
  if (s.length >= 2 && (s.charAt(s.length - 1) === '`' || s.charAt(s.length - 1) === '｀')) s = s.substring(0, s.length - 1);
  // ------ 第 3 层（只针对 B 站）：按 "/bfs/face/" 边界抽取真正的路径本体 ------
  if ((platform || '').toLowerCase() === 'bilibili') {
    const idxBfsFace = s.lastIndexOf('/bfs/face/');
    if (idxBfsFace >= 0) {
      // 找图片扩展名的结束位置
      const tail = s.substring(idxBfsFace); // "/bfs/face/abc.jpg@56w_56h_1c.jpg 其它噪音..."
      const extMatch = tail.match(/^(\/bfs\/face\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%@]+?\.(jpg|jpeg|png|webp|gif))([?#].*)?$/i);
      if (extMatch && extMatch[1]) {
        // 最终绝对路径拼接：host 取原字符串里 idxBfsFace 之前的 https?://[host] 部分
        const before = s.substring(0, idxBfsFace);
        const hostMatch = before.match(/https?:\/\/[A-Za-z0-9\-.]+/i);
        const host = hostMatch && hostMatch[0] ? hostMatch[0] : 'https://i0.hdslb.com';
        return host + extMatch[1];
      }
    }
  }
  // 空白再 trim 一次收尾
  return s.trim();
}

// ============================= [头像渲染新链路：我们完全掌控 <img>] =============================
/** 记录每张头像的"加载结果"：true=成功加载图片，false=确认加载失败（显示首字母），undefined=尚未加载完 */
const _avatarSlotResult = new Map<string, boolean>();
/** 同一个账号 ID 只打印一次 slot 链路诊断，避免刷屏 */
const _avatarSlotDiagnosed = new Set<string>();

/** el-avatar 的内联样式：有图片且成功加载 → 背景透明；否则（没图片/加载失败）→ 粉色渐变 + 白字粗体首字母 */
function avatarSlotStyle(acc: AccountInfo) {
  const imgSrc = avatarSlotImgSrc(acc);
  const loaded = _avatarSlotResult.get(acc.id);
  const showImg = !!imgSrc && loaded !== false;
  if (showImg) {
    return { background: 'transparent', color: '#fff', fontWeight: 600 as const };
  }
  return { background: '#ec4899', color: '#fff', fontWeight: 600 as const };
}

/** 默认 slot 里要不要渲染 `<img>` 节点
 *  - 有图片 URL 且没确认过失败 → 渲染 <img>（onerror 后再把它切回 false）
 *  - 没图片 URL 或加载失败过 → 直接显示首字母 */
function avatarSlotRenderImg(acc: AccountInfo): boolean {
  const imgSrc = avatarSlotImgSrc(acc);
  if (!imgSrc) return false;
  const loaded = _avatarSlotResult.get(acc.id);
  return loaded !== false; // 如果之前确认过失败，就不要再渲染 <img> 了，直接显示首字母
}

/** 默认 slot 里 `<img>` 的 src：直接取"反引号三重保险"后的结果 + 再做一次 URL 规范化，
 *  **完全绕开任何"失败过就返回空"的守卫分支**，确保只要原始值里有 URL，就一定会被剥干净。 */
function avatarSlotImgSrc(acc: AccountInfo): string {
  const raw = acc.avatar || '';
  if (!raw) return '';
  // Step 1：hardStripBackticks 先剥反引号（B 站这轮的根因）+ 从 /bfs/face/ 抽取真路径
  const s0 = hardStripBackticks(raw, acc.platform);
  // Step 2：normalizeAvatarSrc 补协议（//xxx → https:）+ 从噪音里提取 URL + B 站域名强制 https
  const s1 = normalizeAvatarSrc(s0);
  // Step 3：如果 s1 还是空（因为 normalizeAvatarSrc 对一些未知协议/相对路径比较严格），
  //         但 s0 已经是合法 http(s) 开头，就直接用 s0（防御"规范化函数把值吃了"）
  let finalSrc = s1;
  if (!finalSrc && /^https?:\/\/[A-Za-z0-9\-.]+/.test(s0)) {
    finalSrc = s0;
  }
  // 同一个账号 ID 只打一次"Slot 链路三步诊断"（不再刷屏，但足够排障）
  const k = `${acc.platform}:${acc.id}:${acc.userId || acc.platformAccountId || 'anon'}`;
  if (!_avatarSlotDiagnosed.has(k)) {
    _avatarSlotDiagnosed.add(k);
    // 额外再打一次 raw 字符串的逐字符 charCode（只打首尾 6 个字符），如果以后还有"看起来像反引号但没命中"的字符，直接从这里看码位
    const headCh: string[] = [];
    const tailCh: string[] = [];
    const nHead = Math.min(6, raw.length);
    const nTail = Math.min(6, raw.length);
    for (let i = 0; i < nHead; i++) headCh.push(`${raw.charAt(i)}:U+${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
    for (let i = Math.max(0, raw.length - nTail); i < raw.length; i++) tailCh.push(`${raw.charAt(i)}:U+${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
    // eslint-disable-next-line no-console
    console.debug(
      `[avatarSlot] ${acc.platform}/${acc.nickname || '?'} (id=${acc.id}) → ` +
        `(1)raw[len=${raw.length}]="${raw.substring(0, 160)}" ` +
        `raw.head=[${headCh.join(' | ')}] raw.tail=[${tailCh.join(' | ')}] ` +
        `(2)strip="${s0.substring(0, 160)}" ` +
        `(3)norm="${s1.substring(0, 160)}" ` +
        `→ finalSrc truthy=!!${!!finalSrc}` +
        (finalSrc ? `, finalSrc="${finalSrc.substring(0, 160)}"` : ''),
    );
  }
  return finalSrc;
}

/** 成功加载 <img> → 记录 true（下次仍然渲染 <img>），首字母 slot 不会被切到 */
function onAvatarSlotImgLoaded(acc: AccountInfo) {
  if (_avatarSlotResult.get(acc.id) === true) return; // 已成功过就别再重复打日志
  _avatarSlotResult.set(acc.id, true);
  // eslint-disable-next-line no-console
  console.info(
    `[avatarSlot] ✅ LOADED: platform=${acc.platform}, id=${acc.id}, nickname=${acc.nickname}, src=${avatarSlotImgSrc(acc).substring(0, 160)}`,
  );
}

/** 加载失败 <img> → 记录 false（下一次渲染 avatarSlotRenderImg 返回 false，直接切到"首字母占位"，不再反复发请求刷屏） */
function onAvatarSlotImgFailed(acc: AccountInfo) {
  if (_avatarSlotResult.get(acc.id) === false) return;
  _avatarSlotResult.set(acc.id, false);
  // eslint-disable-next-line no-console
  console.warn(
    `[avatarSlot] ❌ FAILED: platform=${acc.platform}, id=${acc.id}, nickname=${acc.nickname}。` +
      `请打开 Network 面板，按状态码定位：404→URL不对 / 403→防盗链 Referer 拦截 / blocked→CSP或广告插件 / ERR_CERT→证书问题。` +
      `三步诊断：raw="${(acc.avatar || '').substring(0, 160)}"` +
      ` → strip="${hardStripBackticks(acc.avatar || '', acc.platform).substring(0, 160)}"` +
      ` → norm="${normalizeAvatarSrc(hardStripBackticks(acc.avatar || '', acc.platform)).substring(0, 160)}"`,
  );
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
.panel { background: #fff; border-radius: 12px; padding: 20px; }
.section-title { font-size: 16px; font-weight: 600; color: #303133; }
.empty-hint { padding: 60px 16px; text-align: center; color: #909399; font-size: 14px; }

/* 授权对话框 - 平台选项统一样式 */
.platform-radio-group {
  width: 100%;
  display: block;
}
.platform-radio {
  width: 100%;
  margin-right: 0;
  margin-bottom: 8px;
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
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  border-radius: 4px;
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
  color: #303133;
  font-weight: 500;
  min-width: 72px;
}
.platform-count {
  color: #909399;
  font-size: 12px;
  margin-left: 8px;
}
</style>
