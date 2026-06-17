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
  contentLimits: {
    title: 80,
    content: 1000,
  },
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
    contentLimits: { title: 80, content: 1000 },
    contentType: 'video',
    tabSwitcher: douyinTabSwitcher,
  });
}

/**
 * [抖音专用] tab 切换 — 支持视频/图文/文章三种模式。
 *
 * 抖音创作者服务平台有多个内容类型入口：
 *   - 视频上传（默认）
 *   - 图文发布（可能叫"图文"或"图片"tab）
 *   - 文章发布（可能叫"文章"或"长文"tab）
 *
 * 策略：
 *   1. 优先选择 role="tab" 的元素
 *   2. 搜索 button/a/div 中含关键词的元素
 *   3. 检测当前是否已在正确 tab（含 active 类）
 */
async function douyinTabSwitcher(
  win: BrowserWindow,
  contentType: ContentType,
  log: (level: 'info' | 'warn' | 'error', stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  // 根据 contentType 定义关键词
  let targetKeyword: string;
  let excludeKeyword: string;
  if (contentType === 'article') {
    targetKeyword = '文章';
    excludeKeyword = '视频';
  } else if (contentType === 'image') {
    targetKeyword = '图文';
    excludeKeyword = '视频';
  } else {
    targetKeyword = '视频';
    excludeKeyword = '图文';
  }

  log('info', 'tab', `[douyin] 执行平台专用 tab 切换 → ${targetKeyword}`);

  const script = `
    (function () {
      var targetKw = ${JSON.stringify(targetKeyword)};
      var excludeKw = ${JSON.stringify(excludeKeyword)};
      var altKws = [];
      if (targetKw === '图文') altKws = ['图片', '图集', '图文'];
      if (targetKw === '视频') altKws = ['视频', '上传视频'];
      if (targetKw === '文章') altKws = ['文章', '长文', '图文文章'];

      // 递归收集 root
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

        // 1. role="tab" 优先
        try {
          var roleTabs = root.querySelectorAll('[role="tab"]');
          for (var ti = 0; ti < roleTabs.length; ti++) {
            var rt = roleTabs[ti];
            var txt = (rt.innerText || rt.textContent || '').trim();
            if (!txt || txt.length > 50) continue;
            var matched = txt.indexOf(targetKw) !== -1;
            for (var ai = 0; ai < altKws.length; ai++) {
              if (txt.indexOf(altKws[ai]) !== -1) matched = true;
            }
            var hasExclude = txt.indexOf(excludeKw) !== -1 && excludeKw !== targetKw;
            if (matched && !hasExclude) {
              candidates.push({ el: rt, score: 3000, text: txt, tag: 'role-tab',
                cls: (rt.getAttribute && rt.getAttribute('class') || '').slice(0, 60) });
            }
          }
        } catch (e) {}

        // 2. 搜索 button / a / div / span，匹配关键词
        var tags = ['button', 'a', 'div', 'span', 'li'];
        for (var ti2 = 0; ti2 < tags.length; ti2++) {
          var els = root.querySelectorAll(tags[ti2]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            try {
              var txt2 = (el.innerText || el.textContent || '').trim();
              if (!txt2 || txt2.length > 50) continue;

              var hasTarget = txt2.indexOf(targetKw) !== -1;
              for (var ai2 = 0; ai2 < altKws.length; ai2++) {
                if (txt2.indexOf(altKws[ai2]) !== -1) hasTarget = true;
              }
              var hasExclude2 = txt2.indexOf(excludeKw) !== -1 && targetKw !== excludeKw;
              if (!hasTarget || hasExclude2) continue;

              var score = 0;
              var cls = el.getAttribute && el.getAttribute('class') || '';
              if (/tab|Tab|TAB|switch|Switch|nav|Nav|menu|Menu/i.test(cls)) score += 500;
              if (tags[ti2] === 'button') score += 200;
              else if (tags[ti2] === 'a') score += 150;
              if (el.onclick !== null || /cursor-pointer|pointer|clickable/i.test(cls)) score += 100;
              score += 200;

              try {
                var w = el.offsetWidth || 0;
                var h = el.offsetHeight || 0;
                if (w < 30 || h < 20) continue;
                if (w > 1500 || h > 400) continue;
              } catch (eSz) {}

              candidates.push({ el: el, score: score, text: txt2.slice(0, 50), tag: tags[ti2], cls: cls.slice(0, 60) });
            } catch (e) {}
          }
        }
      }

      if (candidates.length === 0) return { clicked: false, reason: 'no-candidate' };

      // 检查当前是否已选中
      var topCandidates = candidates.slice(0, 5);
      for (var ai = 0; ai < topCandidates.length; ai++) {
        var c = topCandidates[ai];
        try {
          var activeCls = c.el.getAttribute && c.el.getAttribute('class') || '';
          if (/is-active|isActive|is_selected|selected|active|-active/i.test(activeCls)) {
            return { clicked: true, alreadyActive: true, text: '当前已在正确 tab' };
          }
        } catch (e) {}
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
      if (val.alreadyActive) {
        log('info', 'tab', `[douyin] 当前已在${targetKeyword} tab，无需切换`);
      } else {
        log('info', 'tab', `✅ 已切换到${targetKeyword} tab（匹配="${val.text}" score=${val.score}）`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      return true;
    }
    log('warn', 'tab', `[douyin] 专用脚本未找到${targetKeyword} tab（${JSON.stringify(val).slice(0, 200)}），fallback 到通用脚本`);
    return false;
  } catch (e) {
    log('warn', 'tab', `[douyin] tab 切换异常: ${(e as Error).message}`);
    return false;
  }
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
    contentLimits: { title: 80, content: 1000 },
    contentType: 'image',
    tabSwitcher: douyinTabSwitcher,
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
    contentLimits: { title: 80, content: 1000 },
    contentType: 'article',
    tabSwitcher: douyinTabSwitcher,
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
