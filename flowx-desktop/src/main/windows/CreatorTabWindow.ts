import { BrowserWindow, WebContentsView, session, ipcMain, protocol } from 'electron';
import path from 'path';
import { BrowserEnvService } from '../services/BrowserEnvService';
import { AccountWebViewController, type WebviewHost, type WebviewNotifier } from '../services/AccountWebViewController';
import { CREATOR_TAB_BAR_H, CREATOR_TOOLBAR_H } from '../services/layout';
import { getAppIcon } from './MainWindow';

// 自定义协议名称（tab 栏 HTML 页面）
const TAB_BAR_PROTOCOL = 'creator-tab';
const TAB_BAR_HOST = 'tabbar';

// 标记协议是否已注册
let protocolRegistered = false;
// 标记 IPC handlers 是否已注册
let ipcHandlersRegistered = false;
// webContentsId → CreatorTabWindow 实例映射，用于 IPC 路由
const winByWebContentsId = new Map<number, CreatorTabWindow>();

/**
 * 生成 tab 栏的 HTML 模板（与内嵌主窗口版的 Vue 信息条/子页签条不同，
 * 弹窗版仍用原生 HTML 渲染 tab 栏 + 工具条）
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

    btnBack.addEventListener('click', function() { window.electron.creatorTab.goBack(); });
    btnForward.addEventListener('click', function() { window.electron.creatorTab.goForward(); });
    btnReload.addEventListener('click', function() { window.electron.creatorTab.reload(); });
    btnHome.addEventListener('click', function() { window.electron.creatorTab.goHome(); });
    newTabBtn.addEventListener('click', function() { window.electron.creatorTab.newTab(); });
  })();
</script>
</body>
</html>`;
}

/**
 * 注册自定义协议，用于加载 tab 栏 HTML 页面（必须在 app.whenReady() 之后调用）
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
 * 注册 IPC 处理函数（全局只执行一次）。creator-tab:* 仅服务独立弹窗；
 * 内嵌主窗口版走 workspace-webview:*（路由按 accountId，见 WorkspaceWebViewController）。
 */
function ensureIpcHandlersRegistered(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle('creator-tab:activate', (e, tabId: string) => {
    winByWebContentsId.get(e.sender.id)?.activateTab(tabId);
  });
  ipcMain.handle('creator-tab:close', (e, tabId: string) => {
    winByWebContentsId.get(e.sender.id)?.closeTab(tabId);
  });
  ipcMain.handle('creator-tab:new', (e) => {
    winByWebContentsId.get(e.sender.id)?.newTab();
  });
  ipcMain.handle('creator-tab:back', (e) => {
    winByWebContentsId.get(e.sender.id)?.goBack();
  });
  ipcMain.handle('creator-tab:forward', (e) => {
    winByWebContentsId.get(e.sender.id)?.goForward();
  });
  ipcMain.handle('creator-tab:reload', (e) => {
    winByWebContentsId.get(e.sender.id)?.reload();
  });
  ipcMain.handle('creator-tab:home', (e) => {
    winByWebContentsId.get(e.sender.id)?.goHome();
  });
}

/**
 * 带 tab 栏的创作中心浏览器窗口（独立弹窗，过渡期保留）。
 * 内部 inner tab 引擎复用宿主无关的 AccountWebViewController。
 */
export class CreatorTabWindow {
  private win: BrowserWindow;
  /** 复用宿主无关的账号视图控制器 */
  private controller: AccountWebViewController;
  homeUrl: string = '';
  private accountId: string;
  private disposed = false;

  constructor(accountId: string, initialUrl: string, windowTitle: string, envId?: string) {
    this.accountId = accountId;
    this.homeUrl = initialUrl;

    registerTabBarProtocol();

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

    // 宿主：本弹窗的 contentView（tab 栏 38 + 工具条 36 之下）
    const host: WebviewHost = {
      addChildView: (v) => this.win.contentView.addChildView(v),
      removeChildView: (v) => {
        try {
          this.win.contentView.removeChildView(v);
        } catch {
          /* ignore */
        }
      },
      setBounds: (_v, _rect) => {
        if (this.disposed || this.win.isDestroyed()) return;
        const [width, height] = this.win.getSize();
        const top = CREATOR_TAB_BAR_H + CREATOR_TOOLBAR_H;
        _v.setBounds({ x: 0, y: top, width, height: Math.max(height - top, 100) });
      },
    };

    // 通知：直接发给本弹窗的 webContents（渲染层 creator-tab:*）
    const notifier: WebviewNotifier = {
      sendTabs: (_accId, tabs, activeId) => {
        this.win.webContents.send('creator-tabs:update', { tabs, activeId });
      },
      sendUrl: (_accId, tabId, url, title) => {
        this.win.webContents.send('creator-tabs:url-update', { tabId, url, title });
      },
      // M4：隔离失效状态通知。弹窗路径无环境告警 UI，透传到弹窗 webContents（未订阅则忽略）。
      sendEnvStatus: (_accId, ok, reason) => {
        this.win.webContents.send('creator-tabs:env-status', { ok, reason });
      },
    };

    this.controller = new AccountWebViewController(host, notifier, accountId, initialUrl, windowTitle, envId);

    // 加载 tab 栏页面
    this.win.loadURL(`${TAB_BAR_PROTOCOL}://${TAB_BAR_HOST}/`);

    this.win.webContents.on('did-finish-load', () => {
      if (windowTitle) {
        this.win.webContents
          .executeJavaScript(`document.title = ${JSON.stringify(windowTitle)}`)
          .catch(() => {});
      }
    });

    ensureIpcHandlersRegistered();
    winByWebContentsId.set(this.win.webContents.id, this);

    this.win.on('resize', () => {
      if (this.disposed || this.win.isDestroyed()) return;
      this.controller.show(); // 重设激活视图 bounds
    });

    const wcId = this.win.webContents.id;
    this.win.on('close', () => {
      this.disposed = true;
      this.controller.destroy();
      winByWebContentsId.delete(wcId);
      creatorWindows.delete(this.accountId);
    });
    this.win.on('closed', () => {
      /* 清理已在 close 中完成 */
    });
  }

  // ===== 以下方法供 creator-tab:* IPC 委托 =====
  createTab(url: string, title: string): string {
    return this.controller.createTab(url, title);
  }
  activateTab(tabId: string): void {
    this.controller.activateTab(tabId);
  }
  closeTab(tabId: string): void {
    this.controller.closeTab(tabId);
  }
  getActiveTab() {
    return this.controller.getActiveTab();
  }
  goBack(): void {
    this.controller.goBack();
  }
  goForward(): void {
    this.controller.goForward();
  }
  reload(): void {
    this.controller.reload();
  }
  goHome(): void {
    this.controller.goHome();
  }
  newTab(): void {
    this.controller.newTab();
  }

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
  envId?: string | null,
): CreatorTabWindow {
  let w = creatorWindows.get(accountId);
  if (!w || w.getWindow().isDestroyed()) {
    w = new CreatorTabWindow(accountId, url, title, envId ?? undefined);
    creatorWindows.set(accountId, w);
  } else {
    w.getWindow().show();
    w.getWindow().focus();
  }
  return w;
}
