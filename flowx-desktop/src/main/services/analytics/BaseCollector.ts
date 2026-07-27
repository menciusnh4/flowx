import { BrowserWindow, session } from 'electron';
import { logger } from '../../utils/logger';
import { getAppIcon } from '../../windows/MainWindow';
import { BrowserEnvService } from '../BrowserEnvService';
import { injectAccountCookies } from '../AccountService';
import { sleep, evalJS } from '../platforms/shared';
import type { AccountCredential, PlatformType } from '../../../types';
import { getPlatform } from '../platforms';
import { applyDouyinAntiCrash } from '../platforms';

export interface BaseCollectOptions {
  headless?: boolean;
  windowWidth?: number;
  windowHeight?: number;
}

export abstract class BaseCollector {
  protected platform: PlatformType;
  protected account: AccountCredential;
  protected win: BrowserWindow | null = null;
  protected disposed = false;

  constructor(account: AccountCredential) {
    this.account = account;
    this.platform = account.platform;
  }
  protected makeLog(prefix: string) {
    return (level: 'info' | 'warn' | 'error' | 'debug', stage: string, message: string, data?: Record<string, unknown>) => {
      const fullPrefix = `[AnalyticsCollector][${prefix}]`;
      const payload = data ? ` | ${JSON.stringify(data).slice(0, 200)}` : '';
      const fullMsg = `${fullPrefix}[${stage}] ${message}${payload}`;
      if (level === 'error') {
        logger.error(fullMsg);
      } else if (level === 'warn') {
        logger.warn(fullMsg);
      } else if (level === 'debug') {
        logger.debug(fullMsg);
      } else {
        logger.info(fullMsg);
      }
    };
  }

  async initWindow(opts?: BaseCollectOptions): Promise<BrowserWindow> {
    const { headless = true, windowWidth = 1280, windowHeight = 880 } = opts || {};
    const cred = this.account;
    const accountId = cred.id;
    const partition = `persist:account_${accountId}`;
    const sess = session.fromPartition(partition);

    await BrowserEnvService.applyEnvironment(sess, cred.envId);

    const platform = getPlatform(cred.platform);
    const homeUrl = platform?.meta.homeUrl || '';

    await injectAccountCookies(accountId, homeUrl);

    const win = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      title: `数据采集 - ${cred.nickname || accountId}`,
      show: !headless,
      autoHideMenuBar: true,
      icon: getAppIcon(),
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);

    if (cred.platform === 'douyin') {
      const log = this.makeLog('douyin-anti-crash');
      applyDouyinAntiCrash(win, accountId, log as any);
    }

    this.win = win;

    win.on('closed', () => {
      this.win = null;
    });

    return win;
  }

  async goto(url: string, waitMs: number = 3000): Promise<void> {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('窗口未初始化或已销毁');
    }
    try {
      await this.win.loadURL(url);
    } catch (e) {
      logger.warn(`[AnalyticsCollector] 加载页面失败: ${url} → ${(e as Error).message}`);
    }
    await sleep(waitMs);
  }

  async eval(code: string, desc: string): Promise<unknown> {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('窗口未初始化或已销毁');
    }
    const log = this.makeLog('eval');
    return evalJS(this.win, code, desc, log as any);
  }

  async waitForSelector(selector: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.win || this.win.isDestroyed()) return false;
      try {
        const result = await this.eval(
          `document.querySelector('${selector.replace(/'/g, "\\'")}') ? true : false`,
          `check-${selector.slice(0, 20)}`,
        );
        if (result) return true;
      } catch { /* ignore */ }
      await sleep(500);
    }
    return false;
  }

  async scrollToBottom(): Promise<void> {
    if (!this.win) return;
    await this.eval(`
      (async () => {
        let lastHeight = document.body.scrollHeight;
        let stableCount = 0;
        while (stableCount < 3) {
          window.scrollBy(0, window.innerHeight * 0.8);
          await new Promise(r => setTimeout(r, 800));
          const newHeight = document.body.scrollHeight;
          if (newHeight === lastHeight) {
            stableCount++;
          } else {
            stableCount = 0;
            lastHeight = newHeight;
          }
          if (stableCount >= 3) break;
        }
        window.scrollTo(0, 0);
      })();
    `, 'scroll-to-bottom');
  }

  destroy(): void {
    this.disposed = true;
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch (e) {
        logger.warn(`[AnalyticsCollector] 销毁窗口失败: ${(e as Error).message}`);
      }
    }
    this.win = null;
  }

  isDestroyed(): boolean {
    return this.disposed || !this.win || this.win.isDestroyed();
  }

  abstract collectAccountOverview(): Promise<{
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  }>;

  abstract collectWorksList(limit?: number): Promise<Array<{
    workId: string;
    title: string;
    coverUrl?: string;
    publishTime: number;
    detailUrl?: string;
    duration?: number;
    contentType: 'video' | 'article' | 'image';
    views?: number;
    likes?: number;
    comments?: number;
    favorites?: number;
    shares?: number;
  }>>;
}
