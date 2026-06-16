import { defineStore } from 'pinia';
import { electronApi } from '../utils/electron';
import type { AccountInfo, PlatformType, HealthCheckConfig } from '../../types';

export const useAccountStore = defineStore('account', {
  state: () => ({
    loading: false,
    accounts: [] as AccountInfo[],
    platforms: [] as { key: PlatformType; name: string; icon: string; platformAccountLabel: string }[],
    error: '' as string,
    healthCheckConfig: null as HealthCheckConfig | null,
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
    async beginAuth(platform: PlatformType) {
      const acc = await electronApi.beginAuth(platform);
      await this.refreshAccounts();
      return acc;
    },
    async deleteAccount(id: string) {
      await electronApi.deleteAccount(id);
      await this.refreshAccounts();
    },
    async updateAccount(id: string, patch: { nickname?: string; remark?: string }) {
      await electronApi.updateAccount(id, patch);
      await this.refreshAccounts();
    },
    async refreshToken(id: string) {
      const acc = await electronApi.refreshToken(id);
      await this.refreshAccounts();
      return acc;
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

    /** 更新健康检测配置（同时持久化保存 + 重启定时器） */
    async setHealthCheckConfig(cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }): Promise<HealthCheckConfig> {
      const newCfg = await electronApi.setHealthCheckConfig(cfg);
      this.healthCheckConfig = newCfg;
      return newCfg;
    },
  },
});
