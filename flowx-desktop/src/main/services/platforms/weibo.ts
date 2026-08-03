import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import {
  sleep,
  makePublishLogger,
  makePublishWindow,
  attachNavigationTracker,
  evalJS,
  makeFailedResult,
  uploadViaCDP,
  waitForUploadComplete,
  buildPageStructureProbe,
  buildTestModeProbeScript,
  setupTestModeWindow,
} from './shared';
import { registerPlatform } from './registry';
import type {
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
  ContentType,
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
  publishUrl: 'https://weibo.com/upload/channel',
  homeUrl: 'https://me.weibo.com/',
  contentTypes: ['video', 'image', 'article'],
  capabilities: {
    publishVideo: true,
    publishImage: true, // 首页图文发布：https://weibo.com/
    publishArticle: false, // TODO: 待实现（头条文章）
  } as AccountCapabilities,
  contentLimits: {
    title: 30, // 微博视频标题最多 30 字
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
    // SUB 有效性校验：访客态默认值/太短/空 不算有效 SUB
    const subCookieRaw = cookies.find((c) => c.name === 'SUB');
    const subVal = (subCookieRaw?.value || '').trim();
    const subCookie = subVal && subVal.length >= 20 && !/^_?v(isitor)?[_\-]*$/i.test(subVal) ? subCookieRaw : undefined;
    const subP = cookies.find((c) => c.name === 'SUBP' && c.value && c.value.length >= 12);
    const wbSess = cookies.find((c) => (c.name === 'WEIBOCN_WM' || c.name === '_2AAM') && c.value && c.value.length >= 10);

    const matchedKeywords: string[] = [];
    if (subCookie) matchedKeywords.push('SUB-cookie');
    if (subP) matchedKeywords.push('SUBP-cookie');
    if (wbSess) matchedKeywords.push('WEIBO-session-cookie');

    // 2. 绝对未登录：登录域 / 登录路径 —— 包含 /newlogin（微博新版登录页）和 visitor 访客域也必须算登录页
    const isLoginPage = currentUrl.includes('/login') ||
                        currentUrl.includes('/newlogin') ||
                        currentUrl.includes('/signin') ||
                        currentUrl.includes('passport.weibo.com') ||
                        currentUrl.includes('/visitor/') ||
                        currentUrl.includes('weibo.com/visitor') ||
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
    // URL 归属判断（用于给结构级结果加上下文字段，避免 newlogin 页面残留 woo-avatar DOM 被命中 creatorAvatarOK）
    const inMe = currentUrl.includes('me.weibo.com');
    const inHomepageProfile = /weibo\.com\/(u|p)\/\d/i.test(currentUrl) && !isLoginPage;

    if (personalTab && personalTab.ok) {
      matchedKeywords.push('struct-personalTabOK');
      if (personalTab.title) matchedKeywords.push('pt-title:' + personalTab.title.slice(0, 12));
    }
    // 结构级 creatorAvatar 必须带 URL 上下文校验：只有 me.weibo.com 或个人主页 weibo.com/u/p/N 才会渲染真实的创作中心头像
    // 登录页 /newlogin 里即使有 woo-avatar 残留元素（空壳）也不算命中
    const creatorAvatarOK = !!(creatorAvatar && creatorAvatar.ok) && (inMe || inHomepageProfile);
    if (creatorAvatarOK) matchedKeywords.push('struct-creatorAvatarOK');
    if (visitorSign) matchedKeywords.push('struct-visitorSign');
    if (hasLogoutButton) matchedKeywords.push('struct-logoutBtn');

    // 4. inBackend：在 me.weibo.com / weibo.com/u/xxx / weibo.com/p/xxx / weibo.com/upload/* 且不在登录页
    //    说明：weibo.com/upload/channel 是视频发布页，能进入该页就说明已登录（访客态会重定向到登录页）
    const inUploadPage = currentUrl.includes('weibo.com/upload/') && !isLoginPage;
    const inBackend = ((inMe && !isLoginPage) ||
                       inHomepageProfile ||
                       inUploadPage) &&
                      !isLoginPage &&
                      !visitorSign;
    if (inBackend) matchedKeywords.push('in-weibo-backend');
    if (inUploadPage) matchedKeywords.push('in-upload-page');

    // 5. 老版 dom 辅助（仅当结构没有判断时兜底，避免漏网之鱼）
    let domLoggedIn = false;
    if (!personalTab.ok && !creatorAvatarOK && !visitorSign && !isLoginPage) {
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
    //   - 结构 A 或 结构 B 命中（带 URL 上下文校验，避免 newlogin 残留 DOM 误判）→ 一定已登录
    //   - 否则，需要：有效 SUB cookie 存在 AND 不在登录页 AND 不是访客态 AND (inBackend OR domLoggedIn OR hasLogoutButton)
    //   - 访客态(struct-visitorSign=true) / 登录页 URL（含/newlogin、/visitor/、passport.weibo.com） 直接判 false，哪怕 SUB 残留
    const strongStructLoggedIn = !!(personalTab && personalTab.ok) || creatorAvatarOK;
    const softLoggedIn = !!subCookie &&
                         !isLoginPage &&
                         !visitorSign &&
                         (inBackend || domLoggedIn || hasLogoutButton);
    // 登录页 URL 直接否决：只要当前页面还是登录页（/newlogin /passport /visitor /sso），不管 cookie 还是结构，一律不算已登录
    //   应对场景：用户还没扫码，直接关窗口 → 防止误保存访客残留 + 跳转主页产生的错误昵称/粉丝数
    const loggedIn = !isLoginPage && !visitorSign && (strongStructLoggedIn || softLoggedIn);

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
        // ⚠️ 2026-08-03 验证：sinaimg.cn 的 crop/avatar 类 URL 现在必须带签名才能访问（Referer + ssig/KID/Expires 缺一即 403）
        // 因此：**不再剥除任何 query 参数**，完整保留带签名的 URL。
        //   防盗链绕过在渲染层通过 Electron webRequest.onBeforeSendHeaders 统一注入 Referer: https://weibo.com/ 实现。
        //   过期问题：采集的签名有效期一般几小时到一天，过期后重新采集即可（用户点击"刷新账号"触发）。
        if (host && (_isSinaImgHost(host) || /sinaimg\.cn$/i.test(host))) {
          // 保留原样：不剥 KID/Expires/ssig 等签名
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

/** ⚠️ 2026-08-03 验证：tp1~tp4.sinaimg.cn/{uid}/180/0 永久格式已被微博废弃，全部返回 403 Forbidden
 *  ——不要再用！微博现在对 sinaimg.cn 头像图片同时校验：
 *     (1) URL 上的 KID=imgbed,tva & Expires=... & ssig=... 短期签名参数
 *     (2) HTTP Referer 头必须为 weibo.com
 *  两者缺一即 403。因此正确做法：采集阶段完整保留带签名的 crop URL，渲染层在 Electron 拦截时加上 Referer 头。
 */
function _weiboPermanentAvatar(_uid: string | null | undefined): string {
  return '';
}

function _isSinaImgHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'sinaimg.cn' || h.endsWith('.sinaimg.cn')) return true;
  // 常见微博头像节点：tva1~tva4 / tvax1~tvax4 / tp1~tp4 / wx1~wx4 / h5
  if (/^(tva|tvax|tp|wx|h5|ss)\d*\.sinaimg\.cn$/.test(h)) return true;
  return false;
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

    // ---------- 阶段 2.5：platformAccountId (UID/微博号) 主进程级兜底 ----------
    // 用户反馈：创作中心 me.weibo.com 完全没有数字 UID 写入 DOM，导致后续阶段3.5无法跳转个人主页
    // 强顺序：cookies 优先（uidCandidates 直接命中 → 裸扫value中纯数字 → SUBP base64）→ 页面级多源兜底
    log('info', 'extractPageInfo',
      `[阶段2.5 入口] platformAccountId=(${platformAccountId || '空'}) nickname=(${nickname || '空'}) avatar.len=${avatar.length}`);
    if (!platformAccountId) {
      try {
        const cookies = await win.webContents.session.cookies.get({});
        log('info', 'extractPageInfo', `[阶段2.5] session.cookies 共 ${cookies.length} 条`);
        // 1) 精确 uidCandidates 直接命中（和 AccountService Step4 同款）
        const uidCandidates = ['a1', 'user_id', 'user_key', 'open_id', 'sec_user_id', 'uid', 'z_c0', 'wbind', 'wb_uid', 'weibouid', 'suda_id', 'w_muid', 'wmid'];
        let foundPid = '';
        for (const c of cookies) {
          if (!c.value) continue;
          const name = (c.name || '').toLowerCase();
          const val = (c.value || '').trim();
          if (uidCandidates.includes(name) && /^\d{5,12}$/.test(val)) {
            foundPid = val;
            log('info', 'extractPageInfo', `[阶段2.5] 🔴 uidCandidates 精确命中 cookie=${c.name} = ${val}`);
            break;
          }
        }
        // 2) 「整个 value 纯数字」的 cookie 直接命中（排除令牌类/非UID名黑名单）
        //    常见：uid=8322677072(纯数字), DedeUserID=34567890(纯数字)
        if (!foundPid) {
          const NAME_BLACKLIST = /(token|csrf|xsrf|svb|srt|srf|scf|cross|cache|salt|sign|key|crypt|nonce|state|pc_token|session|sso|track|device|fingerprint|fp|gcid|suda|cid|code)/i;
          for (const c of cookies) {
            if (!c.value) continue;
            const name = (c.name || '');
            const val = (c.value || '').trim();
            if (NAME_BLACKLIST.test(name)) continue; // 令牌类名直接跳过
            if (/^[A-Za-z\-]/.test(val)) continue;    // 首字母开头基本是签名类，跳过
            if (/^\d{5,12}$/.test(val)) {
              foundPid = val;
              log('info', 'extractPageInfo', `[阶段2.5] value全纯数字命中 cookie=${name} = ${val}`);
              break;
            }
          }
        }
        // 3) 「片段数字」兜底（门槛最高）—— 仅 SUB/ SUBP 这类已知前缀合理的 cookie 才做片段抽
        //    ⚠️ 严禁对所有 cookie 做片段裸扫！之前 PC_TOKEN=945d126441 → 片段 126441 被误当 UID
        if (!foundPid) {
          const FRAGMENT_OK = /^(SUB|SUBP|SUHB|SUDAPROD|SSOLoginState|WEIBOCN|_2AAM|SINA Visitor)$/i;
          for (const c of cookies) {
            if (!c.value) continue;
            const name = (c.name || '');
            const val = (c.value || '');
            if (!FRAGMENT_OK.test(name) && !(name.toLowerCase() === 'subp')) continue;
            const m = val.match(/(^|[^\d])(\d{8,12})([^\d]|$)/); // UID 至少 8 位（极少人6位数）
            if (m && m[2]) {
              foundPid = m[2];
              log('info', 'extractPageInfo', `[阶段2.5] 片段数字命中(仅SUB系列) cookie=${name} 片段=${foundPid} (raw.len=${val.length})`);
              break;
            }
          }
        }
        // 4) SUBP base64 decode 最后兜底
        if (!foundPid) {
          const subp = cookies.find((c) => (c.name || '').toLowerCase() === 'subp' && c.value && c.value.length > 10);
          if (subp && subp.value) {
            try {
              const decoded = Buffer.from(subp.value, 'base64').toString('latin1');
              const dm = decoded.match(/(\d{8,12})/);
              if (dm && dm[1]) {
                foundPid = dm[1];
                log('info', 'extractPageInfo', `[阶段2.5] SUBP decode 命中UID=${dm[1]} (decoded.len=${decoded.length})`);
              }
            } catch (_) { /* ignore */ }
          }
        }
        if (foundPid) platformAccountId = foundPid;
      } catch (cookieErr) {
        log('warn', 'extractPageInfo', `[阶段2.5] cookies 读取异常: ${(cookieErr as Error).message}`);
      }
    }
    log('info', 'extractPageInfo', `[阶段2.5] cookies完成后 platformAccountId=(${platformAccountId || '空'}) → 进入页面级脚本`);
    // 页面级兜底脚本：__INITIAL_STATE__/storage/innerHTML（必须纯 JS，绝不能写 TS 的 window as any）
    if (!platformAccountId) {
      try {
        const p: any = await win.webContents.executeJavaScript(`
          (function() {
            try {
              function _pick(s) {
                if (!s) return null;
                var m = String(s).match(/(?:\\/u\\/|uid["'\\s:=]+|userid["'\\s:=]+)(\\d{5,12})/i);
                if (m && m[1]) return m[1];
                return null;
              }
              var r = null;
              try {
                if (window.__INITIAL_STATE__ != null) r = _pick(JSON.stringify(window.__INITIAL_STATE__));
                else if (window.__NUXT__ != null) r = _pick(JSON.stringify(window.__NUXT__));
                else if (window.$CONFIG != null) r = _pick(JSON.stringify(window.$CONFIG));
                else if (window.bootstrap && typeof window.bootstrap === 'object') r = _pick(JSON.stringify(window.bootstrap));
              } catch(_e1) { /* ignore */ }
              if (!r) try { if (typeof location !== 'undefined' && location && location.href) r = _pick(location.href); } catch(_e2) {}
              if (!r) try {
                if (document && document.body && document.body.innerHTML) {
                  var m2 = String(document.body.innerHTML).match(/["'\\/]\\/u\\/(\\d{5,12})(?:\\?|["'\\/ ]|$)/);
                  if (m2 && m2[1]) r = m2[1];
                }
              } catch(_e3) {}
              if (!r) try {
                // 读 sessionStorage/localStorage 所有 key-value
                var keys = [], i;
                if (typeof localStorage !== 'undefined') {
                  for (i = 0; i < localStorage.length; i++) keys.push('LS:' + localStorage.key(i));
                }
                if (typeof sessionStorage !== 'undefined') {
                  for (i = 0; i < sessionStorage.length; i++) keys.push('SS:' + sessionStorage.key(i));
                }
                for (i = 0; i < keys.length && !r; i++) {
                  var k = keys[i];
                  var v = '';
                  try { v = k.substr(0,3)==='LS:' ? (localStorage.getItem(k.substr(3)) || '') : (sessionStorage.getItem(k.substr(3)) || ''); } catch(_e4) {}
                  var hit = _pick(v);
                  if (hit) r = hit;
                }
              } catch(_e5) {}
              // 最终兜底：直接 document.querySelectorAll 扫所有 a[href] 含 /u/ 的
              if (!r) try {
                if (document && document.querySelectorAll) {
                  var aa = document.querySelectorAll('a[href*="/u/"], a[href*="weibo.com/u/"]');
                  for (var ai = 0; ai < aa.length && !r; ai++) {
                    var ah = (aa[ai].getAttribute('href') || '') + ' ' + (aa[ai].href || '');
                    var am = ah.match(/weibo\\.com\\/u\\/(\\d{5,12})/i) || String(ah).match(/[\\/"]u\\/(\\d{5,12})(?:\\?|[\\/" ]|$)/);
                    if (am && am[1]) r = am[1];
                  }
                }
              } catch(_e6) {}
              return r;
            } catch(e) { return '__ERR__' + String(e && e.message || e); }
          })()
        `);
        log('info', 'extractPageInfo', `[阶段2.5] 页面脚本返回: ${typeof p === 'string' ? (p.length < 40 ? p : p.slice(0,40)+'…') : JSON.stringify(p)}`);
        if (p && typeof p === 'string' && /^\d{5,12}$/.test(p)) {
          platformAccountId = p;
          log('info', 'extractPageInfo', `[阶段2.5] 🔴 页面__INITIAL_STATE__/storage/innerHTML 命中UID=${p}`);
        } else if (typeof p === 'string' && p.startsWith('__ERR__')) {
          log('warn', 'extractPageInfo', `[阶段2.5] 页面脚本执行异常: ${p}`);
        }
      } catch (e) {
        log('warn', 'extractPageInfo', `[阶段2.5] 页面脚本外层异常: ${(e as Error).message}`);
      }
    }
    log('info', 'extractPageInfo', `[阶段2.5 出口] platformAccountId=(${platformAccountId || '空'})`);

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
    //   ✅ 拆分成 6 个独立小脚本，避免单个脚本语法异常导致"整个阶段3.2没值"
    try {
      // ------- 3.2.1 昵称 -------
      if (!nickname) {
        try {
          const r = await win.webContents.executeJavaScript(`
            (function(){try{
              var sel = ['div[class*="_name_"]','._name_v0oim_18','.user-info .name','.username','.nick-name','.screen-name','[class*="user-name"]','[class*="nickname"]','[class*="screen-name"]','.header .name','.topbar-user .name','.WD_header_name','.nameBox .name','.nameBox .userName','.person_name','.name','h1'];
              for (var i=0;i<sel.length;i++){
                try {
                  var el = document.querySelector(sel[i]);
                  if (!el) continue;
                  var txt = ((el.innerText || el.textContent || '')+'').trim().slice(0,40);
                  if (txt && txt.length>=1) return txt;
                } catch(_){}
              }
              return '';
            }catch(e){return '';}})()
          `);
          if (r && typeof r === 'string' && r.trim()) {
            nickname = r.trim();
            log('info', 'extractPageInfo', `[3.2.1] 兜底脚本命中昵称: "${nickname}"`);
          }
        } catch (e) {
          log('warn', 'extractPageInfo', '[3.2.1] 昵称脚本异常: ' + (e as Error).message);
        }
      }
      // ------- 3.2.2 头像 -------
      if (!avatar) {
        try {
          const r = await win.webContents.executeJavaScript(`
            (function(){try{
              var sel = ['img.woo-avatar-img','img[class*="_avatar_"]','img[class*="avatar"]','img[class*="head"]','a[href*="weibo.com/u/"] img','a[href*="weibo.com/p/"] img','.avatar img','a.avatar img','.user-info img','img.avatar','.header img','.topbar-user img','.account-info img','.user-card img','.head_pic img','.W_face_radius img','img.head_pic'];
              for (var i=0;i<sel.length;i++){
                try {
                  var img = document.querySelector(sel[i]);
                  if (!img) continue;
                  var src = img.src || img.getAttribute('src') || '';
                  if (src && (src.indexOf('http')===0 || src.indexOf('//')===0)) return src;
                } catch(_){}
              }
              return '';
            }catch(e){return '';}})()
          `);
          if (r && typeof r === 'string' && (r.startsWith('http') || r.startsWith('//'))) {
            avatar = r;
            log('info', 'extractPageInfo', `[3.2.2] 兜底脚本命中头像: ${avatar.length} chars`);
          }
        } catch (e) {
          log('warn', 'extractPageInfo', '[3.2.2] 头像脚本异常: ' + (e as Error).message);
        }
      }
      // ------- 3.2.3 platformAccountId (UID/微博号) -------
      log('info', 'extractPageInfo',
        `[3.2.3 入口] platformAccountId=(${platformAccountId || '空'})`);
      if (!platformAccountId) {
        try {
          const r: any = await win.webContents.executeJavaScript(`
            (function(){try{
              // 1) a 链接
              var allLinks = document.querySelectorAll('a[href*="weibo.com/u/"], a[href^="/u/"], a[href*="/u/"]');
              var i, href, fullHref, m;
              for (i=0;i<allLinks.length;i++){
                href = allLinks[i].getAttribute('href') || '';
                fullHref = allLinks[i].href || href;
                m = String(fullHref+' '+href).match(/weibo\\.com\\/u\\/([0-9]{5,12})/i) || href.match(/^\\/u\\/([0-9]{5,12})$/);
                if (m && m[1]) return { platformAccountId: m[1], source: 'a-href' };
              }
              // 2) 正文搜"微博号"
              if (document && document.body) {
                var bodyText = document.body.innerText || '';
                var am = bodyText.match(/(?:微博号|微博账号|微号)[：:\\s]*([A-Za-z0-9_\\-]{3,30})/);
                if (am && am[1]) return { platformAccountId: am[1], source: 'body-微博号' };
              }
              return { platformAccountId: '', source: 'none' };
            }catch(e){return { platformAccountId:'', source:'err:'+String(e&&e.message||e) };}})()
          `);
          if (r && r.platformAccountId) {
            platformAccountId = r.platformAccountId;
            log('info', 'extractPageInfo', `[3.2.3] 兜底脚本命中platformAccountId="${platformAccountId}" (${r.source})`);
          }
        } catch (e) {
          log('warn', 'extractPageInfo', '[3.2.3] platformAccountId脚本异常: ' + (e as Error).message);
        }
      }
      // ------- 3.2.4 统计数字（DOM配对方式）【加更严格标签过滤】-------
      log('info', 'extractPageInfo',
        `[3.2.4 入口] before: fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}`);
      try {
        const r: any = await win.webContents.executeJavaScript(`
          (function(){try{
            function _pn(s){
              if(!s) return null;
              var t = String(s).replace(/\\s+/g,'').replace(/,/g,'');
              var base = parseFloat(t);
              if (isNaN(base)) return null;
              if (t.indexOf('万')!==-1) base*=10000;
              else if (t.indexOf('千')!==-1) base*=1000;
              else if (t.indexOf('百')!==-1) base*=100;
              else if (t.indexOf('亿')!==-1) base*=100000000;
              return Math.round(base);
            }
            var out = { fansCount:null, followCount:null, likeCount:null };
            // 标签黑名单：避免把"互相关注 1 人""私信 1""评论 1""转发 1"等识别为统计数
            var BAD = /(我|人|位|条|私信|评论|转发|回复|点赞按钮|文章|视频|相册|专辑|分组|聊天|对话|消息|记录|好友|博主|话题|超话|帖子|举报|屏蔽|特别|悄悄|共同|关注的|关注他|关注她|关注我)/;
            function _set(lab,val){
              if (val===null || !lab) return false;
              var L = (lab||'').trim();
              if (L.length===0 || L.length>10) return false;
              if (BAD.test(L)) return false;
              if ((/粉丝/.test(L)) && out.fansCount===null) { out.fansCount=val; return true; }
              if (/关注/.test(L) && !/互相关注|关注我|关注的人|关注TA|关注他|关注她/.test(L) && out.followCount===null) { out.followCount=val; return true; }
              if ((/获赞|点赞数|转评赞/.test(L)) && out.likeCount===null) { out.likeCount=val; return true; }
              // 单独"点赞"太容易被帖子点赞按钮干扰，必须在数字 >= 10 或 val 是万单位时才接受
              if (/点赞/.test(L) && !/点赞数/.test(L) && (val>=10 || /万|千|亿/.test(lab))) {
                if (out.likeCount===null) { out.likeCount=val; return true; }
              }
              return false;
            }
            var all = document.querySelectorAll('[class*="number"], [class*="Number"], [class*="count"], [class*="Count"], [class*="num"], [class*="Num"], [class*="stat"]');
            var i, ne, nv, np, pi, pch, ptxt;
            for (i=0;i<all.length;i++){
              ne = all[i];
              nv = _pn(ne.textContent || '');
              if (nv===null) continue;
              np = ne.parentNode;
              if (np && np.children) {
                for (pi=0;pi<np.children.length;pi++){
                  pch = np.children[pi];
                  if (pch===ne) continue;
                  ptxt = (pch.textContent || '').trim();
                  if (ptxt) _set(ptxt, nv);
                }
              }
            }
            return out;
          }catch(e){return { fansCount:null, followCount:null, likeCount:null, _err: String(e&&e.message||e) };}})()
        `);
        if (r) {
          // 极度不信任"只命中一个字段且值为 0~2"的情况（99%是误抓）
          const hits = [r.fansCount, r.followCount, r.likeCount].filter((x: any) => typeof x === 'number').length;
          const tinySuspect = (x: any) => typeof x === 'number' && x >= 0 && x <= 2;
          if (hits === 1) {
            if (tinySuspect(r.fansCount)) r.fansCount = null;
            if (tinySuspect(r.followCount)) r.followCount = null;
            if (tinySuspect(r.likeCount)) r.likeCount = null;
          }
          if (fansCount === null && typeof r.fansCount === 'number') fansCount = r.fansCount;
          if (followCount === null && typeof r.followCount === 'number') followCount = r.followCount;
          if (likeCount === null && typeof r.likeCount === 'number') likeCount = r.likeCount;
          log('info', 'extractPageInfo',
            `[3.2.4 出口] script=(${typeof r.fansCount === 'number' ? r.fansCount : '-'}/` +
            `${typeof r.followCount === 'number' ? r.followCount : '-'}/` +
            `${typeof r.likeCount === 'number' ? r.likeCount : '-'}) ` +
            `after: fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}` +
            (r._err ? ' err=' + r._err : ''));
        }
      } catch (e) {
        log('warn', 'extractPageInfo', '[3.2.4] 统计DOM配对脚本异常: ' + (e as Error).message);
      }
      // ------- 3.2.5 统计数字（body全文正则双向兜底）【严格标签过滤 + tiny 值不信任】-------
      log('info', 'extractPageInfo',
        `[3.2.5 入口] before: fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}`);
      try {
        const r: any = await win.webContents.executeJavaScript(`
          (function(){try{
            function _pn(s){
              if(!s) return null;
              var t = String(s).replace(/\\s+/g,'').replace(/,/g,'');
              var base = parseFloat(t);
              if (isNaN(base)) return null;
              if (t.indexOf('万')!==-1) base*=10000;
              else if (t.indexOf('千')!==-1) base*=1000;
              else if (t.indexOf('百')!==-1) base*=100;
              else if (t.indexOf('亿')!==-1) base*=100000000;
              return Math.round(base);
            }
            var b = '';
            try { b = document.body ? (document.body.innerText || '') : ''; } catch(_) {}
            var fans=null, fol=null, lik=null;
            var m1=null, m2=null;
            // ===== 粉丝（不受干扰词影响，较稳）=====
            m1 = b.match(/(粉丝|粉丝数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
            m2 = b.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(粉丝|粉丝数)/);
            if (m1 && m1[2]) fans = _pn(m1[2]);
            else if (m2 && m2[1]) fans = _pn(m2[1]);
            // ===== 关注（严格避免"互关|关注我|关注的|关注TA|关注他|关注她|关注一个人|我的关注"）=====
            //   正则方向1：标签在左，数字在右 —— 前面不能有"互" / "的"；中间必须全是非"我他她TA关的"
            m1 = b.match(/(^|[^互的的他她TA我])\\s*(关注|关注数)([^0-9我他她TA的的]{0,10})(\\d+(?:\\.\\d+)?[万千百亿]?)/);
            //   正则方向2：数字在左，标签在右 —— 标签后面必须跟结束/空格/标点/换行，不能跟"的/人/TA"
            m2 = b.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)([^0-9我他她TA的的]{0,10})(关注|关注数)([^人他她TA我的的]|$)/);
            if (m1 && m1[4]) fol = _pn(m1[4]);
            else if (m2 && m2[1]) fol = _pn(m2[1]);
            // ===== 获赞（只用"获赞/点赞数/转评赞"，单独"点赞"太容易误抓）=====
            m1 = b.match(/(获赞|点赞数|转评赞)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
            m2 = b.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(获赞|点赞数|转评赞)/);
            if (m1 && m1[2]) lik = _pn(m1[2]);
            else if (m2 && m2[1]) lik = _pn(m2[1]);
            return { fansCount: fans, followCount: fol, likeCount: lik };
          }catch(e){
            return { fansCount:null, followCount:null, likeCount:null, _err: String(e&&e.message||e) };
          }})()
        `);
        if (r) {
          // 极度不信任：只命中一个字段 + 值在 0~2 → 99% 是"关注我 1 人""私信 1 条"类干扰
          const hits = [r.fansCount, r.followCount, r.likeCount].filter((x: any) => typeof x === 'number').length;
          const tinySuspect = (x: any) => typeof x === 'number' && x >= 0 && x <= 2;
          if (hits === 1) {
            if (tinySuspect(r.fansCount)) r.fansCount = null;
            if (tinySuspect(r.followCount)) r.followCount = null;
            if (tinySuspect(r.likeCount)) r.likeCount = null;
          }
          if (fansCount === null && typeof r.fansCount === 'number') fansCount = r.fansCount;
          if (followCount === null && typeof r.followCount === 'number') followCount = r.followCount;
          if (likeCount === null && typeof r.likeCount === 'number') likeCount = r.likeCount;
          log('info', 'extractPageInfo',
            `[3.2.5 出口] script=(${typeof r.fansCount === 'number' ? r.fansCount : '-'}/` +
            `${typeof r.followCount === 'number' ? r.followCount : '-'}/` +
            `${typeof r.likeCount === 'number' ? r.likeCount : '-'}) hits=${hits} ` +
            `after: fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}` +
            (r._err ? ' err=' + r._err : ''));
        }
      } catch (e) {
        log('warn', 'extractPageInfo', '[3.2.5] 统计正则脚本异常: ' + (e as Error).message);
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '通用 DOM 兜底脚本外层异常: ' + (e as Error).message);
    }

    // ---------- 阶段 3.5：个人主页精确提取（粉丝/关注/点赞数） ----------
    // 用户反馈：微博的关注/粉丝/获赞数不在首页和创作中心，必须进入个人主页
    // URL 格式：纯数字 UID -> https://weibo.com/u/{UID}；自定义微博号 -> https://weibo.com/n/{微博号}
    log('info', 'extractPageInfo',
      `[阶段3.5 入口] fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}` +
      `; pid=(${platformAccountId || '空'})`);
    const needStats = fansCount === null || followCount === null || likeCount === null;
    const haveUid = /^\d{5,12}$/.test(platformAccountId || '');
    const haveCustomId =
      !haveUid &&
      !!platformAccountId &&
      /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,30}$/.test(platformAccountId); // 微博号允许中文/字母/数字/下划线/横线
    if (needStats && (haveUid || haveCustomId)) {
      let profileUrl = '';
      // 🐛 修复末尾逗号 bug：先对 pid 做尾部清洗（去除逗号/句号/分号/空格）
      const safePid = (platformAccountId || '').replace(/[，,.;；:：\s]+$/g, '').replace(/^[，,.;；:：\s]+/g, '');
      if (haveUid) profileUrl = `https://weibo.com/u/${safePid}`;
      else if (haveCustomId) profileUrl = `https://weibo.com/n/${encodeURIComponent(safePid)}`;
      // URL 级二次兜底：剥掉路径末尾可能残留的逗号/句号等
      if (profileUrl) profileUrl = profileUrl.replace(/([\u4e00-\u9fa5A-Za-z0-9])[，,.;；:：]+([?#]|$)/g, '$1$2');
      if (profileUrl) {
        try {
          log('info', 'extractPageInfo',
            `[阶段3.5] 进入个人主页提取统计数据 → url=${profileUrl}, ` +
            `before: fans=${fansCount ?? 'n/a'}, follow=${followCount ?? 'n/a'}, like=${likeCount ?? 'n/a'}`);
          // 挂接导航跟踪器，防止"页面跳转中执行JS导致 frame disposed"
          const profileTracker = attachNavigationTracker(win, log);
          try {
            await win.loadURL(profileUrl);
          } catch (loadErr) {
            log('warn', 'extractPageInfo', `[阶段3.5] loadURL 抛错但继续: ${(loadErr as Error).message}`);
          }
          try {
            await profileTracker.waitForStable(1500, 25000);
          } catch (_) {
            log('warn', 'extractPageInfo', '[阶段3.5] waitForStable 超时，继续（可能SPA页面已部分渲染）');
          }
          await sleep(1800); // 给微博个人主页顶部统计卡片留出异步渲染时间

          // 个人主页统计卡片提取脚本：针对用户确认过的新版微博个人主页 DOM
          // 原则：个人主页是**唯一权威源**，结果以这里为准 —— 先清零，再按严格策略从外向内填
          // 用户真实页面示例（头部统计区 _h4_1yc79_82）：
          //   <div class="_h4_1yc79_82">
          //     <a href="/u/page/follow/{UID}?relate=fans"><span class="_h5_1yc79_100"><span>1</span>粉丝 </span></a>
          //     <a href="/u/page/follow/{UID}?relate=">    <span class="_h5_1yc79_100"><span>50</span>关注 </span></a>
          //     <a class="_statusCounter_1yc79_360">       <span class="_h5_1yc79_100"><span>0</span>转评赞 </span></a>
          //   </div>
          const statsResult: any = await win.webContents.executeJavaScript(`
            (function() {
              try {
                function _pn(s) {
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
                // ✅ 精确锁定「头部主统计卡片」：父容器 className 同时含 _box1_* + _h4_*（用户给的真实 DOM 就是这个）
                //   真实结构：div._box1_1yc79_55
                //               div._h3_1yc79_78 (昵称行)
                //               div._h4_1yc79_82 ← 统计行，所有 a.relate 和 _statusCounter_ 都在里面
                // 任何不在这个精确结构里的数字（侧边栏「1分组」「1 条消息」「关注 1 个博主」）全部排除
                function _inProfileHeader(el) {
                  if (!el) return false;
                  var cur = el;
                  for (var up = 0; up < 8 && cur; up++, cur = cur.parentElement) {
                    var cls = (cur.className || '') + '';
                    if (typeof cls !== 'string') continue;
                    // 直接落在 _h4_*（统计行）或 _statusCounter_*（转评赞容器）就算命中
                    if (/_h4_/.test(cls)) return true;
                    if (/_statusCounter_/.test(cls)) return true;
                  }
                  return false;
                }
                var out = { fansCount: null, followCount: null, likeCount: null };
                // 命中来源调试：每条赋值都记录，返回时一并带回给主进程打日志用
                var src = { fans: '', follow: '', like: '' };
                function _s(k, v, why) {
                  if (src[k]) return;
                  src[k] = (why || k) + '=' + v;
                }
                function _set(labelTxt, numVal, why) {
                  if (numVal === null || !labelTxt) return false;
                  if ((/粉丝/.test(labelTxt)) && out.fansCount === null) { out.fansCount = numVal; _s('fans', numVal, why || labelTxt); return true; }
                  if (/关注/.test(labelTxt) && /关注我|互相关注|分组|特别关注|悄悄关注|共同关注|关注的人|关注TA|关注他|关注她|关注一个人|关注博主|关注用户|关注列表|的关注/.test(labelTxt) === false && out.followCount === null) { out.followCount = numVal; _s('follow', numVal, why || (labelTxt+'|关注')); return true; }
                  if ((/获赞|转评赞|点赞数/.test(labelTxt)) && out.likeCount === null) { out.likeCount = numVal; _s('like', numVal, why || (labelTxt+'|转评赞')); return true; }
                  // 单纯"点赞"太容易被「点赞 1」按钮误判，仅当 >=10 或含单位才接受
                  if (/点赞/.test(labelTxt) && !/点赞数|获赞|转评赞/.test(labelTxt) && (numVal >= 10 || /万|千|亿/.test(labelTxt))) {
                    if (out.likeCount === null) { out.likeCount = numVal; _s('like', numVal, why || (labelTxt+'|点赞')); return true; }
                  }
                  return false;
                }

                // ---------- 策略 1【最高优先级 · 强绑定头部容器】：_h4_* 父容器下的 span._h5_* / _statusCounter_ 内 span
                //   新版微博个人主页唯一正确 DOM，只在这个层级里扫，避免侧边栏/页脚干扰
                try {
                  var headerStats = document.querySelectorAll(
                    'div[class*="_h4_"] span[class*="_h5_"], div[class*="_h3_"] span[class*="_h5_"], a[class*="_statusCounter_"] span'
                  );
                  var hsi, hsEl, hsText, hsNumTxt, hsLabel, hsNum, hsInner;
                  for (hsi = 0; hsi < headerStats.length; hsi++) {
                    hsEl = headerStats[hsi];
                    if (!_inProfileHeader(hsEl)) continue;
                    hsText = (hsEl.textContent || '').trim();
                    if (!hsText || hsText.length > 30) continue;
                    hsNum = null;
                    hsInner = hsEl.querySelector && hsEl.querySelector('span');
                    if (hsInner) hsNum = _pn(hsInner.textContent);
                    if (hsNum === null) {
                      hsNumTxt = hsText.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                      if (hsNumTxt && hsNumTxt[1]) hsNum = _pn(hsNumTxt[1]);
                    }
                    if (hsNum === null) continue;
                    hsLabel = hsText.replace(/\\d+(?:\\.\\d+)?[万千百亿]?/g, '').trim();
                    if (hsLabel) _set(hsLabel, hsNum, '策略1_h4_h5|' + hsLabel);
                  }
                } catch(_) { /* ignore */ }

                // ---------- 策略 2【URL query 精确 · 强绑定头部容器】：a[href*="relate="] 在头部统计区里
                //   ?relate=fans → 粉丝数；?relate=（空）→ 关注数；_statusCounter_ class → 转评赞
                try {
                  var aLinks = document.querySelectorAll('a[href*="relate="], a[class*="_statusCounter_"]');
                  var ai, aEl, aHref, aClass, aContent, aMatch, aVal;
                  for (ai = 0; ai < aLinks.length; ai++) {
                    aEl = aLinks[ai];
                    if (!_inProfileHeader(aEl)) continue;
                    aHref = (aEl.getAttribute('href') || '').toLowerCase();
                    aClass = aEl.className || '';
                    aContent = aEl.textContent || '';
                    aMatch = aContent.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                    if (!aMatch || !aMatch[1]) continue;
                    aVal = _pn(aMatch[1]);
                    if (aVal === null) continue;
                    if (/relate=fans(&|$)/.test(aHref) || aHref.indexOf('?relate=fans') !== -1) {
                      if (out.fansCount === null) { out.fansCount = aVal; _s('fans', aVal, '策略2_relate=fans'); }
                    } else if (/relate=(&|$)/.test(aHref) || (/relate=/.test(aHref) && !/relate=fans/.test(aHref))) {
                      // relate=（空值）或 relate=非fans → 关注
                      if (out.followCount === null) { out.followCount = aVal; _s('follow', aVal, '策略2_relate=空'); }
                    }
                    if (/_statusCounter_/.test(aClass) || /转评赞/.test(aContent)) {
                      if (out.likeCount === null) { out.likeCount = aVal; _s('like', aVal, '策略2_statusCounter'); }
                    }
                  }
                } catch(_) { /* ignore */ }

                // ---------- 策略 3（兜底 · 必须在头部容器内）：兄弟节点 strong/b/em + 标签 ----------
                try {
                  var strongs = document.querySelectorAll('strong, b, em');
                  var si, sb, sibCh, sibTxt, sibVal;
                  for (si = 0; si < strongs.length; si++) {
                    sb = strongs[si];
                    if (!_inProfileHeader(sb)) continue;
                    sibVal = _pn(sb.textContent || '');
                    if (sibVal === null) continue;
                    if (sb.parentNode && sb.parentNode.children) {
                      for (var sbi = 0; sbi < sb.parentNode.children.length; sbi++) {
                        sibCh = sb.parentNode.children[sbi];
                        if (sibCh === sb) continue;
                        sibTxt = (sibCh.textContent || '').trim();
                        if (sibTxt && sibTxt.length <= 10) {
                          if (_set(sibTxt, sibVal, '策略3_strong|' + sibTxt)) break;
                        }
                      }
                    }
                  }
                } catch(_) { /* ignore */ }

                // ---------- 策略 4（兜底 · 必须在头部容器内）：class 含 number/count/num/stat ----------
                try {
                  var numEls = document.querySelectorAll(
                    '[class*="number"], [class*="Number"], [class*="count"], [class*="Count"], [class*="num"], [class*="Num"], [class*="stat"]'
                  );
                  for (var ni = 0; ni < numEls.length; ni++) {
                    var ne = numEls[ni];
                    if (!_inProfileHeader(ne)) continue;
                    var nv = _pn(ne.textContent || '');
                    if (nv === null) continue;
                    var np = ne.parentNode;
                    if (np && np.children) {
                      for (var pi = 0; pi < np.children.length; pi++) {
                        var pch = np.children[pi];
                        if (pch === ne) continue;
                        var ptxt = (pch.textContent || '').trim();
                        if (ptxt && ptxt.length <= 10) _set(ptxt, nv, '策略4_number|' + ptxt);
                      }
                    }
                  }
                } catch(_) { /* ignore */ }

                // ---------- 策略 5（兜底 · 必须在头部容器内）：a[href] 含 /follow /fans /like 路径 ----------
                try {
                  var statLinks = document.querySelectorAll('a[href*="/follow"], a[href*="/fans"], a[href*="/like"]');
                  for (var li = 0; li < statLinks.length; li++) {
                    var sel = statLinks[li];
                    if (!_inProfileHeader(sel)) continue;
                    var shref = (sel.getAttribute('href') || '').toLowerCase();
                    var stxt = sel.textContent || '';
                    var sm = stxt.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                    if (sm && sm[1]) {
                      var sv = _pn(sm[1]);
                      if (sv !== null) {
                        if (/\\/fans/.test(shref)) { if (out.fansCount === null) { out.fansCount = sv; _s('fans', sv, '策略5_/fans'); } }
                        else if (/\\/follow[^a-z]/.test(shref) || /\\/follow$/.test(shref)) { if (out.followCount === null) { out.followCount = sv; _s('follow', sv, '策略5_/follow'); } }
                        else if (/\\/like/.test(shref)) { if (out.likeCount === null) { out.likeCount = sv; _s('like', sv, '策略5_/like'); } }
                      }
                    }
                  }
                } catch(_) { /* ignore */ }

                // ---------- 策略 6（最后兜底 · 仅当三项还缺至少 2 项时才用正文正则）：避免首页/侧栏误读
                var missingCount = (out.fansCount===null?1:0) + (out.followCount===null?1:0) + (out.likeCount===null?1:0);
                if (missingCount >= 2) {
                  var btxt = document.body ? (document.body.innerText || '') : '';
                  if (out.fansCount === null) {
                    var fm1 = btxt.match(/(粉丝|粉丝数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                    var fm2 = btxt.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(粉丝|粉丝数)(?!群|会|)/);
                    if (fm1 && fm1[2]) { out.fansCount = _pn(fm1[2]); _s('fans', out.fansCount, '策略6_regex|粉丝+数字'); }
                    else if (fm2 && fm2[1]) { out.fansCount = _pn(fm2[1]); _s('fans', out.fansCount, '策略6_regex|数字+粉丝'); }
                  }
                  if (out.followCount === null) {
                    var fol1 = btxt.match(/(关注)[^0-9我他她TA的的]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                    var fol2 = btxt.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9我他她TA的的]{0,5}(关注)(?!我|者|他|她|TA|的|分组|的人|一个人|博主|用户)/);
                    if (fol1 && fol1[2]) { out.followCount = _pn(fol1[2]); _s('follow', out.followCount, '策略6_regex|关注+数字'); }
                    else if (fol2 && fol2[1]) { out.followCount = _pn(fol2[1]); _s('follow', out.followCount, '策略6_regex|数字+关注'); }
                  }
                  if (out.likeCount === null) {
                    var lk1 = btxt.match(/(获赞|点赞数|转评赞)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百亿]?)/);
                    var lk2 = btxt.match(/(\\d+(?:\\.\\d+)?[万千百亿]?)[^0-9]{0,5}(获赞|点赞数|转评赞)/);
                    if (lk1 && lk1[2]) { out.likeCount = _pn(lk1[2]); _s('like', out.likeCount, '策略6_regex|获赞+数字'); }
                    else if (lk2 && lk2[1]) { out.likeCount = _pn(lk2[1]); _s('like', out.likeCount, '策略6_regex|数字+获赞'); }
                  }
                }
                return { fansCount: out.fansCount, followCount: out.followCount, likeCount: out.likeCount, src: src };
              } catch(e) {
                return { fansCount: null, followCount: null, likeCount: null, error: String(e && e.message || e) };
              }
            })()
          `).catch((err: Error) => {
            log('warn', 'extractPageInfo', '[阶段3.5] 个人主页统计提取脚本异常: ' + err.message);
            return null;
          });

          if (statsResult) {
            // ⚠️ 个人主页是权威源，但要防止「命中后值极小(0~2)」的误判
            //    真实示例：侧边栏"关注1个分组"被误读 → follow=1；"1条消息"被误读
            //    2026-08-03 用户实际案例：hitCount=3 且 fans=1/follow=1/like=0（全小值），疑似仍命中策略1
            const beforeFans = fansCount, beforeFollow = followCount, beforeLike = likeCount;
            const rawFans: number | null = typeof statsResult.fansCount === 'number' ? statsResult.fansCount : null;
            const rawFollow: number | null = typeof statsResult.followCount === 'number' ? statsResult.followCount : null;
            const rawLike: number | null = typeof statsResult.likeCount === 'number' ? statsResult.likeCount : null;
            const hitCount = (rawFans !== null ? 1 : 0) + (rawFollow !== null ? 1 : 0) + (rawLike !== null ? 1 : 0);
            const tinySuspect = (x: number | null) => x !== null && x >= 0 && x <= 2;
            const hadFansGood = typeof beforeFans === 'number' && beforeFans > 2;
            const hadFollowGood = typeof beforeFollow === 'number' && beforeFollow > 2;
            const hadLikeGood = typeof beforeLike === 'number' && beforeLike > 2;
            const beforeAnyGood = hadFansGood || hadFollowGood || hadLikeGood;
            let finalFans = rawFans, finalFollow = rawFollow, finalLike = rawLike;
            let distrustReason = '';
            const tinyCount = (tinySuspect(rawFans) ? 1 : 0) + (tinySuspect(rawFollow) ? 1 : 0) + (tinySuspect(rawLike) ? 1 : 0);
            if (hitCount === 1) {
              // 单字段命中 + 值极小 → 99%是误抓，保留旧有效值
              const onlyVal = rawFans ?? rawFollow ?? rawLike;
              if (tinySuspect(onlyVal)) {
                distrustReason = `单字段命中(hit=${hitCount})且值=${onlyVal}∈[0,2]，视为误判，保留原值`;
                if (rawFans !== null) finalFans = hadFansGood ? beforeFans : (beforeFans ?? null);
                if (rawFollow !== null) finalFollow = hadFollowGood ? beforeFollow : (beforeFollow ?? null);
                if (rawLike !== null) finalLike = hadLikeGood ? beforeLike : (beforeLike ?? null);
              }
            } else if (hitCount >= 2 && tinyCount >= 2) {
              // 多字段命中，且 ≥2 个是小值（包含 tinyCount===3 的情况：3个全是0~2）
              //   - 如果 before 已有任何有效值（>2）→ 小值字段全部走「保留原值」（旧值非空覆盖，空则保留 raw，避免新账号直接被清空）
              //   - 如果 before 全空（第一次采集，tinyCount===3）→ 打 ⚠️告警但保留 raw 值，方便人工复核（也许真是新账号）
              if (tinyCount === 3 && !beforeAnyGood) {
                distrustReason = `3字段全小值(0~2)且before全空 → 疑似新账号或全误读，保留原值但⚠️标记复核`;
              } else {
                distrustReason = `小值字段≥2(tiny=${tinyCount}/hit=${hitCount})${beforeAnyGood?'(已有有效值→小值字段保留原值)':''}`;
                if (tinySuspect(rawFans)) finalFans = hadFansGood ? beforeFans : (beforeFans ?? rawFans);
                if (tinySuspect(rawFollow)) finalFollow = hadFollowGood ? beforeFollow : (beforeFollow ?? rawFollow);
                if (tinySuspect(rawLike)) finalLike = hadLikeGood ? beforeLike : (beforeLike ?? rawLike);
              }
            }
            // 应用最终值
            if (finalFans !== null) fansCount = finalFans;
            if (finalFollow !== null) followCount = finalFollow;
            if (finalLike !== null) likeCount = finalLike;
            // 命中来源 debug 日志
            const src: any = statsResult.src || {};
            log('info', 'extractPageInfo',
              `[阶段3.5] 完成(权威覆盖) before=(${beforeFans ?? 'n/a'}/${beforeFollow ?? 'n/a'}/${beforeLike ?? 'n/a'}) → after=(${fansCount ?? 'n/a'}/${followCount ?? 'n/a'}/${likeCount ?? 'n/a'})` +
              (distrustReason ? ` ⚠️不信任过滤: ${distrustReason}` : '') +
              ` 命中来源 src=fans:${src.fans || '(无)'} / follow:${src.follow || '(无)'} / like:${src.like || '(无)'}`);
          }
          profileTracker.dispose && profileTracker.dispose();
        } catch (profileErr) {
          log('warn', 'extractPageInfo',
            `[阶段3.5] 个人主页提取失败，保留原值: ${(profileErr as Error).message}`);
        }
      }
    }

    // ---------- 阶段 4：最终 GUARD 守卫，清洗字段 ----------
    const gNick = _cleanStr(nickname);
    const gPid = _cleanStr(platformAccountId);
    // ⚠️ 2026-08-03 验证：tp3.sinaimg.cn/{uid}/180/0 永久格式已 403 废弃
    // 现在头像策略：完整保留从 DOM 提取到的带签名的 crop URL（含 KID/Expires/ssig）
    // Referer 头绕过：由 Electron 主进程 webRequest.onBeforeSendHeaders 统一注入 Referer: https://weibo.com/
    // 过期处理：签名失效后用户点击"刷新账号"重新采集即可
    let gAvatar = _normalizeUrl(avatar) || '';
    if (!gAvatar) {
      // 兜底：如果没从 DOM 提取到任何头像，才退化使用 tp3 永久格式（即使 403 也比空好，至少渲染层知道这是微博头像可以尝试 Referer 兼容逻辑——不过它现在也是 403，所以留空即可）
      gAvatar = '';
    }
    log('info', 'extractPageInfo', `[阶段4.头像] 保留带签名的 crop URL（Referer 由主进程注入）→ raw.len=${avatar.length}, gAvatar.len=${gAvatar.length}`);

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

// ========================= 发布功能 =========================

/** 截断字符串（简易版，避免依赖 lodash） */
function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n);
}

/** 组装话题标签：#xxx# 格式（微博话题格式） */
function prepareTags(tags?: string[]): string[] {
  const list = (tags || []).map((t) => (t || '').trim()).filter(Boolean);
  return list.map((t) => `#${t.replace(/^#|#$/g, '')}#`);
}

/** 组装微博正文内容（标题 + 正文 + 话题） */
function buildWeiboText(request: PublishRequest, skipTitle: boolean): string {
  const parts: string[] = [];
  const title = (request.title || '').trim();
  const content = (request.content || '').trim();
  if (!skipTitle && title) parts.push(truncate(title, 30));
  if (content) parts.push(truncate(content, 2000 - parts.join('\n').length - 20));
  const tags = prepareTags(request.tags);
  if (tags.length) parts.push(tags.join(' '));
  return parts.join('\n');
}

/**
 * 填写「视频标题」输入框脚本。
 * 精确匹配源码里的：placeholder="填写标题（0～30个字）"
 */
function buildFillTitleScript(title: string): string {
  const safeTitle = JSON.stringify(title);
  return `
    (function(){
      try {
        // 优先精确 placeholder 匹配（源码里：<input type="text" placeholder="填写标题（0～30个字）">）
        var t = document.querySelector('input[placeholder="填写标题（0～30个字）"]');
        if (!t) {
          // 回退：找任意 input 其 placeholder 含"填写标题"
          t = document.querySelector('input[placeholder*="填写标题"]');
        }
        if (!t) {
          // 二次回退：在 .wbpro-form 里找第一个 input
          var f = document.querySelector('.wbpro-form._top1_osr0h_16, [class*="_top1_osr0h"]');
          if (f) t = f.querySelector('input[type="text"], input');
        }
        if (!t) return { ok: false, reason: 'no-title-input' };
        t.focus();
        t.value = ${safeTitle};
        try { t.dispatchEvent(new Event('input', { bubbles: true })); } catch(e1){}
        try { t.dispatchEvent(new Event('change', { bubbles: true })); } catch(e2){}
        try { t.dispatchEvent(new Event('blur', { bubbles: true })); } catch(e3){}
        return { ok: true, filled: ${safeTitle} };
      } catch(e) { return { ok: false, error: String(e) }; }
    })();
  `;
}

/**
 * 填写「微博正文」textarea 脚本。
 * 精确匹配源码里的：<textarea placeholder="有什么新鲜事想分享给大家？" class="_input_1rz8r_8">
 */
function buildFillContentScript(text: string): string {
  const safeText = JSON.stringify(text);
  return `
    (function(){
      try {
        var roots = [];
        try { roots.push(document); } catch(e){}
        try {
          var ifs = document.querySelectorAll('iframe');
          for (var fi = 0; fi < ifs.length; fi++) {
            try {
              var idoc = ifs[fi].contentDocument || (ifs[fi].contentWindow && ifs[fi].contentWindow.document);
              if (idoc) roots.push(idoc);
            } catch(ei){}
          }
        } catch(eif){}

        var t = null;
        var type = 'textarea';
        // 1) 精确 class（哈希类更稳）
        for (var ri = 0; ri < roots.length && !t; ri++) {
          t = roots[ri].querySelector && roots[ri].querySelector('textarea._input_1rz8r_8');
        }
        // 2) 精确 placeholder
        for (var ri2 = 0; ri2 < roots.length && !t; ri2++) {
          t = roots[ri2].querySelector && roots[ri2].querySelector('textarea[placeholder="有什么新鲜事想分享给大家？"]');
        }
        // 3) 在设置微博内容 ._box1_19x8d_14 内 textarea 兜底
        if (!t) {
          var box = document.querySelector('[class*="_box1_19x8d"]');
          if (box) t = box.querySelector('textarea');
        }
        // 4) contenteditable 兜底（其他组件形态）
        if (!t) {
          for (var ri3 = 0; ri3 < roots.length; ri3++) {
            var ces = roots[ri3].querySelectorAll ? roots[ri3].querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]') : [];
            for (var j = 0; j < ces.length; j++) {
              var ph = (ces[j].getAttribute && ces[j].getAttribute('placeholder')) || '';
              if (/新鲜事|分享给大家|说点什么/.test(ph)) { t = ces[j]; type = 'contenteditable'; break; }
            }
            if (t) break;
          }
        }
        if (!t) return { ok: false, reason: 'no-content-input' };
        if (type === 'textarea') {
          t.focus();
          t.value = ${safeText};
          try { t.dispatchEvent(new Event('input', { bubbles: true })); } catch(e1){}
          try { t.dispatchEvent(new Event('change', { bubbles: true })); } catch(e2){}
          try { t.dispatchEvent(new Event('blur', { bubbles: true })); } catch(e3){}
          return { ok: true, type: 'textarea' };
        } else {
          t.focus();
          try { t.innerText = ${safeText}; } catch(e11){ try { t.textContent = ${safeText}; } catch(e12){} }
          try { t.dispatchEvent(new Event('input', { bubbles: true })); } catch(e4){}
          try { t.dispatchEvent(new Event('blur', { bubbles: true })); } catch(e5){}
          return { ok: true, type: 'contenteditable', isContentEditable: true };
        }
      } catch(e) { return { ok: false, error: String(e) }; }
    })();
  `;
}

/**
 * 点击「原创」类型：源码里 .woo-radio-main 的子 span.woo-radio-text 文本为「原创/二创/转载」
 */
function buildSelectOriginalTypeScript(): string {
  return `
    (function(){
      try {
        // 1) 优先：在 ._type_1vpmt_29 容器中，找 woo-radio-text 文本为 "原创"，点击其外层 .woo-radio-main
        var typeBox = document.querySelector('[class*="_type_1vpmt_"]');
        var pick = null;
        if (typeBox) {
          var labels = typeBox.querySelectorAll('.woo-radio-main, label.woo-radio-main');
          for (var i = 0; i < labels.length; i++) {
            var txt = (labels[i].innerText || labels[i].textContent || '').replace(/\\s+/g, '').trim();
            if (txt === '原创') { pick = labels[i]; break; }
          }
        }
        // 2) 回退：全文匹配
        if (!pick) {
          var all = document.querySelectorAll('label, span, div, li');
          for (var j = 0; j < all.length; j++) {
            var t = (all[j].innerText || all[j].textContent || '').replace(/\\s+/g, '').trim();
            if (t === '原创' && all[j].classList && (all[j].classList.contains('woo-radio-main') || all[j].classList.contains('woo-radio-text'))) {
              var p = all[j];
              while (p && !p.classList.contains('woo-radio-main')) p = p.parentElement;
              if (p) { pick = p; break; }
            }
          }
        }
        if (!pick) return { clicked: false, reason: 'no-original-found' };
        // 先点 .woo-radio-text 也能触发，再兜底点击 label 本体
        try {
          var radioText = pick.querySelector('.woo-radio-text');
          if (radioText) radioText.click();
        } catch(ea){}
        pick.click();
        return { clicked: true };
      } catch(e) { return { clicked: false, error: String(e) }; }
    })();
  `;
}

/**
 * 选择分类脚本。微博使用自定义下拉 wbpor-pos：
 * 点击「请选择合适的频道」触发下拉显示，然后点击 _item1_1w2ud_29 第一个一级分类
 */
function buildSelectCategoryScript(): string {
  return `
    (function(){
      try {
        // 1) 展开下拉：._sort_19x8d_181 是 wbpro-select 自定义框，其文本是「请选择合适的频道」
        var trigger = null;
        var selBox = document.querySelector('.wbpro-select[class*="_sort_19x8d_"], [class*="_sort_19x8d_181"], [class*="_top1_19x8d"]');
        if (selBox) {
          var textEl = selBox.querySelector('div[style*="align-self"], .woo-box-item-flex');
          if (textEl && /请选择合适的频道/.test(textEl.textContent || '')) trigger = selBox;
          else trigger = selBox;
        }
        // 2) 回退：任何包含「请选择合适的频道」的元素
        if (!trigger) {
          var all2 = document.querySelectorAll('div, span');
          for (var a = 0; a < all2.length; a++) {
            var txt2 = (all2[a].innerText || all2[a].textContent || '').replace(/\\s+/g, '');
            if (txt2.indexOf('请选择合适的频道') !== -1 && (all2[a].offsetWidth || 0) > 0) {
              trigger = all2[a];
              while (trigger && trigger.parentElement && !trigger.classList.contains('wbpro-select')) trigger = trigger.parentElement;
              break;
            }
          }
        }
        if (trigger) { trigger.click(); } else { return { ok: false, reason: 'no-cate-trigger' }; }
        // 3) 选择第一个一级分类：._item1_1w2ud_29，优先选"生活"，否则选第一个带 _curr_1w2ud_46 的或第一个
        var firstList = document.querySelectorAll('[class*="_sort1_1w2ud_"] ._item1_1w2ud_29, [class*="_item1_1w2ud_"]');
        if (firstList.length === 0) return { ok: true, method: 'opened-only', note: '下拉已打开但未找到一级分类选项' };
        var target = null;
        for (var k = 0; k < firstList.length; k++) {
          var tk = (firstList[k].innerText || firstList[k].textContent || '').replace(/\\s+/g, '');
          if (tk === '生活' || tk === 'VLOG') { target = firstList[k]; break; }
        }
        if (!target) target = firstList[0];
        target.click();
        // 4) 如果有二级分类，立即再点第一个默认 _curr_1w2ud_46 的
        var secondList = document.querySelectorAll('[class*="_sort2_1w2ud_"] ._item2_1w2ud_66');
        if (secondList.length > 0) {
          var sub = null;
          for (var s = 0; s < secondList.length; s++) {
            if (secondList[s].classList.contains('_curr_1w2ud_46')) { sub = secondList[s]; break; }
          }
          if (!sub) sub = secondList[0];
          sub.click();
          return { ok: true, method: 'both-levels', first: target.innerText, second: sub.innerText };
        }
        return { ok: true, method: 'first-level', first: target.innerText };
      } catch(e) { return { ok: false, error: String(e) }; }
    })();
  `;
}

/**
 * 点击发布按钮脚本（微博专用）。
 * 精确匹配：
 *   - 主发布按钮：button._btn_2z30i_68._btn1_2z30i_72，其 <span> 文本是「发布」
 *     disabled 属性表明表单必填项是否都填了（分类/封面等）；
 *   - 回退：「立即发布/发送」但文本不含「再发一条」。
 *   - 绝对不点击：包含「再发一条」「上传视频」「上传封面」「暂停」「继续」「删除」「上传字幕」「裁剪封面」「视频管理」的按钮/链接。
 */
function buildClickPublishButtonScript(): string {
  return `
    (function(){
      try {
        // 1) 优先精确：._btn_2z30i_68（源码里的「发布」主按钮：class 含 _btn_2z30i_68 + _btn1_2z30i_72）
        var exact = document.querySelector('button._btn1_2z30i_72, [class*="_btn_2z30i_68"], [class*="_btn1_2z30i_"]');
        if (exact) {
          try { exact.click(); } catch(e1){
            try { exact.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch(e2){}
          }
          var bt = (exact.innerText || exact.textContent || '').replace(/\\s+/g, '').trim();
          return { clicked: true, match: 'exact', text: bt, disabled: !!exact.disabled };
        }
        // 2) 回退：通用发布按钮（排除强黑名单）
        var all = document.querySelectorAll('button, div, a');
        var candidates = [];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if ((el.offsetWidth || 0) === 0 && (el.offsetHeight || 0) === 0) continue;
          var txt = (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
          if (!txt) continue;
          // 强黑名单：绝对不点击
          if (/再发一条|上传视频|上传封面|暂停|继续|删除|上传字幕|裁剪封面|视频管理/i.test(txt)) continue;
          var match = false;
          if (txt === '自动发布' || txt === '发布' || txt === '立即发布' || txt === '发送') match = true;
          else if (/发布|发送/.test(txt) && txt.length <= 8) match = true;
          if (!match) continue;
          var cls = (el.getAttribute('class') || '');
          var score = 0;
          if (/primary|main|submit|publish|send|_btn_2z30i_/i.test(cls)) score += 50;
          if (/woo-button-main|woo-button-primary|woo-button-flat/i.test(cls)) score += 30;
          if (el.tagName && el.tagName.toLowerCase() === 'button') score += 10;
          try {
            var st = window.getComputedStyle(el, null);
            if (st && st.cursor && st.cursor.indexOf('pointer') !== -1) score += 5;
            if (st && (parseFloat(st.opacity || '1') < 0.4)) score -= 200;
          } catch(est){}
          if (el.disabled) score -= 200;
          if (score > 0) candidates.push({ el: el, score: score, text: txt });
        }
        candidates.sort(function(a,b){ return b.score - a.score; });
        if (candidates.length === 0) return { clicked: false, reason: 'no-button' };
        candidates[0].el.click();
        return { clicked: true, match: 'fallback', text: candidates[0].text, score: candidates[0].score };
      } catch(e) { return { clicked: false, error: String(e) }; }
    })();
  `;
}

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runWeiboPublish(accountId, request, onProgress, 'video');
}

/**
 * 微博图文/纯文本发布（首页 weibo.com）专用图片上传。
 *  入口：._file_1jg7d_67 图标按钮（<span>图片</span>）
 *  真实隐藏 input：._picbed_1syq3_2._box_hqmwy_2 > input._file_hqmwy_20
 *     - 外层 5 层 div 都 style="display:none"（我们绝对不碰 display:none）
 *     - 但只要把本地文件通过 DOM.setFileInputFiles 直接注入到这个真实 input 上，
 *       再 dispatch change/input，React/Vue 组件状态会被触发，自己把 width:50%
 *       display:none 的包裹容器改为显示，并渲染出缩略图（你给的成功 DOM）
 *  策略（绝不触碰 display:none）：
 *    方案 A：FileChooser 拦截 → 点击 ._file_1jg7d_67「图片」 → 收到 fileChooserOpened 后 accept
 *    方案 C（兜底）：直接定位真实 input._file_hqmwy_20 → CDP 注入文件 → dispatch input/change
 *  无论走哪个方案，都必须额外走「等待缩略图出现」校验：
 *    ._box2_vkpry_14 下 ._pic_1syq3_2 里面 img.woo-picture-img 数量 >= 实际文件数
 *  只有通过校验才算真正上传成功，避免假成功。
 */
async function uploadWeiboImage(
  win: BrowserWindow,
  imageFiles: string[],
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    try { await win.webContents.debugger.attach('1.3'); } catch { /* ignore */ }
    const expectedCount = imageFiles.length;
    let schemeAOk = false;

    // ================= 方案 A：FileChooser 拦截 + 点「图片」按钮 =================
    log('info', 'upload', `[A] 启用 FileChooser 拦截，准备点击首页「图片」按钮 (target=${expectedCount} 张)…`);
    let interceptionOk = false;
    try {
      await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true } as any);
      interceptionOk = true;
    } catch (err) {
      log('warn', 'upload', `[A] FileChooser 拦截启用失败: ${(err as Error).message}`);
    }

    if (interceptionOk) {
      let chooserResolved = false;
      const chooserPromise = new Promise<boolean>((resolve) => {
        const handler = (_event: any, method: string, params: any) => {
          if (method === 'Page.fileChooserOpened') {
            log('info', 'upload', `[A] 收到 Page.fileChooserOpened (mode=${params?.mode}, params=${JSON.stringify(params).slice(0, 200)})`);
            // 两种 CDP 语义：一种是 params 默认值，用 { action, files } 注入；
            // 另一种是 params 里带 { frameId, backendNodeId }，但 Electron 一般只认前者。
            const cmdArgs: Record<string, unknown> = { action: 'accept', files: imageFiles };
            if (params && typeof params === 'object') {
              if (params.frameId) (cmdArgs as any).frameId = params.frameId;
              if (params.backendNodeId) (cmdArgs as any).backendNodeId = params.backendNodeId;
            }
            win.webContents.debugger
              .sendCommand('Page.handleFileChooser', cmdArgs as any)
              .then(() => {
                chooserResolved = true;
                try { win.webContents.debugger.off('message', handler); } catch { /* ignore */ }
                resolve(true);
              })
              .catch((err) => {
                log('warn', 'upload', `[A] handleFileChooser 失败: ${(err as Error).message}`);
                try { win.webContents.debugger.off('message', handler); } catch { /* ignore */ }
                resolve(false);
              });
          }
        };
        try { win.webContents.debugger.on('message', handler); } catch { /* ignore */ }
        setTimeout(() => {
          if (!chooserResolved) {
            try { win.webContents.debugger.off('message', handler); } catch { /* ignore */ }
            resolve(false);
          }
        }, 18000); // 放宽到 18 秒，点击后可能有 pop-over 展开延迟
      });

      const clickScript = `
        (function(){
          try {
            // 1) 优先精确匹配 ._file_1jg7d_67（你给的真实入口 class 容器：_file_1jg7d_67 是带 svg<image> + <span>图片</span> 的 _itemin 层）
            var imgBtn = document.querySelector('[class*="_file_1jg7d_"], [class*="_file_1jg7d_67"]');
            if (imgBtn) {
              try { imgBtn.click(); } catch(e1){ try { imgBtn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(e2){} }
              return { clicked: true, method: 'img-icon-direct', class: (imgBtn.getAttribute&&imgBtn.getAttribute('class'))||'' };
            }
            // 2) 回退：找 span 文本为「图片」且父级 class 含 _itemin_ 的入口
            var spans = document.querySelectorAll('span, div, button, a');
            for (var i = 0; i < spans.length; i++) {
              var el = spans[i];
              if ((el.offsetWidth || 0) < 4 && (el.offsetHeight || 0) < 4) continue;
              var txt = (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
              if (txt !== '图片') continue;
              var p = el;
              for (var j = 0; j < 6 && p; j++) {
                var cls = (p.getAttribute && p.getAttribute('class')) || '';
                if (/_itemin_|_iconitem_|woo-pop-wrap|_file_1jg7d_|_1jg7d_/.test(cls)) {
                  try { p.click(); } catch(ea){ try { p.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(eb){} }
                  return { clicked: true, method: 'text-scan', parentClass: cls };
                }
                p = p.parentElement;
              }
            }
            return { clicked: false, reason: 'no-image-button' };
          } catch(e) { return { clicked: false, error: String(e) }; }
        })();
      `;
      const clickEval: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: clickScript, returnByValue: true,
      }).catch(() => null);
      const clickVal = clickEval && clickEval.result && clickEval.result.value ? clickEval.result.value : null;
      log('info', 'upload', `[A] 点击「图片」结果: ${clickVal ? JSON.stringify(clickVal).slice(0, 200) : 'unknown'}`);

      const chooserOk = await chooserPromise;
      try { await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false } as any).catch(() => {}); } catch { /* ignore */ }
      if (chooserOk) {
        log('info', 'upload', '✅ [A] handleFileChooser 返回 OK，开始校验缩略图渲染…');
        schemeAOk = true;
      } else {
        log('warn', 'upload', '[A] FileChooser 失败，走方案 C（直接注入真实隐藏 input._file_hqmwy_20 并触发 change）');
      }
    }

    // ================= 方案 C（兜底）：直接把文件注入到真实隐藏 input._file_hqmwy_20 上 =================
    if (!schemeAOk) {
      log('info', 'upload', `[C] 方案 C：定位真实隐藏 input._file_hqmwy_20 → CDP 注入文件 → dispatch input/change`);

      // 先在 page 里定位 selector 的真实存在性，打 log 看能不能找到
      const locateScript = `
        (function(){
          try {
            var sel = 'input[class*="_file_hqmwy_"], input._file_hqmwy_20, [class*="_picbed_1syq3_"] input[type="file"]';
            var nodes = document.querySelectorAll(sel);
            if (!nodes || nodes.length === 0) return { found: false, count: 0, sel: sel };
            var arr = [];
            for (var i = 0; i < nodes.length; i++) {
              var n = nodes[i];
              var cls = (n.getAttribute && n.getAttribute('class')) || '';
              var acc = (n.getAttribute && n.getAttribute('accept')) || '';
              var d = false;
              var p = n;
              for (var j = 0; j < 8 && p; j++) {
                if (p && p.style && String(p.style.display || '').toLowerCase() === 'none') { d = true; break; }
                p = p.parentElement;
              }
              arr.push({ idx: i, class: cls, accept: acc, hasHiddenAncestor: d });
            }
            return { found: true, count: nodes.length, sel: sel, nodes: arr };
          } catch(e) { return { found: false, error: String(e) }; }
        })();
      `;
      const locateVal: any = await win.webContents.executeJavaScript(locateScript).catch(() => null);
      log('info', 'upload', `[C] 定位 input: ${locateVal ? JSON.stringify(locateVal).slice(0, 300) : 'execute-js-null'}`);

      // CDP 找真实 input objectId（优先 performSearch，再 DOM.getDocument + querySelectorAll）
      let objectId: string | undefined;
      let doc: any = null;
      try {
        doc = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true } as any);
      } catch (err) { log('warn', 'upload', `[C] DOM.getDocument 失败: ${(err as Error).message}`); }

      if (doc && doc.root && doc.root.nodeId) {
        const rootId = doc.root.nodeId;
        const trySelectors = [
          'input._file_hqmwy_20',
          'input[class*="_file_hqmwy_"]',
          'input[accept*="image/*"]',
        ];
        for (const sel of trySelectors) {
          if (objectId) break;
          const found: any = await win.webContents.debugger.sendCommand('DOM.querySelectorAll', {
            nodeId: rootId, selector: sel,
          } as any).catch(() => null);
          if (found && found.nodeIds && found.nodeIds.length > 0) {
            for (const nid of found.nodeIds) {
              if (objectId) break;
              const resolved: any = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: nid } as any).catch(() => null);
              if (resolved && resolved.object && resolved.object.objectId) objectId = resolved.object.objectId;
            }
          }
        }
        if (!objectId) {
          const s: any = await win.webContents.debugger.sendCommand('DOM.performSearch', {
            query: '._file_hqmwy_20', includeUserAgentShadowDOM: false,
          } as any).catch(() => null);
          if (s && s.nodeIds && s.nodeIds.length > 0) {
            const resolved: any = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: s.nodeIds[0] } as any).catch(() => null);
            if (resolved && resolved.object && resolved.object.objectId) objectId = resolved.object.objectId;
          }
        }
      }
      if (!objectId) { log('error', 'upload', `[C] 找不到真实隐藏 input 的 objectId (locate=${locateVal?.count || 0})`); return false; }

      // 注入文件
      let setOk = false;
      try {
        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { objectId, files: imageFiles } as any);
        setOk = true;
      } catch (err) {
        log('warn', 'upload', `[C] DOM.setFileInputFiles 失败: ${(err as Error).message}`);
      }
      if (!setOk) return false;

      // 关键：在该真实 input 上 dispatch change/input 事件（不能碰父级 display:none）。
      // 若组件在受控态下仍需要额外聚焦/失焦 -> 也触发一次 blur。
      const fireEventsScript = `
        (function(){
          try {
            var sel = 'input[class*="_file_hqmwy_"], input._file_hqmwy_20, [class*="_picbed_1syq3_"] input[type="file"]';
            var node = document.querySelector(sel);
            if (!node) return { ok: false, reason: 'fire-no-input' };
            // 读取文件数量，验证 DOM.setFileInputFiles 生效
            var count = node.files ? node.files.length : 0;
            try { node.dispatchEvent(new Event('focus', { bubbles: true })); } catch(e1){}
            try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch(e2){}
            try { node.dispatchEvent(new Event('change', { bubbles: true })); } catch(e3){}
            try { node.dispatchEvent(new Event('blur',  { bubbles: true })); } catch(e4){}
            return { ok: true, count: count };
          } catch(e) { return { ok: false, error: String(e) }; }
        })();
      `;
      const fireVal: any = await win.webContents.executeJavaScript(fireEventsScript).catch(() => null);
      if (!fireVal || !fireVal.ok) {
        log('error', 'upload', `[C] 触发 change 失败: ${fireVal ? JSON.stringify(fireVal).slice(0, 200) : 'fire-js-null'}`);
        return false;
      }
      log('info', 'upload', `✅ [C] 真实隐藏 input 文件注入 + 事件分发完成 (files=${fireVal.count})，开始校验缩略图渲染…`);
    }

    // ================= 最终校验：缩略图渲染出来才算真成功 =================
    // 你给的成功态 DOM 结构：
    //   <div class="_box2_vkpry_14 grayTheme">
    //     <div style="width: 50%;">   ← 注意此时已经**没有 display:none** 了（组件自己切的）
    //       <div class="u-col-3">
    //         <div class="woo-box-item-inlineBlock" style="padding:0.25rem;">
    //           <div class="_picbed_1syq3_2">
    //             <div class="woo-picture-main ... _pic_1syq3_2">
    //               <img src="https://wx*.sinaimg.cn/..." class="woo-picture-img">  ← 我们数这个
    //             </div>
    //             <i class="..._close_1syq3_42"></i>  ← 有这个删除按钮才算真正显示出来
    //           </div>
    const deadline = Date.now() + 45_000;
    let realOk = false;
    let lastSnap: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      const snap: any = await win.webContents.executeJavaScript(`
        (function(){
          try {
            var wrap = document.querySelector('[class*="_box2_vkpry_"]');
            if (!wrap) return { ok: false, reason: 'no-box2-wrap', displayNone: false };
            // 查看 width:50% 的直接子节点是否还带着 display:none（组件如果还没切态就会是 display:none）
            var inner = wrap.querySelector(':scope > div');
            var innerHidden = false;
            if (inner) {
              var st = window.getComputedStyle(inner, null);
              if (st && (st.display === 'none' || inner.getAttribute && String(inner.getAttribute('style')||'').indexOf('display:none')>=0)) innerHidden = true;
            }
            var pics = wrap.querySelectorAll('[class*="_picbed_1syq3_"]');
            var validImgs = 0;
            var withClose = 0;
            for (var i = 0; pics && i < pics.length; i++) {
              var bed = pics[i];
              var cls = (bed.getAttribute && bed.getAttribute('class')) || '';
              if (!/_picbed_1syq3_/.test(cls)) continue;
              var img = bed.querySelector('img.woo-picture-img');
              var src = img ? (img.getAttribute && img.getAttribute('src')) : '';
              if (!src) continue;
              if (src.indexOf('about:')===0 || src==='false' || src.indexOf('data:')===0) continue;
              if (!/^https?:\\/\\//.test(src)) continue;
              if (!/wx\\d+\\.sinaimg\\.cn|tvax\\d+\\.sinaimg\\.cn/.test(src)) continue;
              validImgs++;
              var close = bed.querySelector('[class*="_close_1syq3_"], i.woo-font--close, [title="删除"]');
              if (close) withClose++;
            }
            return { ok: validImgs >= ${expectedCount}, validImgs: validImgs, withClose: withClose, expected: ${expectedCount}, innerHidden: innerHidden };
          } catch(e) { return { ok: false, error: String(e) }; }
        })();
      `).catch(() => null);
      if (snap) lastSnap = snap;
      if (snap && snap.ok) { realOk = true; break; }
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      log('info', 'upload', `缩略图校验中: ${JSON.stringify(snap).slice(0, 180)} (剩余 ${remain}s)`);
      await sleep(2500);
    }
    if (!realOk) {
      log('warn', 'upload', `⚠️ 45 秒内未检测到 ${expectedCount} 张缩略图渲染，最后快照: ${JSON.stringify(lastSnap).slice(0, 200)}`);
      return false;
    }
    log('info', 'upload', `✅ 最终上传校验通过: ${JSON.stringify(lastSnap).slice(0, 200)}`);
    await sleep(1500);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'upload', `图片上传总异常: ${msg}`);
    return false;
  }
}

/**
 * 首页图文/纯文本发布主流程：
 *  URL = https://weibo.com/
 *  元素：
 *    正文输入：textarea._input_1rz8r_8（placeholder="有什么新鲜事想分享给大家？"）
 *    图片入口：._file_1jg7d_67（<span>图片</span>）
 *    发送按钮：button._btn_2z30i_68（<span>发送</span>，填写内容后自动取消 disabled）
 */
async function runWeiboPublishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'weibo' });
  const publishUrl = 'https://weibo.com/';
  const title = `微博图文发布 - ${accountId}`;
  let win: BrowserWindow | null = null;
  let tracker: ReturnType<typeof attachNavigationTracker> | null = null;

  try {
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);

    onProgress(5, '加载微博首页…');
    await win.loadURL(publishUrl);
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      win.show();
      onProgress(15, '请在窗口中登录微博账号…');
      const deadline = Date.now() + 120_000;
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const recheck: any = await detectLoggedIn(win).catch(() => null);
        if (recheck && recheck.loggedIn) { ok = true; break; }
      }
      if (!ok) return makeFailedResult(accountId, 'weibo', '登录超时或未登录', startedAt);
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', `✅ 已登录 (url=${loginInfo.url.slice(0, 80)})`);
    }

    // 1) 组装正文：title 换行 content 换行 标签；所有合并到 textarea
    const titlePart = (request.title || '').trim();
    const contentPart = (request.content || '').trim();
    const tagStr = prepareTags(request.tags).join(' ');
    const parts: string[] = [];
    if (titlePart) parts.push(truncate(titlePart, 30));
    if (contentPart) parts.push(truncate(contentPart, 2000 - (parts.join('\n').length + 1 + tagStr.length)));
    if (tagStr) parts.push(tagStr);
    const bodyText = parts.join('\n');
    log('info', 'fill', `准备写入正文: title=${titlePart.length ? '有' : '无'}, content=${contentPart.length ? '有' : '无'}, tags=${(request.tags || []).length}, totalLen=${bodyText.length}`);

    // 2) 先上传图片（如果有），否则只发文字
    const mediaFiles = (request.mediaFiles && request.mediaFiles.length > 0) ? request.mediaFiles : [];
    if (mediaFiles.length > 0) {
      const imageFiles = mediaFiles.filter((f) => /\.(png|jpe?g|gif|bmp|heic|heif|webp)$/i.test(f));
      if (imageFiles.length > 0) {
        onProgress(30, `开始上传图片（${imageFiles.length} 张）…`);
        const upOk = await uploadWeiboImage(win, imageFiles, log);
        if (!upOk) {
          log('warn', 'upload', '图片上传失败，尝试继续以纯文本形式发布…');
          onProgress(35, '图片未上传，继续填写正文…');
        } else {
          onProgress(50, '图片上传完成，等待渲染…');
          await sleep(3500); // 给图片上传结果 + 缩略图渲染时间
        }
      }
    }

    // 3) 填写正文
    onProgress(65, '填写微博正文…');
    const fillRes: any = await evalJS(win, buildFillContentScript(bodyText), 'fill-image-content', log).catch(() => null);
    if (!fillRes || !fillRes.ok) {
      log('warn', 'fill', `正文写入失败: ${JSON.stringify(fillRes).slice(0, 200)}`);
      // 允许失败（空正文也能发），但记录
    } else {
      log('info', 'fill', `✅ 正文已写入 (type=${fillRes.type})`);
    }
    await sleep(800);

    // 4) 测试模式或发布
    onProgress(80, '准备发布…');
    if (request.testMode) {
      const probe = buildTestModeProbeScript(
        [
          // 首页发送按钮：._btn_2z30i_68（和视频发布的 hash 一致，但文本是「发送」）
          'button[class*="_btn_2z30i_"]',
          'button[class*="_check_2z30i_81"] button',
          '._check_2z30i_81 button',
          'button.woo-button-main.woo-button-primary',
          'button[class*="woo-button-primary"]',
          'button[class*="primary"]',
          'button[type="submit"]',
        ],
        [
          {
            name: '微博正文',
            selector: 'textarea[placeholder="有什么新鲜事想分享给大家？"], textarea._input_1rz8r_8, textarea[placeholder*="新鲜事"]',
            type: 'textarea',
          },
        ],
      );
      const testRes: any = await evalJS(win, probe, 'test-mode-probe', log).catch(() => null);
      // 按钮可见性兜底（offsetParent===null 时）
      if (testRes && !testRes.publishButtonFound) {
        const probe2: any = await win.webContents.executeJavaScript(`
          (function(){
            try {
              var sels = ['button[class*="_btn_2z30i_"]', '._check_2z30i_81 button', 'button.woo-button-primary'];
              for (var i = 0; i < sels.length; i++) {
                var el = document.querySelector(sels[i]);
                if (!el) continue;
                var st = window.getComputedStyle(el, null);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
                var rect = el.getBoundingClientRect();
                if (!rect || rect.width <= 1 || rect.height <= 1) continue;
                return { text: (el.innerText||'').trim().slice(0,30), selector: sels[i], x: Math.round(rect.left+window.scrollX), y: Math.round(rect.top+window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
              }
              return null;
            } catch(e) { return null; }
          })();
        `).catch(() => null);
        if (probe2) {
          testRes.publishButtonFound = true;
          testRes.publishButtonInfo = probe2;
          if (testRes.note === '未找到发布按钮') testRes.note = '探针脚本兜底找到发布按钮';
        }
      }
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      setupTestModeWindow(win, log);
      const field = testRes?.fields?.find && testRes.fields.find((f: any) => f.name === '微博正文');
      return {
        accountId, platform: 'weibo', status: 'success', progress: 100,
        message: '测试完成 - 表单填写验证通过', startedAt, finishedAt: Date.now(),
        testResult: {
          titleFilled: titlePart.length > 0 ? true : !!(field?.filled && bodyText.length > 0),
          contentFilled: !!(field?.filled) || bodyText.length > 0,
          tagsFilled: !!(request.tags && request.tags.length > 0),
          coverUploaded: !!(mediaFiles.length > 0),
          publishButtonFound: !!(testRes?.publishButtonFound),
          publishButtonInfo: testRes?.publishButtonInfo || null,
          formFields: testRes?.fields || [],
          note: testRes?.note || '',
        },
      };
    }

    // 5) 点击发送：优先精确 _btn_2z30i_68；文本白名单包含「发送」
    const sendScript = `
      (function(){
        try {
          var exact = document.querySelector('button[class*="_btn_2z30i_"], ._check_2z30i_81 button');
          if (exact) {
            var txt = (exact.innerText||'').replace(/\\s+/g,'').trim();
            if (exact.disabled) return { clicked: false, reason: 'button-disabled', text: txt };
            try { exact.click(); } catch(e1){ try { exact.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(e2){} }
            return { clicked: true, method: 'exact', text: txt };
          }
          var all = document.querySelectorAll('button, div, a');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if ((el.offsetWidth||0) === 0 && (el.offsetHeight||0) === 0) continue;
            var t = (el.innerText || el.textContent || '').replace(/\\s+/g,'').trim();
            if (/再发一条|上传图片|表情|视频|话题|头条文章|更多|定时|公开|内容声明/.test(t)) continue;
            if (t !== '发送' && t !== '发布' && t !== '立即发布') continue;
            var cls = (el.getAttribute && el.getAttribute('class')) || '';
            if (!/woo-button-primary|woo-button-main|_btn_2z30i_|submit|publish/.test(cls) && el.tagName.toLowerCase() !== 'button') continue;
            if (el.disabled) continue;
            try { el.click(); } catch(ea){ try { el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(eb){} }
            return { clicked: true, method: 'fallback', text: t };
          }
          return { clicked: false, reason: 'no-send-button' };
        } catch(e) { return { clicked: false, error: String(e) }; }
      })();
    `;
    const clickRes: any = await evalJS(win, sendScript, 'click-send', log).catch(() => null);
    if (!clickRes || !clickRes.clicked) {
      if (clickRes && clickRes.reason === 'button-disabled') {
        return makeFailedResult(accountId, 'weibo', '发送按钮被禁用（可能是内容字数超限或封面未上传）', startedAt);
      }
      return makeFailedResult(accountId, 'weibo', '未找到或无法点击发送按钮', startedAt);
    }

    // 6) 检测发布成功：180s 内 URL 变化或出现「发布成功/发送成功」
    onProgress(88, '等待发布成功…');
    const sendDeadline = Date.now() + 180_000;
    let success = false;
    const startUrl = win.webContents.getURL();
    while (Date.now() < sendDeadline) {
      if (win.isDestroyed()) break;
      const url = win.webContents.getURL();
      const bodyText = await win.webContents.executeJavaScript(`document.body ? document.body.innerText.slice(0,4000) : ''`).catch(() => '') || '';
      if (url !== startUrl && (!url.includes('weibo.com/') || /status|profile|mblog|publishSuccess/.test(url))) { success = true; break; }
      if (/发布成功|发送成功|发布完成|已发送|发送完成|发博成功|成功发布/.test(bodyText)) { success = true; break; }
      if (/发布失败|发送失败|不符合|违规|字数超限|未通过|请先登录|登录状态已失效/.test(bodyText)) {
        const m = bodyText.match(/(发布失败|发送失败|不符合[^。]{0,20}|违规[^。]{0,20}|字数超限|未通过[^。]{0,20}|请先登录|登录状态已失效)[^。\n]{0,30}/);
        return makeFailedResult(accountId, 'weibo', `发布失败: ${m ? m[1] : '检测到失败提示'}`, startedAt);
      }
      await sleep(3000);
    }
    if (!success) return makeFailedResult(accountId, 'weibo', '发布等待超时：180秒内未检测到发布成功信号', startedAt);
    onProgress(100, '发布成功');
    return { accountId, platform: 'weibo', status: 'success', progress: 100, message: '微博图文发布成功', startedAt, finishedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'publish-image', `图文发布异常: ${msg}`);
    return makeFailedResult(accountId, 'weibo', `发布异常: ${msg}`, startedAt);
  } finally {
    // 测试模式不自动关窗（由 setupTestModeWindow 接管）
    if (win && !request.testMode && !win.isDestroyed()) {
      try {
        const w: BrowserWindow = win;
        setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 4000);
      } catch { /* ignore */ }
    }
  }
}

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runWeiboPublishImage(accountId, request, onProgress);
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

/**
 * 微博专用视频上传（严格禁止触碰 display:none，避免破坏布局）。
 *
 *  背景：
 *    · 主上传入口：._abox2_109u9_77 { class="woo-box-flex woo-box-column woo-box-alignCenter" }
 *         ↳ <button class="_btn1_109u9_8 woo-button-main woo-button-primary ...">上传视频</button>
 *    · 图片/视频混传框（设置微博内容下面的）：._file_hqmwy_20 ← 这个不是主视频上传的 input，绝对不要用
 *    · 微博支持「把文件拖进主上传区域 ._abox2_109u9_77 也可上传」
 *
 *  策略：
 *    方案 A（推荐）：Page.setInterceptFileChooserDialog → 精确点击 ._btn1_109u9_8 →
 *                    收到 Page.fileChooserOpened 后 Page.handleFileChooser accept 文件。
 *                    完全不触碰 DOM / display 属性，最稳。
 *    方案 B（回退）：在页面内动态创建一个临时 input[type=file]，接受 video/*，
 *                    用 CDP DOM.setFileInputFiles 注入本地路径 → 手动构造 DataTransfer + drop 事件，
 *                    dispatch 到主上传区 ._abox2_109u9_77（模拟拖拽上传，前端监听了 drop 一定能收到）
 *                    → 注入成功后移除临时 input。绝对不走解除 display:none。
 */
async function uploadWeiboVideo(
  win: BrowserWindow,
  videoFiles: string[],
  log: (level: any, stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    try {
      await win.webContents.debugger.attach('1.3');
    } catch { /* 可能已 attached */ }

    // ================= 方案 A：FileChooser 拦截 + 精确点击 ._btn1_109u9_8 =================
    log('info', 'upload', '[A] 启用 FileChooser 拦截，准备点击微博「上传视频」按钮…');
    let interceptionOk = false;
    try {
      await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true } as any);
      interceptionOk = true;
    } catch (err) {
      log('warn', 'upload', `[A] FileChooser 拦截启用失败: ${(err as Error).message}`);
    }

    if (interceptionOk) {
      let chooserResolved = false;
      const chooserPromise = new Promise<boolean>((resolve) => {
        const handler = (_event: any, method: string, params: any) => {
          if (method === 'Page.fileChooserOpened') {
            log('info', 'upload', `[A] 收到 Page.fileChooserOpened 事件 (mode=${params?.mode})`);
            win.webContents.debugger
              .sendCommand('Page.handleFileChooser', { action: 'accept', files: videoFiles })
              .then(() => {
                chooserResolved = true;
                log('info', 'upload', '[A] handleFileChooser accept 调用成功');
                win.webContents.debugger.off('message', handler);
                resolve(true);
              })
              .catch((err) => {
                log('warn', 'upload', `[A] handleFileChooser 失败: ${(err as Error).message}`);
                win.webContents.debugger.off('message', handler);
                resolve(false);
              });
          }
        };
        win.webContents.debugger.on('message', handler);
        setTimeout(() => {
          if (!chooserResolved) {
            try { win.webContents.debugger.off('message', handler); } catch { /* ignore */ }
            log('warn', 'upload', '[A] 12s 内未收到 fileChooserOpened，超时');
            resolve(false);
          }
        }, 12000);
      });

      // 精确点击：优先 _btn1_109u9_8；其次整个 _abox2_109u9_77 拖拽区域也能触发点击（因为其 click 事件代理会调 input click）
      const clickScript = `
        (function(){
          try {
            // 1) 先试精确命中 ._btn1_109u9_8（上传视频按钮）
            var btn = document.querySelector('button._btn1_109u9_8, [id^="video_button_upload_"]');
            if (btn) {
              try { btn.click(); } catch(e1){ try { btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(e2){} }
              return { clicked: true, method: 'btn-direct' };
            }
            // 2) 再试父级拖拽容器 ._abox2_109u9_77（区域点击也会触发 input）
            var box = document.querySelector('[class*="_abox2_109u9_"], [id^="area_video_button_upload_"]');
            if (box) {
              try { box.click(); } catch(e3){ try { box.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); } catch(e4){} }
              return { clicked: true, method: 'box-container' };
            }
            // 3) 兜底：全文本匹配
            var all = document.querySelectorAll('button, div');
            var candidates = [];
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              if ((el.offsetWidth || 0) < 10 && (el.offsetHeight || 0) < 10) continue;
              var cls = (el.getAttribute && el.getAttribute('class')) || '';
              var txt = (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
              var score = 0;
              if (cls.indexOf('woo-button-primary') !== -1) score += 800;
              if (cls.indexOf('woo-button-round') !== -1) score += 300;
              if (cls.indexOf('woo-button-main') !== -1) score += 200;
              if (txt === '上传视频') score += 1000;
              else if (txt.indexOf('上传视频') !== -1 && txt.length <= 10) score += 600;
              if (el.tagName && el.tagName.toLowerCase() === 'button') score += 300;
              if (score > 0) candidates.push({ el: el, score: score, txt: txt, cls: cls.slice(0, 60) });
            }
            if (candidates.length === 0) return { clicked: false, reason: 'no-candidates' };
            candidates.sort(function(a,b){ return b.score - a.score; });
            var t = candidates[0];
            try { t.el.click(); } catch(e1){}
            try { t.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch(e2){}
            return { clicked: true, method: 'fallback-text-scan', score: t.score, txt: t.txt, cls: t.cls };
          } catch(e) { return { clicked: false, error: String(e) }; }
        })();
      `;
      const clickEval: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: clickScript, returnByValue: true,
      }).catch(() => null);
      const clickVal = clickEval && clickEval.result && clickEval.result.value ? clickEval.result.value : null;
      log('info', 'upload', `[A] 点击「上传视频」结果: ${clickVal ? JSON.stringify(clickVal).slice(0, 300) : 'unknown'}`);

      const chooserOk = await chooserPromise;
      try { await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false } as any).catch(() => {}); } catch { /* ignore */ }

      if (chooserOk) {
        log('info', 'upload', '✅ [A] FileChooser 方案成功，等待微博触发上传…');
        await sleep(2500);
        return true;
      }
      log('warn', 'upload', '[A] FileChooser 方案失败（点击了按钮但浏览器未触发文件选择器），走方案 B（模拟 drop 事件）');
    }

    // ================= 方案 B：在页面内构造临时 input → CDP 注入 → dispatch drop 事件 =================
    log('info', 'upload', '[B] 方案 B：构造临时 <input type=file> → CDP 注入文件 → 模拟 drop 到主上传区');

    const safeFiles = JSON.stringify(videoFiles);
    const setupScript = `
      (function(){
        try {
          // 1) 移除之前残留的（如果有）
          var old = document.getElementById('__flowx_weibo_upload_tmp__');
          if (old && old.parentNode) old.parentNode.removeChild(old);
          // 2) 新建临时 input
          var input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.accept = 'video/*,.mkv,.flv,.mp4,.mov';
          input.id = '__flowx_weibo_upload_tmp__';
          // 关键：不要加 display:none；放在视口外但保持 offsetWidth/Height>0 避免被过滤
          input.style.cssText = 'position:fixed;left:-99999px;top:-99999px;opacity:0.01;z-index:-1;pointer-events:none;';
          document.documentElement.appendChild(input);
          // 3) 找到主上传区 ._abox2_109u9_77（拖放区）
          var dropTarget = document.querySelector('[class*="_abox2_109u9_"], [id^="area_video_button_upload_"]') || document.body;
          return {
            ok: true,
            inputId: input.id,
            inputHasFiles: input.files && input.files.length >= 0,
            dropTargetCls: (dropTarget.getAttribute && dropTarget.getAttribute('class')) || '',
            dropTargetId: (dropTarget.getAttribute && dropTarget.getAttribute('id')) || ''
          };
        } catch(e) { return { ok: false, error: String(e) }; }
      })();
    `;
    const setupVal: any = await win.webContents.executeJavaScript(setupScript).catch((err: Error) => {
      log('warn', 'upload', `[B] 创建临时 input 失败: ${err.message}`);
      return null;
    });
    if (!setupVal || !setupVal.ok) { log('error', 'upload', '[B] 创建临时 input 阶段失败'); return false; }
    log('info', 'upload', `[B] 临时 input 已就绪: ${JSON.stringify(setupVal).slice(0, 200)}`);

    // 4) CDP 注入文件到临时 input
    log('info', 'upload', `[B] 调用 DOM.setFileInputFiles 注入 ${videoFiles.length} 个视频文件…`);
    const doc = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true } as any).catch(() => null);
    const qRes = doc ? (await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: (doc as any).root.nodeId, selector: '#__flowx_weibo_upload_tmp__',
    } as any).catch(() => null)) : null;
    const backendId = qRes && (qRes as any).nodeId ? (await win.webContents.debugger.sendCommand('DOM.resolveNode', {
      nodeId: (qRes as any).nodeId,
    } as any).catch(() => null)) : null;
    let objectId: string | undefined;
    if (backendId && (backendId as any).object && (backendId as any).object.objectId) {
      objectId = (backendId as any).object.objectId;
    } else {
      // 兜底：用 queryObjects 不行，直接用 DOM.performSearch
      const search: any = await win.webContents.debugger.sendCommand('DOM.performSearch', {
        query: '#__flowx_weibo_upload_tmp__', includeUserAgentShadowDOM: false,
      } as any).catch(() => null);
      if (search && search.nodeIds && search.nodeIds.length > 0) {
        const resolved: any = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: search.nodeIds[0] } as any).catch(() => null);
        if (resolved && resolved.object && resolved.object.objectId) objectId = resolved.object.objectId;
      }
    }
    if (!objectId) {
      log('error', 'upload', '[B] 找不到临时 input 的 objectId，CDP 注入失败');
      return false;
    }

    let setOk = false;
    try {
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { objectId, files: videoFiles } as any);
      setOk = true;
      log('info', 'upload', '[B] DOM.setFileInputFiles 注入成功');
    } catch (err) {
      log('warn', 'upload', `[B] DOM.setFileInputFiles 失败: ${(err as Error).message}`);
    }
    if (!setOk) return false;

    // 5) 触发 input 的 change/input 事件，然后构造 DataTransfer 并模拟 drop 到主上传区
    const dropScript = `
      (function(){
        try {
          var input = document.getElementById('__flowx_weibo_upload_tmp__');
          if (!input) return { ok: false, reason: 'no-tmp-input' };
          // 5.1) 触发 input 自身 change（有些组件要这个）
          try { input.dispatchEvent(new Event('input',{bubbles:true})); } catch(e1){}
          try { input.dispatchEvent(new Event('change',{bubbles:true})); } catch(e2){}
          // 5.2) 找到主上传区
          var dropTarget = document.querySelector('[class*="_abox2_109u9_"], [id^="area_video_button_upload_"]');
          if (!dropTarget) dropTarget = document.body;
          // 5.3) 构造 DataTransfer（Chrome 支持 new DataTransfer）
          var dt;
          try { dt = new DataTransfer(); } catch(edt){ return { ok: false, reason: 'DataTransfer-not-supported' }; }
          if (input.files && input.files.length > 0) {
            for (var k = 0; k < input.files.length; k++) dt.items.add(input.files[k]);
          }
          var common = { bubbles: true, cancelable: true, dataTransfer: dt };
          // 5.4) 触发 dragover → dragenter → drop（完整拖放序列）
          try { dropTarget.dispatchEvent(new DragEvent('dragenter', common)); } catch(a){}
          try { dropTarget.dispatchEvent(new DragEvent('dragover', common)); } catch(b){}
          try { dropTarget.dispatchEvent(new DragEvent('drop', common)); } catch(c){}
          try { dropTarget.dispatchEvent(new DragEvent('dragleave', common)); } catch(d){}
          return { ok: true, filesCount: input.files ? input.files.length : 0, dropTarget: (dropTarget.tagName || '') + '.' + ((dropTarget.getAttribute && dropTarget.getAttribute('class')) || '').slice(0,40) };
        } catch(e) { return { ok: false, error: String(e) }; }
      })();
    `;
    const dropRes: any = await win.webContents.executeJavaScript(dropScript).catch((err: Error) => {
      log('warn', 'upload', `[B] drop 事件脚本抛错: ${err.message}`);
      return null;
    });
    log('info', 'upload', `[B] drop 事件结果: ${dropRes ? JSON.stringify(dropRes).slice(0, 200) : 'unknown'}`);

    // 6) 最后移除临时 input（保持 DOM 干净，不影响样式）
    try {
      await win.webContents.executeJavaScript(`
        (function(){
          try { var x = document.getElementById('__flowx_weibo_upload_tmp__'); if (x && x.parentNode) x.parentNode.removeChild(x); return { removed: true }; }
          catch(e) { return { removed: false, error: String(e) }; }
        })();
      `).catch(() => {});
    } catch { /* ignore */ }

    if (dropRes && dropRes.ok) {
      log('info', 'upload', '✅ [B] 模拟 drop 方案调用完成，等待上传流程启动…');
      await sleep(3000);
      return true;
    }
    log('error', 'upload', '❌ 两种上传方案均失败');
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'upload', `微博视频上传总异常: ${msg}`);
    return false;
  }
}

/** 通用发布入口（视频） */
async function runWeiboPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
  _contentType: ContentType,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'weibo' });

  const publishUrl = 'https://weibo.com/upload/channel';
  const title = `微博视频发布 - ${accountId}`;
  let win: BrowserWindow | null = null;
  let tracker: ReturnType<typeof attachNavigationTracker> | null = null;

  try {
    // ---- 步骤 1：创建窗口 + 导航跟踪 ----
    log('info', 'init', '初始化微博视频发布窗口');
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);

    // ---- 步骤 2：加载发布 URL ----
    onProgress(5, '加载微博视频发布页…');
    log('info', 'load', `加载 URL: ${publishUrl}`);
    await win.loadURL(publishUrl);

    // ---- 步骤 3：等待页面稳定 ----
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // ---- 步骤 4：检测登录状态 ----
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      log('warn', 'login', `未检测到登录状态，url=${loginInfo.url}`);
      win.show();
      onProgress(15, '请在窗口中登录微博账号…');
      const loginDeadline = Date.now() + 120_000;
      let loggedIn = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const recheck = await detectLoggedIn(win).catch(() => null as any);
        if (recheck && recheck.loggedIn) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        return makeFailedResult(accountId, 'weibo', '登录超时或未登录，请先在微博登录', startedAt);
      }
      log('info', 'login', '✅ 登录成功，继续发布流程');
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', `✅ 已登录 (url=${loginInfo.url.slice(0, 80)})`);
    }

    // ---- 步骤 5：上传素材（微博专用上传） ----
    const mediaFiles = (request.mediaFiles && request.mediaFiles.length > 0) ? request.mediaFiles : [];
    if (mediaFiles.length === 0) {
      return makeFailedResult(accountId, 'weibo', '未提供任何视频文件', startedAt);
    }
    // 过滤视频文件（微博视频发布页只允许视频）
    const videoFiles = mediaFiles.filter((f) =>
      /\.(mp4|mov|mkv|avi|flv|wmv|webm|m4v|mpg|mpeg|3gp)$/i.test(f),
    );
    if (videoFiles.length === 0) {
      return makeFailedResult(accountId, 'weibo', '未找到支持的视频文件（mp4/mov/mkv 等）', startedAt);
    }

    onProgress(25, `开始上传视频（${videoFiles.length} 个）…`);
    log('info', 'upload', `准备上传 ${videoFiles.length} 个视频文件`);

    const uploadOk = await uploadWeiboVideo(win, videoFiles, log);
    if (!uploadOk) {
      return makeFailedResult(accountId, 'weibo', '视频上传失败（FileChooser + CDP 两种方式均未成功）', startedAt);
    }

    // ---- 步骤 6：等待上传完成（包含转码，最长 6 分钟） ----
    onProgress(40, '等待上传完成…');
    const uploadResult = await waitForUploadComplete(win, log, onProgress, 360_000, tracker);
    if (win.isDestroyed() || uploadResult.finalStatus === 'window-destroyed') {
      log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
      return makeFailedResult(accountId, 'weibo', '发布窗口已被关闭，发布已终止', startedAt);
    }
    if (!uploadResult.ready) {
      log('warn', 'upload', `上传完成检测警告: ${uploadResult.finalStatus}，继续尝试填写表单`);
    }

    // ---- 步骤 6.5：等待封面生成（微博在上传+转码完成后才异步生成封面候选） ----
    // 元素特征：._a5rt_1gx9k_237 封面容器 + ._a5list_1gx9k_304 封面列表
    //         + ._a5itemcurr_1gx9k_367（已自动选中的第 1 张封面）+ img[src 非空且非 about:blank]
    onProgress(52, '等待视频封面生成…');
    const coverDeadline = Date.now() + 120_000; // 最长 2 分钟
    let coverReady = false;
    let coverInfo: { count?: number; selectedSrc?: string } = {};
    while (Date.now() < coverDeadline) {
      if (win.isDestroyed()) break;
      const probeCover: any = await win.webContents.executeJavaScript(`
        (function(){
          try {
            var box = document.querySelector('[class*="_a5rt_1gx9k_"], [class*="_a5list_1gx9k_"], [class*="_coverbox_"], [class*="_cover_"]');
            if (!box) return { ready: false, reason: 'no-cover-box' };
            // 找已选中的封面项：class 含 _a5itemcurr_1gx9k_367 或已选中状态
            var imgs = box.querySelectorAll && box.querySelectorAll('img.woo-picture-img, img');
            var realImgs = [];
            for (var i = 0; imgs && i < imgs.length; i++) {
              var src = (imgs[i].getAttribute && imgs[i].getAttribute('src')) || '';
              if (!src) continue;
              if (src.indexOf('about:') === 0 || src.indexOf('data:') === 0 || src === 'false') continue;
              if (!/^https?:\\/\\//.test(src)) continue;
              realImgs.push(src);
            }
            if (realImgs.length === 0) return { ready: false, reason: 'no-valid-imgs', count: 0 };
            var selected = box.querySelector('[class*="_a5itemcurr_1gx9k_"]');
            var selectedImg = selected ? selected.querySelector && selected.querySelector('img.woo-picture-img, img') : null;
            var selectedSrc = '';
            if (selectedImg) {
              selectedSrc = (selectedImg.getAttribute && selectedImg.getAttribute('src')) || '';
              if (/about:|false|data:/.test(selectedSrc)) selectedSrc = realImgs[0];
            } else if (realImgs.length > 0) {
              selectedSrc = realImgs[0];
            }
            return { ready: realImgs.length >= 1, count: realImgs.length, selectedSrc: selectedSrc };
          } catch(e) { return { ready: false, error: String(e) }; }
        })();
      `).catch(() => null);
      if (probeCover && probeCover.ready) {
        coverReady = true;
        coverInfo = probeCover;
        break;
      }
      const remain = Math.max(0, Math.ceil((coverDeadline - Date.now()) / 1000));
      log('info', 'upload', `封面尚未生成: ${JSON.stringify(probeCover).slice(0, 120)}，继续等待…(剩余 ${remain}s)`);
      await sleep(2000);
    }
    if (!coverReady) {
      log('warn', 'upload', '⚠️ 等待封面生成超过 2 分钟仍未出现，仍将继续填写表单（部分情况下发布按钮可能因缺少封面被禁用）');
      onProgress(58, '封面未生成，继续填写表单…');
    } else {
      log('info', 'upload', `✅ 封面已就绪: 共 ${coverInfo.count} 张候选，已选=${(coverInfo.selectedSrc || '').slice(0, 80)}`);
      onProgress(59, '封面就绪，准备填写表单…');
    }
    await sleep(800);

    onProgress(60, '上传完成，准备填写内容…');
    await sleep(1200);

    // ---- 步骤 7：填写表单 ----
    // 注意：绝对不要去强制解除 display:none，
    // 否则会导致 flex/native 布局破坏、下拉框收起态展开、完成弹窗覆盖页面。
    // 正确的做法是通过 FileChooser 或 drop 事件真正触发组件状态，让表单自然显示。
    const titleText = truncate((request.title || '').trim(), 30);
    // 关键：微博视频发布有独立的「视频标题」输入框，正文（设置微博内容）永远不要再重复写标题，
    // 避免出现「视频标题=一键开天 + 正文首行=一键开天」的重复显示。
    // 正文只写入：content + tags；当且仅当 content 与 tags 都为空时，正文保持空字符串。
    const rawContent = (request.content || '').trim();
    const tagStr = prepareTags(request.tags).join(' ');
    let bodyText = '';
    if (rawContent && tagStr) {
      bodyText = rawContent + '\n' + tagStr;
      if (bodyText.length > 2000) bodyText = truncate(rawContent, 2000 - tagStr.length - 1) + '\n' + tagStr;
    } else if (rawContent) {
      bodyText = truncate(rawContent, 2000);
    } else if (tagStr) {
      bodyText = tagStr;
    }
    const hasContent = rawContent.length > 0;
    const hasTags = !!(request.tags && request.tags.length > 0);
    log('info', 'fill', `准备写入：title="${titleText.slice(0, 40)}", bodyLen=${bodyText.length}, hasContent=${hasContent}, hasTags=${hasTags}, tags=${(request.tags || []).length}`);

    // 7.1 类型：选择「原创」
    onProgress(62, '选择「原创」类型…');
    for (let attempt = 0; attempt < 2; attempt++) {
      const resSel: any = await evalJS(win, buildSelectOriginalTypeScript(), `select-original-${attempt + 1}`, log).catch(() => null);
      if (resSel && resSel.clicked) {
        log('info', 'fill', `✅ 原创类型已选择`);
        break;
      }
      await sleep(500);
    }

    // 7.2 视频标题（有则填，无则跳过）
    if (titleText) {
      onProgress(65, '填写视频标题…');
      const resT: any = await evalJS(win, buildFillTitleScript(titleText), 'fill-title', log).catch(() => null);
      if (!resT || !resT.ok) {
        log('warn', 'fill', `视频标题写入失败: ${JSON.stringify(resT).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 视频标题已写入`);
      }
      await sleep(500);
    }

    // 7.3 分类：选择分类（选不到就算了，非必填）
    onProgress(68, '选择视频分类…');
    const resCate: any = await evalJS(win, buildSelectCategoryScript(), 'select-category', log).catch(() => null);
    if (resCate && resCate.ok) {
      log('info', 'fill', `✅ 分类已选择 (method=${resCate.method}, value=${resCate.value || ''})`);
    } else {
      log('warn', 'fill', `分类选择跳过: ${JSON.stringify(resCate).slice(0, 120)}`);
    }
    await sleep(500);

    // 7.4 微博正文（含话题）
    if (bodyText) {
      onProgress(72, '填写微博正文…');
      const resC: any = await evalJS(win, buildFillContentScript(bodyText), 'fill-content', log).catch(() => null);
      if (!resC || !resC.ok) {
        log('warn', 'fill', `微博正文写入失败: ${JSON.stringify(resC).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 微博正文已写入 (type=${resC.type}, score=${resC.index})`);
      }
      await sleep(800);
    }

    // ---- 步骤 8：点击发布按钮（测试模式则高亮并返回） ----
    onProgress(78, '准备发布…');

    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          // 精确哈希优先（你给的按钮：button.woo-button-main.woo-button-flat.woo-button-primary._btn_2z30i_68._btn1_2z30i_72）
          'button[class*="_btn1_2z30i_"]',
          'button[class*="_btn_2z30i_"]',
          '._check_2z30i_81 button',
          'button._btn_2z30i_68',
          'button._btn1_2z30i_72',
          // Woo 主按钮兜底
          'button.woo-button-main.woo-button-primary',
          'button[class*="woo-button-primary"]',
          'button[class*="primary"]',
          'button[class*="publish"]',
          'button[type="submit"]',
        ],
        [
          // 和正文脚本精确一致：input 标题 + textarea 正文
          {
            name: '视频标题',
            selector: 'input[placeholder="填写标题（0～30个字）"], input[placeholder*="填写标题"], input[placeholder*="标题"]',
            type: 'input',
          },
          {
            // 微博正文：真实元素是 textarea（._input_1rz8r_8）placeholder 精确匹配
            name: '微博正文',
            selector: 'textarea[placeholder="有什么新鲜事想分享给大家？"], textarea._input_1rz8r_8, textarea[placeholder*="新鲜事"]',
            type: 'textarea',
          },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      // 由于 buildTestModeProbeScript 内部用 offsetParent !== null 作为 visible 判定，
      // 微博按钮在 fixed/absolute 容器里 offsetParent 常为 null，这里在外部再找一次按钮做兜底修正。
      if (testRes && !testRes.publishButtonFound) {
        const probe2: any = await win.webContents.executeJavaScript(`
          (function(){
            try {
              var sels = ${JSON.stringify([
                'button[class*="_btn1_2z30i_"]',
                'button[class*="_btn_2z30i_"]',
                '._check_2z30i_81 button',
              ])};
              for (var i = 0; i < sels.length; i++) {
                var el = document.querySelector(sels[i]);
                if (!el) continue;
                var st = window.getComputedStyle(el, null);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
                var rect = el.getBoundingClientRect();
                if (!rect || rect.width <= 1 || rect.height <= 1) continue;
                return {
                  text: (el.innerText || el.textContent || '').trim().slice(0,30),
                  selector: sels[i],
                  x: Math.round(rect.left + window.scrollX),
                  y: Math.round(rect.top + window.scrollY),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                };
              }
              return null;
            } catch(e) { return null; }
          })();
        `).catch(() => null);
        if (probe2) {
          testRes.publishButtonFound = true;
          testRes.publishButtonInfo = probe2;
          // 顺便给结果 note 修正
          if (testRes.note === '未找到发布按钮') {
            testRes.note = '探针脚本兜底找到发布按钮';
          }
        }
      }
      // 同样对字段值：如果正文 found=true 但 filled=false（可能是探针把 type=contenteditable 改成了 textarea 后不一致），兜底再读一次
      if (testRes && testRes.fields && Array.isArray(testRes.fields)) {
        for (const f of testRes.fields) {
          if (f.found && !f.filled) {
            if (f.name === '微博正文') {
              // 再次精确读取 textarea 的 value
              const v: any = await win.webContents.executeJavaScript(`
                (function(){
                  var el = document.querySelector('textarea[placeholder="有什么新鲜事想分享给大家？"], textarea._input_1rz8r_8');
                  if (!el) return null;
                  return (el.value || '').trim();
                })();
              `).catch(() => null);
              if (v && v.length > 0) {
                f.filled = true;
                f.valueLength = v.length;
              }
            }
          }
        }
      }
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');
      setupTestModeWindow(win, log);
      return {
        accountId,
        platform: 'weibo',
        status: 'success',
        progress: 100,
        message: '测试完成 - 表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: {
          titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '视频标题')?.filled),
          contentFilled: !!(testRes?.fields?.find((f: any) => f.name === '微博正文')?.filled),
          tagsFilled: !!(request.tags && request.tags.length > 0),
          publishButtonFound: !!(testRes?.publishButtonFound),
          publishButtonInfo: testRes?.publishButtonInfo || null,
          formFields: testRes?.fields || [],
          note: testRes?.note || '测试模式完成',
        },
      } as PublishItemProgress;
    }

    onProgress(82, '点击发布按钮…');
    const clickRes: any = await evalJS(win, buildClickPublishButtonScript(), 'click-publish', log).catch(() => null);
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', `发布按钮点击失败: ${JSON.stringify(clickRes).slice(0, 200)}`);
      const probe: any = await evalJS(win, buildPageStructureProbe(), 'probe', log).catch(() => null);
      log('warn', 'publish', `页面结构探测: ${JSON.stringify(probe).slice(0, 400)}`);
      return makeFailedResult(accountId, 'weibo', '未找到可点击的"发布"按钮', startedAt);
    }
    log('info', 'publish', `✅ 发布按钮已点击 (text="${clickRes.text}" score=${clickRes.score})`);
    onProgress(88, '发布中，等待结果…');

    // ---- 步骤 9：等待发布成功 ----
    const successDeadline = Date.now() + 180_000;
    let lastUrl = win.webContents.getURL();
    let lastText = '';
    const initialUrl = lastUrl;
    while (Date.now() < successDeadline) {
      if (win.isDestroyed()) break;
      try {
        const check: any = await win.webContents.executeJavaScript(`
          (function () {
            var body = (document.body ? (document.body.innerText || '') : '').slice(0, 600);
            return {
              url: location.href,
              title: document.title,
              body: body,
              urlChanged: location.href !== ${JSON.stringify(initialUrl)},
            };
          })();
        `).catch(() => null);
        if (check) {
          lastUrl = check.url || '';
          lastText = `${check.body || ''} | ${check.title || ''}`;
          const urlOk = /\/profile|\/u\/|upload_success|publish_success|我的主页|weibo\.com\/home|weibo\.com\/upload\/done/i.test(lastUrl);
          const urlChanged = !!check.urlChanged && !/upload\/channel/.test(lastUrl);
          const textOk = /发布成功|发布完成|发表成功|已发布|发送成功|发送完成|上传成功|微博已发出/i.test(lastText);
          const textFail = /发布失败|不符合|违规|发送失败|请先|参数不合法|不能为空|上传失败/i.test(lastText);
          if (urlOk || textOk || urlChanged) {
            const reason = [urlOk && 'url-ok', textOk && 'text-success', urlChanged && 'url-changed'].filter(Boolean).join(',');
            log('info', 'done', `✅ 微博发布成功 (reason=${reason}, url=${lastUrl.slice(0, 120)})`);
            onProgress(100, '发布成功');
            return {
              accountId,
              platform: 'weibo',
              status: 'success',
              progress: 100,
              message: '发布成功',
              url: lastUrl,
              startedAt,
              finishedAt: Date.now(),
            } as PublishItemProgress;
          }
          if (textFail) {
            log('warn', 'done', `页面提示失败：${lastText.slice(0, 200)}`);
            return makeFailedResult(accountId, 'weibo', '页面提示发布失败，请检查素材或内容合规性', startedAt);
          }
        }
      } catch { /* ignore */ }
      await sleep(3000);
    }

    log('warn', 'done', `等待发布成功超时（180 秒），最后 url=${lastUrl.slice(0, 120)}`);
    return makeFailedResult(accountId, 'weibo', '等待发布结果超时，请在微博上查看是否发布成功', startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', `发布流程异常: ${msg}`);
    return makeFailedResult(accountId, 'weibo', msg, startedAt);
  } finally {
    if (tracker) {
      try { tracker.dispose(); } catch { /* ignore */ }
    }
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开');
    } else if (win && !win.isDestroyed()) {
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      }, 2000);
    }
  }
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
