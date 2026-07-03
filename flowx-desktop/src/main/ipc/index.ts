import { ipcMain, app } from 'electron';
import { registerAccountIpc } from './account';
import { registerPublishIpc } from './publish';
import { registerSystemIpc } from './system';
import { registerEnvIpc } from './env';
import { registerApiServerIpc } from './apiServer';
import { logger } from '../utils/logger';

// 注册所有 IPC 监听
export function registerAllIpc(): void {
  registerAccountIpc();
  registerPublishIpc();
  registerSystemIpc();
  registerEnvIpc();
  registerApiServerIpc();
  logger.info('[IPC] 所有通道已注册');
}

// 全局的 invoke 封装，带 try/catch 与统一错误结构
// 所有子模块建议使用此格式： { ok: boolean, data?, error? }
export function safeInvoke<T>(
  channel: string,
  handler: (...args: any[]) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      logger.error(`[IPC:${channel}]`, err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

// 给渲染层的安全类型（主进程不需要运行，但便于文档化）
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface FlowxIpc {}
}
