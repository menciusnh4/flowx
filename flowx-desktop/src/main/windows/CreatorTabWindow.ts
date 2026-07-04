import { BrowserWindow, WebContentsView, session, ipcMain, protocol } from 'electron';
import path from 'path';
import { BrowserEnvService } from '../services/BrowserEnvService';
import { getAppIcon } from './MainWindow';

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  isLoading: boolean;
}

interface TabItem {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
}

// 自定义协议名称
const TAB_BAR_PROTOCOL = 'creator-tab';
const TAB_BAR_HOST = 'tabbar';

// 标记协议是否已注册
let protocolRegistered = false;
// 标记 IPC handlers 是否已注册
let ipcHandlersRegistered = false;
// webContentsId → CreatorTabWindow 实例映射，用于 IPC 路由
const winByWebContentsId = new Map<number, CreatorTabWindow>();

/**
 * 生成 tab 栏的 HTML 模板
 */
function generateTabBarHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>TabBar</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #f5f5f5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, "Microsoft YaHei", sans-serif;
    font-size: 13px;
    user-select: none;
  }
  .tab-bar {
    display: flex;
    align-items: flex-end;
    height: 38px;
    padding: 4px 8px 0 8px;
    background: #ebebeb;
    border-bottom: 1px solid #d0d0d0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    flex-shrink: 0;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .new-tab-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 4px;
    margin-bottom: 2px;
    border-radius: 4px;
    cursor: pointer;
    color: #666;
    font-size: 16px;
    flex-shrink: 0;
  }
  .new-tab-btn:hover { background: #d8d8d8; color: #333; }
  .tab-item {
    display: flex;
    align-items: center;
    min-width: 120px;
    max-width: 200px;
    height: 30px;
    padding: 0 8px;
    margin-right: 2px;
    background: #d8d8d8;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
    border: 1px solid transparent;
    border-bottom: none;
  }
  .tab-item:hover { background: #e4e4e4; }
  .tab-item.active {
    background: #fff;
    border-color: #d0d0d0;
    height: 31px;
    margin-bottom: -1px;
    position: relative;
    z-index: 2;
  }
  .tab-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #444;
    font-size: 12px;
    margin-right: 6px;
  }
  .tab-item.active .tab-title { color: #303133; font-weight: 500; }
  .tab-close {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: #999;
    font-size: 14px;
    line-height: 1;
    flex-shrink: 0;
  }
  .tab-close:hover {
    background: #ccc;
    color: #555;
  }
  .toolbar {
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0 10px;
    background: #fff;
    border-bottom: 1px solid #e5e5e5;
    gap: 6px;
    flex-shrink: 0;
  }
  .tool-btn {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    color: #606266;
    font-size: 14px;
    flex-shrink: 0;
  }
  .tool-btn:hover { background: #f0f0f0; }
  .tool-btn:active { background: #e8e8e8; }
  .url-bar {
    flex: 1;
    height: 28px;
    padding: 0 14px;
    border: 1px solid #dcdfe6;
    border-radius: 14px;
    background: #f5f7fa;
    font-size: 12px;
    color: #909399;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 26px;
  }
  body { display: flex; flex-direction: column; }
</style>
</head>
<body>
  <div class="tab-bar" id="tabBar">
    <div class="new-tab-btn" id="newTabBtn" title="新标签页">+</div>
  </div>
  <div class="toolbar">
    <div class="tool-btn" id="btnBack" title="后退">◀</div>
    <div class="tool-btn" id="btnForward" title="前进">▶</div>
    <div class="tool-btn" id="btnReload" title="刷新">⟳</div>
    <div class="tool-btn" id="btnHome" title="首页">⌂</div>
    <div class="url-bar" id="urlBar"></div>
  </div>
<script>
  (function() {
    var tabBar = document.getElementById('tabBar');
    var newTabBtn = document.getElementById('newTabBtn');
    var urlBar = document.getElementById('urlBar');
    var btnBack = document.getElementById('btnBack');
    var btnForward = document.getElementById('btnForward');
    var btnReload = document.getElementById('btnReload');
    var btnHome = document.getElementById('btnHome');

    var tabs = [];
    var activeId = '';

    function renderTabs() {
      var items = tabBar.querySelectorAll('.tab-item');
      items.forEach(function(el) { el.remove(); });

      for (var i = tabs.length - 1; i >= 0; i--) {
        (function(tab) {
          var el = document.createElement('div');
          el.className = 'tab-item' + (tab.id === activeId ? ' active' : '');
          el.dataset.id = tab.id;
          var title = tab.title || '新标签页';
          var safeTitle = title.replace(/"/g, '&quot;');
          el.innerHTML = '<span class="tab-title" title="' + safeTitle + '">' + title + '</span><span class="tab-close" title="关闭">×</span>';
          el.addEventListener('click', function(e) {
            if (e.target.classList.contains('tab-close')) {
              e.stopPropagation();
              window.electron.creatorTab.closeTab(tab.id);
            } else {
              window.electron.creatorTab.activateTab(tab.id);
            }
          });
          tabBar.insertBefore(el, newTabBtn);
        })(tabs[i]);
      }
    }

    function updateUrlBar(url) {
      urlBar.textContent = url || '';
      urlBar.title = url || '';
    }

    // 监听来自主进程的消息
    if (window.electron && window.electron.creatorTab && window.electron.creatorTab.onTabsUpdate) {
      window.electron.creatorTab.onTabsUpdate(function(data) {
        tabs = data.tabs || [];
        activeId = data.activeId || '';
        renderTabs();
        var activeTab = tabs.find(function(t) { return t.id === activeId; });
        if (activeTab) updateUrlBar(activeTab.url);
      });
    }

    if (window.electron && window.electron.creatorTab && window.electron.creatorTab.onUrlUpdate) {
      window.electron.creatorTab.onUrlUpdate(function(data) {
        var tab = tabs.find(function(t) { return t.id === data.tabId; });
        if (tab) {
          tab.url = data.url;
          tab.title = data.title;
          if (data.tabId === activeId) updateUrlBar(data.url);
          renderTabs();
        }
      });
    }

    // 工具栏按钮
    btnBack.addEventListener('click', function() {
      window.electron.creatorTab.goBack();
    });
    btnForward.addEventListener('click', function() {
      window.electron.creatorTab.goForward();
    });
    btnReload.addEventListener('click', function() {
      window.electron.creatorTab.reload();
    });
    btnHome.addEventListener('click', function() {
      window.electron.creatorTab.goHome();
    });
    newTabBtn.addEventListener('click', function() {
      window.electron.creatorTab.newTab();
    });
  })();
</script>
</body>
</html>`;
}

/**
 * 注册自定义协议，用于加载 tab 栏 HTML 页面
 * 必须在 app.whenReady() 之后调用
 */
function registerTabBarProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;

  protocol.handle(TAB_BAR_PROTOCOL, (request) => {
    const url = new URL(request.url);
    if (url.hostname === TAB_BAR_HOST) {
      const html = generateTabBarHtml();
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  });
}

/**
 * 注册 IPC 处理函数（全局只执行一次）
 * 通过 winByWebContentsId 映射路由到对应窗口实例
 */
function ensureIpcHandlersRegistered(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle('creator-tab:activate', (e, tabId: string) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) w.activateTab(tabId);
  });

  ipcMain.handle('creator-tab:close', (e, tabId: string) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) w.closeTab(tabId);
  });

  ipcMain.handle('creator-tab:new', (e) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) w.createTab(w.homeUrl, '新标签页');
  });

  ipcMain.handle('creator-tab:back', (e) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) {
      const tab = w.getActiveTab();
      if (tab && tab.view.webContents.canGoBack()) {
        tab.view.webContents.goBack();
      }
    }
  });

  ipcMain.handle('creator-tab:forward', (e) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) {
      const tab = w.getActiveTab();
      if (tab && tab.view.webContents.canGoForward()) {
        tab.view.webContents.goForward();
      }
    }
  });

  ipcMain.handle('creator-tab:reload', (e) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) {
      const tab = w.getActiveTab();
      if (tab) tab.view.webContents.reload();
    }
  });

  ipcMain.handle('creator-tab:home', (e) => {
    const w = winByWebContentsId.get(e.sender.id);
    if (w) {
      const tab = w.getActiveTab();
      if (tab && w.homeUrl) {
        tab.view.webContents.loadURL(w.homeUrl);
      }
    }
  });
}

/**
 * 带 tab 栏的创作中心浏览器窗口
 *
 * 结构：
 * - 主窗口 BrowserWindow：加载 tab 栏 HTML（顶部 tab 栏 + 工具栏）
 * - 多个 WebContentsView：每个 tab 一个，显示网页内容
 *
 * 点击页面上 target=_blank 的链接时，在新 tab 中打开
 */
export class CreatorTabWindow {
  private win: BrowserWindow;
  private tabs: TabItem[] = [];
  private activeTabId: string = '';
  private accountId: string;
  private accountPartition: string;
  homeUrl: string = '';
  private tabBarHeight = 38;
  private toolbarHeight = 36;
  private disposed = false;

  constructor(accountId: string, initialUrl: string, windowTitle: string, envId?: string) {
    this.accountId = accountId;
    this.accountPartition = `persist:account_${accountId}`;
    this.homeUrl = initialUrl;

    // 确保自定义协议已注册
    registerTabBarProtocol();

    // 创建主窗口（用于显示 tab 栏和工具栏）
    this.win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 900,
      minHeight: 600,
      title: windowTitle,
      autoHideMenuBar: true,
      icon: getAppIcon(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        preload: path.join(__dirname, '../preload/index.js'),
      },
    });

    // 应用浏览器环境到账号 partition
    const sess = session.fromPartition(this.accountPartition);
    BrowserEnvService.applyEnvironment(sess, envId).catch(() => {});

    // 加载 tab 栏页面（使用自定义协议）
    this.win.loadURL(`${TAB_BAR_PROTOCOL}://${TAB_BAR_HOST}/`);

    // 注册 IPC 处理（全局只注册一次）
    ensureIpcHandlersRegistered();

    // 注册当前窗口到路由表
    winByWebContentsId.set(this.win.webContents.id, this);

    // 监听窗口大小变化，调整 view 位置
    this.win.on('resize', () => {
      if (this.disposed || this.win.isDestroyed()) return;
      this.layoutActiveView();
    });

    // 缓存 webContents id，closed 事件中无法再访问
    const wcId = this.win.webContents.id;

    // 窗口即将关闭时，提前清理所有 tabs（此时窗口还未销毁，可以安全操作 views）
    this.win.on('close', () => {
      this.disposed = true;
      this.clearAllTabs();
      winByWebContentsId.delete(wcId);
      creatorWindows.delete(this.accountId);
    });

    // 窗口关闭后（无需额外操作，清理已在 close 中完成）
    this.win.on('closed', () => {
      // 所有清理已在 close 事件中完成，此处仅作占位
    });

    // 创建第一个 tab
    this.createTab(initialUrl, '首页');
  }

  /**
   * 清理所有 tabs（在窗口 close 阶段调用，此时窗口尚未销毁）
   */
  private clearAllTabs(): void {
    for (const tab of this.tabs) {
      try {
        if (!tab.view.webContents.isDestroyed()) {
          this.win.contentView.removeChildView(tab.view);
          tab.view.webContents.close();
        }
      } catch {
        /* ignore */
      }
    }
    this.tabs = [];
    this.activeTabId = '';
  }

  /**
   * 创建一个新 tab
   */
  createTab(url: string, title: string): string {
    if (this.disposed || this.win.isDestroyed()) return '';
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const view = new WebContentsView({
      webPreferences: {
        partition: this.accountPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    const tab: TabItem = {
      id: tabId,
      view,
      title: title || url || '新标签页',
      url: url || 'about:blank',
    };

    // 监听页面标题变化
    view.webContents.on('page-title-updated', (_e, newTitle) => {
      if (this.disposed || this.win.isDestroyed() || view.webContents.isDestroyed()) return;
      tab.title = newTitle || tab.url;
      this.notifyTabsUpdate();
    });

    // 监听 URL 变化
    view.webContents.on('did-navigate', (_e, newUrl) => {
      if (this.disposed || this.win.isDestroyed() || view.webContents.isDestroyed()) return;
      tab.url = newUrl;
      this.notifyUrlUpdate(tabId, newUrl, tab.title);
    });

    view.webContents.on('did-navigate-in-page', (_e, newUrl) => {
      if (this.disposed || this.win.isDestroyed() || view.webContents.isDestroyed()) return;
      tab.url = newUrl;
      this.notifyUrlUpdate(tabId, newUrl, tab.title);
    });

    // 拦截新窗口请求 → 在新 tab 中打开
    view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
      if (!this.disposed && !this.win.isDestroyed()) {
        this.createTab(newUrl, '新标签页');
      }
      return { action: 'deny' };
    });

    this.tabs.push(tab);
    this.win.contentView.addChildView(view);

    // 默认隐藏，激活时显示
    view.setVisible(false);

    // 激活新 tab
    this.activateTab(tabId);

    // 加载 URL
    if (url && url !== 'about:blank') {
      view.webContents.loadURL(url).catch((err) => {
        console.error(`[CreatorTabWindow] loadURL error: ${err.message}`);
      });
    }

    return tabId;
  }

  /**
   * 激活指定 tab
   */
  activateTab(tabId: string): void {
    if (this.disposed || this.win.isDestroyed()) return;
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.view.webContents.isDestroyed()) return;

    // 隐藏当前激活的 tab
    const prevTab = this.getActiveTab();
    if (prevTab && prevTab.id !== tabId && !prevTab.view.webContents.isDestroyed()) {
      prevTab.view.setVisible(false);
    }

    this.activeTabId = tabId;
    tab.view.setVisible(true);
    this.layoutActiveView();

    this.notifyTabsUpdate();
  }

  /**
   * 关闭指定 tab
   */
  closeTab(tabId: string): void {
    if (this.disposed || this.win.isDestroyed()) return;
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const tab = this.tabs[idx];
    const wasActive = tab.id === this.activeTabId;

    // 移除 view
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      /* ignore */
    }
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }

    this.tabs.splice(idx, 1);

    // 如果关闭的是当前激活的 tab，激活相邻的
    if (wasActive && this.tabs.length > 0) {
      const nextIdx = Math.min(idx, this.tabs.length - 1);
      this.activateTab(this.tabs[nextIdx].id);
    }

    // 如果没有 tab 了，关闭窗口
    if (this.tabs.length === 0) {
      this.win.close();
      return;
    }

    this.notifyTabsUpdate();
  }

  /**
   * 获取当前激活的 tab
   */
  getActiveTab(): TabItem | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  /**
   * 获取 tab 信息列表（用于渲染）
   */
  private getTabInfos(): TabInfo[] {
    return this.tabs
      .filter((t) => !t.view.webContents.isDestroyed())
      .map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        isLoading: t.view.webContents.isLoading(),
      }));
  }

  /**
   * 调整当前激活 view 的位置和大小
   */
  private layoutActiveView(): void {
    if (this.disposed || this.win.isDestroyed()) return;
    const tab = this.getActiveTab();
    if (!tab) return;
    if (tab.view.webContents.isDestroyed()) return;

    const [width, height] = this.win.getSize();
    const topOffset = this.tabBarHeight + this.toolbarHeight;

    tab.view.setBounds({
      x: 0,
      y: topOffset,
      width,
      height: Math.max(height - topOffset, 100),
    });
  }

  /**
   * 通知渲染进程 tab 列表更新
   */
  private notifyTabsUpdate(): void {
    if (this.disposed || this.win.isDestroyed()) return;
    this.win.webContents.send('creator-tabs:update', {
      tabs: this.getTabInfos(),
      activeId: this.activeTabId,
    });
  }

  /**
   * 通知渲染进程 URL 更新
   */
  private notifyUrlUpdate(tabId: string, url: string, title: string): void {
    if (this.disposed || this.win.isDestroyed()) return;
    this.win.webContents.send('creator-tabs:url-update', {
      tabId,
      url,
      title,
    });
  }

  /**
   * 获取底层 BrowserWindow 引用
   */
  getWindow(): BrowserWindow {
    return this.win;
  }
}

// 全局已打开的创作中心窗口索引
const creatorWindows = new Map<string, CreatorTabWindow>();

export function getOrCreateCreatorWindow(
  accountId: string,
  url: string,
  title: string,
  envId?: string,
): CreatorTabWindow {
  let w = creatorWindows.get(accountId);
  if (!w || w.getWindow().isDestroyed()) {
    w = new CreatorTabWindow(accountId, url, title, envId);
    creatorWindows.set(accountId, w);
  } else {
    // 窗口已存在，激活并聚焦
    w.getWindow().show();
    w.getWindow().focus();
  }
  return w;
}
