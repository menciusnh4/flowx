import { Tray, Menu, app, nativeImage, BrowserWindow, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { getMainWindow, createMainWindow } from '../windows/MainWindow';
import { PublishEngine } from './PublishEngine';
import { AccountService } from './AccountService';
import { listPlatforms } from '../services/PlatformRegistry';
import { getStore } from '../store/SecureStore';
import type { PlatformType } from '../../types';
import { logger } from '../utils/logger';

export interface TrayStatusInfo {
  pendingCount: number;
  runningCount: number;
  hasRunningTask: boolean;
}

export class TrayServiceClass {
  private tray: Tray | null = null;
  private initialized = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatus: TrayStatusInfo = {
    pendingCount: 0,
    runningCount: 0,
    hasRunningTask: false,
  };

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const iconPath = this.resolveTrayIconPath();
      if (!iconPath) {
        logger.warn('[TrayService] 未找到托盘图标，跳过托盘初始化');
        return;
      }

      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        logger.warn('[TrayService] 托盘图标加载失败');
        return;
      }

      // 按平台调整托盘图标尺寸：
      //   Windows  16x16（系统托盘小图标）
      //   macOS    18x18 pt（菜单栏推荐尺寸，@2x 时会是 36x36 px）
      //   Linux    22x22（多数发行版托盘常规大小）
      let trayIcon: Electron.NativeImage;
      if (process.platform === 'win32') {
        trayIcon = icon.resize({ width: 16, height: 16, quality: 'good' });
      } else if (process.platform === 'darwin') {
        trayIcon = icon.resize({ width: 18, height: 18, quality: 'good' });
        // macOS：默认不强制模板渲染，保留彩色外观；若后续希望跟随菜单主题自动变模板
        // 可提供专门的单色模板图标再调用 trayIcon.setTemplateImage(true)
      } else {
        trayIcon = icon.resize({ width: 22, height: 22, quality: 'good' });
      }

      this.tray = new Tray(trayIcon);
      this.tray.setToolTip('FlowX - 多平台内容发布');

      // 双击托盘图标打开主面板
      this.tray.on('double-click', () => {
        this.showMainWindow();
      });

      // 单击托盘图标：Windows 下显示/隐藏主窗口，macOS 下弹出菜单
      this.tray.on('click', () => {
        if (process.platform === 'win32') {
          this.toggleMainWindow();
        } else {
          this.refreshMenu();
        }
      });

      // 初始化菜单
      this.refreshMenu();

      // 定时刷新状态（每 5 秒）
      this.statusTimer = setInterval(() => {
        this.refreshMenu();
      }, 5000);

      logger.info('[TrayService] 初始化成功');
    } catch (e) {
      logger.error('[TrayService] 初始化失败:', e);
    }
  }

  destroy(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
      this.tray = null;
    }
    this.initialized = false;
  }

  /** 获取当前发布状态信息 */
  getStatusInfo(): TrayStatusInfo {
    try {
      const stats = PublishEngine.getStats();
      const info: TrayStatusInfo = {
        pendingCount: stats.running || 0,
        runningCount: stats.running || 0,
        hasRunningTask: (stats.running || 0) > 0,
      };
      this.lastStatus = info;
      return info;
    } catch {
      return this.lastStatus;
    }
  }

  /** 生成状态显示文本 */
  private getStatusText(): string {
    const info = this.getStatusInfo();
    if (info.hasRunningTask) {
      return `🔄 正在发布中... (${info.runningCount} 个任务)`;
    } else if (info.pendingCount > 0) {
      return `📋 待发布任务: ${info.pendingCount} 个`;
    } else {
      return '✅ 暂无发布任务';
    }
  }

  /** 构建授权新账号的二级菜单（submenu 形式，由 Electron 原生弹出，避免 popup 冲突） */
  private buildAuthSubmenu(): Electron.MenuItemConstructorOptions['submenu'] {
    try {
      const platforms = listPlatforms();
      if (!platforms || platforms.length === 0) {
        return [{ label: '（暂无可用平台）', enabled: false }];
      }
      return platforms.map((p) => ({
        label: `${p.name}${p.platformAccountLabel ? `（${p.platformAccountLabel}）` : ''}`,
        click: () => {
          logger.info(`[TrayService] 从托盘开始授权平台: ${p.key}`);
          // 先导航到账号管理页面，等页面渲染后再弹出授权窗口
          this.navigateTo('/accounts');
          setTimeout(() => {
            AccountService.beginAuthorization(p.key as PlatformType).then((account) => {
              logger.info(`[TrayService] 授权成功: ${account.nickname || account.id}`);
            }).catch((err) => {
              if (err?.message?.includes('用户取消')) {
                logger.info(`[TrayService] 用户取消授权 (${p.key})`);
              } else {
                logger.warn(`[TrayService] 授权失败 (${p.key}):`, err?.message || String(err));
                const rawMsg = err?.message || String(err);
                const displayMsg = rawMsg.includes('未检测到')
                  ? `未检测到有效登录态\n\n原因：授权窗口内未检测到平台登录状态。\n\n解决方法：\n1. 在授权窗口完成扫码或短信登录\n2. 确认已进入平台创作者中心页面\n3. 点击窗口右上角红色「保存账号」按钮\n\n仍无法解决？\n· 刷新授权窗口页面后重试\n· 关闭窗口，重新开始授权`
                  : `${p.name} 授权失败\n\n${rawMsg}`;
                dialog.showErrorBox('授权失败', displayMsg);
              }
            });
          }, 600);
        },
      }));
    } catch (e) {
      logger.error('[TrayService] 构建授权菜单失败:', e);
      return [{ label: '（加载失败）', enabled: false }];
    }
  }

  /** 刷新托盘菜单 */
  refreshMenu(): void {
    if (!this.tray || this.tray.isDestroyed()) return;

    const statusText = this.getStatusText();
    const info = this.getStatusInfo();

    const template: Electron.MenuItemConstructorOptions[] = [
      // ===== 状态信息 =====
      {
        label: statusText,
        enabled: false,
      },
      {
        label: info.hasRunningTask
          ? `运行中: ${info.runningCount} 个`
          : `待发布: ${info.pendingCount} 个`,
        enabled: false,
      },
      { type: 'separator' },

      // ===== 快捷操作 =====
      {
        label: '打开主面板',
        click: () => this.showMainWindow(),
      },
      {
        label: '快速发布',
        submenu: [
          {
            label: '发布视频',
            click: () => this.navigateTo('/publish/video'),
          },
          {
            label: '发布图文',
            click: () => this.navigateTo('/publish/image'),
          },
          {
            label: '发布文章',
            click: () => this.navigateTo('/publish/article'),
          },
        ],
      },
      {
        label: '授权新账号',
        // 使用原生 submenu：鼠标悬停时 Electron 会自动弹出二级菜单，不需要 click 里手动 popup
        submenu: this.buildAuthSubmenu(),
      },
      {
        label: '账号分析',
        click: () => this.openAnalytics(),
      },
      {
        label: '提取浏览器',
        click: () => this.openBrowserExtractor(),
      },
      {
        label: '查看发布队列',
        click: () => this.openPublishQueue(),
      },
      { type: 'separator' },

      // ===== 应用控制 =====
      {
        label: this.getSavedCloseBehavior()
          ? '关闭时再次询问'
          : '已设置为关闭时询问',
        enabled: !!this.getSavedCloseBehavior(),
        click: () => this.resetCloseBehavior(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.quitApp(),
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);

    // 更新 tooltip，包含状态信息
    this.tray.setToolTip(`FlowX - ${statusText}`);
  }

  /** macOS Dock 图标显示控制（非 macOS 平台为空操作） */
  setDockVisible(visible: boolean): void {
    if (process.platform !== 'darwin') return;
    try {
      // app.dock 在 macOS 下可用；visible=true 显示，false 隐藏
      if (visible) {
        if (!app.dock.isVisible()) {
          app.dock.show().catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug('[TrayService] Dock.show 已跳过或失败:', msg);
          });
        }
      } else {
        if (app.dock.isVisible()) {
          app.dock.hide();
        }
      }
    } catch (e) {
      // 极少数情况 Electron 版本下 dock API 不可用，静默忽略
      const msg = e instanceof Error ? e.message : String(e);
      logger.debug('[TrayService] setDockVisible 未生效:', msg);
    }
  }

  /** 显示/激活主窗口 */
  showMainWindow(): void {
    // macOS：显示主窗口时同步恢复 Dock 图标（避免最小化到托盘后 Dock 隐藏）
    this.setDockVisible(true);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) {
        win.restore();
      }
      if (!win.isVisible()) {
        win.show();
      }
      win.focus();
    } else {
      createMainWindow().catch((e) => {
        logger.error('[TrayService] 创建主窗口失败:', e);
      });
    }
  }

  /** 切换主窗口显示/隐藏 */
  private toggleMainWindow(): void {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
      win.hide();
      // macOS：用户主动切换为隐藏时，也隐藏 Dock
      this.setDockVisible(false);
    } else {
      this.showMainWindow();
    }
  }

  /** 导航主窗口到指定路由 */
  private navigateTo(route: string): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      createMainWindow().then((newWin) => {
        this.doNavigate(newWin, route);
      }).catch((e) => {
        logger.error(`[TrayService] 导航到 ${route} 失败:`, e);
      });
      return;
    }

    this.showMainWindow();
    this.doNavigate(win, route);
  }

  /** 执行实际的路由跳转：通过 IPC 推送 workspace:navigate 到渲染进程，
   *  由 App.vue 监听后调用 store.openSystemTab() 创建/激活 tab。
   *  不能纯改 location.hash——当前分支用 WorkspaceView 自定义 tab 系统，
   *  必须通过 store 才能正确建 tab 并显示页面。 */
  private doNavigate(win: BrowserWindow, route: string): void {
    try {
      win.webContents.send('workspace:navigate', { route });
    } catch (e) {
      logger.warn(`[TrayService] 导航推送失败: ${route}`, e);
    }
  }

  /** 账号分析：打开账号分析页 */
  openAnalytics(): void {
    this.navigateTo('/analytics');
  }

  /** 提取浏览器功能：打开浏览器页 */
  openBrowserExtractor(): void {
    this.navigateTo('/browser');
  }

  /** 查看发布队列：导航到发布历史页 */
  openPublishQueue(): void {
    this.navigateTo('/publish/history');
  }

  /** 显示关闭提示对话框：最小化到托盘 vs 退出 */
  async showCloseDialog(): Promise<'tray' | 'quit'> {
    const win = getMainWindow();
    const validWin = (win && !win.isDestroyed()) ? win : null;

    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '关闭 FlowX',
      message: '您希望如何处理 FlowX？',
      detail: '选择"最小化到托盘"后，FlowX 将在后台继续运行发布任务。',
      buttons: ['最小化到托盘', '完全退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: '记住我的选择，下次不再提示',
      checkboxChecked: false,
    };

    const result = validWin
      ? await dialog.showMessageBox(validWin, options)
      : await dialog.showMessageBox(options);

    // result.response: 0 = 托盘, 1 = 退出
    const action: 'tray' | 'quit' = result.response === 1 ? 'quit' : 'tray';

    // 如果勾选了"记住选择"，保存到配置
    if (result.checkboxChecked) {
      try {
        const store = getStore();
        const settings = (store.get('settings') as Record<string, unknown>) || {};
        settings.closeBehavior = action; // 'tray' | 'quit'
        store.set('settings', settings);
        logger.info(`[TrayService] 已保存关闭行为: ${action}`);
      } catch (e) {
        logger.warn('[TrayService] 保存关闭行为失败:', e);
      }
    }

    return action;
  }

  /** 获取保存的关闭行为，未设置返回 null */
  getSavedCloseBehavior(): 'tray' | 'quit' | null {
    try {
      const store = getStore();
      const settings = (store.get('settings') as Record<string, unknown>) || {};
      const behavior = settings.closeBehavior;
      if (behavior === 'tray' || behavior === 'quit') {
        return behavior;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 重置关闭行为：清除已保存的 closeBehavior，下次关闭时会再次弹出对话框 */
  resetCloseBehavior(): void {
    try {
      const store = getStore();
      const settings = (store.get('settings') as Record<string, unknown>) || {};
      if ('closeBehavior' in settings) {
        delete settings.closeBehavior;
        store.set('settings', settings);
        logger.info('[TrayService] 已重置关闭行为（已清除记住的选择）');
      }
      // 弹一个简短提示，让用户知道已生效
      const win = getMainWindow();
      const validWin = (win && !win.isDestroyed()) ? win : null;
      const opts: Electron.MessageBoxOptions = {
        type: 'info',
        title: 'FlowX',
        message: '已生效',
        detail: '下次关闭窗口时会再次询问您的选择。',
        buttons: ['确定'],
        noLink: true,
      };
      (validWin ? dialog.showMessageBox(validWin, opts) : dialog.showMessageBox(opts))
        .catch(() => {});
    } catch (e) {
      logger.warn('[TrayService] 重置关闭行为失败:', e);
    }
  }

  /** 完全退出应用 */
  quitApp(): void {
    logger.info('[TrayService] 从托盘菜单退出应用');
    // macOS：退出前恢复 Dock 图标，避免退出后应用图标在 Dock 里保持隐藏态
    this.setDockVisible(true);
    // 先销毁托盘，避免退出时托盘图标残留
    this.destroy();
    // 确保在所有平台上都退出
    app.exit(0);
  }

  /** 解析托盘图标路径 */
  private resolveTrayIconPath(): string | null {
    const candidates: string[] = [];

    if (app.isPackaged) {
      // 打包环境
      // macOS 优先：electron-builder 生成的 Mac App 主程序 icns（一定存在）
      if (process.platform === 'darwin') {
        candidates.push(path.join(app.getAppPath(), 'Contents', 'Resources', 'appIcon.icns'));
      }
      // extraResources 拷入的三份图标（跨平台共用
      candidates.push(path.join(process.resourcesPath, 'icon.png'));
      candidates.push(path.join(process.resourcesPath, 'icon.ico'));
      candidates.push(path.join(process.resourcesPath, 'icon.icns'));
    } else {
      // 开发环境
      const buildDir = path.join(__dirname, '../../build');
      candidates.push(path.join(buildDir, 'icon.png'));
      candidates.push(path.join(buildDir, 'icon.ico'));
      // 本地如有 icns 源文件也尝试读取
      candidates.push(path.join(buildDir, 'icon.icns'));
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }
}

export const TrayService = new TrayServiceClass();
