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
  async beginAuth(platform: PlatformType): Promise<AccountInfo> {
    return invokeElectron('account.beginAuth', 'account:beginAuth', platform);
  },
  async deleteAccount(id: string): Promise<boolean> {
    return invokeElectron('account.delete', 'account:delete', id);
  },
  async updateAccount(
    id: string,
    patch: { nickname?: string; remark?: string },
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
  async openFileDialog(opts?: { mode?: 'file' | 'files' }): Promise<{ canceled: boolean; filePaths: string[] }> {
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
  const [ns, key] = pathA.split(':'); // e.g. "account:listPlatforms"
  const obj = (e as Record<string, unknown>)[ns] as Record<string, unknown> | undefined;
  if (!obj || typeof obj[key] !== 'function') {
    throw new Error(`FlowX API 缺失：${debugName}（${ns}.${key}）。请确认 IPC 与 preload 已注册此通道。`);
  }
  return await (obj[key] as (...a: unknown[]) => Promise<T>)(...args);
}
