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
    publishVideo: false,
    publishImage: true,
    publishArticle: false,
  } as AccountCapabilities,
  contentLimits: {
    title: 30,
    content: WEITOUTIAO_CONTENT_LIMIT,
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

/**
 * 生成"检测发布结果"的脚本（轮询使用）
 */
function buildPublishResultProbeScript(): string {
  return (
    '(function(){' +
    'var url = location.href || "";' +
    'var bodyText = "";' +
    'try { bodyText = (document.body ? (document.body.innerText || "") : "") || ""; } catch(e) {}' +
    'var successKeywords = ["发布成功", "已发布", "发布完成", "发布成功，正在审核", "微头条已发布"];' +
    'var failKeywords = ["发布失败", "发布未成功", "服务器开小差", "网络异常", "内容包含敏感", "违反社区公约", "内容不能为空"];' +
    'var hitSuccess = [];' +
    'var hitFail = [];' +
    'for (var i = 0; i < successKeywords.length; i++) if (bodyText.indexOf(successKeywords[i]) !== -1) hitSuccess.push(successKeywords[i]);' +
    'for (var j = 0; j < failKeywords.length; j++) if (bodyText.indexOf(failKeywords[j]) !== -1) hitFail.push(failKeywords[j]);' +
    'var leftPublish = url.indexOf("weitoutiao/publish") === -1 && url.indexOf("graphic/publish") === -1;' +
    'var isSuccessPage = url.indexOf("success") !== -1 || url.indexOf("published=true") !== -1;' +
    '// 检测是否有"发布成功"弹窗或 toast' +
    'var hasSuccessToast = false;' +
    'try {' +
    '  var toastEls = document.querySelectorAll(\'[class*="toast"], [class*="message"], [class*="notification"], [class*="notice"]\');' +
    '  for (var ti = 0; ti < toastEls.length; ti++) {' +
    '    var tText = (toastEls[ti].innerText || "").replace(/\\s+/g, "");' +
    '    for (var si = 0; si < successKeywords.length; si++) {' +
    '      if (tText.indexOf(successKeywords[si]) !== -1) { hasSuccessToast = true; hitSuccess.push("toast:" + successKeywords[si]); break; }' +
    '    }' +
    '  }' +
    '} catch(e) {}' +
    'return {' +
    '  url: url,' +
    '  success: hitSuccess.length > 0 || isSuccessPage || hasSuccessToast || (leftPublish && hitFail.length === 0),' +
    '  failed: hitFail.length > 0,' +
    '  hitSuccess: hitSuccess,' +
    '  hitFail: hitFail,' +
    '  leftPublish: leftPublish,' +
    '  isSuccessPage: isSuccessPage,' +
    '  hasSuccessToast: hasSuccessToast' +
    '};' +
    '})()'
  );
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

// 向后兼容：旧版通用 publish 接口
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  // 根据 contentType 自动分发
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
};

registerPlatform(adapter);

log('info', 'register', '今日头条平台适配器已注册（支持微头条图文发布）');
