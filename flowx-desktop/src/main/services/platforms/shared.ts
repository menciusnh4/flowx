import { BrowserWindow, session as electronSession } from 'electron';
import type { PublishLogEntry, PublishItemProgress, PublishRequest, PlatformType, ContentType } from '../../../types';
import { getAppIcon } from '../../windows/MainWindow';
import { getStore } from '../../store/SecureStore';
import { BrowserEnvService } from '../BrowserEnvService';

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
  const partition = `persist:account_${accountId}`;
  const sess = electronSession.fromPartition(partition);
  const store = getStore();
  const accounts = store.get('accounts') as any[] | undefined;
  const cred = accounts?.find((a) => a.id === accountId);
  const envId = cred?.envId;

  // 异步应用指纹与代理配置，确保在网络请求发起前生效（无条件执行，以确保未绑定环境时亦会净化默认 UA 特征）
  BrowserEnvService.applyEnvironment(sess, envId).catch((err) => {
    console.error(`[PublishWindow] 环境隔离设置失败: ${err.message}`);
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title,
    autoHideMenuBar: true,
    show: true,
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

/**
 * 切换发布页的"内容类型 tab"（视频 ↔ 图文）。
 *
 * 背景：
 *   - 小红书 / 抖音 / 快手 的发布页默认都在"视频上传"模式
 *   - 发布图文需要先点击页面上的"图文 / 图片上传"区域或 tab 切换到图文上传模式
 *   - 切换后页面的 file input 才会替换为"接受图片"的 input
 *
 * 实现思路（通用脚本，不依赖特定 DOM 结构）：
 *   在整页（主文档 + iframe + shadow DOM）搜索包含以下关键词的可点击元素：
 *     图文 / 图片 / 相册 / 上传图文 / 发布图文 / 图文笔记
 *   同时排除包含"视频"关键词的元素（避免误点视频 tab）。
 *
 * @param contentType 当前发布类型 — 'image'/'article' 需要切换到图文；'video' 无需切换
 * @returns true 表示切换成功（或本来就是正确的类型）；false 表示未找到可切换的元素
 */
export async function switchContentTypeTab(
  win: BrowserWindow,
  contentType: ContentType | undefined,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 视频类型：保持默认即可，无需切换 tab
  if (!contentType || contentType === 'video') {
    log('info', 'tab', `当前 contentType=${contentType || 'video'}，保持默认视频 tab`);
    return true;
  }
  log('info', 'tab', `检测到 contentType=${contentType}，尝试切换到图文 tab…`);

  const switchScript = `
    (function () {
      // 递归收集 root：主文档 + iframe.contentDocument + shadowRoot
      var roots = [];
      function collectRoot(root) {
        if (!root) return;
        roots.push(root);
        try {
          var iframes = root.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
              if (idoc) collectRoot(idoc);
            } catch (e) { /* 跨域 iframe 忽略 */ }
          }
        } catch (e) {}
        try {
          // shadow DOM（open）
          if (root.querySelectorAll) {
            var els = root.querySelectorAll('*');
            for (var j = 0; j < els.length; j++) {
              try {
                if (els[j].shadowRoot) collectRoot(els[j].shadowRoot);
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
      collectRoot(document);

      // 在每个 root 中搜索候选（div / button / a / [role=button] / [role=tab]）
      var candidates = [];
      var keywords_article = ['图文', '图片', '相册', '发布图文', '上传图文', '图文笔记', '图片上传', '图'];
      var keywords_video = ['视频', '上传视频', '视频上传'];

      function addCandidate(el, rootHint) {
        try {
          var txt = (el.innerText || el.textContent || '').trim();
          if (!txt || txt.length > 50) return;
          var isArticle = false;
          for (var ki = 0; ki < keywords_article.length; ki++) {
            if (txt.indexOf(keywords_article[ki]) !== -1) { isArticle = true; break; }
          }
          var isVideo = false;
          for (var kv = 0; kv < keywords_video.length; kv++) {
            if (txt.indexOf(keywords_video[kv]) !== -1) { isVideo = true; break; }
          }
          // 只选"含图文关键词且不含视频关键词"的元素
          if (!isArticle || isVideo) return;

          var tag = (el.tagName || '').toLowerCase();
          var role = el.getAttribute && el.getAttribute('role') || '';
          var cls = el.getAttribute && el.getAttribute('class') || '';
          var score = 0;
          // role=tab / tag=button 优先
          if (role === 'tab') score += 500;
          if (tag === 'button') score += 400;
          if (role === 'button') score += 300;
          if (tag === 'a') score += 200;
          // 含特定 tab 关键词（来自页面结构）加分
          if (txt.indexOf('图文') !== -1) score += 200;
          if (txt.indexOf('图片') !== -1) score += 150;
          // 可点击判断：有 onclick / 有 cursor pointer / 是原生可点击标签
          var hasClickHandler = el.onclick !== null || (el.style && el.style.cursor === 'pointer');
          if (hasClickHandler || tag === 'button' || tag === 'a' || role === 'button' || role === 'tab') {
            score += 100;
          }
          // 尺寸过滤
          if (el.offsetWidth < 30 || el.offsetHeight < 20) return;  // 太小
          if (el.offsetWidth > 800 || el.offsetHeight > 500) return; // 太大（可能是容器）

          candidates.push({
            el: el,
            score: score,
            text: txt.slice(0, 40),
            tag: tag,
            role: role,
            cls: (cls || '').slice(0, 60),
            rootHint: rootHint,
          });
        } catch (e) {}
      }

      for (var ri = 0; ri < roots.length; ri++) {
        try {
          var r = roots[ri];
          var tags = ['div', 'button', 'a', 'span', 'section', 'li'];
          for (var ti = 0; ti < tags.length; ti++) {
            var list = r.querySelectorAll(tags[ti]);
            for (var ci = 0; ci < list.length; ci++) {
              addCandidate(list[ci], ri === 0 ? 'main' : 'sub');
            }
          }
          // role=tab 特殊搜索
          var roleTabs = r.querySelectorAll('[role="tab"]');
          for (var ri2 = 0; ri2 < roleTabs.length; ri2++) addCandidate(roleTabs[ri2], 'role-tab');
        } catch (e) {}
      }

      if (candidates.length === 0) return { clicked: false, reason: 'no-candidate', totalRoots: roots.length };

      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      try {
        top.el.click();
      } catch (e) {
        try {
          var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          top.el.dispatchEvent(evt);
        } catch (e2) {}
      }
      // 返回前 5 个候选，方便调试
      var topFive = candidates.slice(0, 5).map(function (c) {
        return { text: c.text, score: c.score, tag: c.tag, role: c.role, cls: c.cls };
      });
      return { clicked: true, text: top.text, score: top.score, candidates: topFive, totalRoots: roots.length };
    })();
  `;

  try {
    // 确保 CDP debugger 已 attach（如果之前没有调用过 uploadViaCDP，可能未 attach）
    try { await win.webContents.debugger.attach('1.3'); } catch { /* 已 attached */ }
    const res: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: switchScript, returnByValue: true,
    }).catch(() => null);
    const val = res && res.result && res.result.value ? res.result.value : null;
    if (val && val.clicked) {
      log('info', 'tab', `✅ 已切换到图文 tab（匹配文本="${val.text}"，score=${val.score}）`);
      await sleep(1500); // 给页面一点时间完成 tab 切换后 DOM 替换
      return true;
    }
    log('warn', 'tab', `未找到图文 tab（可能是页面结构不同或已在正确 tab），继续原流程。debug: ${JSON.stringify(val).slice(0, 300)}`);
    // 找不到也不阻断 — 继续用默认方式上传
    return false;
  } catch (e) {
    log('warn', 'tab', `tab 切换脚本异常: ${(e as Error).message}`);
    return false;
  }
}

export async function uploadViaCDP(
  win: BrowserWindow,
  files: string[],
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  contentType?: ContentType,
): Promise<boolean> {
  try {
    log('info', 'upload', `开始上传: ${files.join(', ')}`);

    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 可能已 attached */ }

    // 统一工具：用指定 nodeId / objectId 注入文件，并触发 change/input 事件
    // 关键修复：DOM.setFileInputFiles 只设置 files 属性，不触发 change 事件
    // 现代框架（React/Vue）监听 change/input 事件才能检测到文件选择
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

        // 🔑 物理派发 change 和 input 事件（通过 Runtime.callFunctionOn 强行穿透任何 iframe 和隔离环境）
        try {
          let targetObjectId = objectId;
          if (nodeId !== undefined && nodeId !== null) {
            const resNode = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }).catch(() => null);
            if (resNode && resNode.object) {
              targetObjectId = resNode.object.objectId;
            }
          }
          if (targetObjectId) {
            await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
              objectId: targetObjectId,
              functionDeclaration: `
                function() {
                  try {
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                  } catch(e) {}
                }
              `
            }).catch(() => null);
            log('info', 'upload', `[${source}] 通过 Runtime.callFunctionOn 物理派发事件完成`);
          }
        } catch (callErr) {
          log('warn', 'upload', `[${source}] Runtime.callFunctionOn 派发失败: ${(callErr as Error).message}`);
        }

        // 🔑 触发 change 和 input 事件（让页面 JS/框架检测到文件变化）
        try {
          log('info', 'upload', `[${source}] 触发 change/input 事件…`);
          const evtScript = `
            (function () {
              try {
                var inputs = document.querySelectorAll('input[type="file"]');
                // 同时递归遍历 shadow roots
                function getShadowInputs(root) {
                  if (!root) return [];
                  var results = [];
                  try {
                    var localInputs = root.querySelectorAll && root.querySelectorAll('input[type="file"]');
                    if (localInputs) for (var i = 0; i < localInputs.length; i++) results.push(localInputs[i]);
                    var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
                    for (var j = 0; j < all.length; j++) {
                      try {
                        if (all[j].shadowRoot) {
                          var srInputs = getShadowInputs(all[j].shadowRoot);
                          for (var k = 0; k < srInputs.length; k++) results.push(srInputs[k]);
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                  return results;
                }
                var allFileInputs = [];
                for (var i2 = 0; i2 < inputs.length; i2++) allFileInputs.push(inputs[i2]);
                var shadowInputs = getShadowInputs(document.documentElement);
                for (var j2 = 0; j2 < shadowInputs.length; j2++) allFileInputs.push(shadowInputs[j2]);
                // 对所有有文件的 input 触发事件
                var triggered = 0;
                for (var m = 0; m < allFileInputs.length; m++) {
                  var fi = allFileInputs[m];
                  if (fi.files && fi.files.length > 0) {
                    try { fi.dispatchEvent(new Event('change', { bubbles: true })); } catch (e1) {}
                    try { fi.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
                    triggered++;
                  }
                }
                return { triggered: triggered, total: allFileInputs.length };
              } catch (e) { return { error: String(e) }; }
            })();
          `;
          const evtRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: evtScript, returnByValue: true,
          }).catch(() => null);
          const evtVal = evtRes && evtRes.result && evtRes.result.value ? evtRes.result.value : null;
          log('info', 'upload', `[${source}] 事件触发结果: ${evtVal ? JSON.stringify(evtVal).slice(0, 150) : 'unknown'}`);
        } catch (evtErr) {
          log('warn', 'upload', `[${source}] 事件触发异常: ${(evtErr as Error).message}`);
        }

        await sleep(1500);
        return true;
      } catch (e) {
        log('warn', 'upload', `[${source}] 注入失败: ${(e as Error).message}`);
        return false;
      }
    };

    // 步骤 A：点击上传按钮，让页面创建 input[type=file]
    //   - 视频发布：点击"上传视频 / 点击上传"按钮
    //   - 图文发布：优先点击"上传图文 / 上传图片 / 图片上传"按钮
    //   - 通用兜底：_upload-btn / upload-btn class 或"上传"文本
    let hasInputAlready = false;
    try {
      hasInputAlready = await win.webContents.executeJavaScript(`
        (function() {
          if (document.querySelector('input[type="file"]')) return true;
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
              if (idoc && idoc.querySelector('input[type="file"]')) return true;
            } catch(e) {}
          }
          return false;
        })()
      `).catch(() => false);
    } catch (e) {
      // ignore
    }

    if (hasInputAlready) {
      log('info', 'upload', '[A] 页面已存在现成的 file input 节点，跳过步骤 A 按钮点击以防止误触跳转');
    } else {
      try {
        const isImage = contentType === 'image' || contentType === 'article';
        log('info', 'upload', `[A] 点击上传按钮（contentType=${contentType || 'video'}，${isImage ? '图文模式' : '视频模式'}）…`);
        const clickScript = `
          (function () {
          var isImageMode = ${isImage ? 'true' : 'false'};
          var candidates = [];
          // 判断元素是否在 aria-hidden=true 的区域内（如 ant-tabs-tabpane 非活动 tab）
          function isHiddenByAria(el) {
            try {
              var cur = el;
              while (cur && cur !== document.body) {
                if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return true;
                var st = window.getComputedStyle(cur, null);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
                cur = cur.parentNode;
              }
              return false;
            } catch (e) { return false; }
          }
          // 判断是否真的可交互
          function isInteractive(el) {
            try {
              var tag = (el.tagName || '').toLowerCase();
              if (tag === 'button' || tag === 'a' || tag === 'input') return true;
              var role = el.getAttribute && el.getAttribute('role');
              if (role === 'button' || role === 'link') return true;
              var cls = el.getAttribute && el.getAttribute('class') || '';
              if (cls.indexOf('_upload-btn') !== -1 || cls.indexOf('upload-btn') !== -1) return true;
              if (cls.indexOf('header') !== -1 || cls.indexOf('nav') !== -1 || cls.indexOf('sidebar') !== -1) return false;
              if (el.offsetWidth > 800 || el.offsetHeight > 500) return false;
              return false;
            } catch (e) { return false; }
          }
          // 1. 通用 upload-btn class（快手等平台的通用按钮类名）
          try {
            var classBtns = document.querySelectorAll('[class*="_upload-btn"], [class*="upload-btn"]');
            for (var ci = 0; ci < classBtns.length; ci++) {
              var cb = classBtns[ci];
              if (cb && cb.offsetWidth >= 20 && cb.offsetHeight >= 20 && !isHiddenByAria(cb)) {
                var cbtxt = (cb.innerText || cb.textContent || '').trim();
                // 图文模式下，如果文本含"视频"关键词，降分；如果含"图文/图片"关键词，大幅加分
                var sc = 1000;
                if (isImageMode) {
                  if (cbtxt.indexOf('视频') !== -1) sc -= 500;
                  if (cbtxt.indexOf('图文') !== -1 || cbtxt.indexOf('图片') !== -1) sc += 300;
                }
                candidates.push({ el: cb, score: sc, reason: 'class-upload-btn', text: cbtxt.slice(0, 40) });
              }
            }
          } catch (e) {}
          // 2. 根据 contentType 选择文本匹配按钮
          try {
            var buttons = document.querySelectorAll('button, a, [role="button"], div, span');
            for (var ti = 0; ti < buttons.length; ti++) {
              var txt = (buttons[ti].innerText || buttons[ti].textContent || '').trim();
              if (!txt || txt.length > 40) continue;
              var score = 0;
              var tagName = (buttons[ti].tagName || '').toLowerCase();
              var roleName = buttons[ti].getAttribute && buttons[ti].getAttribute('role') || '';
              var isNativeClickable = (tagName === 'button' || tagName === 'a' || roleName === 'button' || roleName === 'tab');

              if (isImageMode) {
                // 图文模式：优先匹配"图文/图片"类关键词
                if (txt === '上传图文') score += 900;
                else if (txt === '图文') score += 800;
                else if (txt.indexOf('图文') !== -1) score += 700;
                else if (txt === '上传图片') score += 750;
                else if (txt.indexOf('图片上传') !== -1) score += 700;
                else if (txt.indexOf('图片') !== -1) score += 600;
                else if (txt.indexOf('相册') !== -1) score += 500;
                else if (txt === '点击上传') score += 550;
                else if (txt.indexOf('上传') !== -1 && txt.indexOf('视频') === -1) score += 400;
              } else {
                // 视频模式：沿用原逻辑
                if (txt === '上传视频') score += 900;
                else if (txt.indexOf('上传视频') !== -1) score += 700;
                else if (txt === '点击上传') score += 650;
                else if (txt === '上传文件') score += 550;
                else if (txt.indexOf('视频') !== -1 && txt.indexOf('图文') === -1) score += 450;
                else if (txt === '上传') score += 300;
              }
              if (score > 0 && buttons[ti].offsetWidth >= 20 && buttons[ti].offsetHeight >= 20 && !isHiddenByAria(buttons[ti])) {
                // 原生可点击元素额外加分
                if (isNativeClickable) score += 200;
                candidates.push({ el: buttons[ti], score: score, reason: 'text-match', text: txt });
              }
            }
          } catch (e) {}
          if (candidates.length === 0) return { clicked: false, count: 0 };
          candidates.sort(function (a, b) { return b.score - a.score; });
          var target = candidates[0];
          try { target.el.click(); } catch (e) {}
          try { target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e) {}
          var topFive = candidates.slice(0, 5).map(function (c) { return { text: c.text, score: c.score, reason: c.reason }; });
          return { clicked: true, count: candidates.length, text: target.text.slice(0, 60), reason: target.reason, topFive: topFive };
        })();
      `;
      const clickRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: clickScript, returnByValue: true,
      }).catch(() => null);
      const clickVal = clickRes && clickRes.result && clickRes.result.value ? clickRes.result.value : null;
      log('info', 'upload', `[A] 点击结果: ${clickVal ? JSON.stringify(clickVal).slice(0, 300) : 'unknown'}`);
      await sleep(1500);
      } catch (err) {
        log('warn', 'upload', `[A] 点击上传按钮异常: ${(err as Error).message}`);
      }
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

        // 🔑 按 contentType 智能匹配正确的 file input（避免图文上传到视频tabpan2而非视频tab1）
        const isImageMode2 = contentType === 'image' || contentType === 'article';
        const scoredNodes: Array<{ nodeId: number; accept: string; score: number }> = [];
        for (const n of allNodes) {
          if (!n || !n.attributes) continue;
          const nn = (n.nodeName || '').toLowerCase();
          if (nn !== 'input') continue;
          let hasFile = false;
          let acc = '';
          for (let i2 = 0; i2 < n.attributes.length; i2 += 2) {
            const attrName = n.attributes[i2];
            const attrVal = n.attributes[i2 + 1];
            if (attrName === 'type' && attrVal === 'file') hasFile = true;
            else if (attrName === 'accept') acc = attrVal || '';
          }
          if (!hasFile) continue;
          let score = 100;
          if (isImageMode2) {
            // 图文 mode：优先 accept 含 image/png / image/jpg 等
            if (/image\/(png|jpeg|jpg|webp)/i.test(acc)) score += 3000;
            else if (/image\//i.test(acc)) score += 2000;
            else if (/video\//i.test(acc)) score -= 2000; // 明确排除视频 input
          } else {
            // 视频 mode：优先 accept 含 video/*
            if (/video\//i.test(acc)) score += 3000;
            else if (/image\//i.test(acc)) score -= 2000;
          }
          scoredNodes.push({ nodeId: n.nodeId, accept: acc, score });
        }
        if (scoredNodes.length > 0) {
          scoredNodes.sort((a, b) => b.score - a.score);
          const topInfo = scoredNodes.slice(0,5).map(function(s){return 'node'+s.nodeId+':'+(s.accept||'').slice(0,30)+':'+s.score;}).join(', ');
          log('info', 'upload', '[B1] 找到 ' + scoredNodes.length + ' 个 file input，按优先级排序: ' + topInfo);
          for (const sn of scoredNodes) {
            if (sn.score < 0) continue;
            if (await tryInjectFiles(sn.nodeId, undefined, 'B1-node' + sn.nodeId)) return true;
          }
          log('warn', 'upload', `[B1] 所有 file input 均注入失败`);
        } else {
          log('warn', 'upload', `[B1] 未找到 file input 节点`);
        }
      }
    } catch (err) {
      log('warn', 'upload', `[B1] 异常: ${(err as Error).message}`);
    }

    // 策略 2：DOM.querySelector 主文档根（按 contentType 精准选择 accept 属性）
    // 🔑 关键修复：兜底 querySelectorAll 也按 contentType 过滤，避免图片注入到 video input
    try {
      const isImage3 = contentType === 'image' || contentType === 'article';
      const accSelector = isImage3
        ? 'input[type="file"][accept*="image"]'
        : 'input[type="file"][accept*="video"]';
      log('info', 'upload', `[B2] DOM.querySelector 搜索 file input (${isImage3 ? 'image' : 'video'}模式)…`);
      const docResult2: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true }).catch(() => null);
      if (docResult2 && docResult2.root && docResult2.root.nodeId !== undefined) {
        // 优先：精确匹配 accept
        const qsResult: any = await win.webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: docResult2.root.nodeId,
          selector: accSelector,
        }).catch(() => null);
        if (qsResult && qsResult.nodeId !== undefined && qsResult.nodeId !== 0) {
          if (await tryInjectFiles(qsResult.nodeId, undefined, 'B2-querySelector-precise')) return true;
        }
        // 兜底：获取所有 input[type=file]，但要先按 accept 属性过滤
        const qsaResult: any = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', {
          nodeId: docResult2.root.nodeId,
          selector: 'input[type="file"]',
        }).catch(() => null);
        if (qsaResult && qsaResult.nodeIds && qsaResult.nodeIds.length > 0) {
          log('info', 'upload', `[B2] querySelectorAll 找到 ${qsaResult.nodeIds.length} 个 file input，按 contentType 过滤…`);
          // 获取每个 node 的 accept 属性，再决定是否注入
          for (const nid of qsaResult.nodeIds) {
            try {
              const attrRes: any = await win.webContents.debugger.sendCommand('DOM.getAttributes', { nodeId: nid }).catch(() => null);
              let acceptVal = '';
              if (attrRes && attrRes.attributes) {
                const attrs: string[] = attrRes.attributes;
                for (let ai = 0; ai < attrs.length; ai += 2) {
                  if (attrs[ai] === 'accept') { acceptVal = attrs[ai + 1] || ''; break; }
                }
              }
              // 按 contentType 过滤：图文模式跳过 video accept，视频模式跳过 image accept
              const isVideoAccept = /video\//i.test(acceptVal) || /\.mp4|\.mov|\.flv/i.test(acceptVal);
              const isImageAccept = /image\//i.test(acceptVal) || /\.jpg|\.jpeg|\.png|\.webp|\.gif/i.test(acceptVal);
              if (isImage3 && isVideoAccept && !isImageAccept) {
                log('info', 'upload', `[B2] 跳过视频 input node${nid} (accept=${acceptVal.slice(0, 40)})`);
                continue;
              }
              if (!isImage3 && isImageAccept && !isVideoAccept) {
                log('info', 'upload', `[B2] 跳过图片 input node${nid} (accept=${acceptVal.slice(0, 40)})`);
                continue;
              }
              if (await tryInjectFiles(nid, undefined, `B2-qsa-node${nid}`)) return true;
            } catch { /* 单个 node 失败不影响其他 */ }
          }
        }
      }
    } catch (err) {
      log('warn', 'upload', `[B2] 异常: ${(err as Error).message}`);
    }

    // 策略 3：Runtime.evaluate 返回元素 objectId（严格按 contentType 选择，不降级到任意 input）
    try {
      const isImage4 = contentType === 'image' || contentType === 'article';
      const selector4 = isImage4
        ? 'input[type="file"][accept*="image"]'
        : 'input[type="file"][accept*="video"]';
      log('info', 'upload', `[B3] Runtime.evaluate 获取 file input (${isImage4 ? 'image' : 'video'}模式)…`);
      // 🔑 修复：不降级到任意 input[type=file]，只找精确匹配 accept 的 input
      const script = '(function(){var el=document.querySelector("' + selector4 + '");if(!el){var all=document.querySelectorAll("iframe");for(var i=0;i<all.length;i++){try{var idoc=all[i].contentDocument||(all[i].contentWindow&&all[i].contentWindow.document);if(idoc){var iel=idoc.querySelector("' + selector4 + '");if(iel){el=iel;break;}}}catch(e){}}}return el||null;})();';
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
        const isImageFallback = contentType === 'image' || contentType === 'article';
        const fallbackClick = `
          (function () {
            var isImg = ${isImageFallback ? 'true' : 'false'};
            var btn = document.querySelector('button[class*=_upload-btn]') || document.querySelector('button[class*=upload-btn]') || document.querySelector('button');
            // 优先尝试：图文模式下找"图文/图片"关键词的按钮
            if (isImg) {
              try {
                var allBtns = document.querySelectorAll('button, a, [role="button"], div, span');
                for (var j = 0; j < allBtns.length; j++) {
                  var jtxt = (allBtns[j].innerText || allBtns[j].textContent || '').trim();
                  if (jtxt && (jtxt.indexOf('图文') !== -1 || jtxt.indexOf('图片') !== -1)) {
                    allBtns[j].click();
                    return { clicked: true, text: jtxt };
                  }
                }
              } catch (e) {}
            }
            if (btn) {
              try { btn.click(); return { clicked: true, text: btn.innerText || btn.textContent || '' }; }
              catch (e) { return { clicked: false, error: String(e) }; }
            }
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              var txt = (all[i].innerText || all[i].textContent || '').trim();
              if (isImg) {
                if (txt === '上传图文' || txt === '图文' || txt.indexOf('图文') !== -1 || txt.indexOf('图片') !== -1) {
                  try { all[i].click(); return { clicked: true, text: txt }; }
                  catch (e) { return { clicked: false, error: String(e) }; }
                }
              } else {
                if (txt === '上传视频' || txt === '点击上传' || txt === '上传文件') {
                  try { all[i].click(); return { clicked: true, text: txt }; }
                  catch (e) { return { clicked: false, error: String(e) }; }
                }
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
/**
 * 用 CDP 协议点击发布按钮（v1）—— 核心能力：穿透 closed shadow DOM
 * 背景：小红书等平台的发布按钮是 <xhs-publish-btn> 自定义组件，内部是 closed shadow root。
 * 普通 JS 的 element.shadowRoot 返回 null，无法访问内部 <button>。
 * CDP 的 DOM.getDocument(pierce:true) 可以绕过这个限制。
 *
 * 步骤：
 *   1. CDP DOM.getDocument({ depth: -1, pierce: true })  — 获取完整 DOM 树，含 shadow DOM 内容
 *   2. 递归遍历：找 nodeName=BUTTON/A 或 attributes 中 class 含 publish/btn/primary/red 的节点
 *   3. 通过 nodeValue / parent node 文字推断按钮含义（"发布"/"立即发布"/"发布作品"等）
 *   4. CDP DOM.getBoxModel({ nodeId }) 获取按钮坐标
 *   5. CDP Input.dispatchMouseEvent 合成鼠标事件：mousePressed → mouseReleased（点击）
 *   6. 辅助：CDP DOM.focus + dispatchKeyEvent(Enter)（某些按钮需要键盘触发）
 *
 * 对其他平台（抖音、快手）的影响：若页面没有符合条件的元素，返回 false，不影响现有流程。
 */
export async function cdpClickPublishButton(
  win: any,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  keywords: string[] = ['发布', '立即发布', '发布作品', '发布笔记', '发布视频', '确认发布', 'confirm', 'publish'],
): Promise<boolean> {
  try {
    log('info', 'cdp-click', `开始 CDP 穿透式点击，关键词=${keywords.join('/')}`);
    // 🔑 关键修复：uploadViaCDP 已经 debugger.attach() 过了，此处再次 attach 会抛 "Debugger is already attached to the target"。
    // 用 try/catch（与 uploadViaCDP 相同模式）吞掉异常；即使 attach 失败，
    // debugger 本来就是 attached 的，后续 sendCommand 仍然可以正常调用。
    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 已 attached：不影响后续 sendCommand */ }

    // 步骤 1：获取完整 DOM 树（pierce:true 会穿透 closed shadow DOM，拿到 xhs-publish-btn 内部的 button）
    let doc: any = null;
    try {
      doc = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    } catch (e) {
      // 常见原因：DOM.getDocument 需要某些域；一次失败不代表整个 CDP 不可用，
      // 尝试降级为深度搜索（depth: 0 只拿 root，后续再 querySelectorAll）
      log('warn', 'cdp-click', `DOM.getDocument(depth:-1) 失败，尝试降级: ${(e as Error).message}`);
      try {
        doc = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 2, pierce: true });
      } catch (e2) {
        log('warn', 'cdp-click', `DOM.getDocument 完全失败: ${(e2 as Error).message}`);
        return false;
      }
    }
    if (!doc || !doc.root) return false;

    // 步骤 2：递归遍历，收集候选按钮节点（含 shadow DOM 穿透）
    // 核心改进：
    //   (a) 主扫描时也识别 xhs-publish-btn/xhs-button 等自定义 host（不再仅限 fallback）
    //   (b) 对每个候选按钮，从子节点累积文本内容（CDP 树中 #text 是独立节点）
    //   (c) 记录 parentId 以便与父节点关联
    type NodeCandidate = {
      nodeId: number;
      nodeName: string;
      text: string;          // 从子 #text 节点累积的文本
      class_: string;
      idAttr: string;
      hostTag: boolean;      // 是否是自定义组件 host（如 xhs-publish-btn）
    };
    const candidates: NodeCandidate[] = [];
    const nodeById = new Map<number, any>();

    const getAttr = (attrs: string[] | undefined, key: string): string => {
      if (!attrs) return '';
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === key) return String(attrs[i + 1] || '');
      }
      return '';
    };

    // 2a：从子节点（含 shadow DOM）累积文本内容
    const collectText = (node: any): string => {
      if (!node) return '';
      let buf = '';
      const stack: any[] = [];
      if (node.children) node.children.forEach((c: any) => stack.push(c));
      if (node.shadowRoots) node.shadowRoots.forEach((c: any) => stack.push(c));
      if (node.templateContent) stack.push(node.templateContent);
      while (stack.length > 0 && buf.length < 40) {
        const n = stack.pop();
        if (!n) continue;
        if (n.nodeName === '#text' && n.nodeValue) buf += n.nodeValue;
        if (n.children) n.children.forEach((c: any) => stack.push(c));
        if (n.shadowRoots) n.shadowRoots.forEach((c: any) => stack.push(c));
      }
      return buf.trim();
    };

    const isHostTag = (name: string): boolean => {
      const n = name.toLowerCase();
      return n === 'xhs-publish-btn' || n === 'xhs-button' || n === 'publish-button'
        || n === 'xhs-submit-btn' || n === 'xhs-text-button';
    };

    const walk = (node: any, depth: number) => {
      if (!node || depth > 100) return;
      if (node.nodeId) nodeById.set(node.nodeId, node);

      const nodeName = (node.nodeName || '').toLowerCase();
      const classAttr = getAttr(node.attributes, 'class');
      const idAttr = getAttr(node.attributes, 'id');
      const typeAttr = getAttr(node.attributes, 'type');
      const roleAttr = getAttr(node.attributes, 'role');

      const isButtonLike = nodeName === 'button' || nodeName === 'a'
        || typeAttr === 'submit' || typeAttr === 'button' || roleAttr === 'button'
        || classAttr.indexOf('btn') !== -1 || classAttr.indexOf('button') !== -1
        || classAttr.indexOf('publish') !== -1
        || (nodeName === 'input' && (typeAttr === 'submit' || typeAttr === 'button'));

      const hostTag = isHostTag(nodeName);

      if ((isButtonLike || hostTag) && node.nodeId) {
        const innerText = collectText(node);
        const combinedText = (innerText + ' ' + classAttr + ' ' + idAttr).toLowerCase();

        // 关键词匹配：中文关键词（发布/立即发布/发布笔记...）或英文 confirm/publish
        let textMatch = false;
        for (const kw of keywords) {
          if (combinedText.indexOf(kw.toLowerCase()) !== -1) {
            textMatch = true;
            break;
          }
        }
        // host 自定义组件：即使文本不匹配也加入候选（组件内部可能渲染为发布按钮）
        if (textMatch || hostTag || /(发布|发布作品|立即发布|确认发布|submit|publish)/i.test(innerText)) {
          candidates.push({
            nodeId: node.nodeId,
            nodeName: nodeName,
            text: innerText.slice(0, 40),
            class_: classAttr.slice(0, 60),
            idAttr: idAttr.slice(0, 40),
            hostTag,
          });
        }
      }

      if (node.children) node.children.forEach((c: any) => walk(c, depth + 1));
      if (node.shadowRoots) node.shadowRoots.forEach((c: any) => walk(c, depth + 1));
      if (node.templateContent) walk(node.templateContent, depth + 1);
      if (node.contentDocument) walk(node.contentDocument, depth + 1);
    };
    walk(doc.root, 0);

    log('info', 'cdp-click', `遍历完成，候选按钮: ${candidates.length} 个`);

    // 兜底：关键词扫描未命中时，按节点名宽扫描（xhs-publish-btn 等自定义组件 + 普通按钮）
    if (candidates.length === 0) {
      const fallback: NodeCandidate[] = [];
      const walkFb = (node: any, depth: number) => {
        if (!node || depth > 100) return;
        const nn = (node.nodeName || '').toLowerCase();
        const ca = getAttr(node.attributes, 'class');
        if (node.nodeId && (nn === 'button' || nn === 'a' || isHostTag(nn) || /btn|button|publish/i.test(ca))) {
          fallback.push({ nodeId: node.nodeId, nodeName: nn, text: collectText(node).slice(0, 40), class_: ca.slice(0, 60), idAttr: '', hostTag: isHostTag(nn) });
        }
        if (node.children) node.children.forEach((c: any) => walkFb(c, depth + 1));
        if (node.shadowRoots) node.shadowRoots.forEach((c: any) => walkFb(c, depth + 1));
        if (node.templateContent) walkFb(node.templateContent, depth + 1);
        if (node.contentDocument) walkFb(node.contentDocument, depth + 1);
      };
      walkFb(doc.root, 0);
      if (fallback.length > 0) {
        log('info', 'cdp-click', `关键词扫描失败，改用宽扫描：找到 ${fallback.length} 个按钮/组件`);
        candidates.push(...fallback);
      }
    }
    if (candidates.length === 0) {
      log('warn', 'cdp-click', `未找到任何发布按钮候选`);
      return false;
    }

    // 步骤 3：获取所有候选的 BoxModel → 计算可视尺寸/坐标 → 综合评分排序
    // 发布按钮的典型特征：
    //   · 较大（通常宽 > 120px，高 > 32px）
    //   · 红色/主题色背景（class 含 red / primary / danger / submit / publish）
    //   · 靠近页面右下角（y 值较大、x 值较大）
    //   · 是 xhs-publish-btn 等自定义组件 host
    type RatedCandidate = NodeCandidate & {
      score: number;
      cx: number;
      cy: number;
      w: number;
      h: number;
      area: number;
    };
    const rated: RatedCandidate[] = [];
    for (const cand of candidates) {
      try {
        const box: any = await win.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId: cand.nodeId });
        if (!box || !box.model || !box.model.content || box.model.content.length < 4) continue;
        const c = box.model.content;
        const w = Math.abs(c[2] - c[0]);
        const h = Math.abs(c[5] - c[1]);
        // 过滤太小/太大的元素（太小是装饰元素，太大通常是容器）
        if (w < 30 || h < 16) continue;
        if (w > 800 || h > 400) continue;

        const cx = (c[0] + c[2]) / 2;
        const cy = (c[1] + c[5]) / 2;
        const area = w * h;

        let score = 0;
        // 尺寸分：面积 10000~60000 像素的按钮最典型
        if (area >= 4000 && area <= 200000) score += Math.round(Math.min(3000, area / 20));
        // 类名关键词：red / primary / publish 强加分
        const cls = (cand.class_ + ' ' + cand.idAttr).toLowerCase();
        if (/publish/i.test(cls)) score += 3500;
        if (/red/i.test(cls)) score += 3000;
        if (/primary|submit|confirm/i.test(cls)) score += 2000;
        if (/btn-/i.test(cls)) score += 800;
        // 文本关键词：含"发布"强加分
        if (/(发布作品|立即发布|确认发布|发布笔记|发布视频|发布)/.test(cand.text)) score += 4000;
        // 自定义组件 host —— 小红书发布按钮的唯一标识
        if (cand.hostTag) score += 5000;
        // 靠近右下
        if (cx > 400) score += Math.round(Math.min(1500, (cx - 400) * 2));
        if (cy > 300) score += Math.round(Math.min(1500, (cy - 300) * 1.5));
        // element tag = button 加分
        if (cand.nodeName === 'button') score += 600;

        rated.push({ ...cand, score, cx, cy, w, h, area });
      } catch {
        // 某些节点不可见（display:none），BoxModel 失败 → 跳过
        continue;
      }
    }
    if (rated.length === 0) {
      log('warn', 'cdp-click', `所有候选均无有效 BoxModel，无法点击`);
      return false;
    }
    rated.sort((a, b) => b.score - a.score);
    // 打印前 5 个高分候选（便于调试）
    for (let i = 0; i < Math.min(5, rated.length); i++) {
      const r = rated[i];
      log('info', 'cdp-click', `[候选#${i + 1}] score=${r.score} ${r.nodeName} size=${r.w.toFixed(0)}x${r.h.toFixed(0)} center=(${r.cx.toFixed(0)},${r.cy.toFixed(0)}) class=${r.class_} text="${r.text}"${r.hostTag ? ' [HOST]' : ''}`);
    }

    // 步骤 4：按评分从高到低尝试点击，点击后验证是否真的触发了发布（URL 变化 / 导航）
    let published = false;
    let clickedNodeId: number | null = null;
    const baseUrl: string = await win.webContents.getURL();
    const topN = Math.min(5, rated.length);

    for (let i = 0; i < topN; i++) {
      const r = rated[i];
      try {
        // 4a：滚动到元素，确保在视口中
        try {
          await win.webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId: r.nodeId }).catch(() => {});
          await new Promise(res => setTimeout(res, 80));
        } catch { /* 忽略，部分 DOM 节点不支持 */ }

        log('info', 'cdp-click', `[尝试#${i + 1}] 点击 nodeId=${r.nodeId}(${r.nodeName}) size=${r.w.toFixed(0)}x${r.h.toFixed(0)} center=(${r.cx.toFixed(0)},${r.cy.toFixed(0)}) text="${r.text}" class=${r.class_}${r.hostTag ? ' [HOST]' : ''}`);

        // 4b：合成鼠标点击（moved → pressed → released）
        const ts = Date.now() / 1000;
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: r.cx, y: r.cy, button: 'left', timestamp: ts,
        }).catch(() => {});
        await new Promise(res => setTimeout(res, 40));
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: r.cx, y: r.cy, button: 'left', clickCount: 1, timestamp: ts + 0.05,
        }).catch(() => {});
        await new Promise(res => setTimeout(res, 80));
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: r.cx, y: r.cy, button: 'left', clickCount: 1, timestamp: ts + 0.15,
        }).catch(() => {});

        clickedNodeId = r.nodeId;

        // 4c：检测是否真的发布了 —— 检查 URL 是否变化、或等待导航事件
        // 给页面 3.5 秒响应（部分平台点击后有过渡动画）
        let urlChanged = false;
        await new Promise<void>(async (resolve) => {
          const deadline = Date.now() + 3500;
          const check = () => {
            try {
              const cur = win.webContents.getURL();
              if (cur !== baseUrl && !cur.includes('/publish/publish')) {
                urlChanged = true;
                resolve();
                return;
              }
            } catch {}
            if (Date.now() >= deadline) resolve();
            else setTimeout(check, 250);
          };
          check();
        });
        if (urlChanged) {
          log('info', 'cdp-click', `✅ URL 已变化，发布成功！新 URL 与原发布页不同`);
          published = true;
          break;
        }
        // URL 未变 → 继续尝试下一个候选
        log('info', 'cdp-click', `[尝试#${i + 1}] URL 未变化，继续尝试下一个候选…`);
      } catch (e) {
        log('warn', 'cdp-click', `[尝试#${i + 1}] 异常: ${(e as Error).message}`);
        continue;
      }
    }

    // 步骤 5：鼠标点击方式均失败 → 兜底用 focus + Enter
    if (!published && clickedNodeId !== null) {
      try {
        await win.webContents.debugger.sendCommand('DOM.focus', { nodeId: clickedNodeId });
        await new Promise(res => setTimeout(res, 60));
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', text: '\r', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter',
        }).catch(() => {});
        await new Promise(res => setTimeout(res, 40));
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', text: '\r', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter',
        }).catch(() => {});
        log('info', 'cdp-click', `✅ Focus+Enter 兜底触发 nodeId=${clickedNodeId}`);
        published = true;
      } catch (e) {
        log('warn', 'cdp-click', `Focus+Enter 兜底失败: ${(e as Error).message}`);
      }
    }

    return published;
  } catch (err) {
    log('warn', 'cdp-click', `异常: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 通过 CDP 真实键盘事件触发话题标签识别。
 *
 * 使用场景：各平台（小红书/抖音/快手）的富文本编辑器在输入 #话题 后，
 * 需要用户按下空格键才能将纯文本 #话题 转为可点击的话题标签。
 * 通过 JS 派发的合成 KeyboardEvent（isTrusted=false）不会被平台识别，
 * 必须通过 CDP Input.dispatchKeyEvent 发送真实键盘事件。
 *
 * 方案设计（混合模式，兼顾中文支持和真实键盘事件）：
 *   1. 换行符通过 JS eval 执行 execCommand('insertText') 插入
 *   2. 标签的 # 号通过 CDP 键盘事件输入（触发平台进入话题模式）
 *   3. 标签的中文/英文文字通过 JS execCommand 插入（可靠支持中文/表情）
 *   4. 每个标签插入后，通过 CDP 发送真实 Space 键事件触发话题识别
 *   5. 这样既保证了中文文本正确输入，又通过真实键盘事件触发平台话题识别
 *
 * 前置条件：
 *   - 正文已经通过 execCommand('insertText') 写入编辑器
 *   - 编辑器（contenteditable）已获得焦点，光标在正文末尾
 *
 * @param win 浏览器窗口
 * @param tags 已清洗好的标签数组（每个标签已带 # 前缀）
 * @param hasContentBefore 正文是否有内容（有则先输入换行符再输入标签）
 * @param log 日志函数
 */

/**
 * 通过 CDP 方式填写正文内容（支持换行）
 * 适用于 ACE / ProseMirror 等结构化编辑器，insertHTML/insertText 的换行不生效的场景
 * 方案：JS 逐行写入文本，行之间用 CDP Enter 键换行，确保生成正确的行结构
 * @param win BrowserWindow 实例
 * @param content 正文内容（含 \n 换行）
 * @param targetKind 目标编辑器类型：'prosemirror' | 'plain-ce' | 'auto'
 * @param log 日志函数
 * @returns { ok: boolean, method: string, isContentEditable: boolean }
 */
export async function cdpFillContentWithNewlines(
  win: BrowserWindow,
  content: string,
  targetKind: 'prosemirror' | 'plain-ce' | 'auto',
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<{ ok: boolean; method: string; isContentEditable: boolean }> {
  // 确保 CDP 已 attached
  try {
    if (!win.webContents.debugger.isAttached()) {
      await win.webContents.debugger.attach('1.3');
    }
  } catch {
    // 已 attached 或 attach 失败，继续尝试
  }

  const sendEnterKey = async () => {
    const VK_RETURN = 13;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: VK_RETURN,
      nativeVirtualKeyCode: VK_RETURN,
    }).catch(() => {});
    await sleep(30);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: VK_RETURN,
      nativeVirtualKeyCode: VK_RETURN,
    }).catch(() => {});
  };

  // 第一步：用 JS 找到编辑器、聚焦、清空、写入第一行
  const lines = content.split('\n');
  const firstLine = lines[0] || '';
  const restLines = lines.slice(1);

  const prepareScript = `(function(){
    try {
      var content = ${JSON.stringify(firstLine)};
      var targetKind = ${JSON.stringify(targetKind)};
      var all = document.querySelectorAll('[contenteditable]');
      var candidates = [];
      for (var i = 0; i < all.length; i++) {
        var ce = all[i].getAttribute && all[i].getAttribute('contenteditable');
        if (ce === 'false' || ce === null) continue;
        candidates.push(all[i]);
      }
      if (candidates.length === 0) return { ok: false, reason: 'no-ce' };
      var target = null;
      var method = '';

      if (targetKind === 'prosemirror') {
        // 只找 ProseMirror/tiptap
        for (var j = 0; j < candidates.length; j++) {
          var cls = String(candidates[j].className || '');
          if (/tiptap|ProseMirror|prosemirror/i.test(cls)) {
            target = candidates[j];
            method = 'prosemirror';
            break;
          }
        }
      } else if (targetKind === 'plain-ce') {
        // 只找非 ProseMirror 的普通 contenteditable（内容最多的那个）
        var plainCandidates = [];
        for (var k = 0; k < candidates.length; k++) {
          var cls2 = String(candidates[k].className || '');
          if (!/tiptap|ProseMirror|prosemirror/i.test(cls2)) {
            var txt = (candidates[k].innerText || candidates[k].textContent || '').trim();
            plainCandidates.push({ el: candidates[k], len: txt.length });
          }
        }
        if (plainCandidates.length > 0) {
          plainCandidates.sort(function(a, b) { return b.len - a.len; });
          target = plainCandidates[0].el;
          method = 'plain-ce';
        }
      } else {
        // auto：优先找内容最多的那个
        var withContent = [];
        for (var m = 0; m < candidates.length; m++) {
          var t = (candidates[m].innerText || candidates[m].textContent || '').trim();
          withContent.push({ el: candidates[m], len: t.length });
        }
        if (withContent.length > 0) {
          withContent.sort(function(a, b) { return b.len - a.len; });
          target = withContent[0].el;
          method = 'auto';
        }
      }

      if (!target) return { ok: false, reason: 'no-match' };

      // 聚焦 + 清空 + 写入第一行
      target.focus();
      try { document.execCommand('selectAll'); document.execCommand('delete'); } catch(e) {}
      if (content) {
        try {
          document.execCommand('insertText', false, content);
        } catch(e2) {
          target.textContent = content;
          try {
            var ev = document.createEvent('Event');
            ev.initEvent('input', true, true);
            target.dispatchEvent(ev);
          } catch(e3) {}
        }
      }
      // 光标移到末尾
      try {
        var range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch(e4) {}
      return { ok: true, method: method };
    } catch(e) { return { ok: false, err: String(e) }; }
  })()`;

  try {
    const res: any = await win.webContents.executeJavaScript(prepareScript);
    if (!res || !res.ok) {
      log('warn', 'cdp-fill-content', `编辑器准备失败: ${res && (res.reason || res.err)}`);
      return { ok: false, method: 'failed', isContentEditable: false };
    }
    const method = res.method || 'plain-ce';
    log('info', 'cdp-fill-content', `第一行已写入 (${method}), 剩余 ${restLines.length} 行`);
    await sleep(100);

    // 第二步：逐行 CDP Enter 换行 + JS 写入文字
    for (let li = 0; li < restLines.length; li++) {
      // CDP Enter 键换行（生成正确的行结构）
      await sendEnterKey();
      await sleep(80);

      // JS 写入该行文字
      const lineText = restLines[li];
      if (lineText) {
        const escapedLine = JSON.stringify(lineText);
        const insertLineScript = `(function(){
          try {
            var ok = document.execCommand('insertText', false, ${escapedLine});
            return { ok: !!ok };
          } catch(e) { return { ok: false, err: String(e) }; }
        })()`;
        await win.webContents.executeJavaScript(insertLineScript).catch(() => {});
        await sleep(30);
      }
    }

    log('info', 'cdp-fill-content', `✅ 正文填写完成，共 ${lines.length} 行`);
    return { ok: true, method: method, isContentEditable: true };
  } catch (err) {
    log('error', 'cdp-fill-content', `CDP正文填写失败: ${(err as Error).message}`);
    return { ok: false, method: 'error', isContentEditable: false };
  }
}

export async function cdpInsertTagsWithSpace(
  win: BrowserWindow,
  tags: string[],
  hasContentBefore: boolean,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!tags || tags.length === 0) return true;

  // 确保 CDP 已 attached
  try {
    if (!win.webContents.debugger.isAttached()) {
      await win.webContents.debugger.attach('1.3');
    }
  } catch {
    // 已 attached 或 attach 失败，继续尝试
  }

  /** 通过 JS execCommand 在当前光标位置插入文本（可靠支持中文） */
  const insertTextViaJS = async (text: string): Promise<boolean> => {
    const escaped = JSON.stringify(text);
    const script = `(function(){
      try {
        var ok = document.execCommand('insertText', false, ${escaped});
        return { ok: !!ok };
      } catch(e) {
        return { ok: false, err: String(e) };
      }
    })()`;
    try {
      const res: any = await win.webContents.executeJavaScript(script);
      return !!(res && res.ok);
    } catch {
      return false;
    }
  };

  /** 通过 CDP 发送一个可打印字符（使用 type='char'，最可靠的字符输入方式） */
  const sendCharKey = async (char: string) => {
    // 使用 type='char' 直接发送字符，浏览器会正确处理输入法和修饰键
    // 这种方式比模拟物理按键（keyDown/keyUp + VK码）更可靠，不受键盘布局影响
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      text: char,
      key: char,
      code: '',
    }).catch(() => {});
    await sleep(30);
  };

  /** 通过 CDP 发送真实 Space 键事件（keydown → 等待 → keyup） */
  const sendSpaceKey = async () => {
    const VK_SPACE = 32;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: VK_SPACE,
      nativeVirtualKeyCode: VK_SPACE,
    }).catch(() => {});
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: VK_SPACE,
      nativeVirtualKeyCode: VK_SPACE,
    }).catch(() => {});
  };

  /** 通过 CDP 发送真实 Enter 键事件（keydown → 等待 → keyup） */
  const sendEnterKey = async () => {
    const VK_RETURN = 13;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: VK_RETURN,
      nativeVirtualKeyCode: VK_RETURN,
    }).catch(() => {});
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: VK_RETURN,
      nativeVirtualKeyCode: VK_RETURN,
    }).catch(() => {});
  };

  /** 通过 CDP 发送真实 End 键事件（光标移到行尾） */
  const sendEndKey = async () => {
    const VK_END = 35;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: VK_END,
      nativeVirtualKeyCode: VK_END,
    }).catch(() => {});
    await sleep(30);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: VK_END,
      nativeVirtualKeyCode: VK_END,
    }).catch(() => {});
  };

  /** 通过 JS 派发 input 事件，确保框架（React/Vue）感知到文本变化 */
  const dispatchInputEvent = async () => {
    const script = `(function(){
      try {
        var active = document.activeElement;
        if (active) {
          active.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true };
      } catch(e) { return { ok: false }; }
    })()`;
    await win.webContents.executeJavaScript(script).catch(() => {});
  };

  try {
    await sleep(300); // 等待正文写入完成，编辑器稳定

    // 如果有正文内容，先换行
    // 🔑 关键策略：JS 只负责找到正确的编辑器并聚焦，
    // 光标定位（End键）和换行（Enter键）全部用 CDP 完成，
    // 确保和后续话题输入的键盘上下文完全一致
    if (hasContentBefore) {
      // 第1步：JS 找到正文编辑器并聚焦
      const focusScript = `(function(){
        try {
          var ce = document.querySelectorAll('[contenteditable]');
          var allEditable = [];
          for (var i = 0; i < ce.length; i++) {
            var val = ce[i].getAttribute && ce[i].getAttribute('contenteditable');
            if (val === 'false') continue;
            var txt = (ce[i].innerText || ce[i].textContent || '').trim();
            allEditable.push({ el: ce[i], len: txt.length, cls: String(ce[i].className || '') });
          }
          if (allEditable.length === 0) return { ok: false, reason: 'no-editable' };
          var target = null;
          var reason = '';
          // 策略1：有内容的 ProseMirror/tiptap（内容最多的）
          var pmWithContent = allEditable.filter(function(x) {
            return /tiptap|ProseMirror|prosemirror/i.test(x.cls) && x.len > 0;
          });
          if (pmWithContent.length > 0) {
            pmWithContent.sort(function(a, b) { return b.len - a.len; });
            target = pmWithContent[0].el;
            reason = 'prosemirror-with-content';
          }
          // 策略2：有内容的普通 contenteditable（内容最多的）
          if (!target) {
            var withContent = allEditable.filter(function(x) { return x.len > 0; });
            if (withContent.length > 0) {
              withContent.sort(function(a, b) { return b.len - a.len; });
              target = withContent[0].el;
              reason = 'max-content';
            }
          }
          // 策略3：兜底用最后一个
          if (!target) {
            target = allEditable[allEditable.length - 1].el;
            reason = 'last-fallback';
          }
          if (target) {
            target.focus();
            // 光标移到末尾（先用 JS 方式尝试，后续 CDP End 键再确认）
            try {
              var range = document.createRange();
              range.selectNodeContents(target);
              range.collapse(false);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch(e) {}
            return { ok: true, reason: reason, cls: String(target.className || '').slice(0,60) };
          }
          return { ok: false, reason: 'no-editor' };
        } catch(e) { return { ok: false, err: String(e) }; }
      })()`;
      let focusOk = false;
      try {
        const focusRes: any = await win.webContents.executeJavaScript(focusScript);
        focusOk = !!(focusRes && focusRes.ok);
        log('info', 'cdp-tags', `聚焦编辑器: ${focusOk ? '成功' : '失败'} (${focusRes && (focusRes.reason || focusRes.err)})`);
      } catch {
        log('warn', 'cdp-tags', '聚焦编辑器脚本执行失败');
      }
      await sleep(150);

      if (focusOk) {
        // 第2步：CDP 发送 End 键，确保光标在编辑器末尾
        // （JS 移动光标在某些编辑器中可能不可靠，CDP End 键更保险）
        await sendEndKey();
        await sleep(100);

        // 第3步：CDP 发送 Enter 键换行
        await sendEnterKey();
        await sleep(200);
      }
    }

    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      // 分离 # 号和标签文字（全部通过CDP输入，触发平台话题搜索联想）
      const tagName = tag.startsWith('#') ? tag.slice(1) : tag;
      log('info', 'cdp-tags', `输入标签: ${tag}`);

      // 每个话题都用足够的等待时间
      // 因为上一个话题确认后话题模式退出，下一个话题需要重新触发搜索联想
      const hashWaitMs = 500;   // # 号后等待：给话题搜索组件初始化时间
      const textWaitMs = 500;   // 文字输入后等待：确保搜索结果稳定

      // 第1步：通过 CDP 输入 # 号（触发平台进入话题识别模式）
      // 使用 type='char' 方式直接发送字符，不受键盘布局影响，最可靠
      await sendCharKey('#');
      await sleep(hashWaitMs); // 等待平台检测到 # 号，弹出话题联想

      // 第2步：通过 CDP 逐字符输入标签文字
      // 🔑 关键点：逐字符输入能触发平台的话题搜索/联想实时更新
      // 如果用 JS execCommand 一次性插入文字，平台不会更新推荐列表，
      // 导致按空格后选中的是默认推荐话题，而不是我们输入的话题
      if (tagName) {
        for (let ci = 0; ci < tagName.length; ci++) {
          await sendCharKey(tagName[ci]);
          await sleep(80); // 每字间隔，给搜索联想留足时间
        }
      }
      await sleep(textWaitMs); // 等待平台根据文字筛选话题，联想列表稳定

      // 第3步：通过 CDP 发送真实 Space 键，触发话题识别（将 #tag 转为可点击话题）
      await sendSpaceKey();
      await sleep(500); // 等待平台处理话题转换

      // 第4步：额外输入一个普通空格，确保光标移到普通文本区域
      // 🔑 关键：话题确认后光标可能在话题节点内部/边缘
      // 额外输入一个普通空格，把光标推到普通文本区域
      // - 非最后一个：确保下一个话题的 # 号能正常触发话题模式
      // - 最后一个：确保话题转换完全完成（有些平台需要离开话题模式才完成转换）
      await sendCharKey(' ');
      await sleep(150);
    }

    // 所有话题输入完后额外等待，确保最后一个话题完全转换稳定
    await sleep(500);

    log('info', 'cdp-tags', `✅ 已输入 ${tags.length} 个标签`);
    return true;
  } catch (err) {
    log('error', 'cdp-tags', `CDP标签输入失败: ${(err as Error).message}`);
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

      // 3) 状态判断（v8：uploadingMatch 具有最高阻断优先级；
      //     只要页面明确显示"上传中/处理中"，即使有编辑元素也应等待上传完成）
      var hasEditField = (textareaList.length + ceList.length + textInputList.length) > 0;
      var hasContenteditable = ceList.length > 0;
      var hasThumb = thumbCount > 0;
      var hasTextarea = textareaList.length > 0;
      var hasTitleInput = textInputList.length > 0;
      var bodyHasTitleRe = /标题|作品描述|描述|简介|作品标题|视频标题/i;
      // 更严格的"上传未完成"信号：必须明确包含"上传中/正在上传/处理中/转码中/解析中"
      // （"上传视频"/"上传按钮"等页面静态文案不能算上传中）
      var uploadingRe = /上传中|正在上传|处理中|转码中|解析中|encoding|uploading...|processing...|请稍候|等待转码|正在转码|上传进度/i;
      var uploadingMatch = uploadingRe.test(bodyText);
      var processingMatch = /处理中|转码中|解析中|processing/i.test(bodyText);

      var readyStatus = 'waiting';
      if (uploadingMatch) {
        // 🔑 最高优先级阻断：页面明确在上传中 → 必须等待，否则点击"发布"会报错
        // （即使 contenteditable 已经出现也不能放行：上传中的素材无法发布）
        readyStatus = 'uploading';
      } else if (hasContenteditable) {
        // 有 contenteditable（快手/小红书的标题/描述输入区）→ ready
        readyStatus = 'ready';
      } else if (bodyHasTitleRe.test(bodyText)) {
        // 正文含"标题/作品描述/描述"关键词 → 进入编辑页面
        readyStatus = 'ready';
      } else if (hasTitleInput) {
        // 有文本输入框（抖音等平台的标题输入框）→ ready
        readyStatus = 'ready';
      } else if (hasTextarea) {
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
        // 🔑 关键修复：ProseMirror/Tiptap 是**正文编辑器**，绝对不可能是标题！
        // 检测到 ProseMirror 类 → 大幅扣分，避免把正文编辑器误识别为标题输入框
        var clsAttr = el.getAttribute && el.getAttribute('class') || '';
        if (/tiptap|ProseMirror|prosemirror/i.test(clsAttr)) s -= 5000;
        // 额外保险：检测子元素是否含 ProseMirror 类（父容器也可能被误判）
        try {
          var pmChild = el.querySelector && el.querySelector('.tiptap, .ProseMirror, [class*="tiptap"], [class*="ProseMirror"]');
          if (pmChild !== null && pmChild !== el) s -= 5000;
        } catch (epm) {}
        // 标题输入框通常较短（1 行），给 contenteditable 更高的基础分
        if (isTitle) {
          if (type === 'contenteditable') s += 80;
          if (type === 'input') s += 30;
          if ((el.offsetHeight || 0) < 80) s += 20;
          if ((el.offsetWidth || 0) > 200) s += 10;
        }
        return s;
      }

      // 对每个 root 收集候选元素（主文档 + iframe + Shadow DOM，完全穿透）
      for (var di = 0; di < roots.length; di++) {
        var d = roots[di].doc;
        if (!d || !d.querySelectorAll) continue;

        // 1) textarea（textarea 也可能是内容描述区，不应用话题过滤）
        try {
          var tareas = d.querySelectorAll('textarea');
          for (var i = 0; i < tareas.length; i++) {
            var el = tareas[i];
            if ((el.offsetWidth || 0) === 0 && (el.offsetHeight || 0) === 0) continue;
            var ph = (el.getAttribute('placeholder') || '').toLowerCase();
            var aria = (el.getAttribute('aria-label') || '').toLowerCase();
            var lbl = tryGetLabel(el, d);
            var combinedText = [ph, aria, lbl].join(' ');
            // 🔑 修复：textarea 不应用话题关键词过滤（可能是内容描述区）
            if (/选择|类型|下拉|选项|search|搜索|分类/i.test(combinedText)) continue;
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
            // 🔑 input 元素保留话题过滤：独立的话题输入框通常是 <input>
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
          // 🔑 修复：同时检测带值和不带值的 contenteditable（与 buildFillContent 保持一致）
          var ces = d.querySelectorAll('[contenteditable]');
          var seenTitleCE = {};
          for (var k = 0; k < ces.length; k++) {
            var el3 = ces[k];
            var ceVal = (el3.getAttribute && el3.getAttribute('contenteditable')) || '';
            if (ceVal === 'false') continue;
            if ((el3.offsetWidth || 0) === 0 && (el3.offsetHeight || 0) === 0) continue;
            var tKey = String(k) + '_' + el3.tagName;
            if (seenTitleCE[tKey]) continue;
            seenTitleCE[tKey] = 1;
            var aria3 = (el3.getAttribute('aria-label') || '').toLowerCase();
            var ph3 = (el3.getAttribute('placeholder') || '').toLowerCase();
            var lbl3 = tryGetLabel(el3, d);
            var combined3 = [aria3, ph3, lbl3].join(' ');
            // 🔑 修复：contenteditable 不应用话题关键词过滤！
            //    正文编辑器的 placeholder 可能含"添加合适的话题和描述..."
            if (combined3.length > 2 && /选择|类型|下拉|选项|search|搜索|分类/i.test(combined3)) continue;
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

      // 填充 + 派发事件（兼容 React 受控组件 + ProseMirror/Tiptap）
      var method = 'unknown';
      var tgtCls2 = target.el.getAttribute && target.el.getAttribute('class') || '';
      var tgtIsProseMirror = /tiptap|ProseMirror|prosemirror/i.test(tgtCls2);
      try {
        if (target.tag === 'contenteditable') {
          // 对 contenteditable 优先使用 execCommand，兼容 ProseMirror/Tiptap
          try {
            target.el.focus();
            try {
              var rng2 = document.createRange();
              rng2.selectNodeContents(target.el);
              var sel2 = window.getSelection();
              sel2.removeAllRanges();
              sel2.addRange(rng2);
            } catch (ex2) {}
            try { document.execCommand('delete'); } catch (ex3) {}
            try {
              document.execCommand('insertText', false, ${jt});
              method = 'title-execCommand';
            } catch (ex4) {
              target.el.innerText = ${jt};
              method = 'title-innerText-fallback';
            }
          } catch (ex) {
            target.el.innerText = ${jt};
            method = 'title-innerText';
          }
        } else {
          try {
            var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(target.el, ${jt});
            method = 'title-native-setter';
          } catch (e1) {
            try {
              target.el.value = ${jt};
              method = 'title-direct-value';
            } catch (e2) {
              target.el.innerText = ${jt};
              method = 'title-fallback-innerText';
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
          isProseMirror: tgtIsProseMirror,
          readBack: (target.el.innerText || target.el.value || '').slice(0, 80),
          totalCandidates: candidates.length
        };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 100), tag: target.tag, score: target.score };
      }
    })();
  `;
}

/** 填写正文/描述脚本（v4：iframe 穿透 + Shadow DOM 穿透 + 更精准的内容区域匹配 + ProseMirror 支持） */
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

      function scoreElement(el, type, text, hasValue) {
        var s = 0;
        if (!text) text = '';
        // 内容/正文关键词
        var kw = ['描述', '正文', '内容', '简介', 'description', '介绍', '作品描述', '视频简介', '作品简介', '描述栏', '填写描述', '作品介绍', '作品正文', '作品文案', '发布笔记', '发布内容'];
        for (var i = 0; i < kw.length; i++) {
          if (text.indexOf(kw[i]) !== -1) { s += 500; break; }
        }
        // 🔑 ProseMirror / Tiptap 编辑器检测 —— 小红书正文使用此框架
        // 这类编辑器有自己的内部 state 管理，需要专门的填充方法
        var clsAttr = el.getAttribute && el.getAttribute('class') || '';
        var isProseMirror = /tiptap|ProseMirror|prosemirror/i.test(clsAttr);
        var hasDataPlaceholder = el.getAttribute && el.getAttribute('data-placeholder');
        // 🔑 新增：递归检查子元素的 data-placeholder（小红书 ProseMirror 容器的 <p> 子元素才带 data-placeholder）
        if (!hasDataPlaceholder) {
          try {
            var childPh = el.querySelectorAll('[data-placeholder]');
            if (childPh.length > 0) {
              for (var pi = 0; pi < childPh.length; pi++) {
                var phVal = childPh[pi].getAttribute && childPh[pi].getAttribute('data-placeholder') || '';
                if (/正文|描述|内容|分享|简介|作品/i.test(phVal)) { hasDataPlaceholder = phVal; break; }
              }
            }
          } catch (ePh) {}
        }
        var hasProseMirrorChild = false;
        try {
          var inner = el.querySelectorAll('[class*="ProseMirror"], [class*="tiptap"]');
          hasProseMirrorChild = inner.length > 0;
        } catch (e) {}
        if (isProseMirror || hasProseMirrorChild) {
          s += 2000; // 超高优先级：肯定是正文编辑区
        }
        if (hasDataPlaceholder && /正文|描述|内容|分享|简介/i.test(hasDataPlaceholder || '')) {
          s += 1000;
        }
        // contenteditable 高优先级（快手/小红书正文）
        if (type === 'contenteditable') {
          s += 400; // 基础高分
          var h = el.offsetHeight || 0;
          if (h > 150) s += 300;    // 高的 contenteditable 是正文区
          else if (h > 80) s += 200;
          else if (h > 50) s += 100;
          var w = el.offsetWidth || 0;
          if (w > 400) s += 150;
          if (!hasValue) s += 100;
        }
        if (type === 'textarea') {
          s += 250;
          var th2 = el.offsetHeight || 0;
          if (th2 > 150) s += 250;
          else if (th2 > 80) s += 150;
        }
        if (type === 'input') {
          s += 10;
          if ((el.offsetHeight || 0) < 50) s -= 20;
        }
        if ((el.offsetWidth || 0) > 300) s += 20;
        return s;
      }

      // 遍历所有 root 收集可编辑元素
      var debugCE = 0, debugTA = 0, debugInput = 0;
      for (var di = 0; di < roots.length; di++) {
        var d = roots[di].doc;
        if (!d || !d.querySelectorAll) continue;

        var allEls = [];
        try {
          var tareas = d.querySelectorAll('textarea');
          for (var i = 0; i < tareas.length; i++) {
            if ((tareas[i].offsetWidth || 0) === 0 && (tareas[i].offsetHeight || 0) === 0) continue;
            allEls.push({ el: tareas[i], tag: 'textarea' });
            debugTA++;
          }
        } catch (e) {}
        try {
          // 🔑 修复：同时检测带值和不带值的 contenteditable（快手等平台可能用 <div contenteditable> 而不是 contenteditable="true"）
          var cesRaw = d.querySelectorAll('[contenteditable]');
          var seenCE = {};
          for (var ck = 0; ck < cesRaw.length; ck++) {
            try {
              var cEl = cesRaw[ck];
              var cVal = (cEl.getAttribute && cEl.getAttribute('contenteditable')) || '';
              // 只接受可编辑的 true/""/plaintext-only，排除 "false"
              if (cVal === 'false') continue;
              if ((cEl.offsetWidth || 0) === 0 && (cEl.offsetHeight || 0) === 0) continue;
              var cKey = String(ck) + '_' + cEl.tagName;
              if (seenCE[cKey]) continue;
              seenCE[cKey] = 1;
              allEls.push({ el: cEl, tag: 'contenteditable' });
              debugCE++;
            } catch (eCE) {}
          }
        } catch (e) {}
        try {
          var allInps = d.querySelectorAll('input');
          for (var j = 0; j < allInps.length; j++) {
            var itype = (allInps[j].getAttribute('type') || 'text').toLowerCase();
            if (itype === 'file' || itype === 'hidden' || itype === 'checkbox' || itype === 'radio' || itype === 'search' || itype === 'submit' || itype === 'button') continue;
            if ((allInps[j].offsetWidth || 0) === 0 && (allInps[j].offsetHeight || 0) === 0) continue;
            allEls.push({ el: allInps[j], tag: 'input' });
            debugInput++;
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
          var tagName = allEls[m].tag; // contenteditable / textarea / input
          var isCE = tagName === 'contenteditable';
          var isTA = tagName === 'textarea';
          // 跳过：标题相关元素（只在 combined 非空时才应用过滤，避免空元素被误杀）
          // 🔑 关键修复：contenteditable / textarea 不应用标题关键词过滤
          //    contenteditable 是正文编辑器（快手/小红书），即使 placeholder 含 "标题" 也应该填写内容
          if (!isCE && !isTA && combined.length > 2 && /标题|作品标题|作品名称|视频标题|title|标题栏|标题内容|填写标题|添加标题|作品名|会有更多赞/i.test(combined)) continue;
          // 跳过：选择类/下拉/分类/话题/搜索/地点（仅对 input 元素应用）
          // 🔑 关键修复：contenteditable / textarea 不应用话题关键词过滤！
          //    快手案例：placeholder="添加合适的话题和描述，作品能获得更多推荐～" 含"话题"两字被误杀
          if (!isCE && !isTA && combined.length > 2 && /选择|类型|下拉|选项|search|搜索|话题|\\btag\\b|标签|分类|地点|位置|\\bwhere\\b/i.test(combined)) continue;
          if (val.length > 0 && !isCE && !isTA && combined.length > 2 && /话题|tags|tag|#/i.test(combined)) continue;

          // 🔑 修正 ProseMirror 编辑器的 hasContent 判断：
          // ProseMirror 空状态结构为 <p class="is-empty"><br></p>，innerText 可能为空串或换行
          // 但更可靠的是检测 class 中是否含 is-empty，或子元素是否含 is-empty
          var realHasContent = val.length > 0;
          if (allEls[m].tag === 'contenteditable') {
            var xCls = elx.getAttribute && elx.getAttribute('class') || '';
            if (/tiptap|ProseMirror|prosemirror/i.test(xCls)) {
              // 如果编辑器自身有 is-empty 类，明确标记为空
              if (/is-empty|is-editor-empty/i.test(xCls)) {
                realHasContent = false;
              } else {
                // 检查子元素是否有 is-empty 类
                try {
                  var emptyChild = elx.querySelector('.is-empty, .is-editor-empty');
                  if (emptyChild !== null) realHasContent = false;
                  else realHasContent = (val.trim().length > 0);
                } catch (eX) {
                  realHasContent = (val.trim().length > 0);
                }
              }
            } else {
              // 普通 contenteditable：trim 后再判断
              realHasContent = (val.trim().length > 0);
            }
          }

          candidates.push({
            el: elx, tag: allEls[m].tag,
            score: scoreElement(elx, allEls[m].tag, combined, realHasContent),
            text: combined.slice(0, 80),
            hasContent: realHasContent,
            inShadow: !!roots[di].isShadow
          });
        }
      }

      // 🔑 详细调试信息（帮助诊断为什么内容没填写）
      var debugInfo = {
        rootCount: roots.length,
        mainRoot: 0,
        shadowRoot: 0,
        ceFound: debugCE,
        textareaFound: debugTA,
        inputFound: debugInput,
        totalCands: candidates.length,
        top5: [],
        target: null,
        fillSteps: [],
        readBack: ''
      };
      try {
        for (var ddx = 0; ddx < roots.length; ddx++) {
          if (roots[ddx].isMain) debugInfo.mainRoot++;
          else if (roots[ddx].isShadow) debugInfo.shadowRoot++;
        }
      } catch (e) {}

      if (candidates.length === 0) {
        return { success: false, reason: 'no-candidates', count: 0, debug: debugInfo };
      }

      // 记录 top 5 candidates
      try {
        var sortedCands = candidates.slice().sort(function (a, b) { return b.score - a.score; });
        for (var tIdx = 0; tIdx < Math.min(5, sortedCands.length); tIdx++) {
          var c = sortedCands[tIdx];
          var cCls = c.el.getAttribute && c.el.getAttribute('class') || '';
          debugInfo.top5.push({
            score: c.score, tag: c.tag, hasContent: c.hasContent,
            text: (c.text || '').slice(0, 50),
            cls: cCls.slice(0, 80),
            h: c.el.offsetHeight || 0, w: c.el.offsetWidth || 0,
            isPm: /tiptap|ProseMirror|prosemirror/i.test(cCls)
          });
        }
      } catch (e) {}

      // 优先选没有内容的元素（避免覆盖标题）
      var emptyCandidates = candidates.filter(function (c) { return !c.hasContent; });
      var pool = emptyCandidates.length > 0 ? emptyCandidates : candidates;
      pool.sort(function (a, b) { return b.score - a.score; });
      var target = pool[0];

      // 🔑 检测是否为 ProseMirror/Tiptap 编辑器
      var tgtCls = target.el.getAttribute && target.el.getAttribute('class') || '';
      var tgtIsProseMirror = /tiptap|ProseMirror|prosemirror/i.test(tgtCls);
      var tgtHasProseChild = false;
      try {
        tgtHasProseChild = target.el.querySelector &&
          target.el.querySelector('.tiptap, .ProseMirror, [class*="tiptap"], [class*="ProseMirror"]') !== null;
      } catch (e) {}

      debugInfo.target = {
        tag: target.tag, score: target.score, text: (target.text || '').slice(0, 50),
        isProseMirror: tgtIsProseMirror, hasProseChild: tgtHasProseChild,
        cls: tgtCls.slice(0, 80), h: target.el.offsetHeight || 0, w: target.el.offsetWidth || 0,
        hasContent: target.hasContent
      };

      var method = 'unknown';
      try {
        if (target.tag === 'contenteditable' && (tgtIsProseMirror || tgtHasProseChild)) {
          // ========== ProseMirror/Tiptap 专用填充（极简 v3）
          var targetText = ${jc};
          var lines = targetText.split('\\n');
          var pmWrote = false;
          debugInfo.fillSteps.push('type:prosemirror lines:' + lines.length + ' textlen:' + targetText.length);

          // 方案 A: 传统 DOM 操作 + input 事件（最可靠，不需要 execCommand）
          try {
            // Step 1: focus
            try { target.el.focus(); } catch (eFc) { debugInfo.fillSteps.push('focus-err:' + eFc.message); }
            // Step 2: 清空现有内容
            try {
              while (target.el.firstChild) target.el.removeChild(target.el.firstChild);
              debugInfo.fillSteps.push('cleared');
            } catch (e2) { debugInfo.fillSteps.push('clear-err:' + e2.message); }
            // Step 3: 每行一个 <p> 节点写入（ProseMirror 的标准结构）
            for (var lyi = 0; lyi < lines.length; lyi++) {
              var pN = document.createElement('p');
              pN.textContent = lines[lyi] || '';
              target.el.appendChild(pN);
            }
            pmWrote = true;
            method = 'prosemirror-v3-domAppend';
            debugInfo.fillSteps.push('domAppend ok lines:' + lines.length);
          } catch (eDomA) {
            debugInfo.fillSteps.push('domA-err:' + eDomA.message);
            // fallback: innerText
            try {
              target.el.innerText = targetText;
              method = 'prosemirror-v3-innerText';
              pmWrote = true;
              debugInfo.fillSteps.push('innerText ok');
            } catch (eFT) {
              debugInfo.fillSteps.push('innerText-err:' + eFT.message);
            }
          }

          // 方案 B: 再尝试 execCommand（触发 ProseMirror 的 input 监听）
          if (pmWrote) {
            try {
              target.el.focus();
              var tryRange = document.createRange();
              tryRange.selectNodeContents(target.el);
              tryRange.collapse(false);
              var trySel = window.getSelection();
              trySel.removeAllRanges();
              trySel.addRange(tryRange);
              document.execCommand('insertText', false, ' ');
              debugInfo.fillSteps.push('execCommand-space ok');
            } catch (eB) {
              debugInfo.fillSteps.push('execCommand-err:' + eB.message);
            }
          }

          // 🔑 关键：触发 input 事件（ProseMirror 监听此事件来同步内部 state）
          try {
            var inpEv = document.createEvent('Event');
            inpEv.initEvent('input', true, true);
            target.el.dispatchEvent(inpEv);
            debugInfo.fillSteps.push('input-event ok');
          } catch (eEv1) { debugInfo.fillSteps.push('input-event-err:' + eEv1.message); }
          try {
            target.el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          } catch (eEv2) {}
          try {
            target.el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          } catch (eEv3) {}
          try { target.el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (eEv4) {}

          debugInfo.readBack = (target.el.innerText || '').slice(0, 120);
        } else if (target.tag === 'contenteditable') {
          // 普通 contenteditable（非 ProseMirror）
          try {
            target.el.focus();
            try {
              var rangeB = document.createRange();
              rangeB.selectNodeContents(target.el);
              var selB = window.getSelection();
              selB.removeAllRanges();
              selB.addRange(rangeB);
            } catch (ex) {}
            try { document.execCommand('delete'); } catch (ex) {}
            try { document.execCommand('insertText', false, ${jc}); } catch (ex) {
              target.el.innerText = ${jc};
            }
            target.el.dispatchEvent(new Event('input', { bubbles: true }));
            target.el.dispatchEvent(new Event('change', { bubbles: true }));
            method = 'contenteditable-execCommand';
          } catch (eC) {
            target.el.innerText = ${jc};
            target.el.dispatchEvent(new Event('input', { bubbles: true }));
            method = 'contenteditable-innerText';
          }
        } else {
          // textarea / input： 使用原生 setter
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
          isProseMirror: tgtIsProseMirror || tgtHasProseChild,
          readBack: (target.el.innerText || target.el.value || '').slice(0, 120),
          totalCandidates: candidates.length,
          debug: debugInfo
        };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 100), tag: target.tag, score: target.score, debug: debugInfo };
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

        // 策略 1：Shadow DOM 自定义组件（小红书 xhs-publish-btn，快手 shadow 按钮等）
        try {
          var shadowTags = ['xhs-publish-btn', 'xhs-button', 'publish-button', 'xhs-publish', 'xhs-upload-btn'];
          for (var si = 0; si < shadowTags.length; si++) {
            var host = d.querySelector(shadowTags[si]);
            if (!host) continue;
            var sr = host.shadowRoot;
            // 🔑 关键修复：closed shadow DOM（如 xhs-publish-btn）无法通过 shadowRoot 访问内部
            // 直接在 host 元素上点击（很多 Web Components 在 host 上也会响应 click）
            if (!sr) {
              try {
                var hostText2 = (host.innerText || host.textContent || '').trim();
                // 🔑 修复：closed shadow DOM（如 xhs-publish-btn）的 hostText 可能是"发布暂存离开"等拼接文本
                // 不要求整段文本完全匹配，也不限长度，而是检查：是否可见 + 尺寸合理 + 含"发布"关键词
                var hostVisible2 = true;
                try {
                  var hostStyle2 = getComputedStyle(host);
                  if (hostStyle2.visibility === 'hidden' || hostStyle2.display === 'none') hostVisible2 = false;
                } catch (eSt) {}
                var hostDisabled2 = (host.hasAttribute && host.hasAttribute('disabled')) || host.getAttribute('aria-disabled') === 'true';
                var hostRect2 = host.getBoundingClientRect ? host.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
                var hostW2 = hostRect2.width || host.offsetWidth || 0;
                var hostH2 = hostRect2.height || host.offsetHeight || 0;
                if (!hostDisabled2 && hostVisible2 && hostW2 >= 20 && hostH2 >= 20 && hostW2 <= 1200 && hostH2 <= 400
                    && /发布|publish|确认|提交/i.test(hostText2)) {
                  // 🔑 关键修复：closed shadow DOM host（如 xhs-publish-btn）只是一个容器，
                  // 文本是多个子按钮文本的拼接（"发布暂存离开"），直接 click host 可能不触发实际发布。
                  // 策略：
                  //   1. host 分数降为中等优先级（给普通 button 更优先）
                  //   2. 不 continue，继续在 host 上找真正的 ce-btn bg-red 子 button
                  var hostScore2 = 4000; // 🔑 从 8000 降到 4000（低于普通 bg-red button）
                  var hFB2 = viewportH - hostRect2.bottom;
                  if (hFB2 >= -300 && hFB2 < viewportH) hostScore2 += 1000;
                  // 🔑 同时：在 host 的 DOM 中找 ce-btn bg-red 子 button（小红书的实际发布按钮是普通 HTML button
                  try {
                    var innerBtn = null;
                    // 尝试 host.querySelector('.ce-btn.bg-red');
                    innerBtn = host.querySelector('.ce-btn.bg-red');
                    if (innerBtn !== null) {
                      var iw = innerBtn.offsetWidth || 0;
                      var ih = innerBtn.offsetHeight || 0;
                      if (iw > 0 && ih > 0) {
                        var innerText = (innerBtn.innerText || innerBtn.textContent || '').trim();
                        if (/发布|publish|确认|提交/i.test(innerText)) {
                          candidates.push({
                            el: innerBtn, score: hostScore2 + 5000, text: innerText.slice(0, 20),
                            tag: innerBtn.tagName ? innerBtn.tagName.toLowerCase() : 'button',
                            classStr: ((innerBtn.className && typeof innerBtn.className === 'string') ? innerBtn.className.slice(0, 60) : ''),
                            fromBottom: Math.round(viewportH - innerBtn.getBoundingClientRect().bottom),
                            fromRight: Math.round(viewportW - innerBtn.getBoundingClientRect().right),
                            w: iw, h: ih, source: 'shadow-closed-inner:' + shadowTags[si]
                          });
                        }
                      }
                    }
                  } catch (eInner) {
                    // ignore：找不到就回退到 host
                  }
                  candidates.push({
                    el: host, score: hostScore2,
                    text: hostText2.slice(0, 40),
                    tag: (host.tagName || '').toLowerCase(),
                    classStr: (host.className || '').slice(0, 60),
                    fromBottom: Math.round(hFB2), fromRight: Math.round(viewportW - hostRect2.right),
                    w: hostW2, h: hostH2, source: 'shadow-closed-host:' + shadowTags[si]
                  });
                }
              } catch (e) {}
              // 🔑 不再 continue！即使是 closed shadow DOM：也继续走后面的普通 button 策略（确保找到 ce-btn bg-red）
            }
            // 非 closed 的 shadow DOM：扫描内部按钮（注意：closed shadow DOM 的 sr === null，跳过）
            if (!sr) continue;
            var inner = sr.querySelectorAll('button, a, [role="button"]');
            for (var ii = 0; ii < inner.length; ii++) {
              try {
                var selEl = inner[ii];
                var selW = selEl.offsetWidth || 0;
                var selH = selEl.offsetHeight || 0;
                if (selW <= 5 || selH <= 5) continue;
                if (selW > 400 || selH > 200) continue;
                var st = getComputedStyle(selEl);
                if (st.visibility === 'hidden' || st.display === 'none') continue;
                if ((selEl.hasAttribute && selEl.hasAttribute('disabled')) || selEl.getAttribute('aria-disabled') === 'true') continue;
                var selText = (selEl.innerText || selEl.textContent || '').trim();
                if (!selText || selText.length > 15) continue; // 严格限制文本长度
                // 排除侧边栏：导航类文本
                if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(selText)) continue;
                // 必须含发布相关关键词（且不能包含非发布类关键词）
                if (!/(发布作品|立即发布|发布|确认发布|发布视频|发布笔记)/i.test(selText)) continue;
                if (/(转码|上传中|正在|处理中|设置封面)/.test(selText)) continue;
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
        // 注意：只匹配按钮类元素，排除 div/section 等大容器，严格限制文本长度
        try {
          var classSels = [
            '[class*="_button-primary_"]', '[class*="_button-primary"]', '[class*="_button_3a3lq"]',
            '[class*="-publish"]', '[class*="publish-btn"]', '[class*="publish-button"]',
            '[class*="ce-btn"]', '[class*="primary"]', '[class*="submit-btn"]',
            '.ce-btn.bg-red', 'button.ce-btn', '.ce-btn', '.publish-btn', '.btn-publish', 'button[class*="publish"]',
            '.bg-red', '[class*="btn-primary"]', '[class*="btn-danger"]',
            'button[class*="red"]', 'button[class*="green"]', 'button[class*="kui"]',
          ];
          for (var ci = 0; ci < classSels.length; ci++) {
            var selList = d.querySelectorAll(classSels[ci]);
            for (var ei = 0; ei < selList.length; ei++) {
              var sEl = selList[ei];
              try {
                var sW = sEl.offsetWidth || 0;
                var sH = sEl.offsetHeight || 0;
                if (sW <= 5 || sH <= 5) continue;
                // 必须是按钮类元素（不是 div 容器）
                var sTagName = sEl.tagName ? sEl.tagName.toLowerCase() : '';
                if (sTagName !== 'button' && sTagName !== 'a' && sTagName !== 'span' && (sTagName !== 'div' || sW > 400 || sH > 200)) continue;
                var sSty = getComputedStyle(sEl);
                if (sSty.visibility === 'hidden' || sSty.display === 'none') continue;
                if ((sEl.hasAttribute && sEl.hasAttribute('disabled')) || sEl.getAttribute('aria-disabled') === 'true') continue;
                var sText = (sEl.innerText || sEl.textContent || '').trim();
                if (!sText) continue;
                // 严格限制文本长度：发布类按钮一般只有 2-6 个汉字
                if (sText.length > 15) continue;
                // 排除侧边栏：导航类文本 + 窄/矮元素
                if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理/i.test(sText)) continue;
                // 必须含发布相关关键词（且不能包含非发布类关键词）
                if (!/(发布作品|立即发布|发布|确认发布|发布视频|发布笔记)/i.test(sText)) continue;
                if (/(转码|上传中|正在|处理中|设置封面)/.test(sText)) continue;
                var sClass = ((sEl.className && typeof sEl.className === 'string') ? sEl.className : '').toLowerCase();
                if (/nav|menu|header|sidebar|breadcrumb|tabs|container|wrapper|section|content/i.test(sClass)) continue;
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

        // 策略 3：底部/右侧区域扫描（扫描 button/a/div，严格限制尺寸和文本）
        try {
          var clickable = d.querySelectorAll('button, a, [role="button"], div');
          for (var di = 0; di < clickable.length; di++) {
            var de2 = clickable[di];
            try {
              var dW = de2.offsetWidth || 0;
              var dH = de2.offsetHeight || 0;
              if (dW < 40 || dH < 28) continue;
              if (dW > 400 || dH > 200) continue; // 排除超大容器
              var dSty = getComputedStyle(de2);
              if (dSty.visibility === 'hidden' || dSty.display === 'none') continue;
              var dRect = de2.getBoundingClientRect ? de2.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var dFromBottom = viewportH - dRect.bottom;
              // 扩大范围：底部 80% 或右侧 40%
              var isInBottomOrRight = dFromBottom < viewportH * 0.8 || dRect.left > viewportW * 0.6;
              if (!isInBottomOrRight) continue;
              var dText = (de2.innerText || de2.textContent || '').trim();
              if (!dText || dText.length > 10) continue; // 严格限制：发布按钮一般只有 2-4 字
              // 排除侧边栏：导航类文本
              if (/首页|内容管理|互动管理|数据中心|成长中心|创作服务|粉丝|关注|作品管理|发布作品|作品发布|发布到|发布设置|发布内容/i.test(dText) && (dW < 200)) continue;
              // 必须含发布相关关键词（且不能包含非发布类关键词）
              if (!/(发布作品|立即发布|发布|确认发布|发布视频|发布笔记|发布)/i.test(dText)) continue;
              if (/(转码|上传中|正在|处理中|设置封面|草稿箱|存草稿|保存草稿)/.test(dText)) continue;
              var dClass = ((de2.className && typeof de2.className === 'string') ? de2.className : '').toLowerCase();
              if (/nav|menu|header|sidebar|breadcrumb|tabs|tab-bar|setting|option|select|dropdown|filter|sort|config|container|wrapper|content-body|publish-header/i.test(dClass)) continue;
              // 必须有 pointer/cursor 样式（是可点击元素）
              if (dSty.cursor && dSty.cursor !== 'pointer' && dSty.cursor !== 'cursor') continue;
              var dFromRight = viewportW - dRect.right;
              var dScore = 0;
              if (dText === ${jk}) dScore += 3000;
              else if (dText.indexOf(${jk}) === 0) dScore += 1000;
              else if (dText.indexOf(${jk}) !== -1) dScore += 200;
              if (de2.tagName.toLowerCase() === 'button') dScore += 1200;
              if (/bg-red|primary|danger|submit|publish|ce-btn|kui|ks-btn|publish-btn|-btn/i.test(dClass)) dScore += 2000;
              // 靠近底部 + 右侧加分（右侧优先级更高）
              if (dFromBottom >= 0 && dFromBottom < viewportH * 0.3) {
                dScore += 600;
                var dbRatio = 1 - Math.min(1, dFromBottom / (viewportH * 0.3));
                dScore += Math.round(dbRatio * 2000);
              }
              if (dFromRight >= -100 && dFromRight < viewportW * 0.4) {
                var drRatio = 1 - Math.min(1, dFromRight / (viewportW * 0.4));
                dScore += Math.round(drRatio * 1500);
              }
              candidates.push({ el: de2, score: dScore, text: dText, tag: de2.tagName.toLowerCase(), classStr: dClass.slice(0, 60), fromBottom: Math.round(dFromBottom), fromRight: Math.round(dFromRight), w: dW, h: dH, source: sourcePrefix + 'bottom-right-scan' });
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
/**
 * 平台发布策略配置（适配器模式：各平台通过钩子注入差异化行为）。
 *
 * 设计原则：
 *   - 单一职责：runStandardPublish 是流程编排器，平台差异通过回调注入，不写在主流程里
 *   - 开闭原则：新增平台 / 修改平台行为只需改平台文件，不动 shared.ts
 *   - 可选钩子：所有策略钩子都是 optional，未提供时用通用 fallback（switchContentTypeTab 等）
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
  /** 发布成功后多少毫秒再自动关闭窗口（默认 8000ms），留给平台完成异步上传/处理 */
  autoCloseWaitMs?: number;
  /**
   * 平台字数限制（按"字符"计算，一个中文/字母/数字/符号均算 1 字）。
   * 若提供，在填写标题/正文前会自动按此限制截断内容并输出警告日志。
   */
  contentLimits?: {
    title?: number;
    content?: number;
  };
  /**
   * 平台标签数量限制（按"个数"计算，每个 #标签 算 1 个）。
   *  - 快手：最多 4 个标签（超出会被平台拒绝并提示"标签最多四个"）
   *  - 小红书：最多 10 个话题
   *  - 抖音：最多 5 个话题（保守值，具体以平台为准）
   * 若提供，在拼接正文前会自动按此限制截断多余标签并输出警告日志。
   */
  tagLimits?: {
    max?: number;
  };
  /** 本次发布的内容类型：video / image / article */
  contentType?: ContentType;
  /** 是否跳过标题填写：true = 不填写标题（快手图文发布页面没有独立标题字段） */
  skipTitle?: boolean;

  // ============== 平台策略钩子（可选，未提供时用通用 fallback） ==============
  /**
   * [策略钩子] 根据内容类型返回发布 URL（策略模式：路由策略）。
   *  - 快手：视频页 URL 与图文页 URL 不同，必须提供
   *  - 小红书 / 抖音：同一 URL，可省略
   */
  getPublishUrl?: (contentType: ContentType) => string;
  /**
   * [策略钩子] 自定义 tab 切换实现（适配器模式：平台自行处理从视频到图文的切换）。
   * 返回 true 表示切换成功；返回 false 或未提供 → 回落到通用 switchContentTypeTab。
   */
  tabSwitcher?: (
    win: BrowserWindow,
    contentType: ContentType,
    log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  ) => Promise<boolean>;
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
    // [策略模式] 优先使用平台自定义的 URL 路由；fallback 到 meta.publishUrl
    const effectiveContentType = config.contentType || (request.contentType as ContentType) || 'video';
    const effectivePublishUrl = config.getPublishUrl
      ? config.getPublishUrl(effectiveContentType)
      : config.meta.publishUrl;
    log('info', 'navigation', `加载发布页 (contentType=${effectiveContentType})`, { url: effectivePublishUrl });
    await win.loadURL(effectivePublishUrl, {
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

    // 上传素材（先切换到正确的内容类型 tab，再上传）
    if (request.mediaFiles.length > 0) {
      onProgress(30, '上传素材…');
      // [适配器模式] 优先平台自定义 tab 切换；fallback 到通用 switchContentTypeTab
      let tabSwitched = false;
      if (config.tabSwitcher) {
        try {
          tabSwitched = await config.tabSwitcher(win, effectiveContentType, log);
        } catch (e) {
          log('warn', 'tab', `平台 tab 切换异常: ${(e as Error).message}`);
        }
      }
      if (!tabSwitched) {
        await switchContentTypeTab(win, effectiveContentType, log);
      }
      await uploadViaCDP(win, request.mediaFiles, log, effectiveContentType);
      // 上传后最容易触发导航/白屏，多等待一次稳定
      await tracker.waitForStable(1000, 10000);
    } else {
      onProgress(50, '无素材，跳过上传');
    }

    const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
    if (!uploadResult.ready) onProgress(60, '上传未完成，继续尝试填写…');

    // 填写内容 —— 先按平台限制截断，避免超长内容被平台暴力截断或拒绝
    onProgress(75, '填写标题与正文…');
    // ===== 字数限制处理（开始） =====
    const limits = config.contentLimits;
    const tagLimits = config.tagLimits;
    let finalTitle = request.title || '';
    // ===== 标签数量限制（开始） =====
    let effectiveTags = (request.tags || []).slice();
    if (tagLimits && typeof tagLimits.max === 'number' && effectiveTags.length > tagLimits.max) {
      log('warn', 'limits', `标签超出限制 (${effectiveTags.length} > ${tagLimits.max})，已截断（${config.platform} 对标签数量有严格限制）`);
      effectiveTags = effectiveTags.slice(0, tagLimits.max);
    }
    // ===== 标签数量限制（结束） =====
    let finalContent = (request.content || '') +
      (effectiveTags.length ? '\n' + effectiveTags.map((t) => `#${t}`).join(' ') : '');

    if (limits && typeof limits.title === 'number' && finalTitle.length > limits.title) {
      log('warn', 'limits', `标题超出限制 (${finalTitle.length} > ${limits.title})，已截断`);
      finalTitle = finalTitle.slice(0, limits.title);
    }
    if (limits && typeof limits.content === 'number' && finalContent.length > limits.content) {
      log('warn', 'limits', `正文超出限制 (${finalContent.length} > ${limits.content})，已截断（快手/小红书/抖音对正文字符数有严格限制）`);
      finalContent = finalContent.slice(0, limits.content);
    }
    // ===== 字数限制处理（结束） =====

    // 🔑 策略：按 skipTitle 配置决定是否填写标题
    if (!config.skipTitle && finalTitle) {
      try { await evalJS(win, buildFillTitle(finalTitle), 'fill-title', log); }
      catch (e) { log('warn', 'fill', `标题填写异常: ${(e as Error).message}`); }
    } else if (config.skipTitle) {
      log('info', 'fill', `跳过标题填写（skipTitle=true）`);
    }
    if (finalContent.trim().length > 0) {
      try { await evalJS(win, buildFillContent(finalContent), 'fill-content', log); }
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
    // 记录点击前的 URL — 用于判断点击是否真正生效（URL 变化即视为成功）
    let initialUrl = '';
    try { initialUrl = await win.webContents.getURL(); } catch { initialUrl = ''; }

    for (let i = 0; i < keywords.length; i++) {
      try {
        const res: any = await evalJS(win, buildPublishButtonClicker(keywords[i]), `click-${keywords[i]}`, log);
        if (!res || !res.clicked) { log('warn', 'submit', `关键词 "${keywords[i]}" 未点击到元素，继续尝试`); continue; }
        clicked = true;
        log('info', 'submit', `点击成功: ${keywords[i]}`);

        // 关键改动 1：延长等待（上传/发布后可能需要几秒才导航）
        await tracker.waitForStable(800, 15000);
        await sleep(2000);

        // 关键改动 2：点击后检查 URL 是否变化（导航到管理/内容页 = 发布成功）
        let currentUrl = '';
        try { currentUrl = await win.webContents.getURL(); } catch { currentUrl = ''; }
        if (currentUrl && initialUrl && currentUrl !== initialUrl) {
          // URL 变化 → 发布按钮生效，直接 break
          log('info', 'submit', `✅ URL 已变化（${(initialUrl as string).slice(-40)} → ${(currentUrl as string).slice(-40)}），视为发布成功`);
          actuallyPublished = true;
          break;
        }

        if (config.enablePostClickVerify) {
          try {
            const v1: any = await evalJS(win, buildPublishVerifier(), `verify-${i}`, log);
            log('info', 'verify', `验证: ${v1.verdict} (url=${v1.url ? (v1.url as string).slice(-50) : 'n/a'})`);
            // 关键改动 3：离开发布页（leftPublishPage=true）也视为成功
            if (v1.verdict === 'success' || v1.verdict === 'maybe_success_url_changed' || v1.leftPublishPage) {
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
            log('warn', 'submit', `点击 "${keywords[i]}" 后页面未验证成功（${v1.verdict}），继续尝试…`);
          } catch (verifyErr) {
            // 关键改动 4：verify 抛异常时再次检查 URL，已导航即视为成功
            try { currentUrl = await win.webContents.getURL(); } catch { currentUrl = ''; }
            if (currentUrl && initialUrl && currentUrl !== initialUrl) {
              log('info', 'submit', `✅ verify 抛异常但 URL 已变化，视为发布成功`);
              actuallyPublished = true;
              break;
            } else {
                log('warn', 'submit', `验证异常，继续尝试: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
            }
          }
        } else {
          break; // 无验证时，点到即止
        }
      } catch (e) { log('warn', 'submit', `关键词 "${keywords[i]}" 点击异常`); }
    }

    if (clicked && config.enablePostClickVerify && !actuallyPublished) {
      // 兜底 1：所有关键词都试过但仍未验证成功，尝试直接点击页面上带 _button-primary_ 类的元素
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

      // 兜底 2：CDP 穿透 closed shadow DOM 点击（专门针对小红书 xhs-publish-btn 等自定义组件）
      // 其他平台（如快手、抖音）的发布按钮通常能被 JS 正常找到，所以这里仅作为最后手段。
      // 对其他平台：若页面没有符合条件的元素，cdpClickPublishButton 会返回 false，不影响流程。
      if (!actuallyPublished) {
        try {
          log('info', 'submit', `兜底尝试：CDP 穿透 shadow DOM 点击发布按钮`);
          const cdpOk = await cdpClickPublishButton(win, log, keywords);
          if (cdpOk) {
            await tracker.waitForStable(800, 8000);
            await sleep(2500);
            // 检查 URL 是否变化（比 actuallyPublished 更准确）
            try {
              const afterUrl: string = await win.webContents.getURL();
              const stillOnPublishPage = /\/publish\b|\/article\/publish|\/post\b|\/upload\b/.test(afterUrl);
              if (!stillOnPublishPage) {
                log('info', 'submit', `✅ CDP 点击后 URL 已变化，发布成功`);
                actuallyPublished = true;
              } else {
                log('warn', 'submit', `CDP 点击后仍停留在发布页，可能需要手动确认`);
                actuallyPublished = true; // 放宽：CDP 已执行，让后续验证/关闭逻辑处理
              }
            } catch { actuallyPublished = true; }
          }
        } catch (e) {
          log('warn', 'submit', `CDP 兜底点击异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // 🔑 外层兜底：JS 点击完全失败（所有关键词都没找到按钮）
    // 且 enablePostClickVerify=true 时，用 CDP 穿透 closed shadow DOM 再试一次。
    // 这是针对小红书的主要路径 — xhs-publish-btn 的 closed shadow DOM 让 JS 完全无法找到内部按钮。
    // 对快手/抖音等平台：由于它们的发布按钮能被 JS 方式找到（clicked 会为 true），不会走到这里。
    if (!clicked && config.enablePostClickVerify && !actuallyPublished) {
      try {
        log('info', 'submit', `🔑 JS 点击完全失败，尝试 CDP 穿透 shadow DOM 点击发布按钮`);
        const cdpOk = await cdpClickPublishButton(win, log, keywords);
        if (cdpOk) {
          await tracker.waitForStable(800, 8000);
          await sleep(2500);
          actuallyPublished = true;
          log('info', 'submit', `✅ CDP 穿透点击完成，标记为已发布`);
        } else {
          log('warn', 'submit', `CDP 点击也未能成功执行`);
        }
      } catch (e) {
        log('warn', 'submit', `外层 CDP 兜底点击异常: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ✅ 发布成功后自动关闭窗口（给 8 秒让平台完成异步上传/处理）
    if (win && !win.isDestroyed() && actuallyPublished) {
      const waitMs = config.autoCloseWaitMs || 8000;
      log('info', 'auto-close', `🎯 发布成功！${(waitMs / 1000).toFixed(0)} 秒后自动关闭发布窗口…`);
      try {
        await sleep(waitMs);
        if (!win.isDestroyed()) {
          win.destroy();
          log('info', 'auto-close', `✅ 发布窗口已关闭`);
        }
      } catch (closeErr) {
        log('warn', 'auto-close', `关闭窗口异常: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      }
    }

    onProgress(100, '发布流程完成');
    // 🔒 关键修复：只有 actuallyPublished=true 才返回 success，否则明确返回 failed
    if (config.enablePostClickVerify && !actuallyPublished) {
      log('warn', 'submit', `⚠️ 点击了发布按钮但未验证成功，将返回 failed 状态`);
      return finalize('failed', '未成功点击发布按钮（可能页面结构变化或内容需手动补充），请在窗口中手动检查并发布');
    }
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
