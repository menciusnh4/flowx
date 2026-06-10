import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { registerAllIpc } from './ipc';
import { createMainWindow, getMainWindow } from './windows/MainWindow';
import { setupLogger, logger } from './utils/logger';
import { initStore } from './store/SecureStore';
import { AccountService } from './services/AccountService';
import { PublishEngine } from './services/PublishEngine';

// FlowX 主进程入口
// 负责: 窗口管理、IPC 注册、服务初始化、生命周期事件

// 安全基线：禁用不安全的 API
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let isReady = false;

async function bootstrap() {
  setupLogger();
  logger.info('[FlowX] 应用启动');

  // 单实例锁
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    logger.info('[FlowX] 已有实例运行，退出');
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // 当 Electron 完成初始化并准备好创建浏览器窗口时调用
  await app.whenReady();
  isReady = true;

  // 初始化存储（加密）
  initStore();

  // 初始化业务服务
  AccountService.init();
  PublishEngine.init();

  // 创建主窗口（等待 Vite dev server 就绪后才加载）
  await createMainWindow();

  // 注册所有 IPC 监听
  registerAllIpc();

  // 测试模式（FLOWX_TEST=1）：启动后 2 秒自动退出，用于冒烟测试
  if (process.env.FLOWX_TEST === '1') {
    setTimeout(() => {
      logger.info('[FlowX][TEST] 冒烟测试完成，主动退出');
      process.exit(0);
    }, 2500);
  }

  // 当所有窗口关闭时（macOS 除外）退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // 在 macOS 上，当点击 dock 图标并且没有其他窗口打开时，通常重新创建一个窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.on('before-quit', () => {
  logger.info('[FlowX] 应用退出');
});

bootstrap().catch((err) => {
  console.error('[FlowX] 启动失败:', err);
  if (isReady) {
    logger.error('[FlowX] 启动失败', err);
  }
  process.exit(1);
});

// 让 preload 能拿到正确路径（vite-plugin-electron 默认已处理）
export const preloadPath = path.join(__dirname, '../preload/index.js');
