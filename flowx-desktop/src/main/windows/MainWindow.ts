import { BrowserWindow, app, net, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';

let mainWindow: BrowserWindow | null = null;

// 缓存图标路径，避免重复查找
let _cachedIconPath: string | undefined | null = null;

// 获取应用图标路径（兼容开发/生产环境）
export function getAppIconPath(): string | undefined {
  // 返回缓存结果
  if (_cachedIconPath !== null) {
    return _cachedIconPath;
  }
  
  try {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    
    // 可能的图标路径列表（按优先级排序）
    const candidatePaths: string[] = [];
    
    // 生产环境：从 resources 目录读取
    if (app.isPackaged) {
      // Windows 优先使用 .ico
      if (isWin) {
        candidatePaths.push(path.join(process.resourcesPath, 'icon.ico'));
      }
      // macOS/Linux 使用 .png
      candidatePaths.push(path.join(process.resourcesPath, 'icon.png'));
      candidatePaths.push(path.join(process.resourcesPath, 'icon-512.png'));
      // 兜底
      candidatePaths.push(path.join(process.resourcesPath, 'assets/icon.png'));
    } else {
      // 开发环境：从 build 目录读取
      // __dirname 在编译后是 dist-electron/main/
      const buildDir = path.join(__dirname, '../../build');
      if (isWin) {
        candidatePaths.push(path.join(buildDir, 'icon.ico'));
      }
      candidatePaths.push(path.join(buildDir, 'icon.png'));
      candidatePaths.push(path.join(buildDir, 'icon-512.png'));
      candidatePaths.push(path.join(buildDir, 'icon-1024.png'));
    }
    
    // 查找第一个存在的图标
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        console.log('[FlowX] 找到图标:', p);
        _cachedIconPath = p;
        return p;
      }
    }
    
    console.warn('[FlowX] 未找到图标文件，搜索路径:', candidatePaths);
  } catch (e) {
    console.warn('[FlowX] 获取图标路径失败:', e);
  }
  
  _cachedIconPath = undefined;
  return undefined;
}

// 获取应用图标 nativeImage
export function getAppIcon(): Electron.NativeImage | undefined {
  const iconPath = getAppIconPath();
  if (iconPath) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        return img;
      }
    } catch (e) {
      console.warn('[FlowX] 加载图标失败:', e);
    }
  }
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  const isDev = !app.isPackaged;
  // 关键修复：Windows 上优先用 127.0.0.1，避免 localhost 解析为 IPv6 [::1] 导致 connection refused
  const devUrl = process.env.VITE_DEV_SERVER_URL?.replace('localhost', '127.0.0.1') || 'http://127.0.0.1:5173/';

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
