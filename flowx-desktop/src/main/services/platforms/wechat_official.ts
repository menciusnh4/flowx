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
 * 微信公众号平台适配器
 *
 * 平台信息：
 *   - 公众平台后台：https://mp.weixin.qq.com
 *   - 登录页：https://mp.weixin.qq.com
 *   - 登录态标识：cookie `ticket_id` / `data_bizuin` / `bizuin` 等
 *   - 发布入口：图文消息编辑（需要管理员扫码确认发布）
 *
 * 说明：
 *   - 微信公众号发布需要管理员扫码确认，暂不支持自动发布
 *   - 本适配器仅实现账号管理（登录检测、账号信息提取）
 */

const log = makePublishLogger({ platform: 'wechat_official' });

const BASE_URL = 'https://mp.weixin.qq.com';

const meta: PlatformMeta = {
  key: 'wechat_official',
  name: '微信公众号',
  icon: '📢',
  platformAccountLabel: '公众号ID',
  authUrl: BASE_URL,
  homeUrl: BASE_URL,
  publishUrl: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=0&token=',
  contentTypes: ['article'],
  capabilities: {
    publishVideo: false,
    publishImage: false,
    publishArticle: false, // 需要管理员扫码，暂不支持自动发布
  } as AccountCapabilities,
  contentLimits: {
    title: 64,
    content: 20000,
  },
  articleLimits: {
    title: 64,
  },
  nicknameSelectors: [
    '.weui-desktop_name',
    '.weui-desktop-account__nickname',
    '[class*="desktop_name"]',
    '[class*="nickname"]',
  ],
  avatarSelectors: [
    '.weui-desktop-account__img',
    '.weui-desktop-person_info img',
    'img[src*="wx.qlogo.cn"]',
    '[class*="avatar"] img',
  ],
  loginKeywords: ['首页', '图文素材', '已发送', '用户管理', '功能', '设置', '退出'],
};

// ========================= 登录检测 =========================

/**
 * 登录态检测：
 * 1. 优先通过 cookie 判断（可读取 httpOnly cookie，隐藏窗口下也有效）
 * 2. DOM 辅助检测（页面完全加载时更准确）
 *
 * 微信公众号登录态 cookie 说明：
 *   - data_bizuin: 公众号业务标识（登录后必有）
 *   - bizuin: 业务唯一标识（登录后必有）
 *   - slave_user: 从账号用户信息（登录后必有）
 *   - data_ticket: 数据票据（登录后常有）
 *   - mm_lang: 语言设置（登录后设置）
 *   - ticket_id: 登录票据（部分登录流程可能不存在，不作为必要条件）
 */
async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 第一步：通过 cookie 判断登录态
    const sess = win.webContents.session;
    const cookies = await sess.cookies.get({ domain: '.weixin.qq.com' });

    // 微信公众号登录态相关 cookie
    const loginCookieNames = [
      'data_bizuin',       // 公众号业务标识（登录后必有）
      'bizuin',            // 业务唯一标识（登录后必有）
      'slave_user',        // 从账号用户（登录后必有）
      'data_ticket',       // 数据票据
      'mm_lang',           // 语言设置
      'ticket_id',         // 登录票据（部分场景可能不存在）
      'uuid',              // 设备唯一标识
      'rand_info',         // 随机信息
    ];
    const matchedCookieNames: string[] = [];

    for (const name of loginCookieNames) {
      const cookie = cookies.find((c) => c.name === name && c.value && c.value.trim());
      if (cookie) {
        matchedCookieNames.push(`${name}-cookie`);
      }
    }

    // 核心登录态 cookie 检测：data_bizuin + bizuin + slave_user 三者中至少两个存在
    const hasDataBizuin = cookies.some((c) => c.name === 'data_bizuin' && c.value && c.value.trim());
    const hasBizuin = cookies.some((c) => c.name === 'bizuin' && c.value && c.value.trim());
    const hasSlaveUser = cookies.some((c) => c.name === 'slave_user' && c.value && c.value.trim());
    const hasDataTicket = cookies.some((c) => c.name === 'data_ticket' && c.value && c.value.trim());
    const hasTicketId = cookies.some((c) => c.name === 'ticket_id' && c.value && c.value.trim());

    // cookie 登录条件：满足以下任一即可
    //   1. data_bizuin + bizuin 同时存在（最可靠的登录标识）
    //   2. data_bizuin + slave_user 同时存在
    //   3. ticket_id + bizuin/data_bizuin 同时存在（票据模式）
    const coreCookieCount = [hasDataBizuin, hasBizuin, hasSlaveUser].filter(Boolean).length;
    const cookieLoggedIn =
      (hasDataBizuin && hasBizuin) ||
      (hasDataBizuin && hasSlaveUser) ||
      (hasTicketId && (hasBizuin || hasDataBizuin)) ||
      (coreCookieCount >= 2 && hasDataTicket);

    // 第二步：检测是否在登录页
    // 注意：URL 包含 token= 或已进入 home/appmsg 等页面，说明已登录，不是登录页
    const isLoginPage =
      currentUrl.includes('/cgi-bin/loginpage') ||
      currentUrl.includes('/cgi-bin/readtemplate?t=page/login') ||
      (currentUrl.indexOf('mp.weixin.qq.com') !== -1 &&
        !currentUrl.includes('token=') &&
        !currentUrl.includes('/cgi-bin/home') &&
        !currentUrl.includes('/cgi-bin/appmsg') &&
        !currentUrl.includes('/cgi-bin/user_tag') &&
        !currentUrl.includes('/cgi-bin/masssend') &&
        !currentUrl.includes('/cgi-bin/settingpage') &&
        currentUrl !== BASE_URL + '/' &&
        currentUrl !== BASE_URL);

    // 强登录态判定：核心 cookie 充足时，即使页面被重定向到登录页也认为已登录
    // （微信公众号直接访问后台页面会被重定向到登录页，但 cookies 仍然有效）
    const strongCookieLogin =
      coreCookieCount >= 3 ||
      (coreCookieCount >= 2 && hasDataTicket) ||
      (hasDataBizuin && hasBizuin && hasDataTicket);

    // 第三步：DOM 辅助检测
    let domLoggedIn = false;
    const matchedKeywords: string[] = [...matchedCookieNames];

    try {
      const info = await win.webContents.executeJavaScript(
        buildDetectLoggedInScript(meta.loginKeywords || [])
      );
      if (info) {
        domLoggedIn = !!info.domLoggedIn;
        if (info.matched && info.matched.length > 0) {
          matchedKeywords.push(...info.matched);
        }
      }
    } catch {
      // DOM 检测失败不影响 cookie 检测结果
    }

    // 最终登录判定：
    //   1. 强 cookie 登录态 → 直接判定为已登录（忽略页面是否是登录页）
    //   2. 普通情况 → cookie 或 DOM 任一通过 且 不在登录页
    const loggedIn = strongCookieLogin || ((cookieLoggedIn || domLoggedIn) && !isLoginPage);

    log('info', 'detectLoggedIn', `loggedIn=${loggedIn}, strongCookieLogin=${strongCookieLogin}, cookieLoggedIn=${cookieLoggedIn}, domLoggedIn=${domLoggedIn}, isLoginPage=${isLoginPage}, coreCookieCount=${coreCookieCount}`);

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

function buildDetectLoggedInScript(loginKeywords: string[]): string {
  const kwJSON = JSON.stringify(loginKeywords);
  return `
    (function() {
      var url = (location.href || "").toLowerCase();
      var bodyText = "";
      try { bodyText = (document.body ? (document.body.innerText || document.body.textContent || "") : "") || ""; } catch(e) {}

      var kws = ${kwJSON};
      var matched = [];
      for (var i = 0; i < kws.length; i++) {
        if (bodyText.indexOf(kws[i]) !== -1) matched.push(kws[i]);
      }

      // 检测是否存在公众号账号信息区域
      var hasAccountInfo = !!document.querySelector('.weui-desktop_name') ||
                          !!document.querySelector('.weui-desktop-person_info') ||
                          !!document.querySelector('.weui-desktop-account__nickname') ||
                          !!document.querySelector('[class*="desktop_name"]');

      // 检测是否存在退出按钮
      var hasLogout = bodyText.indexOf('退出') !== -1 && bodyText.indexOf('设置') !== -1;

      var isLoginPage = url.indexOf('loginpage') !== -1 ||
                       (url.indexOf('mp.weixin.qq.com') !== -1 &&
                        url.indexOf('token=') === -1 &&
                        url.indexOf('home') === -1 &&
                        url.indexOf('appmsg') === -1);

      var domLoggedIn = !isLoginPage && (hasAccountInfo || hasLogout || matched.length >= 2);

      return {
        domLoggedIn: domLoggedIn,
        matched: matched,
        title: document.title,
        url: url,
        hasAccountInfo: hasAccountInfo,
      };
    })()
  `;
}

// ========================= 提取账号信息 =========================

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    const domInfo = await win.webContents.executeJavaScript(buildExtractPageInfoScript());

    // 从 cookie 中获取公众号ID（slave_user 字段）
    let platformAccountId = domInfo?.platformAccountId || '';
    try {
      const cookies = await win.webContents.session.cookies.get({ domain: '.weixin.qq.com' });
      const slaveUserCookie = cookies.find((c) => c.name === 'slave_user' && c.value && c.value.trim());
      if (slaveUserCookie && slaveUserCookie.value) {
        // slave_user 格式可能是 o_xxx@offiaccount 或类似，取 @ 前面的部分或整体
        const slaveValue = slaveUserCookie.value.trim();
        if (slaveValue && !platformAccountId) {
          platformAccountId = slaveValue.split('@')[0] || slaveValue;
        }
      }
    } catch {
      // 忽略 cookie 读取错误
    }

    if (domInfo && domInfo.nickname) {
      log('info', 'extractPageInfo', `DOM 提取成功: nickname="${domInfo.nickname}", platformAccountId="${platformAccountId || ''}", fansCount=${domInfo.fansCount ?? '-'}`);
    }

    return {
      nickname: domInfo?.nickname || '',
      avatar: domInfo?.avatar || '',
      platformAccountId,
      userId: domInfo?.userId || '',
      fansCount: typeof domInfo?.fansCount === 'number' ? domInfo.fansCount : 0,
      followCount: typeof domInfo?.followCount === 'number' ? domInfo.followCount : 0,
      likeCount: typeof domInfo?.likeCount === 'number' ? domInfo.likeCount : 0,
    };
  } catch (e) {
    log('error', 'extractPageInfo', (e as Error).message);
    return { nickname: '' };
  }
}

function buildExtractPageInfoScript(): string {
  return `
    (function() {
      var r = {
        nickname: '',
        avatar: '',
        platformAccountId: '',
        userId: '',
        fansCount: null,
        followCount: null,
        likeCount: null,
      };

      try {
        // 1. 提取昵称（公众号后台左侧个人信息区域）
        // 优先匹配 .weui-desktop_name（个人信息卡片中的名称）
        var nickSelectors = [
          '.weui-desktop_name',
          '.weui-desktop-account__nickname',
          '.account_nickname',
          '.header .nickname',
          '[class*="account__nickname"]',
          '[class*="desktop_name"]',
        ];
        for (var i = 0; i < nickSelectors.length; i++) {
          var el = document.querySelector(nickSelectors[i]);
          if (el && el.textContent && el.textContent.trim()) {
            var text = el.textContent.trim();
            if (text && text.length < 50 && text !== '微信公众平台') {
              r.nickname = text;
              break;
            }
          }
        }

        // 2. 提取头像
        // 优先匹配 .weui-desktop-account__img（个人信息卡片中的头像）
        var avatarSelectors = [
          '.weui-desktop-account__img',
          '.weui-desktop-person_info img',
          '.weui-desktop-account__avatar img',
          'img[src*="wx.qlogo.cn"]',
          'img[src*="mmbiz.qpic.cn"]',
          '[class*="avatar"] img',
        ];
        for (var j = 0; j < avatarSelectors.length; j++) {
          var img = document.querySelector(avatarSelectors[j]);
          if (img && img.src && img.src.indexOf('data:') !== 0) {
            r.avatar = img.src;
            break;
          }
        }

        // 3. 从 URL 中提取 token 作为 userId
        var url = location.href || '';
        var tokenMatch = url.match(/token=([0-9]+)/);
        if (tokenMatch && tokenMatch[1]) {
          r.userId = tokenMatch[1];
        }

        // 4. 提取粉丝数（总用户数）
        // 结构：.weui-desktop-user_num > .weui-desktop-user_sum > span
        var fanSelectors = [
          '.weui-desktop-user_num .weui-desktop-user_sum span',
          '.weui-desktop-user_num .weui-desktop-user_sum',
          '.weui-desktop-user_sum span',
          '[class*="user_num"] [class*="user_sum"] span',
        ];
        for (var m = 0; m < fanSelectors.length; m++) {
          var fanEl = document.querySelector(fanSelectors[m]);
          if (fanEl && fanEl.textContent) {
            var fanText = fanEl.textContent.replace(/[^0-9]/g, '');
            if (fanText && fanText.length > 0) {
              var fanNum = parseInt(fanText, 10);
              if (!isNaN(fanNum) && fanNum >= 0) {
                r.fansCount = fanNum;
                break;
              }
            }
          }
        }

        // 5. 兜底：从 document.title 中提取昵称
        if (!r.nickname) {
          var title = document.title || '';
          if (title && title.indexOf('微信公众平台') === -1 && title.length < 50) {
            r.nickname = title;
          }
        }

        if (!r.nickname) {
          r.nickname = '微信公众号';
        }
      } catch(e) {
        console.error('[extractPageInfo] error:', e);
      }

      return r;
    })()
  `;
}

// ========================= 发布功能（暂不支持）=========================

async function publish(
  accountId: string,
  _request: PublishRequest,
  _onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return makeFailedResult(
    accountId,
    'wechat_official',
    '微信公众号发布需要管理员扫码确认，暂不支持自动发布'
  );
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

log('info', 'register', '微信公众号平台适配器已注册（仅账号管理，发布功能需管理员扫码）');
