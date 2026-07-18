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

/** 登录态嗅探：能找到用户菜单且找不到登录入口，通常视为已登录 */
function detectLogin(): boolean {
  try {
    const loginEntry = document.querySelector(
      'a[href*="login"], a[href*="passport"], button.login, .login-btn, [class*="login-entry"]',
    );
    const userMenu = document.querySelector(
      '[class*="avatar"], [class*="user-menu"], [class*="userMenu"], img[class*="avatar"], [class*="userinfo"]',
    );
    return !!userMenu && !loginEntry;
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

// 自动上报：页面就绪后上报一次，并轻量持续监控登录态（10s 周期）
function scheduleAuto(): void {
  try {
    send('ready', { title: document.title });
  } catch {
    /* noop */
  }
  try {
    send('login', { loggedIn: detectLogin() });
  } catch {
    /* noop */
  }
  setInterval(() => {
    try {
      send('login', { loggedIn: detectLogin() });
    } catch {
      /* noop */
    }
  }, 10000);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', scheduleAuto);
} else {
  scheduleAuto();
}
