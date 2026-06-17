import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import { runStandardPublish } from './shared';
import { registerPlatform } from './registry';
import type {
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
  ContentType,
} from '../../../types';

/**
 * 快手平台适配器
 *
 * 架构：
 *   - detectLoggedIn：检查 URL + body 关键词
 *   - extractPageInfo：直接 DOM 查询 + 统计
 *   - publishVideo/publishImage：委托给 runStandardPublish
 *
 * 页面结构（已知：
 *   - 账号信息区：div.header-info-card
 *     - img.user-image (头像
 *     - .user-name (昵称
 *     - .user-kwai-id (快手号
 *     - .user-cnt > .user-cnt__item (粉丝/关注/获赞)
 *   - 统计项文本格式：" 2<span>粉丝</span>" → textContent.trim() = "2粉丝"
 */

const meta: PlatformMeta = {
  key: 'kuaishou',
  name: '快手',
  icon: '🎬',
  platformAccountLabel: '快手号',
  authUrl: 'https://passport.kuaishou.com/pc/account/login/',
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

/**
 * 登录检测：
 */
async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const info: any = await win.webContents.executeJavaScript(
      `\n      (function () {\n        var bodyText = document.body ? (document.body.innerText || '') : '';\n        var curUrl = location.href;\n        var keywords = ${JSON.stringify(meta.loginKeywords)};\n        var matched = [];\n        var isLoginPage = /login|passport|redirectReason|signin|401|signup|sso|captcha/i.test(curUrl);\n        var nickSels = ${JSON.stringify(meta.nicknameSelectors)};\n        var hasAccountEl = false;\n        var rawNick = '';\n        for (var i = 0; i < nickSels.length; i++) {\n          var el = document.querySelector(nickSels[i]);\n          if (el && el.textContent && el.textContent.trim() && el.textContent.trim().length > 0) {\n            hasAccountEl = true;\n            rawNick = el.textContent.trim();\n            break;\n          }\n        }\n        for (var j = 0; j < keywords.length; j++) {\n          if (bodyText.indexOf(keywords[j]) !== -1) matched.push(keywords[j]);\n        }\n        var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3);\n        return { loggedIn: loggedIn, matched: matched, title: document.title, url: curUrl, isLoginPage: isLoginPage, hasAccountEl: hasAccountEl, rawNick: rawNick };\n      })();\n    `,
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

/**
 * 从页面中提取账号信息
 *
 * 策略（完全同步的脚本，不使用 Promise 等异步结构
 * 关键点：不使用 setTimeout 或 async 的元素：
 *   - 第一步：在 document.body 里查询
 *   - 扫 .el-popover / .user-info-popper / .header-info-card
 *   - 每个 user-cnt__item 文本解析
 *   - 从 cookie 中解析 user_id
 *   - 最后把结果带回
 */
async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  const result: any = await win.webContents.executeJavaScript(
    `(function () {\n      var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };\n      var debug = { samples: [], hit: 0, errors: [], cookieUserId: null };\n\n      function parseCount(text) {\n        try {\n          var clean = (text || '').trim().replace(/[,\\s]/g, '');\n          var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千])?$/);\n          if (!pm) return null;\n          var n = parseFloat(pm[1]);\n          if (pm[2]) {\n            if (/[万wW]/.test(pm[2])) n *= 10000;\n            else if (/[千kK]/.test(pm[2])) n *= 1000;\n          }\n          return Math.round(n);\n        } catch (e) { return null; }\n      }\n\n      // 处理单个元素：从文本中解析统计信息\n      function tryExtractItem(el) {\n        if (!el || !el.textContent) return;\n        var txt = el.textContent.trim();\n        if (!txt || txt.length > 40) return;\n        if (debug.samples.length < 10) debug.samples.push(txt.replace(/\\s+/g, ' '));\n        var lab = txt.match(/(粉丝|关注|获赞|点赞)/);\n        var num = txt.match(/(\\d+(?:\\.\\d+)?[万wWkK千]?)/);\n        if (!lab || !num) return;\n        var nv = parseCount(num[1]);\n        if (nv === null || nv < 0) return;\n        if (lab[1] === '粉丝' && r.fansCount === null) r.fansCount = nv;\n        else if (lab[1] === '关注' && r.followCount === null) r.followCount = nv;\n        else if ((lab[1] === '获赞' || lab[1] === '点赞') && r.likeCount === null) r.likeCount = nv;\n      }\n\n      // 第一步：在整个 document 中查询\n      try {\n        // 最直接的方式：直接查 user-cnt__item\n        var directItems = document.querySelectorAll('[class*=\"user-cnt__item\"], [class*=\"user_cnt__item\"]');\n        for (var di = 0; di < directItems.length; di++) {\n          tryExtractItem(directItems[di]);\n        }\n        // 兜底：再查 header-info-card / user-cnt / el-popover\n        var containers = document.querySelectorAll('.header-info-card, [class*=\"user-cnt\"], [class*=\"el-popover\"], .user-info-popper, [class*=\"user-info-popper\"]');\n        for (var ci = 0; ci < containers.length; ci++) {\n          var containerItems = containers[ci].querySelectorAll('div, span, p');\n          for (var ci2 = 0; ci2 < containerItems.length; ci2++) {\n            tryExtractItem(containerItems[ci2]);\n          }\n        }\n        // 最后兜底：全页所有 div/span\n        if (r.fansCount === null || r.followCount === null || r.likeCount === null) {\n          var fallback = document.querySelectorAll('div, span');\n          for (var fi = 0; fi < fallback.length; fi++) {\n            tryExtractItem(fallback[fi]);\n            if (r.fansCount !== null && r.followCount !== null && r.likeCount !== null) break;\n          }\n        }\n      } catch (e) { debug.errors.push('extract:' + (e && e.message)); }\n\n      debug.hit = (r.fansCount !== null ? 1 : 0) + (r.followCount !== null ? 1 : 0) + (r.likeCount !== null ? 1 : 0);\n\n      // 第二步：昵称 / 头像 / 快手号\n      try {\n        var nickEl = document.querySelector('.user-name, [class*=\"user-name\"], [class*=\"nickname\"]');\n        if (nickEl && nickEl.textContent) r.nickname = nickEl.textContent.trim();\n      } catch (e) { debug.errors.push('nick:' + e.message); }\n\n      try {\n        var avEl = document.querySelector('img.user-image, [class*=\"user-image\"] img, [class*=\"avatar\"] img, img[class*=\"img-\"]');\n        if (avEl && avEl.getAttribute) {\n          var src = avEl.getAttribute('src') || '';\n          if (/^https?:\\/\\//.test(src)) r.avatar = src;\n        }\n      } catch (e) { debug.errors.push('avatar:' + e.message); }\n\n      // 快手号：尝试 cookie 解析\n      try {\n        var pairs = (document.cookie || '').split(';');\n        for (var ci = 0; ci < pairs.length; ci++) {\n          var kv = (pairs[ci] || '').trim();\n          var eq = kv.indexOf('=');\n          if (eq < 1) continue;\n          var cname = decodeURIComponent(kv.substring(0, eq)).trim().toLowerCase();\n          var cval = kv.substring(eq + 1);\n          try { cval = decodeURIComponent(cval); } catch (_) { }\n          if ((cname === 'user_id' || cname === 'kuaishou_id' || cname === 'kwai_id' || cname === 'uid' || cname === 'uid_key')\n              && cval && /^[A-Za-z0-9_\\-]+$/.test(cval.trim())) {\n            r.platformAccountId = cval.trim();\n            debug.cookieUserId = cname;\n            break;\n          }\n        }\n      } catch (e) { debug.errors.push('cookie:' + e.message); }\n\n      r._debug = debug;\n      return r;\n    })();`,
  ).catch((e: Error) => {
    console.warn('[kuaishou] extractPageInfo failed', e.message);
    return {} as any;
  });

  return {
    nickname: result.nickname || '',
    avatar: result.avatar || undefined,
    platformAccountId: result.platformAccountId || undefined,
    fansCount: typeof result.fansCount === 'number' ? result.fansCount : undefined,
    followCount: typeof result.followCount === 'number' ? result.followCount : undefined,
    likeCount: typeof result.likeCount === 'number' ? result.likeCount : undefined,
    _debug: result._debug,
  } as ExtractedAccountInfo & { _debug?: Record<string, unknown> };
}

/**
 * 发布视频 — contentType === 'video'
 */
async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'kuaishou',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布作品', '立即发布', '发布', '确认发布'],
    enableConfirmStep: false,
    enablePostClickVerify: true,
    fillWaitMs: 1500,
    contentLimits: { title: 80, content: 500 },
    contentType: 'video',
  });
}

/**
 * [快手专用] 图文 tab 切换 — 点击页面上的"上传图文"按钮。
 *
 * 快手视频发布页上有三个并列按钮："上传视频 | 上传图文 | 上传全景视频"。
 * 通用 switchContentTypeTab 脚本匹配不到，因为：
 *   - 按钮可能在 shadow DOM 或特定容器内
 *   - 文本"上传图文"可能被拆分成多个节点或包含特殊字符
 *
 * 策略（多层 fallback）：
 *   1. 精确匹配文本为"上传图文"的 <button> / <a> / div
 *   2. 包含"图文"关键词的可点击元素（排除"视频"）
 *   3. 通过 CSS 类名匹配（tab / switch / upload 等前缀）
 *   4. fallback：尝试直接导航到图文 URL
 */
async function kuaishouTabSwitcher(
  win: BrowserWindow,
  contentType: ContentType,
  log: (level: 'info' | 'warn' | 'error', stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 视频类型：不需要切换
  if (!contentType || contentType === 'video') return true;

  log('info', 'tab', `[kuaishou] 执行平台专用图文 tab 切换…`);

  const script = `
    (function () {
      // 递归收集 root（主文档 + shadow DOM + iframe）
      var roots = [document];
      function collectShadow(root) {
        try {
          if (!root || !root.querySelectorAll) return;
          var all = root.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            try {
              if (all[i].shadowRoot) {
                roots.push(all[i].shadowRoot);
                collectShadow(all[i].shadowRoot);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      function collectIframes(root) {
        try {
          var ifs = root.querySelectorAll('iframe');
          for (var i = 0; i < ifs.length; i++) {
            try {
              var idoc = ifs[i].contentDocument || (ifs[i].contentWindow && ifs[i].contentWindow.document);
              if (idoc) {
                roots.push(idoc);
                collectShadow(idoc);
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      collectShadow(document);
      collectIframes(document);

      var candidates = [];
      for (var ri = 0; ri < roots.length; ri++) {
        var root = roots[ri];
        if (!root || !root.querySelectorAll) continue;

        // 1. 搜索 button / a / div / span 中的文本精确匹配
        var tags = ['button', 'a', 'div', 'span', 'li', 'p'];
        for (var ti = 0; ti < tags.length; ti++) {
          var els = root.querySelectorAll(tags[ti]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            try {
              var txt = (el.innerText || el.textContent || '').trim();
              if (!txt || txt.length > 40) continue;

              // 计分
              var score = 0;
              var isExact = txt === '上传图文';
              var hasTuwen = txt.indexOf('图文') !== -1;
              var hasImage = txt.indexOf('图片') !== -1 || txt.indexOf('相册') !== -1;
              var hasVideo = txt.indexOf('视频') !== -1;

              if (isExact) score += 2000;
              else if (hasTuwen && !hasVideo) score += 1000;
              else if (hasImage && !hasVideo) score += 500;
              if (score === 0) continue;

              // tag 加分
              if (tags[ti] === 'button') score += 300;
              else if (tags[ti] === 'a') score += 200;

              // 可点击性检测
              var cls = el.getAttribute && el.getAttribute('class') || '';
              if (el.onclick || /cursor-pointer|pointer|clickable|tab|upload/i.test(cls)) score += 100;

              // 尺寸过滤
              try {
                if ((el.offsetWidth || 0) < 20 || (el.offsetHeight || 0) < 15) continue;
                if ((el.offsetWidth || 0) > 1200 || (el.offsetHeight || 0) > 300) continue;
              } catch (eSz) {}

              candidates.push({ el: el, score: score, text: txt.slice(0, 40), tag: tags[ti], cls: (cls || '').slice(0, 60) });
            } catch (e) {}
          }
        }

        // 2. 搜索 [role="tab"] 或含 tab 类的元素
        try {
          var roleTabs = root.querySelectorAll('[role="tab"], [class*="tab-"], [class*="Tab"]');
          for (var ri2 = 0; ri2 < roleTabs.length; ri2++) {
            var rt = roleTabs[ri2];
            try {
              var txt2 = (rt.innerText || rt.textContent || '').trim();
              if (!txt2 || txt2.length > 40) continue;
              var hasT = txt2.indexOf('图文') !== -1;
              var hasV = txt2.indexOf('视频') !== -1;
              if (hasT && !hasV) {
                candidates.push({ el: rt, score: 800, text: txt2.slice(0, 40), tag: 'role-tab', cls: (rt.getAttribute && rt.getAttribute('class') || '').slice(0, 60) });
              }
            } catch (e2) {}
          }
        } catch (e) {}

        // 3. 搜索 <a> 链接，匹配 URL 中含 article / image
        try {
          var links = root.querySelectorAll('a');
          for (var li = 0; li < links.length; li++) {
            var lnk = links[li];
            try {
              var href = lnk.getAttribute && lnk.getAttribute('href') || '';
              var ltxt = (lnk.innerText || lnk.textContent || '').trim();
              if (/publish.*article|publish.*image|article.*publish/i.test(href) || (ltxt && ltxt.indexOf('图文') !== -1 && ltxt.indexOf('视频') === -1)) {
                candidates.push({ el: lnk, score: 600, text: ltxt.slice(0, 40) || href.slice(0, 40), tag: 'link', cls: href.slice(0, 60) });
              }
            } catch (e3) {}
          }
        } catch (e) {}
      }

      if (candidates.length === 0) {
        return { clicked: false, reason: 'no-candidate', roots: roots.length };
      }

      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      try {
        top.el.click();
      } catch (e) {
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
      // 导航到图文页面后需要等待加载完成
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }
    log('warn', 'tab', `[kuaishou] 专用脚本未找到图文按钮（${JSON.stringify(val).slice(0, 200)}），尝试 URL fallback…`);

    // fallback：直接把 URL 从 /video 改成 /article（如果当前 URL 是视频页面）
    try {
      const currentUrl = win.webContents.getURL();
      if (/\/article\/publish\/video/i.test(currentUrl)) {
        const imageUrl = currentUrl.replace(/\/article\/publish\/video.*/i, '/article/publish/article');
        log('info', 'tab', `[kuaishou] URL fallback: ${imageUrl}`);
        await win.loadURL(imageUrl);
        await new Promise((r) => setTimeout(r, 2500));
        return true;
      }
    } catch (eNav) {
      log('warn', 'tab', `[kuaishou] URL fallback 失败: ${(eNav as Error).message}`);
    }
    return false;
  } catch (e) {
    log('warn', 'tab', `[kuaishou] 图文切换异常: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 发布图文 — contentType === 'image'
 *
 * 快手视频和图文发布页在不同 URL（或通过按钮切换）。
 * 这里通过专用 tabSwitcher 确保进入图文发布模式。
 */
async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'kuaishou',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布作品', '发布', '立即发布', '确认发布'],
    enableConfirmStep: false,
    enablePostClickVerify: true,
    fillWaitMs: 1500,
    contentLimits: { title: 80, content: 500 },
    contentType: 'image',
    // 🔑 快手专用：图文发布必须切换到图文页面（tab 切换 + URL fallback 双重保险）
    tabSwitcher: kuaishouTabSwitcher,
  });
}

/**
 * 兼容接口（不区分内容类型，默认视频
 * @deprecated 请使用 publishVideo 或 publishImage
 */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const hasImageOnly = (request.mediaFiles || []).every((f) =>
    /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f),
  );
  if (hasImageOnly || request.contentType === 'image') {
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
