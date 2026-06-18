import type { BrowserWindow } from 'electron';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import { sleep, makePublishLogger, makePublishWindow, attachNavigationTracker, evalJS, makeFailedResult, uploadViaCDP, waitForUploadComplete, buildPageStructureProbe } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities, ContentType } from '../../../types';

const TITLE_MAX = 80;
const CONTENT_MAX = 1000;
const TAG_MAX = 10;

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
    const cleaned = tags.map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0; }).map(function (t) { return t.startsWith('#') ? t : '#' + t; });
    const deduped = Array.from(new Set(cleaned));
    const limited = deduped.slice(0, TAG_MAX);
    parts.push(limited.join(' '));
  }
  const combined = parts.join('\n');
  return truncate(combined, CONTENT_MAX);
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

// === 账号信息提取
async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    const info = await win.webContents.executeJavaScript(`
      (function () {
        var r = { nickname: '', avatar: '', fansCount: null };
        var nickSelectors = ['[class*="header-"] [class*="name-"]'];
        for (var i = 0; i < nickSelectors.length; i++) {
          var el = document.querySelector(nickSelectors[i]);
          if (el && el.textContent && el.textContent.trim()) { r.nickname = el.textContent.trim(); break; }
        }
        try {
          var avaSels = ['.user_avatar', 'img[class*="avatar"]'];
          for (var j = 0; j < avaSels.length; j++) {
            var el2 = document.querySelector(avaSels[j]);
            if (el2 && el2.getAttribute && el2.getAttribute('src')) { r.avatar = el2.getAttribute('src'); break; }
          }
        } catch (e) {}
        try {
          var fullText = document.body ? (document.body.innerText || '') : '';
          var fm = fullText.match(/(\\d+(?:\\.\\d+)?[万wWkK千]?)\\s*粉丝|粉丝\\s*[数:：]?\\s*(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
          if (fm && fm[1]) {
            var v1 = parseFloat(fm[1]);
            if (!isNaN(v1)) { if (/[万wW]/.test(fm[1])) v1 = Math.round(v1 * 10000); r.fansCount = Math.round(v1); }
          }
        } catch (e) {}
        return r;
      })();
    `).catch(function () { return {}; });
    return { nickname: info.nickname || '', avatar: info.avatar, fansCount: typeof info.fansCount === 'number' ? info.fansCount : undefined } as ExtractedAccountInfo;
  } catch (e) {
    return { nickname: '', avatar: undefined, fansCount: undefined } as ExtractedAccountInfo;
  }
}

// === 抖音标题填写脚本（标题是 <input type="text">，不是 contenteditable！）
// 优先级：1) placeholder 含"标题"/"作品标题"的 input  2) 普通 contenteditable（兜底）
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
          inp.value = text;
          try { var ev1 = document.createEvent('Event'); ev1.initEvent('input', true, true); inp.dispatchEvent(ev1); } catch (eEv) {}
          try { var ev2 = document.createEvent('Event'); ev2.initEvent('change', true, true); inp.dispatchEvent(ev2); } catch (eEv2) {}
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
          ta.value = text;
          try { var ev3 = document.createEvent('Event'); ev3.initEvent('input', true, true); ta.dispatchEvent(ev3); } catch (eEv3) {}
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
function buildFillContentScript(content: string): string {
  const contentJson = JSON.stringify(content);
  return `(function () {
    var content = ${contentJson};
    if (!content) return { ok: true, skipped: true };
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
          for (var li = 0; li < lines.length; li++) {
            document.execCommand('insertText', false, lines[li]);
            if (li < lines.length - 1) document.execCommand('insertText', false, '\\n');
          }
          return { ok: true, method: 'prosemirror' };
        }
      }
    } catch (e1) {}
    // 2) 普通 contenteditable
    try {
      var ce2 = document.querySelectorAll('[contenteditable]');
      for (var i2 = 0; i2 < ce2.length; i2++) {
        var e2 = ce2[i2];
        var ceVal2 = e2.getAttribute && e2.getAttribute('contenteditable');
        if (ceVal2 === 'false') continue;
        var cls2 = String(e2.className || '');
        if (/tiptap|ProseMirror|prosemirror/i.test(cls2)) continue; // 跳过 ProseMirror
        e2.focus();
        try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (eX2) {}
        document.execCommand('insertText', false, content);
        return { ok: true, method: 'plain-ce' };
      }
    } catch (e2) {}
    // 3) 兜底 textarea
    try {
      var ta1 = document.querySelectorAll('textarea');
      for (var j1 = 0; j1 < ta1.length; j1++) {
        var e3 = ta1[j1];
        e3.focus();
        e3.value = content;
        try { var ev2 = document.createEvent('Event'); ev2.initEvent('input', true, true); e3.dispatchEvent(ev2); } catch (eErr2) {}
        return { ok: true, method: 'textarea' };
      }
    } catch (e3) {}
    return { ok: false, reason: 'no-content-field' };
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
    // 失败信号
    var fail = /发布失败|不符合要求|违规|失败|无法发布|出错/i.test(successText);
    return {
      url: url,
      text: successText.slice(0, 400),
      success: textSuccess || urlSuccess || leftPublishPage,
      fail: fail
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
    if (!uploadResult.ready) { log('warn', 'upload', '上传完成检测失败: ' + uploadResult.finalStatus); }
    onProgress(60, '上传完成，准备填写内容…');
    await sleep(1500);
    const titleText = truncate((request.title || '').trim(), TITLE_MAX);
    const contentText = buildContentText(request.content, request.tags);
    log('info', 'fill', '准备写入: title=' + (titleText || '').slice(0, 40) + ', contentLen=' + contentText.length);
    if (titleText) {
      const script1 = buildFillTitleScript(titleText);
      const res1: any = await evalJS(win, script1, 'fill-title', log).catch(function () { return null; });
      if (!res1 || !res1.ok) log('warn', 'fill', '标题填写失败');
      else log('info', 'fill', '标题已写入');
      await sleep(800);
    }
    if (contentText) {
      const script2 = buildFillContentScript(contentText);
      const res2: any = await evalJS(win, script2, 'fill-content', log).catch(function () { return null; });
      if (!res2 || !res2.ok) log('warn', 'fill', '内容填写失败');
      else log('info', 'fill', '内容已写入 (' + (res2 && res2.method) + ')');
      await sleep(1500);
    }
    onProgress(75, '点击发布按钮…');
    const clickScript = buildClickPublishScript();
    const clickRes: any = await evalJS(win, clickScript, 'click-publish', log).catch(function () { return null; });
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', '发布按钮点击失败');
    } else {
      log('info', 'publish', '发布按钮已点击 (text=' + clickRes.text + ')');
    }
    onProgress(85, '等待发布结果…');
    const resultDeadline = Date.now() + 120000;
    let lastUrl = '', lastText = '';
    while (Date.now() < resultDeadline) {
      if (!win || win.isDestroyed()) break;
      try {
        const check: any = await evalJS(win, buildPublishResultProbeScript(), 'check-result', log).catch(function () { return null; });
        if (check) {
          lastUrl = check.url || '';
          lastText = check.text || '';
          if (check.success) {
            log('info', 'done', '发布成功');
            onProgress(100, '发布成功');
            return { accountId: accountId, platform: 'douyin', status: 'success', progress: 100, message: '发布成功', url: lastUrl, startedAt: startedAt, finishedAt: Date.now() } as PublishItemProgress;
          }
          if (check.fail) {
            log('warn', 'done', '页面提示失败');
            return makeFailedResult(accountId, 'douyin', '发布失败', startedAt);
          }
        }
      } catch (e) {}
      await sleep(2500);
    }
    return makeFailedResult(accountId, 'douyin', '等待发布结果超时', startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', '发布流程异常: ' + msg);
    return makeFailedResult(accountId, 'douyin', msg, startedAt);
  } finally {
    if (tracker) { try { tracker.dispose(); } catch (e) {} }
    if (win && !win.isDestroyed()) {
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
  return runDouyinPublish(accountId, request, onProgress, 'article');
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
