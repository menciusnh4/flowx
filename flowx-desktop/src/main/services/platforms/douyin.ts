import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import { sleep, makePublishLogger, makePublishWindow, attachNavigationTracker, evalJS, makeFailedResult, uploadViaCDP, waitForUploadComplete, buildPageStructureProbe, cdpInsertTagsWithSpace, cdpFillContentWithNewlines, buildTestModeProbeScript, setupTestModeWindow } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities, ContentType } from '../../../types';

// 视频/图文发布限制
const TITLE_MAX = 80;
const CONTENT_MAX = 1000;
const TAG_MAX = 10;

// 文章发布限制（独立：标题30字，正文8000字）
const ARTICLE_TITLE_MAX = 30;
const ARTICLE_CONTENT_MAX = 8000;
const ARTICLE_TAG_MAX = 10;

// 工具函数
function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '\u2026';
}

function buildContentText(content: string | undefined, tags: string[] | undefined): string {
  const parts: string[] = [];
  if (content && content.trim()) parts.push(content.trim());
  if (tags && tags.length > 0) {
    const cleaned = prepareTags(tags);
    parts.push(cleaned.join(' '));
  }
  const combined = parts.join('\n');
  return truncate(combined, CONTENT_MAX);
}

/**
 * 清洗标签数组：去空、加#前缀、去重、截断
 * @param tags 原始标签数组
 * @param max 最大标签数，默认TAG_MAX
 */
function prepareTags(tags: string[] | undefined, max?: number): string[] {
  if (!tags || tags.length === 0) return [];
  const limit = max || TAG_MAX;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tags) {
    const trimmed = (t || '').trim();
    if (!trimmed) continue;
    const withHash = trimmed.startsWith('#') ? trimmed : '#' + trimmed;
    if (seen.has(withHash)) continue;
    seen.add(withHash);
    result.push(withHash);
    if (result.length >= limit) break;
  }
  return result;
}

// === 登录检测脚本（直接在页面上执行 JS）
async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const info: any = await win.webContents.executeJavaScript(`
      (function () {
        var bodyText = document.body ? (document.body.innerText || '') : '';
        var curUrl = location.href;
        var keywords = ['创作中心', '内容管理', '发布', '作品', '数据', '粉丝'];
        var matched = [];
        var isLoginPage = /login|passport|redirectReason|signin|signup|sso|captcha/i.test(curUrl);
        var nickSelectors = ['.name', '[class*="name-"]'];
        var hasAccountEl = false;
        for (var i = 0; i < nickSelectors.length; i++) {
          var el = document.querySelector(nickSelectors[i]);
          if (el && el.textContent && el.textContent.trim() && el.textContent.trim().length > 0) { hasAccountEl = true; break; }
        }
        for (var j = 0; j < keywords.length; j++) {
          if (bodyText.indexOf(keywords[j]) !== -1) matched.push(keywords[j]);
        }
        var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3);
        return { loggedIn: loggedIn, matched: matched, title: document.title, url: curUrl };
      })();
    `);
    return { loggedIn: info.loggedIn, url: info.url || '', title: info.title || '', matchedKeywords: info.matched };
  } catch (e) {
    return { loggedIn: false, url: '', title: '' };
  }
}

// === 账号信息提取（粉丝/关注/获赞数）
// 🔑 抖音 HTML 结构：标签在前，数字在独立 span 中
//    <div class="statics-kyUhqC">
//      <div class="statics-item-MDWoNA" id="guide_home_following">关注 <span class="number-No6ev9">0</span></div>
//      <div class="statics-item-MDWoNA" id="guide_home_fans">粉丝 <span class="number-No6ev9">2</span></div>
//      <div class="statics-item-MDWoNA">获赞 <span class="number-No6ev9">61</span></div>
//    </div>
// 策略：1) 基于 .number-* 或 .statics-* 容器的 DOM 提取  2) 文本正则兜底
async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    const info = await win.webContents.executeJavaScript(`
      (function () {
        var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };

        // ===== 数字解析 =====
        function _parse(text) {
          try {
            var clean = (text || '').trim().replace(/[,\\s]/g, '');
            var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千])?$/);
            if (!pm) return null;
            var n = parseFloat(pm[1]);
            if (pm[2]) { if (/[万wW]/.test(pm[2])) n *= 10000; else if (/[千kK]/.test(pm[2])) n *= 1000; }
            return Math.round(n);
          } catch (e) { return null; }
        }

        // ===== 从单个容器中提取统计数据 =====
        function _tryContainer(el) {
          if (!el) return;
          try {
            // 方式1：查找 class 含 "number-" 的 span，配合父节点文本标签
            var numSpans = el.querySelectorAll('[class*="number-"]');
            for (var i = 0; i < numSpans.length; i++) {
              var sp = numSpans[i];
              var numVal = _parse(sp.textContent || '');
              if (numVal === null) continue;
              // 从父节点中提取标签（"关注"/"粉丝"/"获赞"）
              var parent = sp.parentNode;
              var label = '';
              if (parent) {
                // 克隆节点后删除自身，得到标签文本
                var clone = parent.cloneNode(true);
                var clones = clone.querySelectorAll('[class*="number-"]');
                for (var ci = 0; ci < clones.length; ci++) { clones[ci].textContent = ''; }
                label = (clone.textContent || '').trim();
              }
              if (!label && parent) label = (parent.textContent || '').replace(/[\\d.万千\\s,]/g, '').trim();
              if (!label) continue;
              if (/关注/.test(label) && r.followCount === null) r.followCount = numVal;
              else if (/粉丝/.test(label) && r.fansCount === null) r.fansCount = numVal;
              else if ((/获赞|点赞|收藏/.test(label)) && r.likeCount === null) r.likeCount = numVal;
            }

            // 方式2：查找 .statics-* 容器中的所有子 div（每个 div 是一个统计项）
            var statItems = el.querySelectorAll('[class*="statics-item"], [class*="stat-item"]');
            for (var si = 0; si < statItems.length; si++) {
              var itemEl = statItems[si];
              var itemText = (itemEl.innerText || itemEl.textContent || '').trim();
              if (!itemText || itemText.length > 40) continue;
              var labelMatch = itemText.match(/(关注|粉丝|获赞|点赞)/);
              var numMatch = itemText.match(/(\\d+(?:\\.\\d+)?[万wWkK千]?)/);
              if (!labelMatch || !numMatch) continue;
              var v = _parse(numMatch[1]);
              if (v === null) continue;
              if (labelMatch[1] === '关注' && r.followCount === null) r.followCount = v;
              else if (labelMatch[1] === '粉丝' && r.fansCount === null) r.fansCount = v;
              else if ((labelMatch[1] === '获赞' || labelMatch[1] === '点赞') && r.likeCount === null) r.likeCount = v;
            }

            // 方式3：从整个容器文本中正则提取
            var fullText = (el.innerText || el.textContent || '').trim();
            if (fullText) {
              var lines = fullText.split(/[\\n\\r\\t]+/);
              for (var li = 0; li < lines.length; li++) {
                var line = lines[li].trim();
                if (!line || line.length > 40) continue;
                // "关注 12" / "粉丝 34" / "获赞 56"
                var m1 = line.match(/(关注|粉丝|获赞|点赞)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);
                if (m1) {
                  var v1 = _parse(m1[2]);
                  if (v1 !== null) {
                    if (m1[1] === '关注' && r.followCount === null) r.followCount = v1;
                    else if (m1[1] === '粉丝' && r.fansCount === null) r.fansCount = v1;
                    else if ((m1[1] === '获赞' || m1[1] === '点赞') && r.likeCount === null) r.likeCount = v1;
                  }
                }
              }
            }
          } catch (e) {}
        }

        // ===== 1) 优先从统计区提取数据 =====
        try {
          var containers = [
            document.querySelector('[class*="statics-"]'),
            document.querySelector('[class*="statics"]'),
            document.querySelector('[class*="header-info"]'),
            document.querySelector('[class*="creator-center"]'),
            document.body
          ];
          for (var ci = 0; ci < containers.length; ci++) {
            if (!containers[ci]) continue;
            _tryContainer(containers[ci]);
            if (r.fansCount !== null && r.followCount !== null && r.likeCount !== null) break;
          }
        } catch (e) {}

        // ===== 2) 昵称 =====
        try {
          var nickSels = ['[class*="header-"] [class*="name-"]', '[class*="name-"]', '[class*="name"]', '.name-box', '.user-name', '.nickname'];
          for (var i = 0; i < nickSels.length; i++) {
            var el = document.querySelector(nickSels[i]);
            if (el && el.textContent && el.textContent.trim()) { r.nickname = el.textContent.trim(); break; }
          }
        } catch (e) {}

        // ===== 3) 头像 =====
        try {
          var avaSels = ['img.user_avatar', 'img[class*="avatar"]', '[class*="avatar"] img', 'img[class*="img-"]'];
          for (var j = 0; j < avaSels.length; j++) {
            var el2 = document.querySelector(avaSels[j]);
            if (el2 && el2.getAttribute && el2.getAttribute('src')) { r.avatar = el2.getAttribute('src'); break; }
          }
        } catch (e) {}

        // ===== 3.5) 抖音号 =====
        try {
          var uniqueIdSels = ['.unique_id', '[class*="unique_id-"]', '[class*="unique_id"]'];
          for (var u = 0; u < uniqueIdSels.length; u++) {
            var uEl = document.querySelector(uniqueIdSels[u]);
            if (uEl && uEl.textContent) {
              var uMatch = uEl.textContent.trim().match(/(?:抖音号|unique_id)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/i);
              if (uMatch && uMatch[1]) {
                r.platformAccountId = uMatch[1];
                break;
              }
            }
          }
          if (!r.platformAccountId) {
            var bodyText = (document.body ? (document.body.innerText || "") : "") || "";
            var uMatch2 = bodyText.match(/(?:抖音号|unique_id)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/i);
            if (uMatch2 && uMatch2[1]) r.platformAccountId = uMatch2[1];
          }
        } catch (e) {}

        // ===== 4) 兜底：body 全文正则 =====
        try {
          var bodyText = (document.body ? (document.body.innerText || '') : '') || '';
          if (r.fansCount === null) {
            var fm = bodyText.match(/粉丝[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
            if (fm && fm[1]) { var v = _parse(fm[1]); if (v !== null) r.fansCount = v; }
          }
          if (r.followCount === null) {
            var flm = bodyText.match(/关注[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
            if (flm && flm[1]) { var v2 = _parse(flm[1]); if (v2 !== null) r.followCount = v2; }
          }
          if (r.likeCount === null) {
            var lm = bodyText.match(/(获赞|点赞)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
            if (lm && lm[2]) { var v3 = _parse(lm[2]); if (v3 !== null) r.likeCount = v3; }
          }
        } catch (e) {}

        return r;
      })();
    `).catch(function () { return {}; });
    return {
      nickname: info.nickname || '',
      avatar: info.avatar || undefined,
      platformAccountId: info.platformAccountId || undefined,
      fansCount: typeof info.fansCount === 'number' ? info.fansCount : undefined,
      followCount: typeof info.followCount === 'number' ? info.followCount : undefined,
      likeCount: typeof info.likeCount === 'number' ? info.likeCount : undefined,
    } as ExtractedAccountInfo;
  } catch (e) {
    return { nickname: '', avatar: undefined, fansCount: undefined } as ExtractedAccountInfo;
  }
}

// === 抖音标题填写脚本（标题是 <input type="text">，不是 contenteditable！）
// 优先级：1) placeholder 含"标题"/"作品标题"的 input  2) 普通 contenteditable（兜底）
// === 抖音标题填写脚本（解决 React 受控组件 state 不更新的问题）
// 🔑 核心修复: 不直接 .value 赋值,而是用 execCommand('insertText')
//    直接 .value 赋值 + dispatchEvent 不会同步 React state → 内容写入后触发 React 重渲染,标题被 state(空) 覆盖
//    execCommand 走原生浏览器输入路径,React 能正确监听并更新 state
function buildFillTitleScript(text: string): string {
  const textJson = JSON.stringify(text);
  return `(function () {
    var text = ${textJson};
    if (!text) return { ok: true, skipped: true };
    // 1) 优先找标题专用 input[type=text]（placeholder 含"标题"）
    try {
      var inputs = document.querySelectorAll('input[type="text"]');
      for (var i1 = 0; i1 < inputs.length; i1++) {
        var inp = inputs[i1];
        var ph = (inp.getAttribute && inp.getAttribute('placeholder')) || '';
        if (/标题|作品标题|添加标题/i.test(ph)) {
          inp.focus();
          // 🔑 用 execCommand 模拟原生输入,让 React 受控组件正确更新 state
          try {
            try { document.execCommand('selectAll'); } catch (eSA) {}
            try { document.execCommand('delete'); } catch (eDel) {}
            // 逐字符插入确保输入法安全
            document.execCommand('insertText', false, text);
          } catch (eCmd) {
            // execCommand 失败兜底: 回退到 .value + dispatchEvent
            inp.value = text;
            try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (eEv) {}
            try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (eEv2) {}
          }
          return { ok: true, method: 'title-input', placeholder: ph };
        }
      }
    } catch (e1) {}
    // 2) 再找 textarea（有的版本用 textarea）
    try {
      var textareas = document.querySelectorAll('textarea');
      for (var i2 = 0; i2 < textareas.length; i2++) {
        var ta = textareas[i2];
        var ph2 = (ta.getAttribute && ta.getAttribute('placeholder')) || '';
        if (/标题|作品标题|添加标题/i.test(ph2)) {
          ta.focus();
          try {
            try { document.execCommand('selectAll'); } catch (eSA) {}
            try { document.execCommand('delete'); } catch (eDel) {}
            document.execCommand('insertText', false, text);
          } catch (eCmd) {
            ta.value = text;
            try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (eEv) {}
          }
          return { ok: true, method: 'title-textarea', placeholder: ph2 };
        }
      }
    } catch (e2) {}
    // 3) 兜底：contenteditable（跳过 ProseMirror）
    try {
      var ceEls = document.querySelectorAll('[contenteditable]');
      for (var i3 = 0; i3 < ceEls.length; i3++) {
        var el = ceEls[i3];
        var ceVal = el.getAttribute && el.getAttribute('contenteditable');
        if (ceVal === 'false') continue;
        var cls = String(el.className || '');
        if (/tiptap|ProseMirror|prosemirror/i.test(cls)) continue;
        el.focus();
        try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (eX) {}
        document.execCommand('insertText', false, text);
        return { ok: true, method: 'contenteditable' };
      }
    } catch (e3) {}
    return { ok: false, reason: 'no-title-field' };
  })();`;
}

// === 抖音内容填写脚本（内容是 contenteditable/ProseMirror）
// 优先级：1) ProseMirror 富文本  2) 普通 contenteditable  3) textarea 兜底
// 写完后保持焦点在编辑器末尾，不 blur（便于后续 CDP 键盘事件输入标签）
function buildFillContentScript(content: string): string {
  const contentJson = JSON.stringify(content);
  return `(function () {
    try {
    var content = ${contentJson};

    // 辅助：将光标移到编辑器末尾
    function moveCursorToEnd(el) {
      try {
        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch(e) {}
    }

    var foundTarget = null;
    var foundKind = '';

    // 1) ProseMirror / tiptap 富文本
    try {
      var pmEls = document.querySelectorAll('[contenteditable]');
      for (var i1 = 0; i1 < pmEls.length; i1++) {
        var e1 = pmEls[i1];
        var ceVal = e1.getAttribute && e1.getAttribute('contenteditable');
        if (ceVal === 'false') continue;
        var cls1 = String(e1.className || '');
        if (/tiptap|ProseMirror|prosemirror/i.test(cls1)) {
          e1.focus();
          try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (eX1) {}
          var lines = content.split('\\n');
          // ProseMirror 是结构化编辑器，insertText 插入 \n 不会创建真正的段落换行
          // 需要逐行插入文本，行之间用 insertParagraph（段落换行）或 insertLineBreak（软换行）
          var useParagraph = true; // 使用段落换行（类似按 Enter 键效果）
          for (var li = 0; li < lines.length; li++) {
            if (lines[li]) {
              document.execCommand('insertText', false, lines[li]);
            }
            if (li < lines.length - 1) {
              // 优先尝试 insertParagraph（硬换行，创建新段落），失败则用 insertLineBreak（软换行）
              var paraOk = false;
              try {
                paraOk = document.execCommand('insertParagraph', false, null);
              } catch (eP) { paraOk = false; }
              if (!paraOk) {
                try {
                  document.execCommand('insertLineBreak', false, null);
                } catch (eLB) {}
              }
            }
          }
          foundTarget = e1;
          foundKind = 'prosemirror';
          break;
        }
      }
    } catch (e1) {}

    // 2) 普通 contenteditable
    if (!foundTarget) {
      try {
        var ceList = document.querySelectorAll('[contenteditable]');
        for (var ci = 0; ci < ceList.length; ci++) {
          var ceEl = ceList[ci];
          var ceVal = ceEl.getAttribute && ceEl.getAttribute('contenteditable');
          if (ceVal === 'false') continue;
          var ceCls = String(ceEl.className || '');
          if (/tiptap|ProseMirror|prosemirror/i.test(ceCls)) continue;
          ceEl.focus();
          try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (eDel) {}
          // 用 insertHTML 插入，将换行符转为 <br> 标签
          // insertText 插入 \n 在 contenteditable 中不会产生真正的换行
          var htmlContent = content.replace(/\\n/g, '<br>');
          var insertOk = false;
          try { insertOk = document.execCommand('insertHTML', false, htmlContent); } catch (eIH) {}
          if (!insertOk) {
            // 兜底：insertText 方式（虽然换行可能丢失，但至少内容能写入）
            try { document.execCommand('insertText', false, content); } catch (eIT) {}
          }
          foundTarget = ceEl;
          foundKind = 'plain-ce';
          break;
        }
      } catch (eCE) {}
    }

    // 3) 兜底 textarea
    if (!foundTarget) {
      try {
        var ta1 = document.querySelectorAll('textarea');
        for (var j1 = 0; j1 < ta1.length; j1++) {
          var e3 = ta1[j1];
          e3.focus();
          e3.value = content;
          try { var ev2 = document.createEvent('Event'); ev2.initEvent('input', true, true); e3.dispatchEvent(ev2); } catch (eErr2) {}
          foundTarget = e3;
          foundKind = 'textarea';
          break;
        }
      } catch (e3) {}
    }

    if (!foundTarget) return { ok: false, reason: 'no-content-field' };

    // 将光标移到末尾，保持焦点（不blur），便于后续CDP输入标签
    if (foundKind !== 'textarea') {
      moveCursorToEnd(foundTarget);
    }

    return { ok: true, method: foundKind, isContentEditable: foundKind !== 'textarea' };
    } catch (e) {
      return { ok: false, reason: 'script-error', error: String(e) };
    }
  })();`;
}

// === 抖音发布按钮点击脚本（精确匹配！排除"高清发布"等导航项）
// === 抖音发布按钮点击脚本（严格精确匹配）
// 目标按钮: <button class="button-dhlUZE primary-cECiOJ fixed-J9O8Yw">发布</button>
// 核心策略:
//   1. 优先匹配 primary- 前缀 class + 文本 "发布" → 最高分
//   2. 兜底匹配文本 + 主按钮样式
//   3. 严格排除导航类按钮(高清发布/发布视频/发布图文等)
function buildClickPublishScript(): string {
  return `(function () {
    var candidates = [];
    try {
      var all = document.querySelectorAll('button, div, a, span');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var txt = (el.innerText || el.textContent || '').trim();
        if (!txt) continue;
        // 🔴 排除所有导航/切换类按钮（不是最终发布按钮）
        if (/高清发布|发布管理|发布作品管理|作品管理|发布列表|发布视频|发布图文|发布全景视频|发布文章|了解上传|作品管理|活动管理|内容管理|数据中心/i.test(txt)) continue;
        if (txt.length > 20) continue; // 太长不可能是按钮
        // 必须包含"发布"关键词
        if (!/发布|立即|确认/.test(txt)) continue;
        var cls = String(el.className || '');
        var score = 0;
        // 🔑 最高优先级: primary 样式 + 精确 "发布" 文本
        // 匹配 class 如: button-dhlUZE primary-cECiOJ fixed-J9O8Yw
        var isPrimaryButton = /primary-c|primary-|button-primary|primary-button/i.test(cls);
        if (isPrimaryButton && (txt === '发布' || txt === '发布作品')) {
          score += 8000;
        }
        // 次优先级: primary 样式 + "立即发布/确认发布"
        else if (isPrimaryButton && (txt === '立即发布' || txt === '确认发布')) {
          score += 6000;
        }
        // 精确文本（非 primary 但可能是另一种样式）
        else if (/^发布作品$|^立即发布$|^确认发布$|^发布$/.test(txt)) {
          score += 3000;
        }
        // 包含"发布"且文本较短
        else if (txt.length <= 8 && /发布/.test(txt)) {
          score += 1000;
        }
        else continue;
        // 主按钮样式额外加分
        if (/publish|ce-btn|primary-button|publish-btn|btn-publish|publish-button/i.test(cls)) score += 500;
        // 可见性检查
        try {
          var rect = el.getBoundingClientRect();
          if (!rect || rect.width < 10 || rect.height < 10) continue;
          if ((el.offsetWidth || 0) < 10 && (el.offsetHeight || 0) < 10) continue;
          var st = window.getComputedStyle(el);
          if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.3)) continue;
        } catch (eSz) {}
        candidates.push({ el: el, score: score, text: txt.slice(0, 40), cls: cls.slice(0, 80) });
      }
    } catch (e) {}
    if (candidates.length > 0) {
      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      // 记录前 3 名候选（调试用）
      var topThree = candidates.slice(0, 3).map(function(c) {
        return { text: c.text, score: c.score, cls: c.cls };
      });
      try {
        top.el.click();
        return { clicked: true, text: top.text, score: top.score, strategy: 'js-click', candidates: topThree };
      } catch (e) {
        try {
          var ev = document.createEvent('Event');
          ev.initEvent('click', true, true);
          top.el.dispatchEvent(ev);
          return { clicked: true, text: top.text, score: top.score, strategy: 'event', candidates: topThree };
        } catch (e2) {
          return { clicked: false, reason: 'click-failed', text: top.text };
        }
      }
    }
    return { clicked: false, reason: 'no-match' };
  })();`;
}

// === 抖音文章封面上传（专门处理封面上传区域，区别于正文图片上传）
// 抖音文章发布需要单独上传封面，流程：
//   1. 立即滚动到封面设置区域
//   2. 等待滚动完成，重新获取坐标
//   3. CDP 真实鼠标点击 → 弹出文件选择对话框
//   4. 选择图片后 → 弹出裁剪确认弹窗
//   5. 点击"完成"按钮确认封面
// 🔑 多重上传策略：
//   方案A：CDP 鼠标真实点击 + Page.handleFileChooser 拦截对话框
//   方案B：CDP Frame 操作跨域 iframe 内的 file input
//   方案C：直接查找并设置 file input（含 iframe + shadow DOM）
// === 抖音文章封面上传（FileChooser 拦截优先版）
// 核心思路：
//   1. 滚动到封面区域
//   2. 🔴 先启用 FileChooser 拦截（最可靠的方案）
//   3. 点击 .cover-Uudq5y.clickable 元素（真正的点击目标）
//   4. 等待 fileChooserOpened 事件 → 自动填充文件
//   5. 兜底：DOM.setFileInputFiles 等方式
//   6. 点击裁剪弹窗"完成"按钮
//   7. 验证上传结果
async function uploadArticleCover(
  win: BrowserWindow,
  coverFile: string,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  log('info', 'cover-upload', '开始上传文章封面: ' + coverFile);
  
  try {
    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 可能已 attached */ }
    
    // ============================================
    // 步骤1：滚动到封面设置区域
    // ============================================
    log('info', 'cover-upload', '[1/5] 滚动到封面设置区域…');
    
    const scrollOk = await scrollToCoverSection(win, log);
    if (!scrollOk) {
      log('warn', 'cover-upload', '滚动到封面区域失败，继续尝试…');
    }
    
    // ============================================
    // 步骤2：读取文件并注入超级 patch（DataTransfer 直接设文件）
    // ============================================
    log('info', 'cover-upload', '[2/5] 注入文件上传 patch…');
    
    // 读取封面文件为 base64
    const fileBuffer = fs.readFileSync(coverFile);
    const base64Data = fileBuffer.toString('base64');
    const fileName = path.basename(coverFile);
    
    // 推断 MIME 类型
    const ext = path.extname(coverFile).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp',
    };
    const mimeType = mimeMap[ext] || 'image/png';
    
    log('info', 'cover-upload', '  封面文件: ' + fileName + 
        ' (' + (fileBuffer.length / 1024).toFixed(1) + 'KB, ' + mimeType + ')');
    
    // 构建超级 patch 脚本（直接在 JS 层面设置文件，不弹对话框）
    const superPatchScript = buildSuperCoverPatchScript(base64Data, fileName, mimeType);
    
    // 启用 Page 域 + 拦截文件选择对话框（防止对话框弹出）
    let pageEnabled = false;
    try {
      await win.webContents.debugger.sendCommand('Page.enable');
      pageEnabled = true;
      log('info', 'cover-upload', '  ✅ Page.enable 成功');
      
      // 启用文件选择对话框拦截 - 对话框不会弹出，我们通过JS设置文件
      try {
        await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
          enabled: true,
        });
        log('info', 'cover-upload', '  ✅ FileChooser 拦截已启用（对话框不会弹出）');
      } catch (interceptErr) {
        log('info', 'cover-upload', '  FileChooser 拦截启用失败: ' + (interceptErr as Error).message);
      }
    } catch (pageErr) {
      log('warn', 'cover-upload', '  Page.enable 失败: ' + (pageErr as Error).message);
    }
    
    // 启用 Runtime 域
    let runtimeEnabled = false;
    const frameContextMap = new Map<string, number>();
    
    try {
      await win.webContents.debugger.sendCommand('Runtime.enable');
      runtimeEnabled = true;
      log('info', 'cover-upload', '  ✅ Runtime.enable 成功');
    } catch (rtErr) {
      log('warn', 'cover-upload', '  Runtime.enable 失败: ' + (rtErr as Error).message);
    }
    
    // 如果 Runtime 启用成功，监听新 frame/context 创建并注入 patch
    let ctxHandler: ((...args: any[]) => void) | null = null;
    if (runtimeEnabled) {
      ctxHandler = async (_event: any, _method: string, params: any) => {
        if (_method === 'Runtime.executionContextCreated') {
          const ctx = params.context;
          if (ctx && ctx.id && ctx.auxData && ctx.auxData.frameId) {
            frameContextMap.set(ctx.auxData.frameId, ctx.id);
            log('info', 'cover-upload', '    [Runtime] 新 context: frameId=' + ctx.auxData.frameId.slice(0, 16) + '...');
            
            // 立即注入 patch
            try {
              await win.webContents.debugger.sendCommand('Runtime.evaluate', {
                expression: superPatchScript,
                contextId: ctx.id,
                returnByValue: true,
              });
            } catch { /* ignore */ }
          }
        }
      };
      win.webContents.debugger.on('message', ctxHandler);
    }
    
    // 在主文档注入 patch
    let patchedFrames = 0;
    try {
      const mainRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: superPatchScript,
        returnByValue: true,
      });
      const mainVal = mainRes?.result?.value;
      if (mainVal && (mainVal.patched || mainVal.alreadyPatched)) {
        patchedFrames++;
        log('info', 'cover-upload', '  ✅ 主文档 patch 注入成功');
      }
    } catch (mainErr) {
      log('info', 'cover-upload', '  主文档 patch: ' + (mainErr as Error).message);
    }
    
    // 尝试在所有 iframe 中注入 patch（通过 Page.getFrameTree）
    try {
      const frameTree: any = await win.webContents.debugger.sendCommand('Page.getFrameTree').catch(() => null);
      if (frameTree && frameTree.frameTree) {
        const childFrames: Array<{ id: string; url: string }> = [];
        const collect = (node: any) => {
          if (node.frame && node.frame.id !== frameTree.frameTree.frame.id) {
            childFrames.push({ id: node.frame.id, url: node.frame.url || '' });
          }
          if (node.childFrames) node.childFrames.forEach(collect);
        };
        collect(frameTree.frameTree);
        
        log('info', 'cover-upload', '  检测到 ' + childFrames.length + ' 个子 frame');
        
        for (const cf of childFrames) {
          try {
            // 创建隔离世界来注入 patch
            const isoRes: any = await win.webContents.debugger.sendCommand('Page.createIsolatedWorld', {
              frameId: cf.id,
              worldName: 'flowx-cover-' + Date.now(),
              grantUniversalAccess: true,
            }).catch(() => null);
            
            if (isoRes && isoRes.executionContextId) {
              await win.webContents.debugger.sendCommand('Runtime.evaluate', {
                expression: superPatchScript,
                contextId: isoRes.executionContextId,
                returnByValue: true,
              });
              patchedFrames++;
              log('info', 'cover-upload', '  ✅ frame ' + cf.url.slice(0, 40) + ' patch 成功');
            }
          } catch (fErr) {
            // 跨域 iframe 可能无法注入，忽略
          }
        }
      }
    } catch (ftErr) {
      log('info', 'cover-upload', '  Frame 遍历: ' + (ftErr as Error).message);
    }
    
    // 等待 patch 生效
    await sleep(500);
    log('info', 'cover-upload', '  Patch 注入完成，共 ' + patchedFrames + ' 个 frame');
    
    // ============================================
    // 步骤3：点击封面区域（patch 会拦截 click 并直接设置文件）
    // ============================================
    log('info', 'cover-upload', '[3/5] 点击封面上传区域…');
    
    const clickOk = await clickCoverAreaV2(win, log);
    if (!clickOk) {
      log('warn', 'cover-upload', '  ⚠️ 点击封面区域失败');
    }
    
    // ============================================
    // 步骤4：轮询检查文件是否设置成功，CDP兜底
    // ============================================
    log('info', 'cover-upload', '[4/5] 等待文件设置…');
    
    let fileSet = false;
    let cdpAttempted = false;
    
    for (let attempt = 0; attempt < 40 && !fileSet; attempt++) {
      await sleep(200);
      
      const checkScript = `
        (function() {
          // 检查 JS 层面是否成功
          if (window.__flowxCoverFileSet) {
            return { fileSet: true, via: 'js-patch', setTime: window.__flowxCoverFileSetTime || 0 };
          }
          
          // 检查是否有 input 已经有文件了（可能页面自己处理了）
          var inputs = document.querySelectorAll('input[type="file"]');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].files && inputs[i].files.length > 0) {
              window.__flowxCoverFileSet = true;
              return { fileSet: true, via: 'existing-input', inputCount: inputs.length };
            }
          }
          
          return {
            fileSet: false,
            inputClickCount: window.__flowxInputClickCount || 0,
            pickerCalled: window.__flowxPickerCalled || false,
            inputCount: inputs.length,
            error: window.__flowxCoverError || null,
          };
        })();
      `;
      
      try {
        const checkRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: checkScript,
          returnByValue: true,
        });
        const checkVal = checkRes?.result?.value;
        
        if (checkVal && checkVal.fileSet) {
          log('info', 'cover-upload', '  ✅ 文件已成功设置（第' + (attempt + 1) + '次检测，via=' + checkVal.via + '）');
          fileSet = true;
          break;
        }
        
        if (checkVal && checkVal.error) {
          log('info', 'cover-upload', '  ⚠️ Patch 报错: ' + checkVal.error);
        }
        
        // 每5次打印一次状态
        if (attempt % 5 === 4) {
          log('info', 'cover-upload', '    状态: inputClick=' + (checkVal?.inputClickCount || 0) + 
              ', pickerCalled=' + (checkVal?.pickerCalled || false) +
              ', inputCount=' + (checkVal?.inputCount || 0));
        }
        
        // 第15次检测（约3秒后）如果还没成功，尝试CDP兜底方案
        if (attempt === 14 && !cdpAttempted) {
          cdpAttempted = true;
          log('info', 'cover-upload', '  JS patch 未成功，尝试 CDP 兜底方案…');
          
          try {
            // CDP方案：通过DOM.getDocument查找所有file input，然后用DOM.setFileInputFiles
            const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', {
              depth: -1,
              pierce: true,
            }).catch(() => null);
            
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
              
              // 查找所有file input，优先选择accept含image的
              const fileInputs: Array<{ nodeId: number; accept: string; score: number }> = [];
              for (const n of allNodes) {
                if (!n || !n.attributes) continue;
                const nodeName = (n.nodeName || '').toLowerCase();
                if (nodeName !== 'input') continue;
                
                let isFile = false;
                let accept = '';
                for (let i = 0; i < n.attributes.length; i += 2) {
                  if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') isFile = true;
                  if (n.attributes[i] === 'accept') accept = n.attributes[i + 1] || '';
                }
                
                if (isFile) {
                  let score = 0;
                  if (/image\//i.test(accept) || accept === '') score += 100;
                  fileInputs.push({ nodeId: n.nodeId, accept: accept, score: score });
                }
              }
              
              log('info', 'cover-upload', '    CDP 找到 ' + fileInputs.length + ' 个 file input');
              
              if (fileInputs.length > 0) {
                fileInputs.sort((a, b) => b.score - a.score);
                const target = fileInputs[0];
                
                try {
                  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
                    nodeId: target.nodeId,
                    files: [coverFile],
                  });
                  log('info', 'cover-upload', '    ✅ CDP DOM.setFileInputFiles 成功（nodeId=' + target.nodeId + '）');
                  
                  // 触发change事件
                  await win.webContents.debugger.sendCommand('Runtime.evaluate', {
                    expression: `
                      (function() {
                        var inputs = document.querySelectorAll('input[type="file"]');
                        for (var i = 0; i < inputs.length; i++) {
                          if (inputs[i].files && inputs[i].files.length > 0) {
                            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                            inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                          }
                        }
                        return true;
                      })();
                    `,
                    returnByValue: true,
                  });
                  
                  fileSet = true;
                } catch (setErr) {
                  log('info', 'cover-upload', '    CDP 设置失败: ' + (setErr as Error).message);
                }
              }
            }
          } catch (cdpErr) {
            log('info', 'cover-upload', '    CDP 兜底异常: ' + (cdpErr as Error).message);
          }
        }
      } catch { /* ignore */ }
    }
    
    // 清理 context 监听器
    if (ctxHandler) {
      win.webContents.debugger.off('message', ctxHandler);
    }
    
    if (!fileSet) {
      log('warn', 'cover-upload', '  ⚠️ 未检测到文件设置标记，尝试继续等待上传…');
    }
    
    // ============================================
    // 步骤5：等待上传完成 + 点击"完成"
    // ============================================
    log('info', 'cover-upload', '[5/5] 等待上传并点击完成…');
    
    // 先按Escape键关闭可能弹出的文件选择对话框
    try {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await sleep(50);
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      log('info', 'cover-upload', '  已发送 Escape 键关闭可能的对话框');
    } catch (escErr) {
      log('info', 'cover-upload', '  Escape 键发送失败: ' + (escErr as Error).message);
    }
    
    await sleep(500);
    
    // 等待上传并多次尝试点击"完成"按钮
    let completeClicked = false;
    for (let clickAttempt = 0; clickAttempt < 10; clickAttempt++) {
      await sleep(800);
      
      // 检查是否有"完成"按钮
      const clickCompleteScript = buildClickCompleteScript();
      const completeRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: clickCompleteScript, returnByValue: true,
      }).catch(() => null);
      
      const completeVal = completeRes?.result?.value;
      
      if (completeVal && completeVal.clicked) {
        log('info', 'cover-upload', '  ✅ 已点击"完成"按钮（尝试' + (clickAttempt + 1) + '次）');
        completeClicked = true;
        await sleep(1000);
        
        // 点击后再按一次Escape，关闭可能残留的弹窗
        try {
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
          });
          await sleep(50);
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
          });
        } catch { /* ignore */ }
        
        break;
      }
      
      // 没找到按钮，检查是否已经显示"编辑封面"（说明上传已完成，可能没有裁剪弹窗）
      if (clickAttempt >= 3) {
        const quickVerify = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: `
            (function() {
              var spans = document.querySelectorAll('span');
              for (var i = 0; i < spans.length; i++) {
                if ((spans[i].innerText || '').trim() === '编辑封面') return true;
              }
              var cover = document.querySelector('.cover-Uudq5y');
              if (cover) {
                var style = cover.getAttribute('style') || '';
                if (style.indexOf('background-image') !== -1) return true;
              }
              return false;
            })();
          `,
          returnByValue: true,
        }).catch(() => null);
        
        if (quickVerify?.result?.value) {
          log('info', 'cover-upload', '  封面已就绪（无裁剪弹窗）');
          completeClicked = true;
          break;
        }
      }
    }
    
    if (!completeClicked) {
      log('info', 'cover-upload', '  未找到"完成"按钮（可能无裁剪弹窗或已自动完成）');
    }
    
    // 最后再按几次Escape确保所有弹窗都关闭
    for (let escI = 0; escI < 3; escI++) {
      try {
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
        });
        await sleep(30);
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
        });
        await sleep(100);
      } catch { /* ignore */ }
    }
    
    await sleep(500);
    
    // 验证封面是否上传成功
    log('info', 'cover-upload', '验证封面上传结果…');
    const verifyOk = await verifyCoverUploaded(win, log);
    
    if (verifyOk) {
      log('info', 'cover-upload', '✅ 封面上传验证成功');
      return true;
    } else {
      log('warn', 'cover-upload', '⚠️ 封面上传验证未通过，但继续发布流程');
      return true; // 即使验证未通过也继续，避免阻塞发布
    }
    
  } catch (err) {
    log('error', 'cover-upload', '封面上传异常: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

// === 辅助：滚动到封面设置区域（CDP 鼠标滚轮 + scrollIntoView 双保险）
async function scrollToCoverSection(
  win: BrowserWindow,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 先尝试 scrollIntoView
  const scrollScript = `
    (function () {
      var selectors = [
        '.mycard-c48v6G',
        '.content-upload-ksKds3',
        '[class*="mycard"]',
        '[class*="cover-upload"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        try {
          var el = document.querySelector(selectors[s]);
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.scrollIntoView({ behavior: 'auto', block: 'center' });
              var r2 = el.getBoundingClientRect();
              return {
                found: true,
                selector: selectors[s],
                top: Math.round(r2.top),
                left: Math.round(r2.left),
                width: Math.round(r2.width),
                height: Math.round(r2.height),
                text: (el.innerText || '').slice(0, 40),
              };
            }
          }
        } catch (e) {}
      }
      // 文本匹配兜底
      var allDivs = document.querySelectorAll('div, span');
      for (var i = 0; i < allDivs.length; i++) {
        var txt = (allDivs[i].innerText || '').trim();
        if (txt.indexOf('点击上传封面图') !== -1 && txt.length < 100) {
          var p = allDivs[i];
          for (var d = 0; d < 8; d++) {
            if (p.parentElement) {
              p = p.parentElement;
              var pr = p.getBoundingClientRect();
              if (pr.width > 50 && pr.height > 30) {
                p.scrollIntoView({ behavior: 'auto', block: 'center' });
                var pr2 = p.getBoundingClientRect();
                return {
                  found: true,
                  selector: 'text-match',
                  top: Math.round(pr2.top),
                  left: Math.round(pr2.left),
                  width: Math.round(pr2.width),
                  height: Math.round(pr2.height),
                  text: txt.slice(0, 40),
                };
              }
            }
          }
        }
      }
      return { found: false, reason: 'no-cover-section' };
    })();
  `;
  
  const scrollRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: scrollScript, returnByValue: true,
  }).catch(() => null);
  
  const scrollVal = scrollRes?.result?.value;
  log('info', 'cover-upload', '  scrollIntoView 结果: ' + (scrollVal ? JSON.stringify(scrollVal).slice(0, 200) : 'unknown'));
  
  if (!scrollVal || !scrollVal.found) {
    return false;
  }
  
  // 等待滚动完成
  await sleep(500);
  
  // 检查元素是否在视口内，如果不在，用 CDP 鼠标滚轮辅助滚动
  const checkVisibleScript = `
    (function () {
      var selectors = ['.mycard-c48v6G', '.content-upload-ksKds3', '[class*="mycard"]'];
      for (var s = 0; s < selectors.length; s++) {
        try {
          var el = document.querySelector(selectors[s]);
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              var visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
              return {
                visible: visible,
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                vh: window.innerHeight,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
            }
          }
        } catch (e) {}
      }
      return { visible: false, reason: 'not-found' };
    })();
  `;
  
  const visRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: checkVisibleScript, returnByValue: true,
  }).catch(() => null);
  
  const visVal = visRes?.result?.value;
  
  if (visVal && visVal.visible) {
    log('info', 'cover-upload', '  ✅ 封面区域已在视口内');
    return true;
  }
  
  // 如果不在视口内，尝试 CDP 鼠标滚轮滚动
  log('info', 'cover-upload', '  封面区域不在视口内，尝试 CDP 鼠标滚轮滚动…');
  
  const viewportH = visVal?.vh || 800;
  const elementTop = visVal?.top || 500;
  
  // 计算需要滚动的距离
  const scrollDistance = elementTop > 0 ? elementTop - viewportH * 0.3 : elementTop;
  
  try {
    // 发送鼠标滚轮事件（在视口中心位置滚动）
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(viewportH * 0.5),
      y: Math.round(viewportH * 0.5),
      deltaX: 0,
      deltaY: scrollDistance,
      wheelTicksX: 0,
      wheelTicksY: Math.round(scrollDistance / 100),
      accelerationRatioX: 0,
      accelerationRatioY: 1,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
    });
    
    await sleep(500);
    
    // 再次检查
    const visRes2: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: checkVisibleScript, returnByValue: true,
    }).catch(() => null);
    
    const visVal2 = visRes2?.result?.value;
    
    if (visVal2 && visVal2.visible) {
      log('info', 'cover-upload', '  ✅ CDP 滚轮滚动后，封面区域已在视口内');
      return true;
    }
    
    // 再尝试 PageDown 键
    log('info', 'cover-upload', '  尝试 PageDown 键滚动…');
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: 34,
      code: 'PageDown',
      key: 'PageDown',
    });
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 34,
      code: 'PageDown',
      key: 'PageDown',
    });
    await sleep(500);
    
    return true; // 不管怎样，继续尝试
  } catch (scrollErr) {
    log('warn', 'cover-upload', '  CDP 滚动异常: ' + (scrollErr as Error).message);
    return false;
  }
}

// === 辅助：点击封面区域（用 CDP 真实鼠标事件）
async function clickCoverArea(
  win: BrowserWindow,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 获取封面元素坐标
  const getCoordsScript = `
    (function () {
      var selectors = [
        '.mycard-c48v6G',
        '.content-upload-ksKds3',
        '.cover-Uudq5y',
        '[class*="mycard"]',
        '[class*="cover-upload"]',
      ];
      
      for (var s = 0; s < selectors.length; s++) {
        try {
          var el = document.querySelector(selectors[s]);
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return {
                found: true,
                selector: selectors[s],
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                x20: Math.round(rect.left + rect.width * 0.2),
                x80: Math.round(rect.left + rect.width * 0.8),
                y20: Math.round(rect.top + rect.height * 0.2),
                y80: Math.round(rect.top + rect.height * 0.8),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                text: (el.innerText || '').slice(0, 40),
                cls: (el.className || '').slice(0, 60)
              };
            }
          }
        } catch (e) {}
      }
      
      // 文本匹配兜底
      var allDivs = document.querySelectorAll('div, span');
      for (var i = 0; i < allDivs.length; i++) {
        var txt = (allDivs[i].innerText || '').trim();
        if (txt.indexOf('点击上传封面图') !== -1 && txt.length < 100) {
          var p = allDivs[i];
          for (var d = 0; d < 8; d++) {
            if (p.parentElement) {
              p = p.parentElement;
              var pr = p.getBoundingClientRect();
              if (pr.width > 50 && pr.height > 30) {
                return {
                  found: true,
                  selector: 'text-match',
                  x: Math.round(pr.left + pr.width / 2),
                  y: Math.round(pr.top + pr.height / 2),
                  x20: Math.round(pr.left + pr.width * 0.2),
                  x80: Math.round(pr.left + pr.width * 0.8),
                  y20: Math.round(pr.top + pr.height * 0.2),
                  y80: Math.round(pr.top + pr.height * 0.8),
                  width: Math.round(pr.width),
                  height: Math.round(pr.height),
                  text: txt.slice(0, 40),
                };
              }
            }
          }
        }
      }
      
      return { found: false, reason: 'no-click-target' };
    })();
  `;
  
  const coordsRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: getCoordsScript, returnByValue: true,
  }).catch(() => null);
  
  const coordsVal = coordsRes?.result?.value;
  log('info', 'cover-upload', '  点击坐标: ' + (coordsVal ? JSON.stringify(coordsVal).slice(0, 250) : 'unknown'));
  
  if (!coordsVal || !coordsVal.found) {
    return false;
  }
  
  // 尝试多个点击位置
  const clickPoints = [
    { x: coordsVal.x, y: coordsVal.y, desc: '中心' },
    { x: coordsVal.x20, y: coordsVal.y20, desc: '左上' },
    { x: coordsVal.x80, y: coordsVal.y80, desc: '右下' },
    { x: coordsVal.x, y: coordsVal.y20, desc: '上中' },
  ];
  
  for (let i = 0; i < clickPoints.length; i++) {
    const pt = clickPoints[i];
    log('info', 'cover-upload', '    尝试点击 ' + pt.desc + ' (' + pt.x + ', ' + pt.y + ')');
    
    try {
      // 鼠标移动到目标位置
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pt.x, y: pt.y,
      });
      await sleep(60);
      
      // 鼠标按下
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      await sleep(100);
      
      // 鼠标释放
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      
      await sleep(300);
      
      // 点击成功（至少我们发出了点击事件）
      log('info', 'cover-upload', '    ✅ ' + pt.desc + ' 点击已发送');
      return true;
    } catch (clickErr) {
      log('warn', 'cover-upload', '    ' + pt.desc + ' 点击异常: ' + (clickErr as Error).message);
    }
  }
  
  return false;
}

// === 辅助：点击封面区域 V2（优先点击 .cover-Uudq5y，JS click + CDP 鼠标双保险）
async function clickCoverAreaV2(
  win: BrowserWindow,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 获取封面元素坐标（优先找 .cover-Uudq5y 和 clickable 元素）
  const getCoordsScript = `
    (function () {
      // 优先级从高到低（用户确认：点击"点击上传封面图"才会触发弹窗）
      var selectors = [
        '.mycard-info-uBuPL9',              // "点击上传封面图" 文本（用户确认的点击目标）
        '.mycard-info-text-span-qfhmNK',    // "选择封面" 文本（带图标的可点击元素）
        '.addIcon-WtgoEN',                  // +号图标
        '.cover-Uudq5y.clickable-TQePcx',   // 上传成功后的封面元素（带 clickable）
        '.cover-Uudq5y',                    // 封面元素
        '[class*="cover-"][class*="clickable"]',
        '[class*="clickable-"][class*="cover"]',
        '.mycard-c48v6G',                   // 卡片容器（兜底）
        '[class*="mycard"]',
        '[class*="addIcon"]',               // 任意 +号图标
      ];
      
      for (var s = 0; s < selectors.length; s++) {
        try {
          var el = document.querySelector(selectors[s]);
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return {
                found: true,
                selector: selectors[s],
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                x20: Math.round(rect.left + rect.width * 0.2),
                x80: Math.round(rect.left + rect.width * 0.8),
                y20: Math.round(rect.top + rect.height * 0.2),
                y80: Math.round(rect.top + rect.height * 0.8),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                text: (el.innerText || '').slice(0, 40),
                cls: (el.className || '').slice(0, 80),
                tagName: el.tagName
              };
            }
          }
        } catch (e) {}
      }
      
      // 文本匹配兜底
      var allDivs = document.querySelectorAll('div, span');
      for (var i = 0; i < allDivs.length; i++) {
        var txt = (allDivs[i].innerText || '').trim();
        if (txt.indexOf('点击上传封面图') !== -1 && txt.length < 100) {
          var p = allDivs[i];
          for (var d = 0; d < 8; d++) {
            if (p.parentElement) {
              p = p.parentElement;
              var pr = p.getBoundingClientRect();
              if (pr.width > 50 && pr.height > 30) {
                return {
                  found: true,
                  selector: 'text-match',
                  x: Math.round(pr.left + pr.width / 2),
                  y: Math.round(pr.top + pr.height / 2),
                  x20: Math.round(pr.left + pr.width * 0.2),
                  x80: Math.round(pr.left + pr.width * 0.8),
                  y20: Math.round(pr.top + pr.height * 0.2),
                  y80: Math.round(pr.top + pr.height * 0.8),
                  width: Math.round(pr.width),
                  height: Math.round(pr.height),
                  text: txt.slice(0, 40),
                  cls: (p.className || '').slice(0, 80),
                  tagName: p.tagName
                };
              }
            }
          }
        }
      }
      
      return { found: false, reason: 'no-click-target' };
    })();
  `;
  
  const coordsRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: getCoordsScript, returnByValue: true,
  }).catch(() => null);
  
  const coordsVal = coordsRes?.result?.value;
  log('info', 'cover-upload', '  点击目标: ' + (coordsVal ? JSON.stringify(coordsVal).slice(0, 300) : 'unknown'));
  
  if (!coordsVal || !coordsVal.found) {
    return false;
  }
  
  // 方案A：CDP 鼠标事件（优先，因为真实鼠标事件能触发 React 合成事件）
  log('info', 'cover-upload', '  [方案A] CDP 真实鼠标事件点击…');
  
  const clickPoints = [
    { x: coordsVal.x, y: coordsVal.y, desc: '中心' },
    { x: coordsVal.x20, y: coordsVal.y20, desc: '左上' },
    { x: coordsVal.x80, y: coordsVal.y80, desc: '右下' },
    { x: coordsVal.x, y: coordsVal.y20, desc: '上中' },
    { x: coordsVal.x20, y: coordsVal.y, desc: '左中' },
  ];
  
  for (let i = 0; i < clickPoints.length; i++) {
    const pt = clickPoints[i];
    log('info', 'cover-upload', '    尝试点击 ' + pt.desc + ' (' + pt.x + ', ' + pt.y + ')');
    
    try {
      // 鼠标移动到目标位置（悬停效果，触发 mouseenter/mouseover）
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pt.x, y: pt.y,
      });
      await sleep(100);
      
      // 鼠标按下
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      await sleep(150);
      
      // 鼠标释放
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
      
      await sleep(200);
      log('info', 'cover-upload', '    ✅ ' + pt.desc + ' CDP 点击已发送');
      return true;
    } catch (clickErr) {
      log('warn', 'cover-upload', '    ' + pt.desc + ' 点击异常: ' + (clickErr as Error).message);
    }
  }
  
  // 方案B：JS click()（兜底）
  log('info', 'cover-upload', '  [方案B] JS click() 兜底…');
  
  const jsClickScript = `
    (function () {
      var selectors = [
         '.mycard-info-uBuPL9',
         '.mycard-info-text-span-qfhmNK',
         '.addIcon-WtgoEN',
         '.cover-Uudq5y.clickable-TQePcx',
         '.cover-Uudq5y',
         '[class*="cover-"][class*="clickable"]',
         '.mycard-c48v6G',
       ];
      for (var s = 0; s < selectors.length; s++) {
        try {
          var el = document.querySelector(selectors[s]);
          if (el) {
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            
            try {
              el.click();
              return { clicked: true, selector: selectors[s], method: 'click()' };
            } catch (e1) {
              try {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { clicked: true, selector: selectors[s], method: 'MouseEvent' };
              } catch (e2) {}
            }
          }
        } catch (e) {}
      }
      return { clicked: false, reason: 'no-element' };
    })();
  `;
  
  const jsClickRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: jsClickScript, returnByValue: true,
  }).catch(() => null);
  
  const jsClickVal = jsClickRes?.result?.value;
  if (jsClickVal && jsClickVal.clicked) {
    log('info', 'cover-upload', '  ✅ JS click() 成功 (' + jsClickVal.method + ', ' + jsClickVal.selector + ')');
    return true;
  }
  
  return false;
}

// === 辅助：生成"超级封面上传 patch"脚本
// 核心思路：
// 1. 拦截 HTMLInputElement.prototype.click()：当 file input 被点击时，
//    直接通过 DataTransfer API 设置文件，不弹出文件选择对话框，
//    然后触发 change/input 事件，让页面正常处理文件上传。
// 2. 拦截 showOpenFilePicker()：直接返回我们的文件，处理 File System Access API。
// 3. 使用 MutationObserver 监听 DOM 中新出现的 file input，立即设置文件。
// 4. 在捕获阶段监听所有 click 事件，查找附近的 file input 并设置文件。
// 5. 设置全局标记 __flowxCoverFileSet 表示文件已设置。
function buildSuperCoverPatchScript(base64Data: string, fileName: string, mimeType: string): string {
  // 转义文件名中的单引号和反斜杠
  const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  
  return `
    (function() {
      try {
        // 如果已经设置过文件，直接返回成功
        if (window.__flowxCoverFileSet) {
          return { alreadyPatched: true, fileSet: true };
        }
        
        // 标记已注入 patch
        window.__flowxSuperPatched = true;
        
        // base64 转 Blob/File
        function base64ToFile(base64, filename, type) {
          try {
            var binaryStr = atob(base64);
            var len = binaryStr.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            return new File([bytes], filename, { type: type });
          } catch (e) {
            window.__flowxCoverError = 'base64ToFile: ' + String(e);
            return null;
          }
        }
        
        // 创建我们的封面文件
        var coverFile = base64ToFile('${base64Data}', '${safeFileName}', '${mimeType}');
        if (!coverFile) {
          return { patched: false, error: 'failed-to-create-file' };
        }
        
        // 检查 input 是否接受图片
        function isImageInput(input) {
          try {
            if (!input || !input.accept) return true; // 无 accept 属性默认接受
            var accept = input.accept || '';
            return /image\\//i.test(accept) || accept === '' || accept === '*/*';
          } catch (e) {
            return true;
          }
        }
        
        // 设置文件到 input 的核心函数
        function setFileToInput(input) {
          try {
            if (!input || input.tagName !== 'INPUT' || input.type !== 'file') {
              return false;
            }
            if (!isImageInput(input)) {
              return false;
            }
            if (input.files && input.files.length > 0 && input.files[0].name === coverFile.name) {
              return true; // 已经设置过了
            }
            
            // 使用 DataTransfer 创建 FileList
            var files;
            try {
              var dt = new DataTransfer();
              dt.items.add(coverFile);
              files = dt.files;
            } catch (dtErr) {
              // 旧浏览器可能不支持 DataTransfer，尝试用 ClipboardEvent 构造
              try {
                var dt2 = new ClipboardEvent('').clipboardData || new DataTransfer();
                dt2.items.add(coverFile);
                files = dt2.files;
              } catch (dt2Err) {
                window.__flowxCoverError = 'DataTransfer: ' + String(dtErr) + ' | ' + String(dt2Err);
                return false;
              }
            }
            
            // 尝试多种方式设置 input.files
            var setFilesSuccess = false;
            
            // 方法1: Object.defineProperty 重定义 files 属性
            try {
              Object.defineProperty(input, 'files', {
                value: files,
                writable: true,
                configurable: true,
                enumerable: true,
              });
              setFilesSuccess = true;
            } catch (defineErr) {}
            
            // 方法2: 尝试调用原型链上的 setter
            if (!setFilesSuccess) {
              try {
                var proto = HTMLInputElement.prototype;
                var desc = Object.getOwnPropertyDescriptor(proto, 'files');
                if (desc && desc.set) {
                  desc.set.call(input, files);
                  setFilesSuccess = true;
                }
              } catch (setterErr) {}
            }
            
            // 方法3: 直接赋值（某些环境下可能生效）
            if (!setFilesSuccess) {
              try {
                input.files = files;
                setFilesSuccess = true;
              } catch (assignErr) {}
            }
            
            if (!setFilesSuccess) {
              window.__flowxCoverError = 'set-files: all methods failed';
              return false;
            }
            
            // 设置 value（有些框架会检查这个）
            try {
              Object.defineProperty(input, 'value', {
                value: 'C:\\\\fakepath\\\\' + coverFile.name,
                writable: true,
                configurable: true,
              });
            } catch (valErr) {
              try { input.value = 'C:\\\\fakepath\\\\' + coverFile.name; } catch (e) {}
            }
            
            // 按正确顺序触发事件：先 input，再 change（React 合成事件需要这样）
            try {
              input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            } catch (e1) {}
            try {
              input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            } catch (e2) {}
            
            window.__flowxCoverFileSet = true;
            window.__flowxCoverFileSetTime = Date.now();
            window.__flowxInputClickCount = (window.__flowxInputClickCount || 0) + 1;
            console.log('[flowx] ✅ 文件已设置到 input: ' + coverFile.name + ', size=' + coverFile.size);
            return true;
          } catch (e) {
            window.__flowxCoverError = 'setFileToInput: ' + String(e);
            return false;
          }
        }
        
        // 扫描并设置页面中已存在的所有图片 file input
        function scanAndSetExistingInputs() {
          try {
            var inputs = document.querySelectorAll('input[type="file"]');
            for (var i = 0; i < inputs.length; i++) {
              if (isImageInput(inputs[i])) {
                setFileToInput(inputs[i]);
              }
            }
          } catch (e) {}
        }
        
        // === Patch 1: 捕获阶段 mousedown/click 事件监听 ===
        // 策略：在用户点击（或代码触发click）时，第一时间阻止文件对话框弹出，然后设置文件
        if (!window.__flowxClickCapturePatched) {
          // 处理点击的核心函数
          function handleClickEvent(e) {
            if (window.__flowxCoverFileSet) return;
            
            var target = e.target;
            var inputsToTry = [];
            
            // 1. 如果点击的就是 file input 本身
            if (target && target.tagName === 'INPUT' && target.type === 'file') {
              inputsToTry.push(target);
            }
            
            // 2. 如果点击的是 label，检查关联的 input
            if (target && target.tagName === 'LABEL') {
              try {
                var forId = target.getAttribute('for');
                if (forId) {
                  var labeledInput = document.getElementById(forId);
                  if (labeledInput && labeledInput.type === 'file') {
                    inputsToTry.push(labeledInput);
                  }
                }
                // label内部也可能有input
                var innerInputs = target.querySelectorAll('input[type="file"]');
                for (var ii = 0; ii < innerInputs.length; ii++) {
                  inputsToTry.push(innerInputs[ii]);
                }
              } catch (err) {}
            }
            
            // 3. 向上查找父元素，收集内部的所有 file input
            var el = target;
            for (var d = 0; d < 10 && el; d++) {
              try {
                var found = el.querySelectorAll ? el.querySelectorAll('input[type="file"]') : [];
                for (var i = 0; i < found.length; i++) {
                  inputsToTry.push(found[i]);
                }
              } catch (qErr) {}
              el = el.parentElement;
            }
            
            // 检查是否有图片类型的input需要处理
            var hasImageInput = false;
            var tried = {};
            var imageInputs = [];
            
            for (var j = 0; j < inputsToTry.length; j++) {
              var inp = inputsToTry[j];
              if (!inp || tried[inp]) continue;
              tried[inp] = true;
              
              if (isImageInput(inp)) {
                hasImageInput = true;
                imageInputs.push(inp);
              }
            }
            
            // 如果有图片input，阻止默认行为（弹出文件对话框）
            if (hasImageInput) {
              try { e.preventDefault(); } catch (pe) {}
              try { e.stopPropagation(); } catch (se) {} // 暂时不阻止传播，让页面UI更新
              window.__flowxInputClickCount = (window.__flowxInputClickCount || 0) + 1;
              console.log('[flowx] 拦截文件选择，准备设置封面');
              
              // 立即设置文件，然后再延迟设置几次确保成功
              for (var k = 0; k < imageInputs.length; k++) {
                (function(input) {
                  setFileToInput(input);
                  setTimeout(function() { setFileToInput(input); }, 0);
                  setTimeout(function() { setFileToInput(input); }, 20);
                  setTimeout(function() { setFileToInput(input); }, 100);
                  setTimeout(function() { setFileToInput(input); }, 300);
                })(imageInputs[k]);
              }
            }
          }
          
          // 在 pointerdown/mousedown 阶段就拦截，更早阻止对话框
          document.addEventListener('pointerdown', handleClickEvent, true);
          document.addEventListener('mousedown', handleClickEvent, true);
          // click阶段也拦截（双保险）
          document.addEventListener('click', handleClickEvent, true);
          
          window.__flowxClickCapturePatched = true;
        }
        
        // === Patch 2: 拦截 HTMLInputElement.prototype.click() 方法 ===
        // 处理代码直接调用 input.click() 的情况
        if (!window.__flowxClickPatched) {
          var originalClick = HTMLInputElement.prototype.click;
          HTMLInputElement.prototype.click = function() {
            if (this.type && this.type.toLowerCase() === 'file') {
              if (isImageInput(this)) {
                window.__flowxInputClickCount = (window.__flowxInputClickCount || 0) + 1;
                console.log('[flowx] input.click() called (code), setting file directly');
                
                // 直接设置文件，不调用原始click（避免弹出对话框）
                setFileToInput(this);
                setTimeout((function(input) { 
                  return function() { setFileToInput(input); };
                })(this), 0);
                setTimeout((function(input) { 
                  return function() { setFileToInput(input); };
                })(this), 50);
                
                // 触发一个合成的click事件，让页面的监听器收到
                try {
                  this.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                  }));
                } catch (dispatchErr) {}
                
                return; // 不调用原始click
              }
            }
            // 非图片input，调用原始方法
            return originalClick.apply(this, arguments);
          };
          window.__flowxClickPatched = true;
        }
        
        // === Patch 3: MutationObserver 监听 DOM 变化，捕获动态创建的 file input ===
        if (!window.__flowxObserverPatched) {
          function scanNode(node) {
            if (!node || node.nodeType !== 1) return;
            try {
              if (node.tagName === 'INPUT' && node.type === 'file') {
                if (isImageInput(node) && !window.__flowxCoverFileSet) {
                  setFileToInput(node);
                }
              }
              // 递归扫描子节点
              if (node.children && node.children.length) {
                for (var i = 0; i < node.children.length; i++) {
                  scanNode(node.children[i]);
                }
              }
              // 扫描 shadow DOM
              try {
                if (node.shadowRoot) {
                  scanNode(node.shadowRoot);
                }
              } catch (se) {}
            } catch (e) {}
          }
          
          var observer = new MutationObserver(function(mutations) {
            if (window.__flowxCoverFileSet) return;
            for (var mi = 0; mi < mutations.length; mi++) {
              var added = mutations[mi].addedNodes;
              if (added && added.length) {
                for (var ni = 0; ni < added.length; ni++) {
                  scanNode(added[ni]);
                }
              }
            }
          });
          
          try {
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
            });
          } catch (obsErr) {}
          
          window.__flowxObserverPatched = true;
        }
        
        // === Patch 4: showOpenFilePicker (File System Access API) ===
        if (!window.__flowxPickerPatched) {
          if (typeof window.showOpenFilePicker === 'function') {
            window.__flowxOriginalPicker = window.showOpenFilePicker.bind(window);
            
            function createFakeFileHandle(file) {
              return {
                kind: 'file',
                name: file.name,
                getFile: function() {
                  return Promise.resolve(file);
                },
                createWritable: function() {
                  return Promise.reject(new Error('NotSupported'));
                },
                isSameEntry: function(other) {
                  return Promise.resolve(other === this);
                },
                __flowxFakeHandle: true
              };
            }
            
            window.showOpenFilePicker = function(options) {
              window.__flowxPickerCalled = true;
              window.__flowxPickerCallCount = (window.__flowxPickerCallCount || 0) + 1;
              console.log('[flowx] showOpenFilePicker called');
              
              // 检查是否请求图片
              var types = (options && options.types) || [];
              var acceptsImages = types.length === 0;
              for (var t = 0; t < types.length; t++) {
                var accept = types[t].accept || {};
                for (var mime in accept) {
                  if (/^image\\//i.test(mime)) {
                    acceptsImages = true;
                  }
                }
              }
              
              if (acceptsImages || types.length === 0) {
                window.__flowxCoverFileSet = true;
                window.__flowxCoverFileSetTime = Date.now();
                console.log('[flowx] ✅ 通过 showOpenFilePicker 返回文件');
                return Promise.resolve([createFakeFileHandle(coverFile)]);
              }
              
              return window.__flowxOriginalPicker(options);
            };
            
            window.__flowxPickerPatched = true;
          } else {
            window.__flowxPickerPatched = true;
          }
        }
        
        // 立即扫描一次已有 input
        scanAndSetExistingInputs();
        
        return {
          patched: true,
          hasClick: true,
          hasPicker: typeof window.showOpenFilePicker === 'function',
          fileName: '${safeFileName}',
        };
      } catch (e) {
        window.__flowxCoverError = 'patch: ' + String(e);
        return { patched: false, error: String(e) };
      }
    })();
  `;
}

// === 辅助：生成 showOpenFilePicker monkey patch 脚本
// 抖音文章封面上传可能使用 File System Access API（showOpenFilePicker），
// 而不是传统的 <input type="file">，所以找不到 input 元素。
// 我们重写 showOpenFilePicker，让它直接返回我们的文件。
function buildShowOpenFilePickerPatch(base64Data: string, fileName: string, mimeType: string): string {
  // 注意：base64Data 可能很长，但对于封面图来说应该没问题
  return `
    (function() {
      try {
        if (window.__flowxPickerPatched) {
          return { alreadyPatched: true };
        }
        
        // 检查是否有 showOpenFilePicker
        var hasPicker = typeof window.showOpenFilePicker === 'function';
        if (!hasPicker) {
          window.__flowxPickerPatched = true;
          return { hasPicker: false };
        }
        
        // 保存原始方法
        var originalPicker = window.showOpenFilePicker.bind(window);
        window.__flowxOriginalPicker = originalPicker;
        
        // base64 转 File 对象
        function base64ToFile(base64, filename, type) {
          var binaryStr = atob(base64);
          var len = binaryStr.length;
          var bytes = new Uint8Array(len);
          for (var i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          return new File([bytes], filename, { type: type });
        }
        
        // 创建假的 FileSystemFileHandle
        function createFakeFileHandle(file) {
          return {
            kind: 'file',
            name: file.name,
            getFile: function() {
              return Promise.resolve(file);
            },
            createWritable: function() {
              return Promise.reject(new Error('NotSupported'));
            },
            isSameEntry: function(other) {
              return Promise.resolve(other === this);
            },
            __flowxFakeHandle: true
          };
        }
        
        // 创建我们的假文件和假 handle
        var fakeFile = base64ToFile('${base64Data}', '${fileName.replace(/'/g, "\\'")}', '${mimeType}');
        var fakeHandle = createFakeFileHandle(fakeFile);
        
        // 重写 showOpenFilePicker
        window.showOpenFilePicker = function(options) {
          window.__flowxPickerCalled = true;
          window.__flowxPickerOptions = options || null;
          window.__flowxPickerCallCount = (window.__flowxPickerCallCount || 0) + 1;
          console.log('[flowx] showOpenFilePicker called #' + window.__flowxPickerCallCount);
          return Promise.resolve([fakeHandle]);
        };
        
        // 也重写 showSaveFilePicker（防止意外调用）
        if (typeof window.showSaveFilePicker === 'function') {
          window.__flowxOriginalSavePicker = window.showSaveFilePicker.bind(window);
          window.showSaveFilePicker = function() {
            return Promise.reject(new Error('AbortError: User aborted'));
          };
        }
        
        // 重写 showDirectoryPicker
        if (typeof window.showDirectoryPicker === 'function') {
          window.__flowxOriginalDirPicker = window.showDirectoryPicker.bind(window);
          window.showDirectoryPicker = function() {
            return Promise.reject(new Error('AbortError: User aborted'));
          };
        }
        
        window.__flowxPickerPatched = true;
        return { hasPicker: true, patched: true, fileName: '${fileName.replace(/'/g, "\\'")}' };
      } catch (e) {
        return { error: String(e) };
      }
    })();
  `;
}

// === 辅助：快速在 frame 中查找并设置文件（用于 fileChooserOpened 触发时立即调用）
// 高频轮询 + 递归 shadow DOM 遍历
async function setFileInFrameQuick(
  win: BrowserWindow,
  coverFile: string,
  frameId: string,
  frameContextMap: Map<string, number>,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 先尝试获取 contextId
  let contextId = frameContextMap.get(frameId);
  if (!contextId) {
    try {
      const isoResult: any = await win.webContents.debugger.sendCommand('Page.createIsolatedWorld', {
        frameId: frameId,
        worldName: 'flowx-quick-' + Date.now(),
        grantUniversalAccess: true,
      }).catch(() => null);
      if (isoResult && isoResult.executionContextId) {
        contextId = isoResult.executionContextId;
      }
    } catch { /* ignore */ }
  }
  
  if (!contextId) {
    log('info', 'cover-upload', '    [quick] 无法获取 contextId，快速方案失败');
    return false;
  }
  
  log('info', 'cover-upload', '    [quick] contextId=' + contextId + '，开始高频轮询…');
  
  // 高频轮询 20 次，每次 30ms
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      // 递归查找所有 input[type=file]，包括 shadow DOM
      const findExpr = `
        (function() {
          var allInputs = [];
          
          function scanElement(el) {
            if (!el) return;
            if (el.nodeType !== 1) return;
            
            // 检查当前元素
            if (el.tagName && el.tagName.toLowerCase() === 'input' && 
                el.type && el.type.toLowerCase() === 'file') {
              allInputs.push(el);
            }
            
            // 遍历子元素
            if (el.children && el.children.length) {
              for (var i = 0; i < el.children.length; i++) {
                scanElement(el.children[i]);
              }
            }
            
            // 遍历 shadow DOM
            try {
              if (el.shadowRoot) {
                scanElement(el.shadowRoot);
              }
            } catch(e) {}
          }
          
          scanElement(document.documentElement);
          
          return { count: allInputs.length, inputs: allInputs.map(function(inp, i) {
            return {
              index: i,
              accept: inp.accept || '',
              className: inp.className || '',
              id: inp.id || '',
            };
          }) };
        })();
      `;
      
      const evalResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: findExpr,
        contextId: contextId,
        returnByValue: true,
      });
      
      const val = evalResult?.result?.value;
      if (val && val.count > 0) {
        log('info', 'cover-upload', '    [quick] 第' + (attempt + 1) + '次找到 ' + val.count + ' 个 input');
        
        // 获取最后一个 input 的 objectId
        const getInputExpr = `
          (function() {
            var allInputs = [];
            function scanElement(el) {
              if (!el || el.nodeType !== 1) return;
              if (el.tagName && el.tagName.toLowerCase() === 'input' && el.type === 'file') {
                allInputs.push(el);
              }
              if (el.children && el.children.length) {
                for (var i = 0; i < el.children.length; i++) {
                  scanElement(el.children[i]);
                }
              }
              try { if (el.shadowRoot) scanElement(el.shadowRoot); } catch(e) {}
            }
            scanElement(document.documentElement);
            if (allInputs.length > 0) return allInputs[allInputs.length - 1];
            return null;
          })();
        `;
        
        const objResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: getInputExpr,
          contextId: contextId,
          returnByValue: false,
        });
        
        const objectId = objResult?.result?.objectId;
        if (objectId) {
          try {
            await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
              objectId: objectId,
              files: [coverFile],
            });
            log('info', 'cover-upload', '    [quick] ✅ 设置文件成功！');
            
            // 触发 change/input 事件
            const triggerExpr = `
              (function() {
                var allInputs = [];
                function scanElement(el) {
                  if (!el || el.nodeType !== 1) return;
                  if (el.tagName && el.tagName.toLowerCase() === 'input' && el.type === 'file') {
                    allInputs.push(el);
                  }
                  if (el.children && el.children.length) {
                    for (var i = 0; i < el.children.length; i++) {
                      scanElement(el.children[i]);
                    }
                  }
                  try { if (el.shadowRoot) scanElement(el.shadowRoot); } catch(e) {}
                }
                scanElement(document.documentElement);
                for (var i = 0; i < allInputs.length; i++) {
                  allInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                  allInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                }
                return allInputs.length;
              })();
            `;
            
            await win.webContents.debugger.sendCommand('Runtime.evaluate', {
              expression: triggerExpr,
              contextId: contextId,
              returnByValue: true,
            });
            
            return true;
          } catch (setErr) {
            log('info', 'cover-upload', '    [quick] 设置失败: ' + (setErr as Error).message);
          }
        }
        break;
      }
    } catch {
      // 继续尝试
    }
    
    await new Promise(r => setTimeout(r, 30));
  }
  
  log('info', 'cover-upload', '    [quick] 20次轮询未找到 input');
  return false;
}

// === 辅助：在指定 frame 中查找 file input 并设置文件
// 使用 Runtime executionContext 方式，直接在 frame 的 JS 上下文中运行代码
async function setFileInFrame(
  win: BrowserWindow,
  coverFile: string,
  frameId: string | undefined,
  frameContextMap: Map<string, number>,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!frameId) return false;
  
  log('info', 'cover-upload', '    [frame方案] 在 frameId=' + frameId.slice(0, 20) + '... 中查找 input');
  log('info', 'cover-upload', '    [frame方案] 已有 ' + frameContextMap.size + ' 个 frame->context 映射');
  
  try {
    // 方案A：用 Runtime.evaluate + contextId 在 frame 上下文中查找 input
    let contextId = frameContextMap.get(frameId);
    
    // 如果没有从事件追踪中拿到 contextId，尝试用 createIsolatedWorld 获取
    if (!contextId) {
      try {
        const isolatedResult: any = await win.webContents.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: frameId,
          worldName: 'flowx-cover-upload',
          grantUniversalAccess: true,
        }).catch(() => null);
        
        if (isolatedResult && isolatedResult.executionContextId) {
          contextId = isolatedResult.executionContextId;
          log('info', 'cover-upload', '    [frame方案] 通过 createIsolatedWorld 获取 contextId=' + contextId);
        }
      } catch (isoErr) {
        log('info', 'cover-upload', '    [frame方案] createIsolatedWorld 失败: ' + (isoErr as Error).message);
      }
    }
    
    if (contextId) {
      log('info', 'cover-upload', '    [frame方案] contextId=' + contextId + '，尝试在 frame 上下文中查找…');
      
      try {
        // 在 frame 上下文中查找所有 file input
        const findInputExpr = `
          (function() {
            var inputs = document.querySelectorAll('input[type="file"]');
            var result = { count: inputs.length, inputs: [] };
            for (var i = 0; i < inputs.length; i++) {
              result.inputs.push({
                index: i,
                accept: inputs[i].accept || '',
                className: inputs[i].className || '',
                visible: inputs[i].offsetWidth > 0 && inputs[i].offsetHeight > 0,
              });
            }
            return result;
          })();
        `;
        
        const evalResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: findInputExpr,
          contextId: contextId,
          returnByValue: true,
        });
        
        const evalVal = evalResult?.result?.value;
        log('info', 'cover-upload', '    [frame方案] frame上下文中找到 ' + 
            (evalVal?.count || 0) + ' 个 input: ' + JSON.stringify(evalVal?.inputs || []).slice(0, 200));
        
        if (evalVal && evalVal.count > 0) {
          // 找到 input 了！现在获取最后一个 input 的 objectId 并设置文件
          const getInputExpr = `
            (function() {
              var inputs = document.querySelectorAll('input[type="file"]');
              if (inputs.length > 0) return inputs[inputs.length - 1];
              return null;
            })();
          `;
          
          const objResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: getInputExpr,
            contextId: contextId,
            returnByValue: false,
          });
          
          const objectId = objResult?.result?.objectId;
          if (objectId) {
            log('info', 'cover-upload', '    [frame方案] 获得 input 的 objectId=' + objectId.slice(0, 30) + '...');
            try {
              await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
                objectId: objectId,
                files: [coverFile],
              });
              log('info', 'cover-upload', '    [frame方案] ✅ 设置文件成功');
              
              // 触发 change/input 事件
              const triggerExpr = `
                (function() {
                  var inputs = document.querySelectorAll('input[type="file"]');
                  for (var i = 0; i < inputs.length; i++) {
                    if (inputs[i].files && inputs[i].files.length > 0) {
                      inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                      inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                    }
                  }
                  return true;
                })();
              `;
              
              await win.webContents.debugger.sendCommand('Runtime.evaluate', {
                expression: triggerExpr,
                contextId: contextId,
                returnByValue: true,
              });
              
              return true;
            } catch (setErr) {
              log('info', 'cover-upload', '    [frame方案] 设置文件失败: ' + (setErr as Error).message);
            }
          }
        }
      } catch (evalErr) {
        log('info', 'cover-upload', '    [frame方案] contextId 方案失败: ' + (evalErr as Error).message);
      }
    }
    
    // 方案B：DOM.getDocument + frameId（可能不支持 frameId 参数，但试试）
    try {
      await sleep(200);
      
      const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', {
        depth: -1,
        pierce: true,
        frameId: frameId,
      } as any).catch(() => null);
      
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
        
        const fileInputs: Array<{ nodeId: number; accept: string; className: string }> = [];
        for (const n of allNodes) {
          if (!n || !n.attributes) continue;
          const nn = (n.nodeName || '').toLowerCase();
          if (nn !== 'input') continue;
          let hasFile = false;
          let acc = '';
          let cls = '';
          for (let i = 0; i < n.attributes.length; i += 2) {
            if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') hasFile = true;
            if (n.attributes[i] === 'accept') acc = n.attributes[i + 1] || '';
            if (n.attributes[i] === 'class') cls = n.attributes[i + 1] || '';
          }
          if (hasFile) fileInputs.push({ nodeId: n.nodeId, accept: acc, className: cls });
        }
        
        log('info', 'cover-upload', '    [frame方案] DOM.getDocument(frameId) 找到 ' + fileInputs.length + ' 个 file input');
        
        for (const fi of fileInputs) {
          try {
            await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
              nodeId: fi.nodeId,
              files: [coverFile],
            });
            log('info', 'cover-upload', '    [frame方案] ✅ 设置文件成功 (nodeId=' + fi.nodeId + ')');
            return true;
          } catch (setErr) {
            log('info', 'cover-upload', '    [frame方案] 设置失败 nodeId=' + fi.nodeId + ': ' + (setErr as Error).message);
          }
        }
      }
    } catch (e) {
      log('info', 'cover-upload', '    [frame方案] DOM.getDocument(frameId) 失败: ' + (e as Error).message);
    }
    
    // 方案C：用 Runtime.evaluate 在主文档中尝试访问 iframe（同源的话可能可以）
    try {
      const iframeScript = `
        (function () {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
              if (idoc) {
                var inputs = idoc.querySelectorAll('input[type="file"]');
                if (inputs.length > 0) {
                  return { found: true, count: inputs.length, frameIndex: i, src: iframes[i].src.slice(0, 80) };
                }
              }
            } catch (e) {
              // 跨域访问失败，正常
            }
          }
          return { found: false, iframeCount: iframes.length };
        })();
      `;
      
      const iframeRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: iframeScript, returnByValue: true,
      }).catch(() => null);
      
      const iframeVal = iframeRes?.result?.value;
      log('info', 'cover-upload', '    [frame方案] 同源iframe检查: ' + (iframeVal ? JSON.stringify(iframeVal) : 'unknown'));
      
      if (iframeVal && iframeVal.found) {
        const setScript = `
          (function () {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
                if (idoc) {
                  var inputs = idoc.querySelectorAll('input[type="file"]');
                  if (inputs.length > 0) {
                    return inputs[inputs.length - 1];
                  }
                }
              } catch (e) {}
            }
            return null;
          })();
        `;
        
        const setRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: setScript,
          returnByValue: false,
        }).catch(() => null);
        
        const objectId = setRes?.result?.objectId;
        if (objectId) {
          log('info', 'cover-upload', '    [frame方案] 获得同源 iframe input 的 objectId=' + objectId.slice(0, 24) + '...');
          try {
            await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
              objectId: objectId,
              files: [coverFile],
            });
            log('info', 'cover-upload', '    [frame方案] ✅ 同源iframe 设置文件成功');
            return true;
          } catch (setErr) {
            log('info', 'cover-upload', '    [frame方案] 同源iframe 设置失败: ' + (setErr as Error).message);
          }
        }
      }
    } catch (e) {
      log('info', 'cover-upload', '    [frame方案] 同源iframe方案异常: ' + (e as Error).message);
    }
    
    return false;
  } catch (e) {
    log('warn', 'cover-upload', '    [frame方案] 异常: ' + (e as Error).message);
    return false;
  }
}

// === 辅助：快速注入封面文件（仅 DOM.getDocument 一种策略，用于高频轮询）
async function injectCoverFileQuick(
  win: BrowserWindow,
  coverFile: string,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { 
      depth: -1, 
      pierce: true 
    }).catch(() => null);
    
    if (!docResult || !docResult.root) return false;
    
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
    
    const fileInputs: Array<{ nodeId: number; accept: string }> = [];
    for (const n of allNodes) {
      if (!n || !n.attributes) continue;
      const nn = (n.nodeName || '').toLowerCase();
      if (nn !== 'input') continue;
      let hasFile = false;
      let acc = '';
      for (let i = 0; i < n.attributes.length; i += 2) {
        if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') hasFile = true;
        if (n.attributes[i] === 'accept') acc = n.attributes[i + 1] || '';
      }
      if (hasFile) fileInputs.push({ nodeId: n.nodeId, accept: acc });
    }
    
    if (fileInputs.length === 0) {
      log('info', 'cover-upload', '    快速查找: 0 个 file input');
      return false;
    }
    
    log('info', 'cover-upload', '    快速查找: 找到 ' + fileInputs.length + ' 个 file input');
    
    // 优先选 accept 含 image 的
    fileInputs.sort((a, b) => {
      const aImg = /image\//i.test(a.accept) ? 1 : 0;
      const bImg = /image\//i.test(b.accept) ? 1 : 0;
      return bImg - aImg;
    });
    
    for (const fi of fileInputs) {
      try {
        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: fi.nodeId,
          files: [coverFile],
        });
        log('info', 'cover-upload', '    ✅ 快速注入成功 (nodeId=' + fi.nodeId + ')');
        return true;
      } catch { /* 继续试下一个 */ }
    }
    
    return false;
  } catch {
    return false;
  }
}

// === 辅助：注入封面文件（多种 CDP 方式）
async function injectCoverFile(
  win: BrowserWindow,
  coverFile: string,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 工具函数：注入文件并触发事件
  const tryInject = async (nodeId: number | undefined, objectId: string | undefined, source: string): Promise<boolean> => {
    try {
      const params: Record<string, unknown> = { files: [coverFile] };
      if (nodeId !== undefined && nodeId !== null) {
        params.nodeId = nodeId;
        log('info', 'cover-upload', '    [' + source + '] 以 nodeId=' + nodeId + ' 注入文件…');
      } else if (objectId !== undefined) {
        params.objectId = objectId;
        log('info', 'cover-upload', '    [' + source + '] 以 objectId=' + objectId.slice(0, 20) + '... 注入文件…');
      } else {
        return false;
      }
      
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', params);
      log('info', 'cover-upload', '    ✅ [' + source + '] 文件注入成功');
      
      // 触发 change 和 input 事件
      try {
        const evtScript = `
          (function () {
            try {
              var count = 0;
              var inputs = document.querySelectorAll('input[type="file"]');
              for (var i = 0; i < inputs.length; i++) {
                if (inputs[i].files && inputs[i].files.length > 0) {
                  try { inputs[i].dispatchEvent(new Event('change', { bubbles: true })); } catch(e1) {}
                  try { inputs[i].dispatchEvent(new Event('input', { bubbles: true })); } catch(e2) {}
                  count++;
                }
              }
              // 也遍历 shadow DOM
              function scanShadow(root) {
                if (!root) return;
                try {
                  var all = root.querySelectorAll('*');
                  for (var j = 0; j < all.length; j++) {
                    try {
                      if (all[j].shadowRoot) {
                        var sInputs = all[j].shadowRoot.querySelectorAll('input[type="file"]');
                        for (var k = 0; k < sInputs.length; k++) {
                          if (sInputs[k].files && sInputs[k].files.length > 0) {
                            try { sInputs[k].dispatchEvent(new Event('change', { bubbles: true })); } catch(e3) {}
                            try { sInputs[k].dispatchEvent(new Event('input', { bubbles: true })); } catch(e4) {}
                            count++;
                          }
                        }
                        scanShadow(all[j].shadowRoot);
                      }
                    } catch(e) {}
                  }
                } catch(e) {}
              }
              scanShadow(document.documentElement);
              return { triggered: count };
            } catch (e) { return { error: String(e) }; }
          })();
        `;
        const evtRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: evtScript, returnByValue: true,
        }).catch(() => null);
        
        const evtVal = evtRes?.result?.value;
        log('info', 'cover-upload', '    [' + source + '] 事件触发: ' + (evtVal ? JSON.stringify(evtVal) : 'unknown'));
      } catch (evtErr) {
        log('warn', 'cover-upload', '    [' + source + '] 事件触发异常: ' + (evtErr as Error).message);
      }
      
      await sleep(1000);
      return true;
    } catch (e) {
      log('warn', 'cover-upload', '    [' + source + '] 注入失败: ' + (e as Error).message);
      return false;
    }
  };
  
  // 策略1：DOM.getDocument(pierce:true) + 递归遍历（含 Shadow DOM + iframe contentDocument）
  try {
    log('info', 'cover-upload', '  [策略1] DOM.getDocument 递归遍历（pierce=true）…');
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
      
      log('info', 'cover-upload', '    遍历 ' + allNodes.length + ' 个节点，查找 file input…');
      
      const fileInputs: Array<{ nodeId: number; accept: string }> = [];
      for (const n of allNodes) {
        if (!n || !n.attributes) continue;
        const nn = (n.nodeName || '').toLowerCase();
        if (nn !== 'input') continue;
        let hasFile = false;
        let acc = '';
        for (let i = 0; i < n.attributes.length; i += 2) {
          if (n.attributes[i] === 'type' && n.attributes[i + 1] === 'file') hasFile = true;
          if (n.attributes[i] === 'accept') acc = n.attributes[i + 1] || '';
        }
        if (hasFile) fileInputs.push({ nodeId: n.nodeId, accept: acc });
      }
      
      log('info', 'cover-upload', '    找到 ' + fileInputs.length + ' 个 file input');
      
      // 优先选 accept 含 image 的
      fileInputs.sort((a, b) => {
        const aImg = /image\//i.test(a.accept) ? 1 : 0;
        const bImg = /image\//i.test(b.accept) ? 1 : 0;
        return bImg - aImg;
      });
      
      for (const fi of fileInputs) {
        log('info', 'cover-upload', '    尝试 nodeId=' + fi.nodeId + ' (accept=' + fi.accept + ')');
        if (await tryInject(fi.nodeId, undefined, '策略1-node' + fi.nodeId)) {
          return true;
        }
      }
    }
  } catch (err) {
    log('warn', 'cover-upload', '  [策略1] 异常: ' + (err as Error).message);
  }
  
  // 策略2：DOM.querySelectorAll 主文档根
  try {
    log('info', 'cover-upload', '  [策略2] DOM.querySelectorAll 搜索…');
    const docResult2: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true }).catch(() => null);
    
    if (docResult2 && docResult2.root && docResult2.root.nodeId !== undefined) {
      const qsaResult: any = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', {
        nodeId: docResult2.root.nodeId,
        selector: 'input[type="file"]',
      }).catch(() => null);
      
      if (qsaResult && qsaResult.nodeIds && qsaResult.nodeIds.length > 0) {
        log('info', 'cover-upload', '    找到 ' + qsaResult.nodeIds.length + ' 个 file input');
        for (const nid of qsaResult.nodeIds) {
          if (await tryInject(nid, undefined, '策略2-node' + nid)) {
            return true;
          }
        }
      }
    }
  } catch (err) {
    log('warn', 'cover-upload', '  [策略2] 异常: ' + (err as Error).message);
  }
  
  // 策略3：Runtime.evaluate 获取 objectId（遍历 iframe 和 shadow DOM）
  try {
    log('info', 'cover-upload', '  [策略3] Runtime.evaluate 获取 input…');
    const script = `
      (function () {
        var allInputs = [];
        
        function collectInputs(root) {
          if (!root) return;
          try {
            var inputs = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
            if (inputs) for (var i = 0; i < inputs.length; i++) allInputs.push(inputs[i]);
            
            var allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
            if (allEls) {
              for (var j = 0; j < allEls.length; j++) {
                try {
                  if (allEls[j].shadowRoot) collectInputs(allEls[j].shadowRoot);
                } catch (e) {}
              }
            }
            
            var iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
            if (iframes) {
              for (var k = 0; k < iframes.length; k++) {
                try {
                  var idoc = iframes[k].contentDocument || (iframes[k].contentWindow && iframes[k].contentWindow.document);
                  if (idoc) collectInputs(idoc);
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
        
        collectInputs(document.documentElement);
        return allInputs.length > 0 ? allInputs[allInputs.length - 1] : null;
      })();
    `;
    
    const evalResult: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: false,
    }).catch(() => null);
    
    if (evalResult && evalResult.result && evalResult.result.objectId) {
      const objectId = evalResult.result.objectId;
      log('info', 'cover-upload', '    获得 objectId=' + objectId.slice(0, 24) + '...');
      if (await tryInject(undefined, objectId, '策略3-objectId')) {
        return true;
      }
    }
  } catch (err) {
    log('warn', 'cover-upload', '  [策略3] 异常: ' + (err as Error).message);
  }
  
  // 策略4：DOM.performSearch 全局搜索
  try {
    log('info', 'cover-upload', '  [策略4] DOM.performSearch 搜索…');
    const searchRes: any = await win.webContents.debugger.sendCommand('DOM.performSearch', {
      query: 'input[type="file"]',
    }).catch(() => null);
    
    if (searchRes && searchRes.result && searchRes.result.length > 0) {
      log('info', 'cover-upload', '    找到 ' + searchRes.result.length + ' 个匹配');
      for (const nid of searchRes.result) {
        if (await tryInject(nid, undefined, '策略4-node' + nid)) {
          return true;
        }
      }
    }
  } catch (err) {
    log('warn', 'cover-upload', '  [策略4] 异常: ' + (err as Error).message);
  }
  
  // 策略5：Page.setInterceptFileChooserDialog 拦截（兜底）
  try {
    log('info', 'cover-upload', '  [策略5] FileChooser 拦截兜底…');
    
    let interceptionEnabled = false;
    try {
      await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
        mode: 'accept',
        files: [coverFile],
      });
      interceptionEnabled = true;
      log('info', 'cover-upload', '    FileChooser 拦截已启用');
    } catch {
      try {
        await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
          mode: 'accept',
          fileChooserFiles: [coverFile],
        } as any);
        interceptionEnabled = true;
      } catch { /* ignore */ }
    }
    
    if (interceptionEnabled) {
      // 重新点击封面区域，触发文件选择对话框
      log('info', 'cover-upload', '    重新点击封面区域触发对话框…');
      await clickCoverArea(win, log);
      await sleep(1500);
      
      // 检查是否有文件被设置（通过 input 的 files 属性）
      const checkScript = `
        (function () {
          var inputs = document.querySelectorAll('input[type="file"]');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].files && inputs[i].files.length > 0) {
              return { hasFile: true, count: inputs[i].files.length };
            }
          }
          return { hasFile: false, totalInputs: inputs.length };
        })();
      `;
      
      const checkRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: checkScript, returnByValue: true,
      }).catch(() => null);
      
      const checkVal = checkRes?.result?.value;
      if (checkVal && checkVal.hasFile) {
        log('info', 'cover-upload', '    ✅ FileChooser 拦截成功，文件已设置');
        return true;
      }
    }
  } catch (err) {
    log('warn', 'cover-upload', '  [策略5] 异常: ' + (err as Error).message);
  }
  
  log('error', 'cover-upload', '  ❌ 所有策略都失败了');
  return false;
}

// === 辅助：验证封面是否上传成功
async function verifyCoverUploaded(
  win: BrowserWindow,
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  const verifyScript = `
    (function () {
      // 检查封面区域是否有背景图（表示上传成功）
      var coverImg = document.querySelector('.cover-Uudq5y');
      if (coverImg) {
        var style = coverImg.getAttribute('style') || '';
        var hasBg = style.indexOf('background-image') !== -1 && style.indexOf('url(') !== -1;
        if (hasBg) return { hasCover: true, note: 'background-image', style: style.slice(0, 100) };
      }
      
      // 检查是否有"编辑封面"文本（表示已上传）
      var allSpans = document.querySelectorAll('span');
      for (var i = 0; i < allSpans.length; i++) {
        var txt = (allSpans[i].innerText || '').trim();
        if (txt === '编辑封面') {
          return { hasCover: true, note: 'found-编辑封面' };
        }
      }
      
      // 检查 mycard 元素的状态变化
      var mycard = document.querySelector('.mycard-c48v6G');
      if (mycard) {
        var mycardText = (mycard.innerText || '').trim();
        // 如果文本从"点击上传封面图"变成了其他内容，可能上传成功了
        if (mycardText.indexOf('点击上传封面图') === -1 && mycardText.length > 0) {
          return { hasCover: true, note: 'text-changed', text: mycardText.slice(0, 50) };
        }
      }
      
      return { hasCover: false, note: 'no-cover-indicator' };
    })();
  `;
  
  const verifyRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: verifyScript, returnByValue: true,
  }).catch(() => null);
  
  const verifyVal = verifyRes?.result?.value;
  log('info', 'cover-upload', '  验证结果: ' + (verifyVal ? JSON.stringify(verifyVal) : 'unknown'));
  
  return verifyVal && verifyVal.hasCover === true;
}

// === 辅助函数：点击完成按钮脚本
function buildClickCompleteScript(): string {
  return `
    (function () {
      try {
        var buttons = document.querySelectorAll('button');
        var candidates = [];
        
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var txt = (btn.innerText || btn.textContent || '').trim();
          if (!txt) continue;
          
          var score = 0;
          if (txt === '完成') score += 1000;
          else if (txt === '确认' || txt === '确定') score += 500;
          
          if (score > 0) {
            var inFooter = false;
            var p = btn.parentElement;
            var d = 0;
            while (p && d < 10) {
              var cls = p.className || '';
              if (typeof cls === 'string' && /footer|dialog|modal|popup/i.test(cls)) { inFooter = true; break; }
              p = p.parentElement;
              d++;
            }
            if (inFooter) score += 500;
            
            var cls = btn.className || '';
            if (typeof cls === 'string' && /primary|completeButton/i.test(cls)) score += 300;
            
            var w = btn.offsetWidth || 0;
            var h = btn.offsetHeight || 0;
            if (w >= 20 && h >= 20) {
              candidates.push({ el: btn, score: score, text: txt, inFooter: inFooter });
            }
          }
        }
        
        if (candidates.length === 0) {
          return { clicked: false, reason: 'no-complete-button', note: '可能没有裁剪弹窗' };
        }
        
        candidates.sort(function (a, b) { return b.score - a.score; });
        var top = candidates[0];
        
        try { top.el.click(); } catch (e1) {
          try { top.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (e2) {}
        }
        
        return { clicked: true, text: top.text, score: top.score };
      } catch (e) {
        return { clicked: false, error: String(e) };
      }
    })();
  `;
}

// === 抖音文章发布引导页检测脚本（检测并点击"我要发文"按钮）
// 引导页结构：
//   <button class="semi-button semi-button-primary container-drag-btn-hcUuRC">
//     <span class="semi-button-content">我要发文</span>
//   </button>
function buildDetectArticleLandingScript(): string {
  return `(function () {
    try {
      // 查找所有 semi-button-content span，文本包含"我要发文"
      var spans = document.querySelectorAll('span.semi-button-content');
      for (var i = 0; i < spans.length; i++) {
        var span = spans[i];
        var txt = (span.innerText || span.textContent || '').trim();
        if (txt === '我要发文' || txt.indexOf('我要发文') !== -1) {
          // 找到父级 button
          var btn = span.closest ? span.closest('button') : null;
          if (!btn) {
            // 兼容不支持 closest 的情况
            var p = span.parentElement;
            while (p && p.tagName !== 'BUTTON' && p.tagName !== 'BODY') { p = p.parentElement; }
            if (p && p.tagName === 'BUTTON') btn = p;
          }
          if (btn) {
            btn.click();
            return { hasLanding: true, clicked: true, text: txt };
          }
          return { hasLanding: true, clicked: false, reason: 'no-button-parent' };
        }
      }
      // 也检查一下是否有"抖音等你大作文章"的标题，确认是引导页
      var titleEl = document.querySelector('[class*="container-drag-title"]');
      if (titleEl && /大作文章|我要发文/.test(titleEl.innerText || '')) {
        // 是引导页但没找到按钮，再尝试找所有 primary 按钮
        var btns = document.querySelectorAll('button.semi-button-primary');
        for (var j = 0; j < btns.length; j++) {
          var b = btns[j];
          var bTxt = (b.innerText || b.textContent || '').trim();
          if (bTxt === '我要发文' || bTxt.indexOf('我要发文') !== -1) {
            b.click();
            return { hasLanding: true, clicked: true, text: bTxt, method: 'fallback' };
          }
        }
        return { hasLanding: true, clicked: false, reason: 'btn-not-found-on-landing' };
      }
      return { hasLanding: false, clicked: false };
    } catch (e) {
      return { hasLanding: false, clicked: false, error: String(e) };
    }
  })();`;
}

// === 抖音发布结果检测脚本（成功跳转到内容管理页视为成功）
function buildPublishResultProbeScript(): string {
  return `(function () {
    var url = location.href;
    var bodyText = document.body ? (document.body.innerText || '') : '';
    var title = document.title || '';
    var successText = bodyText + ' | ' + title;
    // 1) 页面明确显示"发布成功"等
    var textSuccess = /发布成功|发表成功|已发布|发布完成|作品已发布|投稿成功|创建成功/i.test(successText);
    // 2) 离开发布编辑页（URL 不再包含 post/image/publish 等）
    var leftPublishPage = !/content\\/post|content\\/publish|content\\/upload|publish\\/image/i.test(url);
    // 3) URL 明确进入管理页
    var urlSuccess = /content\\/manage|works|works_list|article\\/list|home/i.test(url);
    // 失败信号 - 明确的失败/错误提示关键词（避免与正常页面文字混淆）
    var failPattern = /发布失败|发表失败|提交失败|保存失败|上传失败|不符合要求|违规内容|内容违规|审核未通过|无法发布|发布异常|系统错误|网络异常|系统繁忙|操作失败|出错了|发布出错|请重试|重新发布|不能发布|发布不了/i;
    var fail = failPattern.test(successText);
    // 额外检测：是否有弹出的错误/提示对话框（表单验证失败时常见）
    var hasErrorDialog = false;
    var errorDialogText = '';
    try {
      // 查找常见的弹窗/对话框类名（semi design / arco design / 字节系组件）
      var dialogSelectors = [
        '[class*="semi-modal"]',
        '[class*="arco-modal"]',
        '[class*="dialog-content"]', 
        '[class*="modal-content"]',
        '[class*="popup-content"]',
        '[class*="toast"]',
        '[class*="message-"]',
        '[class*="notification"]',
        '[role="dialog"]',
        '[role="alertdialog"]'
      ];
      for (var si = 0; si < dialogSelectors.length; si++) {
        var dialogs = document.querySelectorAll(dialogSelectors[si]);
        for (var di = 0; di < dialogs.length; di++) {
          var dEl = dialogs[di];
          // 检查元素是否可见
          var style = window.getComputedStyle(dEl);
          if (style.display === 'none' || style.visibility === 'hidden' || (parseFloat(style.opacity) || 1) < 0.1) continue;
          var dText = (dEl.innerText || dEl.textContent || '').trim();
          if (dText && dText.length < 500) {
            // 检查弹窗中是否有明确的错误/警告关键词
            if (/失败|错误|异常|不能|无法|请输入|请填写|不能为空|请上传|不符合|提示|注意/.test(dText)) {
              // 排除一些正常的提示（如"温馨提示"如果内容是正常引导则不算失败）
              // 但如果是发布操作后弹出的，且包含负面词汇，则认为是失败
              if (/失败|错误|异常|不能发布|无法发布|不符合要求|不能为空|请输入.*内容|请输入.*标题|请上传.*封面|内容不足|字数不足/.test(dText)) {
                hasErrorDialog = true;
                errorDialogText = dText.slice(0, 200);
                break;
              }
            }
          }
        }
        if (hasErrorDialog) break;
      }
    } catch (e) {}
    return {
      url: url,
      text: successText.slice(0, 400),
      success: textSuccess || urlSuccess || leftPublishPage,
      fail: fail || hasErrorDialog,
      errorText: errorDialogText
    };
  })();`;
}

// === 核心发布流程
async function runDouyinPublish(accountId: string, request: PublishRequest, onProgress: ProgressCallback, contentType: ContentType): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId: accountId, platform: 'douyin' });
  // 🔑 根据 contentType 直接进入正确的发布页：
  //   - 视频：/content/upload（默认，tab=1）
  //   - 图文：/content/upload?default-tab=3（图片上传 tab）
  //   - 文章：/content/upload?default-tab=4（长文/文章 tab）
  let publishUrl = 'https://creator.douyin.com/creator-micro/content/upload';
  const isImage = contentType === 'image';
  const isArticle = contentType === 'article';
  if (isImage) publishUrl = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3';
  else if (isArticle) publishUrl = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=4';
  const title = '抖音发布 - ' + accountId;
  let win: BrowserWindow | null = null;
  let tracker: any = null;
  try {
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);
    onProgress(5, '加载' + (isImage ? '图文' : (isArticle ? '文章' : '视频')) + '发布页…');
    log('info', 'load', '目标 URL: ' + publishUrl);
    await win.loadURL(publishUrl);
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(2000);
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      win.show();
      onProgress(15, '请在窗口中登录抖音账号…');
      const deadline = Date.now() + 120000;
      let logged = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (win && !win.isDestroyed()) {
          const rec = await detectLoggedIn(win).catch(function () { return { loggedIn: false }; });
          if (rec && rec.loggedIn) { logged = true; break; }
        }
      }
      if (!logged) return makeFailedResult(accountId, 'douyin', '登录超时', startedAt);
      log('info', 'login', '登录成功');
      // 登录后重新加载对应类型的发布页
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(2000);
    } else {
      log('info', 'login', '已登录，当前 URL: ' + win.webContents.getURL().slice(0, 80));
    }
    log('info', 'page', '发布页加载完成，URL: ' + win.webContents.getURL().slice(0, 100));

    // 上传素材
    const mediaFiles = request.mediaFiles || [];
    if (mediaFiles.length === 0) return makeFailedResult(accountId, 'douyin', '未提供媒体文件', startedAt);
    const mediaType = isImage ? '图片' : (isArticle ? '图文素材' : '视频');
    onProgress(25, '上传 ' + mediaFiles.length + ' 个' + mediaType + '…');
    const uploadOk = await uploadViaCDP(win, mediaFiles, log, contentType);
    if (!uploadOk) return makeFailedResult(accountId, 'douyin', '上传失败', startedAt);
    onProgress(40, '等待上传完成…');
    const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
    // 窗口已销毁：立即终止发布流程
    if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
      log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
      return makeFailedResult(accountId, 'douyin', '发布窗口已被关闭，发布已终止', startedAt);
    }
    if (!uploadResult.ready) { log('warn', 'upload', '上传完成检测失败: ' + uploadResult.finalStatus); }
    onProgress(60, '上传完成，准备填写内容…');
    await sleep(1500);
    const titleText = truncate((request.title || '').trim(), TITLE_MAX);
    const baseContent = truncate((request.content || '').trim(), CONTENT_MAX);
    const douyinTagList = prepareTags(request.tags);
    log('info', 'fill', '准备写入: title=' + (titleText || '').slice(0, 40) + ', contentLen=' + baseContent.length + ', tags=' + douyinTagList.length);
    if (titleText) {
      const script1 = buildFillTitleScript(titleText);
      const res1: any = await evalJS(win, script1, 'fill-title', log).catch(function () { return null; });
      if (!res1 || !res1.ok) log('warn', 'fill', '标题填写失败');
      else log('info', 'fill', '标题已写入');
      await sleep(800);
    }
    // 内容填写结果（用于测试模式）
    let contentResult: any = null;
    if (baseContent || douyinTagList.length > 0) {
      // 探测编辑器类型：如果是普通 contenteditable（ACE 编辑器），用 CDP Enter 方式换行更可靠
      if (baseContent) {
        const probeScript = `(function(){
          try {
            var ce = document.querySelectorAll('[contenteditable]');
            var plainCE = null;
            var pmCE = null;
            for (var i = 0; i < ce.length; i++) {
              var val = ce[i].getAttribute && ce[i].getAttribute('contenteditable');
              if (val === 'false' || val === null) continue;
              var cls = String(ce[i].className || '');
              if (/tiptap|ProseMirror|prosemirror/i.test(cls)) {
                if (!pmCE) pmCE = ce[i];
              } else {
                // 普通 contenteditable，找内容区域（非标题）
                var txt = (ce[i].innerText || ce[i].textContent || '').trim();
                if (!plainCE || txt.length > (plainCE._len || 0)) {
                  plainCE = ce[i];
                  plainCE._len = txt.length;
                }
              }
            }
            if (pmCE) return { type: 'prosemirror' };
            if (plainCE) return { type: 'plain-ce' };
            return { type: 'unknown' };
          } catch(e) { return { type: 'error', err: String(e) }; }
        })()`;
        const probeRes: any = await evalJS(win, probeScript, 'probe-editor', log).catch(() => null);
        const editorType = probeRes && probeRes.type ? probeRes.type : 'plain-ce';
        log('info', 'fill', `编辑器类型: ${editorType}`);

        if (editorType === 'plain-ce' || editorType === 'auto') {
          // 普通 contenteditable（如 ACE 编辑器）：用 CDP Enter 方式换行，确保生成正确的行结构
          contentResult = await cdpFillContentWithNewlines(win, baseContent, 'plain-ce', log);
          if (!contentResult || !contentResult.ok) {
            // CDP 方式失败，降级用 JS 方式
            log('warn', 'fill', 'CDP正文填写失败，降级用JS方式');
            const script2 = buildFillContentScript(baseContent);
            contentResult = await evalJS(win, script2, 'fill-content', log).catch(() => null);
          }
        } else {
          // ProseMirror 或其他：用原 JS 方式
          const script2 = buildFillContentScript(baseContent);
          contentResult = await evalJS(win, script2, 'fill-content', log).catch(() => null);
        }
      } else {
        // 没有正文，只有话题：用轻量脚本只查找并聚焦编辑器，不做删除/插入操作
        // 避免复杂的 fill 脚本在空内容时意外报错，导致标签也无法输入
        const focusScript = `(function () {
          function moveCursorToEnd(el) {
            try {
              el.focus();
              var range = document.createRange();
              range.selectNodeContents(el);
              range.collapse(false);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch(e) {}
          }
          // 1) 先找 ProseMirror / tiptap 富文本
          var pmEls = document.querySelectorAll('[contenteditable]');
          for (var i = 0; i < pmEls.length; i++) {
            var el = pmEls[i];
            var ceVal = el.getAttribute && el.getAttribute('contenteditable');
            if (ceVal === 'false') continue;
            var cls = String(el.className || '');
            if (/tiptap|ProseMirror|prosemirror/i.test(cls)) {
              moveCursorToEnd(el);
              return { ok: true, method: 'prosemirror', isContentEditable: true };
            }
          }
          // 2) 再找普通 contenteditable
          for (var i = 0; i < pmEls.length; i++) {
            var el = pmEls[i];
            var ceVal = el.getAttribute && el.getAttribute('contenteditable');
            if (ceVal === 'false') continue;
            var cls = String(el.className || '');
            if (/tiptap|ProseMirror|prosemirror/i.test(cls)) continue;
            moveCursorToEnd(el);
            return { ok: true, method: 'plain-ce', isContentEditable: true };
          }
          // 3) 兜底 textarea
          var ta = document.querySelector('textarea');
          if (ta) {
            ta.focus();
            return { ok: true, method: 'textarea', isContentEditable: false };
          }
          return { ok: false, reason: 'no-editor-found' };
        })()`;
        contentResult = await evalJS(win, focusScript, 'focus-editor', log).catch(() => null);
      }

      if (!contentResult || !contentResult.ok) {
        log('warn', 'fill', '内容填写失败');
      } else {
        log('info', 'fill', '内容已写入 (' + (contentResult && contentResult.method) + ')');
      }
      await sleep(500);
      // 通过 CDP 真实键盘事件逐个输入话题标签
      if (douyinTagList.length > 0 && contentResult && contentResult.ok && contentResult.isContentEditable) {
        await cdpInsertTagsWithSpace(win, douyinTagList, baseContent.length > 0, log);
        await sleep(300);
      }
    }
    onProgress(75, '点击发布按钮…');

    // 测试模式：不点击发布，高亮标记按钮并收集表单状态
    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          'button.primary-cECiOJ',
          'button.button-dhlUZE',
          'button[type="submit"]',
          '.publish-btn',
          '.submit-btn',
        ],
        [
          { name: '标题', selector: 'input[placeholder*="标题"]', type: 'input' },
          { name: '描述/正文', selector: '[contenteditable="true"]', type: 'contenteditable' },
          { name: '描述文本框', selector: 'textarea', type: 'textarea' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name.includes('描述') || f.name.includes('正文'))?.filled),
        tagsFilled: douyinTagList.length > 0 && !!(contentResult && contentResult.ok),
        coverUploaded: !!(request.coverImage && request.coverImage.length > 0),
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: testRes?.note || '测试模式完成',
      };
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      // 确保测试模式窗口能正常关闭
      setupTestModeWindow(win, log);
      return {
        accountId: accountId,
        platform: 'douyin',
        status: 'success',
        progress: 100,
        message: '测试完成 - 表单填写验证通过',
        startedAt: startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

    const clickScript = buildClickPublishScript();
    const clickRes: any = await evalJS(win, clickScript, 'click-publish', log).catch(function () { return null; });
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', '发布按钮点击失败');
    } else {
      log('info', 'publish', '发布按钮已点击 (text=' + clickRes.text + ')');
    }
    onProgress(85, '等待发布结果…');
    const resultDeadline = Date.now() + 120000;
    let lastUrl = '', lastText = '', lastError = '';
    while (Date.now() < resultDeadline) {
      if (!win || win.isDestroyed()) break;
      try {
        const check: any = await evalJS(win, buildPublishResultProbeScript(), 'check-result', log).catch(function () { return null; });
        if (check) {
          lastUrl = check.url || '';
          lastText = check.text || '';
          if (check.errorText) lastError = check.errorText;
          if (check.success) {
            log('info', 'done', '发布成功');
            onProgress(100, '发布成功');
            return { accountId: accountId, platform: 'douyin', status: 'success', progress: 100, message: '发布成功', url: lastUrl, startedAt: startedAt, finishedAt: Date.now() } as PublishItemProgress;
          }
          if (check.fail) {
            var failMsg = '发布失败';
            if (check.errorText) failMsg = failMsg + ': ' + check.errorText;
            log('warn', 'done', '页面提示失败: ' + (check.errorText || '未知原因'));
            return makeFailedResult(accountId, 'douyin', failMsg, startedAt);
          }
        }
      } catch (e) {}
      await sleep(2500);
    }
    var timeoutMsg = '等待发布结果超时';
    if (lastError) timeoutMsg = timeoutMsg + ' (' + lastError + ')';
    return makeFailedResult(accountId, 'douyin', timeoutMsg, startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', '发布流程异常: ' + msg);
    return makeFailedResult(accountId, 'douyin', msg, startedAt);
  } finally {
    if (tracker) { try { tracker.dispose(); } catch (e) {} }
    // 测试模式：不关闭窗口，让用户可以检查表单填写情况
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
      setTimeout(function () { try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {} }, 3000);
    }
  }
}

// === 对外接口
async function publishVideo(accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> {
  return runDouyinPublish(accountId, request, onProgress, 'video');
}
async function publishImage(accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> {
  return runDouyinPublish(accountId, request, onProgress, 'image');
}
async function publishArticle(accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId: accountId, platform: 'douyin' });
  // 🔑 文章发布专用 URL：default-tab=5 直接进入长文发布页
  const publishUrl = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=5';
  const winTitle = '抖音发布文章 - ' + accountId;
  let win: BrowserWindow | null = null;
  let tracker: any = null;
  try {
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, winTitle);
    tracker = attachNavigationTracker(win, log);
    onProgress(5, '加载文章发布页…');
    log('info', 'load', '文章 URL: ' + publishUrl);
    await win.loadURL(publishUrl);
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(2000);
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      win.show();
      onProgress(15, '请在窗口中登录抖音账号…');
      const deadline = Date.now() + 120000;
      let logged = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (win && !win.isDestroyed()) {
          const rec = await detectLoggedIn(win).catch(function () { return { loggedIn: false }; });
          if (rec && rec.loggedIn) { logged = true; break; }
        }
      }
      if (!logged) return makeFailedResult(accountId, 'douyin', '登录超时', startedAt);
      log('info', 'login', '登录成功');
      // 重新加载文章发布页
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(2000);
    } else {
      log('info', 'login', '已登录，URL: ' + win.webContents.getURL().slice(0, 100));
    }

    // 检测文章发布引导页，如果有"我要发文"按钮则点击进入编辑器
    onProgress(18, '检测文章发布引导页…');
    const landingScript = buildDetectArticleLandingScript();
    const landingResult: any = await evalJS(win, landingScript, 'article-landing', log).catch(function () { return null; });
    if (landingResult && landingResult.hasLanding) {
      if (landingResult.clicked) {
        log('info', 'article-landing', '检测到引导页，已点击"我要发文"按钮，等待编辑器加载…');
        onProgress(22, '已点击"我要发文"，等待编辑器加载…');
        await tracker.waitForStable(1500, 15000);
        await sleep(2000);
        log('info', 'article-landing', '编辑器页面加载完成，URL: ' + win.webContents.getURL().slice(0, 100));
      } else {
        log('warn', 'article-landing', '检测到引导页但点击失败: ' + (landingResult.reason || '未知'));
        // 即使点击失败也继续尝试，也许页面结构不同
      }
    } else {
      log('info', 'article-landing', '未检测到引导页，直接进入编辑器');
    }

    // 先填写标题和正文，再上传封面（避免填写时页面滚动导致封面区域位置变化）
    const titleText = truncate((request.title || '').trim(), ARTICLE_TITLE_MAX);
    const rawContent = truncate((request.content || '').trim(), ARTICLE_CONTENT_MAX);
    const articleTagList = prepareTags(request.tags, ARTICLE_TAG_MAX);
    log('info', 'fill', '文章标题: ' + (titleText || '').slice(0, 40) + ' (限' + ARTICLE_TITLE_MAX + '字)');
    log('info', 'fill', '文章正文: ' + rawContent.length + '字 (限' + ARTICLE_CONTENT_MAX + '字), 标签: ' + articleTagList.length + '个');

    onProgress(25, '填写标题…');
    if (titleText) {
      const script1 = buildFillTitleScript(titleText);
      const res1: any = await evalJS(win, script1, 'article-fill-title', log).catch(function () { return null; });
      if (!res1 || !res1.ok) log('warn', 'fill', '文章标题填写失败');
      else log('info', 'fill', '文章标题已写入');
      await sleep(800);
    }

    onProgress(35, '填写正文…');
    let contentResult: any = null;
    if (rawContent || articleTagList.length > 0) {
      if (rawContent) {
        // 有正文：先探测编辑器类型，再选择合适的填写方式
        const probeScript = `(function(){
          try {
            var ce = document.querySelectorAll('[contenteditable]');
            var plainCE = null;
            var pmCE = null;
            for (var i = 0; i < ce.length; i++) {
              var val = ce[i].getAttribute && ce[i].getAttribute('contenteditable');
              if (val === 'false' || val === null) continue;
              var cls = String(ce[i].className || '');
              if (/tiptap|ProseMirror|prosemirror/i.test(cls)) {
                if (!pmCE) pmCE = ce[i];
              } else {
                // 普通 contenteditable，找内容区域（非标题）
                var txt = (ce[i].innerText || ce[i].textContent || '').trim();
                if (!plainCE || txt.length > (plainCE._len || 0)) {
                  plainCE = ce[i];
                  plainCE._len = txt.length;
                }
              }
            }
            if (pmCE) return { type: 'prosemirror' };
            if (plainCE) return { type: 'plain-ce' };
            return { type: 'unknown' };
          } catch(e) { return { type: 'error', err: String(e) }; }
        })()`;
        const probeRes: any = await evalJS(win, probeScript, 'article-probe-editor', log).catch(() => null);
        const editorType = probeRes && probeRes.type ? probeRes.type : 'plain-ce';
        log('info', 'fill', '文章编辑器类型: ' + editorType);

        if (editorType === 'plain-ce' || editorType === 'prosemirror' || editorType === 'auto' || editorType === 'unknown') {
          // 所有类型都优先用 CDP 方式填写（更健壮，有完整的错误处理）
          // CDP 方式内部会根据 targetKind 选择正确的编辑器
          const cdpTargetKind = editorType === 'prosemirror' ? 'prosemirror' : (editorType === 'plain-ce' ? 'plain-ce' : 'auto');
          contentResult = await cdpFillContentWithNewlines(win, rawContent, cdpTargetKind, log);
          if (!contentResult || !contentResult.ok) {
            // CDP 方式失败，降级用 JS 方式
            log('warn', 'fill', '文章CDP正文填写失败，降级用JS方式');
            const script2 = buildFillContentScript(rawContent);
            contentResult = await evalJS(win, script2, 'article-fill-content', log).catch(() => null);
          }
        }
      } else {
        // 没有正文，只有话题：用轻量脚本只查找并聚焦编辑器，不做删除/插入操作
        // 避免复杂的 fill 脚本在空内容时意外报错，导致标签也无法输入
        const focusScript = `(function () {
          function moveCursorToEnd(el) {
            try {
              el.focus();
              var range = document.createRange();
              range.selectNodeContents(el);
              range.collapse(false);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch(e) {}
          }
          // 1) 先找 ProseMirror / tiptap 富文本
          var pmEls = document.querySelectorAll('[contenteditable]');
          for (var i = 0; i < pmEls.length; i++) {
            var el = pmEls[i];
            var ceVal = el.getAttribute && el.getAttribute('contenteditable');
            if (ceVal === 'false') continue;
            var cls = String(el.className || '');
            if (/tiptap|ProseMirror|prosemirror/i.test(cls)) {
              moveCursorToEnd(el);
              return { ok: true, method: 'prosemirror', isContentEditable: true };
            }
          }
          // 2) 再找普通 contenteditable
          for (var i = 0; i < pmEls.length; i++) {
            var el = pmEls[i];
            var ceVal = el.getAttribute && el.getAttribute('contenteditable');
            if (ceVal === 'false') continue;
            var cls = String(el.className || '');
            if (/tiptap|ProseMirror|prosemirror/i.test(cls)) continue;
            moveCursorToEnd(el);
            return { ok: true, method: 'plain-ce', isContentEditable: true };
          }
          // 3) 兜底 textarea
          var ta = document.querySelector('textarea');
          if (ta) {
            ta.focus();
            return { ok: true, method: 'textarea', isContentEditable: false };
          }
          return { ok: false, reason: 'no-editor-found' };
        })()`;
        contentResult = await evalJS(win, focusScript, 'article-focus-editor', log).catch(() => null);
      }

      if (!contentResult || !contentResult.ok) {
        log('warn', 'fill', '文章正文填写失败');
      } else {
        log('info', 'fill', '文章正文已写入 (' + (contentResult && contentResult.method) + ')');
      }
      await sleep(500);
      // 通过 CDP 输入话题标签
      if (articleTagList.length > 0 && contentResult && contentResult.ok && contentResult.isContentEditable) {
        await cdpInsertTagsWithSpace(win, articleTagList, rawContent.length > 0, log);
        await sleep(300);
      }
    }

    // 文章发布：上传封面（第一张图片作为封面）+ 正文图片（如有多余图片）
    const mediaFiles = request.mediaFiles || [];
    if (mediaFiles.length > 0) {
      // 第一张图片作为封面
      const coverFile = mediaFiles[0];
      onProgress(45, '上传文章封面…');
      const coverOk = await uploadArticleCover(win, coverFile, log);
      if (!coverOk) {
        log('warn', 'upload', '封面上传失败，继续尝试发布（可能缺少封面）');
      } else {
        log('info', 'upload', '✅ 封面上传成功');
        onProgress(55, '封面上传完成…');
        await sleep(2000);
      }
      
      // 如果有多张图片，剩下的上传到正文
      const bodyImages = mediaFiles.slice(1);
      if (bodyImages.length > 0) {
        onProgress(60, '上传 ' + bodyImages.length + ' 张正文图片…');
        const bodyUploadOk = await uploadViaCDP(win, bodyImages, log, 'image');
        if (!bodyUploadOk) {
          log('warn', 'upload', '正文图片上传失败');
        } else {
          onProgress(65, '等待上传完成…');
          const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
          // 窗口已销毁：立即终止发布流程
          if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
            log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
            return makeFailedResult(accountId, 'douyin', '发布窗口已被关闭，发布已终止', startedAt);
          }
          if (!uploadResult.ready) log('warn', 'upload', '正文上传完成检测失败: ' + uploadResult.finalStatus);
        }
      } else {
          log('info', 'upload', '无正文图片，跳过正文上传');
        onProgress(65, '准备发布…');
      }
      await sleep(1500);
    } else {
      log('warn', 'upload', '⚠️ 无素材上传，文章发布需要封面，可能导致发布失败');
      onProgress(65, '准备发布…');
    }

    // 点击发布
    onProgress(80, '点击发布按钮…');

    // 测试模式：不点击发布，高亮标记按钮并收集表单状态
    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          'button.primary-cECiOJ',
          'button.button-dhlUZE',
          'button[type="submit"]',
          '.publish-btn',
          '.submit-btn',
        ],
        [
          { name: '文章标题', selector: 'input[placeholder*="标题"]', type: 'input' },
          { name: '文章正文', selector: '[contenteditable="true"]', type: 'contenteditable' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'article-test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '文章标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name === '文章正文')?.filled),
        tagsFilled: articleTagList.length > 0 && !!(contentResult && contentResult.ok),
        coverUploaded: (request.mediaFiles || []).length > 0,
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: testRes?.note || '测试模式完成',
      };
      log('info', 'test', '文章测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      // 确保测试模式窗口能正常关闭
      setupTestModeWindow(win, log);
      return {
        accountId: accountId,
        platform: 'douyin',
        status: 'success',
        progress: 100,
        message: '测试完成 - 文章表单填写验证通过',
        startedAt: startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

    const clickScript = buildClickPublishScript();
    const clickRes: any = await evalJS(win, clickScript, 'article-click-publish', log).catch(function () { return null; });
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', '发布按钮点击失败');
    } else {
      log('info', 'publish', '发布按钮已点击 (text=' + clickRes.text + ')');
    }

    // 等待发布结果
    onProgress(90, '等待发布结果…');
    const resultDeadline = Date.now() + 120000;
    let lastUrl = '', lastText = '', lastError = '';
    while (Date.now() < resultDeadline) {
      if (!win || win.isDestroyed()) break;
      try {
        const check: any = await evalJS(win, buildPublishResultProbeScript(), 'article-check-result', log).catch(function () { return null; });
        if (check) {
          lastUrl = check.url || '';
          lastText = check.text || '';
          if (check.errorText) lastError = check.errorText;
          if (check.success) {
            log('info', 'done', '文章发布成功');
            onProgress(100, '发布成功');
            return { accountId: accountId, platform: 'douyin', status: 'success', progress: 100, message: '文章发布成功', url: lastUrl, startedAt: startedAt, finishedAt: Date.now() } as PublishItemProgress;
          }
          if (check.fail) {
            var failMsg = '文章发布失败';
            if (check.errorText) failMsg = failMsg + ': ' + check.errorText;
            log('warn', 'done', '页面提示失败: ' + (check.errorText || '未知原因'));
            return makeFailedResult(accountId, 'douyin', failMsg, startedAt);
          }
        }
      } catch (e) {}
      await sleep(2500);
    }
    var timeoutMsg = '等待文章发布结果超时';
    if (lastError) timeoutMsg = timeoutMsg + ' (' + lastError + ')';
    return makeFailedResult(accountId, 'douyin', timeoutMsg, startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', '文章发布异常: ' + msg);
    return makeFailedResult(accountId, 'douyin', msg, startedAt);
  } finally {
    if (tracker) { try { tracker.dispose(); } catch (e) {} }
    // 测试模式：不关闭窗口，让用户可以检查表单填写情况
    if (request.testMode) {
      log('info', 'test', '文章测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
      setTimeout(function () { try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {} }, 3000);
    }
  }
}

// 辅助：构建文章的话题文本（不超过 ARTICLE_TAG_MAX 个）
function buildArticleTags(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  const cleaned = tags.map(function (t) { return (t || '').trim(); }).filter(function (t) { return t.length > 0; }).map(function (t) { return t.startsWith('#') ? t : '#' + t; });
  const deduped = Array.from(new Set(cleaned));
  const limited = deduped.slice(0, ARTICLE_TAG_MAX);
  return limited.join(' ');
}
async function publish(accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> {
  const files = request.mediaFiles || [];
  const hasImageOnly = files.length > 0 && files.every(function (f) { return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f); });
  if (request.contentType === 'image' || hasImageOnly) return publishImage(accountId, request, onProgress);
  return publishVideo(accountId, request, onProgress);
}

const meta: PlatformMeta = {
  key: 'douyin',
  name: '抖音',
  icon: '\uD83C\uDFB5',
  platformAccountLabel: '抖音号',
  authUrl: 'https://creator.douyin.com/creator-micro/home',
  publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  homeUrl: 'https://creator.douyin.com/creator-micro/home',
  contentTypes: ['video', 'image', 'article'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: true } as AccountCapabilities,
  contentLimits: { title: 80, content: 1000 },
  articleLimits: { title: 30, content: 8000, minContent: 100 },
  nicknameSelectors: ['[class*="header-"] [class*="name-"]', '[class*="name-"]', '[class*="name"]', '.name-box', '.user-name', '.nickname'],
  avatarSelectors: ['[class*="avatar-"] img', 'img[class*="img-"]', 'img[class*="avatar"]', 'img.user_avatar', '.user-info img'],
  loginKeywords: ['创作中心', '内容管理', '发布', '作品', '数据', '粉丝'],
};

const adapter: PlatformAdapter = {
  key: 'douyin',
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publishImage,
  publishArticle,
  publish,
};

registerPlatform(adapter);

export default adapter;
export { meta as douyinMeta };
