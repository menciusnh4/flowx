import { BrowserWindow, app, net } from 'electron';
import path from 'path';
import { getAppIcon, getMainWindow } from './MainWindow';

let aboutWindow: BrowserWindow | null = null;

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

export async function createAboutWindow(): Promise<BrowserWindow> {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return aboutWindow;
  }

  const mainWindow = getMainWindow();
  const mainBounds = mainWindow?.getBounds();

  const width = 720;
  const height = 600;
  let x: number | undefined;
  let y: number | undefined;

  if (mainBounds) {
    x = Math.round(mainBounds.x + (mainBounds.width - width) / 2);
    y = Math.round(mainBounds.y + (mainBounds.height - height) / 2);
  }

  const preloadPath = resolveAssetPath('../preload/index.js');
  const prodHtmlPath = resolveAssetPath('../../dist/index.html');
  const appIcon = getAppIcon();

  aboutWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    modal: !!mainWindow,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    title: '关于 FlowX',
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
  const aboutHash = '#/about-window';

  if (isDev) {
    try {
      await waitForDevServer(devUrl, 20000);
      aboutWindow.loadURL(devUrl + aboutHash).catch((err) => {
        console.error('[AboutWindow] 加载开发页面失败:', err);
      });
    } catch (err) {
      console.error('[AboutWindow] Dev server 不可用:', err);
      aboutWindow.loadURL(devUrl + aboutHash).catch(() => {});
    }
  } else {
    aboutWindow
      .loadFile(prodHtmlPath, { hash: '/about-window' })
      .catch((err) => console.error('[AboutWindow] 加载生产页面失败:', err));
  }

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  return aboutWindow;
}

export function getAboutWindow(): BrowserWindow | null {
  return aboutWindow;
}

export function closeAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.close();
  }
}
