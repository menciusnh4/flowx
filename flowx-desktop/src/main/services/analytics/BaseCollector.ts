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

  async fetchAPI<T>(url: string, desc: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<T> {
    const { method = 'GET', headers, body } = options || {};
    const code = `
      (async function() {
        try {
          return await new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('${method}', '${url}', true);
            xhr.withCredentials = true;
            xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            ${headers ? Object.entries(headers).map(([k, v]) => `xhr.setRequestHeader('${k}', '${v}');`).join('\n            ') : ''}
            xhr.onload = function() {
              try {
                var json = JSON.parse(xhr.responseText);
                resolve({ ok: true, data: json, status: xhr.status });
              } catch (e) {
                resolve({ ok: true, data: xhr.responseText, status: xhr.status, isText: true });
              }
            };
            xhr.onerror = function() {
              reject(new Error('XHR network error'));
            };
            ${body ? `xhr.send('${body.replace(/'/g, "\\'")}');` : 'xhr.send();'}
          });
        } catch (e) {
          return { ok: false, error: e.message, stack: (e.stack || '').slice(0, 1000) };
        }
      })();
    `;
    const result = await this.eval(code, desc) as {
      ok: boolean;
      data?: T;
      error?: string;
      stack?: string;
      status?: number;
      isText?: boolean;
    };
    if (!result.ok) {
      throw new Error(`[${desc}] 请求失败: ${result.error}\n${result.stack || ''}`);
    }
    return result.data as T;
  }

  async waitForNetworkResponse(urlPattern: RegExp, timeoutMs: number = 30000): Promise<any> {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('窗口未初始化或已销毁');
    }

    const log = this.makeLog('network');
    const debuggerObj = this.win.webContents.debugger;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          try {
            if (debuggerObj.isAttached()) {
              debuggerObj.detach();
            }
          } catch {}
          reject(new Error(`等待网络响应超时: ${urlPattern}`));
        }
      }, timeoutMs);

      const onResponseReceived = (_event: any, details: any) => {
        if (resolved) return;
        const { requestId, response } = details;
        if (!response || !response.url) return;
        
        if (urlPattern.test(response.url)) {
          log('info', 'response-caught', `捕获到响应: ${response.url.slice(0, 100)}`);
          
          try {
            debuggerObj.sendCommand('Network.getResponseBody', { requestId }).then((bodyResult: any) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);
              
              try {
                const body = bodyResult.body;
                const isBase64 = bodyResult.base64Encoded;
                let data;
                if (isBase64) {
                  data = JSON.parse(Buffer.from(body, 'base64').toString('utf-8'));
                } else {
                  data = JSON.parse(body);
                }
                
                try {
                  if (debuggerObj.isAttached()) {
                    debuggerObj.detach();
                  }
                } catch {}
                
                resolve(data);
              } catch (e) {
                try {
                  if (debuggerObj.isAttached()) {
                    debuggerObj.detach();
                  }
                } catch {}
                reject(new Error(`解析响应体失败: ${(e as Error).message}`));
              }
            }).catch((err: Error) => {
              log('warn', 'get-body-fail', `获取响应体失败: ${err.message}`);
            });
          } catch (e) {
            log('warn', 'send-cmd-fail', `发送命令失败: ${(e as Error).message}`);
          }
        }
      };

      try {
        if (!debuggerObj.isAttached()) {
          debuggerObj.attach('1.3');
        }
        debuggerObj.sendCommand('Network.enable');
        debuggerObj.on('message', (_event: any, method: string, params: any) => {
          if (method === 'Network.responseReceived') {
            onResponseReceived(_event, params);
          }
        });
        log('info', 'network-listening', `开始监听网络请求，匹配: ${urlPattern}`);
      } catch (e) {
        clearTimeout(timeout);
        reject(new Error(`启动网络监听失败: ${(e as Error).message}`));
      }
    });
  }

  private networkCollector: {
    urlPattern: RegExp | null;
    responses: any[];
    processedIndex: number;
    listening: boolean;
    debuggerAttached: boolean;
  } = {
    urlPattern: null,
    responses: [],
    processedIndex: -1,
    listening: false,
    debuggerAttached: false,
  };

  async startNetworkCollect(urlPattern: RegExp): Promise<void> {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('窗口未初始化或已销毁');
    }

    const log = this.makeLog('network');
    const debuggerObj = this.win.webContents.debugger;

    this.networkCollector.urlPattern = urlPattern;
    this.networkCollector.responses = [];
    this.networkCollector.processedIndex = -1;
    this.networkCollector.listening = true;

    const pendingResponses = new Map<string, any>();

    const onMessage = (_event: any, method: string, params: any) => {
      if (!this.networkCollector.listening) return;

      if (method === 'Network.responseReceived') {
        const { requestId, response } = params;
        if (!response || !response.url) return;
        if (!this.networkCollector.urlPattern?.test(response.url)) return;

        log('info', 'response-matched', `匹配到响应: ${response.url.slice(0, 100)}`);
        pendingResponses.set(requestId, { url: response.url });
        return;
      }

      if (method === 'Network.loadingFinished') {
        const { requestId } = params;
        const pending = pendingResponses.get(requestId);
        if (!pending) return;

        pendingResponses.delete(requestId);
        
        try {
          debuggerObj.sendCommand('Network.getResponseBody', { requestId }).then((bodyResult: any) => {
            try {
              const body = bodyResult.body;
              const isBase64 = bodyResult.base64Encoded;
              let data;
              if (isBase64) {
                data = JSON.parse(Buffer.from(body, 'base64').toString('utf-8'));
              } else {
                data = JSON.parse(body);
              }
              this.networkCollector.responses.push({
                url: pending.url,
                data,
                timestamp: Date.now(),
              });
              log('info', 'response-saved', `响应已保存，当前共 ${this.networkCollector.responses.length} 个`);
            } catch (e) {
              log('warn', 'parse-fail', `解析响应体失败: ${(e as Error).message}`);
            }
          }).catch((err: Error) => {
            log('warn', 'get-body-fail', `获取响应体失败: ${err.message}`);
          });
        } catch (e) {
          log('warn', 'send-cmd-fail', `发送命令失败: ${(e as Error).message}`);
        }
      }
    };

    try {
      if (!debuggerObj.isAttached()) {
        debuggerObj.attach('1.3');
        this.networkCollector.debuggerAttached = true;
        log('info', 'debugger-attached', 'Debugger 已附加');
      } else {
        log('info', 'debugger-already-attached', 'Debugger 已附加（复用）');
      }
      debuggerObj.sendCommand('Network.enable');
      debuggerObj.on('message', onMessage);
      log('info', 'collect-start', `开始收集网络响应，匹配: ${urlPattern}`);
    } catch (e) {
      throw new Error(`启动网络收集失败: ${(e as Error).message}`);
    }
  }

  async waitForNextNetworkResponse(timeoutMs: number = 15000): Promise<any> {
    const log = this.makeLog('network');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const nextIndex = this.networkCollector.processedIndex + 1;
      if (nextIndex < this.networkCollector.responses.length) {
        this.networkCollector.processedIndex = nextIndex;
        const resp = this.networkCollector.responses[nextIndex];
        log('info', 'next-response', `获取到第 ${nextIndex + 1} 个响应`);
        return resp.data;
      }
      await sleep(200);
    }
    
    throw new Error(`等待下一个网络响应超时（${timeoutMs}ms），已处理 ${this.networkCollector.processedIndex + 1} 个`);
  }

  stopNetworkCollect(): void {
    const log = this.makeLog('network');
    const debuggerObj = this.win?.webContents?.debugger;

    this.networkCollector.listening = false;
    this.networkCollector.urlPattern = null;

    if (debuggerObj && this.networkCollector.debuggerAttached) {
      try {
        if (debuggerObj.isAttached()) {
          debuggerObj.detach();
        }
        this.networkCollector.debuggerAttached = false;
        log('info', 'collect-stop', '停止网络收集，已分离 debugger');
      } catch (e) {
        log('warn', 'detach-fail', `分离 debugger 失败: ${(e as Error).message}`);
      }
    }
  }

  getCollectedResponses(): any[] {
    return [...this.networkCollector.responses];
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
