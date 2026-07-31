import { logger } from '../../utils/logger';
import { BaseCollector } from './BaseCollector';
import { DouyinCollector } from './platforms/DouyinCollector';
import { XiaohongshuCollector } from './platforms/XiaohongshuCollector';
import { KuaishouCollector } from './platforms/KuaishouCollector';
import { WechatChannelsCollector } from './platforms/WechatChannelsCollector';
import { ZhihuCollector } from './platforms/ZhihuCollector';
import { CollectTaskQueue } from './CollectTaskQueue';
import * as AnalyticsStore from './AnalyticsStore';
import { AccountService } from '../AccountService';
import type {
  CollectTask,
  CollectTaskResult,
  CollectProgress,
  WorksQueryParams,
  PagedResult,
  WorkItem,
  WorkMetrics,
  AccountStatsSnapshot,
  BenchmarkAccount,
  AnalyticsConfig,
  PlatformType,
  AccountCredential,
  AccountAnalyticsPeriodData,
} from '../../../types';

type ProgressCallback = (p: CollectProgress) => void;

class AnalyticsServiceImpl {
  private taskQueue: CollectTaskQueue | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const config = AnalyticsStore.getConfig();
    this.taskQueue = new CollectTaskQueue(config.maxConcurrentCollects);
    logger.info('[AnalyticsService] 初始化完成');
  }

  private ensureInit(): void {
    if (!this.initialized) {
      this.init();
    }
  }

  getConfig(): AnalyticsConfig {
    return AnalyticsStore.getConfig();
  }

  updateConfig(updates: Partial<AnalyticsConfig>): AnalyticsConfig {
    this.ensureInit();
    const config = AnalyticsStore.updateConfig(updates);
    if (updates.maxConcurrentCollects !== undefined && this.taskQueue) {
      this.taskQueue.setMaxConcurrency(updates.maxConcurrentCollects);
    }
    return config;
  }

  private createCollector(platform: PlatformType, account: AccountCredential): BaseCollector {
    switch (platform) {
      case 'douyin':
        return new DouyinCollector(account);
      case 'xiaohongshu':
        return new XiaohongshuCollector(account);
      case 'kuaishou':
        return new KuaishouCollector(account);
      case 'wechat_channels':
        return new WechatChannelsCollector(account);
      case 'zhihu':
        return new ZhihuCollector(account);
      default:
        throw new Error(`暂不支持平台: ${platform}`);
    }
  }

  startCollect(
    accountId: string,
    type: 'overview' | 'works' | 'all' = 'all',
    onProgress?: (p: CollectProgress) => void,
  ): string {
    this.ensureInit();
    const account = AccountService.getCredential(accountId);
    if (!account) {
      throw new Error(`账号不存在: ${accountId}`);
    }

    // 入队前同步 dry-run 一次创建采集器。
    // 目的：未接入的平台在「点击采集」时就能同步抛出错误，
    // 让前端在调用 startCollect 的 try/catch 中立刻拿到明确提示，
    // 而不是先弹"采集任务已启动"成功消息，等异步 task 执行失败后只在进度条里留下红色失败状态。
    try {
      this.createCollector(account.platform, account);
    } catch (e) {
      logger.info(`[AnalyticsService] 平台 ${account.platform} 未接入数据分析采集，已拒绝入队: ${
        e instanceof Error ? e.message : String(e)
      }`);
      throw e;
    }

    const taskId = `collect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task: CollectTask = {
      id: taskId,
      accountId,
      platform: account.platform,
      type,
      status: 'queued',
      createdAt: Date.now(),
    };

    const handler = async (t: CollectTask, updateProgress: (p: Partial<CollectProgress>) => void): Promise<CollectTaskResult> => {
      const log = (msg: string, data?: Record<string, unknown>) => {
        logger.info(`[AnalyticsService][${account.platform}/${accountId}] ${msg}`, data || '');
      };

      updateProgress({
        status: 'running',
        currentStage: 'initializing',
        message: '初始化采集窗口...',
        progress: 5,
      });

      let collector: BaseCollector | null = null;
      try {
        collector = this.createCollector(account.platform, account);
        await collector.initWindow({ headless: true });

        let worksCollected = 0;
        let overview: any = null;

        if (type === 'overview' || type === 'all') {
          updateProgress({
            currentStage: 'collecting-overview',
            message: '采集账号概览数据...',
            progress: 20,
          });

          overview = await collector.collectAccountOverview();
          log('概览数据采集完成', overview);

          const today = new Date().toISOString().slice(0, 10);
          const snapshot: AccountStatsSnapshot = {
            id: `stats_${Date.now()}`,
            accountId,
            date: today,
            fansCount: overview.followers,
            followCount: overview.following,
            totalLikeCount: overview.likes,
            worksCount: overview.worksCount,
            collectedAt: Date.now(),
          };
          AnalyticsStore.saveAccountStats(snapshot);
        }

        if (type === 'works' || type === 'all') {
          updateProgress({
            currentStage: 'collecting-works',
            message: '采集作品列表...',
            progress: 40,
          });

          const config = AnalyticsStore.getConfig();
          const lastInfo = AnalyticsStore.getLastCollectInfo(accountId);
          const incremental = lastInfo && (lastInfo.lastWorkId || lastInfo.lastWorkPublishTime)
            ? { lastWorkId: lastInfo.lastWorkId, lastWorkPublishTime: lastInfo.lastWorkPublishTime }
            : undefined;
          
          if (incremental) {
            log('增量采集模式', { lastWorkId: incremental.lastWorkId, lastWorkPublishTime: incremental.lastWorkPublishTime });
          }

          const works = await collector.collectWorksList(config.workCollectLimit, incremental);

          const workItems = works.map((w, idx) => {
            const progress = 40 + Math.round((idx + 1) / works.length * 40);
            updateProgress({
              message: `已采集 ${idx + 1}/${works.length} 条作品`,
              collectedCount: idx + 1,
              totalCount: works.length,
              progress,
            });

            const workItem: WorkItem = {
              id: w.workId,
              platform: account.platform,
              accountId,
              platformAccountId: account.platformAccountId,
              title: w.title,
              coverUrl: w.coverUrl,
              contentType: w.contentType,
              publishTime: w.publishTime || Date.now(),
              detailUrl: w.detailUrl,
              duration: w.duration,
              firstCollectedAt: Date.now(),
              lastUpdatedAt: Date.now(),
            };

            const metrics: Omit<WorkMetrics, 'id' | 'collectedAt'> = {
              workId: w.workId,
              accountId,
              platformAccountId: account.platformAccountId,
              platform: account.platform,
              views: w.views || 0,
              likes: w.likes || 0,
              comments: w.comments || 0,
              favorites: w.favorites || 0,
              shares: w.shares || 0,
              impressions: (w as any).impressions || 0,
              clickRate: (w as any).clickRate || 0,
              newFans: (w as any).newFans || 0,
              avgPlayDuration: (w as any).avgPlayDuration || 0,
              completionRate: (w as any).completionRate || 0,
            };

            return { work: workItem, metrics };
          });

          worksCollected = AnalyticsStore.saveWorksBatch(accountId, workItems);

          if (works.length > 0) {
            AnalyticsStore.updateLastCollectInfo(accountId, {
              lastWorkId: works[0].workId,
              lastWorkPublishTime: works[0].publishTime,
            });
          }

          const totalWorksCount = AnalyticsStore.getWorksCount(accountId);
          const today = new Date().toISOString().slice(0, 10);
          const latestStats = AnalyticsStore.getLatestAccountStats(accountId);
          if (latestStats) {
            latestStats.worksCount = totalWorksCount;
            AnalyticsStore.saveAccountStats(latestStats);
          } else {
            AnalyticsStore.saveAccountStats({
              id: `stats_${Date.now()}`,
              accountId,
              date: today,
              fansCount: 0,
              worksCount: totalWorksCount,
              collectedAt: Date.now(),
            });
          }

          log('作品列表采集完成', { count: worksCollected, totalWorksCount });
        }

        if (type === 'all') {
          updateProgress({
            currentStage: 'collecting-period-analytics',
            message: '采集账号周期数据概况（近7天/30天）...',
            progress: 85,
          });
          try {
            const periodDataList = await collector.collectAccountAnalytics();
            if (periodDataList && periodDataList.length > 0) {
              const normalized: AccountAnalyticsPeriodData[] = periodDataList.map(p => ({
                ...p,
                id: p.id || `${accountId}_${p.period || '7d'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                accountId: p.accountId || accountId,
                platform: p.platform || account.platform,
              }));
              const saved = AnalyticsStore.saveAccountAnalytics(normalized);
              log(`周期数据概况采集完成，保存 ${saved} 条`);
            } else {
              log('周期数据概况：该平台暂未实现或无数据');
            }
          } catch (e) {
            log('周期数据概况采集失败', { error: e instanceof Error ? e.message : String(e) });
          }
        }

        updateProgress({
          status: 'completed',
          currentStage: 'done',
          message: '采集完成',
          progress: 100,
        });

        return {
          taskId,
          success: true,
          collectedCount: worksCollected,
          overview,
          collectedAt: Date.now(),
        };
      } catch (err) {
        log('采集失败', { error: err instanceof Error ? err.message : String(err) });
        updateProgress({
          status: 'failed',
          currentStage: 'error',
          message: err instanceof Error ? err.message : String(err),
          progress: 100,
        });
        throw err;
      } finally {
        if (collector) {
          collector.destroy();
        }
      }
    };

    this.taskQueue!.addTask(task, handler, onProgress);

    logger.info(`[AnalyticsService] 启动采集任务: ${taskId} (${accountId}/${type})`);
    return taskId;
  }

  cancelCollect(taskId: string): boolean {
    this.ensureInit();
    return this.taskQueue!.cancelTask(taskId);
  }

  getTaskProgress(taskId: string): CollectProgress | null {
    this.ensureInit();
    return this.taskQueue!.getTaskProgress(taskId);
  }

  getQueueStatus() {
    this.ensureInit();
    return this.taskQueue!.getStatus();
  }

  getWorks(params: WorksQueryParams): PagedResult<WorkItem & { metrics?: WorkMetrics }> {
    return AnalyticsStore.getPagedWorks(params);
  }

  getWorkMetrics(workId: string): WorkMetrics | undefined {
    return AnalyticsStore.getWorkMetrics(workId);
  }

  getAccountStats(accountId: string, days?: number): AccountStatsSnapshot[] {
    return AnalyticsStore.getAccountStats(accountId, days);
  }

  saveAccountAnalytics(list: AccountAnalyticsPeriodData[]): number {
    return AnalyticsStore.saveAccountAnalytics(list);
  }

  getAccountAnalytics(accountId: string, limit?: number): AccountAnalyticsPeriodData[] {
    return AnalyticsStore.getAccountAnalytics(accountId, limit);
  }

  getLatestAccountAnalytics(
    accountId: string,
    period?: 'yesterday' | '7d' | '30d'
  ): AccountAnalyticsPeriodData | null {
    return AnalyticsStore.getLatestAccountAnalytics(accountId, period);
  }

  getBenchmarks(ownerAccountId?: string): BenchmarkAccount[] {
    return AnalyticsStore.getBenchmarks(ownerAccountId);
  }

  addBenchmark(benchmark: Omit<BenchmarkAccount, 'id' | 'createdAt'>): BenchmarkAccount {
    return AnalyticsStore.addBenchmark(benchmark);
  }

  updateBenchmark(id: string, updates: Partial<BenchmarkAccount>): BenchmarkAccount | null {
    return AnalyticsStore.updateBenchmark(id, updates);
  }

  deleteBenchmark(id: string): boolean {
    return AnalyticsStore.deleteBenchmark(id);
  }

  getLastCollectInfo(accountId: string) {
    return AnalyticsStore.getLastCollectInfo(accountId);
  }

  clearAccountData(accountId: string): void {
    AnalyticsStore.clearAccountData(accountId);
  }
}

export const AnalyticsService = new AnalyticsServiceImpl();
