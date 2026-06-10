import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import { sleep, makePublishLogger, evalJS, makePublishWindow, uploadViaCDP, waitForUploadComplete, buildPageStructureProbe, buildFillTitle, buildFillContent, buildPublishButtonClicker } from './shared';
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
  authUrl: 'https://passport.kuaishou.com/pc/account/login/',
  publishUrl: 'https://cp.kuaishou.com/article/publish/video',
  homeUrl: 'https://cp.kuaishou.com/',
  contentTypes: ['video', 'image'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: false } as AccountCapabilities,
  nicknameSelectors: ['.user-name', '.nickname', '[class*="username"]', '[class*="nickname"]'],
  avatarSelectors: ['img.avatar', 'img[class*="avatar"]', '.user-info img'],
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
        // 快手号
        try {
          var all = document.querySelectorAll('div, span, p');
          for (var i = 0; i < all.length; i++) {
            var txt = (all[i].textContent || '').trim();
            var m = txt.match(/快手(号)?[\\s:：]*([0-9A-Za-z_\\-]+)/);
            if (m && m[2]) { r.platformAccountId = m[2]; break; }
          }
        } catch (e) {}
        // 粉丝/关注
        try {
          var allNodes = document.querySelectorAll('div, span, p');
          var currentLabel = null;
          for (var j = 0; j < allNodes.length; j++) {
            var t2 = (allNodes[j].textContent || '').trim();
            if (!t2 || t2.length > 10) continue;
            if (/^(粉丝数?|关注数?|获赞数?|点赞数?)$/.test(t2)) { currentLabel = t2; continue; }
            if (currentLabel && /^\\d+[.]?\\d*[万wWkK千]?$/.test(t2)) {
              var num = parseFloat(t2);
              if (/[万wW]/.test(t2)) num *= 10000;
              else if (/[千kK]/.test(t2)) num *= 1000;
              if (/^粉丝/.test(currentLabel)) r.fansCount = Math.round(num);
              else if (/^关注/.test(currentLabel)) r.followCount = Math.round(num);
              else if (/^获赞|^点赞/.test(currentLabel)) r.likeCount = Math.round(num);
              currentLabel = null;
            } else { currentLabel = null; }
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
    const startedAt = Date.now();
    const log = makePublishLogger({ accountId, platform: 'kuaishou' });
    log('info', 'init', `开始发布到快手（演示实现）`, { title: request.title, mediaFiles: request.mediaFiles.length });

    let win: any = null;
    try {
      onProgress(5, '打开发布窗口…');
      win = makePublishWindow(accountId, '快手发布 - FlowX');
      onProgress(10, '加载发布页面…');
      await win.loadURL(meta.publishUrl, {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);

      try {
        await evalJS(win, buildPageStructureProbe(), 'page-probe', log);
      } catch { /* ignore */ }

      onProgress(15, '检查登录状态…');
      const auth = await this.detectLoggedIn(win);
      if (!auth.loggedIn) {
        if (!win.isDestroyed()) win.show();
        return { accountId, platform: 'kuaishou', status: 'failed', progress: 100, message: '登录态失效，请在窗口中重新登录后重试', startedAt, finishedAt: Date.now() };
      }
      if (!win.isDestroyed()) { win.show(); win.focus(); }

      if (request.mediaFiles.length > 0) {
        onProgress(30, '上传素材…');
        await uploadViaCDP(win, request.mediaFiles, log);
      }
      const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000);

      onProgress(75, '填写内容…');
      if (request.title) {
        try { await evalJS(win, buildFillTitle(request.title), 'fill-title', log); } catch (e) { log('warn', 'fill', `标题异常: ${(e as Error).message}`); }
      }
      const combined = (request.content || '') + (request.tags?.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
      if (combined.trim().length > 0) {
        try { await evalJS(win, buildFillContent(combined), 'fill-content', log); } catch (e) { log('warn', 'fill', `正文异常: ${(e as Error).message}`); }
      }

      await sleep(1500);
      onProgress(90, '点击发布…');
      const keywords = ['立即发布', '发布', '确认发布', '发布作品'];
      for (let i = 0; i < keywords.length; i++) {
        try {
          const res: any = await evalJS(win, buildPublishButtonClicker(keywords[i]), `click-${keywords[i]}`, log);
          if (res && res.clicked) { log('info', 'submit', `点击成功: ${keywords[i]}`); break; }
        } catch { /* ignore */ }
      }
      await sleep(2500);

      onProgress(100, '发布流程完成');
      return {
        accountId,
        platform: 'kuaishou',
        status: 'success',
        progress: 100,
        message: uploadResult.ready ? '快手发布流程已完成（演示实现）' : '上传未完成，请在窗口中手动确认',
        resultUrl: meta.homeUrl,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'fatal', `发布流程异常: ${msg}`);
      if (win && !win.isDestroyed()) { try { win.show(); } catch { /* ignore */ } }
      return { accountId, platform: 'kuaishou', status: 'failed', progress: 100, message: `发布失败: ${msg}`, startedAt, finishedAt: Date.now() };
    }
  },
};

registerPlatform(adapter);
export default adapter;
export { meta as kuaishouMeta };
