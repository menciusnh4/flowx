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
  });
}

/**
 * 发布图文 — contentType === 'image'
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
