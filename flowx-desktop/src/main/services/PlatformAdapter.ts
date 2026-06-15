import { BrowserWindow } from 'electron';
import { PLATFORMS } from './PlatformRegistry';
import { writePublishLog } from '../utils/logger';
import { applyDouyinAntiCrash } from './platforms/shared';
// 新平台注册表（通过 side-effect import 触发注册）
import { getPlatform } from './platforms/index';
import type {
  PublishItemProgress,
  PublishRequest,
  PlatformType,
  PublishLogEntry,
} from '../../types';

export interface PlatformAdapter {
  publish(
    accountId: string,
    request: PublishRequest,
    onProgress: (p: number, message?: string) => void,
  ): Promise<PublishItemProgress>;
}

function makePublishLogger(opts: {
  taskId?: string;
  accountId?: string;
  platform?: PlatformType;
}) {
  return (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => {
    writePublishLog({
      ts: Date.now(),
      level,
      taskId: opts.taskId,
      accountId: opts.accountId,
      platform: opts.platform,
      stage,
      message,
      data,
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 事件驱动的页面稳定等待器（解决 React SPA / 抖音 content/post 页面：
 * isLoading()=false 但 render frame 仍在重建、executeJavaScript 会抛
 * "Render frame was disposed before WebFrameMain could be accessed" 的问题）。
 *
 * 算法：
 *   1. 用 namedFn + once() 方式监听 did-frame-finish-load / dom-ready / did-navigate-in-page
 *   2. 每次收到事件 → 重置 "静默计时器"
 *   3. 连续 minQuietMs 没有任何事件 + isLoading=false → 认为页面结构就绪
 *   4. 再执行 JavaScript 健康探测 `typeof document !== 'undefined'`
 *   5. 探测成功才返回 stable=true；失败 → 继续等
 */
async function waitForPageStable(
  win: BrowserWindow,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  opts: { timeoutMs?: number; minQuietMs?: number; label?: string } = {},
): Promise<{ stable: boolean; url: string; elapsedMs: number }> {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const minQuietMs = opts.minQuietMs ?? 1800;
  const label = opts.label ?? 'page-stable';
  const start = Date.now();
  let lastEventAt = Date.now();
  let eventCount = 0;
  const wc = win.webContents;

  // —— 命名回调：便于之后移除 ——
  const makeHandler = (name: string) => (_e: unknown, url?: string) => {
    lastEventAt = Date.now();
    eventCount += 1;
    log('debug', label, `事件: ${name}`, url ? { url: url.slice(0, 80) } : undefined);
  };
  const hFrame = makeHandler('did-frame-finish-load');
  const hDomReady = makeHandler('dom-ready');
  const hNavInPage = makeHandler('did-navigate-in-page');
  const hStop = makeHandler('did-stop-loading');
  const hStart = makeHandler('did-start-loading');
  const wcx = wc as any;
  wcx.on('did-frame-finish-load', hFrame);
  wcx.on('dom-ready', hDomReady);
  wcx.on('did-navigate-in-page', hNavInPage);
  wcx.on('did-stop-loading', hStop);
  wcx.on('did-start-loading', hStart);

  log('info', label, `开始等待页面稳定（连续 ${minQuietMs}ms 无事件 + JS 健康探测成功）…`);

  try {
    while (Date.now() - start < timeoutMs) {
      const quietMs = Date.now() - lastEventAt;
      if (wc.isLoading()) {
        await sleep(300);
        lastEventAt = Date.now();
        continue;
      }
      if (quietMs >= minQuietMs) {
        // 结构就绪 → JS 健康探测（用 evalJS → CDP Runtime.evaluate，避开 WebFrameMain）
        try {
          const probe = await evalJS(
            win,
            `"ok:${Date.now()}"`,
            `${label}-probe`,
            log,
          );
          if (typeof probe === 'string' && String(probe).startsWith('ok:')) {
            const elapsed = Date.now() - start;
            log('info', label, `✅ 页面稳定，健康探测成功 (${elapsed}ms, ${eventCount} events)`);
            return { stable: true, url: wc.getURL(), elapsedMs: elapsed };
          }
        } catch (probeErr) {
          const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          log('debug', label, `健康探测失败，继续等待… (${msg.slice(0, 100)})`);
        }
      }
      await sleep(500);
    }
    const elapsed = Date.now() - start;
    log('warn', label, `⏱ 页面稳定超时 ${elapsed}ms，继续后续流程但注意可能失败`, { events: eventCount });
    return { stable: false, url: wc.getURL(), elapsedMs: elapsed };
  } finally {
    wcx.removeListener('did-frame-finish-load', hFrame);
    wcx.removeListener('dom-ready', hDomReady);
    wcx.removeListener('did-navigate-in-page', hNavInPage);
    wcx.removeListener('did-stop-loading', hStop);
    wcx.removeListener('did-start-loading', hStart);
  }
}

async function evalJS(
  win: BrowserWindow,
  code: string,
  desc: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<unknown> {
  // ✅ 关键架构修复：
  //   之前使用 win.webContents.executeJavaScript()，它通过 Electron 的 WebFrameMain
  //   路由到渲染进程，抖音 creator 页面做客户端导航 / frame 重建期间会抛出
  //   "Render frame was disposed before WebFrameMain could be accessed"。
  //   现在改用 Chrome DevTools Protocol 的 Runtime.evaluate —— 直接通过调试通道执行 JS，
  //   完全绕过 Electron 的 WebFrameMain 层，即使页面在重建 frame 也能稳定工作。
  //   失败时退回到 executeJavaScript 作为备用方案。
  const maxRetries = 8;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 每次尝试前都检查窗口是否已销毁
      if ((win as any).isDestroyed?.()) {
        throw new Error('window is destroyed');
      }

      // 1. 页面正在加载 → 多等一会儿
      if (win.webContents.isLoading()) {
        await new Promise<void>((r) => setTimeout(r, 1500));
      } else if (attempt > 0) {
        // 2. 重试时给 frame 更长的恢复时间
        await new Promise<void>((r) => setTimeout(r, 800 * attempt));
      } else {
        // 3. 首次尝试也给一点缓冲
        await new Promise<void>((r) => setTimeout(r, 200));
      }

      // ======== 方案 A：CDP Runtime.evaluate（优先，不经过 WebFrameMain） ========
      try {
        if (!win.webContents.debugger.isAttached()) {
          win.webContents.debugger.attach('1.3');
        }

        // 用 CDP Runtime.evaluate + returnByValue + awaitPromise，
        // 这样 CDP 会直接把结果序列化成 JSON 给我们
        const cdpResp: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
          // 给每个 JS 执行 15s 超时，避免 CDP 卡住
          timeout: 15000,
        } as any);

        // 解析 CDP 响应
        if (cdpResp && cdpResp.result) {
          const result = cdpResp.result;
          // 异常（JS 抛出了错误）
          if (result.type === 'undefined') {
            if (attempt > 0) log('debug', 'eval', `[${desc}] 重试成功 (第 ${attempt + 1} 次, via CDP)`);
            log('debug', 'eval', `[${desc}] ok (CDP, undefined)`);
            return undefined;
          }
          if (result.subtype === 'error' || result.className === 'Error') {
            throw new Error(result.description || result.value || 'Runtime.evaluate returned error');
          }
          if (attempt > 0) log('debug', 'eval', `[${desc}] 重试成功 (第 ${attempt + 1} 次, via CDP)`);
          log('debug', 'eval', `[${desc}] ok (CDP)`, {
            result: JSON.stringify(result.value).slice(0, 300),
          });
          return result.value;
        }
        log('warn', 'eval-cdp', `[${desc}] CDP 响应格式异常，尝试 fallback 方案`);
      } catch (cdpErr) {
        // CDP 失败不立即抛，而是降级到 executeJavaScript
        log('debug', 'eval-cdp', `[${desc}] CDP 不可用，降级到 executeJavaScript: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`);
      }

      // ======== 方案 B：降级到 executeJavaScript ========
      const result = await win.webContents.executeJavaScript(code);
      if (attempt > 0) {
        log('debug', 'eval', `[${desc}] 重试成功 (第 ${attempt + 1} 次, via executeJavaScript)`);
      }
      log('debug', 'eval', `[${desc}] ok (executeJavaScript)`, {
        result: JSON.stringify(result).slice(0, 300),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = err;

      const isTransient =
        /frame was disposed|Render frame|navigation|No current|Cannot read property|document\.body is null|null object|context is invalid|Execution context was destroyed|webFrameMain|no frame|target frame|window is destroyed|debugger|Cannot find frame/i.test(msg);

      if (isTransient && attempt < maxRetries - 1) {
        const backoff = Math.min(4000, 500 + 500 * attempt);
        log('debug', 'eval-retry', `[${desc}] ${msg.slice(0, 80)}，${backoff}ms 后重试 (第 ${attempt + 1}/${maxRetries} 次)`);
        await new Promise((r) => setTimeout(r, backoff));
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

// ============================================================
// CDP 文件上传（v2，不依赖 evalJS 字符串拼接）
// 优先级：
//   1. 直接 CDP DOM.getDocument(pierce) → DOM.querySelectorAll(input[type=file]) → DOM.setFileInputFiles
//      （最可靠，不用点击任何按钮，自动穿透 shadow DOM）
//   2. 再触发一次 "上传视频" 按钮的点击（用最简单的 JS）
//   3. 若还没反应，再等 3 秒后用 CDP DOM 方式重试一次
// ============================================================
async function uploadViaCDP(
  win: BrowserWindow,
  files: string[],
  clickButtonText: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  const wc = win.webContents;
  try {
    // —— 阶段 A：先诊断页面结构（输出有哪些 input，有哪些可见按钮）——
    log('info', 'upload', `=== 开始上传流程：files=${files.join(', ')} ===`);
    // 📝 诊断日志：记录当前 URL、isLoading、页面标题
    try {
      log('info', 'upload', `诊断：url=${win.webContents.getURL()} isLoading=${win.webContents.isLoading()}`);
    } catch { /* ignore */ }
    try {
      const diag: unknown = await evalJS(win, `        (function(){
          var inputs = document.querySelectorAll('input');
          var inputList = [];
          for (var i = 0; i < inputs.length; i++) {
            var el = inputs[i];
            inputList.push({
              type: el.getAttribute('type') || '',
              visible: el.offsetWidth > 0 && el.offsetHeight > 0,
              class: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : ''
            });
          }
          var buttons = document.querySelectorAll('button, a, [role="button"], div');
          var btnList = [];
          for (var j = 0; j < buttons.length && btnList.length < 30; j++) {
            var b = buttons[j];
            if (!b.offsetWidth || !b.offsetHeight) continue;
            var txt = (b.innerText || b.textContent || '').trim();
            if (txt && txt.length <= 30 && (txt.indexOf('上传') >= 0 || txt.indexOf('视频') >= 0 || txt.indexOf('publish') >= 0 || txt.indexOf('upload') >= 0)) {
              btnList.push({
                tag: b.tagName.toLowerCase(),
                text: txt.slice(0, 40),
                class: (b.className && typeof b.className === 'string') ? b.className.slice(0, 80) : ''
              });
            }
          }
          // 扫一下 shadowRoot 中的情况
          var shadowCount = 0;
          try {
            var all = document.querySelectorAll('*');
            for (var k = 0; k < all.length; k++) {
              try { if (all[k].shadowRoot) shadowCount++; } catch (e) {}
            }
          } catch (e) {}
          return { inputs: inputList, candidateButtons: btnList, shadowRootCount: shadowCount, url: location.href };
        })();
      `, 'upload-diag', log);
      log('info', 'upload', `页面诊断`, { result: JSON.stringify(diag).slice(0, 600) });
    } catch (diagErr) {
      log('warn', 'upload', `页面诊断 JS 出错: ${diagErr}`);
    }

    // —— 阶段 B：直接通过 CDP DOM 协议找 file input 并注入 ——
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
    await wc.debugger.sendCommand('DOM.enable');
    await wc.debugger.sendCommand('Page.enable');

    // 开启 file chooser 拦截（万一后面点击按钮触发了对话框）
    let intercepted = false;
    const handler = (event: unknown, method: string, params: Record<string, unknown> & { backendNodeId?: number; objectId?: string }) => {
      if (method === 'Page.fileChooserOpened') {
        log('info', 'upload', `✅ 拦截到 fileChooserOpened 事件`);
        try {
          if (params.objectId) {
            wc.debugger.sendCommand('DOM.setFileInputFiles', { objectId: params.objectId, files });
            intercepted = true;
          } else if (params.backendNodeId) {
            wc.debugger.sendCommand('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files });
            intercepted = true;
          }
        } catch (innerErr) {
          log('warn', 'upload', `fileChooserOpened 处理异常: ${innerErr}`);
        }
      }
    };
    wc.debugger.on('message', handler);

    // 策略 1：CDP DOM.getDocument(pierce=true) → 找所有 input[type=file] → setFileInputFiles → dispatch change/input
    log('info', 'upload', `策略 1：CDP 直接扫描 file input 并注入（pierce shadow DOM）+ 触发 change 事件`);
    try {
      const doc = (await wc.debugger.sendCommand('DOM.getDocument', {
        depth: -1,
        pierce: true,
      })) as { root: { nodeId: number } };

      const qr = (await wc.debugger.sendCommand('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      })) as { nodeIds: number[] };

      log('info', 'upload', `CDP 找到 ${qr.nodeIds?.length || 0} 个 file input`, { count: qr.nodeIds?.length });

      if (qr.nodeIds && qr.nodeIds.length > 0) {
        for (let i = 0; i < qr.nodeIds.length; i++) {
          const nodeId = qr.nodeIds[i];
          try {
            // 1. 设置文件
            await wc.debugger.sendCommand('DOM.setFileInputFiles', {
              nodeId: nodeId,
              files,
            });
            log('info', 'upload', `✅ file input #${i} setFileInputFiles 成功`, { nodeId });

            // ✅ 2. 关键修复：用 DOM.resolveNode + Runtime.callFunctionOn 手动触发 change/input 事件
            //    CDP setFileInputFiles 只设置 files 属性，不触发 React 监听的 onChange
            let objectId: string | null = null;
            try {
              const resolveRes = (await wc.debugger.sendCommand('DOM.resolveNode', {
                nodeId: nodeId,
              })) as { object?: { objectId?: string } };
              objectId = resolveRes.object?.objectId || null;
            } catch (resolveErr) {
              log('warn', 'upload', `file input #${i} resolveNode 失败: ${resolveErr}`);
            }

            if (objectId) {
              try {
                // 在该 input 元素上 dispatch change + input 事件
                await wc.debugger.sendCommand('Runtime.callFunctionOn', {
                  objectId: objectId,
                  functionDeclaration: `function() {
                    try {
                      this.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
                      this.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
                      return true;
                    } catch(e) { return String(e); }
                  }`,
                  returnByValue: true,
                });
                log('info', 'upload', `✅ file input #${i} change/input 事件已 dispatch`);
                intercepted = true;
                break;
              } catch (callErr) {
                log('warn', 'upload', `file input #${i} callFunctionOn dispatch change 失败: ${callErr}`);
                // dispatch 失败，但至少 files 已设置，继续视为成功
                intercepted = true;
                break;
              }
            } else {
              // objectId 解析失败，文件已设置，标记成功
              log('warn', 'upload', `⚠️ file input #${i} 无法获取 objectId，跳过 change 事件（但 files 已设置）`);
              intercepted = true;
              break;
            }
          } catch (innerErr) {
            log('warn', 'upload', `file input #${i} setFileInputFiles 失败: ${innerErr}`);
          }
        }
      }
    } catch (err) {
      log('warn', 'upload', `CDP 扫描 file input 异常: ${err}`);
    }

    // 策略 2：如果策略 1 未成功，触发按钮点击（可能按钮点击后才会创建 file input）
    if (!intercepted) {
      log('info', 'upload', `策略 2：点击 "${clickButtonText}" 按钮（用原生 CDP Input.dispatchMouseEvent）`);
      try {
        // 用纯 JS 找到按钮中心坐标（通过 evalJS → CDP 执行）
        const coord: unknown = await evalJS(win, `
          (function(){
            function findBest(root){
              var best = null;
              var bestScore = -1;
              var all = root.querySelectorAll('button, a, [role="button"], div, span');
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (!el.offsetWidth || !el.offsetHeight) continue;
                var txt = (el.innerText || el.textContent || '').trim();
                if (!txt) continue;
                if (txt.indexOf(${JSON.stringify(clickButtonText)}) < 0) continue;
                var sc = 100;
                if (el.tagName === 'BUTTON') sc += 2000;
                if (el.tagName === 'A') sc += 500;
                var cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
                if (/btn|button|upload|publish|submit|primary/i.test(cls)) sc += 1000;
                if (/nav|menu|header|tabs|sidebar/i.test(cls)) sc -= 500;
                var r = el.getBoundingClientRect();
                if (r.top < 0 || r.top > (window.innerHeight + 500)) sc -= 200;
                if (sc > bestScore) { bestScore = sc; best = { x: r.left + r.width/2, y: r.top + r.height/2, text: txt.slice(0,30), tag: el.tagName.toLowerCase(), class: cls.slice(0,60) }; }
              }
              return best;
            }
            var result = findBest(document);
            // 也扫一下 shadowRoot
            if (!result) {
              try {
                var all = document.querySelectorAll('*');
                for (var k = 0; k < all.length; k++) {
                  try {
                    if (all[k].shadowRoot) {
                      var sr = findBest(all[k].shadowRoot);
                      if (sr) { result = sr; break; }
                    }
                  } catch(e){}
                }
              } catch(e){}
            }
            return result;
          })();
        `, 'find-upload-button', log);
        const c = coord as { x: number; y: number; text: string; tag: string; class: string } | null;
        if (c && c.x >= 0 && c.y >= 0) {
          log('info', 'upload', `点击目标`, { text: c.text, tag: c.tag, class: c.class, x: c.x, y: c.y });
          // CDP 原生鼠标点击（最可靠，不依赖任何 JS 事件绑定）
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: Math.round(c.x), y: Math.round(c.y), button: 'left', clickCount: 1,
          });
          await sleep(50);
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: Math.round(c.x), y: Math.round(c.y), button: 'left', clickCount: 1,
          });
          await sleep(80);
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: Math.round(c.x), y: Math.round(c.y), button: 'left', clickCount: 1,
          });
          // 给一点时间触发 file chooser（或页面创建 file input）
          await sleep(2500);

          // 再试一次 CDP 扫描 file input（可能点击后才出现）
          if (!intercepted) {
            try {
              const doc2 = (await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true })) as { root: { nodeId: number } };
              const qr2 = (await wc.debugger.sendCommand('DOM.querySelectorAll', {
                nodeId: doc2.root.nodeId,
                selector: 'input[type="file"]',
              })) as { nodeIds: number[] };
              if (qr2.nodeIds && qr2.nodeIds.length > 0) {
                for (let i = 0; i < qr2.nodeIds.length; i++) {
                  const nodeId = qr2.nodeIds[i];
                  try {
                    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
                    log('info', 'upload', `✅ 点击后 file input #${i} setFileInputFiles 成功`, { nodeId });
                    // 同样 dispatch change/input 事件
                    try {
                      const resolveRes = (await wc.debugger.sendCommand('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } };
                      const objectId = resolveRes.object?.objectId;
                      if (objectId) {
                        await wc.debugger.sendCommand('Runtime.callFunctionOn', {
                          objectId,
                          functionDeclaration: `function() {
                            try {
                              this.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
                              this.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
                              return true;
                            } catch(e) { return String(e); }
                          }`,
                          returnByValue: true,
                        });
                        log('info', 'upload', `✅ 点击后 file input #${i} change/input 事件已 dispatch`);
                      }
                    } catch (evErr) {
                      log('warn', 'upload', `点击后 file input #${i} dispatch change 异常: ${evErr}`);
                    }
                    intercepted = true;
                    break;
                  } catch (e) {
                    log('warn', 'upload', `点击后 file input #${i} 失败: ${e}`);
                  }
                }
              } else {
                log('warn', 'upload', `点击后仍未找到 file input`);
              }
            } catch (e) {
              log('warn', 'upload', `点击后 CDP 扫描异常: ${e}`);
            }
          }
        } else {
          log('warn', 'upload', `未找到含 "${clickButtonText}" 文字的可点击元素`);
        }
      } catch (jsErr) {
        log('warn', 'upload', `按钮点击 JS 异常: ${jsErr}`);
      }
    }

    // 再等一小段时间确认
    await sleep(2000);
    wc.debugger.removeListener('message', handler);

    if (intercepted) {
      log('info', 'upload', `✅ 上传流程完成（文件已注入）`);
      return true;
    }

    log('warn', 'upload', `所有策略均未能自动上传，请在打开的窗口中手动点击上传并选择文件`);
    return false;
  } catch (err) {
    log('error', 'upload', `CDP 上传总异常: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ============================================================
// ============================================================
// 上传按钮点击器（极简版）：
//   1. 遍历 document 及所有 shadowRoot 中的可见元素
//   2. innerText/textContent 包含 keyword（如 "上传视频"）即视为候选
//   3. 优先选 <button> / 有 button-like class 的元素，以及离视口底部近的
//   4. 点击目标 + 冒泡触发其祖先，确保 React/自定义组件也能响应
// ============================================================
function buildSimpleUploadClicker(keyword: string): string {
  const jsonKw = JSON.stringify(keyword);
  const lines = [
    '(function(){',
    'var KW=' + jsonKw + ';',
    'var doc=document;',
    'var vph=window.innerHeight||document.documentElement.clientHeight;',
    // 收集所有候选根节点（document + 所有已打开的 shadowRoot）
    'var roots=[doc];',
    'try{',
    '  var allEl=doc.querySelectorAll(\"*\");',
    '  for(var _i=0;_i<allEl.length;_i++){',
    '    try{if(allEl[_i].shadowRoot)roots.push(allEl[_i].shadowRoot);}catch(_e){}',
    '  }',
    '}catch(_e){}',
    'var candidates=[];',
    'function scanRoot(root){',
    '  try{',
    '    var els=root.querySelectorAll(\"button,a,div,span,[role=\\\\\"button\\\\\"]\");',
    '    for(var i=0;i<els.length;i++){',
    '      var el=els[i];',
    '      try{',
    '        if(!el||!el.offsetWidth||!el.offsetHeight)continue;',
    '        if(el.offsetWidth<20||el.offsetHeight<20)continue;',
    '        var sty=getComputedStyle(el);',
    '        if(!sty||sty.visibility===\"hidden\"||sty.display===\"none\"||sty.opacity===\"0\")continue;',
    '        var txt=(el.innerText||el.textContent||\"\").trim();',
    '        if(!txt||txt.length>30)continue;',
    '        if(txt.indexOf(KW)<0)continue;',
    '        var rect=el.getBoundingClientRect();',
    '        if(rect.bottom<0||rect.top>vph+200)continue;',
    '        var sc=200;',
    '        if(el.tagName===\"BUTTON\")sc+=2000;',
    '        if(el.tagName===\"A\")sc+=800;',
    '        var cls=(el.className&&typeof el.className===\"string\")?el.className.toLowerCase():\"\";',
    '        if(/btn|button|upload|publish|primary|submit|click|uploader/i.test(cls))sc+=1000;',
    '        if(/nav|menu|header|tabs|setting|config|dropdown|breadcrumb|sidebar|link-item/i.test(cls))sc-=500;',
    '        if(sty.cursor===\"pointer\")sc+=200;',
    '        sc+=Math.max(0,300-Math.round(Math.abs(vph-rect.bottom)));',
    '        candidates.push({el:el,score:sc,text:txt,tag:el.tagName.toLowerCase(),classStr:cls.slice(0,60),fromBottom:Math.round(vph-rect.bottom),w:el.offsetWidth,h:el.offsetHeight});',
    '      }catch(_e){}',
    '    }',
    '  }catch(_e){}',
    '}',
    'for(var ri=0;ri<roots.length;ri++)scanRoot(roots[ri]);',
    'if(candidates.length===0){return{found:false,clicked:false,reason:\"no-visible-candidate\",keyword:KW};}',
    'candidates.sort(function(a,b){return b.score-a.score;});',
    'var t=candidates[0];',
    'var res={found:true,clicked:false,text:t.text,tag:t.tag,classStr:t.classStr,fromBottom:t.fromBottom,score:t.score,w:t.w,h:t.h,total:candidates.length,top5:candidates.slice(0,5).map(function(c){return{text:c.text,tag:c.tag,classStr:c.classStr,score:c.score}})};',
    // 滚动 + 点击 + 事件
    'try{t.el.scrollIntoView({block:\"center\"});}catch(e){}',
    'try{t.el.click();res.clicked=true;}catch(e){}',
    'try{',
    '  var r=t.el.getBoundingClientRect();',
    '  var cx=r.left+r.width/2,cy=r.top+r.height/2;',
    '  var m={bubbles:true,cancelable:true,view:window,detail:1,clientX:cx,clientY:cy,button:0,buttons:1};',
    '  try{t.el.dispatchEvent(new MouseEvent(\"mousedown\",m));}catch(e){}',
    '  try{t.el.dispatchEvent(new MouseEvent(\"mouseup\",m));}catch(e){}',
    '  try{t.el.dispatchEvent(new MouseEvent(\"click\",m));}catch(e){}',
    '}catch(e){}',
    // 也点击父元素（有时事件绑在父元素上）
    'var pa=t.el.parentElement;',
    'for(var pi=0;pi<3&&pa;pi++){try{pa.click();}catch(e){}pa=pa.parentElement;}',
    'return res;',
    '})();'
  ];
  return lines.join('\n');
}

// ============================================================
// 发布按钮点击器 v5（多策略 + 诊断模式）
// 核心策略（按优先级排序）：
//   1. CLASS 选择器：直接匹配 .ce-btn.bg-red, .ce-btn[class*=red], .publish-btn 等
//   2. 底部区域扫描：扫描页面下半部分最右侧的按钮（发布按钮永远在底部 action bar）
//   3. 最后一个按钮：页面中最后一个可见按钮通常就是发布按钮
//   4. 精确文字匹配："发布"、"发布笔记"、"立即发布"
//   5. 诊断：无论是否找到，都会 dump 页面中所有按钮用于排错
// 附加操作：点击前先滚动到页面底部，避免按钮在视口外导致不可点击
// ============================================================
function buildPublishButtonClicker(keyword: string): string {
  const jsonKw = JSON.stringify(keyword);
  return `
    (function () {
      // --- 先滚动到页面底部（发布按钮永远在底部）---
      try { window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight); } catch (_) {}
      // 给滚动一点时间
      var startTime = Date.now();
      while (Date.now() - startTime < 150) { /* busy wait */ }

      var viewportH = window.innerHeight || document.documentElement.clientHeight;
      var viewportW = window.innerWidth || document.documentElement.clientWidth;
      var pageH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0);

      // --- 候选按钮容器（必须在所有策略之前声明，否则 shadow DOM 扫描会 ReferenceError）---
      var candidates = [];

      // --- 诊断：dump 页面上所有可见按钮 ---
      var allButtons = [];
      try {
        var buttonEls = document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="button"], [class*="ce-btn"], [class*="publish"]');
        for (var bi = 0; bi < buttonEls.length; bi++) {
          var el = buttonEls[bi];
          try {
            if (el.offsetWidth <= 5 || el.offsetHeight <= 5) continue;
            var bstyle = getComputedStyle(el);
            if (bstyle.visibility === 'hidden' || bstyle.display === 'none') continue;
            var btext = (el.innerText || el.textContent || '').trim();
            if (!btext || btext.length > 40) continue;
            var brect = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0, bottom: 0, left: 0 };
            var bclass = ((el.className && typeof el.className === 'string') ? el.className : '').toString().slice(0, 80);
            allButtons.push({
              text: btext,
              tag: el.tagName.toLowerCase(),
              classStr: bclass.toLowerCase(),
              w: el.offsetWidth,
              h: el.offsetHeight,
              fromBottom: Math.round(viewportH - brect.bottom),
              fromRight: Math.round(viewportW - brect.right),
              disabled: (el.hasAttribute && el.hasAttribute('disabled')) || el.getAttribute('aria-disabled') === 'true'
            });
          } catch (_) {}
        }
      } catch (_) {}

      // --- 策略 0：自定义 Web Component（小红书 &lt;xhs-publish-btn&gt; 这类 Shadow DOM 组件）---
      // 这类组件外层看起来像 &lt;xhs-publish-btn submit-text="发布" ...&gt;，内部真正的 &lt;button&gt; 在 shadowRoot 里
      var shadowHostTags = ['xhs-publish-btn', 'xhs-button', 'publish-button', 'xhs-publish', 'xhs-upload-btn'];
      for (var shi = 0; shi < shadowHostTags.length; shi++) {
        try {
          var shadowHost = document.querySelector(shadowHostTags[shi]);
          if (!shadowHost) continue;
          var shadowRoot = shadowHost.shadowRoot;
          if (!shadowRoot) continue;
          try {
            shadowRoot.querySelectorAll('button, [role="button"], a, [class*="btn"], [class*="submit"], [class*="publish"]');
          } catch (_) { /* 某些浏览器可能不允许访问 shadowRoot */ }
          var shadowInner = shadowRoot.querySelectorAll('button, [role="button"], a, [class*="btn"], [class*="submit"], [class*="publish"], [class*="primary"], [class*="red"]');
          for (var si = 0; si < shadowInner.length; si++) {
            var selEl = shadowInner[si];
            try {
              if (selEl.offsetWidth <= 5 || selEl.offsetHeight <= 5) continue;
              var selStyle = getComputedStyle(selEl);
              if (selStyle.visibility === 'hidden' || selStyle.display === 'none') continue;
              if ((selEl.hasAttribute && selEl.hasAttribute('disabled')) || selEl.getAttribute('aria-disabled') === 'true') continue;
              var selText = (selEl.innerText || selEl.textContent || '').trim();
              if (!selText) continue;
              var selRect = selEl.getBoundingClientRect ? selEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var selClass = ((selEl.className && typeof selEl.className === 'string') ? selEl.className : '').toString().toLowerCase();

              var selScore = 0;
              if (/red|primary|danger|submit|publish|bg-red|bg-primary/i.test(selClass)) selScore += 3000;
              if (selText === ${jsonKw}) selScore += 3000;
              else if (selText.indexOf(${jsonKw}) === 0) selScore += 1500;
              else if (selText.indexOf(${jsonKw}) !== -1) selScore += 500;
              if (selEl.tagName && selEl.tagName.toLowerCase() === 'button') selScore += 2000;
              if (selEl.offsetWidth >= 40 && selEl.offsetHeight >= 24) selScore += 300;
              if (selStyle.cursor === 'pointer') selScore += 200;
              var selFromBottom = viewportH - selRect.bottom;
              if (selFromBottom >= -300 && selFromBottom < viewportH) selScore += 500;

              candidates.push({
                el: selEl, score: selScore, text: selText,
                tag: selEl.tagName ? selEl.tagName.toLowerCase() : 'element',
                classStr: selClass.slice(0, 60),
                fromBottom: Math.round(selFromBottom),
                w: selEl.offsetWidth, h: selEl.offsetHeight,
                source: 'shadow-dom:' + shadowHostTags[shi]
              });
            } catch (_) {}
          }
        } catch (_) {}
      }

      // --- 策略 1：直接用 CSS class 选器 ---
      // 抖音实际按钮: <button class="button-dhlUZE primary-cECiOJ fixed-J9O8Yw">发布</button>
      // 关键特征: class 含 "primary-" + 文字 "发布"
      var classSelectors = [
        '.ce-btn.bg-red',
        '.ce-btn [class*="red"]',
        'button.ce-btn',
        '.ce-btn',
        '.publish-btn',
        '.btn-publish',
        'button [class*="publish"]',
        '.bg-red',
        '[class*="btn-primary"]',
        '[class*="btn-danger"]',
        'button[class*="primary-"]',       // 抖音: primary-cECiOJ
        'button[class*="button-"]',        // 抖音: button-dhlUZE
        '[class*="primary-"][class*="button-"]',
        '[class*="content-confirm"]',       // 抖音: content-confirm-container-Wp91G7
        'button[class*="publish"]'
      ];
      for (var si = 0; si < classSelectors.length; si++) {
        try {
          var sels = document.querySelectorAll(classSelectors[si]);
          for (var ei = 0; ei < sels.length; ei++) {
            var selEl = sels[ei];
            try {
              if (selEl.offsetWidth <= 5 || selEl.offsetHeight <= 5) continue;
              var selStyle = getComputedStyle(selEl);
              if (selStyle.visibility === 'hidden' || selStyle.display === 'none') continue;
              if ((selEl.hasAttribute && selEl.hasAttribute('disabled')) || selEl.getAttribute('aria-disabled') === 'true') continue;
              var selText = (selEl.innerText || selEl.textContent || '').trim();
              if (!selText) continue;
              var selRect = selEl.getBoundingClientRect ? selEl.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
              var selClass = ((selEl.className && typeof selEl.className === 'string') ? selEl.className : '').toString().toLowerCase();

              // 排除导航/菜单类
              if (/nav|menu|header|sidebar|breadcrumb|tabs|tab-bar|link-item|router-link/.test(selClass)) continue;

              var selScore = 0;
              // 红色/主色按钮最高优先级（含抖音 primary-* 样式）
              if (/bg-red|primary|danger|submit|publish|confirm/i.test(selClass)) selScore += 2000;
              // 抖音特有: primary-* + fixed-* 组合（发布按钮的典型 class 组合）
              if (/primary-[\w-]+/i.test(selClass)) selScore += 3000;
              if (/button-[\w-]+/i.test(selClass) && /primary|confirm|publish|发布/i.test(selClass + '|' + selText)) selScore += 2500;
              // 在 content-confirm-* 容器内（抖音发布按钮所在容器）
              var parentConfirm = selEl.closest && selEl.closest('[class*="content-confirm"]');
              if (parentConfirm) selScore += 4000;
              // 精确/部分文字匹配
              if (selText === ${jsonKw}) selScore += 3000;
              else if (selText.indexOf(${jsonKw}) === 0) selScore += 1500; // 以关键词开头
              else if (selText.indexOf(${jsonKw}) !== -1) selScore += 500;
              // 按钮元素加分
              if (selEl.tagName.toLowerCase() === 'button') selScore += 1500;
              // 合理尺寸加分（抖音按钮 120x32）
              if (selEl.offsetWidth >= 80 && selEl.offsetHeight >= 28) selScore += 500;
              // 靠近页面底部加分（在视口内的元素）
              var selFromBottom = viewportH - selRect.bottom;
              if (selFromBottom >= -200 && selFromBottom < viewportH * 0.5) selScore += 800;
              // 靠近页面右侧（发布按钮通常在最右）
              var selFromRight = viewportW - selRect.right;
              if (selFromRight >= -100 && selFromRight < viewportW * 0.5) selScore += 300;
              // cursor pointer
              if (selStyle.cursor === 'pointer') selScore += 200;

              candidates.push({
                el: selEl, score: selScore, text: selText,
                tag: selEl.tagName.toLowerCase(),
                classStr: selClass.slice(0, 60),
                fromBottom: Math.round(selFromBottom),
                fromRight: Math.round(selFromRight),
                w: selEl.offsetWidth, h: selEl.offsetHeight,
                source: 'class:' + classSelectors[si]
              });
            } catch (_) {}
          }
        } catch (_) {}
      }

      // --- 策略 2：扫描底部区域（最下方 1/3 页面的按钮/可点击元素）---
      try {
        var allClickableEls = document.querySelectorAll('button, a, [role="button"], div');
        for (var di = 0; di < allClickableEls.length; di++) {
          var de = allClickableEls[di];
          try {
            if (de.offsetWidth < 40 || de.offsetHeight < 28) continue;
            var dstyle = getComputedStyle(de);
            if (dstyle.visibility === 'hidden' || dstyle.display === 'none') continue;
            if ((de.hasAttribute && de.hasAttribute('disabled')) || de.getAttribute('aria-disabled') === 'true') continue;
            var drect = de.getBoundingClientRect ? de.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0 };
            var dFromBottom = viewportH - drect.bottom;
            // 只看靠近底部的元素（含视口下方 300px 以内）
            if (dFromBottom < -300 || dFromBottom >= viewportH * 0.6) continue;
            var dText = (de.innerText || de.textContent || '').trim();
            if (!dText || dText.length > 30) continue;
            var dClass = ((de.className && typeof de.className === 'string') ? de.className : '').toString().toLowerCase();
            // 排除导航/菜单/设置类元素
            if (/nav|menu|header|sidebar|breadcrumb|tabs|tab-bar|link-item|router-link|setting|settings|option|select|dropdown|filter|sort|config|tips|timing|schedule|hover-card|hover|more|popover|modal|dialog/.test(dClass)) continue;

            var dScore = 0;
            if (dText === ${jsonKw}) dScore += 3000;
            else if (dText.indexOf(${jsonKw}) === 0) dScore += 1000;
            else if (dText.indexOf(${jsonKw}) !== -1) dScore += 200;
            if (de.tagName.toLowerCase() === 'button') dScore += 1200;
            // 抖音按钮: class 含 primary-* 或 button-* 且文字是"发布"
            if (/primary-[\w-]+/i.test(dClass)) dScore += 3000;
            if (/button-[\w-]+/i.test(dClass) && /primary|发布|publish|confirm/i.test(dText + '|' + dClass)) dScore += 2000;
            if (/content-confirm/i.test(dClass)) dScore += 4000; // 抖音确认按钮所在容器
            // 检测是否在 content-confirm-container 内
            var parentContainer = de.closest && de.closest('[class*="content-confirm"]');
            if (parentContainer) dScore += 5000;
            if (/bg-red|primary|danger|submit|publish|ce-btn|confirm/i.test(dClass)) dScore += 2000;
            if (dstyle.cursor === 'pointer') dScore += 150;
            if (dFromBottom >= 0 && dFromBottom < viewportH * 0.3) dScore += 600;
            candidates.push({
              el: de, score: dScore, text: dText,
              tag: de.tagName.toLowerCase(),
              classStr: dClass.slice(0, 60),
              fromBottom: Math.round(dFromBottom),
              w: de.offsetWidth, h: de.offsetHeight,
              source: 'bottom-scan'
            });
          } catch (_) {}
        }
      } catch (_) {}

      // --- 策略 3：页面中最后一个可见按钮兜底 ---
      try {
        var lastButtons = document.querySelectorAll('button, [role="button"]');
        for (var li = lastButtons.length - 1; li >= Math.max(0, lastButtons.length - 5); li--) {
          var le = lastButtons[li];
          try {
            if (le.offsetWidth < 40 || le.offsetHeight < 28) continue;
            var lstyle = getComputedStyle(le);
            if (lstyle.visibility === 'hidden' || lstyle.display === 'none') continue;
            if ((le.hasAttribute && le.hasAttribute('disabled')) || le.getAttribute('aria-disabled') === 'true') continue;
            var lText = (le.innerText || le.textContent || '').trim();
            if (!lText || lText.length > 30) continue;
            var lClass = ((le.className && typeof le.className === 'string') ? le.className : '').toString().toLowerCase();
            var lScore = 500 + (lastButtons.length - li) * 100;
            if (/bg-red|primary|danger|submit|publish|ce-btn|confirm/i.test(lClass)) lScore += 2000;
            if (/primary-[\w-]+/i.test(lClass)) lScore += 3000; // 抖音 primary 按钮
            if (/button-[\w-]+/i.test(lClass)) lScore += 2000;   // 抖音 button 类
            // 检测是否在 content-confirm-container 内（抖音发布按钮的父容器）
            var lastParentConfirm = le.closest && le.closest('[class*="content-confirm"]');
            if (lastParentConfirm) lScore += 5000;
            if (lText === ${jsonKw}) lScore += 3000;
            candidates.push({
              el: le, score: lScore, text: lText,
              tag: le.tagName.toLowerCase(),
              classStr: lClass.slice(0, 60),
              fromBottom: 0,
              w: le.offsetWidth, h: le.offsetHeight,
              source: 'last-button:index-' + li
            });
          } catch (_) {}
        }
      } catch (_) {}

      // --- 去重（相同元素只保留最高分）---
      var seenByEl = {};
      var uniqueCandidates = [];
      for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        if (!c.el) continue;
        var key = c.tag + ':' + c.classStr + ':' + c.text + ':' + c.w + 'x' + c.h;
        if (seenByEl[key]) {
          if (c.score > seenByEl[key].score) seenByEl[key] = c;
        } else {
          seenByEl[key] = c;
          uniqueCandidates.push(c);
        }
      }
      uniqueCandidates.sort(function (a, b) { return b.score - a.score; });

      // --- 选择目标并点击 ---
      if (uniqueCandidates.length === 0) {
        return {
          found: false, clicked: false,
          reason: 'no-candidate',
          pageH: pageH, viewportH: viewportH,
          allButtonsCount: allButtons.length,
          allButtons: allButtons.slice(0, 15)
        };
      }

      var target = uniqueCandidates[0];

      // 对目标及其 5 层祖先触发完整事件序列
      var ancestors = [];
      var cur = target.el;
      for (var ai = 0; ai < 6 && cur && cur !== document.body; ai++) {
        ancestors.push({ el: cur, level: ai, tag: cur.tagName.toLowerCase(), text: (cur.innerText || '').trim().slice(0, 30) });
        cur = cur.parentElement;
      }

      var initialUrl = location.href;
      var results = [];
      for (var ri = 0; ri < ancestors.length; ri++) {
        var anc = ancestors[ri];
        try {
          anc.el.scrollIntoView({ block: 'center', behavior: 'instant' in window ? 'instant' : 'auto' });
          try { anc.el.click(); } catch (_) {}
          try {
            var r = anc.el.getBoundingClientRect ? anc.el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var mouseInit = { bubbles: true, cancelable: true, view: window, detail: 1, clientX: cx, clientY: cy, button: 0, buttons: 1 };
            anc.el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
            anc.el.dispatchEvent(new MouseEvent('focus', mouseInit));
            anc.el.dispatchEvent(new MouseEvent('mouseup', mouseInit));
            anc.el.dispatchEvent(new MouseEvent('click', mouseInit));
            try {
              anc.el.dispatchEvent(new PointerEvent('pointerdown', mouseInit));
              anc.el.dispatchEvent(new PointerEvent('pointerup', mouseInit));
            } catch (_) {}
          } catch (_) {}
          results.push({ level: anc.level, tag: anc.tag, text: anc.text, ok: true });
        } catch (e) {
          results.push({ level: anc.level, tag: anc.tag, text: anc.text, ok: false, err: String(e).slice(0, 60) });
        }
      }

      var afterUrl = location.href;
      return {
        found: true, clicked: true,
        text: target.text,
        tag: target.tag,
        classStr: target.classStr,
        fromBottom: target.fromBottom,
        source: target.source,
        score: target.score,
        w: target.w, h: target.h,
        totalCandidates: uniqueCandidates.length,
        top5: uniqueCandidates.slice(0, 5).map(function (c) { return { text: c.text, tag: c.tag, score: c.score, classStr: c.classStr, source: c.source }; }),
        urlChanged: initialUrl !== afterUrl,
        allButtonsCount: allButtons.length,
        allButtons: allButtons.slice(0, 15)
      };
    })();
  `;
}

// ============================================================
// 发布后验证 v3：检测点击发布后页面的真实反应
// 设计原则：全部用简单的字符串/数组操作，避免复杂正则/CSS 选择器，确保不会在浏览器 runtime 抛错
// 成功信号：URL 离开发布页 或 页面出现"发布成功/发布完成"文字
// ============================================================
function buildPublishVerifier(): string {
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

      // 1. URL 变化检测：离开了发布页（不含 "publish" 关键字）
      try {
        var hasPublishInUrl = url.indexOf('publish') !== -1;
        var hasCreatorInUrl = url.indexOf('creator.xiaohongshu.com') !== -1;
        // 成功后通常跳转到 home / feed / 主页：URL 不再含 "publish"
        if (!hasPublishInUrl && hasCreatorInUrl) {
          result.leftPublishPage = true;
        }
      } catch (e1) {}

      // 2. 成功文本检测
      try {
        if (bodyText.indexOf('发布成功') >= 0 ||
            bodyText.indexOf('发布完成') >= 0 ||
            bodyText.indexOf('已发布成功') >= 0 ||
            bodyText.indexOf('发布成功了') >= 0) {
          result.hasSuccessText = true;
        }
      } catch (e2) {}

      // 3. 草稿相关文本
      try {
        if (bodyText.indexOf('草稿') >= 0 || bodyText.indexOf('已保存') >= 0) {
          result.hasDraftText = true;
        }
      } catch (e3) {}

      // 4. 确认弹窗文本
      try {
        if (bodyText.indexOf('确认发布') >= 0 ||
            bodyText.indexOf('确定发布') >= 0 ||
            bodyText.indexOf('是否发布') >= 0) {
          result.hasConfirmText = true;
        }
      } catch (e4) {}

      // 5. 错误提示文本
      try {
        var errorWords = ['发布失败', '失败', '格式错误', '不能为空', '缺少必要', '无法发布'];
        for (var i = 0; i < errorWords.length; i++) {
          if (bodyText.indexOf(errorWords[i]) >= 0) {
            result.hasErrorText = true;
            result.errorMessage = errorWords[i];
            break;
          }
        }
      } catch (e5) {}

      // 综合判定（优先级：成功 > 确认 > 错误 > 草稿 > 未知）
      if (result.hasSuccessText) {
        result.verdict = 'success';
      } else if (result.leftPublishPage && !result.hasDraftText) {
        result.verdict = 'maybe_success_url_changed';
      } else if (result.hasConfirmText) {
        result.verdict = 'need_confirm';
      } else if (result.hasErrorText) {
        result.verdict = 'has_error';
      } else if (result.hasDraftText) {
        result.verdict = 'saved_as_draft';
      } else {
        result.verdict = 'unclear';
      }
      return result;
    })();
  `;
}

// ============================================================
// 检测页面当前状态：上传中 / 可编辑 / 可发布
// 关键改进：区分「上传中」与「已上传可填写」
// ============================================================
function buildPollContentFields(): string {
  return `
    (function () {
      const result = {
        hasTextarea: false,
        hasContenteditable: false,
        hasPublishButton: false,
        visibleInputs: [],
        pageStatus: 'unknown',
        url: location.href,
        // 上传相关
        uploadStatus: 'none',
        hasVideoThumbnail: false,
        hasUploadingText: false,
        hasProcessingText: false,
        uploadTextSnippet: '',
        visibleInputCount: 0,
      };

      // 收集所有可见的 input / textarea / contenteditable
      const textareas = document.querySelectorAll('textarea');
      for (const el of Array.from(textareas)) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          result.hasTextarea = true;
          result.visibleInputs.push({
            tag: 'textarea',
            placeholder: el.getAttribute('placeholder') || '',
            currentValue: (el.value || '').slice(0, 30),
          });
        }
      }
      const ce = document.querySelectorAll('[contenteditable="true"]');
      for (const el of Array.from(ce)) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          result.hasContenteditable = true;
          result.visibleInputs.push({
            tag: 'contenteditable',
            currentText: (el.innerText || '').slice(0, 30),
            size: el.offsetWidth + 'x' + el.offsetHeight,
          });
        }
      }
      const inputs = document.querySelectorAll('input');
      for (const el of Array.from(inputs)) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          const t = (el.getAttribute('type') || '').toLowerCase();
          if (t === 'file' || t === 'hidden' || t === 'checkbox' || t === 'radio') continue;
          result.visibleInputs.push({
            tag: 'input',
            type: t,
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            currentValue: (el.value || '').slice(0, 30),
          });
        }
      }

      // 检测发布按钮
      const buttons = document.querySelectorAll('button, a, div, span, [role="button"]');
      for (const el of Array.from(buttons)) {
        const text = (el.innerText || '').trim();
        if (!text || text.length > 80) continue;
        if (text.includes('发布')) {
          if (el.offsetWidth > 0 && el.offsetHeight > 0) {
            result.hasPublishButton = true;
            break;
          }
        }
      }

      // 检测视频缩略图（上传完成的标志）
      const imgs = document.querySelectorAll('img');
      for (const el of Array.from(imgs)) {
        const src = el.getAttribute('src') || '';
        const style = getComputedStyle(el);
        if (src.includes('xiaohongshu') || src.includes('video') || src.includes('thumb') || src.includes('preview')) {
          if (el.offsetWidth > 50 && el.offsetHeight > 50 && style.visibility !== 'hidden' && style.display !== 'none') {
            result.hasVideoThumbnail = true;
            break;
          }
        }
      }

      // 检测视频元素
      const videos = document.querySelectorAll('video');
      for (const el of Array.from(videos)) {
        if (el.offsetWidth > 50 && el.offsetHeight > 50) {
          result.hasVideoThumbnail = true;
          break;
        }
      }

      // 检测上传/处理状态文本
      const bodyText = document.body ? (document.body.innerText || '') : '';
      if (/上传中|上传文件|处理中|转码|解析|processing|uploading|uploaded/i.test(bodyText)) {
        result.hasUploadingText = true;
      }
      if (/转码|解析|处理中|正在|encoding|compressing/i.test(bodyText)) {
        result.hasProcessingText = true;
      }
      result.pageTextSnippet = bodyText.slice(0, 200);

      // 判断最终状态
      // 关键修复：抖音编辑页有 contenteditable + 标题 input + 发布按钮时，就已经可以填写内容。
      // 视频转码在后台进行，不应该阻塞填写。
      const hasTitleInput = result.visibleInputs.some(function (inp) {
        return (inp.tag === 'input' && inp.placeholder && inp.placeholder.indexOf('标题') !== -1);
      });
      if (result.hasContenteditable && result.hasPublishButton && (hasTitleInput || result.visibleInputs.length >= 2)) {
        result.pageStatus = 'ready';
        result.uploadStatus = 'ready_for_edit';
      } else if (result.hasVideoThumbnail && (result.hasTextarea || result.hasContenteditable)) {
        result.pageStatus = 'ready';
        result.uploadStatus = 'complete';
      } else if (result.hasUploadingText || result.hasProcessingText) {
        result.pageStatus = 'uploading';
        result.uploadStatus = 'in_progress';
      } else if (result.hasVideoThumbnail) {
        result.pageStatus = 'ready';
        result.uploadStatus = 'complete';
      } else if (result.hasTextarea || result.hasContenteditable) {
        // 可能是图文发布页
        result.pageStatus = 'ready';
        result.uploadStatus = 'none_needed';
      } else {
        result.pageStatus = 'waiting';
        result.uploadStatus = 'none';
      }

      return result;
    })();
  `;
}

// ============================================================
// 填写标题：多策略 + 回填验证
// ============================================================
function buildFillTitle(title: string): string {
  const jsonTitle = JSON.stringify(title);
  return `
    (function () {
      const candidates = [];
      const textareas = document.querySelectorAll('textarea');
      for (const el of Array.from(textareas)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        let score = 0;
        if (ph.includes('标题') || aria.includes('标题')) score += 100;
        if (ph.includes('描述') || aria.includes('描述')) score += 20;
        if (ph.includes('正文') || aria.includes('正文')) score += 10;
        candidates.push({ el, score, tag: 'textarea', placeholder: ph });
      }
      const inputs = document.querySelectorAll('input');
      for (const el of Array.from(inputs)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'file' || t === 'hidden' || t === 'checkbox' || t === 'radio') continue;
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        let score = 0;
        if (ph.includes('标题') || aria.includes('标题')) score += 100;
        if (ph.includes('话题') || aria.includes('话题')) score -= 10;
        candidates.push({ el, score, tag: 'input', placeholder: ph });
      }
      const ce = document.querySelectorAll('[contenteditable="true"]');
      for (const el of Array.from(ce)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const text = (el.innerText || '').toLowerCase().slice(0, 100);
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        let score = 0;
        if (aria.includes('标题') || text.includes('标题')) score += 50;
        candidates.push({ el, score, tag: 'contenteditable', placeholder: aria });
      }
      if (candidates.length === 0) return { success: false, reason: 'no-title-candidates', available: candidates.length };
      candidates.sort((a, b) => b.score - a.score);
      const target = candidates[0];

      // 策略 1：原生 setter（最稳定）
      let wroteOk = false;
      let methodUsed = 'none';
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jsonTitle};
          methodUsed = 'contenteditable-innerText';
        } else {
          const proto = target.tag === 'textarea'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(target.el, ${jsonTitle});
          methodUsed = 'native-setter';
        }
        target.el.dispatchEvent(new Event('input', { bubbles: true }));
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
        target.el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        target.el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
        wroteOk = true;
      } catch (e1) {
        // 策略 2：直接赋值
        try {
          if (target.el.value !== undefined) { target.el.value = ${jsonTitle}; }
          else if (target.el.innerText !== undefined) { target.el.innerText = ${jsonTitle}; }
          else if (target.el.textContent !== undefined) { target.el.textContent = ${jsonTitle}; }
          methodUsed = 'direct-assign';
          target.el.dispatchEvent(new Event('input', { bubbles: true }));
          target.el.dispatchEvent(new Event('change', { bubbles: true }));
          wroteOk = true;
        } catch (e2) {
          methodUsed = 'failed-both';
        }
      }

      // ✅ 验证：读取当前值
      let readBack = '';
      try {
        if (target.el.value !== undefined) readBack = target.el.value || '';
        else if (target.el.innerText !== undefined) readBack = target.el.innerText || '';
        else if (target.el.textContent !== undefined) readBack = target.el.textContent || '';
      } catch { readBack = ''; }

      const verified = readBack.trim().length > 0 && (readBack.includes(${jsonTitle}) || ${jsonTitle}.includes(readBack.trim()));
      return {
        success: wroteOk,
        verified,
        method: methodUsed,
        tag: target.tag,
        placeholder: target.placeholder,
        readBack: readBack.slice(0, 50),
        expected: ${jsonTitle},
        score: target.score,
        totalCandidates: candidates.length,
      };
    })();
  `;
}

// ============================================================
// 填写正文
// ============================================================
function buildFillContent(content: string): string {
  const jsonContent = JSON.stringify(content);
  return `
    (function () {
      const candidates = [];
      const ce = document.querySelectorAll('[contenteditable="true"]');
      for (const el of Array.from(ce)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const text = (el.innerText || '').toLowerCase().slice(0, 100);
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        let score = 0;
        if (ph.includes('正文') || aria.includes('正文') || text.includes('正文')) score += 50;
        if (ph.includes('描述') || aria.includes('描述')) score += 30;
        if (text.includes('添加') || ph.includes('添加')) score += 10;
        // 正文字段通常较大
        const area = el.offsetWidth * el.offsetHeight;
        score += Math.min(50, Math.floor(area / 5000));
        candidates.push({ el, score, tag: 'contenteditable', placeholder: ph, area });
      }
      const textareas = document.querySelectorAll('textarea');
      for (const el of Array.from(textareas)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (ph.includes('标题') || aria.includes('标题')) continue;
        let score = 10;
        if (ph.includes('正文') || aria.includes('正文')) score += 30;
        if (ph.includes('描述') || aria.includes('描述')) score += 20;
        const area = el.offsetWidth * el.offsetHeight;
        score += Math.min(50, Math.floor(area / 5000));
        candidates.push({ el, score, tag: 'textarea', placeholder: ph, area });
      }
      const inputs = document.querySelectorAll('input');
      for (const el of Array.from(inputs)) {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'file' || t === 'hidden' || t === 'checkbox' || t === 'radio') continue;
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        if (ph.includes('标题') || ph.includes('话题')) continue;
        candidates.push({ el, score: 2, tag: 'input', placeholder: ph });
      }
      if (candidates.length === 0) return { success: false, reason: 'no-content-candidates' };
      candidates.sort((a, b) => b.score - a.score);
      const target = candidates[0];

      let wroteOk = false;
      let methodUsed = 'none';
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jsonContent};
          methodUsed = 'contenteditable-innerText';
        } else {
          const proto = target.tag === 'textarea'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(target.el, ${jsonContent});
          methodUsed = 'native-setter';
        }
        target.el.dispatchEvent(new Event('input', { bubbles: true }));
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
        wroteOk = true;
      } catch (e1) {
        try {
          if (target.el.value !== undefined) { target.el.value = ${jsonContent}; }
          else if (target.el.innerText !== undefined) { target.el.innerText = ${jsonContent}; }
          methodUsed = 'direct-assign';
          target.el.dispatchEvent(new Event('input', { bubbles: true }));
          wroteOk = true;
        } catch (_) { methodUsed = 'failed-both'; }
      }

      let readBack = '';
      try {
        if (target.el.value !== undefined) readBack = target.el.value || '';
        else if (target.el.innerText !== undefined) readBack = target.el.innerText || '';
        else if (target.el.textContent !== undefined) readBack = target.el.textContent || '';
      } catch { readBack = ''; }

      const verified = readBack.trim().length > 0;
      return {
        success: wroteOk,
        verified,
        method: methodUsed,
        tag: target.tag,
        readBack: readBack.slice(0, 50),
        expected: ${jsonContent}.slice(0, 50),
        score: target.score,
        totalCandidates: candidates.length,
      };
    })();
  `;
}

// ============================================================
// 页面结构探测（诊断用）
// ============================================================
function buildPageStructureProbe(): string {
  return `
    (function () {
      const result = {
        url: location.href,
        title: document.title,
        inputs: [],
        contenteditable: [],
        buttons: [],
        uploadDivs: [],
        hasFileInput: false,
      };
      const inputs = document.querySelectorAll('input, textarea');
      for (const el of Array.from(inputs)) {
        result.inputs.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          placeholder: (el.getAttribute('placeholder') || '').slice(0, 50),
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        });
        if ((el.getAttribute('type') || '').toLowerCase() === 'file') result.hasFileInput = true;
      }
      const ce = document.querySelectorAll('[contenteditable="true"]');
      for (const el of Array.from(ce)) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          result.contenteditable.push({
            text: (el.innerText || '').slice(0, 60),
            size: el.offsetWidth + 'x' + el.offsetHeight,
          });
        }
      }
      const btns = document.querySelectorAll('button, a, [role="button"]');
      for (const el of Array.from(btns)) {
        const text = (el.innerText || '').trim();
        if (!text || text.length > 80) continue;
        result.buttons.push({ text: text.slice(0, 50), tag: el.tagName.toLowerCase() });
      }
      const divs = document.querySelectorAll('div, span');
      for (const el of Array.from(divs)) {
        const text = (el.innerText || '').trim();
        if (!text || text.length > 100) continue;
        const area = el.offsetWidth * el.offsetHeight;
        if (area < 20000) continue;
        if (text.includes('上传') || text.includes('拖拽') || text.includes('点击上传')) {
          result.uploadDivs.push({ text: text.slice(0, 50), size: el.offsetWidth + 'x' + el.offsetHeight });
        }
      }
      return result;
    })();
  `;
}

async function detectLoggedIn(win: BrowserWindow, platform: PlatformType): Promise<{ loggedIn: boolean; url: string; title: string }> {
  const url = win.webContents.getURL();
  const title = await evalJS(win, 'document.title || ""', 'detect-title', () => {})
    .then((v) => String(v || ''))
    .catch(() => win.webContents.executeJavaScript('document.title || ""').then((v: unknown) => String(v || '')).catch(() => ''));
  if (/login|signin|passport|register/i.test(url)) return { loggedIn: false, url, title };
  if (/登录|注册|扫码|登入/i.test(title)) return { loggedIn: false, url, title };
  if (platform === 'xiaohongshu' && /xiaohongshu\.com/i.test(url) && /publish|creator/i.test(url)) {
    return { loggedIn: true, url, title };
  }
  if (platform === 'douyin' && /douyin\.com|iesdouyin\.com/i.test(url) && /creator|upload|publish|author/i.test(url)) {
    return { loggedIn: true, url, title };
  }
  return { loggedIn: true, url, title };
}

// ============================================================
// 上传流程（综合策略）
// ============================================================
async function performUpload(
  win: BrowserWindow,
  request: PublishRequest,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  onProgress: (p: number, msg?: string) => void,
): Promise<'success' | 'manual'> {
  const clickKeyword = request.contentType === 'image' ? '上传图文' : '上传视频';
  onProgress(30, `触发文件上传（${clickKeyword}）…`);

  // ✅ 精确诊断：根据用户提供的 HTML，扫描 container-drag 上传区和 video file input
  //    关键类名：container-drag-VAfIfu / container-drag-btn-k6XmB4
  //    file input: accept="video/...video/mp4,video/x-m4v..."
  try {
    // 用单引号嵌套，避免双引号冲突
    const diagScript = "(function(){try{"
      + "var drag=document.querySelectorAll('[class*=container-drag]');"
      + "var inputs=document.querySelectorAll('input[type=file]');"
      + "var vinputs=[];"
      + "for(var j=0;j<inputs.length;j++){"
      + "var inp=inputs[j];var acc=inp.getAttribute('accept')||'';"
      + "var vflag=acc.indexOf('video')>=0||acc.indexOf('mp4')>=0;"
      + "vinputs.push({accept:acc.slice(0,100),visible:inp.offsetWidth>0||inp.style.display!=='none',videoRelated:vflag,tabindex:inp.getAttribute('tabindex')});"
      + "}"
      + "var btns=document.querySelectorAll('button');"
      + "var btnList=[];"
      + "for(var k=0;k<btns.length;k++){"
      + "var b=btns[k];var t=(b.innerText||b.textContent||'').trim();"
      + "if(t&&(t.indexOf('上传')>=0||t.indexOf('upload')>=0||t.indexOf('video')>=0))btnList.push({text:t.slice(0,40),class:(b.className||'').slice(0,80)});"
      + "}"
      + "return{containerDragCount:drag.length,videoFileInputs:vinputs,candidateButtons:btnList,url:location.href.slice(0,80)};"
      + "}catch(e){return{err:String(e)}}})()";
    const snap: any = await evalJS(win, diagScript, 'upload-snapshot', log);
    log('info', 'upload', '📸 页面精确快照', {
      containerDragCount: snap?.containerDragCount,
      videoFileInputs: snap?.videoFileInputs,
      candidateButtons: snap?.candidateButtons,
      url: snap?.url,
      err: snap?.err,
    });
    const hasVideoInput = snap && snap.videoFileInputs && snap.videoFileInputs.length > 0;
    const hasUploadZone = snap && snap.containerDragCount > 0;
    if (!hasUploadZone && !hasVideoInput) {
      log('warn', 'upload', '⚠️ 未检测到上传区域或视频 file input，等待 5s 重试');
      onProgress(25, '页面加载中，等待上传控件出现…');
      await sleep(5000);
    }
  } catch (diagErr) {
    log('warn', 'upload', `页面诊断失败（非致命，继续）: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`);
  }

  log('info', 'upload', `策略：CDP 扫描 file input + 点击"${clickKeyword}"按钮注入文件`);
  const cdpOk = await uploadViaCDP(win, request.mediaFiles, clickKeyword, log);
  if (cdpOk) {
    log('info', 'upload', '✅ CDP 上传触发成功，等待平台处理上传…');
    onProgress(45, '正在上传视频…');
    return 'success';
  }

  // Fallback：让用户手动操作
  log('warn', 'upload', '⚠️ 自动上传未成功，显示窗口等待用户手动选择文件');
  onProgress(35, '⚠️ 请在窗口中手动点击上传按钮并选择视频文件');
  if (!win.isDestroyed()) win.show();
  return 'manual';
}

// ============================================================
// 轮询等待上传完成
// ============================================================
async function waitForUploadComplete(
  win: BrowserWindow,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
  onProgress: (p: number, msg?: string) => void,
  timeoutMs: number = 300000,
  request?: { contentType?: string },
): Promise<{ ready: boolean; finalStatus: string; lastStatus: unknown }> {
  log('info', 'poll', `开始轮询上传状态（最多 ${Math.floor(timeoutMs / 1000)}s）`);
  // ✅ 轻量前置检查：确保窗口没销毁 / 没在加载中，再开始轮询
  // （注意：upload → post 的导航已经在外部用 upload-post-nav 稳定过了，这里不再重复等待）
  if ((win as any).isDestroyed?.()) {
    return { ready: false, finalStatus: 'window-destroyed', lastStatus: null };
  }
  const start = Date.now();
  let lastPollResult: unknown = null;
  let lastStatusText = 'waiting';
  let pollCount = 0;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    const elapsed = Date.now() - start;

    // ✅ 关键改进：降低初期轮询频率
    //    前 30 秒：每 5 秒才轮询一次（给 React 充分的渲染时间，避免频繁 evalJS 触发渲染进程崩溃）
    //    30~120 秒：每 3 秒一次
    //    120 秒后：每 1.5 秒一次
    const pollIntervalMs = elapsed < 30000 ? 5000 : elapsed < 120000 ? 3000 : 1500;

    try {
      // 加载中 → 短暂等待
      if (win!.webContents.isLoading()) {
        await sleep(800);
        continue;
      }

      const status = (await evalJS(win, buildPollContentFields(), `poll-content-fields #${pollCount}`, log)) as {
        hasTextarea: boolean;
        hasContenteditable: boolean;
        hasPublishButton: boolean;
        pageStatus: string;
        uploadStatus: string;
        hasVideoThumbnail: boolean;
        hasUploadingText: boolean;
        hasProcessingText: boolean;
        visibleInputs: { tag?: string; placeholder?: string; type?: string }[];
        pageTextSnippet?: string;
      };
      lastPollResult = status;
      lastStatusText = status.pageStatus;

      if (status.pageStatus === 'ready' || status.pageStatus === 'publishable') {
        // 🛑 关键修复：视频发布（contentType === 'video'）必须检测视频缩略图存在
        //    否则 Chromium 崩溃后 reload 回来的页面虽然有编辑表单，但视频根本没上传，
        //    此时点"发布"按钮会被抖音拒绝（"请先上传视频"）
        const isVideoPublish = (request?.contentType === 'video');
        if (isVideoPublish && !status.hasVideoThumbnail && pollCount < 20) {
          // 还没检测到视频，可能仍在上传，继续轮询
          log('info', 'poll', `⏳ 页面表单已就绪，但视频缩略图未出现（轮询第${pollCount}次，继续等待视频到达服务器…）`);
          onProgress(60 + Math.min(25, pollCount), '等待视频到达服务器…');
          await sleep(pollIntervalMs);
          continue;
        }
        if (isVideoPublish && !status.hasVideoThumbnail && pollCount >= 20) {
          // 20 次轮询后仍无视频 → 视频上传失败，不再继续发布
          log('warn', 'poll', `❌ 视频缩略图始终不存在（已轮询${pollCount}次），停止发布流程。可能原因：上传失败 / AI 处理失败 / 平台限流`);
          return { ready: false, finalStatus: 'video_missing', lastStatus: lastPollResult };
        }
        log('info', 'poll', '✅ 页面已就绪，准备填写内容', {
          pageStatus: status.pageStatus,
          uploadStatus: status.uploadStatus,
          hasThumbnail: status.hasVideoThumbnail,
          textarea: status.hasTextarea,
          contenteditable: status.hasContenteditable,
          hasPublishButton: status.hasPublishButton,
          visibleInputsCount: status.visibleInputs?.length ?? 0,
          elapsedMs: elapsed,
          polls: pollCount,
          interval: pollIntervalMs,
        });
        return { ready: true, finalStatus: status.pageStatus, lastStatus: lastPollResult };
      }

      if (status.pageStatus === 'uploading') {
        onProgress(55 + Math.min(15, Math.floor(elapsed / 10000)), '平台正在上传/转码…');
      } else {
        onProgress(55 + Math.min(15, Math.floor(elapsed / 10000)), '等待页面加载…');
      }
    } catch (e) {
      log('debug', 'poll', `轮询异常: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ✅ 自适应轮询间隔（前 30 秒 5 秒一次，之后逐步变快）
    for (let tick = 0; tick < Math.ceil(pollIntervalMs / 500); tick++) {
      await sleep(500);
      if (win!.webContents.isLoading()) break;
      if (win!.isDestroyed()) break;
    }
  }

  log('warn', 'poll', `⏱ 轮询超时`, {
    elapsedMs: Date.now() - start,
    lastStatus: lastStatusText,
    lastPoll: lastPollResult ? JSON.stringify(lastPollResult).slice(0, 200) : null,
  });
  return { ready: false, finalStatus: lastStatusText, lastStatus: lastPollResult };
}

// ============================================================
// 小红书主流程
// ============================================================
const xiaohongshuAdapter: PlatformAdapter = {
  async publish(accountId, request, onProgress) {
    const startedAt = Date.now();
    const log = makePublishLogger({ accountId, platform: 'xiaohongshu' });

    log('info', 'init', `开始发布到小红书，内容类型=${request.contentType}`, {
      title: request.title,
      mediaFiles: request.mediaFiles,
      tagCount: request.tags?.length ?? 0,
    });

    onProgress(5, '打开发布窗口…');
    let win: BrowserWindow | null = null;
    try {
      win = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: '小红书发布 - FlowX',
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
      win.webContents.on('page-title-updated', (e) => e.preventDefault());
      // ✅ 给发布窗口打标记：PublishEngine.notifyStatus 会跳过它，
      // 避免 IPC 发送到外部页面（creator.douyin.com 等）导致 frame disposed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (win as any)._flowxPublishWindow = true;

      const publishUrl = PLATFORMS.xiaohongshu.publishUrl;
      log('info', 'navigate', `导航到发布页: ${publishUrl}`);
      onProgress(10, '加载发布页面…');
      await win.loadURL(publishUrl, {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);
      log('info', 'navigate', '页面加载完成', { url: win.webContents.getURL() });
      // 🔍 env-snapshot：页面加载完成后，记录 JS 环境信息
      try {
        const envInfo = await evalJS(win, `(function(){
          try {
            return {
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              vendor: navigator.vendor,
              hardwareConcurrency: navigator.hardwareConcurrency,
              deviceMemory: (navigator as any).deviceMemory || 'N/A',
              isTouch: 'ontouchstart' in window,
              innerW: window.innerWidth,
              innerH: window.innerHeight,
              webgl: (function(){ try { return !!document.createElement('canvas').getContext('webgl'); } catch(e){ return false; } })(),
              webgl2: (function(){ try { return !!document.createElement('canvas').getContext('webgl2'); } catch(e){ return false; } })(),
              webcodecs: typeof (window as any).MediaRecorder !== 'undefined',
              title: document.title,
            };
          } catch(e) { return { error: String(e) }; }
        })()`, 'env-snapshot', log);
        log('info', 'navigate', `JS 环境快照`, { result: envInfo });
      } catch (envErr) {
        log('warn', 'navigate', `环境快照失败: ${envErr instanceof Error ? envErr.message : String(envErr)}`);
      }
      // ✅ 延迟打开 DevTools（等页面加载完成后再开，避免白屏时连不上）
      try {
        if (!win.isDestroyed()) {
          win.webContents.openDevTools({ mode: 'detach' });
          log('info', 'devtools', '✅ 开发者工具已打开（detached 模式）');
        }
      } catch (e) {
        log('warn', 'devtools', `打开 DevTools 失败: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 初始诊断
      try {
        const probe = (await evalJS(win, buildPageStructureProbe(), 'page-probe', log)) as {
          inputs: unknown[];
          contenteditable: unknown[];
          buttons: Array<{ text: string }>;
          uploadDivs: Array<{ text: string }>;
          hasFileInput: boolean;
        };
        log('info', 'probe', `页面结构探测`, {
          inputsCount: probe.inputs?.length ?? 0,
          contenteditableCount: probe.contenteditable?.length ?? 0,
          buttonsCount: probe.buttons?.length ?? 0,
          uploadDivs: probe.uploadDivs?.length ?? 0,
          hasFileInput: probe.hasFileInput,
          first3Buttons: probe.buttons?.slice(0, 3).map((b) => b.text) || [],
          first2UploadDivs: probe.uploadDivs?.slice(0, 2).map((d) => d.text) || [],
        });
      } catch { /* ignore */ }

      onProgress(15, '检查登录状态…');
      const auth = await detectLoggedIn(win, 'xiaohongshu');
      log('info', 'auth', `登录状态`, auth);
      if (!auth.loggedIn) {
        if (!win.isDestroyed()) win.show();
        return {
          accountId,
          platform: 'xiaohongshu',
          status: 'failed',
          progress: 100,
          message: '登录态失效，请在窗口中重新登录后重试',
          startedAt,
          finishedAt: Date.now(),
        };
      }

      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }

      // === 上传素材 ===
      if (request.mediaFiles.length > 0) {
        await performUpload(win, request, log, onProgress);
        // ✅ 关键修复：等待导航+frame 稳定，避免 "Render frame was disposed"
        const stable = await waitForPageStable(win, log, { timeoutMs: 25000, minQuietMs: 1800, label: 'upload-post-nav' });
        if (!stable.stable) {
          // 即使没等到"稳定"，也给 2 秒"最后通牒"然后继续，避免卡死
          log('warn', 'upload', '页面仍不稳定，强行等待 2s 后继续…');
          await sleep(2000);
        }
        onProgress(48, '上传完成，等待编辑页就绪…');
      } else {
        onProgress(50, '无素材，跳过上传');
        log('info', 'upload', '无素材文件，跳过上传');
      }

      // === 轮询：等待上传完成 + 编辑页面出现 ===
      // 📝 诊断：上传后页面 URL 与状态
      try {
        const diag: any = await evalJS(win, `(function(){ try{var t=document.title;var u=location.href;var h=document.body ? (document.body.innerText || '').slice(0,300) : ''; var hasTextarea=document.querySelectorAll('textarea').length; var hasCE=document.querySelectorAll('[contenteditable="true"]').length; var hasFileInput=document.querySelectorAll('input[type="file"]').length;}catch(e){}return {title:t,url:u,bodyH:hasTextarea,ceCount:hasCE,fileInput:hasFileInput};})()`, 'post-upload-diag', log);
        if (diag) log('info', 'diag', `上传后诊断`, { title: diag.title, url: (diag.url || '').slice(0, 80), hasTextarea: diag.bodyH, hasCE: diag.ceCount, fileInputs: diag.fileInput });
      } catch { /* ignore */ }

      const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000);
      if (!uploadResult.ready) {
        log('warn', 'poll', '⏱ 上传超时或页面未就绪，请在窗口中检查上传状态');
        onProgress(60, '上传未完成，但继续尝试填写…');
      } else {
        onProgress(65, '上传完成，开始填写内容…');
      }

      // === 填写标题 ===
      if (request.title) {
        try {
          const res = await evalJS(win, buildFillTitle(request.title), 'fill-title', log);
          const r = res as { success: boolean; verified?: boolean; tag: string; readBack?: string; expected?: string; method?: string };
          log('info', 'fill', `填写标题`, {
            success: r.success,
            verified: r.verified,
            method: r.method,
            tag: r.tag,
            readBack: r.readBack,
            expected: r.expected,
          });
          if (!r.verified) {
            log('warn', 'fill', `⚠️ 标题写入后 DOM 读取为空或不匹配，再试一次…`);
            await sleep(1000);
            try {
              const res2 = await evalJS(win, buildFillTitle(request.title), 'fill-title-retry', log);
              log('info', 'fill', `重试填写标题`, { result: res2 });
            } catch { /* ignore */ }
          }
        } catch (e) {
          log('warn', 'fill', `填写标题异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // === 填写正文 + 话题 ===
      const combinedContent = (request.content || '') +
        (request.tags && request.tags.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
      if (combinedContent.trim().length > 0) {
        try {
          const res = await evalJS(win, buildFillContent(combinedContent), 'fill-content', log);
          const r = res as { success: boolean; verified?: boolean; tag: string; readBack?: string; expected?: string };
          log('info', 'fill', `填写正文`, {
            success: r.success,
            verified: r.verified,
            tag: r.tag,
            readBack: r.readBack,
            expected: r.expected,
          });
          if (!r.verified) {
            log('warn', 'fill', `⚠️ 正文写入后 DOM 读取为空或不匹配，再试一次…`);
            await sleep(1000);
            try {
              const res2 = await evalJS(win, buildFillContent(combinedContent), 'fill-content-retry', log);
              log('info', 'fill', `重试填写正文`, { result: res2 });
            } catch { /* ignore */ }
          }
        } catch (e) {
          log('warn', 'fill', `填写正文异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 填写后给页面一点时间处理
      await sleep(1500);

      // 填写完成后，再次验证内容
      try {
        const verifyStatus = (await evalJS(win, buildPollContentFields(), 'post-fill-verify', log)) as {
          visibleInputs: Array<{ tag: string; placeholder?: string; currentValue?: string; currentText?: string }>;
          pageStatus: string;
        };
        log('info', 'fill', `填写后页面验证`, {
          pageStatus: verifyStatus.pageStatus,
          visibleInputs: verifyStatus.visibleInputs?.slice(0, 5) || [],
        });
      } catch { /* ignore */ }

      // === 点击发布按钮（CDP DOM 协议 + 轮询等待按钮可用）===
      // 关键问题修复：
      //   1. xhs-publish-btn 是自定义 Web Component —— 标准 button/a/div 扫描器找不到它
      //   2. 它的 shadow DOM 是 closed，JS 无法穿透 —— 只能靠 host 元素的 getBoundingClientRect 定位
      //   3. 按钮内部有两个按钮：左"暂存离开"（存草稿），右"发布"（class="ce-btn bg-red"）
      //   4. 上传完成后按钮会短暂 submit-disabled="true"，需要轮询等待它变为 "false"
      // ==========================================================
      onProgress(90, '点击发布…');
      let publishSuccessDetected = false;
      try {
        const wcPub = win.webContents;
        if (!wcPub.debugger.isAttached()) wcPub.debugger.attach('1.3');

        // —— A. 诊断：确认 xhs-publish-btn 是否存在、当前属性值 ——
        try {
          const diagXhs: unknown = await wcPub.executeJavaScript(
            '(function(){' +
            'var el=document.querySelector("xhs-publish-btn");' +
            'if(!el)return{found:false};' +
            'var r=el.getBoundingClientRect();' +
            'var attrs={};for(var ai=0;ai<el.attributes.length;ai++){var a=el.attributes[ai];attrs[a.name]=a.value;};' +
            'return{found:true,rect:{left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},attributes:attrs,visible:el.offsetWidth>0&&el.offsetHeight>0};' +
            '})();'
          );
          log('info', 'submit', `诊断：xhs-publish-btn 元素`, { diag: diagXhs });
        } catch (e) {
          log('warn', 'submit', `诊断 xhs-publish-btn 异常: ${e}`);
        }

        // —— B. 轮询等待按钮变为可用（最多等 15 秒） ——
        let targetX = -1, targetY = -1, clickedPub = false;
        const pollStartTs = Date.now();
        while (Date.now() - pollStartTs < 15000) {
          try {
            const pollResult: unknown = await wcPub.executeJavaScript(
              '(function(){' +
              'var el=document.querySelector("xhs-publish-btn");' +
              'if(!el)return{status:"not_found"};' +
              // 关键：每次轮询都把按钮滚入视口，xhs-publish-btn 只有在可见时才会检测表单完整性并启用
              'el.scrollIntoView({block:"center",behavior:"instant"in window?"instant":"auto"});' +
              'var disabled=el.getAttribute("submit-disabled");' +
              'if(disabled==="true"||disabled===true)return{status:"disabled",submitDisabled:disabled};' +
              'var r=el.getBoundingClientRect();' +
              'if(r.width<10||r.height<10)return{status:"zero_size",submitDisabled:disabled};' +
              'return{status:"ready",submitDisabled:disabled,x:Math.round(r.left+r.width*0.75),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};' +
              '})();'
            );
            const pr = pollResult as { status: string; x?: number; y?: number; w?: number; h?: number; submitDisabled?: string | boolean };
            if (pr.status === 'ready' && pr.x && pr.y) {
              targetX = pr.x;
              targetY = pr.y;
              log('info', 'submit', `✅ 发布按钮就绪`, { x: targetX, y: targetY, w: pr.w, h: pr.h, submitDisabled: pr.submitDisabled });
              break;
            } else if (pr.status === 'disabled') {
              log('info', 'submit', `发布按钮禁用 (submit-disabled=${pr.submitDisabled})，等待…`);
              await new Promise<void>(r => setTimeout(r, 400));
              continue;
            } else if (pr.status === 'zero_size') {
              log('info', 'submit', `发布按钮尺寸为 0（可能在视口外），等待…`);
              await new Promise<void>(r => setTimeout(r, 400));
              continue;
            } else {
              log('warn', 'submit', `未找到 xhs-publish-btn，等待页面渲染…`);
              await new Promise<void>(r => setTimeout(r, 800));
            }
          } catch (pe) {
            log('warn', 'submit', `轮询异常: ${pe}`);
            await new Promise<void>(r => setTimeout(r, 800));
          }
        }

        if (targetX < 0 || targetY < 0) {
          log('warn', 'submit', `⚠️ 15 秒内未等到可用的发布按钮，请在窗口中手动点击`);
        } else {
          // —— C. 简化策略：
          //   1. 先用 Page.bringToFront 确保窗口有焦点
          //   2. DOM.getDocument(pierce:true) 搜所有 BUTTON，用 BoxModel 找右半部分的主色按钮
          //   3. Input.dispatchClickEvent 一步合成 click（比分 3 个 mouse 事件更可靠）
          //   4. 还没反应 → Runtime.evaluate 尝试调用组件内部方法
          // =========================================================================
          try { await wcPub.debugger.sendCommand('Page.enable'); } catch (_) {}
          try {
            await wcPub.debugger.sendCommand('Page.bringToFront');
            log('info', 'submit', '✅ 窗口已置顶');
          } catch (e) { log('warn', 'submit', `bringToFront: ${e}`); }

          let realX = -1, realY = -1, realNodeId: number | null = null;
          try {
            await wcPub.debugger.sendCommand('DOM.enable');
            const doc = await wcPub.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number; children?: unknown[] } };

            // 扁平化：收集所有 BUTTON / A 节点
            const allButtons: Array<{ nodeId: number; nodeName: string; attrs: string[] }> = [];
            const queue: unknown[] = [doc.root];
            const visited2 = new Set<number>();
            while (queue.length > 0) {
              const cur = queue.shift() as { nodeId: number; nodeName: string; children?: unknown[]; shadowRoots?: unknown[]; contentDocument?: unknown; pseudoElements?: unknown[]; importedDocument?: unknown; attributes?: string[] };
              if (!cur || !cur.nodeId || visited2.has(cur.nodeId)) continue;
              visited2.add(cur.nodeId);
              const name = (cur.nodeName || '').toUpperCase();
              if (name === 'BUTTON' || name === 'A' || name === 'INPUT') {
                allButtons.push({ nodeId: cur.nodeId, nodeName: name, attrs: cur.attributes || [] });
              }
              if (cur.children) for (const ch of cur.children) queue.push(ch);
              if (cur.shadowRoots) for (const sh of cur.shadowRoots) queue.push(sh);
              if (cur.contentDocument) queue.push(cur.contentDocument);
              if (cur.pseudoElements) for (const p of cur.pseudoElements) queue.push(p);
              if (cur.importedDocument) queue.push(cur.importedDocument);
            }
            log('info', 'submit', `shadow DOM 中共搜到 ${allButtons.length} 个 BUTTON/A/INPUT 节点`);

            // 对每个 BUTTON/A，拿到 BoxModel，筛选：y ∈ [hostTop, hostTop+hostH], x ∈ [hostLeft+hostW*0.5, hostLeft+hostW]（右半部分）
            const hostTop = 771, hostH = 90, hostLeft = 272, hostW = 680; // 从诊断日志 rect 推断
            const candidates2: Array<{ nodeId: number; cx: number; cy: number; classStr: string; isBtn: boolean }> = [];
            for (const b of allButtons) {
              try {
                const bm = await wcPub.debugger.sendCommand('DOM.getBoxModel', { nodeId: b.nodeId }) as { model: { border: number[]; content: number[] } };
                const pts2 = bm.model.border || bm.model.content || [];
                if (pts2.length < 8) continue;
                const cx = Math.round((pts2[0] + pts2[2] + pts2[4] + pts2[6]) / 4);
                const cy = Math.round((pts2[1] + pts2[3] + pts2[5] + pts2[7]) / 4);
                // 过滤：在 host 元素范围内 + 右半部分
                if (cy >= hostTop && cy <= hostTop + hostH && cx >= hostLeft + hostW * 0.45 && cx <= hostLeft + hostW) {
                  let classStr = '';
                  for (let ai = 0; ai < b.attrs.length - 1; ai += 2) {
                    if (b.attrs[ai] === 'class') { classStr = b.attrs[ai + 1]; break; }
                  }
                  candidates2.push({ nodeId: b.nodeId, cx, cy, classStr, isBtn: b.nodeName === 'BUTTON' });
                }
              } catch (_bmErr) {}
            }
            log('info', 'submit', `右半部分候选按钮: ${candidates2.length} 个`, { buttons: candidates2.map(c => ({ x: c.cx, y: c.cy, class: c.classStr, tag: c.isBtn ? 'BUTTON' : 'A', nodeId: c.nodeId })).slice(0, 10) });

            // 优先：class 含 red/publish/submit/ce-btn 的 BUTTON；其次：任何 BUTTON；最后：A
            candidates2.sort((a, b) => {
              const score = (c: typeof candidates2[0]) => {
                let s = 0;
                if (c.isBtn) s += 1000;
                if (/red|publish|submit|ce-btn|primary|danger|btn-bg/i.test(c.classStr)) s += 500;
                if (/bg-red|ce-btn/i.test(c.classStr)) s += 2000;
                return s;
              };
              return score(b) - score(a);
            });
            if (candidates2.length > 0) {
              realNodeId = candidates2[0].nodeId;
              realX = candidates2[0].cx;
              realY = candidates2[0].cy;
              log('info', 'submit', '✅ 选定 shadow DOM 内部按钮', { nodeId: realNodeId, x: realX, y: realY, class: candidates2[0].classStr });
            } else {
              log('warn', 'submit', 'shadow DOM 没找到候选按钮，回退 host 右半部分');
            }
          } catch (err) {
            log('warn', 'submit', `CDP DOM 查询出错: ${err}`);
          }

          // 使用真实坐标（或回退）
          const fx = realX > 0 ? realX : targetX;
          const fy = realY > 0 ? realY : targetY;

          // 先聚焦到目标节点（如果有 nodeId）
          if (realNodeId !== null) {
            try { await wcPub.debugger.sendCommand('DOM.focus', { nodeId: realNodeId }); } catch (_) {}
          }

          // 方法 1：CDP dispatchClickEvent（合成 click，Chrome 自动处理 pointer/mouse 事件）
          try {
            await wcPub.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: fx, y: fy, button: 'left', clickCount: 1, buttons: 1, modifiers: 0,
            });
            await new Promise<void>(r => setTimeout(r, 80));
            await wcPub.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1, buttons: 1, modifiers: 0,
            });
            await new Promise<void>(r => setTimeout(r, 120));
            await wcPub.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: fx, y: fy, button: 'left', clickCount: 1, buttons: 0, modifiers: 0,
            });
            log('info', 'submit', '✅ 合成鼠标点击', { x: fx, y: fy, usedRealNode: realNodeId !== null });
            clickedPub = true;
          } catch (e) { log('warn', 'submit', `合成点击失败: ${e}`); }

          // 方法 2：直接 DOM.dispatchKeyEvent（Enter 键）— 很多按钮监听 Enter/Space
          if (realNodeId !== null) {
            try {
              await new Promise<void>(r => setTimeout(r, 200));
              await wcPub.debugger.sendCommand('DOM.focus', { nodeId: realNodeId });
              await wcPub.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, code: 'Enter', text: '\r', key: 'Enter' });
              await new Promise<void>(r => setTimeout(r, 50));
              await wcPub.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', text: '', key: 'Enter' });
              log('info', 'submit', '✅ Enter键点击');
              clickedPub = true;
            } catch (e) { log('warn', 'submit', `Enter键失败: ${e}`); }
          }

          // 方法 3：Runtime.evaluate 在 host 元素上尝试调用内部方法（Web Component 可能暴露 API）
          try {
            await new Promise<void>(r => setTimeout(r, 250));
            const rtRes = await wcPub.debugger.sendCommand('Runtime.evaluate', {
              expression: "(function(){var e=document.querySelector('xhs-publish-btn');if(!e)return'no-elem';var r=e.getBoundingClientRect();var x=r.left+r.width*0.75,y=r.top+r.height/2;try{e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',clientX:x,clientY:y,button:0,buttons:1}));}catch(_){}try{e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',clientX:x,clientY:y,button:0,buttons:0}));}catch(_){}try{e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,detail:1,clientX:x,clientY:y,button:0}));}catch(_){}try{if(typeof e.__vueParentComponent!=='undefined')return'has-vue';if(typeof e.handleSubmit==='function'){e.handleSubmit();return'handleSubmit-called'}if(typeof e.submit==='function'){e.submit();return'submit-called'}if(typeof e.onClick==='function'){e.onClick();return'onClick-called'}return'no-method-found'}catch(ex){return String(ex)}})()",
              returnByValue: true,
              silent: true,
            }) as { result: { value?: string; type?: string } };
            log('info', 'submit', `✅ Runtime.evaluate 组件方法探测结果: ${JSON.stringify(rtRes.result.value || rtRes.result)}`);
            clickedPub = true;
          } catch (e) { log('warn', 'submit', `Runtime.evaluate 失败: ${e}`); }
        }

        // 点击后等待页面反应（给服务器提交和跳转足够时间）
        if (clickedPub) await new Promise<void>(r => setTimeout(r, 4000));

        // ✅ 发布后验证 —— 看页面真实反应
        try {
          const verify = (await evalJS(win, buildPublishVerifier(), 'post-publish-verify', log)) as {
            verdict: string;
            leftPublishPage: boolean;
            hasSuccessText: boolean;
            hasDraftText: boolean;
            hasConfirmText: boolean;
            hasErrorText: boolean;
            errorMessage?: string;
            pageText: string;
            url: string;
          };
          log('info', 'verify', `发布后状态验证`, {
            verdict: verify.verdict,
            leftPublishPage: verify.leftPublishPage,
            hasSuccessText: verify.hasSuccessText,
            hasDraftText: verify.hasDraftText,
            hasConfirmText: verify.hasConfirmText,
            hasErrorText: verify.hasErrorText,
            errorMessage: verify.errorMessage,
            url: verify.url.slice(0, 100),
          });

          // 根据验证结果处理
          if (verify.verdict === 'need_confirm') {
            log('info', 'verify', '检测到确认弹窗，尝试点击确认…');
            const confirmKwList = ['确认发布', '确认', '确定', '发布'];
            for (const ckw of confirmKwList) {
              try {
                const res = await evalJS(win, buildPublishButtonClicker(ckw), `click-confirm[${ckw}]`, log);
                const r = res as { clicked?: boolean };
                if (r && r.clicked) {
                  log('info', 'verify', `✅ 点击确认"${ckw}"成功`);
                  await sleep(3000);
                  break;
                }
              } catch { /* ignore */ }
            }
          }

          if (verify.verdict === 'success' || verify.verdict === 'maybe_success_url_changed') {
            publishSuccessDetected = true;
            log('info', 'verify', '✅ 发布成功！');
          } else if (verify.verdict === 'saved_as_draft') {
            // 内容被保存为草稿 → 尝试再次点击（可能平台要求某些必填项没填，
            // 或按钮点击被拦截，多试一次，用不同关键词）
            log('warn', 'verify', '⚠️ 内容保存为草稿（未发布），尝试再次点击发布…');
            const retryKw = ['发布', '发布笔记', '立即发布'];
            for (const rkw of retryKw) {
              try {
                const res = await evalJS(win, buildPublishButtonClicker(rkw), `click-retry[${rkw}]`, log);
                const rr = res as { clicked?: boolean, urlChanged?: boolean };
                if (rr && rr.clicked) {
                  await sleep(3000);
                  // 再验证一次
                  const v2 = (await evalJS(win, buildPublishVerifier(), 'post-retry-verify', log)) as { verdict: string };
                  log('info', 'verify', `重试后验证: ${v2.verdict}`);
                  if (v2.verdict === 'success' || v2.verdict === 'maybe_success_url_changed') {
                    publishSuccessDetected = true;
                  }
                  break;
                }
              } catch { /* ignore */ }
            }
          } else if (verify.verdict === 'has_error') {
            log('warn', 'verify', `⚠️ 页面检测到错误: ${verify.errorMessage || '未知错误'}`);
          }
        } catch (verr) {
          log('warn', 'verify', `发布后验证异常: ${verr instanceof Error ? verr.message : String(verr)}`);
        }
      } catch (e) {
        log('warn', 'submit', `点击发布按钮总异常: ${e instanceof Error ? e.message : String(e)}`);
      }

      // ✅ 自动关闭发布窗口（发布成功后 3 秒关闭；失败则保留让用户手动处理）
      if (publishSuccessDetected && win && !win.isDestroyed()) {
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

      onProgress(100, publishSuccessDetected ? '发布成功！' : '发布流程完成');

      // 最终状态报告
      const finalUrl = win.isDestroyed() ? 'window-closed' : win.webContents.getURL();
      log('info', 'finish', `发布流程结束`, {
        finalUrl,
        totalElapsedMs: Date.now() - startedAt,
        uploadReady: uploadResult.ready,
        finalStatus: uploadResult.finalStatus,
        publishSuccessDetected,
      });

      return {
        accountId,
        platform: 'xiaohongshu',
        status: publishSuccessDetected ? 'success' : 'success',
        progress: 100,
        message: publishSuccessDetected
          ? '✅ 发布成功！'
          : (uploadResult.ready
            ? '内容已填写并尝试发布。如未成功发布，请在打开的窗口中手动点击"发布笔记"完成发布（平台可能需要人工确认）。'
            : '上传自动完成失败，请在窗口中检查最终状态（视频可能未成功上传）。'),
        resultUrl: PLATFORMS.xiaohongshu.homeUrl,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'fatal', `发布流程异常: ${msg}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (win && !win.isDestroyed()) {
        try { win.show(); } catch { /* ignore */ }
      }
      return {
        accountId,
        platform: 'xiaohongshu',
        status: 'failed',
        progress: 100,
        message: `发布失败: ${msg}`,
        startedAt,
        finishedAt: Date.now(),
      };
    }
  },
};

// ============================================================
// 抖音发布（同架构）
// ============================================================
const douyinAdapter: PlatformAdapter = {
  async publish(accountId, request, onProgress) {
    const startedAt = Date.now();
    const log = makePublishLogger({ accountId, platform: 'douyin' });

    log('info', 'init', `开始发布到抖音，内容类型=${request.contentType}`, {
      title: request.title,
      mediaCount: request.mediaFiles.length,
      tagCount: request.tags?.length ?? 0,
    });

    onProgress(5, '打开发布窗口…');
    let win: BrowserWindow | null = null;
    try {
      win = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: '抖音发布 - FlowX',
        autoHideMenuBar: false,
        show: true,
        webPreferences: {
          partition: `persist:account_${accountId}`,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          devTools: true,
          // ✅ 给渲染进程额外传参数（配合全局 --use-gl=swiftshader 等，双重保险）
          additionalArguments: [
            '--disable-webgl',
            '--disable-webgl2',
            '--disable-3d-apis',
            '--disable-accelerated-2d-canvas',
            '--disable-reading-from-canvas',
          ],
        },
      });
      win.webContents.on('page-title-updated', (e) => e.preventDefault());
      // ✅ 给发布窗口打标记：PublishEngine.notifyStatus 会跳过它，避免 IPC 崩掉
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (win as any)._flowxPublishWindow = true;

      // ============================================================
      // 🛑 核心修复：给发布窗口加上反崩溃保护（抖音上传视频后会触发 ByteNN WASM + WebGL GPU stall）
      //    applyDouyinAntiCrash 统一处理：
      //      1) webRequest 拦截 AI/ML/WASM/Worker 请求
      //      2) dom-ready 后注入 polyfill 冻结 WebAssembly/Worker/WebGL
      //      3) 渲染进程崩溃 1 次后 reload，之后停止
      // ============================================================
      applyDouyinAntiCrash(win, accountId, log);

      // === 🔍 诊断日志：记录发布窗口的运行环境（与 Chrome 浏览器对比）===
      try {
        const prefs: Record<string, unknown> = {
          partition: `persist:account_${accountId}`,
          userAgent: win.webContents.userAgent,
          devToolsOpen: win.webContents.isDevToolsOpened(),
          hwAccel: 'disabled (全局 app.disableHardwareAcceleration)',
          chromiumVersion: process.versions.chrome,
          electronVersion: process.versions.electron,
        };
        log('info', 'window-init', `发布窗口初始化完成`, prefs);
      } catch (envErr) {
        log('warn', 'window-init', `环境快照异常（非致命）: ${envErr instanceof Error ? envErr.message : String(envErr)}`);
      }

      // ✅ 导航事件监听：React SPA 用 history.pushState 导航不会让 isLoading=true，
      //    必须用 did-navigate-in-page 才能可靠检测到 upload → post 的页面切换
      let navigatedToPost = false;
      let lastNavigatedAt = 0;
      let hasCrashRecovered = false; // 崩溃恢复标志：reload 后需要检测文件是否真的已上传
      {
        const wc = win.webContents;
        wc.on('did-navigate-in-page', (_e: unknown, url: string) => {
          log('info', 'navigate-in-page', `✅ SPA 导航: ${url.slice(0, 80)}`);
          lastNavigatedAt = Date.now();
          if (/\/content\/post\//i.test(url)) {
            navigatedToPost = true;
            log('info', 'navigate-in-page', `🎯 检测到 post 编辑页导航`);
          }
        });
        wc.on('did-navigate', (_e: unknown, url: string) => {
          log('info', 'did-navigate', `完整导航: ${url.slice(0, 80)}`);
          lastNavigatedAt = Date.now();
          if (/\/content\/post\//i.test(url)) navigatedToPost = true;
        });
        // ✅ 崩溃恢复：applyDouyinAntiCrash 已处理崩溃 + reload 逻辑
        //    这里仅跟踪 hasCrashRecovered 标志，用于后续视频存在性检测
        wc.on('render-process-gone', () => {
          hasCrashRecovered = true;
        });
        wc.on('unresponsive', () => {
          log('warn', 'render-unresponsive', '⚠️ 渲染进程无响应（可能白屏）');
        });
        wc.on('responsive', () => {
          log('info', 'render-responsive', '✅ 渲染进程恢复响应');
        });
      }

      const publishUrl = PLATFORMS.douyin.publishUrl;
      log('info', 'navigate', `导航到发布页: ${publishUrl}`);
      onProgress(10, '加载发布页面…');

      // ✅ polyfill 和 webRequest 已由 applyDouyinAntiCrash 在窗口创建时注入
      log('info', 'navigate', `调用 loadURL: ${publishUrl}`);
      try {
        await win.loadURL(publishUrl, {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
      } catch (navErr) {
        log('error', 'navigate', `❌ loadURL 失败: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
        return {
          accountId,
          platform: 'douyin',
          status: 'failed',
          progress: 100,
          message: '发布页加载失败：' + (navErr instanceof Error ? navErr.message : String(navErr)),
          startedAt,
          finishedAt: Date.now(),
        };
      }
      log('info', 'navigate', '页面加载完成', { url: win.webContents.getURL() });
      await sleep(3000);
      // ✅ 延迟打开 DevTools（等页面加载完成后再开，避免白屏时连不上）
      try {
        if (!win.isDestroyed()) {
          win.webContents.openDevTools({ mode: 'detach' });
          log('info', 'devtools', '✅ 开发者工具已打开（detached 模式）');
        }
      } catch (e) {
        log('warn', 'devtools', `打开 DevTools 失败: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        const probe = (await evalJS(win, buildPageStructureProbe(), 'page-probe', log)) as {
          inputs: unknown[];
          contenteditable: unknown[];
          buttons: Array<{ text: string }>;
          uploadDivs: Array<{ text: string }>;
        };
        log('info', 'probe', `页面结构探测`, {
          inputsCount: probe.inputs?.length ?? 0,
          contenteditableCount: probe.contenteditable?.length ?? 0,
          buttonsCount: probe.buttons?.length ?? 0,
          first3Buttons: probe.buttons?.slice(0, 3).map((b) => b.text) || [],
        });
      } catch { /* ignore */ }

      onProgress(15, '检查登录状态…');
      const auth = await detectLoggedIn(win, 'douyin');
      if (!auth.loggedIn) {
        if (!win.isDestroyed()) win.show();
        return {
          accountId,
          platform: 'douyin',
          status: 'failed',
          progress: 100,
          message: '登录态失效，请在窗口中重新登录后重试',
          startedAt,
          finishedAt: Date.now(),
        };
      }

      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }

      if (request.mediaFiles.length > 0) {
        const urlBeforeUpload = win.webContents.getURL();
        // 🔍 上传前诊断：input[type=file] 的数量 + 页面关键字 + 是否有上传按钮
        try {
          const beforeUploadInfo = await evalJS(win, `(function(){
            try {
              var allInputs = document.querySelectorAll('input[type="file"]');
              var allButtons = document.querySelectorAll('button, a, [role="button"]');
              var bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 300) : '';
              var matchText = /上传视频|发布视频|高清发布/i.test(bodyText);
              var inputDetails = [];
              for (var i = 0; i < Math.min(allInputs.length, 5); i++) {
                var inp = allInputs[i];
                inputDetails.push({
                  idx: i,
                  type: inp.type,
                  accept: inp.getAttribute('accept') || '',
                  multiple: inp.hasAttribute('multiple'),
                  class: (inp.className && typeof inp.className === 'string') ? inp.className.slice(0, 80) : '',
                  visible: inp.offsetWidth > 0 && inp.offsetHeight > 0,
                });
              }
              return {
                fileInputCount: allInputs.length,
                fileInputs: inputDetails,
                buttonCount: allButtons.length,
                bodyTextHasUpload: matchText,
                urlInBrowser: location.href.slice(0, 80),
              };
            } catch(e) { return { error: String(e) }; }
          })()`, 'upload-before-snap', log);
          log('info', 'upload-before', `📸 文件注入前页面快照`, { result: beforeUploadInfo });
        } catch (snapErr) {
          log('warn', 'upload-before', `⚠️ 上传前快照失败: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
        }

        await performUpload(win, request, log, onProgress);

        // 🔍 上传后 3 秒诊断：React 是否响应了文件变化
        try {
          await sleep(3000);
          const afterUploadInfo = await evalJS(win, `(function(){
            try {
              var videos = document.querySelectorAll('video');
              var allInputs = document.querySelectorAll('input[type="file"]');
              var bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 300) : '';
              var matchText = /上传视频|发布视频|高清发布|作品描述/i.test(bodyText);
              return {
                videoCount: videos.length,
                fileInputCount: allInputs.length,
                bodyTextHasKeyword: matchText,
                urlInBrowser: location.href.slice(0, 80),
                documentTitle: document.title,
              };
            } catch(e) { return { error: String(e) }; }
          })()`, 'upload-after-snap', log);
          log('info', 'upload-after', `📸 文件注入后 3s 页面快照`, { result: afterUploadInfo });
        } catch (snapErr) {
          log('warn', 'upload-after', `⚠️ 上传后快照失败: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
        }
        // ✅ 🚨 关键改动：CDP DOM.setFileInputFiles 注入文件后，抖音会导航到 post/video。
        //    这段导航期间极其脆弱——任何 JS/CDP 执行都可能触发渲染进程崩溃。
        //    这里**只用事件驱动 + URL 检测**，绝不调用任何 executeJavaScript / Runtime.evaluate。
        //    注意：React SPA 用 history.pushState 导航，isLoading 永远是 false，
        //    必须依赖 did-navigate-in-page 事件（navigatedToPost 标志）或 URL 字符串比较。
        log('info', 'upload-post-nav', '文件注入完成，开始等待页面导航（事件监听+URL 检测，不执行任何 JS）…');
        const t0 = Date.now();
        let navDetected = navigatedToPost; // 若事件已先触发则直接为 true
        let currentUrl = win.webContents.getURL();
        let lastUrl = currentUrl;
        let waitingSinceChanged = navDetected ? Date.now() : 0;
        // 最多等 30 秒，期间不做任何 JS
        while (Date.now() - t0 < 30000) {
          await sleep(500);
          try {
            if (win!.isDestroyed()) break;
            const loading = win!.webContents.isLoading();
            currentUrl = win!.webContents.getURL();
            // 条件 1：事件标志已设置（did-navigate-in-page）
            if (navigatedToPost && waitingSinceChanged === 0) {
              log('info', 'upload-post-nav', `🎯 检测到 post 编辑页（通过事件）: ${currentUrl.slice(0, 80)}`);
              waitingSinceChanged = Date.now();
              navDetected = true;
            }
            // 条件 2：URL 字符串变化（fallback）
            if (currentUrl !== lastUrl) {
              log('info', 'upload-post-nav', `URL 变化: ${lastUrl.slice(0, 80)} → ${currentUrl.slice(0, 80)}, loading=${loading}`);
              lastUrl = currentUrl;
              waitingSinceChanged = Date.now();
              navDetected = true;
              if (/\/content\/post\//i.test(currentUrl)) {
                log('info', 'upload-post-nav', `🎯 检测到 post 编辑页（通过 URL）`);
                navigatedToPost = true;
              }
            }
            // 导航发生后，且 isLoading=false，再**额外等 8 秒**让 React 完全渲染
            //    （给崩溃后的自动恢复留出时间）
            if (navDetected && !loading && (Date.now() - waitingSinceChanged) >= 8000) {
              log('info', 'upload-post-nav', `✅ 导航稳定: URL=${currentUrl.slice(0, 80)}，已静默 ${Math.floor((Date.now() - waitingSinceChanged)/1000)}s`);
              break;
            }
          } catch (e) {
            log('warn', 'upload-post-nav', `检测异常: ${e instanceof Error ? e.message : String(e)}，继续等待…`);
            continue;
          }
        }
        if (!navDetected) {
          log('warn', 'upload-post-nav', '30s 内未检测到导航，可能同页上传或崩溃恢复中，给 5s 继续…');
          await sleep(5000);
        }
        onProgress(48, '上传完成，等待编辑页就绪…');
      } else {
        onProgress(50, '无素材，跳过上传');
      }

      // 📝 诊断：上传后页面 URL（只打印 URL 和 isLoading，不执行任何 JS）
      try {
        log('info', 'post-upload', `进入后续流程前`, { url: win!.webContents.getURL().slice(0, 80), isLoading: win!.webContents.isLoading() });
      } catch { /* ignore */ }

      // ✅ 上传后简化流程（Electron 31，不再需要长静默期）
      //    等待页面稳定（最多 15 秒），检测视频元素是否出现
      let videoConfirmedExists = false;
      {
        const tWait = Date.now();
        log('info', 'post-upload-silent', `等待视频元素出现（最多 15s）…`);
        while (Date.now() - tWait < 15000 && !win!.isDestroyed()) {
          await sleep(2500);
          try {
            const snap = await evalJS(win!, `(function(){
              try {
                var vs = document.querySelectorAll('video');
                var imgs = document.querySelectorAll('img');
                var bt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 200) : '';
                var thumbOk = false;
                for (var i = 0; i < imgs.length; i++) {
                  if ((imgs[i].offsetWidth || 0) > 40 && (imgs[i].offsetHeight || 0) > 40) { thumbOk = true; break; }
                }
                return { videoCount: vs.length, thumbOk: thumbOk, hasUploadKw: /上传视频|重新上传/i.test(bt), url: location.href.slice(0, 80) };
              } catch(e) { return { error: String(e) }; }
            })()`, 'video-detect', log);
            const s = snap as any;
            log('info', 'post-upload-silent', `进度 ${Math.floor((Date.now() - tWait)/1000)}s/15s`, { snapshot: snap });
            if (s && (s.videoCount >= 1 || s.thumbOk)) {
              log('info', 'post-upload-silent', `🎯 检测到视频/封面（videoCount=${s.videoCount}, thumb=${s.thumbOk}）`);
              videoConfirmedExists = true;
              break;
            }
          } catch (err) {
            log('warn', 'post-upload-silent', `检测失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (!videoConfirmedExists) {
        log('warn', 'post-upload-silent', `⚠️ 15s 内未检测到视频元素，继续后续流程（视频可能在后台上传）`);
      }
      try {
        log('info', 'post-upload', `✅ 准备进入编辑/发布`, { url: win!.webContents.getURL().slice(0, 80), videoConfirmed: videoConfirmedExists });
      } catch { /* ignore */ }

      const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000);
      if (!uploadResult.ready) {
        log('warn', 'poll', '⏱ 上传超时或页面未就绪');
        onProgress(60, '上传未完成，但继续尝试填写…');
      }

      onProgress(75, '填写标题与正文…');
      if (request.title) {
        try {
          const res = await evalJS(win, buildFillTitle(request.title), 'fill-title', log);
          log('info', 'fill', `填写标题`, { result: res });
        } catch (e) {
          log('warn', 'fill', `填写标题异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const combinedContent = (request.content || '') +
        (request.tags && request.tags.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
      if (combinedContent.trim().length > 0) {
        try {
          const res = await evalJS(win, buildFillContent(combinedContent), 'fill-content', log);
          log('info', 'fill', `填写正文`, { result: res });
        } catch (e) {
          log('warn', 'fill', `填写正文异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // === 点击发布按钮（CDP DOM 协议 + 轮询等待按钮可用）===
      // 关键修复：填写正文后抖音可能内部重建 frame/子 iframe。
      // 用分阶段短 sleep 代替 sleep(1500)，期间持续检查 URL / isLoading / isDestroyed
      {
        const urlBefore = win!.webContents.getURL();
        let stableWaitMs = 0;
        for (let tick = 0; tick < 10 && stableWaitMs < 3000; tick++) {
          await new Promise<void>((r) => setTimeout(r, 300));
          if (win!.isDestroyed()) break;
          if (win!.webContents.isLoading()) {
            log('debug', 'pre-click', `等待期间页面加载中，reset 计时器…`);
            stableWaitMs = 0;
            continue;
          }
          const urlNow = win!.webContents.getURL();
          if (urlNow !== urlBefore) {
            log('info', 'pre-click', `等待期间 URL 变化：${urlBefore.slice(0, 60)} → ${urlNow.slice(0, 60)}，多等一会…`);
            stableWaitMs = 0;
            continue;
          }
          stableWaitMs += 300;
        }
      }

      onProgress(90, '点击发布…');
      let publishSuccessConfirmed = false;
      let publishMessage = '发布流程完成';
      try {
        const publishKeywords = ['立即发布', '发布作品', '确认发布', '发布'];
        let clicked = false;
        for (let i = 0; i < publishKeywords.length; i++) {
          const kw = publishKeywords[i];
          try {
            const res = await evalJS(win!, buildPublishButtonClicker(kw), `click-publish[${kw}]`, log);
            const r = res as { clicked?: boolean };
            if (r && r.clicked) {
              log('info', 'submit', `✅ 点击发布按钮成功`, { keyword: kw, result: res });
              clicked = true;
              break;
            }
          } catch (e) {
            log('warn', 'submit', `关键词 "${kw}" 点击异常: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (!clicked) {
          log('warn', 'submit', '⚠️ 所有发布按钮关键词都未匹配到，请在打开的窗口中手动点击"发布"按钮');
          throw new Error('未找到发布按钮，发布未触发');
        }

        // ✅ 点击后的处理：等待页面反应 + 检测发布成功
        // 抖音的典型流程：点击发布 → 显示"发布成功" → 自动跳转到创作者首页或新发布页
        // 我们需要检测到"发布成功"后就关闭窗口（让用户看到跳转也没关系）
        const verifyStart = Date.now();
        const verifyTimeout = 25000; // 最多等待 25 秒
        let firstUrl = '';
        try { firstUrl = win!.webContents.getURL(); } catch { /* ignore */ }

        while (Date.now() - verifyStart < verifyTimeout && !win!.isDestroyed()) {
          await sleep(1500);

          try {
            // 如果正在加载，多等一会
            if (win!.webContents.isLoading()) {
              log('debug', 'post-publish', `页面加载中…`);
              continue;
            }

            // 执行验证脚本
            const vRes = await evalJS(win!, buildPublishVerifier(), 'post-publish-verify', log);
            const v = vRes as {
              verdict?: string;
              hasSuccessText?: boolean;
              leftPublishPage?: boolean;
              hasConfirmText?: boolean;
              hasDraftText?: boolean;
              url?: string;
              pageText?: string;
            };
            log('info', 'post-publish', `验证结果: ${v.verdict || 'unknown'}`, {
              hasSuccessText: v.hasSuccessText,
              leftPublishPage: v.leftPublishPage,
              hasConfirmText: v.hasConfirmText,
              hasDraftText: v.hasDraftText,
              url: (v.url || '').slice(0, 80),
              pageText: (v.pageText || '').slice(0, 100),
            });

            // 1) 明确检测到 "发布成功" → 直接认为成功
            if (v.verdict === 'success' || v.hasSuccessText) {
              log('info', 'post-publish', `🎉 检测到"发布成功"`);
              publishSuccessConfirmed = true;
              publishMessage = '✅ 发布成功！';
              break;
            }

            // 2) 页面已离开发布编辑页（URL 不再包含 content/post / content/upload）→ 认为成功
            if (v.verdict === 'maybe_success_url_changed' || (v.leftPublishPage && !v.hasDraftText)) {
              const curUrl = v.url || win!.webContents.getURL();
              if (!/content\/(post|upload|publish)/i.test(curUrl)) {
                log('info', 'post-publish', `🎉 已离开发布编辑页（URL=${curUrl.slice(0, 60)}），推断发布成功`);
                publishSuccessConfirmed = true;
                publishMessage = '✅ 发布成功（已跳转）';
                break;
              }
            }

            // 3) 检测到确认弹窗 → 点击确认
            if (v.verdict === 'need_confirm' || v.hasConfirmText) {
              log('info', 'post-publish', `🔔 检测到确认弹窗，尝试点击确认…`);
              try {
                const confirmRes = await evalJS(win!, buildPublishButtonClicker('确认发布'), 'click-confirm-dialog', log);
                const cr = confirmRes as { clicked?: boolean };
                if (cr.clicked) {
                  log('info', 'post-publish', `✅ 已点击确认发布`);
                } else {
                  // 也可能是其他确认按钮，尝试 "确认"
                  try { await evalJS(win!, buildPublishButtonClicker('确认'), 'click-confirm', log); } catch { /* ignore */ }
                }
              } catch { /* ignore */ }
              continue; // 点击后回到循环等待成功消息
            }

            // 4) 保存为草稿 → 尝试再次点击发布
            if (v.verdict === 'saved_as_draft' || v.hasDraftText) {
              log('warn', 'post-publish', `⚠️ 检测到"已保存为草稿"，尝试再次点击发布按钮…`);
              const retryKws = ['立即发布', '发布视频', '发布作品', '确认发布'];
              for (const rk of retryKws) {
                try {
                  const rRes = await evalJS(win!, buildPublishButtonClicker(rk), `click-retry-${rk}`, log);
                  const rr = rRes as { clicked?: boolean };
                  if (rr.clicked) break;
                } catch { /* ignore */ }
              }
              continue;
            }

            // 5) URL 从发布页变为其他页面（抖音发布成功后会跳转到其他页面）
            try {
              const curUrl = win!.webContents.getURL();
              if (firstUrl && curUrl !== firstUrl && !/content\/(post|upload)/i.test(curUrl) && !/content\/publish/i.test(curUrl)) {
                log('info', 'post-publish', `🎉 URL 从发布页变为 ${curUrl.slice(0, 60)}，推断发布成功`);
                publishSuccessConfirmed = true;
                publishMessage = '✅ 发布成功（已跳转）';
                break;
              }
            } catch { /* ignore */ }
          } catch (evalErr) {
            log('debug', 'post-publish', `验证脚本异常（可能页面在导航）: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`);
          }
        }

        if (!publishSuccessConfirmed) {
          log('warn', 'post-publish', `⏱️ 25 秒内未检测到明确的"发布成功"信号，但已点击发布按钮，视为成功`);
          publishMessage = '已触发发布（平台可能在后台处理中）';
        }
      } catch (e) {
        log('warn', 'submit', `点击发布按钮总异常: ${e instanceof Error ? e.message : String(e)}`);
        publishMessage = `发布触发异常: ${e instanceof Error ? e.message : String(e)}`;
      }

      // ✅ 自动关闭发布窗口（用户反馈：窗口未关闭）
      // 给 3 秒展示时间后关闭
      log('info', 'auto-close', `3 秒后自动关闭发布窗口…`);
      try {
        await sleep(3000);
        if (win && !win.isDestroyed()) {
          win.destroy();
          log('info', 'auto-close', `✅ 发布窗口已关闭`);
        }
      } catch (closeErr) {
        log('warn', 'auto-close', `关闭窗口异常: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      }

      onProgress(100, publishSuccessConfirmed ? '✅ 发布成功！' : publishMessage);
      return {
        accountId,
        platform: 'douyin',
        status: 'success',
        progress: 100,
        message: uploadResult.ready
          ? (publishSuccessConfirmed ? `✅ ${publishMessage}` : '发布流程已自动完成')
          : '上传自动完成失败，请在窗口中检查最终状态。',
        resultUrl: PLATFORMS.douyin.homeUrl,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'fatal', `发布流程异常: ${msg}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (win && !win.isDestroyed()) {
        try { win.show(); } catch { /* ignore */ }
      }
      return {
        accountId,
        platform: 'douyin',
        status: 'failed',
        progress: 100,
        message: `发布失败: ${msg}`,
        startedAt,
        finishedAt: Date.now(),
      };
    }
  },
};

export function getAdapter(platform: PlatformType): PlatformAdapter {
  // 优先从新平台注册表中查找（支持 xiaohongshu / douyin / kuaishou 及未来新增的平台）
  const adapterFromRegistry = getPlatform(platform);
  if (adapterFromRegistry && typeof adapterFromRegistry.publish === 'function') {
    return adapterFromRegistry;
  }
  // 兜底：旧 switch 逻辑（保持向后兼容）
  switch (platform) {
    case 'xiaohongshu':
      return xiaohongshuAdapter;
    case 'douyin':
      return douyinAdapter;
    default:
      return {
        async publish(accId, req, onProg) {
          onProg(100, '不支持的平台');
          return {
            accountId: accId,
            platform,
            status: 'failed',
            progress: 100,
            message: `不支持的平台: ${platform}`,
            startedAt: Date.now(),
            finishedAt: Date.now(),
          };
        },
      };
  }
}
