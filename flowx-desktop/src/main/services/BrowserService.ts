import { BrowserWindow, WebContentsView, session, ipcMain, app, Menu, MenuItem } from 'electron';
import path from 'path';
import { BrowserEnvService } from './BrowserEnvService';
import { getMainWindow } from '../windows/MainWindow';
import { addHistory } from './BrowserHistoryService';
import { extractContentFromView, extractContentFromElement, startElementSelector, stopElementSelector, getElementInfoAtPoint, extractWithCustomRule } from './ContentExtractor';
import { siteRuleManager } from './SiteRuleManager';
import { elementPicker } from './ElementPicker';

/**
 * 清理 URL：移除首尾的反引号、引号等特殊字符（复制粘贴时常见）
 */
function cleanUrl(url: string): string {
  return url.replace(/^[`'"<>]+|[`'"<>]+$/g, '').trim();
}

/**
 * 浏览器视图信息
 */
export interface BrowserViewInfo {
  viewId: string;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  envId: string | null;
}

interface ViewItem {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
  isLoading: boolean;
  envId: string | null;
  ignoreCertErrors: boolean;
}

// 全局视图映射
const viewMap = new Map<string, ViewItem>();
let viewIdCounter = 0;

// IPC handlers 是否已注册
let ipcHandlersRegistered = false;

/**
 * 生成唯一 viewId
 */
function generateViewId(): string {
  viewIdCounter++;
  return `browser_view_${Date.now()}_${viewIdCounter}`;
}

/**
 * 获取主窗口实例
 */
function getMainWin(): BrowserWindow | null {
  try {
    return getMainWindow();
  } catch {
    return null;
  }
}

/**
 * 向渲染进程推送页面状态更新
 */
function notifyRender(channel: string, data: Record<string, unknown>) {
  const mainWin = getMainWin();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, data);
  }
}

/**
 * 创建浏览器视图
 */
export async function createBrowserView(options?: { url?: string; envId?: string | null }): Promise<BrowserViewInfo> {
  const mainWin = getMainWin();
  if (!mainWin) {
    throw new Error('主窗口不存在');
  }

  const viewId = generateViewId();
  const partition = 'persist:flowx_browser';
  const sess = session.fromPartition(partition);

  // 应用浏览器环境配置
  const envId = options?.envId ?? null;
  await BrowserEnvService.applyEnvironment(sess, envId).catch((err) => {
    console.error(`[BrowserService] 环境隔离设置失败: ${err.message}`);
  });

  // 确保证书错误处理器已注册（app 级别，全局生效，创建时就注册）
  ensureCertErrorHandler();

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 添加到主窗口
  mainWin.contentView.addChildView(view);

  const initialUrl = cleanUrl(options?.url || 'https://www.baidu.com');
  const item: ViewItem = {
    id: viewId,
    view,
    title: initialUrl,
    url: initialUrl,
    isLoading: true,
    envId,
    ignoreCertErrors: false,
  };

  viewMap.set(viewId, item);

  // 监听页面事件
  const wc = view.webContents;

  wc.on('did-start-loading', () => {
    item.isLoading = true;
    notifyRender('browser:loadingUpdated', {
      viewId,
      isLoading: true,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
    });
  });

  wc.on('did-stop-loading', () => {
    item.isLoading = false;
    item.url = wc.getURL();
    notifyRender('browser:loadingUpdated', {
      viewId,
      isLoading: false,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
    });
    notifyRender('browser:urlUpdated', {
      viewId,
      url: item.url,
    });
  });

  wc.on('page-title-updated', (_e, title) => {
    item.title = title;
    notifyRender('browser:titleUpdated', {
      viewId,
      title,
    });
  });

  wc.on('did-navigate', (_e, url) => {
    item.url = url;
    notifyRender('browser:urlUpdated', {
      viewId,
      url,
    });
    // 自动记录历史
    try {
      addHistory({
        url,
        title: item.title || url,
        viewId,
      });
    } catch (err) {
      console.error('[BrowserService] 记录历史失败:', err);
    }
  });

  wc.on('did-navigate-in-page', (_e, url) => {
    item.url = url;
    notifyRender('browser:urlUpdated', {
      viewId,
      url,
    });
  });

  // 页面加载失败（网络错误、证书错误等）
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[BrowserService] load failed: ${errorDescription} (${errorCode}) url=${validatedURL}`);
    notifyRender('browser:loadFailed', {
      viewId,
      errorCode,
      errorDescription,
      url: validatedURL,
    });
  });

  // 新窗口打开：在当前 view 导航（避免弹出新窗口）
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url).catch(console.error);
    return { action: 'deny' };
  });

  // 右键菜单：提供提取选项
  wc.on('context-menu', async (event, params) => {
    event.preventDefault();
    const { x, y } = params;

    // 获取点击位置的元素信息
    const elementInfo = await getElementInfoAtPoint(viewId, x, y);

    const menu = new Menu();

    // 如果点击的是图片，添加"提取此图片"选项
    if (elementInfo?.tagName === 'img') {
      menu.append(new MenuItem({
        label: '提取此图片',
        click: async () => {
          try {
            const result = await extractContentFromElement(viewId, elementInfo.selector);
            if (result) {
              notifyRender('browser:manualExtractResult', { viewId, result });
            }
          } catch (err) {
            console.error('[BrowserService] 手动提取图片失败:', err);
          }
        },
      }));
    }

    // 如果点击的是段落或有足够文本的元素，添加"提取此段落"
    if (elementInfo && elementInfo.textPreview && elementInfo.textPreview.length > 10 && elementInfo.tagName !== 'img') {
      menu.append(new MenuItem({
        label: '提取此元素内容',
        click: async () => {
          try {
            const result = await extractContentFromElement(viewId, elementInfo.selector);
            if (result) {
              notifyRender('browser:manualExtractResult', { viewId, result });
            }
          } catch (err) {
            console.error('[BrowserService] 手动提取元素失败:', err);
          }
        },
      }));
    }

    // 始终显示"提取整页内容"和"选择提取模式"
    if (menu.items.length > 0) {
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({
      label: '一键提取整页内容',
      click: async () => {
        try {
          const result = await extractContentFromView(viewId);
          if (result) {
            notifyRender('browser:extractResult', { viewId, result });
          }
        } catch (err) {
          console.error('[BrowserService] 提取整页失败:', err);
          notifyRender('browser:extractError', { viewId, error: (err as Error).message });
        }
      },
    }));

    menu.append(new MenuItem({
      label: '选择元素提取',
      click: async () => {
        await startElementSelector(viewId);
        notifyRender('browser:selectorStarted', { viewId });
      },
    }));

    // ========== 自定义规则相关菜单项 ==========
    const currentUrl = wc.getURL();
    const currentPublishType = (global as any).__currentPublishType as string | undefined;
    const customRules = siteRuleManager.getEnabledCustomRules();

    if (customRules.length > 0) {
      menu.append(new MenuItem({ type: 'separator' }));

      // 分组标题：使用自定义规则提取
      menu.append(new MenuItem({
        label: '使用自定义规则提取',
        enabled: false,
      }));

      const { siteMatchTypeMatch, siteMatchOnly, typeMatchOnly, others } =
        siteRuleManager.getRulesForContextMenu(currentUrl, currentPublishType as any);

      // 直接展示匹配的规则（一级菜单）
      const matchedRules = [...siteMatchTypeMatch, ...siteMatchOnly];
      const uniqueMatched = Array.from(new Map(matchedRules.map(r => [r.id, r])).values());
      const matchedList = Array.from(uniqueMatched).slice(0, 5); // 最多显示5个直接展示

      if (matchedList.length > 0) {
        matchedList.forEach((rule, index) => {
          const isStar = index < siteMatchTypeMatch.length;
          menu.append(new MenuItem({
            label: isStar ? `⭐ ${rule.name}` : rule.name,
            click: async () => {
              try {
                const result = await extractWithCustomRule(viewId, rule.id);
                if (result) {
                  notifyRender('browser:extractResult', { viewId, result });
                } else {
                  notifyRender('browser:extractError', { viewId, error: '该规则在此页面提取失败' });
                }
              } catch (err) {
                notifyRender('browser:extractError', { viewId, error: (err as Error).message });
              }
            },
          }));
        });
      }

      // 全部自定义规则（二级菜单）
      const allSorted = [...siteMatchTypeMatch, ...siteMatchOnly, ...typeMatchOnly, ...others];
      const allUnique = Array.from(new Map(allSorted.map(r => [r.id, r])).values());

      if (allUnique.length > 0) {
        menu.append(new MenuItem({
          label: '全部自定义规则',
          submenu: allUnique.map(rule => ({
            label: rule.name,
            click: async () => {
              try {
                const result = await extractWithCustomRule(viewId, rule.id);
                if (result) {
                  notifyRender('browser:extractResult', { viewId, result });
                } else {
                  notifyRender('browser:extractError', { viewId, error: '该规则在此页面提取失败' });
                }
              } catch (err) {
                notifyRender('browser:extractError', { viewId, error: (err as Error).message });
              }
            },
          })),
        }));
      }
    }

    // 添加自定义规则（直接打开规则编辑器）
    menu.append(new MenuItem({
      label: '➕ 添加自定义规则',
      click: () => {
        notifyRender('browser:openRuleEditor', { viewId, url: currentUrl, mode: 'create' });
      },
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: '检查元素',
      click: () => {
        // 打开 DevTools 并检查点击位置的元素
        if (!wc.isDevToolsOpened()) {
          wc.openDevTools({ mode: 'detach' });
        }
        // 使用 inspectElement API 检查点击位置的元素
        wc.inspectElement(Math.round(x), Math.round(y));
      },
    }));

    // 显示右键菜单
    menu.popup();
  });

  // F12 快捷键：打开/关闭 DevTools
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      event.preventDefault();
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: 'detach' });
      }
    }
    // Ctrl+Shift+I 也打开 DevTools
    if (input.key === 'I' && input.control && input.shift && input.type === 'keyDown') {
      event.preventDefault();
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: 'detach' });
      }
    }
  });

  // 监听选择器脚本的消息（通过 console.log 通信）
  wc.on('console-message', async (_event, _level, message) => {
    // 元素被选中
    if (message.startsWith('__FLOX_SELECT__:')) {
      try {
        const data = JSON.parse(message.replace('__FLOX_SELECT__:', ''));
        await stopElementSelector(viewId);
        const result = await extractContentFromElement(viewId, data.selector);
        if (result) {
          notifyRender('browser:manualExtractResult', { viewId, result });
        }
      } catch (err) {
        console.error('[BrowserService] 处理选择结果失败:', err);
      }
    }
    // 选择器被取消
    if (message === '__FLOX_SELECT_CANCEL__') {
      await stopElementSelector(viewId);
      notifyRender('browser:selectorCancelled', { viewId });
    }
    // 拾取器结果
    if (message.startsWith('__FLOWX_PICKER_RESULT__:')) {
      try {
        const data = JSON.parse(message.replace('__FLOWX_PICKER_RESULT__:', ''));
        notifyRender('browser:pickerResult', { viewId, result: data });
      } catch (err) {
        console.error('[BrowserService] 处理拾取结果失败:', err);
      }
    }
    // 拾取器被取消
    if (message === '__FLOWX_PICKER_CANCEL__') {
      notifyRender('browser:pickerCancelled', { viewId });
    }
  });

  // 加载初始 URL
  await wc.loadURL(initialUrl);

  return {
    viewId,
    title: item.title,
    url: item.url,
    isLoading: item.isLoading,
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    envId: item.envId,
  };
}

/**
 * 销毁浏览器视图
 */
export function destroyBrowserView(viewId: string): void {
  const item = viewMap.get(viewId);
  if (!item) return;

  const mainWin = getMainWin();
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      mainWin.contentView.removeChildView(item.view);
    } catch {
      // ignore
    }
  }

  try {
    item.view.webContents.close();
  } catch {
    // ignore
  }

  viewMap.delete(viewId);
}

/**
 * 设置视图 bounds
 */
export function setViewBounds(viewId: string, bounds: { x: number; y: number; width: number; height: number }): void {
  const item = viewMap.get(viewId);
  if (!item) return;

  try {
    item.view.setBounds(bounds);
  } catch (e) {
    console.error('[BrowserService] setBounds error', e);
  }
}

/**
 * 导航到指定 URL
 */
export function navigate(viewId: string, url: string): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  const cleanTarget = cleanUrl(url);
  item.view.webContents.loadURL(cleanTarget).catch((e) => {
    console.error(`[BrowserService] navigate error ${e.message} loading '${cleanTarget}'`);
  });
}

/**
 * 后退
 */
export function goBack(viewId: string): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  if (item.view.webContents.canGoBack()) {
    item.view.webContents.goBack();
  }
}

/**
 * 前进
 */
export function goForward(viewId: string): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  if (item.view.webContents.canGoForward()) {
    item.view.webContents.goForward();
  }
}

/**
 * 刷新
 */
export function reload(viewId: string): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  item.view.webContents.reload();
}

/**
 * 停止加载
 */
export function stop(viewId: string): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  item.view.webContents.stop();
}

/**
 * 切换浏览器环境（UA + 代理），切换后自动重载当前页面
 */
export async function switchEnvironment(viewId: string, envId: string | null): Promise<void> {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  const sess = item.view.webContents.session;
  await BrowserEnvService.applyEnvironment(sess, envId);
  item.envId = envId;

  // 通知渲染层环境已切换
  notifyRender('browser:envChanged', {
    viewId,
    envId,
  });

  // 重新加载当前页面以应用新环境
  try {
    item.view.webContents.reload();
  } catch {
    // ignore
  }
}

/**
 * 获取当前环境 ID
 */
export function getCurrentEnv(viewId: string): string | null {
  const item = viewMap.get(viewId);
  return item ? item.envId : null;
}

/**
 * 获取视图的 webContents（用于内容提取等高级操作）
 */
export function getViewWebContents(viewId: string): Electron.WebContents | null {
  const item = viewMap.get(viewId);
  return item ? item.view.webContents : null;
}

// 是否忽略证书错误（全局开关）
let globalIgnoreCertErrors = false;
let certErrorHandlerSet = false;

/**
 * 注册全局证书错误处理器（app 级别，对所有 webContents 生效，包括 WebContentsView）
 * 比 session 级别更可靠，是 Electron 推荐的方式
 * 幂等：只注册一次
 */
function ensureCertErrorHandler(): void {
  if (certErrorHandlerSet) return;
  certErrorHandlerSet = true;

  const register = () => {
    app.on('certificate-error', (event, _webContents, _url, _error, _cert, callback) => {
      if (globalIgnoreCertErrors) {
        event.preventDefault();
        callback(true); // 允许
      } else {
        callback(false); // 拒绝（默认行为）
      }
    });
  };

  if (app.isReady()) {
    register();
  } else {
    app.whenReady().then(register);
  }
}

/**
 * 设置是否忽略证书错误（全局，因为所有浏览器 view 共享同一个 session）
 * 切换后会自动重新加载当前页面
 */
export function setIgnoreCertErrors(viewId: string, ignore: boolean): void {
  const item = viewMap.get(viewId);
  if (!item) throw new Error('视图不存在');

  item.ignoreCertErrors = ignore;
  globalIgnoreCertErrors = ignore;

  // 确保证书错误处理器已注册（app 级别，全局生效）
  ensureCertErrorHandler();

  // 通知渲染层
  notifyRender('browser:certIgnoreChanged', {
    viewId,
    ignore,
  });

  // 重新加载当前页面以生效
  try {
    item.view.webContents.reload();
  } catch {
    // ignore
  }
}

/**
 * 获取当前是否忽略证书错误
 */
export function isIgnoringCertErrors(viewId: string): boolean {
  const item = viewMap.get(viewId);
  return item ? item.ignoreCertErrors : false;
}

/**
 * 注册 IPC handlers
 */
export function registerBrowserIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle('browser:createView', async (_event, options?: { url?: string }) => {
    return createBrowserView(options);
  });

  ipcMain.handle('browser:destroyView', (_event, viewId: string) => {
    destroyBrowserView(viewId);
    return true;
  });

  ipcMain.handle('browser:setBounds', (_event, viewId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    setViewBounds(viewId, bounds);
    return true;
  });

  ipcMain.handle('browser:navigate', (_event, viewId: string, url: string) => {
    navigate(viewId, url);
    return true;
  });

  ipcMain.handle('browser:goBack', (_event, viewId: string) => {
    goBack(viewId);
    return true;
  });

  ipcMain.handle('browser:goForward', (_event, viewId: string) => {
    goForward(viewId);
    return true;
  });

  ipcMain.handle('browser:reload', (_event, viewId: string) => {
    reload(viewId);
    return true;
  });

  ipcMain.handle('browser:stop', (_event, viewId: string) => {
    stop(viewId);
    return true;
  });
}

/**
 * 清理所有浏览器视图（应用退出时调用）
 */
export function cleanupAllBrowserViews(): void {
  const mainWin = getMainWin();
  for (const item of viewMap.values()) {
    if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.contentView.removeChildView(item.view);
      } catch {
        // ignore
      }
    }
    try {
      item.view.webContents.close();
    } catch {
      // ignore
    }
  }
  viewMap.clear();
}
