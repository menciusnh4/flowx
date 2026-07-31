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
 * X（原 Twitter）平台适配器
 *
 * 平台信息：
 *   - 创作者后台 / 首页：https://x.com/home
 *   - 登录页：https://x.com/i/flow/login
 *   - 登录态标识：cookie `auth_token` 存在且非空即为已登录
 *   - 发布入口：https://x.com/compose/post
 *   - 个人资料页包含粉丝/关注数据
 *
 * TODO 待实现：
 *   - publishVideo / publishImage / publishArticle: 发布功能
 */

const log = makePublishLogger({ platform: 'x' });

const meta: PlatformMeta = {
  key: 'x',
  name: 'X（Twitter）',
  icon: 'X',
  platformAccountLabel: 'X账号',
  authUrl: 'https://x.com/i/flow/login',
  publishUrl: 'https://x.com/compose/post',
  homeUrl: 'https://x.com/home',
  contentTypes: ['article', 'video', 'image'],
  capabilities: {
    publishVideo: false, // TODO: 待实现
    publishImage: false, // TODO: 待实现
    publishArticle: false, // TODO: 待实现
  } as AccountCapabilities,
  contentLimits: {
    title: 0, // X 没有标题字段
    content: 280, // 单条推文最多 280 字符
  },
  articleLimits: {
    title: 0,
    content: 25000, // 长推文（长文）最多 25000 字符
  },
  nicknameSelectors: [
    '[data-testid="AppTabBar_Profile_Link"] + div span',
    'a[href*="/"] [aria-label*="@"]',
    '[data-testid="SideNav_AccountSwitcher_Button"] span',
    'div[data-testid="User-Name"] span',
    '.css-1rynq56.r-bcqeeo.r-qvutc0.r-poiln3.r-a023e6.r-rjixqe',
  ],
  avatarSelectors: [
    '[data-testid="AppTabBar_Profile_Link"] img',
    '[data-testid="SideNav_AccountSwitcher_Button"] img',
    'div[data-testid="Tweet-User-Avatar"] img',
    'img[src*="pbs.twimg.com/profile_images"]',
  ],
  loginKeywords: [
    '首页', 'Home', '探索', 'Explore', '通知', '通知', 'Messages',
    '私信', '个人资料', 'Profile', '推文', 'Tweet', '发帖', '发布',
    'Post', '书签', 'Bookmarks', '列表', 'Lists', '退出', 'Log out',
    '关注的人', 'Following', '正在关注', '为你推荐', '推荐',
  ],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：X 登录后必有 auth_token
    const cookies = await win.webContents.session.cookies.get({});
    const authToken = cookies.find((c) => c.name === 'auth_token' && c.value);
    const ct0 = cookies.find((c) => c.name === 'ct0' && c.value);

    const matchedKeywords: string[] = [];
    if (authToken) matchedKeywords.push('auth_token-cookie');
    if (ct0) matchedKeywords.push('ct0-cookie');

    // 2. 在登录/注册页肯定未登录
    const isLoginPage =
      currentUrl.includes('/i/flow/login') ||
      currentUrl.includes('/i/flow/signup') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('/signup') ||
      currentUrl.includes('login.x.com');

    // 3. 已进入需要登录的页面（home / notifications / messages 等）
    const inProtectedPage =
      currentUrl.includes('/home') ||
      currentUrl.includes('/notifications') ||
      currentUrl.includes('/messages') ||
      currentUrl.includes('/compose/') ||
      currentUrl.match(/\/[a-zA-Z0-9_]+$/) !== null; // 个人主页 /username
    if (inProtectedPage && !isLoginPage) matchedKeywords.push('in-protected');

    // 4. DOM 辅助检测
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // X 已登录标志：
            //   - 左侧导航栏存在 (data-testid="AppTabBar_Home_Link")
            //   - 推文发布按钮 (data-testid="SideNav_NewTweet_Button" 或 "ComposeButton")
            //   - 用户头像 / 个人资料链接
            //   - "退出登录"文本
            var hasNav = document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
                        document.querySelector('a[href="/home"]');
            var hasComposeBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
                              document.querySelector('[data-testid="tweetTextarea_0"]') ||
                              document.querySelector('div[contenteditable="true"][data-testid*="tweetText"]');
            var hasProfileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
                                 document.querySelector('a[href*="/following"]') ||
                                 document.querySelector('a[href*="/followers"]');
            var hasLogoutText = false;
            try {
              var bodyText = document.body ? (document.body.innerText || '') : '';
              hasLogoutText = bodyText.indexOf('Log out') !== -1 ||
                              bodyText.indexOf('退出') !== -1 ||
                              bodyText.indexOf('登出') !== -1;
            } catch(e) {}
            return !!(hasNav || hasComposeBtn || (hasProfileLink && hasLogoutText));
          } catch(e) {
            return false;
          }
        })()
      `);
      if (domLoggedIn) matchedKeywords.push('dom-profile');
    } catch {
      // ignore
    }

    // URL 不是登录页 + (有 auth_token cookie OR DOM 检测通过)
    const loggedIn = !isLoginPage && (!!authToken || domLoggedIn);

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
    let fansCount: number | undefined;
    let followCount: number | undefined;
    let likeCount: number | undefined;
    let userId = '';

    // 1. 提取昵称（显示名称，不是 @username）
    try {
      nickname = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 方式 0：优先从 window.__INITIAL_STATE__ 提取（最可靠）
            try {
              var state = window.__INITIAL_STATE__;
              if (state) {
                // X 的 INITIAL_STATE 结构较复杂，常见路径：
                // state.entities.users.entities[userId].name / screen_name
                // 或 state.user.name / state.session.user.name
                var candidates = [];
                // 遍历查找 users entities
                try {
                  if (state.entities && state.entities.users && state.entities.users.entities) {
                    var usersMap = state.entities.users.entities;
                    for (var uid in usersMap) {
                      if (usersMap[uid] && usersMap[uid].name) candidates.push(String(usersMap[uid].name));
                    }
                  }
                } catch(e0) {}
                // 尝试 state.user / state.session.user
                try {
                  if (state.user && state.user.name) candidates.push(String(state.user.name));
                  if (state.session && state.session.user && state.session.user.name) candidates.push(String(state.session.user.name));
                  if (state.currentUser && state.currentUser.name) candidates.push(String(state.currentUser.name));
                } catch(e0b) {}
                // 取第一个非空且合理的值
                for (var ci = 0; ci < candidates.length; ci++) {
                  var cn = (candidates[ci] || '').trim();
                  if (cn && cn.indexOf('@') !== 0 && cn.length < 50) return cn;
                }
              }
            } catch(eInit) {}

            // 方式 A：侧边栏用户信息区（账号切换按钮）
            // 根据用户提供的结构：账号菜单按钮内嵌套多层 div -> span 显示昵称（zian Meng）
            var acctSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
            if (acctSwitcher) {
              // A1：精确匹配：在菜单按钮中找到不带@、非空的第一个有效文本
              // 结构中：<div dir="ltr" ...><span>zian Meng</span></div>
              // 过滤掉 @MengZian37784 的 span
              var allSpans = acctSwitcher.querySelectorAll('span');
              var lastNonAtText = '';
              for (var s = 0; s < allSpans.length; s++) {
                var txt = (allSpans[s].textContent || '').trim();
                if (!txt) continue;
                if (txt.indexOf('@') === 0) continue;
                // 过滤掉纯表情、纯符号或太短的文本
                if (txt.length < 1) continue;
                if (txt.length > 50) continue;
                // X 的昵称 span 结构通常在 @handle 之上，我们取第一个遇到的有意义的
                return txt;
              }
              // A2：通过 aria-label 从容器提取
              // 用户提供的结构中：<div aria-label="zian Meng" class="css-..."> 包含头像
              var ariaDiv = acctSwitcher.querySelector('[aria-label]');
              if (ariaDiv && ariaDiv.getAttribute) {
                var al = (ariaDiv.getAttribute('aria-label') || '').trim();
                if (al && al.indexOf('@') !== 0 && al.length < 50 && al.length > 0) {
                  // 过滤掉可能是头像描述的情况（通常是人名）
                  return al;
                }
              }
            }

            // 方式 B：当前页面如果是个人主页，从 User-Name 提取
            var userNameEl = document.querySelector('div[data-testid="User-Name"]');
            if (userNameEl) {
              var firstSpan = userNameEl.querySelector('span');
              if (firstSpan) {
                var un = (firstSpan.textContent || '').trim();
                if (un && un.indexOf('@') !== 0 && un.length < 50) return un;
              }
            }

            // 方式 C：从 data-testid="UserAvatar-Container-<handle>" 容器的 aria-label 子元素提取
            var avatarContainer = document.querySelector('[data-testid^="UserAvatar-Container-"]');
            if (avatarContainer) {
              var avatarAria = avatarContainer.querySelector('[aria-label]');
              if (avatarAria && avatarAria.getAttribute) {
                var aal = (avatarAria.getAttribute('aria-label') || '').trim();
                if (aal && aal.indexOf('@') !== 0 && aal.length < 50) return aal;
              }
            }

            // 方式 D：从 meta 标签提取
            var metaOgTitle = document.querySelector('meta[property="og:title"]');
            if (metaOgTitle && metaOgTitle.getAttribute) {
              var m = metaOgTitle.getAttribute('content') || '';
              // X 的 og:title 通常是 "(用户名) (@handle) / X"
              var ogMatch = m.match(/^(.+?)\\s*\\(@/);
              if (ogMatch && ogMatch[1]) {
                var ogName = ogMatch[1].trim();
                if (ogName && ogName.length < 50) return ogName;
              }
            }

            // 方式 E：document.title 提取（"昵称 (@handle) / X" 格式）
            var titleText = document.title || '';
            var tm = titleText.match(/^(.+?)\\s*\\(@/);
            if (tm && tm[1]) {
              var tName = tm[1].trim();
              if (tName && tName.length < 50) return tName;
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取昵称失败: ' + (e as Error).message);
    }

    // 2. 提取头像 URL
    try {
      avatar = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 方式 0：优先从 window.__INITIAL_STATE__ 提取（最可靠）
            try {
              var state = window.__INITIAL_STATE__;
              if (state) {
                var avatarCandidates = [];
                // state.entities.users.entities[userId].profile_image_url_https / profile_image_url
                try {
                  if (state.entities && state.entities.users && state.entities.users.entities) {
                    var usersMap = state.entities.users.entities;
                    for (var uid in usersMap) {
                      var u = usersMap[uid];
                      if (u) {
                        if (u.profile_image_url_https) avatarCandidates.push(String(u.profile_image_url_https));
                        else if (u.profile_image_url) avatarCandidates.push(String(u.profile_image_url));
                      }
                    }
                  }
                } catch(e0) {}
                // state.user / state.session.user
                try {
                  if (state.user) {
                    if (state.user.profile_image_url_https) avatarCandidates.push(String(state.user.profile_image_url_https));
                    else if (state.user.profile_image_url) avatarCandidates.push(String(state.user.profile_image_url));
                  }
                  if (state.session && state.session.user) {
                    if (state.session.user.profile_image_url_https) avatarCandidates.push(String(state.session.user.profile_image_url_https));
                    else if (state.session.user.profile_image_url) avatarCandidates.push(String(state.session.user.profile_image_url));
                  }
                  if (state.currentUser) {
                    if (state.currentUser.profile_image_url_https) avatarCandidates.push(String(state.currentUser.profile_image_url_https));
                    else if (state.currentUser.profile_image_url) avatarCandidates.push(String(state.currentUser.profile_image_url));
                  }
                } catch(e0b) {}
                // 返回第一个有效的
                for (var ai = 0; ai < avatarCandidates.length; ai++) {
                  var asrc = avatarCandidates[ai] || '';
                  // X 的头像通常提供 _normal 尺寸，我们尽量返回 _normal 或更大
                  if (asrc && asrc.indexOf('http') === 0) return asrc;
                }
              }
            } catch(eInit) {}

            // 方式 A：账号切换按钮里的头像（用户已登录首页必存在）
            // 根据用户提供的结构：按钮内有 <img alt="zian Meng" src="..._normal.png">
            var switcherAvatar = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] img');
            if (switcherAvatar && switcherAvatar.src && switcherAvatar.src.indexOf('http') === 0) return switcherAvatar.src;

            // 方式 A2：通过 UserAvatar-Container-<handle> 容器内的 img（data-testid 中包含 handle）
            var uaContainer = document.querySelector('[data-testid^="UserAvatar-Container-"]');
            if (uaContainer) {
              var uaImg = uaContainer.querySelector('img');
              if (uaImg && uaImg.src && uaImg.src.indexOf('http') === 0) return uaImg.src;
            }

            // 方式 B：侧边栏用户头像（可能为 AppTabBar）
            var navAvatar = document.querySelector('[data-testid="AppTabBar_Profile_Link"] img');
            if (navAvatar && navAvatar.src && navAvatar.src.indexOf('http') === 0) return navAvatar.src;

            // 方式 C：个人主页的头像（data-testid 可能不包含 Container 后缀的变体）
            var profileAvatar = document.querySelector('div[data-testid="UserAvatar-Container"] img');
            if (profileAvatar && profileAvatar.src && profileAvatar.src.indexOf('http') === 0) return profileAvatar.src;

            // 方式 D：通过 aria-label 匹配头像 img（alt 或 aria-label 为昵称）
            var ariaImg = document.querySelector('img[alt][src*="profile_images"]');
            if (ariaImg && ariaImg.src && ariaImg.src.indexOf('http') === 0) return ariaImg.src;

            // 方式 E：meta og:image
            var metaOgImg = document.querySelector('meta[property="og:image"]');
            if (metaOgImg && metaOgImg.getAttribute) {
              var msrc = metaOgImg.getAttribute('content') || '';
              if (msrc && msrc.indexOf('http') === 0) return msrc;
            }

            // 方式 F：任意匹配 profile_images 的 img（兜底）
            var anyAvatar = document.querySelector('img[src*="pbs.twimg.com/profile_images"]');
            if (anyAvatar && anyAvatar.src) return anyAvatar.src;
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取头像失败: ' + (e as Error).message);
    }

    // 3. 提取平台账号ID（@username，去掉 @）
    try {
      platformAccountId = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 方式 0：优先从 window.__INITIAL_STATE__ 提取（最可靠）
            try {
              var state = window.__INITIAL_STATE__;
              if (state) {
                var handleCandidates = [];
                // state.entities.users.entities[userId].screen_name
                try {
                  if (state.entities && state.entities.users && state.entities.users.entities) {
                    var usersMap = state.entities.users.entities;
                    for (var uid in usersMap) {
                      var u = usersMap[uid];
                      if (u && u.screen_name) handleCandidates.push(String(u.screen_name));
                    }
                  }
                } catch(e0) {}
                // state.user / state.session.user
                try {
                  if (state.user && state.user.screen_name) handleCandidates.push(String(state.user.screen_name));
                  if (state.session && state.session.user && state.session.user.screen_name) handleCandidates.push(String(state.session.user.screen_name));
                  if (state.currentUser && state.currentUser.screen_name) handleCandidates.push(String(state.currentUser.screen_name));
                } catch(e0b) {}
                // 返回第一个有效 handle
                for (var hi = 0; hi < handleCandidates.length; hi++) {
                  var h = (handleCandidates[hi] || '').trim();
                  if (h && h.length >= 1 && h.length <= 15 && /^[a-zA-Z0-9_]+$/.test(h)) return h;
                }
              }
            } catch(eInit) {}

            // 方式 A0：从 UserAvatar-Container-<handle> 的 data-testid 属性中直接提取（非常可靠）
            // 用户提供的结构：data-testid="UserAvatar-Container-MengZian37784"
            var uaContainerAttr = document.querySelector('[data-testid^="UserAvatar-Container-"]');
            if (uaContainerAttr && uaContainerAttr.getAttribute) {
              var dt = uaContainerAttr.getAttribute('data-testid') || '';
              var dm = dt.match(/^UserAvatar-Container-([a-zA-Z0-9_]{1,15})$/);
              if (dm && dm[1]) return dm[1];
            }

            // 方式 A：侧边栏账号切换区域中 @xxx 的文本
            var switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
            if (switcher) {
              var txt = (switcher.textContent || '');
              var m = txt.match(/@([a-zA-Z0-9_]{1,15})/);
              if (m && m[1]) return m[1];
            }

            // 方式 A1：账号切换按钮内的 a 标签 href /following 形式
            if (switcher) {
              var swLinks = switcher.querySelectorAll('a[href]');
              for (var swl = 0; swl < swLinks.length; swl++) {
                var swHref = swLinks[swl].getAttribute('href') || '';
                var swMatch = swHref.match(/^\\/([a-zA-Z0-9_]{1,15})(?:\\/(following|followers))?$/);
                if (swMatch && swMatch[1]) return swMatch[1];
              }
            }

            // 方式 B：个人资料链接 /username
            var profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
            if (profileLink && profileLink.getAttribute) {
              var href = profileLink.getAttribute('href') || '';
              var hm = href.match(/^\\/([a-zA-Z0-9_]{1,15})$/);
              if (hm && hm[1]) return hm[1];
            }

            // 方式 C：页面任意 a[href] 匹配 /following /followers 的前缀
            var followLinks = document.querySelectorAll('a[href*="/following"], a[href*="/followers"]');
            for (var fl = 0; fl < followLinks.length; fl++) {
              var flHref = followLinks[fl].getAttribute('href') || '';
              var fm = flHref.match(/^\\/([a-zA-Z0-9_]{1,15})\\/(following|followers)/);
              if (fm && fm[1]) return fm[1];
            }

            // 方式 D：document.title / og:title 中的 @handle
            var titleAndMeta = (document.title || '') + ' ';
            try {
              var ogTitle = document.querySelector('meta[property="og:title"]');
              if (ogTitle && ogTitle.getAttribute) titleAndMeta += ogTitle.getAttribute('content') || '';
            } catch(e) {}
            var tm2 = titleAndMeta.match(/@([a-zA-Z0-9_]{1,15})/);
            if (tm2 && tm2[1]) return tm2[1];

            // 方式 E：body 全文搜索第一个 @xxx 格式（兜底）
            try {
              var bodyTxt = (document.body ? document.body.innerText : '') || '';
              var bm = bodyTxt.match(/@([a-zA-Z0-9_]{1,15})/);
              if (bm && bm[1]) return bm[1];
            } catch(e) {}
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
    } catch (e) {
      log('warn', 'extractPageInfo', '提取账号ID失败: ' + (e as Error).message);
    }

    // 4. 提取 userId（从 cookies 兜底）
    try {
      const cookies = await win.webContents.session.cookies.get({});
      const twid = cookies.find((c) => c.name === 'twid' && c.value);
      if (twid) {
        // twid 格式通常是 "u=123456789"
        const m = twid.value.match(/u=(\d+)/);
        if (m && m[1]) userId = m[1];
      }
    } catch {
      // ignore
    }

    // 5. 提取粉丝数/关注数（优先从 window.__INITIAL_STATE__ 提取 followers_count / friends_count）
    try {
      const statsScript = `
        (function() {
          try {
            var result = { followers: null, following: null };

            // ================ 方式 0：优先从 window.__INITIAL_STATE__ 提取（最可靠） ================
            // X 的 INITIAL_STATE 中：followers_count = 粉丝数，friends_count = 关注数
            // 🔑 注意：X 把 INITIAL_STATE 存在 <script> 标签里赋值给 window.__INITIAL_STATE__，
            // 但部分首屏情况下 window.__INITIAL_STATE__ 尚未被赋值（脚本仍在解析），
            // 因此我们直接从第 4 个 script 标签里用括号深度平衡法抠 JSON 再解析，
            // 这样不依赖 window 变量，首屏、刷新、二次打开都能稳定取到。
            try {
              var state = null;
              // 0a. 先试 window.__INITIAL_STATE__
              try {
                if (window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object') {
                  state = window.__INITIAL_STATE__;
                }
              } catch(eWin) {}
              // 0b. 若 window 上拿不到，从 <script> 标签里自行抠 JSON（括号匹配法）
              if (!state) {
                try {
                  var sc = document.querySelectorAll('script');
                  for (var sci = 0; sci < sc.length; sci++) {
                    var sraw = sc[sci].textContent || '';
                    if (!/window\\.__INITIAL_STATE__\\s*=/.test(sraw)) continue;
                    var mBegin = sraw.indexOf('window.__INITIAL_STATE__');
                    var braceStart = sraw.indexOf('{', mBegin);
                    if (braceStart === -1) continue;
                    var depth = 0, inStr = false, strCh = '', braceEnd = -1;
                    for (var k = braceStart; k < sraw.length; k++) {
                      var ch = sraw[k], pv = k > braceStart ? sraw[k-1] : '';
                      if (inStr) {
                        if (ch === '\\\\' && pv !== '\\\\') { k++; continue; }
                        if (ch === strCh) { inStr = false; continue; }
                        continue;
                      }
                      if (ch === '\"' || ch === \"'\") { inStr = true; strCh = ch; continue; }
                      if (ch === '{') depth++;
                      else if (ch === '}') {
                        depth--;
                        if (depth === 0) { braceEnd = k; break; }
                      }
                    }
                    if (braceEnd !== -1) {
                      var jsonTxt = sraw.slice(braceStart, braceEnd + 1);
                      state = JSON.parse(jsonTxt);
                      break;
                    }
                  }
                } catch(eScript) {}
              }

              // 0c. state 拿到了 → 精确定位「当前登录账号」
              if (state) {
                // 步骤 1：从 state.session 等位置找出【当前登录账号】的 id_str / screen_name
                var curId = null;    // 当前登录账号的数字 id（最优先）
                var curScreen = null;// 当前登录账号的 screen_name（handle）
                try {
                  var sessionHit = null;
                  // 找 session.* 下 user_id_str / user_id / id_str / screen_name
                  (function walkS(o, p, d) {
                    if (d > 8 || !o || sessionHit) return;
                    if (Array.isArray(o)) { for (var wi = 0; wi < Math.min(o.length, 5); wi++) walkS(o[wi], p + '[' + wi + ']', d + 1); return; }
                    if (typeof o !== 'object') return;
                    for (var k in o) {
                      if (!curId && /^(user_id_str|user_id|id_str|viewerId|viewer_id_str|logged_in_user_id)$/.test(k) && typeof o[k] === 'string' && /^\\d+$/.test(o[k])) {
                        curId = o[k];
                      }
                      if (!curScreen && /^(screen_name)$/.test(k) && typeof o[k] === 'string') {
                        // session 下的 screen_name 很可能就是当前登录用户
                        if (/\\.session(?:\\.|\\[)/.test(p)) curScreen = o[k];
                      }
                      if (typeof o[k] === 'object') walkS(o[k], p + '.' + k, d + 1);
                      if (curId && curScreen) break;
                    }
                  })(state, 'root', 0);
                } catch(eWalkS) {}

                // 步骤 2：从 DOM 再兜底找当前登录者的 screen_name（头像容器 data-testid / @xxx 文本）
                if (!curScreen) {
                  try {
                    var ava = document.querySelector('[data-testid^=\"UserAvatar-Container-\"]');
                    if (ava && ava.getAttribute) {
                      var avaDT = ava.getAttribute('data-testid') || '';
                      var avaM = avaDT.match(/UserAvatar-Container-([a-zA-Z0-9_]{1,15})/);
                      if (avaM && avaM[1]) curScreen = avaM[1];
                    }
                  } catch(eAva) {}
                }
                if (!curScreen) {
                  try {
                    var sw = document.querySelector('[data-testid=\"SideNav_AccountSwitcher_Button\"]');
                    if (sw) {
                      var swText = sw.textContent || '';
                      var atM = swText.match(/@([a-zA-Z0-9_]{1,15})/);
                      if (atM && atM[1]) curScreen = atM[1];
                    }
                  } catch(eSw) {}
                }

                // 步骤 3：从 entities.users.entities 收集所有 user，先按精确命中取，否则走回退
                var usersMap = (state.entities && state.entities.users && state.entities.users.entities) || {};
                var userKeys = Object.keys(usersMap);
                var primaryUser = null;      // 当前登录账号（命中 curId 或 curScreen）
                var fallbackUser = null;     // 回退：取 map 中第一个有 follow*_count 的 user
                for (var fui = 0; fui < userKeys.length; fui++) {
                  var fk = userKeys[fui];
                  var fu = usersMap[fk];
                  if (!fu || typeof fu !== 'object') continue;
                  if (!primaryUser) {
                    var idMatch = curId && (fu.id_str === curId || String(fu.id) === String(curId) || fk === curId);
                    var snMatch = curScreen && (fu.screen_name && fu.screen_name.toLowerCase() === String(curScreen).toLowerCase());
                    if (idMatch || snMatch) primaryUser = fu;
                  }
                  if (!fallbackUser && (typeof fu.followers_count === 'number' || typeof fu.friends_count === 'number')) {
                    fallbackUser = fu;
                  }
                  if (primaryUser) break;
                }
                var chosenUser = primaryUser || fallbackUser || null;

                // 也试试 state.user / state.session.user / state.currentUser
                var sideUsers = [];
                try {
                  if (state.user) sideUsers.push(state.user);
                  if (state.session && state.session.user) sideUsers.push(state.session.user);
                  if (state.currentUser) sideUsers.push(state.currentUser);
                } catch(eSide) {}
                for (var sui = 0; sui < sideUsers.length; sui++) {
                  var su = sideUsers[sui];
                  if (!su || typeof su !== 'object') continue;
                  var idMatch2 = curId && (su.id_str === curId || String(su.id) === String(curId));
                  var snMatch2 = curScreen && su.screen_name && su.screen_name.toLowerCase() === String(curScreen).toLowerCase();
                  if (idMatch2 || snMatch2) { chosenUser = su; break; }
                  if (!chosenUser && (typeof su.followers_count === 'number' || typeof su.friends_count === 'number')) {
                    chosenUser = su;
                  }
                }

                // 步骤 4：写入结果
                if (chosenUser) {
                  if (typeof chosenUser.followers_count === 'number') result.followers = chosenUser.followers_count;
                  if (typeof chosenUser.friends_count === 'number')   result.following = chosenUser.friends_count;
                  if (typeof chosenUser.following_count === 'number' && result.following === null) result.following = chosenUser.following_count;
                }

                // 把「当前登录者标识」挂到 result 上，方便上层日志诊断
                try {
                  result._diag = {
                    curId: curId || null,
                    curScreen: curScreen || null,
                    chosenScreen: chosenUser ? chosenUser.screen_name : null,
                    chosenName: chosenUser ? chosenUser.name : null,
                    chosenIdStr: chosenUser ? chosenUser.id_str : null,
                    usersMapLen: userKeys.length,
                    hitPrimary: !!primaryUser,
                  };
                } catch(eDiag) {}
              }
            } catch(eInit) {}

            // 若 INITIAL_STATE 已经把两个字段都拿到，直接返回（不再跑 DOM 兜底）
            if (result.followers !== null && result.following !== null) {
              return result;
            }

            // ================ 兜底：辅助：解析 "1.2万" / "12.3K" / "1,234" 等格式 ================
            function _parseNum(s) {
              if (!s) return null;
              var t = String(s).replace(/\\s+/g, '').replace(/,/g, '');
              // 中文：万/千
              var base = parseFloat(t);
              if (isNaN(base)) return null;
              if (/万/i.test(t)) base *= 10000;
              else if (/千/i.test(t)) base *= 1000;
              // 英文：K / M
              else if (/K/i.test(t)) base *= 1000;
              else if (/M/i.test(t)) base *= 1000000;
              return Math.round(base);
            }

            // ================ 方式 A：找 a[href$="/followers"] 和 a[href$="/following"] ================
            var links = document.querySelectorAll('a[href$="/followers"], a[href$="/following"]');
            for (var i = 0; i < links.length; i++) {
              var a = links[i];
              var href = a.getAttribute('href') || '';
              // 粉丝/关注数字通常在 <a> 内的第一个 span 或直接文本中
              var span = a.querySelector('span');
              var rawNum = span ? (span.textContent || '') : (a.textContent || '');
              if (!rawNum) continue;
              // 取文本中的数字部分（可能包含 "粉丝 1.2万" 这种）
              var numMatch = rawNum.match(/(\d+(?:\\.\\d+)?[万千百KMkm]?)/);
              if (!numMatch) continue;
              var val = _parseNum(numMatch[1]);
              if (val === null || val === undefined) continue;
              if (href.indexOf('/followers') !== -1 && result.followers === null) result.followers = val;
              if (href.indexOf('/following') !== -1 && result.following === null) result.following = val;
            }
            // ================ 方式 B：body 文本正则 "12.3K 粉丝" / "粉丝 12.3K" 或 "Followers" ================
            if (result.followers === null || result.following === null) {
              try {
                var bt = (document.body ? document.body.innerText : '') || '';
                if (result.followers === null) {
                  var fm1 = bt.match(/(?:粉丝|Followers)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百KMkm]?)/i);
                  var fm2 = bt.match(/(\\d+(?:\\.\\d+)?[万千百KMkm]?)[^0-9]{0,5}(?:粉丝|Followers)/i);
                  if (fm1 && fm1[1]) result.followers = _parseNum(fm1[1]);
                  else if (fm2 && fm2[1]) result.followers = _parseNum(fm2[1]);
                }
                if (result.following === null) {
                  var fg1 = bt.match(/(?:关注|Following)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百KMkm]?)/i);
                  var fg2 = bt.match(/(\\d+(?:\\.\\d+)?[万千百KMkm]?)[^0-9]{0,5}(?:关注|Following)/i);
                  if (fg1 && fg1[1]) result.following = _parseNum(fg1[1]);
                  else if (fg2 && fg2[1]) result.following = _parseNum(fg2[1]);
                }
              } catch(e) {}
            }
            return result;
          } catch(e) { return { followers: null, following: null }; }
        })()
      `;
      const stats: any = await win.webContents.executeJavaScript(statsScript) || {};
      if (typeof stats.followers === 'number') fansCount = stats.followers;
      if (typeof stats.following === 'number') followCount = stats.following;
      // 把提取诊断信息打到日志，便于后续定位
      if (stats._diag) {
        log('info', 'extractPageInfo', `[x-fans-diag] ${JSON.stringify(stats._diag)}`);
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '提取粉丝/关注数失败: ' + (e as Error).message);
    }

    // 6. 提取获赞/收藏数（X 没有统一的总获赞展示，只有推文数/媒体数，留空）
    likeCount = undefined;

    log('info', 'extractPageInfo', `提取结果: nickname="${nickname}", id="${platformAccountId}", userId="${userId}", fans=${fansCount ?? '-'}, follow=${followCount ?? '-'}`);

    return {
      nickname,
      avatar: avatar || undefined,
      platformAccountId: platformAccountId || undefined,
      userId: userId || undefined,
      fansCount,
      followCount,
      likeCount,
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
  return makeFailedResult(accountId, 'x', 'X（Twitter）发布功能正在开发中，暂不支持');
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

log('info', 'register', 'X（Twitter）平台适配器已注册（账号管理版本，发布功能待实现）');
