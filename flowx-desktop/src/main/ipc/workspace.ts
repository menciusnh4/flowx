import { app, BrowserWindow, webContents } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { safeInvoke } from './index';
import { workspaceWebViewController } from '../services/WorkspaceWebViewController';
import { logger } from '../utils/logger';

/**
 * 账号创作中心「内嵌主窗口」的 IPC 通道（DOM <webview> 方案）。
 * 渲染层 AccountWorkspace.vue 直接用 <webview> 完成导航/显隐，主进程只负责：
 *  - workspace-webview:ensure  → 预建隔离分区 + 应用环境 + 返回首页 URL / 隔离结果
 *  - workspace-webview:close   → 记账清理
 * 原生层时代的 activate/deactivateAll/setRect/back/forward/reload/home/newTab/activateInner/closeInner/toggleDevTools
 * 已全部移除（那些是 WebContentsView 原生层专属，webview 由渲染层直接驱动）。
 */
export function registerWorkspaceIpc(): void {
  safeInvoke('workspace-webview:ensure', (accountId: string, title: string) =>
    workspaceWebViewController.ensure(accountId, title),
  );

  safeInvoke('workspace-webview:close', (accountId: string) => {
    workspaceWebViewController.close(accountId);
    return { ok: true };
  });

  // 双保险手动挂载通道：当全局 web-contents-created 因时序/类型判定逃逸时，
  // 允许前端通过 getWebContentsId() 手动完成可靠挂载 setWindowOpenHandler 弹窗拦截。
  safeInvoke('workspace-webview:registerPopups', async (wcId: number, accountId: string) => {
    const wc = webContents.fromId(wcId);
    if (!wc) {
      logger.warn(`[workspace] 手动挂载拦截失败，未找到 WebContents 实例: wcId=${wcId}, accountId=${accountId}`);
      return { ok: false, error: 'WebContents 实例未找到' };
    }

    wc.setWindowOpenHandler((details) => {
      const url = details.url;
      if (!url || !/^https?:\/\//i.test(url)) return { action: 'deny' };

      const mainWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (mainWin) {
        mainWin.webContents.send('workspace:new-inner-tab', {
          url,
          referrer: details.referrer?.url || '',
          accountId,
        });
      }
      return { action: 'deny' };
    });

    const blockNonHttp = (_event: Electron.Event, navUrl: string) => {
      if (!/^https?:\/\//i.test(navUrl)) _event.preventDefault();
    };
    wc.on('will-navigate' as any, blockNonHttp);
    wc.on('will-frame-navigate' as any, blockNonHttp);

    logger.info(`[workspace] IPC 弹窗拦截手动挂载成功: wcId=${wcId}, accountId=${accountId}`);
    return { ok: true };
  });

  // ============ 弹窗拦截（主进程，最可靠挂载点） ============
  // 通过 app 'web-contents-created' 在 guest WebContents「创建时」同步挂载 setWindowOpenHandler，
  // 这是 Electron 官方推荐的弹窗拦截方式，零异步竞态、零 getWebContentsId/fromId 轮询，
  // 且返回 { action: 'deny' } 在窗口创建「之前」就拦掉，绝不会生成原生弹窗（与 allowpopups 解耦）。
  app.on('web-contents-created', (_event: Electron.Event, contents: Electron.WebContents) => {
    // 仅对 <webview> 访客 WebContents 生效（主窗口 / DevTools / 后台页跳过）。
    // 用 getType()==='webview' 作可靠、同步判别——不依赖 session.partition 在创建时刻是否就绪。
    const type: string | undefined = (contents as any).getType?.();
    if (type && type !== 'webview') return;

    // 导航强阻断：仅放行 http(s)/about:/data:/file:/blob:，拦截防风控探测自定义协议
    // （如 bitbrowser://）触发 OS 弹窗 / 闪退。不影响正常的 https 页面加载与 SPA 站内跳转。
    const allowScheme = (u: string) => /^https?:|^about:|^data:|^file:|^blob:/i.test(u);
    const blockUnsafe = (_e: Electron.Event, navUrl: string) => {
      if (!allowScheme(navUrl)) _e.preventDefault();
    };
    contents.on('will-navigate' as any, blockUnsafe);
    contents.on('will-frame-navigate' as any, blockUnsafe);

    // 弹窗拦截：accountId 在「弹窗真正触发时」从 session.partition 解析（此刻 partition 必然已就绪），
    // 规避创建时刻 partition 未就绪导致漏挂、或依赖渲染层异步传参的竞态。
    contents.setWindowOpenHandler((details) => {
      const url = details.url;
      if (!url || !/^https?:\/\//i.test(url)) return { action: 'deny' };
      const partition: string = ((contents.session as any)?.partition as string) || '';
      const m = /^persist:account_(.+)$/.exec(partition);
      const accountId = m ? m[1] : '';
      const mainWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (mainWin) {
        mainWin.webContents.send('workspace:new-inner-tab', { accountId, url, referrer: details.referrer?.url || '' });
        logger.info(`[workspace] 弹窗拦截命中: accountId=${accountId || '(未知)'}, url=${url}`);
      }
      return { action: 'deny' };
    });

    logger.info(`[workspace] 弹窗拦截已挂载(web-contents-created): type=${type || '(未知)'}`);
  });

  // 返回创作中心 <webview> 的「访客预加载脚本」绝对路径（沙箱兼容，用于登录监控/统计抓取/DOM 体检）。
  // 渲染层在创建 <webview> 前通过 workspaceWebview.getGuestPreloadPath 获取，再绑定到 :preload。
  safeInvoke('workspace:getGuestPreloadPath', (): string => {
    // 开发期：app.getAppPath() = 项目根；vite-plugin-electron 已将产物构建到 dist-electron/preload-guest/
    // 生产期（asar 内）：需 electron-builder 将 preload-guest 解包到资源目录，否则 webview 无法从 asar 加载 preload。
    const p = path.join(app.getAppPath(), 'dist-electron', 'preload-guest', 'workspace-guest.js');
    if (!fs.existsSync(p)) {
      // 降级：极端时序下产物尚未构建，返回空串 → 渲染层 :preload 绑定为 null，
      // webview 仍可正常加载目标页面（仅登录监控/体检降级），避免 preload 缺失拖垮主流程。
      return '';
    }
    // 关键：<webview> 的 preload 属性强制要求 file:// 协议（不同于 BrowserWindow.preload 接受原生路径），
    // 否则预加载脚本解析失败会导致 guest 进程无法初始化，webview 永远卡在加载态。
    return pathToFileURL(p).toString();
  });

  // ============ M4：任务选项卡布局持久化（存盘 / 恢复） ============
  const stateFile = () => path.join(app.getPath('userData'), 'workspace-state.json');

  safeInvoke('workspace:saveState', (payload: unknown) => {
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(payload ?? {}), 'utf-8');
    } catch (e) {
      logger.warn('[workspace] 保存任务选项卡状态失败', e);
    }
    return { ok: true };
  });

  safeInvoke('workspace:loadState', (): unknown => {
    try {
      const p = stateFile();
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf-8');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      logger.warn('[workspace] 读取任务选项卡状态失败', e);
      return null;
    }
  });
}
