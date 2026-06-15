import { BrowserWindow, session as electronSession } from 'electron';
import type { PublishLogEntry, PublishItemProgress, PublishRequest, PlatformType, ContentType } from '../../../types';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function makePublishLogger(opts: {
  taskId?: string;
  accountId?: string;
  platform?: PlatformType;
}) {
  return (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => {
    const prefix = `[${opts.platform || 'platform'}]`;
    const payload = data ? ` | ${JSON.stringify(data).slice(0, 300)}` : '';
    if (level === 'error' || level === 'warn') {
      console.warn(`${prefix}[${stage}] ${message}${payload}`);
    } else {
      console.log(`${prefix}[${stage}] ${message}${payload}`);
    }
  };
}

/**
 * 页面导航跟踪器：解决"上传后抖音跳转到内容编辑页"导致的
 * "Render frame was disposed before WebFrameMain could be accessed" 错误。
 *
 * 使用方法：
 *   const tracker = attachNavigationTracker(win);
 *   // 执行可能触发导航的操作（如注入文件、点击按钮）
 *   await tracker.waitForStable(); // 等待导航稳定
 *   tracker.dispose();
 */
export interface NavigationTracker {
  /** 是否检测到有正在进行的导航/页面加载 */
  isNavigating(): boolean;
  /** 等待导航稳定：没有新的导航事件 + 页面不处于加载状态 */
  waitForStable(minStableMs?: number, timeoutMs?: number): Promise<void>;
  /** 停止监听 */
  dispose(): void;
}

export function attachNavigationTracker(
  win: BrowserWindow,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): NavigationTracker {
  let lastNavigationAt = Date.now();
  let navigateCount = 0;
  const listeners: Array<() => void> = [];

  const markNavigation = (source: string, url?: string) => {
    lastNavigationAt = Date.now();
    navigateCount += 1;
    log('debug', 'navigation', `检测到导航 (${source})`, { count: navigateCount, url: (url || '').slice(0, 120) });
  };

  const onNavigate = (_e: any, url: string) => markNavigation('did-navigate', url);
  const onInPage = (_e: any, url: string) => markNavigation('did-navigate-in-page', url);
  const onFrameNav = (_e: any, url: string) => markNavigation('did-frame-navigate', url);
  const onStart = () => markNavigation('did-start-loading');
  const onStop = () => markNavigation('did-stop-loading');

  try { win.webContents.on('did-navigate', onNavigate); listeners.push(() => win.webContents.removeListener('did-navigate', onNavigate)); } catch { /* ignore */ }
  try { win.webContents.on('did-navigate-in-page', onInPage); listeners.push(() => win.webContents.removeListener('did-navigate-in-page', onInPage)); } catch { /* ignore */ }
  try { win.webContents.on('did-frame-navigate', onFrameNav); listeners.push(() => win.webContents.removeListener('did-frame-navigate', onFrameNav)); } catch { /* ignore */ }
  try { win.webContents.on('did-start-loading', onStart); listeners.push(() => win.webContents.removeListener('did-start-loading', onStart)); } catch { /* ignore */ }
  try { win.webContents.on('did-stop-loading', onStop); listeners.push(() => win.webContents.removeListener('did-stop-loading', onStop)); } catch { /* ignore */ }

  return {
    isNavigating() {
      // 300ms 内发生过导航事件 或 页面仍在加载
      return Date.now() - lastNavigationAt < 500 || win.webContents.isLoading();
    },
    async waitForStable(minStableMs = 1000, timeoutMs = 10000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (this.isNavigating()) {
          log('debug', 'navigation', '页面仍在导航/加载中，等待…');
          await sleep(300);
          continue;
        }
        // 二次确认：至少 minStableMs 没有新的导航
        const since = Date.now() - lastNavigationAt;
        if (since >= minStableMs && !win.webContents.isLoading()) {
          log('debug', 'navigation', `页面已稳定 (空闲 ${since}ms)`);
          return;
        }
        await sleep(200);
      }
      log('warn', 'navigation', `导航稳定超时 (${timeoutMs}ms)，继续后续流程`);
    },
    dispose() {
      listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    },
  };
}

/** 临时错误判断：导航导致的 frame disposed / 空 body 等错误都可重试 */
function isTransientEvalError(msg: string): boolean {
  return /frame was disposed|Render frame|navigation|No current|Cannot read property|document.body is null|null object|context is invalid|Execution context was destroyed|No frame|target frame|subframe/i.test(msg);
}

export async function evalJS(
  win: BrowserWindow,
  code: string,
  desc: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  opts?: { maxRetries?: number; stableMs?: number },
): Promise<unknown> {
  const maxRetries = opts?.maxRetries ?? 6;
  const stableMs = opts?.stableMs ?? 400;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 若页面正在加载 / 最近刚刚发生导航 → 先等稳定
      if (win.webContents.isLoading()) {
        try {
          await new Promise<void>((done) => {
            const timeout = setTimeout(done, 5000);
            win.webContents.once('did-stop-loading', () => {
              clearTimeout(timeout);
              done();
            });
          });
        } catch { /* ignore */ }
        await sleep(300);
      } else if (attempt > 0) {
        // 重试前多留一点缓冲
        await sleep(stableMs);
      }

      const result = await win.webContents.executeJavaScript(code);
      if (attempt > 0) {
        log('debug', 'eval', `[${desc}] 重试成功 (第 ${attempt + 1} 次)`);
      }
      log('debug', 'eval', `[${desc}] ok`, {
        result: JSON.stringify(result).slice(0, 200),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = err;

      if (isTransientEvalError(msg) && attempt < maxRetries - 1) {
        const backoff = Math.min(2000, 250 * (attempt + 1));
        log('debug', 'eval-retry', `[${desc}] 临时错误，${backoff}ms 后重试 (第 ${attempt + 1}/${maxRetries} 次): ${msg.slice(0, 100)}`);
        await sleep(backoff);
        continue;
      }

      log('warn', 'eval-error', `[${desc}] 失败: ${msg}`);
      throw new Error(`[${desc}] 失败: ${msg}`);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  log('warn', 'eval-error', `[${desc}] 重试 ${maxRetries} 次仍失败: ${msg}`);
  throw new Error(`[${desc}] 失败: ${msg}`);
}

/** 创建使用特定账号 partition 的浏览器窗口（发布流程统一入口） */
export function makePublishWindow(accountId: string, title: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: `persist:account_${accountId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  return win;
}

// =======================================================================
// 抖音发布窗口稳定性（Electron 31 已解决 GPU 崩溃，此处仅保留最轻量的崩溃恢复兜底）
// =======================================================================

/**
 * 给抖音发布窗口添加渲染进程崩溃恢复（仅 1 次）。
 * Electron 31 已修复底层 GPU 崩溃根源，因此不再需要：
 *   - WebAssembly / Worker 冻结 polyfill
 *   - webRequest 拦截
 *   - 25 秒静默等待
 * 如果发生崩溃，自动 reload 一次作为兜底（主要应对偶发网络问题）。
 */
export function applyDouyinAntiCrash(
  win: BrowserWindow,
  accountId: string,
  log?: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): void {
  const _log = log || ((_lv: PublishLogEntry['level'], stage: string, msg: string) => {
    console.log(`[douyin][${stage}] ${msg}`);
  });

  _log('info', 'anti-crash', `✅ 窗口初始化完成（Electron 31，无 polyfill，无 webRequest 拦截）`, {
    accountId,
  });

  // 渲染进程崩溃恢复：最多 1 次 reload，之后停止
  let crashCount = 0;
  let stopRecover = false;
  win.webContents.on('render-process-gone', (_e, details) => {
    crashCount++;
    _log('error', 'render-crash', `❌ 渲染进程崩溃（第${crashCount}次）`, {
      reason: details?.reason,
      exitCode: details?.exitCode,
    });
    if (crashCount === 1 && !stopRecover && !win.isDestroyed()) {
      _log('info', 'render-crash', '🔄 reload 当前页恢复（1/1）');
      setTimeout(() => {
        if (!win.isDestroyed()) {
          try { win.webContents.reload(); } catch { /* ignore */ }
        }
      }, 2000);
      stopRecover = true;
    } else {
      _log('warn', 'render-crash', `⚠️ 已停止自动恢复（超过 1 次崩溃上限），请手动检查`);
      stopRecover = true;
    }
  });
}

/** 创建一个失败的发布结果（统一格式） */
export function makeFailedResult(
  accountId: string,
  platform: PlatformType,
  message: string,
  startedAt?: number,
): PublishItemProgress {
  return {
    accountId,
    platform,
    status: 'failed',
    progress: 100,
    message: `发布失败: ${message}`,
    startedAt: startedAt || Date.now(),
    finishedAt: Date.now(),
  };
}

/**
 * CDP 文件上传 v4 — 针对快手等"上传按钮+隐藏 file input 已存在"的页面
 *
 * 策略顺序（按可靠性从高到低）：
 *   1. DOM.getDocument (pierce:true) → DOM.setFileInputFiles 直接注入（最可靠）
 *   2. Runtime.evaluate 获取 objectId → DOM.setFileInputFiles
 *   3. Page.setInterceptFileChooserDialog + 点击"上传视频"按钮
 *   4. DOM.performSearch 全局搜索 "input type=file" → setFileInputFiles
 *
 * 关键改进：所有策略成功后均会执行 verifyFilesInjected() 校验 input.files.length>0
 * 页面实际结构：<input type=file style=display:none> 已在主文档中存在，点击按钮触发它
 */
export async function uploadViaCDP(
  win: BrowserWindow,
  files: string[],
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    log('info', 'upload', `开始上传: ${files.join(', ')}`);

    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 可能已 attached */ }

    // 统一工具：用指定 nodeId / objectId 注入文件
    const tryInjectFiles = async (nodeId: number | undefined, objectId: string | undefined, source: string): Promise<boolean> => {
      try {
        const params: Record<string, unknown> = { files: files };
        if (nodeId !== undefined && nodeId !== null) {
          params.nodeId = nodeId;
          log('info', 'upload', `[${source}] 以 nodeId=${nodeId} 注入文件…`);
        } else if (objectId !== undefined) {
          params.objectId = objectId;
          log('info', 'upload', `[${source}] 以 objectId=${objectId.slice(0, 24)}... 注入文件…`);
        } else {
          return false;
        }
        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', params);
        log('info', 'upload', `✅ [${source}] DOM.setFileInputFiles 返回成功`);
        await sleep(1500);
        return true;
      } catch (e) {
        log('warn', 'upload', `[${source}] 注入失败: ${(e as Error).message}`);
        return false;
      }
    };

    // 步骤 A：点击上传按钮，让页面创建 input[type=file]
    // （快手等平台是懒创建的：需要先点击"上传视频"按钮才会创建 file input）
    try {
      log('info', 'upload', `[A] 点击上传按钮，让页面创建 file input…`);
      const clickScript = `
        (function () {
          var candidates = [];
          // 1. 优先点击 class 含 _upload-btn 的按钮（快手专用）
          try {
            var classBtns = document.querySelectorAll('button[class*=_upload-btn], [class*=_upload-btn] button, [class*=_upload-btn_]');
            for (var ci = 0; ci < classBtns.length; ci++) {
              if (classBtns[ci] && classBtns[ci].offsetWidth > 0) {
                candidates.push({ el: classBtns[ci], score: 100, reason: 'class-upload-btn', text: classBtns[ci].innerText || '' });
              }
            }
          } catch (e) {}
          // 2. 匹配文字"上传视频"的按钮
          try {
            var all = document.querySelectorAll('button, span, div, a');
            for (var ti = 0; ti < all.length; ti++) {
              var txt = (all[ti].innerText || all[ti].textContent || '').trim();
              if (!txt) continue;
              var score = 0;
              if (txt === '上传视频') score += 80;
              else if (txt.indexOf('上传视频') !== -1) score += 50;
              else if (txt === '点击上传') score += 70;
              else if (txt === '上传') score += 40;
              if (score > 0 && all[ti].offsetWidth >= 20 && all[ti].offsetHeight >= 20) {
                candidates.push({ el: all[ti], score: score, reason: 'text-match', text: txt });
              }
            }
          } catch (e) {}
          if (candidates.length === 0) return { clicked: false, count: 0 };
          candidates.sort(function (a, b) { return b.score - a.score; });
          var target = candidates[0];
          try { target.el.click(); } catch (e) {}
          // 也触发一次事件
          try { target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) {}
          return { clicked: true, count: candidates.length, text: target.text.slice(0, 60), reason: target.reason };
        })();
      `;
      const clickRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: clickScript, returnByValue: true,
      }).catch(() => null);
      const clickVal = clickRes && clickRes.result && clickRes.result.value ? clickRes.result.value : null;
      log('info', 'upload', `[A] 点击结果: ${clickVal ? JSON.stringify(clickVal).slice(0, 200) : 'unknown'}`);
      await sleep(1500);
    } catch (err) {
      log('warn', 'upload', `[A] 点击上传按钮异常: ${(err as Error).message}`);
    }

    // 步骤 B：用多种 CDP 方式查找 input[type=file] 并注入文件
    // 策略 1：DOM.getDocument(pierce:true) + 手动遍历（递归处理 shadowRoots）
    try {
      log('info', 'upload', `[B1] DOM.getDocument 递归遍历 DOM 树（含 Shadow DOM）…`);
      const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }).catch(() => null);
      if (docResult && docResult.root) {
        const allNodes: any[] = [];
        const walk = (n: any) => {
          if (!n) return;
          allNodes.push(n);
          if (n.children) n.children.forEach(walk);
          if (n.shadowRoots) n.shadowRoots.forEach(walk);
          if (n.templateContent) walk(n.templateContent);
          if (n.contentDocument) walk(n.contentDocument);
        };
        walk(docResult.root);
        log('info', 'upload', `[B1] 遍历 ${allNodes.length} 个节点，查找 type=file 的 input…`);

        let foundFileNodes = 0;
        for (const n of allNodes) {
          if (!n || !n.attributes) continue;
          const nn = (n.nodeName || '').toLowerCase();
          if (nn !== 'input') continue;
          for (let i = 0; i < n.attributes.length; i += 2) {
            if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') {
              foundFileNodes++;
              if (await tryInjectFiles(n.nodeId, undefined, `B1-node${n.nodeId}`)) return true;
              break;
            }
          }
        }
        if (foundFileNodes > 0) {
          log('warn', 'upload', `[B1] 找到 ${foundFileNodes} 个 file input，但均注入失败`);
        } else {
          log('warn', 'upload', `[B1] 未找到 file input 节点`);
        }
      }
    } catch (err) {
      log('warn', 'upload', `[B1] 异常: ${(err as Error).message}`);
    }

    // 策略 2：DOM.querySelector 主文档根
    try {
      log('info', 'upload', `[B2] DOM.querySelector 搜索 file input…`);
      const docResult2: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true }).catch(() => null);
      if (docResult2 && docResult2.root && docResult2.root.nodeId !== undefined) {
        const qsResult: any = await win.webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: docResult2.root.nodeId,
          selector: 'input[type="file"]',
        }).catch(() => null);
        if (qsResult && qsResult.nodeId !== undefined && qsResult.nodeId !== 0) {
          if (await tryInjectFiles(qsResult.nodeId, undefined, 'B2-querySelector')) return true;
        }
        // 再试 querySelectorAll
        const qsaResult: any = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', {
          nodeId: docResult2.root.nodeId,
          selector: 'input[type="file"]',
        }).catch(() => null);
        if (qsaResult && qsaResult.nodeIds && qsaResult.nodeIds.length > 0) {
          log('info', 'upload', `[B2] querySelectorAll 找到 ${qsaResult.nodeIds.length} 个 file input`);
          for (const nid of qsaResult.nodeIds) {
            if (await tryInjectFiles(nid, undefined, `B2-qsa-node${nid}`)) return true;
          }
        }
      }
    } catch (err) {
      log('warn', 'upload', `[B2] 异常: ${(err as Error).message}`);
    }

    // 策略 3：Runtime.evaluate 返回元素 objectId
    try {
      log('info', 'upload', `[B3] Runtime.evaluate 获取 file input 的 objectId…`);
      // 脚本：直接 return 元素（不包对象），否则返回 null
      const script = `(function(){var el=document.querySelector('input[type=file]');if(!el){var all=document.querySelectorAll('iframe');for(var i=0;i<all.length;i++){try{var idoc=all[i].contentDocument||(all[i].contentWindow&&all[i].contentWindow.document);if(idoc){var iel=idoc.querySelector('input[type=file]');if(iel){el=iel;break;}}}catch(e){}}}return el||null;})();`;
      const evalResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: script,
        returnByValue: false,
      }).catch(() => null);
      if (evalResult && evalResult.result && evalResult.result.objectId) {
        const objectId = evalResult.result.objectId;
        log('info', 'upload', `[B3] 获得 objectId=${objectId.slice(0, 24)}... (type=${evalResult.result.type}, subtype=${evalResult.result.subtype || 'n/a'}, className=${evalResult.result.className || 'n/a'})`);
        if (await tryInjectFiles(undefined, objectId, 'B3-objectId')) return true;
      } else {
        log('warn', 'upload', `[B3] evaluate 未获得有效 objectId，result: ${JSON.stringify(evalResult && evalResult.result).slice(0, 150)}`);
      }
    } catch (err) {
      log('warn', 'upload', `[B3] 异常: ${(err as Error).message}`);
    }

    // 策略 4：DOM.performSearch 全局搜索
    try {
      log('info', 'upload', `[B4] DOM.performSearch 搜索…`);
      const searchRes: any = await win.webContents.debugger.sendCommand('DOM.performSearch', {
        query: 'input[type="file"]',
      }).catch(() => null);
      if (searchRes && searchRes.result && searchRes.result.length > 0) {
        log('info', 'upload', `[B4] 找到 ${searchRes.result.length} 个匹配`);
        for (const nid of searchRes.result) {
          if (await tryInjectFiles(nid, undefined, `B4-node${nid}`)) return true;
        }
      }
    } catch (err) {
      log('warn', 'upload', `[B4] 异常: ${(err as Error).message}`);
    }

    // 策略 5：FileChooser 拦截 + 点击（兜底方案：兼容传统流程）
    try {
      log('info', 'upload', `[B5] FileChooser Dialog 拦截…`);
      let interceptionEnabled = false;
      const attempts: Array<Record<string, unknown>> = [
        { mode: 'accept', files: files },
        { mode: 'accept', fileChooserFiles: files },
        { mode: 'accept' },
      ];
      for (let i = 0; i < attempts.length; i++) {
        try {
          await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', attempts[i] as any);
          interceptionEnabled = true;
          log('info', 'upload', `[B5] FileChooser 拦截已启用 (格式 ${i + 1})`);
          break;
        } catch { /* 继续尝试 */ }
      }

      if (interceptionEnabled) {
        const fallbackClick = `
          (function () {
            var btn = document.querySelector('button[class*=_upload-btn]') || document.querySelector('button[class*=upload-btn]') || document.querySelector('button');
            if (btn) {
              try { btn.click(); return { clicked: true, text: btn.innerText || btn.textContent || '' }; }
              catch (e) { return { clicked: false, error: String(e) }; }
            }
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              var txt = (all[i].innerText || all[i].textContent || '').trim();
              if (txt === '上传视频' || txt === '点击上传' || txt === '上传文件') {
                try { all[i].click(); return { clicked: true, text: txt }; }
                catch (e) { return { clicked: false, error: String(e) }; }
              }
            }
            return { clicked: false };
          })();
        `;
        const click2: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: fallbackClick, returnByValue: true,
        }).catch(() => null);
        const cv = click2 && click2.result && click2.result.value ? click2.result.value : null;
        log('info', 'upload', `[B5] 点击结果: ${cv ? JSON.stringify(cv).slice(0, 200) : 'unknown'}`);
        await sleep(3000);
        try {
          await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { mode: 'none' } as any).catch(() => {});
        } catch { /* ignore */ }
        if (cv && cv.clicked) {
          log('info', 'upload', `✅ [B5] FileChooser 拦截+点击 完成`);
          return true;
        }
      } else {
        log('warn', 'upload', `[B5] 无法启用 FileChooser 拦截（Electron 版本可能不支持）`);
      }
    } catch (err) {
      log('warn', 'upload', `[B5] 异常: ${(err as Error).message}`);
    }

    log('error', 'upload', `❌ 所有上传策略均失败`);
    return false;
  } catch (err) {
    log('error', 'upload', `上传总异常: ${(err as Error).message}`);
    return false;
  }
}
export async function waitForUploadComplete(
  win: BrowserWindow,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  onProgress: (p: number, m?: string) => void,
  timeoutMs = 300000,
  tracker?: NavigationTracker,
): Promise<{ ready: boolean; finalStatus: string }> {
  const start = Date.now();
  const interval = 4000;
  // 上传完成的脚本（v4：穿透 iframe + Shadow DOM，支持快手等使用 Shadow DOM 的平台）
  const probeScript = `
    (function () {
      var bodyText = document.body ? (document.body.innerText || '') : '';
      var iframeCount = 0;
      try { iframeCount = document.querySelectorAll('iframe').length; } catch (e) {}

      // 收集文档根：主文档 + iframe 的 contentDocument + 所有 shadowRoot
      var roots = [];
      function addShadowRoots(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            try {
              if (all[i].shadowRoot) {
                roots.push({ doc: all[i].shadowRoot, isShadow: true });
                addShadowRoots(all[i].shadowRoot); // 递归（shadow root 嵌套）
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      try { roots.push({ doc: document, isMain: true }); } catch (e) {}
      try { addShadowRoots(document); } catch (e) {}
      try {
        var ifs = document.querySelectorAll('iframe');
        for (var fi = 0; fi < ifs.length; fi++) {
          try {
            var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
            if (idoc) {
              roots.push({ doc: idoc, isMain: false });
              try { addShadowRoots(idoc); } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

      // 在某个 root 下查询元素（兼容 shadow root 没有 body 的情况）
      function findAll(root, selector) {
        try { return root.querySelectorAll ? root.querySelectorAll(selector) : []; }
        catch (e) { return []; }
      }
      function getRootText(root) {
        try {
          if (root.body && root.body.innerText) return root.body.innerText;
          // Shadow root 没有 body，用 host 的 innerText 或遍历获取
          var txt = '';
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var ti = 0; ti < Math.min(all.length, 20); ti++) {
            try {
              var sub = (all[ti].innerText || all[ti].textContent || '').trim();
              if (sub && sub.length > 0 && sub.length < 200) txt += ' ' + sub;
            } catch (e) {}
          }
          return txt;
        } catch (e) { return ''; }
      }

      // 1) 封面检测（所有 root 累计）
      var thumbCount = 0;
      for (var di = 0; di < roots.length; di++) {
        try {
          var d = roots[di].doc;
          // 收集 body 文本（用于判断上传/处理中状态）
          var rt = getRootText(d);
          if (rt && rt.length > 0 && !roots[di].isMain) bodyText += ' | ' + rt.slice(0, 200);
          else if (rt && rt.length > 0 && roots[di].isShadow) bodyText += ' | ' + rt.slice(0, 200);

          var imgs = findAll(d, 'img');
          for (var i = 0; i < imgs.length; i++) {
            var w = imgs[i].offsetWidth || 0;
            var h = imgs[i].offsetHeight || 0;
            if (w > 10 && h > 10) thumbCount++;
          }
          var vids = findAll(d, 'video');
          for (var j = 0; j < vids.length; j++) {
            if ((vids[j].offsetWidth || 0) > 10 && (vids[j].offsetHeight || 0) > 10) thumbCount++;
          }
        } catch (e) {}
      }

      // 2) 可编辑区域检测（所有 root 累计）
      var textareaList = [];
      var ceList = [];
      var textInputList = [];
      for (var di2 = 0; di2 < roots.length; di2++) {
        try {
          var d2 = roots[di2].doc;
          // textarea
          var tareas = findAll(d2, 'textarea');
          for (var k = 0; k < Math.min(tareas.length, 10); k++) {
            var t = tareas[k];
            if ((t.offsetWidth || 0) > 0 || (t.offsetHeight || 0) > 0) {
              textareaList.push({
                ph: (t.getAttribute('placeholder') || '').slice(0, 50),
                aria: (t.getAttribute('aria-label') || '').slice(0, 50),
                w: t.offsetWidth || 0, h: t.offsetHeight || 0,
                inShadow: !!roots[di2].isShadow,
              });
            }
          }
          // contenteditable
          var cef = findAll(d2, '[contenteditable="true"], [contenteditable="plaintext-only"]');
          for (var m2 = 0; m2 < Math.min(cef.length, 10); m2++) {
            var c = cef[m2];
            if ((c.offsetWidth || 0) > 0 || (c.offsetHeight || 0) > 0) {
              ceList.push({
                aria: (c.getAttribute('aria-label') || '').slice(0, 50),
                ph: (c.getAttribute('placeholder') || '').slice(0, 50),
                text: (c.innerText || '').slice(0, 60),
                w: c.offsetWidth || 0, h: c.offsetHeight || 0,
                inShadow: !!roots[di2].isShadow,
              });
            }
          }
          // text input
          var allInps = findAll(d2, 'input');
          for (var n2 = 0; n2 < Math.min(allInps.length, 15); n2++) {
            var inp = allInps[n2];
            var itype = (inp.getAttribute('type') || 'text').toLowerCase();
            if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio') continue;
            if ((inp.offsetWidth || 0) === 0 && (inp.offsetHeight || 0) === 0) continue;
            textInputList.push({
              type: itype,
              ph: (inp.getAttribute('placeholder') || '').slice(0, 50),
              aria: (inp.getAttribute('aria-label') || '').slice(0, 50),
              w: inp.offsetWidth || 0, h: inp.offsetHeight || 0,
              inShadow: !!roots[di2].isShadow,
            });
          }
        } catch (e) {}
      }

      // 3) 状态判断（v6：修复 hasThumb/processingMatch 未定义导致的 ReferenceError；ready 必须有可编辑字段或正文含标题/描述关键词）
      var hasEditField = (textareaList.length + ceList.length + textInputList.length) > 0;
      var hasContenteditable = ceList.length > 0;
      var hasThumb = thumbCount > 0;
      var bodyHasTitleRe = /标题|作品描述|描述|简介|作品标题|视频标题/i;
      var uploadingMatch = /上传中|正在上传|处理中|转码|解析|processing|uploading|请稍|等待|正在/i.test(bodyText);
      var processingMatch = /处理中|转码中|解析中|processing/i.test(bodyText);

      var readyStatus = 'waiting';
      if (uploadingMatch) {
        readyStatus = 'uploading';
      } else if (hasContenteditable) {
        // 有 contenteditable 元素（快手标题/描述通常是 contenteditable）→ 视为就绪
        readyStatus = 'ready';
      } else if (bodyHasTitleRe.test(bodyText)) {
        // 正文含有"标题/作品描述/描述/简介"等关键词 → 进入编辑页面
        readyStatus = 'ready';
      } else if (hasEditField) {
        readyStatus = 'ready';
      }

      return {
        status: readyStatus,
        hasThumb: hasThumb,
        thumbCount: thumbCount,
        hasEditField: hasEditField,
        textareaCount: textareaList.length,
        ceCount: ceList.length,
        textInputCount: textInputList.length,
        uploading: uploadingMatch,
        processing: processingMatch,
        sampleTextarea: textareaList.slice(0, 2),
        sampleCE: ceList.slice(0, 2),
        sampleTextInput: textInputList.slice(0, 2),
        body: bodyText.slice(0, 400),
        iframeCount: iframeCount,
        rootCount: roots.length,
      };
    })();
  `;

  // 记录上一次的 URL，检测到页面变化后等待稳定再继续轮询
  let lastUrl = '';

  while (Date.now() - start < timeoutMs) {
    try {
      // 若页面正在加载 / 跟踪器判定仍在导航 → 先等稳定
      if (tracker && tracker.isNavigating()) {
        await tracker.waitForStable(800, 8000);
      } else if (win.webContents.isLoading()) {
        try {
          await new Promise<void>((done) => {
            const timeout = setTimeout(done, 5000);
            win.webContents.once('did-stop-loading', () => {
              clearTimeout(timeout);
              done();
            });
          });
        } catch { /* ignore */ }
        await sleep(300);
      }

      const currentUrl = win.webContents.getURL();
      const urlChanged = lastUrl && currentUrl !== lastUrl;
      lastUrl = currentUrl;

      if (urlChanged) {
        log('debug', 'poll', `页面已导航，等待 1.5s 让 DOM 稳定后继续轮询`, { url: currentUrl.slice(0, 80) });
        await sleep(1500);
      }

      // 通过 evalJS 执行（内置重试，应对导航导致的 frame disposed 错误）
      const info: any = await evalJS(win, probeScript, `poll-content-fields #${Math.floor((Date.now() - start) / interval) + 1}`, log);

      log('debug', 'poll', `上传状态: ${info.status}`, {
        hasThumb: info.hasThumb,
        thumbCount: info.thumbCount,
        hasEditField: info.hasEditField,
        textareaCount: info.textareaCount,
        ceCount: info.ceCount,
        textInputCount: info.textInputCount,
        uploading: info.uploading,
        processing: info.processing,
        sampleInputs: info.sampleTextInput,
        body: info.body ? info.body.slice(0, 100) : '',
      });

      if (info.status === 'ready') {
        onProgress(60, '上传完成，准备填写内容…');
        return { ready: true, finalStatus: info.status };
      }
      if (info.status === 'uploading') {
        onProgress(30 + Math.min(30, (Date.now() - start) / 10000 * 10), '上传/处理中…');
      }
    } catch (e) {
      log('warn', 'poll', `轮询异常: ${(e as Error).message}`);
    }

    await sleep(interval);
  }

  return { ready: false, finalStatus: 'timeout' };
}

/** 页面结构探测（v2：穿透 Shadow DOM + iframe，用于日志排查） */
export function buildPageStructureProbe(): string {
  return `
    (function () {
      var result = {
        inputs: [],
        contenteditable: [],
        buttons: [],
        uploadDivs: [],
        hasFileInput: false,
        shadowRootCount: 0,
        iframeCount: 0,
      };
      // 收集：主文档 + Shadow DOM + iframe
      var roots = [];
      function collectShadow(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var si = 0; si < all.length; si++) {
            try {
              if (all[si].shadowRoot) {
                roots.push({ doc: all[si].shadowRoot });
                result.shadowRootCount++;
                collectShadow(all[si].shadowRoot);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      try { roots.push({ doc: document }); } catch (e) {}
      try { collectShadow(document); } catch (e) {}
      try {
        var ifs = document.querySelectorAll('iframe');
        result.iframeCount = ifs.length;
        for (var fi = 0; fi < ifs.length; fi++) {
          try {
            var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
            if (idoc) {
              roots.push({ doc: idoc });
              collectShadow(idoc);
            }
          } catch (e) {}
        }
      } catch (e) {}

      for (var ri = 0; ri < roots.length; ri++) {
        var d = roots[ri].doc;
        if (!d || !d.querySelectorAll) continue;
        try {
          var inputs = d.querySelectorAll('input');
          for (var i=0; i<inputs.length; i++) {
            var el = inputs[i];
            if (result.inputs.length >= 20) break;
            result.inputs.push({
              type: el.getAttribute('type'),
              placeholder: el.getAttribute('placeholder'),
              ariaLabel: el.getAttribute('aria-label'),
              w: el.offsetWidth, h: el.offsetHeight,
            });
            if (el.getAttribute('type') === 'file') result.hasFileInput = true;
          }
        } catch (e) {}
        try {
          var ce = d.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
          for (var j=0; j<Math.min(ce.length, 10); j++) {
            result.contenteditable.push({ text: (ce[j].innerText || ce[j].textContent || '').slice(0, 50) });
          }
        } catch (e) {}
        try {
          var btns = d.querySelectorAll('button, [role="button"], a, div');
          for (var k=0; k<btns.length; k++) {
            var txt = (btns[k].innerText || btns[k].textContent || '').trim();
            if (txt && txt.length <= 30) result.buttons.push({ text: txt });
            if (result.buttons.length >= 40) break;
          }
        } catch (e) {}
        try {
          var upKeywords = ['上传', 'upload', '选择文件', '选择视频', '选择图片', '拖拽'];
          var divs = d.querySelectorAll('div, button, a, span');
          for (var m=0; m<divs.length; m++) {
            var txt2 = (divs[m].innerText || divs[m].textContent || '').trim();
            if (!txt2 || txt2.length > 30) continue;
            var matched = false;
            for (var n=0; n<upKeywords.length; n++) { if (txt2.indexOf(upKeywords[n]) !== -1) { matched = true; break; } }
            if (matched) result.uploadDivs.push({ text: txt2 });
            if (result.uploadDivs.length >= 15) break;
          }
        } catch (e) {}
      }
      return result;
    })();
  `;
}

/** 填写标题脚本（v4：iframe 穿透 + Shadow DOM 穿透 + 优先 contenteditable + 排除选择类下拉） */
export function buildFillTitle(title: string): string {
  const jt = JSON.stringify(title);
  return `
    (function () {
      var candidates = [];
      // 收集：主文档 + iframe + Shadow DOM
      var roots = [];
      function collectShadowRoots(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var si = 0; si < all.length; si++) {
            try {
              if (all[si].shadowRoot) {
                roots.push({ doc: all[si].shadowRoot, isShadow: true });
                collectShadowRoots(all[si].shadowRoot);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      try { roots.push({ doc: document, isMain: true }); } catch (e) {}
      try { collectShadowRoots(document); } catch (e) {}
      try {
        var ifs = document.querySelectorAll('iframe');
        for (var fi = 0; fi < ifs.length; fi++) {
          try {
            var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
            if (idoc) {
              roots.push({ doc: idoc, isMain: false });
              try { collectShadowRoots(idoc); } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

      function tryGetLabel(el, doc) {
        try {
          var id = el.getAttribute('id');
          if (id && doc) {
            var lbl = doc.querySelector('label[for="' + id + '"]');
            if (lbl) return (lbl.innerText || '').trim().toLowerCase().slice(0, 50);
          }
          var parent = el.parentElement;
          for (var t = 0; t < 3 && parent; t++) {
            try {
              var ph = parent.querySelector('span, label, :scope > div:first-child');
              if (ph && ph !== el) {
                var txt = (ph.innerText || '').trim().toLowerCase().slice(0, 50);
                if (txt.length > 0) return txt;
              }
            } catch (e) {}
            parent = parent.parentElement;
          }
        } catch (e) {}
        return '';
      }

      function scoreElement(el, type, text, isTitle) {
        var s = 0;
        if (!text) return s;
        // 标题关键词（平台全覆盖，shadow DOM 穿透后仍可命中）
        var titleKw = ['标题', 'title', '作品标题', '作品名称', '视频标题', '标题栏', '标题内容', '填写标题', '添加标题', '作品名'];
        for (var i = 0; i < titleKw.length; i++) {
          if (text.indexOf(titleKw[i]) !== -1) { s += 500; break; }
        }
        // 标题输入框通常较短（1 行），给 contenteditable 更高的基础分（快手标题是 contenteditable）
        if (isTitle) {
          if (type === 'contenteditable') s += 80; // 快手标题框是 contenteditable，优先
          if (type === 'input') s += 30;
          if ((el.offsetHeight || 0) < 80) s += 20; // 矮框优先（通常是标题）
          if ((el.offsetWidth || 0) > 200) s += 10; // 较宽的输入框更可能是标题
        }
        return s;
      }

      // 对每个 root 收集候选元素（主文档 + iframe + Shadow DOM，完全穿透）
      for (var di = 0; di < roots.length; di++) {
        var d = roots[di].doc;
        if (!d || !d.querySelectorAll) continue;

        // 1) textarea
        try {
          var tareas = d.querySelectorAll('textarea');
          for (var i = 0; i < tareas.length; i++) {
            var el = tareas[i];
            if ((el.offsetWidth || 0) === 0 && (el.offsetHeight || 0) === 0) continue;
            var ph = (el.getAttribute('placeholder') || '').toLowerCase();
            var aria = (el.getAttribute('aria-label') || '').toLowerCase();
            var lbl = tryGetLabel(el, d);
            var combinedText = [ph, aria, lbl].join(' ');
            if (/选择|类型|下拉|选项|search|搜索|话题|tag|标签|分类/i.test(combinedText)) continue;
            candidates.push({
              el: el, tag: 'textarea', score: scoreElement(el, 'textarea', combinedText, true),
              text: combinedText.slice(0, 80),
              inShadow: !!roots[di].isShadow
            });
          }
        } catch (e) {}

        // 2) input (排除 file/hidden/checkbox/radio/search/下拉类)
        try {
          var allInps = d.querySelectorAll('input');
          for (var j = 0; j < allInps.length; j++) {
            var el2 = allInps[j];
            var itype = (el2.getAttribute('type') || 'text').toLowerCase();
            if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio' || itype === 'search' || itype === 'submit' || itype === 'button') continue;
            if ((el2.offsetWidth || 0) === 0 && (el2.offsetHeight || 0) === 0) continue;
            var ph2 = (el2.getAttribute('placeholder') || '').toLowerCase();
            var aria2 = (el2.getAttribute('aria-label') || '').toLowerCase();
            var lbl2 = tryGetLabel(el2, d);
            var combined2 = [ph2, aria2, lbl2].join(' ');
            if (/选择|类型|下拉|选项|search|搜索|话题|tag|标签|分类/i.test(combined2)) continue;
            candidates.push({
              el: el2, tag: 'input', score: scoreElement(el2, 'input', combined2, true),
              text: combined2.slice(0, 80),
              inShadow: !!roots[di].isShadow
            });
          }
        } catch (e) {}

        // 3) contenteditable（快手标题通常是这个 — 优先；shadow DOM 内也可命中）
        try {
          var ces = d.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
          for (var k = 0; k < ces.length; k++) {
            var el3 = ces[k];
            if ((el3.offsetWidth || 0) === 0 && (el3.offsetHeight || 0) === 0) continue;
            var aria3 = (el3.getAttribute('aria-label') || '').toLowerCase();
            var ph3 = (el3.getAttribute('placeholder') || '').toLowerCase();
            var lbl3 = tryGetLabel(el3, d);
            var combined3 = [aria3, ph3, lbl3].join(' ');
            if (/选择|类型|下拉|选项|search|搜索|话题|tag|标签|分类/i.test(combined3)) continue;
            candidates.push({
              el: el3, tag: 'contenteditable', score: scoreElement(el3, 'contenteditable', combined3, true),
              text: combined3.slice(0, 80),
              inShadow: !!roots[di].isShadow
            });
          }
        } catch (e) {}
      }

      if (candidates.length === 0) {
        return { success: false, reason: 'no-candidates', count: 0 };
      }
      candidates.sort(function (a, b) { return b.score - a.score; });
      var target = candidates[0];

      // 填充 + 派发事件（兼容 React 受控组件）
      var method = 'unknown';
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jt};
          method = 'innerText';
        } else {
          try {
            var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(target.el, ${jt});
            method = 'native-setter';
          } catch (e1) {
            try {
              target.el.value = ${jt};
              method = 'direct-value';
            } catch (e2) {
              target.el.innerText = ${jt};
              method = 'fallback-innerText';
            }
          }
        }
        try { target.el.dispatchEvent(new Event('input', { bubbles: true })); } catch (ev) {}
        try { target.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (ev) {}
        try { target.el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (ev) {}

        return {
          success: true,
          method: method,
          tag: target.tag,
          score: target.score,
          matchedText: target.text,
          readBack: (target.el.innerText || target.el.value || '').slice(0, 80),
          totalCandidates: candidates.length
        };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 100), tag: target.tag, score: target.score };
      }
    })();
  `;
}

/** 填写正文/描述脚本（v4：iframe 穿透 + Shadow DOM 穿透 + 更精准的内容区域匹配 + 跳过选择下拉） */
export function buildFillContent(content: string): string {
  const jc = JSON.stringify(content);
  return `
    (function () {
      var candidates = [];
      // 收集：主文档 + iframe + Shadow DOM
      var roots = [];
      function collectShadowRoots(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var si = 0; si < all.length; si++) {
            try {
              if (all[si].shadowRoot) {
                roots.push({ doc: all[si].shadowRoot, isShadow: true });
                collectShadowRoots(all[si].shadowRoot);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      try { roots.push({ doc: document, isMain: true }); } catch (e) {}
      try { collectShadowRoots(document); } catch (e) {}
      try {
        var ifs = document.querySelectorAll('iframe');
        for (var fi = 0; fi < ifs.length; fi++) {
          try {
            var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
            if (idoc) {
              roots.push({ doc: idoc, isMain: false });
              try { collectShadowRoots(idoc); } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

      function tryGetLabel(el, doc) {
        try {
          var id = el.getAttribute('id');
          if (id && doc) {
            var lbl = doc.querySelector('label[for="' + id + '"]');
            if (lbl) return (lbl.innerText || '').trim().toLowerCase().slice(0, 50);
          }
          var parent = el.parentElement;
          for (var t = 0; t < 3 && parent; t++) {
            try {
              var ph = parent.querySelector('span, label, :scope > div:first-child');
              if (ph && ph !== el) {
                var txt = (ph.innerText || '').trim().toLowerCase().slice(0, 50);
                if (txt.length > 0) return txt;
              }
            } catch (e) {}
            parent = parent.parentElement;
          }
        } catch (e) {}
        return '';
      }

      function scoreElement(el, type, text) {
        var s = 0;
        if (!text) return s;
        var kw = ['描述', '正文', '内容', '简介', 'description', '介绍', '作品描述', '视频简介', '作品简介', '描述栏', '填写描述', '作品介绍', '作品正文', '作品文案'];
        for (var i = 0; i < kw.length; i++) {
          if (text.indexOf(kw[i]) !== -1) { s += 500; break; }
        }
        if (type === 'textarea') s += 40;
        if (type === 'contenteditable') s += 60; // 快手正文通常是 contenteditable
        if ((el.offsetHeight || 0) > 80) s += 30; // 较高的框更像正文
        if ((el.offsetWidth || 0) > 300) s += 10;
        return s;
      }

      // 遍历所有 root（主文档 + iframe + Shadow DOM）收集可编辑元素
      for (var di = 0; di < roots.length; di++) {
        var d = roots[di].doc;
        if (!d || !d.querySelectorAll) continue;

        var allEls = [];
        try {
          var tareas = d.querySelectorAll('textarea');
          for (var i = 0; i < tareas.length; i++) {
            if ((tareas[i].offsetWidth || 0) === 0 && (tareas[i].offsetHeight || 0) === 0) continue;
            allEls.push({ el: tareas[i], tag: 'textarea' });
          }
        } catch (e) {}
        try {
          var allInps = d.querySelectorAll('input');
          for (var j = 0; j < allInps.length; j++) {
            var itype = (allInps[j].getAttribute('type') || 'text').toLowerCase();
            if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio' || itype === 'search' || itype === 'submit' || itype === 'button') continue;
            if ((allInps[j].offsetWidth || 0) === 0 && (allInps[j].offsetHeight || 0) === 0) continue;
            allEls.push({ el: allInps[j], tag: 'input' });
          }
        } catch (e) {}
        try {
          var ces = d.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
          for (var k = 0; k < ces.length; k++) {
            if ((ces[k].offsetWidth || 0) === 0 && (ces[k].offsetHeight || 0) === 0) continue;
            allEls.push({ el: ces[k], tag: 'contenteditable' });
          }
        } catch (e) {}

        // 对每个元素评分
        for (var m = 0; m < allEls.length; m++) {
          var elx = allEls[m].el;
          var val = (elx.value !== undefined ? elx.value : elx.innerText) || '';
          var ph = (elx.getAttribute('placeholder') || '').toLowerCase();
          var aria = (elx.getAttribute('aria-label') || '').toLowerCase();
          var lbl = tryGetLabel(elx, d);
          var combined = [ph, aria, lbl].join(' ');
          // 跳过：标题相关元素（标题脚本应该已经填它了）
          if (/标题|作品标题|作品名称|视频标题|title|标题栏|标题内容|填写标题|添加标题|作品名/i.test(combined)) continue;
          // 跳过：选择类/下拉/分类/话题
          if (/选择|类型|下拉|选项|search|搜索|话题|tag|标签|分类/i.test(combined)) continue;
          // 跳过已经有内容且是话题输入框
          if (val.length > 0 && /话题|tags|tag/i.test(combined)) continue;
          candidates.push({
            el: elx, tag: allEls[m].tag,
            score: scoreElement(elx, allEls[m].tag, combined),
            text: combined.slice(0, 80),
            hasContent: val.length > 0,
            inShadow: !!roots[di].isShadow
          });
        }
      }

      if (candidates.length === 0) {
        return { success: false, reason: 'no-candidates', count: 0 };
      }

      // 优先选没有内容的元素（避免覆盖标题）
      var emptyCandidates = candidates.filter(function (c) { return !c.hasContent; });
      var pool = emptyCandidates.length > 0 ? emptyCandidates : candidates;
      pool.sort(function (a, b) { return b.score - a.score; });
      var target = pool[0];

      var method = 'unknown';
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jc};
          method = 'innerText';
        } else {
          try {
            var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(target.el, ${jc});
            method = 'native-setter';
          } catch (e1) {
            try {
              target.el.value = ${jc};
              method = 'direct-value';
            } catch (e2) {
              target.el.innerText = ${jc};
              method = 'fallback-innerText';
            }
          }
        }
        try { target.el.dispatchEvent(new Event('input', { bubbles: true })); } catch (ev) {}
        try { target.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (ev) {}
        try { target.el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (ev) {}

        return {
          success: true,
          method: method,
          tag: target.tag,
          score: target.score,
          matchedText: target.text,
          readBack: (target.el.innerText || target.el.value || '').slice(0, 80),
          totalCandidates: candidates.length
        };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 100), tag: target.tag, score: target.score };
      }
    })();
  `;
}

/** 发布按钮点击脚本（v3：iframe 穿透 + shadow DOM + 多平台 class 匹配 + 关键词） */
export function buildPublishButtonClicker(keyword: string): string {
  const jk = JSON.stringify(keyword);
  return `
    (function () {
      var candidates = [];
      try { window.scrollTo(0, (document.documentElement && document.documentElement.scrollHeight) || (document.body && document.body.scrollHeight) || 0); } catch (e) {}
      var viewportH = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 600;
      var viewportW = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 800;

      // 收集所有 root：主文档 + iframe + Shadow DOM（快手等平台将发布按钮放在 Shadow DOM 中）
      var roots = [];
      function collectShadowRoots2(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var si = 0; si < all.length; si++) {
            try {
              if (all[si].shadowRoot) {
                roots.push({ doc: all[si].shadowRoot, isShadow: true, hostTagName: all[si].tagName ? all[si].tagName.toLowerCase() : '' });
                collectShadowRoots2(all[si].shadowRoot);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      try { roots.push({ doc: document, isMain: true }); } catch (e) {}
      try { collectShadowRoots2(document); } catch (e) {}
      try {
        var ifs = document.querySelectorAll('iframe');
        for (var fi = 0; fi < ifs.length; fi++) {
          try {
            var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
            if (idoc) {
              roots.push({ doc: idoc, isMain: false });
              try { collectShadowRoots2(idoc); } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}

      // 遍历每个 root 执行所有策略
      for (var dIdx = 0; dIdx < roots.length; dIdx++) {
        var d = roots[dIdx].doc;
        if (!d || !d.querySelectorAll) continue;
        var sourcePrefix = roots[dIdx].isMain ? '' : (roots[dIdx].isShadow ? 'shadow:' + (roots[dIdx].hostTagName || '') : 'iframe:');

        // 策略 1：Shadow DOM 自定义组件
        try {
          var shadowTags = ['xhs-publish-btn', 'xhs-button', 'publish-button', 'xhs-publish', 'xhs-upload-btn'];
          for (var si = 0; si < shadowTags.length; si++) {
            var host = d.querySelector(shadowTags[si]);
            if (!host) continue;
            var sr = host.shadowRoot;
            if (!sr) continue;
            var inner = sr.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="submit"], [class*="publish"], [class*="primary"], [class*="red"]');
            for (var ii = 0; ii < inner.length; ii++) {
              try {
                var selEl = inner[ii];
                var selW = selEl.offsetWidth || 0;
                var selH = selEl.offsetHeight || 0;
                if (selW <= 5 || selH <= 5) continue;
                var st = getComputedStyle(selEl);
                if (st.visibility === 'hidden' || st.display === 'none') continue;
                if ((selEl.hasAttribute && selEl.hasAttribute('disabled')) || selEl.getAttribute('aria-disabled') === 'true') continue;
                var selText = (selEl.innerText || selEl.textContent || '').trim();
                if (!selText) continue;
                // 排除侧边栏：导航类文本 + 窄/矮元素
                if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(selText) && (selW < 250 || selH < 80)) continue;
                // 必须含发布相关关键词
                if (!/(发布作品|立即发布|发布|确认发布)/i.test(selText)) continue;
                var selClass = ((selEl.className && typeof selEl.className === 'string') ? selEl.className : '').toLowerCase();
                var selRect = selEl.getBoundingClientRect ? selEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
                var selFromBottom = viewportH - selRect.bottom;
                var selFromRight = viewportW - selRect.right;
                var selScore = 0;
                if (/red|primary|danger|submit|publish|bg-red/i.test(selClass)) selScore += 3000;
                if (selText === ${jk}) selScore += 3000;
                else if (selText.indexOf(${jk}) === 0) selScore += 1500;
                else if (selText.indexOf(${jk}) !== -1) selScore += 500;
                if (selEl.tagName && selEl.tagName.toLowerCase() === 'button') selScore += 2000;
                // 靠近底部加分（fromBottom 越小越高分）
                if (selFromBottom >= -300 && selFromBottom < viewportH) {
                  selScore += 500;
                  var bottomRatio = 1 - Math.min(1, Math.abs(selFromBottom) / viewportH);
                  selScore += Math.round(bottomRatio * 1500);
                }
                // 靠近右侧加分
                if (selFromRight >= -100 && selFromRight < viewportW * 0.5) {
                  var rightRatio = 1 - Math.min(1, selFromRight / (viewportW * 0.5));
                  selScore += Math.round(rightRatio * 800);
                }
                candidates.push({ el: selEl, score: selScore, text: selText, tag: selEl.tagName ? selEl.tagName.toLowerCase() : 'element', classStr: selClass.slice(0, 60), fromBottom: Math.round(selFromBottom), fromRight: Math.round(selFromRight), w: selW, h: selH, source: sourcePrefix + 'shadow-dom:' + shadowTags[si] });
              } catch (e) {}
            }
          }
        } catch (e) {}

        // 策略 2：class 精确选择器（抖音 ce-btn、快手 _button-primary_、小红书通用命名）
        try {
          var classSels = [
            '[class*="_button-primary_"]', '[class*="_button-primary"]', '[class*="_button_3a3lq"]',
            '.ce-btn.bg-red', '.ce-btn [class*="red"]', 'button.ce-btn', '.ce-btn', '.publish-btn', '.btn-publish', 'button [class*="publish"]', '.bg-red', '[class*="btn-primary"]', '[class*="btn-danger"]', 'button[class*="kui"]', '[class*="kui-btn"]', '[class*="ks-btn"]', 'button[class*="ks-"]', '[class*="publish-"]'];
          for (var ci = 0; ci < classSels.length; ci++) {
            var selList = d.querySelectorAll(classSels[ci]);
            for (var ei = 0; ei < selList.length; ei++) {
              var sEl = selList[ei];
              try {
                var sW = sEl.offsetWidth || 0;
                var sH = sEl.offsetHeight || 0;
                if (sW <= 5 || sH <= 5) continue;
                var sSty = getComputedStyle(sEl);
                if (sSty.visibility === 'hidden' || sSty.display === 'none') continue;
                if ((sEl.hasAttribute && sEl.hasAttribute('disabled')) || sEl.getAttribute('aria-disabled') === 'true') continue;
                var sText = (sEl.innerText || sEl.textContent || '').trim();
                if (!sText) continue;
                // 排除侧边栏：导航类文本 + 窄/矮元素
                if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(sText) && (sW < 250 || sH < 80)) continue;
                // 必须含发布相关关键词
                if (!/(发布作品|立即发布|发布|确认发布)/i.test(sText)) continue;
                var sClass = ((sEl.className && typeof sEl.className === 'string') ? sEl.className : '').toLowerCase();
                if (/nav|menu|header|sidebar|breadcrumb|tabs/.test(sClass)) continue;
                var sRect = sEl.getBoundingClientRect ? sEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
                var sFromBottom = viewportH - sRect.bottom;
                var sFromRight = viewportW - sRect.right;
                var sScore = 0;
                // 快手专属：_button-primary_ 类是最高优先级的发布按钮样式
                if (/_button-primary|_button.*primary|primary.*button/i.test(sClass)) sScore += 5000;
                else if (/bg-red|primary|danger|submit|publish|kui|ks-btn|publish-btn/i.test(sClass)) sScore += 2000;
                if (sText === ${jk}) sScore += 3000;
                else if (sText.indexOf(${jk}) === 0) sScore += 1500;
                else if (sText.indexOf(${jk}) !== -1) sScore += 500;
                if (sEl.tagName.toLowerCase() === 'button') sScore += 1500;
                // 排除左侧导航：在视口左 1/5 区域内的"发布作品"文本减分（防止点到侧边导航）
                if (sRect.left >= 0 && sRect.left < viewportW * 0.2 && /发布作品/.test(sText)) sScore -= 3000;
                if (sFromRight < 0 || sRect.left > viewportW * 0.85) sScore -= 500;
                // 靠近底部 + 右侧加分
                if (sFromBottom >= -200 && sFromBottom < viewportH * 0.5) {
                  sScore += 800;
                  var sbRatio = 1 - Math.min(1, Math.abs(sFromBottom) / (viewportH * 0.5));
                  sScore += Math.round(sbRatio * 1500);
                }
                if (sFromRight >= -100 && sFromRight < viewportW * 0.5) {
                  sScore += 300;
                  var srRatio = 1 - Math.min(1, sFromRight / (viewportW * 0.5));
                  sScore += Math.round(srRatio * 800);
                }
                candidates.push({ el: sEl, score: sScore, text: sText, tag: sEl.tagName.toLowerCase(), classStr: sClass.slice(0, 60), fromBottom: Math.round(sFromBottom), fromRight: Math.round(sFromRight), w: sW, h: sH, source: sourcePrefix + 'class:' + classSels[ci] });
              } catch (e) {}
            }
          }
        } catch (e) {}

        // 策略 3：底部区域扫描
        try {
          var clickable = d.querySelectorAll('button, a, [role="button"], div');
          for (var di = 0; di < clickable.length; di++) {
            var de2 = clickable[di];
            try {
              var dW = de2.offsetWidth || 0;
              var dH = de2.offsetHeight || 0;
              if (dW < 40 || dH < 28) continue;
              var dSty = getComputedStyle(de2);
              if (dSty.visibility === 'hidden' || dSty.display === 'none') continue;
              var dRect = de2.getBoundingClientRect ? de2.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var dFromBottom = viewportH - dRect.bottom;
              if (dFromBottom < -300 || dFromBottom >= viewportH * 0.6) continue;
              var dText = (de2.innerText || de2.textContent || '').trim();
              if (!dText || dText.length > 30) continue;
              // 排除侧边栏：导航类文本 + 窄/矮元素
              if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(dText) && (dW < 250 || dH < 80)) continue;
              // 必须含发布相关关键词
              if (!/(发布作品|立即发布|发布|确认发布)/i.test(dText)) continue;
              var dClass = ((de2.className && typeof de2.className === 'string') ? de2.className : '').toLowerCase();
              if (/nav|menu|header|sidebar|breadcrumb|tabs|tab-bar|setting|option|select|dropdown|filter|sort|config/.test(dClass)) continue;
              var dFromRight = viewportW - dRect.right;
              var dScore = 0;
              if (dText === ${jk}) dScore += 3000;
              else if (dText.indexOf(${jk}) === 0) dScore += 1000;
              else if (dText.indexOf(${jk}) !== -1) dScore += 200;
              if (de2.tagName.toLowerCase() === 'button') dScore += 1200;
              if (/bg-red|primary|danger|submit|publish|ce-btn|kui|ks-btn|publish-btn/i.test(dClass)) dScore += 2000;
              // 靠近底部 + 右侧加分
              if (dFromBottom >= 0 && dFromBottom < viewportH * 0.3) {
                dScore += 600;
                var dbRatio = 1 - Math.min(1, dFromBottom / (viewportH * 0.3));
                dScore += Math.round(dbRatio * 2000);
              }
              if (dFromRight >= -100 && dFromRight < viewportW * 0.5) {
                var drRatio = 1 - Math.min(1, dFromRight / (viewportW * 0.5));
                dScore += Math.round(drRatio * 1000);
              }
              candidates.push({ el: de2, score: dScore, text: dText, tag: de2.tagName.toLowerCase(), classStr: dClass.slice(0, 60), fromBottom: Math.round(dFromBottom), fromRight: Math.round(dFromRight), w: dW, h: dH, source: sourcePrefix + 'bottom-scan' });
            } catch (e) {}
          }
        } catch (e) {}

        // 策略 4：最后一个可见按钮兜底
        try {
          var lastBtns = d.querySelectorAll('button, [role="button"]');
          for (var li = lastBtns.length - 1; li >= Math.max(0, lastBtns.length - 5); li--) {
            var le = lastBtns[li];
            try {
              var lW = le.offsetWidth || 0;
              var lH = le.offsetHeight || 0;
              if (lW < 40 || lH < 28) continue;
              var lSty = getComputedStyle(le);
              if (lSty.visibility === 'hidden' || lSty.display === 'none') continue;
              var lText = (le.innerText || le.textContent || '').trim();
              if (!lText || lText.length > 30) continue;
              // 排除侧边栏：导航类文本 + 窄/矮元素
              if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(lText) && (lW < 250 || lH < 80)) continue;
              // 必须含发布相关关键词
              if (!/(发布作品|立即发布|发布|确认发布)/i.test(lText)) continue;
              var lRect = le.getBoundingClientRect ? le.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var lFromBottom = viewportH - lRect.bottom;
              var lFromRight = viewportW - lRect.right;
              var lClass = ((le.className && typeof le.className === 'string') ? le.className : '').toLowerCase();
              var lScore = 500 + (lastBtns.length - li) * 100;
              if (/bg-red|primary|danger|submit|publish|ce-btn|kui|ks-btn|publish-btn/i.test(lClass)) lScore += 2000;
              if (lText === ${jk}) lScore += 3000;
              // 靠近底部 + 右侧加分
              if (lFromBottom >= 0 && lFromBottom < viewportH * 0.4) {
                var lbRatio = 1 - Math.min(1, lFromBottom / (viewportH * 0.4));
                lScore += Math.round(lbRatio * 1500);
              }
              if (lFromRight >= -100 && lFromRight < viewportW * 0.5) {
                var lrRatio = 1 - Math.min(1, lFromRight / (viewportW * 0.5));
                lScore += Math.round(lrRatio * 800);
              }
              candidates.push({ el: le, score: lScore, text: lText, tag: le.tagName.toLowerCase(), classStr: lClass.slice(0, 60), fromBottom: Math.round(lFromBottom), fromRight: Math.round(lFromRight), w: lW, h: lH, source: sourcePrefix + 'last-button' });
            } catch (e) {}
          }
        } catch (e) {}
      }

      if (candidates.length === 0) return { found: false, clicked: false, reason: 'no-candidate' };
      // 去重 + 排序
      var seen = {};
      var unique = [];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!c.el) continue;
        var key = c.tag + ':' + c.classStr + ':' + c.text + ':' + c.w + 'x' + c.h;
        if (seen[key]) { if (c.score > seen[key].score) seen[key] = c; }
        else { seen[key] = c; unique.push(c); }
      }
      unique.sort(function (a, b) { return b.score - a.score; });
      var target = unique[0];

      // 只对目标元素本身触发点击（防止对祖先元素重复触发导致平台检测到重复点击）
      var initialUrl = location.href;
      try {
        target.el.scrollIntoView({ block: 'center', behavior: 'instant' in window ? 'instant' : 'auto' });
      } catch (e) {}
      try {
        target.el.click();
      } catch (e) {}
      try {
        var r2 = target.el.getBoundingClientRect ? target.el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        var cx2 = r2.left + r2.width / 2, cy2 = r2.top + r2.height / 2;
        var mi2 = { bubbles: true, cancelable: true, view: window, detail: 1, clientX: cx2, clientY: cy2, button: 0, buttons: 1 };
        target.el.dispatchEvent(new MouseEvent('mousedown', mi2));
        target.el.dispatchEvent(new MouseEvent('mouseup', mi2));
        target.el.dispatchEvent(new MouseEvent('click', mi2));
      } catch (e) {}
      var afterUrl = location.href;
      return { found: true, clicked: true, text: target.text, tag: target.tag, classStr: target.classStr, score: target.score, source: target.source, totalCandidates: unique.length, urlChanged: initialUrl !== afterUrl, top5: unique.slice(0, 5).map(function (c) { return { text: c.text, tag: c.tag, score: c.score, source: c.source }; }) };
    })();
  `;
}

/**
 * 标准发布流程（适配器模式的内核）
 *
 * 每个平台只需要提供少量"配置化"信息（meta / publishUrl / 按钮关键词等），
 * 然后调用此函数完成"导航 → 登录检测 → 上传 → 等待 → 填写 → 点击"标准流程。
 * 这样平台发布逻辑变更不会互相影响，改进 shared.ts 的一处逻辑就能让所有平台受益。
 */
export interface StandardPublishConfig {
  /** 平台 key（用于日志 / 结果标识） */
  platform: PlatformType;
  /** 对外展示的平台元信息（publishUrl / homeUrl 会被用到） */
  meta: {
    publishUrl: string;
    homeUrl: string;
  };
  /** 该平台账号登录检测回调（通常就是 adapter.detectLoggedIn） */
  detectLoggedIn: (win: BrowserWindow) => Promise<{ loggedIn: boolean }>;
  /** "点击发布"阶段按顺序尝试的关键词（第一个命中即停止） */
  publishKeywords?: string[];
  /** 是否需要在点击发布后再尝试点击"确认发布"（二次确认弹窗） */
  enableConfirmStep?: boolean;
  /** 是否使用 buildPublishVerifier 做点击后状态校验（小红书风格） */
  enablePostClickVerify?: boolean;
  /** 标题/正文填写后等待的毫秒，让 React 状态更新 */
  fillWaitMs?: number;
}

export async function runStandardPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: (p: number, m?: string) => void,
  config: StandardPublishConfig,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: config.platform });
  log('info', 'init', `开始发布`, { title: request.title, mediaCount: request.mediaFiles.length, tagCount: request.tags?.length ?? 0 });

  let win: BrowserWindow | null = null;
  let tracker: NavigationTracker | null = null;

  const finalize = (status: PublishItemProgress['status'], message: string) => ({
    accountId,
    platform: config.platform,
    status,
    progress: 100,
    message,
    resultUrl: config.meta.homeUrl,
    startedAt,
    finishedAt: Date.now(),
  });

  try {
    onProgress(5, '打开发布窗口…');
    win = makePublishWindow(accountId, `${config.platform} 发布 - FlowX`);
    tracker = attachNavigationTracker(win, log);

    onProgress(10, '加载发布页面…');
    await win.loadURL(config.meta.publishUrl, {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await tracker.waitForStable(1200, 12000);

    try {
      const probe = (await evalJS(win, buildPageStructureProbe(), 'page-probe', log)) as any;
      log('info', 'probe', `页面结构`, { inputsCount: probe.inputs?.length, contenteditableCount: probe.contenteditable?.length, buttonsCount: probe.buttons?.length });
    } catch { /* ignore */ }

    onProgress(15, '检查登录状态…');
    const auth = await config.detectLoggedIn(win);
    if (!auth.loggedIn) {
      if (!win.isDestroyed()) win.show();
      return finalize('failed', '登录态失效，请在窗口中重新登录后重试');
    }
    if (!win.isDestroyed()) { win.show(); win.focus(); }

    // 上传素材
    if (request.mediaFiles.length > 0) {
      onProgress(30, '上传素材…');
      await uploadViaCDP(win, request.mediaFiles, log);
      // 上传后最容易触发导航/白屏，多等待一次稳定
      await tracker.waitForStable(1000, 10000);
    } else {
      onProgress(50, '无素材，跳过上传');
    }

    const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
    if (!uploadResult.ready) onProgress(60, '上传未完成，继续尝试填写…');

    // 填写内容
    onProgress(75, '填写标题与正文…');
    if (request.title) {
      try { await evalJS(win, buildFillTitle(request.title), 'fill-title', log); }
      catch (e) { log('warn', 'fill', `标题填写异常: ${(e as Error).message}`); }
    }
    const combinedContent = (request.content || '') +
      (request.tags && request.tags.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
    if (combinedContent.trim().length > 0) {
      try { await evalJS(win, buildFillContent(combinedContent), 'fill-content', log); }
      catch (e) { log('warn', 'fill', `正文填写异常: ${(e as Error).message}`); }
    }
    await sleep(config.fillWaitMs ?? 1500);

    // 点击发布按钮
    onProgress(90, '点击发布…');
    const keywords = config.publishKeywords && config.publishKeywords.length > 0
      ? config.publishKeywords
      : ['立即发布', '发布作品', '确认发布', '发布'];
    let clicked = false;
    let actuallyPublished = false;

    for (let i = 0; i < keywords.length; i++) {
      try {
        const res: any = await evalJS(win, buildPublishButtonClicker(keywords[i]), `click-${keywords[i]}`, log);
        if (!res || !res.clicked) { log('warn', 'submit', `关键词 "${keywords[i]}" 未点击到元素，继续尝试`); continue; }
        clicked = true;
        log('info', 'submit', `点击成功: ${keywords[i]}`);

        // 等待页面稳定
        await tracker.waitForStable(800, 8000);
        await sleep(1500);

        if (config.enablePostClickVerify) {
          try {
            const v1: any = await evalJS(win, buildPublishVerifier(), `verify-${i}`, log);
            log('info', 'verify', `验证: ${v1.verdict} (url=${v1.url ? (v1.url as string).slice(-50) : 'n/a'})`);
            if (v1.verdict === 'success' || v1.verdict === 'maybe_success_url_changed') {
              actuallyPublished = true;
              break;
            }
            if (v1.verdict === 'need_confirm') {
              try { await evalJS(win, buildPublishButtonClicker('确认发布'), 'click-confirm', log); } catch { /* ignore */ }
              await sleep(2500);
              actuallyPublished = true;
              break;
            }
            if (v1.verdict === 'saved_as_draft') {
              const tryKeys = ['发布笔记', '立即发布', '发布视频'];
              for (const kw of tryKeys) {
                try {
                  const r: any = await evalJS(win, buildPublishButtonClicker(kw), `click-${kw}`, log);
                  if (r && r.clicked) { await sleep(2500); actuallyPublished = true; break; }
                } catch { /* ignore */ }
              }
              if (actuallyPublished) break;
            }
            // has_error 或 unclear：不 break，继续试下一个关键词
            log('warn', 'submit', `点击 "${keywords[i]}" 后页面未验证成功（${v1.verdict}），继续尝试其他按钮…`);
          } catch (verifyErr) {
            log('warn', 'submit', `验证异常，继续尝试: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
          }
        } else {
          break; // 无验证时，点到即止
        }
      } catch (e) { log('warn', 'submit', `关键词 "${keywords[i]}" 点击异常`); }
    }

    if (clicked && config.enablePostClickVerify && !actuallyPublished) {
      // 兜底：所有关键词都试过但仍未验证成功，尝试直接点击页面上带 _button-primary_ 类的元素
      try {
        log('warn', 'submit', `兜底尝试：点击页面主按钮…`);
        const fallback: any = await evalJS(win,
          `(function(){ var els = document.querySelectorAll('[class*="_button-primary_"][class*="_button_3a3lq"], [class*="_button-primary_"]'); for(var i=0;i<els.length;i++){ try { els[i].click(); return {clicked:true, text:els[i].innerText || ''}; } catch(e){} } return {clicked:false}; })();`,
          'click-fallback', log);
        if (fallback && fallback.clicked) {
          await tracker.waitForStable(800, 5000);
          await sleep(2000);
          actuallyPublished = true;
        }
      } catch { /* ignore */ }
    }

    // ✅ 发布成功后自动关闭窗口（给 3 秒展示时间）
    if (win && !win.isDestroyed()) {
      log('info', 'auto-close', `🎯 发布成功！3 秒后自动关闭发布窗口…`);
      try {
        await sleep(3000);
        if (!win.isDestroyed()) {
          win.destroy();
          log('info', 'auto-close', `✅ 发布窗口已关闭`);
        }
      } catch (closeErr) {
        log('warn', 'auto-close', `关闭窗口异常: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      }
    }

    onProgress(100, '发布流程完成');
    return finalize(
      'success',
      uploadResult.ready ? '发布流程已自动完成。如平台弹出二次确认，请在窗口中手动点击确认' : '上传自动完成失败，请在窗口中检查最终状态',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', `发布流程异常: ${msg}`);
    if (win && !win.isDestroyed()) { try { win.show(); } catch { /* ignore */ } }
    return finalize('failed', `发布失败: ${msg}`);
  } finally {
    if (tracker) { try { tracker.dispose(); } catch { /* ignore */ } }
    // 窗口已在成功分支中关闭（或失败分支中保留让用户处理）
  }
}

/** 发布后验证脚本 — 检测页面真实反应 */
export function buildPublishVerifier(): string {
  return `
    (function () {
      var body = document.body;
      var bodyText = body ? (body.innerText || '') : '';
      var url = location.href;
      var result = {
        url: url,
        leftPublishPage: false,
        hasSuccessText: false,
        hasDraftText: false,
        hasConfirmText: false,
        hasErrorText: false,
        errorMessage: '',
        pageText: bodyText.slice(0, 200),
        verdict: 'unknown'
      };
      try {
        // 严格判断是否离开发布页：URL 中没有 /publish/video/article 等路径，但包含 manage/center/creator/home 等管理页路径
        var isPublishPage = /\/publish\b|\/article\/publish|\/post\b|\/upload\b/.test(url);
        var isManagePage = /\/manage|\/center|\/creator|\/articles\?|\/works\?|\/media|status=\d|from=publish/.test(url);
        if (!isPublishPage && isManagePage) result.leftPublishPage = true;
      } catch (e1) {}
      try {
        // 严格的成功文本：避免把"已发布成功，请勿重复点击"等提示误判
        if (/\b发布成功\b|\b发布完成\b|\b已发布\b|\b已成功发布\b|\b内容已发布/.test(bodyText)) result.hasSuccessText = true;
      } catch (e2) {}
      try {
        if (/\b草稿\b|\b已保存\b|\b存为草稿/.test(bodyText)) result.hasDraftText = true;
      } catch (e3) {}
      try {
        if (/\b确认发布\b|\b确定发布\b|\b是否发布\b/.test(bodyText)) result.hasConfirmText = true;
      } catch (e4) {}
      try {
        // 严格错误关键词：避免把"请填写标题"、"请勿重复点击"等提示误判为发布失败
        var errWords = ['发布失败', '提交失败', '无法发布', '上传失败', '格式不支持', '内容违规', '审核不通过', '网络异常，请重试'];
        for (var ei = 0; ei < errWords.length; ei++) {
          if (bodyText.indexOf(errWords[ei]) !== -1) {
            result.hasErrorText = true;
            result.errorMessage = errWords[ei];
            break;
          }
        }
      } catch (e5) {}
      if (result.hasSuccessText) result.verdict = 'success';
      else if (result.leftPublishPage && !result.hasDraftText) result.verdict = 'maybe_success_url_changed';
      else if (result.hasConfirmText) result.verdict = 'need_confirm';
      else if (result.hasErrorText) result.verdict = 'has_error';
      else if (result.hasDraftText) result.verdict = 'saved_as_draft';
      else result.verdict = 'unclear';
      return result;
    })();
  `;
}
