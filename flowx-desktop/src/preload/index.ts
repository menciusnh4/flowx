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

  // ========== 更新 ==========
  update: {
    check: (): Promise<UpdateInfo> => invoke('update:check'),
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
      };
      update: {
        check: () => Promise<UpdateInfo>;
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
    };
  }
}

export {};
