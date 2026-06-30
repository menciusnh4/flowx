<script setup lang="ts">
import { ref, computed, onMounted, reactive, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { usePublishStore } from '../stores/publish'
import { useAccountStore } from '../stores/account'
import { electronApi } from '../utils/electron'
import type { PublishRequest, PlatformType } from '../../types'

const accountStore = useAccountStore()
const publishStore = usePublishStore()

// ============ 表单 ============
const contentType = ref<'video' | 'image' | 'article'>('video')
const title = ref('')
const mediaFiles = ref<string[]>([])
const content = ref('')
const coverImage = ref('')
const tagsRaw = ref('')
const submitting = ref(false)

// ============ UI ============
const showDebug = ref(false)
// el-collapse 在 accordion=false 时接收 string[]，用 Set 也不行；
// 这里用数组 + 响应式替换来保证 UI 同步
const openTaskIds = ref<string[]>([])

// ============ 选择的账号 ID（用 reactive 保证 .has 也响应式）============
// 注意：ref<Set<>> 不响应内部 .add/.delete，改用 reactive object + 显式数组
const selectedIds = reactive<Record<string, boolean>>({})

function toggleAccount(id: string) {
  selectedIds[id] = !selectedIds[id]
  // 不使用的 key 保留 false 也没问题；true 表示选中
  console.log('[Publish.vue] toggleAccount', id, 'selectedCount=', getSelectedIds().length)
}

function getSelectedIds(): string[] {
  return Object.keys(selectedIds).filter((k) => selectedIds[k])
}

function selectAll() {
  // 仅全选分类过滤后的可见账号
  visibleAccounts.value.forEach((a) => { selectedIds[a.id] = true })
  console.log('[Publish.vue] selectAll ->', getSelectedIds().length)
}

function clearSelection() {
  for (const k of Object.keys(selectedIds)) delete selectedIds[k]
  console.log('[Publish.vue] clearSelection')
}

// ============ 初始化 ============
onMounted(async () => {
  console.log('[Publish.vue] mounted, ensuring listener + loading accounts')
  publishStore.ensureListener()
  try {
    if (accountStore.accounts.length === 0) {
      console.log('[Publish.vue] accountStore is empty, calling refreshAccounts')
      await accountStore.refreshAccounts()
    }
    if (accountStore.platforms.length === 0) {
      await accountStore.loadPlatforms()
    }
  } catch (e) {
    console.error('[Publish.vue] account refresh failed', e)
  }
  console.log('[Publish.vue] init done. accountsCount=', accountStore.accounts.length)
})

// ============ 计算属性 ============
const videoAccounts = computed(() =>
  accountStore.accounts.filter((a) => a.capabilities?.publishVideo)
)
const imageAccounts = computed(() =>
  accountStore.accounts.filter((a) => a.capabilities?.publishImage)
)
const articleAccounts = computed(() =>
  accountStore.accounts.filter((a) => a.capabilities?.publishArticle)
)
const currentAccounts = computed(() => {
  if (contentType.value === 'video') return videoAccounts.value
  if (contentType.value === 'image') return imageAccounts.value
  return articleAccounts.value
})

// 账号分类筛选与定时发布相关的响应式状态
const publishFilterCategoryId = ref<string>('')
const publishTimeType = ref<'now' | 'scheduled'>('now')
const scheduledTime = ref<Date | null>(null)

// 账号列表根据所选分类过滤后的可见账号列表
const visibleAccounts = computed(() => {
  const list = currentAccounts.value
  if (!publishFilterCategoryId.value) {
    return list
  }
  if (publishFilterCategoryId.value === 'unclassified') {
    return list.filter((a) => !a.categoryIds || a.categoryIds.length === 0)
  }
  return list.filter((a) => a.categoryIds && a.categoryIds.includes(publishFilterCategoryId.value))
})

// 定时发送：禁止选择过去的日期
function disabledScheduledDate(time: Date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return time.getTime() < today.getTime()
}

// ======== 内容限制（按平台汇总，取最小值当限制 ========
//  - 文章（article）：从 meta.articleLimits.content 读取（抖音 8000，小红书不限）
//  - 图文/视频（image/video）：从 meta.contentLimits.content 读取
const platformContentLimit = computed(() => {
  const ids = getSelectedIds()
  const isArticle = contentType.value === 'article'
  if (ids.length === 0) {
    // 未选账号时：文章默认不限制（用一个很大的数字占位），图文/视频默认 1000
    return { min: isArticle ? 100000 : 1000, platforms: [] }
  }
  const limits = new Set<number>()
  const plats: Array<{ platform: string; limit: number }> = []
  for (const id of ids) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (!meta) continue
    if (isArticle) {
      // 文章发布：从 articleLimits 读取
      if (typeof meta.articleLimits?.content === 'number') {
        limits.add(meta.articleLimits.content)
        plats.push({ platform: a.platform, limit: meta.articleLimits.content })
      }
      // 若没有 articleLimits.content（如小红书），表示该平台不限制正文字数 → 不加入集合
    } else {
      // 图文/视频发布：从 contentLimits 读取
      if (typeof meta.contentLimits?.content === 'number') {
        limits.add(meta.contentLimits.content)
        plats.push({ platform: a.platform, limit: meta.contentLimits.content })
      }
    }
  }
  // 若没有限制数据：文章模式返回大数（不限制），否则默认 1000
  if (limits.size === 0) return { min: isArticle ? 100000 : 1000, platforms: plats }
  return { min: Math.min(...limits.values()), platforms: plats }
})
// ======== 标题限制（按内容类型区分）=======
//  - 文章（article）：从 meta.articleLimits.title 读取（抖音 30，小红书 64）
//  - 图文（image）：从 meta.contentLimits.title 读取（小红书 20）
//  - 视频（video）：从 meta.contentLimits.title 读取
const titleMaxLength = computed(() => {
  const ids = getSelectedIds()
  const isArticle = contentType.value === 'article'
  if (ids.length === 0) {
    return isArticle ? 64 : 80
  }
  let min = Infinity
  for (const id of ids) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (!meta) continue
    let limit: number | undefined
    if (isArticle) {
      limit = meta.articleLimits?.title
    } else {
      limit = meta.contentLimits?.title
    }
    if (typeof limit === 'number') {
      min = Math.min(min, limit)
    }
  }
  return Number.isFinite(min) ? min : isArticle ? 64 : 80
})
const titlePlaceholder = computed(() => {
  if (contentType.value === 'article') {
    const ids = getSelectedIds()
    if (ids.length === 0) return '请输入文章标题（最多 64 字）'
    const hasDouyin = ids.some((id) => {
      const a = accountStore.accounts.find((x) => x.id === id)
      return a?.platform === 'douyin'
    })
    const hasXhs = ids.some((id) => {
      const a = accountStore.accounts.find((x) => x.id === id)
      return a?.platform === 'xiaohongshu'
    })
    if (hasDouyin && hasXhs) return '请输入文章标题（抖音最多 30 字，小红书最多 64 字，超出部分将被截断）'
    if (hasDouyin) return '请输入文章标题（抖音最多 30 字，超出部分将被截断）'
    if (hasXhs) return '请输入文章标题（小红书最多 64 字）'
    return '请输入文章标题'
  }
  if (contentType.value === 'image') {
    return '请输入图文标题（小红书最多 20 字，超出部分将被截断）'
  }
  return '请输入视频标题'
})
const isContentOverLimit = computed(() => content.value.length > platformContentLimit.value.min)
const kuaishouSelected = computed(() => {
  const ids = getSelectedIds()
  return accountStore.accounts.some((a) => ids.includes(a.id) && a.platform === 'kuaishou')
})

// 文章模式下是否选中了抖音账号（用于封面必填校验）
const hasDouyinAccount = computed(() => {
  const ids = getSelectedIds()
  return accountStore.accounts.some((a) => ids.includes(a.id) && a.platform === 'douyin')
})

// 文章模式下的正文最小字数提示
const articleMinContentHint = computed(() => {
  if (contentType.value !== 'article') return null
  const ids = getSelectedIds()
  const minReqs: Array<{ platform: string; min: number }> = []
  for (const id of ids) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (meta?.articleLimits?.minContent) {
      minReqs.push({ platform: a.platform, min: meta.articleLimits.minContent })
    }
  }
  if (minReqs.length === 0) return null
  const parts = minReqs.map((r) => `${platformName(r.platform)}至少${r.min}字`)
  return `📝 ${parts.join('，')}（当前 ${content.value.length} 字）`
})

// ============ 文件操作 ============
async function pickMediaFiles() {
  console.log('[Publish.vue] pickMediaFiles start')
  try {
    const r = await electronApi.openFileDialog({ mode: 'files' })
    console.log('[Publish.vue] pickMediaFiles raw=', r)
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      mediaFiles.value = [...mediaFiles.value, ...r.filePaths]
      console.log('[Publish.vue] pickMediaFiles -> ', mediaFiles.value.length, 'files')
      ElMessage.success(`已添加 ${r.filePaths.length} 个文件`)
    }
  } catch (e) {
    console.error('[Publish.vue] pickMediaFiles error', e)
    ElMessage.error('选择文件失败')
  }
}

function removeMediaFile(p: string) {
  mediaFiles.value = mediaFiles.value.filter((x) => x !== p)
  console.log('[Publish.vue] removeMediaFile', p, 'now size=', mediaFiles.value.length)
}

async function pickCover() {
  try {
    const r = await electronApi.openFileDialog({ mode: 'file' })
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      coverImage.value = r.filePaths[0]
      console.log('[Publish.vue] pickCover=', coverImage.value)
    }
  } catch (e) {
    console.error('[Publish.vue] pickCover error', e)
  }
}

// 文章模式：选择封面图片（支持多选，第一张为封面，其余为正文插图）
async function pickArticleCover() {
  console.log('[Publish.vue] pickArticleCover start')
  try {
    const r = await electronApi.openFileDialog({
      mode: 'files',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
    })
    console.log('[Publish.vue] pickArticleCover raw=', r)
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      mediaFiles.value = [...mediaFiles.value, ...r.filePaths]
      console.log('[Publish.vue] pickArticleCover -> ', mediaFiles.value.length, 'files')
      ElMessage.success(`已添加 ${r.filePaths.length} 张图片`)
    }
  } catch (e) {
    console.error('[Publish.vue] pickArticleCover error', e)
    ElMessage.error('选择图片失败')
  }
}

// ============ 提交 ============
async function submitPublish() {
  console.log('[Publish.vue] submitPublish clicked')

  if (!title.value.trim()) {
    ElMessage.warning('请输入标题')
    console.warn('[Publish.vue] missing title, abort')
    return
  }
  const accountIds = getSelectedIds()
  if (accountIds.length === 0) {
    ElMessage.warning('请至少选择一个账号')
    console.warn('[Publish.vue] no accounts selected, abort')
    return
  }
  if (contentType.value !== 'article' && mediaFiles.value.length === 0) {
    ElMessage.warning('请上传素材文件')
    console.warn('[Publish.vue] no media files, abort')
    return
  }

  // 文章模式 + 抖音账号：封面为必填项
  if (contentType.value === 'article' && hasDouyinAccount.value && mediaFiles.value.length === 0) {
    ElMessage.warning('抖音文章发布必须上传封面图片')
    console.warn('[Publish.vue] douyin article requires cover image, abort')
    return
  }

  // 文章模式：正文最小字数检查（阻塞性验证，不满足不能发布）
  if (contentType.value === 'article') {
    for (const id of accountIds) {
      const a = accountStore.accounts.find((x) => x.id === id)
      if (!a) continue
      const meta = accountStore.platforms.find((p) => p.key === a.platform)
      if (!meta || !meta.articleLimits) continue
      const minContent = meta.articleLimits.minContent
      if (typeof minContent === 'number' && content.value.length < minContent) {
        const platformDisplayName = platformName(a.platform)
        ElMessage.warning(`${platformDisplayName}文章正文至少需要 ${minContent} 字（当前 ${content.value.length} 字）`)
        console.warn(`[Publish.vue] ${a.platform} article content too short: ${content.value.length}/${minContent}`)
        return
      }
    }
  }

  // ===== 字数限制预检：提醒用户 =====
  // 按平台分别检查标题和内容，若任意平台超限，在提交时弹提醒（不阻塞，用户可自己取舍）
  const overLimitPlats: Array<{ platform: string; titleLen?: number; contentLen?: number; titleMax?: number; contentMax?: number }> = []
  for (const id of accountIds) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (!meta) continue
    
    // 检查图文/视频的contentLimits
    if (meta.contentLimits) {
      const tMax = meta.contentLimits.title
      const cMax = meta.contentLimits.content
      if ((typeof tMax === 'number' && title.value.length > tMax) ||
          (typeof cMax === 'number' && content.value.length > cMax)) {
        overLimitPlats.push({
          platform: a.platform,
          titleLen: title.value.length, contentLen: content.value.length,
          titleMax: tMax, contentMax: cMax,
        })
      }
    }
    
    // 检查文章模式的articleLimits最大字数
    if (contentType.value === 'article' && meta.articleLimits) {
      const tMax = meta.articleLimits.title
      const cMax = meta.articleLimits.content
      if ((typeof tMax === 'number' && title.value.length > tMax) ||
          (typeof cMax === 'number' && content.value.length > cMax)) {
        overLimitPlats.push({
          platform: a.platform,
          titleLen: title.value.length, contentLen: content.value.length,
          titleMax: tMax, contentMax: cMax,
        })
      }
    }
  }
  if (overLimitPlats.length > 0) {
    const msg = overLimitPlats.map((p) => {
      const parts: string[] = []
      if (typeof p.titleMax === 'number' && p.titleLen! > p.titleMax) parts.push(`标题${p.titleLen}/${p.titleMax}`)
      if (typeof p.contentMax === 'number' && p.contentLen! > p.contentMax) parts.push(`正文${p.contentLen}/${p.contentMax}`)
      return `  · ${platformName(p.platform)}：${parts.join('、')}`
    }).join('\n')
    ElMessage.warning({
      message: `以下平台将截断内容（超出限制自动截断，不影响发布）：\n${msg}`,
      duration: 5000,
    })
    console.warn('[Publish.vue] content over limits:', overLimitPlats)
  }

  // 校验是否属于定时发送，若是则检查日期并获取时间戳
  let scheduledAt: number | undefined = undefined
  if (publishTimeType.value === 'scheduled') {
    if (!scheduledTime.value) {
      ElMessage.warning('请选择定时发布时间')
      return
    }
    if (scheduledTime.value.getTime() <= Date.now()) {
      ElMessage.warning('定时发布时间必须是未来的时间')
      return
    }
    scheduledAt = scheduledTime.value.getTime()
  }

  const tags = tagsRaw.value
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0)

  const req: PublishRequest = {
    contentType: contentType.value,
    accountIds,
    title: title.value.trim(),
    mediaFiles: mediaFiles.value.slice(),
    coverImage: coverImage.value,
    tags,
    category: '',
    content: content.value,
    scheduledAt,
  }
  console.log('[Publish.vue] sending request to main process:', {
    contentType: req.contentType,
    title: req.title,
    accountCount: req.accountIds.length,
    mediaCount: req.mediaFiles.length,
  })

  submitting.value = true
  try {
    const taskId = await publishStore.submit(req)
    console.log('[Publish.vue] submitPublish success, taskId=', taskId)
    ElMessage.success(`任务已提交：${taskId}`)

    // 让新任务在折叠面板里默认展开
    openTaskIds.value = [...new Set([...openTaskIds.value, taskId])]
  } catch (e) {
    console.error('[Publish.vue] submitPublish caught error:', e)
    ElMessage.error(`发布失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    submitting.value = false
    console.log('[Publish.vue] submitPublish flow finished')
  }
}

// ============ 工具函数 ============
function formatTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function statusLabel(s?: string): string {
  switch (s) {
    case 'queued': return '排队中'
    case 'running': return '发布中'
    case 'success': return '成功'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return s || '-'
  }
}

function platformName(p?: string): string {
  if (!p) return '-'
  const map: Record<string, string> = {
    douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书',
    bilibili: '哔哩哔哩', video: '视频号',
  }
  return map[p] || p
}

function iconOf(platform?: string): string {
  const map: Record<string, string> = {
    douyin: '🎵', kuaishou: '⚡', xiaohongshu: '📕', bilibili: '📺', video: '🎬',
  }
  return map[platform ?? ''] || '🔘'
}

function nicknameOf(accountId: string): string {
  const a = accountStore.accounts.find((x) => x.id === accountId)
  return a?.nickname || accountId
}

function toggleDebug() {
  showDebug.value = !showDebug.value
  console.log('[Publish.vue] showDebug=', showDebug.value, 'logCount=', publishStore.logs.length)
}

function clearTask(taskId: string) {
  console.log('[Publish.vue] clearTask', taskId)
  publishStore.remove(taskId)
  openTaskIds.value = openTaskIds.value.filter((x) => x !== taskId)
}

function platformFromAccountId(accountId: string): PlatformType | undefined {
  const a = accountStore.accounts.find((x) => x.id === accountId)
  return a?.platform
}
</script>

<template>
  <div class="publish-page">
    <div class="panel">
      <h2 class="section-title">① 选择发布类型</h2>
      <el-radio-group v-model="contentType" size="default">
        <el-radio-button value="video">视频</el-radio-button>
        <el-radio-button value="image">图文</el-radio-button>
        <el-radio-button value="article">文章</el-radio-button>
      </el-radio-group>
      <el-divider />

      <h2 class="section-title">② 标题与内容</h2>
      <el-form label-width="80px" label-position="right">
        <el-form-item label="标题">
          <el-input
            v-model="title"
            :placeholder="titlePlaceholder"
            :maxlength="titleMaxLength"
            show-word-limit
          />
        </el-form-item>

        <el-form-item v-if="contentType !== 'article'" label="素材">
          <el-button @click="pickMediaFiles">选择文件</el-button>
          <span v-if="mediaFiles.length > 0" style="margin-left:8px; color:#909399; font-size:12px;">
            已选择 {{ mediaFiles.length }} 个文件
          </span>
          <div class="file-list" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="file-item">
              <span class="file-name">{{ f }}</span>
              <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
            </div>
          </div>
        </el-form-item>

        <!-- 文章模式：封面图片上传（抖音必填） -->
        <el-form-item v-if="contentType === 'article'" label="封面">
          <el-button @click="pickArticleCover">选择封面图片</el-button>
          <span v-if="mediaFiles.length > 0" style="margin-left:8px; color:#909399; font-size:12px;">
            已选择 {{ mediaFiles.length }} 张图片（第 1 张作为封面）
          </span>
          <div class="article-cover-hint" v-if="hasDouyinAccount">
            <span style="color:#F56C6C;">⚠️ 已选抖音账号：封面为必填项</span>
          </div>
          <div class="file-list" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="file-item">
              <span class="file-name">{{ idx === 0 ? '📌 封面：' : '' }}{{ f }}</span>
              <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
            </div>
          </div>
        </el-form-item>

        <el-form-item v-if="contentType === 'video'" label="封面">
          <el-button @click="pickCover">选择封面</el-button>
          <span v-if="coverImage" style="margin-left:8px; color:#909399; font-size:12px;">{{ coverImage }}</span>
        </el-form-item>

        <el-form-item label="描述">
          <el-input
            v-model="content"
            type="textarea"
            :rows="contentType === 'article' ? 8 : 4"
            :placeholder="contentType === 'article'
              ? '请输入文章正文（抖音：至少100字，最多8000字；小红书：不限制字数）'
              : contentType === 'image'
                ? '可选：为图文添加描述文案（将作为笔记正文发布，小红书 1000 字/抖音 1000 字/快手 500 字）'
                : '可选：为视频添加描述文案（快手最多 500 字）'"
            :maxlength="platformContentLimit.min"
            show-word-limit
          />
          <div v-if="kuaishouSelected" class="kuaishou-hint">
            ⚡ 已选快手账号：正文将被限制为 500 字，超出部分将自动截断
          </div>
          <div v-if="isContentOverLimit" class="over-limit-hint">
            ⚠️ 当前内容（{{ content.length }} 字）超出所选平台最大限制（{{ platformContentLimit.min }} 字），超出部分将在发布时自动截断
          </div>
          <div v-if="platformContentLimit.platforms.length > 0" class="limits-hint">
            各平台正文限制：{{ platformContentLimit.platforms.map(p => `${platformName(p.platform)} ${p.limit}字`).join(' / ') }}
          </div>
          <div v-if="articleMinContentHint" class="min-content-hint">
            {{ articleMinContentHint }}
          </div>
        </el-form-item>

        <el-form-item label="话题">
          <el-input v-model="tagsRaw" placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活" />
        </el-form-item>
      </el-form>

      <el-divider />

      <h2 class="section-title">③ 选择发布账号</h2>
      <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 13px; color: #606266;">分类筛选：</span>
        <el-select v-model="publishFilterCategoryId" placeholder="全部分类" clearable style="width: 140px" size="small">
          <el-option label="全部分类" value="" />
          <el-option label="未分类" value="unclassified" />
          <el-option v-for="cat in accountStore.categories" :key="cat.id" :label="cat.name" :value="cat.id" />
        </el-select>
      </div>
      <div class="account-actions">
        <el-button size="small" @click="selectAll">全选可见</el-button>
        <el-button size="small" @click="clearSelection">清空</el-button>
        <span class="hint">已选 {{ getSelectedIds().length }} / {{ visibleAccounts.length }}</span>
      </div>

      <div v-if="visibleAccounts.length === 0" class="empty">
        <el-empty description="没有可用账号，请先在账号管理授权" />
      </div>

      <div v-else class="account-grid">
        <div
          v-for="a in visibleAccounts"
          :key="a.id"
          class="account-card"
          :class="{ selected: !!selectedIds[a.id] }"
          @click="toggleAccount(a.id)"
        >
          <div class="platform-tag">{{ iconOf(a.platform) }} {{ platformName(a.platform) }}</div>
          <div class="nickname">{{ a.nickname }}</div>
          <div class="account-id">{{ a.id }}</div>
          <div class="content-limit-tag">
            {{ (() => {
              const meta = accountStore.platforms.find(p => p.key === a.platform);
              if (!meta) return '';
              if (contentType === 'article') {
                const t = meta.articleLimits?.title;
                const c = meta.articleLimits?.content;
                if (typeof t === 'number' && typeof c === 'number') return `标题${t}字 / 正文${c}字`;
                if (typeof t === 'number') return `标题${t}字 / 正文不限`;
                if (typeof c === 'number') return `正文最多 ${c} 字`;
                return '字数不限';
              }
              return meta.contentLimits?.content ? `正文最多 ${meta.contentLimits.content} 字` : '';
            })() }}
          </div>
          <div v-if="selectedIds[a.id]" class="selected-mark">✓</div>
        </div>
      </div>

      <el-divider />

      <h2 class="section-title">④ 发布设置</h2>
      <el-form label-width="80px" style="margin-bottom: 20px;">
        <el-form-item label="发布时间">
          <el-radio-group v-model="publishTimeType" size="default">
            <el-radio value="now">立即发布</el-radio>
            <el-radio value="scheduled">定时发布</el-radio>
          </el-radio-group>
          
          <el-date-picker
            v-if="publishTimeType === 'scheduled'"
            v-model="scheduledTime"
            type="datetime"
            placeholder="选择发布时间"
            :disabled-date="disabledScheduledDate"
            style="margin-left: 16px; width: 220px;"
          />
        </el-form-item>
      </el-form>

      <el-divider />

      <div class="submit-row">
        <el-button type="primary" :loading="submitting" :disabled="visibleAccounts.length === 0" @click="submitPublish">
          {{ publishTimeType === 'scheduled' ? '定时发布到' : '一键发布到' }} {{ getSelectedIds().length }} 个账号
        </el-button>
        <el-button @click="toggleDebug" :type="showDebug ? 'warning' : 'default'">
          {{ showDebug ? '隐藏调试日志' : '调试模式' }}（{{ publishStore.logs.length }}）
        </el-button>
      </div>
    </div>

    <!-- ==================== 任务进行中 ==================== -->
    <div v-if="publishStore.hasLiveTasks" class="panel">
      <h2 class="section-title">任务进行中（{{ Object.keys(publishStore.liveTasks).length }}）</h2>
      <el-collapse v-model="openTaskIds">
        <el-collapse-item
          v-for="t in publishStore.liveList"
          :key="t.taskId"
          :name="t.taskId"
          :title="`任务 ${t.taskId.slice(0, 14)} | ${statusLabel(t.status)} | ${Math.round(t.overallProgress)}% | ${formatTime(t.startedAt)}`"
        >
          <div class="task-meta">
            <span>标题：{{ t.request.title }}</span>
            <span>类型：{{ t.request.contentType }}</span>
            <span>账号数：{{ t.request.accountIds.length }}</span>
            <el-button size="small" type="danger" link @click.stop="clearTask(t.taskId)">移除</el-button>
          </div>
          <el-progress
            :percentage="Math.round(t.overallProgress)"
            :status="t.status === 'success' ? 'success' : t.status === 'failed' ? 'exception' : undefined"
          />
          <el-table :data="t.items" size="small" style="margin-top: 10px;">
            <el-table-column label="账号" min-width="200">
              <template #default="{ row }">
                <span>{{ iconOf(platformFromAccountId(row.accountId)) }} {{ nicknameOf(row.accountId) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="平台" width="120">
              <template #default="{ row }">{{ platformName(platformFromAccountId(row.accountId)) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'success'" type="success" size="small">成功</el-tag>
                <el-tag v-else-if="row.status === 'failed'" type="danger" size="small">失败</el-tag>
                <el-tag v-else-if="row.status === 'running'" type="primary" size="small">发布中</el-tag>
                <el-tag v-else size="small">队列</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" width="200">
              <template #default="{ row }">
                <el-progress :percentage="Math.round(row.progress ?? 0)" :stroke-width="10" />
              </template>
            </el-table-column>
            <el-table-column prop="message" label="详情" min-width="220" show-overflow-tooltip />
            <el-table-column label="链接" width="120">
              <template #default="{ row }">
                <el-link v-if="row.resultUrl" type="primary" :href="row.resultUrl" target="_blank" :disabled="false">查看</el-link>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- ==================== 调试日志面板 ==================== -->
    <div v-if="showDebug" class="panel">
      <h2 class="section-title">实时调试日志（最近 {{ publishStore.logs.length }} 条）</h2>
      <div class="debug-hint">
        打开浏览器 DevTools (Ctrl+Shift+I) 可查看 console 实时日志；这里同时记录关键事件。
      </div>
      <div class="debug-actions">
        <el-button size="small" @click="() => { console.log('[Publish.vue] store dump:', { liveTasks: publishStore.liveTasks, logs: publishStore.logs }); ElMessage.info('已输出到 console'); }">
          把 store 打印到 console
        </el-button>
        <el-button size="small" @click="() => { console.log('[Publish.vue] accountStore:', accountStore.accounts); }">
          打印账号列表
        </el-button>
      </div>
      <div class="debug-log">
        <div v-for="(l, idx) in publishStore.logs" :key="idx" class="log-line" :class="l.level">
          <span class="log-time">{{ formatTime(l.ts) }}</span>
          <span class="log-level">[{{ l.level === 'info' ? 'INFO' : l.level === 'warn' ? 'WARN' : 'ERR' }}]</span>
          <span class="log-msg">{{ l.msg }}</span>
          <span v-if="l.data" class="log-data">{{ JSON.stringify(l.data) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.publish-page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #303133;
}
.file-list { margin-top: 8px; max-height: 160px; overflow-y: auto; }
.file-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 12px; color: #606266; }
.file-name { word-break: break-all; }
.account-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.hint { color: #909399; font-size: 12px; }
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.account-card {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 10px;
  cursor: pointer;
  position: relative;
  transition: all 0.15s;
}
.account-card:hover { border-color: #409eff; background: #f4faff; }
.account-card.selected { border-color: #409eff; background: #ecf5ff; border-width: 2px; padding: 9px; }
.platform-tag { font-size: 12px; color: #909399; margin-bottom: 4px; }
.nickname { font-size: 14px; font-weight: 500; color: #303133; }
.account-id { font-size: 11px; color: #c0c4cc; margin-top: 4px; word-break: break-all; }
.selected-mark { position: absolute; top: 8px; right: 10px; color: #409eff; font-weight: bold; }
.submit-row { display: flex; gap: 10px; align-items: center; }

/* ======== 字数限制提示 ======== */
.kuaishou-hint {
  font-size: 12px;
  color: #e6a23c;
  margin-top: 4px;
  background: #fdf6ec;
  border-left: 3px solid #e6a23c;
  padding: 6px 10px;
  border-radius: 3px;
}
.over-limit-hint {
  font-size: 12px;
  color: #f56c6c;
  margin-top: 4px;
  background: #fef0f0;
  border-left: 3px solid #f56c6c;
  padding: 6px 10px;
  border-radius: 3px;
}
.limits-hint {
  font-size: 11px;
  color: #909399;
  margin-top: 4px;
}
.min-content-hint {
  font-size: 12px;
  color: #409eff;
  margin-top: 4px;
  background: #ecf5ff;
  border-left: 3px solid #409eff;
  padding: 6px 10px;
  border-radius: 3px;
}
.content-limit-tag {
  font-size: 11px;
  color: #909399;
  margin-top: 4px;
}

/* 调试日志 */
.debug-hint { font-size: 12px; color: #909399; margin-bottom: 6px; }
.debug-actions { margin-bottom: 10px; display: flex; gap: 8px; }
.debug-log {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 10px;
  border-radius: 4px;
  max-height: 420px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.7;
}
.log-line { display: flex; gap: 6px; flex-wrap: wrap; }
.log-line.warn { color: #e5c07b; }
.log-line.error { color: #f48771; }
.log-time { color: #858585; flex-shrink: 0; }
.log-level { color: #6a9955; flex-shrink: 0; }
.log-msg { color: #d4d4d4; }
.log-data { color: #858585; margin-left: 4px; word-break: break-all; }
.empty { padding: 20px 0; }
.task-meta { display: flex; gap: 20px; color: #606266; font-size: 13px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
</style>
