<template>
  <div class="accounts-container">
    <!-- 顶部动作面板 -->
    <div class="panel header-actions-panel">
      <div class="header-flex">
        <div class="title-wrap">
          <div class="title-icon-wrapper">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
          <h2 class="section-title">账号管理</h2>
          <div class="health-badge-wrap" v-if="accountStore.healthCheckConfig && accountStore.healthCheckConfig.enabled">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="health-success-check"><polyline points="20 6 9 17 4 12"/></svg>
            <span>自动检测：每 {{ Math.round(accountStore.healthCheckConfig.intervalMs / 60000) }} 分钟</span>
          </div>
          <div class="health-badge-wrap disabled-badge" v-else>
            <span class="dot-disabled"></span>
            <span>自动检测：已禁用</span>
          </div>
        </div>
        <div class="actions-wrap">
          <el-button type="primary" @click="openAuthDialog" class="action-btn auth-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>授权新账号</span>
          </el-button>
          <el-button @click="openCategoryDialog" class="action-btn plain-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>分类管理</span>
          </el-button>
          <el-button @click="openHealthCheckConfigDialog" class="action-btn plain-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>定时设置</span>
          </el-button>
          <el-button type="success" @click="checkAllHealth" :loading="checkAllLoading" class="action-btn health-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span>批量检测健康</span>
          </el-button>
          <el-button @click="refresh" class="action-btn refresh-round-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          </el-button>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          按分类筛选：
        </span>
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
              <span class="card-more-action">•••</span>
            </div>
          </div>

          <!-- 主体：头像与昵称 -->
          <div class="card-profile">
            <div class="profile-avatar-wrapper">
              <el-avatar
                :size="54"
                :src="row.avatar"
                :style="{ background: row.avatar ? 'transparent' : '#6366f1', color: '#fff', fontWeight: 800, fontSize: '18px' }"
                class="profile-avatar"
              >
                {{ (row.nickname || 'U').slice(0, 1).toUpperCase() }}
              </el-avatar>
            </div>
            <div class="profile-info">
              <div class="profile-name" :title="row.nickname">{{ row.nickname }}</div>
              <div class="profile-id-row" v-if="row.platformAccountId">
                <span>{{ accountStore.platforms.find((x) => x.key === row.platform)?.platformAccountLabel || '号' }}: {{ row.platformAccountId }}</span>
                <span class="copy-id-btn" @click.stop="copyId(row.platformAccountId)" title="复制账号 ID">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </span>
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
          <div class="card-tags-list">
            <div class="tag-row-item">
              <div class="tag-row-left">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tag-row-svg"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                <span>分类</span>
              </div>
              <div class="tag-row-right">
                <div class="tag-pill-wrap" v-if="row.categoryIds && row.categoryIds.length > 0">
                  <span v-for="cid in row.categoryIds" :key="cid" class="category-pill">
                    {{ getCategoryName(cid) }}
                  </span>
                </div>
                <span class="tag-empty-val" v-else>未分类</span>
              </div>
            </div>
            <div class="tag-row-item">
              <div class="tag-row-left">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tag-row-svg"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <span>环境</span>
              </div>
              <div class="tag-row-right">
                <span class="env-pill-val" v-if="row.envId">{{ getEnvName(row.envId) }}</span>
                <span class="tag-empty-val" v-else>本机直连</span>
              </div>
            </div>
          </div>

          <!-- 时间说明 -->
          <div class="card-time-block">
            <div class="time-item-row">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="time-svg color-blue"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span class="time-lbl">授权时间</span>
              <span class="time-val">{{ fmt(row.authorizedAt) }}</span>
            </div>
            <div class="time-item-row" v-if="row.lastChecked">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="time-svg color-green"><polyline points="20 6 9 17 4 12"/></svg>
              <span class="time-lbl">最后检测</span>
              <span class="time-val">{{ fmt(row.lastChecked) }}</span>
            </div>
          </div>

          <!-- 底部操作按钮 -->
          <div class="card-actions-pills">
            <div class="action-pill pill-success" @click="openCreator(asAccount(row))" v-loading="openingId === asAccount(row).id">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              <span>创作中心</span>
            </div>
            <div class="action-pill pill-primary" @click="editRemark(asAccount(row))">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              <span>编辑</span>
            </div>
            <div class="action-pill pill-warning" @click="refreshToken(asAccount(row))" v-loading="refreshingId === asAccount(row).id">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              <span>刷新</span>
            </div>
            <div class="action-pill pill-danger" @click="remove(asAccount(row))">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              <span>删除</span>
            </div>
          </div>
        </div>

        <!-- 3D 纸飞机立方体空态组件（对齐设计图） -->
        <div v-if="filteredAccounts.length === 0 && !accountStore.loading" class="empty-glow-box">
          <div class="empty-3d-scene">
            <div class="empty-box-body">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-airplane-svg"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </div>
            <div class="empty-dust dust-1">✦</div>
            <div class="empty-dust dust-2">✦</div>
          </div>
          <div class="empty-main-hint">更多账号正在路上...</div>
          <div class="empty-sub-hint">点击「授权新账号」开始添加</div>
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

function copyId(id: string) {
  navigator.clipboard.writeText(id);
  ElMessage.success('账号 ID 已复制到剪贴板');
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
  gap: 16px;
  background: transparent;
}

.panel {
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.02);
  box-sizing: border-box;
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
  gap: 10px;
}

.title-icon-wrapper {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6366f1;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

/* 自动检测绿色药丸徽章 */
.health-badge-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 12px;
  background: rgba(16, 185, 129, 0.06);
  border: 1px solid rgba(16, 185, 129, 0.15);
  color: #10b981;
  font-size: 11px;
  font-weight: 700;
  margin-left: 6px;
}

.health-success-check {
  color: #10b981;
}

.disabled-badge {
  background: rgba(0, 0, 0, 0.03);
  border-color: rgba(0, 0, 0, 0.06);
  color: #64748b;
}

.dot-disabled {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #94a3b8;
  display: inline-block;
}

.actions-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 按钮统一精细样式 */
.actions-wrap :deep(.el-button) {
  border-radius: 20px !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  padding: 8px 16px !important;
  height: auto !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* 授权新账号紫蓝渐变 */
.actions-wrap .auth-btn {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
  border: none !important;
  color: #ffffff !important;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.2) !important;
}

.actions-wrap .auth-btn:hover {
  transform: translateY(-1.5px);
  box-shadow: 0 6px 20px rgba(99, 102, 241, 0.35) !important;
}

/* 白底配置按钮 */
.actions-wrap .plain-btn {
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  background: #ffffff !important;
  color: #475569 !important;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.01) !important;
}

.actions-wrap .plain-btn:hover {
  border-color: rgba(99, 102, 241, 0.2) !important;
  background: rgba(99, 102, 241, 0.03) !important;
  color: #6366f1 !important;
}

/* 批量健康检测绿色 */
.actions-wrap .health-btn {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%) !important;
  border: none !important;
  color: #ffffff !important;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.2) !important;
}

.actions-wrap .health-btn:hover {
  transform: translateY(-1.5px);
  box-shadow: 0 6px 20px rgba(16, 185, 129, 0.35) !important;
}

/* 纯圆形刷新按钮 */
.refresh-round-btn {
  width: 32px !important;
  height: 32px !important;
  border-radius: 50% !important;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: #ffffff !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  color: #475569 !important;
}

.refresh-round-btn:hover {
  color: #6366f1 !important;
  border-color: rgba(99, 102, 241, 0.2) !important;
}

/* ======== 分类筛选 ======== */
.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
}

.filter-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  flex-shrink: 0;
}

.filter-select {
  width: 140px !important;
}

.filter-row :deep(.el-select__wrapper) {
  border-radius: 20px !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04) inset !important;
  background: #ffffff !important;
  padding: 4px 12px !important;
  height: 28px !important;
  line-height: 28px !important;
  width: 100% !important;
}

.filter-row :deep(.el-select__wrapper.is-focus),
.filter-row :deep(.el-select__wrapper:hover) {
  box-shadow: 0 0 0 1px #6366f1 inset, 0 0 0 4px rgba(99, 102, 241, 0.12) !important;
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

/* ======== 账号网格流与卡片美化 ======== */
.account-grid-flow {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 20px;
  margin-top: 16px;
}

.flow-account-card {
  background: #ffffff;
  border-top: 1.5px solid rgba(99, 102, 241, 0.2);
  border-left: none;
  border-right: none;
  border-bottom: none;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px -5px rgba(99, 102, 241, 0.04), 0 2px 10px -3px rgba(0, 0, 0, 0.02);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
}

.flow-account-card:hover {
  transform: translateY(-4px);
  border-top-color: rgba(99, 102, 241, 0.58);
  box-shadow: 0 16px 36px -4px rgba(99, 102, 241, 0.14), 0 4px 16px -2px rgba(99, 102, 241, 0.04);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
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
  width: 12px;
  height: 12px;
  object-fit: contain;
}

.badge-xiaohongshu { background: rgba(255, 77, 79, 0.08); color: #ff4d4f; }
.badge-douyin { background: rgba(6, 182, 212, 0.08); color: #06b6d4; }
.badge-kuaishou { background: rgba(249, 115, 22, 0.08); color: #f97316; }
.badge-wechat_channels { background: rgba(16, 185, 129, 0.08); color: #10b981; }
.badge-zhihu { background: rgba(0, 102, 255, 0.08); color: #0066ff; }
.badge-toutiao { background: rgba(240, 65, 52, 0.08); color: #f04134; }

/* 健康状态 */
.status-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}

.dot-active {
  background-color: #10b981;
  box-shadow: 0 0 6px #10b981;
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
  font-weight: 700;
  color: #64748b;
  margin-right: 4px;
}

.card-more-action {
  font-size: 10px;
  color: #cbd5e1;
  cursor: pointer;
  letter-spacing: -0.5px;
  transition: color 0.2s ease;
}

.card-more-action:hover {
  color: #64748b;
}

/* 个人信息 */
.card-profile {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 20px;
}

.profile-avatar-wrapper {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}

.profile-avatar-wrapper::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, transparent 70%);
  z-index: 0;
  pointer-events: none;
}

.profile-avatar {
  position: relative;
  z-index: 1;
  border: 2px solid #ffffff;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.12);
}

.profile-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.profile-name {
  font-size: 17px;
  font-weight: 800;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-id-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
}

.copy-id-btn {
  cursor: pointer;
  color: #94a3b8;
  display: inline-flex;
  align-items: center;
  transition: color 0.2s ease;
}

.copy-id-btn:hover {
  color: #6366f1;
}

/* 数据展示三栏 */
.card-stats {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(99, 102, 241, 0.015);
  border: 1px solid rgba(99, 102, 241, 0.04);
  border-radius: 12px;
  padding: 12px 18px;
  margin-bottom: 20px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}

.stat-num {
  font-size: 17px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1.1;
}

.stat-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  margin-top: 3px;
}

.stat-divider {
  width: 1px;
  height: 20px;
  background-color: rgba(99, 102, 241, 0.08);
}

/* 标签行区 */
.card-tags-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.tag-row-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.tag-row-left {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #94a3b8;
  font-weight: 700;
}

.tag-row-svg {
  color: #94a3b8;
}

.tag-row-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tag-pill-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.category-pill {
  background: rgba(99, 102, 241, 0.06);
  color: #6366f1;
  border: 1px solid rgba(99, 102, 241, 0.12);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 10px;
}

.env-pill-val {
  color: #10b981;
  font-weight: 700;
}

.tag-empty-val {
  color: #cbd5e1;
  font-weight: 500;
}

/* 向右小箭头 */
.tag-row-arrow {
  width: 4px;
  height: 4px;
  border-top: 1.5px solid #cbd5e1;
  border-right: 1.5px solid #cbd5e1;
  transform: rotate(45deg);
  margin-left: 2px;
}

/* 时间说明区 */
.card-time-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 20px;
}

.time-item-row {
  display: flex;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
}

.time-svg {
  margin-right: 6px;
}

.time-svg.color-blue { color: #6366f1; }
.time-svg.color-green { color: #10b981; }

.time-lbl {
  font-weight: 600;
  color: #94a3b8;
  min-width: 60px;
}

.time-val {
  margin-left: auto;
  font-family: monospace;
  color: #64748b;
}

/* 底部操作按钮平铺胶囊 */
.card-actions-pills {
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

.pill-success {
  background: transparent;
  color: #10b981;
  border-color: transparent;
}
.pill-success:hover {
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
  border-color: rgba(16, 185, 129, 0.12);
}

.pill-primary {
  background: transparent;
  color: #6366f1;
  border-color: transparent;
}
.pill-primary:hover {
  background: rgba(99, 102, 241, 0.08);
  color: #4f46e5;
  border-color: rgba(99, 102, 241, 0.12);
}

.pill-warning {
  background: transparent;
  color: #f97316;
  border-color: transparent;
}
.pill-warning:hover {
  background: rgba(249, 115, 22, 0.08);
  color: #ea580c;
  border-color: rgba(249, 115, 22, 0.12);
}

.pill-danger {
  background: transparent;
  color: #ef4444;
  border-color: transparent;
}
.pill-danger:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.12);
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

/* ======== 3D 纸飞机立方体空态组件（对齐设计图） ======== */
.empty-glow-box {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  box-sizing: border-box;
}

.empty-3d-scene {
  position: relative;
  width: 120px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
}

.empty-box-body {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(56, 189, 248, 0.03) 100%);
  border: 1px solid rgba(99, 102, 241, 0.12);
  box-shadow: inset 0 2px 6px rgba(255, 255, 255, 0.6), 0 10px 24px -4px rgba(99, 102, 241, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  animation: floatScene 4s ease-in-out infinite;
}

.empty-airplane-svg {
  color: #6366f1;
  filter: drop-shadow(0 4px 8px rgba(99, 102, 241, 0.2));
  transform: rotate(-15deg);
}

.empty-dust {
  position: absolute;
  font-size: 12px;
  color: #6366f1;
  opacity: 0.6;
}

.dust-1 {
  top: 10px;
  left: 15px;
  animation: particleFloat 3s ease-in-out infinite alternate;
}

.dust-2 {
  bottom: 15px;
  right: 15px;
  animation: particleFloat 3.5s ease-in-out infinite alternate-reverse;
}

@keyframes floatScene {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

@keyframes particleFloat {
  0% { transform: translate(0, 0) scale(0.8); opacity: 0.3; }
  100% { transform: translate(4px, -4px) scale(1.2); opacity: 0.8; }
}

.empty-main-hint {
  font-size: 15px;
  font-weight: 700;
  color: #1e293b;
  margin-bottom: 6px;
}

.empty-sub-hint {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 500;
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
