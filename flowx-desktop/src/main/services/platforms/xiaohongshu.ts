import type { BrowserWindow } from 'electron';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import type { NavigationTracker } from './shared';
import {
  sleep,
  makePublishLogger,
  makePublishWindow,
  attachNavigationTracker,
  evalJS,
  makeFailedResult,
  uploadViaCDP,
  waitForUploadComplete,
  buildPageStructureProbe,
  cdpClickPublishButton, // 🔑 CDP 穿透 closed shadow DOM 点击（小红书发布按钮是自定义 web component）
} from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities, ContentType } from '../../../types';

// =====================================================================
// 常量 / 配置
// =====================================================================

// 通用发布页 URL（视频/图文）
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';

// 文章（长文）发布专用 URL
const PUBLISH_ARTICLE_URL =
  'https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=article';

const LOGIN_KEYWORDS = [
  '创作中心',
  '数据中心',
  '作品管理',
  '发布笔记',
  '发布视频',
  '粉丝',
  '数据分析',
];

// 🔑 小红书图文发布平台限制：标题最多 20 字，正文 1000 字，话题最多 10 个
//    超过限制时自动截断并记录日志，避免发布失败
const TITLE_LIMIT = 20;
const CONTENT_LIMIT = 1000;
const MAX_TAGS = 10;

// 🔑 小红书文章（长文）发布平台限制：标题最多 64 字，正文不限，话题最多 10 个
const ARTICLE_TITLE_LIMIT = 64;
// ARTICLE_CONTENT_LIMIT = undefined 表示正文无字数限制

// =====================================================================
// 页面脚本构造器
// =====================================================================

/**
 * 生成"检测当前页面是否处于已登录状态"的 JS 脚本
 *
 * 判定规则：
 *  1) URL 不包含 login / signup
 *  2) 页面文本命中 LOGIN_KEYWORDS 中 3 个以上关键词 或 存在明显的账号元素
 *     （如 meta 中含 "creator.xiaohongshu.com" / account-name 类名等）
 */
function buildDetectLoggedInScript(loginKeywords: string[]): string {
  const kwJSON = JSON.stringify(loginKeywords);
  return (
    '(function(){' +
    'var url = (location.href || "").toLowerCase();' +
    'var title = document.title || "";' +
    'var bodyText = "";' +
    'try { bodyText = (document.body ? (document.body.innerText || document.body.textContent || "") : "") || ""; } catch(e) {}' +
    // 关键词命中
    'var kws = ' + kwJSON + ';' +
    'var matched = [];' +
    'for (var i = 0; i < kws.length; i++) { if (bodyText.indexOf(kws[i]) !== -1) matched.push(kws[i]); }' +
    // 账号元素命中（meta/导航栏）
    'var hasAccountSignal = false;' +
    'try { ' +
    '  var navText = ""; ' +
    // ⚠️ 用单引号包裹 CSS 选择器字符串（外层 TS 单引号字符串用 \' 转义）
    '  var navs = document.querySelectorAll(\'header, nav, [class*="header"], [class*="nav"]\'); ' +
    '  for (var ni = 0; ni < navs.length; ni++) { navText += (navs[ni].innerText || "") + " "; } ' +
    '  var topText = (document.body ? document.body.innerText.slice(0, 2000) : "") + " " + navText; ' +
    '  for (var j = 0; j < kws.length; j++) { if (topText.indexOf(kws[j]) !== -1 && matched.indexOf(kws[j]) === -1) matched.push(kws[j]); } ' +
    '  var hasMeta = document.querySelector(\'meta[name*="creator"]\') || document.querySelector(\'meta[property*="creator"]\'); ' +
    '  var hasNick = document.querySelector(\'[class*="account"], [class*="nickname"], [class*="user-name"], [class*="avatar"]\'); ' +
    '  hasAccountSignal = !!(hasMeta || hasNick); ' +
    '} catch (e) {}' +
    // 登录态 = 不是 login/signup URL + (关键词>=3 或 有明确账号信号)
    'var isLoginUrl = url.indexOf("login") !== -1 || url.indexOf("signup") !== -1;' +
    'var loggedIn = !isLoginUrl && (matched.length >= 3 || hasAccountSignal);' +
    'return { ' +
    '  loggedIn: loggedIn, ' +
    '  url: location.href, ' +
    '  title: title, ' +
    '  matchedKeywords: matched ' +
    '};' +
    '})()'
  );
}

/**
 * 生成"提取昵称 / 头像 / 平台账号ID / 粉丝数 / 关注数 / 获赞数"的 JS 脚本
 * 🔑 小红书 HTML 结构：数字在前，标签在后（分离在不同子元素）
 *     <div class="static description-text">
 *       <div><span class="numerical">19</span><span>关注数</span></div>
 *       <div><span class="numerical">14</span><span>粉丝数</span></div>
 *       <div><span class="numerical">109</span><span>获赞与收藏</span></div>
 *     </div>
 * 策略：1) 全局搜索 .numerical 元素 + 兄弟节点标签  2) 容器文本正则（双向格式）  3) body 全文正则兜底
 */
function buildExtractPageInfoScript(): string {
  return (
    '(function(){' +
    'var result = { nickname: "", avatar: "", platformAccountId: "", fansCount: null, followCount: null, likeCount: null };' +
    // ===== 辅助：数字解析 =====
    'function _parseNumber(s) {' +
    '  if (!s) return null;' +
    '  var t = String(s).replace(/\\s+/g, "").replace(/,/g, "");' +
    '  var base = parseFloat(t);' +
    '  if (isNaN(base)) return null;' +
    '  if (t.indexOf("万") !== -1) base *= 10000;' +
    '  else if (t.indexOf("千") !== -1) base *= 1000;' +
    '  else if (t.indexOf("百") !== -1) base *= 100;' +
    '  return Math.round(base);' +
    '}' +
    // ===== 辅助：根据标签设置对应字段（只在字段为 null 时设置） =====
    'function _setByLabel(labelText, numValue) {' +
    '  if (numValue === null || !labelText) return false;' +
    '  if (/粉丝/.test(labelText) && result.fansCount === null) { result.fansCount = numValue; return true; }' +
    '  if (/关注/.test(labelText) && result.followCount === null) { result.followCount = numValue; return true; }' +
    '  if ((/获赞|点赞|收藏/.test(labelText)) && result.likeCount === null) { result.likeCount = numValue; return true; }' +
    '  return false;' +
    '}' +
    // ===== 方式 A：全局搜索所有 class 含 "numerical" 的元素 =====
    //    对每个数字元素，从其兄弟节点/父节点文本中提取标签
    'try {' +
    '  var allNumEls = document.querySelectorAll(\'[class*="numerical"]\');' +
    '  for (var ai = 0; ai < allNumEls.length; ai++) {' +
    '    var aEl = allNumEls[ai];' +
    '    var aVal = _parseNumber(aEl.textContent || "");' +
    '    if (aVal === null) continue;' +
    '    var labelFound = false;' +
    '    var aParent = aEl.parentNode;' +
    '    if (aParent && aParent.children) {' +
    // 优先检查兄弟节点
    '      for (var bi = 0; bi < aParent.children.length; bi++) {' +
    '        var sib = aParent.children[bi];' +
    '        if (sib === aEl) continue;' +
    '        var lblTxt = (sib.textContent || "").trim();' +
    '        if (lblTxt && lblTxt.length <= 10 && /(粉丝|关注|获赞|点赞|收藏)/.test(lblTxt)) {' +
    '          if (_setByLabel(lblTxt, aVal)) { labelFound = true; break; }' +
    '        }' +
    '      }' +
    '    }' +
    '    if (labelFound) continue;' +
    // 兜底：从父节点的完整文本中提取
    '    if (aParent) {' +
    '      var parentTxt = (aParent.textContent || "").replace(/\\d/g, " ").trim();' +
    '      if (parentTxt) _setByLabel(parentTxt, aVal);' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    // ===== 方式 B：搜索统计容器 + 文本正则匹配 =====
    'try {' +
    '  var statSel = [' +
    '    \'[class*="description-text"]\',' +
    '    \'[class*="static"]\',' +
    '    \'[class*="statics"]\',' +
    '    \'[class*="header-info"]\',' +
    '    \'[class*="user-info"]\',' +
    '    \'[class*="creator-home"]\'' +
    '  ];' +
    '  for (var si2 = 0; si2 < statSel.length; si2++) {' +
    '    try {' +
    '      var cEl = document.querySelector(statSel[si2]);' +
    '      if (!cEl) continue;' +
    '      var cText = (cEl.innerText || cEl.textContent || "").trim();' +
    '      if (!cText) continue;' +
    // 在容器文本中搜索所有 "数字+标签" 和 "标签+数字" 组合
    '      var tokens = cText.split(/[\\n\\r\\t,，;；]+/);' +
    '      for (var ti = 0; ti < tokens.length; ti++) {' +
    '        var tok = tokens[ti].trim();' +
    '        if (!tok || tok.length > 30) continue;' +
    // 格式 1: "关注数19" / "粉丝数 14" (标签+数字)
    '        var mLabelFirst = tok.match(/(关注数|粉丝数|获赞与收藏|关注|粉丝|获赞|点赞|收藏)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);' +
    '        if (mLabelFirst) {' +
    '          var vLf = _parseNumber(mLabelFirst[2]);' +
    '          _setByLabel(mLabelFirst[1], vLf);' +
    '        }' +
    // 格式 2: "19关注数" / "14粉丝数" (数字+标签)
    '        var mNumFirst = tok.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(关注数|粉丝数|获赞与收藏|关注|粉丝|获赞|点赞|收藏)/);' +
    '        if (mNumFirst) {' +
    '          var vNf = _parseNumber(mNumFirst[1]);' +
    '          _setByLabel(mNumFirst[2], vNf);' +
    '        }' +
    '      }' +
    '    } catch(e2) {}' +
    '    if (result.fansCount !== null && result.followCount !== null && result.likeCount !== null) break;' +
    '  }' +
    '} catch(e) {}' +
    // ===== 方式 C：body 全文正则兜底（双重格式） =====
    'try {' +
    '  var bodyText = (document.body ? (document.body.innerText || "") : "") || "";' +
    // 小红书号
    '  var reAccount = /小红书号[：:\\s]*([A-Za-z0-9_\\-]{3,30})/;' +
    '  var accountMatch = bodyText.match(reAccount);' +
    '  if (accountMatch && accountMatch[1]) result.platformAccountId = accountMatch[1];' +
    // 粉丝（两种格式）
    '  if (result.fansCount === null) {' +
    '    var fm1 = bodyText.match(/(粉丝数|粉丝)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);' +
    '    var fm2 = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(粉丝数|粉丝)/);' +
    '    if (fm1 && fm1[2]) result.fansCount = _parseNumber(fm1[2]);' +
    '    else if (fm2 && fm2[1]) result.fansCount = _parseNumber(fm2[1]);' +
    '  }' +
    // 关注（两种格式）
    '  if (result.followCount === null) {' +
    '    var fol1 = bodyText.match(/(关注数|关注)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);' +
    '    var fol2 = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(关注数|关注)/);' +
    '    if (fol1 && fol1[2]) result.followCount = _parseNumber(fol1[2]);' +
    '    else if (fol2 && fol2[1]) result.followCount = _parseNumber(fol2[1]);' +
    '  }' +
    // 获赞（两种格式）
    '  if (result.likeCount === null) {' +
    '    var lk1 = bodyText.match(/(获赞与收藏|获赞|点赞|收藏)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);' +
    '    var lk2 = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(获赞与收藏|获赞|点赞|收藏)/);' +
    '    if (lk1 && lk1[2]) result.likeCount = _parseNumber(lk1[2]);' +
    '    else if (lk2 && lk2[1]) result.likeCount = _parseNumber(lk2[1]);' +
    '  }' +
    '} catch(e) {}' +
    // ===== 昵称：按优先级尝试多个选择器 =====
    'var nickSelectors = [' +
    '  \'[class*="account-name"]\', \'[class*="user-name"]\', \'[class*="nickname"]\', ' +
    '  ".account-name", ".user-name", ".nickname", ".user-nick"' +
    '];' +
    'for (var i = 0; i < nickSelectors.length; i++) {' +
    '  try {' +
    '    var el = document.querySelector(nickSelectors[i]);' +
    '    if (el && (el.innerText || el.textContent || "").trim()) {' +
    '      result.nickname = (el.innerText || el.textContent || "").trim().slice(0, 40);' +
    '      break;' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    // ===== 头像：img 的 src =====
    'var avatarSelectors = [' +
    '  \'img[class*="avatar"]\', \'img[class*="img-"]\', \'[class*="avatar"] img\',' +
    '  "img.user_avatar"' +
    '];' +
    'for (var j = 0; j < avatarSelectors.length; j++) {' +
    '  try {' +
    '    var img = document.querySelector(avatarSelectors[j]);' +
    '    if (img && img.src && img.src.indexOf("http") === 0) {' +
    '      result.avatar = img.src;' +
    '      break;' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    'return result;' +
    '})()'
  );
}

/**
 * 生成"填写标题"的脚本
 *  - 标题通常是独立的 textarea 或 contenteditable（不是 ProseMirror 编辑器）
 *  - 排除 ProseMirror / tiptap 编辑器区域（那是正文）
 */
function buildFillTitleTextScript(text: string): string {
  const textJSON = JSON.stringify(text);
  return (
    '(function(){' +
    'var text = ' + textJSON + ';' +
    // 辅助：判断是否为 ProseMirror / tiptap 富文本编辑器
    'function isProbablyProseMirror(el) {' +
    '  if (!el) return false;' +
    '  var cls = el.getAttribute ? (el.getAttribute(\'class\') || \'\') : \'\';' +
    '  if (cls.indexOf(\'ProseMirror\') !== -1 || cls.indexOf(\'tiptap\') !== -1) return true;' +
    '  if (el.getAttribute && el.getAttribute(\'data-slate-editor\')) return true;' +
    '  var parent = el.parentElement;' +
    '  if (parent && parent.getAttribute) {' +
    '    var pcls = parent.getAttribute(\'class\') || \'\';' +
    '    if (pcls.indexOf(\'ProseMirror\') !== -1 || pcls.indexOf(\'tiptap\') !== -1) return true;' +
    '  }' +
    '  return false;' +
    '}' +
    // 🔑 1) 优先：<input type="text">（小红书/抖音的标题字段最常见形式）
    'var target = null;' +
    'try {' +
    // ⚠️ CSS 属性选择器：外层用 \' 转义单引号，避免与外层双引号嵌套
    '  var titleInputs = document.querySelectorAll(\'input[type="text"]\');' +
    '  for (var i = 0; i < titleInputs.length; i++) {' +
    '    var inp = titleInputs[i];' +
    '    if (inp.disabled || inp.readOnly) continue;' +
    '    if (isProbablyProseMirror(inp)) continue;' +
    '    var ph = (inp.getAttribute(\'placeholder\') || \'\').toLowerCase();' +
    '    var name = (inp.getAttribute(\'name\') || \'\').toLowerCase();' +
    '    var id = (inp.getAttribute(\'id\') || \'\').toLowerCase();' +
    '    var aria = (inp.getAttribute(\'aria-label\') || \'\').toLowerCase();' +
    // 精确匹配标题相关关键词
    '    if (ph.indexOf(\'标题\') !== -1 || ph.indexOf(\'title\') !== -1 ||' +
    '        name.indexOf(\'title\') !== -1 || id.indexOf(\'title\') !== -1 ||' +
    '        aria.indexOf(\'标题\') !== -1 || aria.indexOf(\'title\') !== -1 ||' +
    '        ph.indexOf(\'填写标题\') !== -1) {' +
    '      target = inp; break;' +
    '    }' +
    '    if (!target) target = inp;' + // fallback to first non-empty text input
    '  }' +
    '} catch(e) {}' +
    // 2) 其次：textarea
    'if (!target) {' +
    '  try {' +
    '    var textareas = document.querySelectorAll(\'textarea\');' +
    '    for (var t = 0; t < textareas.length; t++) {' +
    '      var ta = textareas[t];' +
    '      if (ta.disabled || ta.readOnly) continue;' +
    '      if (isProbablyProseMirror(ta)) continue;' +
    '      var tph = (ta.getAttribute(\'placeholder\') || \'\').toLowerCase();' +
    '      if (tph.indexOf(\'标题\') !== -1 || tph.indexOf(\'title\') !== -1) { target = ta; break; }' +
    '      if (!target) target = ta;' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    // 3) 最后兜底：contenteditable 元素（非 ProseMirror）
    'if (!target) {' +
    '  try {' +
    '    var editables = document.querySelectorAll(\'[contenteditable="true"], [contenteditable=""]\');' +
    '    for (var j = 0; j < editables.length; j++) {' +
    '      var ed = editables[j];' +
    '      if (isProbablyProseMirror(ed)) continue;' +
    '      var edph = (ed.getAttribute(\'data-placeholder\') || ed.getAttribute(\'placeholder\') || \'\').toLowerCase();' +
    '      if (edph.indexOf(\'标题\') !== -1 || edph.indexOf(\'title\') !== -1) { target = ed; break; }' +
    '      if (!target) target = ed;' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    // 写入逻辑
    'if (!target) return { ok: false, reason: \'no-title-target\' };' +
    'try {' +
    '  target.focus();' +
    '  var tag = (target.tagName || \'\').toLowerCase();' +
    // 🔑 input/textarea 用 execCommand 模拟原生输入，确保 React 受控组件 state 同步更新
    '  if (tag === \'textarea\' || tag === \'input\') {' +
    '    try {' +
    '      document.execCommand(\'selectAll\');' +
    '    } catch(e1) {}' +
    '    try {' +
    '      document.execCommand(\'delete\');' +
    '    } catch(e2) {}' +
    '    try {' +
    '      document.execCommand(\'insertText\', false, text);' +
    '    } catch(e3) {' +
    '      target.value = text;' + // fallback: direct value assignment
    '      try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(ev) {}' +
    '      try { target.dispatchEvent(new Event(\'change\', { bubbles: true })); } catch(ev2) {}' +
    '    }' +
    '    try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(ev) {}' +
    '    try { target.dispatchEvent(new Event(\'change\', { bubbles: true })); } catch(ev2) {}' +
    '  } else {' +
    // contenteditable
    '    try { document.execCommand(\'selectAll\'); } catch(e1) {}' +
    '    try { document.execCommand(\'delete\'); } catch(e2) {}' +
    '    try { document.execCommand(\'insertText\', false, text); } catch(e3) { target.innerText = text; }' +
    '    try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  }' +
    '  try { target.blur(); } catch(e) {}' +
    '  return { ok: true, tag: tag, length: text.length };' +
    '} catch(e) {' +
    '  return { ok: false, reason: String(e && e.message || e) };' +
    '}' +
    '})()'
  );
}

/**
 * 生成"填写正文"的脚本（小红书正文是 ProseMirror / tiptap 富文本编辑器）
 *
 * 填充策略：
 *  1) 查找所有 [contenteditable]，筛选 class 中含 ProseMirror / tiptap 的元素
 *  2) 找到后 focus → 全选 → 删除 → insertText（insertText 可正确处理多行/空格/表情）
 *  3) 若无 ProseMirror，退回到普通 contenteditable 的 innerText 写入
 *  4) 若再无，回退到 textarea
 */
function buildFillContentScript(content: string): string {
  const contentJSON = JSON.stringify(content);
  return (
    '(function(){' +
    'var content = ' + contentJSON + ';' +
    // 辅助：判断是否为 ProseMirror / tiptap
    'function isProseMirror(el) {' +
    '  if (!el || !el.getAttribute) return false;' +
    '  var cls = el.getAttribute(\'class\') || \'\';' +
    '  if (cls.indexOf(\'ProseMirror\') !== -1) return true;' +
    '  if (cls.indexOf(\'tiptap\') !== -1) return true;' +
    '  return false;' +
    '}' +
    // 收集候选（优先 ProseMirror，其次普通 contenteditable，最后 textarea）
    'var pmTarget = null;' +
    'var edTarget = null;' +
    'var taTarget = null;' +
    'try {' +
    '  var nodes = document.querySelectorAll(\'[contenteditable]\');' +
    '  for (var i = 0; i < nodes.length; i++) {' +
    '    var n = nodes[i];' +
    '    if (isProseMirror(n)) { if (!pmTarget) pmTarget = n; }' +
    '    else { if (!edTarget) edTarget = n; }' +
    '  }' +
    '} catch(e) {}' +
    'try {' +
    '  var tas = document.querySelectorAll(\'textarea\');' +
    '  for (var j = 0; j < tas.length; j++) {' +
    '    if (tas[j].getAttribute && (tas[j].getAttribute(\'name\') || \'\').indexOf(\'title\') === -1) {' +
    '      if (!taTarget) taTarget = tas[j];' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'var target = pmTarget || edTarget || taTarget;' +
    'if (!target) return { ok: false, reason: \'no-content-target\' };' +
    // 写入
    'try {' +
    '  target.focus();' +
    '  var tag = (target.tagName || \'\').toLowerCase();' +
    '  if (tag === \'textarea\' || tag === \'input\') {' +
    '    target.value = content;' +
    '    try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '    try { target.dispatchEvent(new Event(\'change\', { bubbles: true })); } catch(e) {}' +
    '  } else if (pmTarget) {' +
    // ProseMirror：selectAll → delete → insertText
    '    try {' +
    '      window.getSelection().removeAllRanges();' +
    '      var range = document.createRange();' +
    '      range.selectNodeContents(pmTarget);' +
    '      window.getSelection().addRange(range);' +
    '      try { document.execCommand(\'delete\'); } catch(e) {}' +
    '      try { document.execCommand(\'insertText\', false, content); } catch(e2) { pmTarget.innerText = content; }' +
    '    } catch(e) {' +
    '      pmTarget.innerText = content;' +
    '    }' +
    '    try { pmTarget.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  } else {' +
    // 普通 contenteditable：用 execCommand 触发真实输入事件，确保 React 受控组件 state 更新
    '    try { document.execCommand(\'selectAll\'); } catch(e1) {}' +
    '    try { document.execCommand(\'delete\'); } catch(e2) {}' +
    '    try { document.execCommand(\'insertText\', false, content); } catch(e3) { target.innerText = content; }' +
    '    try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  }' +
    '  try { target.blur(); } catch(e) {}' +
    '  return { ok: true, kind: pmTarget ? \'prosemirror\' : (edTarget ? \'contenteditable\' : \'textarea\'), length: content.length };' +
    '} catch(e) {' +
    '  return { ok: false, reason: String(e && e.message || e) };' +
    '}' +
    '})()'
  );
}

/**
 * 生成"点击发布按钮"的脚本
 *  - 匹配文本："发布"、"发布笔记"、"发布视频"、"立即发布" 等
 *  - 对找到的按钮执行 click() + dispatchEvent 兜底
 */
function buildClickPublishScript(): string {
  return (
    '(function(){' +
    'var patterns = [\'发布视频\', \'发布笔记\', \'立即发布\', \'发布\'];' +
    // 收集候选：button / a / [role=button] / div / span
    // ⚠️ 外层用 \' 转义单引号，避免 CSS 选择器的引号冲突
    'var candidates = [];' +
    'try {' +
    '  var nodes = document.querySelectorAll(\'button, a, [role="button"], div, span\');' +
    '  for (var i = 0; i < nodes.length; i++) {' +
    '    var n = nodes[i];' +
    '    var txt = ((n.innerText || n.textContent || \'\').replace(/\\s+/g, \'\').trim());' +
    '    if (!txt || txt.length > 20) continue;' +
    '    for (var k = 0; k < patterns.length; k++) {' +
    '      if (txt === patterns[k] || txt.indexOf(patterns[k]) !== -1) {' +
    '        candidates.push({ el: n, text: txt.slice(0, 30), len: txt.length, score: (100 - k * 10) });' +
    '        break;' +
    '      }' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'if (candidates.length === 0) return { clicked: false, reason: \'no-button\' };' +
    // 再按 class 名给"publish / button"等额外加分（简单启发式）
    'for (var m = 0; m < candidates.length; m++) {' +
    '  var cls = candidates[m].el.getAttribute ? (candidates[m].el.getAttribute(\'class\') || \'\') : \'\';' +
    '  if (cls.indexOf(\'publish\') !== -1 || cls.indexOf(\'submit\') !== -1) candidates[m].score += 50;' +
    '  if (cls.indexOf(\'primary\') !== -1 || cls.indexOf(\'btn-\') !== -1) candidates[m].score += 20;' +
    // 过滤不可见 / 禁用
    '  try {' +
    '    if (candidates[m].el.offsetWidth === 0 || candidates[m].el.offsetHeight === 0) candidates[m].score -= 1000;' +
    '    if (candidates[m].el.disabled) candidates[m].score -= 1000;' +
    '  } catch(e) {}' +
    '}' +
    'candidates.sort(function(a, b) { return b.score - a.score; });' +
    'var target = candidates[0];' +
    'try { target.el.click(); } catch(e) {}' +
    'try { target.el.dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true })); } catch(e) {}' +
    'return { clicked: true, text: target.text, topThree: candidates.slice(0, 3).map(function(c) { return { text: c.text, score: c.score }; }) };' +
    '})()'
  );
}

/**
 * 生成"检测发布是否成功"的脚本（用于发布后轮询）
 */
function buildPublishResultProbeScript(): string {
  return (
    '(function(){' +
    'var url = location.href || "";' +
    'var bodyText = "";' +
    'try { bodyText = (document.body ? (document.body.innerText || "") : "") || ""; } catch(e) {}' +
    'var successKeywords = ["发布成功", "已发布", "发布完成", "发布成功，正在审核", "发布成功!"];' +
    'var failKeywords = ["发布失败", "发布未成功", "服务器开小差", "网络异常", "内容包含敏感", "违反社区公约"];' +
    'var hitSuccess = [];' +
    'var hitFail = [];' +
    'for (var i = 0; i < successKeywords.length; i++) if (bodyText.indexOf(successKeywords[i]) !== -1) hitSuccess.push(successKeywords[i]);' +
    'for (var j = 0; j < failKeywords.length; j++) if (bodyText.indexOf(failKeywords[j]) !== -1) hitFail.push(failKeywords[j]);' +
    // URL 变化（从 publish 跳转到 home 或作品列表）
    'var leftPublish = url.indexOf("/publish/publish") === -1 && url.indexOf("publish") === -1;' +
    'return {' +
    '  url: url,' +
    '  success: hitSuccess.length > 0 || (leftPublish && hitFail.length === 0),' +
    '  failed: hitFail.length > 0,' +
    '  hitSuccess: hitSuccess,' +
    '  hitFail: hitFail,' +
    '  leftPublish: leftPublish' +
    '};' +
    '})()'
  );
}

// =====================================================================
// 文本处理工具
// =====================================================================

/** 截断文本到 max 字符 */
function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/**
 * 拼接正文 + 话题（小红书最多 10 个话题，拼到正文末尾）
 *  - 每个 tag 前面自动加 "#"（若没有）
 *  - 超出 MAX_TAGS 的部分丢弃
 */
function buildContentText(content: string, tags: string[] | undefined): string {
  const base = content || '';
  if (!tags || tags.length === 0) return base;
  const trimmedTags = tags
    .map((t) => (t || '').trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TAGS)
    .map((t) => (t.startsWith('#') ? t : '#' + t));
  if (trimmedTags.length === 0) return base;
  const tagStr = trimmedTags.join(' ');
  const combined = base.length > 0 ? base + '\n' + tagStr : tagStr;
  return combined;
}

// =====================================================================
// 主流程
// =====================================================================

async function runXhsPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
  contentType: ContentType,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'xiaohongshu' });

  log('info', 'start', `开始发布小红书 [${contentType}]`, { title: request.title });

  let win: BrowserWindow | null = null;
  let disposeTracker: (() => void) | null = null;

  try {
    // 1) 创建窗口 + 挂导航跟踪器
    win = makePublishWindow(accountId, `小红书发布 - ${request.title || '未命名'}`);
    const tracker = attachNavigationTracker(win, log);
    disposeTracker = () => tracker.dispose();

    // 2) 加载发布页
    onProgress(5, '加载发布页…');
    log('info', 'load', `打开 ${PUBLISH_URL}`);
    await win.loadURL(PUBLISH_URL).catch((err) => {
      log('warn', 'load', `loadURL 异常: ${err.message}`);
    });

    // 3) 等待页面稳定
    onProgress(10, '等待页面加载稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // 4) 检测登录态，未登录则显示窗口让用户手动登录
    //    防御：脚本执行失败时，降级为"未检测到登录态"，进入窗口等待流程，不中断发布
    onProgress(15, '检测登录状态…');
    let loginCheck: any = null;
    try {
      loginCheck = await evalJS(win, buildDetectLoggedInScript(LOGIN_KEYWORDS), '检测登录态', log);
    } catch (scriptErr) {
      log('warn', 'login', `登录态检测脚本执行失败，降级为显示窗口等待: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}`);
      loginCheck = { loggedIn: false };
    }
    if (!loginCheck || !loginCheck.loggedIn) {
      log('warn', 'login', '未检测到登录态，显示窗口，等待用户登录…');
      onProgress(20, '请在打开的窗口中完成登录（最长等待 120 秒）');
      win.show();
      win.focus();

      const loginDeadline = Date.now() + 120 * 1000;
      let loggedInNow = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        try {
          const checkRes: any = await win.webContents
            .executeJavaScript(buildDetectLoggedInScript(LOGIN_KEYWORDS))
            .catch(() => null);
          if (checkRes && checkRes.loggedIn) {
            loggedInNow = true;
            log('info', 'login', '检测到已登录，继续发布流程');
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!loggedInNow) {
        return makeFailedResult(accountId, 'xiaohongshu', '登录超时或未完成登录', startedAt);
      }

      // 登录后回到发布页（若跳转）
      if (!win.isDestroyed()) {
        const currentUrl = win.webContents.getURL();
        if (currentUrl.indexOf('/publish/publish') === -1) {
          log('info', 'login', `当前不在发布页 (${currentUrl})，重新跳转至发布页`);
          await win.loadURL(PUBLISH_URL).catch(() => {});
        }
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', '已登录，继续发布流程');
    }

    onProgress(25, '已登录，准备上传内容…');

    // 5) 图文模式：尝试切换到"图文"tab
    if (contentType === 'image') {
      log('info', 'tab', '切换到图文 tab…');
      const tabSwitchScript =
        '(function(){' +
        'var targets = ["图文", "图片", "上传图文"];' +
        'var found = null;' +
        'try {' +
        // ⚠️ 外层用 \' 转义单引号，CSS 选择器内部用双引号
        '  var nodes = document.querySelectorAll(\'button, a, [role="tab"], [role="button"], div, span\');' +
        '  for (var i = 0; i < nodes.length; i++) {' +
        '    var txt = ((nodes[i].innerText || nodes[i].textContent || "").replace(/\\s+/g, "").trim());' +
        '    for (var k = 0; k < targets.length; k++) {' +
        '      if (txt === targets[k] || txt.indexOf(targets[k]) !== -1) { found = nodes[i]; break; }' +
        '    }' +
        '    if (found) break;' +
        '  }' +
        '} catch(e) {}' +
        'if (!found) return { switched: false };' +
        'try { found.click(); } catch(e) {}' +
        'try { found.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch(e) {}' +
        'return { switched: true, text: (found.innerText || "").slice(0, 40) };' +
        '})()';
      const tabRes: any = await evalJS(win, tabSwitchScript, '切换图文 tab', log).catch(() => null);
      log('info', 'tab', `tab 切换结果: ${JSON.stringify(tabRes)}`);
      await sleep(1500);
    }

    // 6) 通过 CDP 注入文件 → 上传
    onProgress(35, '上传文件…');
    const files = request.mediaFiles || [];
    if (files.length === 0) {
      return makeFailedResult(accountId, 'xiaohongshu', '没有要上传的文件', startedAt);
    }
    log('info', 'upload', `待上传文件: ${files.join(', ')}`);
    const uploadOk = await uploadViaCDP(win, files, log, contentType);
    if (!uploadOk) {
      return makeFailedResult(accountId, 'xiaohongshu', '文件上传失败', startedAt);
    }

    // 7) 等待上传完成（5 分钟内）
    onProgress(50, '等待上传完成…');
    const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
    if (!uploadResult || !uploadResult.ready) {
      return makeFailedResult(
        accountId,
        'xiaohongshu',
        `上传超时或失败 (status=${uploadResult?.finalStatus || 'unknown'})`,
        startedAt,
      );
    }
    log('info', 'upload', `上传完成: ${JSON.stringify(uploadResult)}`);
    await sleep(1000);

    // 8) 填充标题（先标题再正文）
    onProgress(65, '填写标题…');
    const originalTitle = request.title || '';
    const titleText = truncate(originalTitle, TITLE_LIMIT);
    if (originalTitle.length > TITLE_LIMIT) {
      log('warn', 'fill-title', `标题过长，已从 ${originalTitle.length} 字截断为 ${TITLE_LIMIT} 字: "${titleText}"`);
    } else {
      log('info', 'fill-title', `标题长度: ${titleText.length}/${TITLE_LIMIT} 字`);
    }
    const titleResult: any = await evalJS(win, buildFillTitleTextScript(titleText), '填写标题', log);
    log('info', 'fill-title', `标题填写结果: ${JSON.stringify(titleResult)}`);
    await sleep(500);

    // 9) 填充正文（含话题）
    onProgress(70, '填写正文…');
    const fullContent = buildContentText(request.content || '', request.tags);
    const contentText = truncate(fullContent, CONTENT_LIMIT);
    if (fullContent.length > CONTENT_LIMIT) {
      log('warn', 'fill-content', `正文过长，已从 ${fullContent.length} 字截断为 ${CONTENT_LIMIT} 字`);
    } else {
      log('info', 'fill-content', `正文长度: ${contentText.length}/${CONTENT_LIMIT} 字`);
    }
    const contentResult: any = await evalJS(win, buildFillContentScript(contentText), '填写正文', log);
    log('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentResult)}`);
    await sleep(800);

    // 10) 点击"发布"按钮 —— 🔑 使用 CDP 穿透 closed shadow DOM（小红书发布按钮是自定义 web component）
    //    先尝试 JS 点击（处理 light DOM 中的按钮），失败后用 CDP 鼠标合成事件（可穿透 shadow DOM）
    onProgress(85, '点击发布按钮…');
    let clicked = false;
    const clickResult: any = await evalJS(win, buildClickPublishScript(), '点击发布', log);
    log('info', 'click-publish', `JS 点击结果: ${JSON.stringify(clickResult)}`);
    clicked = !!(clickResult && clickResult.clicked);

    // 🔑 无论 JS 点击是否成功，都尝试 CDP 穿透点击（closed shadow DOM 的按钮只能通过 CDP 点击）
    //    CDP 会合成真实鼠标事件（mouseMoved → mousePressed → mouseReleased），坐标从 DOM.getBoxModel 计算
    try {
      const cdpOk = await cdpClickPublishButton(win, log, [
        '发布笔记', '发布视频', '立即发布', '发布作品', '确认发布', '发布', 'publish', 'confirm',
      ]);
      if (cdpOk) {
        log('info', 'click-publish', '✅ CDP 穿透式点击成功');
        clicked = true;
      } else {
        log('warn', 'click-publish', 'CDP 点击返回 false，尝试继续轮询发布结果');
      }
    } catch (cdpErr) {
      log('warn', 'click-publish', `CDP 点击异常: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`);
    }

    if (!clicked) {
      log('warn', 'click-publish', `所有点击方式均未命中发布按钮`);
      return makeFailedResult(accountId, 'xiaohongshu', '未找到发布按钮或点击失败', startedAt);
    }
    await sleep(1200);

    // 11) 等待发布成功 / 失败（轮询最多 60 秒）
    onProgress(92, '等待发布结果…');
    const probeDeadline = Date.now() + 60 * 1000;
    let finalState: any = null;
    const probeScript = buildPublishResultProbeScript();
    while (Date.now() < probeDeadline) {
      await sleep(2500);
      if (!win || win.isDestroyed()) break;
      try {
        const probeRes: any = await win.webContents.executeJavaScript(probeScript).catch(() => null);
        if (probeRes && probeRes.success) {
          finalState = probeRes;
          break;
        }
        if (probeRes && probeRes.failed) {
          finalState = probeRes;
          break;
        }
      } catch {
        // ignore transient errors
      }
    }

    // 组装最终结果
    onProgress(100, '发布完成');
    log('info', 'done', `最终状态: ${JSON.stringify(finalState)}`);

    const success = !!(finalState && finalState.success);
    const progress: PublishItemProgress = {
      accountId,
      platform: 'xiaohongshu',
      status: success ? 'success' : 'failed',
      progress: 100,
      message: success
        ? '小红书发布成功'
        : finalState && finalState.hitFail && finalState.hitFail.length > 0
          ? `发布失败: ${finalState.hitFail.join(', ')}`
          : '发布结果未明确，请在小红书后台确认',
      resultUrl: finalState && finalState.url ? finalState.url : PUBLISH_URL,
      startedAt,
      finishedAt: Date.now(),
    };
    return progress;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', `发布流程异常: ${message}`);
    return makeFailedResult(accountId, 'xiaohongshu', message, startedAt);
  } finally {
    try {
      disposeTracker?.();
    } catch {
      // ignore
    }
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // ignore
      }
    }
  }
}

// =====================================================================
// 对外接口：按内容类型分发
// =====================================================================

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runXhsPublish(accountId, request, onProgress, 'video');
}

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runXhsPublish(accountId, request, onProgress, 'image');
}

// =====================================================================
// 文章（长文）发布：独立流程，不影响视频/图文
//  - URL: PUBLISH_ARTICLE_URL
//  - 标题最多 64 字（图文是 20 字）
//  - 正文不限制字数（图文是 1000 字）
//  - 使用与图文相同的 ProseMirror / tiptap 富文本写入
//  - 使用 CDP 穿透 closed shadow DOM 点击发布按钮
// =====================================================================

async function publishArticle(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'xiaohongshu' });

  log('info', 'start', `开始发布小红书 [article]`, { title: request.title });

  let win: BrowserWindow | null = null;
  let disposeTracker: (() => void) | null = null;

  try {
    // 1) 创建窗口 + 挂导航跟踪器
    onProgress(3, '初始化窗口…');
    win = makePublishWindow(accountId, `小红书发布文章 - ${request.title || '未命名'}`);
    const tracker = attachNavigationTracker(win, log);
    disposeTracker = () => tracker.dispose();

    // 2) 加载文章发布页
    onProgress(8, '加载文章发布页…');
    log('info', 'load', `打开 ${PUBLISH_ARTICLE_URL}`);
    await win.loadURL(PUBLISH_ARTICLE_URL).catch((err) => {
      log('warn', 'load', `loadURL 异常: ${err.message}`);
    });

    // 3) 等待页面稳定
    onProgress(15, '等待页面加载稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // 4) 登录态检测
    onProgress(22, '检测登录状态…');
    let loginCheck: any = null;
    try {
      loginCheck = await evalJS(win, buildDetectLoggedInScript(LOGIN_KEYWORDS), '文章-登录态', log);
    } catch (scriptErr) {
      log('warn', 'login', `登录态检测失败: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}`);
      loginCheck = { loggedIn: false };
    }
    if (!loginCheck || !loginCheck.loggedIn) {
      log('warn', 'login', '未检测到登录态，显示窗口，等待用户登录…');
      onProgress(25, '请在打开的窗口中完成登录（最长等待 120 秒）');
      win.show();
      win.focus();

      const loginDeadline = Date.now() + 120 * 1000;
      let loggedInNow = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        try {
          const checkRes: any = await win.webContents
            .executeJavaScript(buildDetectLoggedInScript(LOGIN_KEYWORDS))
            .catch(() => null);
          if (checkRes && checkRes.loggedIn) {
            loggedInNow = true;
            log('info', 'login', '检测到已登录，继续发布流程');
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!loggedInNow) {
        return makeFailedResult(accountId, 'xiaohongshu', '登录超时或未完成登录', startedAt);
      }
      // 回到文章发布页
      if (!win.isDestroyed()) {
        const currentUrl = win.webContents.getURL();
        if (currentUrl.indexOf('target=article') === -1) {
          log('info', 'login', `当前不在文章发布页，重新跳转`);
          await win.loadURL(PUBLISH_ARTICLE_URL).catch(() => {});
        }
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', '已登录，继续发布流程');
    }

    onProgress(30, '已登录，准备上传/填写内容…');

    // 5) 上传用户提供的素材（如有）
    const files = request.mediaFiles || [];
    if (files.length > 0) {
      onProgress(38, '上传文件…');
      log('info', 'upload', `待上传文件: ${files.join(', ')}`);
      const uploadOk = await uploadViaCDP(win, files, log, 'image');
      if (uploadOk) {
        onProgress(50, '等待上传完成…');
        const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
        if (!uploadResult || !uploadResult.ready) {
          log('warn', 'upload', `上传完成检测失败 (status=${uploadResult?.finalStatus || 'unknown'})`);
        }
        await sleep(1000);
      } else {
        log('warn', 'upload', '文件上传失败，继续填写其他字段（可能缺少封面）');
      }
    }

    // 6) 标题（最多 64 字，文章专用限制）
    onProgress(62, '填写标题…');
    const originalTitle = request.title || '';
    const articleTitleText = truncate(originalTitle, ARTICLE_TITLE_LIMIT);
    if (originalTitle.length > ARTICLE_TITLE_LIMIT) {
      log('warn', 'fill-title', `文章标题过长，已从 ${originalTitle.length} 字截断为 ${ARTICLE_TITLE_LIMIT} 字: "${articleTitleText}"`);
    } else {
      log('info', 'fill-title', `文章标题: ${articleTitleText.length}/${ARTICLE_TITLE_LIMIT} 字`);
    }
    const titleRes: any = await evalJS(win, buildFillTitleTextScript(articleTitleText), '文章-填写标题', log).catch(() => null);
    log('info', 'fill-title', `标题填写结果: ${JSON.stringify(titleRes)}`);
    await sleep(500);

    // 7) 正文（富文本，不限制字数）
    onProgress(72, '填写正文…');
    const rawContent = request.content || '';
    // 话题处理：与图文相同，最多 10 个
    const trimmedTags = (request.tags || [])
      .map((t) => (t || '').trim())
      .filter((t) => t.length > 0)
      .slice(0, MAX_TAGS)
      .map((t) => (t.startsWith('#') ? t : '#' + t));
    let articleContent = rawContent;
    if (trimmedTags.length > 0) {
      const tagStr = trimmedTags.join(' ');
      articleContent = articleContent.length > 0 ? articleContent + '\n' + tagStr : tagStr;
    }
    log('info', 'fill-content', `文章正文: ${articleContent.length} 字`);
    const contentRes: any = await evalJS(win, buildFillContentScript(articleContent), '文章-填写正文', log).catch(() => null);
    log('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentRes)}`);
    await sleep(800);

    // 8) 点击发布按钮（JS click + CDP 穿透 shadow DOM）
    onProgress(88, '点击发布按钮…');
    let clicked = false;
    const clickResult: any = await evalJS(win, buildClickPublishScript(), '文章-点击发布', log).catch(() => null);
    log('info', 'click-publish', `JS 点击结果: ${JSON.stringify(clickResult)}`);
    clicked = !!(clickResult && clickResult.clicked);

    try {
      const cdpOk = await cdpClickPublishButton(win, log, [
        '发布笔记', '发布文章', '立即发布', '发布作品', '确认发布', '发布', 'publish', 'confirm',
      ]);
      if (cdpOk) {
        log('info', 'click-publish', '✅ CDP 穿透式点击成功');
        clicked = true;
      } else {
        log('warn', 'click-publish', 'CDP 点击返回 false，继续轮询发布结果');
      }
    } catch (cdpErr) {
      log('warn', 'click-publish', `CDP 点击异常: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`);
    }

    if (!clicked) {
      log('warn', 'click-publish', `所有点击方式均未命中发布按钮`);
      return makeFailedResult(accountId, 'xiaohongshu', '未找到发布按钮或点击失败', startedAt);
    }
    await sleep(1200);

    // 9) 等待发布结果（60 秒超时）
    onProgress(94, '等待发布结果…');
    const probeDeadline = Date.now() + 60 * 1000;
    let finalState: any = null;
    const probeScript = buildPublishResultProbeScript();
    while (Date.now() < probeDeadline) {
      await sleep(2500);
      if (!win || win.isDestroyed()) break;
      try {
        const probeRes: any = await win.webContents.executeJavaScript(probeScript).catch(() => null);
        if (probeRes && probeRes.success) {
          finalState = probeRes;
          break;
        }
        if (probeRes && probeRes.failed) {
          finalState = probeRes;
          break;
        }
      } catch {
        // ignore transient errors
      }
    }

    onProgress(100, '发布完成');
    log('info', 'done', `文章发布最终状态: ${JSON.stringify(finalState)}`);

    const success = !!(finalState && finalState.success);
    const progress: PublishItemProgress = {
      accountId,
      platform: 'xiaohongshu',
      status: success ? 'success' : 'failed',
      progress: 100,
      message: success
        ? '小红书文章发布成功'
        : finalState && finalState.hitFail && finalState.hitFail.length > 0
          ? `发布失败: ${finalState.hitFail.join(', ')}`
          : '发布结果未明确，请在小红书后台确认',
      resultUrl: finalState && finalState.url ? finalState.url : PUBLISH_ARTICLE_URL,
      startedAt,
      finishedAt: Date.now(),
    };
    return progress;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'fatal', `文章发布流程异常: ${message}`);
    return makeFailedResult(accountId, 'xiaohongshu', message, startedAt);
  } finally {
    try {
      disposeTracker?.();
    } catch {
      // ignore
    }
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // ignore
      }
    }
  }
}

async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const ct: ContentType = request.contentType || 'video';
  return runXhsPublish(accountId, request, onProgress, ct);
}

// =====================================================================
// 检测登录态 / 提取账号信息（用于授权流程）
// =====================================================================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const res: any = await win.webContents.executeJavaScript(buildDetectLoggedInScript(LOGIN_KEYWORDS));
    return {
      loggedIn: !!(res && res.loggedIn),
      url: (res && res.url) || win.webContents.getURL() || '',
      title: (res && res.title) || '',
      matchedKeywords: (res && res.matchedKeywords) || [],
    };
  } catch (err) {
    return {
      loggedIn: false,
      url: win.webContents.getURL() || '',
      title: '',
      matchedKeywords: [],
    };
  }
}

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    const res: any = await win.webContents.executeJavaScript(buildExtractPageInfoScript());
    return {
      nickname: (res && res.nickname) || '',
      avatar: (res && res.avatar) || undefined,
      platformAccountId: (res && res.platformAccountId) || undefined,
      fansCount: (res && typeof res.fansCount === 'number' && !Number.isNaN(res.fansCount))
        ? res.fansCount
        : undefined,
      followCount: (res && typeof res.followCount === 'number' && !Number.isNaN(res.followCount))
        ? res.followCount
        : undefined,
      likeCount: (res && typeof res.likeCount === 'number' && !Number.isNaN(res.likeCount))
        ? res.likeCount
        : undefined,
    };
  } catch {
    return { nickname: '' };
  }
}

// =====================================================================
// meta / capabilities
// =====================================================================

const meta: PlatformMeta = {
  key: 'xiaohongshu',
  name: '小红书',
  icon: '📕',
  platformAccountLabel: '小红书号',
  authUrl: 'https://creator.xiaohongshu.com/creator/home',
  publishUrl: PUBLISH_URL,
  homeUrl: 'https://creator.xiaohongshu.com/creator/home',
  contentTypes: ['video', 'image', 'article'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: true } as AccountCapabilities,
  contentLimits: { title: TITLE_LIMIT, content: CONTENT_LIMIT },
  nicknameSelectors: [
    '.account-name',
    '.user-name',
    '.nickname',
    '[class*="account-name"]',
    '[class*="user-name"]',
  ],
  avatarSelectors: [
    'img.user_avatar',
    '[class*="avatar"] img',
    'img[class*="img-"]',
    'img[class*="avatar"]',
  ],
  loginKeywords: LOGIN_KEYWORDS,
};

const adapter: PlatformAdapter = {
  key: 'xiaohongshu',
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publishImage,
  publishArticle,
  publish,
};

// 注：buildPageStructureProbe 从 shared.ts import，以满足"可从 shared.ts import"要求，
//     这里显示调用一次以避免 tree-shaking 将其移除（某些 TypeScript 编译器可能会警告未使用的 import）。
void buildPageStructureProbe;

registerPlatform(adapter);

export default adapter;
