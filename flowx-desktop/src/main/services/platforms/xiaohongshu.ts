import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import { runStandardPublish } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities } from '../../../types';

const meta: PlatformMeta = {
  key: 'xiaohongshu',
  name: '小红书',
  icon: '📕',
  platformAccountLabel: '小红书号',
  authUrl: 'https://creator.xiaohongshu.com/creator/home',
  publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
  homeUrl: 'https://creator.xiaohongshu.com/creator/home',
  contentTypes: ['video', 'image'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: false } as AccountCapabilities,
  nicknameSelectors: ['.account-name', '.user-name', '.nickname', '[class*="account-name"]'],
  avatarSelectors: ['img.user_avatar', '.user-info img', 'img[class*="avatar"]'],
  loginKeywords: ['创作中心', '数据中心', '作品管理', '发布笔记', '发布视频', '我的', '粉丝', '数据分析', '数据看板'],
};

const adapter: PlatformAdapter = {
  key: 'xiaohongshu',
  meta,
  capabilities: meta.capabilities,

  async detectLoggedIn(win): Promise<LoginCheckResult> {
    try {
      const url = win.webContents.getURL();
      const info: any = await win.webContents.executeJavaScript(`
        (function () {
          var bodyText = document.body ? (document.body.innerText || '') : '';
          var curUrl = location.href;
          var keywords = ${JSON.stringify(meta.loginKeywords)};
          var matched = [];
          // 1) 登录页黑名单：URL 含 login/401/redirectReason/signin 直接判定未登录
          var isLoginPage = /login|passport|redirectReason|signin|401|signup/i.test(curUrl);
          // 2) 精确 DOM 检查：必须有账号名元素（如 .account-name 或 .user-name）
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
          // 3) 关键字检查
          for (var j = 0; j < keywords.length; j++) {
            if (bodyText.indexOf(keywords[j]) !== -1) matched.push(keywords[j]);
          }
          // 综合判定：URL 非登录页 AND (有账号元素 OR 多关键字命中)
          var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3);
          return {
            loggedIn: loggedIn,
            matched: matched,
            title: document.title,
            url: curUrl,
            isLoginPage: isLoginPage,
            hasAccountEl: hasAccountEl,
            rawNick: rawNick,
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
  },

  async extractPageInfo(win): Promise<ExtractedAccountInfo> {
    // 从页面 DOM 提取昵称、头像、平台账号ID、粉丝/关注/获赞数据
    const result: any = await win.webContents.executeJavaScript(`
      (function () {
        var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };
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
        // 平台账号 ID（小红书账号）
        try {
          var allDivs = document.querySelectorAll('div, span, p');
          for (var i = 0; i < allDivs.length; i++) {
            var txt = (allDivs[i].textContent || '').trim();
            var m = txt.match(/小红书账号[\\s:：]*([0-9A-Za-z_\\-]+)/);
            if (m) { r.platformAccountId = m[1]; break; }
          }
        } catch (e) {}
        // 粉丝/关注/获赞 — 小红书页面结构：xx 粉丝数 / xx 关注数 / xx 获赞与收藏
        try {
          var allNodes = document.querySelectorAll('div, span, p');
          var currentNumStr = null;
          for (var j = 0; j < allNodes.length; j++) {
            var t2 = (allNodes[j].textContent || '').trim();
            if (!t2 || t2.length > 10) continue;
            if (/^(粉丝数?|关注数?|获赞(与收藏)?)$/.test(t2)) {
              if (currentNumStr) {
                var num = parseFloat(currentNumStr);
                if (!isNaN(num)) {
                  if (/[万wW]/.test(currentNumStr)) num *= 10000;
                  else if (/[千kK]/.test(currentNumStr)) num *= 1000;
                  if (/^粉丝/.test(t2)) r.fansCount = Math.round(num);
                  else if (/^关注/.test(t2)) r.followCount = Math.round(num);
                  else if (/^获赞/.test(t2)) r.likeCount = Math.round(num);
                }
                currentNumStr = null;
              }
              // 也允许：标签后跟数字（抖音格式）— 在下一轮循环中处理
              var lookingFor = t2;
              var found = false;
              for (var k = j + 1; k < Math.min(j + 5, allNodes.length); k++) {
                var t3 = (allNodes[k].textContent || '').trim();
                if (/^\\d+[.]?\\d*[万wWkK千]?$/.test(t3)) {
                  var num2 = parseFloat(t3);
                  if (/[万wW]/.test(t3)) num2 *= 10000;
                  else if (/[千kK]/.test(t3)) num2 *= 1000;
                  if (/^粉丝/.test(lookingFor)) r.fansCount = Math.round(num2);
                  else if (/^关注/.test(lookingFor)) r.followCount = Math.round(num2);
                  else if (/^获赞/.test(lookingFor)) r.likeCount = Math.round(num2);
                  found = true;
                  break;
                }
              }
              if (found) continue;
            }
            if (/^\\d+[.]?\\d*[万wWkK千]?$/.test(t2)) {
              currentNumStr = t2;
            } else {
              currentNumStr = null;
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

  async publish(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress> {
    return runStandardPublish(accountId, request, onProgress, {
      platform: 'xiaohongshu',
      meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
      detectLoggedIn: (win: BrowserWindow) => this.detectLoggedIn(win),
      publishKeywords: ['发布', '立即发布', '发布笔记', '发布视频'],
      enablePostClickVerify: true,
      fillWaitMs: 1500,
    });
  },
};

// 注册到全局注册表
registerPlatform(adapter);

export default adapter;
export { meta as xiaohongshuMeta };
