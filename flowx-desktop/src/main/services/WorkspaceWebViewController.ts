import { session } from 'electron';
import { AccountService, injectAccountCookies, injectingAccounts } from './AccountService';
import { getPlatform, applyDouyinAntiCrash } from './platforms';
import { BrowserEnvService } from './BrowserEnvService';
import { getMainWindow } from '../windows/MainWindow';
import { logger } from '../utils/logger';

/**
 * 账号创作中心「内嵌主窗口」的总控制器（DOM <webview> 方案，2026-07-17 起）。
 *
 * 设计变更：创作中心改为渲染层直接用 Electron <webview> 标签内嵌
 * （partition 隔离 + CSS flex 自适应），不再是主窗口 contentView 上的 WebContentsView 原生层。
 * 因此本控制器不再创建 / 定位 / 显隐任何原生视图，只负责：
 *  - 按 accountId 预创建隔离分区会话并应用隔离环境（代理 / Cookie / UA）；
 *  - 返回该账号创作中心首页 URL 与隔离结果；
 *  - 抖音账号：在主窗口挂防崩兜底（render-process-gone → reload 1 次）。
 * 视图的创建 / 导航 / 显隐 / 多子页签全部由渲染层 AccountWorkspace.vue 的 <webview> 完成。
 *
 * 注意：AccountWebViewController / MainWindowWebViewHost 仍被遗留弹窗 CreatorTabWindow 复用，不在此改动范围。
 */
class WorkspaceWebViewController {
  /** 已就绪账号的缓存（幂等，避免重复套防崩监听 / 重复应用环境） */
  private readonly cache = new Map<string, { url: string; env: { ok: boolean; reason?: string }; userAgent?: string }>();
  /** 记账：当前已 ensure 的账号（close 时清理） */
  private readonly sessions = new Set<string>();
  /** Cookie 变更防抖存盘的定时器（按账号，1.5s 防抖） */
  private readonly cookieSyncTimers = new Map<string, NodeJS.Timeout>();
  /** 已挂载 cookies.on('changed') 的账号（避免重复挂载） */
  private readonly cookieSyncAttached = new Set<string>();

  /** 预创建隔离分区并应用环境，返回首页 URL 与隔离结果（幂等） */
  async ensure(
    accountId: string,
    _title: string,
  ): Promise<{ ok: boolean; url?: string; error?: string; env?: { ok: boolean; reason?: string }; userAgent?: string }> {
    const cached = this.cache.get(accountId);
    if (cached) return { ok: true, url: cached.url, env: cached.env, userAgent: cached.userAgent };

    const cred = AccountService.getCredential(accountId);
    if (!cred) return { ok: false, error: '账号不存在' };
    const platform = getPlatform(cred.platform);
    if (!platform) return { ok: false, error: '未知平台: ' + cred.platform };
    const homeUrl = platform.meta.homeUrl;

    // 每账号独立隔离分区（与旧方案 partition 一致，保证 cookie / 代理 / UA 隔离延续）
    const sess = session.fromPartition(`persist:account_${accountId}`);
    let env: { ok: boolean; reason?: string } = { ok: true };
    try {
      env = await BrowserEnvService.applyEnvironment(sess, cred.envId || undefined);
    } catch (e) {
      env = { ok: false, reason: '隔离环境应用异常，已回退本机直连' };
      logger.warn(`[workspace] 隔离环境应用异常 ${accountId}:`, e);
    }
    // 回读该分区实际生效的 User-Agent（隔离指纹），交给渲染层绑定到 <webview :useragent>，
    // 保证「会话级 UA」与「webview 标签 UA」完全一致，杜绝双重设置错配。
    let userAgent: string | undefined;
    try {
      userAgent = sess.getUserAgent();
    } catch {
      /* ignore */
    }
    this.sessions.add(accountId);
    this.cache.set(accountId, { url: homeUrl, env, userAgent });

    // 跨子域名 Cookie 共享：将已保存的加密 cookies 还原到 partition（确保跨子域免登）
    try {
      await injectAccountCookies(accountId, homeUrl);
    } catch (e) {
      logger.warn(`[workspace] Cookie 注入失败 ${accountId}:`, e);
    }

    // Cookie 变更防抖存盘：用户在创作中心重新登录后，自动持久化最新 cookies
    this.attachCookieSync(accountId, sess);

    // 抖音：在主窗口挂防崩兜底（内容已迁入 webview，崩溃发生在 webview 进程；
    // 此处保留主窗口兜底 + 渲染层 webview 'crashed' 监听双保险）
    if (cred.platform === 'douyin') {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        applyDouyinAntiCrash(
          win,
          accountId,
          (level, stage, msg, data) => {
            const payload = data ? ` | ${JSON.stringify(data).slice(0, 200)}` : '';
            if (level === 'error' || level === 'warn') logger.warn(`[workspace][douyin-anti-crash][${stage}] ${msg}${payload}`);
            else logger.info(`[workspace][douyin-anti-crash][${stage}] ${msg}${payload}`);
          },
        );
      }
    }

    logger.info(`[workspace] 已就绪创作中心会话: ${cred.platform} | ${cred.nickname} | url=${homeUrl} | ua=${userAgent ? '已注入' : '默认'}`);
    return { ok: true, url: homeUrl, env, userAgent };
  }

  /** 关闭账号创作中心（会话分区保留在磁盘，下次 ensure 复用；此处仅做记账清理） */
  close(accountId: string): { ok: boolean } {
    this.sessions.delete(accountId);
    this.cache.delete(accountId);
    // 清理 Cookie 防抖定时器
    const timer = this.cookieSyncTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.cookieSyncTimers.delete(accountId);
    }
    this.cookieSyncAttached.delete(accountId);
    return { ok: true };
  }

  /**
   * 挂载 cookies.on('changed') 监听，1.5s 防抖后同步最新 cookies 到加密存储。
   * 确保用户在创作中心重新登录/操作后，Cookie 自动持久化，下次启动免重新登录。
   * 过滤注入期间的变更（injectingAccounts 标记），避免代码还原 Cookie 触发无意义存盘。
   */
  private attachCookieSync(accountId: string, sess: Electron.Session): void {
    if (this.cookieSyncAttached.has(accountId)) return;
    this.cookieSyncAttached.add(accountId);

    sess.cookies.on('changed', () => {
      // 跳过注入期间的变更（injectAccountCookies 主动设置标记）
      if (injectingAccounts.has(accountId)) return;
      // 防抖 1.5s
      const existing = this.cookieSyncTimers.get(accountId);
      if (existing) clearTimeout(existing);
      this.cookieSyncTimers.set(
        accountId,
        setTimeout(async () => {
          this.cookieSyncTimers.delete(accountId);
          try {
            await AccountService.syncCookiesFromSession(accountId, sess);
          } catch (e) {
            logger.warn(`[workspace] Cookie 防抖存盘失败 ${accountId}:`, e);
          }
        }, 1500),
      );
    });

    logger.info(`[workspace] Cookie 变更防抖存盘已挂载: ${accountId}`);
  }
}

export const workspaceWebViewController = new WorkspaceWebViewController();
