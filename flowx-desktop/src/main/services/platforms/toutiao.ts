import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import {
  makePublishLogger,
  makeFailedResult,
} from './shared';
import { registerPlatform } from './registry';
import type {
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
} from '../../../types';

/**
 * 今日头条（头条号）平台适配器
 *
 * 平台信息：
 *   - 创作者后台：https://mp.toutiao.com/profile_v4/index
 *   - 登录页：https://mp.toutiao.com/auth/page/login
 *   - 登录态标识：cookie `sessionid` 或 `sid_tt` 存在且非空即为已登录
 *   - 发布入口：
 *     - 图文：https://mp.toutiao.com/profile_v4/graphic/publish
 *     - 视频：通过发布中心
 *     - 微头条：短内容
 *
 * TODO 待实现：
 *   - publishVideo / publishImage / publishArticle: 发布功能
 */

const log = makePublishLogger({ platform: 'toutiao' });

const meta: PlatformMeta = {
  key: 'toutiao',
  name: '今日头条',
  icon: '条',
  platformAccountLabel: '头条号',
  authUrl: 'https://mp.toutiao.com/profile_v4/index',
  publishUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  homeUrl: 'https://mp.toutiao.com/profile_v4/index',
  contentTypes: ['article', 'video', 'image'],
  capabilities: {
    publishVideo: false, // TODO: 待实现
    publishImage: false, // TODO: 待实现
    publishArticle: false, // TODO: 待实现
  } as AccountCapabilities,
  contentLimits: {
    title: 30,
    content: 50000,
  },
  articleLimits: {
    title: 30,
  },
  nicknameSelectors: [
    '.nickname',
    '.user-name',
    '.author-name',
    '[class*="nickname"]',
    '[class*="username"]',
    '.sidebar .name',
    '.user-info .name',
    '.author-info .name',
  ],
  avatarSelectors: [
    '.avatar img',
    '.user-avatar img',
    '[class*="avatar"] img',
    'img.avatar',
    '.sidebar img',
    '.author-info img',
  ],
  loginKeywords: ['头条号', '创作中心', '发布', '内容管理', '数据分析', '粉丝', '收益', '退出登录'],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：头条登录后必有 sessionid 或 sid_tt
    const cookies = await win.webContents.session.cookies.get({});
    const sessionid = cookies.find((c) => c.name === 'sessionid' && c.value);
    const sidtt = cookies.find((c) => c.name === 'sid_tt' && c.value);

    const matchedKeywords: string[] = [];
    if (sessionid) matchedKeywords.push('sessionid-cookie');
    if (sidtt) matchedKeywords.push('sid_tt-cookie');

    // 2. 在登录页肯定未登录
    const isLoginPage = currentUrl.includes('/auth/page/login') ||
                        (currentUrl.includes('login') && !currentUrl.includes('profile'));

    // 3. 已进入后台管理页面（URL 包含 profile_v4）
    const inBackend = currentUrl.includes('profile_v4') || currentUrl.includes('/creator/');
    if (inBackend) matchedKeywords.push('in-backend');

    // 4. DOM 辅助检测
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 头条后台已登录标志：用户昵称元素、退出按钮、侧边栏菜单
            var nameEl = document.querySelector('.nickname') ||
                        document.querySelector('.user-name') ||
                        document.querySelector('[class*="nickname"]');
            var hasLogout = document.body.innerText.indexOf('退出登录') !== -1 ||
                           document.body.innerText.indexOf('退出') !== -1;
            var hasSidebar = document.body.innerText.indexOf('内容管理') !== -1 ||
                            document.body.innerText.indexOf('数据分析') !== -1;
            return !!(nameEl || (hasLogout && hasSidebar));
          } catch(e) {
            return false;
          }
        })()
      `);
      if (domLoggedIn) matchedKeywords.push('dom-profile');
    } catch {
      // ignore
    }

    const loggedIn = (!!sessionid || !!sidtt) && !isLoginPage;

    return {
      loggedIn,
      url: currentUrl,
      title: win.webContents.getTitle(),
      matchedKeywords,
    };
  } catch (e) {
    log('error', 'detectLoggedIn', (e as Error).message);
    return {
      loggedIn: false,
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
    };
  }
}

// ========================= 提取账号信息 =========================

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    // 分步提取，避免单个大脚本执行失败导致全部信息丢失
    let nickname = '';
    let avatar = '';
    let platformAccountId = '';
    let fansCount = 0;

    // 1. 提取昵称
    try {
      nickname = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var sel = ['.auth-avator-name','.user-panel .auth-avator-name','.nickname','.user-name','[class*="nickname"]'];
            for (var i = 0; i < sel.length; i++) {
              var el = document.querySelector(sel[i]);
              if (el && el.textContent) {
                var t = el.textContent.trim();
                if (t && t.length < 50 && t !== '头条号'
                    && t.indexOf('下午好') < 0 && t.indexOf('上午好') < 0
                    && t.indexOf('晚上好') < 0 && t.indexOf('欢迎') < 0) {
                  return t;
                }
              }
            }
            // 从菜单标题提取
            var mt = document.querySelector('.menu-title');
            if (mt && mt.textContent) {
              var m = mt.textContent.match(/[\uff0c,]\\s*(.+)$/);
              if (m && m[1]) return m[1].trim();
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取昵称失败: ' + (e as Error).message);
    }

    // 2. 提取头像
    try {
      avatar = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var sel = ['.auth-avator-img','.user-panel .auth-avator-img','[class*="auth-avator"] img','.avatar img','[class*="avatar"] img'];
            for (var i = 0; i < sel.length; i++) {
              var img = document.querySelector(sel[i]);
              if (img && img.src && img.src.indexOf('data:') < 0) return img.src;
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取头像失败: ' + (e as Error).message);
    }

    // 3. 提取平台账号ID（从个人主页链接）
    try {
      platformAccountId = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var links = document.querySelectorAll('a[href*="/c/user/"]');
            for (var i = 0; i < links.length; i++) {
              var href = links[i].getAttribute('href') || '';
              var m = href.match(/\\/c\\/user\\/(\\d+)/);
              if (m && m[1]) return m[1];
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取账号ID失败: ' + (e as Error).message);
    }

    // 4. 提取粉丝数
    try {
      const fansStr = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var items = document.querySelectorAll('.data-board-item');
            if (items.length > 0) {
              var el = items[0].querySelector('.data-board-item-primary');
              if (el) return el.textContent.trim();
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
      if (fansStr) {
        const num = parseFloat(fansStr.replace(/[^0-9.]/g, ''));
        if (!isNaN(num)) {
          fansCount = fansStr.includes('万') ? Math.round(num * 10000) : Math.round(num);
        }
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '提取粉丝数失败: ' + (e as Error).message);
    }

    log('info', 'extractPageInfo', `提取结果: nickname="${nickname}", id="${platformAccountId}", fans=${fansCount}`);

    return {
      nickname,
      avatar,
      platformAccountId,
      fansCount,
      followCount: 0,
      likeCount: 0,
    };
  } catch (e) {
    log('error', 'extractPageInfo', (e as Error).message);
    return { nickname: '' };
  }
}

// ========================= 发布功能（待实现）=========================

async function publish(
  accountId: string,
  _request: PublishRequest,
  _onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return makeFailedResult(accountId, 'toutiao', '今日头条发布功能正在开发中，暂不支持');
}

// ========================= 注册平台 =========================

const adapter: PlatformAdapter = {
  key: meta.key,
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publish,
};

registerPlatform(adapter);

log('info', 'register', '今日头条平台适配器已注册（骨架版本，发布功能待实现）');
