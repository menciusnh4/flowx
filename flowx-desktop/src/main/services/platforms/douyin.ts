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
 * 抖音平台适配器
 *
 * 架构（同小红书）：
 *   - 发布方法按内容类型拆分：publishVideo / publishImage / publishArticle
 *   - 每个方法委托给 runStandardPublish + 自身专属配置（URL/关键词/确认步骤）
 *   - 抖音特有: enableConfirmStep = true（点击"发布作品"后需等待异步完成）
 */

const meta: PlatformMeta = {
  key: 'douyin',
  name: '抖音',
  icon: '🎵',
  platformAccountLabel: '抖音号',
  authUrl: 'https://creator.douyin.com/creator-micro/home',
  publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  homeUrl: 'https://creator.douyin.com/creator-micro/home',
  contentTypes: ['video', 'image', 'article'],
  capabilities: {
    publishVideo: true,
    publishImage: true,
    publishArticle: true,
  } as AccountCapabilities,
  nicknameSelectors: [
    '[class*="header-"] [class*="name-_"]',
    '[class*="name-_"]',
    '[class*="name-"]',
    '.name-box',
    '.user-name',
    '.nickname',
  ],
  avatarSelectors: [
    '[class*="avatar-"] img',
    'img[class*="img-"]',
    'img[class*="avatar"]',
    'img.user_avatar',
    '.user-info img',
  ],
  loginKeywords: ['创作中心', '内容管理', '发布', '作品', '数据', '粉丝'],
};

/**
 * 登录检测：非登录页 + (有账号昵称元素 OR ≥3 关键字命中)
 */
async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const info: any = await win.webContents.executeJavaScript(`
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
        return { loggedIn: loggedIn, matched: matched, title: document.title, url: curUrl, isLoginPage, hasAccountEl, rawNick };
      })();
    `);
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
 * 提取账号信息：昵称/头像/抖音号/粉丝/关注/获赞
 * 抖音统计元素通常是 <div class="statics-item-xxx">粉丝 <span class="number-xxx">123</span></div>
 */
async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  const result: any = await win.webContents.executeJavaScript(`
    (function () {
      var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };

      function parseCount(text) {
        var clean = (text || '').trim().replace(/[,\\s]/g, '');
        var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万千wWkK])?$/);
        if (!pm) return null;
        var n = parseFloat(pm[1]);
        if (pm[2]) {
          if (/[万千wW]/.test(pm[2])) n *= 10000;
          else if (/[千kK]/.test(pm[2])) n *= 1000;
        }
        return Math.round(n);
      }

      // 昵称
      var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
      for (var si = 0; si < nickSels.length; si++) {
        var el = document.querySelector(nickSels[si]);
        if (el && el.textContent && el.textContent.trim()) { r.nickname = el.textContent.trim(); break; }
      }
      // 头像
      var avSels = ${JSON.stringify(meta.avatarSelectors)};
      for (var ai = 0; ai < avSels.length; ai++) {
        var el2 = document.querySelector(avSels[ai]);
        if (el2 && el2.getAttribute) {
          var src = el2.getAttribute('src') || '';
          if (src && /^https?:\\/\\//.test(src)) { r.avatar = src; break; }
        }
      }
      // 抖音号
      try {
        var all = document.querySelectorAll('div, span, p');
        for (var i = 0; i < all.length; i++) {
          var txt = (all[i].textContent || '').trim();
          var m = txt.match(/抖音号[\\s:：]*([0-9A-Za-z_\\-]+)/);
          if (m) { r.platformAccountId = m[1]; break; }
        }
      } catch (e) {}

      // 粉丝/关注/获赞：策略 A（statics-item 元素）+ 策略 B（label+数字同元素 / 相邻元素）
      try {
        // 策略 A：statics-item 类元素
        var statItems = document.querySelectorAll('[class*="statics-item"], [class*="statics-"] > *');
        for (var a = 0; a < statItems.length; a++) {
          var t = (statItems[a].textContent || '').trim();
          if (!t || t.length > 30) continue;
          var tm = t.match(/^(粉丝|关注|获赞)[\\s\\S]*?([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
          if (tm) {
            var n = parseCount(tm[2]);
            if (n !== null) {
              if (tm[1] === '粉丝' && r.fansCount === null) r.fansCount = n;
              else if (tm[1] === '关注' && r.followCount === null) r.followCount = n;
              else if (tm[1] === '获赞' && r.likeCount === null) r.likeCount = n;
            }
          }
        }
        // 策略 B：兜底 - label+数字 同元素 或 相邻
        if (r.fansCount === null || r.followCount === null || r.likeCount === null) {
          var allNodes = document.querySelectorAll('div, span, p');
          var currentLabel = null;
          for (var j = 0; j < allNodes.length; j++) {
            var t2 = (allNodes[j].textContent || '').trim();
            if (!t2 || t2.length > 30) continue;
            // B.1 标签+数字 同元素
            var tm2 = t2.match(/^(粉丝|关注|获赞)[\\s:：]*([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
            if (tm2) {
              var n2 = parseCount(tm2[2]);
              if (n2 !== null) {
                if (/^粉丝/.test(tm2[1]) && r.fansCount === null) r.fansCount = n2;
                else if (/^关注/.test(tm2[1]) && r.followCount === null) r.followCount = n2;
                else if (/^获赞/.test(tm2[1]) && r.likeCount === null) r.likeCount = n2;
              }
              currentLabel = null;
              continue;
            }
            // B.2 标签/数字相邻
            if (/^(粉丝数?|关注数?|获赞数?)$/.test(t2)) { currentLabel = t2; continue; }
            if (currentLabel && /^[\\d,]+[.]?\\d*[万wWkK千]?$/.test(t2)) {
              var n3 = parseCount(t2);
              if (n3 !== null) {
                if (/^粉丝/.test(currentLabel) && r.fansCount === null) r.fansCount = n3;
                else if (/^关注/.test(currentLabel) && r.followCount === null) r.followCount = n3;
                else if (/^获赞/.test(currentLabel) && r.likeCount === null) r.likeCount = n3;
              }
              currentLabel = null;
            } else if (!/^(粉丝|关注|获赞|点赞)/.test(t2)) {
              currentLabel = null;
            }
          }
        }
      } catch (e) {}
      return r;
    })();
  `).catch(() => ({}));
  return {
    nickname: result.nickname || '',
    avatar: result.avatar || undefined,
    platformAccountId: result.platformAccountId || undefined,
    fansCount: typeof result.fansCount === 'number' ? result.fansCount : undefined,
    followCount: typeof result.followCount === 'number' ? result.followCount : undefined,
    likeCount: typeof result.likeCount === 'number' ? result.likeCount : undefined,
  };
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
    platform: 'douyin',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['立即发布', '发布作品', '确认发布', '发布'],
    enableConfirmStep: true,
    enablePostClickVerify: true,
    fillWaitMs: 1500,
  });
}

/**
 * 发布图文 — contentType === 'image'
 * 抖音图文与视频共用上传页面（根据文件扩展名自动切换模式）
 */
async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'douyin',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布', '发布作品', '立即发布', '确认发布'],
    enableConfirmStep: true,
    enablePostClickVerify: true,
    fillWaitMs: 1500,
  });
}

/**
 * 发布文章（长文）— contentType === 'article'
 * 抖音支持发布图文长文，上传页面根据内容类型自动切换到文章编辑模式
 */
async function publishArticle(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'douyin',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布', '发布作品', '立即发布', '确认发布'],
    enableConfirmStep: true,
    enablePostClickVerify: true,
    fillWaitMs: 1500,
  });
}

/**
 * 兼容接口：自动根据请求内容类型分发
 * @deprecated 请使用 publishVideo / publishImage / publishArticle
 */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  if (request.contentType === 'article') {
    return publishArticle(accountId, request, onProgress);
  }
  const hasImageOnly = (request.mediaFiles || []).every((f) =>
    /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f),
  );
  if (hasImageOnly || request.contentType === 'image') {
    return publishImage(accountId, request, onProgress);
  }
  return publishVideo(accountId, request, onProgress);
}

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
