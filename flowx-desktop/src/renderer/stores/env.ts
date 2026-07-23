import { defineStore } from 'pinia';
import { electronApi } from '../utils/electron';
import type { ProxyConfig, BrowserEnvironment, ProxyTestResult, PagedResult, ProxyQueryFilter, EnvQueryFilter } from '../../types';

export const useEnvStore = defineStore('env', {
  state: () => ({
    proxies: [] as ProxyConfig[],
    environments: [] as BrowserEnvironment[],
    loading: false,
  }),

  actions: {
    /**
     * 加载全部环境配置和代理 IP
     */
    async loadAll() {
      this.loading = true;
      try {
        const [pList, eList] = await Promise.all([
          electronApi.listProxies(),
          electronApi.listEnvironments(),
        ]);
        this.proxies = pList;
        this.environments = eList;
      } catch (err) {
        console.error('[EnvStore] 数据加载失败:', err);
      } finally {
        this.loading = false;
      }
    },

    /** 服务端分页查询代理 IP（筛选下推主进程），供列表使用 */
    async loadProxiesPaged(filter: ProxyQueryFilter = {}, page = 1, pageSize = 10): Promise<PagedResult<ProxyConfig>> {
      try {
        return await electronApi.listProxiesPaged(filter, page, pageSize);
      } catch (err) {
        console.error('[EnvStore] loadProxiesPaged failed:', err);
        return { items: [], total: 0, page, pageSize, totalPages: 1 };
      }
    },

    /** 服务端分页查询浏览器环境（筛选下推主进程），供列表使用 */
    async loadEnvironmentsPaged(filter: EnvQueryFilter = {}, page = 1, pageSize = 10): Promise<PagedResult<BrowserEnvironment>> {
      try {
        return await electronApi.listEnvironmentsPaged(filter, page, pageSize);
      } catch (err) {
        console.error('[EnvStore] loadEnvironmentsPaged failed:', err);
        return { items: [], total: 0, page, pageSize, totalPages: 1 };
      }
    },

    // ==================== 代理 IP 缓存操作 ====================

    async createProxy(data: Omit<ProxyConfig, 'id' | 'createdAt'>) {
      this.loading = true;
      try {
        const newProxy = await electronApi.createProxy(data);
        this.proxies.push(newProxy);
        return newProxy;
      } finally {
        this.loading = false;
      }
    },

    async updateProxy(id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>) {
      this.loading = true;
      try {
        const updated = await electronApi.updateProxy(id, patch);
        if (updated) {
          const idx = this.proxies.findIndex((p) => p.id === id);
          if (idx >= 0) this.proxies[idx] = updated;
        }
        return updated;
      } finally {
        this.loading = false;
      }
    },

    async deleteProxy(id: string) {
      this.loading = true;
      try {
        const ok = await electronApi.deleteProxy(id);
        if (ok) {
          this.proxies = this.proxies.filter((p) => p.id !== id);
          // 级联解绑本地代理 IP
          this.environments.forEach((env) => {
            if (env.proxyId === id) env.proxyId = null;
          });
        }
        return ok;
      } finally {
        this.loading = false;
      }
    },

    /**
     * 测试代理 IP 是否可用
     */
    async testProxy(id: string): Promise<ProxyTestResult> {
      return electronApi.testProxy(id);
    },

    // ==================== 浏览器环境缓存操作 ====================

    async createEnvironment(data: Omit<BrowserEnvironment, 'id' | 'createdAt'>) {
      this.loading = true;
      try {
        const newEnv = await electronApi.createEnvironment(data);
        this.environments.push(newEnv);
        return newEnv;
      } finally {
        this.loading = false;
      }
    },

    async updateEnvironment(id: string, patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>) {
      this.loading = true;
      try {
        const updated = await electronApi.updateEnvironment(id, patch);
        if (updated) {
          const idx = this.environments.findIndex((e) => e.id === id);
          if (idx >= 0) this.environments[idx] = updated;
        }
        return updated;
      } finally {
        this.loading = false;
      }
    },

    async deleteEnvironment(id: string) {
      this.loading = true;
      try {
        const ok = await electronApi.deleteEnvironment(id);
        if (ok) {
          this.environments = this.environments.filter((e) => e.id !== id);
        }
        return ok;
      } finally {
        this.loading = false;
      }
    },
  },
});
