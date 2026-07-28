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

type SortByField = 'publishTime' | 'views' | 'likes' | 'comments' | 'favorites' | 'completionRate' | 'interactionRate';

export const useAnalyticsStore = defineStore('analytics', {
  state: () => ({
    loading: false,
    config: null as AnalyticsConfig | null,
    works: [] as (WorkItem & { metrics?: WorkMetrics })[],
    worksTotal: 0,
    worksPage: 1,
    worksPageSize: 10,
    filterAccountIds: [] as string[],
    filterPlatformAccountIds: [] as string[],
    filterPlatform: '' as string,
    filterKeyword: '' as string,
    sortBy: 'publishTime' as SortByField,
    sortOrder: 'desc' as 'asc' | 'desc',
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
    latestAccountStats: (s) => {
      if (!s.accountStats || s.accountStats.length === 0) return null;
      return s.accountStats[s.accountStats.length - 1];
    },
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
      this.loading = true;
      this.error = '';
      try {
        const queryParams: Partial<WorksQueryParams> = {
          page: params.page || this.worksPage,
          pageSize: params.pageSize || this.worksPageSize,
          sortBy: (params.sortBy as SortByField | undefined) || this.sortBy,
          sortOrder: params.sortOrder || this.sortOrder,
        };

        if (params.accountId !== undefined) {
          queryParams.accountId = params.accountId;
        }
        if (params.accountIds !== undefined && params.accountIds.length > 0) {
          queryParams.accountIds = params.accountIds;
        } else if (this.filterAccountIds.length > 0) {
          queryParams.accountIds = this.filterAccountIds;
        }
        if (params.platformAccountIds !== undefined && params.platformAccountIds.length > 0) {
          queryParams.platformAccountIds = params.platformAccountIds;
        } else if (this.filterPlatformAccountIds.length > 0) {
          queryParams.platformAccountIds = this.filterPlatformAccountIds;
        }
        if (params.platform !== undefined && params.platform) {
          queryParams.platform = params.platform;
        } else if (this.filterPlatform) {
          queryParams.platform = this.filterPlatform;
        }
        if (params.keyword !== undefined && params.keyword) {
          queryParams.keyword = params.keyword;
        } else if (this.filterKeyword) {
          queryParams.keyword = this.filterKeyword;
        }
        if (params.contentType !== undefined) {
          queryParams.contentType = params.contentType;
        }
        if (params.startTime !== undefined) {
          queryParams.startTime = params.startTime;
        }
        if (params.endTime !== undefined) {
          queryParams.endTime = params.endTime;
        }

        const result: PagedResult<WorkItem & { metrics?: WorkMetrics }> = await electronApi.analytics.getWorks(queryParams as WorksQueryParams);
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
                this.loadWorks();
                if (this.selectedAccountId) {
                  this.loadAccountStats(this.selectedAccountId);
                }
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
