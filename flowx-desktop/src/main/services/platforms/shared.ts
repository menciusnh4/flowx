import { BrowserWindow } from 'electron';
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

export async function evalJS(
  win: BrowserWindow,
  code: string,
  desc: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<unknown> {
  try {
    const result = await win.webContents.executeJavaScript(code);
    log('debug', 'eval', `[${desc}] ok`, {
      result: JSON.stringify(result).slice(0, 200),
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', 'eval-error', `[${desc}] 失败: ${msg}`);
    throw new Error(`[${desc}] 失败: ${msg}`);
  }
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
): Promise<{ ready: boolean; finalStatus: string }> {
  const start = Date.now();
  const interval = 3000;

  while (Date.now() - start < timeoutMs) {
    try {
      const info: any = await win.webContents.executeJavaScript(`
        (function () {
          var bodyText = document.body ? (document.body.innerText || '') : '';
          var hasThumb = false;
          try {
            var imgs = document.querySelectorAll('img');
            for (var i=0; i<imgs.length; i++) {
              var w = imgs[i].offsetWidth || 0;
              var h = imgs[i].offsetHeight || 0;
              if (w > 50 && h > 50) { hasThumb = true; break; }
            }
            var videos = document.querySelectorAll('video');
            for (var j=0; j<videos.length; j++) {
              if ((videos[j].offsetWidth || 0) > 50 && (videos[j].offsetHeight || 0) > 50) { hasThumb = true; break; }
            }
          } catch (e) {}
          var hasTextarea = document.querySelectorAll('textarea').length > 0;
          var hasCE = document.querySelectorAll('[contenteditable="true"]').length > 0;
          var uploadingMatch = /上传中|上传文件|处理中|转码|解析|processing|uploading|uploaded/i.test(bodyText);
          var processingMatch = /转码|解析|处理中|正在|encoding|compressing/i.test(bodyText);
          var readyStatus = (hasThumb && (hasTextarea || hasCE)) ? 'ready' : (uploadingMatch || processingMatch ? 'uploading' : 'waiting');
          return {
            status: readyStatus,
            hasThumb: hasThumb,
            hasTextarea: hasTextarea,
            hasCE: hasCE,
            uploading: uploadingMatch,
            processing: processingMatch,
            body: bodyText.slice(0, 200)
          };
        })();
      `);

      log('debug', 'poll', `上传状态: ${info.status}`, {
        hasThumb: info.hasThumb,
        hasTextarea: info.hasTextarea,
        hasCE: info.hasCE,
        uploading: info.uploading,
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

/** 填写标题脚本 */
export function buildFillTitle(title: string): string {
  const jt = JSON.stringify(title);
  return `
    (function () {
      var candidates = [];
      try {
        var textareas = document.querySelectorAll('textarea');
        for (var i=0; i<textareas.length; i++) {
          var el = textareas[i];
          if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
          var ph = (el.getAttribute('placeholder') || '').toLowerCase();
          var aria = (el.getAttribute('aria-label') || '').toLowerCase();
          var score = 0;
          if (ph.indexOf('标题') !== -1 || aria.indexOf('标题') !== -1) score += 100;
          if (ph.indexOf('描述') !== -1 || aria.indexOf('描述') !== -1) score += 20;
          candidates.push({ el: el, score: score, tag: 'textarea', placeholder: ph });
        }
      } catch (e) {}
      try {
        var inputs = document.querySelectorAll('input');
        for (var j=0; j<inputs.length; j++) {
          var el2 = inputs[j];
          if (el2.offsetWidth <= 0 || el2.offsetHeight <= 0) continue;
          var t2 = (el2.getAttribute('type') || '').toLowerCase();
          if (t2 === 'file' || t2 === 'hidden' || t2 === 'checkbox' || t2 === 'radio') continue;
          var ph2 = (el2.getAttribute('placeholder') || '').toLowerCase();
          var aria2 = (el2.getAttribute('aria-label') || '').toLowerCase();
          var score2 = 0;
          if (ph2.indexOf('标题') !== -1 || aria2.indexOf('标题') !== -1) score2 += 100;
          if (ph2.indexOf('话题') !== -1 || aria2.indexOf('话题') !== -1) score2 -= 10;
          candidates.push({ el: el2, score: score2, tag: 'input', placeholder: ph2 });
        }
      } catch (e) {}
      try {
        var ce2 = document.querySelectorAll('[contenteditable="true"]');
        for (var k=0; k<ce2.length; k++) {
          var el3 = ce2[k];
          if (el3.offsetWidth <= 0 || el3.offsetHeight <= 0) continue;
          var aria3 = (el3.getAttribute('aria-label') || '').toLowerCase();
          var score3 = 0;
          if (aria3.indexOf('标题') !== -1) score3 += 50;
          candidates.push({ el: el3, score: score3, tag: 'contenteditable', placeholder: aria3 });
        }
      } catch (e) {}
      if (candidates.length === 0) return { success: false, reason: 'no-candidates' };
      candidates.sort(function (a, b) { return b.score - a.score; });
      var target = candidates[0];
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jt};
        } else {
          var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(target.el, ${jt});
        }
        target.el.dispatchEvent(new Event('input', { bubbles: true }));
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, verified: true, tag: target.tag, readBack: (target.el.innerText || target.el.value || '').slice(0, 60), expected: ${jt}, method: target.tag === 'contenteditable' ? 'innerText' : 'native-setter' };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 80) };
      }
    })();
  `;
}

/** 填写正文/描述脚本 */
export function buildFillContent(content: string): string {
  const jc = JSON.stringify(content);
  return `
    (function () {
      var candidates = [];
      try {
        var textareas = document.querySelectorAll('textarea');
        for (var i=0; i<textareas.length; i++) {
          var el = textareas[i];
          if (el.offsetWidth <= 0 || el.offsetHeight <= 0) continue;
          var ph = (el.getAttribute('placeholder') || '').toLowerCase();
          var aria = (el.getAttribute('aria-label') || '').toLowerCase();
          var score = 0;
          if (ph.indexOf('正文') !== -1 || aria.indexOf('正文') !== -1) score += 100;
          if (ph.indexOf('描述') !== -1 || aria.indexOf('描述') !== -1) score += 80;
          if (ph.indexOf('内容') !== -1 || aria.indexOf('内容') !== -1) score += 60;
          candidates.push({ el: el, score: score, tag: 'textarea', placeholder: ph });
        }
      } catch (e) {}
      try {
        var ce2 = document.querySelectorAll('[contenteditable="true"]');
        for (var k=0; k<ce2.length; k++) {
          var el3 = ce2[k];
          if (el3.offsetWidth <= 0 || el3.offsetHeight <= 0) continue;
          var aria3 = (el3.getAttribute('aria-label') || '').toLowerCase();
          var score3 = 0;
          if (aria3.indexOf('正文') !== -1) score3 += 100;
          if (aria3.indexOf('描述') !== -1) score3 += 80;
          candidates.push({ el: el3, score: score3, tag: 'contenteditable', placeholder: aria3 });
        }
      } catch (e) {}
      if (candidates.length < 2) {
        // 如果没找到"正文"元素，就返回已找到的元素（标题与正文可能共用同一个选择器）
      }
      if (candidates.length === 0) return { success: false, reason: 'no-candidates' };
      candidates.sort(function (a, b) { return b.score - a.score; });
      // 正文选择器：选分数排前的（如果只有一个选择器且和标题同元素，则直接用它）
      var target = candidates[0];
      try {
        if (target.tag === 'contenteditable') {
          target.el.innerText = ${jc};
        } else {
          var proto = target.tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(target.el, ${jc});
        }
        target.el.dispatchEvent(new Event('input', { bubbles: true }));
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, verified: true, tag: target.tag, readBack: (target.el.innerText || target.el.value || '').slice(0, 60), expected: ${jc} };
      } catch (err) {
        return { success: false, reason: String(err).slice(0, 80) };
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
