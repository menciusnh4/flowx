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
    beginAuth: (platform: PlatformType): Promise<AccountInfo> =>
      invoke('account:beginAuth', platform),
    delete: (id: string): Promise<boolean> => invoke('account:delete', id),
    update: (
      id: string,
      patch: { nickname?: string; remark?: string },
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
  },

  // ========== 发布相关 ==========
  publish: {
    submit: (req: PublishRequest): Promise<string> => invoke('publish:submit', req),
    progress: (taskId: string): Promise<ProgressInfo | null> =>
      invoke('publish:progress', taskId),
    cancel: (taskId: string): Promise<boolean> => invoke('publish:cancel', taskId),
    list: (): Promise<PublishTask[]> => invoke('publish:list'),
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

  // ========== 更新 ==========
  update: {
    check: (): Promise<UpdateInfo> => invoke('update:check'),
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
        beginAuth: (platform: PlatformType) => Promise<AccountInfo>;
        delete: (id: string) => Promise<boolean>;
        update: (
          id: string,
          patch: { nickname?: string; remark?: string },
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
      };
      publish: {
        submit: (req: PublishRequest) => Promise<string>;
        progress: (taskId: string) => Promise<ProgressInfo | null>;
        cancel: (taskId: string) => Promise<boolean>;
        list: () => Promise<PublishTask[]>;
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
    };
  }
}

export {};
