import { session, BrowserWindow } from 'electron';
import crypto from 'crypto';
import { getStore, encrypt, decrypt } from '../store/SecureStore';
import { logger } from '../utils/logger';
import { PLATFORMS } from './PlatformRegistry';
import type {
  AccountCredential,
  AccountInfo,
  PlatformType,
} from '../../types';

// =======================================================================
// 平台策略：登录入口 + 个人中心页 + DOM 选择器
// =======================================================================
interface PlatformStrategy {
  // 授权窗口打开的第一页（直接在创作中心域登录，避免跨子域 401）
  authUrl: string;
  // 登录成功后理论上应该到达的 URL（用于"是否已登录"判定）
  homeUrl: string;
  // 提取昵称时的候选选择器（按顺序尝试）
  nicknameSelectors: string[];
  // 提取头像时的候选选择器（img 的 src）
  avatarSelectors: string[];
  // 页面已登录的启发式判定（body 文本中含任意关键字即判为已登录）
  loginKeywords: string[];
}

const STRATEGIES: Record<PlatformType, PlatformStrategy> = {
  xiaohongshu: {
    authUrl: 'https://creator.xiaohongshu.com/creator/home',
    homeUrl: 'https://creator.xiaohongshu.com/creator/home',
    // 顺序很重要：最精确的放最前面
    nicknameSelectors: [
      '.name-box',             // 小红书实际使用的昵称容器 span
      '.user_avatar + .name-box',
      '.user-name',
      '.nick-name',
      '.author-name',
      '.nickname',
      '.user-info .name-box',
      '.account-info .name-box',
      '[class*="name-box"]',
      '[class*="user-name"]',
      '[class*="nick"]',
    ],
    avatarSelectors: [
      'img.user_avatar',        // 小红书实际使用的头像 img
      '.user_avatar',
      '.user-info img',
      'img.avatar',
      '[class*="avatar"] img',
      'img[class*="avatar"]',
      '.header img',
    ],
    loginKeywords: ['创作中心', '数据中心', '作品管理', '发布笔记', '发布视频', '我的', '粉丝', '数据分析', '数据看板'],
  },
  douyin: {
    authUrl: 'https://creator.douyin.com/creator-micro/home',
    homeUrl: 'https://creator.douyin.com/creator-micro/home',
    nicknameSelectors: [
      '.name-box',
      '.user-name',
      '.nickname',
      '.header-user .name',
      '[class*="user-name"]',
      '[class*="nick"]',
    ],
    avatarSelectors: [
      'img.user_avatar',
      '.user-info img',
      '.avatar img',
      'img.avatar',
      '[class*="avatar"] img',
      'img[class*="avatar"]',
    ],
    loginKeywords: ['创作中心', '内容管理', '发布', '作品', '数据', '粉丝'],
  },
};

// 让 PLATFORMS 注册表里的 authUrl 与我们策略中的保持一致
for (const key of Object.keys(STRATEGIES) as PlatformType[]) {
  if (PLATFORMS[key]) {
    PLATFORMS[key].authUrl = STRATEGIES[key].authUrl;
    PLATFORMS[key].homeUrl = STRATEGIES[key].homeUrl;
  }
}

// =======================================================================
// 工具：延迟
// =======================================================================
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// =======================================================================
// 账号服务
// =======================================================================
const STORAGE_KEY = 'accounts';

function genId(prefix: string): string {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

export class AccountService {
  private static ready = false;

  static init() {
    if (AccountService.ready) return;
    AccountService.ready = true;
    AccountService.checkAllExpiration();
    logger.info('[Account] 账号服务初始化完成，支持平台:', Object.keys(STRATEGIES).join(', '));
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
  static async beginAuthorization(platform: PlatformType): Promise<AccountInfo> {
    const strategy = STRATEGIES[platform];
    if (!strategy) throw new Error(`未知平台: ${platform}`);

    const accountId = genId(platform);
    const partition = `persist:account_${accountId}`;

    logger.info('\n' + '='.repeat(70));
    logger.info(`[Account-Auth] 🚀 开始授权 (${platform})`);
    logger.info(`[Account-Auth]   accountId  = ${accountId}`);
    logger.info(`[Account-Auth]   partition  = ${partition}`);
    logger.info(`[Account-Auth]   authUrl    = ${strategy.authUrl}`);
    logger.info('='.repeat(70) + '\n');

    const authWin = new BrowserWindow({
      width: 1280,
      height: 880,
      minWidth: 900,
      minHeight: 640,
      title: `登录 ${PLATFORMS[platform]?.name ?? platform} - FlowX （登录完成后请点右上角红色按钮）`,
      autoHideMenuBar: true,
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

    // 每次页面渲染完成后注入"已登录完成，保存账号"按钮
    const injectSaveBtn = () => {
      if (authWin.isDestroyed()) return;
      authWin.webContents
        .executeJavaScript(`
          (function(){
            if (document.getElementById('flowx-account-save-btn')) return;
            var d = document.createElement('div');
            d.id = 'flowx-account-save-btn';
            d.innerHTML = '✅ 登录完成，保存账号';
            d.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#ff2442;color:#fff;padding:12px 18px;border-radius:8px;font-size:14px;font-family:"PingFang SC",sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);font-weight:600;letter-spacing:1px';
            d.onclick = function(){
              d.innerText = '正在保存，窗口将自动关闭...';
              d.style.pointerEvents='none';
              d.style.opacity='0.7';
              // 告诉主进程可以保存了（通过 window.close 触发 close 事件）
              setTimeout(function(){ window.close(); }, 400);
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
      const trySave = async () => {
        try {
          logger.info('\n' + '-'.repeat(70));
          logger.info(`[Account-Auth] 🔍 开始提取登录态...`);
          logger.info('-'.repeat(70));

          // -------- Step 1: 确保页面在已登录状态下 --------
          // 当前 URL 不是 home 且页面无登录关键字时，主动跳 homeUrl 再等 3 秒
          let currentUrl = authWin.webContents.getURL();
          let tries = 0;
          while (tries < 2) {
            logger.info(`[Account-Auth] 当前 URL: ${currentUrl}`);

            // 先尝试从当前页面读文本判断是否已登录
            let bodyText = '';
            try {
              bodyText = await authWin.webContents.executeJavaScript(
                `document.body ? document.body.innerText.slice(0,2000) : ''`,
              );
            } catch {
              bodyText = '';
            }
            const loggedIn = strategy.loginKeywords.some((k) => bodyText.includes(k));
            logger.info(`[Account-Auth]   → 登录关键字命中: ${loggedIn
              ? strategy.loginKeywords.filter((k) => bodyText.includes(k)).join(', ')
              : '无'}`);

            if (loggedIn && currentUrl.includes('creator')) break;

            // 尝试跳到 homeUrl，等 SPA 渲染
            tries++;
            logger.info(`[Account-Auth]   → 尝试导航到 homeUrl (第 ${tries} 次): ${strategy.homeUrl}`);
            try {
              await authWin.loadURL(strategy.homeUrl);
              await sleep(2500);
              currentUrl = authWin.webContents.getURL();
            } catch (e) {
              logger.warn(`[Account-Auth]   → 导航失败: ${(e as Error).message}`);
              await sleep(1500);
              currentUrl = authWin.webContents.getURL();
            }
          }

          // -------- Step 2: 读 DOM 结构（先打印给我看，再拿昵称/头像） --------
          let nickname = '';
          let avatar = '';
          try {
            const info: any = await authWin.webContents.executeJavaScript(`
              (function(){
                var r = { url: location.href, title: document.title, body: (document.body ? document.body.innerText.slice(0,1200) : ''), texts:[], imgs:[] };
                // 把页面里"有意义"的文本节点及其 class 路径打出来
                try {
                  var candidates = document.querySelectorAll('div, span, h1, h2, h3');
                  for (var i=0; i<Math.min(candidates.length,60); i++){
                    var el = candidates[i];
                    var txt = (el.textContent || '').trim();
                    if (txt && txt.length >= 2 && txt.length <= 40 && !/登录|注册|扫码|忘记|验证码|协议|隐私|Copyright|ICP/i.test(txt)){
                      var path = el.tagName.toLowerCase();
                      if (el.className && typeof el.className === 'string') path += ' class="' + el.className.slice(0,80) + '"';
                      else if (el.id) path += ' id="' + el.id + '"';
                      r.texts.push(path + ' → "' + txt + '"');
                    }
                  }
                } catch(e){}
                try {
                  var allImgs = document.querySelectorAll('img');
                  for (var i=0; i<Math.min(allImgs.length,15); i++){
                    var src = allImgs[i].getAttribute('src') || '';
                    if (!src || src.indexOf('data:') === 0) continue;
                    var cls = allImgs[i].getAttribute('class') || '';
                    var alt = allImgs[i].getAttribute('alt') || '';
                    r.imgs.push('[img] class="' + cls.slice(0,60) + '" alt="' + alt + '" src=' + src.slice(0,140));
                  }
                } catch(e){}
                // 最后：尝试按选择器拿昵称/头像
                var selectors = ${JSON.stringify({
                  nicks: strategy.nicknameSelectors,
                  avatars: strategy.avatarSelectors,
                })};
                for (var si=0; si<selectors.nicks.length; si++){
                  var el = document.querySelector(selectors.nicks[si]);
                  if (el && el.textContent && el.textContent.trim()){ r.nickname = el.textContent.trim(); break; }
                }
                for (var si=0; si<selectors.avatars.length; si++){
                  var el = document.querySelector(selectors.avatars[si]);
                  if (el && el.getAttribute){ var s = el.getAttribute('src') || ''; if (s && /^https?:\\/\\//.test(s)){ r.avatar = s; break; } }
                }
                return r;
              })();
            `);

            logger.info(`[Account-Auth] 🔹 页面快照:`);
            logger.info(`  url    = ${info?.url}`);
            logger.info(`  title  = ${info?.title}`);
            logger.info(`  body(前1200字) =\n${(info?.body || '').split('\n').map((l: string) => '    ' + l).join('\n')}`);
            if (info?.texts?.length) {
              logger.info(`  可见文本候选:`);
              info.texts.forEach((t: string, i: number) => logger.info(`    [${String(i).padStart(2, '0')}] ${t}`));
            }
            if (info?.imgs?.length) {
              logger.info(`  图片候选:`);
              info.imgs.forEach((t: string, i: number) => logger.info(`    [${String(i).padStart(2, '0')}] ${t}`));
            }
            nickname = info?.nickname || '';
            avatar = info?.avatar || '';
            logger.info(`[Account-Auth] 🔹 选择器提取结果: nickname="${nickname}", avatar="${avatar}"`);
          } catch (e) {
            logger.warn(`[Account-Auth]   → DOM 提取失败: ${(e as Error).message}`);
          }

          // -------- Step 3: 收集所有 cookies（含完整属性） --------
          const sess = session.fromPartition(partition);
          const rawCookies = await sess.cookies.get({});
          logger.info(`\n[Account-Auth] 🔹 Cookies: 共 ${rawCookies.length} 条（按域名分组）`);

          const byDomain = new Map<string, typeof rawCookies>();
          rawCookies.forEach((c) => {
            const key = c.domain || '(unknown)';
            if (!byDomain.has(key)) byDomain.set(key, []);
            byDomain.get(key)!.push(c);
          });
          byDomain.forEach((list, domain) => {
            logger.info(`  [${domain}] (${list.length} 条)`);
            list.forEach((c) => {
              const valStr = (c.value || '').length > 60
                ? (c.value || '').slice(0, 60) + `...(len=${(c.value || '').length})`
                : (c.value || '(empty)');
              logger.info(
                `     ${c.name} = ${valStr}  ` +
                `(path=${c.path || '/'}, httpOnly=${c.httpOnly}, secure=${c.secure}, sameSite=${c.sameSite || '-'}, expires=${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'})`,
              );
            });
          });

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

          // -------- Step 5: 兜底 + 校验 --------
          const finalNick =
            nickname.trim() || (userId ? `${PLATFORMS[platform]?.name ?? platform}账号 (${userId.slice(-4)})` : `${PLATFORMS[platform]?.name ?? platform}账号`);
          if (!nickname.trim()) {
            logger.info(`[Account-Auth] 🔹 DOM 未提取到昵称，降级为: "${finalNick}"`);
          }

          if (rawCookies.length === 0) {
            throw new Error(
              `未检测到 ${PLATFORMS[platform]?.name ?? platform} 登录态（partition 中无 cookies）。\n` +
              `请在窗口内完成扫码/短信登录后，再点右上角红色按钮或关闭窗口。`,
            );
          }

          // -------- Step 6: 构造凭证并持久化 --------
          const credential: AccountCredential = {
            id: accountId,
            platform,
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
            authUrl: strategy.authUrl,
            authorizedAt: Date.now(),
            expiresAt: Date.now() + 14 * 24 * 3600 * 1000,
          };

          this.saveCredential(credential);

          logger.info('\n' + '='.repeat(70));
          logger.info(`[Account-Auth] ✅ 保存成功！最终凭证:`);
          logger.info(`  id         = ${credential.id}`);
          logger.info(`  platform   = ${credential.platform}`);
          logger.info(`  nickname   = ${credential.nickname}`);
          logger.info(`  avatar     = ${credential.avatar || '(无)'}`);
          logger.info(`  userId     = ${credential.userId || '(无)'}`);
          logger.info(`  cookies    = ${credential.cookies.length} 条 (已加密存储)`);
          logger.info(`  authUrl    = ${credential.authUrl}`);
          logger.info(`  authorizedAt = ${new Date(credential.authorizedAt).toLocaleString()}`);
          logger.info('='.repeat(70) + '\n');

          try { clearInterval(btnReinject); } catch { /* ignore */ }
          try { authWin.destroy(); } catch { /* ignore */ }
          resolve(this.toInfo(credential));
        } catch (err) {
          logger.error(`\n[Account-Auth] ❌ 授权失败: ${(err as Error).message}`);
          logger.error(`  堆栈: ${(err as Error).stack?.split('\n').slice(0, 3).join('\n')}`);
          try { clearInterval(btnReinject); } catch { /* ignore */ }
          try { authWin.destroy(); } catch { /* ignore */ }
          reject(err);
        }
      };

      // 窗口关闭 → 保存
      authWin.on('close', (e) => {
        e.preventDefault();
        logger.info(`[Account-Auth] 收到窗口关闭事件 → 开始保存...`);
        trySave();
      });

      // 兜底超时（20 分钟）
      const timeoutHandle = setTimeout(() => {
        if (!authWin.isDestroyed()) {
          logger.warn(`[Account-Auth] ⏰ 授权超时，强制关闭`);
          trySave();
        }
      }, 20 * 60 * 1000);

      // 窗口被销毁时清定时器
      authWin.on('closed', () => {
        clearTimeout(timeoutHandle);
        clearInterval(btnReinject);
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
    patch: Partial<Pick<AccountInfo, 'nickname' | 'remark'>>,
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
    this.saveCredentials(list);
    return this.toInfo(c);
  }

  static async refreshToken(id: string): Promise<AccountInfo> {
    const c = this.loadCredentials().find((a) => a.id === id);
    if (!c) throw new Error('账号不存在');
    const info = await AccountService.beginAuthorization(c.platform);
    await AccountService.deleteAccount(c.id);
    return info;
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
    list.unshift(cred);
    this.saveCredentials(list);
  }

  private static toInfo(c: AccountCredential): AccountInfo {
    const remarkCookie = c.cookies.find((x) => x.name === '__flowx_remark__');
    const remark = remarkCookie ? decrypt(remarkCookie.value) : undefined;
    let status: AccountInfo['status'] = 'active';
    if (c.expiresAt && c.expiresAt < Date.now()) status = 'expired';

    // 根据平台推断发布能力：
    //   - xiaohongshu: 支持视频笔记 + 图文笔记
    //   - douyin: 支持视频发布 + 图文作品
    let capabilities: AccountInfo['capabilities'];
    switch (c.platform) {
      case 'xiaohongshu':
        capabilities = { publishVideo: true, publishImage: true, publishArticle: false };
        break;
      case 'douyin':
        capabilities = { publishVideo: true, publishImage: true, publishArticle: true };
        break;
      default:
        capabilities = { publishVideo: true, publishImage: false, publishArticle: false };
    }

    return {
      id: c.id,
      platform: c.platform,
      nickname: c.nickname,
      avatar: c.avatar,
      userId: c.userId,
      authorizedAt: c.authorizedAt,
      expiresAt: c.expiresAt,
      status,
      remark,
      capabilities,
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
   *  - 先注入凭证 cookies，再跳转到 homeUrl
   *  - 返回 { ok, windowOpened, cookiesInjected, skipped, url } 便于调试
   */
  static async openCreatorPlatform(
    accountId: string,
  ): Promise<{ ok: boolean; url: string; injected: number; skipped: number; failed: number; error?: string }> {
    const cred = AccountService.getCredential(accountId);
    if (!cred) {
      return { ok: false, url: '', injected: 0, skipped: 0, failed: 0, error: '账号不存在' };
    }
    const strategy = STRATEGIES[cred.platform];
    if (!strategy) {
      return { ok: false, url: '', injected: 0, skipped: 0, failed: 0, error: '未知平台: ' + cred.platform };
    }

    // 1. 注入 cookies 到该账号的 partition
    const { ok, fail, skipped } = await injectAccountCookies(accountId, strategy.homeUrl);

    // 2. 打开 BrowserWindow，使用同一 partition（这样 cookies + localStorage + session 都共享）
    const partition = `persist:account_${accountId}`;
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
      },
    });

    // 3. 加载创作中心首页
    try {
      await win.loadURL(strategy.homeUrl);
    } catch (e) {
      logger.error(`[Account] openCreator loadURL failed: ${(e as Error).message}`);
      return {
        ok: false,
        url: strategy.homeUrl,
        injected: ok,
        skipped,
        failed: fail + 1,
        error: (e as Error).message,
      };
    }

    logger.info(
      `[Account] 打开创作中心: ${cred.platform} | ${cred.nickname} | url=${strategy.homeUrl} | cookies ok=${ok}, skip=${skipped}, fail=${fail}`,
    );

    return { ok: true, url: strategy.homeUrl, injected: ok, skipped, failed: fail };
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
