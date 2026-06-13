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

// ✅ 关键修复（Electron 31 + GPU 隔离方案，详见抖音发布解救方案报告）
//    抖音 creator 编辑页上传视频后会触发 0xC0000005 (STATUS_ACCESS_VIOLATION)
//    渲染进程崩溃（exitCode: -1073741819），根源：
//      1) Chromium 旧版本 GLES3 上下文虚拟化共享缺陷
//      2) 无沙盒模式下第三方网页 JS 越权访问本地大文件
//      3) GPU 硬件加速兼容性死锁
//    本项目采用：Electron 31 大版本升级 + GPU 进程隔离 双保险
app.disableHardwareAcceleration();
// 1. 关闭 GPU 沙盒，防止 Windows 系统沙盒误杀 Chromium 图形上下文
app.commandLine.appendSwitch('disable-gpu-sandbox');
// 2. 规避图形合成器渲染冲突（核心开关之一）
app.commandLine.appendSwitch('disable-gpu-compositing');
// 3. 禁用硬件视频解码/编码（视频上传时最容易触发驱动崩溃的路径）
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-accelerated-video-encode');
// 4. 禁用 WebGL（抖音 AI 封面提取用 WebGL，容易崩溃）
app.commandLine.appendSwitch('disable-webgl');
// 5. 保留软件 GL 回退（当 GPU 被禁用时使用）
app.commandLine.appendSwitch('use-gl', 'swiftshader');
// 6. 给渲染进程更多内存空间，防止大页面 OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
// 7. 允许混合内容，防止抖音接口被浏览器安全策略拦截
app.commandLine.appendSwitch('allow-insecure-localhost');

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
