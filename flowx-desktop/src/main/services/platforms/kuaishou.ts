import type { BrowserWindow } from 'electron';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import { runStandardPublish } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities } from '../../../types';

/**
 * 快手平台适配器
 *
 * 发布流程：通过 runStandardPublish 复用标准框架（导航 → 登录检测 → 上传 → 填写 → 点击发布）
 * 差异化点：
 *   1. 账号 / 粉丝数 / 关注数 / 获赞 的 DOM 结构与抖音不同，使用快手专属选择器
 *   2. 发布按钮关键词与抖音略有差异（快手常用"发布作品"而非"立即发布"）
 *   3. 登录检测基于创作中心特有元素（"发布作品"、"粉丝"、"数据"等关键词）
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
  capabilities: { publishVideo: true, publishImage: true, publishArticle: false } as AccountCapabilities,
  // 快手创作中心：<div class="user-name">xxx</div> 或带 hash 的 class 如 name-xxxx
  nicknameSelectors: [
    '[class*="user-name"]',
    '[class*="nickname"]',
    '[class*="nick-name"]',
    '.user-name',
    '.nickname',
    '.header-info-card .user-name',
    '[class*="username"]',
  ],
  // 快手头像：<img class="user-image" src="..."> 或 <div class="avatar-xxx"><img></div>
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

const adapter: PlatformAdapter = {
  key: 'kuaishou',
  meta,
  capabilities: meta.capabilities,

  async detectLoggedIn(win): Promise<LoginCheckResult> {
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
          return { loggedIn: loggedIn, matched: matched, title: document.title, url: curUrl, isLoginPage: isLoginPage, hasAccountEl: hasAccountEl, rawNick: rawNick };
        })();
      `);
      return { loggedIn: info.loggedIn, url: info.url || '', title: info.title || '', matchedKeywords: info.matched };
    } catch {
      return { loggedIn: false, url: '', title: '' };
    }
  },

  async extractPageInfo(win): Promise<ExtractedAccountInfo> {
    const result: any = await win.webContents.executeJavaScript(`
      (function () {
        var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };
        var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
        for (var si = 0; si < nickSels.length; si++) {
          var el = document.querySelector(nickSels[si]);
          if (el && el.textContent && el.textContent.trim()) { r.nickname = el.textContent.trim(); break; }
        }
        var avSels = ${JSON.stringify(meta.avatarSelectors)};
        for (var ai = 0; ai < avSels.length; ai++) {
          var el2 = document.querySelector(avSels[ai]);
          if (el2 && el2.getAttribute) {
            var src = el2.getAttribute('src') || '';
            if (src && /^https?:\\/\\//.test(src)) { r.avatar = src; break; }
          }
        }
        // 快手号：<div>快手号：12345678</div> 或 <span>快手号 12345678</span>
        try {
          var all = document.querySelectorAll('div, span, p');
          for (var i = 0; i < all.length; i++) {
            var txt = (all[i].textContent || '').trim();
            var m = txt.match(/快手(号)?[\\s:：]*([0-9A-Za-z_\\-]+)/);
            if (m && m[2]) { r.platformAccountId = m[2]; break; }
          }
        } catch (e) {}
        // 兜底：从 cookie 解析 userId
        if (!r.platformAccountId) {
          try {
            var ck = document.cookie || '';
            var pairs = ck.split(';');
            for (var ci = 0; ci < pairs.length; ci++) {
              var kv = (pairs[ci] || '').trim();
              var eq = kv.indexOf('=');
              if (eq < 1) continue;
              var cname = decodeURIComponent(kv.substring(0, eq)).trim().toLowerCase();
              var cval = kv.substring(eq + 1);
              try { cval = decodeURIComponent(cval); } catch (_) {}
              var isUidName = (function (n) {
                return n === 'user_id' || n === 'userid' || n === 'userId' || n === 'kuaishou_id' ||
                       n === 'kwai_id' || n === 'kwaiuserid' ||
                       n === 'uid' || n === 'uid_key' || n === 'kwai_uid';
              })(cname);
              if (isUidName && cval) {
                cval = cval.trim();
                if (cval.length >= 4 && cval.length <= 40 && /^[0-9A-Za-z_\\-]+$/.test(cval)) {
                  r.platformAccountId = cval;
                  break;
                }
              }
            }
          } catch (e) {}
        }
        // 粉丝/关注/获赞 — 快手创作者中心多种格式：
        //   格式 A（同元素 label+数字）：<div class="xxx">粉丝 123</div> / <div class="xxx">关注 45</div>
        //   格式 B（相邻元素）：<span>粉丝</span><span>123</span>
        //   格式 C（统计卡片）：<div class="stat-card"><span>粉丝数</span><span>123</span></div>
        //   格式 D（数字在前）：<div>123 粉丝</div>
        try {
          function parseCount(text) {
            var clean = (text || '').trim().replace(/[,\\s]/g, '');
            var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万千wWkK千])?$/);
            if (!pm) return null;
            var n = parseFloat(pm[1]);
            if (pm[2]) {
              if (/[万千wW]/.test(pm[2])) n *= 10000;
              else if (/[千kK]/.test(pm[2])) n *= 1000;
            }
            return Math.round(n);
          }
          // 策略 A：优先匹配带统计关键词的元素（label+数字 或 数字+label）
          var statItems = document.querySelectorAll('[class*="stat"], [class*="count"], [class*="cnt"], [class*="num"], [class*="number"], [class*="item-"], div > span');
          for (var a = 0; a < statItems.length; a++) {
            var t = (statItems[a].textContent || '').trim();
            if (!t || t.length > 40) continue;
            // A.1 "粉丝 123" / "关注 45" / "获赞 678"
            var tm1 = t.match(/^(粉丝|关注|获赞|点赞)[\\s:：]*([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
            if (tm1) {
              var n1 = parseCount(tm1[2]);
              if (n1 !== null) {
                if (tm1[1] === '粉丝' && r.fansCount === null) r.fansCount = n1;
                else if (tm1[1] === '关注' && r.followCount === null) r.followCount = n1;
                else if ((tm1[1] === '获赞' || tm1[1] === '点赞') && r.likeCount === null) r.likeCount = n1;
              }
              continue;
            }
            // A.2 "123 粉丝" / "45 关注" / "678 获赞"（数字在前）
            var tm2 = t.match(/^([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)[\\s:：]*(粉丝|关注|获赞|点赞)\\s*$/);
            if (tm2) {
              var n2 = parseCount(tm2[1]);
              if (n2 !== null) {
                if (tm2[2] === '粉丝' && r.fansCount === null) r.fansCount = n2;
                else if (tm2[2] === '关注' && r.followCount === null) r.followCount = n2;
                else if ((tm2[2] === '获赞' || tm2[2] === '点赞') && r.likeCount === null) r.likeCount = n2;
              }
              continue;
            }
            // A.3 "粉丝数：123" / "关注数 45"
            var tm3 = t.match(/^(粉丝数|关注数|获赞数|点赞数)[\\s:：]*([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
            if (tm3) {
              var n3 = parseCount(tm3[2]);
              if (n3 !== null) {
                if (/^粉丝/.test(tm3[1]) && r.fansCount === null) r.fansCount = n3;
                else if (/^关注/.test(tm3[1]) && r.followCount === null) r.followCount = n3;
                else if (/^获赞|^点赞/.test(tm3[1]) && r.likeCount === null) r.likeCount = n3;
              }
              continue;
            }
          }
          // 策略 B：兜底相邻元素（label 与数字在不同子元素内）
          if (r.fansCount === null || r.followCount === null || r.likeCount === null) {
            var allNodes = document.querySelectorAll('div, span, p');
            var currentLabel = null;
            for (var j = 0; j < allNodes.length; j++) {
              var t2 = (allNodes[j].textContent || '').trim();
              if (!t2 || t2.length > 30) continue;
              // B.1 标签元素："粉丝" / "关注" / "获赞"
              if (/^(粉丝数?|关注数?|获赞数?|点赞数?)$/.test(t2)) { currentLabel = t2; continue; }
              // B.2 后续的纯数字元素
              if (currentLabel && /^[\\d,]+[.]?\\d*[万wWkK千]?$/.test(t2)) {
                var nB = parseCount(t2);
                if (nB !== null) {
                  if (/^粉丝/.test(currentLabel) && r.fansCount === null) r.fansCount = nB;
                  else if (/^关注/.test(currentLabel) && r.followCount === null) r.followCount = nB;
                  else if (/^获赞|^点赞/.test(currentLabel) && r.likeCount === null) r.likeCount = nB;
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
  },

  async publish(accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> {
    return runStandardPublish(accountId, request, onProgress, {
      platform: 'kuaishou',
      meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
      detectLoggedIn: (win: BrowserWindow) => adapter.detectLoggedIn(win),
      // 快手发布按钮关键词优先级：发布作品 > 立即发布 > 发布 > 确认发布
      publishKeywords: ['发布作品', '立即发布', '发布', '确认发布'],
      enableConfirmStep: false,
      enablePostClickVerify: true,
      fillWaitMs: 1500,
    });
  },
};

registerPlatform(adapter);
export default adapter;
export { meta as kuaishouMeta };
