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
      // 🔑 微信视频号特异性字数限制：视频短标题限制 16 字，图文限制 22 字
      if (a.platform === 'wechat_channels' && contentType.value === 'video') {
        limit = 16
      } else {
        limit = meta.contentLimits?.title
      }
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

// 话题标签总长度计算（和各平台 prepareTags 逻辑一致：去空、去重、加#、空格连接）
const tagsLength = computed(() => {
  if (!tagsRaw.value.trim()) return 0
  const tagList = tagsRaw.value
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tagList) {
    const withHash = '#' + t
    if (!seen.has(withHash)) {
      seen.add(withHash)
      unique.push(withHash)
    }
  }
  if (unique.length === 0) return 0
  // 标签 + 空格分隔 + （正文非空时前面一个换行符）
  const joined = unique.join(' ')
  return joined.length + (content.value.trim().length > 0 ? 1 : 0)
})
// 正文 + 话题 是否超限（用于页面实时提示）
const isContentWithTagsOverLimit = computed(() => {
  if (getSelectedIds().length === 0) return false
  const total = content.value.length + tagsLength.value
  return total > platformContentLimit.value.min
})
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
// 图片格式扩展名
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
// 视频格式扩展名
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'webm', 'm4v', '3gp']

async function pickMediaFiles() {
  console.log('[Publish.vue] pickMediaFiles start, contentType=', contentType.value)
  try {
    const options: { mode: 'files'; filters?: Electron.FileFilter[] } = { mode: 'files' }
    // 根据内容类型限制文件选择格式
    if (contentType.value === 'image') {
      options.filters = [{ name: '图片文件', extensions: IMAGE_EXTENSIONS }]
    } else if (contentType.value === 'video') {
      options.filters = [{ name: '视频文件', extensions: VIDEO_EXTENSIONS }]
    }
    const r = await electronApi.openFileDialog(options)
    console.log('[Publish.vue] pickMediaFiles raw=', r)
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      // 校验文件格式是否匹配
      const exts = contentType.value === 'image' ? IMAGE_EXTENSIONS
        : contentType.value === 'video' ? VIDEO_EXTENSIONS
        : null
      if (exts) {
        const valid = r.filePaths.filter((p) => {
          const ext = p.split('.').pop()?.toLowerCase() || ''
          return exts.includes(ext)
        })
        const invalid = r.filePaths.length - valid.length
        if (invalid > 0) {
          ElMessage.warning(`已过滤 ${invalid} 个不支持的文件格式`)
        }
        if (valid.length === 0) return
        mediaFiles.value = [...mediaFiles.value, ...valid]
        console.log('[Publish.vue] pickMediaFiles -> ', mediaFiles.value.length, 'files')
        ElMessage.success(`已添加 ${valid.length} 个文件`)
      } else {
        mediaFiles.value = [...mediaFiles.value, ...r.filePaths]
        console.log('[Publish.vue] pickMediaFiles -> ', mediaFiles.value.length, 'files')
        ElMessage.success(`已添加 ${r.filePaths.length} 个文件`)
      }
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
    const r = await electronApi.openFileDialog({
      mode: 'file',
      filters: [{ name: '图片文件', extensions: IMAGE_EXTENSIONS }],
    })
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

  // 防止重复提交：进入即锁定
  if (submitting.value) {
    console.warn('[Publish.vue] 重复提交被拦截')
    return
  }

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

  // 所有前置校验通过后，才锁定提交状态
  submitting.value = true

  // ===== 字数限制预检：提醒用户 =====
  // 按平台分别检查标题和内容，若任意平台超限，在提交时弹提醒（不阻塞，用户可自己取舍）
  // 🔑 话题标签追加在正文后面，所以正文限制需要把标签长度也算进去
  const tagList = tagsRaw.value
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0)
  // 去重（和各平台 prepareTags 逻辑一致）
  const seenTags = new Set<string>()
  const uniqueTags: string[] = []
  for (const t of tagList) {
    const withHash = '#' + t
    if (!seenTags.has(withHash)) {
      seenTags.add(withHash)
      uniqueTags.push(withHash)
    }
  }
  // 标签总长度 = 各标签用空格连接 + 正文非空时前面一个换行符
  const tagsTotalLen = uniqueTags.length > 0
    ? uniqueTags.join(' ').length + (content.value.trim().length > 0 ? 1 : 0)
    : 0

  const overLimitPlats: Array<{ platform: string; titleLen?: number; contentLen?: number; titleMax?: number; contentMax?: number; tagsLen?: number; totalLen?: number }> = []
  for (const id of accountIds) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (!meta) continue
    
    // 检查图文/视频的contentLimits（正文 + 话题标签 一起算）
    if (meta.contentLimits) {
      const tMax = meta.contentLimits.title
      const cMax = meta.contentLimits.content
      const contentLen = content.value.length
      const totalContentLen = contentLen + tagsTotalLen
      if ((typeof tMax === 'number' && title.value.length > tMax) ||
          (typeof cMax === 'number' && totalContentLen > cMax)) {
        overLimitPlats.push({
          platform: a.platform,
          titleLen: title.value.length, contentLen, tagsLen: tagsTotalLen, totalLen: totalContentLen,
          titleMax: tMax, contentMax: cMax,
        })
      }
    }
    
    // 检查文章模式的articleLimits最大字数（正文 + 话题标签 一起算）
    if (contentType.value === 'article' && meta.articleLimits) {
      const tMax = meta.articleLimits.title
      const cMax = meta.articleLimits.content
      const contentLen = content.value.length
      const totalContentLen = contentLen + tagsTotalLen
      if ((typeof tMax === 'number' && title.value.length > tMax) ||
          (typeof cMax === 'number' && totalContentLen > cMax)) {
        overLimitPlats.push({
          platform: a.platform,
          titleLen: title.value.length, contentLen, tagsLen: tagsTotalLen, totalLen: totalContentLen,
          titleMax: tMax, contentMax: cMax,
        })
      }
    }
  }
  if (overLimitPlats.length > 0) {
    const msg = overLimitPlats.map((p) => {
      const parts: string[] = []
      if (typeof p.titleMax === 'number' && p.titleLen! > p.titleMax) parts.push(`标题${p.titleLen}/${p.titleMax}`)
      if (typeof p.contentMax === 'number' && p.totalLen! > p.contentMax) {
        parts.push(`正文+话题${p.totalLen}/${p.contentMax}（正文${p.contentLen}+话题${p.tagsLen}）`)
      }
      return `  · ${platformName(p.platform)}：${parts.join('、')}`
    }).join('\n')
    ElMessage.warning({
      message: `以下平台内容将超出字数限制（话题会追加到正文末尾），发布后可能被截断：\n${msg}`,
      duration: 6000,
    })
    console.warn('[Publish.vue] content over limits (including tags):', overLimitPlats)
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
    bilibili: '哔哩哔哩', wechat_channels: '微信视频号', video: '视频号',
    zhihu: '知乎', toutiao: '今日头条',
  }
  return map[p] || p
}

function iconOf(platform?: string): string {
  const map: Record<string, string> = {
    douyin: '🎵', kuaishou: '⚡', xiaohongshu: '📕', bilibili: '📺', wechat_channels: '🎬',
    zhihu: '💡', toutiao: '📰',
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
      <div class="publish-type-selector">
        <div 
          class="type-card video-card" 
          :class="{ active: contentType === 'video' }" 
          @click="contentType = 'video'"
        >
          <div class="type-icon-wrapper video">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>
          </div>
          <div class="type-info">
            <div class="type-title">视频</div>
            <div class="type-desc">发布短视频、中视频</div>
          </div>
        </div>

        <div 
          class="type-card image-card" 
          :class="{ active: contentType === 'image' }" 
          @click="contentType = 'image'"
        >
          <div class="type-icon-wrapper image">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          </div>
          <div class="type-info">
            <div class="type-title">图文</div>
            <div class="type-desc">多张图片加文本描述</div>
          </div>
        </div>

        <div 
          class="type-card article-card" 
          :class="{ active: contentType === 'article' }" 
          @click="contentType = 'article'"
        >
          <div class="type-icon-wrapper article">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
          </div>
          <div class="type-info">
            <div class="type-title">文章</div>
            <div class="type-desc">长文字、排版与封面图</div>
          </div>
        </div>
      </div>
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
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
            <el-button @click="pickMediaFiles">选择文件</el-button>
            <span v-if="mediaFiles.length > 0" style="color:#64748b; font-size:12px; font-weight: 500;">
              已选择 {{ mediaFiles.length }} 个文件
            </span>
            <span v-else style="color:#94a3b8; font-size:12px; font-weight: 500;">
              {{ contentType === 'video' ? '支持 mp4, mov, avi, mkv, flv, webm 等视频格式' : '支持 jpg, jpeg, png, webp, gif, bmp 等图片格式' }}
            </span>
          </div>
          <div class="file-list" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="file-item">
              <span class="file-name">{{ f }}</span>
              <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
            </div>
          </div>
        </el-form-item>

        <!-- 文章模式：封面图片上传（抖音必填） -->
        <el-form-item v-if="contentType === 'article'" label="封面">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
            <el-button @click="pickArticleCover">选择封面图片</el-button>
            <span v-if="mediaFiles.length > 0" style="color:#64748b; font-size:12px; font-weight: 500;">
              已选择 {{ mediaFiles.length }} 张图片（第 1 张作为封面）
            </span>
            <span v-else style="color:#94a3b8; font-size:12px; font-weight: 500;">
              支持 jpg, jpeg, png, webp 等图片格式
            </span>
          </div>
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
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
            <el-button @click="pickCover">选择封面</el-button>
            <span v-if="coverImage" style="color:#64748b; font-size:12px; font-weight: 500;">
              {{ coverImage }}
            </span>
            <span v-else style="color:#94a3b8; font-size:12px; font-weight: 500;">
              支持 jpg, jpeg, png, webp 等图片格式
            </span>
          </div>
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
          <div v-if="isContentWithTagsOverLimit" class="over-limit-hint">
            ⚠️ 正文+话题共 {{ content.length + tagsLength }} 字，超出所选平台最大限制（{{ platformContentLimit.min }} 字），发布后可能被截断
          </div>
          <div v-else-if="isContentOverLimit" class="over-limit-hint">
            ⚠️ 当前内容（{{ content.length }} 字）超出所选平台最大限制（{{ platformContentLimit.min }} 字），超出部分将在发布时自动截断
          </div>
          <div v-if="platformContentLimit.platforms.length > 0" class="limits-hint">
            各平台正文限制：{{ platformContentLimit.platforms.map(p => `${platformName(p.platform)} ${p.limit}字`).join(' / ') }}
            <span v-if="tagsLength > 0">（当前话题约 {{ tagsLength }} 字）</span>
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
          <div class="selection-indicator" :class="{ selected: !!selectedIds[a.id] }">
            <span class="check-icon" v-if="selectedIds[a.id]">✓</span>
          </div>
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
        <el-button type="primary" :loading="submitting" :disabled="submitting || visibleAccounts.length === 0" @click="submitPublish">
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
/* 美化发布类型选择卡片 */
.publish-type-selector {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.type-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--glow-shadow-sm);
}

.type-card:not(.active):hover {
  transform: translateY(-2px);
  border-color: rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.03);
}

.type-card.active:hover {
  transform: translateY(-2px);
}

/* 视频卡片激活样式 */
.type-card.video-card.active {
  border-color: #f97316;
  background: rgba(249, 115, 22, 0.07);
  box-shadow: 0 8px 20px rgba(249, 115, 22, 0.12);
}
.type-card.video-card.active .type-title {
  color: #f97316;
}

/* 图文卡片激活样式 */
.type-card.image-card.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.07);
  box-shadow: 0 8px 20px rgba(16, 185, 129, 0.12);
}
.type-card.image-card.active .type-title {
  color: #10b981;
}

/* 文章卡片激活样式 */
.type-card.article-card.active {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.07);
  box-shadow: 0 8px 20px rgba(99, 102, 241, 0.12);
}
.type-card.article-card.active .type-title {
  color: #6366f1;
}

.type-icon-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  font-size: 20px;
  transition: all 0.3s ease;
}

/* 视频图标背景和颜色 */
.type-icon-wrapper.video {
  background: rgba(249, 115, 22, 0.08);
  color: #f97316;
}
.type-card.active .type-icon-wrapper.video {
  background: #f97316;
  color: #ffffff;
}

/* 图文图标背景和颜色 */
.type-icon-wrapper.image {
  background: rgba(16, 185, 129, 0.08);
  color: #10b981;
}
.type-card.active .type-icon-wrapper.image {
  background: #10b981;
  color: #ffffff;
}

/* 文章图标背景和颜色 */
.type-icon-wrapper.article {
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
}
.type-card.active .type-icon-wrapper.article {
  background: #6366f1;
  color: #ffffff;
}

.type-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.type-title {
  font-size: 14px;
  font-weight: 700;
  color: #1e293b;
  transition: color 0.3s ease;
}

/* 已集成到各卡片激活样式中 */

.type-desc {
  font-size: 11px;
  color: #94a3b8;
}

.publish-page {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-list {
  margin-top: 12px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 10px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.5);
}

.file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
  color: #475569;
  border-bottom: 1px solid rgba(0, 0, 0, 0.02);
}

.file-item:last-child {
  border-bottom: none;
}

.file-name {
  word-break: break-all;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.account-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}

.hint {
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  margin-left: auto;
}

/* 账号卡片网络 */
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}

.account-card {
  border: 1px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  position: relative;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  background: rgba(255, 255, 255, 0.85);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: var(--glow-shadow-sm);
}

.account-card:hover {
  border-color: rgba(99, 102, 241, 0.22);
  background: rgba(99, 102, 241, 0.04);
  transform: translateY(-4px);
  box-shadow: 0 12px 28px -6px rgba(99, 102, 241, 0.12), 0 4px 12px -8px rgba(0, 0, 0, 0.04);
}

.account-card.selected:hover {
  border-color: #4f46e5;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, #ffffff 100%);
  box-shadow: 0 16px 36px -6px rgba(99, 102, 241, 0.22), 0 4px 16px -8px rgba(0, 0, 0, 0.08);
}

.account-card.selected {
  border-color: #6366f1;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, #ffffff 100%);
  border-width: 1px;
  box-shadow: 0 10px 20px -10px rgba(99, 102, 241, 0.15), var(--glow-shadow-md);
}

.platform-tag {
  font-size: 11px;
  color: #64748b;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.nickname {
  font-size: 14px;
  font-weight: 700;
  color: #1e293b;
  margin-top: 2px;
}

.account-id {
  font-size: 11px;
  color: #94a3b8;
  word-break: break-all;
  font-family: monospace;
}

.selection-indicator {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid #cbd5e1;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
}

.account-card:hover .selection-indicator:not(.selected) {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.05);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
  transform: scale(1.05);
}

.selection-indicator.selected {
  border-color: #6366f1;
  background: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}

.selection-indicator .check-icon {
  color: #ffffff;
  font-size: 10px;
  font-weight: 800;
  transform: scale(0.85);
  display: inline-block;
  line-height: 1;
}

.submit-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

/* ======== 字数限制提示美化（清透现代通知栏） ======== */
.kuaishou-hint,
.over-limit-hint,
.min-content-hint {
  font-size: 12px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.kuaishou-hint {
  color: #d97706;
  background: #fef3c7;
  border: 1px solid rgba(217, 119, 6, 0.1);
}

.over-limit-hint {
  color: #dc2626;
  background: #fee2e2;
  border: 1px solid rgba(220, 38, 38, 0.1);
}

.min-content-hint {
  color: #2563eb;
  background: #dbeafe;
  border: 1px solid rgba(37, 99, 235, 0.1);
}

.limits-hint {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 6px;
  font-weight: 500;
}

.content-limit-tag {
  font-size: 11px;
  color: #64748b;
  margin-top: 4px;
  font-weight: 500;
}

.article-cover-hint {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
}

/* 调试日志终端 */
.debug-hint {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 8px;
}

.debug-actions {
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
}

.debug-log {
  background: #0f172a;
  color: #cbd5e1;
  padding: 16px;
  border-radius: 12px;
  max-height: 400px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.8;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2);
}

.log-line {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.log-line:last-child {
  border-bottom: none;
}

.log-line.warn {
  color: #f59e0b;
}

.log-line.error {
  color: #ef4444;
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-level {
  color: #10b981;
  font-weight: 600;
  flex-shrink: 0;
}

.log-msg {
  color: #f1f5f9;
}

.log-data {
  color: #94a3b8;
  margin-left: 4px;
  word-break: break-all;
  font-size: 11px;
}

.empty {
  padding: 20px 0;
}

.task-meta {
  display: flex;
  gap: 20px;
  color: #475569;
  font-size: 13px;
  margin-bottom: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-weight: 600;
}
</style>
