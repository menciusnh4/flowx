<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import { electronApi } from '../utils/electron'
import { useEnvStore } from '../stores/env'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import PublishForm from '../components/PublishForm.vue'
import BrowserRulePanel from '../components/BrowserRulePanel.vue'
import type { BrowserEnvironment, PublishRequest, BrowserBookmark, BrowserHistoryItem, ExtractedContent, CustomSiteRule, PickerFieldType, PickerResult, PublishContentType } from '../../types'
import TurndownService from 'turndown'

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

turndownService.addRule('removeImages', {
  filter: 'img',
  replacement: function () {
    return ''
  },
})

const route = useRoute()
const envStore = useEnvStore()
const props = defineProps<{ url?: string }>()
const uiStore = useUiStore()

// 发布表单 ref
const publishFormRef = ref<InstanceType<typeof PublishForm> | null>(null)
// 规则面板 ref
const browserRulePanelRef = ref<InstanceType<typeof BrowserRulePanel> | null>(null)

// 布局模式：browser-only | split | publish-only
const layoutMode = ref<'browser-only' | 'split' | 'publish-only'>('split')
const leftWidth = ref(60) // 左侧浏览器占比（%）；默认 60/40，给右侧发布编辑面板留出更舒适的宽度

// 右侧面板 Tab
const rightPanelTab = ref<'publish' | 'rules'>('publish')
const isDragging = ref(false)
const isExtracting = ref(false)
const layoutDropdownVisible = ref(false)

// ========== 内容提取优化状态 ==========
const selectorActive = ref(false)
const extractMode = ref<'replace' | 'append'>('replace')
const extractConfidence = ref<number | null>(null)

// ========== 自定义规则 & 拾取器 ==========

// 拾取器状态
const pickerActive = ref(false)
const currentPickerField = ref<PickerFieldType | null>(null)

// 地址栏输入值（UI 状态，切换标签时同步）
const urlInput = ref('')
// 证书忽略开关（UI 状态，切换标签时同步）
const ignoreCertErrors = ref(false)
// 当前环境选择（UI 状态，切换标签时同步）
const currentEnvId = ref<string | null>(null)

// ========== 收藏夹与历史记录 ==========

// 当前页面是否已收藏
const isCurrentUrlBookmarked = ref(false)

// 侧边栏显示状态
const sidebarVisible = ref(false)
// 侧边栏当前 Tab：bookmarks | history
const sidebarTab = ref<'bookmarks' | 'history'>('bookmarks')

// 收藏夹列表
const bookmarkList = ref<BrowserBookmark[]>([])
const bookmarkSearchKeyword = ref('')

// 历史记录列表
const historyList = ref<BrowserHistoryItem[]>([])
const historySearchKeyword = ref('')

// 搜索防抖定时器
let bookmarkSearchTimer: ReturnType<typeof setTimeout> | null = null
let historySearchTimer: ReturnType<typeof setTimeout> | null = null

const browserContainerRef = ref<HTMLElement | null>(null)

// 原生视图（WebContentsView）是否已临时隐藏：弹窗/下拉打开时置 true，
// 把原生视图移到屏幕外避免其「永远覆盖 HTML DOM」的层级特性盖住弹窗。
// 任何 setBounds 恢复操作（updateViewBounds 等）都必须检查它，否则会被 ResizeObserver 等拉回。
let browserHidden = false

// 环境列表
const environments = ref<BrowserEnvironment[]>([])

// ========== 多标签页数据结构 ==========

interface BrowserTab {
  id: string // viewId
  title: string
  url: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  envId: string | null
  ignoreCertErrors: boolean
}

const tabs = ref<BrowserTab[]>([])
const activeTabId = ref<string | null>(null)

/** 当前激活的标签 */
const activeTab = computed<BrowserTab | null>(() => {
  if (!activeTabId.value) return null
  return tabs.value.find((t) => t.id === activeTabId.value) || null
})

/** 当前激活标签的 viewId（兼容旧代码） */
const browserViewId = computed(() => activeTab.value?.id ?? null)
const currentUrl = computed(() => activeTab.value?.url ?? '')
const pageTitle = computed(() => activeTab.value?.title ?? '')
const isLoading = computed(() => activeTab.value?.isLoading ?? false)
const canGoBack = computed(() => activeTab.value?.canGoBack ?? false)
const canGoForward = computed(() => activeTab.value?.canGoForward ?? false)

// ========== 标签操作 ==========

/** 新建标签 */
async function createTab(url = 'flowx-newtab://page') {
  try {
    const result = await electronApi.browser.createView({ url })
    const tab: BrowserTab = {
      id: result.viewId,
      title: result.title || '新标签页',
      url: result.url || url,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      envId: result.envId ?? null,
      ignoreCertErrors: false,
    }
    // 获取证书忽略状态
    try {
      tab.ignoreCertErrors = await electronApi.browser.isIgnoringCertErrors(result.viewId)
    } catch {
      // ignore
    }
    tabs.value.push(tab)
    // 激活新标签
    await switchTab(result.viewId)
    return tab
  } catch (e) {
    console.error('[Browser.vue] createTab error', e)
    ElMessage.error('新建标签页失败')
    return null
  }
}

/** 切换到指定标签 */
async function switchTab(tabId: string) {
  if (tabId === activeTabId.value) return
  const tab = tabs.value.find((t) => t.id === tabId)
  if (!tab) return

  // 切换标签前，如果选择器模式激活，先关闭
  if (selectorActive.value && activeTabId.value) {
    try {
      await electronApi.browser.stopSelector(activeTabId.value)
    } catch {
      // ignore
    }
    selectorActive.value = false
  }

  // 先把当前激活的标签 view 移到屏幕外
  if (activeTabId.value) {
    hideTabView(activeTabId.value)
  }

  activeTabId.value = tabId

  // 同步 UI 状态
  urlInput.value = tab.url
  ignoreCertErrors.value = tab.ignoreCertErrors
  currentEnvId.value = tab.envId

  // 把新标签的 view 移到可见区域
  await nextTick()
  await updateViewBounds()

  // 检查新标签页的收藏状态
  checkCurrentUrlBookmarked()
}

/** 隐藏指定标签的 WebContentsView（移到屏幕外） */
function hideTabView(viewId: string) {
  electronApi.browser.setBounds(viewId, { x: -9999, y: -9999, width: 0, height: 0 }).catch(() => {})
}

/** 关闭标签 */
async function closeTab(tabId: string) {
  const index = tabs.value.findIndex((t) => t.id === tabId)
  if (index === -1) return

  // 至少保留一个标签
  if (tabs.value.length <= 1) return

  const isActive = tabId === activeTabId.value

  // 如果关闭的是当前激活标签且选择器激活，重置选择器状态
  if (isActive && selectorActive.value) {
    selectorActive.value = false
  }

  // 先从数组中移除
  tabs.value.splice(index, 1)

  // 如果关闭的是当前激活标签，激活相邻标签
  if (isActive) {
    const newActiveIndex = Math.min(index, tabs.value.length - 1)
    const newActiveTab = tabs.value[newActiveIndex]
    if (newActiveTab) {
      activeTabId.value = newActiveTab.id
      urlInput.value = newActiveTab.url
      ignoreCertErrors.value = newActiveTab.ignoreCertErrors
      currentEnvId.value = newActiveTab.envId
      await nextTick()
      await updateViewBounds()
      // 检查新标签页的收藏状态
      checkCurrentUrlBookmarked()
    }
  }

  // 销毁 view
  try {
    await electronApi.browser.destroyView(tabId)
  } catch (e) {
    console.error('[Browser.vue] destroyView error', e)
  }
}

// ========== 初始化 ==========

async function initBrowser() {
  try {
    // 先加载环境列表
    await envStore.loadAll()
    environments.value = envStore.environments

    // 从 URL 参数获取初始 URL（从草稿箱等地方跳转过来时会带 url 参数）
    const initialUrl = (props.url ?? (route.query.url as string)) || 'flowx-newtab://page'

    // 初始创建一个标签
    await createTab(initialUrl)

    // 检查初始页面的收藏状态
    checkCurrentUrlBookmarked()
  } catch (e) {
    console.error('[Browser.vue] initBrowser error', e)
    ElMessage.error('浏览器初始化失败')
  }
}

// 从草稿箱等带 url 跳转到浏览器 tab 时，props.url 变化则导航到该网页
watch(
  () => props.url,
  (u) => {
    if (u && activeTabId.value) navigateTo(u)
  },
)

// ========== 视图 bounds 管理 ==========

/** 更新当前激活标签的 WebContentsView 位置和大小 */
async function updateViewBounds() {
  // 原生视图已隐藏时，绝不重新 setBounds 把它拉回可见区 ——
  // 否则 ResizeObserver / 窗口 resize / 各处 nextTick 任意触发都会让 WebContentsView 重新盖住弹窗
  if (browserHidden) return
  if (!browserContainerRef.value || !activeTabId.value) return
  const rect = browserContainerRef.value.getBoundingClientRect()
  // 容器不可见（display:none / 布局未就绪 / 仅发布表单模式）时尺寸为 0，
  // 若仍照常 setBounds 会把原生视图设成 0 尺寸并停在屏幕外 → 内容区空白。
  // 这里直接跳过，交给 ResizeObserver 在容器重新可见时再校正（见 onMounted）。
  if (rect.width <= 0 || rect.height <= 0) return
  try {
    await electronApi.browser.setBounds(activeTabId.value, {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  } catch (e) {
    console.error('[Browser.vue] setBounds error', e)
  }
}

// ========== 浏览器操作（作用于当前激活标签） ==========

// 全局搜索「在浏览器 tab 打开 URL」挂起地址消费：搜索的书签/历史结果点击后写入，
// 本函数在其就绪时调用内部 navigateTo 并清空。
const workspaceStore = useWorkspaceStore();
function consumePendingNavigate() {
  const url = workspaceStore.pendingNavigateUrl;
  if (!url) return;
  if (!activeTabId.value) return; // 等待默认标签就绪
  navigateTo(url);
  workspaceStore.pendingNavigateUrl = '';
}

// 导航到指定 URL
async function navigateTo(url: string) {
  if (!activeTabId.value) return
  let target = url.trim()
  if (!target) return

  // 清理 URL 首尾的反引号、引号等特殊字符（复制粘贴时常见）
  target = target.replace(/^[`'"<>]+|[`'"<>]+$/g, '').trim()
  if (!target) return

  // 如果不是完整 URL，自动补全 https://
  if (!/^https?:\/\//i.test(target)) {
    if (/^[\w-]+(\.[\w-]+)+/.test(target)) {
      target = 'https://' + target
    } else {
      // 当作搜索词，用百度搜索
      target = 'https://www.baidu.com/s?wd=' + encodeURIComponent(target)
    }
  }
  try {
    const tab = tabs.value.find((t) => t.id === activeTabId.value)
    if (tab) tab.isLoading = true
    urlInput.value = target
    await electronApi.browser.navigate(activeTabId.value, target)
  } catch (e) {
    console.error('[Browser.vue] navigate error', e)
    const tab = tabs.value.find((t) => t.id === activeTabId.value)
    if (tab) tab.isLoading = false
  }
}

function handleUrlKeydown(e: KeyboardEvent | Event) {
  if ('key' in e && e.key === 'Enter') {
    navigateTo(urlInput.value)
  }
}

async function goHome() {
  if (!activeTabId.value) return
  try {
    await electronApi.browser.navigate(activeTabId.value, 'flowx-newtab://page')
  } catch (e) {
    console.error('[Browser.vue] goHome error', e)
  }
}

async function goBack() {
  if (!activeTabId.value || !canGoBack.value) return
  try {
    await electronApi.browser.goBack(activeTabId.value)
  } catch (e) {
    console.error('[Browser.vue] goBack error', e)
  }
}

async function goForward() {
  if (!activeTabId.value || !canGoForward.value) return
  try {
    await electronApi.browser.goForward(activeTabId.value)
  } catch (e) {
    console.error('[Browser.vue] goForward error', e)
  }
}

async function reload() {
  if (!activeTabId.value) return
  try {
    if (isLoading.value) {
      await electronApi.browser.stop(activeTabId.value)
    } else {
      await electronApi.browser.reload(activeTabId.value)
    }
  } catch (e) {
    console.error('[Browser.vue] reload error', e)
  }
}

function stop() {
  if (!activeTabId.value) return
  electronApi.browser.stop(activeTabId.value).catch(console.error)
}

// ========== 分割条拖拽 ==========
let startX = 0
let startLeftWidth = 0

function startDrag(e: MouseEvent) {
  if (layoutMode.value !== 'split') return
  isDragging.value = true
  startX = e.clientX
  startLeftWidth = leftWidth.value
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onDrag(e: MouseEvent) {
  if (!isDragging.value) return
  const container = browserContainerRef.value?.parentElement
  if (!container) return
  const containerWidth = container.clientWidth
  const deltaX = e.clientX - startX
  const deltaPercent = (deltaX / containerWidth) * 100
  let newWidth = startLeftWidth + deltaPercent
  // 限制范围：左侧最小 25%，右侧最小 30%
  newWidth = Math.max(25, Math.min(70, newWidth))
  leftWidth.value = newWidth
  nextTick(() => updateViewBounds())
}

function stopDrag() {
  isDragging.value = false
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

// ========== 布局切换 ==========

function setLayoutMode(mode: 'browser-only' | 'split' | 'publish-only') {
  layoutMode.value = mode
  // 布局切换后，等待 DOM 更新后多次尝试恢复 bounds（确保动画/过渡完成）
  nextTick(() => {
    updateViewBounds()
    setTimeout(() => updateViewBounds(), 100)
    setTimeout(() => updateViewBounds(), 300)
  })
}

// 布局下拉显示/隐藏时，更新全局弹层计数
function handleLayoutDropdownVisible(visible: boolean) {
  layoutDropdownVisible.value = visible
  if (visible) {
    uiStore.pushOverlay('browser-layout-dropdown')
  } else {
    uiStore.popOverlay('browser-layout-dropdown')
  }
}

// 环境选择下拉显示/隐藏时，更新全局弹层计数
function handleEnvDropdownVisible(visible: boolean) {
  if (visible) {
    uiStore.pushOverlay('browser-env-dropdown')
  } else {
    uiStore.popOverlay('browser-env-dropdown')
  }
}

// 弹窗显示/隐藏时，更新全局弹层计数
function handleModalShow() {
  uiStore.pushOverlay('browser-modal')
}
function handleModalHide() {
  uiStore.popOverlay('browser-modal')
}

// 监听全局弹层计数变化，控制 WebContentsView 显隐
// 因为 WebContentsView 是原生控件，层级永远在 HTML 之上，会挡住所有 HTML 弹层
watch(() => uiStore.overlayCount, (count, oldCount) => {
  if (!activeTabId.value) return
  if (count > 0 && oldCount === 0) {
    // 从 0 变到有弹层 → 隐藏浏览器视图
    hideBrowserView()
  } else if (count === 0 && oldCount > 0) {
    // 从有弹层变到 0 → 恢复浏览器视图（延迟等待动画完成）
    setTimeout(() => {
      showBrowserView()
      // 多次尝试确保恢复（防止动画期间尺寸变化）
      setTimeout(() => showBrowserView(), 100)
      setTimeout(() => showBrowserView(), 300)
    }, 200)
  }
})

// 顶栏弹窗（右键/「+」/搜索）显示时，WebContentsView 原生控件必须整块隐藏
// （原生层永远覆盖 HTML DOM，CSS z-index 无效），让位给弹窗。
function hideBrowserView() {
  if (!activeTabId.value || browserHidden) return
  browserHidden = true
  hideTabView(activeTabId.value)
}
function showBrowserView() {
  if (!activeTabId.value || !browserHidden) return
  // 两路遮挡并存：远程 uiStore（浏览器内下拉/规则面板/弹窗）+ 本分支顶栏 topbarOverlayCount（顶栏「+」/右键/搜索）
  if (uiStore.overlayCount > 0 || workspaceStore.topbarOverlayCount > 0) return
  browserHidden = false
  nextTick(() => {
    updateViewBounds()
    // 额外一次确保（防止容器尺寸还没计算好）
    setTimeout(() => updateViewBounds(), 50)
  })
}

// 监听顶栏弹层叠加计数器：顶栏的「+」下拉/右键菜单/搜索面板显示时，
// WebContentsView 原生控件必须隐藏（原生层永远覆盖 HTML DOM，CSS z-index 无效）。
// 与 handleLayoutDropdownVisible / handleEnvDropdownVisible / handleModalShow 共享同一套 hide/show 机制。
watch(() => workspaceStore.topbarOverlayCount, (count) => {
  if (count > 0) {
    hideBrowserView()
  } else {
    // 延迟恢复，等待弹层动画完成
    setTimeout(() => showBrowserView(), 200)
  }
})

// 窗口大小变化时更新 bounds
function handleResize() {
  updateViewBounds()
}

// ========== 环境切换 ==========

async function handleEnvChange(envId: string | null) {
  if (!activeTabId.value) return
  try {
    await electronApi.browser.switchEnv(activeTabId.value, envId)
    const envName = envId
      ? environments.value.find((e) => e.id === envId)?.name || '未知环境'
      : '默认环境'
    ElMessage.success(`已切换到「${envName}」，正在重新加载页面`)
  } catch (e) {
    console.error('[Browser.vue] switchEnv error', e)
    ElMessage.error('切换环境失败')
  }
}

// ========== 证书忽略切换 ==========

async function handleCertIgnoreChange(ignore: boolean | string | number) {
  const ignoreVal = Boolean(ignore)
  if (!activeTabId.value) return
  try {
    await electronApi.browser.setIgnoreCertErrors(activeTabId.value, ignoreVal)
    ElMessage.success(ignoreVal ? '已忽略证书错误，正在重新加载页面' : '已启用证书验证，正在重新加载页面')
  } catch (e) {
    console.error('[Browser.vue] setIgnoreCertErrors error', e)
    ElMessage.error('设置失败')
  }
}

// ========== 收藏夹与历史记录功能 ==========

/** 检查当前 URL 是否已收藏 */
async function checkCurrentUrlBookmarked() {
  if (!currentUrl.value) {
    isCurrentUrlBookmarked.value = false
    return
  }
  try {
    isCurrentUrlBookmarked.value = await electronApi.browserHistory.isBookmarked(currentUrl.value)
  } catch (e) {
    console.error('[Browser.vue] checkCurrentUrlBookmarked error', e)
  }
}

/** 切换当前页面的收藏状态 */
async function toggleBookmark() {
  if (!activeTab.value) return
  const url = activeTab.value.url
  const title = activeTab.value.title || url
  try {
    if (isCurrentUrlBookmarked.value) {
      await electronApi.browserHistory.deleteBookmarkByUrl(url)
      isCurrentUrlBookmarked.value = false
      ElMessage.success('已取消收藏')
    } else {
      await electronApi.browserHistory.addBookmark({ url, title })
      isCurrentUrlBookmarked.value = true
      ElMessage.success('已添加到收藏夹')
    }
    // 如果侧边栏显示的是收藏夹，刷新列表
    if (sidebarVisible.value && sidebarTab.value === 'bookmarks') {
      loadBookmarks()
    }
  } catch (e) {
    console.error('[Browser.vue] toggleBookmark error', e)
    ElMessage.error('操作失败')
  }
}

/** 加载收藏夹列表 */
async function loadBookmarks() {
  try {
    if (bookmarkSearchKeyword.value.trim()) {
      bookmarkList.value = await electronApi.browserHistory.searchBookmarks(bookmarkSearchKeyword.value)
    } else {
      bookmarkList.value = await electronApi.browserHistory.listAllBookmarks()
    }
  } catch (e) {
    console.error('[Browser.vue] loadBookmarks error', e)
  }
}

/** 收藏夹搜索（防抖） */
function handleBookmarkSearch() {
  if (bookmarkSearchTimer) clearTimeout(bookmarkSearchTimer)
  bookmarkSearchTimer = setTimeout(() => {
    loadBookmarks()
  }, 200)
}

/** 删除单条收藏 */
async function deleteBookmark(item: BrowserBookmark) {
  try {
    await electronApi.browserHistory.deleteBookmark(item.id)
    ElMessage.success('已删除收藏')
    loadBookmarks()
    // 如果删除的是当前页面，更新收藏按钮状态
    if (item.url === currentUrl.value) {
      isCurrentUrlBookmarked.value = false
    }
  } catch (e) {
    console.error('[Browser.vue] deleteBookmark error', e)
    ElMessage.error('删除失败')
  }
}

/** 加载历史记录列表 */
async function loadHistory() {
  try {
    if (historySearchKeyword.value.trim()) {
      historyList.value = await electronApi.browserHistory.searchHistory(historySearchKeyword.value)
    } else {
      historyList.value = await electronApi.browserHistory.listHistory()
    }
  } catch (e) {
    console.error('[Browser.vue] loadHistory error', e)
  }
}

/** 历史记录搜索（防抖） */
function handleHistorySearch() {
  if (historySearchTimer) clearTimeout(historySearchTimer)
  historySearchTimer = setTimeout(() => {
    loadHistory()
  }, 200)
}

/** 删除单条历史记录 */
async function deleteHistoryItem(item: BrowserHistoryItem) {
  try {
    await electronApi.browserHistory.deleteHistory(item.id)
    ElMessage.success('已删除')
    loadHistory()
  } catch (e) {
    console.error('[Browser.vue] deleteHistoryItem error', e)
    ElMessage.error('删除失败')
  }
}

/** 清除全部历史记录 */
async function clearAllHistory() {
  try {
    await ElMessageBox.confirm('确定要清除全部历史记录吗？此操作不可恢复。', '确认清除', {
      type: 'warning',
      confirmButtonText: '确定清除',
      cancelButtonText: '取消',
    })
    await electronApi.browserHistory.clearHistory()
    ElMessage.success('历史记录已清除')
    loadHistory()
  } catch (e) {
    if (e === 'cancel') return
    console.error('[Browser.vue] clearAllHistory error', e)
    ElMessage.error('清除失败')
  }
}

/** 格式化时间显示 */
function formatVisitTime(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000

  const pad = (n: number) => n.toString().padStart(2, '0')
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())

  if (ts >= todayStart) {
    return `今天 ${hh}:${mm}`
  } else if (ts >= yesterdayStart) {
    return `昨天 ${hh}:${mm}`
  } else {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
}

/** 打开侧边栏（默认显示收藏夹） */
function openSidebar(tab: 'bookmarks' | 'history' = 'bookmarks') {
  sidebarTab.value = tab
  sidebarVisible.value = true
  // 加载对应数据
  if (tab === 'bookmarks') {
    loadBookmarks()
  } else {
    loadHistory()
  }
  // 隐藏 WebContentsView
  handleModalShow()
}

/** 关闭侧边栏 */
function closeSidebar() {
  sidebarVisible.value = false
  // 显示 WebContentsView
  handleModalHide()
}

/** 切换侧边栏显示/隐藏 */
function toggleSidebar(tab: 'bookmarks' | 'history') {
  if (sidebarVisible.value && sidebarTab.value === tab) {
    closeSidebar()
  } else {
    openSidebar(tab)
  }
}

/** 在当前标签页打开 URL */
function openUrlInCurrentTab(url: string) {
  navigateTo(url)
  closeSidebar()
}

/** 切换侧边栏 Tab */
function switchSidebarTab(tab: 'bookmarks' | 'history') {
  sidebarTab.value = tab
  if (tab === 'bookmarks') {
    loadBookmarks()
  } else {
    loadHistory()
  }
}

// ========== 事件监听（来自主进程） ==========

function findTab(viewId: string): BrowserTab | undefined {
  return tabs.value.find((t) => t.id === viewId)
}

function onPageTitleUpdated(data: { viewId: string; title: string }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.title = data.title
  }
}

function onPageUrlUpdated(data: { viewId: string; url: string }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.url = data.url
    // 如果是当前激活标签，同步更新地址栏
    if (data.viewId === activeTabId.value) {
      urlInput.value = data.url
      // URL 变化时重新检查收藏状态
      checkCurrentUrlBookmarked()
    }
  }
}

function onLoadingUpdated(data: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.isLoading = data.isLoading
    if (typeof data.canGoBack === 'boolean') tab.canGoBack = data.canGoBack
    if (typeof data.canGoForward === 'boolean') tab.canGoForward = data.canGoForward
  }
}

function onEnvChanged(data: { viewId: string; envId: string | null }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.envId = data.envId
    // 如果是当前激活标签，同步更新 UI
    if (data.viewId === activeTabId.value) {
      currentEnvId.value = data.envId
    }
  }
}

function onLoadFailed(data: { viewId: string; errorCode: number; errorDescription: string; url: string }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.isLoading = false
  }
  // 只在当前激活标签显示错误提示
  if (data.viewId !== activeTabId.value) return
  // 证书错误特殊处理（错误码 -200 = ERR_CERT_COMMON_NAME_INVALID）
  if (data.errorCode === -200 || data.errorDescription?.includes('CERT_')) {
    ElMessage({
      type: 'warning',
      message: `证书错误：${data.errorDescription}，可在工具栏开启「忽略证书错误」后重试`,
      duration: 6000,
      showClose: true,
    })
  } else {
    ElMessage.error(`加载失败：${data.errorDescription}`)
  }
}

function onCertIgnoreChanged(data: { viewId: string; ignore: boolean }) {
  const tab = findTab(data.viewId)
  if (tab) {
    tab.ignoreCertErrors = data.ignore
    // 如果是当前激活标签，同步更新 UI 开关
    if (data.viewId === activeTabId.value) {
      ignoreCertErrors.value = data.ignore
    }
  }
}

// ========== 发布 & 提取 ==========

// 发布表单提交
async function handlePublishSubmit(req: PublishRequest) {
  try {
    const { usePublishStore } = await import('../stores/publish')
    const publishStore = usePublishStore()
    publishStore.ensureListener()
    const taskId = await publishStore.submit(req)
    ElMessage.success(`任务已提交：${taskId}`)
  } catch (e) {
    console.error('[Browser.vue] publish error', e)
    ElMessage.error(`发布失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// 测试发布提交
async function handleTestSubmit(req: PublishRequest) {
  try {
    const { usePublishStore } = await import('../stores/publish')
    const publishStore = usePublishStore()
    publishStore.ensureListener()
    const taskId = await publishStore.submit(req)
    ElMessage.success(`测试任务已提交：${taskId}`)
  } catch (e) {
    console.error('[Browser.vue] test submit error', e)
    ElMessage.error(`测试失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 将提取结果填充到发布表单（支持替换/追加模式）
 * @param result 提取结果（images 为 ExtractedImage[]）
 * @param mode 填充模式：replace 替换，append 追加
 */
async function fillExtractToForm(result: ExtractedContent, mode: 'replace' | 'append' = 'replace', contentType?: PublishContentType, useMarkdown = false) {
  // 下载图片（使用 ExtractedImage 对象的 url 属性，优先下载内容图片）
  let downloadedImages: string[] = []
  if (result.images && result.images.length > 0) {
    try {
      // 优先使用 isLikelyContent 标记的内容图片，否则使用全部图片
      const contentImages = result.images.filter((img) => img.isLikelyContent)
      const imagesToDownload = contentImages.length > 0 ? contentImages : result.images
      const imageUrls = imagesToDownload.map((img) => img.url)
      downloadedImages = await electronApi.browser.downloadImages(imageUrls, currentEnvId.value)
    } catch (e) {
      console.warn('[Browser.vue] 图片下载失败:', e)
    }
  }

  if (!publishFormRef.value) return

  // 内容类型映射：PublishContentType -> 表单 contentType
  // 'image-text' -> 'image', 'video' -> 'video', 'article' -> 'article'
  const mapContentType = (ct: PublishContentType): 'video' | 'image' | 'article' => {
    if (ct === 'image-text') return 'image'
    return ct as 'video' | 'article'
  }

  // 自动判断内容类型：图文 > 文章
  // 如果有图片且图片数量 >= 1，优先用图文；否则用文章
  const autoContentType = contentType
    ? mapContentType(contentType)
    : (downloadedImages.length > 0 ? 'image' : 'article') as 'video' | 'image' | 'article'

  // Markdown 转换：仅文章模式且 useMarkdown=true 时启用
  const isArticleMarkdown = autoContentType === 'article' && useMarkdown
  let markdownContent = ''
  if (isArticleMarkdown && result.content) {
    try {
      markdownContent = turndownService.turndown(result.content)
    } catch (e) {
      console.warn('[Browser.vue] HTML转Markdown失败:', e)
    }
  }

  if (mode === 'append') {
    // 追加模式：获取当前表单数据，合并内容
    const current = publishFormRef.value.getFormData()
    const mergedTitle = current.title?.trim()
      ? (result.title && !current.title.includes(result.title) ? `${current.title} / ${result.title}` : current.title)
      : result.title
    const mergedContent = (current.content?.trim() ? current.content + '\n\n' : '') + (result.textContent || '')
    const mergedMedia = [...(current.mediaFiles || []), ...downloadedImages]
    // 合并话题标签
    const currentTags = current.tags || []
    const resultTags = result.tags || []
    const mergedTags = Array.from(new Set([...currentTags, ...resultTags]))

    const fillData: any = {
      contentType: autoContentType,
      title: mergedTitle,
      content: mergedContent,
      mediaFiles: mergedMedia,
      tags: mergedTags,
    }
    if (isArticleMarkdown && markdownContent) {
      fillData.contentMode = 'markdown'
      fillData.markdownContent = (current.markdownContent?.trim() ? current.markdownContent + '\n\n' : '') + markdownContent
    }
    publishFormRef.value.fillForm(fillData)
  } else {
    // 替换模式（默认）：直接填充
    const fillData: any = {
      contentType: autoContentType,
      title: result.title,
      content: result.textContent || '',
      mediaFiles: downloadedImages,
      tags: result.tags || [],
    }
    if (isArticleMarkdown && markdownContent) {
      fillData.contentMode = 'markdown'
      fillData.markdownContent = markdownContent
    }
    publishFormRef.value.fillForm(fillData)
  }
}

/**
 * 手动提取结果插入到光标位置（右键提取/选择器提取使用）
 */
async function insertExtractToForm(result: ExtractedContent) {
  if (!publishFormRef.value) return

  // 下载图片
  let downloadedImages: string[] = []
  if (result.images && result.images.length > 0) {
    try {
      const contentImages = result.images.filter((img) => img.isLikelyContent)
      const imagesToDownload = contentImages.length > 0 ? contentImages : result.images
      downloadedImages = await electronApi.browser.downloadImages(
        imagesToDownload.map((img) => img.url),
        currentEnvId.value,
      )
    } catch (e) {
      console.warn('[Browser.vue] 图片下载失败:', e)
    }
  }

  // 添加图片到媒体列表（不覆盖已有图片）
  if (downloadedImages.length > 0) {
    publishFormRef.value.addImages(downloadedImages)
  }

  // 如果是仅图片提取（右键图片），不插入文本，只添加图片和占位符
  if (result.isImageOnly) {
    if (downloadedImages.length > 0) {
      publishFormRef.value.insertImagePlaceholder(downloadedImages.length)
    }
    return
  }

  // 有文本内容：在光标位置插入
  if (result.textContent && result.textContent.trim()) {
    // 如果标题为空，尝试用提取的标题填充
    const current = publishFormRef.value.getFormData()
    if (!current.title?.trim() && result.title) {
      publishFormRef.value.fillForm({ title: result.title })
    }

    publishFormRef.value.insertTextAtCursor(result.textContent, true)
  }

  // 如果有图片但没有文本，插入图片占位符
  if (downloadedImages.length > 0 && (!result.textContent || !result.textContent.trim())) {
    publishFormRef.value.insertImagePlaceholder(downloadedImages.length)
  }
}

// 一键提取网页内容（自动提取）
async function handleExtractContent() {
  if (!activeTabId.value || isExtracting.value) return
  isExtracting.value = true
  try {
    const result = await electronApi.browser.extractContent(activeTabId.value)
    if (!result) {
      ElMessage.warning('未能提取到文章内容，请确保页面已完全加载')
      extractConfidence.value = null
      return
    }

    // 设置置信度
    extractConfidence.value = typeof result.confidence === 'number' ? result.confidence : null

    // 填充到发布表单
    await fillExtractToForm(result, extractMode.value)

    // 如果是分栏布局，确保右侧可见
    if (layoutMode.value === 'browser-only') {
      layoutMode.value = 'split'
      nextTick(() => updateViewBounds())
    }

    const imgCount = result.images?.filter((img) => img.isLikelyContent).length ?? result.images?.length ?? 0
    const confText = extractConfidence.value != null ? `，置信度 ${Math.round(extractConfidence.value)}%` : ''
    ElMessage.success(`已提取：${result.title?.slice(0, 20) || '无标题'}...（${result.length} 字，${imgCount} 张图${confText}）`)
    console.log('[Browser.vue] 提取结果:', result)
  } catch (e) {
    console.error('[Browser.vue] extract error', e)
    ElMessage.error(`提取失败：${e instanceof Error ? e.message : String(e)}`)
    extractConfidence.value = null
  } finally {
    isExtracting.value = false
  }
}

// 切换规则面板
function toggleRulesPanel() {
  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
  }
  rightPanelTab.value = 'rules'
}

// 切换选择器模式（选择提取）
async function toggleSelectorMode() {
  if (!activeTabId.value) return
  if (selectorActive.value) {
    // 取消选择器
    try {
      await electronApi.browser.stopSelector(activeTabId.value)
    } catch (e) {
      console.warn('[Browser.vue] stopSelector error', e)
    }
    selectorActive.value = false
  } else {
    // 启动选择器
    try {
      const ok = await electronApi.browser.startSelector(activeTabId.value)
      if (!ok) {
        ElMessage.warning('无法启动元素选择器，请确保页面已完全加载')
      }
      // selectorActive 状态由 onSelectorStarted 事件确认后设置为 true
    } catch (e) {
      console.error('[Browser.vue] startSelector error', e)
      ElMessage.error('启动选择器失败')
    }
  }
}

// 根据规则和提取结果解析内容类型和是否使用Markdown
function resolveContentTypeByRule(rule: CustomSiteRule, result: ExtractedContent): { contentType: PublishContentType; useMarkdown: boolean } {
  let contentType: PublishContentType = 'article'
  let useMarkdown = false
  const hasImageText = rule.contentTypes?.includes('image-text')
  const hasArticle = rule.contentTypes?.includes('article')
  const contentLength = result.length || 0

  if (rule.contentTypes && rule.contentTypes.length > 0) {
    if (hasImageText && hasArticle) {
      if (contentLength > 1000) {
        contentType = 'article'
        useMarkdown = true
      } else {
        contentType = 'image-text'
      }
    } else {
      contentType = rule.contentTypes[0] as PublishContentType
    }
  } else if (result.images && result.images.filter(i => i.isLikelyContent).length > 0) {
    contentType = 'image-text'
  }
  return { contentType, useMarkdown }
}

// 处理自动提取结果事件（来自右键菜单"提取正文"）
async function handleExtractResultEvent(data: { viewId: string; result: ExtractedContent }) {
  if (data.viewId !== activeTabId.value) return
  isExtracting.value = false
  if (!data.result) {
    ElMessage.warning('未能提取到文章内容')
    extractConfidence.value = null
    return
  }

  let contentType: PublishContentType = 'article'
  let useMarkdown = false
  const imgCount = data.result.images?.filter(i => i.isLikelyContent).length ?? 0

  // 如果是自定义规则提取，获取规则信息并智能判断
  if (data.result.ruleId) {
    try {
      const rule = await electronApi.browser.getCustomRule(data.result.ruleId)
      if (rule) {
        const resolved = resolveContentTypeByRule(rule, data.result)
        contentType = resolved.contentType
        useMarkdown = resolved.useMarkdown
      } else {
        contentType = imgCount > 0 ? 'image-text' : 'article'
      }
    } catch (e) {
      console.warn('[Browser.vue] 获取规则失败，使用默认判断:', e)
      contentType = imgCount > 0 ? 'image-text' : 'article'
    }
  } else {
    contentType = imgCount > 0 ? 'image-text' : 'article'
  }

  fillExtractToForm(data.result, 'replace', contentType, useMarkdown).catch((e) => {
    console.error('[Browser.vue] fillExtractToForm error', e)
  })
  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
    nextTick(() => updateViewBounds())
  }
  const confText = data.result.confidence != null ? `，置信度 ${Math.round(data.result.confidence)}%` : ''
  const mdHint = useMarkdown ? '，Markdown 模式' : ''
  ElMessage.success(`提取成功：${data.result.length} 字，${imgCount} 张图${confText}${mdHint}`)
}

// 处理规则面板应用提取结果
function handleApplyRule(payload: { rule: CustomSiteRule; result: ExtractedContent }) {
  const { rule, result } = payload
  // 切换到发布 Tab
  rightPanelTab.value = 'publish'

  // 根据规则的 contentTypes 和内容长度决定发布类型
  const { contentType, useMarkdown } = resolveContentTypeByRule(rule, result)

  // 填充表单
  fillExtractToForm(result, 'replace', contentType, useMarkdown).catch((e) => {
    console.error('[Browser.vue] fillExtractToForm error', e)
  })
  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
    nextTick(() => updateViewBounds())
  }
  const imgCount = result.images?.filter((img) => img.isLikelyContent).length ?? result.images?.length ?? 0
  const confText = result.confidence != null ? `，置信度 ${Math.round(result.confidence)}%` : ''
  const mdHint = useMarkdown ? '，Markdown 模式' : ''
  ElMessage.success(`提取成功：${result.length} 字，${imgCount} 张图${confText}${mdHint}`)
}

// 处理提取错误事件
function handleExtractErrorEvent(data: { viewId: string; error: string }) {
  if (data.viewId !== activeTabId.value) return
  isExtracting.value = false
  selectorActive.value = false
  extractConfidence.value = null
  ElMessage.error(`提取失败：${data.error}`)
}

// 处理手动选择提取结果事件（右键提取图片/元素、选择器提取）
function handleManualExtractResultEvent(data: { viewId: string; result: ExtractedContent }) {
  if (data.viewId !== activeTabId.value) return
  isExtracting.value = false
  selectorActive.value = false
  if (!data.result) {
    ElMessage.warning('未能提取到选中元素的内容')
    extractConfidence.value = null
    return
  }
  extractConfidence.value = typeof data.result.confidence === 'number' ? data.result.confidence : null

  // 手动提取使用光标插入模式
  insertExtractToForm(data.result).catch((e) => {
    console.error('[Browser.vue] insertExtractToForm error', e)
  })

  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
    nextTick(() => updateViewBounds())
  }

  const imgCount = data.result.images?.filter((img) => img.isLikelyContent).length ?? data.result.images?.length ?? 0
  if (data.result.isImageOnly) {
    ElMessage.success(`已提取 ${imgCount} 张图片，已添加到媒体列表并插入占位符`)
  } else {
    const confText = extractConfidence.value != null ? `，置信度 ${Math.round(extractConfidence.value)}%` : ''
    ElMessage.success(`已在光标位置插入：${(data.result.title || '').slice(0, 20) || '选中内容'}...（${data.result.length} 字，${imgCount} 张图${confText}）`)
  }
}

// 处理选择器启动事件
function handleSelectorStartedEvent(data: { viewId: string }) {
  if (data.viewId !== activeTabId.value) return
  selectorActive.value = true
  ElMessage.info('点击页面元素提取内容，按 Esc 取消')
}

// 处理选择器取消事件
function handleSelectorCancelledEvent(data: { viewId: string }) {
  if (data.viewId !== activeTabId.value) return
  selectorActive.value = false
}

// ========== 拾取器事件处理 ==========

// 处理拾取器启动（外部触发时切换到规则面板）
function handlePickerStarted(data: { viewId: string; fieldType: PickerFieldType }) {
  if (data.viewId !== activeTabId.value) return
  pickerActive.value = true
  currentPickerField.value = data.fieldType

  // 自动切换到规则面板
  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
  }
  rightPanelTab.value = 'rules'
}

// 处理拾取器结果（主要由 SiteRuleEditor 内部处理，这里仅更新状态）
function handlePickerResult(data: { viewId: string; result: PickerResult }) {
  if (data.viewId !== activeTabId.value) return
  pickerActive.value = false
  currentPickerField.value = null
}

// 处理拾取器取消
function handlePickerCancelled(data: { viewId: string }) {
  if (data.viewId !== activeTabId.value) return
  pickerActive.value = false
  currentPickerField.value = null
}

// 从右键菜单打开规则编辑器
function handleOpenRuleEditor(data: { viewId: string; url: string; mode: 'create' | 'edit' }) {
  if (data.viewId !== activeTabId.value) return
  // 切换到规则面板 tab
  rightPanelTab.value = 'rules'
  // 展开右侧面板（如果是浏览器-only 模式）
  if (layoutMode.value === 'browser-only') {
    layoutMode.value = 'split'
  }
  // 调用规则面板的新建方法
  nextTick(() => {
    browserRulePanelRef.value?.openCreate()
  })
}

// 保存到草稿箱
async function saveToDraft() {
  if (!publishFormRef.value) return
  const formData = publishFormRef.value.getFormData()

  const rawTitle = (formData.title || '').trim()
  const rawContent = (formData.content || '').trim()

  // 提取场景下标题常为空白（手动选择文本块、页面无 h1/og:title、纯图片提取等），
  // 这里兜底生成标题，保证「提取内容 → 保存草稿」始终可走通，不再硬性拦截。
  let finalTitle = rawTitle
  if (!finalTitle && rawContent) {
    finalTitle = rawContent.split('\n').map((l) => l.trim()).find((l) => l)?.slice(0, 40) || rawContent.slice(0, 40)
  }
  if (!finalTitle) {
    finalTitle = (pageTitle.value || '').trim() || currentUrl.value?.trim() || '未命名草稿'
  }

  // 标题与正文都为空，确实没有可保存的内容
  if (!finalTitle && !rawContent) {
    ElMessage.warning('没有可保存的内容')
    return
  }

  // 来源站点名（用于草稿列表展示，提取场景更有意义）
  let sourceSite: string | undefined
  if (pageTitle.value) sourceSite = pageTitle.value.trim()
  else if (currentUrl.value) {
    try {
      sourceSite = new URL(currentUrl.value).hostname.replace(/^www\./, '')
    } catch {
      // ignore
    }
  }

  try {
    await electronApi.draft.create({
      title: finalTitle,
      contentType: formData.contentType || 'article',
      formData: {
        title: finalTitle,
        content: formData.content || '',
        tagsRaw: (formData.tags || []).join(' '),
        mediaFiles: formData.mediaFiles || [],
        coverImage: formData.coverImage || '',
        selectedAccountIds: formData.accountIds || [],
        publishTimeType: 'now',
        scheduledTime: null,
      },
      sourceUrl: currentUrl.value,
      sourceSite,
    })
    ElMessage.success('已保存到草稿箱')
  } catch (e) {
    console.error('[Browser.vue] save draft error', e)
    ElMessage.error('保存草稿失败')
  }
}

// ========== 生命周期 ==========

// 新事件监听器的清理函数引用
let cleanupExtractResult: (() => void) | null = null
let cleanupExtractError: (() => void) | null = null
let cleanupManualExtractResult: (() => void) | null = null
let cleanupSelectorStarted: (() => void) | null = null
let cleanupSelectorCancelled: (() => void) | null = null
let cleanupPickerStarted: (() => void) | null = null
let cleanupPickerResult: (() => void) | null = null
let cleanupPickerCancelled: (() => void) | null = null
let cleanupOpenRuleEditor: (() => void) | null = null

// 全局键盘事件：Esc 取消选择器
function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && selectorActive.value && activeTabId.value) {
    electronApi.browser.stopSelector(activeTabId.value).catch(() => {})
    selectorActive.value = false
  }
}

// 容器尺寸观察器：原生 WebContentsView 的位置/大小全靠测量 .browser-container 的 rect 后 setBounds。
// 工作台所有系统 tab 用 v-show 同挂载，浏览器容器在初始化时常处于 display:none（rect=0），
// 仅有的几处 updateViewBounds 触发（切 tab / 路由 / 拖拽）易漏掉「容器由隐藏变可见」这一关键时机，
// 导致原生视图停在 0 尺寸、内容区空白。ResizeObserver 在容器渲染尺寸变化（含隐藏→可见）时
// 自动重算 bounds，是本 bug 的根因修复；不可见时把原生视图移出屏幕，避免遮挡其它 tab。
let containerResizeObserver: ResizeObserver | null = null
function setupContainerResizeObserver() {
  if (containerResizeObserver || typeof ResizeObserver === 'undefined') return
  const el = browserContainerRef.value
  if (!el) return
  containerResizeObserver = new ResizeObserver(() => {
    if (!el || !activeTabId.value) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      updateViewBounds()
    } else {
      // 容器不可见：把原生视图移出屏幕，防止穿透显示到其它 tab 之上
      hideTabView(activeTabId.value)
    }
  })
  containerResizeObserver.observe(el)
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
  window.addEventListener('keydown', handleGlobalKeydown)
  setupContainerResizeObserver()
  if (electronApi.browser) {
    electronApi.browser.onPageTitleUpdated?.(onPageTitleUpdated)
    electronApi.browser.onPageUrlUpdated?.(onPageUrlUpdated)
    electronApi.browser.onLoadingUpdated?.(onLoadingUpdated)
    electronApi.browser.onEnvChanged?.(onEnvChanged)
    electronApi.browser.onLoadFailed?.(onLoadFailed)
    electronApi.browser.onCertIgnoreChanged?.(onCertIgnoreChanged)
    // 注册内容提取相关事件
    cleanupExtractResult = electronApi.browser.onExtractResult?.(handleExtractResultEvent) ?? null
    cleanupExtractError = electronApi.browser.onExtractError?.(handleExtractErrorEvent) ?? null
    cleanupManualExtractResult = electronApi.browser.onManualExtractResult?.(handleManualExtractResultEvent) ?? null
    cleanupSelectorStarted = electronApi.browser.onSelectorStarted?.(handleSelectorStartedEvent) ?? null
    cleanupSelectorCancelled = electronApi.browser.onSelectorCancelled?.(handleSelectorCancelledEvent) ?? null
    // 注册拾取器相关事件
    cleanupPickerStarted = electronApi.browser.onPickerStarted?.(handlePickerStarted) ?? null
    cleanupPickerResult = electronApi.browser.onPickerResult?.(handlePickerResult) ?? null
    cleanupPickerCancelled = electronApi.browser.onPickerCancelled?.(handlePickerCancelled) ?? null
    // 注册规则编辑器事件
    cleanupOpenRuleEditor = electronApi.browser.onOpenRuleEditor?.(handleOpenRuleEditor) ?? null
  }
  initBrowser()
  // 进入本页时若全局搜索已挂起待打开的 URL，标签就绪后导航
  if (workspaceStore.pendingNavigateUrl) nextTick(consumePendingNavigate)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', handleGlobalKeydown)
  containerResizeObserver?.disconnect()
  containerResizeObserver = null
  stopDrag()
  // 清理搜索防抖定时器
  if (bookmarkSearchTimer) clearTimeout(bookmarkSearchTimer)
  if (historySearchTimer) clearTimeout(historySearchTimer)
  // 清理内容提取事件监听器
  cleanupExtractResult?.()
  cleanupExtractError?.()
  cleanupManualExtractResult?.()
  cleanupSelectorStarted?.()
  cleanupSelectorCancelled?.()
  cleanupPickerStarted?.()
  cleanupPickerResult?.()
  cleanupPickerCancelled?.()
  cleanupOpenRuleEditor?.()
  // 确保选择器模式已关闭
  if (selectorActive.value && activeTabId.value) {
    electronApi.browser.stopSelector?.(activeTabId.value).catch(() => {})
  }
  // 确保拾取器已关闭
  if (pickerActive.value && activeTabId.value) {
    electronApi.browser.stopPicker?.(activeTabId.value).catch(() => {})
  }
  // 销毁所有标签的 view
  if (electronApi.browser) {
    for (const tab of tabs.value) {
      electronApi.browser.destroyView(tab.id).catch(console.error)
    }
    electronApi.browser.removePageTitleUpdatedListener?.(onPageTitleUpdated)
    electronApi.browser.removePageUrlUpdatedListener?.(onPageUrlUpdated)
    electronApi.browser.removeLoadingUpdatedListener?.(onLoadingUpdated)
  }
})

// 监听路由变化，重新调整 bounds
watch(() => route.path, () => {
  nextTick(() => updateViewBounds())
})

// 全局搜索「在浏览器 tab 打开 URL」：URL 写入即尝试导航；默认标签就绪（activeTabId 变化）时也尝试
watch(() => workspaceStore.pendingNavigateUrl, consumePendingNavigate)
watch(activeTabId, () => {
  if (workspaceStore.pendingNavigateUrl) consumePendingNavigate()
})
</script>

<template>
  <div class="browser-page">
    <!-- 标签栏 -->
    <div class="tab-bar">
      <div class="tab-list">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-item"
          :class="{ active: tab.id === activeTabId }"
          @click="switchTab(tab.id)"
        >
          <el-icon v-if="tab.isLoading" class="tab-icon tab-loading"><Loading /></el-icon>
          <span class="tab-title">{{ tab.title }}</span>
          <el-icon
            v-if="tabs.length > 1"
            class="tab-close"
            @click.stop="closeTab(tab.id)"
          >
            <Close />
          </el-icon>
        </div>
      </div>
      <div class="tab-actions">
        <el-button circle size="small" icon="Plus" @click="createTab()" title="新建标签页" />
      </div>
    </div>

    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="nav-buttons">
        <el-button
          icon="House"
          circle
          size="small"
          :disabled="!browserViewId"
          @click="goHome"
          title="主页"
        />
        <el-button :icon="isLoading ? 'Close' : 'Refresh'" circle size="small"
          :disabled="!browserViewId"
          @click="reload"
          :title="isLoading ? '停止' : '刷新'" />
        <el-button icon="ArrowLeft" circle size="small"
          :disabled="!canGoBack"
          @click="goBack"
          title="后退" />
        <el-button icon="ArrowRight" circle size="small"
          :disabled="!canGoForward"
          @click="goForward"
          title="前进" />
        <div class="nav-divider"></div>
        <el-button
          :icon="isCurrentUrlBookmarked ? 'StarFilled' : 'Star'"
          circle
          size="small"
          :disabled="!browserViewId"
          @click="toggleBookmark"
          :class="{ 'btn-bookmark-active': isCurrentUrlBookmarked }"
          :title="isCurrentUrlBookmarked ? '取消收藏' : '添加收藏'"
        />
        <el-button
          icon="Clock"
          circle
          size="small"
          @click="toggleSidebar('history')"
          :class="{ 'btn-sidebar-active': sidebarVisible && sidebarTab === 'history' }"
          title="历史记录"
        />
      </div>

      <div class="url-bar">
        <el-input
          v-model="urlInput"
          placeholder="输入网址或搜索词"
          @keydown="handleUrlKeydown"
          :prefix-icon="isLoading ? 'Loading' : 'Search'"
          clearable
        />
      </div>

      <div class="tool-buttons">
        <el-select
          v-model="currentEnvId"
          size="small"
          style="width: 140px"
          placeholder="选择环境"
          clearable
          popper-class="ws-top-popper"
          @change="handleEnvChange"
          @visible-change="handleEnvDropdownVisible"
        >
          <el-option
            v-for="env in environments"
            :key="env.id"
            :label="env.name"
            :value="env.id"
          />
          <template #empty>
            <div style="padding: 8px; text-align: center; color: #909399; font-size: 12px;">
              暂无环境，请到系统配置中添加
            </div>
          </template>
        </el-select>
        <el-switch
          v-model="ignoreCertErrors"
          size="small"
          active-text="忽略证书"
          inactive-text="证书验证"
          @change="handleCertIgnoreChange"
        />

        <!-- 提取模式切换 -->
        <el-radio-group v-model="extractMode" size="small" class="extract-mode-toggle">
          <el-radio-button value="replace">替换</el-radio-button>
          <el-radio-button value="append">追加</el-radio-button>
        </el-radio-group>

        <!-- 规则管理按钮 -->
        <el-tooltip content="提取规则管理" placement="bottom">
          <el-button
            size="small"
            type="primary"
            plain
            icon="Setting"
            :class="{ 'btn-rules-active': rightPanelTab === 'rules' && layoutMode !== 'browser-only' }"
            @click="toggleRulesPanel"
          >
            规则
          </el-button>
        </el-tooltip>

        <!-- 提取按钮组 -->
        <div class="extract-btn-group">
          <el-button size="small" type="primary" plain icon="MagicStick" :loading="isExtracting" @click="handleExtractContent">
            一键提取
          </el-button>
          <el-tooltip content="点击页面元素提取内容" placement="bottom">
            <el-button
              size="small"
              :type="selectorActive ? 'warning' : 'primary'"
              plain
              icon="Aim"
              :class="{ 'btn-selector-active': selectorActive }"
              :disabled="!browserViewId || isExtracting"
              @click="toggleSelectorMode"
            >
              选择提取
            </el-button>
          </el-tooltip>
          <!-- 置信度徽章 -->
          <el-tag
            v-if="extractConfidence != null"
            :type="extractConfidence >= 70 ? 'success' : extractConfidence >= 40 ? 'warning' : 'danger'"
            size="small"
            class="confidence-badge"
            effect="light"
            round
          >
            置信度: {{ Math.round(extractConfidence) }}%
          </el-tag>
        </div>

        <el-dropdown popper-class="ws-top-popper" @command="setLayoutMode" @visible-change="handleLayoutDropdownVisible">
          <el-button size="small" icon="Grid">
            布局
            <el-icon class="el-icon--right"><arrow-down /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="browser-only" :divided="layoutMode === 'browser-only'">
                仅浏览器
              </el-dropdown-item>
              <el-dropdown-item command="split" :divided="layoutMode === 'split'">
                左右分栏
              </el-dropdown-item>
              <el-dropdown-item command="publish-only" :divided="layoutMode === 'publish-only'">
                仅发布表单
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="content-area">
      <!-- 左侧浏览器区 -->
      <div
        v-show="layoutMode !== 'publish-only'"
        class="browser-container"
        :class="{ 'selector-active': selectorActive }"
        :style="{ width: layoutMode === 'split' ? leftWidth + '%' : '100%' }"
        ref="browserContainerRef"
      >
        <div v-if="!browserViewId" class="browser-placeholder">
          <el-icon size="48" color="#c0c4cc"><Monitor /></el-icon>
          <p>浏览器加载中…</p>
        </div>
        <!-- 选择器模式激活提示覆盖层 -->
        <div v-if="selectorActive" class="selector-overlay">
          <div class="selector-hint-badge">
            <el-icon><Aim /></el-icon>
            <span>选择提取模式：点击页面元素提取内容，按 Esc 取消</span>
          </div>
        </div>
      </div>

      <!-- 分割条 -->
      <div
        v-if="layoutMode === 'split'"
        class="divider"
        :class="{ dragging: isDragging }"
        @mousedown="startDrag"
      >
        <div class="divider-handle"></div>
      </div>

      <!-- 右侧面板区（发布/规则） -->
      <div
        v-show="layoutMode !== 'browser-only'"
        class="right-panel"
        :style="{ width: layoutMode === 'split' ? (100 - leftWidth) + '%' : '100%' }"
      >
        <!-- 右侧 Tab 头 -->
        <div class="right-panel-tabs">
          <div
            class="right-tab"
            :class="{ active: rightPanelTab === 'publish' }"
            @click="rightPanelTab = 'publish'"
          >
            <el-icon><Edit /></el-icon>
            <span>发布编辑</span>
          </div>
          <div
            class="right-tab"
            :class="{ active: rightPanelTab === 'rules' }"
            @click="rightPanelTab = 'rules'"
          >
            <el-icon><Setting /></el-icon>
            <span>提取规则</span>
          </div>
        </div>

        <!-- 发布表单 -->
        <div v-show="rightPanelTab === 'publish'" class="tab-content">
          <PublishForm
            ref="publishFormRef"
            @submit="handlePublishSubmit"
            @test-submit="handleTestSubmit"
            @modal-show="handleModalShow"
            @modal-hide="handleModalHide"
          >
            <template #footer-extra>
              <el-button :disabled="isExtracting" icon="Document" @click="saveToDraft">保存草稿</el-button>
            </template>
          </PublishForm>
        </div>

        <!-- 规则面板 -->
        <div v-show="rightPanelTab === 'rules'" class="tab-content">
          <BrowserRulePanel
            ref="browserRulePanelRef"
            :current-url="currentUrl"
            :view-id="browserViewId"
            @apply-rule="handleApplyRule"
          />
        </div>
      </div>
    </div>

    <!-- 左侧侧边栏（收藏夹 / 历史记录） -->
    <transition name="sidebar-slide">
      <div v-if="sidebarVisible" class="sidebar-mask" @click="closeSidebar">
        <div class="sidebar-panel" @click.stop>
          <!-- 侧边栏头部 Tab -->
          <div class="sidebar-header">
            <div class="sidebar-tabs">
              <div
                class="sidebar-tab"
                :class="{ active: sidebarTab === 'bookmarks' }"
                @click="switchSidebarTab('bookmarks')"
              >
                <el-icon><Star /></el-icon>
                <span>收藏夹</span>
              </div>
              <div
                class="sidebar-tab"
                :class="{ active: sidebarTab === 'history' }"
                @click="switchSidebarTab('history')"
              >
                <el-icon><Clock /></el-icon>
                <span>历史记录</span>
              </div>
            </div>
            <el-icon class="sidebar-close" @click="closeSidebar"><Close /></el-icon>
          </div>

          <!-- 搜索框 -->
          <div class="sidebar-search">
            <el-input
              v-if="sidebarTab === 'bookmarks'"
              v-model="bookmarkSearchKeyword"
              placeholder="搜索收藏夹"
              prefix-icon="Search"
              clearable
              size="small"
              @input="handleBookmarkSearch"
            />
            <el-input
              v-else
              v-model="historySearchKeyword"
              placeholder="搜索历史记录"
              prefix-icon="Search"
              clearable
              size="small"
              @input="handleHistorySearch"
            />
          </div>

          <!-- 列表内容 -->
          <div class="sidebar-list">
            <!-- 收藏夹列表 -->
            <div v-if="sidebarTab === 'bookmarks'" class="list-content">
              <div v-if="bookmarkList.length === 0" class="list-empty">
                <el-icon size="32" color="#c0c4cc"><Star /></el-icon>
                <p>暂无收藏</p>
              </div>
              <div
                v-for="item in bookmarkList"
                :key="item.id"
                class="list-item"
                @click="openUrlInCurrentTab(item.url)"
              >
                <div class="item-icon bookmark-icon">
                  <el-icon><Star /></el-icon>
                </div>
                <div class="item-info">
                  <div class="item-title" :title="item.title">{{ item.title }}</div>
                  <div class="item-url" :title="item.url">{{ item.url }}</div>
                </div>
                <el-icon
                  class="item-delete"
                  title="删除收藏"
                  @click.stop="deleteBookmark(item)"
                >
                  <Close />
                </el-icon>
              </div>
            </div>

            <!-- 历史记录列表 -->
            <div v-else class="list-content">
              <div v-if="historyList.length === 0" class="list-empty">
                <el-icon size="32" color="#c0c4cc"><Clock /></el-icon>
                <p>暂无历史记录</p>
              </div>
              <div
                v-for="item in historyList"
                :key="item.id"
                class="list-item"
                @click="openUrlInCurrentTab(item.url)"
              >
                <div class="item-icon history-icon">
                  <el-icon><Clock /></el-icon>
                </div>
                <div class="item-info">
                  <div class="item-title" :title="item.title">{{ item.title }}</div>
                  <div class="item-time">{{ formatVisitTime(item.visitTime) }}</div>
                </div>
                <el-icon
                  class="item-delete"
                  title="删除记录"
                  @click.stop="deleteHistoryItem(item)"
                >
                  <Close />
                </el-icon>
              </div>
            </div>
          </div>

          <!-- 历史记录底部操作 -->
          <div v-if="sidebarTab === 'history' && historyList.length > 0" class="sidebar-footer">
            <el-button
              size="small"
              type="danger"
              plain
              icon="Delete"
              @click="clearAllHistory"
            >
              清除全部
            </el-button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 拾取器提示 -->
    <transition name="fade">
      <div v-if="pickerActive" class="picker-toast">
        <el-icon><Mouse /></el-icon>
        请在页面上点击选择元素，按 Esc 取消
      </div>
    </transition>
  </div>
</template>

<style scoped>
.browser-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

/* ========== 标签栏 ========== */
.tab-bar {
  display: flex;
  align-items: center;
  background: #f1f3f4;
  padding: 6px 8px 0 8px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  gap: 6px;
}

.tab-list {
  display: flex;
  flex: 1;
  gap: 2px;
  overflow: hidden;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 100px;
  max-width: 200px;
  height: 32px;
  padding: 0 10px;
  background: #e8eaed;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: background 0.15s;
}

.tab-item:hover {
  background: #dfe1e4;
}

.tab-item.active {
  background: #fff;
}

.tab-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: #909399;
}

.tab-loading {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tab-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  flex-shrink: 0;
  font-size: 14px;
  color: #909399;
  padding: 2px;
  border-radius: 50%;
  transition: all 0.15s;
}

.tab-close:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #606266;
}

.tab-actions {
  flex-shrink: 0;
  padding-bottom: 4px;
}

/* ========== 工具栏 ========== */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.nav-buttons {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.url-bar {
  flex: 1;
  min-width: 0;
}

.tool-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* ========== 内容区 ========== */
.content-area {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.browser-container {
  height: 100%;
  position: relative;
  background: var(--surface-2);
  overflow: hidden;
}

.browser-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #909399;
  gap: 12px;
}

.divider {
  width: 4px;
  background: var(--line);
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  transition: background 0.2s;
}

.divider:hover,
.divider.dragging {
  background: var(--brand-indigo);
}

.divider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 40px;
  background: #c0c4cc;
  border-radius: 1px;
}

.divider:hover .divider-handle,
.divider.dragging .divider-handle {
  background: #fff;
}

.publish-container {
  height: 100%;
  background: var(--surface-2);
  overflow: hidden;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

/* ========== 右侧面板（Tab 结构） ========== */
.right-panel {
  height: 100%;
  background: #f5f7fa;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.right-panel-tabs {
  display: flex;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  flex-shrink: 0;
}

.right-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  font-size: 14px;
  color: #606266;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  position: relative;
}

.right-tab:hover {
  color: #409eff;
}

.right-tab.active {
  color: #409eff;
  border-bottom-color: #409eff;
  font-weight: 500;
}

.tab-badge {
  margin-left: 2px;
}

.tab-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 发布表单在 tab 内容中的样式 */
.tab-content > :deep(.publish-form) {
  height: 100%;
  overflow-y: auto;
}

/* ========== 导航按钮分隔线 ========== */
.nav-divider {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 4px;
}

.btn-bookmark-active :deep(.el-icon) {
  color: var(--warning);
}

.btn-sidebar-active :deep(.el-icon) {
  color: var(--brand-indigo);
}

/* ========== 侧边栏 ========== */
.sidebar-mask {
  position: fixed;
  /* 根治：遮罩 z-index 压到内容区层级(60,低于顶栏 chrome 的 100)，
     顶栏(.ws-tabbar z-index:100)整体在其之上——任何顶栏弹层(含未 Teleport 的)天然不被盖。
     顶栏下拉/右键/搜索面板仍额外 Teleport 到 body 并顶到 99999/100000 作双保险；
     PublishForm 全屏模态 z-index:9000 > 100，不受影响。 */
  top: 48px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 60;
  display: flex;
}

.sidebar-panel {
  width: 300px;
  height: 100%;
  background: #fff;
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 侧边栏滑入动画 */
.sidebar-slide-enter-active,
.sidebar-slide-leave-active {
  transition: opacity 0.25s ease;
}

.sidebar-slide-enter-active .sidebar-panel,
.sidebar-slide-leave-active .sidebar-panel {
  transition: transform 0.25s ease;
}

.sidebar-slide-enter-from,
.sidebar-slide-leave-to {
  opacity: 0;
}

.sidebar-slide-enter-from .sidebar-panel,
.sidebar-slide-leave-to .sidebar-panel {
  transform: translateX(-100%);
}

/* 侧边栏头部 */
.sidebar-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  gap: 8px;
}

.sidebar-tabs {
  flex: 1;
  display: flex;
  gap: 4px;
}

.sidebar-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.sidebar-tab:hover {
  background: var(--surface-2);
}

.sidebar-tab.active {
  background: #ecf5ff;
  color: var(--brand-indigo);
  font-weight: 500;
}

.sidebar-tab .el-icon {
  font-size: 14px;
}

.sidebar-close {
  flex-shrink: 0;
  font-size: 16px;
  color: #909399;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s;
}

.sidebar-close:hover {
  background: var(--surface-2);
  color: #606266;
}

/* 搜索框 */
.sidebar-search {
  padding: 10px 12px;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}

/* 列表区域 */
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.list-content {
  padding: 4px 0;
}

.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #c0c4cc;
  gap: 8px;
}

.list-empty p {
  margin: 0;
  font-size: 13px;
}

/* 列表项 */
.list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.list-item:hover {
  background: var(--surface-2);
}

.item-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 14px;
}

.bookmark-icon {
  background: #fdf6ec;
  color: var(--warning);
}

.history-icon {
  background: #ecf5ff;
  color: var(--brand-indigo);
}

.item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-title {
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.item-url {
  font-size: 11px;
  color: #909399;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-time {
  font-size: 11px;
  color: #909399;
}

.item-delete {
  flex-shrink: 0;
  font-size: 14px;
  color: #c0c4cc;
  padding: 4px;
  border-radius: 4px;
  opacity: 0;
  transition: all 0.15s;
}

.list-item:hover .item-delete {
  opacity: 1;
}

.item-delete:hover {
  background: #fef0f0;
  color: #f56c6c;
}

/* 侧边栏底部 */
.sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid #ebeef5;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}

/* ========== 内容提取优化样式 ========== */

/* 提取模式切换 */
.extract-mode-toggle {
  flex-shrink: 0;
}

.extract-mode-toggle :deep(.el-radio-button__inner) {
  padding: 5px 10px;
  font-size: 12px;
}

/* 提取按钮组 */
.extract-btn-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 选择提取按钮激活状态 */
.btn-selector-active {
  animation: pulse-border 1.5s ease-in-out infinite;
}

.btn-rules-active {
  background-color: #ecf5ff !important;
  border-color: #409eff !important;
  color: #409eff !important;
}

@keyframes pulse-border {
  0%, 100% { box-shadow: 0 0 0 0 rgba(230, 162, 60, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(230, 162, 60, 0); }
}

/* 置信度徽章 */
.confidence-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 500;
}

/* 选择器模式激活时的浏览器容器边框 */
.browser-container.selector-active {
  outline: 2px solid var(--warning);
  outline-offset: -2px;
}

/* 选择器模式提示覆盖层 */
.selector-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: 8px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.selector-hint-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: linear-gradient(135deg, var(--warning), #f0c78a);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  border-radius: 20px;
  box-shadow: 0 2px 12px rgba(230, 162, 60, 0.4);
  pointer-events: auto;
  animation: bounce-in 0.3s ease-out;
}

.selector-hint-badge .el-icon {
  font-size: 16px;
  animation: pulse-icon 1.5s ease-in-out infinite;
}

@keyframes bounce-in {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes pulse-icon {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.2); }
}

/* 拾取器提示 Toast */
.picker-toast {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(64, 158, 255, 0.95);
  color: #fff;
  padding: 10px 20px;
  border-radius: 20px;
  font-size: 14px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.4);
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
