/**
 * 创作中心 <webview> 的「访客预加载脚本（Guest Preload）」
 *
 * 设计要点（对应核心技术方案第 3 点「预加载脚本与安全边界」）：
 *  - 该脚本运行在 <webview> 独立的 Guest Process 中，与主渲染进程完全隔离。
 *  - 宿主主窗口已设置 webview webpreferences="sandbox=true,contextIsolation=true"，
 *    因此本脚本被**沙箱化**：禁止使用任何 Node API（fs/path 等），
 *    只允许 contextBridge + ipcRenderer.sendToHost（Electron 沙箱白名单）。
 *  - 这样即使抖音/小红书后台的恶意脚本也无法穿透到桌面端主进程，保障本机安全。
 *
 * 它负责在「安全隔离环境」中实现：
 *  1) 登录状态监控（monitorLogin）—— 周期上报登录态
 *  2) 粉丝/点赞等统计数据抓取（getCreatorStats）
 *  3) 自动化体检中心的 DOM 诊断（runDiagnosis）
 * 上报通道：ipcRenderer.sendToHost('flowx-guest', {...}) → 宿主渲染进程 webview 'ipc-message' 监听。
 * 若沙箱/安全策略禁止 sendToHost，宿主端会用 executeJavaScript 主动拉取（优雅降级）。
 */
import { contextBridge, ipcRenderer } from 'electron';

// webview guest 的全局类型放宽（preload 运行于类渲染上下文，但构建时未必包含 DOM lib）
declare const window: any;
declare const document: any;
declare const location: any;

const CHANNEL = 'flowx-guest';

function send(type: string, payload?: unknown): void {
  try {
    ipcRenderer.sendToHost(CHANNEL, { type, payload, href: location.href, ts: Date.now() });
  } catch {
    // 沙箱或安全策略可能拦截 IPC；宿主端会以 executeJavaScript 兜底拉取，这里静默忽略。
  }
}

// ---- 平台无关的轻量诊断实现（仅读 DOM，不触碰主进程、不依赖 Node） ----

/** 元素是否在视口中可见（排除 display:none / 零尺寸，避免已登录页残留的隐藏登录链接误判未登录） */
function isVisibleEl(el: any): boolean {
  try {
    if (!el) return false;
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
    if (el.getClientRects && el.getClientRects().length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 登录态嗅探：综合「不在登录页 + 有用户菜单/账号信息 + 无可见登录入口」判定已登录。
 * 选择器汇集主进程各平台 adapter 的 DOM 判断（zhihu.ts / wechat_official.ts 等）。
 *
 * 微信公众号特殊处理：已登录也可能停在 loginpage 形态 URL（cookie 仍有效，主进程以
 * 强 cookie 绕过），guest 读不到 cookie，故微信不以 URL 含 login 直接判未登录，而是
 * 完全以 DOM 信号为准（对齐 wechat_official.ts buildDetectLoggedInScript）。
 */
function detectLogin(): boolean {
  try {
    const href = (location.href || '').toLowerCase();
    const isWechat = href.indexOf('mp.weixin.qq.com') !== -1;

    // 1) 通用登录页直接判未登录（微信除外，见上）
    if (!isWechat && /(^|\/)(login|signin|sign_in|passport|sso)(\b|[\/?#])/i.test(href)) return false;

    // 取页面文本（供「退出」/微信关键词信号使用）
    let txt = '';
    try {
      txt = (document.body && (document.body.innerText || document.body.textContent)) || '';
    } catch {
      /* noop */
    }

    // 2) 微信公众号：对齐主进程 buildDetectLoggedInScript，纯 DOM 三选一
    if (isWechat) {
      const wechatKws = ['首页', '图文素材', '已发送', '用户管理', '功能', '设置', '退出'];
      let kw = 0;
      for (let i = 0; i < wechatKws.length; i++) {
        if (txt.indexOf(wechatKws[i]) !== -1) kw++;
      }
      const hasLogout = txt.indexOf('退出') !== -1 && txt.indexOf('设置') !== -1;
      const hasAccountInfo =
        !!document.querySelector('.weui-desktop_name') ||
        !!document.querySelector('.weui-desktop-person_info') ||
        !!document.querySelector('.weui-desktop-account__nickname') ||
        !!document.querySelector('[class*="desktop_name"]');
      return kw >= 2 || hasLogout || hasAccountInfo;
    }

    // 3) 通用强信号：页面含「退出」字样（已登录专属）
    if (txt.indexOf('退出') !== -1) return true;

    // 4) 正向信号：各平台已登录的 DOM 特征
    const userSel = [
      // 通用
      '[class*="avatar" i]',
      'img[class*="avatar" i]',
      '[class*="user-menu" i]',
      '[class*="userMenu" i]',
      '[class*="userinfo" i]',
      '[class*="profile" i]',
      // 知乎 creator.zhihu.com
      '.AppHeader-profile',
      '.AppHeader-userInfo',
      '.CreatorHomeProfile-name',
      'a.UserLink-link',
    ].join(',');
    const userMenu = document.querySelector(userSel);
    if (!userMenu) return false;

    // 5) 负向信号：仅当存在「可见」的登录入口才推翻（已登录页残留的隐藏登录链接不计入）
    const loginSel =
      'a[href*="login" i], a[href*="passport" i], a[href*="signin" i], a[href*="sign_in" i], button.login, .login-btn, [class*="login-entry" i]';
    const loginNodes: any = document.querySelectorAll(loginSel);
    let hasVisibleLogin = false;
    if (loginNodes && loginNodes.forEach) {
      loginNodes.forEach((n: any) => {
        if (isVisibleEl(n)) hasVisibleLogin = true;
      });
    }
    return !hasVisibleLogin;
  } catch {
    return false;
  }
}

/** 创作者数据统计抓取（粉丝/点赞等）—— 按常见 class 嗅探 */
function scrapeStats(): { followers?: string; likes?: string } {
  try {
    const pick = (sel: string): string | undefined => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : undefined;
    };
    return {
      followers: pick('[class*="follower"],[class*="fans"],[data-e2e*="follow"],[class*="fans-count"]'),
      likes: pick('[class*="like"],[data-e2e*="like"],[class*="liked-count"]'),
    };
  } catch {
    return {};
  }
}

/**
 * 自动化体检：平台无关的 DOM 渲染健康诊断。
 *
 * 旧实现写死 ['header','main','nav','#root','#app'] 五类脚手架约定，但抖音/小红书/快手/知乎等
 * 创作后台几乎不用语义标签 <header>/<nav>、根节点 id 也不是 #root（小红书是 #app、抖音是其它），
 * 导致这三项「永远」查不到、每次都误报缺失，掩盖了真正的渲染异常。
 *
 * 新实现改为平台无关的四维判断，任何正常渲染的第三方页都应判为「完整」：
 *  1) 文档骨架：html / body 是否存在（任何页面都必有，缺失即真崩）
 *  2) 内容充分性：节点总数与可见正文是否达到「真渲染」阈值（白屏/崩溃页节点极少且无正文）
 *  3) 布局壳：语义标签（header/main/nav）或常见 class 容器（header/nav/layout/container/content）任一存在
 *  4) 异常页特征：短正文 + 命中 404/502/连接失败/ERR_ 等已知错误签名，明确提示而非误判为「正常」
 */
const ERR_SIGNATURES = ['页面不存在', '页面走丢了', '连接失败', '网络异常', '无法访问', '404', '502', '503', 'err_', 'not found'];

function diagnoseDom(): { ok: boolean; missing: string[]; nodeCount: number } {
  try {
    const missing: string[] = [];
    const root = document.documentElement;
    const body = document.body;
    const nodeCount = document.getElementsByTagName('*').length;

    // 1) 文档骨架
    if (!root) missing.push('html');
    if (!body) missing.push('body');

    // 2) 内容充分性：正常渲染页节点众多且有可见正文；白屏/崩溃页节点极少且无正文
    const bodyText = body ? (body.innerText || body.textContent || '').trim() : '';
    const hasContent = nodeCount > 80 && bodyText.length > 0;
    if (!hasContent) missing.push('content');

    // 3) 布局壳：语义标签或常见 class 容器任一存在即认为骨架在（兼容各平台不同实现）
    const hasShell = !!document.querySelector(
      'header, main, nav, [class*="header" i], [class*="nav" i], [class*="layout" i], [class*="container" i], [class*="content" i]',
    );
    if (!hasShell) missing.push('layout-shell');

    // 4) 异常页特征：仅在「短正文」页命中错误签名才标记，避免正常内容里的偶发关键字误判
    const lowerText = bodyText.toLowerCase();
    const hitErr = ERR_SIGNATURES.some((s) => lowerText.indexOf(s.toLowerCase()) !== -1) && bodyText.length < 300;
    if (hitErr) missing.push('error-page');

    return { ok: missing.length === 0, missing, nodeCount };
  } catch {
    return { ok: false, missing: ['<error>'], nodeCount: 0 };
  }
}

// 暴露给访客页面（以及宿主 executeJavaScript 主动拉取）
contextBridge.exposeInMainWorld('flowxGuest', {
  monitorLogin: () => {
    const r = detectLogin();
    send('login', { loggedIn: r });
    return r;
  },
  getCreatorStats: () => {
    const r = scrapeStats();
    send('stats', r);
    return r;
  },
  runDiagnosis: () => {
    const r = diagnoseDom();
    send('diagnosis', r);
    return r;
  },
  url: () => location.href,
});

// 自动上报：页面就绪即上报，并在 SPA 异步渲染期快速轮询，避免「页面已加载但登录态迟迟不刷新」
function scheduleAuto(): void {
  try {
    send('ready', { title: document.title });
  } catch {
    /* noop */
  }

  const reportLogin = (): void => {
    try {
      send('login', { loggedIn: detectLogin() });
    } catch {
      /* noop */
    }
  };

  // 1) 立即上报一次（DOM 就绪）
  reportLogin();

  // 2) 完整 load（含子资源）后再上报一次：SPA 此时通常已渲染出用户菜单/头像
  if (document.readyState === 'complete') {
    reportLogin();
  } else {
    window.addEventListener('load', reportLogin, { once: true });
  }

  // 3) 快速收敛阶段：前 ~8s 以 1.2s 短间隔轮询，覆盖异步渲染的头像/用户菜单出现窗口，
  //    头像一出现即可在 1.2s 内翻成「已登录」，而非盲等 10s；之后回落到低频 10s 持续监控。
  let fastTicks = 0;
  const FAST_INTERVAL = 1200;
  const FAST_MAX_TICKS = 7; // 7 * 1.2s ≈ 8.4s
  const fastInterval = setInterval(() => {
    reportLogin();
    if (++fastTicks >= FAST_MAX_TICKS) {
      clearInterval(fastInterval);
      setInterval(reportLogin, 10000);
    }
  }, FAST_INTERVAL);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', scheduleAuto);
} else {
  scheduleAuto();
}
