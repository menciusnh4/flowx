<script setup lang="ts">
import { ref, computed, reactive, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox, ElInput } from 'element-plus'
import { useAccountStore } from '../stores/account'
import { electronApi } from '../utils/electron'
import type { PublishRequest, PlatformType } from '../../types'

const props = defineProps<{
  /** 表单初始值（用于草稿加载、内容提取预填充等） */
  initialValue?: Partial<PublishRequest>
  /** 是否显示发布按钮（浏览器页内嵌时可能隐藏，改为"保存草稿"） */
  showSubmit?: boolean
  /** 提交按钮文本 */
  submitText?: string
}>()

const emit = defineEmits<{
  (e: 'submit', req: PublishRequest): void
  (e: 'test-submit', req: PublishRequest): void
  (e: 'change', value: Partial<PublishRequest>): void
  (e: 'modal-show'): void
  (e: 'modal-hide'): void
}>()

const accountStore = useAccountStore()

// ============ 弹窗封装（解决 WebContentsView 遮挡问题） ============
async function showConfirm(message: string, title: string, options?: Record<string, unknown>): Promise<boolean> {
  emit('modal-show')
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
      ...options,
    })
    return true
  } catch {
    return false
  } finally {
    emit('modal-hide')
  }
}

// ============ 表单 ============
const contentType = ref<'video' | 'image' | 'article'>(props.initialValue?.contentType || 'video')
const title = ref(props.initialValue?.title || '')
const mediaFiles = ref<string[]>(props.initialValue?.mediaFiles || [])
const content = ref(props.initialValue?.content || '')
const summary = ref(props.initialValue?.summary || '')
const coverImage = ref(props.initialValue?.coverImage || '')
const tagsRaw = ref((props.initialValue?.tags || []).join(' '))
const submitting = ref(false)
const contentTextareaRef = ref<InstanceType<typeof ElInput> | null>(null)

// 切换发布类型时清空素材文件
watch(contentType, () => {
  mediaFiles.value = []
  coverImage.value = ''
  notifyChange()
})

// 监听表单变化，向外通知
function notifyChange() {
  emit('change', {
    contentType: contentType.value,
    title: title.value,
    mediaFiles: mediaFiles.value,
    content: content.value,
    summary: summary.value,
    coverImage: coverImage.value,
    tags: tagsRaw.value.split(/[,，\s]+/).map(t => t.trim().replace(/^#/, '')).filter(t => t.length > 0),
  })
}

// ============ 选择的账号 ID ============
const selectedIds = reactive<Record<string, boolean>>({})

function toggleAccount(id: string) {
  selectedIds[id] = !selectedIds[id]
  notifyChange()
}

function getSelectedIds(): string[] {
  // 🔑 只返回支持当前 contentType 的账号，防止切换类型后残留的选中账号被误发布
  const currentType = contentType.value
  return Object.keys(selectedIds)
    .filter((k) => selectedIds[k])
    .filter((id) => {
      const acc = accountStore.accounts.find((a) => a.id === id)
      if (!acc) return false
      if (currentType === 'video') return !!acc.capabilities?.publishVideo
      if (currentType === 'image') return !!acc.capabilities?.publishImage
      if (currentType === 'article') return !!acc.capabilities?.publishArticle
      return false
    })
}

function selectAll() {
  visibleAccounts.value.forEach((a) => { selectedIds[a.id] = true })
  notifyChange()
}

function clearSelection() {
  for (const k of Object.keys(selectedIds)) delete selectedIds[k]
  notifyChange()
}

// ============ 监听发布类型变化，清除不支持的账号选中状态 ============
watch(contentType, () => {
  const currentType = contentType.value
  let changed = false
  for (const id of Object.keys(selectedIds)) {
    if (!selectedIds[id]) continue
    const acc = accountStore.accounts.find((a) => a.id === id)
    if (!acc) {
      delete selectedIds[id]
      changed = true
      continue
    }
    const supported =
      (currentType === 'video' && acc.capabilities?.publishVideo) ||
      (currentType === 'image' && acc.capabilities?.publishImage) ||
      (currentType === 'article' && acc.capabilities?.publishArticle)
    if (!supported) {
      delete selectedIds[id]
      changed = true
    }
  }
  if (changed) {
    notifyChange()
  }
})

// ============ 初始化 ============
onMounted(async () => {
  try {
    if (accountStore.accounts.length === 0) {
      await accountStore.refreshAccounts()
    }
    if (accountStore.platforms.length === 0) {
      await accountStore.loadPlatforms()
    }
    if (accountStore.categories.length === 0) {
      await accountStore.loadCategories()
    }
    // 如果有初始选中的账号
    if (props.initialValue?.accountIds) {
      props.initialValue.accountIds.forEach((id) => {
        selectedIds[id] = true
      })
    }
  } catch (e) {
    console.error('[PublishForm] init failed', e)
  }
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

// 账号分类筛选与定时发布
const publishFilterCategoryId = ref<string>('')
const publishTimeType = ref<'now' | 'scheduled'>('now')
const scheduledTime = ref<Date | null>(null)

const visibleAccounts = computed(() => {
  const list = currentAccounts.value
  if (!publishFilterCategoryId.value) return list
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

// ======== 内容限制 ========
const platformContentLimit = computed(() => {
  const ids = getSelectedIds()
  const isArticle = contentType.value === 'article'
  if (ids.length === 0) {
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
      if (typeof meta.articleLimits?.content === 'number') {
        limits.add(meta.articleLimits.content)
        plats.push({ platform: a.platform, limit: meta.articleLimits.content })
      }
    } else {
      if (typeof meta.contentLimits?.content === 'number') {
        limits.add(meta.contentLimits.content)
        plats.push({ platform: a.platform, limit: meta.contentLimits.content })
      }
    }
  }
  if (limits.size === 0) return { min: isArticle ? 100000 : 1000, platforms: plats }
  return { min: Math.min(...limits.values()), platforms: plats }
})

// ======== 标题限制 ========
const titleMaxLength = computed(() => {
  const ids = getSelectedIds()
  const isArticle = contentType.value === 'article'
  if (ids.length === 0) return isArticle ? 64 : 80
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
      if (a.platform === 'wechat_channels' && contentType.value === 'video') {
        limit = 16
      } else {
        limit = meta.contentLimits?.title
      }
    }
    if (typeof limit === 'number') min = Math.min(min, limit)
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
  if (contentType.value === 'image') return '请输入图文标题（小红书最多 20 字，超出部分将被截断）'
  return '请输入视频标题'
})

const isContentOverLimit = computed(() => content.value.length > platformContentLimit.value.min)

// 话题标签长度
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
  const joined = unique.join(' ')
  return joined.length + (content.value.trim().length > 0 ? 1 : 0)
})

const isContentWithTagsOverLimit = computed(() => {
  if (getSelectedIds().length === 0) return false
  const total = content.value.length + tagsLength.value
  return total > platformContentLimit.value.min
})

const kuaishouSelected = computed(() => {
  const ids = getSelectedIds()
  return accountStore.accounts.some((a) => ids.includes(a.id) && a.platform === 'kuaishou')
})

const hasDouyinAccount = computed(() => {
  const ids = getSelectedIds()
  return accountStore.accounts.some((a) => ids.includes(a.id) && a.platform === 'douyin')
})

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

// 文章摘要最大字数（取所选平台中最小的限制）
const articleSummaryMaxLength = computed(() => {
  if (contentType.value !== 'article') return 2000
  const ids = getSelectedIds()
  if (ids.length === 0) return 2000
  let minLimit = Infinity
  for (const id of ids) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (meta?.articleLimits?.summary && meta.articleLimits.summary < minLimit) {
      minLimit = meta.articleLimits.summary
    }
  }
  return minLimit === Infinity ? 2000 : minLimit
})

// ============ 图片预览缓存 ============
const imageUrlCache = reactive<Record<string, string>>({})

async function loadImagePreview(filePath: string): Promise<string> {
  if (imageUrlCache[filePath]) return imageUrlCache[filePath]
  try {
    const dataUrl = await electronApi.browser.getImageDataUrl(filePath)
    imageUrlCache[filePath] = dataUrl
    return dataUrl
  } catch (e) {
    console.error('[PublishForm] loadImagePreview error', filePath, e)
    return ''
  }
}

function loadAllImagePreviews(files: string[]) {
  files.forEach((f) => {
    if (!imageUrlCache[f]) {
      loadImagePreview(f)
    }
  })
}

// 监听 mediaFiles 变化，自动加载新图片的预览
watch(
  () => mediaFiles.value,
  (newFiles) => {
    loadAllImagePreviews(newFiles)
  },
  { immediate: true }
)

// ============ 文件操作 ============
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'webm', 'm4v', '3gp']

async function pickMediaFiles() {
  try {
    const options: { mode: 'files'; filters?: Electron.FileFilter[] } = { mode: 'files' }
    if (contentType.value === 'image') {
      options.filters = [{ name: '图片文件', extensions: IMAGE_EXTENSIONS }]
    } else if (contentType.value === 'video') {
      options.filters = [{ name: '视频文件', extensions: VIDEO_EXTENSIONS }]
    }
    const r = await electronApi.openFileDialog(options)
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      const exts = contentType.value === 'image' ? IMAGE_EXTENSIONS
        : contentType.value === 'video' ? VIDEO_EXTENSIONS
        : null
      if (exts) {
        const valid = r.filePaths.filter((p) => {
          const ext = p.split('.').pop()?.toLowerCase() || ''
          return exts.includes(ext)
        })
        const invalid = r.filePaths.length - valid.length
        if (invalid > 0) ElMessage.warning(`已过滤 ${invalid} 个不支持的文件格式`)
        if (valid.length === 0) return
        mediaFiles.value = [...mediaFiles.value, ...valid]
        ElMessage.success(`已添加 ${valid.length} 个文件`)
      } else {
        mediaFiles.value = [...mediaFiles.value, ...r.filePaths]
        ElMessage.success(`已添加 ${r.filePaths.length} 个文件`)
      }
      notifyChange()
    }
  } catch (e) {
    console.error('[PublishForm] pickMediaFiles error', e)
    ElMessage.error('选择文件失败')
  }
}

function removeMediaFile(p: string) {
  mediaFiles.value = mediaFiles.value.filter((x) => x !== p)
  delete imageUrlCache[p]
  notifyChange()
}

async function clearMediaFiles() {
  if (mediaFiles.value.length === 0) return
  const ok = await showConfirm('确定要清空所有图片吗？', '确认清空', { confirmButtonText: '确定清空' })
  if (!ok) return
  mediaFiles.value = []
  for (const k of Object.keys(imageUrlCache)) delete imageUrlCache[k]
  notifyChange()
  ElMessage.success('已清空图片')
}

async function pickCover() {
  try {
    const r = await electronApi.openFileDialog({
      mode: 'file',
      filters: [{ name: '图片文件', extensions: IMAGE_EXTENSIONS }],
    })
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      coverImage.value = r.filePaths[0]
      notifyChange()
    }
  } catch (e) {
    console.error('[PublishForm] pickCover error', e)
  }
}

async function pickArticleCover() {
  try {
    const r = await electronApi.openFileDialog({
      mode: 'files',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
    })
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      mediaFiles.value = [...mediaFiles.value, ...r.filePaths]
      ElMessage.success(`已添加 ${r.filePaths.length} 张图片`)
      notifyChange()
    }
  } catch (e) {
    console.error('[PublishForm] pickArticleCover error', e)
    ElMessage.error('选择图片失败')
  }
}

// ============ 提交 ============
async function submitPublish() {
  if (submitting.value) return

  if (!title.value.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  const accountIds = getSelectedIds()
  if (accountIds.length === 0) {
    ElMessage.warning('请至少选择一个账号')
    return
  }
  if (contentType.value !== 'article' && mediaFiles.value.length === 0) {
    ElMessage.warning('请上传素材文件')
    return
  }

  // 文章模式 + 抖音账号：封面必填
  if (contentType.value === 'article' && hasDouyinAccount.value && mediaFiles.value.length === 0) {
    ElMessage.warning('抖音文章发布必须上传封面图片')
    return
  }

  // 文章模式：正文最小字数检查
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
        return
      }
    }
  }

  submitting.value = true

  // 字数限制预检（提醒，不阻塞）
  const tagList = tagsRaw.value
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0)
  const seenTags = new Set<string>()
  const uniqueTags: string[] = []
  for (const t of tagList) {
    const withHash = '#' + t
    if (!seenTags.has(withHash)) {
      seenTags.add(withHash)
      uniqueTags.push(withHash)
    }
  }
  const tagsTotalLen = uniqueTags.length > 0
    ? uniqueTags.join(' ').length + (content.value.trim().length > 0 ? 1 : 0)
    : 0

  const overLimitPlats: Array<{ platform: string; titleLen?: number; contentLen?: number; titleMax?: number; contentMax?: number; tagsLen?: number; totalLen?: number }> = []
  for (const id of accountIds) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (!a) continue
    const meta = accountStore.platforms.find((p) => p.key === a.platform)
    if (!meta) continue
    
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
  }

  // 定时发布
  let scheduledAt: number | undefined = undefined
  if (publishTimeType.value === 'scheduled') {
    if (!scheduledTime.value) {
      ElMessage.warning('请选择定时发布时间')
      submitting.value = false
      return
    }
    if (scheduledTime.value.getTime() <= Date.now()) {
      ElMessage.warning('定时发布时间必须是未来的时间')
      submitting.value = false
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
    summary: summary.value,
    scheduledAt,
  }

  emit('submit', req)
  submitting.value = false
}

// ============ 测试发布（不真的点击发布按钮，仅验证表单填写） ============
async function submitTestPublish() {
  if (submitting.value) return

  if (!title.value.trim()) {
    ElMessage.warning('请输入标题')
    return
  }
  const accountIds = getSelectedIds()
  if (accountIds.length === 0) {
    ElMessage.warning('请至少选择一个账号')
    return
  }
  if (contentType.value !== 'article' && mediaFiles.value.length === 0) {
    ElMessage.warning('请上传素材文件')
    return
  }

  // 文章模式 + 抖音账号：封面必填
  if (contentType.value === 'article' && hasDouyinAccount.value && mediaFiles.value.length === 0) {
    ElMessage.warning('抖音文章发布必须上传封面图片')
    return
  }

  // 文章模式：正文最小字数检查
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
        return
      }
    }
  }

  submitting.value = true

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
    summary: summary.value,
    testMode: true,
  }

  emit('test-submit', req)
  submitting.value = false
}

// ============ 外部方法 ============
/** 用外部数据填充表单（内容提取、草稿加载等场景） */
function fillForm(data: Partial<PublishRequest>) {
  if (data.contentType) contentType.value = data.contentType
  if (data.title !== undefined) title.value = data.title
  if (data.mediaFiles) mediaFiles.value = [...data.mediaFiles]
  if (data.content !== undefined) content.value = data.content
  if (data.summary !== undefined) summary.value = data.summary
  if (data.coverImage) coverImage.value = data.coverImage
  if (data.tags) tagsRaw.value = data.tags.join(' ')
  if (data.accountIds) {
    for (const k of Object.keys(selectedIds)) delete selectedIds[k]
    data.accountIds.forEach((id) => { selectedIds[id] = true })
  }
  notifyChange()
}

/** 获取当前表单数据 */
function getFormData(): Partial<PublishRequest> {
  return {
    contentType: contentType.value,
    title: title.value,
    mediaFiles: [...mediaFiles.value],
    content: content.value,
    summary: summary.value,
    coverImage: coverImage.value,
    tags: tagsRaw.value.split(/[,，\s]+/).map(t => t.trim().replace(/^#/, '')).filter(t => t.length > 0),
    accountIds: getSelectedIds(),
  }
}

/**
 * 在光标位置插入文本，没有光标时追加到末尾
 * @param text 要插入的文本
 * @param addNewLine 是否在插入前添加换行（默认 true）
 */
function insertTextAtCursor(text: string, addNewLine = true): void {
  const inputInstance = contentTextareaRef.value as unknown as { textarea: HTMLTextAreaElement } | null
  const textarea = inputInstance?.textarea
  const currentContent = content.value
  let insertPos = currentContent.length

  if (textarea) {
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    if (start !== undefined && start === end) {
      insertPos = start
    } else if (start !== undefined && end !== undefined) {
      // 有选中文本，替换选中部分
      content.value = currentContent.slice(0, start) + text + currentContent.slice(end)
      nextTick(() => {
        textarea.focus()
        textarea.setSelectionRange(start + text.length, start + text.length)
      })
      notifyChange()
      return
    }
  }

  // 无光标或无选区，追加到末尾
  let prefix = ''
  if (addNewLine && insertPos > 0) {
    const lastChar = currentContent.slice(insertPos - 1, insertPos)
    if (lastChar !== '\n') {
      prefix = '\n\n'
    } else if (insertPos >= 2 && currentContent.slice(insertPos - 2, insertPos - 1) !== '\n') {
      prefix = '\n'
    }
  }

  const insertText = prefix + text
  content.value = currentContent.slice(0, insertPos) + insertText + currentContent.slice(insertPos)

  nextTick(() => {
    if (textarea) {
      textarea.focus()
      const newPos = insertPos + insertText.length
      textarea.setSelectionRange(newPos, newPos)
    }
  })
  notifyChange()
}

/**
 * 添加图片到媒体列表（不覆盖已有图片）
 */
function addImages(imagePaths: string[]): void {
  if (!imagePaths || imagePaths.length === 0) return
  const existing = new Set(mediaFiles.value)
  const added: string[] = []
  for (const p of imagePaths) {
    if (!existing.has(p)) {
      existing.add(p)
      added.push(p)
    }
  }
  if (added.length > 0) {
    mediaFiles.value = [...mediaFiles.value, ...added]
    notifyChange()
  }
}

/**
 * 插入图片占位文本（在光标处插入 [图片] 标记）
 */
function insertImagePlaceholder(count: number): void {
  if (count <= 0) return
  const placeholder = '[图片]'.repeat(count)
  insertTextAtCursor(placeholder, true)
}

/** 清空标题、内容、话题（②区域的清空按钮） */
async function clearContentSection() {
  if (!title.value && !content.value && !summary.value && !tagsRaw.value) return
  const ok = await showConfirm('确定要清空标题、正文、摘要和话题吗？', '确认清空', { confirmButtonText: '确定清空' })
  if (!ok) return
  title.value = ''
  content.value = ''
  summary.value = ''
  tagsRaw.value = ''
  notifyChange()
  ElMessage.success('已清空内容')
}

/** 清空整个表单 */
async function clearForm() {
  const ok = await showConfirm('确定要清空所有表单内容吗？包括标题、内容、素材、账号选择等。', '确认清空', { confirmButtonText: '确定清空' })
  if (!ok) return
  title.value = ''
  content.value = ''
  summary.value = ''
  mediaFiles.value = []
  coverImage.value = ''
  tagsRaw.value = ''
  for (const k of Object.keys(imageUrlCache)) delete imageUrlCache[k]
  for (const k of Object.keys(selectedIds)) delete selectedIds[k]
  publishTimeType.value = 'now'
  scheduledTime.value = null
  publishFilterCategoryId.value = ''
  notifyChange()
  ElMessage.success('已清空表单')
}

defineExpose({ fillForm, getFormData, insertTextAtCursor, addImages, insertImagePlaceholder })

// ============ 工具函数 ============
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
</script>

<template>
  <div class="publish-form">
    <div class="panel">
      <h2 class="section-title">① 选择发布类型</h2>
      <div class="publish-type-selector">
        <div 
          class="type-card video-card" 
          :class="{ active: contentType === 'video' }" 
          @click="contentType = 'video'; notifyChange();"
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
          @click="contentType = 'image'; notifyChange();"
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
          @click="contentType = 'article'; notifyChange();"
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

      <div class="section-header">
        <h2 class="section-title">② 标题与内容</h2>
        <el-button size="small" class="clear-content-btn" @click="clearContentSection">🧹 清空内容</el-button>
      </div>
      <el-form label-width="80px" label-position="right">
        <el-form-item label="标题" class="form-item-title">
          <el-input
            v-model="title"
            :placeholder="titlePlaceholder"
            :maxlength="titleMaxLength"
            show-word-limit
            @input="notifyChange"
          />
        </el-form-item>

        <el-form-item v-if="contentType !== 'article'" label="素材" class="form-item-media">
          <el-button @click="pickMediaFiles">选择文件</el-button>
          <span v-if="mediaFiles.length > 0" style="margin-left:8px; color:#909399; font-size:12px;">
            已选择 {{ mediaFiles.length }} 个文件
          </span>
          <span v-else style="margin-left:8px; color:#909399; font-size:12px;">
            {{ contentType === 'video' ? '（支持 mp4, mov, avi, mkv, flv, webm 等视频格式）' : '（支持 jpg, jpeg, png, webp, gif, bmp 等图片格式）' }}
          </span>
          <div class="file-list" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="file-item">
              <span class="file-name">{{ f }}</span>
              <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
            </div>
          </div>
        </el-form-item>

        <!-- 文章模式：封面图片上传 -->
        <el-form-item v-if="contentType === 'article'" label="封面" class="form-item-cover">
          <div class="article-cover-actions">
            <el-button @click="pickArticleCover">选择封面图片</el-button>
            <el-button
              v-if="mediaFiles.length > 0"
              type="danger"
              plain
              size="small"
              @click="clearMediaFiles"
            >清空图片</el-button>
            <span v-if="mediaFiles.length > 0" style="color:#909399; font-size:12px;">
              已选择 {{ mediaFiles.length }} 张图片（第 1 张作为封面）
            </span>
            <span v-else style="color:#909399; font-size:12px; margin-left:8px;">
              （支持 jpg, jpeg, png, webp 等图片格式，首图将自动被设为封面）
            </span>
          </div>
          <div class="article-cover-hint" v-if="hasDouyinAccount">
            <span style="color:#F56C6C;">⚠️ 已选抖音账号：封面为必填项</span>
          </div>
          <div class="image-grid" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="image-item">
              <div class="image-thumb">
                <img v-if="imageUrlCache[f]" :src="imageUrlCache[f]" :alt="'图片' + (idx + 1)" />
                <div v-else class="image-loading">加载中...</div>
                <div v-if="idx === 0" class="cover-badge">封面</div>
              </div>
              <div class="image-actions">
                <span class="image-index">{{ idx + 1 }}</span>
                <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-form-item v-if="contentType === 'video'" label="封面" class="form-item-cover">
          <el-button @click="pickCover">选择封面</el-button>
          <span v-if="coverImage" style="margin-left:8px; color:#909399; font-size:12px;">{{ coverImage }}</span>
          <span v-else style="margin-left:8px; color:#909399; font-size:12px;">（可选，支持 jpg, jpeg, png, webp 等图片格式）</span>
        </el-form-item>

        <el-form-item label="描述" class="form-item-desc">
          <el-input
            ref="contentTextareaRef"
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
            @input="notifyChange"
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

        <!-- 文章模式：文章摘要 -->
        <el-form-item v-if="contentType === 'article'" label="摘要" class="form-item-summary">
          <el-input
            v-model="summary"
            type="textarea"
            :rows="2"
            placeholder="可选：文章摘要/简介，将显示在文章列表或分享卡片中（抖音300字/小红书1000字）"
            :maxlength="articleSummaryMaxLength"
            show-word-limit
            @input="notifyChange"
          />
        </el-form-item>

        <el-form-item label="话题" class="form-item-tags">
          <el-input v-model="tagsRaw" placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活" @input="notifyChange" />
        </el-form-item>
      </el-form>

      <el-divider />

      <div class="section-header">
        <h2 class="section-title">③ 选择发布账号</h2>
        <div class="category-filter">
          <span class="filter-label">分类：</span>
          <el-select v-model="publishFilterCategoryId" placeholder="全部分类" clearable style="width: 120px" size="small">
            <el-option label="全部分类" value="" />
            <el-option label="未分类" value="unclassified" />
            <el-option v-for="cat in accountStore.categories" :key="cat.id" :label="cat.name" :value="cat.id" />
          </el-select>
        </div>
      </div>

      <div class="account-actions">
        <div class="left-actions">
          <el-button size="small" class="action-btn" @click="selectAll">全选可见</el-button>
          <el-button size="small" class="action-btn" @click="clearSelection">清空</el-button>
        </div>
        <div class="right-info">
          <span class="selection-hint">已选 <strong class="highlight">{{ getSelectedIds().length }}</strong> / {{ visibleAccounts.length }}</span>
        </div>
      </div>

      <div v-if="visibleAccounts.length === 0" class="empty">
        <el-empty :image-size="80" description="没有可用账号，请先在账号管理授权" />
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
          <el-radio-group v-model="publishTimeType" size="default" @change="notifyChange">
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
    </div>

    <div class="form-footer">
      <div class="submit-row">
        <el-button type="primary" :loading="submitting" :disabled="submitting || visibleAccounts.length === 0" @click="submitPublish">
          {{ submitText || (publishTimeType === 'scheduled' ? '定时发布到' : '一键发布到') + ' ' + getSelectedIds().length + ' 个账号' }}
        </el-button>
        <el-button type="warning" :loading="submitting" :disabled="submitting || visibleAccounts.length === 0" @click="submitTestPublish">
          发布测试
        </el-button>
        <el-button :disabled="submitting" @click="clearForm">清空</el-button>
        <slot name="footer-extra"></slot>
      </div>
    </div>
  </div>
</template>

<style scoped>
.publish-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  gap: 10px;
}

.panel {
  background: var(--glass-bg, #ffffff);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: var(--glass-border, 1px solid rgba(0, 0, 0, 0.05));
  border-radius: 16px;
  padding: 24px;
  box-shadow: var(--glow-shadow-sm, 0 4px 20px -2px rgba(0, 0, 0, 0.04));
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.section-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 16px 0;
  color: #0f172a;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header .section-title {
  margin: 0;
}

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
  padding: 14px 18px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.type-card:not(.active):hover {
  transform: translateY(-2px);
  border-color: rgba(99, 102, 241, 0.15);
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 8px 16px rgba(99, 102, 241, 0.04);
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

.type-desc {
  font-size: 11px;
  color: #94a3b8;
}

/* 封面与素材图片预览 */
.article-cover-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.image-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.image-thumb {
  position: relative;
  width: 100%;
  padding-top: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: #f1f5f9;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.02);
}

.image-thumb img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-loading {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #64748b;
  background: #f1f5f9;
}

.cover-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: #6366f1;
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 700;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
}

.image-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.image-index {
  color: #64748b;
  font-size: 11px;
  font-weight: 500;
}

.file-list {
  margin-top: 12px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 10px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.5);
  box-sizing: border-box;
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
}

.category-filter {
  display: flex;
  align-items: center;
  gap: 6px;
}

.category-filter .filter-label {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
}

.account-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 14px;
  margin-bottom: 12px;
}

.left-actions {
  display: flex;
  gap: 8px;
}

.left-actions .action-btn {
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  height: 24px;
  border-color: rgba(15, 23, 42, 0.08);
  background: #ffffff;
  color: #475569;
  transition: all 0.25s ease;
}

.left-actions .action-btn:hover {
  border-color: #6366f1;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}

.right-info {
  display: flex;
  align-items: center;
}

.selection-hint {
  font-size: 11px;
  color: #64748b;
  font-weight: 600;
}

.selection-hint .highlight {
  color: #6366f1;
  font-weight: 700;
}

/* 账号选择网格与卡片 */
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
  margin-top: 12px;
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
  box-shadow: var(--glow-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.04));
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
  box-shadow: 0 10px 20px -10px rgba(99, 102, 241, 0.15), var(--glow-shadow-md, 0 4px 12px rgba(99, 102, 241, 0.08));
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

.selected-mark {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #6366f1;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 800;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}

.form-footer {
  flex-shrink: 0;
  padding: 16px 20px;
  border: 1px solid rgba(15, 23, 42, 0.05);
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: 14px;
  display: flex;
  justify-content: center;
  box-shadow: 0 10px 30px -10px rgba(99, 102, 241, 0.08), 0 4px 12px -4px rgba(0, 0, 0, 0.03);
  margin: 0px 0 16px 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.submit-row {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
  width: 100%;
  flex-wrap: wrap;
}

/* 按钮样式微调，让它们在排在一起时更精致 */
.submit-row :deep(.el-button) {
  border-radius: 10px;
  font-weight: 600;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 10px 18px;
  height: auto;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.submit-row :deep(.el-button--primary) {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
  border: none;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);
}
.submit-row :deep(.el-button--primary:hover) {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
}

.submit-row :deep(.el-button--warning) {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  border: none;
  box-shadow: 0 4px 14px rgba(245, 158, 11, 0.25);
  color: #ffffff;
}
.submit-row :deep(.el-button--warning:hover) {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(245, 158, 11, 0.4);
}

@media (max-width: 768px) {
  .form-footer {
    padding: 12px 16px;
    margin: 0px 0 12px 0;
    border-radius: 12px;
  }
  .submit-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 100%;
  }
  /* 让发布主按钮独占一行，显得重点突出 */
  .submit-row :deep(.el-button:first-child) {
    grid-column: span 2;
    padding: 12px;
    font-size: 14px;
  }
  .submit-row :deep(.el-button) {
    width: 100%;
    margin: 0 !important;
    padding: 10px;
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .submit-row {
    grid-template-columns: 1fr;
  }
  .submit-row :deep(.el-button:first-child) {
    grid-column: span 1;
  }
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

.empty {
  padding: 10px 0;
}
.empty :deep(.el-empty) {
  padding: 10px 0;
}
.empty :deep(.el-empty__description p) {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 500;
}

.clear-content-btn {
  border: 1px solid rgba(239, 68, 68, 0.15) !important;
  background: rgba(239, 68, 68, 0.04) !important;
  color: #ef4444 !important;
  font-weight: 700;
  font-size: 11px;
  border-radius: 6px;
  padding: 4px 10px;
  height: 24px;
  transition: all 0.25s ease;
}

.clear-content-btn:hover {
  background: #ef4444 !important;
  color: #ffffff !important;
  border-color: #ef4444 !important;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
}

/* ======== 表单标题与配置内容全线高级感美化 ======== */
:deep(.el-form-item) {
  margin-bottom: 24px !important;
}

/* 美化 Element Plus Label 宽度和右对齐 */
:deep(.el-form-item__label) {
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #334155 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: flex-end !important;
  padding-right: 12px !important;
  box-sizing: border-box !important;
}

/* 仅在特定配置项的 label 上改为左对齐，并置为 inline-flex 布局，文字与图标居中 */
:deep(.form-item-title .el-form-item__label),
:deep(.form-item-media .el-form-item__label),
:deep(.form-item-cover .el-form-item__label),
:deep(.form-item-desc .el-form-item__label),
:deep(.form-item-summary .el-form-item__label),
:deep(.form-item-tags .el-form-item__label) {
  padding-left: 0 !important;
  padding-right: 0 !important;
  justify-content: flex-start !important;
  display: inline-flex !important;
  align-items: center !important; /* 强制图标与文字 100% 垂直中线咬合 */
  height: auto !important;
  line-height: normal !important;
}

/* 统一的圆角矩形小图标，作为 Label 内不脱离文档流的常规 flex 元素排布，天然完美垂直居中 */
:deep(.form-item-title .el-form-item__label)::before,
:deep(.form-item-media .el-form-item__label)::before,
:deep(.form-item-cover .el-form-item__label)::before,
:deep(.form-item-desc .el-form-item__label)::before,
:deep(.form-item-summary .el-form-item__label)::before,
:deep(.form-item-tags .el-form-item__label)::before {
  content: '';
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  margin-right: 8px; /* 直接通过右外边距拉开 8px 与字体的间距 */
  font-size: 13px;
  font-weight: 900;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
  transition: all 0.25s ease;
  flex-shrink: 0;
}

/* 精准为不同类目渲染底色和图标 */
:deep(.form-item-title .el-form-item__label)::before {
  content: 'T';
  background: rgba(99, 102, 241, 0.07);
  color: #6366f1;
  border: 1px solid rgba(99, 102, 241, 0.1);
}

:deep(.form-item-media .el-form-item__label)::before {
  content: '📁';
  background: rgba(56, 189, 248, 0.07);
  color: #0ea5e9;
  border: 1px solid rgba(56, 189, 248, 0.1);
  font-size: 11px;
}

:deep(.form-item-cover .el-form-item__label)::before {
  content: '🖼️';
  background: rgba(16, 185, 129, 0.07);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.1);
  font-size: 11px;
}

:deep(.form-item-desc .el-form-item__label)::before {
  content: '📝';
  background: rgba(245, 158, 11, 0.07);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.1);
  font-size: 11px;
}

:deep(.form-item-tags .el-form-item__label)::before {
  content: '#';
  background: rgba(139, 92, 246, 0.07);
  color: #8b5cf6;
  border: 1px solid rgba(139, 92, 246, 0.1);
  font-size: 13px;
}

:deep(.form-item-summary .el-form-item__label)::before {
  content: '📄';
  background: rgba(100, 116, 139, 0.07);
  color: #64748b;
  border: 1px solid rgba(100, 116, 139, 0.1);
  font-size: 11px;
}

/* 升级输入框圆角与微光聚焦特效 */
:deep(.el-input__wrapper),
:deep(.el-textarea__inner) {
  border-radius: 10px !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04) inset !important;
  border: none !important;
  padding: 8px 14px !important;
  background: #ffffff !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

:deep(.el-input__wrapper:hover),
:deep(.el-textarea__inner:hover) {
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.2) inset !important;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-textarea__inner:focus) {
  box-shadow: 0 0 0 1px #6366f1 inset, 0 0 0 4px rgba(99, 102, 241, 0.12) !important;
}

/* 计数器精美扁平化 */
:deep(.el-input__count) {
  font-size: 10px !important;
  color: #94a3b8 !important;
  font-weight: 700 !important;
  background: transparent !important;
  bottom: 6px !important;
}

/* 全新胶囊上传选择按钮（微熏蓝紫） */
:deep(.el-form-item__content .el-button) {
  border-radius: 20px !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  padding: 8px 16px !important;
  height: auto !important;
  border: 1px solid rgba(99, 102, 241, 0.15) !important;
  background: rgba(99, 102, 241, 0.03) !important;
  color: #6366f1 !important;
  transition: all 0.25s ease !important;
}

:deep(.el-form-item__content .el-button:hover) {
  background: #6366f1 !important;
  color: #ffffff !important;
  border-color: #6366f1 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2) !important;
}

/* 红色警告/清除按钮 */
:deep(.el-form-item__content .el-button--danger) {
  border: 1px solid rgba(239, 68, 68, 0.15) !important;
  background: rgba(239, 68, 68, 0.04) !important;
  color: #ef4444 !important;
}

:deep(.el-form-item__content .el-button--danger:hover) {
  background: #ef4444 !important;
  color: #ffffff !important;
  border-color: #ef4444 !important;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2) !important;
}
</style>
