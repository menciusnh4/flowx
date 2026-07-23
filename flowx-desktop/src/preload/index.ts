import { contextBridge, ipcRenderer } from 'electron';
import type {
  AccountInfo,
  PlatformMeta,
  PlatformType,
  PublishRequest,
  ProgressInfo,
  PublishTask,
  SystemInfo,
  UpdateInfo,
  PublishStatus,
  PublishLogEntry,
  PublishLogQuery,
  HealthCheckConfig,
  PagedResult,
  PublishStats,
  AccountCategory,
  ProxyConfig,
  BrowserEnvironment,
  ProxyTestResult,
  PublishDraft,
  BrowserBookmark,
  BrowserBookmarkFolder,
  BrowserHistoryItem,
  ExtractedContent,
  ExtractedImage,
  ComplianceScanRequest,
  ComplianceResult,
  ComplianceSettings,
  CustomSiteRule,
  PickerFieldType,
  PickerResult,
  RuleDraft,
  RuleTestResult,
  PublishContentType,
} from '../types';

// Preload 脚本：通过 contextBridge 暴露安全 API
// - 只允许白名单函数
// - 主进程响应统一为 { ok, data, error }

interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>;
  if (!res.ok) throw new Error(res.error || '未知错误');
  return res.data as T;
}

export interface PublishStatusEvent {
  taskId: string;
  status: PublishStatus;
  items: { accountId: string; platform: PlatformType; status: PublishStatus; progress: number; message?: string; resultUrl?: string }[];
  overallProgress: number;
}

// 暴露给 window.electron
contextBridge.exposeInMainWorld('electron', {
  // ========== 账号相关 ==========
  account: {
    listPlatforms: (): Promise<PlatformMeta[]> => invoke('account:listPlatforms'),
    list: (): Promise<AccountInfo[]> => invoke('account:list'),
    get: (id: string): Promise<AccountInfo | null> => invoke('account:get', id),
    beginAuth: (platform: PlatformType, envId?: string | null): Promise<AccountInfo> =>
      invoke('account:beginAuth', platform, envId),
    delete: (id: string): Promise<boolean> => invoke('account:delete', id),
    update: (
      id: string,
      patch: { nickname?: string; remark?: string; categoryIds?: string[]; envId?: string | null },
    ): Promise<AccountInfo | null> => invoke('account:update', id, patch),
    refresh: (id: string): Promise<AccountInfo> => invoke('account:refresh', id),
    openCreator: (
      id: string,
    ): Promise<{
      ok: boolean;
      url: string;
      injected: number;
      skipped: number;
      failed: number;
      error?: string;
    }> => invoke('account:openCreator', id),
    /** M3：以「内嵌主窗口」方式打开创作中心 */
    openAccountTab: (id: string): Promise<{ ok: boolean; url?: string; error?: string }> =>
      invoke('account:openAccountTab', id),
    /** 静默检测单个账号的登录态 */
    healthCheck: (id: string): Promise<AccountInfo | null> => invoke('account:healthCheck', id),
    /** 静默检测所有账号 */
    healthCheckAll: (): Promise<AccountInfo[]> => invoke('account:healthCheckAll'),
    /** 配置定时检测：intervalMs 为毫秒间隔 */
    setHealthCheckInterval: (intervalMs: number, initialDelayMs = 0): Promise<boolean> =>
      invoke('account:setHealthCheckInterval', intervalMs, initialDelayMs),
    /** 获取当前健康检测配置 */
    getHealthCheckConfig: (): Promise<HealthCheckConfig> => invoke('account:getHealthCheckConfig'),
    /** 更新健康检测配置（同时持久化保存 + 重启定时器） */
    setHealthCheckConfig: (cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }): Promise<HealthCheckConfig> =>
      invoke('account:setHealthCheckConfig', cfg),

    // ========== 分类管理 ==========
    listCategories: (): Promise<AccountCategory[]> => invoke('account:listCategories'),
    createCategory: (name: string): Promise<AccountCategory> =>
      invoke('account:createCategory', name),
    updateCategory: (id: string, name: string): Promise<AccountCategory | null> =>
      invoke('account:updateCategory', id, name),
    deleteCategory: (id: string): Promise<boolean> => invoke('account:deleteCategory', id),
  },

  // ========== 发布相关 ==========
  publish: {
    submit: (req: PublishRequest): Promise<string> => invoke('publish:submit', req),
    progress: (taskId: string): Promise<ProgressInfo | null> =>
      invoke('publish:progress', taskId),
    cancel: (taskId: string): Promise<boolean> => invoke('publish:cancel', taskId),
    list: (): Promise<PublishTask[]> => invoke('publish:list'),
    listPaged: (page?: number, pageSize?: number): Promise<PagedResult<PublishTask>> =>
      invoke('publish:listPaged', page, pageSize),
    getStats: (): Promise<PublishStats> => invoke('publish:getStats'),
    retry: (taskId: string): Promise<string | null> => invoke('publish:retry', taskId),
    retryAsTest: (taskId: string): Promise<string | null> => invoke('publish:retryAsTest', taskId),
    retryAsPublish: (taskId: string): Promise<string | null> => invoke('publish:retryAsPublish', taskId),
    detail: (taskId: string): Promise<{ task: PublishTask | null; logs: PublishLogEntry[] }> =>
      invoke('publish:detail', taskId),
    delete: (taskId: string): Promise<boolean> => invoke('publish:delete', taskId),
    setConcurrency: (n: number): Promise<boolean> => invoke('publish:setConcurrency', n),

    // 日志相关
    getLogPaths: (): Promise<{ publishLog: string; mainLog: string; dir: string }> =>
      invoke('publish:getLogPaths'),
    openLogDir: (): Promise<boolean> => invoke('publish:openLogDir'),
    queryLogs: (query?: PublishLogQuery): Promise<PublishLogEntry[]> =>
      invoke('publish:queryLogs', query || {}),
    clearLogs: (): Promise<boolean> => invoke('publish:clearLogs'),

    // 订阅主进程推送的发布状态变更
    onStatusChanged: (cb: (evt: PublishStatusEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: PublishStatusEvent) => cb(payload);
      ipcRenderer.on('publish:statusChanged', handler);
      return () => ipcRenderer.removeListener('publish:statusChanged', handler);
    },
  },

  // ========== 系统相关 ==========
  system: {
    openExternal: (url: string): Promise<boolean> => invoke('system:openExternal', url),
    getInfo: (): Promise<SystemInfo> => invoke('system:getInfo'),
    readChangelog: (): Promise<string> => invoke('system:readChangelog'),
    openFileDialog: (
      options?: { mode?: 'file' | 'files'; filters?: Electron.FileFilter[] },
    ): Promise<{ canceled: boolean; filePaths: string[] }> =>
      invoke('system:openFileDialog', options),
    showSaveDialog: (
      options?: Electron.SaveDialogOptions,
    ): Promise<{ canceled: boolean; filePath?: string }> =>
      invoke('system:showSaveDialog', options),
    minimizeWindow: (): Promise<boolean> => invoke('system:minimizeWindow'),
    closeWindow: (): Promise<boolean> => invoke('system:closeWindow'),
    // 窗口最大化/还原（toggle）
    maximizeWindow: (): Promise<boolean> => invoke('system:maximizeWindow'),
    isMaximizedWindow: (): Promise<boolean> => invoke('system:isMaximizedWindow'),
    // 自定义边缘缩放：读取/设置窗口几何
    getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      invoke('system:getWindowBounds'),
    setWindowBounds: (b: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      invoke('system:setWindowBounds', b),
    // 原生菜单（用于顶部导航栏下拉，避免 WebContentsView 遮挡）
    popupNativeMenu: (
      items: Array<{ id: string; label: string; enabled?: boolean; type?: 'normal' | 'separator' | 'submenu'; submenu?: any[] }>,
      x?: number,
      y?: number,
    ): Promise<string | null> => invoke('system:popupNativeMenu', items, x, y),
  },

  // ========== 日志管理 ==========
  log: {
    readMain: (options?: { limit?: number; date?: string }): Promise<string> => invoke('log:readMain', options),
    readPublish: (options?: { limit?: number; date?: string }): Promise<string> => invoke('log:readPublish', options),
    listFiles: (type: 'main' | 'publish'): Promise<{ date: string; path: string; size: number }[]> =>
      invoke('log:listFiles', type),
    queryPublish: (query?: PublishLogQuery): Promise<PublishLogEntry[]> => invoke('log:queryPublish', query),
    clearPublish: (): Promise<boolean> => invoke('log:clearPublish'),
    openDir: (): Promise<boolean> => invoke('log:openDir'),
    'export': (type: 'main' | 'publish' | 'all'): Promise<{ ok: boolean; path?: string; error?: string }> =>
      invoke('log:export', type),
    getInfo: (): Promise<{
      mainSize: number;
      publishSize: number;
      logsDir: string;
      mainPath: string;
      publishPath: string;
    }> => invoke('log:getInfo'),
  },

  // ========== 草稿箱 ==========
  draft: {
    list: (contentType?: string): Promise<PublishDraft[]> => invoke('draft:list', contentType),
    get: (id: string): Promise<PublishDraft | null> => invoke('draft:get', id),
    create: (data: unknown): Promise<PublishDraft> => invoke('draft:create', data),
    update: (id: string, patch: unknown): Promise<PublishDraft | null> => invoke('draft:update', id, patch),
    delete: (id: string): Promise<boolean> => invoke('draft:delete', id),
    search: (keyword: string): Promise<PublishDraft[]> => invoke('draft:search', keyword),
  },

  // ========== 浏览器 ==========
  browser: {
    createView: (options?: { url?: string }): Promise<{
      viewId: string;
      title: string;
      url: string;
      isLoading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }> => invoke('browser:createView', options),
    destroyView: (viewId: string): Promise<boolean> => invoke('browser:destroyView', viewId),
    setBounds: (viewId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      invoke('browser:setBounds', viewId, bounds),
    navigate: (viewId: string, url: string): Promise<boolean> => invoke('browser:navigate', viewId, url),
    goBack: (viewId: string): Promise<boolean> => invoke('browser:goBack', viewId),
    goForward: (viewId: string): Promise<boolean> => invoke('browser:goForward', viewId),
    reload: (viewId: string): Promise<boolean> => invoke('browser:reload', viewId),
    stop: (viewId: string): Promise<boolean> => invoke('browser:stop', viewId),
    switchEnv: (viewId: string, envId: string | null): Promise<boolean> => invoke('browser:switchEnv', viewId, envId),
    setIgnoreCertErrors: (viewId: string, ignore: boolean): Promise<boolean> => invoke('browser:setIgnoreCertErrors', viewId, ignore),
    isIgnoringCertErrors: (viewId: string): Promise<boolean> => invoke('browser:isIgnoringCertErrors', viewId),
    extractContent: (viewId: string): Promise<ExtractedContent | null> => invoke('browser:extractContent', viewId),
    manualExtract: (viewId: string, selector: string): Promise<ExtractedContent | null> => invoke('browser:manualExtract', viewId, selector),
    startSelector: (viewId: string): Promise<boolean> => invoke('browser:startSelector', viewId),
    stopSelector: (viewId: string): Promise<boolean> => invoke('browser:stopSelector', viewId),
    downloadImages: (imageUrls: string[], envId?: string | null): Promise<string[]> => invoke('browser:downloadImages', imageUrls, envId),
    getImageDataUrl: (filePath: string): Promise<string> => invoke('browser:getImageDataUrl', filePath),

    // 自定义站点规则
    listCustomRules: (): Promise<CustomSiteRule[]> => invoke('browser:listCustomRules'),
    getCustomRule: (id: string): Promise<CustomSiteRule | null> => invoke('browser:getCustomRule', id),
    createCustomRule: (data: Omit<CustomSiteRule, 'id' | 'createdAt' | 'updatedAt' | 'useCount'>): Promise<CustomSiteRule> =>
      invoke('browser:createCustomRule', data),
    updateCustomRule: (id: string, patch: Partial<CustomSiteRule>): Promise<CustomSiteRule | null> =>
      invoke('browser:updateCustomRule', id, patch),
    deleteCustomRule: (id: string): Promise<boolean> => invoke('browser:deleteCustomRule', id),
    toggleCustomRule: (id: string): Promise<boolean> => invoke('browser:toggleCustomRule', id),
    testCustomRule: (viewId: string, rule: Partial<CustomSiteRule> & { contentSelector: string }): Promise<ExtractedContent | null> =>
      invoke('browser:testCustomRule', viewId, rule),
    applyCustomRule: (viewId: string, ruleId: string): Promise<ExtractedContent | null> =>
      invoke('browser:applyCustomRule', viewId, ruleId),

    // 元素拾取器
    startPicker: (viewId: string, fieldType: PickerFieldType, mode?: 'single' | 'multi'): Promise<boolean> =>
      invoke('browser:startPicker', viewId, fieldType, mode),
    stopPicker: (viewId: string): Promise<boolean> => invoke('browser:stopPicker', viewId),

    // 发布类型同步
    setCurrentPublishType: (type: PublishContentType): Promise<boolean> =>
      invoke('browser:setCurrentPublishType', type),

    // 订阅页面状态更新
    onPageTitleUpdated: (cb: (data: { viewId: string; title: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; title: string }) => cb(payload);
      ipcRenderer.on('browser:titleUpdated', handler);
      return () => ipcRenderer.removeListener('browser:titleUpdated', handler);
    },
    onPageUrlUpdated: (cb: (data: { viewId: string; url: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; url: string }) => cb(payload);
      ipcRenderer.on('browser:urlUpdated', handler);
      return () => ipcRenderer.removeListener('browser:urlUpdated', handler);
    },
    onLoadingUpdated: (cb: (data: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) => cb(payload);
      ipcRenderer.on('browser:loadingUpdated', handler);
      return () => ipcRenderer.removeListener('browser:loadingUpdated', handler);
    },
    onEnvChanged: (cb: (data: { viewId: string; envId: string | null }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; envId: string | null }) => cb(payload);
      ipcRenderer.on('browser:envChanged', handler);
      return () => ipcRenderer.removeListener('browser:envChanged', handler);
    },
    onLoadFailed: (cb: (data: { viewId: string; errorCode: number; errorDescription: string; url: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; errorCode: number; errorDescription: string; url: string }) => cb(payload);
      ipcRenderer.on('browser:loadFailed', handler);
      return () => ipcRenderer.removeListener('browser:loadFailed', handler);
    },
    onCertIgnoreChanged: (cb: (data: { viewId: string; ignore: boolean }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; ignore: boolean }) => cb(payload);
      ipcRenderer.on('browser:certIgnoreChanged', handler);
      return () => ipcRenderer.removeListener('browser:certIgnoreChanged', handler);
    },
    onExtractResult: (cb: (data: { viewId: string; result: ExtractedContent }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; result: ExtractedContent }) => cb(payload);
      ipcRenderer.on('browser:extractResult', handler);
      return () => ipcRenderer.removeListener('browser:extractResult', handler);
    },
    onExtractError: (cb: (data: { viewId: string; error: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; error: string }) => cb(payload);
      ipcRenderer.on('browser:extractError', handler);
      return () => ipcRenderer.removeListener('browser:extractError', handler);
    },
    onManualExtractResult: (cb: (data: { viewId: string; result: ExtractedContent }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; result: ExtractedContent }) => cb(payload);
      ipcRenderer.on('browser:manualExtractResult', handler);
      return () => ipcRenderer.removeListener('browser:manualExtractResult', handler);
    },
    onSelectorStarted: (cb: (data: { viewId: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string }) => cb(payload);
      ipcRenderer.on('browser:selectorStarted', handler);
      return () => ipcRenderer.removeListener('browser:selectorStarted', handler);
    },
    onSelectorCancelled: (cb: (data: { viewId: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string }) => cb(payload);
      ipcRenderer.on('browser:selectorCancelled', handler);
      return () => ipcRenderer.removeListener('browser:selectorCancelled', handler);
    },

    // 拾取器事件
    onPickerStarted: (cb: (data: { viewId: string; fieldType: PickerFieldType }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; fieldType: PickerFieldType }) => cb(payload);
      ipcRenderer.on('browser:pickerStarted', handler);
      return () => ipcRenderer.removeListener('browser:pickerStarted', handler);
    },
    onPickerResult: (cb: (data: { viewId: string; result: PickerResult }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; result: PickerResult }) => cb(payload);
      ipcRenderer.on('browser:pickerResult', handler);
      return () => ipcRenderer.removeListener('browser:pickerResult', handler);
    },
    onPickerCancelled: (cb: (data: { viewId: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string }) => cb(payload);
      ipcRenderer.on('browser:pickerCancelled', handler);
      return () => ipcRenderer.removeListener('browser:pickerCancelled', handler);
    },
    // 打开规则编辑器
    onOpenRuleEditor: (cb: (data: { viewId: string; url: string; mode: 'create' | 'edit' }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { viewId: string; url: string; mode: 'create' | 'edit' }) => cb(payload);
      ipcRenderer.on('browser:openRuleEditor', handler);
      return () => ipcRenderer.removeListener('browser:openRuleEditor', handler);
    },

    // 移除监听器的便捷方法
    removePageTitleUpdatedListener: (cb: (data: { viewId: string; title: string }) => void): void => {
      ipcRenderer.removeListener('browser:titleUpdated', cb as (...args: unknown[]) => void);
    },
    removePageUrlUpdatedListener: (cb: (data: { viewId: string; url: string }) => void): void => {
      ipcRenderer.removeListener('browser:urlUpdated', cb as (...args: unknown[]) => void);
    },
    removeLoadingUpdatedListener: (cb: (data: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) => void): void => {
      ipcRenderer.removeListener('browser:loadingUpdated', cb as (...args: unknown[]) => void);
    },
  },

  // ========== 浏览器收藏夹与历史记录 ==========
  browserHistory: {
    // 收藏夹
    listBookmarks: (folderId?: string | null): Promise<BrowserBookmark[]> =>
      invoke('browserHistory:listBookmarks', folderId),
    listAllBookmarks: (): Promise<BrowserBookmark[]> =>
      invoke('browserHistory:listAllBookmarks'),
    isBookmarked: (url: string): Promise<boolean> =>
      invoke('browserHistory:isBookmarked', url),
    addBookmark: (data: { url: string; title: string; siteName?: string; folderId?: string }): Promise<BrowserBookmark> =>
      invoke('browserHistory:addBookmark', data),
    updateBookmark: (id: string, patch: Partial<Pick<BrowserBookmark, 'title' | 'url' | 'folderId' | 'siteName'>>): Promise<BrowserBookmark | null> =>
      invoke('browserHistory:updateBookmark', id, patch),
    deleteBookmark: (id: string): Promise<boolean> =>
      invoke('browserHistory:deleteBookmark', id),
    deleteBookmarkByUrl: (url: string): Promise<boolean> =>
      invoke('browserHistory:deleteBookmarkByUrl', url),
    searchBookmarks: (keyword: string): Promise<BrowserBookmark[]> =>
      invoke('browserHistory:searchBookmarks', keyword),
    listBookmarkFolders: (): Promise<BrowserBookmarkFolder[]> =>
      invoke('browserHistory:listBookmarkFolders'),
    createBookmarkFolder: (name: string, parentId?: string): Promise<BrowserBookmarkFolder> =>
      invoke('browserHistory:createBookmarkFolder', name, parentId),
    deleteBookmarkFolder: (folderId: string): Promise<boolean> =>
      invoke('browserHistory:deleteBookmarkFolder', folderId),

    // 历史记录
    listHistory: (limit?: number): Promise<BrowserHistoryItem[]> =>
      invoke('browserHistory:listHistory', limit),
    listHistoryPaged: (page?: number, pageSize?: number): Promise<{
      items: BrowserHistoryItem[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    }> =>
      invoke('browserHistory:listHistoryPaged', page, pageSize),
    addHistory: (data: { url: string; title: string; viewId?: string }): Promise<BrowserHistoryItem> =>
      invoke('browserHistory:addHistory', data),
    deleteHistory: (id: string): Promise<boolean> =>
      invoke('browserHistory:deleteHistory', id),
    clearHistory: (beforeTs?: number): Promise<number> =>
      invoke('browserHistory:clearHistory', beforeTs),
    searchHistory: (keyword: string, limit?: number): Promise<BrowserHistoryItem[]> =>
      invoke('browserHistory:searchHistory', keyword, limit),
    getHistoryStats: (): Promise<{ total: number; today: number; thisWeek: number }> =>
      invoke('browserHistory:getHistoryStats'),
  },

  // ========== 创作中心 Tab 栏（仅供创作中心窗口内部使用）==========
  creatorTab: {
    activateTab: (tabId: string): Promise<void> =>
      invoke('creator-tab:activate', tabId),
    closeTab: (tabId: string): Promise<void> =>
      invoke('creator-tab:close', tabId),
    newTab: (): Promise<void> =>
      invoke('creator-tab:new'),
    goBack: (): Promise<void> =>
      invoke('creator-tab:back'),
    goForward: (): Promise<void> =>
      invoke('creator-tab:forward'),
    reload: (): Promise<void> =>
      invoke('creator-tab:reload'),
    goHome: (): Promise<void> =>
      invoke('creator-tab:home'),
    onTabsUpdate: (cb: (data: { tabs: Array<{ id: string; title: string; url: string; isLoading: boolean }>; activeId: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { tabs: Array<{ id: string; title: string; url: string; isLoading: boolean }>; activeId: string }) => cb(payload);
      ipcRenderer.on('creator-tabs:update', handler);
      return () => ipcRenderer.removeListener('creator-tabs:update', handler);
    },
    onUrlUpdate: (cb: (data: { tabId: string; url: string; title: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { tabId: string; url: string; title: string }) => cb(payload);
      ipcRenderer.on('creator-tabs:url-update', handler);
      return () => ipcRenderer.removeListener('creator-tabs:url-update', handler);
    },
  },

  // ========== 账号创作中心（内嵌主窗口，DOM <webview> 方案）==========
  workspaceWebview: {
    ensure: (accountId: string, title: string): Promise<{ ok: boolean; url?: string; error?: string; env?: { ok: boolean; reason?: string }; userAgent?: string }> =>
      invoke('workspace-webview:ensure', accountId, title),
    close: (accountId: string): Promise<void> =>
      invoke('workspace-webview:close', accountId),
    /** 返回创作中心 <webview> 的访客预加载脚本绝对路径（沙箱兼容，用于登录监控/统计抓取/DOM 体检） */
    getGuestPreloadPath: (): Promise<string> =>
      invoke('workspace:getGuestPreloadPath'),
    /** 向主进程注册弹窗拦截（webview dom-ready 后调用，传入 getWebContentsId() 返回的 wcId 和 accountId） */
    registerPopups: (wcId: number, accountId: string): Promise<void> =>
      invoke('workspace-webview:registerPopups', wcId, accountId),
    /** 监听主进程回传的新 inner tab 请求（含 accountId 用于多账号过滤） */
    onNewInnerTab: (callback: (data: { url: string; referrer?: string; accountId: string }) => void) => {
      const listener = (_event: any, data: any) => callback(data);
      ipcRenderer.on('workspace:new-inner-tab', listener);
      return () => { ipcRenderer.removeListener('workspace:new-inner-tab', listener); };
    },
  },

  // ========== 更新 ==========
  update: {
    check: (): Promise<UpdateInfo> => invoke('update:check'),
  },

  // ========== 对外 API 服务 ==========
  apiServer: {
    getConfig: (): Promise<{ enabled: boolean; port: number; apiKey: string }> =>
      invoke('apiServer:getConfig'),
    saveConfig: (config: { enabled?: boolean; port?: number; apiKey?: string }): Promise<{ config: { enabled: boolean; port: number; apiKey: string }; running: boolean }> =>
      invoke('apiServer:saveConfig', config),
    status: (): Promise<{ running: boolean; config: { enabled: boolean; port: number; apiKey: string } }> =>
      invoke('apiServer:status'),
    start: (): Promise<{ running: boolean }> => invoke('apiServer:start'),
    stop: (): Promise<{ running: boolean }> => invoke('apiServer:stop'),
  },

  // ========== 系统环境配置与指纹代理 ==========
  env: {
    listProxies: (): Promise<ProxyConfig[]> => invoke('env:listProxies'),
    createProxy: (data: Omit<ProxyConfig, 'id' | 'createdAt'>): Promise<ProxyConfig> => invoke('env:createProxy', data),
    updateProxy: (id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>): Promise<ProxyConfig | null> => invoke('env:updateProxy', id, patch),
    deleteProxy: (id: string): Promise<boolean> => invoke('env:deleteProxy', id),
    testProxy: (id: string, testUrl?: string, timeoutMs?: number): Promise<ProxyTestResult> =>
      invoke('env:testProxy', id, testUrl, timeoutMs),

    listEnvironments: (): Promise<BrowserEnvironment[]> => invoke('env:listEnvironments'),
    createEnvironment: (data: Omit<BrowserEnvironment, 'id' | 'createdAt'>): Promise<BrowserEnvironment> => invoke('env:createEnvironment', data),
    updateEnvironment: (id: string, patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>): Promise<BrowserEnvironment | null> => invoke('env:updateEnvironment', id, patch),
    deleteEnvironment: (id: string): Promise<boolean> => invoke('env:deleteEnvironment', id),
  },

  // ========== 发布合规预检（P0） ==========
  compliance: {
    scan: (req: ComplianceScanRequest): Promise<ComplianceResult> => invoke('compliance:scan', req),
    getSettings: (): Promise<ComplianceSettings> => invoke('compliance:getSettings'),
    setSettings: (patch: { promptEnabled?: boolean }): Promise<ComplianceSettings> =>
      invoke('compliance:setSettings', patch),
  },

  // ========== 任务选项卡布局持久化（M4） ==========
  workspaceState: {
    save: (state: unknown): Promise<void> => invoke('workspace:saveState', state),
    load: (): Promise<unknown> => invoke('workspace:loadState'),
  },
});

// 便于在 Vue 组件中做类型推断
declare global {
  interface Window {
    electron: {
      account: {
        listPlatforms: () => Promise<PlatformMeta[]>;
        list: () => Promise<AccountInfo[]>;
        get: (id: string) => Promise<AccountInfo | null>;
        beginAuth: (platform: PlatformType, envId?: string | null) => Promise<AccountInfo>;
        delete: (id: string) => Promise<boolean>;
        update: (
          id: string,
          patch: { nickname?: string; remark?: string; categoryIds?: string[]; envId?: string | null },
        ) => Promise<AccountInfo | null>;
        refresh: (id: string) => Promise<AccountInfo>;
        openCreator: (
          id: string,
        ) => Promise<{
          ok: boolean;
          url: string;
          injected: number;
          skipped: number;
          failed: number;
          error?: string;
        }>;
        openAccountTab: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
        healthCheck: (id: string) => Promise<AccountInfo | null>;
        healthCheckAll: () => Promise<AccountInfo[]>;
        setHealthCheckInterval: (intervalMs: number, initialDelayMs?: number) => Promise<boolean>;
        getHealthCheckConfig: () => Promise<HealthCheckConfig>;
        setHealthCheckConfig: (cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }) => Promise<HealthCheckConfig>;
      };
      publish: {
        submit: (req: PublishRequest) => Promise<string>;
        progress: (taskId: string) => Promise<ProgressInfo | null>;
        cancel: (taskId: string) => Promise<boolean>;
        list: () => Promise<PublishTask[]>;
        listPaged: (page?: number, pageSize?: number) => Promise<PagedResult<PublishTask>>;
        getStats: () => Promise<PublishStats>;
        retry: (taskId: string) => Promise<string | null>;
        retryAsTest: (taskId: string) => Promise<string | null>;
        retryAsPublish: (taskId: string) => Promise<string | null>;
        detail: (taskId: string) => Promise<{ task: PublishTask | null; logs: PublishLogEntry[] }>;
        delete: (taskId: string) => Promise<boolean>;
        setConcurrency: (n: number) => Promise<boolean>;
        getLogPaths: () => Promise<{ publishLog: string; mainLog: string; dir: string }>;
        openLogDir: () => Promise<boolean>;
        queryLogs: (query?: PublishLogQuery) => Promise<PublishLogEntry[]>;
        clearLogs: () => Promise<boolean>;
        onStatusChanged: (cb: (evt: PublishStatusEvent) => void) => () => void;
      };
      system: {
        openExternal: (url: string) => Promise<boolean>;
        getInfo: () => Promise<SystemInfo>;
        openFileDialog: (
          options?: { mode?: 'file' | 'files'; filters?: Electron.FileFilter[] },
        ) => Promise<{ canceled: boolean; filePaths: string[] }>;
        showSaveDialog: (options?: Electron.SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
        minimizeWindow: () => Promise<boolean>;
        closeWindow: () => Promise<boolean>;
        maximizeWindow: () => Promise<boolean>;
        isMaximizedWindow: () => Promise<boolean>;
        getWindowBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
        setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
      };
      log: {
        readMain: (options?: { limit?: number; date?: string }) => Promise<string>;
        readPublish: (options?: { limit?: number; date?: string }) => Promise<string>;
        listFiles: (type: 'main' | 'publish') => Promise<{ date: string; path: string; size: number }[]>;
        queryPublish: (query?: PublishLogQuery) => Promise<PublishLogEntry[]>;
        clearPublish: () => Promise<boolean>;
        openDir: () => Promise<boolean>;
        'export': (type: 'main' | 'publish' | 'all') => Promise<{ ok: boolean; path?: string; error?: string }>;
        getInfo: () => Promise<{
          mainSize: number;
          publishSize: number;
          logsDir: string;
          mainPath: string;
          publishPath: string;
        }>;
      };
      update: {
        check: () => Promise<UpdateInfo>;
      };
      workspaceWebview: {
        ensure: (accountId: string, title: string) => Promise<{ ok: boolean; url?: string; error?: string; userAgent?: string }>;
        getGuestPreloadPath: () => Promise<string>;
        activate: (accountId: string) => Promise<void>;
        deactivateAll: () => Promise<void>;
        setRect: (accountId: string, rect: { x: number; y: number; width: number; height: number }) => Promise<void>;
        close: (accountId: string) => Promise<void>;
        back: (accountId: string) => Promise<void>;
        forward: (accountId: string) => Promise<void>;
        reload: (accountId: string) => Promise<void>;
        home: (accountId: string) => Promise<void>;
        newTab: (accountId: string) => Promise<void>;
        activateInner: (accountId: string, tabId: string) => Promise<void>;
        closeInner: (accountId: string, tabId: string) => Promise<void>;
        onTabsUpdate: (cb: (data: { accountId: string; tabs: Array<{ id: string; title: string; url: string; isLoading: boolean }>; activeId: string }) => void) => () => void;
        onUrlUpdate: (cb: (data: { accountId: string; tabId: string; url: string; title: string }) => void) => () => void;
        onWindowResize: (cb: () => void) => () => void;
        onEnvStatus: (cb: (data: { accountId: string; ok: boolean; reason?: string }) => void) => () => void;
      };
      env: {
        listProxies: () => Promise<ProxyConfig[]>;
        createProxy: (data: Omit<ProxyConfig, 'id' | 'createdAt'>) => Promise<ProxyConfig>;
        updateProxy: (id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>) => Promise<ProxyConfig | null>;
        deleteProxy: (id: string) => Promise<boolean>;
        testProxy: (id: string, testUrl?: string, timeoutMs?: number) => Promise<ProxyTestResult>;

        listEnvironments: () => Promise<BrowserEnvironment[]>;
        createEnvironment: (data: Omit<BrowserEnvironment, 'id' | 'createdAt'>) => Promise<BrowserEnvironment>;
        updateEnvironment: (id: string, patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>) => Promise<BrowserEnvironment | null>;
        deleteEnvironment: (id: string) => Promise<boolean>;
      };
      compliance: {
        scan: (req: ComplianceScanRequest) => Promise<ComplianceResult>;
        getSettings: () => Promise<ComplianceSettings>;
        setSettings: (patch: { promptEnabled?: boolean }) => Promise<ComplianceSettings>;
      };
      workspaceState: {
        save: (state: unknown) => Promise<void>;
        load: () => Promise<unknown>;
      };
    };
  }
}

export {};
