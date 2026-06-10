import { defineStore } from 'pinia';
import { electronApi } from '../utils/electron';
import type { AccountInfo, PlatformType } from '../../types';

export const useAccountStore = defineStore('account', {
  state: () => ({
    loading: false,
    accounts: [] as AccountInfo[],
    platforms: [] as { key: PlatformType; name: string; icon: string; platformAccountLabel: string }[],
    error: '' as string,
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
  },
});
