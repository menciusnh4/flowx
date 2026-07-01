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
  buildPageStructureProbe,
  cdpInsertTagsWithSpace,
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
 * 快手平台适配器（完全独立实现，不依赖 runStandardPublish / buildFillTitle 等平台特定脚本）。
 *
 * 架构：
 *   - detectLoggedIn / extractPageInfo：保留原有 DOM 查询逻辑（无外部依赖）
 *   - publishVideo / publishImage：在 kuaishou.ts 内部实现完整发布流程
 *     1. 打开窗口 + 导航跟踪
 *     2. 加载对应发布 URL（视频 / 图文）
 *     3. 等待页面稳定
 *     4. 检测登录状态
 *     5. 图文模式：必要时点击"上传图文"tab
 *     6. 上传素材（uploadViaCDP，已接受 contentType 参数）
 *     7. 等待上传完成（waitForUploadComplete）
 *     8. 填写标题/内容/标签（自制脚本 + 字数截断）
 *     9. 点击发布按钮（自制脚本）
 *     10. 等待"发布成功"（URL 变为 manage 开头 或 文本出现"发布成功"）
 *     11. 返回结果
 *
 * 页面结构要点：
 *   - 视频发布 URL：https://cp.kuaishou.com/article/publish/video
 *   - 图文发布 URL：https://cp.kuaishou.com/article/publish/video?tabType=2
 *   - 标题：contenteditable 元素（视频模式独有，图文无独立标题）
 *   - 正文：contenteditable 元素，placeholder 含 "添加合适的话题和描述"
 *   - 发布按钮：div 带类名 _button-primary_ / _button_3a3lq_，文本含"发布"
 *   - 字数限制：标题 80，正文/描述 500
 *   - 标签限制：最多 4 个（图文与视频一致）
 *   - 页面没有 Shadow DOM，不需要 pierce 处理
 */

const meta: PlatformMeta = {
  key: 'kuaishou',
  name: '快手',
  icon: '🎬',
  platformAccountLabel: '快手号',
  authUrl: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3Dhttps%253A%252F%252Fcp.kuaishou.com%252Fprofile%26setRootDomain%3Dtrue',
  publishUrl: 'https://cp.kuaishou.com/article/publish/video',
  homeUrl: 'https://cp.kuaishou.com/',
  contentTypes: ['video', 'image'],
  capabilities: {
    publishVideo: true,
    publishImage: true,
    publishArticle: false,
  } as AccountCapabilities,
  contentLimits: {
    title: 80,
    content: 500,
  },
  nicknameSelectors: [
    '[class*="user-name"]',
    '[class*="nickname"]',
    '[class*="nick-name"]',
    '.user-name',
    '.nickname',
    '.header-info-card .user-name',
    '[class*="username"]',
  ],
  avatarSelectors: [
    '[class*="avatar"] img',
    '[class*="user-image"]',
    'img[class*="img-"]',
    'img[class*="avatar"]',
    '.user-image',
    '.user-info img',
    '.header-info-card img',
  ],
  loginKeywords: ['创作中心', '发布作品', '作品管理', '粉丝', '数据分析', '个人中心', '发布视频'],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const info: any = await win.webContents.executeJavaScript(
      `
      (function () {
        var bodyText = document.body ? (document.body.innerText || '') : '';
        var curUrl = location.href;
        var keywords = ${JSON.stringify(meta.loginKeywords)};
        var matched = [];
        var isLoginPage = /login|passport|redirectReason|signin|401|signup|sso|captcha/i.test(curUrl);
        var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
        var hasAccountEl = false;
        var rawNick = '';
        for (var i = 0; i < nickSels.length; i++) {
          var el = document.querySelector(nickSels[i]);
          if (el && el.textContent && el.textContent.trim() && el.textContent.trim().length > 0) {
            hasAccountEl = true;
            rawNick = el.textContent.trim();
            break;
          }
        }
        for (var j = 0; j < keywords.length; j++) {
          if (bodyText.indexOf(keywords[j]) !== -1) matched.push(keywords[j]);
        }
        var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3);
        return { loggedIn: loggedIn, matched: matched, title: document.title, url: curUrl, isLoginPage: isLoginPage, hasAccountEl: hasAccountEl, rawNick: rawNick };
      })();
    `,
    );
    return {
      loggedIn: info.loggedIn,
      url: info.url || '',
      title: info.title || '',
      matchedKeywords: info.matched,
    };
  } catch {
    return { loggedIn: false, url: '', title: '' };
  }
}

// ========================= 账号信息提取 =========================

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  const result: any = await win.webContents
    .executeJavaScript(
      `(function () {
      var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };
      var debug = { samples: [], hit: 0, errors: [], cookieUserId: null };

      function parseCount(text) {
        try {
          var clean = (text || '').trim().replace(/[,\\s]/g, '');
          var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千])?$/);
          if (!pm) return null;
          var n = parseFloat(pm[1]);
          if (pm[2]) {
            if (/[万wW]/.test(pm[2])) n *= 10000;
            else if (/[千kK]/.test(pm[2])) n *= 1000;
          }
          return Math.round(n);
        } catch (e) { return null; }
      }

      // 处理单个元素：从文本中解析统计信息
      function tryExtractItem(el) {
        if (!el || !el.textContent) return;
        var txt = el.textContent.trim();
        if (!txt || txt.length > 40) return;
        if (debug.samples.length < 10) debug.samples.push(txt.replace(/\\s+/g, ' '));
        var lab = txt.match(/(粉丝|关注|获赞|点赞)/);
        var num = txt.match(/(\\d+(?:\\.\\d+)?[万wWkK千]?)/);
        if (!lab || !num) return;
        var nv = parseCount(num[1]);
        if (nv === null || nv < 0) return;
        if (lab[1] === '粉丝' && r.fansCount === null) r.fansCount = nv;
        else if (lab[1] === '关注' && r.followCount === null) r.followCount = nv;
        else if ((lab[1] === '获赞' || lab[1] === '点赞') && r.likeCount === null) r.likeCount = nv;
      }

      // 第一步：在整个 document 中查询
      try {
        var directItems = document.querySelectorAll('[class*="user-cnt__item"], [class*="user_cnt__item"]');
        for (var di = 0; di < directItems.length; di++) {
          tryExtractItem(directItems[di]);
        }
        var containers = document.querySelectorAll('.header-info-card, [class*="user-cnt"], [class*="el-popover"], .user-info-popper, [class*="user-info-popper"]');
        for (var ci = 0; ci < containers.length; ci++) {
          var subs = containers[ci].querySelectorAll('div, span, li, a');
          for (var si = 0; si < subs.length; si++) {
            tryExtractItem(subs[si]);
          }
        }
      } catch (e) { debug.errors.push(String(e)); }

      // 第二步：提取昵称
      try {
        var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
        for (var ni = 0; ni < nickSels.length; ni++) {
          var nEl = document.querySelector(nickSels[ni]);
          if (nEl && nEl.textContent && nEl.textContent.trim()) {
            r.nickname = nEl.textContent.trim().split(/\\s|\\n|\\r/)[0];
            if (r.nickname.length > 0) break;
          }
        }
      } catch (e) { debug.errors.push('nick:' + String(e)); }

      // 第三步：头像
      try {
        var avaSels = ${JSON.stringify(meta.avatarSelectors)};
        for (var ai = 0; ai < avaSels.length; ai++) {
          var aEl = document.querySelector(avaSels[ai]);
          if (aEl) {
            var src = aEl.getAttribute && aEl.getAttribute('src');
            if (!src && aEl.tagName && aEl.tagName.toLowerCase() !== 'img') {
              var inner = aEl.querySelector && aEl.querySelector('img');
              src = inner ? inner.getAttribute('src') : null;
            }
            if (src) { r.avatar = src; break; }
          }
        }
      } catch (e) { debug.errors.push('ava:' + String(e)); }

      // 第四步：从 cookie 解析 user_id / kuaiShouId
      try {
        var cookieStr = document.cookie || '';
        // 🔑 增加 (?:^|;\\s*) 前缀边界，防止误匹配到 bUserId
        var uidMatch = cookieStr.match(/(?:^|;\\s*)(?:userId|user_id|kuaiShouId|ks_id)=([^;\\s]+)/i);
        if (uidMatch) {
          debug.cookieUserId = uidMatch[1];
          r.platformAccountId = uidMatch[1];
        }
      } catch (e) { debug.errors.push('cookie:' + String(e)); }

      // 第五步：从 URL 提取 id（兜底）
      try {
        var urlText = location.href || '';
        var urlMatch = urlText.match(/(?:userId|profileId|kuaiShouId)=([^&\\s]+)/i);
        if (urlMatch && !r.platformAccountId) r.platformAccountId = urlMatch[1];
      } catch (e) { /* ignore */ }

      r._debug = debug;
      return r;
    })();`,
    )
    .catch((e: Error) => {
      console.warn('[kuaishou] extractPageInfo failed', e.message);
      return {} as any;
    });

  let platformAccountId = result.platformAccountId;
  if (!platformAccountId && !win.isDestroyed()) {
    try {
      const cookies = await win.webContents.session.cookies.get({});
      const targetKeys = [
        'userId',
        'kuaishou.server.web_ph',
        'user_id',
        'ks_id',
        'kuaiShouId',
      ];
      for (const key of targetKeys) {
        const c = cookies.find((x) => x.name === key);
        if (c && c.value && c.value.trim()) {
          platformAccountId = c.value.trim();
          break;
        }
      }
    } catch (e) {
      console.warn('[kuaishou] 提取 session cookies 失败:', e);
    }
  }

  return {
    nickname: result.nickname || '',
    avatar: result.avatar || undefined,
    platformAccountId: platformAccountId || undefined,
    fansCount: typeof result.fansCount === 'number' ? result.fansCount : undefined,
    followCount: typeof result.followCount === 'number' ? result.followCount : undefined,
    likeCount: typeof result.likeCount === 'number' ? result.likeCount : undefined,
    _debug: result._debug,
  } as ExtractedAccountInfo & { _debug?: Record<string, unknown> };
}

// ========================= 工具：文本截断 / 标签拼接 =========================

const TITLE_MAX = 80;
const CONTENT_MAX = 500;
const TAG_MAX = 4;

/** 截取字符串，按 UTF-16 code unit，末尾加 "..." */
function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** 格式化 tag 列表：加 "#" 前缀、去重、截断数量 */
function buildTagsString(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  const cleaned = prepareTags(tags);
  return cleaned.join(' ');
}

/**
 * 清洗标签数组：去空、加#前缀、去重、截断到TAG_MAX
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
    if (result.length >= TAG_MAX) break;
  }
  return result;
}

/**
 * 组装要写入内容字段的基础文本（不含标签，标签单独插入以触发话题识别）：[标题] + [正文]（按字数限制截断）。
 * 对于图文模式，skipTitle=true，表示"标题并入内容"，内容里保留完整文本。
 */
function buildContentBaseText(
  title: string | undefined,
  content: string | undefined,
  skipTitle: boolean,
): string {
  const titleText = (title || '').trim();
  const contentText = (content || '').trim();

  // 标题字段独占（视频模式）：标题单独填入 title 输入框，内容字段只含正文
  if (!skipTitle) {
    return truncate(contentText, CONTENT_MAX);
  }

  // skipTitle=true：把 title + content 合并进内容字段，总长 <= CONTENT_MAX
  const parts: string[] = [];
  if (titleText) parts.push(titleText);
  if (contentText) parts.push(contentText);
  const base = parts.join('\n');
  return truncate(base, CONTENT_MAX);
}

// ========================= 快手平台专用脚本 =========================

/**
 * [快手专用] 切换到图文 tab。
 *
 * 页面默认在视频页，图文必须点击"上传图文"按钮或进入 tabType=2 URL。
 * 策略：
 *   1. 查找文本精确匹配"上传图文"或包含"图文"关键词的可点击元素
 *   2. 若无法点击，直接 navigate 到 tabType=2 URL
 */
async function switchToImageTab(
  win: BrowserWindow,
  log: (level: 'info' | 'warn' | 'error', stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  log('info', 'tab', '尝试点击图文 tab 按钮…');

  const script = `
    (function () {
      var roots = [document];
      var candidates = [];
      for (var ri = 0; ri < roots.length; ri++) {
        var root = roots[ri];
        if (!root || !root.querySelectorAll) continue;
        var tags = ['button', 'a', 'div', 'span', 'li'];
        for (var ti = 0; ti < tags.length; ti++) {
          var els = root.querySelectorAll(tags[ti]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            try {
              var txt = (el.innerText || el.textContent || '').trim();
              if (!txt || txt.length > 40) continue;
              var score = 0;
              if (txt === '上传图文') score += 2000;
              else if (txt.indexOf('图文') !== -1 && txt.indexOf('视频') === -1) score += 1000;
              else if (txt.indexOf('图片') !== -1 && txt.indexOf('视频') === -1) score += 500;
              if (score === 0) continue;
              if (tags[ti] === 'button') score += 300;
              else if (tags[ti] === 'a') score += 200;
              try {
                if ((el.offsetWidth || 0) < 20 || (el.offsetHeight || 0) < 15) continue;
                if ((el.offsetWidth || 0) > 1200 || (el.offsetHeight || 0) > 300) continue;
              } catch (eSz) {}
              var cls = el.getAttribute && el.getAttribute('class') || '';
              candidates.push({ el: el, score: score, text: txt.slice(0, 40), tag: tags[ti], cls: (cls || '').slice(0, 60) });
            } catch (e) {}
          }
        }
        // 额外：[role="tab"] 或 tab 类名
        try {
          var roleTabs = root.querySelectorAll('[role="tab"], [class*="tab-"], [class*="Tab"]');
          for (var ri2 = 0; ri2 < roleTabs.length; ri2++) {
            var rt = roleTabs[ri2];
            try {
              var txt2 = (rt.innerText || rt.textContent || '').trim();
              if (txt2 && txt2.indexOf('图文') !== -1 && txt2.indexOf('视频') === -1) {
                candidates.push({ el: rt, score: 800, text: txt2.slice(0, 40), tag: 'role-tab', cls: '' });
              }
            } catch (e2) {}
          }
        } catch (e) {}
      }
      if (candidates.length === 0) return { clicked: false, reason: 'no-candidate' };
      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      try { top.el.click(); }
      catch (e) {
        try {
          var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          top.el.dispatchEvent(evt);
        } catch (e2) {
          return { clicked: false, reason: 'click-failed', text: top.text };
        }
      }
      var topFive = candidates.slice(0, 5).map(function (c) {
        return { text: c.text, score: c.score, tag: c.tag, cls: c.cls };
      });
      return { clicked: true, text: top.text, score: top.score, candidates: topFive };
    })();
  `;

  try {
    const val: any = await win.webContents.executeJavaScript(script).catch(() => null);
    if (val && val.clicked) {
      log('info', 'tab', `✅ 已切换到图文（匹配="${val.text}" score=${val.score}）`);
      await sleep(2000);
      return true;
    }
    log('warn', 'tab', `未找到图文按钮（${JSON.stringify(val).slice(0, 200)}），尝试 URL fallback…`);
  } catch (e) {
    log('warn', 'tab', `图文切换异常: ${(e as Error).message}`);
  }

  // URL fallback
  try {
    const imageUrl = 'https://cp.kuaishou.com/article/publish/video?tabType=2';
    log('info', 'tab', `URL fallback: ${imageUrl}`);
    await win.loadURL(imageUrl);
    await sleep(2500);
    return true;
  } catch (eNav) {
    log('warn', 'tab', `URL fallback 失败: ${(eNav as Error).message}`);
    return false;
  }
}

/**
 * [快手专用] 向 contenteditable 元素写入文本。
 * 策略：
 *   1. 查找所有 contenteditable != 'false' 的元素
 *   2. 根据关键字区分：placeholder 含"标题"/"title" 或 "话题和描述"/"描述"
 *   3. 先用 focus + 清空，再用 document.execCommand('insertText') 写入（触发 React 事件）
 *
 * @param kind  'title' | 'content'
 */
function buildFillContenteditableScript(kind: 'title' | 'content', text: string): string {
  const json = JSON.stringify(text);
  const isTitle = kind === 'title';
  const placeholderKeyword = isTitle
    ? // 标题：placeholder 含 "标题" 或 title 属性
      `(placeholder && (placeholder.indexOf('标题') !== -1 || placeholder.toLowerCase().indexOf('title') !== -1))`
    : // 正文/描述：placeholder 含 "话题和描述" 或 "描述"
      `(placeholder && (placeholder.indexOf('话题和描述') !== -1 || placeholder.indexOf('添加合适的话题') !== -1 || placeholder.indexOf('描述') !== -1 || placeholder.indexOf('说点什么') !== -1))`;

  // 标题元素可能没有 placeholder，而是纯 contenteditable。需要给两种模式一个可靠的 fallback。
  // - 视频发布页：通常有两个 contenteditable，一个是"标题"（较短的那一个），另一个是描述
  // - 图文发布页：只有一个 contenteditable（描述），skipTitle=true
  // 策略：先匹配 placeholder；若无匹配，按元素出现顺序：第一个 = title，第二个 = content
  const fallbackClause = isTitle
    ? `(index === 0 && all.length > 1)` // 仅当存在多个 contenteditable 时，第一个当作 title
    : `(index === all.length - 1 || (index === 0 && all.length === 1))`; // content 为最后一个 或 唯一的一个

  // content 类型写完后不 blur，保持焦点在末尾，便于后续 CDP 输入标签
  const afterWrite = isTitle
    ? `target.blur();`
    : `try { var rng = document.createRange(); rng.selectNodeContents(target); rng.collapse(false); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); } catch(e) {}`;

  return `
    (function () {
      var text = ${json};
      var all = [];
      try {
        var nodes = document.querySelectorAll('[contenteditable]');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var ce = n.getAttribute && n.getAttribute('contenteditable');
          if (ce === 'false' || ce === null) continue;
          all.push(n);
        }
      } catch (e) { return { ok: false, msg: 'query-failed: ' + String(e) }; }
      if (all.length === 0) return { ok: false, msg: 'no-contenteditable-found' };

      // 优先用 placeholder 关键字匹配
      var target = null;
      var matchedIdx = -1;
      for (var j = 0; j < all.length; j++) {
        try {
          var placeholder = all[j].getAttribute && all[j].getAttribute('placeholder') || '';
          var titleAttr = all[j].getAttribute && all[j].getAttribute('title') || '';
          if (${placeholderKeyword}) { target = all[j]; matchedIdx = j; break; }
        } catch (e) {}
      }
      // fallback：按位置猜测
      if (!target) {
        for (var k = 0; k < all.length; k++) {
          var index = k;
          if (${fallbackClause}) { target = all[k]; matchedIdx = k; break; }
        }
      }
      if (!target) {
        return { ok: false, kind: '${kind}', msg: 'no-match', candidates: all.length };
      }
      try {
        target.focus();
        target.innerHTML = '';
        if (text && text.length > 0) {
          try {
            // insertText 能正确触发 React/Vue 的 input 事件
            var ok = document.execCommand('insertText', false, text);
            if (!ok) {
              // 降级：直接设置 textContent，再派发 input 事件
              target.textContent = text;
              try {
                var ev = document.createEvent('Event');
                ev.initEvent('input', true, true);
                target.dispatchEvent(ev);
              } catch (evErr) {}
            }
          } catch (ec) {
            target.textContent = text;
            try {
              var ev2 = document.createEvent('Event');
              ev2.initEvent('input', true, true);
              target.dispatchEvent(ev2);
            } catch (evErr2) {}
          }
        }
        // 标题写完后blur；正文写完后保持焦点在末尾，便于CDP输入标签
        ${afterWrite}
        return { ok: true, kind: '${kind}', index: matchedIdx, length: text.length, isContentEditable: ${isTitle ? 'false' : 'true'} };
      } catch (e) {
        return { ok: false, kind: '${kind}', msg: String(e) };
      }
    })();
  `;
}

/** [快手专用] 构建"点击发布按钮"脚本。
 *  按钮：div 带类名 _button-primary_ 或 _button_3a3lq_，文本含"发布"。
 *  页面可能出现多个（例如：二次确认窗口），需要跳过 disabled 的按钮。
 */
function buildClickPublishButtonScript(): string {
  return `
    (function () {
      var candidates = [];
      try {
        var tags = ['button', 'div', 'a', 'span'];
        for (var ti = 0; ti < tags.length; ti++) {
          var els = document.getElementsByTagName(tags[ti]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            var txt = (el.innerText || el.textContent || '').trim();
            if (!txt || txt.indexOf('发布') === -1) continue;
            if (txt.indexOf('发布作品管理') !== -1) continue;
            var cls = el.getAttribute && el.getAttribute('class') || '';
            if (cls.indexOf('_button-primary_') === -1 && cls.indexOf('_button_3a3lq_') === -1) {
              // 放宽：允许包含"button-primary"或文本精确为"发布"/"立即发布"
              if (cls.indexOf('button-primary') === -1 && !(txt === '发布' || txt === '立即发布')) {
                continue;
              }
            }
            try {
              if ((el.offsetWidth || 0) < 10 || (el.offsetHeight || 0) < 10) continue;
            } catch (eSz) {}
            // disabled 检测
            try {
              if (el.disabled) continue;
              if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
              var st = window.getComputedStyle(el, null);
              if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.4)) continue;
            } catch (eSt) {}
            var score = 0;
            if (cls.indexOf('_button-primary_') !== -1 || cls.indexOf('_button_3a3lq_') !== -1) score += 2000;
            if (txt === '发布') score += 800;
            if (txt === '立即发布') score += 600;
            if (txt.indexOf('作品') !== -1) score -= 300;
            candidates.push({ el: el, score: score, text: txt.slice(0, 40), cls: (cls || '').slice(0, 80) });
          }
        }
      } catch (e) {
        return { clicked: false, msg: 'query-exception: ' + String(e) };
      }
      if (candidates.length === 0) return { clicked: false, msg: 'no-button' };
      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      try { top.el.click(); }
      catch (e) {
        try {
          var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          top.el.dispatchEvent(evt);
        } catch (e2) {
          return { clicked: false, msg: 'click-failed', text: top.text };
        }
      }
      var top3 = candidates.slice(0, 3).map(function (c) { return { text: c.text, score: c.score, cls: c.cls }; });
      return { clicked: true, text: top.text, score: top.score, candidates: top3 };
    })();
  `;
}

// ========================= 核心发布流程 =========================

async function runKuaishouPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
  contentType: ContentType,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'kuaishou' });
  const isImage = contentType === 'image' || contentType === 'article';
  const skipTitle = isImage; // 图文没有独立标题字段

  const publishUrl = isImage
    ? 'https://cp.kuaishou.com/article/publish/video?tabType=2'
    : 'https://cp.kuaishou.com/article/publish/video';

  const title = `快手${isImage ? '图文' : '视频'}发布 - ${accountId}`;
  let win: BrowserWindow | null = null;
  let tracker: ReturnType<typeof attachNavigationTracker> | null = null;

  try {
    // ---- 步骤 1：创建窗口 + 导航跟踪 ----
    log('info', 'init', `初始化发布窗口 (url=${publishUrl})`);
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);

    // ---- 步骤 2：加载发布 URL ----
    onProgress(5, '加载发布页面…');
    log('info', 'load', `加载 URL: ${publishUrl}`);
    await win.loadURL(publishUrl);

    // ---- 步骤 3：等待页面稳定 ----
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // ---- 步骤 4：检测登录状态 ----
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      log('warn', 'login', `未检测到登录状态，url=${loginInfo.url}`);
      // 让用户手动登录；给 60 秒窗口，之后再检查一次
      win.show();
      onProgress(15, '请在窗口中登录快手账号…');
      log('info', 'login', '显示窗口等待用户登录（最多 120 秒）…');
      const loginDeadline = Date.now() + 120_000;
      let loggedIn = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const recheck = await detectLoggedIn(win).catch(() => null as any);
        if (recheck && recheck.loggedIn) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        return makeFailedResult(accountId, 'kuaishou', '登录超时或未登录，请先在快手登录', startedAt);
      }
      log('info', 'login', '✅ 登录成功，继续发布流程');
      // 登录后可能发生了重定向，重新导航到发布 URL 并等待稳定
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', `✅ 已登录 (url=${loginInfo.url.slice(0, 80)})`);
    }

    // ---- 步骤 5：图文模式 tab 切换 ----
    if (isImage) {
      onProgress(18, '切换到图文发布页…');
      const currentUrl = win.webContents.getURL();
      // 若是默认视频 URL，尝试点击 tab 或重新进入图文 URL
      if (!/tabType=2/i.test(currentUrl)) {
        const switched = await switchToImageTab(win, log);
        if (!switched) {
          log('warn', 'tab', '图文 tab 切换失败，尝试直接 navigate 到图文 URL');
          await win.loadURL('https://cp.kuaishou.com/article/publish/video?tabType=2');
          await tracker.waitForStable(1500, 15000);
          await sleep(1500);
        }
      }
    }

    // ---- 步骤 6：上传素材 ----
    const mediaFiles = request.mediaFiles && request.mediaFiles.length > 0 ? request.mediaFiles : [];
    if (mediaFiles.length === 0) {
      return makeFailedResult(accountId, 'kuaishou', '未提供任何媒体文件（视频/图片）', startedAt);
    }

    onProgress(25, `开始上传 ${mediaFiles.length} 个${isImage ? '图片' : '视频'}…`);

    // 🔑 快手图文上传：优先使用 FileChooser 拦截 + 点击上传按钮的方式
    // 问题背景：快手使用 Element UI 的 el-upload 组件，
    //          直接用 DOM.setFileInputFiles 设置 files 不会触发组件内部的上传逻辑，
    //          导致文件已注入但页面无反应。
    // 解决方案：模拟用户真实操作流程 — 点击上传按钮 + FileChooser 拦截选文件，
    //          组件会认为是用户手动选择的，正常触发上传。
    // 视频发布继续使用通用 uploadViaCDP。
    let uploadOk = false;
    if (isImage && win) {
      const browserWin = win; // 保存引用，避免 TypeScript null 检查问题
      log('info', 'upload', '[快手图文] 使用 FileChooser 拦截方式上传图片…');
      try {
        await browserWin.webContents.debugger.attach('1.3');
      } catch { /* 可能已 attached */ }

      try {
        // 步骤 1：启用 FileChooser 拦截
        // 注意：Page.setInterceptFileChooserDialog 的正确参数是 { enabled: true }
        // 拦截后，当页面触发文件选择时会发出 Page.fileChooserOpened 事件
        await browserWin.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        log('info', 'upload', '[快手图文] FileChooser 拦截已启用');

        // 步骤 2：监听 fileChooserOpened 事件，收到后用 handleFileChooser 填入文件
        let fileChooserHandled = false;
        const fileChooserPromise = new Promise<boolean>((resolve) => {
          const handler = (_event: any, method: string, params: any) => {
            if (method === 'Page.fileChooserOpened') {
              log('info', 'upload', `[快手图文] 收到 fileChooserOpened 事件 (mode=${params?.mode})`);
              // 用 handleFileChooser 填入文件路径
              browserWin.webContents.debugger.sendCommand('Page.handleFileChooser', {
                action: 'accept',
                files: mediaFiles,
              }).then(() => {
                log('info', 'upload', '[快手图文] handleFileChooser 调用成功');
                fileChooserHandled = true;
                browserWin.webContents.debugger.off('message', handler);
                resolve(true);
              }).catch((err: Error) => {
                log('warn', 'upload', `[快手图文] handleFileChooser 失败: ${err.message}`);
                browserWin.webContents.debugger.off('message', handler);
                resolve(false);
              });
            }
          };
          browserWin.webContents.debugger.on('message', handler);
          // 超时保护：10 秒内没收到 fileChooserOpened 则认为失败
          setTimeout(() => {
            if (!fileChooserHandled) {
              try { browserWin.webContents.debugger.off('message', handler); } catch { /* ignore */ }
              resolve(false);
            }
          }, 10000);
        });

        // 步骤 3：点击图文 tab 内的"上传图片"按钮
        const clickScript = `
          (function(){
            try {
              // 优先找当前激活 tab 内的上传按钮
              var activeTab = document.querySelector('.ant-tabs-tabpane-active, [aria-hidden="false"]');
              var scope = activeTab || document;
              var btns = scope.querySelectorAll('button, [role="button"]');
              for (var i = 0; i < btns.length; i++) {
                var txt = (btns[i].innerText || btns[i].textContent || '').replace(/\\s+/g, '').trim();
                if (txt === '上传图片' || txt.indexOf('上传图片') !== -1 || txt.indexOf('上传图文') !== -1) {
                  btns[i].click();
                  return { clicked: true, text: txt, method: 'text-match' };
                }
              }
              // 兜底：找 class 含 upload-btn 的按钮
              var classBtns = scope.querySelectorAll('[class*="upload-btn"], [class*="_upload-btn"]');
              if (classBtns && classBtns.length > 0) {
                classBtns[0].click();
                return { clicked: true, method: 'class-match', className: classBtns[0].className.slice(0, 50) };
              }
              // 再兜底：找包含"上传"和"图片"文本的元素点击
              var allElems = scope.querySelectorAll('div, span, p, a');
              for (var j = 0; j < allElems.length; j++) {
                var t = (allElems[j].innerText || allElems[j].textContent || '').replace(/\\s+/g, '').trim();
                if ((t.indexOf('上传') !== -1 && t.indexOf('图片') !== -1) || t === '上传图片') {
                  allElems[j].click();
                  return { clicked: true, method: 'text-fallback', text: t };
                }
              }
              return { clicked: false, reason: 'no-button-found' };
            } catch(e) { return { clicked: false, error: String(e) }; }
          })()
        `;
        const clickRes: any = await browserWin.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: clickScript,
          returnByValue: true,
        }).catch(() => null);
        const cv = clickRes && clickRes.result && clickRes.result.value ? clickRes.result.value : null;
        log('info', 'upload', `[快手图文] 点击上传按钮结果: ${cv ? JSON.stringify(cv).slice(0, 200) : 'unknown'}`);

        if (cv && cv.clicked) {
          // 等待 FileChooser 被处理
          const chooserResult = await fileChooserPromise;
          // 关闭拦截
          try {
            await browserWin.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          } catch { /* ignore */ }

          if (chooserResult) {
            log('info', 'upload', '[快手图文] FileChooser 处理成功，等待上传…');
            // 给一点时间让上传开始
            await sleep(2000);
            uploadOk = true;
          } else {
            log('warn', 'upload', '[快手图文] FileChooser 处理失败或超时，回退到 CDP 注入方式');
          }
        } else {
          // 没点到按钮，关闭拦截
          try {
            await browserWin.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          } catch { /* ignore */ }
          log('warn', 'upload', '[快手图文] 未找到上传按钮，回退到 CDP 注入方式');
        }
      } catch (err) {
        log('warn', 'upload', `[快手图文] FileChooser 方式异常: ${(err as Error).message}，回退到 CDP 注入方式`);
        // 确保拦截已关闭
        try {
          await browserWin.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        } catch { /* ignore */ }
      }
    }

    // 如果 FileChooser 方式失败或不是图文模式，使用通用的 CDP 注入方式
    if (!uploadOk) {
      uploadOk = await uploadViaCDP(win, mediaFiles, log, contentType);
    }

    if (!uploadOk) {
      return makeFailedResult(accountId, 'kuaishou', '素材上传失败（CDP 注入未返回成功）', startedAt);
    }

    // ---- 步骤 7：等待上传完成 ----
    onProgress(40, '等待上传完成…');
    const uploadResult = await waitForUploadComplete(win, log, onProgress, 300_000, tracker);
    if (!uploadResult.ready) {
      log('warn', 'upload', `上传完成检测失败: ${uploadResult.finalStatus}`);
      // 软失败：继续往下走（有些平台不会在 DOM 给出明显"完成"信号）
    }
    onProgress(60, '上传完成，准备填写内容…');
    await sleep(1500);

    // ---- 步骤 8：填写标题 / 内容 / 标签 ----
    const ksTagList = prepareTags(request.tags);
    const baseContentText = buildContentBaseText(request.title, request.content, skipTitle);
    const titleText = skipTitle ? '' : truncate((request.title || '').trim(), TITLE_MAX);

    log('info', 'fill', `准备写入：title="${titleText.slice(0, 40)}" (len=${titleText.length}), contentLen=${baseContentText.length}, tags=${ksTagList.length}`);

    if (titleText) {
      const script = buildFillContenteditableScript('title', titleText);
      const res: any = await evalJS(win, script, 'fill-title', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `标题写入失败: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 标题已写入 (index=${res.index})`);
      }
      await sleep(800);
    }

    if (baseContentText || ksTagList.length > 0) {
      const script = buildFillContenteditableScript('content', baseContentText);
      const res: any = await evalJS(win, script, 'fill-content', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `内容写入失败: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 内容已写入 (index=${res.index})`);
      }
      await sleep(500);
      // 通过 CDP 真实键盘事件逐个输入话题标签
      if (ksTagList.length > 0 && res && res.ok && res.isContentEditable) {
        await cdpInsertTagsWithSpace(win, ksTagList, baseContentText.length > 0, log);
        await sleep(300);
      }
    }

    // ---- 步骤 9：点击发布按钮 ----
    onProgress(75, '点击发布按钮…');
    const clickScript = buildClickPublishButtonScript();
    const clickRes: any = await evalJS(win, clickScript, 'click-publish', log).catch(() => null);
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', `发布按钮点击失败: ${JSON.stringify(clickRes).slice(0, 200)}`);
      // 兜底：用页面结构探测，便于排错
      const probe: any = await evalJS(win, buildPageStructureProbe(), 'probe', log).catch(() => null);
      log('warn', 'publish', `页面结构探测: ${JSON.stringify(probe).slice(0, 400)}`);
      return makeFailedResult(accountId, 'kuaishou', '未找到可点击的"发布"按钮', startedAt);
    }
    log('info', 'publish', `✅ 发布按钮已点击 (text="${clickRes.text}" score=${clickRes.score})`);
    onProgress(85, '发布中，等待结果页…');

    // ---- 步骤 10：等待"发布成功"（更灵敏的检测逻辑）----
    // 策略：轮询 180 秒，检测以下成功信号：
    //   a) URL 变化：从 /publish/ 跳转到 /manage/ 或 /list/ 或 作品管理 页
    //   b) 页面文本含："发布成功"、"已发布"、"发布完成"、"发表成功"、"已提交"、"作品创建成功"、"作品已发布"、"创建成功"
    //   c) 发布按钮状态变化：按钮变成 disabled 或 文本变成"发布中"/"已发布"
    //   d) 检测确认弹窗：点击发布后可能需要二次确认
    // 失败信号：页面文本含"失败"/"违规"/"不符合"/"无法发布"
    const initialUrl = win.webContents.getURL();
    const successDeadline = Date.now() + 180_000;
    let lastUrl = initialUrl;
    let lastText = '';
    let lastButtonState: any = null;
    let confirmationClicked = false;
    log('info', 'done', `开始轮询发布结果（初始 URL=${initialUrl.slice(0, 80)}，最长 180 秒）`);

    while (Date.now() < successDeadline) {
      if (win.isDestroyed()) break;
      try {
        const check: any = await win.webContents
          .executeJavaScript(`
            (function () {
              var result = {
                url: location.href,
                title: document.title,
                body: (document.body ? (document.body.innerText || '') : '').slice(0, 600),
                urlChanged: false,
                buttonDisabled: false,
                buttonText: '',
                hasConfirmation: false,
              };
              result.urlChanged = (location.href !== '${initialUrl.replace(/'/g, "\\'").replace(/\n/g, '')}');
              // 检测发布按钮状态
              try {
                var allTags = ['button', 'div', 'a'];
                for (var ti = 0; ti < allTags.length; ti++) {
                  var els = document.getElementsByTagName(allTags[ti]);
                  for (var ei = 0; ei < els.length; ei++) {
                    var el = els[ei];
                    var txt = (el.innerText || el.textContent || '').trim();
                    if (!txt || txt.indexOf('发布') === -1) continue;
                    var cls = (el.getAttribute && el.getAttribute('class')) || '';
                    if (cls.indexOf('_button-primary_') === -1 && cls.indexOf('_button_3a3lq_') === -1) continue;
                    result.buttonText = txt.slice(0, 40);
                    result.buttonDisabled = !!(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
                    try {
                      var st = window.getComputedStyle(el, null);
                      if (st && (parseFloat(st.opacity || '1') < 0.5 || st.visibility === 'hidden')) result.buttonDisabled = true;
                    } catch (eSt) {}
                    break;
                  }
                  if (result.buttonText) break;
                }
              } catch (eBtn) {}
              // 检测确认弹窗
              try {
                var confirmTexts = ['确认发布', '确认', '确定发布', '立即发布', '发布作品'];
                for (var ci = 0; ci < confirmTexts.length; ci++) {
                  var confirmElements = document.querySelectorAll('button, div, a, span');
                  for (var cj = 0; cj < confirmElements.length; cj++) {
                    var cel = confirmElements[cj];
                    var ctxt = (cel.innerText || cel.textContent || '').trim();
                    if (ctxt === confirmTexts[ci] || ctxt.indexOf(confirmTexts[ci]) !== -1) {
                      var ccls = (cel.getAttribute && cel.getAttribute('class')) || '';
                      try {
                        var cst = window.getComputedStyle(cel, null);
                        if (!cst || cst.display === 'none' || cst.visibility === 'hidden') continue;
                        if ((cel.offsetWidth || 0) < 10 || (cel.offsetHeight || 0) < 10) continue;
                      } catch (eSz) {}
                      if (ccls.indexOf('_button-primary_') !== -1 || ccls.indexOf('_button_3a3lq_') !== -1) {
                        result.hasConfirmation = true;
                        cel.click();
                        break;
                      }
                    }
                  }
                  if (result.hasConfirmation) break;
                }
              } catch (eConfirm) {}
              return result;
            })();
          `)
          .catch(() => null);

        if (check) {
          lastUrl = check.url || '';
          lastText = (check.body || '') + ' | ' + (check.title || '');
          lastButtonState = { buttonText: check.buttonText, buttonDisabled: check.buttonDisabled };

          // 信号 a：URL 变化（跳转到作品管理/列表）
          const urlOk = /\/article\/manage|\/manage\b|works\/list|\/content|\/overview|作品管理|内容管理|我的作品/i.test(lastUrl);
          const urlChanged = check.urlChanged && !/publish/.test(lastUrl);

          // 信号 b：页面文本成功信号
          const textOk = /发布成功|已发布|发布完成|发表成功|已提交|作品创建成功|作品已发布|创建成功|作品发表成功|发布已完成/i.test(lastText);

          // 信号 c：按钮状态变化（disabled 或 文本变成发布中/已发布）
          const buttonOk = check.buttonDisabled || /发布中|正在发布|已发布|发布成功/i.test(check.buttonText || '');

          // 信号 d：确认弹窗
          if (check.hasConfirmation && !confirmationClicked) {
            confirmationClicked = true;
            log('info', 'done', `检测到确认弹窗，已自动点击确认`);
          }

          // 失败信号
          const textFail = /发布失败|不符合要求|违规|发布失败|无法发布|出错|参数不合法|失败/i.test(lastText);

          if (urlOk || textOk || buttonOk || urlChanged) {
            const reason = [urlOk && 'url-ok', textOk && 'text-success', buttonOk && 'button-disabled', urlChanged && 'url-changed'].filter(Boolean).join(',');
            log('info', 'done', `✅ 发布成功 (reason=${reason}, url=${lastUrl.slice(0, 120)})`);
            onProgress(100, '发布成功');
            return {
              accountId,
              platform: 'kuaishou',
              status: 'success',
              progress: 100,
              message: `发布成功`,
              url: lastUrl,
              startedAt,
              finishedAt: Date.now(),
            } as PublishItemProgress;
          }
          if (textFail) {
            log('warn', 'done', `页面提示发布失败: ${lastText.slice(0, 200)}`);
            return makeFailedResult(accountId, 'kuaishou', `页面提示失败`, startedAt);
          }
        }
      } catch { /* ignore transient errors */ }
      await sleep(3000);
    }

    log('warn', 'done', `等待发布成功超时（180 秒），最后 url=${lastUrl.slice(0, 120)}, button=${JSON.stringify(lastButtonState)}`);
    return makeFailedResult(accountId, 'kuaishou', `等待发布结果超时`, startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', `发布流程异常: ${msg}`);
    return makeFailedResult(accountId, 'kuaishou', msg, startedAt);
  } finally {
    if (tracker) {
      try { tracker.dispose(); } catch { /* ignore */ }
    }
    if (win && !win.isDestroyed()) {
      // 短暂停留让用户看到结果页，之后关闭
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      }, 2000);
    }
  }
}

// ========================= 对外接口 =========================

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runKuaishouPublish(accountId, request, onProgress, 'video');
}

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runKuaishouPublish(accountId, request, onProgress, 'image');
}

/** 兼容接口：根据提供的文件类型自动选择视频或图文发布 */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const files = request.mediaFiles || [];
  const hasImageOnly =
    files.length > 0 &&
    files.every((f) => /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f));
  if (request.contentType === 'image' || hasImageOnly) {
    return publishImage(accountId, request, onProgress);
  }
  return publishVideo(accountId, request, onProgress);
}

const adapter: PlatformAdapter = {
  key: 'kuaishou',
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publishImage,
  publish,
};

registerPlatform(adapter);

export default adapter;
export { meta as kuaishouMeta };
