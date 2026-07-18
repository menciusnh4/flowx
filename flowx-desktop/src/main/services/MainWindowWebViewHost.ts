import { WebContentsView } from 'electron';
import { getMainWindow } from '../windows/MainWindow';
import type { WebviewHost } from './AccountWebViewController';
import { logger } from '../utils/logger';

/**
 * 主窗口宿主：把账号创作中心 WebContentsView 挂到主窗口 contentView，
 * 叠在 Vue 内容区之上（侧栏 250 / 全局任务条 48 之外）。
 *
 * 视图最终坐标 = 渲染端账号占位 div 实测矩形（窗口坐标，原点 0,0）。
 * 占位 div 已位于「内容区 - 账号信息条(40) - inner 子页签条(36)」之下，
 * 故原生层只在占位区绘制，不会盖住侧栏 / 任务条 / 账号信息条 / inner 条。
 *
 * 重要：rect 由调用方（AccountWebViewController）携带，每个账号各自记忆，
 * 宿主不再维护任何全局共享矩形（否则多账号切换会串味）。
 */
export class MainWindowWebViewHost implements WebviewHost {
  addChildView(v: WebContentsView): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.addChildView(v);
    } catch (err) {
      logger.error('[MainWindowWebViewHost] addChildView 失败', err);
    }
  }

  removeChildView(v: WebContentsView): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(v);
    } catch {
      /* ignore */
    }
  }

  setBounds(v: WebContentsView, rect: { x: number; y: number; width: number; height: number }): void {
    v.setBounds(rect);
  }
}
