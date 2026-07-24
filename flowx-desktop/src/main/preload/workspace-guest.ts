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

/** 自动化体检：关键布局节点是否缺失 + 节点总数 */
function diagnoseDom(): { ok: boolean; missing: string[]; nodeCount: number } {
  try {
    const critical = ['header', 'main', 'nav', '#root', '#app'];
    const missing = critical.filter((sel) => !document.querySelector(sel));
    return { ok: missing.length === 0, missing, nodeCount: document.getElementsByTagName('*').length };
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
