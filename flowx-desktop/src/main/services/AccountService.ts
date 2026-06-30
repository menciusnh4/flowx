import { session, BrowserWindow } from 'electron';
import crypto from 'crypto';
import { getStore, encrypt, decrypt } from '../store/SecureStore';
import { logger } from '../utils/logger';
import { BrowserEnvService } from './BrowserEnvService';
import { PLATFORMS } from './PlatformRegistry';
import { getPlatform, getAllPlatforms, applyDouyinAntiCrash } from './platforms';
import { getAppIcon } from '../windows/MainWindow';
import type {
  AccountCredential,
  AccountInfo,
  PlatformType,
  HealthCheckConfig,
  AccountCategory,
} from '../../types';

// =======================================================================
// 工具：延迟
// =======================================================================
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// =======================================================================
// 账号服务
// =======================================================================
const STORAGE_KEY = 'accounts';
const HEALTH_CHECK_CONFIG_KEY = 'healthCheckConfig';
const CATEGORIES_STORAGE_KEY = 'categories';

const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  intervalMs: 60 * 60 * 1000, // 1 小时
  initialDelayMs: 5 * 60 * 1000, // 5 分钟
  enabled: true,
};

function genId(prefix: string): string {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

export class AccountService {
  private static ready = false;
  /** 定时健康检测的 interval 对象（避免重复启动） */
  private static healthCheckTimer: NodeJS.Timeout | null = null;
  /** 当前健康检测配置（从存储中读取） */
  private static healthCheckConfig: HealthCheckConfig = { ...DEFAULT_HEALTH_CHECK_CONFIG };
  /** 是否正在进行健康检测（避免重复调度） */
  private static healthCheckInProgress = false;

  /** 从存储中读取健康检测配置（若不存在则返回默认值） */
  private static loadHealthCheckConfig(): HealthCheckConfig {
    try {
      const store = getStore();
      const raw = store.get(HEALTH_CHECK_CONFIG_KEY as any) as HealthCheckConfig | undefined;
      if (raw && typeof raw.intervalMs === 'number') {
        return { ...DEFAULT_HEALTH_CHECK_CONFIG, ...raw };
      }
    } catch (e) {
      logger.warn('[Account-Health] 读取配置失败，使用默认值:', (e as Error).message);
    }
    return { ...DEFAULT_HEALTH_CHECK_CONFIG };
  }

  /** 保存健康检测配置到存储 */
  private static saveHealthCheckConfig(cfg: HealthCheckConfig): void {
    try {
      const store = getStore();
      store.set(HEALTH_CHECK_CONFIG_KEY as any, cfg);
    } catch (e) {
      logger.warn('[Account-Health] 保存配置失败:', (e as Error).message);
    }
  }

  /** 获取当前健康检测配置（供 UI 展示） */
  static getHealthCheckConfig(): HealthCheckConfig {
    return { ...AccountService.healthCheckConfig };
  }

  /** 更新并保存健康检测配置。同时重启定时器（若启用）。 */
  static setHealthCheckConfig(cfg: Partial<HealthCheckConfig> & { intervalMs: number }): HealthCheckConfig {
    AccountService.healthCheckConfig = {
      ...AccountService.healthCheckConfig,
      ...cfg,
    };
    AccountService.saveHealthCheckConfig(AccountService.healthCheckConfig);

    if (AccountService.ready) {
      // 应用启动后才重启定时器（init 时会另行调用一次）
      AccountService.applyTimerFromConfig();
    }
    return { ...AccountService.healthCheckConfig };
  }

  /** 根据当前配置启动 / 停止定时器 */
  private static applyTimerFromConfig(): void {
    const cfg = AccountService.healthCheckConfig;
    if (AccountService.healthCheckTimer) {
      clearTimeout(AccountService.healthCheckTimer as unknown as NodeJS.Timeout);
      AccountService.healthCheckTimer = null;
    }
    if (!cfg.enabled || cfg.intervalMs <= 0) {
      logger.info('[Account-Health] 定时健康检测已禁用');
      return;
    }
    const runOnce = () => {
      AccountService.checkAllAccountsHealth().catch((err) => {
        logger.warn('[Account-Health] ❌ 健康检测异常:', (err as Error).message);
      });
      AccountService.healthCheckTimer = setTimeout(runOnce, AccountService.healthCheckConfig.intervalMs) as unknown as NodeJS.Timeout;
    };
    AccountService.healthCheckTimer = setTimeout(
      runOnce,
      cfg.initialDelayMs > 0 ? cfg.initialDelayMs : cfg.intervalMs,
    ) as unknown as NodeJS.Timeout;
    logger.info(
      `[Account-Health] 定时健康检测已启用，间隔 ${Math.round(cfg.intervalMs / 60000)} 分钟，首次延迟 ${Math.round(cfg.initialDelayMs / 60000)} 分钟`,
    );
  }

  static init() {
    if (AccountService.ready) return;
    AccountService.ready = true;
    AccountService.checkAllExpiration();

    // 读取持久化配置并启动定时器
    AccountService.healthCheckConfig = AccountService.loadHealthCheckConfig();
    AccountService.applyTimerFromConfig();

    logger.info('[Account] 账号服务初始化完成，支持平台:', getAllPlatforms().map((p) => p.key).join(', '));
  }

  /** 开启/更新定时健康检测定时器（兼容旧签名：intervalMs <= 0 表示停止） */
  static startHealthCheckTimer(intervalMs: number, initialDelayMs = 0): void {
    AccountService.setHealthCheckConfig({
      intervalMs,
      initialDelayMs,
      enabled: intervalMs > 0,
    });
  }

  static stopHealthCheckTimer(): void {
    if (AccountService.healthCheckTimer) {
      clearTimeout(AccountService.healthCheckTimer);
      AccountService.healthCheckTimer = null;
    }
  }

  /**
   * 单个账号的健康检测：
   *   打开一个隐藏窗口，使用账号的 partition（已保存的 cookies 会自动生效），
   *   调用对应平台的 detectLoggedIn 验证登录态；
   *   若登录仍有效，尝试刷新粉丝/关注/获赞数，并更新 lastChecked。
   *
   * 返回：更新后的 AccountInfo（若失败则返回更新了 status='expired'）
   */
  static async checkAccountHealth(id: string): Promise<AccountInfo | null> {
    const cred = AccountService.loadCredentials().find((c) => c.id === id);
    if (!cred) {
      logger.warn(`[Account-Health] 账号不存在: ${id}`);
      return null;
    }
    const platform = getPlatform(cred.platform);
    if (!platform) {
      logger.warn(`[Account-Health] 未知平台: ${cred.platform}`);
      return null;
    }

    logger.info(`[Account-Health] 🔍 开始检测 (${cred.platform} / ${cred.nickname})`);

    const partition = `persist:account_${id}`;
    const sess = session.fromPartition(partition);
    await BrowserEnvService.applyEnvironment(sess, cred.envId);

    const win = new BrowserWindow({
      width: 1280, height: 880,
      title: `检测登录态 - ${cred.nickname || id}`,
      show: false,  // 隐藏窗口，静默检测
      autoHideMenuBar: true,
      icon: getAppIcon(),
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);

    // 抖音：应用反崩溃配置（跳过抖音签名 cookie、移除反调试参数等）
    try {
      if (cred.platform === 'douyin') {
        applyDouyinAntiCrash(win, cred.id, (level, stage, message, data) => {
          logger[level](`[Account-Health][${stage}] ${message}`, data || '');
        });
      }
    } catch { /* ignore */ }

    try {
      await win.loadURL(platform.meta.homeUrl);
    } catch (e) {
      logger.warn(`[Account-Health] 加载页面失败: ${(e as Error).message}`);
    }

    // 等待 5 秒，让 cookies / 页面初始化
    await new Promise((r) => setTimeout(r, 5000));

    const check = await platform.detectLoggedIn(win);
    logger.info(`[Account-Health]   → 登录态: loggedIn=${check.loggedIn}`);

    // 更新账号信息（即使未登录也更新 lastChecked，便于 UI 展示）
    const list = AccountService.loadCredentials();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) {
      try { win.destroy(); } catch { /* noop */ }
      return null;
    }

    list[idx].lastChecked = Date.now();

    if (check.loggedIn) {
      // 登录有效：尝试刷新统计信息（粉丝/关注/获赞）
      try {
        const extracted = await platform.extractPageInfo(win);
        if (extracted.nickname) list[idx].nickname = extracted.nickname;
        if (extracted.avatar) list[idx].avatar = extracted.avatar;
        if (extracted.platformAccountId) list[idx].platformAccountId = extracted.platformAccountId;
        if (typeof extracted.fansCount === 'number') list[idx].fansCount = extracted.fansCount;
        if (typeof extracted.followCount === 'number') list[idx].followCount = extracted.followCount;
        if (typeof extracted.likeCount === 'number') list[idx].likeCount = extracted.likeCount;
        if (!list[idx].expiresAt || list[idx].expiresAt < Date.now()) {
          // 登录有效时，将过期时间向后顺延 14 天
          list[idx].expiresAt = Date.now() + 14 * 24 * 3600 * 1000;
        }
        logger.info(`[Account-Health] ✅ ${cred.platform}/${cred.nickname}: 粉丝=${list[idx].fansCount ?? '-'}, 关注=${list[idx].followCount ?? '-'}, 获赞=${list[idx].likeCount ?? '-'}`);
      } catch (e) {
        logger.warn(`[Account-Health]   → 提取统计信息失败: ${(e as Error).message}`);
      }
    } else {
      // 登录已失效，将 expiresAt 设为过去时间，toInfo() 会据此推断 status='expired'
      list[idx].expiresAt = Date.now() - 1;
      logger.info(`[Account-Health] ⚠️ ${cred.platform}/${cred.nickname}: 登录态失效，标记为 expired`);
    }

    AccountService.saveCredentials(list);

    try { if (!win.isDestroyed()) win.destroy(); } catch { /* noop */ }

    return AccountService.toInfo(list[idx]);
  }

  /**
   * 批量检测所有账号健康状态（串行执行，避免同时打开过多浏览器窗口导致 CPU 占用太高）。
   * 返回：更新后的账号列表。
   */
  static async checkAllAccountsHealth(): Promise<AccountInfo[]> {
    if (AccountService.healthCheckInProgress) {
      logger.info('[Account-Health] ⏳ 已有健康检测在进行中，本次跳过');
      return AccountService.listAccounts();
    }
    AccountService.healthCheckInProgress = true;

    try {
      const accounts = AccountService.loadCredentials();
      logger.info(`[Account-Health] ============ 开始批量健康检测，共 ${accounts.length} 个账号 ============`);

      for (const cred of accounts) {
        try {
          await AccountService.checkAccountHealth(cred.id);
          await new Promise((r) => setTimeout(r, 1500)); // 账号间留间隔，降低 CPU 占用
        } catch (e) {
          logger.warn(`[Account-Health] ${cred.id} 检测失败: ${(e as Error).message}`);
        }
      }

      logger.info('[Account-Health] ============ 批量健康检测完成 ============');
      return AccountService.listAccounts();
    } finally {
      AccountService.healthCheckInProgress = false;
    }
  }

  static listAccounts(): AccountInfo[] {
    const list = this.loadCredentials();
    return list.map((c) => this.toInfo(c));
  }

  static getAccount(id: string): AccountInfo | null {
    const c = this.loadCredentials().find((a) => a.id === id);
    return c ? this.toInfo(c) : null;
  }

  static getCredential(id: string): AccountCredential | null {
    return this.loadCredentials().find((a) => a.id === id) || null;
  }

  // -----------------------------------------------------------------------
  // 授权主流程（v2）
  //   1. 打开 platform.authUrl（直接在创作中心域）
  //   2. 等待用户完成登录；同时在窗口右上角注入红色"✅ 登录完成，保存账号"按钮
  //   3. 用户点按钮 或 关窗口 → 触发保存：
  //        · 判断当前页面是否已登录（URL + 页面关键字）
  //        · 若未登录则尝试再跳一次 homeUrl 并等待
  //        · 读 DOM 拿昵称/头像
  //        · 读 partition 里所有 cookies（完整属性：secure/httpOnly/sameSite/expires）
  //        · 加密保存
  // -----------------------------------------------------------------------
  static async beginAuthorization(platformKey: PlatformType, envId?: string | null): Promise<AccountInfo> {
    const platform = getPlatform(platformKey);
    if (!platform) throw new Error(`未知平台: ${platformKey}`);
    const strategy = platform.meta;

    const accountId = genId(platformKey);
    const partition = `persist:account_${accountId}`;

    logger.info('\n' + '='.repeat(70));
    logger.info(`[Account-Auth] 🚀 开始授权 (${platformKey})`);
    logger.info(`[Account-Auth]   accountId  = ${accountId}`);
    logger.info(`[Account-Auth]   partition  = ${partition}`);
    logger.info(`[Account-Auth]   authUrl    = ${strategy.authUrl}`);
    logger.info('='.repeat(70) + '\n');

    const sess = session.fromPartition(partition);
    await BrowserEnvService.applyEnvironment(sess, envId);

    const authWin = new BrowserWindow({
      width: 1280,
      height: 880,
      minWidth: 900,
      minHeight: 640,
      title: `登录 ${PLATFORMS[platformKey]?.name ?? platformKey} — FlowX （完成扫码后点击右上角"保存账号"按钮）`,
      autoHideMenuBar: true,
      icon: getAppIcon(),
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    authWin.setMenuBarVisibility(false);

    // 记录窗口导航日志（便于排查）
    authWin.webContents.on('did-navigate', (_e, url) =>
      logger.info(`[Account-Auth] → 页面导航: ${url}`),
    );
    authWin.webContents.on('did-navigate-in-page', (_e, url) =>
      logger.info(`[Account-Auth] → 页面内导航: ${url}`),
    );

    // 保存信号魔法值（多机制并发触发，应对不同平台页面差异）
    const SAVE_TITLE_MAGIC = '__FLOWX_SAVE_ACCOUNT_MAGIC__';
    const SAVE_HASH_MAGIC = '#flowx-save-now-' + Math.random().toString(36).slice(2, 8);

    // 每次页面渲染完成后注入"保存账号"按钮
    const injectSaveBtn = () => {
      if (authWin.isDestroyed()) return;
      authWin.webContents
        .executeJavaScript(`
          (function(){
            if (document.getElementById('flowx-account-save-btn')) return;
            var d = document.createElement('div');
            d.id = 'flowx-account-save-btn';
            d.innerHTML = '💾 保存账号';
            d.title = '完成扫码登录后点击此按钮保存';
            d.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#ff2442;color:#fff;padding:12px 18px;border-radius:8px;font-size:14px;font-family:"PingFang SC",sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);font-weight:600;letter-spacing:1px;user-select:none';
            d.onclick = function(){
              if (d.dataset.clicked) return;
              d.dataset.clicked = '1';
              d.innerText = '⏳ 正在验证登录状态...';
              d.style.pointerEvents='none';
              d.style.opacity='0.7';
              // 多信号并发：document.title / location.hash / 页面全局标记
              // 主进程通过多种事件监听捕获，任何一种都能触发保存
              setTimeout(function(){
                try { document.title = '${SAVE_TITLE_MAGIC}'; } catch(e) {}
                try { window.location.hash = '${SAVE_HASH_MAGIC}'; } catch(e) {}
                try { window.__FLOWX_SAVE_NOW__ = 1; } catch(e) {}
              }, 200);
            };
            document.body.appendChild(d);
          })();
        `)
        .catch(() => {/* 非 HTML 页面忽略 */});
    };
    authWin.webContents.on('did-frame-finish-load', injectSaveBtn);
    authWin.webContents.on('did-finish-load', injectSaveBtn);
    // 每 3 秒补一次（防止 SPA 路由切换后按钮丢失）
    const btnReinject = setInterval(injectSaveBtn, 3000);

    // 打开登录/创作中心页
    logger.info(`[Account-Auth] 打开: ${strategy.authUrl}`);
    await authWin.loadURL(strategy.authUrl).catch((err) =>
      logger.warn('[Account-Auth] 加载页面失败（继续等待用户操作）:', err?.message),
    );

    return new Promise<AccountInfo>((resolve, reject) => {
      // ===== 关键安全标志：防止 trySave 被重复触发（用户点按钮+关窗会两次调用）=====
      let isTryingToSave = false;
      // 每次 loadURL 超时限制（避免网络慢时 Promise 悬停）
      const loadWithTimeout = (url: string, timeoutMs = 10000) => {
        return new Promise<boolean>((done) => {
          let finished = false;
          authWin.loadURL(url)
            .then(() => { if (!finished) { finished = true; done(true); } })
            .catch(() => { if (!finished) { finished = true; done(false); } });
          setTimeout(() => { if (!finished) { finished = true; done(false); } }, timeoutMs);
        });
      };

      const trySave = async () => {
        // ===== 1. 防抖：正在处理中则直接跳过 =====
        if (isTryingToSave) {
          logger.info('[Account-Auth] ⏳ trySave 已在执行中，跳过重复调用');
          return;
        }
        isTryingToSave = true;

        try {
          logger.info('\n' + '-'.repeat(70));
          logger.info(`[Account-Auth] 🔍 开始提取登录态...`);
          logger.info('-'.repeat(70));

          // -------- Step 1: 确保页面在已登录状态下 --------
          let isLoggedIn = false;
          let tries = 0;
          while (tries < 2 && !authWin.isDestroyed()) {
            const currentUrl = authWin.webContents.getURL();
            logger.info(`[Account-Auth] 当前 URL: ${currentUrl}`);

            const check = await platform.detectLoggedIn(authWin);
            logger.info(`[Account-Auth]   → 平台检测结果: loggedIn=${check.loggedIn}, 命中关键字=${check.matchedKeywords?.join(', ') ?? '(无)'}`);

            if (check.loggedIn) {
              isLoggedIn = true;
              break;
            }

            tries++;
            logger.info(`[Account-Auth]   → 尝试导航到创作者中心首页 (第 ${tries} 次): ${strategy.homeUrl}`);
            const loaded = await loadWithTimeout(strategy.homeUrl, 8000);
            if (loaded) await sleep(2000);
          }

          // ========== 关键修复：强制登录态检查 ==========
          // 用户可能没登录就直接关窗 —— 必须拒绝保存空账号
          if (!isLoggedIn) {
            throw new Error(
              `未检测到有效登录态。\n` +
              `请先在窗口中完成扫码/短信登录，确认已进入创作者中心后，\n` +
              `再点击右上角红色"保存账号"按钮或关闭窗口。`,
            );
          }

          // -------- Step 2: 让平台适配器从当前窗口 DOM 提取账号信息 --------
          let nickname = '';
          let avatar = '';
          let platformAccountId = '';
          let followCount: number | undefined;
          let fansCount: number | undefined;
          let likeCount: number | undefined;
          try {
            const extracted = await platform.extractPageInfo(authWin);
            nickname = extracted.nickname;
            avatar = extracted.avatar || '';
            platformAccountId = extracted.platformAccountId || '';
            followCount = extracted.followCount;
            fansCount = extracted.fansCount;
            likeCount = extracted.likeCount;
            logger.info(`[Account-Auth] 🔹 平台适配器提取结果: nickname="${nickname}", avatar="${avatar}", id="${platformAccountId}", 关注=${followCount ?? '-'}, 粉丝=${fansCount ?? '-'}, 获赞=${likeCount ?? '-'}`);
          } catch (e) {
            logger.warn(`[Account-Auth]   → DOM 提取失败: ${(e as Error).message}`);
          }

          // -------- Step 3: 收集 cookies --------
          const sess = session.fromPartition(partition);
          let rawCookies: any[] = [];
          try {
            rawCookies = await sess.cookies.get({});
          } catch (e) {
            logger.warn(`[Account-Auth]   → 读取 cookies 失败: ${(e as Error).message}`);
          }
          logger.info(`[Account-Auth] 🔹 共读取到 ${rawCookies.length} 条 cookies`);

          // -------- Step 4: 从 cookies 拿 userId --------
          let userId = '';
          const uidCandidates = ['a1', 'user_id', 'user_key', 'open_id', 'sec_user_id', 'uid'];
          for (const c of rawCookies) {
            if (uidCandidates.includes(c.name.toLowerCase()) && c.value) {
              userId = c.value;
              logger.info(`[Account-Auth] 🔹 从 cookie "${c.name}" 拿到 userId`);
              break;
            }
          }

          // -------- Step 5: 兜底 + 强校验 --------
          // 5.1 账号信息强校验：必须从 DOM 提取到真实昵称或平台账号ID
          //   —— 过滤明显的默认/占位文字（如"抖音创作者中心·创作者"）
          const BLACKLISTED_NICKNAMES = [
            '抖音创作者中心',
            '抖音创作者',
            '创作者中心',
            '创作中心',
            '小红书账号',
            '快手账号',
            '登录',
            '登录中',
            '未登录',
            'loading',
            '未命名',
            '匿名用户',
          ];
          const trimmedNickname = nickname.trim();
          const nicknameLooksReal =
            trimmedNickname.length > 0 &&
            !BLACKLISTED_NICKNAMES.some((b) => trimmedNickname.includes(b)) &&
            trimmedNickname.length < 40;
          const platformAccountIdLooksReal = platformAccountId && platformAccountId.trim().length > 2 && platformAccountId.trim().length < 30;

          // 用户信息必须来自真实 DOM 提取（昵称 or 平台账号ID），userId（cookie a1 等）不能作为唯一凭据
          const hasMeaningfulInfo = nicknameLooksReal || !!platformAccountIdLooksReal;
          if (!hasMeaningfulInfo) {
            throw new Error(
              `未在页面中找到真实账号信息（昵称/平台账号ID 均为空或为默认文字）。\n` +
              `请确认已完成登录并成功进入创作者中心后再保存。\n` +
              `（当前提取到的昵称: "${trimmedNickname || '(空)'}"）`,
            );
          }

          // 5.2 Cookies 校验：仅当 cookies 数量合理且包含登录相关 cookie 时才视为有效
          //   —— 纯浏览页面也会有 1~2 个 gdpr/tracker cookie，但真正登录后 cookies 数量通常 ≥ 5
          const hasLoginCookie = rawCookies.some((c) => {
            const name = c.name.toLowerCase();
            return (
              name.includes('session') ||
              name.includes('sid') ||
              name.includes('token') ||
              name.includes('auth') ||
              name.includes('login') ||
              name.includes('user_id') ||
              name.includes('uid') ||
              name.includes('a1') ||  // 小红书
              name.includes('sec_user_id') ||  // 抖音/小红书
              name === 'sessionid' ||
              name === 'sid_guard'
            );
          });
          if (rawCookies.length === 0 || (!hasLoginCookie && rawCookies.length < 5)) {
            throw new Error(
              `未检测到 ${PLATFORMS[platformKey]?.name ?? platformKey} 有效登录凭证（partition 中无登录相关 cookies）。\n` +
              `请在窗口内完成扫码/短信登录后，再点右上角红色"保存账号"按钮或关闭窗口。`,
            );
          }

          // 5.3 昵称兜底：仅在有其他可靠凭据（如真实平台账号ID）时才允许用默认昵称做兜底
          //     （如果 DOM 昵称空、平台账号ID也空、粉丝数据也空，说明没有真登录，不该保存）
          const hasStatsData =
            typeof fansCount === 'number' || typeof followCount === 'number' || typeof likeCount === 'number';
          const realPlatformAccountId = platformAccountId && platformAccountId.trim().length > 2 && platformAccountId.trim().length < 30;
          const needsFallback = !nickname.trim();

          if (needsFallback && !realPlatformAccountId && !hasStatsData) {
            throw new Error(
              `页面没有真实账号数据（无昵称、无平台账号ID、无粉丝/关注数据）。\n` +
              `请确认已成功登录并进入创作者中心首页后再保存。`,
            );
          }

          const finalNick =
            nickname.trim() ||
            (realPlatformAccountId
              ? `${PLATFORMS[platformKey]?.name ?? platformKey}账号 (${platformAccountId.slice(-4)})`
              : `${PLATFORMS[platformKey]?.name ?? platformKey}账号`);
          if (!nickname.trim()) {
            logger.info(`[Account-Auth] 🔹 DOM 未提取到昵称，降级为: "${finalNick}"`);
          }

          // -------- Step 6: 构造凭证并持久化 --------
          const credential: AccountCredential = {
            id: accountId,
            platform: platformKey,
            cookies: rawCookies
              .filter((c) => !!c.value && !c.name.startsWith('__flowx_'))
              .map((c) => ({
                name: c.name,
                value: encrypt(c.value!),
                domain: c.domain || '',
                path: c.path || '/',
                secure: c.secure || false,
                httpOnly: c.httpOnly || false,
                sameSite: (c.sameSite as any) || 'unspecified',
                expirationDate: c.expirationDate ? Math.floor(c.expirationDate * 1000) : undefined,
              })),
            userId,
            nickname: finalNick,
            avatar: avatar || undefined,
            platformAccountId: platformAccountId || undefined,
            followCount,
            fansCount,
            likeCount,
            authUrl: strategy.authUrl,
            authorizedAt: Date.now(),
            expiresAt: Date.now() + 14 * 24 * 3600 * 1000,
            envId: envId || undefined,
          };

          this.saveCredential(credential);
          // saveCredential 内部做了 dedup：如果命中旧账号则更新它而不是新增
          // 这里重新从存储中读取真正被持久化的凭证，确保返回给调用方的 id 与磁盘一致
          const persisted =
            this.loadCredentials().find((c) => {
              const pidMatch = credential.platformAccountId && c.platformAccountId === credential.platformAccountId;
              const uidMatch = credential.userId && c.userId === credential.userId;
              return c.platform === credential.platform && (pidMatch || uidMatch);
            }) || credential;

          logger.info('\n' + '='.repeat(70));
          logger.info(`[Account-Auth] ✅ 保存成功！最终凭证:`);
          logger.info(`  id         = ${credential.id}`);
          logger.info(`  platform   = ${credential.platform}`);
          logger.info(`  nickname   = ${credential.nickname}`);
          logger.info(`  avatar     = ${credential.avatar || '(无)'}`);
          logger.info(`  userId     = ${credential.userId || '(无)'}`);
          if (credential.platformAccountId) logger.info(`  平台ID     = ${credential.platformAccountId}`);
          if (typeof credential.fansCount === 'number') logger.info(`  粉丝/关注/获赞 = ${credential.fansCount} / ${credential.followCount ?? '-'} / ${credential.likeCount ?? '-'}`);
          logger.info(`  cookies    = ${credential.cookies.length} 条 (已加密存储)`);
          logger.info(`  authUrl    = ${credential.authUrl}`);
          logger.info(`  authorizedAt = ${new Date(credential.authorizedAt).toLocaleString()}`);
          logger.info('='.repeat(70) + '\n');

          try { clearInterval(btnReinject); } catch { /* ignore */ }
          try { if (!authWin.isDestroyed()) authWin.destroy(); } catch { /* ignore */ }
          resolve(this.toInfo(persisted));
        } catch (err) {
          logger.error(`\n[Account-Auth] ❌ 授权失败: ${(err as Error).message}`);
          logger.error(`  堆栈: ${(err as Error).stack?.split('\n').slice(0, 3).join('\n')}`);
          try { clearInterval(btnReinject); } catch { /* ignore */ }
          try { if (!authWin.isDestroyed()) authWin.destroy(); } catch { /* ignore */ }
          reject(err);
        }
      };

      // ================ 核心保存信号（多机制并发监听，任何一个命中即触发）================
      // 机制 1: page-title-updated（对小红书等简单页面有效）
      authWin.on('page-title-updated', (evt, title) => {
        if (title === SAVE_TITLE_MAGIC) {
          evt.preventDefault();
          logger.info(`[Account-Auth] 🎯 捕获保存信号 [title] → 开始保存流程`);
          trySave();
        }
      });

      // 机制 2: did-navigate-in-page（hash 变更，对 SPA/框架页面更可靠）
      authWin.webContents.on('did-navigate-in-page', (_evt, url) => {
        if (url.includes(SAVE_HASH_MAGIC)) {
          logger.info(`[Account-Auth] 🎯 捕获保存信号 [hash] → 开始保存流程 (url=${url})`);
          trySave();
        }
      });

      // 机制 3: 轮询兜底（每 500ms 通过 executeJavaScript 检查信号标记）
      //    应对任何事件机制都无法触发的平台（如强 CSP 或特殊 iframe 结构）
      const signalPoller = setInterval(() => {
        if (isTryingToSave || authWin.isDestroyed()) return;
        authWin.webContents
          .executeJavaScript(
            `(function(){ try { return { t: document.title, h: location.hash, f: window.__FLOWX_SAVE_NOW__ }; } catch(e) { return {}; } })()`,
          )
          .then((info: any) => {
            if (!info || isTryingToSave) return;
            const hit =
              info.t === SAVE_TITLE_MAGIC ||
              (info.h && info.h.includes(SAVE_HASH_MAGIC.replace('#', ''))) ||
              info.f === 1;
            if (hit) {
              logger.info(`[Account-Auth] 🎯 捕获保存信号 [poll] → 开始保存流程 (t=${info.t?.slice(0, 30)}, h=${info.h?.slice(0, 30)}, f=${info.f})`);
              trySave();
            }
          })
          .catch(() => { /* 忽略轮询过程中的临时错误 */ });
      }, 500);

      // 用户手动关闭窗口（点击 X 按钮）→ 同样触发保存流程
      authWin.on('close', (e) => {
        if (!isTryingToSave) {
          e.preventDefault();
          logger.info(`[Account-Auth] 收到窗口关闭事件 → 开始保存...`);
          trySave();
        }
      });

      // 兜底超时（10 分钟）
      const timeoutHandle = setTimeout(() => {
        if (!authWin.isDestroyed()) {
          logger.warn(`[Account-Auth] ⏰ 授权超时，强制结束`);
          // 如果 trySave 还没开始，直接 reject
          if (!isTryingToSave) {
            isTryingToSave = true;
            clearInterval(signalPoller);
            try { if (!authWin.isDestroyed()) authWin.destroy(); } catch { /* ignore */ }
            reject(new Error('授权超时（10 分钟内未完成登录操作）'));
          }
        }
      }, 10 * 60 * 1000);

      // 窗口被销毁时清定时器
      authWin.on('closed', () => {
        clearTimeout(timeoutHandle);
        clearInterval(btnReinject);
        clearInterval(signalPoller);
      });
    });
  }

  static async deleteAccount(id: string): Promise<boolean> {
    const list = this.loadCredentials();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.saveCredentials(list);
    try {
      const sess = session.fromPartition(`persist:account_${id}`);
      await sess.clearStorageData();
      await sess.clearCache();
    } catch { /* ignore */ }
    logger.info(`[Account] 删除账号: ${id}`);
    return true;
  }

  static updateAccount(
    id: string,
    patch: Partial<Pick<AccountInfo, 'nickname' | 'remark' | 'categoryIds' | 'envId'>>,
  ): AccountInfo | null {
    const list = this.loadCredentials();
    const c = list.find((a) => a.id === id);
    if (!c) return null;
    if (typeof patch.nickname === 'string') c.nickname = patch.nickname;
    if (typeof patch.remark === 'string') {
      const idx = c.cookies.findIndex((x) => x.name === '__flowx_remark__');
      if (idx >= 0) c.cookies[idx].value = encrypt(patch.remark);
      else c.cookies.push({
        name: '__flowx_remark__',
        value: encrypt(patch.remark),
        domain: 'flowx.local',
        path: '/',
        secure: false,
        httpOnly: false,
      });
    }
    if (patch.categoryIds !== undefined) {
      c.categoryIds = (patch.categoryIds || []).slice(0, 5);
      // 清理原有的单分类遗留字段（若有）
      delete (c as any).categoryId;
    }
    if (patch.envId !== undefined) {
      c.envId = patch.envId;
    }
    this.saveCredentials(list);
    return this.toInfo(c);
  }

  /**
   * 刷新账号：先检测登录态是否有效。
   *  - 若有效：从页面提取最新的昵称/头像/粉丝数据，更新 cookies 和 expiresAt，返回更新后的账号信息
   *  - 若失效：弹出授权窗口让用户重新扫码，返回新账号（旧账号被合并/保留）
   */
  static async refreshToken(id: string): Promise<AccountInfo> {
    const list = this.loadCredentials();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error('账号不存在');
    const c = list[idx];
    const platform = getPlatform(c.platform);
    if (!platform) throw new Error(`未知平台: ${c.platform}`);

    logger.info(`\n[Account-Refresh] 🔄 开始刷新账号 ${c.nickname} (${c.platform})`);

    // Step 1: 打开浏览器窗口，用已有 partition 访问创作中心首页
    const partition = `persist:account_${c.id}`;
    const sess = session.fromPartition(partition);
    await BrowserEnvService.applyEnvironment(sess, c.envId);

    const win = new BrowserWindow({
      width: 1280,
      height: 880,
      title: `刷新登录态 - ${c.nickname}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);

    try {
      await win.loadURL(platform.meta.homeUrl);
    } catch (e) {
      logger.warn(`[Account-Refresh] 加载页面失败: ${(e as Error).message}`);
    }

    // 等待 SPA 渲染（首次给 4 秒，然后会在 extractPageInfo 内多次尝试）
    await new Promise((r) => setTimeout(r, 4000));

    // Step 2: 检测当前页面是否已登录（交给平台适配器）
    const checkResult = await platform.detectLoggedIn(win);
    logger.info(`[Account-Refresh] 检测: loggedIn=${checkResult.loggedIn}, url=${checkResult.url}`);

    if (checkResult.loggedIn) {
      // ========== 登录有效：直接更新信息 ==========
      logger.info(`[Account-Refresh] ✅ 登录态有效，提取最新信息`);

      let nickname = '';
      let avatar = '';
      let platformAccountId = '';
      let followCount: number | undefined;
      let fansCount: number | undefined;
      let likeCount: number | undefined;

      // ✅ 改进：最多尝试 3 次提取信息，间隔 2 秒
      //   小红书的数据看板是异步加载的，首次尝试可能 stats 还没渲染
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const extracted = await platform.extractPageInfo(win);
          nickname = extracted.nickname;
          avatar = extracted.avatar || '';
          platformAccountId = extracted.platformAccountId || '';
          followCount = extracted.followCount;
          fansCount = extracted.fansCount;
          likeCount = extracted.likeCount;

          logger.info(`[Account-Refresh]   → 第${attempt}次提取: 粉丝=${fansCount ?? '-'}, 关注=${followCount ?? '-'}, 获赞=${likeCount ?? '-'}`);
          // 打印调试信息（仅快手平台返回 _debug）
          const _dbg = (extracted as any)._debug;
          if (_dbg) {
            const samples: unknown[] = Array.isArray(_dbg.samples)
              ? _dbg.samples
              : (Array.isArray(_dbg.popTextSamples)
                  ? _dbg.popTextSamples
                  : _dbg.s2samples ?? []);
            const hits = _dbg.hit ?? _dbg.firstHits ?? _dbg.s0hits ?? 0;
            const errs: string = Array.isArray(_dbg.errors) ? _dbg.errors.join('; ') : '';
            const cname: string = _dbg.cookieUserId ?? _dbg.platformAccountId ?? '';
            logger.info(`[Account-Refresh]     [debug] statsHit=${hits}/3 cookieUserId=${cname} samples=${JSON.stringify(samples)}${errs ? ' errors=' + errs : ''}`);
          }

          // 有至少一个统计数据 或 已获取到昵称和头像 → 认为够用
          const hasAnyStat = typeof fansCount === 'number' || typeof followCount === 'number' || typeof likeCount === 'number';
          const hasBasicInfo = !!nickname && !!avatar;
          if ((hasAnyStat || hasBasicInfo) && attempt > 1) break;
          if (hasAnyStat && hasBasicInfo) break;

          if (attempt < 3) {
            logger.info(`[Account-Refresh]   → 数据不完整，等待 2s 后重试...`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (e) {
          logger.warn(`[Account-Refresh]   → 第${attempt}次提取异常: ${(e as Error).message}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // 提取最新 cookies
      const sess = session.fromPartition(partition);
      const freshCookies = await sess.cookies.get({});

      // 更新凭证：优先用新提取的信息，保留已有字段
      const newNick = (nickname || c.nickname).trim() || c.nickname;
      const newAvatar = avatar || c.avatar;
      const newPid = platformAccountId || c.platformAccountId;
      const newFollow = typeof followCount === 'number' ? followCount : c.followCount;
      const newFans = typeof fansCount === 'number' ? fansCount : c.fansCount;
      const newLikes = typeof likeCount === 'number' ? likeCount : c.likeCount;

      // 更新 cookies（保留 remark cookie）
      const remarkCookie = c.cookies.find((x) => x.name === '__flowx_remark__');
      const mergedCookies: AccountCredential['cookies'] = freshCookies
        .filter((ck) => !!ck.value && !ck.name.startsWith('__flowx_'))
        .map((ck) => ({
          name: ck.name,
          value: encrypt(ck.value!),
          domain: ck.domain || '',
          path: ck.path || '/',
          secure: ck.secure || false,
          httpOnly: ck.httpOnly || false,
          sameSite: (ck.sameSite as any) || 'unspecified',
          expirationDate: ck.expirationDate ? Math.floor(ck.expirationDate * 1000) : undefined,
        }));
      if (remarkCookie) mergedCookies.push(remarkCookie);

      list[idx] = {
        ...c,
        nickname: newNick,
        avatar: newAvatar,
        platformAccountId: newPid,
        followCount: newFollow,
        fansCount: newFans,
        likeCount: newLikes,
        cookies: mergedCookies,
        expiresAt: Date.now() + 14 * 24 * 3600 * 1000,
        authorizedAt: Date.now(),
      };
      this.saveCredentials(list);

      logger.info(`[Account-Refresh] ✅ 信息已更新: nickname=${newNick}, id=${newPid}, 粉丝=${newFans ?? '-'}`);
      win.destroy();
      return this.toInfo(list[idx]);
    } else {
      // ========== 登录失效：重新授权 ==========
      logger.info(`[Account-Refresh] ⚠️  登录态已失效，启动重新授权`);
      win.destroy();

      // beginAuthorization 内部 saveCredential 已做 dedup：
      // 若用户登录的是同一个账号，会直接更新现有记录（保留原 id），不会新增重复项
      const refreshedAccount = await AccountService.beginAuthorization(c.platform);
      logger.info(`[Account-Refresh] ✅ 重新授权完成: ${refreshedAccount.nickname}`);
      return refreshedAccount;
    }
  }

  // ============================= 存储层 =============================
  private static loadCredentials(): AccountCredential[] {
    const store = getStore();
    return (store.get(STORAGE_KEY) as AccountCredential[]) || [];
  }

  private static saveCredentials(list: AccountCredential[]): void {
    const store = getStore();
    store.set(STORAGE_KEY, list);
  }

  private static saveCredential(cred: AccountCredential): void {
    const list = this.loadCredentials();
    // 判重：同平台 + (同 platformAccountId 或 同 userId) → 更新而不是新增
    const idx = list.findIndex((c) => {
      if (c.platform !== cred.platform) return false;
      const pidMatch = cred.platformAccountId && c.platformAccountId === cred.platformAccountId;
      const uidMatch = cred.userId && c.userId === cred.userId;
      return pidMatch || uidMatch;
    });
    if (idx >= 0) {
      // 保留原 id，更新所有动态字段
      list[idx] = {
        ...cred,
        id: list[idx].id, // 保持原账号 id 不变
        categoryIds: list[idx].categoryIds || cred.categoryIds, // 关键：保留原账号的分类绑定
        envId: list[idx].envId || cred.envId, // 保留原账号的环境绑定
      };
      logger.info(`[Account-Auth] 🔄 检测到重复账号(${cred.platform})，更新已有记录而非新增`);
    } else {
      list.unshift(cred);
    }
    this.saveCredentials(list);
  }

  private static toInfo(c: AccountCredential): AccountInfo {
    const remarkCookie = c.cookies.find((x) => x.name === '__flowx_remark__');
    const remark = remarkCookie ? decrypt(remarkCookie.value) : undefined;
    let status: AccountInfo['status'] = 'active';
    if (c.expiresAt && c.expiresAt < Date.now()) status = 'expired';

    // 从平台注册表读取 capabilities（新增平台时无需再改这里）
    const p = getPlatform(c.platform);
    const capabilities = p ? p.capabilities : { publishVideo: true, publishImage: false, publishArticle: false };

    // 兼容老版本单分类数据
    const categoryIds = c.categoryIds || ((c as any).categoryId ? [(c as any).categoryId] : []);

    return {
      id: c.id,
      platform: c.platform,
      nickname: c.nickname,
      avatar: c.avatar,
      userId: c.userId,
      platformAccountId: c.platformAccountId,
      fansCount: c.fansCount,
      followCount: c.followCount,
      likeCount: c.likeCount,
      authorizedAt: c.authorizedAt,
      expiresAt: c.expiresAt,
      status,
      lastChecked: c.lastChecked,
      remark,
      capabilities,
      categoryIds,
      envId: c.envId,
    };
  }

  private static checkAllExpiration(): void {
    const list = this.loadCredentials();
    let changed = false;
    for (const c of list) {
      if (!c.expiresAt) {
        c.expiresAt = c.authorizedAt + 14 * 24 * 3600 * 1000;
        changed = true;
      }
    }
    if (changed) this.saveCredentials(list);
  }

  /**
   * 用已保存的登录态打开平台创作中心窗口（验证登录态是否有效）。
   *  - 使用与授权时相同的 partition: persist:account_<id>
   *  - 先注入 cookies，再跳转到 homeUrl
   *  - 返回 { ok, url, injected, skipped, failed, error? } 便于调试
   */
  static async openCreatorPlatform(
    accountId: string,
  ): Promise<{ ok: boolean; url: string; injected: number; skipped: number; failed: number; error?: string }> {
    const cred = AccountService.getCredential(accountId);
    if (!cred) {
      return { ok: false, url: '', injected: 0, skipped: 0, failed: 0, error: '账号不存在' };
    }
    const platform = getPlatform(cred.platform);
    if (!platform) {
      return { ok: false, url: '', injected: 0, skipped: 0, failed: 0, error: '未知平台: ' + cred.platform };
    }
    const homeUrl = platform.meta.homeUrl;

    // 1. 注入 cookies 到该账号的 partition
    const { ok, fail, skipped } = await injectAccountCookies(accountId, homeUrl);

    // 2. 打开 BrowserWindow，使用同一 partition（这样 cookies + localStorage + session 都共享）
    const partition = `persist:account_${accountId}`;
    const sess = session.fromPartition(partition);
    await BrowserEnvService.applyEnvironment(sess, cred.envId);

    const win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 900,
      minHeight: 600,
      title: `创作中心 - ${cred.nickname || cred.platform}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // ✅ 给渲染进程额外传参数（配合全局 --use-gl=swiftshader 等，双重保险）
        //    关键：禁用视频解码管道和 GPU 功能，避免视频预览触发 STATUS_ACCESS_VIOLATION
        additionalArguments: [
          '--disable-webgl',
          '--disable-webgl2',
          '--disable-3d-apis',
          '--disable-gpu-compositing',
          '--disable-accelerated-video-decode',
          '--disable-accelerated-video-encode',
          '--disable-accelerated-mjpeg-decode',
          '--disable-accelerated-vpx-decode',
          '--disable-features=HardwareVideoDecode,HardwareVideoEncoder,VaapiVideoDecoder,VaapiVideoEncoder,MediaFoundationVideoCapture,HardwareProtectedVideoDecode',
          '--max-active-webgl-contexts=0',
        ],
      },
    });

    // ✅ 抖音专属：给创作中心窗口加上反崩溃保护
    //    抖音视频上传后会触发 ByteNN WASM + WebGL GPU stall 崩溃（GPU stall due to ReadPixels）
    if (cred.platform === 'douyin') {
      const creatorLog = (level: 'info' | 'warn' | 'error', stage: string, msg: string, data?: Record<string, unknown>) => {
        const payload = data ? ` | ${JSON.stringify(data).slice(0, 200)}` : '';
        if (level === 'error' || level === 'warn') {
          logger.warn(`[Account][douyin-anti-crash][${stage}] ${msg}${payload}`);
        } else {
          logger.info(`[Account][douyin-anti-crash][${stage}] ${msg}${payload}`);
        }
      };
      applyDouyinAntiCrash(win, accountId, creatorLog as any);
    }

    // 3. 加载创作中心首页
    try {
      await win.loadURL(homeUrl);
    } catch (e) {
      logger.error(`[Account] openCreator loadURL failed: ${(e as Error).message}`);
      return {
        ok: false,
        url: homeUrl,
        injected: ok,
        skipped,
        failed: fail + 1,
        error: (e as Error).message,
      };
    }

    logger.info(
      `[Account] 打开创作中心: ${cred.platform} | ${cred.nickname} | url=${homeUrl} | cookies ok=${ok}, skip=${skipped}, fail=${fail}`,
    );

    return { ok: true, url: homeUrl, injected: ok, skipped, failed: fail };
  }

  // ============================= 分类管理 CRUD =============================

  /**
   * 获取所有分类列表
   */
  static listCategories(): AccountCategory[] {
    const store = getStore();
    return (store.get(CATEGORIES_STORAGE_KEY as any) as AccountCategory[]) || [];
  }

  /**
   * 创建新的账号分类
   */
  static createCategory(name: string): AccountCategory {
    const store = getStore();
    const categories = this.listCategories();
    // 校验分类名是否重复（忽略两端空格）
    const trimmedName = name.trim();
    if (categories.some((c) => c.name.trim() === trimmedName)) {
      throw new Error(`分类名称「${trimmedName}」已存在`);
    }
    const newCategory: AccountCategory = {
      id: genId('cat'),
      name: trimmedName,
      createdAt: Date.now(),
    };
    categories.push(newCategory);
    store.set(CATEGORIES_STORAGE_KEY as any, categories);
    logger.info(`[Account] 新建分类: ${trimmedName} (id=${newCategory.id})`);
    return newCategory;
  }

  /**
   * 更新已有账号分类名称
   */
  static updateCategory(id: string, name: string): AccountCategory | null {
    const store = getStore();
    const categories = this.listCategories();
    // 校验除当前分类外是否重名
    const trimmedName = name.trim();
    if (categories.some((c) => c.id !== id && c.name.trim() === trimmedName)) {
      throw new Error(`分类名称「${trimmedName}」已存在`);
    }
    const c = categories.find((x) => x.id === id);
    if (!c) return null;
    c.name = trimmedName;
    store.set(CATEGORIES_STORAGE_KEY as any, categories);
    logger.info(`[Account] 更新分类: id=${id}, name=${trimmedName}`);
    return c;
  }

  /**
   * 删除账号分类（解绑所有使用该分类的账号）
   */
  static deleteCategory(id: string): boolean {
    const store = getStore();
    const categories = this.listCategories();
    const idx = categories.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    categories.splice(idx, 1);
    store.set(CATEGORIES_STORAGE_KEY as any, categories);

    // 清空绑定了此分类的账号
    const accounts = AccountService.loadCredentials();
    let changed = false;
    for (const acc of accounts) {
      if ((acc as any).categoryId === id) {
        delete (acc as any).categoryId;
        changed = true;
      }
      if (acc.categoryIds && acc.categoryIds.includes(id)) {
        acc.categoryIds = acc.categoryIds.filter((cid) => cid !== id);
        changed = true;
      }
    }
    if (changed) {
      AccountService.saveCredentials(accounts);
    }
    logger.info(`[Account] 删除分类: id=${id} (解绑账号数=${changed})`);
    return true;
  }
}

// =======================================================================
// 把已保存凭证注入到目标 partition（供发布自动化使用）
//   · 还原完整的 secure/httpOnly/sameSite/expires 属性
//   · 跳过注入会失败的 anti-bot cookie（acw_tc 等），它们会自动重新生成
// =======================================================================
export async function injectAccountCookies(accountId: string, targetUrl?: string): Promise<{ ok: number; fail: number; skipped: number }> {
  const cred = AccountService.getCredential(accountId);
  if (!cred) return { ok: 0, fail: 0, skipped: 0 };

  const sess = session.fromPartition(`persist:account_${accountId}`);

  const antiBotCookies = ['acw_tc', 'acw_sc__v2', 'acw_sc__v3', 's_v_web_id', 'tt_scid', 'ttwid', '_csrf'];
  let ok = 0, fail = 0, skipped = 0;

  for (const c of cred.cookies) {
    if (c.name === '__flowx_remark__') continue;
    if (antiBotCookies.includes(c.name)) {
      skipped++;
      continue; // 反自动化 cookie 不注入；访问时会重新下发
    }

    const domain = c.domain || '';
    if (!domain) { skipped++; continue; }

    try {
      // 计算注入 URL（用 https:// + 去掉首点的域名）
      const normalizedDomain = domain.replace(/^\./, '');
      const url = targetUrl || `https://${normalizedDomain}${c.path || '/'}`;

      await sess.cookies.set({
        url,
        name: c.name,
        value: decrypt(c.value),
        domain: domain.startsWith('.') ? domain : undefined,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate: c.expirationDate ? c.expirationDate / 1000 : undefined,
      });
      ok++;
    } catch (err) {
      fail++;
      logger.info(`[Account] 注入 cookie 失败: ${c.name} (${domain}) → ${(err as Error).message}`);
    }
  }

  logger.info(`[Account] 注入账号 ${accountId}: ok=${ok}, fail=${fail}, skipped=${skipped}`);
  return { ok, fail, skipped };
}
