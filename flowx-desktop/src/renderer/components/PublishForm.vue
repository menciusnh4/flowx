<script setup lang="ts">
import { ref, computed, reactive, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox, ElInput } from 'element-plus'
import { useAccountStore } from '../stores/account'
import { getPlatformIcon } from '../utils/platformIcons'
import { electronApi } from '../utils/electron'
import type { PublishRequest, PlatformType } from '../../types'
import { useCompliance } from '../composables/useCompliance'
import ComplianceBadge from './ComplianceBadge.vue'
import ComplianceDetailPanel from './ComplianceDetailPanel.vue'
import ComplianceNoticeModal from './ComplianceNoticeModal.vue'
import type { ComplianceSettings } from '../../types/compliance'
import MarkdownEditor from './MarkdownEditor.vue'

const props = defineProps<{
  /** 表单初始值（用于草稿加载、内容提取预填充等） */
  initialValue?: Partial<PublishRequest>
  /** 是否显示发布按钮（浏览器页内嵌时可能隐藏，改为"保存草稿"） */
  showSubmit?: boolean
  /** 提交按钮文本 */
  submitText?: string
  /**
   * 内容类型由父级（路由）控制时传入。
   * 传入后隐藏页面内分段 Tab，类型完全由该 prop 决定。
   * 不传则保持旧行为：页面内显示 视频/图文/文章 切换。
   */
  contentType?: 'video' | 'image' | 'article'
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
const contentType = ref<'video' | 'image' | 'article'>(props.contentType || props.initialValue?.contentType || 'video')
/** 是否由路由/父级控制内容类型（隐藏页面内 Tab） */
const controlled = computed(() => !!props.contentType)
/** 当前类型对应的展示信息（用于受控模式下的类型徽标） */
const typeMeta = computed(() => {
  const map: Record<string, { icon: string; label: string }> = {
    video: { icon: '🎬', label: '发布视频' },
    image: { icon: '🖼️', label: '发布图文' },
    article: { icon: '📄', label: '发布文章' },
  }
  return map[contentType.value] || map.video
})
const title = ref(props.initialValue?.title || '')
const mediaFiles = ref<string[]>(props.initialValue?.mediaFiles || [])
const content = ref(props.initialValue?.content || '')
const summary = ref(props.initialValue?.summary || '')
const coverImage = ref(props.initialValue?.coverImage || '')
const tagsRaw = ref((props.initialValue?.tags || []).join(' '))
const submitting = ref(false)
const contentTextareaRef = ref<InstanceType<typeof ElInput> | null>(null)

// ===== P0 发布合规预检（仅提示，不阻断） =====
const titleInputRef = ref<InstanceType<typeof ElInput> | null>(null)
const tagsInputRef = ref<InstanceType<typeof ElInput> | null>(null)
const summaryTextareaRef = ref<InstanceType<typeof ElInput> | null>(null)
const promptOn = ref(true)
const complianceSettings = ref<ComplianceSettings>({ promptEnabled: true })
const noticeRef = ref<InstanceType<typeof ComplianceNoticeModal> | null>(null)

// 选择的账号 ID（提前到 useCompliance 之前声明，避免 platforms() 在 setup 阶段读取 selectedIds 触发 TDZ）
const selectedIds = reactive<Record<string, boolean>>({})

const compliance = useCompliance({
  fields: () => ({
    title: title.value,
    content: content.value,
    tags: tagsRaw.value.split(/[,，\s]+/).map((t) => t.trim().replace(/^#/, '')).filter((t) => t.length > 0),
    summary: summary.value,
  }),
  platforms: () => {
    const set = new Set<string>()
    for (const id of getSelectedIds()) {
      const a = accountStore.accounts.find((x) => x.id === id)
      if (a) set.add(a.platform)
    }
    return [...set]
  },
  enabled: () => complianceSettings.value.promptEnabled,
})

/** 聚焦某字段（点击角标 / 面板命中时调用） */
function locateField(field: string) {
  nextTick(() => {
    if (field === 'title') titleInputRef.value?.focus()
    else if (field === 'content') contentTextareaRef.value?.focus()
    else if (field === 'tags') tagsInputRef.value?.focus()
    else if (field === 'summary') summaryTextareaRef.value?.focus()
  })
}

/** 提示开关切换（关闭需二次确认防误关） */
async function onPromptToggle(val: boolean) {
  if (!val) {
    const ok = await showConfirm('关闭后不再提示违禁词，可能增加账号处罚风险。确定关闭？', '关闭合规提示')
    if (!ok) { promptOn.value = true; return }
  }
  complianceSettings.value = await electronApi.compliance.setSettings({ promptEnabled: val })
  promptOn.value = val
}

/** 合规状态条副标题用的平台名（对齐原型 compliance-prototype.html） */
const PLAT_CN: Record<string, string> = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', bilibili: '哔哩哔哩',
  wechat_channels: '微信视频号', video: '视频号', zhihu: '知乎', toutiao: '今日头条',
}
const compliancePlatformLabel = computed(() => {
  const set = new Set<string>()
  for (const id of getSelectedIds()) {
    const a = accountStore.accounts.find((x) => x.id === id)
    if (a) set.add(a.platform)
  }
  const list = [...set].map((p) => PLAT_CN[p] || p)
  return list.length ? list.join(' / ') : '未选择账号'
})

// ============ Markdown 编辑器（origin/main 新增） ============
const contentMode = ref<'text' | 'markdown'>(props.initialValue?.contentMode || 'text')
const markdownContent = ref(props.initialValue?.markdownContent || '')

/** 正文模式切换：纯文本 ⇄ Markdown（迁移内容，origin/main 逻辑） */
async function onContentModeChange(newMode: string | number | boolean | undefined) {
  const mode = newMode as 'text' | 'markdown'
  if (mode === 'markdown') {
    if (content.value && !markdownContent.value) {
      markdownContent.value = content.value
    }
  } else {
    if (markdownContent.value) {
      let plainText = markdownContent.value
      plainText = plainText.replace(/^#{1,6}\s+/gm, '')
      plainText = plainText.replace(/\*\*([^*]+)\*\*/g, '$1')
      plainText = plainText.replace(/\*([^*]+)\*/g, '$1')
      plainText = plainText.replace(/==([^=]+)==/g, '$1')
      plainText = plainText.replace(/^>\s?/gm, '')
      plainText = plainText.replace(/^[-*+]\s+/gm, '')
      plainText = plainText.replace(/^\d+\.\s+/gm, '')
      plainText = plainText.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      content.value = plainText.trim()
    }
  }
  notifyChange()
}

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
    contentMode: contentType.value === 'article' ? contentMode.value : undefined,
    markdownContent: contentType.value === 'article' && contentMode.value === 'markdown' ? markdownContent.value : undefined,
  })
}

// ============ 选择的账号 ID ============

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
    // 加载合规提示设置
    try {
      complianceSettings.value = await electronApi.compliance.getSettings()
      promptOn.value = complianceSettings.value.promptEnabled
    } catch (e) {
      console.warn('[PublishForm] 加载合规设置失败', e)
    }
    // 如果有初始选中的账号
    if (props.initialValue?.accountIds) {
      props.initialValue.accountIds.forEach((id) => {
        selectedIds[id] = true
      })
    }
    // 建立脏检测基线（M4：未保存关闭确认）
    resetBaseline()
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

// ============ 脏标记（M4：未保存关闭确认） ============
/** 序列化当前表单关键字段，用于脏检测比对 */
function snapshot(): string {
  return JSON.stringify({
    contentType: contentType.value,
    title: title.value,
    mediaFiles: [...mediaFiles.value].sort(),
    content: content.value,
    summary: summary.value,
    coverImage: coverImage.value,
    tagsRaw: tagsRaw.value,
    markdownContent: markdownContent.value,
    contentMode: contentMode.value,
    publishTimeType: publishTimeType.value,
    scheduledTime: scheduledTime.value ? scheduledTime.value.getTime() : null,
    publishFilterCategoryId: publishFilterCategoryId.value,
    selectedIds: Object.keys(selectedIds).filter((k) => selectedIds[k]).sort(),
  })
}
/** 基线：当前为「干净」状态。草稿加载/初始化后调用以重建基线 */
const baseline = ref('')
function resetBaseline() {
  baseline.value = snapshot()
}
/** 相对基线是否有改动（基线未建立前视为干净） */
const isDirty = computed(() => baseline.value !== '' && snapshot() !== baseline.value)

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

  // 发布前合规提示（仅提示，不阻断）
  if (compliance.result.value.hasAny && complianceSettings.value.promptEnabled) {
    const cont = await noticeRef.value?.show(compliance.result.value)
    if (cont === false) return // 用户选"去修改"，中止本次提交
  }

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
  if (data.accountIds) {
    for (const k of Object.keys(selectedIds)) delete selectedIds[k]
    data.accountIds.forEach((id) => { selectedIds[id] = true })
  }
  notifyChange()
  // 草稿/外部数据载入后重建基线，避免「刚加载」就被判为脏（M4）
  resetBaseline()
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

defineExpose({ fillForm, getFormData, insertTextAtCursor, addImages, insertImagePlaceholder, isDirty })

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

// ============ 原型视觉辅助 ============
/** 切换发布类型（顺带清理类型不兼容的账号选中，与 watch 一致） */
function setType(t: 'video' | 'image' | 'article') {
  contentType.value = t
  notifyChange()
}

</script>

<template>
  <div class="publish-form">
    <div class="pub-wrap">
      <!-- 左：发布内容 -->
      <div class="panel pub-card">
        <!-- 受控模式（路由驱动）下展示类型徽标，替代页面内 Tab -->
        <div v-if="controlled" class="type-badge">
          <span class="tb-ic">{{ typeMeta.icon }}</span>
          <span class="tb-label">{{ typeMeta.label }}</span>
        </div>
        <!-- 合规预检头部：标题 + 提示开关（对齐原型 mode-switch） -->
        <div class="comp-head-row">
          <span class="comp-head-label">🔒 发布前合规预检</span>
          <div class="mode-switch">
            <button type="button" class="ms" :class="{ active: promptOn }" @click="onPromptToggle(true)">🔔 提示开</button>
            <button type="button" class="ms" :class="{ active: !promptOn }" @click="onPromptToggle(false)">🔕 提示关</button>
          </div>
        </div>

        <ComplianceDetailPanel
          :result="compliance.result.value"
          :enabled="promptOn"
          :scanning="compliance.scanning.value"
          :platform-label="compliancePlatformLabel"
          @locate="locateField"
        />

        <!-- 图例 + 本地检测说明（提升可见性，对齐原型） -->
        <div class="comp-legend">
          <span class="lg"><i class="dot high"></i>高危 · 显著提示，仍可发布</span>
          <span class="lg"><i class="dot mid"></i>中危 · 建议修改</span>
          <span class="lg"><i class="dot low"></i>低危 · 提示</span>
        </div>
        <div class="local-note"><span class="lk">🔒</span> 全部检测在本机完成，词库随版内置、不上传任何数据</div>

        <!-- ① 内容类型 -->
        <div class="type-tabs" v-if="!controlled">
          <button type="button" class="t-tab" :class="{ active: contentType === 'video' }" @click="setType('video')">🎬 视频</button>
          <button type="button" class="t-tab" :class="{ active: contentType === 'image' }" @click="setType('image')">🖼️ 图文</button>
          <button type="button" class="t-tab" :class="{ active: contentType === 'article' }" @click="setType('article')">📄 文章</button>
        </div>

        <!-- 标题 -->
        <div class="field">
          <label>标题<ComplianceBadge :level="compliance.badges.value.title?.level" :count="compliance.badges.value.title?.count" @click="locateField('title')" /><span class="counter">{{ title.length }} / {{ titleMaxLength }}</span></label>
          <el-input ref="titleInputRef" v-model="title" :placeholder="titlePlaceholder" :maxlength="titleMaxLength" @input="notifyChange" />
        </div>

        <!-- 正文 / 描述 -->
        <div class="field">
          <label>{{ contentType === 'article' ? '正文' : '正文 / 描述' }}<ComplianceBadge :level="compliance.badges.value.content?.level" :count="compliance.badges.value.content?.count" @click="locateField('content')" /><span class="counter">{{ content.length }} / {{ platformContentLimit.min }}</span></label>

          <!-- 文章模式：正文模式切换（Markdown 编辑器，origin/main 新增） -->
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
              ? '请输入文章正文（抖音：至少100字，最多8000字；小红书：不限制字数）'
              : contentType === 'image'
                ? '可选：为图文添加描述文案（将作为笔记正文发布，小红书 1000 字/抖音 1000 字/快手 500 字）'
                : '可选：为视频添加描述文案（快手最多 500 字）'"
            :maxlength="platformContentLimit.min"
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
          <div v-if="kuaishouSelected" class="kuaishou-hint">⚡ 已选快手账号：正文将被限制为 500 字，超出部分将自动截断</div>
          <div v-if="isContentWithTagsOverLimit" class="over-limit-hint">⚠️ 正文+话题共 {{ content.length + tagsLength }} 字，超出所选平台最大限制（{{ platformContentLimit.min }} 字），发布后可能被截断</div>
          <div v-else-if="isContentOverLimit" class="over-limit-hint">⚠️ 当前内容（{{ content.length }} 字）超出所选平台最大限制（{{ platformContentLimit.min }} 字），超出部分将在发布时自动截断</div>
          <div v-if="platformContentLimit.platforms.length > 0" class="limits-hint">各平台正文限制：{{ platformContentLimit.platforms.map(p => `${platformName(p.platform)} ${p.limit}字`).join(' / ') }}<span v-if="tagsLength > 0">（当前话题约 {{ tagsLength }} 字）</span></div>
          <div v-if="articleMinContentHint" class="min-content-hint">{{ articleMinContentHint }}</div>
        </div>

        <!-- 话题 -->
        <div class="field">
          <label>话题标签<ComplianceBadge :level="compliance.badges.value.tags?.level" :count="compliance.badges.value.tags?.count" @click="locateField('tags')" /></label>
          <el-input ref="tagsInputRef" v-model="tagsRaw" placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活" @input="notifyChange" />
        </div>

        <!-- 素材（视频 / 图文） -->
        <div class="field" v-if="contentType !== 'article'">
          <label>素材文件</label>
          <div class="dropzone" @click="pickMediaFiles">
            <div class="dz-ico">📎</div>
            <div>
              <div class="dz-main">点击或拖拽上传{{ contentType === 'video' ? '视频' : '图片' }}</div>
              <div class="dz-sub">{{ contentType === 'video' ? '支持 mp4 / mov / avi 等' : '支持 jpg / png / webp 等' }}</div>
            </div>
          </div>
          <div v-if="mediaFiles.length > 0" class="file-tip">已选择 {{ mediaFiles.length }} 个文件</div>
          <div class="file-list" v-if="mediaFiles.length > 0">
            <div v-for="(f, idx) in mediaFiles" :key="idx" class="file-item">
              <span class="file-name">{{ f }}</span>
              <el-button size="small" type="danger" link @click="removeMediaFile(f)">删除</el-button>
            </div>
          </div>
        </div>

        <!-- 封面（视频） -->
        <div class="field" v-if="contentType === 'video'">
          <label>封面图</label>
          <div class="dropzone" @click="pickCover">
            <div class="dz-ico">🖼️</div>
            <div>
              <div class="dz-main">上传封面</div>
              <div class="dz-sub">抖音 / 视频号必填</div>
            </div>
          </div>
          <div v-if="coverImage" class="cover-path">🖼️ {{ coverImage }}</div>
        </div>

        <!-- 封面（文章：取图片首张） -->
        <div class="field" v-if="contentType === 'article'">
          <label>封面图片</label>
          <div class="dropzone" @click="pickArticleCover">
            <div class="dz-ico">🖼️</div>
            <div>
              <div class="dz-main">选择封面图片</div>
              <div class="dz-sub">第 1 张将作为封面</div>
            </div>
          </div>
          <div class="article-cover-hint" v-if="hasDouyinAccount"><span class="warn-text">⚠️ 已选抖音账号：封面为必填项</span></div>
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
        </div>

        <!-- 摘要（文章） -->
        <div class="field" v-if="contentType === 'article'">
          <label>摘要<ComplianceBadge :level="compliance.badges.value.summary?.level" :count="compliance.badges.value.summary?.count" @click="locateField('summary')" /><span class="counter">{{ summary.length }} / {{ articleSummaryMaxLength }}</span></label>
          <el-input ref="summaryTextareaRef" v-model="summary" type="textarea" :rows="2" placeholder="可选：文章摘要/简介（抖音300字/小红书1000字）" :maxlength="articleSummaryMaxLength" @input="notifyChange" />
        </div>

        <!-- 发布时间 -->
        <div class="field">
          <label>发布时间</label>
          <div class="time-row">
            <div class="seg">
              <button type="button" class="seg-btn" :class="{ active: publishTimeType === 'now' }" @click="publishTimeType = 'now'; notifyChange()">⚡ 立即发布</button>
              <button type="button" class="seg-btn" :class="{ active: publishTimeType === 'scheduled' }" @click="publishTimeType = 'scheduled'; notifyChange()">🕘 定时发布</button>
            </div>
            <el-date-picker
              v-if="publishTimeType === 'scheduled'"
              v-model="scheduledTime"
              type="datetime"
              placeholder="选择发布时间"
              :disabled-date="disabledScheduledDate"
              class="time-picker"
              @change="notifyChange"
            />
          </div>
        </div>
      </div>

      <!-- 右：选择账号 -->
      <div class="panel acc-card">
        <h2 class="sec-title">选择发布账号</h2>
        <div class="filters">
          <button type="button" class="pill" :class="{ active: publishFilterCategoryId === '' }" @click="publishFilterCategoryId = ''">全部分类</button>
          <button type="button" class="pill" :class="{ active: publishFilterCategoryId === 'unclassified' }" @click="publishFilterCategoryId = 'unclassified'">未分类</button>
          <button type="button" class="pill" v-for="cat in accountStore.categories" :key="cat.id" :class="{ active: publishFilterCategoryId === cat.id }" @click="publishFilterCategoryId = cat.id">{{ cat.name }}</button>
        </div>
        <div class="pick-actions">
          <button type="button" class="link-btn" @click="selectAll">全选可见</button>
          <button type="button" class="link-btn" @click="clearSelection">清空</button>
          <span class="hint">已选 {{ getSelectedIds().length }} / {{ visibleAccounts.length }}</span>
        </div>

        <div v-if="visibleAccounts.length === 0" class="empty"><el-empty description="没有可用账号，请先在账号管理授权" /></div>

        <div v-else class="pick-scroll">
          <div class="pick-grid">
            <div
              v-for="a in visibleAccounts"
              :key="a.id"
              class="pick"
              :class="{ on: !!selectedIds[a.id] }"
              @click="toggleAccount(a.id)"
            >
              <div class="ava" :style="{ background: a.avatar ? 'transparent' : 'var(--brand-indigo)' }">
                <img v-if="a.avatar" :src="a.avatar" class="ava-img" :alt="a.nickname" />
                <span v-else>{{ (a.nickname || 'U').slice(0, 1) }}</span>
              </div>
              <div class="pinfo">
                <div class="pn">{{ a.nickname }}</div>
                <div class="pf">
                  <img v-if="getPlatformIcon(a.platform)" :src="getPlatformIcon(a.platform)" class="pf-plogo" :alt="platformName(a.platform)" />
                  <span>{{ platformName(a.platform) }}</span>
                  <span class="pf-id">· {{ a.id }}</span>
                </div>
              </div>
              <div v-if="selectedIds[a.id]" class="check">✓</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部提交栏 -->
    <div class="form-footer">
      <div class="submit-row">
        <el-button type="primary" :loading="submitting" :disabled="submitting || visibleAccounts.length === 0" @click="submitPublish">
          {{ submitText || (publishTimeType === 'scheduled' ? '🕘 定时发布到' : '🚀 一键发布到') + ' ' + getSelectedIds().length + ' 个账号' }}
        </el-button>
        <el-button type="warning" :loading="submitting" :disabled="submitting || visibleAccounts.length === 0" @click="submitTestPublish">
          🔍 发布测试
        </el-button>
        <el-button :disabled="submitting" @click="clearForm">清空</el-button>
        <slot name="footer-extra"></slot>
      </div>
    </div>
  </div>
  <ComplianceNoticeModal ref="noticeRef" />
</template>

<style scoped>
.publish-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.pub-wrap {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 16px;
  align-items: start;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 1080px) {
  .pub-wrap { grid-template-columns: 1fr; }
}
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 20px 22px;
  box-shadow: var(--shadow-xs);
}
.pub-card { overflow-y: auto; }
.acc-card { display: flex; flex-direction: column; min-height: 0; }
.pick-scroll { overflow-y: auto; min-height: 0; flex: 1; padding-right: 4px; }

/* 内容类型切换 */
.type-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
  border: 1px solid rgba(99, 102, 241, 0.25);
  border-radius: 12px;
  padding: 7px 14px;
  margin-bottom: 16px;
  font-weight: 700;
  font-size: 13.5px;
}
.tb-ic { font-size: 16px; }
.type-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
  background: var(--surface-2);
  padding: 5px;
  border-radius: 14px;
}
.t-tab {
  flex: 1;
  border: none;
  background: transparent;
  border-radius: 10px;
  padding: 10px 12px;
  font-weight: 700;
  font-size: 13.5px;
  color: var(--slate);
  cursor: pointer;
  transition: all var(--t) var(--ease);
  font-family: inherit;
}
.t-tab:hover { color: var(--brand-indigo); }
.t-tab.active {
  background: #fff;
  color: var(--brand-indigo);
  box-shadow: var(--shadow-sm);
}

/* 字段 */
.field { margin-bottom: 15px; }
.field > label {
  display: block;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 7px;
}
.counter { float: right; font-size: 11.5px; color: var(--faint); font-weight: 600; }

/* 拖拽上传区 */
.dropzone {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--r-md);
  padding: 16px;
  cursor: pointer;
  transition: all var(--t) var(--ease);
  background: var(--surface-2);
}
.dropzone:hover { border-color: var(--brand-indigo); background: var(--brand-grad-soft); }
.dz-ico {
  font-size: 22px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border-radius: 11px;
  box-shadow: var(--shadow-xs);
  flex-shrink: 0;
}
.dz-main { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.dz-sub { font-size: 12px; color: var(--muted); font-weight: 500; }
.file-tip { font-size: 12px; color: var(--muted); margin-top: 8px; }
.file-list { margin-top: 8px; max-height: 150px; overflow-y: auto; }
.file-item { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; font-size: 12px; color: var(--slate); border-bottom: 1px dashed var(--line); }
.file-name { word-break: break-all; }

/* 封面 */
.cover-path { font-size: 12px; color: var(--muted); margin-top: 8px; word-break: break-all; }
.article-cover-hint { margin-top: 8px; }
.warn-text { color: var(--danger); font-size: 12px; font-weight: 600; }
.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px; margin-top: 10px; }
.image-item { display: flex; flex-direction: column; gap: 5px; }
.image-thumb { position: relative; width: 100%; padding-top: 100%; border-radius: var(--r-sm); overflow: hidden; background: var(--surface-2); border: 1px solid var(--line); }
.image-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.image-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); }
.cover-badge { position: absolute; top: 6px; left: 6px; background: var(--brand-indigo); color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 6px; font-weight: 600; }
.image-actions { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.image-index { color: var(--muted); font-size: 11px; }

/* 账号选择 */
.sec-title { font-family: var(--font-display); font-size: 16px; font-weight: 700; margin: 0 0 12px; color: var(--ink); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.pill {
  padding: 7px 14px;
  border-radius: 20px;
  font-size: 12.5px;
  font-weight: 700;
  background: #fff;
  border: 1px solid var(--line);
  color: var(--slate);
  cursor: pointer;
  transition: all var(--t) var(--ease);
  font-family: inherit;
}
.pill:hover { border-color: var(--brand-indigo); color: var(--brand-indigo); }
.pill.active { background: var(--brand-grad); color: #fff; border-color: transparent; }
.pick-actions { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.link-btn { background: none; border: none; color: var(--brand-indigo); font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 0; font-family: inherit; }
.link-btn:hover { text-decoration: underline; }
.hint { color: var(--muted); font-size: 12px; margin-left: auto; }
.pick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding-right: 2px; }
.pick {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: #fff;
  cursor: pointer;
  transition: all var(--t) var(--ease);
  position: relative;
}
.pick:hover { border-color: var(--brand-indigo); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.pick.on { border-color: var(--brand-indigo); background: var(--brand-grad-soft); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12); }
.ava { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; background: var(--brand-indigo); color: #fff; font-weight: 800; font-size: 14px; }
.ava-img { width: 100%; height: 100%; object-fit: cover; }
.pinfo { min-width: 0; }
.pn { font-size: 13px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-plogo { width: 14px; height: 14px; object-fit: contain; border-radius: 4px; flex-shrink: 0; }
.pf-id { opacity: 0.7; }
.check { position: absolute; top: 8px; right: 10px; width: 18px; height: 18px; border-radius: 50%; background: var(--brand-indigo); color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; font-weight: 800; }

/* 发布时间 */
.time-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.seg { display: inline-flex; background: var(--surface-2); border-radius: 11px; padding: 4px; gap: 4px; }
.seg-btn { border: none; background: transparent; border-radius: 8px; padding: 8px 14px; font-weight: 700; font-size: 13px; color: var(--slate); cursor: pointer; transition: all var(--t) var(--ease); font-family: inherit; }
.seg-btn.active { background: #fff; color: var(--brand-indigo); box-shadow: var(--shadow-xs); }
.time-picker { width: 220px; }

/* 底部提交栏 */
.submit-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.form-footer {
  flex-shrink: 0;
  padding: 14px 22px;
  border-top: 1px solid var(--line);
  background: var(--surface);
  display: flex;
  justify-content: center;
}

/* 字数限制提示 */
.kuaishou-hint { font-size: 12px; color: var(--warning); margin-top: 4px; background: #fffbeb; border-left: 3px solid var(--warning); padding: 6px 10px; border-radius: var(--r-sm); }
.over-limit-hint { font-size: 12px; color: var(--danger); margin-top: 4px; background: #fef2f2; border-left: 3px solid var(--danger); padding: 6px 10px; border-radius: var(--r-sm); }
.limits-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
.min-content-hint { font-size: 12px; color: var(--brand-indigo); margin-top: 4px; background: var(--brand-grad-soft); border-left: 3px solid var(--brand-indigo); padding: 6px 10px; border-radius: var(--r-sm); }

/* Markdown 模式切换（origin/main 新增，配色对齐 redesign token） */
.content-limit-tag { font-size: 11px; color: var(--muted); margin-top: 4px; }
.content-mode-switch { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.mode-hint { font-size: 12px; color: var(--muted); }

.empty { padding: 20px 0; }

/* ===== 合规预检头部（对齐原型 compliance-prototype.html）===== */
.comp-head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.comp-head-label { font-size: 13px; font-weight: 800; color: var(--ink); display: inline-flex; align-items: center; gap: 6px; }
.mode-switch { display: inline-flex; align-items: center; gap: 0; background: #f1f5f9; border-radius: 11px; padding: 3px; }
.mode-switch .ms {
  height: 32px; padding: 0 14px; border-radius: 9px; font-size: 12.5px; font-weight: 700;
  color: var(--slate); background: transparent; border: none; cursor: pointer; transition: all 0.2s;
}
.mode-switch .ms.active { background: #fff; color: var(--brand-indigo, #6366f1); box-shadow: var(--shadow-sm); }
.mode-switch .ms.armed { background: rgba(244, 63, 94, 0.14); color: #e11d48; }

/* 图例 */
.comp-legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 2px 0 8px; font-size: 11.5px; color: var(--muted); font-weight: 600; }
.comp-legend .lg { display: flex; align-items: center; gap: 6px; }
.comp-legend .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.comp-legend .dot.high { background: #f43f5e; }
.comp-legend .dot.mid { background: #f59e0b; }
.comp-legend .dot.low { background: #3b82f6; }

/* 本地检测说明 */
.local-note { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 14px; }
.local-note .lk { font-size: 13px; }
</style>
