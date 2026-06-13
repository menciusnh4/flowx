import type { BrowserWindow } from 'electron';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import { runStandardPublish } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities } from '../../../types';

/**
 * 快手平台适配 — 演示用实现，展示如何通过适配器模式扩展新平台
 *
 * 新增平台只需 3 步：
 *   1. 新建 `src/main/services/platforms/<platformKey>.ts`
 *   2. 实现 PlatformAdapter 接口（参考下方）
 *   3. 文件末尾调用 registerPlatform(adapter)
 *
 *   如果使用 side-effect imports 加载机制（index.ts 已实现），
 *   只需在 index.ts 的 platformModules 数组中添加 './<platformKey>' 即可。
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
  // 快手创作中心 HTML：<div class="user-name">User_xxxx</div>
  nicknameSelectors: ['.header-info-card .user-name', '.user-name', '.nickname', '[class*="username"]', '[class*="nickname"]'],
  // 快手头像：<img class="user-image" src="...">
  avatarSelectors: ['.header-info-card img.user-image', 'img.user-image', 'img.avatar', 'img[class*="avatar"]', '.user-info img'],
  loginKeywords: ['创作中心', '发布', '作品', '粉丝', '数据', '个人中心'],
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
        // 快手号：<div class="user-kwai-id">12345678</div>
        try {
          var all = document.querySelectorAll('div, span, p');
          for (var i = 0; i < all.length; i++) {
            var txt = (all[i].textContent || '').trim();
            var m = txt.match(/快手(号)?[\s:：]*([0-9A-Za-z_\-]+)/);
            if (m && m[2]) { r.platformAccountId = m[2]; break; }
          }
        } catch (e) {}
        // 兜底：从页面 cookie 解析 userId 作为快手号（快手页面有时不显示"快手号"文本）
        // 常见 cookie 名：user_id / userId / userKey / kwaiUserId 等
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
                return n === 'user_id' || n === 'userid' || n === 'userId' || n === 'kwaiuserid' ||
                       n === 'kuaishou_id' || n === 'kwai_id' ||
                       n === 'user_key' || n === 'userkey' ||
                       n === 'uid' || n === 'uid_key' ||
                       n === 'kwaiuid' || n === 'user_id_';
              })(cname);
              if (isUidName && cval) {
                cval = cval.trim();
                if (cval.length >= 4 && cval.length <= 40 && /^[0-9A-Za-z_\-]+$/.test(cval)) {
                  r.platformAccountId = cval;
                  break;
                }
              }
            }
          } catch (e) {}
        }
        // 粉丝/关注/获赞 — 快手创作者中心格式（数字在前，label 在后）：
        //   <div class="user-cnt">
        //     <div class="user-cnt__item"> 2<span>粉丝</span></div>
        //     <div class="user-cnt__item">0<span>关注</span></div>
        //     <div class="user-cnt__item">0<span>获赞</span></div>
        //   </div>
        // 元素 textContent = " 2粉丝" / "0关注" / "0获赞"
        try {
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
          // 策略 A：精确匹配 user-cnt__item 元素（最常见的创作者中心 layout）
          var cntItems = document.querySelectorAll('[class*="user-cnt__item"], [class*="user-cnt-"], [class*="user-cnt"] > *');
          for (var a = 0; a < cntItems.length; a++) {
            var t = (cntItems[a].textContent || '').trim();
            if (!t || t.length > 30) continue;
            // 格式："2粉丝" / "0关注" / "0获赞" → 数字在前，label 在后
            var tm = t.match(/^([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*(粉丝|关注|获赞|点赞)\\s*$/);
            if (tm) {
              var n = parseCount(tm[1]);
              if (n !== null) {
                if (tm[2] === '粉丝') r.fansCount = n;
                else if (tm[2] === '关注') r.followCount = n;
                else if (tm[2] === '获赞' || tm[2] === '点赞') r.likeCount = n;
              }
            }
          }
          // 策略 B：兜底遍历，同时兼容 "数字+label" 与 "label+数字" 两种结构
          if (r.fansCount === null || r.followCount === null || r.likeCount === null) {
            var allNodes = document.querySelectorAll('div, span, p');
            var currentLabel = null;
            for (var j = 0; j < allNodes.length; j++) {
              var t2 = (allNodes[j].textContent || '').trim();
              if (!t2 || t2.length > 30) continue;
              // B.1 数字+label 在同一元素（快手常用）："2粉丝" / "0关注" / "0获赞"
              var tmB1 = t2.match(/^([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*(粉丝|关注|获赞|点赞)\\s*$/);
              if (tmB1) {
                var nB1 = parseCount(tmB1[1]);
                if (nB1 !== null) {
                  if (tmB1[2] === '粉丝' && r.fansCount === null) r.fansCount = nB1;
                  else if (tmB1[2] === '关注' && r.followCount === null) r.followCount = nB1;
                  else if ((tmB1[2] === '获赞' || tmB1[2] === '点赞') && r.likeCount === null) r.likeCount = nB1;
                }
                currentLabel = null;
                continue;
              }
              // B.2 label+数字 在同一元素（兼容"粉丝 2" / "关注 0" 风格）
              var tmB2 = t2.match(/^(粉丝|关注|获赞|点赞)\\s*([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
              if (tmB2) {
                var nB2 = parseCount(tmB2[2]);
                if (nB2 !== null) {
                  if (tmB2[1] === '粉丝' && r.fansCount === null) r.fansCount = nB2;
                  else if (tmB2[1] === '关注' && r.followCount === null) r.followCount = nB2;
                  else if ((tmB2[1] === '获赞' || tmB2[1] === '点赞') && r.likeCount === null) r.likeCount = nB2;
                }
                currentLabel = null;
                continue;
              }
              // B.3 label 与数字在相邻元素（兼容其他页面样式）
              if (/^(粉丝数?|关注数?|获赞数?|点赞数?)$/.test(t2)) { currentLabel = t2; continue; }
              if (currentLabel && /^[\\d,]+[.]?\\d*[万wWkK千]?$/.test(t2)) {
                var nB3 = parseCount(t2);
                if (nB3 !== null) {
                  if (/^粉丝/.test(currentLabel) && r.fansCount === null) r.fansCount = nB3;
                  else if (/^关注/.test(currentLabel) && r.followCount === null) r.followCount = nB3;
                  else if (/^获赞|^点赞/.test(currentLabel) && r.likeCount === null) r.likeCount = nB3;
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
      detectLoggedIn: (win: BrowserWindow) => this.detectLoggedIn(win),
      publishKeywords: ['立即发布', '发布', '确认发布', '发布作品'],
      enableConfirmStep: false,
      fillWaitMs: 1500,
    });
  },
};

registerPlatform(adapter);
export default adapter;
export { meta as kuaishouMeta };
