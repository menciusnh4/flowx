import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import {
  sleep,
  makePublishLogger,
  evalJS,
  makePublishWindow,
  uploadViaCDP,
  waitForUploadComplete,
  buildPageStructureProbe,
  buildFillTitle,
  buildFillContent,
  buildPublishButtonClicker,
} from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities } from '../../../types';

const meta: PlatformMeta = {
  key: 'douyin',
  name: '抖音',
  icon: '🎵',
  platformAccountLabel: '抖音号',
  authUrl: 'https://creator.douyin.com/creator-micro/home',
  publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  homeUrl: 'https://creator.douyin.com/creator-micro/home',
  contentTypes: ['video', 'image', 'article'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: true } as AccountCapabilities,
  // 抖音创作中心 HTML：<div class="name-_lSSDc">用法用量</div>
  nicknameSelectors: ['[class*="header-"] [class*="name-_"]', '[class*="name-_"]', '[class*="name-"]', '.name-box', '.user-name', '.nickname'],
  // 头像：<div class="avatar-XoPjK6"><img class="img-PeynF_" src="..."></div>
  avatarSelectors: ['[class*="avatar-"] img', 'img[class*="img-"]', 'img[class*="avatar"]', 'img.user_avatar', '.user-info img'],
  loginKeywords: ['创作中心', '内容管理', '发布', '作品', '数据', '粉丝'],
};

const adapter: PlatformAdapter = {
  key: 'douyin',
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
          // 1) URL 登录页黑名单
          var isLoginPage = /login|passport|redirectReason|signin|401|signup|sso|captcha/i.test(curUrl);
          // 2) 精确 DOM 检查：账号名元素必须真实存在且有内容
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
          // 综合：非登录页 AND (有账号元素 OR ≥3 个关键字命中)
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
        // 抖音号：<div class="unique_id-EuH8eA">抖音号：20275758647</div>
        try {
          var all = document.querySelectorAll('div, span, p');
          for (var i = 0; i < all.length; i++) {
            var txt = (all[i].textContent || '').trim();
            var m = txt.match(/抖音号[\\s:：]*([0-9A-Za-z_\\-]+)/);
            if (m) { r.platformAccountId = m[1]; break; }
          }
        } catch (e) {}
        // 粉丝/关注/获赞 — 抖音创作者中心格式：
        //   <div class="statics-item-MDWoNA">关注 <span class="number-No6ev9">0</span></div>
        //   <div class="statics-item-MDWoNA">粉丝 <span class="number-No6ev9">0</span></div>
        //   <div class="statics-item-MDWoNA">获赞 <span class="number-No6ev9">0</span></div>
        // 元素 textContent = "关注 0" / "粉丝 0" / "获赞 1.2万" 等（label 与 number 混在一起）
        try {
          function parseCount(text) {
            // 支持：0、1234、1.2万、1,234
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
          // 策略 A：识别 statics-item 元素（最常见的创作者中心 layout）
          var statItems = document.querySelectorAll('[class*="statics-item"], [class*="statics-"] > *');
          for (var a = 0; a < statItems.length; a++) {
            var t = (statItems[a].textContent || '').trim();
            if (!t || t.length > 30) continue;
            var tm = t.match(/^(关注|粉丝|获赞)[\\s\\S]*?([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
            if (tm) {
              var n = parseCount(tm[2]);
              if (n !== null) {
                if (tm[1] === '粉丝') r.fansCount = n;
                else if (tm[1] === '关注') r.followCount = n;
                else if (tm[1] === '获赞') r.likeCount = n;
              }
            }
          }
          // 策略 B：兜底 — 遍历所有 div/span，按 "label + 数字" 同一元素 或 相邻元素 两种结构识别
          if (r.fansCount === null || r.followCount === null || r.likeCount === null) {
            var allNodes = document.querySelectorAll('div, span, p');
            var currentLabel = null;
            for (var j = 0; j < allNodes.length; j++) {
              var t2 = (allNodes[j].textContent || '').trim();
              if (!t2 || t2.length > 30) continue;
              // B.1 label+数字在同一元素："关注 1,234"、"粉丝 1.2万"、"获赞 0"
              var tm2 = t2.match(/^(关注|粉丝|获赞)[\\s:：]*([\\d,]+(?:\\.\\d+)?(?:[万千wWkK])?)\\s*$/);
              if (tm2) {
                var n2 = parseCount(tm2[2]);
                if (n2 !== null) {
                  if (tm2[1] === '粉丝' && r.fansCount === null) r.fansCount = n2;
                  else if (tm2[1] === '关注' && r.followCount === null) r.followCount = n2;
                  else if (tm2[1] === '获赞' && r.likeCount === null) r.likeCount = n2;
                }
                currentLabel = null;
                continue;
              }
              // B.2 label 与数字分开的相邻元素（部分页面样式）
              if (/^(粉丝数?|关注数?|获赞数?)$/.test(t2)) { currentLabel = t2; continue; }
              if (currentLabel && /^[\\d,]+[.]?\\d*[万wWkK千]?$/.test(t2)) {
                var n3 = parseCount(t2);
                if (n3 !== null) {
                  if (/^粉丝/.test(currentLabel) && r.fansCount === null) r.fansCount = n3;
                  else if (/^关注/.test(currentLabel) && r.followCount === null) r.followCount = n3;
                  else if (/^获赞/.test(currentLabel) && r.likeCount === null) r.likeCount = n3;
                }
                currentLabel = null;
              } else if (!/^(粉丝|关注|获赞)/.test(t2)) {
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
    const startedAt = Date.now();
    const log = makePublishLogger({ accountId, platform: 'douyin' });
    log('info', 'init', `开始发布到抖音`, { title: request.title, mediaCount: request.mediaFiles.length, tagCount: request.tags?.length ?? 0 });

    let win: any = null;
    try {
      onProgress(5, '打开发布窗口…');
      win = makePublishWindow(accountId, '抖音发布 - FlowX');
      onProgress(10, '加载发布页面…');
      await win.loadURL(meta.publishUrl, {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);

      try {
        const probe: any = await evalJS(win, buildPageStructureProbe(), 'page-probe', log);
        log('info', 'probe', `页面结构`, { inputsCount: probe.inputs?.length, contenteditableCount: probe.contenteditable?.length, buttonsCount: probe.buttons?.length });
      } catch { /* ignore */ }

      onProgress(15, '检查登录状态…');
      const auth = await this.detectLoggedIn(win);
      if (!auth.loggedIn) {
        if (!win.isDestroyed()) win.show();
        return { accountId, platform: 'douyin', status: 'failed', progress: 100, message: '登录态失效，请在窗口中重新登录后重试', startedAt, finishedAt: Date.now() };
      }
      if (!win.isDestroyed()) { win.show(); win.focus(); }

      if (request.mediaFiles.length > 0) {
        onProgress(30, '上传素材…');
        await uploadViaCDP(win, request.mediaFiles, log);
      } else {
        onProgress(50, '无素材，跳过上传');
      }

      const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000);
      if (!uploadResult.ready) onProgress(60, '上传未完成，继续尝试填写…');

      onProgress(75, '填写标题与正文…');
      if (request.title) {
        try { await evalJS(win, buildFillTitle(request.title), 'fill-title', log); }
        catch (e) { log('warn', 'fill', `标题填写异常: ${(e as Error).message}`); }
      }
      const combinedContent = (request.content || '') +
        (request.tags && request.tags.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
      if (combinedContent.trim().length > 0) {
        try { await evalJS(win, buildFillContent(combinedContent), 'fill-content', log); }
        catch (e) { log('warn', 'fill', `正文填写异常: ${(e as Error).message}`); }
      }
      await sleep(1500);

      onProgress(90, '点击发布…');
      const publishKeywords = ['立即发布', '发布作品', '确认发布', '发布'];
      for (let i = 0; i < publishKeywords.length; i++) {
        try {
          const res: any = await evalJS(win, buildPublishButtonClicker(publishKeywords[i]), `click-${publishKeywords[i]}`, log);
          if (res && res.clicked) { log('info', 'submit', `点击成功: ${publishKeywords[i]}`); break; }
        } catch (e) { log('warn', 'submit', `关键词 "${publishKeywords[i]}" 点击异常`); }
      }
      await sleep(2500);
      try { await evalJS(win, buildPublishButtonClicker('确认'), 'click-confirm', log); } catch { /* ignore */ }

      onProgress(100, '发布流程完成');
      return {
        accountId,
        platform: 'douyin',
        status: 'success',
        progress: 100,
        message: uploadResult.ready ? '发布流程已自动完成。如平台弹出二次确认，请在窗口中手动点击确认' : '上传自动完成失败，请在窗口中检查最终状态',
        resultUrl: meta.homeUrl,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'fatal', `发布流程异常: ${msg}`);
      if (win && !win.isDestroyed()) { try { win.show(); } catch { /* ignore */ } }
      return { accountId, platform: 'douyin', status: 'failed', progress: 100, message: `发布失败: ${msg}`, startedAt, finishedAt: Date.now() };
    }
  },
};

registerPlatform(adapter);
export default adapter;
export { meta as douyinMeta };
