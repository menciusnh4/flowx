import { defineStore } from 'pinia';
import { electronApi } from '../utils/electron';
import type { AccountInfo, PlatformMeta, PlatformType, HealthCheckConfig, AccountCategory, PagedResult, AccountQueryFilter } from '../../types';

export const useAccountStore = defineStore('account', {
  state: () => ({
    loading: false,
    accounts: [] as AccountInfo[],
    platforms: [] as PlatformMeta[],
    error: '' as string,
    healthCheckConfig: null as HealthCheckConfig | null,
    categories: [] as AccountCategory[],
    /** 全局搜索「账号定位」目标：搜索结果点击账号后，由 AccountPanel 消费并滚动+脉冲高亮 */
    highlightAccountId: '' as string,
    /** 自增计数：即使重复点击同一账号（id 不变）也能触发 AccountPanel 重新定位 */
    highlightNonce: 0 as number,
  }),
  getters: {
    activeAccounts: (s) => s.accounts.filter((a) => a.status === 'active'),
    byPlatform: (s) => (p: PlatformType): AccountInfo[] => s.accounts.filter((a) => a.platform === p),
  },
  actions: {
    async loadPlatforms() {
      if (this.platforms.length > 0) return;
      this.platforms = await electronApi.listPlatforms();
    },
    async refreshAccounts() {
      this.loading = true;
      this.error = '';
      try {
        this.accounts = await electronApi.listAccounts();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 服务端分页查询账号（筛选下推主进程），供账号管理列表使用 */
    async loadAccountsPaged(filter: AccountQueryFilter = {}, page = 1, pageSize = 10): Promise<PagedResult<AccountInfo>> {
      try {
        return await electronApi.listAccountsPaged(filter, page, pageSize);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return { items: [], total: 0, page, pageSize, totalPages: 1 };
      }
    },
    async beginAuth(platform: PlatformType, envId?: string | null) {
      const acc = await electronApi.beginAuth(platform, envId);
      await this.refreshAccounts();
      return acc;
    },
    async deleteAccount(id: string) {
      await electronApi.deleteAccount(id);
      await this.refreshAccounts();
    },
    async updateAccount(id: string, patch: { nickname?: string; remark?: string; categoryIds?: string[]; envId?: string | null }) {
      await electronApi.updateAccount(id, patch);
      await this.refreshAccounts();
    },
    async refreshToken(id: string) {
      const acc = await electronApi.refreshToken(id);
      await this.refreshAccounts();
      return acc;
    },

    // ========== 分类管理 Action ==========
    async loadCategories() {
      try {
        this.categories = await electronApi.listCategories();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },
    async createCategory(name: string) {
      await electronApi.createCategory(name);
      await this.loadCategories();
    },
    async updateCategory(id: string, name: string) {
      await electronApi.updateCategory(id, name);
      await this.loadCategories();
      await this.refreshAccounts();
    },
    async deleteCategory(id: string) {
      await electronApi.deleteCategory(id);
      await this.loadCategories();
      await this.refreshAccounts();
    },

    /** 静默检测单个账号的登录状态（不弹用户可编辑的窗口） */
    async checkAccountHealth(id: string): Promise<AccountInfo | null> {
      const acc = await electronApi.checkAccountHealth(id);
      await this.refreshAccounts();
      return acc;
    },

    /** 批量检测所有账号的登录态 */
    async checkAllAccountsHealth(): Promise<AccountInfo[]> {
      const list = await electronApi.checkAllAccountsHealth();
      await this.refreshAccounts();
      return list;
    },

    /** 配置定时检测的间隔，intervalMs 为毫秒，<= 0 停止定时 */
    async setHealthCheckInterval(intervalMs: number, initialDelayMs = 0): Promise<boolean> {
      return electronApi.setHealthCheckInterval(intervalMs, initialDelayMs);
    },

    /** 加载健康检测配置（从主进程持久化存储中读取） */
    async loadHealthCheckConfig(): Promise<HealthCheckConfig> {
      const cfg = await electronApi.getHealthCheckConfig();
      this.healthCheckConfig = cfg;
      return cfg;
    },

    /** 全局搜索：请求把某个账号在账号管理页中定位（滚动到该行 + 脉冲高亮）。
     *  由搜索结果点击账号触发；AccountPanel watch highlightNonce 消费。 */
    locateAccount(id: string) {
      this.highlightAccountId = id;
      this.highlightNonce++;
    },

    /** 更新健康检测配置（同时持久化保存 + 重启定时器） */
    async setHealthCheckConfig(cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }): Promise<HealthCheckConfig> {
      const newCfg = await electronApi.setHealthCheckConfig(cfg);
      this.healthCheckConfig = newCfg;
      return newCfg;
    },
  },
});
