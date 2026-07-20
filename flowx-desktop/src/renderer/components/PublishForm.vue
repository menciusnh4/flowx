<script setup lang="ts">
import { ref, computed, reactive, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElInput, ElImageViewer } from 'element-plus'
import { useAccountStore } from '../stores/account'
import { electronApi } from '../utils/electron'
import type { PublishRequest, PlatformType } from '../../types'
import MarkdownEditor from './MarkdownEditor.vue'

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

// ============ 内嵌确认框（避免 BrowserView 遮挡和闪白） ============
const confirmVisible = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmButtonText = ref('确定')
const confirmCancelText = ref('取消')
let confirmResolver: ((value: boolean) => void) | null = null

function showConfirm(message: string, title: string, options?: Record<string, unknown>): Promise<boolean> {
  confirmMessage.value = message
  confirmTitle.value = title
  confirmButtonText.value = (options?.confirmButtonText as string) || '确定'
  confirmCancelText.value = (options?.cancelButtonText as string) || '取消'
  confirmVisible.value = true
  return new Promise<boolean>((resolve) => {
    confirmResolver = resolve
  })
}

function handleConfirmOk() {
  confirmVisible.value = false
  if (confirmResolver) {
    confirmResolver(true)
    confirmResolver = null
  }
}

function handleConfirmCancel() {
  confirmVisible.value = false
  if (confirmResolver) {
    confirmResolver(false)
    confirmResolver = null
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

// ============ Markdown 编辑器 ============
const contentMode = ref<'text' | 'markdown'>(props.initialValue?.contentMode || 'text')
const markdownContent = ref(props.initialValue?.markdownContent || '')

// 监听表单变化，向外通知
function notifyChange() {
  emit('change', {
    contentType: contentType.value,
    title: title.value,
    mediaFiles: mediaFiles.value,
    content: content.value,
    markdownContent: markdownContent.value,
    contentMode: contentMode.value,
    summary: summary.value,
    coverImage: coverImage.value,
    tags: tagsRaw.value.split(/[,，\s]+/).map(t => t.trim().replace(/^#/, '')).filter(t => t.length > 0),
  })
}

// 切换正文模式（纯文本 / Markdown）
async function onContentModeChange(newMode: string | number | boolean | undefined) {
  const mode = newMode as 'text' | 'markdown';
  if (mode === 'markdown') {
    // 从纯文本切到 Markdown：将当前内容迁移到 Markdown 编辑器
    if (content.value && !markdownContent.value) {
      markdownContent.value = content.value
    }
  } else {
    // 从 Markdown 切到纯文本：去除 Markdown 标记后回填
    if (markdownContent.value) {
      let plainText = markdownContent.value
      // 去除标题标记
      plainText = plainText.replace(/^#{1,6}\s+/gm, '')
      // 去除粗体/斜体标记
      plainText = plainText.replace(/\*\*([^*]+)\*\*/g, '$1')
      plainText = plainText.replace(/\*([^*]+)\*/g, '$1')
      // 去除高亮标记
      plainText = plainText.replace(/==([^=]+)==/g, '$1')
      // 去除引用标记
      plainText = plainText.replace(/^>\s?/gm, '')
      // 去除列表标记
      plainText = plainText.replace(/^[-*+]\s+/gm, '')
      plainText = plainText.replace(/^\d+\.\s+/gm, '')
      // 图片语法转文字
      plainText = plainText.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      content.value = plainText.trim()
    }
  }
  notifyChange()
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

const isContentOverLimit = computed(() => contentEffectiveLength.value > platformContentLimit.value.min)

// 正文字符数（文章模式排除换行符，图文/视频正常计数；Markdown 模式去除标记符号）
const contentEffectiveLength = computed(() => {
  if (contentType.value === 'article') {
    // 文章发布
    if (contentMode.value === 'markdown') {
      // Markdown 模式：去除 Markdown 标记和换行符
      let text = markdownContent.value
      // 去除图片语法
      text = text.replace(/!\[.*?\]\(.*?\)/g, '')
      // 去除标题标记
      text = text.replace(/^#{1,6}\s+/gm, '')
      // 去除粗体/斜体标记
      text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
      text = text.replace(/\*([^*]+)\*/g, '$1')
      text = text.replace(/__([^_]+)__/g, '$1')
      text = text.replace(/_([^_]+)_/g, '$1')
      // 去除高亮标记
      text = text.replace(/==([^=]+)==/g, '$1')
      // 去除引用标记
      text = text.replace(/^>\s?/gm, '')
      // 去除列表标记
      text = text.replace(/^[-*+]\s+/gm, '')
      text = text.replace(/^\d+\.\s+/gm, '')
      // 去除换行符
      text = text.replace(/[\n\r]/g, '')
      return text.length
    }
    // 纯文本模式：换行符不计入字数
    return content.value.replace(/[\n\r]/g, '').length
  }
  // 图文/视频：正常计数
  return content.value.length
})

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
  const total = contentEffectiveLength.value + tagsLength.value
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
  return `📝 ${parts.join('，')}（当前 ${contentEffectiveLength.value} 字，换行符不计）`
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

// ============ 图片大图预览 ============
const imageViewerVisible = ref(false)
const imageViewerUrlList = ref<string[]>([])
const imageViewerInitialIndex = ref(0)

function previewImage(filePath: string) {
  const urls = mediaFiles.value
    .filter(f => imageUrlCache[f])
    .map(f => imageUrlCache[f])
  const idx = mediaFiles.value.indexOf(filePath)
  imageViewerUrlList.value = urls.length > 0 ? urls : [imageUrlCache[filePath] || filePath]
  imageViewerInitialIndex.value = idx >= 0 ? idx : 0
  imageViewerVisible.value = true
}

function closeImageViewer() {
  imageViewerVisible.value = false
}

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
      if (typeof minContent === 'number' && contentEffectiveLength.value < minContent) {
        const platformDisplayName = platformName(a.platform)
        ElMessage.warning(`${platformDisplayName}文章正文至少需要 ${minContent} 字（当前 ${contentEffectiveLength.value} 字）`)
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
      // 文章发布：使用有效字符数（已排除换行符和 Markdown 标记）
      const contentLen = contentEffectiveLength.value
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
    markdownContent: contentType.value === 'article' && contentMode.value === 'markdown' ? markdownContent.value : undefined,
    contentMode: contentType.value === 'article' ? contentMode.value : undefined,
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
      if (typeof minContent === 'number' && contentEffectiveLength.value < minContent) {
        const platformDisplayName = platformName(a.platform)
        ElMessage.warning(`${platformDisplayName}文章正文至少需要 ${minContent} 字（当前 ${contentEffectiveLength.value} 字）`)
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
    markdownContent: contentType.value === 'article' && contentMode.value === 'markdown' ? markdownContent.value : undefined,
    contentMode: contentType.value === 'article' ? contentMode.value : undefined,
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
  if (data.contentMode) contentMode.value = data.contentMode
  if (data.markdownContent !== undefined) markdownContent.value = data.markdownContent
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
    markdownContent: contentType.value === 'article' && contentMode.value === 'markdown' ? markdownContent.value : undefined,
    contentMode: contentType.value === 'article' ? contentMode.value : undefined,
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
      <el-radio-group v-model="contentType" size="default" @change="notifyChange">
        <el-radio-button value="video">视频</el-radio-button>
        <el-radio-button value="image">图文</el-radio-button>
        <el-radio-button value="article">文章</el-radio-button>
      </el-radio-group>
      <el-divider />

      <div class="section-header">
        <h2 class="section-title">② 标题与内容</h2>
        <el-button size="small" text type="danger" @click="clearContentSection">清空内容</el-button>
      </div>
      <el-form label-width="80px" label-position="right">
        <el-form-item label="标题">
          <el-input
            v-model="title"
            :placeholder="titlePlaceholder"
            :maxlength="titleMaxLength"
            show-word-limit
            @input="notifyChange"
          />
        </el-form-item>

        <el-form-item v-if="contentType === 'image'" label="素材">
          <div class="image-upload-actions">
            <el-button @click="pickMediaFiles">选择图片</el-button>
            <el-button
              v-if="mediaFiles.length > 0"
              type="danger"
              plain
              size="small"
              @click="clearMediaFiles"
            >清空图片</el-button>
            <span v-if="mediaFiles.length > 0" style="color:#909399; font-size:12px;">
              已选择 {{ mediaFiles.length }} 张图片
            </span>
          </div>
          <div class="image-grid" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="image-item" @click="previewImage(f)">
              <div class="image-thumb">
                <img v-if="imageUrlCache[f]" :src="imageUrlCache[f]" :alt="'图片' + (idx + 1)" />
                <div v-else class="image-loading">加载中...</div>
              </div>
              <div class="image-actions">
                <span class="image-index">{{ idx + 1 }}</span>
                <el-button size="small" type="danger" link @click.stop="removeMediaFile(f)">删除</el-button>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-form-item v-if="contentType === 'video'" label="素材">
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

        <!-- 文章模式：封面图片上传 -->
        <el-form-item v-if="contentType === 'article'" label="封面">
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
          </div>
          <div class="article-cover-hint" v-if="hasDouyinAccount">
            <span style="color:#F56C6C;">⚠️ 已选抖音账号：封面为必填项</span>
          </div>
          <div class="image-grid" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="image-item" @click="previewImage(f)">
              <div class="image-thumb">
                <img v-if="imageUrlCache[f]" :src="imageUrlCache[f]" :alt="'图片' + (idx + 1)" />
                <div v-else class="image-loading">加载中...</div>
                <div v-if="idx === 0" class="cover-badge">封面</div>
              </div>
              <div class="image-actions">
                <span class="image-index">{{ idx + 1 }}</span>
                <el-button size="small" type="danger" link @click.stop="removeMediaFile(f)">删除</el-button>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-form-item v-if="contentType === 'video'" label="封面">
          <el-button @click="pickCover">选择封面</el-button>
          <span v-if="coverImage" style="margin-left:8px; color:#909399; font-size:12px;">{{ coverImage }}</span>
        </el-form-item>

        <el-form-item label="描述">
          <!-- 文章模式：正文模式切换 -->
          <div v-if="contentType === 'article'" class="content-mode-switch">
            <el-radio-group v-model="contentMode" size="small" @change="onContentModeChange">
              <el-radio-button value="text">纯文本</el-radio-button>
              <el-radio-button value="markdown">Markdown</el-radio-button>
            </el-radio-group>
            <span v-if="contentMode === 'markdown'" class="mode-hint">
              💡 Markdown 模式将生成 .md 文件通过平台文档导入功能上传发布
            </span>
          </div>

          <!-- 纯文本模式 -->
          <el-input
            v-if="contentType !== 'article' || contentMode === 'text'"
            ref="contentTextareaRef"
            v-model="content"
            type="textarea"
            :rows="contentType === 'article' ? 8 : 4"
            :placeholder="contentType === 'article'
              ? '请输入文章正文（抖音：最多8000字；小红书：最多10000字；换行符不计入字数）'
              : contentType === 'image'
                ? '可选：为图文添加描述文案（将作为笔记正文发布，小红书 1000 字/抖音 1000 字/快手 500 字）'
                : '可选：为视频添加描述文案（快手最多 500 字）'"
            :maxlength="platformContentLimit.min"
            show-word-limit
            @input="notifyChange"
          />

          <!-- Markdown 模式（仅文章） -->
          <MarkdownEditor
            v-else
            v-model="markdownContent"
            :max-length="platformContentLimit.min"
            :height="380"
            placeholder="在此输入 Markdown 内容...支持标题、粗体、列表、引用、代码块等"
            @input="notifyChange"
          />

          <div v-if="kuaishouSelected" class="kuaishou-hint">
            ⚡ 已选快手账号：正文将被限制为 500 字，超出部分将自动截断
          </div>
          <div v-if="isContentWithTagsOverLimit" class="over-limit-hint">
            ⚠️ 正文+话题共 {{ contentEffectiveLength + tagsLength }} 字，超出所选平台最大限制（{{ platformContentLimit.min }} 字），发布后可能被截断
            <span v-if="contentType === 'article'">（换行符不计入字数）</span>
          </div>
          <div v-else-if="isContentOverLimit" class="over-limit-hint">
            ⚠️ 当前内容（{{ contentEffectiveLength }} 字）超出所选平台最大限制（{{ platformContentLimit.min }} 字），超出部分将在发布时自动截断
            <span v-if="contentType === 'article'">（换行符不计入字数）</span>
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
        <el-form-item v-if="contentType === 'article'" label="摘要">
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

        <el-form-item label="话题">
          <el-input v-model="tagsRaw" placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活" @input="notifyChange" />
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
                if (typeof t === 'number' && typeof c === 'number') return `标题${t}字 / 正文${c}字（换行不计）`;
                if (typeof t === 'number') return `标题${t}字 / 正文不限`;
                if (typeof c === 'number') return `正文最多 ${c} 字（换行不计）`;
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
          🔍 发布测试
        </el-button>
        <el-button :disabled="submitting" @click="clearForm">清空</el-button>
        <slot name="footer-extra"></slot>
      </div>
    </div>

    <!-- 内嵌确认框 -->
    <div v-if="confirmVisible" class="confirm-mask" @click.self="handleConfirmCancel">
      <div class="confirm-box">
        <div class="confirm-header">
          <el-icon color="#e6a23c" size="22px"><Warning /></el-icon>
          <span class="confirm-title">{{ confirmTitle }}</span>
        </div>
        <div class="confirm-body">
          {{ confirmMessage }}
        </div>
        <div class="confirm-footer">
          <el-button size="small" @click="handleConfirmCancel">{{ confirmCancelText }}</el-button>
          <el-button size="small" type="warning" @click="handleConfirmOk">{{ confirmButtonText }}</el-button>
        </div>
      </div>
    </div>
  </div>

  <!-- 图片大图预览 -->
  <el-image-viewer
    v-if="imageViewerVisible"
    :url-list="imageViewerUrlList"
    :initial-index="imageViewerInitialIndex"
    @close="closeImageViewer"
  />
</template>

<style scoped>
.publish-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.panel {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #303133;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.section-header .section-title {
  margin: 0;
}
.article-cover-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.image-upload-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.image-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.image-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 80px;
  cursor: zoom-in;
  flex-shrink: 0;
}
.image-thumb {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 4px;
  overflow: hidden;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  transition: border-color 0.15s;
}
.image-item:hover .image-thumb {
  border-color: #409eff;
}
.image-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  color: #909399;
  background: #f5f7fa;
}
.cover-badge {
  position: absolute;
  top: 4px;
  left: 4px;
  background: #409eff;
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  font-weight: 500;
  line-height: 1.4;
}
.image-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
}
.image-index {
  color: #909399;
  font-size: 10px;
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
.form-footer {
  flex-shrink: 0;
  padding: 12px 20px;
  border-top: 1px solid #e4e7ed;
  background: #fff;
  display: flex;
  justify-content: center;
}

/* 字数限制提示 */
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
/* Markdown 模式切换 */
.content-mode-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.mode-hint {
  font-size: 12px;
  color: #909399;
}
.empty { padding: 20px 0; }

/* ========== 内嵌确认框 ========== */
.confirm-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.confirm-box {
  width: 360px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.confirm-body {
  padding: 20px;
  font-size: 14px;
  color: #606266;
  line-height: 1.6;
}

.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
}
</style>
