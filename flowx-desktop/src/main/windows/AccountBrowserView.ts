import { app, BrowserWindow, WebContentsView, session } from 'electron';
import path from 'path';
import type { PlatformType } from '../../types';
import { PLATFORMS } from '../services/PlatformRegistry';

// 多开浏览器视图（嵌入在主窗口某个区域，用于账号浏览）
// 每个账号一个独立 partition，隔离登录态
//
// 注：由于要操作第三方网页，账号的登录态通过 cookies 持久化到
// `persist:account_${accountId}` partition；也可用于后续发布自动化。

export class AccountBrowserView {
  public view: WebContentsView;
  public accountId: string;
  public platform: PlatformType;

  constructor(accountId: string, platform: PlatformType, url?: string) {
    this.accountId = accountId;
    this.platform = platform;

    this.view = new WebContentsView({
      webPreferences: {
        partition: `persist:account_${accountId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    const target = url || PLATFORMS[platform]?.publishUrl || PLATFORMS[platform]?.homeUrl;
    if (target) {
      this.view.webContents.loadURL(target).catch(() => {
        /* 网络错误由渲染层提示 */
      });
    }
  }

  /** 将当前视图挂载到指定窗口区域 */
  attachTo(window: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }) {
    window.contentView.addChildView(this.view);
    this.view.setBounds(bounds);
    this.view.setVisible(true);
  }

  detachFrom(window: BrowserWindow) {
    try {
      window.contentView.removeChildView(this.view);
    } catch (_err) {
      /* ignore */
    }
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.view.setVisible(false);
  }

  async loadUrl(url: string) {
    return this.view.webContents.loadURL(url);
  }

  async goHome() {
    const url = PLATFORMS[this.platform]?.homeUrl;
    if (url) await this.loadUrl(url);
  }

  async reload() {
    this.view.webContents.reload();
  }

  async getTitle(): Promise<string> {
    return this.view.webContents.getTitle();
  }

  /** 清理当前账号的 partition 缓存（登出时调用） */
  async clearPartition(): Promise<void> {
    const sess = session.fromPartition(`persist:account_${this.accountId}`);
    await sess.clearStorageData();
    await sess.clearCache();
  }

  destroy(): void {
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }
}

/** 全局已打开的视图索引，便于在渲染层切换时复用 */
const views = new Map<string, AccountBrowserView>();

export function getOrCreateBrowserView(
  accountId: string,
  platform: PlatformType,
  url?: string,
): AccountBrowserView {
  let v = views.get(accountId);
  if (!v) {
    v = new AccountBrowserView(accountId, platform, url);
    views.set(accountId, v);
  }
  return v;
}

export function closeBrowserView(accountId: string, window?: BrowserWindow): void {
  const v = views.get(accountId);
  if (!v) return;
  if (window) v.detachFrom(window);
  v.destroy();
  views.delete(accountId);
}

export function closeAllBrowserViews(): void {
  for (const v of views.values()) {
    v.destroy();
  }
  views.clear();
}
