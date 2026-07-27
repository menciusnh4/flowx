import { defineStore } from 'pinia';
import { electronApi } from '../utils/electron';
import type {
  WorkItem,
  WorkMetrics,
  AccountStatsSnapshot,
  BenchmarkAccount,
  AnalyticsConfig,
  WorksQueryParams,
  PagedResult,
  CollectProgress,
} from '../../types';

export const useAnalyticsStore = defineStore('analytics', {
  state: () => ({
    loading: false,
    config: null as AnalyticsConfig | null,
    works: [] as (WorkItem & { metrics?: WorkMetrics })[],
    worksTotal: 0,
    worksPage: 1,
    worksPageSize: 20,
    accountStats: [] as AccountStatsSnapshot[],
    benchmarks: [] as BenchmarkAccount[],
    activeTaskId: '' as string,
    currentProgress: null as CollectProgress | null,
    queueStatus: { queued: 0, running: 0, completed: 0 },
    error: '' as string,
    selectedAccountId: '' as string,
  }),
  getters: {
    totalPages: (s) => Math.ceil(s.worksTotal / s.worksPageSize) || 1,
    isCollecting: (s) => !!s.currentProgress && s.currentProgress.status === 'running',
  },
  actions: {
    async loadConfig() {
      try {
        this.config = await electronApi.analytics.getConfig();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },

    async updateConfig(updates: Partial<AnalyticsConfig>) {
      this.config = await electronApi.analytics.updateConfig(updates);
      return this.config;
    },

    async loadWorks(params: Partial<WorksQueryParams> = {}) {
      if (!params.accountId && !this.selectedAccountId) {
        return;
      }
      this.loading = true;
      this.error = '';
      try {
        const result: PagedResult<WorkItem & { metrics?: WorkMetrics }> = await electronApi.analytics.getWorks({
          accountId: params.accountId || this.selectedAccountId,
          page: params.page || this.worksPage,
          pageSize: params.pageSize || this.worksPageSize,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          contentType: params.contentType,
          startTime: params.startTime,
          endTime: params.endTime,
          keyword: params.keyword,
        });
        this.works = result.items;
        this.worksTotal = result.total;
        this.worksPage = result.page;
        this.worksPageSize = result.pageSize;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    async loadAccountStats(accountId: string, days?: number) {
      try {
        this.accountStats = await electronApi.analytics.getAccountStats(accountId, days);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },

    async startCollect(accountId: string, type: 'overview' | 'works' | 'all' = 'all') {
      const result = await electronApi.analytics.startCollect(accountId, type);
      this.activeTaskId = result.taskId;
      this.pollProgress(result.taskId);
      return result.taskId;
    },

    async pollProgress(taskId: string) {
      const poll = async () => {
        try {
          const progress = await electronApi.analytics.getTaskProgress(taskId);
          if (progress) {
            this.currentProgress = progress;
            if (progress.status === 'running' || progress.status === 'queued') {
              setTimeout(poll, 1000);
            } else {
              if (progress.status === 'completed') {
                this.loadWorks({ accountId: this.selectedAccountId });
              }
            }
          }
        } catch {
          this.currentProgress = null;
        }
      };
      poll();
    },

    async cancelCollect(taskId: string) {
      return await electronApi.analytics.cancelCollect(taskId);
    },

    async refreshQueueStatus() {
      try {
        this.queueStatus = await electronApi.analytics.getQueueStatus();
      } catch { /* ignore */ }
    },

    async loadBenchmarks(ownerAccountId?: string) {
      try {
        this.benchmarks = await electronApi.analytics.getBenchmarks(ownerAccountId);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },

    async addBenchmark(benchmark: Omit<BenchmarkAccount, 'id' | 'createdAt'>) {
      const result = await electronApi.analytics.addBenchmark(benchmark);
      this.benchmarks.push(result);
      return result;
    },

    async deleteBenchmark(id: string) {
      const ok = await electronApi.analytics.deleteBenchmark(id);
      if (ok) {
        this.benchmarks = this.benchmarks.filter(b => b.id !== id);
      }
      return ok;
    },

    setSelectedAccount(accountId: string) {
      this.selectedAccountId = accountId;
      this.worksPage = 1;
    },

    setPage(page: number) {
      this.worksPage = page;
      this.loadWorks();
    },

    async clearData(accountId: string) {
      await electronApi.analytics.clearData(accountId);
      this.works = [];
      this.worksTotal = 0;
      this.worksPage = 1;
    },
  },
});
