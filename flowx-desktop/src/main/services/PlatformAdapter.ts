import { BrowserWindow } from 'electron';
import { PLATFORMS } from './PlatformRegistry';
import { writePublishLog } from '../utils/logger';
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

async function evalJS(
  win: BrowserWindow,
  code: string,
  desc: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<unknown> {
  try {
    const result = await win.webContents.executeJavaScript(code);
    log('debug', 'eval', `[${desc}]`, {
      result: JSON.stringify(result).slice(0, 300),
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', 'eval-error', `[${desc}] 失败: ${msg}`);
    throw new Error(`[${desc}] 失败: ${msg}`);
  }
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
    try {
      const diag: unknown = await wc.executeJavaScript(`
        (function(){
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
      `);
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

    // 策略 1：直接 CDP DOM.getDocument(pierce=true) → 找所有 input[type=file] → setFileInputFiles
    log('info', 'upload', `策略 1：CDP 直接扫描 file input 并注入（pierce shadow DOM）`);
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
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', {
              nodeId: qr.nodeIds[i],
              files,
            });
            log('info', 'upload', `✅ file input #${i} 注入成功`, { nodeId: qr.nodeIds[i] });
            intercepted = true;
            break;
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
        // 用纯 JS 找到按钮中心坐标
        const coord: unknown = await wc.executeJavaScript(`
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
        `);
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
                  try {
                    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
                      nodeId: qr2.nodeIds[i], files,
                    });
                    log('info', 'upload', `✅ 点击后 file input #${i} 注入成功`, { nodeId: qr2.nodeIds[i] });
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
        '[class*="btn-danger"]'
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
              // 红色/主色按钮最高优先级
              if (/bg-red|primary|danger|submit|publish/i.test(selClass)) selScore += 2000;
              // 精确/部分文字匹配
              if (selText === ${jsonKw}) selScore += 3000;
              else if (selText.indexOf(${jsonKw}) === 0) selScore += 1500; // 以关键词开头
              else if (selText.indexOf(${jsonKw}) !== -1) selScore += 500;
              // 按钮元素加分
              if (selEl.tagName.toLowerCase() === 'button') selScore += 1500;
              // 合理尺寸加分
              if (selEl.offsetWidth >= 60 && selEl.offsetHeight >= 30) selScore += 300;
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
            if (/bg-red|primary|danger|submit|publish|ce-btn/.test(dClass)) dScore += 2000;
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
            if (/bg-red|primary|danger|submit|publish|ce-btn/.test(lClass)) lScore += 2000;
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
      if (result.hasVideoThumbnail && (result.hasTextarea || result.hasContenteditable)) {
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
  const title = await win.webContents.executeJavaScript('document.title || ""').catch(() => '') as string;
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
  log('info', 'upload', `策略：点击 "${clickKeyword}" 按钮 → CDP 拦截文件选择器 → 注入文件`);
  onProgress(30, `触发文件上传（${clickKeyword}）…`);

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
): Promise<{ ready: boolean; finalStatus: string; lastStatus: unknown }> {
  log('info', 'poll', `开始轮询上传状态（最多 ${Math.floor(timeoutMs / 1000)}s）`);
  const start = Date.now();
  let lastPollResult: unknown = null;
  let lastStatusText = 'waiting';
  let pollCount = 0;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const status = (await evalJS(win, buildPollContentFields(), `poll-content-fields #${pollCount}`, log)) as {
        hasTextarea: boolean;
        hasContenteditable: boolean;
        hasPublishButton: boolean;
        pageStatus: string;
        uploadStatus: string;
        hasVideoThumbnail: boolean;
        hasUploadingText: boolean;
        hasProcessingText: boolean;
        visibleInputs: unknown[];
        pageTextSnippet?: string;
      };
      lastPollResult = status;
      lastStatusText = status.pageStatus;

      if (status.pageStatus === 'ready' || status.pageStatus === 'publishable') {
        log('info', 'poll', '✅ 上传完成，页面已就绪', {
          pageStatus: status.pageStatus,
          uploadStatus: status.uploadStatus,
          hasThumbnail: status.hasVideoThumbnail,
          textarea: status.hasTextarea,
          contenteditable: status.hasContenteditable,
          hasPublishButton: status.hasPublishButton,
          visibleInputsCount: status.visibleInputs?.length ?? 0,
          elapsedMs: Date.now() - start,
          polls: pollCount,
        });
        return { ready: true, finalStatus: status.pageStatus, lastStatus: lastPollResult };
      }

      if (status.pageStatus === 'uploading') {
        onProgress(55 + Math.min(15, Math.floor((Date.now() - start) / 10000)), '平台正在上传/转码…');
      } else {
        onProgress(55 + Math.min(15, Math.floor((Date.now() - start) / 10000)), '等待页面加载…');
      }
    } catch (e) {
      log('debug', 'poll', `轮询异常: ${e}`);
    }
    await sleep(3000);
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

      const publishUrl = PLATFORMS.xiaohongshu.publishUrl;
      log('info', 'navigate', `导航到发布页: ${publishUrl}`);
      onProgress(10, '加载发布页面…');
      await win.loadURL(publishUrl, {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);
      log('info', 'navigate', '页面加载完成', { url: win.webContents.getURL() });

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
      } else {
        onProgress(50, '无素材，跳过上传');
        log('info', 'upload', '无素材文件，跳过上传');
      }

      // === 轮询：等待上传完成 + 编辑页面出现 ===
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

      const publishUrl = PLATFORMS.douyin.publishUrl;
      log('info', 'navigate', `导航到发布页: ${publishUrl}`);
      onProgress(10, '加载发布页面…');

      await win.loadURL(publishUrl, {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);
      log('info', 'navigate', '页面加载完成', { url: win.webContents.getURL() });

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
        await performUpload(win, request, log, onProgress);
      } else {
        onProgress(50, '无素材，跳过上传');
      }

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

      await sleep(1500);
      onProgress(90, '点击发布…');
      try {
        const publishKeywords = ['立即发布', '发布作品', '确认发布', '发布'];
        let clicked = false;
        for (let i = 0; i < publishKeywords.length; i++) {
          const kw = publishKeywords[i];
          try {
            const res = await evalJS(win, buildPublishButtonClicker(kw), `click-publish[${kw}]`, log);
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
        }
        await sleep(2500);
        try {
          const confirmRes = await evalJS(win, buildPublishButtonClicker('确认'), 'click-confirm-dialog', log);
          const cr = confirmRes as { clicked?: boolean };
          if (cr.clicked) {
            log('info', 'submit', '✅ 检测到确认弹窗并点击确认', { result: confirmRes });
          }
        } catch { /* ignore */ }
      } catch (e) {
        log('warn', 'submit', `点击发布按钮总异常: ${e instanceof Error ? e.message : String(e)}`);
      }

      onProgress(100, '发布流程完成');
      return {
        accountId,
        platform: 'douyin',
        status: 'success',
        progress: 100,
        message: uploadResult.ready
          ? '发布流程已自动完成。如平台弹出二次确认，请在窗口中手动点击确认。'
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
