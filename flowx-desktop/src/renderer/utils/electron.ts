// 渲染进程对 window.electron 的安全封装
// 如果 preload 未正确加载（例如路径配置错误），不会让页面崩溃，
// 而是返回带中文诊断信息的 Error，便于快速定位问题。
import type {
  PlatformMeta,
  AccountInfo,
  PlatformType,
  PublishRequest,
  PublishTask,
  ProgressInfo,
  SystemInfo,
  UpdateInfo,
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
} from '../../types';

type StatusCb = (evt: unknown) => void;

// 对外统一的 API 表，任何对 Electron 的调用都走这里
export const electronApi = {
  // 账号
  async listPlatforms(): Promise<PlatformMeta[]> {
    return invokeElectron('account.listPlatforms', 'account:listPlatforms');
  },
  async listAccounts(): Promise<AccountInfo[]> {
    return invokeElectron('account.list', 'account:list');
  },
  async getAccount(id: string): Promise<AccountInfo | null> {
    return invokeElectron('account.get', 'account:get', id);
  },
  async beginAuth(platform: PlatformType, envId?: string | null): Promise<AccountInfo> {
    return invokeElectron('account.beginAuth', 'account:beginAuth', platform, envId);
  },
  async deleteAccount(id: string): Promise<boolean> {
    return invokeElectron('account.delete', 'account:delete', id);
  },
  async updateAccount(
    id: string,
    patch: { nickname?: string; remark?: string; categoryIds?: string[]; envId?: string | null },
  ): Promise<AccountInfo | null> {
    return invokeElectron('account.update', 'account:update', id, patch);
  },
  async refreshToken(id: string): Promise<AccountInfo> {
    return invokeElectron('account.refresh', 'account:refresh', id);
  },
  async openCreator(accountId: string): Promise<{
    ok: boolean;
    url: string;
    injected: number;
    skipped: number;
    failed: number;
    error?: string;
  }> {
    return invokeElectron('account.openCreator', 'account:openCreator', accountId);
  },

  // 分类管理
  async listCategories(): Promise<AccountCategory[]> {
    return invokeElectron('account.listCategories', 'account:listCategories');
  },
  async createCategory(name: string): Promise<AccountCategory> {
    return invokeElectron('account.createCategory', 'account:createCategory', name);
  },
  async updateCategory(id: string, name: string): Promise<AccountCategory | null> {
    return invokeElectron('account.updateCategory', 'account:updateCategory', id, name);
  },
  async deleteCategory(id: string): Promise<boolean> {
    return invokeElectron('account.deleteCategory', 'account:deleteCategory', id);
  },

  /** 静默检测单个账号的登录态（不弹用户可编辑的窗口） */
  async checkAccountHealth(id: string): Promise<AccountInfo | null> {
    return invokeElectron('account.checkAccountHealth', 'account:healthCheck', id);
  },

  /** 批量检测所有账号登录态 */
  async checkAllAccountsHealth(): Promise<AccountInfo[]> {
    return invokeElectron('account.checkAllAccountsHealth', 'account:healthCheckAll');
  },

  /** 设置定时检测的间隔（毫秒），intervalMs <= 0 表示停止定时检测 */
  async setHealthCheckInterval(intervalMs: number, initialDelayMs = 0): Promise<boolean> {
    return invokeElectron('account.setHealthCheckInterval', 'account:setHealthCheckInterval', intervalMs, initialDelayMs);
  },

  /** 获取当前健康检测配置 */
  async getHealthCheckConfig(): Promise<HealthCheckConfig> {
    return invokeElectron('account.getHealthCheckConfig', 'account:getHealthCheckConfig');
  },

  /** 更新健康检测配置（同时持久化保存 + 重启定时器） */
  async setHealthCheckConfig(cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }): Promise<HealthCheckConfig> {
    return invokeElectron('account.setHealthCheckConfig', 'account:setHealthCheckConfig', cfg);
  },

  // 发布
  async submitPublish(req: PublishRequest): Promise<string> {
    return invokeElectron('publish.submit', 'publish:submit', req);
  },
  async getPublishProgress(taskId: string): Promise<ProgressInfo | null> {
    return invokeElectron('publish.progress', 'publish:progress', taskId);
  },
  async cancelPublish(taskId: string): Promise<boolean> {
    return invokeElectron('publish.cancel', 'publish:cancel', taskId);
  },
  async listTasks(): Promise<PublishTask[]> {
    return invokeElectron('publish.list', 'publish:list');
  },
  async listTasksPaged(page?: number, pageSize?: number): Promise<PagedResult<PublishTask>> {
    return invokeElectron('publish.listPaged', 'publish:listPaged', page, pageSize);
  },
  async getPublishStats(): Promise<PublishStats> {
    return invokeElectron('publish.getStats', 'publish:getStats');
  },
  async retryPublish(taskId: string): Promise<string | null> {
    return invokeElectron('publish.retry', 'publish:retry', taskId);
  },
  async getTaskDetail(taskId: string): Promise<{ task: PublishTask | null; logs: PublishLogEntry[] }> {
    return invokeElectron('publish.detail', 'publish:detail', taskId);
  },
  async deleteTask(taskId: string): Promise<boolean> {
    return invokeElectron('publish.delete', 'publish:delete', taskId);
  },
  async setConcurrency(n: number): Promise<boolean> {
    return invokeElectron('publish.setConcurrency', 'publish:setConcurrency', n);
  },

  // 发布日志相关
  async getPublishLogPaths(): Promise<{ publishLog: string; mainLog: string; dir: string }> {
    return invokeElectron('publish.getLogPaths', 'publish:getLogPaths');
  },
  async openLogDir(): Promise<boolean> {
    return invokeElectron('publish.openLogDir', 'publish:openLogDir');
  },
  async queryPublishLogs(query?: PublishLogQuery): Promise<PublishLogEntry[]> {
    return invokeElectron('publish.queryLogs', 'publish:queryLogs', query || {});
  },
  async clearPublishLogs(): Promise<boolean> {
    return invokeElectron('publish.clearLogs', 'publish:clearLogs');
  },

  onPublishStatusChanged(cb: StatusCb): () => void {
    const e = getElectronOrThrow();
    return e.publish.onStatusChanged(cb as never);
  },

  // 系统
  async openExternal(url: string): Promise<boolean> {
    return invokeElectron('system.openExternal', 'system:openExternal', url);
  },
  async getSystemInfo(): Promise<SystemInfo> {
    return invokeElectron('system.getInfo', 'system:getInfo');
  },
  async openFileDialog(opts?: { mode?: 'file' | 'files'; filters?: Electron.FileFilter[] }): Promise<{ canceled: boolean; filePaths: string[] }> {
    return invokeElectron('system.openFileDialog', 'system:openFileDialog', opts);
  },
  async minimizeWindow(): Promise<boolean> {
    return invokeElectron('system.minimizeWindow', 'system:minimizeWindow');
  },
  async closeWindow(): Promise<boolean> {
    return invokeElectron('system.closeWindow', 'system:closeWindow');
  },

  // 日志管理
  async readMainLog(options?: { limit?: number; date?: string }): Promise<string> {
    return invokeElectron('log.readMain', 'log:readMain', options);
  },
  async readPublishLog(options?: { limit?: number; date?: string }): Promise<string> {
    return invokeElectron('log.readPublish', 'log:readPublish', options);
  },
  async listLogFiles(type: 'main' | 'publish'): Promise<{ date: string; path: string; size: number }[]> {
    return invokeElectron('log.listFiles', 'log:listFiles', type);
  },
  async queryPublishLog(query?: PublishLogQuery): Promise<PublishLogEntry[]> {
    return invokeElectron('log.queryPublish', 'log:queryPublish', query);
  },
  async clearPublishLogMemory(): Promise<boolean> {
    return invokeElectron('log.clearPublish', 'log:clearPublish');
  },
  async openLogDirectory(): Promise<boolean> {
    return invokeElectron('log.openDir', 'log:openDir');
  },
  async exportLog(type: 'main' | 'publish' | 'all'): Promise<{ ok: boolean; path?: string; error?: string }> {
    return invokeElectron('log.export', 'log:export', type);
  },
  async getLogFileInfo(): Promise<{
    mainSize: number;
    publishSize: number;
    logsDir: string;
    mainPath: string;
    publishPath: string;
  }> {
    return invokeElectron('log.getInfo', 'log:getInfo');
  },

  // 更新
  async checkUpdate(): Promise<UpdateInfo> {
    return invokeElectron('update.check', 'update:check');
  },

  // 对外 API 服务
  async getApiServerConfig(): Promise<{ enabled: boolean; port: number; apiKey: string }> {
    return invokeElectron('apiServer.getConfig', 'apiServer:getConfig');
  },
  async saveApiServerConfig(cfg: { enabled?: boolean; port?: number; apiKey?: string }): Promise<{ config: { enabled: boolean; port: number; apiKey: string }; running: boolean }> {
    return invokeElectron('apiServer.saveConfig', 'apiServer:saveConfig', cfg);
  },
  async getApiServerStatus(): Promise<{ running: boolean; config: { enabled: boolean; port: number; apiKey: string } }> {
    return invokeElectron('apiServer.getStatus', 'apiServer:status');
  },
  async startApiServer(): Promise<{ running: boolean }> {
    return invokeElectron('apiServer.start', 'apiServer:start');
  },
  async stopApiServer(): Promise<{ running: boolean }> {
    return invokeElectron('apiServer.stop', 'apiServer:stop');
  },
  async listProxies(): Promise<ProxyConfig[]> {
    return invokeElectron('env.listProxies', 'env:listProxies');
  },
  async createProxy(data: Omit<ProxyConfig, 'id' | 'createdAt'>): Promise<ProxyConfig> {
    return invokeElectron('env.createProxy', 'env:createProxy', data);
  },
  async updateProxy(id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>): Promise<ProxyConfig | null> {
    return invokeElectron('env.updateProxy', 'env:updateProxy', id, patch);
  },
  async deleteProxy(id: string): Promise<boolean> {
    return invokeElectron('env.deleteProxy', 'env:deleteProxy', id);
  },
  async testProxy(id: string, testUrl?: string, timeoutMs?: number): Promise<ProxyTestResult> {
    return invokeElectron('env.testProxy', 'env:testProxy', id, testUrl, timeoutMs);
  },
  async listEnvironments(): Promise<BrowserEnvironment[]> {
    return invokeElectron('env.listEnvironments', 'env:listEnvironments');
  },
  async createEnvironment(data: Omit<BrowserEnvironment, 'id' | 'createdAt'>): Promise<BrowserEnvironment> {
    return invokeElectron('env.createEnvironment', 'env:createEnvironment', data);
  },
  async updateEnvironment(id: string, patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>): Promise<BrowserEnvironment | null> {
    return invokeElectron('env.updateEnvironment', 'env:updateEnvironment', id, patch);
  },
  async deleteEnvironment(id: string): Promise<boolean> {
    return invokeElectron('env.deleteEnvironment', 'env:deleteEnvironment', id);
  },

  // 草稿箱
  draft: {
    async list(contentType?: string): Promise<PublishDraft[]> {
      return invokeElectron('draft.list', 'draft:list', contentType);
    },
    async get(id: string): Promise<PublishDraft | null> {
      return invokeElectron('draft.get', 'draft:get', id);
    },
    async create(data: Parameters<typeof import('../../main/services/DraftService').createDraft>[0]): Promise<PublishDraft> {
      return invokeElectron('draft.create', 'draft:create', data);
    },
    async update(id: string, patch: Parameters<typeof import('../../main/services/DraftService').updateDraft>[1]): Promise<PublishDraft | null> {
      return invokeElectron('draft.update', 'draft:update', id, patch);
    },
    async delete(id: string): Promise<boolean> {
      return invokeElectron('draft.delete', 'draft:delete', id);
    },
    async search(keyword: string): Promise<PublishDraft[]> {
      return invokeElectron('draft.search', 'draft:search', keyword);
    },
  },

  // 浏览器
  browser: {
    async createView(options?: { url?: string; envId?: string | null }): Promise<{
      viewId: string;
      title: string;
      url: string;
      isLoading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
      envId: string | null;
    }> {
      return invokeElectron('browser.createView', 'browser:createView', options);
    },
    async destroyView(viewId: string): Promise<boolean> {
      return invokeElectron('browser.destroyView', 'browser:destroyView', viewId);
    },
    async setBounds(viewId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> {
      return invokeElectron('browser.setBounds', 'browser:setBounds', viewId, bounds);
    },
    async navigate(viewId: string, url: string): Promise<boolean> {
      return invokeElectron('browser.navigate', 'browser:navigate', viewId, url);
    },
    async goBack(viewId: string): Promise<boolean> {
      return invokeElectron('browser.goBack', 'browser:goBack', viewId);
    },
    async goForward(viewId: string): Promise<boolean> {
      return invokeElectron('browser.goForward', 'browser:goForward', viewId);
    },
    async reload(viewId: string): Promise<boolean> {
      return invokeElectron('browser.reload', 'browser:reload', viewId);
    },
    async stop(viewId: string): Promise<boolean> {
      return invokeElectron('browser.stop', 'browser:stop', viewId);
    },
    async switchEnv(viewId: string, envId: string | null): Promise<boolean> {
      return invokeElectron('browser.switchEnv', 'browser:switchEnv', viewId, envId);
    },
    async setIgnoreCertErrors(viewId: string, ignore: boolean): Promise<boolean> {
      return invokeElectron('browser.setIgnoreCertErrors', 'browser:setIgnoreCertErrors', viewId, ignore);
    },
    async isIgnoringCertErrors(viewId: string): Promise<boolean> {
      return invokeElectron('browser.isIgnoringCertErrors', 'browser:isIgnoringCertErrors', viewId);
    },
    async extractContent(viewId: string): Promise<ExtractedContent | null> {
      return invokeElectron('browser.extractContent', 'browser:extractContent', viewId);
    },
    async manualExtract(viewId: string, selector: string): Promise<ExtractedContent | null> {
      return invokeElectron('browser.manualExtract', 'browser:manualExtract', viewId, selector);
    },
    async startSelector(viewId: string): Promise<boolean> {
      return invokeElectron('browser.startSelector', 'browser:startSelector', viewId);
    },
    async stopSelector(viewId: string): Promise<boolean> {
      return invokeElectron('browser.stopSelector', 'browser:stopSelector', viewId);
    },
    async downloadImages(imageUrls: string[], envId?: string | null): Promise<string[]> {
      return invokeElectron('browser.downloadImages', 'browser:downloadImages', imageUrls, envId);
    },
    async getImageDataUrl(filePath: string): Promise<string> {
      return invokeElectron('browser.getImageDataUrl', 'browser:getImageDataUrl', filePath);
    },

    onPageTitleUpdated(cb: (data: { viewId: string; title: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onPageTitleUpdated: (cb: never) => () => void } };
      return e.browser?.onPageTitleUpdated?.(cb as never) ?? (() => { /* noop */ });
    },
    onPageUrlUpdated(cb: (data: { viewId: string; url: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onPageUrlUpdated: (cb: never) => () => void } };
      return e.browser?.onPageUrlUpdated?.(cb as never) ?? (() => { /* noop */ });
    },
    onLoadingUpdated(cb: (data: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onLoadingUpdated: (cb: never) => () => void } };
      return e.browser?.onLoadingUpdated?.(cb as never) ?? (() => { /* noop */ });
    },
    onEnvChanged(cb: (data: { viewId: string; envId: string | null }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onEnvChanged: (cb: never) => () => void } };
      return e.browser?.onEnvChanged?.(cb as never) ?? (() => { /* noop */ });
    },
    onLoadFailed(cb: (data: { viewId: string; errorCode: number; errorDescription: string; url: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onLoadFailed: (cb: never) => () => void } };
      return e.browser?.onLoadFailed?.(cb as never) ?? (() => { /* noop */ });
    },
    onCertIgnoreChanged(cb: (data: { viewId: string; ignore: boolean }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onCertIgnoreChanged: (cb: never) => () => void } };
      return e.browser?.onCertIgnoreChanged?.(cb as never) ?? (() => { /* noop */ });
    },
    onExtractResult(cb: (data: { viewId: string; result: ExtractedContent }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onExtractResult: (cb: never) => () => void } };
      return e.browser?.onExtractResult?.(cb as never) ?? (() => { /* noop */ });
    },
    onExtractError(cb: (data: { viewId: string; error: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onExtractError: (cb: never) => () => void } };
      return e.browser?.onExtractError?.(cb as never) ?? (() => { /* noop */ });
    },
    onManualExtractResult(cb: (data: { viewId: string; result: ExtractedContent }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onManualExtractResult: (cb: never) => () => void } };
      return e.browser?.onManualExtractResult?.(cb as never) ?? (() => { /* noop */ });
    },
    onSelectorStarted(cb: (data: { viewId: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onSelectorStarted: (cb: never) => () => void } };
      return e.browser?.onSelectorStarted?.(cb as never) ?? (() => { /* noop */ });
    },
    onSelectorCancelled(cb: (data: { viewId: string }) => void): () => void {
      const e = getElectronOrThrow() as { browser?: { onSelectorCancelled: (cb: never) => () => void } };
      return e.browser?.onSelectorCancelled?.(cb as never) ?? (() => { /* noop */ });
    },

    removePageTitleUpdatedListener(cb: (data: { viewId: string; title: string }) => void): void {
      const e = getElectronOrThrow() as { browser?: { removePageTitleUpdatedListener: (cb: never) => void } };
      e.browser?.removePageTitleUpdatedListener?.(cb as never);
    },
    removePageUrlUpdatedListener(cb: (data: { viewId: string; url: string }) => void): void {
      const e = getElectronOrThrow() as { browser?: { removePageUrlUpdatedListener: (cb: never) => void } };
      e.browser?.removePageUrlUpdatedListener?.(cb as never);
    },
    removeLoadingUpdatedListener(cb: (data: { viewId: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean }) => void): void {
      const e = getElectronOrThrow() as { browser?: { removeLoadingUpdatedListener: (cb: never) => void } };
      e.browser?.removeLoadingUpdatedListener?.(cb as never);
    },
  },

  // 浏览器收藏夹与历史记录
  browserHistory: {
    // 收藏夹
    async listBookmarks(folderId?: string | null): Promise<BrowserBookmark[]> {
      return invokeElectron('browserHistory.listBookmarks', 'browserHistory:listBookmarks', folderId);
    },
    async listAllBookmarks(): Promise<BrowserBookmark[]> {
      return invokeElectron('browserHistory.listAllBookmarks', 'browserHistory:listAllBookmarks');
    },
    async isBookmarked(url: string): Promise<boolean> {
      return invokeElectron('browserHistory.isBookmarked', 'browserHistory:isBookmarked', url);
    },
    async addBookmark(data: { url: string; title: string; siteName?: string; folderId?: string }): Promise<BrowserBookmark> {
      return invokeElectron('browserHistory.addBookmark', 'browserHistory:addBookmark', data);
    },
    async updateBookmark(
      id: string,
      patch: Partial<Pick<BrowserBookmark, 'title' | 'url' | 'folderId' | 'siteName'>>,
    ): Promise<BrowserBookmark | null> {
      return invokeElectron('browserHistory.updateBookmark', 'browserHistory:updateBookmark', id, patch);
    },
    async deleteBookmark(id: string): Promise<boolean> {
      return invokeElectron('browserHistory.deleteBookmark', 'browserHistory:deleteBookmark', id);
    },
    async deleteBookmarkByUrl(url: string): Promise<boolean> {
      return invokeElectron('browserHistory.deleteBookmarkByUrl', 'browserHistory:deleteBookmarkByUrl', url);
    },
    async searchBookmarks(keyword: string): Promise<BrowserBookmark[]> {
      return invokeElectron('browserHistory.searchBookmarks', 'browserHistory:searchBookmarks', keyword);
    },
    async listBookmarkFolders(): Promise<BrowserBookmarkFolder[]> {
      return invokeElectron('browserHistory.listBookmarkFolders', 'browserHistory:listBookmarkFolders');
    },
    async createBookmarkFolder(name: string, parentId?: string): Promise<BrowserBookmarkFolder> {
      return invokeElectron('browserHistory.createBookmarkFolder', 'browserHistory:createBookmarkFolder', name, parentId);
    },
    async deleteBookmarkFolder(folderId: string): Promise<boolean> {
      return invokeElectron('browserHistory.deleteBookmarkFolder', 'browserHistory:deleteBookmarkFolder', folderId);
    },

    // 历史记录
    async listHistory(limit?: number): Promise<BrowserHistoryItem[]> {
      return invokeElectron('browserHistory.listHistory', 'browserHistory:listHistory', limit);
    },
    async listHistoryPaged(page?: number, pageSize?: number): Promise<{
      items: BrowserHistoryItem[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    }> {
      return invokeElectron('browserHistory.listHistoryPaged', 'browserHistory:listHistoryPaged', page, pageSize);
    },
    async addHistory(data: { url: string; title: string; viewId?: string }): Promise<BrowserHistoryItem> {
      return invokeElectron('browserHistory.addHistory', 'browserHistory:addHistory', data);
    },
    async deleteHistory(id: string): Promise<boolean> {
      return invokeElectron('browserHistory.deleteHistory', 'browserHistory:deleteHistory', id);
    },
    async clearHistory(beforeTs?: number): Promise<number> {
      return invokeElectron('browserHistory.clearHistory', 'browserHistory:clearHistory', beforeTs);
    },
    async searchHistory(keyword: string, limit?: number): Promise<BrowserHistoryItem[]> {
      return invokeElectron('browserHistory.searchHistory', 'browserHistory:searchHistory', keyword, limit);
    },
    async getHistoryStats(): Promise<{ total: number; today: number; thisWeek: number }> {
      return invokeElectron('browserHistory.getHistoryStats', 'browserHistory:getHistoryStats');
    },
  },
};

function getElectronOrThrow(): (typeof window)['electron'] {
  const e = (window as unknown as { electron?: unknown }).electron;
  if (!e) {
    throw new Error(
      'FlowX 初始化失败：preload 脚本未成功注入 window.electron。\n' +
      '常见原因：\n' +
      '  1) main/windows/MainWindow.ts 里的 preload 路径不正确\n' +
      '  2) 构建产物 dist-electron/preload/index.js 不存在\n' +
      '请查看主进程控制台日志（[FlowX] 预解析资源路径: ...），并确认路径存在。',
    );
  }
  return e as (typeof window)['electron'];
}

async function invokeElectron<T>(
  debugName: string,
  pathA: string,
  ...args: unknown[]
): Promise<T> {
  const e = getElectronOrThrow();
  const [ns, key] = pathA.split(':'); // e.g. "account:beginAuth" -> ns="account", key="beginAuth"
  const obj = (e as Record<string, unknown>)[ns] as Record<string, unknown> | undefined;
  if (!obj || typeof obj[key] !== 'function') {
    throw new Error(`FlowX API 缺失：${debugName}（${ns}.${key}）。请确认 IPC 与 preload 已注册此通道。`);
  }
  // ⚠️  注意：preload 中的 invoke() 已经把主进程 safeInvoke 返回的 { ok, data, error }
  //     解包成纯 data（失败时直接 throw Error），所以这里不需要再次解包！
  return (await (obj[key] as (...a: unknown[]) => Promise<T>)(...args)) as T;
}
