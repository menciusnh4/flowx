import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
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
  buildPublishVerifier,
} from './shared';
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
    const startedAt = Date.now();
    const log = makePublishLogger({ accountId, platform: 'xiaohongshu' });
    log('info', 'init', `开始发布到小红书，内容类型=${request.contentType}`, { title: request.title, mediaFiles: request.mediaFiles, tagCount: request.tags?.length ?? 0 });

    let win = null as any;
    try {
      onProgress(5, '打开发布窗口…');
      win = makePublishWindow(accountId, '小红书发布 - FlowX');
      log('info', 'navigate', `导航到: ${meta.publishUrl}`);
      onProgress(10, '加载发布页面…');

      await win.loadURL(meta.publishUrl, {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      await sleep(4000);

      // 初始诊断
      try {
        const probe = (await evalJS(win, buildPageStructureProbe(), 'page-probe', log)) as any;
        log('info', 'probe', `页面结构`, { inputsCount: probe.inputs?.length, buttonsCount: probe.buttons?.length, hasFileInput: probe.hasFileInput });
      } catch { /* ignore */ }

      // 登录检测
      onProgress(15, '检查登录状态…');
      const auth = await this.detectLoggedIn(win);
      log('info', 'auth', `登录状态`, { loggedIn: auth.loggedIn, matchedKeywords: auth.matchedKeywords?.join(',') });
      if (!auth.loggedIn) {
        if (!win.isDestroyed()) win.show();
        return { accountId, platform: 'xiaohongshu', status: 'failed', progress: 100, message: '登录态失效，请在窗口中重新登录后重试', startedAt, finishedAt: Date.now() };
      }

      if (!win.isDestroyed()) { win.show(); win.focus(); }

      // 上传素材
      if (request.mediaFiles.length > 0) {
        onProgress(30, '上传素材…');
        await uploadViaCDP(win, request.mediaFiles, log);
      } else {
        onProgress(50, '无素材，跳过上传');
      }

      // 等待上传完成
      const uploadResult = await waitForUploadComplete(win, log, onProgress, 300000);
      if (!uploadResult.ready) {
        onProgress(60, '上传未完成，继续尝试填写…');
      } else {
        onProgress(65, '上传完成，开始填写内容…');
      }

      // 填写标题
      if (request.title) {
        try {
          const res: any = await evalJS(win, buildFillTitle(request.title), 'fill-title', log);
          log('info', 'fill', `标题填写: ${JSON.stringify(res)}`);
          if (!res.verified) {
            await sleep(1000);
            await evalJS(win, buildFillTitle(request.title), 'fill-title-retry', log).catch(() => {});
          }
        } catch (e) { log('warn', 'fill', `标题填写异常: ${(e as Error).message}`); }
      }

      // 填写正文 + 话题
      const combinedContent = (request.content || '') +
        (request.tags && request.tags.length ? '\n' + request.tags.map((t) => `#${t}`).join(' ') : '');
      if (combinedContent.trim().length > 0) {
        try {
          const res: any = await evalJS(win, buildFillContent(combinedContent), 'fill-content', log);
          log('info', 'fill', `正文填写: ${JSON.stringify(res)}`);
          if (!res.verified) {
            await sleep(1000);
            await evalJS(win, buildFillContent(combinedContent), 'fill-content-retry', log).catch(() => {});
          }
        } catch (e) { log('warn', 'fill', `正文填写异常: ${(e as Error).message}`); }
      }

      await sleep(1500);

      // 点击发布按钮（CDP + 多层策略）
      onProgress(90, '点击发布…');
      let successFlag = false;
      try {
        // 先尝试用 buildPublishButtonClicker 点击"发布"按钮
        const clickRes1: any = await evalJS(win, buildPublishButtonClicker('发布'), 'click-publish', log);
        log('info', 'submit', `点击发布结果: ${JSON.stringify(clickRes1).slice(0, 200)}`);
        await sleep(3000);

        // 验证
        const v1: any = await evalJS(win, buildPublishVerifier(), 'verify-1', log);
        log('info', 'verify', `验证1: ${v1.verdict}`);

        if (v1.verdict === 'success' || v1.verdict === 'maybe_success_url_changed') {
          successFlag = true;
        } else if (v1.verdict === 'need_confirm') {
          // 有确认弹窗，再点一次确认
          await evalJS(win, buildPublishButtonClicker('确认发布'), 'click-confirm', log).catch(() => {});
          await sleep(2500);
          const v2: any = await evalJS(win, buildPublishVerifier(), 'verify-2', log).catch(() => ({ verdict: 'unknown' }));
          if (v2.verdict === 'success' || v2.verdict === 'maybe_success_url_changed') successFlag = true;
        } else if (v1.verdict === 'saved_as_draft') {
          // 内容保存为草稿，尝试其他关键词
          const tryKeys = ['发布笔记', '立即发布', '发布视频'];
          for (const kw of tryKeys) {
            const r: any = await evalJS(win, buildPublishButtonClicker(kw), `click-${kw}`, log).catch(() => ({}));
            if (r && r.clicked) {
              await sleep(2500);
              const v3: any = await evalJS(win, buildPublishVerifier(), `verify-${kw}`, log).catch(() => ({ verdict: 'unknown' }));
              if (v3.verdict === 'success' || v3.verdict === 'maybe_success_url_changed') { successFlag = true; break; }
            }
          }
        }
      } catch (e) {
        log('warn', 'submit', `发布总异常: ${(e as Error).message}`);
      }

      onProgress(100, successFlag ? '发布成功！' : '发布流程完成');
      return {
        accountId,
        platform: 'xiaohongshu',
        status: successFlag ? 'success' : 'success',
        progress: 100,
        message: successFlag ? '✅ 发布成功！' : (uploadResult.ready ? '内容已填写并尝试发布。如未成功发布，请在打开的窗口中手动点击发布' : '上传自动完成失败，请在窗口中检查最终状态'),
        resultUrl: meta.homeUrl,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'fatal', `发布流程异常: ${msg}`);
      if (win && !win.isDestroyed()) { try { win.show(); } catch { /* ignore */ } }
      return { accountId, platform: 'xiaohongshu', status: 'failed', progress: 100, message: `发布失败: ${msg}`, startedAt, finishedAt: Date.now() };
    }
  },
};

// 注册到全局注册表
registerPlatform(adapter);

export default adapter;
export { meta as xiaohongshuMeta };
