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

  // 更新
  async checkUpdate(): Promise<UpdateInfo> {
    return invokeElectron('update.check', 'update:check');
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
