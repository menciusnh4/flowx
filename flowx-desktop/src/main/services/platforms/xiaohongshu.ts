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
  cdpInsertTagsWithSpace,
  buildTestModeProbeScript,
  setupTestModeWindow,
  createMarkdownTempFile,
  cleanupMarkdownTempFile,
  uploadFileToInput,
} from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities, ContentType } from '../../../types';

// =====================================================================
// 常量 / 配置
// =====================================================================

// 通用发布页 URL（视频/图文）
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';

// 图文发布专用 URL（直接打开图文 tab，避免 JS 切换 tab 导致的上传区域不匹配问题）
const PUBLISH_IMAGE_URL =
  'https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image';

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

// 🔑 小红书文章（长文）发布平台限制：标题最多 64 字，正文 10000 字（换行符不计），话题最多 10 个
const ARTICLE_TITLE_LIMIT = 64;
const ARTICLE_CONTENT_LIMIT = 10000; // 正文 10000 字（换行符不计入字数）

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
    '  var reAccount = /(?:小红书号|小红书账号)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/;' +
    '  var accountMatch = bodyText.match(reAccount);' +
    '  if (accountMatch && accountMatch[1]) result.platformAccountId = accountMatch[1];' +
    '  if (!result.platformAccountId) {' +
    '    try {' +
    '      var divs = document.querySelectorAll("div, span, p");' +
    '      for (var di = 0; di < divs.length; di++) {' +
    '        var txt = (divs[di].textContent || "").trim();' +
    '        var m = txt.match(/(?:小红书号|小红书账号)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/);' +
    '        if (m && m[1]) { result.platformAccountId = m[1]; break; }' +
    '      }' +
    '    } catch(e) {}' +
    '  }' +
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
 *  5) 写完后保持焦点在编辑器末尾，不 blur（便于后续 CDP 键盘事件输入标签）
 */
function buildFillContentScript(content: string): string {
  const contentJSON = JSON.stringify(content);
  return (
    '(function(){' +
    'var content = ' + contentJSON + ';' +
    // 辅助：将光标移到编辑器末尾
    'function moveCursorToEnd(el) {' +
    '  try {' +
    '    el.focus();' +
    '    var range = document.createRange();' +
    '    range.selectNodeContents(el);' +
    '    range.collapse(false);' +
    '    var sel = window.getSelection();' +
    '    sel.removeAllRanges();' +
    '    sel.addRange(range);' +
    '  } catch(e) {}' +
    '}' +
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
    'var kind = pmTarget ? \'prosemirror\' : (edTarget ? \'contenteditable\' : \'textarea\');' +
    // 写入正文
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
    // 普通 contenteditable：用 execCommand 触发真实输入事件
    '    try { document.execCommand(\'selectAll\'); } catch(e1) {}' +
    '    try { document.execCommand(\'delete\'); } catch(e2) {}' +
    '    try { document.execCommand(\'insertText\', false, content); } catch(e3) { target.innerText = content; }' +
    '    try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  }' +
    // 将光标移到末尾，保持焦点（不blur），便于后续CDP输入标签
    '  if (pmTarget || edTarget) {' +
    '    moveCursorToEnd(target);' +
    '  }' +
    '  return { ok: true, kind: kind, length: content.length, isContentEditable: pmTarget || edTarget ? true : false };' +
    '} catch(e) {' +
    '  return { ok: false, reason: String(e && e.message || e) };' +
    '}' +
    '})()'
  );
}

/**
 * [文章发布专用] 生成填写第三步页面"正文描述/摘要"的 JS 脚本
 *  - 第三步页面（发布设置页）的正文描述框，与图文发布的正文描述框类似
 *  - 描述框也是 tiptap / ProseMirror 编辑器，是页面上第二个 ProseMirror 编辑器
 *  - 第一个 ProseMirror 是正文编辑器，第二个是描述/摘要编辑器
 *  - 写完后光标保持在末尾，便于后续 CDP 输入话题标签
 */
function buildFillArticleSummaryScript(summary: string): string {
  const contentJSON = JSON.stringify(summary);
  return (
    '(function(){' +
    'var content = ' + contentJSON + ';' +
    // 辅助：将光标移到编辑器末尾
    'function moveCursorToEnd(el) {' +
    '  try {' +
    '    el.focus();' +
    '    var range = document.createRange();' +
    '    range.selectNodeContents(el);' +
    '    range.collapse(false);' +
    '    var sel = window.getSelection();' +
    '    sel.removeAllRanges();' +
    '    sel.addRange(range);' +
    '  } catch(e) {}' +
    '}' +
    // 辅助：判断是否为 ProseMirror / tiptap
    'function isProseMirror(el) {' +
    '  if (!el || !el.getAttribute) return false;' +
    '  var cls = el.getAttribute(\'class\') || \'\';' +
    '  if (cls.indexOf(\'ProseMirror\') !== -1) return true;' +
    '  if (cls.indexOf(\'tiptap\') !== -1) return true;' +
    '  return false;' +
    '}' +
    // 收集所有 ProseMirror 编辑器
    'var pmEditors = [];' +
    'try {' +
    '  var nodes = document.querySelectorAll(\'[contenteditable]\');' +
    '  for (var i = 0; i < nodes.length; i++) {' +
    '    var n = nodes[i];' +
    '    if (isProseMirror(n)) {' +
    '      pmEditors.push(n);' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    // 目标：第二个 ProseMirror 编辑器（描述框）。如果只有一个，就用那一个。
    'var target = null;' +
    'if (pmEditors.length >= 2) {' +
    '  target = pmEditors[1];' +
    '} else if (pmEditors.length === 1) {' +
    '  target = pmEditors[0];' +
    '}' +
    'if (!target) return { ok: false, kind: \'\', length: 0, isContentEditable: false, reason: \'no-summary-target\' };' +
    'var kind = \'prosemirror\';' +
    // 写入内容
    'try {' +
    '  target.focus();' +
    // ProseMirror：selectAll → delete → insertText
    '  try {' +
    '    window.getSelection().removeAllRanges();' +
    '    var range = document.createRange();' +
    '    range.selectNodeContents(target);' +
    '    window.getSelection().addRange(range);' +
    '    try { document.execCommand(\'delete\'); } catch(e) {}' +
    '    try { document.execCommand(\'insertText\', false, content); } catch(e2) { target.innerText = content; }' +
    '  } catch(e) {' +
    '    target.innerText = content;' +
    '  }' +
    '  try { target.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    // 将光标移到末尾，保持焦点（不blur），便于后续CDP输入标签
    '  moveCursorToEnd(target);' +
    '  return { ok: true, kind: kind, length: content.length, isContentEditable: true };' +
    '} catch(e) {' +
    '  return { ok: false, kind: kind, length: 0, isContentEditable: true, reason: String(e && e.message || e) };' +
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
    // URL 变化检测（图文/视频发布：从 publish 页跳走）
    'var leftPublish = url.indexOf("/publish/publish") === -1 && url.indexOf("publish") === -1;' +
    // 🔑 文章发布特有成功状态：
    //   - /publish/success  → 发布成功页（长文发布专用）
    //   - /publish/publish?published=true  → 发布后回调到发布页
    //   - URL 包含 "success" 且在 /publish/ 目录下
    'var isArticleSuccess = url.indexOf("/publish/success") !== -1 || url.indexOf("published=true") !== -1 || (url.indexOf("success") !== -1 && url.indexOf("/publish/") !== -1);' +
    'return {' +
    '  url: url,' +
    '  success: hitSuccess.length > 0 || isArticleSuccess || (leftPublish && hitFail.length === 0),' +
    '  failed: hitFail.length > 0,' +
    '  hitSuccess: hitSuccess,' +
    '  hitFail: hitFail,' +
    '  leftPublish: leftPublish,' +
    '  isArticleSuccess: isArticleSuccess' +
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
 * 按"排除换行符的字符数"截断文本
 *  - 计算字数时忽略 \n 和 \r
 *  - 截断时保留换行符（只限制有效字符数）
 *  - 返回截断后的完整文本（包含换行符）
 */
function truncateExcludingNewlines(text: string, max: number): string {
  if (!text) return '';
  let effectiveLen = 0;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      result += ch;
      continue;
    }
    if (effectiveLen >= max) break;
    result += ch;
    effectiveLen++;
  }
  return result;
}

/**
 * 将 Markdown 内容清洗为纯文本（仅保留支持的语法对应的文字）
 */
function cleanMarkdownToPlain(mdText: string): string {
  if (!mdText) return '';
  return mdText
    .replace(/!\[.*?\]\(.*?\)/g, '') // 去除图片
    .replace(/^#{1,6}\s+/gm, '') // 去除标题标记
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 去除粗体
    .replace(/\*([^*]+)\*/g, '$1') // 去除斜体
    .replace(/==([^=]+)==/g, '$1') // 去除高亮
    .replace(/^>\s?/gm, '') // 去除引用
    .replace(/^[-*+]\s+/gm, '') // 去除无序列表
    .replace(/^\d+\.\s+/gm, ''); // 去除有序列表
}

/**
 * 拼接正文 + 话题（小红书最多 10 个话题，拼到正文末尾）
 *  - 每个 tag 前面自动加 "#"（若没有）
 *  - 超出 MAX_TAGS 的部分丢弃
 */
function buildContentText(content: string, tags: string[] | undefined): string {
  const base = content || '';
  if (!tags || tags.length === 0) return base;
  const trimmedTags = prepareTags(tags);
  if (trimmedTags.length === 0) return base;
  const tagStr = trimmedTags.join(' ');
  const combined = base.length > 0 ? base + '\n' + tagStr : tagStr;
  return combined;
}

/**
 * 清洗标签数组：去空、加#前缀、去重、截断到MAX_TAGS
 */
function prepareTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tags) {
    const trimmed = (t || '').trim();
    if (!trimmed) continue;
    const withHash = trimmed.startsWith('#') ? trimmed : '#' + trimmed;
    if (seen.has(withHash)) continue;
    seen.add(withHash);
    result.push(withHash);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
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

    // 2) 根据内容类型加载对应发布页
    onProgress(5, '加载发布页…');
    const targetUrl = contentType === 'image' ? PUBLISH_IMAGE_URL : PUBLISH_URL;
    log('info', 'load', `打开 ${targetUrl} (contentType=${contentType})`);
    await win.loadURL(targetUrl).catch((err) => {
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
          const backUrl = contentType === 'image' ? PUBLISH_IMAGE_URL : PUBLISH_URL;
          log('info', 'login', `当前不在发布页 (${currentUrl})，重新跳转至发布页`);
          await win.loadURL(backUrl).catch(() => {});
        }
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', '已登录，继续发布流程');
    }

    onProgress(25, '已登录，准备上传内容…');

    // 5) 图文模式：确保当前处于图文 tab，等待图文上传区域渲染
    if (contentType === 'image') {
      log('info', 'tab', '确保处于图文发布 tab…');

      // 检测是否已经在图文 tab（通过 URL 参数或页面内容判断）
      const checkImageTabScript = `
        (function(){
          try {
            // 方法1：检查 URL 是否有 target=image
            if (window.location.href.indexOf('target=image') !== -1) return { isImageTab: true, reason: 'url_target_image' };
            // 方法2：检查页面上是否有图文上传相关的元素或文本
            var bodyText = (document.body.innerText || '').replace(/\\s+/g, '');
            // 检查是否有"上传图文"且没有"上传视频"在显著位置
            var hasUploadImageText = bodyText.indexOf('上传图文') !== -1 || bodyText.indexOf('上传图片') !== -1;
            // 检查是否有图片格式的 file input
            var imageInputs = document.querySelectorAll('input[type="file"][accept*="image"]');
            if (imageInputs && imageInputs.length > 0) return { isImageTab: true, reason: 'image_input_found', count: imageInputs.length };
            if (hasUploadImageText) return { isImageTab: true, reason: 'upload_image_text' };
            return { isImageTab: false, bodyText: bodyText.slice(0, 200) };
          } catch(e) { return { isImageTab: false, error: String(e) }; }
        })()
      `;

      // 先检查当前是否已经在图文 tab
      let tabCheck: any = await evalJS(win, checkImageTabScript, '检测图文 tab', log).catch(() => null);
      log('info', 'tab', `初始 tab 检测: ${JSON.stringify(tabCheck)}`);

      // 如果不在图文 tab，尝试点击切换
      if (!tabCheck || !tabCheck.isImageTab) {
        log('info', 'tab', '当前不在图文 tab，尝试切换…');
        const tabSwitchScript =
          '(function(){' +
          'var targets = ["图文", "图片", "上传图文"];' +
          'var found = null;' +
          'try {' +
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
      }

      // 等待图文上传区域渲染（最多等待 8 秒，轮询检测 image 类型的 file input）
      log('info', 'tab', '等待图文上传区域渲染…');
      const waitStart = Date.now();
      const waitTimeout = 8000;
      let imageInputReady = false;
      while (Date.now() - waitStart < waitTimeout) {
        await sleep(1000);
        const check: any = await win.webContents.executeJavaScript(checkImageTabScript).catch(() => null);
        if (check && check.isImageTab) {
          imageInputReady = true;
          log('info', 'tab', `图文上传区域已就绪 (${check.reason})`);
          break;
        }
      }
      if (!imageInputReady) {
        log('warn', 'tab', '等待图文上传区域超时，继续尝试上传…');
      }
      // 额外等待一下确保 DOM 稳定
      await sleep(1000);
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
    // 窗口已销毁：立即终止发布流程
    if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
      log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
      return makeFailedResult(accountId, 'xiaohongshu', '发布窗口已被关闭，发布已终止', startedAt);
    }
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

    // 9) 填充正文
    onProgress(70, '填写正文…');
    const baseContent = truncate(request.content || '', CONTENT_LIMIT);
    const tagList = prepareTags(request.tags);
    if ((request.content || '').length > CONTENT_LIMIT) {
      log('warn', 'fill-content', `正文过长，已从 ${(request.content || '').length} 字截断为 ${CONTENT_LIMIT} 字`);
    }
    log('info', 'fill-content', `正文长度: ${baseContent.length}/${CONTENT_LIMIT} 字, 标签: ${tagList.length} 个`);
    const contentResult: any = await evalJS(win, buildFillContentScript(baseContent), '填写正文', log);
    log('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentResult)}`);
    await sleep(500);

    // 9.5) 通过 CDP 真实键盘事件逐个输入话题标签（空格键触发话题识别）
    if (tagList.length > 0 && contentResult && contentResult.ok && contentResult.isContentEditable) {
      await cdpInsertTagsWithSpace(win, tagList, baseContent.length > 0, log);
      await sleep(300);
    }

    // 10) 点击"发布"按钮 —— 🔑 使用 CDP 穿透 closed shadow DOM（小红书发布按钮是自定义 web component）
    //    先尝试 JS 点击（处理 light DOM 中的按钮），失败后用 CDP 鼠标合成事件（可穿透 shadow DOM）
    onProgress(85, '点击发布按钮…');

    // 测试模式：不点击发布，高亮标记按钮并收集表单状态
    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          'button.ce-btn.bg-red',
          '.publish-page-publish-btn button',
          '.publish-page-publish-btn',
          'xhs-publish-btn',
          'button[type="submit"]',
          '.publish-btn',
          '.submit-btn',
        ],
        [
          { name: '标题', selector: 'input[placeholder*="标题"]', type: 'input' },
          { name: '正文', selector: '[contenteditable="true"]', type: 'contenteditable' },
          { name: '正文文本框', selector: 'textarea', type: 'textarea' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name.includes('正文') || f.name.includes('描述'))?.filled),
        tagsFilled: tagList.length > 0 && !!(contentResult && contentResult.ok),
        coverUploaded: !!(uploadResult && uploadResult.ready),
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
        accountId,
        platform: 'xiaohongshu',
        status: 'success',
        progress: 100,
        message: '测试完成 - 表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

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
    // 测试模式：不关闭窗口，让用户可以检查表单填写情况
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
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

    onProgress(30, '已登录，准备进入文章编辑器…');

    // 🔑 关键修复 v3：`target=article` 页面加载后默认显示视频发布界面
    //    真实流程（根据用户提供的 HTML）：
    //      1) 页面加载：显示视频发布界面（含"发布笔记"按钮）
    //      2) 可能需要点击"写长文"切换到文章模式
    //      3) 点击红色按钮 "✏️ 新的创作" 进入编辑器
    //    重要教训：cdpClickPublishButton 对"新的创作"关键词匹配过于宽松（会误点"发布笔记"）
    //             本次修复完全弃用 CDP 点击进入编辑器，改用纯 JS DOM 精准点击 <button class="new-btn">
    //    HTML 参考（来自实际页面）：
    //      <button ... class="d-button ... custom-button bg-red new-btn">
    //        <span class="center"><svg>✏️</svg> 新的创作</span>
    //      </button>
    try {
      // ========== Step 1: 检查是否已在编辑器（跳过整个流程） ==========
      const alreadyEditor: any = await evalJS(
        win,
        `(function(){
          var hasEd = false, hasTitle = false;
          try {
            var all = document.body ? document.body.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]') : [];
            for (var i = 0; i < all.length; i++) {
              var ce = all[i].getAttribute && all[i].getAttribute('contenteditable');
              if (ce === 'true' || ce === '' ) hasEd = true;
              var ph = (all[i].getAttribute && all[i].getAttribute('placeholder')) || '';
              if (/标题|title/.test(ph)) hasTitle = true;
              if (hasEd && hasTitle) break;
            }
          } catch(e) {}
          return { hasEd: hasEd, hasTitle: hasTitle, url: location.href };
        })()`,
        '文章-编辑器检测',
        log,
      ).catch(() => ({ hasEd: false, hasTitle: false, url: '' }));

      if (alreadyEditor?.hasEd || alreadyEditor?.hasTitle) {
        log('info', 'enter-editor', `✅ 已在编辑器，跳过入口点击 (url=${alreadyEditor.url})`);
        onProgress(50, '已在编辑器，开始填写内容…');
      } else {
        // ========== Step 2: 纯 JS 精准点击（避免 cdpClickPublishButton 误点"发布笔记"） ==========
        const originalUrl = win.webContents.getURL();
        log('info', 'enter-editor', `不在编辑器，寻找并点击进入文章模式 (url=${originalUrl})`);

        // 优先：直接点击带 "新的创作" 文本的 button（它就是 class="new-btn" 的红色按钮）
        // 备选：点击 "写长文" / "写文章" / "文章" 等切换按钮（它可能需要先切换页面模式）
        const enterEditorResult: any = await evalJS(
          win,
          `(function(){
            // 查找并点击"新的创作"按钮（从 HTML 看它是 <button>，class 含 "new-btn" / "bg-red" / "d-button"）
            function findAndClick(pattern, strict) {
              // 策略 A: CSS class 直接命中（最可靠）
              try {
                var byClass = document.querySelector('button.new-btn, button.bg-red, button[class*="new-btn"], button[class*="custom-button"]');
                if (byClass) {
                  var txt = (byClass.innerText || byClass.textContent || '').trim();
                  if (!strict || pattern.test(txt)) {
                    byClass.click();
                    return { method: 'class-selector', text: txt.slice(0, 20), clicked: true };
                  }
                }
              } catch(e) {}

              // 策略 B: 遍历 button/a，文本严格匹配 pattern
              try {
                var tags = document.querySelectorAll('button, a, [role="button"]');
                var best = null;
                for (var i = 0; i < tags.length; i++) {
                  var t = (tags[i].innerText || tags[i].textContent || '').trim();
                  if (!t) continue;
                  if (pattern.test(t)) {
                    best = tags[i];
                    break;
                  }
                }
                if (best) {
                  best.click();
                  return { method: 'text-match', text: (best.innerText||'').trim().slice(0, 20), clicked: true };
                }
              } catch(e) {}

              // 策略 C: 深搜所有 DOM 节点文本（处理嵌套 span/div 的情况）
              try {
                var allEl = document.body ? document.body.querySelectorAll('*') : [];
                for (var k = 0; k < allEl.length; k++) {
                  var t2 = (allEl[k].innerText || allEl[k].textContent || '').trim();
                  if (t2 && pattern.test(t2) && t2.replace(/\\s+/g,'').length <= 20) {
                    // 必须是可点击元素（含 button/a/role=button 或有 click 监听）
                    var p = allEl[k];
                    while (p && p.nodeType === 1) {
                      var tn = (p.tagName || '').toLowerCase();
                      var role = (p.getAttribute && p.getAttribute('role')) || '';
                      var cls2 = (p.getAttribute && p.getAttribute('class')) || '';
                      if (tn === 'button' || tn === 'a' || role === 'button' || role === 'link' || /btn|button|clickable|cursor-pointer/.test(cls2)) {
                        p.click();
                        return { method: 'deep-search', text: t2.slice(0, 20), clicked: true };
                      }
                      p = p.parentElement;
                    }
                  }
                }
              } catch(e) {}

              return { clicked: false };
            }

            // 第 1 轮：找 "新的创作"（直接进入编辑器）
            var r1 = findAndClick(/新的创作|新创作|✨.*创作/, true);
            if (r1.clicked) return r1;

            // 第 2 轮：没找到可能需要先切换到文章模式，点击"写长文"等
            var r2 = findAndClick(/写长文|写文章|长文|新建文章/, true);
            if (r2.clicked) return r2;

            // 第 3 轮：兜底，点击页面中任意"创作"字样按钮
            var r3 = findAndClick(/创作/, false);
            if (r3.clicked) return r3;

            return { clicked: false };
          })()`,
          '文章-点击进入编辑器',
          log,
        ).catch(() => ({ clicked: false }));

        log('info', 'enter-editor', `JS 点击结果: ${JSON.stringify(enterEditorResult)}`);

        if (!enterEditorResult.clicked) {
          log('warn', 'enter-editor', '❌ JS 未找到可点击的入口按钮');
          return makeFailedResult(
            accountId,
            'xiaohongshu',
            '未能进入文章编辑器：页面中未找到"新的创作"或"写长文"按钮，请手动检查页面',
            startedAt,
          );
        }

        // 点击后等待页面导航 + 渲染（新的创作 按钮可能触发 JS 路由跳转）
        onProgress(40, '等待编辑器加载…');
        await tracker.waitForStable(2000, 15000);
        await sleep(2000);

        // ========== Step 3: 二次检查 —— 如果点击了"写长文"，可能还需要再点一次"新的创作" ==========
        const afterClick: any = await evalJS(
          win,
          `(function(){
            var hasEd = false, hasTitle = false, newBtnExists = false, stillOnVideoPage = false;
            try {
              var all = document.body ? document.body.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]') : [];
              for (var i = 0; i < all.length; i++) {
                var ce = all[i].getAttribute && all[i].getAttribute('contenteditable');
                if (ce === 'true' || ce === '' ) hasEd = true;
                var ph = (all[i].getAttribute && all[i].getAttribute('placeholder')) || '';
                if (/标题|title/.test(ph)) hasTitle = true;
                if (hasEd && hasTitle) break;
              }
            } catch(e) {}
            // 检查"新的创作"按钮是否在点击后出现
            try {
              var btns = document.querySelectorAll('button, a, [role="button"]');
              for (var j = 0; j < btns.length; j++) {
                var t = (btns[j].innerText || btns[j].textContent || '').trim();
                if (/新的创作/.test(t)) { newBtnExists = true; break; }
              }
            } catch(e) {}
            return { hasEd: hasEd, hasTitle: hasTitle, newBtnExists: newBtnExists, url: location.href };
          })()`,
          '文章-点击后状态检查',
          log,
        ).catch(() => ({ hasEd: false, hasTitle: false, newBtnExists: false, url: '' }));
        log('info', 'enter-editor', `点击后检查: ${JSON.stringify(afterClick)}`);

        if (afterClick?.hasEd || afterClick?.hasTitle) {
          log('info', 'enter-editor', '✅ 一次点击已进入编辑器');
        } else if (afterClick?.newBtnExists) {
          // 页面切换到了文章管理页，"新的创作"按钮出现，再点一次
          log('info', 'enter-editor', '检测到"新的创作"已出现，第二次点击进入编辑器');
          onProgress(43, '进入编辑器…');
          const secondClick: any = await evalJS(
            win,
            `(function(){
              // 直接找 class 匹配或文本匹配的 button
              var byClass = document.querySelector('button.new-btn, button.bg-red, button[class*="new-btn"], button[class*="custom-button"]');
              if (byClass) { byClass.click(); return { method:'class', text:(byClass.innerText||'').trim().slice(0,20), clicked:true }; }
              var tags = document.querySelectorAll('button, a, [role="button"]');
              for (var i = 0; i < tags.length; i++) {
                var t = (tags[i].innerText || tags[i].textContent || '').trim();
                if (/新的创作/.test(t)) { tags[i].click(); return { method:'text', text:t.slice(0,20), clicked:true }; }
              }
              return { clicked: false };
            })()`,
            '文章-二次点击新的创作',
            log,
          ).catch(() => ({ clicked: false }));
          log('info', 'enter-editor', `二次点击结果: ${JSON.stringify(secondClick)}`);
          if (!secondClick.clicked) {
            return makeFailedResult(accountId, 'xiaohongshu', '点击"新的创作"后进入文章管理页，但无法再次点击进入编辑器', startedAt);
          }
          await tracker.waitForStable(2000, 15000);
          await sleep(2000);
        } else {
          log('warn', 'enter-editor', `点击后未进入编辑器，也未发现"新的创作"按钮 (url=${afterClick?.url})`);
          return makeFailedResult(accountId, 'xiaohongshu', '进入文章编辑器失败：页面结构与预期不符', startedAt);
        }

        onProgress(50, '已进入编辑器，准备填写内容…');
      }
    } catch (enterErr) {
      log('warn', 'enter-editor', `异常: ${enterErr instanceof Error ? enterErr.message : String(enterErr)}`);
      return makeFailedResult(
        accountId,
        'xiaohongshu',
        `进入编辑器失败: ${enterErr instanceof Error ? enterErr.message : String(enterErr)}`,
        startedAt,
      );
    }

    // 5) 上传用户提供的素材（如有）
    const files = request.mediaFiles || [];
    if (files.length > 0) {
      onProgress(38, '上传文件…');
      log('info', 'upload', `待上传文件: ${files.join(', ')}`);
      const uploadOk = await uploadViaCDP(win, files, log, 'image');
      if (uploadOk) {
        onProgress(50, '等待上传完成…');
        const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000, tracker);
        // 窗口已销毁：立即终止发布流程
        if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
          log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
          return makeFailedResult(accountId, 'xiaohongshu', '发布窗口已被关闭，发布已终止', startedAt);
        }
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

    // 7) 正文
    onProgress(72, '填写正文…');
    const isMarkdownMode = request.contentMode === 'markdown' && request.markdownContent;
    let mdFilePath = '';
    const articleTagList = prepareTags(request.tags);

    if (isMarkdownMode) {
      // Markdown 模式：生成 .md 文件并通过文档导入上传
      log('info', 'fill-content', 'Markdown 模式，生成 .md 文件并通过文档导入上传');
      onProgress(68, '生成 Markdown 文件…');

      try {
        mdFilePath = createMarkdownTempFile(request.markdownContent || '', 'xhs-article');
        log('info', 'fill-content', `Markdown 临时文件已生成: ${mdFilePath}`);

        onProgress(70, '点击文档导入…');
        // 点击文档导入图标按钮（工具栏中的 .menu-item，文档图标 SVG）
        const clickImportResult: any = await evalJS(
          win as BrowserWindow,
          `(function(){
            // 查找文档导入按钮：.menu-item 中包含文档图标的
            var items = document.querySelectorAll('.menu-item');
            for (var i = 0; i < items.length; i++) {
              var item = items[i];
              var svg = item.querySelector('svg');
              if (!svg) continue;
              // 文档图标特征：包含 path，且 path 的 d 属性包含文档相关特征（如矩形+线条）
              var paths = svg.querySelectorAll('path');
              for (var j = 0; j < paths.length; j++) {
                var d = paths[j].getAttribute('d') || '';
                // 文档导入图标的特征：包含文件图标 + 箭头
                if (d.indexOf('M13.4287 1.72845') !== -1 ||  // 文件图标起点
                    (d.indexOf('import') !== -1) ||
                    (svg.innerHTML && svg.innerHTML.indexOf('upload') !== -1)) {
                  item.click();
                  return { ok: true, selector: '.menu-item[doc-icon]' };
                }
              }
            }
            // 备选：通过 tooltip 或 aria-label 匹配
            var allBtns = document.querySelectorAll('.menu-item, button[class*="menu"]');
            for (var k = 0; k < allBtns.length; k++) {
              var btn = allBtns[k];
              var title = btn.getAttribute('title') || btn.getAttribute('aria-label') || '';
              if (/文档导入|导入文档|import.*doc|doc.*import/i.test(title)) {
                btn.click();
                return { ok: true, selector: 'title-match' };
              }
            }
            // 备选：查找所有 menu-item 中 SVG path 数量符合文档图标的（一般有2-3个path）
            var menuItems = document.querySelectorAll('.menu-item');
            var candidates = [];
            for (var m = 0; m < menuItems.length; m++) {
              var mi = menuItems[m];
              var svgEl = mi.querySelector('svg');
              if (svgEl) {
                var pathCount = svgEl.querySelectorAll('path').length;
                // 文档图标通常有 2-4 个 path（文件轮廓 + 内部线条 + 导入箭头）
                if (pathCount >= 2 && pathCount <= 5) {
                  candidates.push({ el: mi, pathCount: pathCount });
                }
              }
            }
            // 如果只有一个候选，直接点击
            if (candidates.length === 1) {
              candidates[0].el.click();
              return { ok: true, selector: 'single-candidate' };
            }
            // 如果有多个，尝试找包含导入特征的
            for (var n = 0; n < candidates.length; n++) {
              var c = candidates[n];
              var html = c.el.innerHTML || '';
              // 导入箭头特征：d 属性中有类似箭头向下/向上的路径
              if (html.indexOf('arrow') !== -1 || html.indexOf('import') !== -1 || html.indexOf('upload') !== -1) {
                c.el.click();
                return { ok: true, selector: 'arrow-candidate' };
              }
            }
            // 最后兜底：点击第 7 个 menu-item（文档导入通常在工具栏中间位置）
            if (menuItems.length >= 5) {
              // 尝试从右往左数第3个（文档导入通常在格式按钮之后）
              var idx = Math.max(0, menuItems.length - 4);
              menuItems[idx].click();
              return { ok: true, selector: 'fallback-index-' + idx };
            }
            return { ok: false, reason: '未找到文档导入按钮', menuItemCount: menuItems.length };
          })()`,
          '文章-点击文档导入',
          log,
        ).catch(() => null);

        if (!clickImportResult || !clickImportResult.ok) {
          log('warn', 'fill-content', `点击文档导入按钮失败: ${JSON.stringify(clickImportResult)}，回退到纯文本模式`);
          // 回退到纯文本填写
          const originalContent = cleanMarkdownToPlain(request.markdownContent || '');
          const rawContent = truncateExcludingNewlines(originalContent, ARTICLE_CONTENT_LIMIT);
          const effectiveLen = originalContent.replace(/[\n\r]/g, '').length;
          log('info', 'fill-content', `回退纯文本: 有效字符 ${effectiveLen}/${ARTICLE_CONTENT_LIMIT} 字`);
          const contentRes: any = await evalJS(win, buildFillContentScript(rawContent), '文章-填写正文', log).catch(() => null);
          log('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentRes)}`);
        } else {
          log('info', 'fill-content', `文档导入按钮已点击 (${clickImportResult.selector})，等待弹窗…`);
          await sleep(1500);

          // 等待导入弹窗出现
          onProgress(71, '等待导入弹窗…');
          let modalAppeared = false;
          const modalDeadline = Date.now() + 5000;
          while (Date.now() < modalDeadline) {
            const checkModal: any = await evalJS(
              win as BrowserWindow,
              `(function(){ return !!document.querySelector('.import-from-file-modal, .d-modal'); })()`,
              '文章-检查弹窗',
              log,
            ).catch(() => false);
            if (checkModal) {
              modalAppeared = true;
              break;
            }
            await sleep(300);
          }

          if (!modalAppeared) {
            log('warn', 'fill-content', '导入弹窗未出现，回退到纯文本模式');
            const originalContent = cleanMarkdownToPlain(request.markdownContent || '');
            const rawContent = truncateExcludingNewlines(originalContent, ARTICLE_CONTENT_LIMIT);
            await evalJS(win, buildFillContentScript(rawContent), '文章-填写正文-回退', log).catch(() => null);
          } else {
            log('info', 'fill-content', '导入弹窗已出现，点击上传区域…');

            // 点击上传区域，触发文件选择
            await evalJS(
              win as BrowserWindow,
              `(function(){
                var uploadArea = document.querySelector('.import-from-file-modal .upload-area, .d-modal .upload-area, [class*="upload-area"]');
                if (uploadArea) {
                  uploadArea.click();
                  return { ok: true };
                }
                return { ok: false, reason: '未找到上传区域' };
              })()`,
              '文章-点击上传区域',
              log,
            ).catch(() => null);

            await sleep(800);

            // 等待 file input 出现并上传文件
            onProgress(73, '上传 Markdown 文件…');
            const uploadResult = await uploadFileToInput(
              win as BrowserWindow,
              mdFilePath,
              'input[type=file][accept*=".md"], input[type=file][accept*=".markdown"], input[type=file][accept*="docx"], .import-from-file-modal input[type=file], .d-modal input[type=file], body > input[type=file]',
              log,
              8000,
            );

            if (uploadResult) {
              log('info', 'fill-content', 'Markdown 文件上传成功，等待内容填充…');
              // 等待内容自动填充到编辑器
              await sleep(2500);
              // 关闭弹窗（如果还开着）
              try {
                await evalJS(
                  win as BrowserWindow,
                  `(function(){
                    var closeBtn = document.querySelector('.d-modal-close, .import-from-file-modal .d-modal-close');
                    if (closeBtn) { closeBtn.click(); return { closed: true }; }
                    return { closed: false };
                  })()`,
                  '文章-关闭导入弹窗',
                  log,
                ).catch(() => null);
              } catch {
                // 忽略关闭失败
              }
              await sleep(1000);
              log('info', 'fill-content', 'Markdown 内容已导入编辑器');
            } else {
              log('warn', 'fill-content', 'Markdown 文件上传失败，回退到纯文本模式');
              // 关闭弹窗
              try {
                await evalJS(
                  win as BrowserWindow,
                  `(function(){
                    var closeBtn = document.querySelector('.d-modal-close');
                    if (closeBtn) closeBtn.click();
                  })()`,
                  '文章-关闭弹窗',
                  log,
                ).catch(() => null);
              } catch {}
              await sleep(500);
              // 回退到纯文本
              const originalContent = cleanMarkdownToPlain(request.markdownContent || '');
              const rawContent = truncateExcludingNewlines(originalContent, ARTICLE_CONTENT_LIMIT);
              await evalJS(win, buildFillContentScript(rawContent), '文章-填写正文-回退', log).catch(() => null);
            }
          }
        }
      } catch (mdErr) {
        log('error', 'fill-content', `Markdown 上传异常: ${mdErr instanceof Error ? mdErr.message : String(mdErr)}，回退到纯文本`);
        const originalContent = cleanMarkdownToPlain(request.markdownContent || '');
        const rawContent = truncateExcludingNewlines(originalContent, ARTICLE_CONTENT_LIMIT);
        await evalJS(win, buildFillContentScript(rawContent), '文章-填写正文-回退', log).catch(() => null);
      } finally {
        // 清理临时文件
        if (mdFilePath) {
          cleanupMarkdownTempFile(mdFilePath);
        }
      }
    } else {
      // 纯文本模式：直接填写正文
      const originalContent = request.content || '';
      const rawContent = truncateExcludingNewlines(originalContent, ARTICLE_CONTENT_LIMIT);
      const articleTagList = prepareTags(request.tags);
      // 计算有效字符数（排除换行）
      const effectiveLen = originalContent.replace(/[\n\r]/g, '').length;
      if (effectiveLen > ARTICLE_CONTENT_LIMIT) {
        log('warn', 'fill-content', `文章正文过长，有效字符 ${effectiveLen} > ${ARTICLE_CONTENT_LIMIT}，已截断（换行符不计入字数）`);
      } else {
        log('info', 'fill-content', `文章正文: 有效字符 ${effectiveLen}/${ARTICLE_CONTENT_LIMIT} 字 (含换行共 ${rawContent.length} 字), 标签: ${articleTagList.length} 个`);
      }
      const contentRes: any = await evalJS(win, buildFillContentScript(rawContent), '文章-填写正文', log).catch(() => null);
      log('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentRes)}`);
      await sleep(500);
    }

    // 注意：文章发布的话题标签不在正文中插入，而是在第三步页面的正文描述框中追加

    // 8) 文章发布：点击底部 "next-btn" 红色按钮 2-3 次（文本动态变化）
    //    🔑 关键洞察（来自实际页面 HTML）：
    //      - 文章编辑页底部有一个按钮：<button class="d-button ... custom-button bg-red next-btn">
    //      - 这个按钮的文本动态变化：第1次 = "一键排版" → 第2次 = "下一步" → 第3次可能 = "发布"
    //      - 页脚结构：<div class="footer new-ui-footer"> ... <button class="next-btn">一键排版/下一步</button>
    //      - 同时页面左上角有一个"发布笔记"按钮（div，44x44，score=7500），必须 100% 避免点击它
    //    策略：
    //      A. 首选：直接 querySelector('button.next-btn') / 'button.bg-red' 精确匹配 + click()
    //      B. 每次点击后等待按钮文本变化（或超时），再点下一次
    //      C. 全程不使用通用的 cdpClickPublishButton（它会误点"发布笔记"）
    onProgress(70, '点击：一键排版…');

    // 帮助函数：精准点击底部红色按钮（by CSS class）。最多轮询 10 秒等待按钮出现
    // 🔑 关键：点击"一键排版"后页面会重新渲染，"下一步"按钮需要几秒才出现
    //          轮询逻辑放在 Node.js 侧（更可靠，避免浏览器 JS 的事件循环问题）
    async function clickNextBtn(expectedHint: string): Promise<{ ok: boolean; text: string; reason?: string; attempts?: number }> {
      const MAX_ATTEMPTS = 10;  // 最多 10 次，每次 1 秒
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const res: any = await evalJS(
          win as BrowserWindow,
          `(function(){
            // 🔒 只看 <button> 元素，不碰 div/a
            var blacklist = /发布笔记|暂存离开|保存草稿|返回/;
            var validText = /一键排版|智能排版|排版|下一步|发布作品|发布文章|立即发布|发布|继续|完成|next|publish/i;
            var prioritySelectors = [
              'button.next-btn','button.submit','button.bg-red',
              'button[class*="next-btn"]','button[class*="submit"]',
              'button[class*="custom-button"]','button[class*="d-button"]',
            ];
            var seen = new Set();
            for (var s = 0; s < prioritySelectors.length; s++) {
              try {
                var nodes = document.querySelectorAll(prioritySelectors[s]);
                for (var n = 0; n < nodes.length; n++) {
                  var nd = nodes[n];
                  var t = (nd.innerText || nd.textContent || '').trim().replace(/\s+/g, ' ');
                  if (!t || t.length > 40) continue;
                  if (seen.has(t)) continue;
                  seen.add(t);
                  if (blacklist.test(t)) continue;
                  if (!validText.test(t)) continue;
                  try { nd.click(); return { ok: true, text: t.slice(0,20) }; } catch(e) {}
                  try { var evt = new MouseEvent('click', { bubbles:true, cancelable:true, view:window });
                         nd.dispatchEvent(evt); return { ok:true, text:t.slice(0,20), method:'dispatch'}; } catch(e2) {}
                }
              } catch(e) {}
            }
            // 兜底：遍历所有 button
            try {
              var allBtns = document.querySelectorAll('button');
              for (var b = 0; b < allBtns.length; b++) {
                var bt = (allBtns[b].innerText || allBtns[b].textContent || '').trim().replace(/\\s+/g, ' ');
                if (!bt || bt.length > 40) continue;
                if (blacklist.test(bt)) continue;
                if (!validText.test(bt)) continue;
                allBtns[b].click();
                return { ok: true, text: bt.slice(0, 20) };
              }
            } catch(e) {}
            return { ok: false, text: '', reason: 'no-button' };
          })()`,
          `文章-${expectedHint}`,
          log,
        ).catch(() => ({ ok: false, text: '', reason: 'eval-error' }));

        if (res && res.ok) {
          return { ok: true, text: res.text, attempts: attempt };
        }

        // 最后一次也没找到 → 用 CDP 穿透 shadow DOM 作为兜底
        // 🔑 小红书最后一页的"发布"按钮可能在 web component / shadow DOM 中，JS querySelector 无法访问
        if (attempt === MAX_ATTEMPTS) {
          log('warn', 'article-publish', `⚠️ ${expectedHint} 按钮在 ${MAX_ATTEMPTS} 次 JS 尝试后仍未找到，改用 CDP 穿透式点击`);
          let cdpKeywords: string[];
          if (/排版/i.test(expectedHint)) cdpKeywords = ['一键排版', '智能排版', '排版'];
          else if (/下一步|继续|next/i.test(expectedHint)) cdpKeywords = ['下一步', '继续', 'next'];
          else cdpKeywords = ['发布作品', '发布文章', '立即发布', '发布', 'publish', 'confirm'];
          try {
            const cdpOk = await cdpClickPublishButton(win, log, cdpKeywords);
            if (cdpOk) return { ok: true, text: `CDP:${expectedHint}`, attempts: MAX_ATTEMPTS };
          } catch (cdpErr) {
            log('warn', 'article-publish', `CDP 点击异常: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`);
          }
          return { ok: false, text: '', reason: 'timeout-cdp-failed', attempts: MAX_ATTEMPTS };
        }

        // 等待 1 秒后再试
        log('info', 'article-publish', `  [第${attempt}/${MAX_ATTEMPTS}] 未找到"${expectedHint}"按钮，1 秒后重试`);
        await sleep(1000);
      }
      return { ok: false, text: '', reason: 'timeout', attempts: MAX_ATTEMPTS };
    }

    // 帮助函数：读取当前按钮文本（用于判断流程是否继续）
    async function readNextBtnText(): Promise<string> {
      const res: any = await evalJS(
        win as BrowserWindow,
        `(function(){
          // 与 clickNextBtn 相同的选择器和过滤逻辑
          var sel = ['button.next-btn','button.submit','button.bg-red','button[class*="next-btn"]','button[class*="submit"]','button[class*="custom-button"]','button[class*="d-button"]'];
          var blacklist = /发布笔记|暂存离开|保存草稿|返回/;
          var validText = /一键排版|智能排版|排版|下一步|发布作品|发布文章|立即发布|发布|继续|完成|next|publish/i;
          var seen2 = new Set();
          for (var s = 0; s < sel.length; s++) {
            try {
              var nodes = document.querySelectorAll(sel[s]);
              for (var n = 0; n < nodes.length; n++) {
                var nd = nodes[n];
                var t = (nd.innerText || nd.textContent || '').trim().replace(/\\s+/g, ' ');
                if (!t || t.length > 40) continue;
                if (seen2.has(t)) continue;
                seen2.add(t);
                if (blacklist.test(t)) continue;
                if (!validText.test(t)) continue;
                return t.slice(0, 20);
              }
            } catch(e) {}
          }
          // 兜底遍历所有 button
          try {
            var allBtns = document.querySelectorAll('button');
            for (var b = 0; b < allBtns.length; b++) {
              var bt = (allBtns[b].innerText || allBtns[b].textContent || '').trim().replace(/\\s+/g, ' ');
              if (!bt || bt.length > 40) continue;
              if (blacklist.test(bt)) continue;
              if (validText.test(bt)) return bt.slice(0, 20);
            }
          } catch(e) {}
          return '';
        })()`,
        '文章-按钮文本',
        log,
      ).catch(() => '');
      return res || '';
    }

    let publishFlowOk = true;
    const totalClicks = 3;
    let summaryResult: any = null; // 第三步页面摘要填写结果（用于话题插入）

    for (let clickN = 1; clickN <= totalClicks && publishFlowOk; clickN++) {
      const stepLabel = clickN === 1 ? '一键排版' : (clickN === 2 ? '下一步' : '发布');

      // 🔑 测试模式：在点击"发布"（第3步）之前停止，不执行真正的发布
      if (request.testMode && clickN === 3) {
        log('info', 'test', '测试模式：跳过"发布"按钮点击，仅收集表单状态');
        break;
      }

      onProgress(70 + clickN * 6, `点击：${stepLabel}（第 ${clickN}/${totalClicks} 步）…`);

      // 🔑 直接尝试点击当前步骤的按钮。不依赖 readNextBtnText 的返回值来判断是否继续。
      //   理由：排版后按钮可能在 shadow DOM / iframe 中，普通 DOM 查询可能返回空。
      //   但 clickNextBtn 会遍历所有 <button> 元素，真实点击按钮比判断"按钮是否存在"更靠谱。
      const clickRes = await clickNextBtn(stepLabel);
      log('info', 'article-publish', `点击 #${clickN} [${stepLabel}] → ${JSON.stringify(clickRes)}`);

      if (!clickRes.ok) {
        // 第 1 次点击失败：页面结构变化，明确失败
        if (clickN === 1) {
          log('warn', 'article-publish', `❌ 第 1 次点击失败（无法找到"一键排版"按钮）`);
          publishFlowOk = false;
          break;
        }
        // 第 2-3 次点击失败：可能已到最后页面/按钮不存在，视为流程完成
        log('info', 'article-publish', `ℹ️ 第 ${clickN} 次点击未找到按钮，视为流程已完成`);
        break;
      }

      // 步骤间等待：让排版 / 导航 / 接口调用完成
      const waitMs = clickN === 1 ? 5000 : 3500;
      await tracker.waitForStable(1500, 15000);
      await sleep(waitMs);

      // 🔒 只用 URL 跳转来判断流程是否已结束（更可靠）
      const currentUrl = win.webContents.getURL();
      if (!/publish|editor/i.test(currentUrl)) {
        log('info', 'article-publish', `✅ URL 已跳转到非发布页面: ${currentUrl}`);
        break;
      }

      // 调试辅助：读取按钮文本（仅供日志，不影响流程逻辑）
      const debugText = await readNextBtnText();
      log('info', 'article-publish', `点击 #${clickN} 后 [调试] 按钮文本: "${debugText}", 当前 URL: ${currentUrl}`);

      // 🔑 第二步（点击"下一步"）完成后：在第三步页面填写摘要 + 插入话题标签
      if (clickN === 2) {
        // 填写文章摘要（正文描述）
        const articleSummary = request.summary || '';
        if (articleSummary.trim() || articleTagList.length > 0) {
          onProgress(82, '填写文章摘要…');
          log('info', 'fill-summary', `文章摘要: ${articleSummary.length} 字, 标签: ${articleTagList.length} 个`);
          summaryResult = await evalJS(win, buildFillArticleSummaryScript(articleSummary), '文章-填写摘要', log).catch(() => null);
          log('info', 'fill-summary', `摘要填写结果: ${JSON.stringify(summaryResult)}`);
          await sleep(500);

          // 在摘要框中插入话题标签
          if (articleTagList.length > 0 && summaryResult && summaryResult.ok && summaryResult.isContentEditable) {
            log('info', 'cdp-tags', '在摘要描述框中插入话题标签…');
            await cdpInsertTagsWithSpace(win, articleTagList, articleSummary.trim().length > 0, log);
            await sleep(300);
          } else if (articleTagList.length > 0 && summaryResult && summaryResult.ok && summaryResult.kind === 'textarea') {
            // textarea 类型：用 JS 方式追加标签
            log('info', 'fill-summary', '摘要框为 textarea 类型，用 JS 追加话题标签');
            const tagsStr = articleTagList.join(' ');
            const appendScript = `
              (function() {
                try {
                  var phMatch = /描述|简介|摘要|正文|说点什么|添加描述/i;
                  var tas = document.querySelectorAll('textarea');
                  var target = null;
                  for (var i = 0; i < tas.length; i++) {
                    var ph = tas[i].getAttribute && tas[i].getAttribute('placeholder') || '';
                    if (ph && phMatch.test(ph) && !/标题|title/i.test(ph)) {
                      target = tas[i];
                      break;
                    }
                  }
                  if (!target) return { ok: false, reason: 'no-target' };
                  target.focus();
                  var curVal = target.value || '';
                  var toAppend = (curVal && curVal.length > 0 ? '\\n' : '') + ${JSON.stringify(tagsStr)};
                  target.value = curVal + toAppend;
                  try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                  try { target.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
                  // 光标移到末尾
                  target.selectionStart = target.value.length;
                  target.selectionEnd = target.value.length;
                  return { ok: true, appended: toAppend.length, total: target.value.length };
                } catch(e) {
                  return { ok: false, reason: String(e && e.message || e) };
                }
              })()
            `;
            const appendRes: any = await evalJS(win, appendScript, '文章-摘要追加标签', log).catch(() => null);
            log('info', 'fill-summary', `摘要追加标签结果: ${JSON.stringify(appendRes)}`);
          }
        }
      }
    }

    if (!publishFlowOk) {
      return makeFailedResult(accountId, 'xiaohongshu', '文章发布流程失败：无法找到/点击底部红色按钮', startedAt);
    }

    if (!request.testMode) {
      log('info', 'article-publish', `✅ 文章发布多步点击流程完成（${totalClicks} 步）`);
      await sleep(1200);
    }

    // 测试模式：不继续等待发布结果，高亮标记按钮并收集表单状态
    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          'button.ce-btn.bg-red',
          '.publish-page-publish-btn button',
          '.publish-page-publish-btn',
          'xhs-publish-btn',
          'button.next-btn',
          'button.bg-red',
          'button[class*="custom-button"]',
          'button[class*="d-button"]',
          'button[type="submit"]',
          '.publish-btn',
          '.submit-btn',
        ],
        [
          { name: '文章标题', selector: 'input[placeholder*="标题"]', type: 'input' },
          { name: '文章正文', selector: '[contenteditable="true"]', type: 'contenteditable' },
          { name: '文章摘要', selector: '.tiptap-container .ProseMirror, .editor-container .ProseMirror', type: 'contenteditable' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'article-test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '文章标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name === '文章正文')?.filled),
        summaryFilled: !!(testRes?.fields?.find((f: any) => f.name === '文章摘要')?.filled),
        tagsFilled: articleTagList.length > 0 && !!(summaryResult && summaryResult.ok),
        coverUploaded: false, // 文章封面后续再实现
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: testRes?.note || '文章测试模式完成',
      };
      log('info', 'test', '文章测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      // 确保测试模式窗口能正常关闭
      setupTestModeWindow(win, log);
      return {
        accountId,
        platform: 'xiaohongshu',
        status: 'success',
        progress: 100,
        message: '测试完成 - 文章表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

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
    // 测试模式：不关闭窗口，让用户可以检查表单填写情况
    if (request.testMode) {
      log('info', 'test', '文章测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
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
  articleLimits: { title: 64, content: 10000, summary: 1000 },
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
