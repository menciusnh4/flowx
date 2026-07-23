import { getStore } from '../store/SecureStore';
import { logger } from '../utils/logger';
import { session, net } from 'electron';
import type { ProxyConfig, BrowserEnvironment, ProxyTestResult, PagedResult, ProxyQueryFilter, EnvQueryFilter } from '../../types';

const PROXIES_KEY = 'proxies';
const ENVIRONMENTS_KEY = 'environments';
const ACCOUNTS_KEY = 'accounts';

export class BrowserEnvService {
  // ==================== 代理 IP 配置 CRUD ====================

  /**
   * 获取所有代理配置
   */
  static listProxies(): ProxyConfig[] {
    const store = getStore();
    return (store.get(PROXIES_KEY) as ProxyConfig[] | undefined) || [];
  }

  /** 服务端分页查询代理 IP（预留 keyword/type 筛选，当前页面无筛选 UI 也可正确分页） */
  static queryProxies(
    filter: ProxyQueryFilter = {},
    page = 1,
    pageSize = 10,
  ): PagedResult<ProxyConfig> {
    let list = this.listProxies();
    const q = (filter.keyword || '').trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.host.toLowerCase().includes(q) ||
          String(p.port).includes(q),
      );
    }
    if (filter.type) {
      list = list.filter((p) => p.type === filter.type);
    }
    const total = list.length;
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 10));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const start = (safePage - 1) * safeSize;
    return {
      items: list.slice(start, start + safeSize),
      total,
      page: safePage,
      pageSize: safeSize,
      totalPages,
    };
  }

  /**
   * 新增代理配置
   */
  static createProxy(data: Omit<ProxyConfig, 'id' | 'createdAt'>): ProxyConfig {
    const store = getStore();
    const list = this.listProxies();
    const newProxy: ProxyConfig = {
      ...data,
      id: 'prx_' + Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
    };
    list.push(newProxy);
    store.set(PROXIES_KEY, list);
    logger.info(`[BrowserEnv] 新建代理成功: ${newProxy.name} (${newProxy.host}:${newProxy.port})`);
    return newProxy;
  }

  /**
   * 更新代理配置
   */
  static updateProxy(id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>): ProxyConfig | null {
    const store = getStore();
    const list = this.listProxies();
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    list[idx] = {
      ...list[idx],
      ...patch,
    };
    store.set(PROXIES_KEY, list);
    logger.info(`[BrowserEnv] 更新代理成功: id=${id}, name=${list[idx].name}`);
    return list[idx];
  }

  /**
   * 删除代理配置 (级联清理绑定此代理的环境)
   */
  static deleteProxy(id: string): boolean {
    const store = getStore();
    const list = this.listProxies();
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    store.set(PROXIES_KEY, list);

    // 级联清理环境配置中的 proxyId 绑定
    const envs = this.listEnvironments();
    let envsChanged = false;
    for (const env of envs) {
      if (env.proxyId === id) {
        env.proxyId = null;
        envsChanged = true;
      }
    }
    if (envsChanged) {
      store.set(ENVIRONMENTS_KEY, envs);
    }
    logger.info(`[BrowserEnv] 删除代理成功: id=${id} (解绑环境数=${envsChanged})`);
    return true;
  }

  /**
   * 测试代理 IP 是否可用
   * 通过创建临时 session 并使用代理发起 HTTP 请求来验证
   * @param proxyId 代理配置 ID
   * @param testUrl 测试 URL，默认使用 httpbin.org/ip
   * @param timeoutMs 超时时间（毫秒），默认 10 秒
   */
  static async testProxy(
    proxyId: string,
    testUrl = 'https://httpbin.org/ip',
    timeoutMs = 10000,
  ): Promise<ProxyTestResult> {
    const proxy = this.listProxies().find((p) => p.id === proxyId);
    if (!proxy) {
      return {
        ok: false,
        latency: -1,
        targetUrl: testUrl,
        error: '代理配置不存在',
      };
    }

    const partition = `persist:proxy_test_${proxyId}_${Date.now()}`;
    const sess = session.fromPartition(partition) as any;

    try {
      // 配置代理
      const proxyRules = `${proxy.type}://${proxy.host}:${proxy.port}`;
      await sess.setProxy({ proxyRules });

      // 配置代理认证（如果需要）
      if (proxy.username && proxy.password) {
        sess.removeAllListeners('login');
        sess.on('login', (event: any, _details: any, authInfo: any, callback: any) => {
          if (authInfo.isProxy) {
            event.preventDefault();
            callback(proxy.username, proxy.password);
          }
        });
      }

      const startTime = Date.now();

      // 使用 net 模块通过 session 发起请求
      return await new Promise<ProxyTestResult>((resolve) => {
        const req = net.request({
          url: testUrl,
          session: sess,
          method: 'GET',
        });

        const timeoutTimer = setTimeout(() => {
          req.abort();
          resolve({
            ok: false,
            latency: -1,
            targetUrl: testUrl,
            error: `请求超时（${timeoutMs}ms）`,
          });
        }, timeoutMs);

        req.on('response', (response: any) => {
          const latency = Date.now() - startTime;
          clearTimeout(timeoutTimer);

          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf-8');
          });

          response.on('end', () => {
            const statusCode = response.statusCode;
            if (statusCode >= 200 && statusCode < 300) {
              let outboundIp: string | undefined;
              try {
                const json = JSON.parse(body);
                outboundIp = json.origin || json.ip;
              } catch {
                // 解析失败也不影响测试结果
              }
              logger.info(`[BrowserEnv] 代理测试成功: ${proxy.name} (${proxy.host}:${proxy.port}), 延迟=${latency}ms`);
              resolve({
                ok: true,
                latency,
                targetUrl: testUrl,
                outboundIp,
              });
            } else {
              resolve({
                ok: false,
                latency,
                targetUrl: testUrl,
                error: `HTTP 状态码: ${statusCode}`,
              });
            }
          });
        });

        req.on('error', (err: Error) => {
          clearTimeout(timeoutTimer);
          const latency = Date.now() - startTime;
          logger.warn(`[BrowserEnv] 代理测试失败: ${proxy.name} (${proxy.host}:${proxy.port}), 错误=${err.message}`);
          resolve({
            ok: false,
            latency,
            targetUrl: testUrl,
            error: err.message || '网络请求失败',
          });
        });

        req.on('abort', () => {
          clearTimeout(timeoutTimer);
        });

        req.end();
      });
    } catch (err) {
      logger.error(`[BrowserEnv] 代理测试异常: ${proxy.name}`, err);
      return {
        ok: false,
        latency: -1,
        targetUrl: testUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // 清理临时 session 的缓存，释放资源
      try {
        sess.removeAllListeners('login');
        // 异步清理缓存，不阻塞返回
        sess.clearCache().catch(() => {});
        sess.clearStorageData({ storages: ['cookies', 'localstorage'] }).catch(() => {});
      } catch {
        // 清理失败忽略
      }
    }
  }

  // ==================== 浏览器环境配置 CRUD ====================

  /**
   * 获取所有浏览器环境配置
   */
  static listEnvironments(): BrowserEnvironment[] {
    const store = getStore();
    return (store.get(ENVIRONMENTS_KEY) as BrowserEnvironment[] | undefined) || [];
  }

  /** 服务端分页查询浏览器环境（预留 keyword 筛选） */
  static queryEnvironments(
    filter: EnvQueryFilter = {},
    page = 1,
    pageSize = 10,
  ): PagedResult<BrowserEnvironment> {
    let list = this.listEnvironments();
    const q = (filter.keyword || '').trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.userAgent.toLowerCase().includes(q) ||
          (e.proxyId || '').toLowerCase().includes(q),
      );
    }
    const total = list.length;
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 10));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const start = (safePage - 1) * safeSize;
    return {
      items: list.slice(start, start + safeSize),
      total,
      page: safePage,
      pageSize: safeSize,
      totalPages,
    };
  }

  /**
   * 新增环境配置
   */
  static createEnvironment(data: Omit<BrowserEnvironment, 'id' | 'createdAt'>): BrowserEnvironment {
    const store = getStore();
    const list = this.listEnvironments();
    const newEnv: BrowserEnvironment = {
      ...data,
      id: 'env_' + Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
    };
    list.push(newEnv);
    store.set(ENVIRONMENTS_KEY, list);
    logger.info(`[BrowserEnv] 新建环境成功: ${newEnv.name}`);
    return newEnv;
  }

  /**
   * 更新环境配置
   */
  static updateEnvironment(
    id: string,
    patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>,
  ): BrowserEnvironment | null {
    const store = getStore();
    const list = this.listEnvironments();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    list[idx] = {
      ...list[idx],
      ...patch,
    };
    store.set(ENVIRONMENTS_KEY, list);
    logger.info(`[BrowserEnv] 更新环境成功: id=${id}, name=${list[idx].name}`);
    return list[idx];
  }

  /**
   * 删除环境配置 (级联清理绑定该环境的账号)
   */
  static deleteEnvironment(id: string): boolean {
    const store = getStore();
    const list = this.listEnvironments();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    store.set(ENVIRONMENTS_KEY, list);

    // 级联清理账号绑定
    const accounts = (store.get(ACCOUNTS_KEY) as any[] | undefined) || [];
    let accChanged = false;
    for (const acc of accounts) {
      if (acc.envId === id) {
        acc.envId = null;
        accChanged = true;
      }
    }
    if (accChanged) {
      store.set(ACCOUNTS_KEY, accounts);
    }
    logger.info(`[BrowserEnv] 删除环境成功: id=${id} (解绑账号数=${accChanged})`);
    return true;
  }

  // ==================== 应用隔离指纹与代理 IP ====================

  /**
   * 在 Session 会话中应用绑定的浏览器指纹 UA 及代理 IP 出网环境
   * @param sess Electron 的 Session 实例
   * @param envId 绑定的浏览器环境 id
   * @returns 隔离应用结果；ok=false 表示隔离失效（环境/代理丢失），已回退本机直连
   */
  static async applyEnvironment(sess: any, envId?: string | null): Promise<{ ok: boolean; reason?: string }> {
    if (!envId) {
      // 若没有绑定环境，清空当前的代理设置，保持默认环境出网
      try {
        await sess.setProxy({ mode: 'direct' });
      } catch (err) {
        logger.warn('[BrowserEnv] 清理代理失败', err);
      }

      // 🛡️ 强制净化默认的 User-Agent（抹除 Electron 与 flowx-desktop 等爬虫痕迹，防止微信视频号官方风控拒绝二维码加载）
      try {
        const defaultUA = sess.getUserAgent();
        if (defaultUA.indexOf('Electron/') !== -1 || defaultUA.indexOf('flowx-desktop/') !== -1) {
          const cleanUA = defaultUA
            .replace(/Electron\/[0-9\.]+\s?/g, '')
            .replace(/flowx-desktop\/[0-9\.]+\s?/g, '');
          sess.setUserAgent(cleanUA);
          logger.info(`[BrowserEnv] 已为未绑定环境的 Session 净化注入标准 UA: "${cleanUA}"`);
        }
      } catch (uaErr) {
        const fallbackUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
        sess.setUserAgent(fallbackUA);
        logger.info(`[BrowserEnv] 为未绑定环境的 Session 注入兜底 UA: "${fallbackUA}"`);
      }
      return { ok: true };
    }

    const env = this.listEnvironments().find((e) => e.id === envId);
    if (!env) {
      logger.warn(`[BrowserEnv] 未找到绑定的环境配置: ${envId}`);
      return { ok: false, reason: '绑定的隔离环境配置已不存在，已回退本机直连' };
    }

    // 1. 设置特定的浏览器指纹 User-Agent
    if (env.userAgent) {
      sess.setUserAgent(env.userAgent);
      logger.info(`[BrowserEnv] Session 已配置独立 User-Agent: "${env.userAgent}"`);
    }

    // 2. 设置独立的代理出网 IP
    if (env.proxyId) {
      const proxy = this.listProxies().find((p) => p.id === env.proxyId);
      if (proxy) {
        const proxyRules = `${proxy.type}://${proxy.host}:${proxy.port}`;
        try {
          await sess.setProxy({ proxyRules });

          // 每次配置前先清理之前的旧认证监听器，防范内存泄露
          sess.removeAllListeners('login');

          // 若代理需要鉴权（用户名及密码），监听并拦截填充
          if (proxy.username && proxy.password) {
            sess.on('login', (event: any, details: any, authInfo: any, callback: any) => {
              if (authInfo.isProxy) {
                event.preventDefault();
                callback(proxy.username, proxy.password);
              }
            });
            logger.info(`[BrowserEnv] 代理认证登录监听器已绑定: username="${proxy.username}"`);
          }
          logger.info(`[BrowserEnv] Session 已绑定代理出网环境: ${proxyRules}`);
          return { ok: true };
        } catch (err) {
          logger.error(`[BrowserEnv] 代理设置失败 (${proxyRules}):`, err);
          return { ok: false, reason: '代理 IP 配置无效，已回退本机直连' };
        }
      } else {
        logger.warn(`[BrowserEnv] 环境绑定的代理 IP 数据已丢失: proxyId=${env.proxyId}`);
        // 代理数据丢失 → 回退直连，避免用错误的出网 IP
        try {
          await sess.setProxy({ mode: 'direct' });
        } catch {
          /* ignore */
        }
        return { ok: false, reason: '绑定的代理 IP 已失效，已回退本机直连' };
      }
    } else {
      // 若没有绑定代理 IP，重置为直接连接
      try {
        await sess.setProxy({ mode: 'direct' });
      } catch (err) {
        logger.warn('[BrowserEnv] 重置直连代理失败', err);
      }
      return { ok: true };
    }
  }
}
