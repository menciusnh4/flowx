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
 * 微博平台适配器
 *
 * 平台信息：
 *   - 创作中心：https://me.weibo.com/
 *   - 登录页：自动跳转（未登录访问 me.weibo.com 会跳到 weibo.com/login.php 登录页）
 *   - 登录态标识：cookie `SUB` 存在且非空即为已登录（微博核心登录 cookie）
 *   - 发布页：https://me.weibo.com/ (创作中心首页即可发布微博)
 *
 * 当前接入范围：账号管理（登录态检测 + 账号信息提取）
 * TODO 待实现：
 *   - publishVideo / publishImage / publishArticle: 发布功能
 */

const log = makePublishLogger({ platform: 'weibo' });

const meta: PlatformMeta = {
  key: 'weibo',
  name: '微博',
  icon: 'W',
  platformAccountLabel: '微博号',
  // 创作中心地址，未登录时微博会自动跳转到登录页
  authUrl: 'https://me.weibo.com/',
  publishUrl: 'https://me.weibo.com/',
  homeUrl: 'https://me.weibo.com/',
  contentTypes: ['video', 'image', 'article'],
  capabilities: {
    publishVideo: false, // TODO: 待实现
    publishImage: false, // TODO: 待实现（图文/微博配图）
    publishArticle: false, // TODO: 待实现（头条文章）
  } as AccountCapabilities,
  contentLimits: {
    title: 0, // 普通微博无独立标题
    content: 2000, // 普通微博最多 2000 字
  },
  articleLimits: {
    title: 100, // 头条文章标题
    content: 100000, // 头条文章正文
  },
  nicknameSelectors: [
    // 【路径 A：创作中心 me.weibo.com】新版头像旁昵称容器（用户确认过的 DOM）
    'div[class*="_name_"]',
    '._name_v0oim_18',
    // 【路径 B：登录后 weibo.com 首页】个人 tab 的 title/aria-label（属性会在提取脚本中兜底读取，不在此 querySelector）
    // 创作中心 / 公开中心兼容老版
    '.user-info .name',
    '.username',
    '.nick-name',
    '.screen-name',
    '[class*="user-name"]',
    '[class*="nickname"]',
    '[class*="screen-name"]',
    '.header .name',
    '.topbar-user .name',
    '.WD_header_name',
    '.nameBox .name',
    '.nameBox .userName',
  ],
  avatarSelectors: [
    // 【创作中心】新版 woo-avatar 组件（用户确认的 DOM：<img class="woo-avatar-img">）
    'img.woo-avatar-img',
    // 【登录后 weibo.com 首页】个人 tab 内嵌头像 <img class="_icon_1z046_35 _avatar_1z046_57">
    'img[class*="_avatar_"]',
    // 老版通用
    'img[class*="avatar"]',
    'img[class*="head"]',
    'a[href*="weibo.com/u/"] img',
    'a[href*="weibo.com/p/"] img',
    '.avatar img',
    'a.avatar img',
    '.user-info img',
    'img.avatar',
    '.header img',
    '.topbar-user img',
    '.account-info img',
    '.user-card img',
    '.head_pic img',
    '.W_face_radius img',
    'img.head_pic',
  ],
  loginKeywords: ['创作中心', '内容管理', '数据中心', '粉丝', '发微博', '发布', '收益管理', '退出登录', '我的主页'],
};

// ========================= 登录检测 =========================

/**
 * 结构级登录判定脚本（在页面 DOM 中执行）。
 * 目标：用「用户确认过的真实 DOM 结构」替代脆弱的 bodyText 关键词匹配。
 * 微博有两套常见登录后页面：
 *   A. 登录后 weibo.com 公开首页：顶栏 woo-tab-nav 中最后一个 a._alink_* 的 href="/u/{UID}" +
 *      title/aria-label = 昵称 + 子 img._avatar_*（用户自己的头像）
 *   B. me.weibo.com 创作中心：左侧/顶栏 woo-avatar 组件 = img.woo-avatar-img（src 以 // 开头）
 *      + 旁边的 div._name_*（昵称）
 *
 * 另外，访客态的结构判定：页面有指向 passport/login/sso 的「登录/注册」按钮，
 *                          且 没有结构A 且 没有结构B。
 */
const PROBE_DOM_LOGIN_SCRIPT = `
(function() {
  var r = {
    // 结构 A：登录后 weibo.com 公开首页（个人 tab）
    personalTab: { ok: false, href: '', title: '', ariaLabel: '', avatarSrc: '' },
    // 结构 B：me.weibo.com 创作中心（woo-avatar + 昵称）
    creatorAvatar: { ok: false, avatarSrc: '', nickname: '' },
    // 结构 V：访客态（有登录入口，没有登录后结构）
    visitorSign: false,
    // 兼容老版：页面上出现「退出登录」按钮
    hasLogoutButton: false,
    // 调试：URL 路径
    host: location.hostname,
    path: location.pathname,
  };
  try {
    // ------------- 结构 A：woo-tab-nav 里的个人 tab（登录后公开首页）-------------
    // 选择所有 a._alink_*（首页顶栏 5 个 tab 的容器），找 href="/u/数字" 的那个
    try {
      var links = document.querySelectorAll('a[href^="/u/"][class*="_alink_"]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.getAttribute('href') || '';
        if (!/^\\/u\\/[0-9]{5,12}$/.test(href)) continue;
        // 看它子节点有没有带 _avatar_* class 的 img（登录后首页个人 tab 的头像）
        var imgEl = a.querySelector('img');
        var hasAvatarCls = !!(imgEl && (imgEl.className || '').indexOf('_avatar_') !== -1);
        var title = (a.getAttribute('title') || '').trim();
        var aria = (a.getAttribute('aria-label') || '').trim();
        var src = imgEl ? (imgEl.src || imgEl.getAttribute('src') || '') : '';
        if ((title || aria || hasAvatarCls)) {
          r.personalTab.ok = true;
          r.personalTab.href = href;
          r.personalTab.title = title;
          r.personalTab.ariaLabel = aria;
          r.personalTab.avatarSrc = src;
          break;
        }
      }
    } catch(_e1) { /* ignore */ }

    // ------------- 结构 B：创作中心 woo-avatar + 昵称 -------------
    try {
      // 用户确认：<img class="woo-avatar-img"> 旁边 <div class="_name_v0oim_18">昵称</div>
      var avatarImg = document.querySelector('img.woo-avatar-img');
      var nameEl = document.querySelector('div[class*="_name_"]');
      var nickname = (nameEl && (nameEl.innerText || nameEl.textContent || '') || '').trim();
      var aSrc = avatarImg ? (avatarImg.src || avatarImg.getAttribute('src') || '') : '';
      if ((avatarImg && aSrc) || nickname) {
        r.creatorAvatar.ok = !!(avatarImg && aSrc) || !!nickname;
        r.creatorAvatar.avatarSrc = aSrc;
        r.creatorAvatar.nickname = nickname;
      }
    } catch(_e2) { /* ignore */ }

    // ------------- 结构 V：访客态（有登录/注册按钮，指向 passport/login/sso）-------------
    try {
      var btns = document.querySelectorAll('a[href], button');
      var hasLoginEntry = false;
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        var txt = ((b.innerText || b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')).trim();
        if (!txt) continue;
        if (txt.indexOf('登录') === -1 && txt.indexOf('注册') === -1) continue;
        // <a href="*passport*" / *login* / *sso.weibo.com* /> 结构判定为真访客登录入口
        var h = b.tagName === 'A' ? (b.getAttribute('href') || '') : '';
        if (h && (/passport\\.weibo\\.com|login|sso\\.weibo\\.com|signin/i.test(h))) {
          hasLoginEntry = true;
          break;
        }
      }
      r.visitorSign = hasLoginEntry && !r.personalTab.ok && !r.creatorAvatar.ok;
    } catch(_e3) { /* ignore */ }

    // ------------- 老版兼容：是否存在「退出登录」按钮 -------------
    try {
      var bodyText = (document.body && (document.body.innerText || '')) || '';
      r.hasLogoutButton = bodyText.indexOf('退出登录') !== -1;
    } catch(_e4) { /* ignore */ }
  } catch(_e) {}
  return r;
})();`;

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. Cookie 扫描（仅记录，不再单独作为登录判定依据——访客态 SUB 残留会误判）
    const cookies = await win.webContents.session.cookies.get({});
    const subCookie = cookies.find((c) => c.name === 'SUB' && c.value);
    const subP = cookies.find((c) => c.name === 'SUBP' && c.value);
    const wbSess = cookies.find((c) => c.name === 'WEIBOCN_WM' || c.name === '_2AAM');

    const matchedKeywords: string[] = [];
    if (subCookie) matchedKeywords.push('SUB-cookie');
    if (subP) matchedKeywords.push('SUBP-cookie');
    if (wbSess) matchedKeywords.push('WEIBO-session-cookie');

    // 2. 绝对未登录：登录域 / 登录路径
    const isLoginPage = currentUrl.includes('/login') ||
                        currentUrl.includes('/signin') ||
                        currentUrl.includes('passport.weibo.com') ||
                        currentUrl.includes('sso.weibo.com');
    if (isLoginPage) matchedKeywords.push('is-login-page');

    // 3. 结构级探测
    let struct: any = {};
    try {
      struct = await win.webContents.executeJavaScript(PROBE_DOM_LOGIN_SCRIPT);
    } catch {
      struct = {};
    }
    const personalTab: any = struct.personalTab || {};
    const creatorAvatar: any = struct.creatorAvatar || {};
    const visitorSign = !!struct.visitorSign;
    const hasLogoutButton = !!struct.hasLogoutButton;

    if (personalTab && personalTab.ok) {
      matchedKeywords.push('struct-personalTabOK');
      if (personalTab.title) matchedKeywords.push('pt-title:' + personalTab.title.slice(0, 12));
    }
    if (creatorAvatar && creatorAvatar.ok) matchedKeywords.push('struct-creatorAvatarOK');
    if (visitorSign) matchedKeywords.push('struct-visitorSign');
    if (hasLogoutButton) matchedKeywords.push('struct-logoutBtn');

    // 4. inBackend：在 me.weibo.com / weibo.com/u/xxx / weibo.com/p/xxx 且不在登录页
    const inBackend = (currentUrl.includes('me.weibo.com') ||
                       currentUrl.includes('weibo.com/u/') ||
                       currentUrl.includes('weibo.com/p/')) &&
                      !isLoginPage &&
                      !visitorSign;
    if (inBackend) matchedKeywords.push('in-weibo-backend');

    // 5. 老版 dom 辅助（仅当结构没有判断时兜底，避免漏网之鱼）
    let domLoggedIn = false;
    if (!personalTab.ok && !creatorAvatar.ok && !visitorSign && !isLoginPage) {
      try {
        domLoggedIn = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var bodyText = (document.body && (document.body.innerText || '')) || '';
              var hasLogout = bodyText.indexOf('退出登录') !== -1;
              var hasSidebar = bodyText.indexOf('内容管理') !== -1 ||
                               bodyText.indexOf('数据中心') !== -1 ||
                               bodyText.indexOf('创作中心') !== -1 ||
                               bodyText.indexOf('发微博') !== -1 ||
                               bodyText.indexOf('我的主页') !== -1;
              return !!(hasLogout && (hasSidebar || true)); // 有「退出登录」就当已登录兜底
            } catch(e) { return false; }
          })();
        `);
        if (domLoggedIn) matchedKeywords.push('dom-fallback');
      } catch { /* ignore */ }
    }

    // ========== 核心登录判定（结构驱动，SUB 仅为辅助） ==========
    //   - 结构 A 或 结构 B 命中 → 一定已登录（这两个结构只有登录后才会渲染）
    //   - 否则，需要：SUB cookie 存在 AND 不在登录页 AND 不是访客态 AND (inBackend OR domLoggedIn OR hasLogoutButton)
    //   - 访客态(struct-visitorSign=true) 直接判 false，哪怕 SUB 残留
    const strongStructLoggedIn = !!(personalTab && personalTab.ok) || !!(creatorAvatar && creatorAvatar.ok);
    const softLoggedIn = !!subCookie &&
                         !isLoginPage &&
                         !visitorSign &&
                         (inBackend || domLoggedIn || hasLogoutButton);

    const loggedIn = strongStructLoggedIn || softLoggedIn;

    return {
      loggedIn,
      url: currentUrl,
      title: win.webContents.getTitle(),
      matchedKeywords,
      // 附加字段：把 probe 结果塞给上层（仅用于诊断），不影响类型
    } as any;
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

/** 微博自有域名白名单：命中这些 host 的 http:// 链接需要强制升级为 https:// */
const WEIBO_FORCE_HTTPS_DOMAINS = [
  'weibo.com',
  'weibo.cn',
  'sinaimg.cn',
  'sina.com.cn',
  'weibocdn.com',
  'h5.sinaimg.cn',
  'ss1.bdstatic.com',
  'ss2.bdstatic.com',
  'ss3.bdstatic.com',
];

/** 判断 host（已 lowercase 后）是否属于微博自有域名 */
function _isWeiboDomain(host: string): boolean {
  const h = host.toLowerCase();
  for (const d of WEIBO_FORCE_HTTPS_DOMAINS) {
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

/** 类引号字符黑名单（逐字符剔除）——与 bilibili 保持一致 */
const QUOTE_LIKE_CHARCODES = new Set<number>([
  0x0027, // ' APOSTROPHE
  0x0022, // " QUOTATION MARK
  0x0060, // ` GRAVE ACCENT
  0x00b4, // ´ ACUTE ACCENT
  0x005c, // \ REVERSE SOLIDUS
  0x2018, // ‘ LEFT SINGLE QUOTATION MARK
  0x2019, // ’ RIGHT SINGLE QUOTATION MARK
  0x201c, // “ LEFT DOUBLE QUOTATION MARK
  0x201d, // ” RIGHT DOUBLE QUOTATION MARK
  0x2039, // ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  0x203a, // › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  0x00ab, // « LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x00bb, // » RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x02cb, // ˋ MODIFIER LETTER GRAVE ACCENT
  0x02ca, // ˊ MODIFIER LETTER ACUTE ACCENT
  0x0300, //  ̀ COMBINING GRAVE ACCENT
  0x0301, //  ́ COMBINING ACUTE ACCENT
  0xff07, // ＇ FULLWIDTH APOSTROPHE
  0xff02, // ＂ FULLWIDTH QUOTATION MARK
  0xff40, // ｀ FULLWIDTH GRAVE ACCENT
  0x300c, // 「 LEFT CORNER BRACKET
  0x300d, // 」 RIGHT CORNER BRACKET
  0x300e, // 『 LEFT WHITE CORNER BRACKET
  0x300f, // 』 RIGHT WHITE CORNER BRACKET
  0x201a, // ‚ SINGLE LOW-9 QUOTATION MARK
  0x201e, // „ DOUBLE LOW-9 QUOTATION MARK
  0x201b, // ‛ SINGLE HIGH-REVERSED-9 QUOTATION MARK
  0x201f, // ‟ DOUBLE HIGH-REVERSED-9 QUOTATION MARK
]);

/** 字符串净化（逐字符去"类引号字符"） */
function _cleanStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (QUOTE_LIKE_CHARCODES.has(c)) continue;
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
      out += ' ';
      continue;
    }
    out += s.charAt(i);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** URL 规范化最终步骤：从杂糅文本里提取真正的 URL */
function _normalizeUrl(u: unknown): string {
  const cleaned = _cleanStr(u);
  if (!cleaned) return '';
  if (cleaned.indexOf('data:') === 0) return '';
  if (cleaned.indexOf('1x1') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  if (cleaned.indexOf('transparent') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  let url = cleaned;
  // 协议相对路径 //xxx 补 https:
  if (url.indexOf('//') === 0) url = 'https:' + url;
  // 如果没有 http/https 前缀，尝试从正文里提取一个 URL
  if (url.indexOf('http:') !== 0 && url.indexOf('https:') !== 0) {
    const m = url.match(/https?:\/\/[^\s"'`<>【】《》（）()[\]{}，,。;；:：]+/i);
    if (m && m[0]) {
      url = m[0];
    }
  }
  url = _cleanStr(url);
  // 纯相对路径丢弃
  if (url.indexOf('/') === 0 && url.indexOf('//') !== 0) return '';
  // http(s) URL 规范化：微博自有域名 http → https
  if (url.indexOf('http:') === 0 || url.indexOf('https:') === 0) {
    try {
      const protoEnd = url.indexOf('//');
      if (protoEnd !== -1) {
        const afterProto = url.substring(protoEnd + 2);
        const hostEndIdx = afterProto.search(/[\/?#:]/);
        const host = (hostEndIdx === -1 ? afterProto : afterProto.substring(0, hostEndIdx)).toLowerCase();
        if (host && _isWeiboDomain(host) && url.indexOf('http:') === 0) {
          url = 'https:' + url.substring(5);
        }
      }
    } catch {
      // ignore
    }
    const m2 = url.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i);
    if (m2 && m2[0]) {
      url = m2[0];
    }
    return url;
  }
  return '';
}

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    const currentUrl = win.webContents.getURL();
    log('info', 'extractPageInfo', `开始提取微博账号信息，当前 URL: ${currentUrl}`);

    // ---------- 阶段 1：复用同一套结构级 PROBE，区分「登录后首页」和「创作中心」两套 DOM ----------
    let struct: any = {};
    try {
      struct = await win.webContents.executeJavaScript(PROBE_DOM_LOGIN_SCRIPT);
    } catch (e) {
      log('warn', 'extractPageInfo', `PROBE 脚本执行失败，降级通用 DOM 兜底: ${(e as Error).message}`);
    }
    const personalTab: any = struct.personalTab || { ok: false };
    const creatorAvatar: any = struct.creatorAvatar || { ok: false };
    log('info', 'extractPageInfo',
      `PROBE → personalTab.ok=${!!personalTab.ok}, ` +
      `creatorAvatar.ok=${!!creatorAvatar.ok}, ` +
      `visitorSign=${!!struct.visitorSign}, host=${struct.host || 'n/a'}, path=${struct.path || 'n/a'}`);

    // 分步提取，避免单个大脚本执行失败导致全部信息丢失
    let nickname = '';
    let avatar = '';
    let platformAccountId = '';
    let fansCount: number | null = null;
    let followCount: number | null = null;
    let likeCount: number | null = null;

    // ---------- 阶段 2：优先使用 PROBE 结果提取 ----------
    if (personalTab && personalTab.ok) {
      // 【路径 A：登录后 weibo.com 公开首页（个人 tab）】
      // 用户确认：a._alink_1z046_65 href="/u/8322677072" title="七初七都" aria-label="七初七都"
      //         img src="https://tvax3.sinaimg.cn/crop.xxx.jpg..." class="_icon_1z046_35 _avatar_1z046_57"
      nickname = _cleanStr(personalTab.title || personalTab.ariaLabel || '');
      avatar   = _normalizeUrl(personalTab.avatarSrc || '');
      const href = personalTab.href || ''; // "/u/{uid}"
      const uidFromHref = href.match(/\/u\/([0-9]{5,12})/);
      if (uidFromHref && uidFromHref[1]) {
        platformAccountId = uidFromHref[1];
      }
      log('info', 'extractPageInfo',
        `✔ 采用【登录后首页 · 个人 tab】: nickname="${nickname}", ` +
        `avatarLen=${avatar.length}, uid=${platformAccountId || '(n/a)'}`);
    } else if (creatorAvatar && creatorAvatar.ok) {
      // 【路径 B：me.weibo.com 创作中心】
      // 用户确认：<img class="woo-avatar-img" src="//tvax3.sinaimg.cn/crop.xxx.jpg">
      //         旁边 <div class="_name_v0oim_18">七初七都</div>
      nickname = _cleanStr(creatorAvatar.nickname || '');
      avatar   = _normalizeUrl(creatorAvatar.avatarSrc || '');
      log('info', 'extractPageInfo',
        `✔ 采用【创作中心 · woo-avatar】: nickname="${nickname}", avatarLen=${avatar.length}`);
    } else {
      log('warn', 'extractPageInfo', '⚠️ PROBE 未命中任何登录后结构，将走通用 DOM 兜底');
    }

    // ---------- 阶段 3：通用兜底 ----------
    // 3.1 UID / platformAccountId：URL + 页面中 a[href*="weibo.com/u/"] + 微博号文本匹配
    if (!platformAccountId) {
      const url = win.webContents.getURL();
      const uidMatch = url.match(/weibo\.com\/u\/([0-9]{5,12})/i) ||
                      url.match(/weibo\.com\/p\/[0-9.]+\/([0-9]{5,12})/i);
      if (uidMatch && uidMatch[1]) {
        platformAccountId = uidMatch[1];
        log('info', 'extractPageInfo', `从 URL 提取到 UID: ${platformAccountId}`);
      }
    }

    // 3.2 提取昵称 + 头像 + 微博号 + 粉丝/关注/获赞 数（通用 DOM 兜底）
    try {
      const domResult: any = await win.webContents.executeJavaScript(`
        (function() {
          try {
            function _parseNumber(s) {
              if (!s) return null;
              var t = String(s).replace(/\\s+/g, '').replace(/,/g, '');
              var base = parseFloat(t);
              if (isNaN(base)) return null;
              if (t.indexOf('万') !== -1) base *= 10000;
              else if (t.indexOf('千') !== -1) base *= 1000;
              else if (t.indexOf('百') !== -1) base *= 100;
              else if (t.indexOf('亿') !== -1) base *= 100000000;
              return Math.round(base);
            }
            var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };

            // ===== 昵称：按优先级尝试多个选择器（已包含新版：div[class*="_name_"] / ._name_v0oim_18）=====
            var nickSelectors = [
              'div[class*="_name_"]',
              '._name_v0oim_18',
              '.user-info .name',
              '.username',
              '.nick-name',
              '.screen-name',
              '[class*="user-name"]',
              '[class*="nickname"]',
              '[class*="screen-name"]',
              '.header .name',
              '.topbar-user .name',
              '.WD_header_name',
              '.nameBox .name',
              '.nameBox .userName',
              '.person_name',
              '.name',
              'h1',
            ];
            for (var ni = 0; ni < nickSelectors.length; ni++) {
              try {
                var el = document.querySelector(nickSelectors[ni]);
                if (el && (el.innerText || el.textContent || '').trim()) {
                  var txt = (el.innerText || el.textContent || '').trim().slice(0, 40);
                  if (txt && txt.length >= 1) {
                    r.nickname = txt;
                    break;
                  }
                }
              } catch(_) { /* ignore */ }
            }

            // ===== 头像：img 的 src（新版 img.woo-avatar-img / img[class*="_avatar_"] 排在最前）=====
            var avatarSelectors = [
              'img.woo-avatar-img',
              'img[class*="_avatar_"]',
              'img[class*="avatar"]',
              'img[class*="head"]',
              'a[href*="weibo.com/u/"] img',
              'a[href*="weibo.com/p/"] img',
              '.avatar img',
              'a.avatar img',
              '.user-info img',
              'img.avatar',
              '.header img',
              '.topbar-user img',
              '.account-info img',
              '.user-card img',
              '.head_pic img',
              '.W_face_radius img',
              'img.head_pic',
            ];
            for (var ai = 0; ai < avatarSelectors.length; ai++) {
              try {
                var img = document.querySelector(avatarSelectors[ai]);
                var src = img ? (img.src || img.getAttribute('src') || '') : '';
                if (src && (src.indexOf('http') === 0 || src.indexOf('//') === 0)) {
                  r.avatar = src;
                  break;
                }
              } catch(_) { /* ignore */ }
            }

            // ===== 平台账号 ID（微博号 / UID）=====
            //   1. a[href^="/u/"] 顶栏个人 tab（登录后首页就用 PROBE 取了，这里做页面内其他 a 兜底）
            var allUserLinks = document.querySelectorAll('a[href*="weibo.com/u/"], a[href^="/u/"]');
            for (var li = 0; li < allUserLinks.length; li++) {
              var href = allUserLinks[li].getAttribute('href') || '';
              var fullHref = (allUserLinks[li] as any).href || href;
              var lm = String(fullHref + ' ' + href).match(/weibo\\.com\\/u\\/([0-9]{5,12})/i) ||
                       href.match(/^\\/u\\/([0-9]{5,12})$/);
              if (lm && lm[1]) { r.platformAccountId = lm[1]; break; }
            }
            //   2. body 文本中「微博号：xxx」
            if (!r.platformAccountId) {
              var bodyText = document.body ? (document.body.innerText || '') : '';
              var accountM = bodyText.match(/(?:微博号|微博账号|微号)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/);
              if (accountM && accountM[1]) r.platformAccountId = accountM[1];
            }

            // ===== 粉丝/关注/获赞/微博数 =====
            function _setByLabel(labelText, numValue) {
              if (numValue === null || !labelText) return false;
              if ((/粉丝/.test(labelText)) && r.fansCount === null) { r.fansCount = numValue; return true; }
              if (/关注/.test(labelText) && r.followCount === null) { r.followCount = numValue; return true; }
              if ((/获赞|点赞|收藏|转评赞/.test(labelText)) && r.likeCount === null) { r.likeCount = numValue; return true; }
              return false;
            }
            var bodyText2 = document.body ? (document.body.innerText || '') : '';

            // 方式 A：全局搜索 class 含 number 或 count 或 num 的数字元素
            try {
              var allNumEls = document.querySelectorAll('[class*="number"], [class*="count"], [class*="num"], [class*="Count"], [class*="Num"]');
              for (var ai2 = 0; ai2 < allNumEls.length; ai2++) {
                var aEl = allNumEls[ai2];
                var aVal = _parseNumber(aEl.textContent || '');
                if (aVal === null) continue;
                var labelFound = false;
                var aParent = aEl.parentNode;
                if (aParent && aParent.children) {
                  for (var bi = 0; bi < aParent.children.length; bi++) {
                    var sib = aParent.children[bi];
                    if (sib === aEl) continue;
                    var lblTxt = (sib.textContent || '').trim();
                    if (lblTxt && lblTxt.length <= 12 && /(粉丝|关注|获赞|点赞|收藏)/.test(lblTxt)) {
                      if (_setByLabel(lblTxt, aVal)) { labelFound = true; break; }
                    }
                  }
                }
                if (labelFound) continue;
                if (aParent) {
                  var parentTxt = (aParent.textContent || '').replace(/\\d/g, ' ').trim();
                  if (parentTxt) _setByLabel(parentTxt, aVal);
                }
              }
            } catch(_) { /* ignore */ }

            // 方式 B：body 全文正则兜底（双向格式）
            if (r.fansCount === null) {
              var fm1 = bodyText2.match(/(粉丝|粉丝数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
              var fm2 = bodyText2.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(粉丝|粉丝数)/);
              if (fm1 && fm1[2]) r.fansCount = _parseNumber(fm1[2]);
              else if (fm2 && fm2[1]) r.fansCount = _parseNumber(fm2[1]);
            }
            if (r.followCount === null) {
              var fol1 = bodyText2.match(/(关注|关注数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
              var fol2 = bodyText2.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(关注|关注数)/);
              if (fol1 && fol1[2]) r.followCount = _parseNumber(fol1[2]);
              else if (fol2 && fol2[1]) r.followCount = _parseNumber(fol2[1]);
            }
            if (r.likeCount === null) {
              var lk1 = bodyText2.match(/(获赞|点赞|点赞数|转评赞)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
              var lk2 = bodyText2.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(获赞|点赞|点赞数|转评赞)/);
              if (lk1 && lk1[2]) r.likeCount = _parseNumber(lk1[2]);
              else if (lk2 && lk2[1]) r.likeCount = _parseNumber(lk2[1]);
            }

            return r;
          } catch(e) {
            return { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null, error: String(e && e.message || e) };
          }
        })()
      `);

      if (domResult) {
        if (!nickname && domResult.nickname) nickname = domResult.nickname;
        if (!avatar   && domResult.avatar)   avatar   = domResult.avatar;
        if (!platformAccountId && domResult.platformAccountId) platformAccountId = domResult.platformAccountId;
        if (fansCount === null && domResult.fansCount !== null && domResult.fansCount !== undefined) fansCount = domResult.fansCount;
        if (followCount === null && domResult.followCount !== null && domResult.followCount !== undefined) followCount = domResult.followCount;
        if (likeCount === null && domResult.likeCount !== null && domResult.likeCount !== undefined) likeCount = domResult.likeCount;
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '通用 DOM 兜底脚本执行失败: ' + (e as Error).message);
    }

    // ---------- 阶段 4：最终 GUARD 守卫，清洗字段 ----------
    const gNick = _cleanStr(nickname);
    const gAvatar = _normalizeUrl(avatar) || '';
    const gPid = _cleanStr(platformAccountId);

    // 诊断日志：如果头像疑似仍有异常字符
    if (gAvatar && (gAvatar.length < 10 || /[`"'´`'"]/.test(gAvatar) || !/^https?:\/\//i.test(gAvatar))) {
      const head: string[] = [];
      const tail: string[] = [];
      const headCount = Math.min(6, gAvatar.length);
      const tailCount = Math.min(6, gAvatar.length);
      for (let i = 0; i < headCount; i++) {
        const ch = gAvatar.charAt(i);
        head.push(`${ch}:U+${gAvatar.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
      }
      for (let i = Math.max(0, gAvatar.length - tailCount); i < gAvatar.length; i++) {
        const ch = gAvatar.charAt(i);
        tail.push(`${ch}:U+${gAvatar.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
      }
      log('warn', 'extractPageInfo', `[CHARCODE] guardAvatar 疑似仍有异常字符 → 前${headCount}个: [${head.join(' | ')}] | 后${tailCount}个: [${tail.join(' | ')}] | 完整值: "${gAvatar}"`);
    }

    const guardResult: ExtractedAccountInfo = {
      nickname: gNick,
      avatar: gAvatar,
      platformAccountId: gPid || undefined,
      userId: gPid || undefined,
      fansCount: fansCount ?? undefined,
      followCount: followCount ?? undefined,
      likeCount: likeCount ?? undefined,
    };
    const finalAvatar = guardResult.avatar || '';
    log('info', 'extractPageInfo',
      `FINAL RETURN → ` +
      `scenario=${(personalTab.ok ? 'homepage-personalTab' : (creatorAvatar.ok ? 'creator-center' : 'generic-fallback'))}, ` +
      `avatar.len=${finalAvatar.length}, avatar="${finalAvatar.substring(0, 160)}", ` +
      `nickname="${guardResult.nickname}", platformAccountId="${guardResult.platformAccountId || ''}", ` +
      `fans=${guardResult.fansCount ?? 'n/a'}, follow=${guardResult.followCount ?? 'n/a'}, like=${guardResult.likeCount ?? 'n/a'}`);
    return guardResult;
  } catch (e) {
    log('error', 'extractPageInfo', (e as Error).message);
    return { nickname: '' };
  }
}

// ========================= 发布功能（待实现，占位） =========================

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  log('warn', 'publishVideo', '微博视频发布功能尚未实现');
  return makeFailedResult(accountId, 'weibo', '微博视频发布功能待实现', startedAt);
}

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  log('warn', 'publishImage', '微博图文发布功能尚未实现');
  return makeFailedResult(accountId, 'weibo', '微博图文发布功能待实现', startedAt);
}

async function publishArticle(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  log('warn', 'publishArticle', '微博头条文章发布功能尚未实现');
  return makeFailedResult(accountId, 'weibo', '微博头条文章发布功能待实现', startedAt);
}

/** 旧版通用发布接口（向后兼容） */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  switch (request.contentType) {
    case 'video':
      return publishVideo(accountId, request, onProgress);
    case 'image':
      return publishImage(accountId, request, onProgress);
    case 'article':
      return publishArticle(accountId, request, onProgress);
    default:
      return makeFailedResult(
        accountId,
        'weibo',
        `不支持的内容类型: ${request.contentType}`,
        Date.now(),
      );
  }
}

// ========================= 注册适配器 =========================

const adapter: PlatformAdapter = {
  key: 'weibo',
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

log('info', 'register', '微博平台适配器已注册（账号管理已接入，发布功能待实现）');

export default adapter;
export { meta as weiboMeta };
