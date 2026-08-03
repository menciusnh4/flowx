import { BrowserWindow, app, net } from 'electron';
import path from 'path';
import { getAppIcon, getMainWindow } from './MainWindow';

let quickPublishWindow: BrowserWindow | null = null;

function resolveAssetPath(relativeFromBundleRoot: string): string {
  const bundleDir = __dirname;
  return path.join(bundleDir, relativeFromBundleRoot);
}

async function waitForDevServer(url: string, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      try {
        const req = net.request({ method: 'GET', url });
        req.on('response', (res) => {
          if (res.statusCode >= 200 && res.statusCode < 500) {
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
        reject(new Error(`Dev server ${url} 在 ${timeoutMs}ms 内未就绪`));
        return;
      }
      setTimeout(probe, 400);
    };
    probe();
  });
}

/** 创建独立的快速发布窗口（一键发布页） */
export async function createQuickPublishWindow(): Promise<BrowserWindow> {
  if (quickPublishWindow && !quickPublishWindow.isDestroyed()) {
    if (quickPublishWindow.isMinimized()) {
      quickPublishWindow.restore();
    }
    quickPublishWindow.show();
    quickPublishWindow.focus();
    return quickPublishWindow;
  }

  const mainWindow = getMainWindow();
  const mainBounds = mainWindow?.getBounds();

  // 因为隐藏了顶部导航菜单，窗口高度可以小一些
  const width = 1200;
  const height = 760;
  let x: number | undefined;
  let y: number | undefined;

  if (mainBounds) {
    x = Math.round(mainBounds.x + (mainBounds.width - width) / 2);
    y = Math.round(mainBounds.y + (mainBounds.height - height) / 2);
  }

  const preloadPath = resolveAssetPath('../preload/index.js');
  const prodHtmlPath = resolveAssetPath('../../dist/index.html');
  const appIcon = getAppIcon();

  quickPublishWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 640,
    x,
    y,
    autoHideMenuBar: true,
    title: '快速发布 - FlowX',
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
  const devUrl = process.env.VITE_DEV_SERVER_URL?.replace('localhost', '127.0.0.1') || 'http://127.0.0.1:41730/';
  // 使用专用路由 /quick-publish（hideHeader=true，不显示顶部导航菜单）
  const publishHash = '#/quick-publish';

  if (isDev) {
    try {
      await waitForDevServer(devUrl, 20000);
      quickPublishWindow.loadURL(devUrl + publishHash).catch((err) => {
        console.error('[QuickPublishWindow] 加载开发页面失败:', err);
      });
    } catch (err) {
      console.error('[QuickPublishWindow] Dev server 不可用:', err);
      quickPublishWindow.loadURL(devUrl + publishHash).catch(() => {});
    }
  } else {
    quickPublishWindow
      .loadFile(prodHtmlPath, { hash: '/quick-publish' })
      .catch((err) => console.error('[QuickPublishWindow] 加载生产页面失败:', err));
  }

  quickPublishWindow.on('closed', () => {
    quickPublishWindow = null;
  });

  return quickPublishWindow;
}

export function getQuickPublishWindow(): BrowserWindow | null {
  return quickPublishWindow;
}

export function closeQuickPublishWindow(): void {
  if (quickPublishWindow && !quickPublishWindow.isDestroyed()) {
    quickPublishWindow.close();
  }
}
