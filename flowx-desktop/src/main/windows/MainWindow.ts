import { BrowserWindow, app, net, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';

let mainWindow: BrowserWindow | null = null;

// 缓存图标，避免重复加载
let _cachedIcon: Electron.NativeImage | undefined | null = null;

// 获取应用图标（nativeImage）
// 按照electron-builder官方推荐方式：
// - 开发环境: build/icon.png (1024x1024)
// - 生产环境: electron-builder会自动将图标嵌入exe，
//   但我们仍然尝试从resources加载，确保窗口图标正确
export function getAppIcon(): Electron.NativeImage | undefined {
  if (_cachedIcon !== null) {
    return _cachedIcon;
  }
  
  try {
    const candidatePaths: string[] = [];
    
    if (app.isPackaged) {
      // 生产环境：electron-builder会将图标放在resources目录
      candidatePaths.push(path.join(process.resourcesPath, 'icon.png'));
      // Windows上exe图标已经嵌入，也可以尝试ico
      candidatePaths.push(path.join(process.resourcesPath, 'icon.ico'));
    } else {
      // 开发环境：从build目录读取
      const buildDir = path.join(__dirname, '../../build');
      candidatePaths.push(path.join(buildDir, 'icon.png'));
      candidatePaths.push(path.join(buildDir, 'icon.ico'));
    }
    
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          console.log('[FlowX] 加载应用图标:', p);
          _cachedIcon = img;
          return img;
        }
      }
    }
    
    console.warn('[FlowX] 未找到图标文件');
  } catch (e) {
    console.warn('[FlowX] 获取应用图标失败:', e);
  }
  
  _cachedIcon = undefined;
  return undefined;
}

// 获取图标路径（兼容旧代码）
export function getAppIconPath(): string | undefined {
  const icon = getAppIcon();
  // nativeImage没有直接获取路径的方法，这里返回undefined让Electron使用默认
  return undefined;
}

// 动态解析 preload / 生产产物路径（兼容 development / production）
function resolveAssetPath(relativeFromBundleRoot: string): string {
  const bundleDir = __dirname; // dist-electron/main
  const candidate = path.join(bundleDir, relativeFromBundleRoot);
  console.log(`[FlowX] 预解析资源路径: ${relativeFromBundleRoot} -> ${candidate}`);
  return candidate;
}

// 轮询 Vite dev server 直到返回 2xx/3xx 或超时
function waitForDevServer(url: string, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      try {
        const req = net.request({ method: 'GET', url });
        req.on('response', (res) => {
          if (res.statusCode >= 200 && res.statusCode < 500) {
            console.log(`[FlowX] Dev server ${url} 就绪 (HTTP ${res.statusCode})`);
            resolve();
          } else {
            retrySoon();
          }
        });
        req.on('error', () => retrySoon());
        req.end();
      } catch {
        retrySoon();
      }
    };
    const retrySoon = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Vite dev server ${url} 在 ${timeoutMs}ms 内未就绪，请检查端口是否被占用或是否有代理软件拦截`));
        return;
      }
      setTimeout(probe, 400);
    };
    probe();
  });
}

// 主窗口（单例）
export async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const preloadPath = resolveAssetPath('../preload/index.js');
  const prodHtmlPath = resolveAssetPath('../../dist/index.html');
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: 'FlowX - 多平台内容发布',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: preloadPath,
      // 关键约束：<webview> 标签在 sandboxed 渲染进程中不被 Electron 支持，
      // 必须关闭 sandbox 才能用 webview 内嵌创作中心（否则 webview 不被升级、右侧空白）。
      // 安全由 contextIsolation + contextBridge（preload 仅暴露受限 API）+ nodeIntegration:false 兜底。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      spellcheck: false,
      // 允许渲染层用 <webview> 标签内嵌创作中心（第三方平台），替代原生 WebContentsView 层
      webviewTag: true,
    },
  });

  const isDev = !app.isPackaged;
  // 关键修复：Windows 上优先用 127.0.0.1，避免 localhost 解析为 IPv6 [::1] 导致 connection refused
  const devUrl = process.env.VITE_DEV_SERVER_URL?.replace('localhost', '127.0.0.1') || 'http://127.0.0.1:41730/';

  if (isDev) {
    try {
      await waitForDevServer(devUrl, 20000);
      mainWindow.loadURL(devUrl).catch((err) => {
        console.error('[FlowX] 加载开发页面失败:', err);
      });
    } catch (err) {
      console.error('[FlowX] Dev server 不可用:', err);
      mainWindow.loadURL(devUrl).catch(() => {}); // 即使失败也尝试加载，便于用户看到错误页
    }
  } else {
    mainWindow
      .loadFile(prodHtmlPath)
      .catch((err) => console.error('[FlowX] 加载生产页面失败:', err));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 主窗口 DevTools：F12 / Ctrl+Shift+I → 以 detach 独立窗口打开，
  // 避免被右侧创作中心原生 WebContentsView 层级遮挡（docked 模式会被盖住）。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      event.preventDefault();
      if (mainWindow!.webContents.isDevToolsOpened()) mainWindow!.webContents.closeDevTools();
      else mainWindow!.webContents.openDevTools({ mode: 'detach' });
    } else if (input.key === 'I' && input.control && input.shift && input.type === 'keyDown') {
      event.preventDefault();
      if (mainWindow!.webContents.isDevToolsOpened()) mainWindow!.webContents.closeDevTools();
      else mainWindow!.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 如果首次加载失败，给出中文诊断页 + 刷新按钮，避免白屏
  mainWindow.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
    try {
      mainWindow?.webContents.executeJavaScript(
        `document.title='FlowX';document.body.innerHTML='<div style="font-family:sans-serif;padding:40px 16px;text-align:center;color:#555"><h2 style="color:#333">FlowX 加载失败</h2><p>Vite dev server 尚未就绪，请尝试刷新。</p><p style="color:#888;font-size:12px">URL: <code>${escapeForHtml(url || devUrl)}</code></p><button onclick="location.reload()" style="margin-top:12px;padding:8px 16px;font-size:14px;cursor:pointer;border-radius:6px;border:1px solid #ccc;background:#fff">重新加载</button></div>'`
      );
    } catch {
      // ignore
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function escapeForHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
