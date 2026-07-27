import { safeInvoke } from './index';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import type { WorksQueryParams, BenchmarkAccount, CollectProgress } from '../../types';
import { ipcMain, BrowserWindow } from 'electron';

function notifyProgress(progress: CollectProgress) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('analytics:progress', progress);
      } catch { /* ignore */ }
    }
  }
}

export function registerAnalyticsIpc(): void {
  safeInvoke('analytics:getConfig', () => AnalyticsService.getConfig());

  safeInvoke('analytics:updateConfig', (updates: any) => AnalyticsService.updateConfig(updates));

  safeInvoke('analytics:startCollect', (accountId: string, type: 'overview' | 'works' | 'all') => {
    const taskId = AnalyticsService.startCollect(accountId, type, (progress) => {
      notifyProgress(progress);
    });
    return { taskId };
  });

  safeInvoke('analytics:cancelCollect', (taskId: string) => {
    return AnalyticsService.cancelCollect(taskId);
  });

  safeInvoke('analytics:getTaskProgress', (taskId: string) => {
    return AnalyticsService.getTaskProgress(taskId);
  });

  safeInvoke('analytics:getQueueStatus', () => {
    return AnalyticsService.getQueueStatus();
  });

  safeInvoke('analytics:getWorks', (params: WorksQueryParams) => {
    return AnalyticsService.getWorks(params);
  });

  safeInvoke('analytics:getWorkMetrics', (workId: string) => {
    return AnalyticsService.getWorkMetrics(workId);
  });

  safeInvoke('analytics:getAccountStats', (accountId: string, days?: number) => {
    return AnalyticsService.getAccountStats(accountId, days);
  });

  safeInvoke('analytics:getBenchmarks', (ownerAccountId?: string) => {
    return AnalyticsService.getBenchmarks(ownerAccountId);
  });

  safeInvoke('analytics:addBenchmark', (benchmark: Omit<BenchmarkAccount, 'id' | 'createdAt'>) => {
    return AnalyticsService.addBenchmark(benchmark);
  });

  safeInvoke('analytics:updateBenchmark', (id: string, updates: Partial<BenchmarkAccount>) => {
    return AnalyticsService.updateBenchmark(id, updates);
  });

  safeInvoke('analytics:deleteBenchmark', (id: string) => {
    return AnalyticsService.deleteBenchmark(id);
  });

  safeInvoke('analytics:getLastCollectInfo', (accountId: string) => {
    return AnalyticsService.getLastCollectInfo(accountId);
  });
}
