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
 * 哔哩哔哩（B站）平台适配器
 *
 * 平台信息：
 *   - 创作中心：https://member.bilibili.com/
 *   - 登录页：自动跳转（未登录访问 member.bilibili.com 会跳到 passport.bilibili.com 登录页）
 *   - 登录态标识：cookie `SESSDATA` 存在且非空即为已登录（`bili_jct` 为 CSRF Token）
 *   - 视频发布页：https://member.bilibili.com/v2#/upload/video/frame
 *   - 图文（专栏）发布页：https://member.bilibili.com/v2#/upload/article/article
 *   - 动态发布：创作中心首页
 *
 * 当前接入范围：账号管理（登录态检测 + 账号信息提取）
 * TODO 待实现：
 *   - publishVideo / publishImage / publishArticle: 发布功能
 */

const log = makePublishLogger({ platform: 'bilibili' });

const meta: PlatformMeta = {
  key: 'bilibili',
  name: '哔哩哔哩',
  icon: 'B',
  platformAccountLabel: 'UID',
  // 创作中心地址，未登录时 B 站会自动跳转到登录页
  authUrl: 'https://member.bilibili.com/',
  publishUrl: 'https://member.bilibili.com/v2#/upload/video/frame',
  homeUrl: 'https://member.bilibili.com/',
  contentTypes: ['video', 'image', 'article'],
  capabilities: {
    publishVideo: false, // TODO: 待实现
    publishImage: false, // TODO: 待实现（图文/专栏）
    publishArticle: false, // TODO: 待实现（专栏）
  } as AccountCapabilities,
  contentLimits: {
    title: 80,
    content: 2000,
  },
  articleLimits: {
    title: 100,
    content: 20000,
  },
  nicknameSelectors: [
    '.user-info .name',
    '.username',
    '.nick-name',
    '[class*="user-name"]',
    '[class*="nickname"]',
    '.header .name',
    '.topbar-user .name',
  ],
  avatarSelectors: [
    // B 站创作中心实际 DOM: <a class="avatar el-popover__reference"><img class="custom-lazy-img" src="//i0.hdslb.com/..."></a>
    'a.avatar img.custom-lazy-img',
    'img.custom-lazy-img',
    'a[href*="space.bilibili.com"] img',
    '.avatar img',
    'a.avatar img',
    '.user-info img',
    '[class*="avatar"] img',
    'img.avatar',
    '.header img',
    '.topbar-user img',
  ],
  loginKeywords: ['创作中心', '稿件管理', '数据中心', '粉丝', '发布', '投稿', '收益', '退出登录'],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：B站登录后必有 SESSDATA cookie
    const cookies = await win.webContents.session.cookies.get({});
    const sessdata = cookies.find((c) => c.name === 'SESSDATA' && c.value);
    const biliJct = cookies.find((c) => c.name === 'bili_jct' && c.value);
    const dedeUserID = cookies.find((c) => c.name === 'DedeUserID' && c.value);

    const matchedKeywords: string[] = [];
    if (sessdata) matchedKeywords.push('SESSDATA-cookie');
    if (biliJct) matchedKeywords.push('bili_jct-cookie');
    if (dedeUserID) matchedKeywords.push('DedeUserID-cookie');

    // 2. 在登录页肯定未登录
    const isLoginPage = currentUrl.includes('passport.bilibili.com') ||
                        currentUrl.includes('/login') ||
                        currentUrl.includes('/signin');

    // 3. 已进入创作中心页面（URL 包含 member.bilibili.com）
    const inBackend = currentUrl.includes('member.bilibili.com') && !isLoginPage;
    if (inBackend) matchedKeywords.push('in-member-backend');

    // 4. DOM 辅助检测
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // B站创作中心已登录标志：用户昵称元素、退出按钮、侧边栏菜单
            var nameEl = document.querySelector('.user-info .name') ||
                        document.querySelector('.username') ||
                        document.querySelector('[class*="user-name"]') ||
                        document.querySelector('[class*="nickname"]');
            var hasLogout = document.body.innerText.indexOf('退出登录') !== -1 ||
                           document.body.innerText.indexOf('退出') !== -1;
            var hasSidebar = document.body.innerText.indexOf('稿件管理') !== -1 ||
                            document.body.innerText.indexOf('数据中心') !== -1 ||
                            document.body.innerText.indexOf('创作中心') !== -1;
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

    const loggedIn = !!sessdata && !isLoginPage;

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

/** B 站自有域名白名单：命中这些 host 的 http:// 链接需要强制升级为 https://，
 *  否则在 https://member.bilibili.com 创作中心页面中 <img src="http://..."> 会被 Mixed Content 拦截，头像不显示。
 *  hdslb.com / bilibili.com / bilibili.cn / bilibili.co.id 这些 CDN 或主站域名都支持 https。 */
const BILI_FORCE_HTTPS_DOMAINS = [
  'hdslb.com',
  'bilibili.com',
  'bilibili.cn',
  'bilibili.co.id',
  'bilibili.tv',
  'biligame.com',
  'bilibiliw.com',
];

/** 判断 host（已 lowercase 后）是否属于 B 站自有域名 */
function _isBiliDomain(host: string): boolean {
  const h = host.toLowerCase();
  for (const d of BILI_FORCE_HTTPS_DOMAINS) {
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

/** 类引号字符黑名单（逐字符剔除）。
 *  之前用 /[`"'\\]+/g 字符类正则对某些"看起来像反引号"的 Unicode 字符（U+00B4/锐音符、U+2018/2019 弯引号、U+02CB/抑音符、
 *  U+0060 原反引号、U+FF40 全角反引号 等）漏匹配，导致反引号一直"洗不掉"，头像 URL 最终发请求时变成
 *  `%60https://i0.hdslb.com/...%60` 从而 404。现在改成"任何字符码位属于下面这张表就直接丢弃"，命中范围更广也更可控。 */
const QUOTE_LIKE_CHARCODES = new Set<number>([
  0x0027, // ' APOSTROPHE
  0x0022, // " QUOTATION MARK
  0x0060, // ` GRAVE ACCENT (原反引号，最常见的"看起来像反引号"的字符)
  0x00b4, // ´ ACUTE ACCENT（看起来像反引号但方向相反，容易被误贴）
  0x005c, // \ REVERSE SOLIDUS（反斜杠）
  0x2018, // ‘ LEFT SINGLE QUOTATION MARK（左弯单引号，markdown 渲染时常被替换成这个）
  0x2019, // ’ RIGHT SINGLE QUOTATION MARK（右弯单引号）
  0x201c, // “ LEFT DOUBLE QUOTATION MARK
  0x201d, // ” RIGHT DOUBLE QUOTATION MARK
  0x2039, // ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  0x203a, // › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  0x00ab, // « LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x00bb, // » RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x02cb, // ˋ MODIFIER LETTER GRAVE ACCENT（修饰符版抑音符）
  0x02ca, // ˊ MODIFIER LETTER ACUTE ACCENT
  0x0300, //  ̀ COMBINING GRAVE ACCENT（组合字符，有些编辑器会把反引号和下一个字符合成）
  0x0301, //  ́ COMBINING ACUTE ACCENT
  0xff07, // ＇ FULLWIDTH APOSTROPHE
  0xff02, // ＂ FULLWIDTH QUOTATION MARK
  0xff40, // ｀ FULLWIDTH GRAVE ACCENT（全角反引号，全角输入时经常误敲）
  0x300c, // 「 LEFT CORNER BRACKET（中文左引号）
  0x300d, // 」 RIGHT CORNER BRACKET
  0x300e, // 『 LEFT WHITE CORNER BRACKET
  0x300f, // 』 RIGHT WHITE CORNER BRACKET
  0x201a, // ‚ SINGLE LOW-9 QUOTATION MARK
  0x201e, // „ DOUBLE LOW-9 QUOTATION MARK
  0x201b, // ‛ SINGLE HIGH-REVERSED-9 QUOTATION MARK
  0x201f, // ‟ DOUBLE HIGH-REVERSED-9 QUOTATION MARK
]);

/** 字符串净化（第 1 层：逐字符去"类引号字符"）。
 *  相比单条正则，逐字符查表的好处是结果完全可预测：只要字符码命中就丢，其它字符原样保留。*/
function _cleanStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (QUOTE_LIKE_CHARCODES.has(c)) continue;
    // 合并空白：所有 \r\n\t 以及多空格统一成一个空格；这里只做控制字符处理，后续 .trim() 再收口
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
      out += ' ';
      continue;
    }
    out += s.charAt(i);
  }
  // 把连续多个空格合并成一个，再去掉首尾空白
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** URL 规范化最终步骤（第 2 层：从一堆杂糅的文本里把真正的 URL 抽出来）。
 *  场景：即使过了 _cleanStr 把字符类引号去掉，有些场景值里会残留 "原始日志写反了"：
 *       `[head]https://i0.hdslb.com/bfs/face/...jpg [tail]`
 *  这层用正则 /https?:\/\/[^\s"'`<>]+/ig 从文本里**提取**第一个 http(s) URL，
 *  再叠加协议相对路径补全 + B 站域名 http→https 升级。两层之后 URL 一定是"干净的 http(s) 绝对地址"。*/
function _normalizeUrl(u: unknown): string {
  const cleaned = _cleanStr(u);
  if (!cleaned) return '';
  // dataURI 放行（这里主要是头像，B 站不用 dataURI 做头像，但作为兜底逻辑保留）
  if (cleaned.indexOf('data:') === 0) return '';
  if (cleaned.indexOf('1x1') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  if (cleaned.indexOf('transparent') !== -1 && cleaned.indexOf('base64') !== -1) return '';
  let url = cleaned;
  // 协议相对路径 //xxx 补 https:
  if (url.indexOf('//') === 0) url = 'https:' + url;
  // 如果当前字符串里没有 http/https 前缀，但在正文里包含了一个 URL（前后带噪音字符），则提取第一个命中的 http(s) URL
  if (url.indexOf('http:') !== 0 && url.indexOf('https:') !== 0) {
    const m = url.match(/https?:\/\/[^\s"'`<>【】《》（）()[\]{}，,。;；:：]+/i);
    if (m && m[0]) {
      url = m[0];
    }
  }
  // 再做一轮 _cleanStr：从噪音里抽出来的 URL 可能末尾粘了标点或引号
  url = _cleanStr(url);
  // 纯相对路径（/xxx，没 http/https 也没 //）丢弃
  if (url.indexOf('/') === 0 && url.indexOf('//') !== 0) return '';
  // http(s) URL 规范化：B 站自有域名 http → https
  if (url.indexOf('http:') === 0 || url.indexOf('https:') === 0) {
    try {
      const protoEnd = url.indexOf('//');
      if (protoEnd !== -1) {
        const afterProto = url.substring(protoEnd + 2);
        const hostEndIdx = afterProto.search(/[\/?#:]/);
        const host = (hostEndIdx === -1 ? afterProto : afterProto.substring(0, hostEndIdx)).toLowerCase();
        if (host && _isBiliDomain(host) && url.indexOf('http:') === 0) {
          url = 'https:' + url.substring(5);
        }
      }
    } catch {
      // ignore
    }
    // 最后一道：URL 末尾可能粘了中文标点/引号，根据合法 URL 字符再截一次
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
    // 优先通过 B 站 Web API 获取当前用户信息（最可靠）
    // 注意：之前用 fetch() 可能被 CSP connect-src 拦（inline 注入脚本 strict-dynamic 没有 nonce），
    // 这里改成 XMLHttpRequest + Promise 包装，兼容性更好；同时页面原生脚本实际就是用 XHR 调的这个接口
    let apiInfo: any = null;
    let apiError = '';
    try {
      const navResult: any = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            try {
              var xhr = new XMLHttpRequest();
              xhr.open('GET', 'https://api.bilibili.com/x/web-interface/nav', true);
              xhr.withCredentials = true;
              // 模拟浏览器原生脚本的头（Referer / Origin 是创作中心，B 站接口校验较严格）
              try { xhr.setRequestHeader('Accept', 'application/json, text/plain, */*'); } catch(_) {}
              try { xhr.setRequestHeader('Referer', (location.origin || 'https://member.bilibili.com') + '/'); } catch(_) {}
              try { xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); } catch(_) {}
              xhr.timeout = 8000;
              xhr.onload = function() {
                try {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    var resp = JSON.parse(xhr.responseText || 'null');
                    resolve({ ok: true, status: xhr.status, raw: resp, respLen: (xhr.responseText || '').length });
                  } else {
                    resolve({ ok: false, status: xhr.status, err: 'HTTP_' + xhr.status, text: xhr.responseText && xhr.responseText.substring ? xhr.responseText.substring(0, 200) : '' });
                  }
                } catch(parseErr) {
                  resolve({ ok: false, status: xhr.status, err: 'PARSE_ERR:' + (parseErr && parseErr.message || '') });
                }
              };
              xhr.onerror = function() { resolve({ ok: false, status: xhr.status, err: 'NETWORK_ERR' }); };
              xhr.ontimeout = function() { resolve({ ok: false, status: xhr.status, err: 'TIMEOUT' }); };
              xhr.send();
            } catch(e) {
              resolve({ ok: false, status: 0, err: 'XHR_SEND_ERR:' + (e && e.message || '') });
            }
          });
        })();
      `);
      if (navResult && navResult.ok && navResult.raw && navResult.raw.code === 0 && navResult.raw.data) {
        apiInfo = navResult.raw.data;
        // 字段值做净化（去掉可能包裹的引号/反引号，防御性处理）
        if (apiInfo.face !== undefined) apiInfo.face = _cleanStr(apiInfo.face);
        if (apiInfo.avatar !== undefined) apiInfo.avatar = _cleanStr(apiInfo.avatar);
        if (apiInfo.uname !== undefined) apiInfo.uname = _cleanStr(apiInfo.uname);
        if (apiInfo.mid !== undefined) apiInfo.mid = _cleanStr(apiInfo.mid);
        // URL 规范化：协议相对路径补 https、B 站域名 http→https、dataURI 过滤
        const faceNorm = _normalizeUrl(apiInfo.face);
        const avatarNorm = _normalizeUrl(apiInfo.avatar);
        if (faceNorm) apiInfo.face = faceNorm;
        if (avatarNorm) apiInfo.avatar = avatarNorm;
        const faceFull = String(apiInfo.face || '');
        log('info', 'extractPageInfo', `API(nav) 成功: uname="${apiInfo.uname}", mid="${apiInfo.mid}", faceLen=${faceFull.length}, faceFull="${faceFull}"`);
      } else if (navResult) {
        apiError = `status=${navResult.status} err=${navResult.err || 'unknown'} code=${navResult.raw ? navResult.raw.code : 'n/a'} respLen=${navResult.respLen ?? 'n/a'}`;
      }
    } catch (e) {
      apiError = (e as Error).message;
    }
    if (apiError) {
      log('warn', 'extractPageInfo', `API(nav) 失败: ${apiError}，将回退 DOM 方案`);
    }

    // 如果 API 成功获取到信息，直接使用
    if (apiInfo && (apiInfo.uname || apiInfo.mid)) {
      // 尝试额外获取粉丝/关注数（关系接口）——同样用 XHR，失败不影响基础信息
      // 注意：B 站新版接口有些需要 WBI 签名，如果 relation/stat 未命中签名，follower/following 可能返回 0，
      // 这在粉丝数为 0 时是可接受的兜底；失败时打日志但不阻塞头像/昵称等基础字段返回
      let fansCount = 0;
      let followCount = 0;
      let statError = '';
      let statCode = 'n/a';
      let statFollowerRaw: unknown = null;
      let statFollowingRaw: unknown = null;
      if (apiInfo.mid) {
        try {
          const statResult: any = await win.webContents.executeJavaScript(`
            (function() {
              var mid = ${JSON.stringify(String(apiInfo.mid))};
              return new Promise(function(resolve) {
                try {
                  var xhr = new XMLHttpRequest();
                  xhr.open('GET', 'https://api.bilibili.com/x/relation/stat?vmid=' + encodeURIComponent(mid), true);
                  xhr.withCredentials = true;
                  try { xhr.setRequestHeader('Accept', 'application/json, text/plain, */*'); } catch(_) {}
                  try { xhr.setRequestHeader('Referer', (location.origin || 'https://member.bilibili.com') + '/'); } catch(_) {}
                  try { xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); } catch(_) {}
                  xhr.timeout = 6000;
                  xhr.onload = function() {
                    try {
                      if (xhr.status >= 200 && xhr.status < 300) {
                        var resp = JSON.parse(xhr.responseText || 'null');
                        resolve({ ok: true, status: xhr.status, raw: resp, respLen: (xhr.responseText || '').length });
                      } else {
                        resolve({ ok: false, status: xhr.status, err: 'HTTP_' + xhr.status });
                      }
                    } catch(parseErr) {
                      resolve({ ok: false, status: xhr.status, err: 'PARSE_ERR:' + (parseErr && parseErr.message || '') });
                    }
                  };
                  xhr.onerror = function() { resolve({ ok: false, status: xhr.status, err: 'NETWORK_ERR' }); };
                  xhr.ontimeout = function() { resolve({ ok: false, status: xhr.status, err: 'TIMEOUT' }); };
                  xhr.send();
                } catch(e) {
                  resolve({ ok: false, status: 0, err: 'XHR_SEND_ERR:' + (e && e.message || '') });
                }
              });
            })();
          `);
          if (statResult && statResult.ok && statResult.raw && statResult.raw.code === 0 && statResult.raw.data) {
            const d = statResult.raw.data;
            statFollowerRaw = d.follower;
            statFollowingRaw = d.following;
            fansCount = typeof d.follower === 'number' ? d.follower : parseInt(String(d.follower || '0'), 10) || 0;
            followCount = typeof d.following === 'number' ? d.following : parseInt(String(d.following || '0'), 10) || 0;
            log('info', 'extractPageInfo', `API(relation/stat) 成功: raw.follower=${statFollowerRaw}, raw.following=${statFollowingRaw}, parsed.follower=${fansCount}, parsed.following=${followCount}`);
          } else if (statResult) {
            statCode = statResult.raw ? String(statResult.raw.code) : 'n/a';
            statError = `status=${statResult.status} err=${statResult.err || ''} code=${statCode} respLen=${statResult.respLen ?? 'n/a'}`;
          }
        } catch (e2) {
          statError = (e2 as Error).message;
        }
      }
      if (statError) {
        log('warn', 'extractPageInfo', `API(relation/stat) 失败: ${statError}，粉丝/关注数用 0 兜底`);
      }

      // 返回前再跑一次"强清洗 + URL 规范化 + 校验"的最终守卫。
      // 历史踩坑：executeJavaScript 里 JSON.parse(nav 接口响应) 后，apiInfo.face 曾经被前后包上反引号 `` ` ``
      // （你最新日志 FINAL RETURN 里 avatar= 就是被反引号包住的），光在字段提取阶段清洗一次不够，
      // 必须在返回对象构造之前对最终值再"全局去反引号 + B 站域名 http→https 升级 + 肉眼可验证的诊断日志"。
      const rawAvatarBeforeGuard = apiInfo.face || apiInfo.avatar || '';
      const _cleanOnce = (v: unknown) => _normalizeUrl(v); // _normalizeUrl 内部已先跑 _cleanStr
      const guardAvatar = _cleanOnce(apiInfo.face) || _cleanOnce(apiInfo.avatar) || '';
      const guardNickname = _cleanStr(apiInfo.uname);
      const guardPid = _cleanStr(apiInfo.mid);
      const result: ExtractedAccountInfo = {
        nickname: guardNickname,
        avatar: guardAvatar,
        platformAccountId: guardPid, // B站 UID（纯数字）
        userId: guardPid || undefined,
        fansCount,
        followCount,
        likeCount: 0, // B 站导航接口和关系接口不直接返回总获赞数
      };
      // 【逐字符诊断】如果清洗完仍看到 avatar 前后"看起来有引号"，就打这一段 charCode 日志，精确识别到底是哪个字符：
      //   每个字符格式为 "<字符字面>:U+<十六进制码位>"，例如 "`:U+0060"、"´:U+00B4"、"‘:U+2018"
      //   正常干净的 URL 应该以 "h:U+0068 t:U+0074 t:U+0074" 开头、以 "g:U+0067（.jpg）" 结尾
      if (guardAvatar && (guardAvatar.length < 10 || /[`"'´`‘’"｀]/.test(guardAvatar) || !/^https?:\/\//i.test(guardAvatar))) {
        const head: string[] = [];
        const tail: string[] = [];
        const headCount = Math.min(6, guardAvatar.length);
        const tailCount = Math.min(6, guardAvatar.length);
        for (let i = 0; i < headCount; i++) {
          const ch = guardAvatar.charAt(i);
          head.push(`${ch}:U+${guardAvatar.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
        }
        for (let i = Math.max(0, guardAvatar.length - tailCount); i < guardAvatar.length; i++) {
          const ch = guardAvatar.charAt(i);
          tail.push(`${ch}:U+${guardAvatar.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
        }
        log('warn', 'extractPageInfo', `[CHARCODE] guardAvatar 疑似仍有异常字符 → 前${headCount}个: [${head.join(' | ')}] | 后${tailCount}个: [${tail.join(' | ')}] | 完整值: "${guardAvatar}"`);
      }
      const finalAvatar = result.avatar || '';
      log('info', 'extractPageInfo', `FINAL RETURN from API path → (GUARD 校验) rawAvatarBeforeGuard="${String(rawAvatarBeforeGuard || '').substring(0, 160)}", guardAvatar.len=${finalAvatar.length}, guardAvatar="${finalAvatar}", nickname="${result.nickname}", platformAccountId="${result.platformAccountId}", fans=${result.fansCount ?? 'n/a'}, follow=${result.followCount ?? 'n/a'}, like=${result.likeCount ?? 'n/a'}`);
      return result;
    }

    // API 失败时从 DOM 提取兜底
    log('info', 'extractPageInfo', 'API 未返回数据，尝试 DOM 提取');

    // 分步提取，避免单个大脚本执行失败导致全部信息丢失
    let nickname = '';
    let avatar = '';
    let platformAccountId = '';
    let fansCount = 0;
    let followCount = 0;
    let likeCount = 0;

    // 1. 提取昵称
    try {
      nickname = await win.webContents.executeJavaScript(`
        (function() {
          try {
            var sel = [
              '.user-info .name',
              '.username',
              '.nick-name',
              '[class*="user-name"]',
              '[class*="nickname"]',
              '.header .name',
              '.topbar-user .name',
              '.account-info .name',
              '.user-card .name',
            ];
            for (var i = 0; i < sel.length; i++) {
              var el = document.querySelector(sel[i]);
              if (el && el.textContent) {
                var t = el.textContent.trim();
                if (t && t.length < 50 && t !== '哔哩哔哩'
                    && t.indexOf('下午好') < 0 && t.indexOf('上午好') < 0
                    && t.indexOf('晚上好') < 0 && t.indexOf('欢迎') < 0
                    && t.indexOf('创作中心') < 0) {
                  return t;
                }
              }
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
            function _fixUrl(u) {
              if (!u) return '';
              var s = String(u).trim();
              if (!s) return '';
              // 过滤 dataURI 占位图/透明图（非头像）
              if (s.indexOf('data:') === 0) return '';
              if (s.indexOf('1x1') !== -1 && s.indexOf('base64') !== -1) return '';
              if (s.indexOf('transparent') !== -1 && s.indexOf('base64') !== -1) return '';
              // 协议相对路径 //xxx 补 https:
              if (s.indexOf('//') === 0) return 'https:' + s;
              // 相对路径 /xxx 不处理（用户头像 CDN 都是绝对/协议相对）
              if (s.indexOf('/') === 0 && s.indexOf('//') !== 0) return '';
              if (s.indexOf('http:') === 0 || s.indexOf('https:') === 0) return s;
              return '';
            }
            function _readImgSrc(img) {
              if (!img) return '';
              // 读取所有可能放真实地址的属性（B 站的 custom-lazy-img 可能用 data-*）
              var raw = img.getAttribute('data-src') ||
                        img.getAttribute('data-lazy-src') ||
                        img.getAttribute('data-original-src') ||
                        img.getAttribute('data-original') ||
                        img.getAttribute('data-url') ||
                        img.getAttribute('data-source') ||
                        img.getAttribute('data-srcset') ||
                        img.src ||
                        img.getAttribute('src') ||
                        '';
              // srcset 情况：取第一个候选的 URL 部分
              if (raw && typeof raw === 'string' && raw.indexOf(' ') !== -1 && raw.indexOf(',') !== -1) {
                var first = raw.split(',')[0];
                if (first) raw = first.trim().split(' ')[0];
              }
              return raw || '';
            }
            function _isBiliFaceUrl(u) {
              return u && (
                u.indexOf('/bfs/face/') !== -1 ||   // 用户头像 CDN 硬特征（不会与静态 icon 冲突）
                u.indexOf('hdslb.com/bfs/face/') !== -1
              );
            }

            // === 第一层（最可靠）：全页面扫 img，按 CDN 特征找头像 ===
            // B 站用户头像一定在 i<N>.hdslb.com/bfs/face/ 下，而花生AI/updream 这些静态 icon
            // 的路径是 /static/svg/ 或 /static/image/，完全不含 /bfs/face/，不会误判
            try {
              var allImgs = document.querySelectorAll('img');
              var len = allImgs ? allImgs.length : 0;
              var i, raw, fixed;
              // 先扫含 custom-lazy-img 的 img（创作中心头像就是这个类），命中更快
              for (i = 0; i < len; i++) {
                var ci = allImgs[i];
                if (!ci || !ci.className || String(ci.className).indexOf('custom-lazy-img') < 0) continue;
                raw = _readImgSrc(ci);
                if (!raw) continue;
                if (_isBiliFaceUrl(raw)) {
                  fixed = _fixUrl(raw);
                  if (fixed) return fixed;
                }
              }
              // 再扫所有 img，只要 URL 含 /bfs/face/ 就是头像
              for (i = 0; i < len; i++) {
                raw = _readImgSrc(allImgs[i]);
                if (!raw) continue;
                if (_isBiliFaceUrl(raw)) {
                  fixed = _fixUrl(raw);
                  if (fixed) return fixed;
                }
              }
            } catch(_) { /* ignore */ }

            // === 第二层（次可靠）：从用户空间链接反推内部 img ===
            try {
              var spaceLinks = document.querySelectorAll('a[href*="space.bilibili.com"]');
              for (var li = 0; spaceLinks && li < spaceLinks.length; li++) {
                var link = spaceLinks[li];
                if (!link) continue;
                var linkImgs = link.querySelectorAll('img');
                for (var lj = 0; linkImgs && lj < linkImgs.length; lj++) {
                  raw = _readImgSrc(linkImgs[lj]);
                  if (!raw) continue;
                  fixed = _fixUrl(raw);
                  if (fixed) return fixed;
                }
              }
            } catch(_) { /* ignore */ }

            // === 第三层：组合选择器兜底（取 querySelectorAll 里所有候选，不拿第一个） ===
            var selectorGroups = [
              'a.avatar img.custom-lazy-img',
              'img.custom-lazy-img',
              'a[href*="space.bilibili.com"] img',
              '.avatar img',
              'a.avatar img',
              '.user-info img',
              '[class*="avatar"] img',
              'img.avatar',
              '.header img',
              '.topbar-user img',
              '.account-info img',
              '.user-card img',
            ];
            for (var si = 0; si < selectorGroups.length; si++) {
              try {
                var candidates = document.querySelectorAll(selectorGroups[si]);
                if (!candidates || candidates.length === 0) continue;
                for (var ci2 = 0; ci2 < candidates.length; ci2++) {
                  raw = _readImgSrc(candidates[ci2]);
                  if (!raw) continue;
                  // 这一层放宽限制：只要能修成合法 http(s) 就返回（CDN 特征已经在上面用过了）
                  fixed = _fixUrl(raw);
                  if (fixed) return fixed;
                }
              } catch(_) { /* ignore单个选择器异常 */ }
            }
            return '';
          } catch(e) { return ''; }
        })()
      `) || '';
      if (avatar) {
        // DOM 脚本返回的 URL 也可能带反引号（前面 API 方案已多次出现过），
        // 这里用主进程的 _normalizeUrl（内部已先全局 _cleanStr）再做一次最终守卫，避免 DOM 版也带反引号。
        avatar = _normalizeUrl(avatar) || avatar;
        const rawAvatarDom = avatar; // 记录 _normalizeUrl 之后的值用于日志
        log('info', 'extractPageInfo', `头像提取成功 (DOM 兜底): len=${rawAvatarDom.length}, full="${rawAvatarDom.substring(0, 120)}"`);
      } else {
        log('warn', 'extractPageInfo', '头像 DOM 兜底提取结果为空');
      }
    } catch (e) {
      log('warn', 'extractPageInfo', '提取头像失败: ' + (e as Error).message);
    }

    // 3. 提取平台账号ID（UID）
    //    优先从 cookie 中的 DedeUserID 读取，再从 DOM 文本匹配
    try {
      const cookies = await win.webContents.session.cookies.get({});
      const dedeUid = cookies.find((c) => c.name === 'DedeUserID' && c.value);
      if (dedeUid && dedeUid.value) {
        platformAccountId = dedeUid.value;
      }
    } catch {
      // ignore
    }
    if (!platformAccountId) {
      try {
        platformAccountId = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var bodyText = document.body ? (document.body.innerText || '') : '';
              // 匹配 "UID: 123456" 或 "UID 123456" 格式
              var m = bodyText.match(/UID[：:\\s]*([0-9]{3,12})/);
              if (m && m[1]) return m[1];
              // 匹配链接中的 space.bilibili.com/<uid>
              var links = document.querySelectorAll('a[href*="space.bilibili.com"]');
              for (var i = 0; i < links.length; i++) {
                var href = links[i].getAttribute('href') || '';
                var lm = href.match(/space\\.bilibili\\.com\\/([0-9]{3,12})/);
                if (lm && lm[1]) return lm[1];
              }
              return '';
            } catch(e) { return ''; }
          })()
        `) || '';
      } catch (e) {
        log('warn', 'extractPageInfo', '提取UID失败: ' + (e as Error).message);
      }
    }

    // 4. 提取粉丝/关注/获赞数（DOM 文本正则兜底）
    try {
      const stats = await win.webContents.executeJavaScript(`
        (function() {
          try {
            function _parseNumber(s) {
              if (!s) return 0;
              var t = String(s).replace(/\\s+/g, '').replace(/,/g, '');
              var base = parseFloat(t);
              if (isNaN(base)) return 0;
              if (t.indexOf('万') !== -1) base *= 10000;
              else if (t.indexOf('千') !== -1) base *= 1000;
              else if (t.indexOf('百') !== -1) base *= 100;
              return Math.round(base);
            }
            var bodyText = document.body ? (document.body.innerText || '') : '';
            var fans = 0, follow = 0, like = 0;
            var fm;
            // 粉丝数（两种格式）
            fm = bodyText.match(/(粉丝|粉丝数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);
            if (fm) fans = _parseNumber(fm[2]);
            else { fm = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(粉丝|粉丝数)/); if (fm) fans = _parseNumber(fm[1]); }
            // 关注数
            fm = bodyText.match(/(关注|关注数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);
            if (fm) follow = _parseNumber(fm[2]);
            else { fm = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(关注|关注数)/); if (fm) follow = _parseNumber(fm[1]); }
            // 获赞/点赞
            fm = bodyText.match(/(获赞|点赞|点赞数)[^0-9]{0,5}(\\d+(?:\\.\\d+)?[万千百]?)/);
            if (fm) like = _parseNumber(fm[2]);
            else { fm = bodyText.match(/(\\d+(?:\\.\\d+)?[万千百]?)[^0-9]{0,5}(获赞|点赞|点赞数)/); if (fm) like = _parseNumber(fm[1]); }
            return { fansCount: fans, followCount: follow, likeCount: like };
          } catch(e) {
            return { fansCount: 0, followCount: 0, likeCount: 0 };
          }
        })()
      `);
      fansCount = (stats as any)?.fansCount || 0;
      followCount = (stats as any)?.followCount || 0;
      likeCount = (stats as any)?.likeCount || 0;
    } catch (e) {
      log('warn', 'extractPageInfo', '提取统计数据失败: ' + (e as Error).message);
    }

    // DOM 兜底方案也执行一次"最终 GUARD 守卫"：
    //   nickname / avatar / platformAccountId / userId 全部再 _cleanStr 或 _normalizeUrl 一次，
    //   避免 DOM 脚本里有带反引号/多余空白的脏值。
    const gNick = _cleanStr(nickname);
    const gAvatar = _normalizeUrl(avatar) || '';
    const gPid = _cleanStr(platformAccountId);
    const guardResult: ExtractedAccountInfo = {
      nickname: gNick,
      avatar: gAvatar,
      platformAccountId: gPid,
      userId: gPid || undefined,
      fansCount,
      followCount,
      likeCount,
    };
    const domFinalAvatar = guardResult.avatar || '';
    log('info', 'extractPageInfo', `FINAL RETURN from DOM fallback path → (GUARD 校验) avatar.len=${domFinalAvatar.length}, avatar="${domFinalAvatar}", nickname="${guardResult.nickname}", platformAccountId="${guardResult.platformAccountId}", fans=${guardResult.fansCount ?? 'n/a'}, follow=${guardResult.followCount ?? 'n/a'}, like=${guardResult.likeCount ?? 'n/a'}`);
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
  log('warn', 'publishVideo', 'B站视频发布功能尚未实现');
  return makeFailedResult(accountId, 'bilibili', 'B站视频发布功能待实现', startedAt);
}

async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  log('warn', 'publishImage', 'B站图文发布功能尚未实现');
  return makeFailedResult(accountId, 'bilibili', 'B站图文发布功能待实现', startedAt);
}

async function publishArticle(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  log('warn', 'publishArticle', 'B站专栏发布功能尚未实现');
  return makeFailedResult(accountId, 'bilibili', 'B站专栏发布功能待实现', startedAt);
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
        'bilibili',
        `不支持的内容类型: ${request.contentType}`,
        Date.now(),
      );
  }
}

// ========================= 注册适配器 =========================

const adapter: PlatformAdapter = {
  key: 'bilibili',
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

log('info', 'register', '哔哩哔哩平台适配器已注册（账号管理已接入，发布功能待实现）');

export default adapter;
export { meta as bilibiliMeta };
