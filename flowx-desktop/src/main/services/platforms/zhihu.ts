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
 * 知乎平台适配器
 *
 * 平台信息：
 *   - 创作者中心：https://www.zhihu.com/creator
 *   - 登录页：https://www.zhihu.com/signin
 *   - 登录态标识：cookie `z_c0` 存在且非空即为已登录
 *   - 发布入口：知乎支持文章、回答、视频、想法等多种内容形式
 *
 * TODO 待实现：
 *   - publishVideo / publishImage / publishArticle: 发布功能
 */

const log = makePublishLogger({ platform: 'zhihu' });

const meta: PlatformMeta = {
  key: 'zhihu',
  name: '知乎',
  icon: '知',
  platformAccountLabel: '知乎ID',
  authUrl: 'https://www.zhihu.com/signin?next=https%3A%2F%2Fwww.zhihu.com%2Fcreator',
  publishUrl: 'https://www.zhihu.com/creator',
  homeUrl: 'https://www.zhihu.com/creator',
  contentTypes: ['article', 'video', 'image'],
  capabilities: {
    publishVideo: false, // TODO: 待实现
    publishImage: false, // TODO: 待实现
    publishArticle: false, // TODO: 待实现
  } as AccountCapabilities,
  contentLimits: {
    title: 100,
    content: 50000,
  },
  articleLimits: {
    title: 100,
  },
  nicknameSelectors: [
    '.AppHeader-profile .Popover div',
    '.AppHeader-userInfo .UserLink-link',
    '.CreatorHomeProfile-name',
    'a.UserLink-link',
    '.ProfileHeader-name',
    'meta[itemprop="name"]',
  ],
  avatarSelectors: [
    '.AppHeader-profile img.Avatar',
    '.AppHeader-userInfo img.Avatar',
    '.CreatorHomeProfile-avatar img',
    'img.Avatar',
  ],
  loginKeywords: ['创作者中心', '私信', '退出', '写回答', '写文章', '想法'],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：知乎登录后必有 z_c0 cookie
    const cookies = await win.webContents.session.cookies.get({});
    const zc0 = cookies.find((c) => c.name === 'z_c0' && c.value);
    const d_c0 = cookies.find((c) => c.name === 'd_c0' && c.value);

    const matchedKeywords: string[] = [];
    if (zc0) matchedKeywords.push('z_c0-cookie');
    if (d_c0) matchedKeywords.push('d_c0-cookie');

    // 2. 在登录页肯定未登录
    const isLoginPage = currentUrl.includes('/signin') || currentUrl.includes('/login');

    // 3. DOM 辅助检测：检查是否存在已登录用户的头像/下拉菜单
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 知乎已登录标志：头像区域、AppHeader 中的用户菜单
            var profileEl = document.querySelector('.AppHeader-profile') ||
                           document.querySelector('.AppHeader-userInfo') ||
                           document.querySelector('.CreatorHomeProfile-name') ||
                           document.querySelector('a.UserLink-link');
            // 检查是否存在退出登录按钮
            var hasLogout = document.body.innerText.indexOf('退出') !== -1;
            return !!(profileEl || hasLogout);
          } catch(e) {
            return false;
          }
        })()
      `);
      if (domLoggedIn) matchedKeywords.push('dom-profile');
    } catch {
      // ignore
    }

    const loggedIn = !!zc0 && !isLoginPage;

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
    // 通过知乎 API 获取当前用户信息（最可靠）
    // 使用 async IIFE 确保 Promise 被正确 await
    let apiInfo: any = null;
    try {
      apiInfo = await win.webContents.executeJavaScript(`
        (async function() {
          try {
            var resp = await fetch('https://www.zhihu.com/api/v4/me?include=is_realname', {
              credentials: 'include',
              headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) return null;
            var data = await resp.json();
            return data;
          } catch(e) {
            return null;
          }
        })()
      `);
    } catch (e) {
      log('warn', 'extractPageInfo', 'API fetch failed: ' + (e as Error).message);
    }

    // 如果 API 成功获取到信息，直接使用
    if (apiInfo && apiInfo.name) {
      log('info', 'extractPageInfo', `API 获取成功: name="${apiInfo.name}", uid="${apiInfo.uid}", url_token="${apiInfo.url_token}"`);
      return {
        nickname: apiInfo.name || '',
        avatar: apiInfo.avatar_url || '',
        platformAccountId: apiInfo.url_token || apiInfo.uid || '',
        userId: apiInfo.uid || '',
        fansCount: typeof apiInfo.follower_count === 'number' ? apiInfo.follower_count : 0,
        followCount: typeof apiInfo.following_count === 'number' ? apiInfo.following_count : 0,
        likeCount: typeof apiInfo.voteup_count === 'number' ? apiInfo.voteup_count : 0,
      };
    }

    // API 失败时从 DOM 提取兜底
    log('info', 'extractPageInfo', 'API 未返回数据，尝试 DOM 提取');
    const domInfo = await win.webContents.executeJavaScript(`
      (function() {
        try {
          var nickname = '';
          var avatar = '';
          var platformAccountId = '';

          // 尝试多种选择器获取昵称（创作者中心页面结构）
          var nameSelectors = [
            // 创作者中心特有
            '.CreatorHomeProfile-name',
            '.creator-profile-name',
            '.profile-card .name',
            '.user-card .name',
            // 通用知乎页面
            '.AppHeader-profile .Popover div',
            '.AppHeader-userInfo .UserLink-link',
            'a.UserLink-link',
            '.ProfileHeader-name',
            // 全局搜索：包含用户名的元素
            '[class*="Profile-name"]',
            '[class*="userName"]',
            '[class*="nickname"]',
          ];
          for (var i = 0; i < nameSelectors.length; i++) {
            var el = document.querySelector(nameSelectors[i]);
            if (el && el.textContent) {
              var text = el.textContent.trim();
              if (text && text.length < 50 && text !== '知乎' && text !== '创作者中心') {
                nickname = text;
                break;
              }
            }
          }

          // 尝试获取头像
          var avatarSelectors = [
            '.CreatorHomeProfile-avatar img',
            '.AppHeader-profile img.Avatar',
            '.AppHeader-userInfo img.Avatar',
            '[class*="Profile"] img[src*="zhimg.com"]',
            'img[src*="zhimg.com/v2-"]',
            'img.Avatar',
          ];
          for (var j = 0; j < avatarSelectors.length; j++) {
            var img = document.querySelector(avatarSelectors[j]);
            if (img && img.src && img.src.indexOf('data:') !== 0 && img.src.indexOf('zhimg.com') !== -1) {
              avatar = img.src;
              break;
            }
          }

          // 尝试从页面链接获取用户 ID
          var links = document.querySelectorAll('a[href*="/people/"], a[href*="/org/"]');
          for (var k = 0; k < links.length; k++) {
            var href = links[k].getAttribute('href') || '';
            var match = href.match(/\/(people|org)\/([^\/\?#]+)/);
            if (match && match[2] && match[2].length > 1) {
              platformAccountId = match[2];
              break;
            }
          }

          return { nickname: nickname, avatar: avatar, platformAccountId: platformAccountId };
        } catch(e) {
          return { nickname: '', avatar: '', platformAccountId: '' };
        }
      })()
    `);

    return {
      nickname: domInfo.nickname || '',
      avatar: domInfo.avatar || '',
      platformAccountId: domInfo.platformAccountId || '',
      fansCount: 0,
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
  return makeFailedResult(accountId, 'zhihu', '知乎发布功能正在开发中，暂不支持');
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

log('info', 'register', '知乎平台适配器已注册（骨架版本，发布功能待实现）');
