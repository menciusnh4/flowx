import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import {
  sleep,
  makePublishLogger,
  makePublishWindow,
  attachNavigationTracker,
  evalJS,
  makeFailedResult,
  uploadViaCDP,
  waitForUploadComplete,
  buildTestModeProbeScript,
  setupTestModeWindow,
} from './shared';
import { registerPlatform } from './registry';
import type {
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
  ContentType,
} from '../../../types';

/**
 * 今日头条（头条号）平台适配器
 *
 * 平台信息：
 *   - 创作者后台：https://mp.toutiao.com/profile_v4/index
 *   - 登录页：https://mp.toutiao.com/auth/page/login
 *   - 登录态标识：cookie `sessionid` 或 `sid_tt` 存在且非空即为已登录
 *   - 发布入口：
 *     - 微头条（图文短内容）：https://mp.toutiao.com/profile_v4/weitoutiao/publish
 *     - 图文（长文）：https://mp.toutiao.com/profile_v4/graphic/publish
 *     - 视频：通过发布中心
 */

// =====================================================================
// 常量 / 配置
// =====================================================================

const log = makePublishLogger({ platform: 'toutiao' });

// 微头条发布页 URL（图文短内容）
const WEITOUTIAO_PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/weitoutiao/publish';

// 视频发布页 URL（西瓜创作平台，和抖音发布框架同源 xigua-upload-manage）
const XIGUA_VIDEO_PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/xigua/upload-video';

// 视频发布：标题最多 30 字（字节系常规限制：1~30字），简介最多 400 字（实际 textarea 已带 maxlength=400）
const XIGUA_VIDEO_TITLE_LIMIT = 30;
const XIGUA_VIDEO_TITLE_MIN = 5;
const XIGUA_VIDEO_ABSTRACT_LIMIT = 400;

// 微头条字数限制：正文最多 2000 字（含话题标签）
const WEITOUTIAO_CONTENT_LIMIT = 2000;
const WEITOUTIAO_TAG_LIMIT = 10;

// 长文（图文）发布限制
const ARTICLE_TITLE_LIMIT = 30;
const ARTICLE_CONTENT_LIMIT = 50000;

const meta: PlatformMeta = {
  key: 'toutiao',
  name: '今日头条',
  icon: '条',
  platformAccountLabel: '头条号',
  authUrl: 'https://mp.toutiao.com/profile_v4/index',
  publishUrl: WEITOUTIAO_PUBLISH_URL,
  homeUrl: 'https://mp.toutiao.com/profile_v4/index',
  contentTypes: ['article', 'video', 'image'],
  capabilities: {
    publishVideo: true,
    publishImage: true,
    publishArticle: false,
  } as AccountCapabilities,
  contentLimits: {
    title: 30,
    content: WEITOUTIAO_CONTENT_LIMIT, // 微头条(图文)正文最多 2000 字
  },
  // ★ 视频发布的独立限制（前端展示 + 主进程截断）：标题 30，简介/描述 400
  //   之前 UI 把视频正文也展示成 contentLimits.content(2000) 导致「最多2000字」显示错误
  videoLimits: {
    title: XIGUA_VIDEO_TITLE_LIMIT,
    content: XIGUA_VIDEO_ABSTRACT_LIMIT,
  },
  articleLimits: {
    title: ARTICLE_TITLE_LIMIT,
    content: ARTICLE_CONTENT_LIMIT,
  },
  nicknameSelectors: [
    '.nickname',
    '.user-name',
    '.author-name',
    '[class*="nickname"]',
    '[class*="username"]',
    '.sidebar .name',
    '.user-info .name',
    '.author-info .name',
  ],
  avatarSelectors: [
    '.avatar img',
    '.user-avatar img',
    '[class*="avatar"] img',
    'img.avatar',
    '.sidebar img',
    '.author-info img',
  ],
  loginKeywords: ['头条号', '创作中心', '发布', '内容管理', '数据分析', '粉丝', '收益', '退出登录'],
};

// =====================================================================
// 工具函数
// =====================================================================

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '\u2026';
}

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
    if (result.length >= WEITOUTIAO_TAG_LIMIT) break;
  }
  return result;
}

function buildContentText(content: string | undefined, tags: string[] | undefined): string {
  const base = content || '';
  const tagList = prepareTags(tags);
  if (tagList.length === 0) return truncate(base, WEITOUTIAO_CONTENT_LIMIT);
  const tagStr = tagList.join(' ');
  const combined = base.length > 0 ? base + '\n' + tagStr : tagStr;
  return truncate(combined, WEITOUTIAO_CONTENT_LIMIT);
}

// =====================================================================
// 页面脚本构造器
// =====================================================================

/**
 * 生成"填写微头条正文"的脚本（ProseMirror 富文本编辑器）
 *
 * DOM 结构：
 *   - 外层容器：.sg-editor
 *   - 编辑器节点：.sg-editor .ProseMirror
 *   - placeholder："有什么新鲜事想告诉大家？"
 */
function buildFillWeitoutiaoContentScript(content: string): string {
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
    // 查找 ProseMirror 编辑器
    'var pmTarget = null;' +
    'try {' +
    '  var nodes = document.querySelectorAll(\'[contenteditable]\');' +
    '  for (var i = 0; i < nodes.length; i++) {' +
    '    var n = nodes[i];' +
    '    var cls = n.getAttribute ? (n.getAttribute(\'class\') || \'\') : \'\';' +
    '    if (cls.indexOf(\'ProseMirror\') !== -1) { pmTarget = n; break; }' +
    '  }' +
    '} catch(e) {}' +
    // 兜底：找 .sg-editor 下的 contenteditable
    'if (!pmTarget) {' +
    '  try {' +
    '    var sg = document.querySelector(\'.sg-editor\');' +
    '    if (sg) {' +
    '      var eds = sg.querySelectorAll(\'[contenteditable]\');' +
    '      if (eds && eds.length > 0) pmTarget = eds[0];' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    'if (!pmTarget) return { ok: false, reason: \'no-editor-target\' };' +
    // 写入正文：ProseMirror → selectAll → delete → insertText
    'try {' +
    '  pmTarget.focus();' +
    '  try {' +
    '    window.getSelection().removeAllRanges();' +
    '    var range = document.createRange();' +
    '    range.selectNodeContents(pmTarget);' +
    '    window.getSelection().addRange(range);' +
    '    try { document.execCommand(\'delete\'); } catch(e) {}' +
    '    try { document.execCommand(\'insertText\', false, content); } catch(e2) { pmTarget.innerText = content; }' +
    '  } catch(e) {' +
    '    pmTarget.innerText = content;' +
    '  }' +
    '  try { pmTarget.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  moveCursorToEnd(pmTarget);' +
    '  return { ok: true, kind: \'prosemirror\', length: content.length, isContentEditable: true };' +
    '} catch(e) {' +
    '  return { ok: false, reason: String(e && e.message || e) };' +
    '}' +
    '})()'
  );
}

/**
 * 生成"点击工具栏图片按钮"的脚本
 * 按钮：button.syl-toolbar-button，文本包含"图片"
 */
function buildClickImageButtonScript(): string {
  return (
    '(function(){' +
    'var candidates = [];' +
    'try {' +
    '  var buttons = document.querySelectorAll(\'button, [role="button"], div, span\');' +
    '  for (var i = 0; i < buttons.length; i++) {' +
    '    var txt = ((buttons[i].innerText || buttons[i].textContent || \'\').replace(/\\s+/g, \'\').trim());' +
    '    if (!txt || txt.length > 20) continue;' +
    '    var cls = buttons[i].getAttribute ? (buttons[i].getAttribute(\'class\') || \'\') : \'\';' +
    '    var score = 0;' +
    '    if (txt === \'图片\' || txt.indexOf(\'图片\') !== -1) score += 500;' +
    '    if (txt.indexOf(\'上传\') !== -1) score += 100;' +
    '    if (cls.indexOf(\'syl-toolbar\') !== -1) score += 300;' +
    '    if (cls.indexOf(\'toolbar\') !== -1) score += 100;' +
    '    if (score > 0 && buttons[i].offsetWidth >= 10 && buttons[i].offsetHeight >= 10) {' +
    '      candidates.push({ el: buttons[i], score: score, text: txt.slice(0, 40) });' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'if (candidates.length === 0) return { clicked: false, reason: \'no-image-button\' };' +
    'candidates.sort(function(a, b) { return b.score - a.score; });' +
    'var top = candidates[0];' +
    'try { top.el.click(); } catch(e) {}' +
    'try { top.el.dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true })); } catch(e2) {}' +
    'return { clicked: true, text: top.text, score: top.score };' +
    '})()'
  );
}

/**
 * 生成"检测是否有 input[type=file]"的脚本，用于判断上传区域是否已渲染
 */
function buildCheckFileInputScript(): string {
  return (
    '(function(){' +
    'var inputs = [];' +
    'try {' +
    '  var all = document.querySelectorAll(\'input[type="file"]\');' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var inp = all[i];' +
    '    inputs.push({' +
    '      accept: inp.getAttribute ? (inp.getAttribute(\'accept\') || \'\') : \'\',' +
    '      cls: inp.getAttribute ? (inp.getAttribute(\'class\') || \'\') : \'\',' +
    '      multiple: inp.multiple || false,' +
    '      hidden: inp.offsetWidth === 0 || inp.offsetHeight === 0' +
    '    });' +
    '  }' +
    '} catch(e) {}' +
    // 检查 shadow DOM
    'try {' +
    '  function walkShadow(root) {' +
    '    if (!root) return;' +
    '    try {' +
    '      var els = root.querySelectorAll ? root.querySelectorAll(\'*\') : [];' +
    '      for (var j = 0; j < els.length; j++) {' +
    '        try {' +
    '          if (els[j].tagName === \'INPUT\' && els[j].type === \'file\') {' +
    '            inputs.push({' +
    '              accept: els[j].accept || \'\',' +
    '              cls: els[j].className || \'\',' +
    '              multiple: els[j].multiple || false,' +
    '              hidden: els[j].offsetWidth === 0 || els[j].offsetHeight === 0,' +
    '              shadow: true' +
    '            });' +
    '          }' +
    '          if (els[j].shadowRoot) walkShadow(els[j].shadowRoot);' +
    '        } catch(e) {}' +
    '      }' +
    '    } catch(e) {}' +
    '  }' +
    '  walkShadow(document.documentElement);' +
    '} catch(e) {}' +
    'return { count: inputs.length, inputs: inputs };' +
    '})()'
  );
}

/**
 * 生成"点击发布按钮"的脚本
 * 发布按钮：.byte-btn.byte-btn-primary.publish-content，文本"发布"
 */
function buildClickPublishScript(): string {
  return (
    '(function(){' +
    'var patterns = [\'立即发布\', \'发布\', \'确认发布\'];' +
    'var candidates = [];' +
    'try {' +
    '  var nodes = document.querySelectorAll(\'button, a, [role="button"], div, span\');' +
    '  for (var i = 0; i < nodes.length; i++) {' +
    '    var n = nodes[i];' +
    '    var txt = ((n.innerText || n.textContent || \'\').replace(/\\s+/g, \'\').trim());' +
    '    if (!txt || txt.length > 20) continue;' +
    '    for (var k = 0; k < patterns.length; k++) {' +
    '      if (txt === patterns[k] || txt.indexOf(patterns[k]) !== -1) {' +
    '        var cls = n.getAttribute ? (n.getAttribute(\'class\') || \'\') : \'\';' +
    '        var score = (100 - k * 10);' +
    '        if (cls.indexOf(\'publish\') !== -1 || cls.indexOf(\'publish-content\') !== -1) score += 80;' +
    '        if (cls.indexOf(\'primary\') !== -1) score += 50;' +
    '        if (cls.indexOf(\'byte-btn\') !== -1) score += 30;' +
    '        try {' +
    '          if (n.offsetWidth === 0 || n.offsetHeight === 0) score -= 1000;' +
    '          if (n.disabled) score -= 1000;' +
    '        } catch(e) {}' +
    '        candidates.push({ el: n, text: txt.slice(0, 30), score: score });' +
    '        break;' +
    '      }' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'if (candidates.length === 0) return { clicked: false, reason: \'no-button\' };' +
    'candidates.sort(function(a, b) { return b.score - a.score; });' +
    'var target = candidates[0];' +
    'try { target.el.click(); } catch(e) {}' +
    'try { target.el.dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true })); } catch(e) {}' +
    'return { clicked: true, text: target.text, topThree: candidates.slice(0, 3).map(function(c) { return { text: c.text, score: c.score }; }) };' +
    '})()'
  );
}

/**
 * 生成"检测图片上传抽屉状态"的脚本
 * 抽屉结构：
 *   .byte-drawer-wrapper > .mp-ic-img-drawer  (右侧抽屉)
 *     .image-area .image-list > li.pic-select-image-item-wrap  (已上传图片项，含 .success 标记)
 *     .footer .confirm-btns > button[data-e2e="imageUploadConfirm-btn"]  (确定按钮)
 * 返回：
 *   drawerOpen: 抽屉是否渲染
 *   uploadedCount: 已上传且带 success 标记的图片数量
 *   confirmBtn: { exists, disabled, text }
 */
function buildProbeImageDrawerScript(expectedCount: number): string {
  return (
    '(function(){' +
    'var expected = ' + expectedCount + ';' +
    // 1) 定位右侧图片抽屉
    'var drawer = null;' +
    'try {' +
    '  var allDrawers = document.querySelectorAll(\'.byte-drawer-wrapper, .byte-drawer\');' +
    '  for (var i = 0; i < allDrawers.length; i++) {' +
    '    var d = allDrawers[i];' +
    '    var cls = (d.getAttribute ? d.getAttribute(\'class\') || \'\' : \'\');' +
    '    if (cls.indexOf(\'mp-ic-img-drawer\') !== -1 || cls.indexOf(\'ic-img-drawer\') !== -1) { drawer = d; break; }' +
    '  }' +
    '  if (!drawer) { drawer = document.querySelector(\'.mp-ic-img-drawer\') || document.querySelector(\'[class*="ic-img-drawer"]\'); }' +
    '} catch(e) {}' +
    'if (!drawer) return { drawerOpen: false, uploadedCount: 0, confirmBtn: { exists: false } };' +
    // 2) 检查可见性
    'var visible = true;' +
    'try {' +
    '  var rect = drawer.getBoundingClientRect();' +
    '  if (rect.width === 0 && rect.height === 0) visible = false;' +
    '  var st = window.getComputedStyle ? window.getComputedStyle(drawer) : null;' +
    '  if (st && (st.display === \'none\' || st.visibility === \'hidden\')) visible = false;' +
    '} catch(e) {}' +
    // 3) 统计已上传成功的图片数量
    'var uploaded = 0;' +
    'var totalItems = 0;' +
    'try {' +
    '  var items = drawer.querySelectorAll(\'li.pic-select-image-item-wrap, .image-list li, [class*="pic-select"] [class*="image-item"]\');' +
    '  totalItems = items.length;' +
    '  for (var j = 0; j < items.length; j++) {' +
    '    var it = items[j];' +
    '    var itCls = (it.getAttribute ? it.getAttribute(\'class\') || \'\' : \'\');' +
    '    var hasSuccess = itCls.indexOf(\'success\') !== -1 || !!it.querySelector(\'.success\');' +
    '    if (hasSuccess) uploaded++;' +
    '  }' +
    '} catch(e) {}' +
    // 4) 检查「确定」按钮
    'var confirm = { exists: false, disabled: true, text: \'\' };' +
    'try {' +
    '  var confirmBtn = drawer.querySelector(\'button[data-e2e="imageUploadConfirm-btn"]\');' +
    '  if (!confirmBtn) confirmBtn = drawer.querySelector(\'.confirm-btns .byte-btn-primary\');' +
    '  if (!confirmBtn) {' +
    '    var fbtns = drawer.querySelectorAll(\'button\');' +
    '    for (var k = 0; k < fbtns.length; k++) {' +
    '      var bText = ((fbtns[k].innerText || fbtns[k].textContent || \'\').replace(/\\s+/g, \'\').trim());' +
    '      if (bText === \'确定\' || bText === \'确认\') { confirmBtn = fbtns[k]; break; }' +
    '    }' +
    '  }' +
    '  if (confirmBtn) {' +
    '    confirm.exists = true;' +
    '    confirm.disabled = !!(confirmBtn.disabled || confirmBtn.getAttribute(\'disabled\') !== null || confirmBtn.getAttribute(\'aria-disabled\') === \'true\');' +
    '    confirm.text = (confirmBtn.innerText || confirmBtn.textContent || \'\').replace(/\\s+/g, \' \').trim().slice(0, 20);' +
    '  }' +
    '} catch(e) {}' +
    'return {' +
    '  drawerOpen: visible,' +
    '  visible: visible,' +
    '  uploadedCount: uploaded,' +
    '  totalItems: totalItems,' +
    '  expectedCount: expected,' +
    '  allUploaded: uploaded >= expected,' +
    '  confirmBtn: confirm' +
    '};' +
    '})()'
  );
}

/**
 * 生成「在图片上传抽屉内移除多余已上传项」的脚本（严格保留最新的 expected 张，其余全部删掉）
 * 🔧 场景：用户只上传了 1 张，但抽屉里 uploadedCount=2（草稿回显残留了一张老图）→ 导致点确定插入 2 张
 * ⚠️ 安全原则：绝对不能手动 removeChild 破坏 Vue/React 内部 DOM（会导致 footer 的确定按钮一起被卸载消失）
 *    只能点击每个 li 内的 .image-item-remove 图标，让平台组件自己的逻辑删除
 * 🧠 保留策略：只处理带 .success 标记的已完成上传项（不含 loading 中），保留最后（最新）expected 个，其余通过点 X 图标删除
 *    选择器严格限定：只匹配 li.pic-select-image-item-wrap（用户真实 DOM 里的精确类名）
 * 返回：{ drawerFound, beforeCount, successCount, removed, skipped, afterCount, errors:[...] }
 */
function buildRemoveExtraDrawerImagesScript(expectedCount: number): string {
  const expected = Math.max(1, Number(expectedCount) || 1);
  // 用 TS 字符串拼接，避免模板字符串里正则反斜杠导致 JS SyntaxError
  var s = '';
  s += '(function(){';
  s += 'try{';
  s += 'var res={drawerFound:false,beforeCount:0,successCount:0,removed:0,skipped:0,afterCount:0,expected:' + expected + ',errors:[]};';
  s += 'var drawer=null;';
  s += 'try{';
  s += 'var ads=document.querySelectorAll(\'.byte-drawer-wrapper, .byte-drawer\');';
  s += 'for(var di=0;di<ads.length;di=di+1){';
  s += 'var d=ads[di];';
  s += 'var cls=d.getAttribute?String(d.getAttribute(\'class\')||\'\'):\'\';';
  s += 'if(cls.indexOf(\'mp-ic-img-drawer\')>=0||cls.indexOf(\'ic-img-drawer\')>=0){drawer=d;break;}';
  s += '}';
  s += 'if(!drawer){drawer=document.querySelector(\'.mp-ic-img-drawer\')||document.querySelector(\'[class*="ic-img-drawer"]\');}';
  s += '}catch(e1){drawer=null;}';
  s += 'if(!drawer){return res;}';
  s += 'res.drawerFound=true;';
  s += 'try{';
  // ↓↓↓ 关键1：严格只用 li.pic-select-image-item-wrap，去掉宽泛的 .image-list li / [class*="image-item"] 避免匹配到 footer 元素
  s += 'var items=drawer.querySelectorAll(\'li.pic-select-image-item-wrap\');';
  s += 'res.beforeCount=items.length;';
  // 过滤出带 .success 的项（只有已完成上传的才算，loading/占位的不要删）
  s += 'var successItems=[];';
  s += 'for(var fi=0;fi<items.length;fi=fi+1){';
  s += 'var fit=items[fi];';
  s += 'var fcls=fit&&fit.getAttribute?String(fit.getAttribute(\'class\')||\'\'):\'\';';
  s += 'var hasSuccess=fcls.indexOf(\'success\')>=0||!!(fit&&fit.querySelector&&fit.querySelector(\'.success\'));';
  s += 'if(hasSuccess){successItems.push(fit);}';
  s += '}';
  s += 'res.successCount=successItems.length;';
  // 已完成上传的数量 <= expected，直接跳过不用清理
  s += 'if(successItems.length<=' + expected + '){';
  s += 'res.skipped=1;res.afterCount=items.length;return res;';
  s += '}';
  // 需要删除的：successItems[0 .. length-expected-1]，保留最后 expected 个（倒序最后面的 = 最新上传的）
  s += 'var removeCount=successItems.length-' + expected + ';';
  s += 'for(var rk=0;rk<removeCount;rk=rk+1){';
  s += 'try{';
  s += 'var it=successItems[rk];';
  // ↓↓↓ 关键2：只点 .image-item-remove 图标，完整事件链。找不到就算了，绝不能 removeChild 破坏组件 DOM
  s += 'var rm=it.querySelector(\'.image-item-remove, [class*="-remove"], [class*="-close"]\');';
  s += 'if(!rm){rm=it.querySelector(\'i\');}';
  s += 'var done=0;';
  s += 'if(rm){';
  s += 'try{if(typeof rm.focus===\'function\'){rm.focus();}}catch(x1){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(\'mouseover\',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x2){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(\'mousemove\',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x3){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(\'mousedown\',{bubbles:true,cancelable:true,view:window,button:0,buttons:1}));}catch(x4){}';
  s += 'try{if(typeof rm.click===\'function\'){rm.click();done=1;}}catch(x5){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(\'mouseup\',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x6){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(\'click\',{bubbles:true,cancelable:true,view:window,button:0}));done=1;}catch(x7){}';
  s += '}';
  // ⚠️ 关键安全：去掉 removeChild 兜底！破坏组件 DOM 会导致确定按钮消失，宁可不删也不硬删
  s += 'if(done){res.removed=res.removed+1;}else{res.errors.push(\'noRmBtn:\'+rk);}';
  s += '}catch(itemErr){res.errors.push(\'it\'+rk+\':\'+String(itemErr&&itemErr.message||itemErr).slice(0,80));}';
  s += '}';
  s += 'try{var itemsAfter=drawer.querySelectorAll(\'li.pic-select-image-item-wrap\');res.afterCount=itemsAfter.length;}catch(ae){}';
  s += '}catch(big){res.errors.push(\'main:\'+String(big&&big.message||big).slice(0,150));}';
  s += 'return res;';
  s += '}catch(fatal){';
  s += 'return{drawerFound:false,beforeCount:-1,successCount:-1,removed:0,skipped:0,afterCount:-1,expected:' + expected + ',';
  s += 'fatal:String(fatal&&fatal.message?(fatal.name+\':\'+fatal.message):fatal).slice(0,200),errors:[]};';
  s += '}';
  s += '})();';
  return s;
}

/**
 * 生成"在图片上传抽屉内点击确定按钮"的脚本
 * 严格限定点击作用域在图片抽屉内，避免暴力点击全页面
 */
function buildClickImageDrawerConfirmScript(): string {
  return (
    '(function(){' +
    // 1) 精确定位图片抽屉（按 z-index / 可见性取最上层）
    'var drawer = null;' +
    'var candidates = [];' +
    'try {' +
    '  var all = document.querySelectorAll(\'.byte-drawer-wrapper, .byte-drawer, [class*="ic-img-drawer"]\');' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var d = all[i];' +
    '    try {' +
    '      var cls = (d.getAttribute ? d.getAttribute(\'class\') || \'\' : \'\');' +
    '      if (cls.indexOf(\'mp-ic-img-drawer\') === -1 && cls.indexOf(\'ic-img-drawer\') === -1) continue;' +
    '      var rect = d.getBoundingClientRect();' +
    '      if (rect.width <= 0 || rect.height <= 0) continue;' +
    '      var zi = parseInt(window.getComputedStyle ? window.getComputedStyle(d).zIndex : \'0\', 10) || 0;' +
    '      candidates.push({ el: d, zi: zi, cls: cls });' +
    '    } catch(e) {}' +
    '  }' +
    '} catch(e) {}' +
    'if (candidates.length === 0) return { clicked: false, reason: \'no-drawer\' };' +
    'candidates.sort(function(a, b) { return b.zi - a.zi; });' +
    'drawer = candidates[0].el;' +
    // 2) 在抽屉内找确定按钮：优先 data-e2e，其次 primary+确定文本
    'var btn = null;' +
    'var matchInfo = \'\';' +
    'try { btn = drawer.querySelector(\'button[data-e2e="imageUploadConfirm-btn"]\'); if (btn) matchInfo = \'data-e2e\'; } catch(e) {}' +
    'if (!btn) try { btn = drawer.querySelector(\'.confirm-btns .byte-btn-primary\'); if (btn) matchInfo = \'confirm-btns primary\'; } catch(e) {}' +
    'if (!btn) {' +
    '  try {' +
    '    var allBtns = drawer.querySelectorAll(\'button, [role="button"]\');' +
    '    for (var j = 0; j < allBtns.length; j++) {' +
    '      var t = ((allBtns[j].innerText || allBtns[j].textContent || \'\').replace(/\\s+/g, \'\').trim());' +
    '      if (t === \'确定\' || t === \'确认\') { btn = allBtns[j]; matchInfo = \'text:\' + t; break; }' +
    '    }' +
    '  } catch(e) {}' +
    '}' +
    'if (!btn) return { clicked: false, reason: \'no-confirm-btn-in-drawer\', drawerClass: candidates[0].cls };' +
    // 3) 先检查 disabled
    'var isDisabled = !!(btn.disabled || btn.getAttribute(\'disabled\') !== null || btn.getAttribute(\'aria-disabled\') === \'true\');' +
    'if (isDisabled) return { clicked: false, reason: \'confirm-btn-disabled\', btnText: (btn.innerText || \'\').trim() };' +
    // 4) 可靠点击：原生 click + MouseEvent 组合（与发布按钮策略一致）
    'try { btn.click(); } catch(e) {}' +
    'try { btn.dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true, view: window })); } catch(e2) {}' +
    'var btnText = (btn.innerText || btn.textContent || \'\').replace(/\\s+/g, \' \').trim().slice(0, 20);' +
    'return { clicked: true, match: matchInfo, text: btnText, drawerClass: candidates[0].cls };' +
    '})()'
  );
}

/**
 * 生成"检测图片是否已插入编辑器"的脚本（作为点击确定后的兜底校验）
 * 检查 ProseMirror 编辑器内是否出现 <img> 标签
 */
function buildCheckImageInEditorScript(): string {
  return (
    '(function(){' +
    'try {' +
    '  var pm = document.querySelector(\'.sg-editor .ProseMirror\') || document.querySelector(\'[contenteditable].ProseMirror\');' +
    '  if (!pm) return { editorFound: false, imageCount: 0 };' +
    '  var imgs = pm.querySelectorAll(\'img\');' +
    '  return { editorFound: true, imageCount: imgs.length, imgs: Array.prototype.slice.call(imgs).map(function(i){return (i.getAttribute(\'src\')||\'\').slice(0,80);}) };' +
    '} catch(e) { return { error: String(e && e.message || e) }; }' +
    '})()'
  );
}

// =====================================================================
// 构建撤销草稿回显的最小化可执行 JS 脚本
// 用户真实 DOM 参考：
//   html > body > div > div.byte-message-wrapper.byte-message-wrapper-top
//     > div.message-slideDown-exit... > div.byte-message.byte-message-info
//       > svg + span > 已恢复上次编辑未保存的内容 + <span class="wtt-publish-message-opr">撤销</span>
// 🔑 设计原则：尽量减少语法复杂度，避免 SyntaxError
//   - 全部使用普通 var/if/for，不使用解构/展开/箭头/可选链
//   - 所有表达式用分号显式结束
//   - 中文注释放在 TS 侧，脚本内只保留英文注释
// 返回对象结构（永远返回对象，防止 catch null 误判）：
//   { undoBtnFound, undoBtnClicked, msgFound, messageText,
//     diag: { cWtt, cWrapper, cByteMsg, cTop, cSpan, bTip, bSave, bUndo, firstUndoTxt, topWrapTxt, firstUndoCls, topWrapCls },
//     fatal: string|null }
// =====================================================================
function buildDismissRestoreTipScript(): string {
  const nowTms = Date.now();
  return `(function(){try{var res={undoBtnFound:false,undoBtnClicked:false,msgFound:false,messageText:'',diag:{cWtt:0,cWrapper:0,cByteMsg:0,cTop:0,cSpan:0,bTip:0,bSave:0,bUndo:0,firstUndoTxt:'',topWrapTxt:'',firstUndoCls:'',topWrapCls:'',tms:${nowTms}},fatal:null};var q1;var q2;var q3;var q4;var bodyTxt;var i;var q;var item;var txt;var n;var cls;var up;var upTxt;var undoBtn=null;var msgText='';try{q1=document.querySelectorAll('.wtt-publish-message-opr');q2=document.querySelectorAll('.byte-message-wrapper');q3=document.querySelectorAll('.byte-message');q4=document.querySelectorAll('.byte-message-wrapper-top');res.diag.cWtt=q1.length;res.diag.cWrapper=q2.length;res.diag.cByteMsg=q3.length;res.diag.cTop=q4.length;res.diag.cSpan=document.getElementsByTagName('span').length;bodyTxt='';if(document.body&&document.body.innerText){bodyTxt=String(document.body.innerText||'').replace(/\\s+/g,' ');}if(bodyTxt.indexOf('恢复上次编辑')>=0){res.diag.bTip=1;}if(bodyTxt.indexOf('未保存的内容')>=0){res.diag.bSave=1;}if(bodyTxt.indexOf('撤销')>=0){res.diag.bUndo=1;}if(q1.length>0){item=q1[0];res.diag.firstUndoTxt=String(item.innerText||item.textContent||'').replace(/\\s+/g,' ').slice(0,30);res.diag.firstUndoCls=String(item.className||'').slice(0,100);}if(q4.length>0){item=q4[0];res.diag.topWrapTxt=String(item.innerText||item.textContent||'').replace(/\\s+/g,' ').slice(0,200);res.diag.topWrapCls=String(item.className||'').slice(0,150);}}catch(de){res.diag.err=String(de&&de.message?de.name+':'+de.message:de).slice(0,200);}try{q=document.querySelectorAll('span.wtt-publish-message-opr, .wtt-publish-message-opr');for(i=0;i<q.length;i++){n=q[i];txt=String(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim();if(txt==='撤销'){undoBtn=n;break;}}}catch(e1){undoBtn=null;}if(!undoBtn){try{q=document.querySelectorAll('span, a, button');for(i=0;i<q.length;i++){n=q[i];txt=String(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim();if(txt!=='撤销'){continue;}up=n.parentElement||n.parentNode;upTxt='';try{if(up){upTxt=String(up.innerText||up.textContent||'').replace(/\\s+/g,' ');}}catch(e2){upTxt='';}if(upTxt.indexOf('恢复上次编辑')>=0||upTxt.indexOf('未保存的内容')>=0){undoBtn=n;break;}}}catch(e3){undoBtn=null;}}if(undoBtn){res.undoBtnFound=true;}try{q=document.querySelectorAll('.byte-message-wrapper .byte-message, .byte-message-wrapper, .byte-message, .byte-message-wrapper-top');for(i=0;i<q.length;i++){n=q[i];txt=String(n.innerText||n.textContent||'').replace(/\\s+/g,' ').trim();if(txt.indexOf('恢复上次编辑')>=0||txt.indexOf('未保存的内容')>=0){res.msgFound=true;msgText=txt.slice(0,200);break;}}}catch(e4){res.msgFound=res.msgFound;}if(!res.msgFound&&res.undoBtnFound&&undoBtn){try{up=null;if(typeof undoBtn.closest==='function'){up=undoBtn.closest('div, section, span, article');}if(!up){up=undoBtn.parentElement;if(up&&up.parentElement){up=up.parentElement;}}if(up){upTxt=String(up.innerText||'').replace(/\\s+/g,' ');if(upTxt.indexOf('恢复')>=0||upTxt.indexOf('未保存')>=0){res.msgFound=true;msgText=upTxt.slice(0,200);}}}catch(e5){res.msgFound=res.msgFound;}}res.messageText=msgText;if(undoBtn){var optsBase={bubbles:true,cancelable:true,view:window};try{res.undoBtnText=String(undoBtn.innerText||undoBtn.textContent||'').trim().slice(0,10);}catch(e6){res.undoBtnText='';}try{if(typeof undoBtn.focus==='function'){undoBtn.focus();}}catch(e7){}try{undoBtn.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window,button:0}));}catch(e8){}try{undoBtn.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,view:window,button:0}));}catch(e9){}try{undoBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window,button:0,buttons:1}));}catch(e10){}try{if(typeof undoBtn.click==='function'){undoBtn.click();res.undoBtnClicked=true;}}catch(e11){}try{undoBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window,button:0}));}catch(e12){}try{undoBtn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));res.undoBtnClicked=true;}catch(e13){}return res;}return res;}catch(fatal){return{undoBtnFound:false,undoBtnClicked:false,msgFound:false,messageText:'',diag:{},fatal:String(fatal&&fatal.message?(fatal.name+':'+fatal.message):fatal).slice(0,300)};}})();`;
}

// =====================================================================
// 进入表单时清空上次残留的已上传图片（草稿回显导致图片会追加）
// 🔑 处理 3 类残留：
//   1. 正文编辑器 ProseMirror 里已插入的 <img> 节点
//   2. 编辑器外「图文预览缩略图列表」(带删除/移除图标的 li.pic-select-image-item-wrap / 或 .thumb / 或 .publish-content 下的 img wrapper)
//   3. 若图片上传抽屉当前开着，直接点抽屉里每个 li 的 .image-item-remove 移除
// 返回：
//   { editorImgsRemoved, drawerImgsRemoved, listImgsRemoved, totalRemoved }
// =====================================================================
// =====================================================================
// 构建"清空上次残留图片"的最小化安全版脚本（min-safe）
// 🔑 说明：上一版本存在 SyntaxError 风险（全字符串拼接+注释/三元嵌套），本版：
//   - 单模板字符串一次性拼完，所有中文说明在 TS 侧注释
// =====================================================================
// 生成「上传图片预览区（div.upload-list）重复图去重」脚本
// 🔧 场景：点击抽屉"确定"后，div.upload-list > div.img-box-item 出现 2 个完全相同的 img-box-item（URL 完全一致）= 重复插入
// 🔧 用户提供的 DOM 结构：
//     div.upload-list
//       div.img-box-item            ← 同 URL 第 1 张（保留）
//         span.item  [background-image: url("...")]
//         i.image-remove-btn       ← 点这个删除（<i class="image-remove-btn">&nbsp;</i>）
//       div.img-box-item .ml6       ← 同 URL 第 2 张（重复，点 X 删除）
//         span.item.ml6  [background-image: url("...")]   ← URL 完全相同
//         i.image-remove-btn
//       div.upload-handler.ml6      ← 添加按钮（不动它）
//         span.upl-btn.image-add-btn
// ⚠️ 安全原则：只点击 .image-remove-btn，绝不 removeChild / 修改 DOM，避免破坏 Vue 内部结构
// 🧠 去重策略：以 background-image URL 为 key，同 URL 只保留 1 张（第 1 张），其余点 X 图标删除
//             同时严格限制处理范围：只匹配 div.upload-list 下的 div.img-box-item（不会碰到 + 按钮）
// 返回：{ listFound, beforeCount, removed, skipped, afterCount, errors:[...] }
// =====================================================================
function buildDedupeUploadListScript(): string {
  var q = '\'';
  var s = '';
  s += '(function(){';
  s += 'try{';
  s += 'var res={listFound:false,beforeCount:0,removed:0,skipped:0,afterCount:0,errors:[]};';
  // 定位 div.upload-list（多个也兼容）
  s += 'var lists=document.querySelectorAll(' + q + 'div.upload-list' + q + ');';
  s += 'if(!lists||lists.length===0){return res;}';
  s += 'res.listFound=true;';
  s += 'for(var li=0;li<lists.length;li=li+1){';
  s += 'try{';
  s += 'var list=lists[li];';
  // 只处理 div.img-box-item（严格 div + class，不会匹配 upload-handler）
  s += 'var items=list.querySelectorAll(' + q + 'div.img-box-item' + q + ');';
  s += 'res.beforeCount=res.beforeCount+items.length;';
  s += 'var seen={};';
  s += 'for(var ii=0;ii<items.length;ii=ii+1){';
  s += 'try{';
  s += 'var it=items[ii];';
  // 先找带 background-image 的 span.item
  s += 'var spanItem=it.querySelector(' + q + 'span.item, .item' + q + ');';
  s += 'if(!spanItem){continue;}';
  // 从 style.backgroundImage 里抽出 URL，兼容 url("...") 和 url('...') 和 url(...)
  s += 'var bg=(spanItem&&spanItem.style?String(spanItem.style.backgroundImage||' + q + q + '):' + q + q + ')||' + q + q + ';';
  s += 'var urlKey=' + q + q + ';';
  s += 'try{';
  s += 'var m0=bg.match(/url\\([\'"]?([^\'"]*)[\'"]?\\)/);';
  s += 'urlKey=m0&&m0[1]?String(m0[1]):bg;';
  s += 'urlKey=urlKey.split(' + q + '?' + q + ')[0];'; // 去掉签名等 query 后再做 key（避免不同 expires 判定为不同）
  s += '}catch(mex){urlKey=bg;}';
  s += 'if(!urlKey||urlKey.length<20){continue;}'; // 没拿到 URL 就跳过
  s += 'if(seen[urlKey]){';
  // 已见过这个 URL → 重复项，点 .image-remove-btn 删除
  s += 'var rm=it.querySelector(' + q + 'i.image-remove-btn, .image-remove-btn, [class*="remove-btn"]' + q + ');';
  s += 'var done=0;';
  s += 'if(rm){';
  s += 'try{if(typeof rm.focus===' + q + 'function' + q + '){rm.focus();}}catch(x1){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mouseover' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x2){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mousemove' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x3){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mousedown' + q + ',{bubbles:true,cancelable:true,view:window,button:0,buttons:1}));}catch(x4){}';
  s += 'try{if(typeof rm.click===' + q + 'function' + q + '){rm.click();done=1;}}catch(x5){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mouseup' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x6){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'click' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));done=1;}catch(x7){}';
  s += '}';
  s += 'if(done){res.removed=res.removed+1;}else{res.errors.push(' + q + 'noRmBtn:II_' + q + '+ii+' + q + ':URL_' + q + '+urlKey.slice(0,40));}';
  s += '}else{';
  // 第一次见 → 登记，保留不删
  s += 'seen[urlKey]=1;res.skipped=res.skipped+1;';
  s += '}';
  s += '}catch(itErr){res.errors.push(' + q + 'it_' + q + '+li+' + q + '_' + q + '+ii+' + q + ':' + q + '+String(itErr&&itErr.message||itErr).slice(0,80));}';
  s += '}';
  s += 'try{var itemsAfter=list.querySelectorAll(' + q + 'div.img-box-item' + q + ');res.afterCount=res.afterCount+itemsAfter.length;}catch(ae){}';
  s += '}catch(listErr){res.errors.push(' + q + 'list:' + q + '+String(listErr&&listErr.message||listErr).slice(0,120));}';
  s += '}';
  s += 'return res;';
  s += '}catch(fatal){';
  s += 'return{listFound:false,beforeCount:-1,removed:0,skipped:0,afterCount:-1,';
  s += 'fatal:String(fatal&&fatal.message?(fatal.name+' + q + ':' + q + '+fatal.message):fatal).slice(0,200),errors:[]};';
  s += '}';
  s += '})();';
  return s;
}

// =====================================================================
//   - 永远返回对象，fatal 字段返回语法/运行时错误
// 返回：
//   { editorImgsRemoved, drawerImgsRemoved, listImgsRemoved, totalRemoved:number, fatal }
// =====================================================================
function buildClearDanglingImagesScript(): string {
  // 🔑 极简安全版：去掉正则/反斜杠
  var q = '\'';
  var s = '';
  s += '(function(){';
  s += 'try{';
  s += 'var res={editorImgsRemoved:0,drawerImgsRemoved:0,listImgsRemoved:0,totalRemoved:0,fatal:null};';
  // ---- Part 1: 编辑器 ProseMirror 内的残留 img / figure（不碰文本，不碰正则）----
  s += 'var eds;var i;var pm;var imgs;var ii;var figs;var fi;';
  s += 'try{eds=document.querySelectorAll(' + q + '.sg-editor .ProseMirror, [contenteditable].ProseMirror' + q + ');}catch(e1){eds=[];}';
  s += 'for(i=0;i<eds.length;i=i+1){try{pm=eds[i];';
  s += 'imgs=pm.querySelectorAll(' + q + 'img' + q + ');res.editorImgsRemoved=res.editorImgsRemoved+imgs.length;';
  s += 'for(ii=imgs.length-1;ii>=0;ii=ii-1){try{if(imgs[ii]&&imgs[ii].parentNode){imgs[ii].parentNode.removeChild(imgs[ii]);}}catch(e2){}}';
  s += 'figs=pm.querySelectorAll(' + q + 'figure, [class*="image-wrapper"], [class*="img-wrapper"], [class*="media-wrapper"]' + q + ');';
  s += 'for(fi=figs.length-1;fi>=0;fi=fi-1){try{if(figs[fi]&&figs[fi].parentNode){figs[fi].parentNode.removeChild(figs[fi]);res.editorImgsRemoved=res.editorImgsRemoved+1;}}catch(e4){}}}catch(e5){}';
  s += '}';
  // ---- Part 2: 图片抽屉当前开着的情况 → 仅点 X 图标，绝不 removeChild（避免破坏 Vue DOM 导致确定按钮消失）----
  s += 'try{var drawer=document.querySelector(' + q + '.mp-ic-img-drawer' + q + ');';
  s += 'if(!drawer){drawer=document.querySelector(' + q + '[class*="ic-img-drawer"]' + q + ');}';
  s += 'if(drawer){var lis=drawer.querySelectorAll(' + q + 'li.pic-select-image-item-wrap' + q + ');';
  s += 'for(var li1=lis.length-1;li1>=0;li1=li1-1){try{var item=lis[li1];';
  s += 'var rm=item.querySelector(' + q + '.image-item-remove, [class*="-remove"], [class*="-close"]' + q + ');';
  s += 'if(!rm){rm=item.querySelector(' + q + 'i' + q + ');}';
  s += 'var ok=0;';
  s += 'if(rm){try{if(typeof rm.focus===' + q + 'function' + q + '){rm.focus();}}catch(x1){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mouseover' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x2){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mousemove' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x3){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mousedown' + q + ',{bubbles:true,cancelable:true,view:window,button:0,buttons:1}));}catch(x4){}';
  s += 'try{if(typeof rm.click===' + q + 'function' + q + '){rm.click();ok=1;}}catch(x5){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'mouseup' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));}catch(x6){}';
  s += 'try{rm.dispatchEvent(new MouseEvent(' + q + 'click' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));ok=1;}catch(x7){}';
  s += '}if(ok){res.drawerImgsRemoved=res.drawerImgsRemoved+1;}}catch(e6){}}}catch(e7){}';
  // ---- Part 3: 全局缩略图 / 预览列表残留（抽屉外的独立预览区）→ 仅点 X，不点不到就算了 ----
  s += 'try{var listSel=[';
  s += q + '.publish-content li.pic-select-image-item-wrap' + q + ',';
  s += q + '.pgc-ic-image-tab-scope li.pic-select-image-item-wrap' + q + ',';
  s += q + '.image-area li.pic-select-image-item-wrap' + q + ',';
  s += q + '.upload-image-wrapper .image-item' + q + ',';
  s += q + '.thumb-list [class*="image-item"]' + q + '';
  s += '].join(' + q + ',' + q + ');';
  s += 'var listItems=document.querySelectorAll(listSel);';
  s += 'for(var xi=listItems.length-1;xi>=0;xi=xi-1){try{var xit=listItems[xi];';
  s += 'var xrm=xit.querySelector(' + q + '.image-item-remove, [class*="icon-close"], [class*="icon-remove"]' + q + ');';
  s += 'if(!xrm){xrm=xit.querySelector(' + q + '[class*="-remove"], [class*="-close"], button, i' + q + ');}';
  s += 'var xclicked=0;';
  s += 'if(xrm){try{if(typeof xrm.click===' + q + 'function' + q + '){xrm.click();xclicked=1;}}catch(xc1){}';
  s += 'try{xrm.dispatchEvent(new MouseEvent(' + q + 'click' + q + ',{bubbles:true,cancelable:true,view:window,button:0}));xclicked=1;}catch(xc2){}';
  s += '}if(xclicked){res.listImgsRemoved=res.listImgsRemoved+1;}}catch(e8){}}catch(e9){}';
  s += 'res.totalRemoved=res.editorImgsRemoved+res.drawerImgsRemoved+res.listImgsRemoved;';
  s += 'return res;';
  s += '}catch(fatal){';
  s += 'return{editorImgsRemoved:0,drawerImgsRemoved:0,listImgsRemoved:0,totalRemoved:0,';
  s += 'fatal:String(fatal&&fatal.message?(fatal.name+' + q + ':' + q + '+fatal.message):fatal).slice(0,300)};';
  s += '}';
  s += '})();';
  return s;
}

// =====================================================================
// 话题（#推荐话题）相关脚本构造器
// 🔑 2026-08-04 根据用户提供真实 DOM 结构重写：
//   <div class="tweet-link-selector-wrap">
//     <section class="mention-selector-modal forum" style="position:absolute; transform: translate(...);">
//       <div class="word-tips">敲空格可取消插入话题</div>
//       <div class="forum-list-content">
//         <section class="forum-list-item">                ← 第一项（直接 querySelectorAll 就能取到）
//           <div>#<span class="forum-list-item-text">硅谷</span>#</div>
//           <div>1,391<span>讨论</span></div>
//         </section>
//       </div>
//     </section>
//   </div>
// =====================================================================

/**
 * 生成"检测话题推荐下拉框是否已出现+第一项是否就绪"的脚本
 * 🔑 最高优先级：用精确类名命中；找不到才退回通用评分
 * 🔑 2026-08-04 增加 diag 字段：无论是否命中，都把精确类名节点信息 dump 出来方便定位
 */
function buildProbeTopicSuggestionScript(tagName: string): string {
  const tagJSON = JSON.stringify(tagName);
  return (
    '(function(){' +
    'var tagName = ' + tagJSON + ' || \'\';' +
    'var tagLower = tagName.toLowerCase();' +
    // ========= 0) 诊断：先把所有精确类名节点的状态 dump =========
    'var diag = {};' +
    'try {' +
    '  diag.wrapCount = document.querySelectorAll(\'.tweet-link-selector-wrap\').length;' +
    '  diag.wrapNodes = Array.prototype.slice.call(document.querySelectorAll(\'.tweet-link-selector-wrap\')).slice(0,5).map(function(n){ var r=n.getBoundingClientRect(); return { cls: (n.className||\'\').toString().slice(0,120), txt: (n.innerText||\'\').replace(/\\s+/g,\' \').slice(0,180), w: Math.round(r.width), h: Math.round(r.height), visible: (n.offsetWidth>10&&n.offsetHeight>10)?1:0 }; });' +
    '  diag.modalCount = document.querySelectorAll(\'.mention-selector-modal\').length;' +
    '  diag.modalNodes = Array.prototype.slice.call(document.querySelectorAll(\'.mention-selector-modal\')).slice(0,5).map(function(n){ var r=n.getBoundingClientRect(); return { cls: (n.className||\'\').toString().slice(0,120), txt: (n.innerText||\'\').replace(/\\s+/g,\' \').slice(0,180), w: Math.round(r.width), h: Math.round(r.height), visible: (n.offsetWidth>10&&n.offsetHeight>10)?1:0 }; });' +
    '  diag.forumItemCount = document.querySelectorAll(\'.forum-list-item\').length;' +
    '  diag.forumItems = Array.prototype.slice.call(document.querySelectorAll(\'.forum-list-item\')).slice(0,5).map(function(n){ var r=n.getBoundingClientRect(); return { cls: (n.className||\'\').toString().slice(0,120), txt: (n.innerText||\'\').replace(/\\s+/g,\' \').slice(0,120), w: Math.round(r.width), h: Math.round(r.height), visible: (n.offsetWidth>5&&n.offsetHeight>5)?1:0 }; });' +
    '  diag.wordTipsCount = document.querySelectorAll(\'.word-tips\').length;' +
    '  diag.forumListContentCount = document.querySelectorAll(\'.forum-list-content\').length;' +
    '  try { var s = window.getSelection(); diag.anchorNodeName = s && s.anchorNode ? s.anchorNode.nodeName : \'NO_SEL\'; diag.anchorParentClass = s && s.anchorNode && s.anchorNode.parentNode ? (s.anchorNode.parentNode.className||\'\').toString().slice(0,100) : \'NO_SEL\'; diag.rangeCount = s ? s.rangeCount : -1; } catch(e) { diag.selErr = String(e); }' +
    '  var bodyText = \'\'; try { bodyText = (document.body ? (document.body.innerText || \'\') : \'\').replace(/\\s+/g, \' \'); } catch(e) {}' +
    '  diag.bodyHasTipText = bodyText.indexOf(\'敲空格可取消插入话题\') !== -1 ? 1 : 0;' +
    '  diag.bodyHasDiscussText = bodyText.indexOf(\'讨论\') !== -1 ? 1 : 0;' +
    '  diag.bodyLast500 = bodyText.slice(-500);' +
    '} catch(e) { diag.error = String(e && e.message || e); }' +
    // ========= 1) 最高优先级：精确类名全局查找 =========
    'var panel = null;' +
    'var panelText = \'\';' +
    'var matchKind = \'\';' +
    'try {' +
    '  var wrap = document.querySelector(\'.tweet-link-selector-wrap\');' +
    '  if (wrap) { var st = window.getComputedStyle ? window.getComputedStyle(wrap) : null; if (!st || (st.display !== \'none\' && st.visibility !== \'hidden\')) { var rect = wrap.getBoundingClientRect(); if (rect.width > 50 && rect.height > 20) { panel = wrap; matchKind = \'tweet-link-selector-wrap\'; } } }' +
    '  if (!panel) { var modal = document.querySelector(\'.mention-selector-modal.forum\'); if (modal) { var r2 = modal.getBoundingClientRect(); if (r2.width > 50 && r2.height > 20) { panel = modal; matchKind = \'mention-selector-modal.forum\'; } } }' +
    '  if (!panel) { var lc = document.querySelector(\'.forum-list-content\'); if (lc && lc.parentElement) { var r3 = lc.parentElement.getBoundingClientRect(); if (r3.width > 50 && r3.height > 20) { panel = lc.parentElement; matchKind = \'forum-list-content.parent\'; } } }' +
    '  if (!panel) { var wt = document.querySelector(\'.word-tips\'); if (wt && wt.parentElement) { var pe = wt.parentElement; var r4 = pe.getBoundingClientRect(); if (r4.width > 50 && r4.height > 20) { panel = pe; matchKind = \'word-tips.parent\'; } } }' +
    '  if (!panel) { var anyMention = document.querySelector(\'.mention-selector-modal\'); if (anyMention) { var r5 = anyMention.getBoundingClientRect(); if (r5.width > 50 && r5.height > 20) { panel = anyMention; matchKind = \'mention-selector-modal\'; } } }' +
    '  if (panel) try { panelText = (panel.innerText || panel.textContent || \'\').replace(/\\s+/g, \' \').trim(); } catch(e) {}' +
    '} catch(e) {}' +
    // ========= 2) 通用评分兜底 =========
    'if (!panel) try {' +
    '  var candidates = [];' +
    '  var all = document.querySelectorAll(\'div, section, span\');' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var el = all[i]; if (!el) continue;' +
    '    try {' +
    '      var rect = el.getBoundingClientRect(); if (rect.width <= 80 || rect.height <= 30) continue;' +
    '      var st = window.getComputedStyle ? window.getComputedStyle(el) : null;' +
    '      if (st && (st.display === \'none\' || st.visibility === \'hidden\' || parseFloat(st.opacity || \'1\') <= 0.1)) continue;' +
    '      var pos = st ? (st.position || \'\') : \'\';' +
    '      var zi = st ? parseInt(st.zIndex || \'0\', 10) : 0;' +
    '      var cls = (el.getAttribute ? el.getAttribute(\'class\') || \'\' : \'\');' +
    '      var inner = (el.innerText || el.textContent || \'\').replace(/\\s+/g, \' \');' +
    '      var hasFloatFeature = (pos === \'fixed\' || pos === \'absolute\') || (inner.indexOf(\'讨论\') !== -1 && inner.indexOf(\'敲空格\') !== -1);' +
    '      if (!hasFloatFeature) continue;' +
    '      var score = 0;' +
    '      if (pos === \'fixed\' || pos === \'absolute\') score += 100;' +
    '      if (!isNaN(zi) && zi >= 10) score += Math.min(zi, 5000) / 30;' +
    '      if (inner.indexOf(\'讨论\') !== -1) score += 80;' +
    '      if (inner.indexOf(\'敲空格\') !== -1 || inner.indexOf(\'取消插入话题\') !== -1) score += 200;' +
    '      if (/^\\s*#.+?#/m.test(inner)) score += 150;' +
    '      if (cls.indexOf(\'mention\') !== -1 || cls.indexOf(\'selector\') !== -1) score += 200;' +
    '      if (tagLower && inner.toLowerCase().indexOf(tagLower) !== -1) score += 60;' +
    '      if (score >= 200) candidates.push({ el: el, score: score, text: inner.slice(0, 200) });' +
    '    } catch(e) {}' +
    '  }' +
    '  if (candidates.length > 0) { candidates.sort(function(a, b) { return b.score - a.score; }); panel = candidates[0].el; panelText = candidates[0].text; matchKind = \'score:\' + candidates[0].score; }' +
    '} catch(e) {}' +
    // ========= 结果返回 =========
    'var result = { diag: diag, tagName: tagName };' +
    'if (!panel) { result.found = false; return result; }' +
    // 3) 浮层内找第一项：优先 .forum-list-item
    'var firstItem = null;' +
    'var firstInfo = { text: \'\', matched: false, cls: \'\' };' +
    'try {' +
    '  var itemSelectors = [\'.forum-list-item\', \'section.forum-list-item\', \'li\', \'[role="option"]\', \'[class*="list-item"]\', \'[class*="menu-item"]\', \'[class*="-item"]\', \'button\', \'div > div\'];' +
    '  for (var is = 0; is < itemSelectors.length; is++) {' +
    '    var items = panel.querySelectorAll(itemSelectors[is]);' +
    '    for (var ii = 0; ii < items.length; ii++) {' +
    '      var it = items[ii];' +
    '      try {' +
    '        if (!panel.contains(it)) continue;' +
    '        var ir = it.getBoundingClientRect(); if (ir.width < 30 || ir.height < 15) continue;' +
    '        var itTxt = ((it.innerText || it.textContent || \'\').replace(/\\s+/g, \' \').trim());' +
    '        if (!itTxt) continue;' +
    '        if (itTxt.indexOf(\'敲空格可取消插入话题\') !== -1) continue;' +
    '        var topY = ir.top + ir.height / 2;' +
    '        if (!firstItem || topY < firstItem._topY) { firstItem = it; firstItem._topY = topY; firstInfo.text = itTxt; firstInfo.cls = (it.getAttribute ? it.getAttribute(\'class\') || \'\' : \'\').slice(0, 120); }' +
    '      } catch(e) {}' +
    '    }' +
    '    if (firstItem) break;' +
    '  }' +
    '  if (firstItem && tagLower) {' +
    '    var fLower = firstInfo.text.toLowerCase();' +
    '    firstInfo.matched = (fLower.indexOf(tagLower) !== -1) || /#[^#\\n]+?#/.test(firstInfo.text);' +
    '  }' +
    '  if (!firstItem && panelText) { firstItem = panel; firstInfo.text = panelText; firstInfo.matched = true; firstInfo.cls = (panel.getAttribute ? panel.getAttribute(\'class\') || \'\' : \'\').slice(0, 120); }' +
    '} catch(e) {}' +
    'result.found = true;' +
    'result.matchKind = matchKind;' +
    'result.panelTextPreview = (panelText || \'\').slice(0, 300);' +
    'result.panelClass = (panel && panel.getAttribute ? panel.getAttribute(\'class\') || \'\' : \'\').slice(0, 150);' +
    'result.firstItemExists = !!firstItem;' +
    'result.firstItemText = firstInfo.text;' +
    'result.firstItemClass = firstInfo.cls;' +
    'result.firstItemMatched = firstInfo.matched;' +
    'return result;' +
    '})()'
  );
}

/**
 * 生成"在话题推荐下拉框中点击第一项"的脚本
 * 🔑 与上面 probe 完全一致的浮层定位优先级：精确类名 > 通用评分
 * 🔑 第一项定位：优先 .forum-list-item（用户提供的精确类名）
 */
function buildClickFirstTopicSuggestionScript(tagName: string): string {
  const tagJSON = JSON.stringify(tagName);
  return (
    '(function(){' +
    'var tagName = ' + tagJSON + ' || \'\';' +
    'var tagLower = tagName.toLowerCase();' +
    // ========= 1) 浮层定位：和 probe 完全一致 =========
    'var panel = null;' +
    'var matchKind = \'\';' +
    'try {' +
    '  var wrap = document.querySelector(\'.tweet-link-selector-wrap\');' +
    '  if (wrap) { var st = window.getComputedStyle ? window.getComputedStyle(wrap) : null; if (!st || (st.display !== \'none\' && st.visibility !== \'hidden\')) { var rect = wrap.getBoundingClientRect(); if (rect.width > 50 && rect.height > 20) { panel = wrap; matchKind = \'tweet-link-selector-wrap\'; } } }' +
    '  if (!panel) { var modal = document.querySelector(\'.mention-selector-modal.forum\'); if (modal) { var r2 = modal.getBoundingClientRect(); if (r2.width > 50 && r2.height > 20) { panel = modal; matchKind = \'mention-selector-modal.forum\'; } } }' +
    '  if (!panel) { var lc = document.querySelector(\'.forum-list-content\'); if (lc && lc.parentElement) { var r3 = lc.parentElement.getBoundingClientRect(); if (r3.width > 50 && r3.height > 20) { panel = lc.parentElement; matchKind = \'forum-list-content.parent\'; } } }' +
    '  if (!panel) { var wt = document.querySelector(\'.word-tips\'); if (wt && wt.parentElement) { var pe = wt.parentElement; var r4 = pe.getBoundingClientRect(); if (r4.width > 50 && r4.height > 20) { panel = pe; matchKind = \'word-tips.parent\'; } } }' +
    '  if (!panel) { var anyM = document.querySelector(\'.mention-selector-modal\'); if (anyM) { var r5 = anyM.getBoundingClientRect(); if (r5.width > 50 && r5.height > 20) { panel = anyM; matchKind = \'mention-selector-modal\'; } } }' +
    '} catch(e) {}' +
    'if (!panel) try {' +
    '  var candidates = [];' +
    '  var all = document.querySelectorAll(\'div, section, span\');' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var el = all[i]; if (!el) continue;' +
    '    try {' +
    '      var rect = el.getBoundingClientRect(); if (rect.width <= 80 || rect.height <= 30) continue;' +
    '      var st = window.getComputedStyle ? window.getComputedStyle(el) : null;' +
    '      if (st && (st.display === \'none\' || st.visibility === \'hidden\')) continue;' +
    '      var pos = st ? (st.position || \'\') : \'\';' +
    '      var zi = st ? parseInt(st.zIndex || \'0\', 10) : 0;' +
    '      var cls = (el.getAttribute ? el.getAttribute(\'class\') || \'\' : \'\');' +
    '      var inner = (el.innerText || el.textContent || \'\').replace(/\\s+/g, \' \');' +
    '      var hasFloat = (pos === \'fixed\' || pos === \'absolute\') || (inner.indexOf(\'讨论\') !== -1 && inner.indexOf(\'敲空格\') !== -1);' +
    '      if (!hasFloat) continue;' +
    '      var score = 0;' +
    '      if (pos === \'fixed\' || pos === \'absolute\') score += 100;' +
    '      if (!isNaN(zi) && zi >= 10) score += Math.min(zi, 5000) / 30;' +
    '      if (inner.indexOf(\'讨论\') !== -1) score += 80;' +
    '      if (inner.indexOf(\'敲空格\') !== -1 || inner.indexOf(\'取消插入话题\') !== -1) score += 200;' +
    '      if (/^\\s*#.+?#/m.test(inner)) score += 150;' +
    '      if (cls.indexOf(\'mention\') !== -1 || cls.indexOf(\'selector\') !== -1) score += 200;' +
    '      if (tagLower && inner.toLowerCase().indexOf(tagLower) !== -1) score += 60;' +
    '      if (score >= 200) candidates.push({ el: el, score: score });' +
    '    } catch(e) {}' +
    '  }' +
    '  if (candidates.length > 0) { candidates.sort(function(a, b) { return b.score - a.score; }); panel = candidates[0].el; matchKind = \'score:\' + candidates[0].score; }' +
    '} catch(e) {}' +
    'if (!panel) return { clicked: false, reason: \'no-topic-panel\', tagName: tagName };' +
    // ========= 2) 在浮层里找第一项（最高优先级：.forum-list-item） =========
    'var first = null;' +
    'var firstTop = Infinity;' +
    'var firstText = \'\';' +
    'try {' +
    '  var itemSelectors = [\'.forum-list-item\', \'section.forum-list-item\', \'[role="option"]\', \'li\', \'[class*="list-item"]\', \'[class*="menu-item"]\', \'[class*="-item"]\', \'button\', \'a\', \'div > div\', \'span\'];' +
    '  for (var is = 0; is < itemSelectors.length; is++) {' +
    '    var its = panel.querySelectorAll(itemSelectors[is]);' +
    '    for (var ii = 0; ii < its.length; ii++) {' +
    '      var it = its[ii];' +
    '      try {' +
    '        if (!panel.contains(it)) continue;' +
    '        var ir = it.getBoundingClientRect(); if (ir.width < 30 || ir.height < 15) continue;' +
    '        var itTxt = ((it.innerText || it.textContent || \'\').replace(/\\s+/g, \' \').trim());' +
    '        if (!itTxt || itTxt === \'取消\' || itTxt === \'确定\') continue;' +
    '        if (itTxt.indexOf(\'敲空格可取消插入话题\') !== -1) continue;' +
    '        var midY = ir.top + ir.height / 2;' +
    '        if (midY < firstTop) { firstTop = midY; first = it; firstText = itTxt; }' +
    '      } catch(e) {}' +
    '    }' +
    '    if (first) break;' +
    '  }' +
    '} catch(e) {}' +
    'if (!first) return { clicked: false, reason: \'no-first-item-in-panel\', matchKind: matchKind, panelClass: (panel && panel.getAttribute ? panel.getAttribute(\'class\') || \'\' : \'\').slice(0, 120) };' +
    // ========= 3) 点击：click + 完整 mouse 事件链（兼容字节组件） =========
    'try { first.focus && first.focus(); } catch(e) {}' +
    'try { first.dispatchEvent(new MouseEvent(\'mouseover\', { bubbles: true, cancelable: true, view: window })); } catch(e) {}' +
    'try { first.dispatchEvent(new MouseEvent(\'mousemove\', { bubbles: true, cancelable: true, view: window })); } catch(e) {}' +
    'try { first.dispatchEvent(new MouseEvent(\'mousedown\', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 })); } catch(e) {}' +
    'try { first.click && first.click(); } catch(e) {}' +
    'try { first.dispatchEvent(new MouseEvent(\'mouseup\', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch(e) {}' +
    'try { first.dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch(e) {}' +
    // 🔑 额外：如果节点是 .forum-list-item（用户给的精确类）再把子节点也点一下，防止真点击目标在内部 span/div
    'try {' +
    '  var firstCls = (first && first.getAttribute ? first.getAttribute(\'class\') || \'\' : \'\');' +
    '  if (firstCls.indexOf(\'forum-list-item\') !== -1) {' +
    '    var inners = first.querySelectorAll(\'div, span, a, section\');' +
    '    for (var k = 0; k < inners.length; k++) {' +
    '      try { inners[k].dispatchEvent(new MouseEvent(\'mousedown\', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 })); } catch(e) {}' +
    '      try { inners[k].click && inners[k].click(); } catch(e) {}' +
    '      try { inners[k].dispatchEvent(new MouseEvent(\'click\', { bubbles: true, cancelable: true, view: window })); } catch(e) {}' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'return { clicked: true, matchKind: matchKind, firstItemText: firstText.slice(0, 100), firstItemClass: (first && first.getAttribute ? first.getAttribute(\'class\') || \'\' : \'\').slice(0, 120) };' +
    '})()'
  );
}

/**
 * 生成"找到 ProseMirror 编辑器、聚焦并把光标移到末尾"的脚本
 * 返回 { ok, editorFound, isContentEditable }
 */
function buildFocusProseMirrorEndScript(): string {
  return (
    '(function(){' +
    'var pm = document.querySelector(\'.sg-editor .ProseMirror\') || document.querySelector(\'[contenteditable].ProseMirror\');' +
    'if (!pm) try {' +
    '  var all = document.querySelectorAll(\'[contenteditable="true"], [contenteditable=""]\');' +
    '  for (var i = 0; i < all.length; i++) { var c = (all[i].getAttribute && all[i].getAttribute(\'class\')) || \'\'; if (c.indexOf(\'ProseMirror\') !== -1) { pm = all[i]; break; } }' +
    '} catch(e) {}' +
    'if (!pm) return { ok: false, editorFound: false, isContentEditable: false };' +
    'try {' +
    '  pm.focus();' +
    '  var range = document.createRange();' +
    '  range.selectNodeContents(pm);' +
    '  range.collapse(false);' +
    '  var sel = window.getSelection();' +
    '  sel.removeAllRanges();' +
    '  sel.addRange(range);' +
    '  try { pm.dispatchEvent(new Event(\'focus\', { bubbles: true })); } catch(e) {}' +
    '  try { pm.dispatchEvent(new Event(\'input\', { bubbles: true })); } catch(e) {}' +
    '  return { ok: true, editorFound: true, isContentEditable: true };' +
    '} catch(e) {' +
    '  return { ok: false, editorFound: true, isContentEditable: true, error: String(e && e.message || e) };' +
    '}' +
    '})()'
  );
}

// =====================================================================
// 脚本安全注入辅助
// 背景：win.webContents.executeJavaScript 内部用「结构化克隆」读取返回值，
//  一遇到 DOM 引用（含循环引用）/ Symbol / 大 TypedArray / 非可序列化对象，
//  就会直接抛 "Script failed to execute, this normally means an error was thrown."，
//  无法区分是 JS 语法错还是返回值序列化错。
//
// 修复策略：所有注入脚本统一在最外层包裹一层「顶级 try/catch + JSON.stringify」，
//  仅以字符串形式返回 JSON，主进程再 JSON.parse，从根源上绕过返回值序列化问题。
// =====================================================================
type SafeScriptFn = (...args: any[]) => any;
function wrapSafeScript(fn: SafeScriptFn, args: any[] = []): string {
  // 把函数体抽出来，并在两侧加上顶级 try/catch
  // 1) 把参数序列化进调用方
  const argsJson = args.map((a) => {
    try { return JSON.stringify(a); } catch { return 'undefined'; }
  }).join(',');
  return `
;(function(){
  try {
    var args = [${argsJson}];
    var payload = (${fn.toString()}).apply(null, args);
    // 如果返回值本身就是字符串（安全模式），直接回传
    if (typeof payload === 'string') return payload;
    // 否则 JSON.stringify 兜底（防循环引用）
    var seen = [];
    var s = JSON.stringify(payload, function(k,v){
      if (typeof v === 'function' || typeof v === 'symbol') return undefined;
      if (typeof v === 'object' && v !== null) {
        if (seen.indexOf(v) !== -1) return '[Circular]';
        seen.push(v);
      }
      return v;
    });
    return s;
  } catch (topErr) {
    try {
      return JSON.stringify({ __err: String((topErr && topErr.message) || topErr).slice(0, 2000), __stack: String((topErr && topErr.stack) || '').slice(0, 2000) });
    } catch (_) {
      return '{"__err":"execute_unknown_error"}';
    }
  }
})();
`.trim();
}

/** 主进程端：把 wrapSafeScript 返回的字符串安全解析为对象 */
function parseSafeResult(raw: unknown, fallback: Record<string, any> = {}): any {
  try {
    if (typeof raw !== 'string') {
      // 极少数场景 executeJavaScript 解析字符串时直接给对象；但一般我们 wrap 后都是字符串
      return raw != null ? raw : { ...fallback };
    }
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.__err === 'string') {
      const e: any = new Error(obj.__err);
      if (obj.__stack) e.stack = obj.__stack;
      throw e;
    }
    return obj;
  } catch (e) {
    // 抛给外层 evalJS 去 retry；同时在 fallback 里兜底值，避免后续解构报错
    const msg = (e instanceof Error ? e.message : String(e)) || 'safe_parse_failed';
    return { ...fallback, __safeParseErr: msg };
  }
}

/**
 * 生成"检测发布结果"的脚本（轮询使用）
 */
function buildPublishResultProbeScript(): string {
  const runner = function () {
    const res: any = { err: null, url: '', success: false, failed: false, hitSuccess: [], hitFail: [], leftPublish: false, isSuccessPage: false, hasSuccessToast: false };
    try {
      const url = (location && location.href) || ''; res.url = url;
      let bodyText = '';
      try { bodyText = (document && document.body ? (document.body.innerText || '') : '') || ''; } catch (_) { /* ignore */ }
      const successKeywords = ['发布成功', '已发布', '发布完成', '发布成功，正在审核', '微头条已发布', '投稿成功', '已发布，正在审核'];
      const failKeywords = ['发布失败', '发布未成功', '服务器开小差', '网络异常', '内容包含敏感', '违反社区公约', '内容不能为空', '发布未通过'];
      for (let i = 0; i < successKeywords.length; i++) if (bodyText.indexOf(successKeywords[i]) !== -1) res.hitSuccess.push(successKeywords[i]);
      for (let j = 0; j < failKeywords.length; j++) if (bodyText.indexOf(failKeywords[j]) !== -1) res.hitFail.push(failKeywords[j]);
      res.leftPublish = url.indexOf('weitoutiao/publish') === -1 && url.indexOf('graphic/publish') === -1 && url.indexOf('xigua/upload-video') === -1;
      res.isSuccessPage = url.indexOf('success') !== -1 || url.indexOf('published=true') !== -1 || url.indexOf('content/manage') !== -1 || url.indexOf('manage/table') !== -1;
      try {
        const toastEls = document.querySelectorAll('[class*="toast"], [class*="message"], [class*="notification"], [class*="notice"]');
        for (let ti = 0; ti < toastEls.length; ti++) {
          const tText = ((toastEls[ti] as any).innerText || '').replace(/\s+/g, '');
          for (let si = 0; si < successKeywords.length; si++) {
            if (tText.indexOf(successKeywords[si]) !== -1) { res.hasSuccessToast = true; res.hitSuccess.push('toast:' + successKeywords[si]); break; }
          }
        }
      } catch (_) { /* ignore */ }
      res.success = res.hitSuccess.length > 0 || res.isSuccessPage || res.hasSuccessToast || (res.leftPublish && res.hitFail.length === 0);
      res.failed = res.hitFail.length > 0;
    } catch (e: any) { res.err = String((e && e.message) || e).slice(0, 500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner);
}

// =====================================================================
// 西瓜视频（今日头条视频发布）脚本构造器
// 发布页 DOM 结构（和抖音创作平台 xigua-upload-manage 同源）：
//   顶层：.xigua_upload-video-wrapper
//     .garr-video-container
//       .m-upload-anchor           → 视频上传锚点区
//         .upload-video-trigger-btn .byte-upload-trigger → <button> + input[type=file]
//       .video-show-progress       → 上传进度条区
//         .progress-items
//           .progress-item.selected/.uploading
//             .progress-item-main
//               .process-item-icon.scanning/uploading → 转码中 / 上传中
//               .process-item-icon.finish             → 上传完成 ✓
//               .progress-item-name                   → 文件名
//       .video-form-basic          → 视频信息表单（上传完成后渲染）
//         .video-form-wrapper .video-form-item
//           .form-item-title       → 标题（必填 5~30 字）
//             .video-form-item-control textarea / .byte-textarea-wrapper textarea
//           .form-item-abstract    → 简介（可选，最多 400 字）
//             .byte-textarea-wrapper .abstract textarea
//           .form-item-sub-title   → 副标题
//           .form-item-poster      → 封面海报
//           .form-item-tags        → 话题标签
//       .publish-footer-content / .video-batch-footer → 发布区
//         .byte-btn.primary.publish-btn → "发布" 按钮
// =====================================================================

/**
 * 检测视频发布页结构：上传锚点、进度区、表单、发布按钮是否已渲染
 * 返回 { wrapperFound, uploadAnchorFound, progressFound, formFound, publishBtn, fileInputs:[...] }
 */
function buildProbeXiguaVideoPageScript(): string {
  const runner = function () {
    const res: any = { err: null, wrapperFound: false, uploadAnchorFound: false, progressFound: false, formFound: false, publishBtn: null, fileInputs: [], progressItems: [], diag: {} };
    try {
      try { res.wrapperFound = !!document.querySelector('.xigua_upload-video-wrapper, .garr-video-container'); } catch (_) { /* ignore */ }
      try { res.diag.wrapperCls = ((document.querySelector('.xigua_upload-video-wrapper') as any) || {}).className || ''; } catch (_) { /* ignore */ }
      try {
        const anchor = document.querySelector('.m-upload-anchor, .upload-video-trigger-btn, .byte-upload-trigger');
        res.uploadAnchorFound = !!anchor;
        if (anchor) res.diag.anchorCls = String((anchor as any).className || '').slice(0, 150);
      } catch (_) { /* ignore */ }
      try { res.progressFound = !!document.querySelector('.video-show-progress, .progress-items'); } catch (_) { /* ignore */ }
      try { res.formFound = !!document.querySelector('.video-form-basic, .video-form-wrapper'); } catch (_) { /* ignore */ }

      // 发布按钮评分（footer 作用域加权优先）
      try {
        const patterns = ['发布', '立即发布', '确认发布'];
        const candidates: any[] = [];
        const nodes = document.querySelectorAll('button, a, [role="button"], div, span');
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i] as any; if (!n) continue;
          const txt = ((n.innerText || n.textContent || '').replace(/\s+/g, '')).trim();
          if (!txt || txt.length > 20) continue;
          let matched = false; let rank = 0;
          for (let k1 = 0; k1 < patterns.length; k1++) {
            if (txt === patterns[k1] || txt.indexOf(patterns[k1]) !== -1) { matched = true; rank = 100 - k1 * 10; break; }
          }
          if (!matched) continue;
          const cls = (n.getAttribute ? String(n.getAttribute('class') || '') : '') as string;
          try {
            if ((n.offsetWidth | 0) === 0 || (n.offsetHeight | 0) === 0) continue;
            const disabled = !!(n.disabled || (n.getAttribute && (n.getAttribute('disabled') !== null || n.getAttribute('aria-disabled') === 'true')));
            if (disabled) rank -= 500;
            // footer 作用域加权（向上追溯最多 8 层）
            let p = n; let depth = 0;
            while (p && depth < 8 && p.parentElement) {
              p = p.parentElement; depth++;
              const pCls = String((p as any).className || '');
              if (pCls.indexOf('publish-footer') !== -1 || pCls.indexOf('video-batch') !== -1 || pCls.indexOf('footer-content') !== -1) { rank += 200; break; }
            }
          } catch (_) { /* ignore */ }
          if (cls.indexOf('publish') !== -1 || cls.indexOf('publish-btn') !== -1) rank += 80;
          if (cls.indexOf('primary') !== -1) rank += 50;
          if (cls.indexOf('byte-btn') !== -1) rank += 30;
          if (cls.indexOf('footer') !== -1 || cls.indexOf('video-batch') !== -1) rank += 40;
          const disabledFlag = !!(n.disabled || (n.getAttribute && (n.getAttribute('disabled') !== null || n.getAttribute('aria-disabled') === 'true')));
          candidates.push({ idx: i, cls, text: txt, rank, disabled: disabledFlag });
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.rank - a.rank);
          const top = candidates[0];
          res.publishBtn = {
            exists: true,
            cls: String(top.cls || '').slice(0, 200),
            text: top.text,
            disabled: !!top.disabled,
            topThree: candidates.slice(0, 3).map((c) => ({ text: c.text, rank: c.rank, cls: String(c.cls || '').slice(0, 60), disabled: !!c.disabled })),
          };
        }
      } catch (e: any) { res.diag.publishBtnErr = String((e && e.message) || e).slice(0, 200); }

      // file inputs（带 accept 特征）
      try {
        const fins = document.querySelectorAll('input[type="file"]');
        for (let j = 0; j < fins.length; j++) {
          const f = fins[j] as any;
          res.fileInputs.push({
            accept: f.accept || '',
            cls: (f.className || '') as string,
            multiple: !!f.multiple,
            hidden: ((f.offsetWidth | 0) === 0 || (f.offsetHeight | 0) === 0),
          });
        }
      } catch (_) { /* ignore */ }

      // 进度项
      try {
        const pItems = document.querySelectorAll('.video-show-progress .progress-items .progress-item');
        for (let k2 = 0; k2 < pItems.length; k2++) {
          const it = pItems[k2] as any;
          const iCls = String(it.className || '');
          const iconEl = it.querySelector('.process-item-icon') as any;
          let iName = ''; try { iName = ((it.querySelector('.progress-item-name') as any) || {}).innerText || ''; } catch (_) { /* ignore */ }
          res.progressItems.push({
            cls: iCls.slice(0, 100),
            selected: iCls.indexOf('selected') !== -1,
            uploading: iCls.indexOf('uploading') !== -1 || (iconEl && (String(iconEl.className || '').indexOf('uploading') !== -1)),
            scanning: !!(iconEl && String(iconEl.className || '').indexOf('scanning') !== -1),
            finished: !!(iconEl && String(iconEl.className || '').indexOf('finish') !== -1),
            name: String(iName || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          });
        }
      } catch (e: any) { res.diag.progressErr = String((e && e.message) || e).slice(0, 200); }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1000); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner);
}

/**
 * 填写视频标题（重写：与用户提供 DOM 对齐）
 *   实际 DOM: .form-item-title .video-form-item-control > .article-title-wrap > .xigua-input-wrapper > input.xigua-input
 *   限制：1~30 字（placeholder 明确写 1～30，旁边 word-limit 30）
 */
function buildFillXiguaVideoTitleScript(title: string): string {
  const runner = function (title: string) {
    const res: any = { err: null, targetFound: false, filled: false, method: '', beforeVal: '', afterVal: '', afterLen: 0, errors: [] };
    try {
      const sels = [
        '.form-item-title .article-title-wrap input.xigua-input',
        '.form-item-title .xigua-input-wrapper > input.xigua-input',
        '.form-item-title input.show-limit',
        '.form-item-title .video-form-item-control input[type="text"]',
        '.video-form-basic input[placeholder*="请输入 1～30 个字符"]',
        'input.xigua-input.show-limit',
      ];
      let target: any = null;
      for (let i = 0; i < sels.length; i++) {
        try {
          const el = document.querySelector(sels[i]);
          if (el) { target = el; res.method = sels[i]; break; }
        } catch (_) { /* ignore */ }
      }
      if (!target) {
        // 最后兜底：.form-item-title 下第一个可见 input
        try {
          const all = document.querySelectorAll('.form-item-title input');
          for (let j = 0; j < all.length; j++) {
            const n = all[j] as any;
            try {
              if ((n.offsetWidth | 0) <= 0 || (n.offsetHeight | 0) <= 0) continue;
              target = n; res.method = '.form-item-title input[' + j + ']'; break;
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
      }
      if (!target) return JSON.stringify(res);
      res.targetFound = true;
      try { res.beforeVal = typeof target.value === 'string' ? target.value.slice(0, 80) : ''; } catch (_) { /* ignore */ }
      try { if (typeof target.focus === 'function') target.focus(); } catch (_) { /* ignore */ }
      try { if (typeof target.select === 'function') target.select(); } catch (_) { /* ignore */ }
      try {
        // React 受控 value：先写原生 setter（input type=text 通常是 HTMLInputElement.prototype.value setter）再派发 input/change
        const proto = Object.getPrototypeOf(target);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && typeof desc.set === 'function') { desc.set.call(target, title); } else { target.value = title; }
        res.method += '|setter';
        res.afterVal = String(target.value || '').slice(0, 80);
        res.afterLen = String(target.value || '').length;
      } catch (e: any) { res.errors.push('set:' + String((e && e.message) || e).slice(0, 200)); }
      try {
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: title.slice(-1) || '' } as any));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) { /* ignore */ }
      try { if (typeof target.blur === 'function') target.blur(); } catch (_) { /* ignore */ }
      res.afterLen = String(target.value || '').length;
      res.filled = res.afterLen >= 1 && res.afterLen <= 30;
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [title]);
}

/**
 * 填写视频简介（重写：与用户提供 DOM 对齐）
 *   实际 DOM: .form-item-abstract .byte-textarea-wrapper > textarea.byte-textarea.abstract (maxlength=400)
 */
function buildFillXiguaVideoAbstractScript(content: string): string {
  const runner = function (content: string) {
    const res: any = { err: null, targetFound: false, filled: false, method: '', afterLen: 0, errors: [] };
    try {
      if (!content) return JSON.stringify(res);
      const sels = [
        '.form-item-abstract textarea.byte-textarea.abstract',
        '.form-item-abstract .byte-textarea-wrapper textarea',
        '.form-item-abstract textarea[maxlength="400"]',
        'textarea.byte-textarea.abstract',
        '.form-item-abstract textarea',
      ];
      let target: any = null;
      for (let i = 0; i < sels.length; i++) {
        try {
          const el = document.querySelector(sels[i]);
          if (el) { target = el; res.method = sels[i]; break; }
        } catch (_) { /* ignore */ }
      }
      if (!target) return JSON.stringify(res);
      res.targetFound = true;
      try { if (typeof target.focus === 'function') target.focus(); } catch (_) { /* ignore */ }
      try { if (typeof target.select === 'function') target.select(); } catch (_) { /* ignore */ }
      try {
        const proto = Object.getPrototypeOf(target);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc && typeof desc.set === 'function') desc.set.call(target, content); else target.value = content;
        res.method += '|setter';
      } catch (e: any) { res.errors.push('set:' + String((e && e.message) || e).slice(0, 200)); }
      try {
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) { /* ignore */ }
      try { if (typeof target.blur === 'function') target.blur(); } catch (_) { /* ignore */ }
      res.afterLen = String(target.value || '').length;
      res.filled = res.afterLen > 0 && res.afterLen <= 400;
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [content]);
}

/**
 * 填写视频话题标签（修复：Arco input-tag Enter 不生效问题）
 *   实际 DOM：.form-item-hash_tag .hash_tag_wrapper .hash-tag-editor
 *     .arco-input-tag（Arco Design Tag输入） > .arco-input-tag-inner > input.arco-input-tag-input
 *     已添加的话题渲染为 <span class="arco-tag arco-tag-checked" title="#话题">#话题</span>
 *   正确交互（字节 Arco）：往 input 逐字符输入 -> 等推荐面板渲染 -> 点击第一个推荐 -> 自动生成 tag
 *   多重回退：逐字符 inputEvent -> 点击推荐第一个 -> Enter/Space/Comma -> blur -> 手工创建 arco-tag DOM 兜底
 *   限制：最多 10 个
 */
function buildFillXiguaVideoHashTagScript(tags: string[]): string {
  const runner = function (tags: string[]) {
    const res: any = {
      err: null, wrapperFound: false, inputFound: false,
      attempts: 0, added: 0, skipped: 0, beforeCount: 0, afterCount: 0,
      errors: [], addedTags: [], fallbackDomInserts: 0, dropdownClicked: 0,
    };
    try {
      if (!tags || tags.length === 0) return JSON.stringify(res);
      const tagMax = 10;
      const wrapper = document.querySelector('.form-item-hash_tag .hash-tag-editor .arco-input-tag') as any;
      if (!wrapper) return JSON.stringify(res);
      res.wrapperFound = true;
      const input: any = wrapper.querySelector('input.arco-input-tag-input, input.arco-input-tag-input-size-default, .arco-input-tag input');
      if (!input) return JSON.stringify(res);
      res.inputFound = true;
      // 工具：sleep（用同步 while Date.now 代替 Promise，避免 evalJS async 回不来）
      const sleepSync = (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) { try { /* spin */ } catch (_) { /* ignore */ } }
      };
      // 工具：先数已有的 tag
      const countTags = () => {
        try {
          const list = wrapper.querySelectorAll('.arco-tag-checked, .arco-input-tag-tag');
          return list ? list.length : 0;
        } catch (_) { return 0; }
      };
      // 工具：找到 arco 推荐下拉里的第一个候选并点击
      const clickFirstDropdown = (keyword: string): boolean => {
        try {
          // Arco 推荐面板常见 selector（今日头条这里是 .tag-select-wrapper 下 .arco-input-tag + .arco-select 联动，推荐实际出现在 body 下 floating layer）
          const candidateSelectors = [
            '.arco-select-dropdown .arco-select-option',
            '.arco-select-view .arco-select-view-option',
            '.arco-popover-content .arco-list-item',
            '.arco-popover .arco-list-item',
            '.tag-select-suggestions .arco-tag-suggest-item',
            '.hash-tag-suggest .suggest-item',
            'body > [class*="arco-select"] .arco-select-option',
            'body > [class*="arco-popover"] .arco-list-item',
          ];
          for (let s = 0; s < candidateSelectors.length; s++) {
            try {
              const list = document.querySelectorAll(candidateSelectors[s]) as any;
              if (!list || list.length === 0) continue;
              // 优先选包含 keyword 的
              for (let k = 0; k < list.length; k++) {
                const txt = String((list[k].textContent || list[k].innerText || '')).trim().replace(/^#/, '');
                if (keyword && txt.indexOf(keyword) >= 0) {
                  try { list[k].click(); if (typeof list[k].dispatchEvent === 'function') { try { list[k].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); list[k].dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) { /* ignore */ } } return true; } catch (_) { /* ignore */ }
                }
              }
              // 没匹配 keyword，就点第一个（Arco 里通常第一个就是最推荐的输入词本身）
              try {
                list[0].click();
                if (typeof list[0].dispatchEvent === 'function') {
                  try {
                    list[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    list[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    list[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  } catch (_) { /* ignore */ }
                }
                return true;
              } catch (_) { /* ignore */ }
            } catch (_) { /* ignore */ }
          }
          return false;
        } catch (_) { return false; }
      };
      // 工具：创建一个「手工 DOM 兜底的 arco-tag 节点」，放到 .arco-input-tag-inner 最后
      const insertTagDomFallback = (tagInner: HTMLElement, raw: string): boolean => {
        try {
          const templateTag = tagInner.querySelector('.arco-tag-checked, .arco-input-tag-tag');
          let newTag: any = null;
          if (templateTag && templateTag.cloneNode) {
            newTag = templateTag.cloneNode(true);
          } else {
            newTag = document.createElement('span');
            newTag.className = 'arco-tag arco-tag-checked arco-tag-size-default arco-input-tag-tag zoomIn-enter-done';
            const txt = document.createElement('span');
            txt.className = 'arco-tag-content';
            newTag.appendChild(txt);
          }
          const txt = String(raw || '').replace(/^#/, '');
          const contentSpan = newTag.querySelector('.arco-tag-content') || newTag;
          try { contentSpan.textContent = '#' + txt; } catch (_) { try { contentSpan.innerText = '#' + txt; } catch (_2) { /* ignore */ } }
          try { newTag.setAttribute('title', '#' + txt); } catch (_) { /* ignore */ }
          // 放 input 前面
          try {
            const inputHere = tagInner.querySelector('.arco-input-tag-input, input');
            if (inputHere && inputHere.parentNode) {
              inputHere.parentNode.insertBefore(newTag, inputHere);
            } else {
              tagInner.appendChild(newTag);
            }
            res.fallbackDomInserts++;
            return true;
          } catch (_) { /* ignore */ }
          return false;
        } catch (_) { return false; }
      };
      // 工具：尝试同步 arco 的隐藏 input（如果存在）—— 一些实现里会把 join 的 tags 放到 hidden input value，提交时取这个
      const syncHiddenInput = (tagsValList: string[]): void => {
        try {
          const hiddenCandidates = [
            wrapper.querySelector('input[type="hidden"]'),
            wrapper.parentElement ? wrapper.parentElement.querySelector('input[type="hidden"]') : null,
            document.querySelector('.hash-tag-editor input[type="hidden"]'),
          ];
          for (let i = 0; i < hiddenCandidates.length; i++) {
            const hi = hiddenCandidates[i] as any;
            if (!hi) continue;
            try {
              const val = tagsValList.map((t) => '#' + String(t).replace(/^#/, '')).join(',');
              const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hi), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              if (desc && typeof desc.set === 'function') desc.set.call(hi, val);
              else hi.value = val;
              try { hi.dispatchEvent(new Event('input', { bubbles: true })); hi.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { /* ignore */ }
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
      };

      res.beforeCount = countTags();
      const finalTagsAdded: string[] = [];
      for (let i = 0; i < tags.length; i++) {
        const beforeI = countTags();
        if (beforeI >= tagMax) { res.skipped += (tags.length - i); break; }
        let raw = String(tags[i] || '').trim();
        if (!raw) { res.skipped++; continue; }
        raw = raw.replace(/^#+|\s+$/g, '').replace(/\s+/g, ' ').trim();
        if (!raw) { res.skipped++; continue; }
        if (raw.length > 20) raw = raw.slice(0, 20);
        res.attempts++;

        // --- Step 1: focus+select 清空上一个残留 ---
        try { if (typeof input.focus === 'function') input.focus({ preventScroll: false }); } catch (_) { try { input.focus(); } catch (_2) { /* ignore */ } }
        try { if (typeof input.select === 'function') input.select(); } catch (_) { /* ignore */ }
        try {
          const desc1 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc1 && typeof desc1.set === 'function') desc1.set.call(input, '');
          else input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) { input.value = ''; }

        // --- Step 2: 逐字符写入（每个字符都 set + beforeinput + input + 10ms spin），模仿真实用户输入法 ---
        const chars = String(raw || '').split('');
        let buffer = '';
        for (let ci = 0; ci < chars.length; ci++) {
          buffer += chars[ci];
          try {
            const desc2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (desc2 && typeof desc2.set === 'function') desc2.set.call(input, buffer);
            else input.value = buffer;
          } catch (_) { input.value = buffer; }
          // 派发 beforeinput（模拟 composition）+ input + keydown/keyup（ascii 范围）
          try {
            try { input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: chars[ci], inputType: 'insertText' })); } catch (_) { /* ignore */ }
            try { input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: chars[ci], inputType: 'insertText' })); } catch (_) { /* ignore */ }
            const kUpper = (chars[ci] || '').toUpperCase();
            try { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: chars[ci] || '', code: ('Key' + kUpper), keyCode: (chars[ci] || '').charCodeAt(0) } as any)); } catch (_) { /* ignore */ }
            try { input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: chars[ci] || '', code: ('Key' + kUpper) } as any)); } catch (_) { /* ignore */ }
          } catch (_) { /* ignore */ }
          if (ci === 1 || ci === chars.length - 1) sleepSync(20); // 开头/结尾多 spin 一下
        }
        // 结尾发一次 compositionend（中文输入法合成结束）
        try { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: raw } as any)); } catch (_) { /* ignore */ }
        try { input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: raw, inputType: 'insertCompositionText' })); } catch (_) { /* ignore */ }

        // --- Step 3: 等推荐面板出现（spin 300ms，每 50ms 尝试点一下） ---
        let dropdownOk = false;
        for (let w = 0; w < 6; w++) {
          if (clickFirstDropdown(raw)) { dropdownOk = true; res.dropdownClicked++; sleepSync(60); break; }
          sleepSync(50);
        }
        if (!dropdownOk) {
          // --- Step 4: 没下拉 / 点了没生效 → 键盘确认 4 连发 ---
          try {
            const keys: any[] = [
              { key: 'Enter', code: 'Enter', kc: 13 },
              { key: ' ', code: 'Space', kc: 32 },
              { key: ',', code: 'Comma', kc: 188 },
              { key: 'Enter', code: 'Enter', kc: 13 },
            ];
            for (let ki = 0; ki < keys.length; ki++) {
              try {
                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keys[ki].key, code: keys[ki].code, keyCode: keys[ki].kc } as any));
                input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: keys[ki].key, code: keys[ki].code, keyCode: keys[ki].kc } as any));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: keys[ki].key, code: keys[ki].code } as any));
              } catch (_) { /* ignore */ }
              sleepSync(15);
            }
          } catch (_) { /* ignore */ }
          try {
            if (typeof input.blur === 'function') input.blur();
          } catch (_) { /* ignore */ }
        }

        // --- Step 5: 判断是否添加成功 ---
        const afterI = countTags();
        if (afterI > beforeI) {
          res.added++;
          res.addedTags.push(raw + (dropdownOk ? '|dropdown' : '|keyboard'));
          finalTagsAdded.push(raw);
          continue;
        }

        // --- Step 6: 终极兜底：手工在 .arco-input-tag-inner 里插入一个 tag 节点（避免提交时提交不到） ---
        try {
          const tagInner = wrapper.querySelector('.arco-input-tag-inner');
          if (tagInner) {
            // 插入前先去重：如果已存在同名 arco-tag-content 内容 == #raw，就不插
            try {
              const existTexts: string[] = [];
              const existList = wrapper.querySelectorAll('.arco-tag-checked .arco-tag-content, .arco-input-tag-tag .arco-tag-content');
              if (existList) { for (let e = 0; e < existList.length; e++) { const t = String((existList[e] && (existList[e].textContent || existList[e].innerText)) || '').trim().replace(/^#/, ''); if (t) existTexts.push(t); } }
              if (existTexts.indexOf(raw) !== -1) {
                // 已存在 → 当作 added 成功，不用再插，但把 input.value 清掉避免残留
                try {
                  const descClean = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                  if (descClean && typeof descClean.set === 'function') descClean.set.call(input, ''); else input.value = '';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  if (typeof input.blur === 'function') input.blur();
                } catch (_) { /* ignore */ }
                res.added++;
                res.addedTags.push(raw + '|dedup-already-exist');
                finalTagsAdded.push(raw);
                continue;
              }
            } catch (_) { /* ignore */ }
            if (insertTagDomFallback(tagInner, raw)) {
              const afterFb = countTags();
              // 插入后强制清空输入框 value + 派发 change/input + blur  避免 input 里残留文本被用户误看成「第三个标签」
              try {
                const descClean2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                if (descClean2 && typeof descClean2.set === 'function') descClean2.set.call(input, ''); else input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof input.blur === 'function') input.blur();
                // 再让推荐面板消失（有些实现推荐面板是跟着 input focus 保持的，失焦不消失就 click body）
                try {
                  const body = document.body;
                  if (body && typeof body.dispatchEvent === 'function') {
                    body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
                    body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 2, clientY: 2 }));
                  }
                } catch (_) { /* ignore */ }
              } catch (_) { /* ignore */ }
              if (afterFb > beforeI) {
                res.added++;
                res.addedTags.push(raw + '|fallback-dom');
                finalTagsAdded.push(raw);
                continue;
              }
            }
          }
        } catch (_) { /* ignore */ }

        res.skipped++;
        res.errors.push('tag[' + i + ']=' + raw + ' not added after all steps (dropdown=' + dropdownOk + ') after=' + afterI + ' before=' + beforeI);
      }

      // 函数末尾兜底：再清一次输入框 + blur + 关推荐面板（防止前几次残留的 input 文本）
      try {
        const descCleanFinal: any = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (descCleanFinal && typeof descCleanFinal.set === 'function') (descCleanFinal.set as any).call(input, ''); else input.value = '';
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* ignore */ }
        try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { /* ignore */ }
        try { if (typeof input.blur === 'function') input.blur(); } catch (_) { /* ignore */ }
      } catch (_) { /* ignore */ }

      // 最后同步隐藏 input（如果有）
      try {
        const collected: string[] = [];
        try {
          const all = wrapper.querySelectorAll('.arco-tag-checked .arco-tag-content, .arco-input-tag-tag .arco-tag-content');
          if (all) {
            for (let q = 0; q < all.length; q++) {
              const t = String((all[q] && (all[q].textContent || all[q].innerText)) || '').trim().replace(/^#/, '');
              if (t) collected.push(t);
            }
          }
        } catch (_) { /* ignore */ }
        syncHiddenInput(collected.concat(finalTagsAdded));
      } catch (_) { /* ignore */ }

      res.afterCount = countTags();
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [tags || []]);
}

/**
 * 视频封面「是否已上传」探测（不点击，只读）
 *   实际 DOM：.form-item-poster（required） > .xigua-poster-editor >
 *     - .fake-upload-trigger 说明还没上传
 *     - 如果已上传，通常 fake-upload-trigger 会消失，取而代之是 <img class="poster-img"> / .poster-preview 之类（以字节常用命名探测）
 */
function buildProbeXiguaVideoPosterScript(): string {
  const runner = function () {
    const res: any = {
      err: null,
      formItemFound: false,
      required: false,
      editorFound: false,
      fakeUploadTrigger: false,
      hasImage: false,
      imageSrc: '',
      fileInputs: 0,
      fileAccepts: [] as string[],
      hasDeleteBtn: false,
      diag: {} as any,
    };
    try {
      const item = document.querySelector('.video-form-wrapper .form-item-poster, .form-item-poster') as any;
      if (!item) return JSON.stringify(res);
      res.formItemFound = true;
      try { res.required = !!item.querySelector('.video-form-item-label.required') || item.className && String(item.className || '').indexOf('required') !== -1; } catch (_) { /* ignore */ }
      const ed = item.querySelector('.xigua-poster-editor') as any;
      if (ed) {
        res.editorFound = true;
        res.fakeUploadTrigger = !!ed.querySelector('.fake-upload-trigger');
        const imgs = ed.querySelectorAll('img');
        if (imgs && imgs.length > 0) {
          for (let i = 0; i < imgs.length; i++) {
            try {
              const src = imgs[i].getAttribute ? (imgs[i].getAttribute('src') || '') : '';
              if (src && /^(blob:|https?:|data:)/i.test(src)) {
                res.hasImage = true; res.imageSrc = String(src).slice(0, 200); break;
              }
            } catch (_) { /* ignore */ }
          }
        }
        // ★ 竖版 portrait 封面编辑器：<div class="xigua-poster-editor portrait"><div class="bg" style="background-image: url('blob:.../xxx')"></div></div>
        //   封面 blob 不在 <img>，而在 div.bg 的 background-image 里，必须解析 style
        if (!res.hasImage) {
          const bgDivs = ed.querySelectorAll ? ed.querySelectorAll('.bg, [class*="bg"], [style*="background-image"]') : [];
          for (let bi = 0; bi < bgDivs.length; bi++) {
            try {
              const d: any = bgDivs[bi];
              const styleStr = String(((d.currentStyle || d.style) && ((d.currentStyle && d.currentStyle.backgroundImage) || (d.style && d.style.backgroundImage))) || (d.getAttribute && d.getAttribute('style') || ''));
              const bgMatch = styleStr.match(/url\(\s*['"]?\s*(blob:[^'")\s]+|https?:[^'")\s]+|data:[^'")\s]+)/i);
              if (bgMatch && bgMatch[1]) {
                res.hasImage = true; res.imageSrc = String(bgMatch[1]).slice(0, 200);
                res.diag.portraitBgStyle = styleStr.slice(0, 200);
                break;
              }
            } catch (_) { /* ignore */ }
          }
        }
        // 其他可作为「已上传」的节点（字节常用）
        if (!res.hasImage) {
          const cls = String(ed.className || ed.innerHTML || '');
          if (/poster-img|poster-preview|uploaded-poster|已上传|重新上传|更换封面/i.test(cls)) {
            res.hasImage = true;
          }
        }
        // ★ 竖版：记录是否含替换按钮（用户提供真实 DOM 有「替换」按钮说明已经有封面编辑器）
        try {
          const modifyBars = ed.querySelectorAll ? ed.querySelectorAll('.xigua-image-modify, .image-modify-btn') : [];
          res.diag.portraitModifyBarCount = modifyBars ? modifyBars.length : 0;
          if (modifyBars && modifyBars.length) {
            const t: string[] = [];
            for (let mi = 0; mi < modifyBars.length; mi++) {
              const txt = String((modifyBars[mi].innerText || modifyBars[mi].textContent || '')).replace(/\s+/g, '').trim().slice(0, 10);
              if (txt) t.push(txt);
            }
            res.diag.portraitModifyBtn = t.join('|');
          }
        } catch (_) { /* ignore */ }
        res.hasDeleteBtn = !!ed.querySelector('.btn.delete, .delete-btn, [class*="delete"], svg[name="icon-close"]');
        const fIns = ed.querySelectorAll('input[type="file"]');
        res.fileInputs = fIns ? fIns.length : 0;
        if (fIns) {
          for (let k = 0; k < fIns.length; k++) {
            try {
              const acc = String((fIns[k] && fIns[k].getAttribute && fIns[k].getAttribute('accept')) || '');
              res.fileAccepts.push(acc.slice(0, 160));
            } catch (_) { /* ignore */ }
          }
        }
      }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner);
}

// ============================================================================================
// 封面上传（toutiao 平台专用，不改动 shared.ts）：在 scopeSelector 作用域内定位 type=file 注入图片
//   - 默认 scopeSelector = .form-item-poster（表单体里的封面上传入口）
//   - 封面本地上传（在 Dialog 弹窗里）时传 scopeSelector = '.Dialog-container'
// ============================================================================================
type UploadPosterViaCDPResult = {
  ok: boolean;
  reason?: string;
  injected?: boolean;
  triggered?: number;
  acceptFound?: string;
  fallback?: string;
};
async function uploadPosterViaCDP(
  win: BrowserWindow,
  posterFilePath: string,
  plog: any,
  scopeSelector: string = '.form-item-poster, .video-form-item.form-item-poster',
): Promise<UploadPosterViaCDPResult> {
  const source = 'B-poster';
  const scopedQuery = String(scopeSelector || '') || '.form-item-poster, .video-form-item.form-item-poster';
  const scopeJSON = JSON.stringify(scopedQuery);
  try {
    if (!posterFilePath || typeof posterFilePath !== 'string') return { ok: false, reason: 'no-poster-path' };
    try {
      const fs = require('fs');
      if (!fs.existsSync(posterFilePath)) return { ok: false, reason: 'poster-not-exists:' + String(posterFilePath).slice(0, 300) };
    } catch (_) { /* allow dev env without fs check */ }
    // 1) 在 scope 内找 accept 包含 image / png / jpg / jpeg / webp / gif 的 type=file（递归 shadow DOM）
    const locateScript = `
      ;(function(){
        try {
          var q = ${scopeJSON};
          var scope = null;
          try { scope = document.querySelector(q); } catch (e) {}
          if (!scope) scope = document.body;
          var res = { scopeFound:!!scope, inputs:[] };
          function walk(root){
            if(!root) return;
            try {
              var list = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
              for (var i=0;i<list.length;i++) res.inputs.push(list[i]);
            } catch (e) {}
            try {
              var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
              for (var j=0;j<all.length;j++) {
                try {
                  if (all[j] && all[j].shadowRoot) walk(all[j].shadowRoot);
                } catch (e2) {}
              }
            } catch (e3) {}
          }
          walk(scope);
          var seen = {}; var uniq = [];
          for (var k=0;k<res.inputs.length;k++){
            var el = res.inputs[k];
            var key = (el && el.getAttribute && el.getAttribute('name') || '') + '|' + (el && el.getAttribute && el.getAttribute('accept') || '') + '|' + k;
            if (!seen[key]) { seen[key]=1; uniq.push(el); }
          }
          res.inputs = uniq.map(function(el){
            return {
              accept: String((el && el.getAttribute && el.getAttribute('accept')) || '').slice(0,200),
              cls: String((el && el.getAttribute && el.getAttribute('class')) || '').slice(0,120),
              acceptImage: /image\/*|\.png|\.jpe?g|\.webp|\.gif|\.bmp|\.tiff?/i.test(String((el && el.getAttribute && el.getAttribute('accept')) || ''))
            };
          });
          return JSON.stringify(res);
        } catch(e){ return JSON.stringify({err:String(e).slice(0,300)}) }
      })();
    `;
    const locateRaw: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: locateScript, returnByValue: true }).catch(() => null);
    const locateStr = (locateRaw && locateRaw.result && locateRaw.result.value) || '';
    let locateParsed: any = {}; try { locateParsed = JSON.parse(locateStr || '{}'); } catch (_) { /* ignore */ }
    const candidates = Array.isArray(locateParsed.inputs) ? locateParsed.inputs : [];
    if (candidates.length === 0) {
      plog('warn', 'poster-upload', `作用域 ${scopedQuery} 内未找到 file input，throw 降级到 Fallback-B DOM.getDocument 全页搜索… locateRaw=${String(locateStr || '').slice(0, 200)}`);
      // 不是直接 return，而是 throw 一个标记，让 catch 分支 fall through 到 Fallback-B
      // @ts-ignore
      throw new Error('__SCOPE_NO_INPUT__:' + scopedQuery + '|' + String(locateStr || '').slice(0, 200));
    }
    const firstImg = candidates.findIndex((c: any) => c && c.acceptImage);
    const targetIdx = firstImg >= 0 ? firstImg : 0;
    const targetAccept = (candidates[targetIdx] && candidates[targetIdx].accept) || '';
    plog('info', 'poster-upload', `作用域 ${scopedQuery} 定位到 ${candidates.length} 个 file input，优先选 #${targetIdx} (accept=${targetAccept.slice(0, 80)})`);

    // 2) 取 scope 内第 targetIdx 个 input 的 objectId
    const objectScript = `
      ;(function(){
        try {
          var q = ${scopeJSON};
          var scope = null;
          try { scope = document.querySelector(q); } catch(e){}
          if (!scope) scope = document.body;
          function walk(root, arr){
            if(!root) return arr;
            try {
              var list = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
              for (var i=0;i<list.length;i++) arr.push(list[i]);
            } catch(e){}
            try {
              var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
              for (var j=0;j<all.length;j++) try { if (all[j] && all[j].shadowRoot) walk(all[j].shadowRoot, arr); } catch(e2){}
            } catch(e3){}
            return arr;
          }
          var arr = []; walk(scope, arr);
          var seen = {}; var uniq = [];
          for (var k=0;k<arr.length;k++){
            var el = arr[k];
            var key = (el && el.getAttribute && el.getAttribute('name') || '') + '|' + (el && el.getAttribute && el.getAttribute('accept') || '') + '|' + k;
            if (!seen[key]) { seen[key]=1; uniq.push(el); }
          }
          var idx = ${targetIdx};
          if (uniq[idx]) return uniq[idx]; else return null;
        } catch(e){ return null; }
      })();
    `;
    const evalRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: objectScript, objectGroup: 'xiguaPoster' }).catch(() => null);
    const objId = evalRes && evalRes.result && evalRes.result.objectId ? evalRes.result.objectId : undefined;
    if (!objId) return { ok: false, reason: 'poster-input-objectId-null' };

    // 3) setFileInputFiles
    try {
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { objectId: objId, files: [posterFilePath] });
    } catch (sfErr: any) {
      try {
        const doc: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }).catch(() => null);
        if (!doc || !doc.root) return { ok: false, reason: 'poster DOM.getDocument failed' };
        const q: any = await win.webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: scopedQuery + ' input[type="file"]',
        }).catch(() => null);
        if (q && q.nodeId) {
          await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [posterFilePath] });
        } else {
          return { ok: false, reason: 'poster setFileInputFiles failed: ' + String((sfErr && sfErr.message) || sfErr).slice(0, 200) };
        }
      } catch (innerErr2: any) {
        return { ok: false, reason: 'poster setFileInputFiles failed2: ' + String((innerErr2 && innerErr2.message) || innerErr2).slice(0, 200) };
      }
    }
    plog('info', 'poster-upload', `setFileInputFiles 成功，接下来派发 change/input 事件…`);

    // 4) 通过 Runtime.callFunctionOn 直接派发事件（更稳定，不走 selector）
    try {
      await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: objId,
        functionDeclaration: `function() {
          try { this.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
          try { this.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
          try { this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch (_) {}
          try { this.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: null })); } catch (_) {}
          try { this.blur && this.blur(); } catch (_) {}
        }`,
      }).catch(() => null);
    } catch (_) { /* ignore */ }
    // 再通过 runtime evaluate 补一轮事件（作用域限定在 scopedQuery）
    let triggered = 0;
    try {
      const evtRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `
          ;(function(){
            try {
              var q = ${scopeJSON};
              var scope = document.querySelector(q) || document.body;
              var inputs = scope.querySelectorAll ? scope.querySelectorAll('input[type="file"]') : document.querySelectorAll('input[type="file"]');
              var t=0;
              for (var i=0;i<inputs.length;i++){
                var fi = inputs[i];
                var acc = String((fi.getAttribute && fi.getAttribute('accept')) || '').toLowerCase();
                if (/image\/*|\.png|\.jpe?g|\.webp|\.gif|\.bmp|\.tiff?/i.test(acc) || !acc) {
                  try { fi.dispatchEvent(new Event('change',{bubbles:true})); } catch(_){}
                  try { fi.dispatchEvent(new Event('input',{bubbles:true})); } catch(_){}
                  t++;
                }
              }
              return JSON.stringify({triggered:t, total:inputs.length});
            } catch (e) { return JSON.stringify({error:String(e).slice(0,200)}); }
          })();
        `,
        returnByValue: true,
      }).catch(() => null);
      const str = evtRes && evtRes.result && evtRes.result.value;
      let p: any = {}; try { p = str ? JSON.parse(str) : {}; } catch (_) { /* ignore */ }
      triggered = Number(p.triggered || 0);
    } catch (_) { /* ignore */ }
    try { await win.webContents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'xiguaPoster' }).catch(() => null); } catch (_) { /* ignore */ }
    // 如果 scope 内流程走到这里（objId 存在或 DOM.querySelector fallback 成功），先直接 return success；Fallback-B 只在 scope 内 locate/注入失败时才在前面触发
    // - 实际上如果 targetIdx >=0 且 setFileInputFiles 没抛错（或 DOM.querySelector fallback 成功），上面 try 块就正常执行完了，因此这里默认返回 scope-ok
    return { ok: true, injected: true, triggered, acceptFound: targetAccept };
  } catch (scopeTopErr: any) {
    // ignore, fall through to Fallback-B
  }

  // ===== Fallback-B：作用域内 locateScript 找不到 input（比如本地上传 tab 惰性渲染，没点云朵 trigger 时 input 还没插入 DOM） =====
  // 直接 CDP DOM.getDocument + pierce:true 递归搜所有 type=file，过滤 accept 含 image 的，取最靠近 scope 的（命中路径包含 Dialog-container / 本地上传的优先级最高）
  plog('warn', 'poster-upload', `作用域内流程失败，走 Fallback-B DOM.getDocument 全页搜索… scope=${scopedQuery}`);
  try {
    const doc: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }).catch(() => null);
    if (doc && doc.root) {
      const rootNodeId = doc.root.nodeId;
      const allFiles: any[] = [];
      const qAll: any = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', { nodeId: rootNodeId, selector: 'input[type="file"]' }).catch(() => null);
      const ids: number[] = (qAll && Array.isArray(qAll.nodeIds)) ? qAll.nodeIds : [];
      plog('info', 'poster-upload', `Fallback-B: DOM.querySelectorAll input[type=file] 全页共 ${ids.length} 个节点`);
      // ========== 关键：通过一次性 Runtime.evaluate，收集每个 input 的 accept + 父链 class（判断是否在 Dialog + byte-upload 下）==========
      //   DOM.getAttributes 只能拿 input 自身属性，看不到父节点。用 JS 一次性扫描更准
      const probeAllScript = `
        ;(function(){
          try {
            var list = document.querySelectorAll('input[type="file"]');
            var out = [];
            for (var idx = 0; idx < list.length; idx++) {
              var inp = list[idx];
              var accept = String((inp.getAttribute && inp.getAttribute('accept')) || '').toLowerCase();
              var cls = String((inp.getAttribute && inp.getAttribute('class')) || '').toLowerCase();
              var name = String((inp.getAttribute && inp.getAttribute('name')) || '').toLowerCase();
              var id = String((inp.getAttribute && inp.getAttribute('id')) || '').toLowerCase();
              // 父链遍历（最多 8 层，找 byte-upload / xigua-upload-poster / Dialog-container / m-poster / upload-trigger-card / 封面 等）
              var parentClsAll = '';
              var cur = inp.parentNode || inp.parentElement;
              var hitByteUpload = 0;
              var hitXiguaPoster = 0;
              var hitDialog = 0;
              var hitTriggerCard = 0;
              var hitFormPoster = 0;
              for (var pl = 0; pl < 8 && cur; pl++) {
                var pCls = '';
                try { pCls = String((cur.getAttribute && cur.getAttribute('class')) || '').toLowerCase(); } catch (_) {}
                if (pCls) parentClsAll += '|' + pCls;
                if (/byte-upload/.test(pCls)) hitByteUpload = 1;
                if (/xigua-upload-poster/.test(pCls) || /upload-thumb-trigger-card/.test(pCls)) { hitXiguaPoster = 1; hitTriggerCard = 1; }
                if (/Dialog-container|m-xigua-dialog|m-poster-upgrade/.test(pCls)) hitDialog = 1;
                if (/form-item-poster|video-form-item-poster/.test(pCls)) hitFormPoster = 1;
                cur = cur.parentNode || cur.parentElement;
              }
              out.push({
                idx: idx,
                accept: accept,
                cls: cls,
                name: name,
                id: id,
                parentClsTail: parentClsAll.slice(0, 500),
                hitByteUpload: hitByteUpload,
                hitXiguaPoster: hitXiguaPoster,
                hitDialog: hitDialog,
                hitTriggerCard: hitTriggerCard,
                hitFormPoster: hitFormPoster,
                acceptMatch: (/image\\/*|\\.png|\\.jpe?g|\\.webp|\\.gif|\\.bmp|\\.tiff?/i.test(accept) || !accept) ? 1 : 0,
              });
            }
            return JSON.stringify({ total: list.length, items: out });
          } catch (e) { return JSON.stringify({ err: String(e).slice(0, 500) }); }
        })();
      `;
      const probeAllRaw: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: probeAllScript, returnByValue: true }).catch(() => null);
      const probeAllStr = (probeAllRaw && probeAllRaw.result && probeAllRaw.result.value) || '';
      let probeAllParsed: any = null; try { probeAllParsed = probeAllStr ? JSON.parse(probeAllStr) : null; } catch (_) { probeAllParsed = null; }
      const probeItems: any[] = (probeAllParsed && Array.isArray(probeAllParsed.items)) ? probeAllParsed.items : [];
      plog('info', 'poster-upload', `Fallback-B: JS probe 成功=${probeItems.length} 个 input, probeStrLen=${probeAllStr.length}`);

      // 如果 JS probe 拿到了数据：用 probe 结果按父链高权重评分，拿 nodeId 按 idx 对号
      if (probeItems.length > 0 && probeItems.length === ids.length) {
        for (let pi = 0; pi < probeItems.length; pi++) {
          try {
            const it = probeItems[pi];
            if (!it.acceptMatch) continue;
            let score = 0;
            if (/image/.test(it.accept)) score += 25;
            if (/poster|cover|upload|image|picture|thumbnail|封面/.test(it.cls + it.name + it.id)) score += 15;
            // ★ 父链命中才是关键！高权重（用户真实 DOM 父链一定是 Dialog-container > ... > byte-upload.xigua-upload-poster-trigger）
            if (it.hitDialog) score += 80;
            if (it.hitByteUpload) score += 120;
            if (it.hitXiguaPoster || it.hitTriggerCard) score += 200;
            if (it.hitFormPoster) score += 100;
            allFiles.push({ nodeId: ids[pi], accept: it.accept, score, cls: it.cls, parentTail: (it.parentClsTail || '').slice(0, 300) });
          } catch (_) { /* ignore */ }
        }
      }
      // Fallback：JS probe 失败或长度不匹配，退回 DOM.getAttributes 模式
      if (allFiles.length === 0) {
        for (let nid of ids) {
          try {
            const attrsResp: any = await win.webContents.debugger.sendCommand('DOM.getAttributes', { nodeId: nid }).catch(() => null);
            const attrsArr: string[] = (attrsResp && Array.isArray(attrsResp.attributes)) ? attrsResp.attributes : [];
            const amap: any = {};
            for (let ai = 0; ai + 1 < attrsArr.length; ai += 2) amap[attrsArr[ai]] = String(attrsArr[ai + 1] || '');
            const accept = String(amap.accept || '').toLowerCase();
            const isImage = /image\/*|\.png|\.jpe?g|\.webp|\.gif|\.bmp|\.tiff?/i.test(accept) || !accept;
            if (!isImage) continue;
            let score = 0;
            if (/image/.test(accept)) score += 25;
            const cls = String(amap.class || '').toLowerCase();
            const name = String(amap.name || '').toLowerCase();
            if (/poster|cover|upload|image|picture|thumbnail|封面/i.test(cls + name)) score += 15;
            allFiles.push({ nodeId: nid, accept, score, cls, name });
          } catch (_) { /* ignore */ }
        }
      }
      if (allFiles.length > 0) {
        allFiles.sort((a, b) => b.score - a.score);
        plog('info', 'poster-upload', `Fallback-B 找到 ${allFiles.length} 个候选 input，选中 #0: nodeId=${allFiles[0].nodeId} accept=${allFiles[0].accept.slice(0, 80)} score=${allFiles[0].score}`);
        try {
          await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: allFiles[0].nodeId, files: [posterFilePath] });
          try {
            const resolved: any = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: allFiles[0].nodeId, objectGroup: 'xiguaPosterFb' }).catch(() => null);
            if (resolved && resolved.object && resolved.object.objectId) {
              await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
                objectId: resolved.object.objectId,
                functionDeclaration: `function() {
                  try { this.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
                  try { this.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
                  try { this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch (_) {}
                  try { this.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: null })); } catch (_) {}
                  try { this.blur && this.blur(); } catch (_) {}
                }`,
              }).catch(() => null);
            }
          } catch (_) { /* ignore */ }
          let tr2 = 0;
          try {
            const evtRaw2: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
              expression: `;(function(){try{var list=document.querySelectorAll('input[type="file"]');var t=0;for(var i=0;i<list.length;i++){var fi=list[i];var a=String((fi.getAttribute&&fi.getAttribute('accept'))||'').toLowerCase();if(/image|png|jpe?g|webp|gif|bmp|tiff?/i.test(a)||!a){try{fi.dispatchEvent(new Event('change',{bubbles:true}))}catch(_){}try{fi.dispatchEvent(new Event('input',{bubbles:true}))}catch(_){}t++}}return JSON.stringify({triggered:t,total:list.length})}catch(e){return JSON.stringify({error:String(e).slice(0,200)})}})();`,
              returnByValue: true,
            }).catch(() => null);
            const p2 = evtRaw2 && evtRaw2.result && evtRaw2.result.value ? (() => { try { return JSON.parse(evtRaw2.result.value); } catch (_) { return {}; } })() : {};
            tr2 = Number(p2.triggered || 0);
          } catch (_) { /* ignore */ }
          try { await win.webContents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'xiguaPosterFb' }).catch(() => null); } catch (_) { /* ignore */ }
          return { ok: true, injected: true, triggered: tr2, acceptFound: allFiles[0].accept, fallback: 'DOM.getDocument' };
        } catch (fbErr: any) {
          return { ok: false, reason: 'Fallback-B setFileInputFiles failed: ' + String((fbErr && fbErr.message) || fbErr).slice(0, 300) };
        }
      }
    }
  } catch (fbTopErr: any) {
    return { ok: false, reason: 'Fallback-B fatal: ' + String((fbTopErr && fbTopErr.message) || fbTopErr).slice(0, 300) };
  }
  return { ok: false, reason: 'no-input-found-in-scope-and-fallbacks scope=' + scopedQuery };
}

// ------ 封面弹窗辅助脚本 ------
/** 点击 fake-upload-trigger 打开上传弹窗（封面入口）；或在本地上传 tab 点击云朵区域 trigger（强制让 file input 挂载） */
function buildOpenXiguaPosterDialogScript(scope: 'coverEntry' | 'localUploadArea' = 'coverEntry'): string {
  const runner = function (scopeVal: string) {
    const res: any = { err: null, foundTrigger: false, clicked: false, beforeDialogVisible: false };
    try {
      if (scopeVal === 'localUploadArea') {
        // 点击「本地上传」tab 里的上传触发区域
        // ★ 用户提供真实 DOM：<div class="byte-upload xigua-upload-poster-trigger upload-thumb-trigger-card">
        //       <input type=file accept="image/jpg,..."> <div class="byte-upload-trigger"><div class="byte-upload-trigger-picture"><div><svg ...
        // 优先级最高：用户真实 DOM 的精确类名（.byte-upload-trigger 是真正响应 click 的可视元素）
        const candidates = [
          '.Dialog-container .byte-upload.xigua-upload-poster-trigger.upload-thumb-trigger-card .byte-upload-trigger',
          '.Dialog-container .m-xigua-dialog .byte-upload.upload-thumb-trigger-card .byte-upload-trigger',
          '.Dialog-container .byte-upload.xigua-upload-poster-trigger .byte-upload-trigger',
          '.Dialog-container [class*="upload-trigger-card"] .byte-upload-trigger',
          '.Dialog-container [class*="upload-trigger-card"]',
          '.Dialog-container .byte-upload [class*="byte-upload-trigger"]',
          '.Dialog-container .m-one-peace',
          '.Dialog-container [class*="upload-trigger"]',
          '.Dialog-container [class*="drop-zone"]',
          '.Dialog-container [class*="peace"]',
          '.Dialog-container .body .detail > :first-child',
          '.Dialog-container .m-xigua-dialog .detail :first-child',
        ];
        for (let i = 0; i < candidates.length; i++) {
          try {
            const t: any = document.querySelector(candidates[i]);
            if (!t) continue;
            res.foundTrigger = true;
            try {
              t.click();
              if (typeof t.dispatchEvent === 'function') {
                try { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
                try { t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
                try { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
                try { t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
              }
              res.clicked = true; break;
            } catch (_) { /* ignore */ }
          } catch (_) { /* ignore */ }
        }
        return JSON.stringify(res);
      }
      // coverEntry: 表单里「上传封面」trigger（竖版 small-video 时，编辑器已经 portrait 渲染好了，需要点「替换」而不是 fakeUploadTrigger）
      try {
        const d1 = document.querySelector('.Dialog-container .m-xigua-dialog.m-poster-upgrade');
        res.beforeDialogVisible = !!d1;
      } catch (_) { /* ignore */ }
      if (res.beforeDialogVisible) return JSON.stringify(res);
      // ★ 优先：竖版 portrait 编辑器（small-video）已经渲染时，点「.xigua-image-modify .image-modify-btn」文本='替换'
      //   用户真实 DOM：<div class="xigua-image-modify portrait"><span class="image-modify-btn">编辑</span>...<span class="image-modify-btn">替换</span></div>
      const portraitModifys = document.querySelectorAll('.form-item-poster .xigua-image-modify .image-modify-btn, .form-item-poster .image-modify-btn');
      if (portraitModifys && portraitModifys.length) {
        let pickedPortraitBtn: any = null;
        const allBtns: string[] = [];
        for (let mbi = 0; mbi < portraitModifys.length; mbi++) {
          const b: any = portraitModifys[mbi];
          const txt = String((b.innerText || b.textContent || '')).replace(/\s+/g, '').trim();
          allBtns.push(txt.slice(0, 10));
          if (/替换|换封面|换图|修改|重新上传|更换封面/.test(txt)) { pickedPortraitBtn = b; break; }
        }
        if (pickedPortraitBtn) {
          res.foundTrigger = true;
          res.diag = { portraitBtn: allBtns.join('|') };
          try {
            if (typeof pickedPortraitBtn.focus === 'function') { try { pickedPortraitBtn.focus(); } catch (_) {} }
            try { pickedPortraitBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
            try { pickedPortraitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 })); } catch (_) {}
            try { if (typeof pickedPortraitBtn.click === 'function') { pickedPortraitBtn.click(); res.clicked = true; } } catch (_) {}
            try { pickedPortraitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
            try { pickedPortraitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })); res.clicked = true; } catch (_) {}
            try { pickedPortraitBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
          } catch (_) { /* ignore */ }
          return JSON.stringify(res);
        }
      }
      // 兜底：横版/未上传过封面的 fakeUploadTrigger 入口
      const triggerCandidates = [
        '.form-item-poster .fake-upload-trigger',
        '.form-item-poster .xigua-poster-editor .fake-upload-trigger',
        '.form-item-poster [class*="upload-trigger"]',
        '.form-item-poster [class*="poster-editor"] [class*="trigger"]',
        '.video-form-wrapper .form-item-poster .fake-upload-trigger',
      ];
      for (let i = 0; i < triggerCandidates.length; i++) {
        try {
          const t: any = document.querySelector(triggerCandidates[i]);
          if (!t) continue;
          res.foundTrigger = true;
          try {
            t.click();
            if (typeof t.dispatchEvent === 'function') {
              try { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
              try { t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
              try { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ }
            }
            res.clicked = true; break;
          } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }
      }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [scope]);
}

/**
 * 探测封面弹窗状态：
 *  - dialog1 封面截取/本地上传 两 tab
 *  - dialog2 封面编辑器（含 确定 按钮）
 */
function buildProbeXiguaPosterDialogStateScript(): string {
  const runner = function () {
    const res: any = {
      err: null,
      anyVisible: false,
      dialog1: null as any,
      dialog2: null as any,
      // ★ dialogFinal：封面编辑器点击确定后弹出的二次确认弹窗
      //   DOM: <div class="Dialog-container"><div class="m-xigua-dialog m-modal m-dialog-edit">...</div></div>
      //   内容：完成后无法继续编辑，是否确定完成？
      //   按钮：<button class="m-button">取消</button> <button class="m-button red undefined">确定</button>
      dialogFinal: null as any,
    };
    try {
      // ============ dialogFinal（二次确认弹窗）优先探测：只要 Dialog-container 有 m-dialog-edit，就优先记为可见 ============
      const allFinal = document.querySelectorAll('.Dialog-container .m-xigua-dialog.m-dialog-edit, .Dialog-container .m-dialog-edit');
      if (allFinal && allFinal.length > 0) {
        for (let i = 0; i < allFinal.length; i++) {
          const dlg = allFinal[i] as any;
          // 看是否真的可见：getBoundingClientRect 宽高>0 或 有 mask 或 有 父容器样式
          let vis = false;
          try {
            const r = dlg.getBoundingClientRect();
            if (r.width > 50 && r.height > 50) vis = true;
          } catch (_) {}
          if (!vis) {
            const p = dlg.closest ? dlg.closest('.Dialog-container') : null;
            try {
              if (p) {
                const r2 = p.getBoundingClientRect();
                if (r2.width > 0 && r2.height > 0) vis = true;
                if (p.querySelector('.mask')) vis = true;
              }
            } catch (_) {}
          }
          if (!vis) continue;
          res.anyVisible = true;
          const okBtnRaw = dlg.querySelector('button.m-button.red, button.m-button.primary, .footer .m-button:last-child, .footer button.red, .footer button.primary');
          const cancelBtnRaw = dlg.querySelector('button.m-button:not(.red):not(.primary), .footer .m-button:first-child');
          const okDisabled = okBtnRaw ? (!!okBtnRaw.disabled || (okBtnRaw.getAttribute && (okBtnRaw.getAttribute('disabled') !== null || String(okBtnRaw.getAttribute('aria-disabled') || '') === 'true')) || /opacity:\s*0(\.0)?\s*;/.test(String(okBtnRaw.style && okBtnRaw.style.cssText || ''))) : true;
          const bodyTextRaw = (dlg.querySelector ? (dlg.querySelector('.body, .content .body, .m-content .body') || dlg) : dlg);
          const bodyTxt = String((bodyTextRaw && (bodyTextRaw.innerText || bodyTextRaw.textContent || '')) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          res.dialogFinal = {
            visible: true,
            text: bodyTxt,
            hasOk: !!okBtnRaw,
            okDisabled,
            okText: String((okBtnRaw && (okBtnRaw.innerText || okBtnRaw.textContent || '')) || '').replace(/\s+/g, ' ').trim().slice(0, 20),
            cancelText: String((cancelBtnRaw && (cancelBtnRaw.innerText || cancelBtnRaw.textContent || '')) || '').replace(/\s+/g, ' ').trim().slice(0, 20),
            dialogCls: String((dlg.getAttribute && dlg.getAttribute('class')) || '').slice(0, 100),
          };
          break;
        }
      }
      // ============ dialog1/dialog2：封面截取/本地上传 + 编辑器（m-poster-upgrade / xigua-image-editor-core）============
      const all = document.querySelectorAll('.Dialog-container');
      if (all && all.length) {
        for (let i = 0; i < all.length; i++) {
          const container = all[i] as any;
          const mDialog: any = container.querySelector('.m-xigua-dialog.m-poster-upgrade');
          if (!mDialog) continue;
          const isEditor = /xigua-image-editor-core/.test(String(mDialog.className || ''));
          const maskVisible = !!container.querySelector('.mask');
          const anyVisible = maskVisible || (container.offsetWidth | 0) > 0;
          if (!anyVisible) continue;
          res.anyVisible = true;
          if (isEditor) {
            // Dialog2：编辑器
            const sureBtn: any = mDialog.querySelector('.footer-btns .btns .btn-sure, .footer-btns .btn-sure, .footer-btns button.btn-sure, .footer .m-button.red, .footer .m-button.primary, .footer button.red, .footer button.primary');
            const cancelBtn: any = mDialog.querySelector('.footer-btns .btns .btn-cancel');
            const disabled = sureBtn
              ? (
                  !!sureBtn.disabled ||
                  (sureBtn.getAttribute && sureBtn.getAttribute('disabled') !== null) ||
                  (sureBtn.getAttribute && String(sureBtn.getAttribute('aria-disabled') || '') === 'true') ||
                  /opacity:\s*0(\.0)?\s*;/.test(String(sureBtn.style && sureBtn.style.cssText || ''))
                )
              : true;
            res.dialog2 = {
              visible: true,
              hasConfirm: !!sureBtn,
              confirmDisabled: disabled,
              confirmText: String((sureBtn && (sureBtn.innerText || sureBtn.textContent || '')) || '').slice(0, 30),
              hasCancel: !!cancelBtn,
            };
          } else {
            // Dialog1：封面截取 / 本地上传
            const headers: any = mDialog.querySelectorAll('.header li');
            let selectedTab = '';
            let snapshotIdx = -1, localIdx = -1;
            const tabTexts: string[] = [];
            if (headers) {
              for (let k = 0; k < headers.length; k++) {
                const h = headers[k] as any;
                const txt = String((h.innerText || h.textContent || '')).replace(/\s+/g, '').trim();
                tabTexts.push(txt);
                const isSelected = /selected/.test(String(h.className || ''));
                if (isSelected) {
                  if (/封面|截取/.test(txt) || txt === '封面截取') selectedTab = 'snapshot';
                  else if (/本地|上传/.test(txt) || txt === '本地上传') selectedTab = 'local';
                }
                if (/封面|截取/.test(txt) || txt === '封面截取') snapshotIdx = k;
                if (/本地|上传/.test(txt) || txt === '本地上传') localIdx = k;
              }
            }
            const footer: any = mDialog.querySelector('.footer');
            // ★ 真实DOM里下一步是 <div class="m-button red cannot-click"> — 必须包含 .m-button 本身（不局限 button 元素）
            const nextBtn: any = footer ? footer.querySelector('.m-button.red, .m-button.primary, button.primary, button.red, .footer .m-button, .footer .m-button:last-child') : null;
            // ★ nextDisabled 更完整检测（核心：真实DOM禁用态 class=cannot-click）
            let nextDisabled = true;
            let nextComputedOpacity = 1, nextPointerEvents = 'auto', nextAriaDisabled = '';
            let nextHasCannotClick = false, nextCls = '';
            if (nextBtn) {
              nextCls = String(nextBtn.className || '').slice(0, 200);
              nextHasCannotClick = /cannot-click|cannotclick|disabled/i.test(nextCls); // ★★ 核心：真实禁用 class
              const attrsDisabled = !!nextBtn.disabled || (nextBtn.getAttribute && nextBtn.getAttribute('disabled') !== null);
              nextAriaDisabled = nextBtn.getAttribute ? String(nextBtn.getAttribute('aria-disabled') || '') : '';
              const ariaDisabled = nextAriaDisabled === 'true';
              const cssText = String(nextBtn.style && nextBtn.style.cssText || '');
              const inlineOpacityZero = /opacity:\s*0(\.0)?\s*;/.test(cssText);
              const inlinePE = /pointer-events:\s*none\s*;/.test(cssText);
              let computedOpacityOk = true, computedPEOk = true;
              try {
                if (typeof window !== 'undefined' && window.getComputedStyle) {
                  const cs = window.getComputedStyle(nextBtn);
                  nextComputedOpacity = parseFloat(String(cs.opacity || '1'));
                  nextPointerEvents = String(cs.pointerEvents || 'auto');
                  if (isNaN(nextComputedOpacity)) nextComputedOpacity = 1;
                  if (nextComputedOpacity < 0.5) computedOpacityOk = false;
                  if (nextPointerEvents === 'none') computedPEOk = false;
                }
              } catch (_) { /* ignore */ }
              nextDisabled = nextHasCannotClick || attrsDisabled || ariaDisabled || inlineOpacityZero || inlinePE || !computedOpacityOk || !computedPEOk;
            }
            const fileInputs = mDialog.querySelectorAll ? mDialog.querySelectorAll('input[type="file"]') : [];
            // ★ snapshotReady：封面截取 tab 下的预览缩略图是否真正加载好（真实DOM：解析中→.m-loading，解析成功→.m-one-peace > ul.img-list > li > img）
            let snapshotReady = false;
            let snapshotHasPreview = false;
            let snapshotLoadingVisible = false;
            let snapshotHasOnePeace = false;   // 真实DOM：解析成功才出现的容器 class
            let snapshotHasMLoading = false;    // 真实DOM：解析中的 class=m-loading
            let snapshotPreviewW = 0, snapshotPreviewH = 0;
            let snapshotThumbImgs = 0, snapshotThumbCanvas = 0, snapshotThumbBgImg = 0;
            try {
              // ★ 真实DOM层级：m-poster-upgrade > .m-content > .content > .body > .detail > [.m-loading / .m-one-peace]
              //   必须优先查 .detail 内部才是真正内容区
              const contentArea: any = mDialog.querySelector('.body .detail, .detail, .body .m-one-peace, .m-one-peace, .content, .body, .m-content, .snapshot-area, .poster-snapshot, .snapshot-wrap, .cover-snapshot, .preview-area');
              if (contentArea) {
                try { const r = contentArea.getBoundingClientRect(); snapshotPreviewW = r.width | 0; snapshotPreviewH = r.height | 0; } catch (_) {}
                // ★ 真实DOM显式 class 判定：
                snapshotHasOnePeace = !!contentArea.querySelector('.m-one-peace');
                snapshotHasMLoading = false;
                const mLoadingEls = contentArea.querySelectorAll('.m-loading');
                if (mLoadingEls && mLoadingEls.length > 0) {
                  for (let li2 = 0; li2 < mLoadingEls.length; li2++) {
                    const l2: any = mLoadingEls[li2];
                    try {
                      if (typeof window !== 'undefined' && window.getComputedStyle) {
                        const cs = window.getComputedStyle(l2);
                        if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1) {
                          const r2 = l2.getBoundingClientRect();
                          if (r2.width > 2 && r2.height > 2) { snapshotHasMLoading = true; break; }
                        }
                      }
                    } catch (_) { /* ignore */ }
                  }
                }
                // 找真实图片（真实DOM：ul.img-list li img + img.select-img）
                const imgs = contentArea.querySelectorAll ? contentArea.querySelectorAll('img') : [];
                for (let ii = 0; ii < imgs.length; ii++) {
                  const img = imgs[ii] as any;
                  const s = String(img.src || (img.getAttribute && img.getAttribute('src')) || '').trim();
                  // blob: 链接 + http(s) 外链都算真实图，排除 svg loading/base64 占位
                  if (s && s.length > 8 && !/^data:image\/svg.*loading|^data:image.*placeholder|about:blank|^$/i.test(s)) {
                    snapshotThumbImgs++;
                  }
                }
                const canvases = contentArea.querySelectorAll ? contentArea.querySelectorAll('canvas') : [];
                snapshotThumbCanvas = canvases ? canvases.length : 0;
                const divs = contentArea.querySelectorAll ? contentArea.querySelectorAll('div[style], div.bg, div.poster-bg, div.snapshot-item, div.thumb-item, div.frame-item') : [];
                for (let di = 0; di < divs.length; di++) {
                  const d = divs[di] as any;
                  const st = String((d.style && d.style.cssText) || (d.getAttribute && d.getAttribute('style')) || '');
                  if (/background-image\s*:\s*url\(/i.test(st)) {
                    if (!/url\(\s*["']?\s*data:image\/svg.*loading|url\(\s*["']?\s*data:image.*placeholder|url\(\s*["']?\s*about:blank|url\(\s*["']?\s*["']?\s*\)/i.test(st)) {
                      snapshotThumbBgImg++;
                    }
                  }
                }
                snapshotHasPreview = (snapshotThumbImgs + snapshotThumbCanvas + snapshotThumbBgImg) > 0;
                // loading 类（宽泛 + .m-loading 已单独判定）
                const loaders = contentArea.querySelectorAll ? contentArea.querySelectorAll('.loading:not(.m-loading), .spinner, .spin, .loader, [class*="loading-spinner"], [class*="spinner"], [class*="spin-"]') : [];
                if (loaders && loaders.length > 0) {
                  for (let li = 0; li < loaders.length; li++) {
                    const l = loaders[li] as any;
                    try {
                      if (typeof window !== 'undefined' && window.getComputedStyle) {
                        const cs = window.getComputedStyle(l);
                        if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.1) {
                          const r2 = l.getBoundingClientRect();
                          if (r2.width > 2 && r2.height > 2) { snapshotLoadingVisible = true; break; }
                        }
                      }
                    } catch (_) { /* ignore */ }
                  }
                }
                // .m-loading 也纳入 loading 可见
                if (snapshotHasMLoading) snapshotLoadingVisible = true;
              }
            } catch (_) { /* ignore */ }
            // snapshotReady 组合判定（当前 tab 是 snapshot）：
            //   真实DOM等价：出现 .m-one-peace 且 没有 .m-loading 可见 且 有 img
            if (selectedTab === 'snapshot') {
              if ((snapshotHasPreview || snapshotHasOnePeace) && !snapshotLoadingVisible && !snapshotHasMLoading && (snapshotHasOnePeace || snapshotThumbImgs > 0 || snapshotThumbCanvas > 0 || snapshotThumbBgImg > 0)) {
                snapshotReady = true;
              }
            } else {
              snapshotReady = false;
            }
            res.dialog1 = {
              visible: true,
              selectedTab,
              snapshotIdx, localIdx, tabTexts,
              hasNext: !!nextBtn,
              nextDisabled,
              nextText: String((nextBtn && (nextBtn.innerText || nextBtn.textContent || '')) || '').slice(0, 30),
              nextComputedOpacity,
              nextPointerEvents,
              nextAriaDisabled,
              nextHasCannotClick,
              nextCls,
              fileInputs: fileInputs ? fileInputs.length : 0,
              snapshotReady,
              snapshotHasPreview,
              snapshotLoadingVisible,
              snapshotHasOnePeace,
              snapshotHasMLoading,
              snapshotPreviewW,
              snapshotPreviewH,
              snapshotThumbImgs,
              snapshotThumbCanvas,
              snapshotThumbBgImg,
            };
          }
        }
      }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner);
}

/**
 * 操作封面弹窗：切换 tab / 点「下一步」/ 点「编辑器确定」/ 点「二次确认弹窗确定」
 *   action: 'switch-local' | 'click-next' | 'click-confirm' | 'click-final-confirm'
 */
function buildClickXiguaPosterDialogActionScript(action: 'switch-local' | 'click-next' | 'click-confirm' | 'click-final-confirm' | 'select-snapshot-thumb'): string {
  const runner = function (act: string) {
    const res: any = { err: null, found: false, clicked: false, reason: null };
    try {
      // ============ click-final-confirm：用户真实 DOM 的 m-dialog-edit 二次确认弹窗（和 m-poster-upgrade 不在同一 Dialog-container） ============
      if (act === 'click-final-confirm') {
        const finals = document.querySelectorAll('.Dialog-container .m-xigua-dialog.m-dialog-edit, .Dialog-container .m-dialog-edit');
        let pickedFinal: any = null;
        for (let f = 0; f < finals.length; f++) {
          const d: any = finals[f];
          try {
            const r = d.getBoundingClientRect();
            if (r.width <= 50 || r.height <= 50) continue;
          } catch (_) {}
          pickedFinal = d; break;
        }
        if (!pickedFinal) {
          // 再扩大：所有 .m-dialog-edit，不强制 Dialog-container 前缀
          const f2 = document.querySelectorAll('.m-xigua-dialog.m-dialog-edit, .m-dialog-edit');
          for (let f = 0; f < f2.length; f++) {
            const d: any = f2[f];
            try {
              const r = d.getBoundingClientRect();
              if (r.width <= 50 || r.height <= 50) continue;
            } catch (_) {}
            pickedFinal = d; break;
          }
        }
        if (!pickedFinal) { res.reason = 'no-final-dialog'; return JSON.stringify(res); }
        res.found = true;
        // 精确匹配：优先 .footer .m-button.red（用户真实 DOM：确定按钮红色）
        let btn: any = pickedFinal.querySelector('.footer button.m-button.red, .footer .m-button.red, .footer button.m-button.primary, .footer .m-button.primary, .footer .m-button:last-child, .footer button:last-child');
        if (!btn) {
          // 兜底：整个弹窗内找所有按钮，文本包含「确定」/「完成」/「确认」且带 red/primary 优先
          const allBtns: any = pickedFinal.querySelectorAll('button, .m-button');
          let bestScore = -1, bestBtn: any = null;
          for (let bi = 0; bi < allBtns.length; bi++) {
            const b = allBtns[bi];
            const txt = String((b.innerText || b.textContent || '')).replace(/\s+/g, '').trim();
            const cls = String((b.getAttribute && b.getAttribute('class')) || '').toLowerCase();
            let sc = 0;
            if (/确定|完成|确认|好/.test(txt)) sc += 200;
            if (/red|primary|danger|ok|confirm/.test(cls)) sc += 100;
            if (sc > bestScore) { bestScore = sc; bestBtn = b; }
          }
          btn = bestBtn;
        }
        if (btn) {
          try {
            if (typeof btn.focus === 'function') { try { btn.focus(); } catch (_) {} }
            try { btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 })); } catch (_) {}
            try { if (typeof btn.click === 'function') { btn.click(); res.clicked = true; } } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })); res.clicked = true; } catch (_) {}
          } catch (_) { /* ignore */ }
        } else {
          res.reason = 'no-final-ok-btn';
        }
        return JSON.stringify(res);
      }
      // ============ 其他 action：原 m-poster-upgrade 弹窗分支 ============
      const all = document.querySelectorAll('.Dialog-container');
      if (!all || all.length === 0) { res.reason = 'no-dialog'; return JSON.stringify(res); }
      for (let i = 0; i < all.length; i++) {
        const container = all[i] as any;
        const mDialog: any = container.querySelector('.m-xigua-dialog.m-poster-upgrade');
        if (!mDialog) continue;
        const isEditor = /xigua-image-editor-core/.test(String(mDialog.className || ''));
        if (act === 'switch-local' || act === 'click-next' || act === 'select-snapshot-thumb') {
          if (isEditor) continue;
          res.found = true;
          if (act === 'switch-local') {
            const headers: any = mDialog.querySelectorAll('.header li');
            if (headers) {
              for (let k = 0; k < headers.length; k++) {
                const h = headers[k] as any;
                const txt = String((h.innerText || h.textContent || '')).replace(/\s+/g, '').trim();
                if (/本地|上传/.test(txt) || txt === '本地上传') {
                  try {
                    h.click();
                    if (typeof h.dispatchEvent === 'function') {
                      try { h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) { /* ignore */ }
                      try { h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) { /* ignore */ }
                      try { h.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (_) { /* ignore */ }
                    }
                    res.clicked = true; break;
                  } catch (_) { /* ignore */ }
                }
              }
            }
          } else if (act === 'select-snapshot-thumb') {
            // ★ 兜底：点击封面截取内容区的第一张缩略图/帧/预览（真实DOM：.body .detail .m-one-peace > ul.img-list > li > img）
            const contentArea: any = mDialog.querySelector('.body .detail, .detail, .body .m-one-peace, .m-one-peace, .content, .body, .m-content, .snapshot-area, .poster-snapshot, .snapshot-wrap, .cover-snapshot, .preview-area');
            let target: any = null;
            if (contentArea) {
              // 优先级按真实 DOM 走：
              //   ① ul.img-list li 里的 <img>（真实有 22 张）
              //   ② img.select-img（上方大预览图）
              //   ③ .m-one-peace 内部其他 img
              const frameSelectors = [
                'ul.img-list li img',
                '.img-list img',
                'img.select-img',
                '.m-one-peace img',
                '.snapshot-item:not(.empty):not(.placeholder)',
                '.thumb-item, .frame-item',
                'img:not([src=""]):not([src^="data:image/svg"])',
                'canvas',
                'li[class*="item"]',
                'div[style*="background-image"]',
              ];
              for (const sel of frameSelectors) {
                try {
                  const cs = contentArea.querySelectorAll(sel);
                  for (let csi = 0; cs && csi < cs.length; csi++) {
                    const el: any = cs[csi];
                    try {
                      const r = el.getBoundingClientRect();
                      if (r.width > 10 && r.height > 10) { target = el; break; }
                    } catch (_) { /* ignore */ }
                    if (target) break;
                    if (!target) target = el;
                  }
                } catch (_) { /* ignore */ }
                if (target) break;
              }
            }
            if (!target) {
              try {
                const allImgs = mDialog.querySelectorAll('img, canvas, div[style*="background-image"]');
                for (let ai = 0; allImgs && ai < allImgs.length; ai++) {
                  const el: any = allImgs[ai];
                  try {
                    const r = el.getBoundingClientRect();
                    if (r.width > 20 && r.height > 20 && r.top > 20 && !el.closest('.header') && !el.closest('.footer')) { target = el; break; }
                  } catch (_) { /* ignore */ }
                }
              } catch (_) { /* ignore */ }
            }
            if (target) {
              try {
                res.targetInfo = { tag: target.tagName, cls: String(target.className || '').slice(0, 100) };
                target.click();
                if (typeof target.dispatchEvent === 'function') {
                  try { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } catch (_) { /* ignore */ }
                  try { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) { /* ignore */ }
                  try { target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) { /* ignore */ }
                  try { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (_) { /* ignore */ }
                }
                res.clicked = true;
              } catch (e: any) { res.reason = 'click-thumb-err:' + String(e && e.message || e).slice(0, 100); }
            } else {
              res.reason = 'no-snapshot-thumb-found';
            }
          } else { // click-next
            // ★ 真实DOM：<div class="footer undefined"><div class="m-button red cannot-click">下一步</div></div>
            //   按钮是 <div class="m-button"> 而非 <button>，必须包含 .m-button 本身
            const footer: any = mDialog.querySelector('.footer');
            const btn: any = footer ? footer.querySelector('.m-button.red, .m-button.primary, .footer .m-button, button.primary, button.red, .footer .m-button:last-child') : null;
            if (btn) {
              try {
                btn.click();
                if (typeof btn.dispatchEvent === 'function') {
                  try { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) { /* ignore */ }
                  try { btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) { /* ignore */ }
                  try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (_) { /* ignore */ }
                }
                res.clicked = true;
              } catch (_) { /* ignore */ }
            }
          }
          break;
        } else if (act === 'click-confirm') {
          if (!isEditor) continue;
          res.found = true;
          const btn: any = mDialog.querySelector('.footer-btns .btns .btn-sure, .footer-btns .btn-sure, .footer-btns button.btn-sure, .footer .m-button.red, .footer .m-button.primary, .footer button.red, .footer button.primary');
          if (btn) {
            try {
              if (typeof btn.focus === 'function') { try { btn.focus(); } catch (_) {} }
              try { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 })); } catch (_) {}
              try { if (typeof btn.click === 'function') { btn.click(); res.clicked = true; } } catch (_) {}
              try { btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (_) {}
              try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })); res.clicked = true; } catch (_) {}
            } catch (_) { /* ignore */ }
          }
          break;
        }
      }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [action]);
}

// ============================================================================================
// Strategy（策略）模式：表单填充步骤抽象
//
// 选择该模式的原因：
//   1) 用户要求「头条必须上传封面 + 标题长度限制 + 话题独立输入框 + 简介独立 textarea」这些都是头条平台专用规则，不宜侵入 shared.ts 或其他平台
//   2) 每个步骤都有可复用的「validate / inject / summarize」生命周期（校验请求→执行→日志摘要），符合单一职责
//   3) 后续如果头条新增其他输入（视频生成图文勾选等），新增 step 即可，不影响其他平台
// ============================================================================================

type XiguaFormStepName = 'title' | 'abstract' | 'hashtag' | 'poster';

interface XiguaFormSummary {
  ok: boolean;
  detail: any;
}

interface XiguaFormStep {
  readonly name: XiguaFormStepName;
  readonly label: string;
  readonly required: boolean;
  /** 预检查：返回 { skip:true } 表示这一步不执行（例如用户没填 tags 就跳过 hashtag）；返回 fail 会中断整个表单流程 */
  preflight(req: PublishRequest): { skip?: boolean; skipReason?: string; fail?: string };
  /** 注入/执行 */
  inject(ctx: { win: BrowserWindow; req: PublishRequest; progress: (n: number, msg: string) => void; log: any }): Promise<XiguaFormSummary>;
  /** 给测试模式字段/错误日志做摘要 */
  toTestResult(ctx: { req: PublishRequest; summary: XiguaFormSummary }): { filled: boolean; found: boolean; valueLength?: number; extra?: any };
}

// ---------- Step 1: 标题 ----------
const TitleStep: XiguaFormStep = {
  name: 'title', label: '视频标题', required: true,
  preflight(req: PublishRequest) { return {}; },
  async inject(ctx) {
    const { win, req, log } = ctx;
    let finalTitle = (req.title || (req.content || '').slice(0, 30) || '').trim();
    if (finalTitle.length < 1) finalTitle = (req.mediaFiles && req.mediaFiles[0])
      ? require('path').basename(req.mediaFiles[0]).replace(/\.[^.]+$/, '') + ' 精彩内容' : '精彩视频';
    if (finalTitle.length > XIGUA_VIDEO_TITLE_LIMIT) {
      finalTitle = finalTitle.slice(0, XIGUA_VIDEO_TITLE_LIMIT - 1).trimEnd() + '\u2026';
    }
    log('info', 'fill-title', `准备写入 ${finalTitle.length}/${XIGUA_VIDEO_TITLE_LIMIT} 字：${finalTitle.slice(0, 80)}`);
    const raw: any = await evalJS(win, buildFillXiguaVideoTitleScript(finalTitle), 'fill-video-title', log).catch((e: any) => ({ err: String(e) }));
    const p: any = parseSafeResult(raw, { filled: false, targetFound: false });
    log('info', 'fill-title', `结果: ${JSON.stringify(p || null).slice(0, 300)}`);
    // 第二次补偿（React 受控 value）
    if (!p || !p.filled) {
      log('info', 'fill-title-2', `首次未填成功，再执行一次…`);
      await new Promise((r) => setTimeout(r, 400));
      const r2Raw: any = await evalJS(win, buildFillXiguaVideoTitleScript(finalTitle), 'fill-video-title-2', log).catch(() => null);
      const r2: any = parseSafeResult(r2Raw, { filled: false });
      log('info', 'fill-title-2', `结果2: ${JSON.stringify(r2 || null).slice(0, 300)}`);
      if (r2 && r2.filled) return { ok: true, detail: r2 };
    }
    return { ok: !!(p && (p.filled || (p.targetFound && p.afterLen && p.afterLen >= 1 && p.afterLen <= 30))), detail: p };
  },
  toTestResult({ summary }) {
    return {
      found: !!(summary && summary.detail && summary.detail.targetFound),
      filled: !!(summary && summary.ok),
      valueLength: Number((summary && summary.detail && summary.detail.afterLen) || 0),
      extra: summary && summary.detail,
    };
  },
};

// ---------- Step 2: 简介 ----------
const AbstractStep: XiguaFormStep = {
  name: 'abstract', label: '视频简介', required: false,
  preflight(req: PublishRequest) {
    if (!req.content || String(req.content).trim().length === 0) return { skip: true, skipReason: '无正文内容，跳过简介' };
    return {};
  },
  async inject(ctx) {
    const { win, req, log } = ctx;
    const rawContent = String(req.content || '');
    const abstractStr = truncate(rawContent, XIGUA_VIDEO_ABSTRACT_LIMIT);
    log('info', 'fill-abstract', `准备写入 ${rawContent.length}/${XIGUA_VIDEO_ABSTRACT_LIMIT} 字：截断后=${abstractStr.length} 字，内容前 80=${JSON.stringify(abstractStr.slice(0, 80))}`);
    if (!abstractStr) return { ok: true, detail: { skipped: 'empty', rawLen: rawContent.length, limit: XIGUA_VIDEO_ABSTRACT_LIMIT } };
    const absRaw: any = await evalJS(win, buildFillXiguaVideoAbstractScript(abstractStr), 'fill-video-abstract', log).catch((e: any) => ({ err: String(e) }));
    const absRes: any = parseSafeResult(absRaw, { filled: false });
    log('info', 'fill-abstract', `结果: ${JSON.stringify(absRes || null).slice(0, 300)}`);
    return { ok: !!(absRes && (absRes.filled || (absRes.targetFound && absRes.afterLen > 0))), detail: absRes };
  },
  toTestResult({ summary }) {
    return {
      found: !!(summary && summary.detail && summary.detail.targetFound),
      filled: !!(summary && summary.ok),
      valueLength: Number((summary && summary.detail && summary.detail.afterLen) || 0),
      extra: summary && summary.detail,
    };
  },
};

// ---------- Step 3: 话题 ----------
const HashTagStep: XiguaFormStep = {
  name: 'hashtag', label: '话题标签', required: false,
  preflight(req: PublishRequest) {
    if (!Array.isArray(req.tags) || req.tags.length === 0) return { skip: true, skipReason: '未配置话题' };
    return {};
  },
  async inject(ctx) {
    const { win, req, log } = ctx;
    const tags = (req.tags || []).slice(0, 10);
    const raw: any = await evalJS(win, buildFillXiguaVideoHashTagScript(tags), 'fill-video-hashtag', log).catch((e: any) => ({ err: String(e) }));
    const p: any = parseSafeResult(raw, { added: 0, attempts: 0, afterCount: 0 });
    log('info', 'fill-hashtag', `输入 ${tags.length} 个话题 → 结果: ${JSON.stringify(p || null).slice(0, 500)}`);
    // 至少添加了 1 个，或之前已有
    const ok = (p && (p.added > 0 || p.afterCount > 0));
    return { ok: !!ok, detail: p };
  },
  toTestResult({ summary }) {
    return {
      found: !!(summary && summary.detail && (summary.detail.wrapperFound || summary.detail.inputFound)),
      filled: !!(summary && summary.ok),
      valueLength: Number((summary && summary.detail && summary.detail.afterCount) || 0),
      extra: summary && summary.detail,
    };
  },
};

// ---------- Step 4: 封面（头条非必填；但如果要走流程，先点上传封面，弹窗里选择封面截取→下一步→编辑器里确定；有本地图则走本地上传→编辑器确定） ----------
const PosterStep: XiguaFormStep = {
  name: 'poster', label: '视频封面', required: false,
  preflight() { return {}; },
  async inject(ctx) {
    const { win, req, log } = ctx;
    // 1) 先探测表单是否已有封面（如自动从视频抓、之前流程已填过）
    const probe1Raw: any = await evalJS(win, buildProbeXiguaVideoPosterScript(), 'probe-poster-1', log).catch((e: any) => ({ err: String(e) }));
    const probe1: any = parseSafeResult(probe1Raw, { formItemFound: false, hasImage: false });
    log('info', 'poster-probe', `封面探测(表单初始化): ${JSON.stringify(probe1 || null).slice(0, 400)}`);
    if (probe1 && probe1.hasImage) {
      log('info', 'poster-probe', `表单已存在封面，跳过弹窗流程 src=${(probe1.imageSrc || '').slice(0, 120)}`);
      return { ok: true, detail: { ...probe1, auto: true, flow: 'has-image' } };
    }

    // 选封面文件候选（可能 undefined）
    const coverCandidate: string | undefined = (function pickCover(): string | undefined {
      if (req.coverImage) return req.coverImage;
      const imgs = (req.mediaFiles || []).filter((f: string) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f));
      if (imgs.length > 0) return imgs[0];
      return undefined;
    })();

    // 2) 点击「上传封面」打开 Dialog1（最多重试 2 次）
    let dialogState: any = null;
    {
      const dsRaw0: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-0', log).catch(() => null);
      const ds0: any = parseSafeResult(dsRaw0, { anyVisible: false });
      if (ds0 && ds0.anyVisible) dialogState = ds0;
    }
    if (!dialogState || !dialogState.anyVisible) {
      for (let op = 0; op < 2; op++) {
        const openRaw: any = await evalJS(win, buildOpenXiguaPosterDialogScript(), 'poster-dialog-open-' + op, log).catch(() => null);
        const openRes: any = parseSafeResult(openRaw, { clicked: false });
        log('info', 'poster-dialog', `点击上传封面 #${op}: ${JSON.stringify(openRes || null).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 700));
        const dsRaw: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-' + op, log).catch(() => null);
        const ds: any = parseSafeResult(dsRaw, { anyVisible: false });
        if (ds && ds.anyVisible) { dialogState = ds; break; }
      }
    }
    if (!dialogState || !dialogState.anyVisible) {
      // 弹窗始终打不开：不报错，按「非必填」返回 ok=true（hasImage=false 也没关系，用户说非必填）
      log('warn', 'poster-dialog', `点击 fake-upload-trigger 后未出现封面弹窗，按「非必填」跳过（但封面仍为未上传状态）`);
      return { ok: true, detail: { ...(probe1 || {}), auto: false, flow: 'cannot-open-dialog' } };
    }
    log('info', 'poster-dialog', `弹窗初始状态: ${JSON.stringify(dialogState || null).slice(0, 500)}`);

    // 3) Dialog1 处理：有 coverCandidate → 切本地上传并注入文件；无 coverCandidate → 保持默认封面截取
    let dialog1Processed = false;
    let uploadRes: any = null;
    if (dialogState.dialog1 && dialogState.dialog1.visible) {
      if (coverCandidate) {
        // 切本地上传 tab
        if (dialogState.dialog1.selectedTab !== 'local') {
          const swRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('switch-local'), 'poster-dialog-switch-local', log).catch(() => null);
          const sw: any = parseSafeResult(swRaw, { clicked: false });
          log('info', 'poster-dialog', `切换本地上传 tab: ${JSON.stringify(sw || null).slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 600));
        }
        // 关键：点击云朵上传区域（.m-one-peace / .byte-upload），让惰性渲染的 type=file 挂载到 DOM 上
        //       用户提供真实 DOM：<div class="byte-upload xigua-upload-poster-trigger upload-thumb-trigger-card"><input type=file accept="image/jpg,..."></div>
        {
          const cloudRaw: any = await evalJS(win, buildOpenXiguaPosterDialogScript('localUploadArea'), 'poster-dialog-click-cloud', log).catch(() => null);
          const cloud: any = parseSafeResult(cloudRaw, { foundTrigger: false, clicked: false });
          log('info', 'poster-dialog', `点击本地上传云朵区域触发: ${JSON.stringify(cloud || null).slice(0, 200)}`);
          // ★ 改为轮询等待 input[type=file] 在 Dialog-container / byte-upload 下挂载（最多 16 * 250ms = 4s）
          //   用户真实 DOM：input 在 .Dialog-container .byte-upload.xigua-upload-poster-trigger 内
          const waitInputScript = `
            ;(function(){
              try {
                var scope = null;
                var dlg = document.querySelector('.Dialog-container .m-xigua-dialog.m-poster-upgrade') || document.querySelector('.Dialog-container');
                scope = dlg || document.body;
                // 1. 优先找 .byte-upload.xigua-upload-poster-trigger / upload-thumb-trigger-card（用户提供精确类名）
                var cards = scope.querySelectorAll ? scope.querySelectorAll('.byte-upload.xigua-upload-poster-trigger, .byte-upload.upload-thumb-trigger-card, .byte-upload, .xigua-upload-poster-trigger, [class*="upload-trigger-card"]') : [];
                // 2. 再直接查 input[type=file] 且 accept 含 image
                var inputs = scope.querySelectorAll ? scope.querySelectorAll('input[type="file"]') : [];
                var imgInputs = [];
                for (var i = 0; i < inputs.length; i++) {
                  var a = String((inputs[i].getAttribute && inputs[i].getAttribute('accept')) || '').toLowerCase();
                  if (/image|png|jpe?g|webp|gif|bmp/.test(a) || !a) imgInputs.push(inputs[i]);
                }
                // 3. cards 内如果有嵌套的 input[type=file] 也合并
                var totalAcceptImg = imgInputs.length;
                for (var c = 0; c < cards.length; c++) {
                  try {
                    var nested = cards[c].querySelectorAll ? cards[c].querySelectorAll('input[type="file"]') : [];
                    totalAcceptImg += nested.length;
                  } catch (_) {}
                }
                return JSON.stringify({
                  scopeFound: !!dlg,
                  cardCount: cards.length,
                  cardCls: Array.prototype.slice.call(cards).slice(0,3).map(function(x){ return (x.getAttribute && x.getAttribute('class')||'').slice(0,100); }),
                  totalInputCount: inputs.length,
                  acceptImgCount: imgInputs.length,
                  firstAccept: imgInputs[0] ? String((imgInputs[0].getAttribute && imgInputs[0].getAttribute('accept')) || '') : '',
                  firstCls: imgInputs[0] ? String((imgInputs[0].getAttribute && imgInputs[0].getAttribute('class')) || '') : '',
                });
              } catch(e) { return JSON.stringify({ err: String(e).slice(0,200) }); }
            })();
          `;
          let mountedOk = false;
          for (let wp = 0; wp < 16; wp++) {
            const wr: any = await evalJS(win, waitInputScript, 'poster-wait-input-' + wp, log).catch(() => null);
            const wpRes: any = (wr && typeof wr === 'object') ? wr : (() => { try { return JSON.parse(wr || '{}'); } catch (_) { return {}; } })();
            const gotCards = Number(wpRes.cardCount || 0) > 0;
            const gotAcceptImg = Number(wpRes.acceptImgCount || 0) > 0;
            log('info', 'poster-wait-input', `轮询 #${wp}: cards=${wpRes.cardCount} acceptImg=${wpRes.acceptImgCount} totalInputs=${wpRes.totalInputCount} firstAccept=${(wpRes.firstAccept||'').slice(0,80)}`);
            if (gotCards || gotAcceptImg) { mountedOk = true; break; }
            await new Promise((r) => setTimeout(r, 250));
          }
          log('info', 'poster-wait-input', `挂载轮询结束：mountedOk=${mountedOk}，若=false 仍继续走（后面 Fallback-B 兜底 DOM.getDocument 全页搜）`);
        }
        // 在 Dialog 作用域内 CDP 注入图片
        log('info', 'poster-upload', `准备在 Dialog 作用域上传封面文件: ${String(coverCandidate).slice(0, 200)}`);
        uploadRes = await uploadPosterViaCDP(win, coverCandidate, log, '.Dialog-container .m-xigua-dialog.m-poster-upgrade, .Dialog-container');
        log('info', 'poster-upload', `Dialog 本地上传结果: ${JSON.stringify(uploadRes || null).slice(0, 400)}`);
        if (uploadRes && uploadRes.ok) {
          // ★ 上传成功后：轮询等待「下一步」按钮从 disabled=true → false（解析完成才可用）
          //   用户截图显示「下一步」粉色 disabled 态 = 还没解析完，点了也白点，停留在 Dialog1
          let nextEnabled = false;
          for (let poll = 0; poll < 18; poll++) { // 最多 18*400ms ≈ 7.2s
            await new Promise((r) => setTimeout(r, 400));
            const pRaw: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-poll-next-' + poll, log).catch(() => null);
            const p: any = parseSafeResult(pRaw, { anyVisible: false, dialog1: null, dialog2: null });
            if (p && p.anyVisible) {
              if (p.dialog2 && p.dialog2.visible) { nextEnabled = true; break; } // 已自动跳编辑器
              if (p.dialog1 && p.dialog1.hasNext && !p.dialog1.nextDisabled) { nextEnabled = true; break; }
            }
            if (!p || !p.anyVisible) break; // 弹窗异常关闭
          }
          log('info', 'poster-upload', `上传后 next 按钮启用=${nextEnabled}`);
          if (nextEnabled) {
            const nxRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-next'), 'poster-dialog-next-after-upload', log).catch(() => null);
            const nx: any = parseSafeResult(nxRaw, { clicked: false });
            log('info', 'poster-dialog', `上传成功后点下一步: ${JSON.stringify(nx || null).slice(0, 200)}`);
            dialog1Processed = true;
            await new Promise((r) => setTimeout(r, 1500));
          }
          // 刷新 dialogState（不管 nextEnabled 与否，上传后可能自动进入 Dialog2）
          dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-state-after-upload', log).catch(() => null), { anyVisible: false });
          log('info', 'poster-dialog', `上传+点击next后状态: ${JSON.stringify(dialogState || null).slice(0, 400)}`);
        } else {
          // 上传失败，不再点 next（粉色按钮 disabled，日志里「上传失败但 next 可用」这种回退在 99% 场景下是错的，避免误操作）
          // 仍然尝试 probe 一次看 Dialog 是否自行跳了
          dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-state-after-fail', log).catch(() => null), { anyVisible: false });
          return {
            ok: true, // 非必填
            detail: {
              probeBefore: probe1,
              coverCandidate: String(coverCandidate).slice(0, 300),
              dialog1Processed: false,
              confirmOk: false,
              upload: uploadRes,
              probeAfter: parseSafeResult(await evalJS(win, buildProbeXiguaVideoPosterScript(), 'probe-poster-final-upload-fail', log).catch(() => null), { hasImage: false }),
              flow: 'local-upload-failed',
              error: '封面本地上传失败: ' + String((uploadRes && uploadRes.reason) || 'unknown').slice(0, 300),
            },
          };
        }
      } else {
        // 无 coverCandidate：保持默认封面截取 tab → 必须等待「snapshotReady=true（缩略图/帧真实加载好，无 loading）+ nextDisabled=false」同时满足，再点下一步
        //   ★ 从用户日志看：nextDisabled=false 从一开始就满足，但点击无反应 → 真正的阻塞条件是「封面截取的缩略图还没加载好」，这是Vue/React的"软 disabled"
        //   兜底：如果一直不 ready，先尝试点击一张缩略图（选中某帧）再点下一步
        log('info', 'poster-dialog', `未提供 coverImage / 图片，保持「封面截取」tab，等待 snapshotReady=true + nextDisabled=false 后再点下一步…`);
        // 最多 2 次点「下一步」
        for (let np = 0; np < 2; np++) {
          // 点之前再确保 tab 正确（有些情况初始 tab 可能为其他）
          if (np === 1) {
            const dsCheckRaw: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-pre-next-' + np, log).catch(() => null);
            const dsCheck: any = parseSafeResult(dsCheckRaw, { dialog1: null });
            if (dsCheck && dsCheck.dialog1 && dsCheck.dialog1.selectedTab !== 'snapshot') {
              // 兜底：如果默认 tab 不是 snapshot，尝试找 li 的「封面截取」点击
              try {
                const fixSnapRaw: any = await evalJS(
                  win,
                  wrapSafeScript(
                    function () {
                      try {
                        const headers = document.querySelectorAll('.Dialog-container .m-xigua-dialog.m-poster-upgrade .header li');
                        let clicked = false;
                        for (let k = 0; headers && k < headers.length; k++) {
                          const h: any = headers[k];
                          const txt = String((h.innerText || h.textContent || '')).replace(/\s+/g, '').trim();
                          if (/封面|截取/.test(txt) || txt === '封面截取') { try { h.click(); clicked = true; } catch (_) { /* ignore */ } break; }
                        }
                        return JSON.stringify({ clicked });
                      } catch (e: any) { return JSON.stringify({ err: String(e).slice(0, 200) }); }
                    },
                  ),
                  'poster-dialog-force-snapshot',
                  log,
                ).catch(() => null);
                const fixSnap: any = parseSafeResult(fixSnapRaw, { clicked: false });
                if (fixSnap && fixSnap.clicked) await new Promise((r) => setTimeout(r, 400));
              } catch (_) { /* ignore */ }
            }
          }
          // ★ 轮询等待：必须 snapshotReady && !nextDisabled 才视为真可点击
          //   封面截取加载视频帧可能较慢：最多 32 次 × 400ms ≈ 12.8s
          let readyToClickNext = false;
          let lastPolled: any = null;
          for (let poll = 0; poll < 32; poll++) {
            await new Promise((r) => setTimeout(r, 400));
            const pRaw: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-poll-next-snap-' + np + '-' + poll, log).catch(() => null);
            const p: any = parseSafeResult(pRaw, { anyVisible: false, dialog1: null, dialog2: null });
            lastPolled = p;
            if (p && p.anyVisible) {
              if (p.dialog2 && p.dialog2.visible) { readyToClickNext = true; break; } // 已自动跳编辑器
              if (p.dialog1 && p.dialog1.hasNext && !p.dialog1.nextDisabled) {
                // ★ 核心条件：必须 snapshotReady=true（或非 snapshot tab 才用 !nextDisabled 单条件）
                const isSnapshot = p.dialog1.selectedTab === 'snapshot' || p.dialog1.snapshotIdx >= 0;
                if (!isSnapshot) {
                  readyToClickNext = true; break;
                } else if (p.dialog1.snapshotReady === true) {
                  readyToClickNext = true; break;
                } else {
                  // snapshot tab 但 snapshotReady=false → 继续等待（每 5 次打一条中间日志）
                  if (poll % 5 === 0) {
                    log('info', 'poster-dialog', `封面截取加载中（np=${np},poll=${poll}）：snapshotReady=${String(p.dialog1.snapshotReady)} hasPreview=${String(p.dialog1.snapshotHasPreview)} loading=${String(p.dialog1.snapshotLoadingVisible)} imgs=${String(p.dialog1.snapshotThumbImgs)} canvas=${String(p.dialog1.snapshotThumbCanvas)} bgImg=${String(p.dialog1.snapshotThumbBgImg)} W=${String(p.dialog1.snapshotPreviewW)} H=${String(p.dialog1.snapshotPreviewH)}`);
                  }
                }
              }
            }
            if (!p || !p.anyVisible) break; // 弹窗异常关闭
          }
          log('info', 'poster-dialog', `封面截取场景轮询后 readyToClickNext=${readyToClickNext}（np=${np}）`);
          // ★ 兜底：如果 readyToClickNext 仍为 false，但 hasPreview=true 只是 snapshotReady 判定条件太严，
          //   先尝试点击一张缩略图（让前端确认选中了某帧），再继续点下一步
          if (!readyToClickNext && lastPolled && lastPolled.dialog1 && lastPolled.dialog1.selectedTab === 'snapshot' && lastPolled.dialog1.snapshotHasPreview && !lastPolled.dialog1.nextDisabled) {
            log('warn', 'poster-dialog', `snapshotReady 一直为 false 但已有预览内容，兜底：先点击一张缩略图，再继续尝试下一步（np=${np}）`);
            const thRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('select-snapshot-thumb'), 'poster-dialog-select-thumb-' + np, log).catch(() => null);
            const thr: any = parseSafeResult(thRaw, { found: false, clicked: false, targetInfo: null, reason: null });
            log('info', 'poster-dialog', `点击封面缩略图兜底：found=${thr && thr.found} clicked=${thr && thr.clicked} reason=${thr && thr.reason || ''} info=${thr && thr.targetInfo ? JSON.stringify(thr.targetInfo).slice(0, 200) : ''}`);
            if (thr && thr.clicked) {
              await new Promise((r) => setTimeout(r, 600));
              // 点击缩略图后，再短暂轮询（最多 5 次）看 snapshotReady 是否变成 true
              for (let poll2 = 0; poll2 < 5; poll2++) {
                await new Promise((r) => setTimeout(r, 300));
                const pRaw2: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-poll-after-thumb-' + np + '-' + poll2, log).catch(() => null);
                const p2: any = parseSafeResult(pRaw2, { anyVisible: false, dialog1: null, dialog2: null });
                if (p2 && p2.dialog2 && p2.dialog2.visible) { readyToClickNext = true; break; }
                if (p2 && p2.dialog1 && p2.dialog1.hasNext && !p2.dialog1.nextDisabled && (p2.dialog1.snapshotReady || p2.dialog1.selectedTab !== 'snapshot')) { readyToClickNext = true; break; }
              }
              // 即使没 ready，也兜底放行（已经有预览 + 已手动点过缩略图）
              if (!readyToClickNext) readyToClickNext = true;
            }
          }
          if (!readyToClickNext) {
            log('warn', 'poster-dialog', `封面截取场景仍未就绪，跳过本次点击下一步（np=${np}）。最后一次 poll=${lastPolled ? JSON.stringify(lastPolled.dialog1 && {nextDisabled:lastPolled.dialog1.nextDisabled,snapshotReady:lastPolled.dialog1.snapshotReady,hasPreview:lastPolled.dialog1.snapshotHasPreview,loading:lastPolled.dialog1.snapshotLoadingVisible,selected:lastPolled.dialog1.selectedTab}).slice(0,300) : '无'}`);
            continue;
          }
          const nxRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-next'), 'poster-dialog-next-' + np, log).catch(() => null);
          const nx: any = parseSafeResult(nxRaw, { clicked: false });
          log('info', 'poster-dialog', `点下一步 #${np}: ${JSON.stringify(nx || null).slice(0, 200)}`);
          dialog1Processed = true;
          await new Promise((r) => setTimeout(r, 1500));
          dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-next-' + np, log).catch(() => null), { anyVisible: false });
          // ★ 如果这次点击下一步没跳（还是停在 Dialog1），在 np=0 结束时立即做一次兜底：先点击缩略图再点下一步
          if (np === 0 && dialogState && dialogState.dialog1 && dialogState.dialog1.visible && !(dialogState.dialog2 && dialogState.dialog2.visible)) {
            log('warn', 'poster-dialog', `点下一步 #${np} 后仍停在 Dialog1，兜底：点缩略图 → 再点一次下一步`);
            const thRaw2: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('select-snapshot-thumb'), 'poster-dialog-select-thumb-retry-' + np, log).catch(() => null);
            const thr2: any = parseSafeResult(thRaw2, { clicked: false });
            if (thr2 && thr2.clicked) {
              await new Promise((r) => setTimeout(r, 500));
              const nxRaw2: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-next'), 'poster-dialog-next-retry-' + np, log).catch(() => null);
              const nx2: any = parseSafeResult(nxRaw2, { clicked: false });
              log('info', 'poster-dialog', `兜底：点缩略图后再点下一步：${JSON.stringify(nx2 || null).slice(0, 200)}`);
              await new Promise((r) => setTimeout(r, 1500));
              dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-retry-next-' + np, log).catch(() => null), { anyVisible: false });
            }
          }
          if (dialogState && dialogState.dialog2 && dialogState.dialog2.visible) break; // 已进入编辑器
          if (dialogState && !dialogState.anyVisible) break;
        }
      }
    }

    // 4) 从 Dialog1 进入 Dialog2（编辑器）：点确定；若确定按钮点击后文本变「上传中」，需要轮询等上传完成（最多 30s）
    let confirmOk = false;
    for (let cp = 0; cp < 2; cp++) {
      if (dialogState && dialogState.dialog2 && dialogState.dialog2.visible) {
        if (dialogState.dialog2.hasConfirm && !dialogState.dialog2.confirmDisabled) {
          const btnTextBefore = String((dialogState.dialog2 && dialogState.dialog2.confirmText) || '');
          const cRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-confirm'), 'poster-dialog-confirm-' + cp, log).catch(() => null);
          const cr: any = parseSafeResult(cRaw, { clicked: false });
          log('info', 'poster-dialog', `点编辑器确定 #${cp}: 按钮文本前="${btnTextBefore.slice(0,20)} ${JSON.stringify(cr || null).slice(0, 150)}`);
          confirmOk = !!(cr && cr.clicked);
          await new Promise((r) => setTimeout(r, 1200));
        } else {
          log('warn', 'poster-dialog', `编辑器确定按钮未就绪: hasConfirm=${dialogState.dialog2.hasConfirm} disabled=${dialogState.dialog2.confirmDisabled}，继续等待…`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // ★ 点完编辑器确定后，立即检查是否弹出了「完成后无法继续编辑，是否确定完成？」二次确认弹窗
      dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-confirm-' + cp, log).catch(() => null), { anyVisible: false });
      // ★★ 如果 Dialog2 的确定按钮现在显示「上传中 / 处理中 / 保存中 / 同步中」，进入 30s 轮询等待，不能继续直接点下一次确定（白点！）
      if (dialogState && dialogState.dialog2 && dialogState.dialog2.visible && typeof dialogState.dialog2.confirmText === 'string') {
        const ct: string = dialogState.dialog2.confirmText.replace(/\s+/g, '').trim();
        if (/上传中|处理中|保存中|同步中|提交中|生成中|解析中|加载中|请稍候|稍候|等待中/.test(ct)) {
          log('info', 'poster-dialog-uploading', `检测到编辑器确定按钮进入"上传/处理中"态: confirmText=${ct}，开始轮询等待上传完成（最多 38 次 × 800ms ≈ 30s）…`);
          let uploadingDone = false;
          for (let upl = 0; upl < 38; upl++) {
            await new Promise((r) => setTimeout(r, 800));
            const upRaw: any = await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-uploading-' + cp + '-' + upl, log).catch(() => null);
            const up: any = parseSafeResult(upRaw, { anyVisible: false });
            if (!up || !up.anyVisible) { uploadingDone = true; log('info', 'poster-dialog-uploading', `上传中轮询 #${upl}: 弹窗已关闭，视为完成`); break; }
            // dialogFinal 已弹出 = 上传完了
            if (up.dialogFinal && up.dialogFinal.visible && up.dialogFinal.hasOk) { uploadingDone = true; log('info', 'poster-dialog-uploading', `上传中轮询 #${upl}: 检测到二次确认弹窗 dialogFinal 弹出，停止等待上传`); break; }
            // Dialog2 还在，看 confirmText
            if (up.dialog2 && up.dialog2.visible) {
              const ctNow: string = String((up.dialog2.confirmText || '')).replace(/\s+/g, '').trim();
              const stillUploading = /上传中|处理中|保存中|同步中|提交中|生成中|解析中|加载中|请稍候|稍候|等待中/.test(ctNow);
              log('info', 'poster-dialog-uploading', `上传中轮询 #${upl}: confirmText="${ctNow}" stillUploading=${stillUploading} disabled=${up.dialog2.confirmDisabled}`);
              if (!stillUploading) {
                // confirmText 不是「上传中」了，不管变成啥（确定 / 完成 / 使用 / 保存 / 成功等），就退出等待
                uploadingDone = true;
                break;
              }
            } else {
              uploadingDone = true; break;
            }
          }
          log('info', 'poster-dialog-uploading', `上传中轮询结束: done=${uploadingDone}，继续后续流程`);
          // 刷新 dialogState
          dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-uploading-done-' + cp, log).catch(() => null), { anyVisible: false });
        }
      }
      if (dialogState && dialogState.dialogFinal && dialogState.dialogFinal.visible && dialogState.dialogFinal.hasOk) {
        // 先等 800ms 让按钮就绪
        await new Promise((r) => setTimeout(r, 800));
        // 最多 2 次点「确定(red)」
        let finalOk = false;
        for (let fcp = 0; fcp < 2; fcp++) {
          const fcRaw: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-final-confirm'), 'poster-dialog-final-confirm-' + cp + '-' + fcp, log).catch(() => null);
          const fcr: any = parseSafeResult(fcRaw, { clicked: false, reason: null });
          log('info', 'poster-dialog-final', `二次确认弹窗点击 #${cp}-${fcp}: found=${fcr && fcr.found} clicked=${fcr && fcr.clicked} reason=${(fcr && fcr.reason) || ''}`);
          if (fcr && fcr.clicked) { finalOk = true; break; }
          await new Promise((r) => setTimeout(r, 1000));
          dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-final-after-' + cp + '-' + fcp, log).catch(() => null), { anyVisible: false });
          if (!(dialogState && dialogState.dialogFinal && dialogState.dialogFinal.visible)) break; // 弹窗已被关掉了就停
        }
        log('info', 'poster-dialog-final', `二次确认弹窗处理: ok=${finalOk}，text前50=${(dialogState && dialogState.dialogFinal && dialogState.dialogFinal.text || '').slice(0, 50)}`);
      }
      if (!dialogState || !dialogState.anyVisible) break; // 弹窗关闭
      if (dialogState && !dialogState.dialog2 && !(dialogState.dialogFinal && dialogState.dialogFinal.visible)) break;
    }

    // 4.1) 兜底：如果现在还能看到 dialogFinal（二次确认弹窗还在），再处理一次
    {
      dialogState = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-probe-final-finalize', log).catch(() => null), { anyVisible: false });
      if (dialogState && dialogState.dialogFinal && dialogState.dialogFinal.visible && dialogState.dialogFinal.hasOk) {
        // 轮询最多 5 次：每次探测到就点确定
        for (let ffp = 0; ffp < 5; ffp++) {
          const fcRaw2: any = await evalJS(win, buildClickXiguaPosterDialogActionScript('click-final-confirm'), 'poster-dialog-final-finalize-' + ffp, log).catch(() => null);
          const fcr2: any = parseSafeResult(fcRaw2, { clicked: false });
          log('info', 'poster-dialog-final-finalize', `兜底二次确认弹窗点击 #${ffp}: found=${fcr2 && fcr2.found} clicked=${fcr2 && fcr2.clicked}`);
          await new Promise((r) => setTimeout(r, 1200));
          const checkS2: any = parseSafeResult(await evalJS(win, buildProbeXiguaPosterDialogStateScript(), 'poster-dialog-final-finalize-check-' + ffp, log).catch(() => null), { anyVisible: false });
          if (!(checkS2 && checkS2.dialogFinal && checkS2.dialogFinal.visible)) break;
        }
      }
    }

    // 5) 回到表单再测一次
    const probe2Raw: any = await evalJS(win, buildProbeXiguaVideoPosterScript(), 'probe-poster-final', log).catch(() => null);
    const probe2: any = parseSafeResult(probe2Raw, { hasImage: false });
    log('info', 'poster-probe-final', `流程结束后表单封面探测: hasImage=${!!(probe2 && probe2.hasImage)} src=${(probe2 && probe2.imageSrc || '').slice(0, 120)}`);
    // 非必填：就算 probe2.hasImage 为 false 也返回 ok=true（只有前面 fatal 才 ok=false）；但 detail 里把真实状态写出来
    return {
      ok: true,
      detail: {
        probeBefore: probe1,
        coverCandidate: coverCandidate ? String(coverCandidate).slice(0, 300) : undefined,
        dialog1Processed,
        confirmOk,
        upload: uploadRes,
        probeAfter: probe2,
        flow: 'completed',
      },
    };
  },
  toTestResult({ summary }) {
    const after = summary && summary.detail && (summary.detail.probeAfter || summary.detail);
    return {
      found: !!(summary && summary.detail && (summary.detail.probeBefore || summary.detail.formItemFound || (after && after.formItemFound))),
      filled: !!(after && after.hasImage),
      valueLength: (after && after.hasImage) ? 1 : 0,
      extra: summary && summary.detail,
    };
  },
};

// 策略编排器：按顺序执行 steps，支持跳过 + 必填校验失败直接中断
async function runXiguaVideoFormSteps(
  win: BrowserWindow,
  req: PublishRequest,
  progress: (n: number, s: string) => void,
  log: any,
): Promise<{
  ok: boolean;
  failStep?: XiguaFormStepName;
  failReason?: string;
  /** 给测试模式返回的字段快照 */
  formFields: { name: string; type: string; selector?: string; filled: boolean; found: boolean; valueLength?: number; extra?: any }[];
  details: Record<XiguaFormStepName, XiguaFormSummary | undefined>;
}> {
  const steps: XiguaFormStep[] = [TitleStep, AbstractStep, HashTagStep, PosterStep];
  const outDetails: any = {};
  const outFields: any[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const pf = s.preflight(req);
    if (pf && pf.fail) {
      log('warn', 'step-' + s.name, `preflight fail: ${pf.fail}`);
      return { ok: false, failStep: s.name, failReason: pf.fail, formFields: outFields, details: outDetails };
    }
    if (pf && pf.skip) {
      log('info', 'step-' + s.name, `preflight skip: ${pf.skipReason || ''}`);
      // 可选字段 skip 也记一个空字段用于测试结果
      outFields.push({ name: s.label, type: s.name, selector: '', filled: false, found: false, valueLength: 0, extra: { skipped: true, reason: pf.skipReason } });
      continue;
    }
    progress(80 + Math.round((i + 1) / steps.length * 10), `填写 ${s.label}…`);
    const summary = await s.inject({ win, req, progress, log });
    outDetails[s.name] = summary;
    const tr = s.toTestResult({ req, summary });
    outFields.push({ name: s.label, type: s.name, selector: (tr.extra && (tr.extra.method || tr.extra.acceptFound || '')) || '', ...tr });
    if (!summary.ok && s.required) {
      const reason = (summary.detail && (summary.detail.err || summary.detail.upload && summary.detail.upload.reason)) || 'required step failed:' + s.name;
      log('warn', 'step-' + s.name, `必填步骤失败: ${String(reason).slice(0, 300)}`);
      return { ok: false, failStep: s.name, failReason: String(reason).slice(0, 500), formFields: outFields, details: outDetails };
    }
  }
  return { ok: true, formFields: outFields, details: outDetails };
}

/**
 * 点击视频发布按钮（评分选最像的，保证只在 .publish-footer/.video-batch-footer 作用域优先）
 *
 * 测试模式（testMode=true）：不真的 click，只给命中的按钮画高亮 + 红色标签，返回按钮坐标/尺寸。
 * 正式模式（testMode=false / 不传）：直接点击 best。
 */
function buildClickXiguaVideoPublishScript(testMode: boolean = false): string {
  const runner = function (_testMode: boolean) {
    const res: any = {
      err: null,
      clicked: false,
      testMode: _testMode,
      reason: null,
      candidateCount: 0,
      text: '',
      rank: 0,
      cls: '',
      topThree: [],
      // 测试模式额外返回：定位到的发布按钮坐标/尺寸，以及是否成功高亮
      best: null,
      marked: false,
      fields: [] as any[],
    };
    try {
      const patterns = ['发布', '立即发布', '确认发布'];
      let best: any = null;
      const topList: any[] = [];
      const nodes = document.querySelectorAll('button, a, [role="button"], div, span');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as any; if (!n) continue;
        const txt = ((n.innerText || n.textContent || '').replace(/\s+/g, '')).trim();
        if (!txt || txt.length > 20) continue;
        let matched = false; let rank = 0;
        for (let k1 = 0; k1 < patterns.length; k1++) {
          if (txt === patterns[k1] || txt.indexOf(patterns[k1]) !== -1) { matched = true; rank = 100 - k1 * 10; break; }
        }
        if (!matched) continue;
        const cls = (n.getAttribute ? String(n.getAttribute('class') || '') : '') as string;
        let isDisabled = false;
        try {
          if ((n.offsetWidth | 0) === 0 || (n.offsetHeight | 0) === 0) continue;
          isDisabled = !!(n.disabled || (n.getAttribute && (n.getAttribute('disabled') !== null || n.getAttribute('aria-disabled') === 'true')));
          if (isDisabled) rank -= 1000;
          // 作用域加权（优先 footer 区域）
          let scope: any = n; let inFooter = false; let depth = 0;
          while (scope && depth < 8) {
            const pCls = (scope && scope.getAttribute ? String(scope.getAttribute('class') || '') : '') as string;
            if (pCls.indexOf('publish-footer') !== -1 || pCls.indexOf('video-batch') !== -1 || pCls.indexOf('footer-content') !== -1) { inFooter = true; break; }
            scope = scope.parentElement || scope.parentNode; depth++;
          }
          if (inFooter) rank += 200;
        } catch (_) { /* ignore */ }
        if (cls.indexOf('publish') !== -1 || cls.indexOf('publish-btn') !== -1) rank += 80;
        if (cls.indexOf('primary') !== -1) rank += 50;
        if (cls.indexOf('byte-btn') !== -1) rank += 30;
        // 最佳节点引用仅存在局部变量（不入返回对象，防循环引用序列化失败）
        const info = { el: n, text: txt, cls, rank, disabled: isDisabled };
        if (!isDisabled) { if (!best || rank > best.rank) best = info; }
        topList.push({ text: txt, cls: String(cls || '').slice(0, 60), rank, disabled: isDisabled });
      }
      res.candidateCount = topList.length;
      if (topList.length > 0) {
        topList.sort((a, b) => b.rank - a.rank);
        res.topThree = topList.slice(0, 3);
      }
      if (!best) {
        res.reason = 'no-enabled-button';
      } else {
        const targetEl = best.el;
        const rect: any = targetEl.getBoundingClientRect ? targetEl.getBoundingClientRect() : {};
        res.best = {
          text: String(best.text || '').slice(0, 60),
          cls: String(best.cls || '').slice(0, 200),
          rank: best.rank,
          disabled: !!best.disabled,
          left: Number(rect.left || 0),
          top: Number(rect.top || 0),
          right: Number(rect.right || 0),
          bottom: Number(rect.bottom || 0),
          width: Number(rect.width || 0),
          height: Number(rect.height || 0),
        };
        if (_testMode) {
          // ---- 测试模式：只高亮/标注，不点击 ----
          try {
            // 1. 先注入公共样式 keyframes（只注入一次）
            const styleId = 'flowx-test-highlight-style';
            if (!document.getElementById(styleId)) {
              const s = document.createElement('style');
              s.id = styleId;
              s.textContent = '@keyframes flowx-test-pulse{' +
                '0%,100%{box-shadow:0 0 0 4px rgba(255,107,107,.3),0 0 20px rgba(255,107,107,.5)}' +
                '50%{box-shadow:0 0 0 8px rgba(255,107,107,.5),0 0 30px rgba(255,107,107,.8)}}';
              document.head.appendChild(s);
            }
            // 2. 给按钮加闪烁 outline + box-shadow
            try { targetEl.dataset && (targetEl.dataset.flowxOriginalOutline = targetEl.style.outline || ''); } catch (_) { /* ignore */ }
            try { targetEl.dataset && (targetEl.dataset.flowxOriginalBoxShadow = targetEl.style.boxShadow || ''); } catch (_) { /* ignore */ }
            try { targetEl.dataset && (targetEl.dataset.flowxOriginalZIndex = targetEl.style.zIndex || ''); } catch (_) { /* ignore */ }
            try { targetEl.dataset && (targetEl.dataset.flowxOriginalOutlineOffset = targetEl.style.outlineOffset || ''); } catch (_) { /* ignore */ }
            try { targetEl.dataset && (targetEl.dataset.flowxOriginalPosition = targetEl.style.position || ''); } catch (_) { /* ignore */ }
            try {
              targetEl.style.outline = '3px solid #ff6b6b';
              targetEl.style.outlineOffset = '2px';
              targetEl.style.boxShadow = '0 0 0 4px rgba(255,107,107,.3),0 0 20px rgba(255,107,107,.5)';
              targetEl.style.zIndex = '99999';
              if (targetEl.classList && targetEl.classList.add) targetEl.classList.add('flowx-test-highlight');
              if (typeof getComputedStyle === 'function') {
                try {
                  const cs = getComputedStyle(targetEl) || { position: 'static' };
                  if (cs.position === 'static') targetEl.style.position = 'relative';
                } catch (_) { /* ignore */ }
              }
            } catch (_) { /* ignore */ }
            // 3. 给按钮加红底"🔍 发布按钮（测试模式）"浮层
            try {
              const badge = document.createElement('div');
              badge.textContent = '🔍 发布按钮（测试模式）';
              badge.style.cssText = 'position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:#ff6b6b;color:#fff;' +
                'padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;white-space:nowrap;z-index:100000;pointer-events:none;';
              targetEl.appendChild(badge);
            } catch (_) { /* ignore */ }
            // 4. 右上角悬浮面板
            try {
              const panelId = 'flowx-test-panel';
              if (!document.getElementById(panelId)) {
                const panel = document.createElement('div');
                panel.id = panelId;
                panel.style.cssText = 'position:fixed;top:20px;right:20px;background:#fff;border:2px solid #e6a23c;border-radius:8px;' +
                  'padding:16px;z-index:2147483647;box-shadow:0 4px 20px rgba(0,0,0,.15);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-width:260px;';
                panel.innerHTML = '';
                const t = document.createElement('div');
                t.style.cssText = 'font-weight:600;font-size:14px;color:#e6a23c;margin-bottom:8px;display:flex;align-items:center;gap:6px;';
                t.innerHTML = '🔍 发布测试模式（视频发布）';
                panel.appendChild(t);
                const d = document.createElement('div');
                d.style.cssText = 'font-size:12px;color:#606266;margin-bottom:12px;line-height:1.5;';
                d.textContent = '视频上传完成，标题/简介已自动填写，红色闪烁方框即为发布按钮。请检查表单是否正常，确认无误后再点击下方"确认发布"。';
                panel.appendChild(d);
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:8px;';
                const pb = document.createElement('button');
                pb.textContent = '✅ 确认发布';
                pb.style.cssText = 'flex:1;padding:8px 16px;background:#67c23a;color:#fff;border:none;border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;transition:background .2s;';
                pb.onmouseover = () => { pb.style.background = '#5daf34'; };
                pb.onmouseout = () => { pb.style.background = '#67c23a'; };
                pb.onclick = function () {
                  if (typeof confirm === 'function' && !confirm('确定要发布吗？发布后将无法撤销。')) return;
                  try {
                    // 清理高亮
                    try { targetEl.classList && targetEl.classList.remove && targetEl.classList.remove('flowx-test-highlight'); } catch (_) { /* ignore */ }
                    try { targetEl.style.outline = (targetEl.dataset && targetEl.dataset.flowxOriginalOutline) || ''; } catch (_) { /* ignore */ }
                    try { targetEl.style.outlineOffset = (targetEl.dataset && targetEl.dataset.flowxOriginalOutlineOffset) || ''; } catch (_) { /* ignore */ }
                    try { targetEl.style.boxShadow = (targetEl.dataset && targetEl.dataset.flowxOriginalBoxShadow) || ''; } catch (_) { /* ignore */ }
                    try { targetEl.style.zIndex = (targetEl.dataset && targetEl.dataset.flowxOriginalZIndex) || ''; } catch (_) { /* ignore */ }
                  } catch (_) { /* ignore */ }
                  panel.remove();
                  try { targetEl.scrollIntoView && targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { /* ignore */ }
                  setTimeout(function () {
                    try { targetEl.click && targetEl.click(); } catch (_) { /* ignore */ }
                    try { targetEl.dispatchEvent && targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window as any })); } catch (_) { /* ignore */ }
                  }, 300);
                };
                row.appendChild(pb);
                const cb = document.createElement('button');
                cb.textContent = '关闭';
                cb.style.cssText = 'padding:8px 12px;background:#f5f7fa;color:#606266;border:1px solid #dcdfe6;border-radius:4px;font-size:13px;cursor:pointer;';
                cb.onclick = () => panel.remove();
                row.appendChild(cb);
                panel.appendChild(row);
                document.body.appendChild(panel);
              }
            } catch (_) { /* ignore */ }
            // 5. 最后做一次表单状态快照（标题/简介是否已填）
            try {
              const cfgList = [
                { name: '视频标题', selector: '.form-item-title input, .form-item-title textarea, .publish-title-input, .title-input, input[placeholder*="标题"]', type: 'input' as any },
                { name: '视频简介', selector: '.form-item-intro textarea, .publish-intro-textarea, .abstract-input, textarea[placeholder*="简介"], textarea[placeholder*="介绍"]', type: 'textarea' as any },
              ];
              for (let c = 0; c < cfgList.length; c++) {
                const cfg = cfgList[c];
                const el: any = document.querySelector(cfg.selector);
                let filled = false; let v = ''; let found = !!el;
                if (found) {
                  if (cfg.type === 'contenteditable') { v = String(el.innerText || '').trim(); }
                  else { v = String(el.value || '').trim(); }
                  filled = v.length > 0;
                }
                res.fields.push({ name: cfg.name, type: cfg.type, selector: cfg.selector, found, filled, valueLength: v.length });
              }
            } catch (_) { /* ignore */ }
            res.marked = true;
          } catch (markErr: any) {
            res.err = 'testMode-mark-failed:' + String((markErr && markErr.message) || markErr).slice(0, 500);
          }
        } else {
          // ---- 正式模式：直接点击 ----
          try { targetEl.focus && targetEl.focus(); } catch (_) { /* ignore */ }
          try { targetEl.click && targetEl.click(); } catch (_) { /* ignore */ }
          try { targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window as any })); } catch (_) { /* ignore */ }
          res.clicked = true; res.text = best.text; res.rank = best.rank; res.cls = String(best.cls || '').slice(0, 150);
        }
      }
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner, [testMode]);
}

/**
 * 视频上传进度+转码完成检测（轮询）
 *
 * 历史：progress-item.main .process-item-icon 会依次经过：uploading → scanning → finish
 * 新版（byte-upload / xigua-upload-video-trigger + virtual-upload）：
 *   .video-upload-status
 *     .byte-upload.xigua-upload-video-trigger
 *       .virtual-upload
 *       input[type=file] (display:none，文件真实注入后立刻被组件清空，走内部虚拟上传)
 *     .basic-info
 *       .m-tip-title > .percent ("上传成功" / "上传中…" / "转码中…" / "出错")
 *                    > .tips   (文件名、大小、时长)
 *     .progress-bar  > .progress-bar-inner (width 上传百分比，最终 100%)
 *
 * 任何一种结构命中都会把状态映射成统一的 uploading/scanning/finished/error，并决定 allDone。
 */
function buildProbeXiguaVideoProgressScript(): string {
  const runner = function () {
    const res: any = {
      err: null,
      total: 0, uploading: 0, scanning: 0, finished: 0, error: 0,
      formReady: false, uploadAnchorEmpty: false, allDone: false,
      items: [], byteUpload: null, bodyTip: '', diag: {},
    };
    try {
      try {
        res.bodyTip = (document.body ? (document.body.innerText || '').replace(/\s+/g, ' ') : '').slice(-400);
      } catch (_) { /* ignore */ }

      // ---- 旧版结构：.video-show-progress .progress-items .progress-item + .process-item-icon ----
      try {
        const items = document.querySelectorAll('.video-show-progress .progress-items .progress-item');
        res.total = items.length;
        for (let i = 0; i < items.length; i++) {
          const it = items[i] as any;
          const iCls = String(it.className || '');
          const icon = it.querySelector('.process-item-icon') as any;
          const iconCls = icon ? String(icon.className || '') : '';
          let iName = ''; try { iName = ((it.querySelector('.progress-item-name') as any) || {}).innerText || ''; } catch (_) { /* ignore */ }
          let status = 'pending';
          if (iconCls.indexOf('finish') !== -1 || iCls.indexOf('success') !== -1 || iCls.indexOf('finish') !== -1) { status = 'finish'; res.finished++; }
          else if (iconCls.indexOf('uploading') !== -1 || iCls.indexOf('uploading') !== -1) { status = 'uploading'; res.uploading++; }
          else if (iconCls.indexOf('scanning') !== -1 || iconCls.indexOf('transcode') !== -1) { status = 'scanning'; res.scanning++; }
          else if (iconCls.indexOf('error') !== -1 || iCls.indexOf('error') !== -1) { status = 'error'; res.error++; }
          res.items.push({ cls: String(iCls || '').slice(0, 60), icon: String(iconCls || '').slice(0, 60), status, name: String(iName || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
        }
      } catch (e: any) { res.diag.itemsErr = String((e && e.message) || e).slice(0, 300); }

      // ---- 新版结构：.video-upload-status ----
      try {
        const vus = document.querySelector('.video-upload-status');
        if (vus) {
          const percentEl = vus.querySelector('.percent') as any;
          const tipsEls = vus.querySelectorAll('.m-tip-title > .tips') as any;
          const barInner = vus.querySelector('.progress-bar-inner') as any;
          const vuBtn: any = vus.querySelector('.m-edit-video') || null;
          const vuInput: any = vus.querySelector('input[type="file"]') || null;

          const percentText = percentEl ? String(percentEl.textContent || percentEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
          let barWidth = -1;
          try {
            const m = /width\s*:\s*(-?\d+(?:\.\d+)?)%/i.exec(barInner ? String(barInner.getAttribute('style') || '') : '');
            if (m) barWidth = Number(m[1]);
            // getComputedStyle 兜底
            if (barWidth < 0 && barInner && typeof getComputedStyle === 'function') {
              try {
                const w = (getComputedStyle(barInner) || {}).width || '';
                const m2 = /(-?\d+(?:\.\d+)?)\s*%/.exec(w);
                if (m2) barWidth = Number(m2[1]);
              } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }

          let fileName = ''; let fileSize = ''; let duration = '';
          try {
            for (let k = 0; k < tipsEls.length; k++) {
              const t = String(tipsEls[k].textContent || tipsEls[k].innerText || '').trim();
              if (!fileName && /\.(mp4|flv|wmv|avi|mov|mkv|m4v|mpeg|mpg|webm|m2ts|3gp|ts|rm|rmvb|vob|qt)$/i.test(t)) fileName = t;
              if (!fileSize && /大小\s*:/.test(t)) fileSize = t;
              if (!duration && /时长\s*:/.test(t)) duration = t;
            }
          } catch (_) { /* ignore */ }

          let status = 'pending';
          if (/上传成功|上传完成|已上传/.test(percentText)) {
            status = 'finish'; res.finished = Math.max(res.finished, 1);
          } else if (/上传中/.test(percentText) || (/上传/.test(percentText) && barWidth >= 0 && barWidth < 100)) {
            status = 'uploading'; res.uploading = Math.max(res.uploading, 1);
          } else if (/转码|转码中|处理中|合成/.test(percentText)) {
            status = 'scanning'; res.scanning = Math.max(res.scanning, 1);
          } else if (/失败|错误|出错/.test(percentText)) {
            status = 'error'; res.error = Math.max(res.error, 1);
          }
          // 兜底：progress-bar-inner 达到 100% 但 percentText 文案是空时，也视为完成
          if (status === 'pending' && barWidth >= 100) {
            status = 'finish'; res.finished = Math.max(res.finished, 1);
          }
          // 兜底：barWidth 在 (0,100) 间且无其他文本，视作上传中
          if (status === 'pending' && barWidth > 0 && barWidth < 100) {
            status = 'uploading'; res.uploading = Math.max(res.uploading, 1);
          }

          res.byteUpload = {
            status, percentText, barWidth, fileName, fileSize, duration,
            hasEditBtn: !!vuBtn, hasInput: !!vuInput,
          };
          // 把 byteUpload 视作一个进度项；如果老结构 total=0 说明只有新结构，补齐 total=1
          if (res.total === 0) {
            res.total = 1;
            res.items.push({
              cls: 'video-upload-status progress-item ' + (status === 'finish' ? 'selected' : status),
              icon: 'byte-upload virtual-upload',
              status,
              name: fileName ? fileName.slice(0, 60) : (fileSize + ' ' + duration).trim().slice(0, 60),
            });
          }
        }
      } catch (e: any) { res.diag.byteUploadErr = String((e && e.message) || e).slice(0, 500); }

      try {
        res.formReady = !!document.querySelector('.video-form-basic') && !!document.querySelector('.form-item-title');
      } catch (e: any) { res.diag.formErr = String((e && e.message) || e).slice(0, 300); }

      try {
        // 锚点区还在（空状态）且没有任何进度，说明还没开始上传
        const anchor = document.querySelector('.m-upload-anchor .upload-video-trigger-btn');
        const noProgress = res.total === 0 && !res.byteUpload;
        res.uploadAnchorEmpty = !!anchor && noProgress;
      } catch (_) { /* ignore */ }

      // allDone：至少 1 条进度项（两种结构任一），且 finished>=total 且 error=0，同时表单已渲染
      res.allDone = (res.total > 0 && res.finished >= res.total && res.error === 0 && res.formReady === true);
    } catch (topErr: any) { res.err = String((topErr && topErr.message) || topErr).slice(0, 1500); }
    return JSON.stringify(res);
  };
  return wrapSafeScript(runner);
}

// =====================================================================
// 视频发布主流程
// =====================================================================

async function runXiguaVideoPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const plog = makePublishLogger({ accountId, platform: 'toutiao-video' });

  const videoFile = Array.isArray(request.mediaFiles) ? request.mediaFiles[0] : undefined;
  if (!videoFile) {
    return makeFailedResult(accountId, 'toutiao', '视频发布缺少 mediaFiles（视频文件路径）', startedAt);
  }

  plog('info', 'start', `开始发布今日头条视频（西瓜）`, { videoFile, title: request.title });

  let win: BrowserWindow | null = null;
  let disposeTracker: (() => void) | null = null;

  try {
    // 1) 创建窗口
    win = makePublishWindow(accountId, `今日头条视频发布 - ${request.title || '未命名'}`);
    const tracker = attachNavigationTracker(win, plog);
    disposeTracker = () => tracker.dispose();

    // 2) 加载视频发布页
    onProgress(5, '加载西瓜视频发布页…');
    plog('info', 'load', `打开 ${XIGUA_VIDEO_PUBLISH_URL}`);
    await win.loadURL(XIGUA_VIDEO_PUBLISH_URL).catch((err) => {
      plog('warn', 'load', `loadURL 异常: ${err.message}`);
    });
    onProgress(10, '等待页面加载稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1800);

    // 3) 登录态检测（和微头条复用 detectLoggedIn）
    onProgress(15, '检测登录状态…');
    let loginCheck: any = null;
    try { loginCheck = await detectLoggedIn(win); } catch (e) {
      plog('warn', 'login', `检测失败，降级等待: ${e instanceof Error ? e.message : String(e)}`);
      loginCheck = { loggedIn: false };
    }
    if (!loginCheck || !loginCheck.loggedIn) {
      onProgress(20, '请在窗口中完成登录（最长 120 秒）');
      win.show(); win.focus();
      const deadline = Date.now() + 120000;
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const r: any = await detectLoggedIn(win).catch(() => null);
        if (r && r.loggedIn) { ok = true; break; }
      }
      if (!ok) return makeFailedResult(accountId, 'toutiao', '登录超时', startedAt);
      if (!win.isDestroyed()) {
        const cur = win.webContents.getURL();
        if (cur.indexOf('xigua/upload-video') === -1) await win.loadURL(XIGUA_VIDEO_PUBLISH_URL).catch(() => {});
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      plog('info', 'login', '已登录');
    }

    // 4) 检测视频发布页渲染
    onProgress(22, '检测视频发布页结构…');
    const pageDeadline = Date.now() + 20000;
    let pageReady = false;
    while (Date.now() < pageDeadline) {
      const raw: any = await evalJS(win, buildProbeXiguaVideoPageScript(), 'probe-video-page', plog).catch((e) => ({ err: String(e) }));
      const p: any = parseSafeResult(raw, { wrapperFound: false, uploadAnchorFound: false, fileInputs: [] });
      // 如果 parseSafeResult 抛了 __err 则把 err 打出来
      if (p && (p.err || p.__safeParseErr)) plog('warn', 'probe-page-err', `脚本错误: ${p.err || p.__safeParseErr}`);
      plog('debug', 'probe-page', JSON.stringify(p || null).slice(0, 400));
      if (p && (p.wrapperFound || (p.uploadAnchorFound && p.fileInputs && p.fileInputs.length > 0))) {
        pageReady = true; break;
      }
      await sleep(500);
    }
    if (!pageReady) {
      // 即使结构没完全命中，只要当前 URL 对且 input[type=file] 存在就继续（避免 DOM 延迟渲染）
      const fallback: any = await evalJS(win, buildCheckFileInputScript(), 'file-input-fallback', plog).catch(() => null);
      if (!fallback || !fallback.count || fallback.count === 0) {
        plog('warn', 'probe-page', '页面结构未就绪，最后一次探测: ' + JSON.stringify(fallback || null).slice(0, 200));
        return makeFailedResult(accountId, 'toutiao', '视频发布页结构未就绪（未找到上传锚点或文件输入）', startedAt);
      }
    }

    // 5) 上传视频：CDP 注入文件
    onProgress(25, '准备上传视频…');
    plog('info', 'upload', `开始 CDP 上传视频: ${videoFile}`);
    const uploadOk = await uploadViaCDP(win, [videoFile], plog, 'video');
    if (!uploadOk) {
      return makeFailedResult(accountId, 'toutiao', '视频文件上传失败（CDP 注入未成功）', startedAt);
    }
    onProgress(35, '视频上传中，等待转码…');

    // 6) 等待上传+转码完成 + 表单渲染（最长 10 分钟）
    const upStart = Date.now();
    const upTimeout = 10 * 60 * 1000;
    let lastProgressInfo: any = null;
    let allDone = false;
    while (Date.now() - upStart < upTimeout) {
      if (win.isDestroyed()) break;
      const raw: any = await evalJS(win, buildProbeXiguaVideoProgressScript(), 'video-progress', plog).catch((e) => ({ err: String(e) }));
      const p: any = parseSafeResult(raw, { total: 0, uploading: 0, scanning: 0, finished: 0, error: 0, formReady: false, allDone: false });
      lastProgressInfo = p;
      if (p) {
        if (p.err || p.__safeParseErr) plog('warn', 'progress-err', `脚本错误: ${p.err || p.__safeParseErr} | diag=${JSON.stringify(p.diag || '').slice(0, 200)}`);
        const msg = `上传/转码进度：总数=${p.total || 0} 上传中=${p.uploading || 0} 转码中=${p.scanning || 0} 完成=${p.finished || 0} 表单=${p.formReady ? '就绪' : '未渲染'}`;
        plog('debug', 'progress', msg);
        if (p.total > 0 || p.formReady) {
          onProgress(35 + Math.min(50, Math.floor((p.finished / Math.max(1, p.total)) * 50)), msg);
        }
        if (p.allDone) { allDone = true; break; }
        if (p.error && p.error > 0) {
          return makeFailedResult(accountId, 'toutiao', `视频上传/转码出错 (progress.error=${p.error})`, startedAt);
        }
      }
      await sleep(4000);
    }
    if (!allDone) {
      plog('warn', 'progress', `上传/转码超时或表单未就绪，最后探测: ${JSON.stringify(lastProgressInfo || null).slice(0, 400)}`);
      // 宽限：如果 total>0 且 finished>0 且 formReady 但计算 allDone 因某项未达 100%，则允许继续（西瓜有时候会卡在 scanning 但实际可以填表单）
      if (!lastProgressInfo || !lastProgressInfo.formReady) {
        return makeFailedResult(accountId, 'toutiao', '视频上传/转码超时或表单未渲染（10分钟）', startedAt);
      }
      plog('info', 'progress', '表单已渲染，宽限继续（即使 progress 未达 100%）');
    }
    onProgress(80, '视频就绪，填写标题/简介/话题/封面…');

    // ============ 7~8 + 新增：标题 / 简介 / 话题 / 封面 4 个表单步骤（策略模式编排，头条平台专用，完全在 toutiao.ts 内） ============
    const formSteps = await runXiguaVideoFormSteps(win, request, onProgress, plog);
    plog('info', 'form-steps', `表单步骤结果: ok=${formSteps.ok} failStep=${formSteps.failStep || ''} reason=${String(formSteps.failReason || '').slice(0, 300)}`);
    if (!formSteps.ok) {
      const msg = `表单填写失败（${formSteps.failStep || 'unknown'}）：${formSteps.failReason || 'unknown'}`;
      return makeFailedResult(accountId, 'toutiao', msg, startedAt);
    }

    await sleep(800);

    // 9) 发布按钮检测 + 点击 / 测试模式仅标注
    onProgress(90, request.testMode ? '标记发布按钮位置…' : '点击发布…');
    let publishClicked = false;
    let testMarked = false;
    let testBest: any = null;
    let testFields: any[] = [];
    for (let pa = 0; pa < 3; pa++) {
      if (win.isDestroyed()) break;
      const pageNowRaw: any = await evalJS(win, buildProbeXiguaVideoPageScript(), 'probe-before-publish', plog).catch(() => null);
      const pageNow: any = parseSafeResult(pageNowRaw, { publishBtn: null });
      plog('info', 'before-publish', `发布按钮探测 #${pa + 1}: ${JSON.stringify(pageNow && pageNow.publishBtn ? pageNow.publishBtn : null).slice(0, 300)}`);
      if (pageNow && pageNow.publishBtn && pageNow.publishBtn.disabled) {
        plog('warn', 'before-publish', `发布按钮 disabled，等待 1.5s 再试 (btn=${JSON.stringify(pageNow.publishBtn).slice(0, 150)})`);
        await sleep(1500);
        continue;
      }
      const prRaw: any = await evalJS(
        win,
        buildClickXiguaVideoPublishScript(!!request.testMode),
        `click-publish-${pa}`,
        plog,
      ).catch((e) => ({ err: String(e) }));
      const pr: any = parseSafeResult(prRaw, { clicked: false, marked: false, best: null, fields: [] });
      plog('info', 'publish-click', `#${pa + 1}: ${JSON.stringify(pr || null).slice(0, 600)}`);
      if (pr && pr.best) {
        testBest = pr.best;
        if (Array.isArray(pr.fields) && pr.fields.length > 0) testFields = pr.fields;
      }
      if (pr && pr.marked) {
        testMarked = true;
      }
      if (pr && pr.clicked) { publishClicked = true; break; }
      // 测试模式只要能 successfully mark 就跳出（不需要再重试）
      if (request.testMode && testMarked) break;
      await sleep(1200);
    }
    if (request.testMode) {
      // ===== 测试模式：不做发布判定，直接返回符合 PublishTestResult 规范的成功结果（窗口不关闭，finally 里也不会 destroy） =====
      plog('info', 'test', `测试模式：发布按钮定位结果 marked=${testMarked} best=${JSON.stringify(testBest || null).slice(0, 300)} formSteps.formFields=${JSON.stringify(formSteps.formFields).slice(0, 500)}`);
      // 直接从策略编排器返回的 formSteps.formFields 派生各字段 filled 状态（无需再跑一次标题 eval）
      const getField = (matchRegexp: RegExp) => (Array.isArray(formSteps.formFields) ? formSteps.formFields.find((f: any) => f && matchRegexp.test(String(f.name || ''))) : undefined);
      const titleField = getField(/标题/);
      const abstractField = getField(/简介/);
      const hashtagField = getField(/话题/);
      const posterField = getField(/封面/);
      const titleFilled = !!(titleField && titleField.filled);
      const contentFilled = !!(abstractField ? abstractField.filled : !!request.content);
      const tagsFilled = !!(hashtagField ? (hashtagField.filled || Number(hashtagField.valueLength || 0) > 0) : false);
      const coverUploaded = !!(posterField && posterField.filled);
      const summaryFilled = !!(request.summary && String(request.summary).trim().length > 0);
      const publishButtonInfo = testBest ? {
        text: String(testBest.text || '').slice(0, 60),
        selector: '[rank=' + (testBest.rank || 0) + '] class=' + String(testBest.cls || '').slice(0, 120),
        x: Number(testBest.left || 0),
        y: Number(testBest.top || 0),
        width: Number(testBest.width || 0),
        height: Number(testBest.height || 0),
      } : undefined;
      const successMsg: string = (() => {
        if (publishButtonInfo && testMarked) {
          const loc = `(${Math.round(publishButtonInfo.x)},${Math.round(publishButtonInfo.y)}) ${Math.round(publishButtonInfo.width)}x${Math.round(publishButtonInfo.height)}`;
          return `测试发布成功：已标记发布按钮「${publishButtonInfo.text || ''}」${loc}（title=${titleFilled}/content=${contentFilled}/tags=${tagsFilled}/cover=${coverUploaded}）`;
        }
        if (testBest) return '测试发布：未成功高亮，但找到了候选发布按钮 ' + JSON.stringify(testBest).slice(0, 200);
        return '测试发布：未在页面中定位到发布按钮候选（建议检查页面结构）';
      })();
      const testResult: any = {
        titleFilled,
        summaryFilled,
        contentFilled,
        tagsFilled,
        coverUploaded,
        publishButtonFound: !!(testBest && !testBest.disabled),
        publishButtonInfo,
        note: testMarked ? '页面上已绘制红色闪烁方框 + 浮动说明面板。如需实际发布可点击面板中的「确认发布」。' : '未能绘制高亮，请检查 DOM 是否可见。',
        formFields: Array.isArray(formSteps.formFields) ? formSteps.formFields.map((f: any) => ({
          type: String((f && f.type) || 'unknown'),
          label: String((f && f.name) || ''),
          filled: !!(f && f.filled),
          selector: String((f && f.selector) || ''),
        })) : undefined,
      };
      return {
        accountId,
        platform: 'toutiao',
        status: 'success',
        progress: 100,
        message: successMsg,
        resultUrl: !win.isDestroyed() ? win.webContents.getURL() : '',
        startedAt,
        finishedAt: Date.now(),
        testResult,
      };
    }
    if (!publishClicked) {
      return makeFailedResult(accountId, 'toutiao', '视频发布按钮点击失败（3 次重试均未匹配到可点击目标）', startedAt);
    }

    onProgress(95, '等待发布结果…');

    // 10) 等待发布结果（120 秒）：URL 跳转 / Toast / 成功页
    const resDeadline = Date.now() + 120000;
    let published = false;
    let failReason: string | null = null;
    while (Date.now() < resDeadline) {
      if (win.isDestroyed()) break;
      const raw: any = await evalJS(win, buildPublishResultProbeScript(), 'publish-result', plog).catch(() => null);
      const r: any = parseSafeResult(raw, { success: false, failed: false, hitSuccess: [], hitFail: [] });
      if (r) {
        if (r.success) { published = true; plog('info', 'result', `发布成功: ${JSON.stringify(r).slice(0, 200)}`); break; }
        if (r.failed) { failReason = (r.hitFail && r.hitFail[0]) || '发布失败'; plog('warn', 'result', `失败: ${JSON.stringify(r).slice(0, 200)}`); break; }
      }
      await sleep(2500);
    }
    if (!published) {
      // 宽松：按钮点了且 URL 已经不是 upload-video 且没有 fail → 当作成功
      const curUrl = win.isDestroyed() ? '' : win.webContents.getURL();
      plog('warn', 'result', `未检测到成功关键词，URL=${curUrl}`);
      if (curUrl && curUrl.indexOf('upload-video') === -1 && !failReason) {
        published = true;
      }
    }
    if (!published) {
      return makeFailedResult(accountId, 'toutiao', failReason || '视频发布结果确认超时（2 分钟未检测到发布成功/跳转变更）', startedAt);
    }

    // 发布结果展示用标题：优先用 request.title，否则从 TitleStep 的结果派生（避免引用已删除的局部变量 finalTitle）
    const fallbackTitle = (function () {
      try {
        const titleDetail = (formSteps && formSteps.details && formSteps.details.title && formSteps.details.title.detail) || null;
        if (titleDetail && titleDetail.afterVal) return String(titleDetail.afterVal).slice(0, 60);
        if (request.content) return String(request.content).slice(0, 30);
      } catch (_) { /* ignore */ }
      if (request.mediaFiles && request.mediaFiles[0]) {
        try { return require('path').basename(request.mediaFiles[0]).replace(/\.[^.]+$/, '').slice(0, 30); } catch (_) { /* ignore */ }
      }
      return '';
    })();
    const finalUrl = !win.isDestroyed() ? win.webContents.getURL() : '';
    const resItem: PublishItemProgress = {
      accountId,
      platform: 'toutiao',
      status: 'success',
      progress: 100,
      message: `发布成功 - ${request.title || fallbackTitle}`,
      resultUrl: finalUrl,
      startedAt,
      finishedAt: Date.now(),
    };
    plog('info', 'done', `✅ 今日头条视频发布完成: url=${finalUrl} title=${request.title || fallbackTitle}`);
    return resItem;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    plog('error', 'fatal', `发布流程异常: ${message}`);
    return makeFailedResult(accountId, 'toutiao', message, startedAt);
  } finally {
    try { disposeTracker && disposeTracker(); } catch { /* ignore */ }
    if (request.testMode) {
      plog('info', 'test', '测试模式完成，窗口保持打开');
    } else if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }
}

// =====================================================================
// 登录检测
// =====================================================================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：头条登录后必有 sessionid 或 sid_tt
    const cookies = await win.webContents.session.cookies.get({});
    const sessionid = cookies.find((c) => c.name === 'sessionid' && c.value);
    const sidtt = cookies.find((c) => c.name === 'sid_tt' && c.value);

    const matchedKeywords: string[] = [];
    if (sessionid) matchedKeywords.push('sessionid-cookie');
    if (sidtt) matchedKeywords.push('sid_tt-cookie');

    // 2. 在登录页肯定未登录
    const isLoginPage = currentUrl.includes('/auth/page/login') ||
                        (currentUrl.includes('login') && !currentUrl.includes('profile'));

    // 3. 已进入后台管理页面（URL 包含 profile_v4）
    const inBackend = currentUrl.includes('profile_v4') || currentUrl.includes('/creator/');
    if (inBackend) matchedKeywords.push('in-backend');

    // 4. DOM 辅助检测
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var nameEl = document.querySelector('.nickname') ||
                        document.querySelector('.user-name') ||
                        document.querySelector('[class*="nickname"]');
            var hasLogout = document.body.innerText.indexOf('退出登录') !== -1 ||
                           document.body.innerText.indexOf('退出') !== -1;
            var hasSidebar = document.body.innerText.indexOf('内容管理') !== -1 ||
                            document.body.innerText.indexOf('数据分析') !== -1;
            return !!(nameEl || (hasLogout && hasSidebar));
          } catch(e) {
            return false;
          }
        })()
      `);
      if (domLoggedIn) matchedKeywords.push('dom-profile');
    } catch {
      // ignore
    }

    const loggedIn = (!!sessionid || !!sidtt) && !isLoginPage;

    return {
      loggedIn,
      url: currentUrl,
      title: win.webContents.getTitle(),
      matchedKeywords,
    };
  } catch (e) {
    log('error', 'detectLoggedIn', (e as Error).message);
    return {
      loggedIn: false,
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
    };
  }
}

// =====================================================================
// 提取账号信息
// =====================================================================

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    let nickname = '';
    let avatar = '';
    let platformAccountId = '';
    let fansCount = 0;

    // 1. 提取昵称
    try {
      nickname = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var sel = ['.auth-avator-name','.user-panel .auth-avator-name','.nickname','.user-name','[class*="nickname"]'];
            for (var i = 0; i < sel.length; i++) {
              var el = document.querySelector(sel[i]);
              if (el && el.textContent) {
                var t = el.textContent.trim();
                if (t && t.length < 50 && t !== '头条号'
                    && t.indexOf('下午好') < 0 && t.indexOf('上午好') < 0
                    && t.indexOf('晚上好') < 0 && t.indexOf('欢迎') < 0) {
                  return t;
                }
              }
            }
            var mt = document.querySelector('.menu-title');
            if (mt && mt.textContent) {
              var m = mt.textContent.match(/[\\uff0c,]\\s*(.+)$/);
              if (m && m[1]) return m[1].trim();
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取昵称失败: ' + (e as Error).message);
    }

    // 2. 提取头像
    try {
      avatar = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var sel = ['.auth-avator-img','.user-panel .auth-avator-img','[class*="auth-avator"] img','.avatar img','[class*="avatar"] img'];
            for (var i = 0; i < sel.length; i++) {
              var img = document.querySelector(sel[i]);
              if (img && img.src && img.src.indexOf('data:') < 0) return img.src;
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取头像失败: ' + (e as Error).message);
    }

    // 3. 提取平台账号ID（从个人主页链接）
    try {
      platformAccountId = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var links = document.querySelectorAll('a[href*="/c/user/"]');
            for (var i = 0; i < links.length; i++) {
              var href = links[i].getAttribute('href') || '';
              var m = href.match(/\\/c\\/user\\/(\\d+)/);
              if (m && m[1]) return m[1];
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取账号ID失败: ' + (e as Error).message);
    }

    // 4. 提取粉丝数
    try {
      const fansStr = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var items = document.querySelectorAll('.data-board-item');
            if (items.length > 0) {
              var el = items[0].querySelector('.data-board-item-primary');
              if (el) return el.textContent.trim();
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
      if (fansStr) {
        const num = parseFloat(fansStr.replace(/[^0-9.]/g, ''));
        if (!isNaN(num)) {
          fansCount = fansStr.includes('万') ? Math.round(num * 10000) : Math.round(num);
        }
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '提取粉丝数失败: ' + (e as Error).message);
    }

    log('info', 'extractPageInfo', `提取结果: nickname="${nickname}", id="${platformAccountId}", fans=${fansCount}`);

    return {
      nickname,
      avatar,
      platformAccountId,
      fansCount,
      followCount: 0,
      likeCount: 0,
    };
  } catch (e) {
    log('error', 'extractPageInfo', (e as Error).message);
    return { nickname: '' };
  }
}

// =====================================================================
// 头条话题逐个输入：CDP 真实键盘 + 推荐下拉框点选第一项
// =====================================================================

type PublishLoggerFn = (level: 'info' | 'warn' | 'error', stage: string, message: string, data?: Record<string, unknown>) => void;

async function insertToutiaoTagsOneByOne(
  win: BrowserWindow,
  tags: string[],
  hasContentBefore: boolean,
  plog: PublishLoggerFn,
): Promise<{ ok: boolean; handledCount: number; fallbackCount: number }> {
  if (!tags || tags.length === 0) return { ok: true, handledCount: 0, fallbackCount: 0 };

  // 1) 确保 CDP debugger 已 attach（头条是 contenteditable，真实键盘事件必须走 CDP）
  try {
    if (!win.webContents.debugger.isAttached()) {
      await win.webContents.debugger.attach('1.3');
    }
  } catch (e) {
    plog('warn', 'cdp-tags', `debugger attach 跳过（可能已附加）: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---------- 内部 CDP 工具函数 ----------
  const sendCharKey = async (char: string) => {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      text: char,
      key: char,
      code: '',
    }).catch(() => {});
    await sleep(30);
  };
  const sendSpaceKey = async () => {
    const VK = 32;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
  };
  // ESC 键：用于「话题推荐候选与用户输入不匹配 → 取消话题插入」（提示里写的"敲空格可取消"，ESC 也能取消弹窗但不插入空格）
  const sendESCKey = async () => {
    const VK = 27;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
  };
  const sendEnterKey = async () => {
    const VK = 13;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
    await sleep(50);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
  };
  const sendEndKey = async () => {
    const VK = 35;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'End', code: 'End',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
    await sleep(30);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'End', code: 'End',
      windowsVirtualKeyCode: VK, nativeVirtualKeyCode: VK,
    }).catch(() => {});
  };

  // ---------- 2) 有正文时：聚焦编辑器末尾 → End → Enter 换行 ----------
  if (hasContentBefore) {
    const focusRes: any = await win.webContents.executeJavaScript(buildFocusProseMirrorEndScript()).catch(() => null);
    plog('info', 'cdp-tags', `编辑器聚焦结果: ${JSON.stringify(focusRes)}`);
    await sleep(200);
    await sendEndKey();
    await sleep(100);
    await sendEnterKey(); // 话题单独新起一行
    await sleep(250);
  } else {
    // 无正文也需要聚焦，保证 CDP 键盘事件目标正确
    await win.webContents.executeJavaScript(buildFocusProseMirrorEndScript()).catch(() => {});
    await sleep(300);
  }

  let handledCount = 0;
  let fallbackCount = 0;

  // ---------- 3) 逐个话题处理 ----------
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const tagName = tag.startsWith('#') ? tag.slice(1) : tag;
    if (!tagName) continue;

    plog('info', 'cdp-tags', `处理第${i + 1}/${tags.length}个话题: ${tag}`);

    // 3.1 CDP 输入 # 号（触发平台进入话题模式 + 初始化浮层）
    await sendCharKey('#');
    await sleep(600); // # 号后等待搜索联想浮层初始化（原 500ms，再延长 100ms）

    // 3.2 CDP 逐字符输入话题文字（逐字符确保实时更新推荐列表）
    for (let ci = 0; ci < tagName.length; ci++) {
      await sendCharKey(tagName[ci]);
      await sleep(120); // 原 80ms → 120ms：确保每个字符输入后浮层都更新到位
    }
    await sleep(1500); // 🔑 原 600ms → 1500ms：输入完所有字符后，强制给浮层足够长的异步请求/渲染时间（避免还在显示半截字：#硅谷 → 第一项还是 #硅#）

    // 🔑 2026-08-04 新增：主动派发 input/selectionchange/compositionend 事件链
    // （ProseMirror/TipTap 类编辑器可能需要 selectionchange 才会触发 Mention 插件的浮层渲染）
    if (!win.isDestroyed()) {
      try {
        const triggerScript =
          '(function(){' +
          '  var ce = document.querySelector(\'[contenteditable="true"].ProseMirror\');' +
          '  if (!ce) { ce = document.querySelector(\'[contenteditable="true"]\'); }' +
          '  if (!ce) { return { ce: false }; }' +
          '  var s = window.getSelection();' +
          '  var rng = null;' +
          '  if (s && s.rangeCount > 0) { rng = s.getRangeAt(0).cloneRange(); }' +
          '  var okEvents = [];' +
          '  try { var evIn = new InputEvent(\'input\', { bubbles: true, cancelable: true, data: null, inputType: \'insertText\' }); ce.dispatchEvent(evIn); okEvents.push(\'input\'); } catch(e) {}' +
          '  try { var evComp = new CompositionEvent(\'compositionend\', { bubbles: true, cancelable: true, data: \'\' }); ce.dispatchEvent(evComp); okEvents.push(\'compositionend\'); } catch(e) {}' +
          '  try {' +
          '    if (s && rng) {' +
          '      s.removeAllRanges();' +
          '      s.addRange(rng);' +
          '      okEvents.push(\'selectionchange-restore\');' +
          '    }' +
          '  } catch(e) {}' +
          '  return { ce: true, ceClass: (ce.className||\'\').toString().slice(0,100), events: okEvents.join(\',\'), hasSelRng: rng ? 1 : 0 };' +
          '})()';
        const triggerRes: any = await win.webContents.executeJavaScript(triggerScript).catch(() => null);
        plog('info', 'cdp-tags', `话题输入后主动触发编辑器事件: ${JSON.stringify(triggerRes || {}).slice(0, 200)}`);
      } catch (err) {
        plog('warn', 'cdp-tags', `触发编辑器事件异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await sleep(800); // 🔑 原 300ms → 800ms：触发事件后给浮层更充足的渲染时间（字节系组件异步拉取话题推荐）

    // 3.3 轮询最多 10 秒：推荐浮层是否已出现 + 第一项候选就绪
    // 🔑 关键：找到 firstItem 后不要立即判定 ready，必须再等 1-2 轮确认 firstItemText 稳定了（避免半截字：只输入了 #硅 还没渲染出 #硅谷）
    let ready = false;
    const probeDeadline = Date.now() + 10 * 1000;
    const probeScript = buildProbeTopicSuggestionScript(tagName);
    let probeCount = 0;
    let lastProbeDiag: any = null;
    let lastProbeResult: any = null;
    let stableCount = 0;       // firstItemText 连续相同的轮数
    let prevFirstText = '';    // 上一轮的 firstItemText
    const STABLE_NEED = 2;     // 必须连续 2 轮 firstItemText 完全一致，才算"稳定就绪"
    while (Date.now() < probeDeadline) {
      if (win.isDestroyed()) break;
      const probe: any = await win.webContents.executeJavaScript(probeScript).catch(() => null);
      lastProbeResult = probe;
      probeCount++;
      lastProbeDiag = probe && probe.diag ? probe.diag : null;
      if (probeCount % 10 === 0 || (probe && probe.found)) {
        const preview = probe
          ? { found: probe.found, matchKind: probe.matchKind || '', panelClass: probe.panelClass || '', firstItemExists: probe.firstItemExists, firstItemText: probe.firstItemText || '', diag: probe.diag ? probe.diag : null }
          : null;
        plog('info', 'cdp-tags', `话题浮层探测 #${probeCount}: ${JSON.stringify(preview || null).slice(0, 800)}`);
      }
      if (probe && probe.found && probe.firstItemExists && probe.firstItemText) {
        const cur = String(probe.firstItemText || '').slice(0, 120);
        if (cur && cur === prevFirstText) {
          stableCount++;
        } else {
          stableCount = 1;
          prevFirstText = cur;
        }
        // ✅ 浮层存在 + 第一项存在 + 连续 STABLE_NEED 轮 firstItemText 没变 → 才算 ready
        if (stableCount >= STABLE_NEED) {
          ready = true;
          plog(
            'info',
            'cdp-tags',
            `话题推荐浮层就绪(已稳定 ${stableCount} 轮): firstItem="${probe.firstItemText || ''}", matched=${probe.firstItemMatched}, matchKind=${probe.matchKind || ''}, panelClass=${probe.panelClass || ''}`,
          );
          break;
        }
      } else {
        stableCount = 0;
        prevFirstText = '';
      }
      await sleep(400); // 原 500ms → 400ms：因为需要连续稳定，缩短轮询间隔让整体耗时不增加太多
    }
    // 🔑 没命中时把最后一次 probe 的 diag 原样打出来（精确类名节点计数 + selection 状态）
    if (!ready) {
      plog(
        'warn',
        'cdp-tags',
        `话题浮层探测失败（${probeCount} 轮），最后一次 diag=${JSON.stringify(lastProbeDiag || {}).slice(0, 1500)}`,
      );
    }

    // 3.4 推荐第一项校验：浮层就绪但第一项文本和用户输入的话题不匹配 → 按 Space 取消插入（提示里明确写了"敲空格可取消插入话题"）
    //     匹配 = 去除所有 #号后 firstItemText 以 tagName 开头（支持纯 ASCII + 中文话题；部分长话题浮层带引号/书名号/扩展词视为不匹配）
    let firstTextMatches = false;
    let skipClickAndCancelTopic = false;
    let lastFirstText = '';
    if (ready) {
      try {
        const raw = (lastProbeDiag && lastProbeDiag.__firstText) ? String(lastProbeDiag.__firstText) : '';
        lastFirstText = raw || (lastProbeResult && lastProbeResult.firstItemText ? String(lastProbeResult.firstItemText) : '');
      } catch (_) { lastFirstText = ''; }
      if (!lastFirstText && lastProbeResult && lastProbeResult.firstItemText) {
        lastFirstText = String(lastProbeResult.firstItemText);
      }
      if (lastFirstText) {
        // 1) 去掉所有 # 号 + 去掉末尾「讨论」数字后缀（例：1,394讨论）
        let normalized = String(lastFirstText).replace(/[#＃]/g, '').replace(/\s+/g, ' ').trim();
        normalized = normalized.replace(/[,，0-9]+(讨论|人|条|个|篇|阅读|万|亿|k|K|M|G)?\s*$/, '').trim();
        const want = String(tagName).replace(/[#＃]/g, '').trim();
        // 2) 两档匹配：
        //    a) 强匹配：normalized === want；b) 前向匹配：normalized startsWith want + 下一个字符不是中文/英文字母数字（例：输入"AI"，第一项"AI数据中心…"就是不匹配，因为后面直接连了数据中心）
        if (normalized === want) firstTextMatches = true;
        if (!firstTextMatches && normalized.length >= want.length && want.length > 0) {
          const pre = normalized.slice(0, want.length);
          const next = normalized.length > want.length ? normalized[want.length] : '';
          // 只有 pre===want 且 next 不是 字母/数字/中文字符（即 next 是分隔符/空/标点）才算前向匹配
          if (pre === want && next && !/[A-Za-z0-9\u4e00-\u9fa5]/.test(next)) firstTextMatches = true;
        }
        plog(
          firstTextMatches ? 'info' : 'warn',
          'cdp-tags',
          `话题推荐第一项匹配校验: tagName="${want}" firstItemText="${lastFirstText.slice(0, 80)}" normalized="${normalized.slice(0, 60)}" match=${firstTextMatches}`,
        );
        if (!firstTextMatches) {
          // 🔑 用户明确要求：不匹配就"直接按空格取消插入话题"，不要删任何文本、不要用 ESC
          // ⚠️ ESC 键 或 2次 Space 会导致 ProseMirror 回退/撤销，把刚插入的前一个话题（如 #硅谷）也一起删掉，必须避免
          // 严格按头条提示原文「敲空格可取消插入话题」执行：只按 1 次 Space，不多按、不按 ESC、不做任何文本删除
          skipClickAndCancelTopic = true;
          await sendSpaceKey();
          await sleep(250);
        }
      }
    }

    // 3.5 点击推荐浮层第一项（最多 3 次）—— 仅当匹配通过(skipClick=false)才执行
    let clicked = false;
    let fallbackToSpace = false;
    if (skipClickAndCancelTopic) {
      plog('warn', 'cdp-tags', `话题 "${tag}" 推荐第一项不匹配（firstItem="${lastFirstText.slice(0, 80)}" tagName="${tagName}"），已取消插入该话题`);
      // 取消的话题不计入 handled，也不计入 fallback（用户明确要丢弃）
    } else if (ready) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (win.isDestroyed()) break;
        const clickRes: any = await win.webContents.executeJavaScript(buildClickFirstTopicSuggestionScript(tagName)).catch(() => null);
        plog('info', 'cdp-tags', `点选话题第${attempt + 1}次: ${JSON.stringify(clickRes).slice(0, 200)}`);
        if (clickRes && clickRes.clicked) {
          clicked = true;
          break;
        }
        await sleep(700);
      }
    }

    if (!skipClickAndCancelTopic && !clicked) {
      plog('warn', 'cdp-tags', `话题 "${tag}" 未点选到推荐第一项，回退用 Space 键兜底确认（可能仍为纯文本）`);
      fallbackCount++;
      fallbackToSpace = true;
      // 回退：发送 Space 键（和小红书方式一致），即使没有转为正式话题标签也保证不阻塞后续输入
      await sendSpaceKey();
    }
    await sleep(400);

    // 3.6 额外发一个普通空格 → 光标推到普通文本区，保证下一个话题的 # 号能正常触发搜索（取消了的话题也需要，避免下一个 # 连在上一次文本末尾）
    await sendCharKey(' ');
    await sleep(180);

    if (!fallbackToSpace && !skipClickAndCancelTopic) handledCount++;
  }

  await sleep(500); // 所有话题处理完后稳定
  plog('info', 'cdp-tags', `✅ 话题输入完成：点选成功 ${handledCount} 个，兜底(Space) ${fallbackCount} 个，共 ${tags.length} 个`);
  return { ok: true, handledCount, fallbackCount };
}

// =====================================================================
// 微头条图文发布主流程
// =====================================================================

async function runWeitoutiaoPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const plog = makePublishLogger({ accountId, platform: 'toutiao' });

  plog('info', 'start', `开始发布今日头条微头条图文`, { title: request.title });

  let win: BrowserWindow | null = null;
  let disposeTracker: (() => void) | null = null;

  try {
    // 1) 创建窗口 + 挂导航跟踪器
    win = makePublishWindow(accountId, `今日头条微头条发布 - ${request.title || '未命名'}`);
    const tracker = attachNavigationTracker(win, plog);
    disposeTracker = () => tracker.dispose();

    // 2) 加载微头条发布页
    onProgress(5, '加载微头条发布页…');
    plog('info', 'load', `打开 ${WEITOUTIAO_PUBLISH_URL}`);
    await win.loadURL(WEITOUTIAO_PUBLISH_URL).catch((err) => {
      plog('warn', 'load', `loadURL 异常: ${err.message}`);
    });

    // 3) 等待页面稳定
    onProgress(10, '等待页面加载稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // 4) 检测登录态
    onProgress(15, '检测登录状态…');
    let loginCheck: any = null;
    try {
      loginCheck = await detectLoggedIn(win);
    } catch (scriptErr) {
      plog('warn', 'login', `登录态检测失败，降级等待: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}`);
      loginCheck = { loggedIn: false };
    }

    if (!loginCheck || !loginCheck.loggedIn) {
      plog('warn', 'login', '未检测到登录态，显示窗口等待用户登录…');
      onProgress(20, '请在打开的窗口中完成登录（最长等待 120 秒）');
      win.show();
      win.focus();

      const loginDeadline = Date.now() + 120 * 1000;
      let loggedInNow = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        try {
          const checkRes: any = await detectLoggedIn(win).catch(() => null);
          if (checkRes && checkRes.loggedIn) {
            loggedInNow = true;
            plog('info', 'login', '检测到已登录，继续发布流程');
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!loggedInNow) {
        return makeFailedResult(accountId, 'toutiao', '登录超时或未完成登录', startedAt);
      }

      // 登录后回到发布页
      if (!win.isDestroyed()) {
        const currentUrl = win.webContents.getURL();
        if (currentUrl.indexOf('weitoutiao/publish') === -1) {
          plog('info', 'login', `当前不在发布页 (${currentUrl})，重新跳转`);
          await win.loadURL(WEITOUTIAO_PUBLISH_URL).catch(() => {});
        }
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      plog('info', 'login', '已登录，继续发布流程');
    }

    // 4.4) 处理「已恢复上次编辑未保存的内容」提示：优先点弹窗里的「撤销」让平台自己清空（最稳）
    onProgress(21, '检查草稿恢复弹窗，准备撤销…');
    let undoClicked = false;
    if (!win.isDestroyed()) {
      const dismissScript = buildDismissRestoreTipScript();
      const dismissDeadline = Date.now() + 10 * 1000;
      let pollCount = 0;
      let lastPollInfo: any = null;
      while (Date.now() < dismissDeadline) {
        if (win.isDestroyed()) break;
        pollCount++;
        // 🔑 每 5 轮(1.5s)先跑 1 行极简脚本，确认 webContents.executeJavaScript 本身能返回对象
        //    如果这都返回 catchNull，说明是 WebView 处于无法执行 JS 的状态(导航中/隔离)，不是脚本问题
        if (pollCount === 5 || pollCount === 15 || pollCount === 25) {
          try {
            const sanity: any = await win.webContents.executeJavaScript('({sanity:1,tms:' + Date.now() + '})');
            plog('info', 'undo-restore-tip', `轮询${pollCount}执行环境自检: sanity=${sanity ? sanity.sanity : 'NULL'}, tms=${sanity ? sanity.tms : 'NULL'}`);
          } catch (sanityErr) {
            plog(
              'warn',
              'undo-restore-tip',
              `轮询${pollCount}执行环境自检 FAIL: err=${sanityErr instanceof Error ? sanityErr.message : String(sanityErr)}`,
            );
          }
        }
        // 🔑 catch 不吞成 null：返回 {catchNull:true, errStr} 标记 JS 执行环境异常
        const poll: any = await win.webContents
          .executeJavaScript(dismissScript)
          .catch((e) => ({ catchNull: true, errStr: (e instanceof Error ? `${e.name}:${e.message}` : String(e)).slice(0, 300) }));
        lastPollInfo = poll;
        if (pollCount % 5 === 0 || (poll && poll.undoBtnClicked)) {
          plog(
            'info',
            'undo-restore-tip',
            `草稿撤销弹窗轮询 #${pollCount}: ${JSON.stringify(poll || null).slice(0, 600)}`,
          );
        }
        if (poll && poll.undoBtnClicked) {
          undoClicked = true;
          plog('info', 'undo-restore-tip', `已点击撤销草稿恢复: message="${poll.messageText || ''}"`);
          break;
        }
        await sleep(300);
      }
      if (!undoClicked) {
        plog(
          'info',
          'undo-restore-tip',
          `未检测到草稿恢复弹窗（${pollCount} 轮），最后一次信息: ${JSON.stringify(lastPollInfo || null).slice(0, 600)}`,
        );
      } else {
        await sleep(800);
      }
    }

    // 4.5) 再清一次上次发布残留的已上传图片（兜底：防止撤销没清干净/无弹窗但仍有旧图片）
    onProgress(22, '清理上次发布残留的图片…');
    if (!win.isDestroyed()) {
      try {
        const clearScript = buildClearDanglingImagesScript();
        const clearRes: any = await win.webContents
          .executeJavaScript(clearScript)
          .catch((e) => ({ catchNull: true, errStr: (e instanceof Error ? `${e.name}:${e.message}` : String(e)).slice(0, 300), totalRemoved: 0 }));
        plog(
          'info',
          'clear-dangling-images',
          `清理上次残留图片结果 (undoClicked=${undoClicked}): ${JSON.stringify(clearRes || { totalRemoved: -1 }).slice(0, 600)}`,
        );
        // 如果清理了>0张，再做一轮 poll（500ms×3 次）确认 DOM 生效
        if (clearRes && !clearRes.catchNull && clearRes.totalRemoved > 0) {
          for (let i = 0; i < 3; i++) {
            await sleep(500);
            const second: any = await win.webContents
              .executeJavaScript(clearScript)
              .catch((e) => ({ catchNull: true, errStr: String(e).slice(0, 200), totalRemoved: 0 }));
            if (!second || second.catchNull || second.totalRemoved === 0) break;
            plog('info', 'clear-dangling-images', `第${i + 2}轮再清理: ${JSON.stringify(second).slice(0, 300)}`);
          }
        } else if (clearRes && clearRes.catchNull) {
          plog('warn', 'clear-dangling-images', `残留图清理脚本执行异常(已 catchNull): ${String(clearRes.errStr || '').slice(0, 200)}`);
        }
        // 清理完再 sleep 500ms 给编辑器状态稳定
        await sleep(500);
      } catch (err) {
        plog('warn', 'clear-dangling-images', `清理残留图片异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    onProgress(25, '已登录，准备上传图片…');

    // 5) 如果有图片文件：先点击图片按钮 → 等待 input[type=file] 出现 → 通过 CDP 注入
    const files = request.mediaFiles || [];
    if (files.length > 0) {
      plog('info', 'upload', `待上传图片: ${files.join(', ')}`);

      // 先检查页面是否已有 file input
      let inputCheck: any = await evalJS(win, buildCheckFileInputScript(), '检查file-input', plog).catch(() => null);
      plog('info', 'upload', `初始 file input 状态: ${JSON.stringify(inputCheck).slice(0, 200)}`);

      if (!inputCheck || inputCheck.count === 0) {
        // 点击工具栏"图片"按钮触发展开上传区域
        onProgress(30, '点击图片上传按钮…');
        const clickRes: any = await evalJS(win, buildClickImageButtonScript(), '点击图片按钮', plog).catch(() => null);
        plog('info', 'upload', `图片按钮点击结果: ${JSON.stringify(clickRes).slice(0, 200)}`);
        await sleep(1500);

        // 等待 file input 出现（最多 8 秒）
        const waitStart = Date.now();
        while (Date.now() - waitStart < 8000) {
          await sleep(800);
          const check: any = await win.webContents.executeJavaScript(buildCheckFileInputScript()).catch(() => null);
          if (check && check.count > 0) {
            plog('info', 'upload', `file input 已就绪: ${check.count} 个`);
            break;
          }
        }
      }

      // 通过 CDP 上传图片
      onProgress(40, '上传图片文件…');
      const uploadOk = await uploadViaCDP(win, files, plog, 'image');
      if (!uploadOk) {
        plog('warn', 'upload', 'CDP 图片上传未确认成功，继续尝试填写正文（可能无图模式）');
      } else {
        onProgress(55, '等待图片上传完成…');
        const uploadResult = await waitForUploadComplete(win, plog, onProgress, 180000, tracker);
        if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
          return makeFailedResult(accountId, 'toutiao', '发布窗口已被关闭', startedAt);
        }
        plog('info', 'upload', `图片上传结果: ${JSON.stringify(uploadResult).slice(0, 200)}`);
        await sleep(1000);

        // ============ 关键步骤：等待图片抽屉内 success 标记 → 点击「确定」插入编辑器 ============
        const expectedImgCount = files.length;
        onProgress(60, '等待上传抽屉内图片就绪，准备插入编辑器…');
        const drawerDeadline = Date.now() + 60 * 1000;
        let drawerReady = false;
        let lastDrawerInfo: any = null;
        const drawerProbeScript = buildProbeImageDrawerScript(expectedImgCount);
        while (Date.now() < drawerDeadline) {
          if (win.isDestroyed()) break;
          const probe: any = await win.webContents.executeJavaScript(drawerProbeScript).catch(() => null);
          lastDrawerInfo = probe;
          if (probe && probe.drawerOpen && probe.allUploaded && probe.confirmBtn && probe.confirmBtn.exists && !probe.confirmBtn.disabled) {
            drawerReady = true;
            break;
          }
          // 如果抽屉未出现也可能图片已直接插入（某些场景下无抽屉），做一个快速兜底检测
          if (probe && !probe.drawerOpen) {
            const quickImgCheck: any = await win.webContents.executeJavaScript(buildCheckImageInEditorScript()).catch(() => null);
            if (quickImgCheck && quickImgCheck.editorFound && quickImgCheck.imageCount >= expectedImgCount) {
              plog('info', 'upload-drawer', `未出现抽屉，但编辑器内已存在 ${quickImgCheck.imageCount} 张图片，跳过点击确定`);
              drawerReady = true;
              lastDrawerInfo = { skipped: true, imageInEditor: quickImgCheck.imageCount };
              break;
            }
          }
          await sleep(1200);
        }
        plog('info', 'upload-drawer', `抽屉就绪检测: ${drawerReady}, 最近状态: ${JSON.stringify(lastDrawerInfo).slice(0, 300)}`);

        if (drawerReady && lastDrawerInfo && !lastDrawerInfo.skipped) {
          // 🔑 2026-08-05 新增：点击确定前先把抽屉里多余的已上传图片删掉（倒序保留最后 expectedImgCount 张）
          //    场景：草稿回显导致 old=1 + 本次 upload=1 → totalItems=2 → 点"确定"会插入 2 张
          if (!win.isDestroyed()) {
            try {
              const removeExtrasScript = buildRemoveExtraDrawerImagesScript(expectedImgCount);
              for (let rmAttempt = 0; rmAttempt < 2; rmAttempt++) {
                const rmRes: any = await win.webContents
                  .executeJavaScript(removeExtrasScript)
                  .catch((e) => ({ catchNull: true, errStr: String(e).slice(0, 200) }));
                plog(
                  rmRes && rmRes.removed > 0 ? 'warn' : 'info',
                  'upload-drawer',
                  `清理抽屉多余图（第${rmAttempt + 1}次, expect=${expectedImgCount}）: ${JSON.stringify(rmRes || null).slice(0, 300)}`,
                );
                if (!rmRes || rmRes.catchNull) break;
                if (rmRes && (rmRes.skipped || rmRes.removed === 0 || rmRes.afterCount <= expectedImgCount)) break;
                await sleep(400);
              }
            } catch (rmErr) {
              plog('warn', 'upload-drawer', `清理抽屉多余图异常（不影响主流程）: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
            }
          }
          onProgress(65, '点击「确定」插入图片到编辑器…');
          let confirmClicked = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (win.isDestroyed()) break;
            const clickConfirmRes: any = await evalJS(win, buildClickImageDrawerConfirmScript(), '点击上传抽屉确定', plog).catch(() => null);
            plog('info', 'upload-drawer', `第${attempt + 1}次点击确定结果: ${JSON.stringify(clickConfirmRes)}`);
            if (clickConfirmRes && clickConfirmRes.clicked) {
              confirmClicked = true;
              break;
            }
            // 再次探测当前抽屉状态，确认按钮是否变成可点
            const reprobe: any = await win.webContents.executeJavaScript(drawerProbeScript).catch(() => null);
            if (reprobe && !(reprobe.confirmBtn && !reprobe.confirmBtn.disabled)) {
              plog('warn', 'upload-drawer', `重试：确定按钮从 disabled 变为可用，重试点击`);
              continue;
            }
            await sleep(1500);
          }
          if (!confirmClicked) {
            plog('warn', 'upload-drawer', '3次尝试均未成功点击确定按钮，尝试继续后续流程（图片可能未插入）');
          } else {
            // 等待抽屉关闭 / 图片出现在编辑器（最多 8 秒）
            const insertDeadline = Date.now() + 8000;
            while (Date.now() < insertDeadline) {
              if (win.isDestroyed()) break;
              const imgInEd: any = await win.webContents.executeJavaScript(buildCheckImageInEditorScript()).catch(() => null);
              const drawerNow: any = await win.webContents.executeJavaScript(drawerProbeScript).catch(() => null);
              const drawerClosedNow = !drawerNow || !drawerNow.drawerOpen === false;
              const imgInserted = imgInEd && imgInEd.editorFound && imgInEd.imageCount >= expectedImgCount;
              if (drawerClosedNow || imgInserted) {
                plog('info', 'upload-drawer', `插入结果: drawerClosed=${drawerClosedNow}, imgInEditor=${imgInEd?.imageCount || 0}, expected=${expectedImgCount}`);
                break;
              }
              await sleep(800);
            }
          }
        }
        await sleep(800);
        // 🔑 2026-08-05 新增：div.upload-list 预览区重复缩略图去重
        //     用户反馈：点击"确定"后虽然编辑器里是 1 张，但主页面 div.upload-list 缩略图里出现 2 张完全相同的 img-box-item（同 URL）
        //     策略：以 background-image URL 为 key 去重，同 URL 只保留 1 张（第 1 张），其余点 i.image-remove-btn 删除（绝不 removeChild）
        if (!win.isDestroyed()) {
          try {
            const dedupeScript = buildDedupeUploadListScript();
            for (let dedupeAt = 0; dedupeAt < 2; dedupeAt++) {
              const dedupeRes: any = await win.webContents
                .executeJavaScript(dedupeScript)
                .catch((e) => ({ catchNull: true, errStr: String(e).slice(0, 200) }));
              plog(
                dedupeRes && dedupeRes.removed > 0 ? 'warn' : 'info',
                'upload-list',
                `预览缩略图区重复图去重（第${dedupeAt + 1}次）: ${JSON.stringify(dedupeRes || null).slice(0, 300)}`,
              );
              if (!dedupeRes || dedupeRes.catchNull) break;
              if (!dedupeRes || !dedupeRes.listFound || dedupeRes.beforeCount <= 0 || dedupeRes.removed === 0) break;
              await sleep(500); // 等 DOM 更新
            }
          } catch (dedupeErr) {
            plog('warn', 'upload-list', `预览缩略图区去重异常（不影响主流程）: ${dedupeErr instanceof Error ? dedupeErr.message : String(dedupeErr)}`);
          }
        }
      }
    }

    // 6) 填写正文（ProseMirror 编辑器，不含话题标签）
    onProgress(70, '填写微头条正文…');
    const baseContent = truncate(request.content || '', WEITOUTIAO_CONTENT_LIMIT);
    const tagList = prepareTags(request.tags);
    plog('info', 'fill-content', `正文长度: ${baseContent.length}/${WEITOUTIAO_CONTENT_LIMIT} 字, 标签: ${tagList.length} 个`);
    if ((request.content || '').length > WEITOUTIAO_CONTENT_LIMIT) {
      plog('warn', 'fill-content', `内容过长，已从 ${(request.content || '').length} 字截断到 ${WEITOUTIAO_CONTENT_LIMIT} 字`);
    }
    const contentResult: any = await evalJS(win, buildFillWeitoutiaoContentScript(baseContent), '填写正文', plog);
    plog('info', 'fill-content', `正文填写结果: ${JSON.stringify(contentResult)}`);
    await sleep(500);

    // 6.5) 逐个话题输入：CDP 真实键盘输入 #+文字 → 触发推荐 → 点选第一个
    if (tagList.length > 0 && contentResult && contentResult.ok) {
      onProgress(75, `输入话题标签（${tagList.length} 个，逐个选择推荐项）…`);
      const tagsResult = await insertToutiaoTagsOneByOne(win, tagList, baseContent.length > 0, plog).catch((err) => {
        plog('warn', 'cdp-tags', `话题输入异常，跳过: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (tagsResult) {
        plog('info', 'cdp-tags', `话题输入完成统计: handled=${tagsResult.handledCount}, fallback=${tagsResult.fallbackCount}`);
      }
      await sleep(500);
    }

    // 7) 点击"发布"按钮
    onProgress(85, '点击发布按钮…');

    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          '.byte-btn.publish-content',
          '.byte-btn.byte-btn-primary',
          'button.publish-content',
          '[class*="publish"] [class*="primary"]',
          '.publish-btn',
        ],
        [
          { name: '正文', selector: '.sg-editor .ProseMirror', type: 'contenteditable' },
          { name: '正文2', selector: '[contenteditable].ProseMirror', type: 'contenteditable' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', plog).catch(() => null);
      const testResult = {
        contentFilled: !!(contentResult && contentResult.ok),
        tagsFilled: tagList.length > 0,
        coverUploaded: files.length > 0,
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: testRes?.note || '测试模式完成',
        titleFilled: true,
      };
      plog('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      setupTestModeWindow(win, plog);
      return {
        accountId,
        platform: 'toutiao',
        status: 'success',
        progress: 100,
        message: '测试完成 - 微头条表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult,
      } as PublishItemProgress;
    }

    const clickResult: any = await evalJS(win, buildClickPublishScript(), '点击发布', plog);
    plog('info', 'click-publish', `发布按钮点击结果: ${JSON.stringify(clickResult)}`);
    const clicked = !!(clickResult && clickResult.clicked);
    if (!clicked) {
      return makeFailedResult(accountId, 'toutiao', '未找到发布按钮或点击失败', startedAt);
    }
    await sleep(1500);

    // 8) 等待发布结果（轮询最多 60 秒）
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
        // ignore
      }
    }

    onProgress(100, '发布完成');
    plog('info', 'done', `最终状态: ${JSON.stringify(finalState)}`);

    const success = !!(finalState && finalState.success);
    const progress: PublishItemProgress = {
      accountId,
      platform: 'toutiao',
      status: success ? 'success' : 'failed',
      progress: 100,
      message: success
        ? '今日头条微头条发布成功'
        : finalState && finalState.hitFail && finalState.hitFail.length > 0
          ? `发布失败: ${finalState.hitFail.join(', ')}`
          : '发布结果未明确，请在头条号后台确认',
      resultUrl: finalState && finalState.url ? finalState.url : WEITOUTIAO_PUBLISH_URL,
      startedAt,
      finishedAt: Date.now(),
    };
    return progress;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    plog('error', 'fatal', `发布流程异常: ${message}`);
    return makeFailedResult(accountId, 'toutiao', message, startedAt);
  } finally {
    try { disposeTracker?.(); } catch { /* ignore */ }
    if (request.testMode) {
      plog('info', 'test', '测试模式完成，窗口保持打开');
    } else if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }
}

// =====================================================================
// 对外发布接口
// =====================================================================

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runWeitoutiaoPublish(accountId, request, onProgress);
}

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runXiguaVideoPublish(accountId, request, onProgress);
}

// 向后兼容：旧版通用 publish 接口
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  // 根据 contentType 自动分发
  if (request.contentType === 'video') {
    return runXiguaVideoPublish(accountId, request, onProgress);
  }
  if (request.contentType === 'image') {
    return runWeitoutiaoPublish(accountId, request, onProgress);
  }
  // 默认走微头条图文（image 是微头条最常用的类型）
  return runWeitoutiaoPublish(accountId, request, onProgress);
}

// =====================================================================
// 注册平台
// =====================================================================

const adapter: PlatformAdapter = {
  key: meta.key,
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publish,
  publishImage,
  publishVideo,
};

registerPlatform(adapter);

log('info', 'register', '今日头条平台适配器已注册（支持微头条图文发布 + 西瓜视频发布）');
