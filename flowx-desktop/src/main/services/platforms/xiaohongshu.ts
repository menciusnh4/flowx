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
 * 小红书平台适配器
 *
 * 架构：
 *   - 对外暴露: detectLoggedIn / extractPageInfo / publishVideo / publishImage / publish
 *   - 发布流程委托给 shared.ts 中的 runStandardPublish 模板方法
 *   - 各内容类型（视频/图文）使用独立方法，便于差异化配置
 *   - 单一职责原则：仅处理小红书页面的 DOM 结构和发布流程
 */

const meta: PlatformMeta = {
  key: 'xiaohongshu',
  name: '小红书',
  icon: '📕',
  platformAccountLabel: '小红书号',
  authUrl: 'https://creator.xiaohongshu.com/creator/home',
  publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
  homeUrl: 'https://creator.xiaohongshu.com/creator/home',
  contentTypes: ['video', 'image'],
  capabilities: {
    publishVideo: true,
    publishImage: true,
    publishArticle: false,
  } as AccountCapabilities,
  nicknameSelectors: [
    '.account-name',
    '.user-name',
    '.nickname',
    '[class*="account-name"]',
    '[class*="user-name"]',
    '[class*="nick-name"]',
  ],
  avatarSelectors: [
    'img.user_avatar',
    '[class*="avatar"] img',
    '[class*="user-image"]',
    'img[class*="img-"]',
    'img[class*="avatar"]',
    '.user-image',
    '.user-info img',
    '.header-info-card img',
  ],
  loginKeywords: [
    '创作中心',
    '数据中心',
    '作品管理',
    '发布笔记',
    '发布视频',
    '我的',
    '粉丝',
    '数据分析',
    '数据看板',
  ],
};

/**
 * 检测当前窗口中的小红书页面是否处于已登录状态
 * 策略：URL 非登录页 + (有账号元素 OR ≥3 关键字命中 OR 发布页信号)
 */
async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const url = win.webContents.getURL();
    const info: any = await win.webContents.executeJavaScript(`
      (function () {
        var bodyText = document.body ? (document.body.innerText || '') : '';
        var curUrl = location.href;
        var keywords = ${JSON.stringify(meta.loginKeywords)};
        var matched = [];
        var isLoginPage = /login|passport|redirectReason|signin|401|signup/i.test(curUrl);
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
        var isPublishPage = /publish|creator\.xiaohongshu\.com/i.test(curUrl);
        var hasFileInput = document.querySelector && document.querySelector('input[type="file"]') !== null;
        var hasPublishUI = false;
        try {
          var btnText = document.body.innerText || '';
          hasPublishUI = btnText.indexOf('发布') !== -1 || btnText.indexOf('上传') !== -1;
        } catch (e) {}
        var publishPageSignal = isPublishPage && (hasFileInput || hasPublishUI || matched.length >= 1);
        var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3 || publishPageSignal);
        return {
          loggedIn: loggedIn,
          matched: matched,
          title: document.title,
          url: curUrl,
          isLoginPage: isLoginPage,
          hasAccountEl: hasAccountEl,
          rawNick: rawNick,
          isPublishPage: isPublishPage,
          hasFileInput: hasFileInput,
          publishPageSignal: publishPageSignal,
          body: bodyText.slice(0, 150),
        };
      })();
    `);
    return {
      loggedIn: info.loggedIn,
      url: info.url || url,
      title: info.title || '',
      matchedKeywords: info.matched,
    };
  } catch (e) {
    return { loggedIn: false, url: '', title: '' };
  }
}

/**
 * 从页面 DOM 提取账号信息（昵称/头像/平台账号ID/粉丝/关注/获赞）
 * 数字解析支持 "1.2万" / "12,345" / "12345" 等多种格式
 */
async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  const result: any = await win.webContents.executeJavaScript(`
    (function () {
      var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };

      function parseNumber(raw) {
        if (!raw || typeof raw !== 'string') return null;
        var s = raw.trim();
        if (!s) return null;
        s = s.replace(/[,\\s]/g, '');
        var m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*([万亿万千wWkK]?)/);
        if (!m) {
          var m2 = s.match(/^\\d+(?:\\.\\d+)?$/);
          if (!m2) return null;
          var v2 = parseFloat(m2[0]);
          return isNaN(v2) ? null : Math.round(v2);
        }
        var num = parseFloat(m[1]);
        if (isNaN(num)) return null;
        var unit = m[2] || '';
        if (/[万wW]/.test(unit)) num = Math.round(num * 10000);
        else if (/[千kK]/.test(unit)) num = Math.round(num * 1000);
        else if (/亿/.test(unit)) num = Math.round(num * 100000000);
        else num = Math.round(num);
        return num;
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
      // 小红书号
      try {
        var allDivs = document.querySelectorAll('div, span, p');
        for (var i = 0; i < allDivs.length; i++) {
          var txt = (allDivs[i].textContent || '').trim();
          var m = txt.match(/小红书账号[\\s:：]*([0-9A-Za-z_\\-]+)/);
          if (m) { r.platformAccountId = m[1]; break; }
        }
      } catch (e) {}

      // 粉丝/关注/获赞：策略 A（单元素 "数字 标签"）→ 策略 B（标签+数字分离）→ 策略 C（全文扫描兜底）
      try {
        var candidateNodes = document.querySelectorAll('div, span, p, a, li');
        var textBlobs = [];
        for (var j = 0; j < candidateNodes.length; j++) {
          var tRaw = (candidateNodes[j].textContent || '').trim();
          if (!tRaw) continue;
          if (tRaw.length > 40) continue;
          textBlobs.push({ text: tRaw, index: j });
        }

        function trySetCount(kw, numStr) {
          if (!numStr) return false;
          var n = parseNumber(numStr);
          if (n === null) return false;
          if (/粉丝/.test(kw)) {
            if (r.fansCount === null) r.fansCount = n;
            return true;
          } else if (/关注/.test(kw)) {
            if (r.followCount === null) r.followCount = n;
            return true;
          } else if (/获赞|收藏|点赞/.test(kw)) {
            if (r.likeCount === null) r.likeCount = n;
            return true;
          }
          return false;
        }

        // 方法 A：严格 "数字+标签" 或 "标签+数字"
        for (var a = 0; a < textBlobs.length; a++) {
          var blob = textBlobs[a].text;
          var mDigitFirst = blob.match(/^(\\d+(?:\\.\\d+)?\\s*[万wWkK千]?)\\s*(粉丝数?|关注数?|获赞(?:与收藏)?)$/);
          if (mDigitFirst) { trySetCount(mDigitFirst[2], mDigitFirst[1]); continue; }
          var mLabelFirst = blob.match(/^(粉丝数?|关注数?|获赞(?:与收藏)?|点赞数?|收藏数?)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?\\s*[万wWkK千]?)$/);
          if (mLabelFirst) trySetCount(mLabelFirst[1], mLabelFirst[2]);
        }

        // 方法 B：标签 + 数字分离模式
        var pureLabels = [];
        var pureNumbers = {};
        for (var b = 0; b < textBlobs.length; b++) {
          var tText = textBlobs[b].text;
          var labelMatch = tText.match(/^(粉丝数?|关注数?|获赞(?:与收藏)?|获赞数?)$/);
          if (labelMatch) { pureLabels.push({ index: b, label: labelMatch[1] }); continue; }
          var pn = parseNumber(tText);
          if (pn !== null && pn > 0 && pn < 1000000000) pureNumbers[b] = pn;
        }
        for (var bi = 0; bi < pureLabels.length; bi++) {
          var pl = pureLabels[bi];
          var needFans = /粉丝/.test(pl.label) && r.fansCount === null;
          var needFollow = /关注/.test(pl.label) && r.followCount === null;
          var needLike = /获赞|收藏/.test(pl.label) && r.likeCount === null;
          if (!needFans && !needFollow && !needLike) continue;
          var bestNum = null;
          var bestDist = 99;
          var numKeys = Object.keys(pureNumbers);
          for (var nk = 0; nk < numKeys.length; nk++) {
            var nIdx = parseInt(numKeys[nk]);
            var dist = Math.abs(nIdx - pl.index);
            if (dist > 0 && dist <= 8 && dist < bestDist) { bestNum = pureNumbers[nIdx]; bestDist = dist; }
          }
          if (bestNum !== null) {
            if (needFans) r.fansCount = bestNum;
            else if (needFollow) r.followCount = bestNum;
            else if (needLike) r.likeCount = bestNum;
          }
        }

        // 方法 C：全文扫描兜底
        var fullText = document.body ? (document.body.innerText || '') : '';
        function scanFullTextC(pattern) {
          var matches = fullText.match(pattern);
          if (matches) {
            for (var gi = 1; gi < matches.length; gi++) {
              if (matches[gi]) return parseNumber(matches[gi]);
            }
          }
          return null;
        }
        if (r.fansCount === null) {
          var fd = scanFullTextC(/(\\d+(?:\\.\\d+)?[万wWkK千]?)\\s*粉丝|粉丝\\s*[数:：]?\\s*(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
          if (fd !== null) r.fansCount = fd;
        }
        if (r.followCount === null) {
          var fl = scanFullTextC(/(\\d+(?:\\.\\d+)?[万wWkK千]?)\\s*关注|关注\\s*[数:：]?\\s*(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
          if (fl !== null) r.followCount = fl;
        }
        if (r.likeCount === null) {
          var lc = scanFullTextC(/(\\d+(?:\\.\\d+)?[万wWkK千]?)\\s*(?:获赞|点赞|收藏)|(?:获赞|点赞|收藏)[与\\s]*[与收藏数:：]*\\s*(\\d+(?:\\.\\d+)?[万wWkK千]?)/i);
          if (lc !== null) r.likeCount = lc;
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
 * 发布视频 — 由 PlatformDispatcher.execute 调用（contentType === 'video'）
 * 流程：打开统一发布页 → 上传视频文件（CDP）→ 填标题/正文 → 点击"发布视频"按钮
 */
async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'xiaohongshu',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布视频', '发布笔记', '发布', '立即发布', '确认发布'],
    enablePostClickVerify: true,
    fillWaitMs: 1500,
  });
}

/**
 * 发布图文 — 由 PlatformDispatcher.execute 调用（contentType === 'image'）
 * 小红书图文与视频使用相同的发布页面：上传图片文件 → 填标题/正文 → 点击"发布笔记"按钮
 */
async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runStandardPublish(accountId, request, onProgress, {
    platform: 'xiaohongshu',
    meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
    detectLoggedIn: (win) => detectLoggedIn(win),
    publishKeywords: ['发布笔记', '发布', '发布视频', '立即发布', '确认发布'],
    enablePostClickVerify: true,
    fillWaitMs: 1500,
  });
}

/**
 * 兼容接口（旧调用路径）：不区分内容类型，默认按视频处理
 * @deprecated 请使用 publishVideo 或 publishImage
 */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  // 自动降级：根据 request.mediaFiles 的扩展名判断
  const isVideo = (request.mediaFiles || []).some((f) =>
    /\.(mp4|mov|mkv|avi|flv|webm|wmv)$/i.test(f),
  );
  if (isVideo || !request.contentType || request.contentType === 'video') {
    return publishVideo(accountId, request, onProgress);
  }
  return publishImage(accountId, request, onProgress);
}

// 组装适配器对象
const adapter: PlatformAdapter = {
  key: 'xiaohongshu',
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publishImage,
  publish,
};

// 注册到全局注册表（供 PlatformDispatcher / PlatformRegistry 查找）
registerPlatform(adapter);

export default adapter;
export { meta as xiaohongshuMeta };
