import { ipcMain, shell, app, dialog, BrowserWindow } from 'electron';
import { safeInvoke } from './index';
import type { SystemInfo, UpdateInfo, PublishLogQuery } from '../../types';
import { getMainWindow } from '../windows/MainWindow';
import { getLogsDir, getPublishLogPath, getMainLogPath, queryPublishLogs, clearPublishLogs, listLogFiles, getLogPathByDate } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export function registerSystemIpc(): void {
  safeInvoke(
    'system:openExternal',
    (url: string) => {
      if (!/^https?:\/\//.test(url)) throw new Error('非法 URL 协议');
      shell.openExternal(url);
      return true;
    },
  );

  safeInvoke('system:getInfo', (): SystemInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron,
    appPath: app.getAppPath(),
    logsDir: getLogsDir(),
    publishLogPath: getPublishLogPath(),
    mainLogPath: getMainLogPath(),
  }));

  // 选择文件（用于本地素材上传）
  safeInvoke(
    'system:openFileDialog',
    async (
      options: Electron.OpenDialogOptions & { mode?: 'file' | 'files' },
    ) => {
      const win = getMainWindow();
      const result = await dialog.showOpenDialog(win!, {
        title: '选择要发布的素材',
        properties: options?.mode === 'files'
          ? ['openFile', 'multiSelections']
          : ['openFile'],
        filters: options?.filters || [
          {
            name: '媒体文件',
            extensions: ['mp4', 'mov', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp'],
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      return result;
    },
  );

  // 选择文件保存位置
  safeInvoke('system:showSaveDialog', async (options: Electron.SaveDialogOptions) => {
    const win = getMainWindow();
    return dialog.showSaveDialog(win!, options);
  });

  // 最小化/关闭主窗口（供自定义 titlebar 使用）
  safeInvoke('system:minimizeWindow', () => {
    getMainWindow()?.minimize();
    return true;
  });
  safeInvoke('system:closeWindow', () => {
    getMainWindow()?.close();
    return true;
  });

  // 自动更新（骨架实现，真实环境需要配置 electron-updater feed）
  safeInvoke('update:check', (): UpdateInfo => ({ available: false }));

  // --- 日志管理 ---

  // 读取主日志文件内容（最后 N 行，支持指定日期）
  safeInvoke('log:readMain', async (options?: { limit?: number; date?: string }): Promise<string> => {
    const limit = options?.limit ?? 500;
    let logPath = getMainLogPath();
    if (options?.date) {
      logPath = getLogPathByDate('main', new Date(options.date));
    }
    try {
      if (!fs.existsSync(logPath)) return '';
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      return lines.slice(-limit).join('\n');
    } catch (err) {
      return `[读取日志失败] ${(err as Error).message}`;
    }
  });

  // 读取发布日志文件内容（最后 N 行，支持指定日期）
  safeInvoke('log:readPublish', async (options?: { limit?: number; date?: string }): Promise<string> => {
    const limit = options?.limit ?? 500;
    let logPath = getPublishLogPath();
    if (options?.date) {
      logPath = getLogPathByDate('publish', new Date(options.date));
    }
    try {
      if (!fs.existsSync(logPath)) return '';
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      return lines.slice(-limit).join('\n');
    } catch (err) {
      return `[读取日志失败] ${(err as Error).message}`;
    }
  });

  // 列出日志文件（按日期倒序）
  safeInvoke('log:listFiles', (type: 'main' | 'publish'): { date: string; path: string; size: number }[] => {
    return listLogFiles(type);
  });

  // 查询结构化发布日志（用于发布详情页等）
  safeInvoke('log:queryPublish', (query: PublishLogQuery) => {
    return queryPublishLogs(query);
  });

  // 清空内存中的发布日志
  safeInvoke('log:clearPublish', () => {
    clearPublishLogs();
    return true;
  });

  // 打开日志目录
  safeInvoke('log:openDir', (): boolean => {
    const logsDir = getLogsDir();
    try {
      shell.openPath(logsDir);
      return true;
    } catch {
      return false;
    }
  });

  // 导出日志文件（保存到用户指定位置）
  safeInvoke('log:export', async (type: 'main' | 'publish' | 'all'): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const win = getMainWindow();
    if (!win) return { ok: false, error: '窗口不存在' };
    try {
      const defaultName = type === 'all' 
        ? `flowx-logs-${new Date().toISOString().slice(0, 10)}.zip`
        : `${type === 'main' ? 'main' : 'publish'}-${new Date().toISOString().slice(0, 10)}.log`;
      const result = await dialog.showSaveDialog(win, {
        title: '导出日志',
        defaultPath: defaultName,
        filters: type === 'all'
          ? [{ name: '压缩包', extensions: ['zip'] }]
          : [{ name: '日志文件', extensions: ['log'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: '用户取消' };

      if (type === 'main' || type === 'publish') {
        const srcPath = type === 'main' ? getMainLogPath() : getPublishLogPath();
        if (!fs.existsSync(srcPath)) return { ok: false, error: '日志文件不存在' };
        fs.copyFileSync(srcPath, result.filePath);
        return { ok: true, path: result.filePath };
      } else {
        // all：简单复制两个日志文件到目标目录（打包为 zip 较复杂，先导出为两个文件）
        const destDir = path.dirname(result.filePath);
        const baseName = path.basename(result.filePath, '.zip');
        const mainDest = path.join(destDir, `${baseName}-main.log`);
        const publishDest = path.join(destDir, `${baseName}-publish.log`);
        if (fs.existsSync(getMainLogPath())) fs.copyFileSync(getMainLogPath(), mainDest);
        if (fs.existsSync(getPublishLogPath())) fs.copyFileSync(getPublishLogPath(), publishDest);
        return { ok: true, path: destDir };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // 获取日志文件大小信息
  safeInvoke('log:getInfo', (): { mainSize: number; publishSize: number; logsDir: string; mainPath: string; publishPath: string } => {
    const mainPath = getMainLogPath();
    const publishPath = getPublishLogPath();
    let mainSize = 0;
    let publishSize = 0;
    try { if (fs.existsSync(mainPath)) mainSize = fs.statSync(mainPath).size; } catch {}
    try { if (fs.existsSync(publishPath)) publishSize = fs.statSync(publishPath).size; } catch {}
    return {
      mainSize,
      publishSize,
      logsDir: getLogsDir(),
      mainPath,
      publishPath,
    };
  });
}
