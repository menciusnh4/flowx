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
 * CDP 文件上传 — 穿透 shadow DOM 找到 file input 并注入文件路径
 * 同时尝试点击上传按钮触发平台上传流程
 */
export async function uploadViaCDP(
  win: BrowserWindow,
  files: string[],
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    log('info', 'upload', `开始上传: ${files.join(', ')}`);

    // 方法 A：先用 DOM API 定位 file input，然后通过 debugger 协议 setFileInputFiles
    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 可能已 attached */ }

    try {
      const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      // 扁平化收集所有节点
      const allNodes: any[] = [];
      const walk = (node: any) => {
        if (!node) return;
        allNodes.push(node);
        if (node.children) node.children.forEach(walk);
        if (node.shadowRoots) node.shadowRoots.forEach(walk);
        if (node.templateContent) walk(node.templateContent);
        if (node.contentDocument) walk(node.contentDocument);
      };
      walk(docResult.root);

      log('info', 'upload', `CDP 遍历到 ${allNodes.length} 个节点`);

      // 找出 type=file 的 input
      let fileInputNodeId: number | null = null;
      for (const n of allNodes) {
        if (!n || !n.attributes) continue;
        const nodeName = (n.nodeName || '').toLowerCase();
        if (nodeName !== 'input') continue;
        for (let i = 0; i < n.attributes.length; i += 2) {
          if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') {
            fileInputNodeId = n.nodeId;
            break;
          }
        }
        if (fileInputNodeId !== null) break;
      }

      if (fileInputNodeId !== null) {
        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: fileInputNodeId,
          files,
        });
        log('info', 'upload', `✅ CDP 上传文件成功`);
        return true;
      } else {
        log('warn', 'upload', `CDP 没找到 file input，回退到 executeJavaScript`);
      }
    } catch (cdpErr) {
      log('warn', 'upload', `CDP 协议出错: ${(cdpErr as Error).message}`);
    }

    // 方法 B：兜底 — executeJavaScript 找到 input[type="file"] 并触发 change 事件
    try {
      const bResult = await win.webContents.executeJavaScript(`
        (function () {
          var inputs = document.querySelectorAll('input[type="file"]');
          if (!inputs.length) return false;
          var target = inputs[0];
          try { target.click(); } catch (e) {}
          return true;
        })();
      `);
      if (bResult) {
        log('info', 'upload', `✅ executeJavaScript 触发上传流程`);
        return true;
      }
    } catch (jsErr) {
      log('warn', 'upload', `executeJavaScript 兜底失败: ${(jsErr as Error).message}`);
    }

    return false;
  } catch (err) {
    log('error', 'upload', `上传总异常: ${(err as Error).message}`);
    return false;
  }
}

/** 轮询等待上传完成：检测页面进入"可编辑/已上传"状态 */
export async function waitForUploadComplete(
  win: BrowserWindow,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  onProgress: (p: number, m?: string) => void,
  timeoutMs = 300000,
  tracker?: NavigationTracker,
): Promise<{ ready: boolean; finalStatus: string }> {
  const start = Date.now();
  const interval = 4000;
  // 上传完成的脚本（v2：降低门槛，增加诊断，支持 shadow DOM）
  const probeScript = `
    (function () {
      var bodyText = document.body ? (document.body.innerText || '') : '';

      // 1) 封面检测（降低门槛：任何可见图片或视频元素都算有封面预览）
      var thumbCount = 0;
      try {
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
          var w = imgs[i].offsetWidth || 0;
          var h = imgs[i].offsetHeight || 0;
          if (w > 10 && h > 10) thumbCount++;
        }
        var vids = document.querySelectorAll('video');
        for (var j = 0; j < vids.length; j++) {
          if ((vids[j].offsetWidth || 0) > 10 && (vids[j].offsetHeight || 0) > 10) thumbCount++;
        }
      } catch (e) {}

      // 2) 可编辑区域检测：textarea / contenteditable / text input
      var textareaList = [];
      try {
        var tareas = document.querySelectorAll('textarea');
        for (var k = 0; k < Math.min(tareas.length, 5); k++) {
          var t = tareas[k];
          if (t.offsetWidth > 0 || t.offsetHeight > 0) {
            textareaList.push({
              ph: (t.getAttribute('placeholder') || '').slice(0, 50),
              aria: (t.getAttribute('aria-label') || '').slice(0, 50),
              w: t.offsetWidth, h: t.offsetHeight,
            });
          }
        }
      } catch (e) {}

      var ceList = [];
      try {
        var ces = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
        for (var m = 0; m < Math.min(ces.length, 5); m++) {
          var c = ces[m];
          if (c.offsetWidth > 0 || c.offsetHeight > 0) {
            ceList.push({
              aria: (c.getAttribute('aria-label') || '').slice(0, 50),
              ph: (c.getAttribute('placeholder') || '').slice(0, 50),
              text: (c.innerText || '').slice(0, 60),
              w: c.offsetWidth, h: c.offsetHeight,
            });
          }
        }
      } catch (e) {}

      var textInputList = [];
      try {
        var allInps = document.querySelectorAll('input');
        for (var n = 0; n < Math.min(allInps.length, 10); n++) {
          var inp = allInps[n];
          var itype = (inp.getAttribute('type') || 'text').toLowerCase();
          if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio') continue;
          if ((inp.offsetWidth || 0) === 0 && (inp.offsetHeight || 0) === 0) continue;
          textInputList.push({
            type: itype,
            ph: (inp.getAttribute('placeholder') || '').slice(0, 50),
            aria: (inp.getAttribute('aria-label') || '').slice(0, 50),
            w: inp.offsetWidth, h: inp.offsetHeight,
          });
        }
      } catch (e) {}

      // 3) 状态判断
      var hasEditField = (textareaList.length + ceList.length + textInputList.length) > 0;
      var hasThumb = thumbCount > 0;
      var uploadingMatch = /上传中|正在上传|上传文件|处理中|转码|解析|processing|uploading|transcoding/i.test(bodyText);
      var processingMatch = /转码|解析|处理中|正在处理|encoding|compressing/i.test(bodyText);

      // ready 条件：页面有可编辑区域 且 没有明显的"上传中"字样
      var readyStatus = 'waiting';
      if (uploadingMatch || processingMatch) {
        readyStatus = 'uploading';
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
        body: bodyText.slice(0, 300)
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
        return { ready: true, finalStatus: 'ready' };
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

/** 页面结构探测（用于日志排查） */
export function buildPageStructureProbe(): string {
  return `
    (function () {
      var result = {
        inputs: [],
        contenteditable: [],
        buttons: [],
        uploadDivs: [],
        hasFileInput: false,
      };
      try {
        var inputs = document.querySelectorAll('input');
        for (var i=0; i<Math.min(inputs.length, 10); i++) {
          var el = inputs[i];
          result.inputs.push({
            type: el.getAttribute('type'),
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
          });
          if (el.getAttribute('type') === 'file') result.hasFileInput = true;
        }
      } catch (e) {}
      try {
        var ce = document.querySelectorAll('[contenteditable="true"]');
        for (var j=0; j<Math.min(ce.length, 5); j++) {
          result.contenteditable.push({ text: (ce[j].innerText || '').slice(0, 50) });
        }
      } catch (e) {}
      try {
        var btns = document.querySelectorAll('button, [role="button"], a, div');
        for (var k=0; k<btns.length; k++) {
          var txt = (btns[k].innerText || '').trim();
          if (txt && txt.length <= 30) result.buttons.push({ text: txt });
          if (result.buttons.length >= 20) break;
        }
      } catch (e) {}
      try {
        var upKeywords = ['上传', 'upload', '选择文件', '选择视频', '选择图片'];
        var divs = document.querySelectorAll('div, button, a');
        for (var m=0; m<divs.length; m++) {
          var txt2 = (divs[m].innerText || '').trim();
          if (!txt2 || txt2.length > 30) continue;
          var matched = false;
          for (var n=0; n<upKeywords.length; n++) { if (txt2.indexOf(upKeywords[n]) !== -1) { matched = true; break; } }
          if (matched) result.uploadDivs.push({ text: txt2 });
          if (result.uploadDivs.length >= 10) break;
        }
      } catch (e) {}
      return result;
    })();
  `;
}

/** 填写标题脚本（v2：更灵活的元素匹配 + React 兼容的事件派发） */
export function buildFillTitle(title: string): string {
  const jt = JSON.stringify(title);
  return `
    (function () {
      var candidates = [];

      function tryGetLabel(el) {
        try {
          var id = el.getAttribute('id');
          if (id) {
            var lbl = document.querySelector('label[for="' + id + '"]');
            if (lbl) return (lbl.innerText || '').trim().toLowerCase().slice(0, 50);
          }
          var parent = el.parentElement;
          for (var t = 0; t < 3 && parent; t++) {
            var ph = parent.querySelector('span, label, :scope > div:first-child');
            if (ph && ph !== el) {
              var txt = (ph.innerText || '').trim().toLowerCase().slice(0, 50);
              if (txt.length > 0) return txt;
            }
            parent = parent.parentElement;
          }
        } catch (e) {}
        return '';
      }

      function scoreElement(el, type, text, isTitle) {
        var s = 0;
        if (!text) return s;
        var kw = isTitle ? ['标题', 'title', '作品标题', '作品名称'] : ['描述', '正文', '内容', '简介', 'description'];
        for (var i = 0; i < kw.length; i++) {
          if (text.indexOf(kw[i]) !== -1) { s += 200; break; }
        }
        // 标题输入框通常比较短（一行），正文通常比较大
        if (isTitle) {
          if (type === 'input') s += 20;
          if ((el.offsetHeight || 0) < 80) s += 10;
        } else {
          if (type === 'textarea') s += 30;
          if (type === 'contenteditable') s += 20;
          if ((el.offsetHeight || 0) > 80) s += 20;
        }
        return s;
      }

      // 1) textarea
      try {
        var tareas = document.querySelectorAll('textarea');
        for (var i = 0; i < tareas.length; i++) {
          var el = tareas[i];
          if ((el.offsetWidth || 0) === 0 && (el.offsetHeight || 0) === 0) continue;
          var ph = (el.getAttribute('placeholder') || '').toLowerCase();
          var aria = (el.getAttribute('aria-label') || '').toLowerCase();
          var lbl = tryGetLabel(el);
          var combinedText = [ph, aria, lbl].join(' ');
          candidates.push({
            el: el, tag: 'textarea', score: scoreElement(el, 'textarea', combinedText, true),
            text: combinedText.slice(0, 80)
          });
        }
      } catch (e) {}

      // 2) input (非 file/hidden/checkbox/radio)
      try {
        var allInps = document.querySelectorAll('input');
        for (var j = 0; j < allInps.length; j++) {
          var el2 = allInps[j];
          var itype = (el2.getAttribute('type') || 'text').toLowerCase();
          if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio') continue;
          if ((el2.offsetWidth || 0) === 0 && (el2.offsetHeight || 0) === 0) continue;
          var ph2 = (el2.getAttribute('placeholder') || '').toLowerCase();
          var aria2 = (el2.getAttribute('aria-label') || '').toLowerCase();
          var lbl2 = tryGetLabel(el2);
          var combined2 = [ph2, aria2, lbl2].join(' ');
          if (/话题|tag|标签/i.test(combined2)) continue; // 跳过话题输入框
          candidates.push({
            el: el2, tag: 'input', score: scoreElement(el2, 'input', combined2, true),
            text: combined2.slice(0, 80)
          });
        }
      } catch (e) {}

      // 3) contenteditable
      try {
        var ces = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
        for (var k = 0; k < ces.length; k++) {
          var el3 = ces[k];
          if ((el3.offsetWidth || 0) === 0 && (el3.offsetHeight || 0) === 0) continue;
          var aria3 = (el3.getAttribute('aria-label') || '').toLowerCase();
          var ph3 = (el3.getAttribute('placeholder') || '').toLowerCase();
          var lbl3 = tryGetLabel(el3);
          var combined3 = [aria3, ph3, lbl3].join(' ');
          candidates.push({
            el: el3, tag: 'contenteditable', score: scoreElement(el3, 'contenteditable', combined3, true),
            text: combined3.slice(0, 80)
          });
        }
      } catch (e) {}

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
            // 方法 A：原生 setter（最稳定）
            var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(target.el, ${jt});
            method = 'native-setter';
          } catch (e1) {
            try {
              // 方法 B：直接赋值
              target.el.value = ${jt};
              method = 'direct-value';
            } catch (e2) {
              target.el.innerText = ${jt};
              method = 'fallback-innerText';
            }
          }
        }
        // 派发多个事件以确保 React/Vue 等框架能感知变化
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

/** 填写正文/描述脚本（v2：更灵活的元素匹配 + 跳过已经填了标题的元素） */
export function buildFillContent(content: string): string {
  const jc = JSON.stringify(content);
  return `
    (function () {
      var candidates = [];
      var used = []; // 记录已经填过标题的元素（通过 DOM 状态判断）

      function tryGetLabel(el) {
        try {
          var id = el.getAttribute('id');
          if (id) {
            var lbl = document.querySelector('label[for="' + id + '"]');
            if (lbl) return (lbl.innerText || '').trim().toLowerCase().slice(0, 50);
          }
          var parent = el.parentElement;
          for (var t = 0; t < 3 && parent; t++) {
            var ph = parent.querySelector('span, label, :scope > div:first-child');
            if (ph && ph !== el) {
              var txt = (ph.innerText || '').trim().toLowerCase().slice(0, 50);
              if (txt.length > 0) return txt;
            }
            parent = parent.parentElement;
          }
        } catch (e) {}
        return '';
      }

      function scoreElement(el, type, text) {
        var s = 0;
        if (!text) return s;
        var kw = ['描述', '正文', '内容', '简介', 'description', '介绍'];
        for (var i = 0; i < kw.length; i++) {
          if (text.indexOf(kw[i]) !== -1) { s += 200; break; }
        }
        if (type === 'textarea') s += 30;
        if (type === 'contenteditable') s += 20;
        if ((el.offsetHeight || 0) > 80) s += 20;
        return s;
      }

      // 收集所有可编辑元素
      var allEls = [];
      try {
        var tareas = document.querySelectorAll('textarea');
        for (var i = 0; i < tareas.length; i++) {
          if ((tareas[i].offsetWidth || 0) === 0 && (tareas[i].offsetHeight || 0) === 0) continue;
          allEls.push({ el: tareas[i], tag: 'textarea' });
        }
      } catch (e) {}
      try {
        var allInps = document.querySelectorAll('input');
        for (var j = 0; j < allInps.length; j++) {
          var itype = (allInps[j].getAttribute('type') || 'text').toLowerCase();
          if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio') continue;
          if ((allInps[j].offsetWidth || 0) === 0 && (allInps[j].offsetHeight || 0) === 0) continue;
          allEls.push({ el: allInps[j], tag: 'input' });
        }
      } catch (e) {}
      try {
        var ces = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
        for (var k = 0; k < ces.length; k++) {
          if ((ces[k].offsetWidth || 0) === 0 && (ces[k].offsetHeight || 0) === 0) continue;
          allEls.push({ el: ces[k], tag: 'contenteditable' });
        }
      } catch (e) {}

      // 对每个元素评分 + 检测是否已有内容（可能是标题刚填的）
      for (var m = 0; m < allEls.length; m++) {
        var elx = allEls[m].el;
        var val = (elx.value !== undefined ? elx.value : elx.innerText) || '';
        var ph = (elx.getAttribute('placeholder') || '').toLowerCase();
        var aria = (elx.getAttribute('aria-label') || '').toLowerCase();
        var lbl = tryGetLabel(elx);
        var combined = [ph, aria, lbl].join(' ');
        // 跳过明确是"标题"相关的元素（标题脚本应该已经填它了）
        if (/标题|作品标题|作品名称|title/i.test(combined)) continue;
        // 跳过已经有内容的元素（可能是话题输入框已经被填过了）
        if (val.length > 0 && /话题|tags|tag/i.test(combined)) continue;
        candidates.push({
          el: elx, tag: allEls[m].tag,
          score: scoreElement(elx, allEls[m].tag, combined),
          text: combined.slice(0, 80),
          hasContent: val.length > 0
        });
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

/** 发布按钮点击脚本（关键词匹配 + shadow DOM 穿透 + 祖先层级触发） */
export function buildPublishButtonClicker(keyword: string): string {
  const jk = JSON.stringify(keyword);
  return `
    (function () {
      var candidates = [];
      try { window.scrollTo(0, (document.documentElement && document.documentElement.scrollHeight) || (document.body && document.body.scrollHeight) || 0); } catch (e) {}
      var viewportH = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 600;
      var viewportW = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 800;

      // 策略 1：Shadow DOM 自定义组件（如 <xhs-publish-btn>）
      try {
        var shadowTags = ['xhs-publish-btn', 'xhs-button', 'publish-button', 'xhs-publish', 'xhs-upload-btn'];
        for (var si = 0; si < shadowTags.length; si++) {
          var host = document.querySelector(shadowTags[si]);
          if (!host) continue;
          var sr = host.shadowRoot;
          if (!sr) continue;
          var inner = sr.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="submit"], [class*="publish"], [class*="primary"], [class*="red"]');
          for (var ii = 0; ii < inner.length; ii++) {
            try {
              var selEl = inner[ii];
              if (selEl.offsetWidth <= 5 || selEl.offsetHeight <= 5) continue;
              var st = getComputedStyle(selEl);
              if (st.visibility === 'hidden' || st.display === 'none') continue;
              if ((selEl.hasAttribute && selEl.hasAttribute('disabled')) || selEl.getAttribute('aria-disabled') === 'true') continue;
              var selText = (selEl.innerText || selEl.textContent || '').trim();
              if (!selText) continue;
              var selClass = ((selEl.className && typeof selEl.className === 'string') ? selEl.className : '').toLowerCase();
              var selRect = selEl.getBoundingClientRect ? selEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var selScore = 0;
              if (/red|primary|danger|submit|publish|bg-red/i.test(selClass)) selScore += 3000;
              if (selText === ${jk}) selScore += 3000;
              else if (selText.indexOf(${jk}) === 0) selScore += 1500;
              else if (selText.indexOf(${jk}) !== -1) selScore += 500;
              if (selEl.tagName && selEl.tagName.toLowerCase() === 'button') selScore += 2000;
              var selFromBottom = viewportH - selRect.bottom;
              if (selFromBottom >= -300 && selFromBottom < viewportH) selScore += 500;
              candidates.push({ el: selEl, score: selScore, text: selText, tag: selEl.tagName ? selEl.tagName.toLowerCase() : 'element', classStr: selClass.slice(0, 60), fromBottom: Math.round(selFromBottom), w: selEl.offsetWidth, h: selEl.offsetHeight, source: 'shadow-dom:' + shadowTags[si] });
            } catch (e) {}
          }
        }
      } catch (e) {}

      // 策略 2：class 精确选择器
      try {
        var classSels = ['.ce-btn.bg-red', '.ce-btn [class*="red"]', 'button.ce-btn', '.ce-btn', '.publish-btn', '.btn-publish', 'button [class*="publish"]', '.bg-red', '[class*="btn-primary"]', '[class*="btn-danger"]'];
        for (var ci = 0; ci < classSels.length; ci++) {
          var selList = document.querySelectorAll(classSels[ci]);
          for (var ei = 0; ei < selList.length; ei++) {
            var sEl = selList[ei];
            try {
              if (sEl.offsetWidth <= 5 || sEl.offsetHeight <= 5) continue;
              var sSty = getComputedStyle(sEl);
              if (sSty.visibility === 'hidden' || sSty.display === 'none') continue;
              if ((sEl.hasAttribute && sEl.hasAttribute('disabled')) || sEl.getAttribute('aria-disabled') === 'true') continue;
              var sText = (sEl.innerText || sEl.textContent || '').trim();
              if (!sText) continue;
              var sClass = ((sEl.className && typeof sEl.className === 'string') ? sEl.className : '').toLowerCase();
              if (/nav|menu|header|sidebar|breadcrumb|tabs/.test(sClass)) continue;
              var sRect = sEl.getBoundingClientRect ? sEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var sScore = 0;
              if (/bg-red|primary|danger|submit|publish/i.test(sClass)) sScore += 2000;
              if (sText === ${jk}) sScore += 3000;
              else if (sText.indexOf(${jk}) === 0) sScore += 1500;
              else if (sText.indexOf(${jk}) !== -1) sScore += 500;
              if (sEl.tagName.toLowerCase() === 'button') sScore += 1500;
              var sFromBottom = viewportH - sRect.bottom;
              if (sFromBottom >= -200 && sFromBottom < viewportH * 0.5) sScore += 800;
              var sFromRight = viewportW - sRect.right;
              if (sFromRight >= -100 && sFromRight < viewportW * 0.5) sScore += 300;
              candidates.push({ el: sEl, score: sScore, text: sText, tag: sEl.tagName.toLowerCase(), classStr: sClass.slice(0, 60), fromBottom: Math.round(sFromBottom), fromRight: Math.round(sFromRight), w: sEl.offsetWidth, h: sEl.offsetHeight, source: 'class:' + classSels[ci] });
            } catch (e) {}
          }
        }
      } catch (e) {}

      // 策略 3：底部区域扫描
      try {
        var clickable = document.querySelectorAll('button, a, [role="button"], div');
        for (var di = 0; di < clickable.length; di++) {
          var de = clickable[di];
          try {
            if (de.offsetWidth < 40 || de.offsetHeight < 28) continue;
            var dSty = getComputedStyle(de);
            if (dSty.visibility === 'hidden' || dSty.display === 'none') continue;
            var dRect = de.getBoundingClientRect ? de.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
            var dFromBottom = viewportH - dRect.bottom;
            if (dFromBottom < -300 || dFromBottom >= viewportH * 0.6) continue;
            var dText = (de.innerText || de.textContent || '').trim();
            if (!dText || dText.length > 30) continue;
            var dClass = ((de.className && typeof de.className === 'string') ? de.className : '').toLowerCase();
            if (/nav|menu|header|sidebar|breadcrumb|tabs|tab-bar|setting|option|select|dropdown|filter|sort|config/.test(dClass)) continue;
            var dScore = 0;
            if (dText === ${jk}) dScore += 3000;
            else if (dText.indexOf(${jk}) === 0) dScore += 1000;
            else if (dText.indexOf(${jk}) !== -1) dScore += 200;
            if (de.tagName.toLowerCase() === 'button') dScore += 1200;
            if (/bg-red|primary|danger|submit|publish|ce-btn/i.test(dClass)) dScore += 2000;
            if (dFromBottom >= 0 && dFromBottom < viewportH * 0.3) dScore += 600;
            candidates.push({ el: de, score: dScore, text: dText, tag: de.tagName.toLowerCase(), classStr: dClass.slice(0, 60), fromBottom: Math.round(dFromBottom), w: de.offsetWidth, h: de.offsetHeight, source: 'bottom-scan' });
          } catch (e) {}
        }
      } catch (e) {}

      // 策略 4：最后一个可见按钮兜底
      try {
        var lastBtns = document.querySelectorAll('button, [role="button"]');
        for (var li = lastBtns.length - 1; li >= Math.max(0, lastBtns.length - 5); li--) {
          var le = lastBtns[li];
          try {
            if (le.offsetWidth < 40 || le.offsetHeight < 28) continue;
            var lSty = getComputedStyle(le);
            if (lSty.visibility === 'hidden' || lSty.display === 'none') continue;
            var lText = (le.innerText || le.textContent || '').trim();
            if (!lText || lText.length > 30) continue;
            var lClass = ((le.className && typeof le.className === 'string') ? le.className : '').toLowerCase();
            var lScore = 500 + (lastBtns.length - li) * 100;
            if (/bg-red|primary|danger|submit|publish|ce-btn/i.test(lClass)) lScore += 2000;
            if (lText === ${jk}) lScore += 3000;
            candidates.push({ el: le, score: lScore, text: lText, tag: le.tagName.toLowerCase(), classStr: lClass.slice(0, 60), fromBottom: 0, w: le.offsetWidth, h: le.offsetHeight, source: 'last-button' });
          } catch (e) {}
        }
      } catch (e) {}

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

      // 对目标及其祖先触发事件序列
      var ancestors = [];
      var cur = target.el;
      for (var ai = 0; ai < 6 && cur && cur !== document.body; ai++) {
        ancestors.push(cur);
        cur = cur.parentElement;
      }
      var initialUrl = location.href;
      for (var ri = 0; ri < ancestors.length; ri++) {
        try {
          ancestors[ri].scrollIntoView({ block: 'center', behavior: 'instant' in window ? 'instant' : 'auto' });
          try { ancestors[ri].click(); } catch (e) {}
          var r = ancestors[ri].getBoundingClientRect ? ancestors[ri].getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var mi = { bubbles: true, cancelable: true, view: window, detail: 1, clientX: cx, clientY: cy, button: 0, buttons: 1 };
          try {
            ancestors[ri].dispatchEvent(new MouseEvent('mousedown', mi));
            ancestors[ri].dispatchEvent(new MouseEvent('focus', mi));
            ancestors[ri].dispatchEvent(new MouseEvent('mouseup', mi));
            ancestors[ri].dispatchEvent(new MouseEvent('click', mi));
          } catch (e) {}
          try {
            ancestors[ri].dispatchEvent(new PointerEvent('pointerdown', mi));
            ancestors[ri].dispatchEvent(new PointerEvent('pointerup', mi));
          } catch (e) {}
        } catch (e) {}
      }
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
    for (let i = 0; i < keywords.length; i++) {
      try {
        const res: any = await evalJS(win, buildPublishButtonClicker(keywords[i]), `click-${keywords[i]}`, log);
        if (res && res.clicked) { clicked = true; log('info', 'submit', `点击成功: ${keywords[i]}`); break; }
      } catch (e) { log('warn', 'submit', `关键词 "${keywords[i]}" 点击异常`); }
    }

    if (clicked) {
      // 点击后可能触发导航 / 弹窗，先等稳定
      await tracker.waitForStable(800, 8000);
      await sleep(1500);

      if (config.enablePostClickVerify) {
        try {
          const v1: any = await evalJS(win, buildPublishVerifier(), 'verify-1', log);
          log('info', 'verify', `验证1: ${v1.verdict}`);
          if (v1.verdict === 'need_confirm') {
            await evalJS(win, buildPublishButtonClicker('确认发布'), 'click-confirm', log).catch(() => {});
            await sleep(2500);
          } else if (v1.verdict === 'saved_as_draft') {
            const tryKeys = ['发布笔记', '立即发布', '发布视频'];
            for (const kw of tryKeys) {
              try {
                const r: any = await evalJS(win, buildPublishButtonClicker(kw), `click-${kw}`, log);
                if (r && r.clicked) { await sleep(2500); break; }
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
      } else if (config.enableConfirmStep) {
        try { await evalJS(win, buildPublishButtonClicker('确认'), 'click-confirm', log); } catch { /* ignore */ }
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
    if (win && !win.isDestroyed()) {
      // 不要立刻 destroy，给平台一点时间；主调方（PublishEngine）通常会自行关闭
      // 这里保留 open 便于用户手动确认。主调方若想关闭可自行调用。
      try { /* leave open */ } catch { /* ignore */ }
    }
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
        var hasPublishInUrl = url.indexOf('publish') !== -1;
        if (!hasPublishInUrl && (url.indexOf('creator') !== -1 || url.indexOf('home') !== -1)) result.leftPublishPage = true;
      } catch (e1) {}
      try {
        if (bodyText.indexOf('发布成功') !== -1 || bodyText.indexOf('发布完成') !== -1 || bodyText.indexOf('已发布成功') !== -1) result.hasSuccessText = true;
      } catch (e2) {}
      try {
        if (bodyText.indexOf('草稿') !== -1 || bodyText.indexOf('已保存') !== -1) result.hasDraftText = true;
      } catch (e3) {}
      try {
        if (bodyText.indexOf('确认发布') !== -1 || bodyText.indexOf('确定发布') !== -1 || bodyText.indexOf('是否发布') !== -1) result.hasConfirmText = true;
      } catch (e4) {}
      try {
        var errWords = ['发布失败', '失败', '格式错误', '不能为空', '缺少必要', '无法发布'];
        for (var i = 0; i < errWords.length; i++) {
          if (bodyText.indexOf(errWords[i]) !== -1) {
            result.hasErrorText = true;
            result.errorMessage = errWords[i];
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
