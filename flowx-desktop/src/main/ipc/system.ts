import { ipcMain, shell, app, dialog, BrowserWindow } from 'electron';
import { safeInvoke } from './index';
import type { SystemInfo, UpdateInfo } from '../../types';
import { getMainWindow } from '../windows/MainWindow';

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
}
