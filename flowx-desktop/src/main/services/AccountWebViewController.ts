import { WebContentsView, session, Menu, MenuItem } from 'electron';
import { BrowserEnvService } from './BrowserEnvService';
import { logger } from '../utils/logger';
import { SIDEBAR_W, TASKBAR_H, ACCOUNT_INFO_H, ACCOUNT_INNER_H } from './layout';
import { getMainWindow } from '../windows/MainWindow';
import type { WorkspaceWebviewTab } from '../../types';

/**
 * 宿主抽象：账号创作中心的原生视图（WebContentsView）可以挂在「独立弹窗」
 * 也可以挂在「主窗口 contentView」。控制器本身与宿主解耦，只通过本接口操作视图。
 */
export interface WebviewHost {
  /** 把视图挂到宿主（主窗口 contentView 或弹窗 contentView） */
  addChildView(v: WebContentsView): void;
  /** 从宿主移除视图 */
  removeChildView(v: WebContentsView): void;
  /**
   * 按宿主当前内容矩形设置视图位置/大小。
   * 控制器每次激活/新建 tab 时调用，由宿主自己决定最终坐标
   * （主窗口用渲染端上报的占位矩形；弹窗用「窗口尺寸 - tab 栏 - 工具条」）。
   * 注意：rect 由调用方（controller）携带，避免多账号共享同一个全局矩形导致串味。
   */
  setBounds(v: WebContentsView, rect: { x: number; y: number; width: number; height: number }): void;
}

/** 渲染层事件通知（accountId 维度的 tabs / url 变更） */
export interface WebviewNotifier {
  sendTabs(accountId: string, tabs: WorkspaceWebviewTab[], activeId: string): void;
  sendUrl(accountId: string, tabId: string, url: string, title: string): void;
  /** 隔离环境应用结果；ok=false 表示隔离失效（环境/代理丢失），渲染端据此兜底提示 */
  sendEnvStatus(accountId: string, ok: boolean, reason?: string): void;
}

interface WebviewTabItem {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
}

/**
 * 账号创作中心视图控制器（宿主无关）。
 *
 * 职责：
 *  - 维护该账号的多个内嵌子页签（inner tab），每个 = 一个 WebContentsView（复用 persist:account_${id} 隔离）。
 *  - 处理前进/后退/刷新/首页/新开页（target=_blank 自动落到新 inner tab）。
 *  - 隔离环境（partition + BrowserEnvService）零改动复用。
 *  - 视图的位置/显隐完全交给宿主（WebviewHost）+ 上层 WorkspaceWebViewController 调度。
 *
 * 不复用的部分：
 *  - 弹窗的 tab 栏 HTML 页面 / 工具条按钮 → 由宿主侧（CreatorTabWindow）自己渲染。
 *  - 主窗口侧的账号信息条 / inner 子页签条 → 由 Vue 层（AccountWorkspace.vue）渲染。
 */
export class AccountWebViewController {
  private tabs: WebviewTabItem[] = [];
  private activeTabId = '';
  private disposed = false;
  /** 该账号独立的占位矩形：主进程按窗口尺寸算出全尺寸兜底（不依赖渲染层测量时机）；
   *  渲染端 measure 上报真实矩形后覆盖 rectSet=true。show/setBounds 一律用自己记的，避免多账号串味。 */
  private rect = AccountWebViewController.computeDefaultRect();
  /** 是否已收到渲染端上报的真实矩形（未收到前用窗口尺寸兜底，保证视图必填满右侧） */
  private rectSet = false;
  /** 隔离环境应用结果（默认 ok，applyEnvironment 异步回填） */
  private envStatus: { ok: boolean; reason?: string } = { ok: true };
  /** 主进程兜底矩形：窗口尺寸 - 侧栏/任务条/信息条/inner 条偏移，保证视图默认就铺满右侧
   *  （彻底消除「依赖渲染层测量时机 → 测量不到就永远停在默认 800x600」的脆弱设计） */
  private static computeDefaultRect(): { x: number; y: number; width: number; height: number } {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { x: SIDEBAR_W, y: TASKBAR_H + ACCOUNT_INFO_H + ACCOUNT_INNER_H, width: 800, height: 600 };
    }
    const [width, height] = win.getSize();
    const x = SIDEBAR_W;
    const y = TASKBAR_H + ACCOUNT_INFO_H + ACCOUNT_INNER_H;
    return {
      x,
      y,
      width: Math.max(width - x, 320),
      height: Math.max(height - y, 240),
    };
  }

  constructor(
    private readonly host: WebviewHost,
    private readonly notifier: WebviewNotifier,
    public readonly accountId: string,
    public readonly homeUrl: string,
    public readonly windowTitle: string,
    private readonly envId?: string | null,
  ) {
    // 隔离环境：一次应用到该账号 partition（与弹窗完全一致）
    const sess = session.fromPartition(`persist:account_${accountId}`);
    BrowserEnvService.applyEnvironment(sess, envId)
      .then((res) => {
        this.envStatus = res;
        if (!res.ok) this.notifier.sendEnvStatus(this.accountId, false, res.reason || '隔离环境应用失败，已回退本机直连');
      })
      .catch(() => {
        this.envStatus = { ok: false, reason: '隔离环境应用异常，已回退本机直连' };
        this.notifier.sendEnvStatus(this.accountId, false, this.envStatus.reason);
      });

    // 首屏：默认打开创作中心首页
    this.createTab(homeUrl, '首页');
  }

  /** 当前激活的 inner tab */
  getActiveTab(): WebviewTabItem | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  getActiveTabId(): string {
    return this.activeTabId;
  }

  /** 渲染端 measure 后上报该账号独立的占位矩形（绝不写全局共享 rect） */
  setRect(rect: { x: number; y: number; width: number; height: number }): void {
    this.rect = rect;
    this.rectSet = true;
    logger.info(`[AccountWebViewController] setRect ${this.accountId} -> ${JSON.stringify(rect)}`);
  }

  /** 创建一个新 inner tab */
  createTab(url: string, title: string): string {
    if (this.disposed) return '';
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:account_${this.accountId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    const tab: WebviewTabItem = {
      id: tabId,
      view,
      title: title || url || '新标签页',
      url: url || 'about:blank',
    };

    view.webContents.on('page-title-updated', (_e, newTitle) => {
      if (this.disposed) return;
      tab.title = newTitle || tab.url;
      this.notifyTabsUpdate();
    });

    view.webContents.on('did-navigate', (_e, newUrl) => {
      if (this.disposed) return;
      tab.url = newUrl;
      this.notifier.sendUrl(this.accountId, tabId, newUrl, tab.title);
    });

    view.webContents.on('did-navigate-in-page', (_e, newUrl) => {
      if (this.disposed) return;
      tab.url = newUrl;
      this.notifier.sendUrl(this.accountId, tabId, newUrl, tab.title);
    });

    // target=_blank → 新 inner tab 打开
    view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
      if (!this.disposed) this.createTab(newUrl, '新标签页');
      return { action: 'deny' };
    });

    // 右键菜单：检查元素（直接 inspect 点击位置）+ 刷新 + 复制/粘贴 + 打开链接
    // 创作中心是独立 webContents，主窗口 DevTools 看不到它的 DOM，必须从本视图打开 DevTools。
    view.webContents.on('context-menu', (_e, params) => {
      const wc = view.webContents;
      if (this.disposed || wc.isDestroyed()) return;
      const menu = new Menu();
      menu.append(new MenuItem({ label: '刷新', click: () => { if (!wc.isDestroyed()) wc.reload(); } }));
      menu.append(
        new MenuItem({
          label: '在新标签页中打开链接',
          visible: !!params.linkURL,
          click: () => { if (params.linkURL) this.createTab(params.linkURL, '新标签页'); },
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: '复制',
          visible: params.editFlags.canCopy,
          click: () => { if (!wc.isDestroyed()) wc.copy(); },
        }),
      );
      menu.append(
        new MenuItem({
          label: '粘贴',
          visible: params.editFlags.canPaste,
          click: () => { if (!wc.isDestroyed()) wc.paste(); },
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: '检查元素',
          click: () => {
            if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
            wc.inspectElement(params.x, params.y);
          },
        }),
      );
      menu.popup();
    });

    // F12 / Ctrl+Shift+I：打开/关闭本视图 DevTools（detach 独立窗口，不被原生层遮挡）
    view.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        event.preventDefault();
        this.toggleDevTools();
      } else if (input.key === 'I' && input.control && input.shift && input.type === 'keyDown') {
        event.preventDefault();
        this.toggleDevTools();
      }
    });

    this.tabs.push(tab);
    this.host.addChildView(view);
    view.setVisible(false);

    this.activateTab(tabId);

    if (url && url !== 'about:blank') {
      view.webContents.loadURL(url).catch((err) => {
        logger.error(`[AccountWebViewController] loadURL error: ${err.message}`);
      });
    }

    return tabId;
  }

  /** 激活指定 inner tab（隐藏其它，显示自己，重设 bounds） */
  activateTab(tabId: string): void {
    if (this.disposed) return;
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;

    const prev = this.getActiveTab();
    if (prev && prev.id !== tabId && !prev.view.webContents.isDestroyed()) {
      prev.view.setVisible(false);
    }

    this.activeTabId = tabId;
    tab.view.setVisible(true);
    this.host.setBounds(tab.view, this.rect);
    this.notifyTabsUpdate();
  }

  /** 关闭指定 inner tab；若关闭的是激活项，回退到相邻项 */
  closeTab(tabId: string): void {
    if (this.disposed) return;
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const tab = this.tabs[idx];
    const wasActive = tab.id === this.activeTabId;

    try {
      this.host.removeChildView(tab.view);
    } catch {
      /* ignore */
    }
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }

    this.tabs.splice(idx, 1);

    if (wasActive && this.tabs.length > 0) {
      const nextIdx = Math.min(idx, this.tabs.length - 1);
      this.activateTab(this.tabs[nextIdx].id);
    }

    this.notifyTabsUpdate();
  }

  goBack(): void {
    const tab = this.getActiveTab();
    if (tab && tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
  }

  goForward(): void {
    const tab = this.getActiveTab();
    if (tab && tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
  }

  reload(): void {
    const tab = this.getActiveTab();
    if (tab) tab.view.webContents.reload();
  }

  /** 打开/关闭本账号激活 inner tab 的 DevTools（detach 独立窗口，不被原生层遮挡） */
  toggleDevTools(): void {
    if (this.disposed) return;
    const tab = this.getActiveTab();
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  goHome(): void {
    const tab = this.getActiveTab();
    if (tab && this.homeUrl) tab.view.webContents.loadURL(this.homeUrl).catch(() => {});
  }

  newTab(): void {
    this.createTab(this.homeUrl, '新标签页');
  }

  /** 显示本账号（激活项可见，其余隐藏，按宿主矩形定位） */
  show(): void {
    if (this.disposed) return;
    const active = this.getActiveTab();
    if (!active) return;
    for (const t of this.tabs) {
      if (t.id !== active.id && !t.view.webContents.isDestroyed()) t.view.setVisible(false);
    }
    active.view.setVisible(true);
    this.host.setBounds(active.view, this.rect);
    logger.info(`[AccountWebViewController] show ${this.accountId} bounds=${JSON.stringify(this.rect)} rectSet=${this.rectSet}`);
    this.notifyTabsUpdate();
    // 每次显示账号视图时回放隔离结果（解决渲染端订阅前的竞态）
    this.notifier.sendEnvStatus(this.accountId, this.envStatus.ok, this.envStatus.reason);
  }

  /** 隐藏本账号全部视图（切到系统 tab / 其它账号时调用） */
  hideAll(): void {
    if (this.disposed) return;
    for (const t of this.tabs) {
      if (!t.view.webContents.isDestroyed()) t.view.setVisible(false);
    }
    logger.info(`[AccountWebViewController] hideAll ${this.accountId}`);
  }

  /** 整体销毁（关闭账号 tab 时调用） */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of this.tabs) {
      try {
        this.host.removeChildView(tab.view);
      } catch {
        /* ignore */
      }
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close();
      }
    }
    this.tabs = [];
    this.activeTabId = '';
  }

  private getTabInfos(): WorkspaceWebviewTab[] {
    return this.tabs
      .filter((t) => !t.view.webContents.isDestroyed())
      .map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        isLoading: t.view.webContents.isLoading(),
      }));
  }

  private notifyTabsUpdate(): void {
    if (this.disposed) return;
    this.notifier.sendTabs(this.accountId, this.getTabInfos(), this.activeTabId);
  }
}
