import { getStore } from '../../store/SecureStore';
import { logger } from '../../utils/logger';
import type {
  WorkItem,
  WorkMetrics,
  AccountStatsSnapshot,
  WorkDiagnosis,
  BenchmarkAccount,
  BenchmarkSnapshot,
  AnalyticsConfig,
  WorksQueryParams,
  PagedResult,
  AccountAnalyticsPeriodData,
} from '../../../types';

const STORE_KEY = 'analyticsData';

interface AnalyticsStoreSchema {
  works: Record<string, WorkItem[]>;
  workMetrics: Record<string, WorkMetrics>;
  accountStats: Record<string, AccountStatsSnapshot[]>;
  accountAnalyticsData: Record<string, AccountAnalyticsPeriodData[]>;
  diagnoses: Record<string, WorkDiagnosis>;
  benchmarks: BenchmarkAccount[];
  benchmarkSnapshots: Record<string, BenchmarkSnapshot[]>;
  config: AnalyticsConfig;
  lastCollectInfo: Record<string, {
    lastCollectTime: number;
    lastWorkId?: string;
    lastWorkPublishTime?: number;
  }>;
}

const defaultConfig: AnalyticsConfig = {
  autoCollectEnabled: false,
  autoCollectIntervalHours: 6,
  maxConcurrentCollects: 2,
  collectWindowIdleCloseMinutes: 5,
  workCollectLimit: 50,
};

function getDefaultSchema(): AnalyticsStoreSchema {
  return {
    works: {},
    workMetrics: {},
    accountStats: {},
    accountAnalyticsData: {},
    diagnoses: {},
    benchmarks: [],
    benchmarkSnapshots: {},
    config: defaultConfig,
    lastCollectInfo: {},
  };
}

function ensureInit(): AnalyticsStoreSchema {
  const store = getStore();
  const anyStore = store as any;
  let data = anyStore.get(STORE_KEY) as AnalyticsStoreSchema | undefined;

  if (!data) {
    data = getDefaultSchema();
    anyStore.set(STORE_KEY, data);
  }

  if (!data.config) {
    data.config = { ...defaultConfig };
  } else {
    data.config = { ...defaultConfig, ...data.config };
  }
  if (!data.works) data.works = {};
  if (!data.workMetrics) data.workMetrics = {};
  if (!data.accountStats) data.accountStats = {};
  if (!data.accountAnalyticsData) data.accountAnalyticsData = {};
  if (!data.diagnoses) data.diagnoses = {};
  if (!data.benchmarks) data.benchmarks = [];
  if (!data.benchmarkSnapshots) data.benchmarkSnapshots = {};
  if (!data.lastCollectInfo) data.lastCollectInfo = {};

  return data;
}

function saveData(data: AnalyticsStoreSchema): void {
  const store = getStore();
  const anyStore = store as any;
  anyStore.set(STORE_KEY, data);
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ==================== 配置相关 ====================

export function getConfig(): AnalyticsConfig {
  const data = ensureInit();
  return { ...defaultConfig, ...data.config };
}

export function updateConfig(updates: Partial<AnalyticsConfig>): AnalyticsConfig {
  const data = ensureInit();
  data.config = { ...data.config, ...updates };
  saveData(data);
  return data.config;
}

// ==================== 作品相关 ====================

export function getWorks(accountId: string): WorkItem[] {
  const data = ensureInit();
  return data.works[accountId] || [];
}

export function getPagedWorks(params: WorksQueryParams): PagedResult<WorkItem & { metrics?: WorkMetrics }> {
  const {
    accountId,
    accountIds,
    platformAccountIds,
    platform,
    page = 1,
    pageSize = 20,
    sortBy = 'publishTime',
    sortOrder = 'desc',
    contentType,
    startTime,
    endTime,
    keyword,
  } = params;

  const data = ensureInit();

  let allWorks: WorkItem[] = [];

  if (accountId) {
    allWorks = [...(data.works[accountId] || [])];
  } else if (accountIds && accountIds.length > 0) {
    for (const aid of accountIds) {
      allWorks = allWorks.concat(data.works[aid] || []);
    }
  } else {
    for (const aid of Object.keys(data.works)) {
      allWorks = allWorks.concat(data.works[aid] || []);
    }
  }

  let works = allWorks;

  if (platformAccountIds && platformAccountIds.length > 0) {
    const idSet = new Set(platformAccountIds.map(String));
    works = works.filter(w => w.platformAccountId && idSet.has(String(w.platformAccountId)));
  }

  if (platform) {
    works = works.filter(w => w.platform === platform);
  }
  if (contentType) {
    works = works.filter(w => w.contentType === contentType);
  }
  if (startTime) {
    works = works.filter(w => w.publishTime >= startTime);
  }
  if (endTime) {
    works = works.filter(w => w.publishTime <= endTime);
  }
  if (keyword) {
    const kw = keyword.toLowerCase();
    works = works.filter(w => w.title.toLowerCase().includes(kw));
  }

  if (sortBy === 'publishTime') {
    works.sort((a, b) => sortOrder === 'desc'
      ? b.publishTime - a.publishTime
      : a.publishTime - b.publishTime
    );
  } else {
    works.sort((a, b) => {
      const ma = data.workMetrics[a.id];
      const mb = data.workMetrics[b.id];
      const va = ma ? (ma[sortBy as keyof WorkMetrics] as number) || 0 : 0;
      const vb = mb ? (mb[sortBy as keyof WorkMetrics] as number) || 0 : 0;
      return sortOrder === 'desc' ? vb - va : va - vb;
    });
  }

  const total = works.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const items = works.slice(start, start + pageSize).map(w => ({
    ...w,
    metrics: data.workMetrics[w.id],
  }));

  return { items, total, page, pageSize, totalPages };
}

export function saveWork(accountId: string, work: WorkItem, metrics?: Omit<WorkMetrics, 'id' | 'collectedAt'>): void {
  const data = ensureInit();

  if (!data.works[accountId]) {
    data.works[accountId] = [];
  }

  const existingIdx = data.works[accountId].findIndex(w => w.id === work.id);
  if (existingIdx >= 0) {
    data.works[accountId][existingIdx] = {
      ...data.works[accountId][existingIdx],
      ...work,
      lastUpdatedAt: Date.now(),
    };
  } else {
    data.works[accountId].push(work);
  }

  if (metrics) {
    const metricsId = generateId();
    data.workMetrics[work.id] = {
      id: metricsId,
      collectedAt: Date.now(),
      ...metrics,
    };
  }

  saveData(data);
  logger.debug('[AnalyticsStore] 保存作品数据:', work.title, '账号:', accountId);
}

export function saveWorksBatch(
  accountId: string,
  works: Array<{ work: WorkItem; metrics?: Omit<WorkMetrics, 'id' | 'collectedAt'> }>,
): number {
  const data = ensureInit();

  if (!data.works[accountId]) {
    data.works[accountId] = [];
  }

  let savedCount = 0;
  for (const { work, metrics } of works) {
    const existingIdx = data.works[accountId].findIndex(w => w.id === work.id);
    if (existingIdx >= 0) {
      data.works[accountId][existingIdx] = {
        ...data.works[accountId][existingIdx],
        ...work,
        lastUpdatedAt: Date.now(),
      };
    } else {
      data.works[accountId].push(work);
    }

    if (metrics) {
      const metricsId = generateId();
      data.workMetrics[work.id] = {
        id: metricsId,
        collectedAt: Date.now(),
        ...metrics,
      };
    }
    savedCount++;
  }

  saveData(data);
  logger.info('[AnalyticsStore] 批量保存作品:', savedCount, '条，账号:', accountId);
  return savedCount;
}

export function getWorkMetrics(workId: string): WorkMetrics | undefined {
  const data = ensureInit();
  return data.workMetrics[workId];
}

export function clearAccountData(accountId: string): void {
  const data = ensureInit();
  
  if (data.works[accountId]) {
    const workIds = data.works[accountId].map(w => w.id);
    for (const wid of workIds) {
      delete data.workMetrics[wid];
    }
    delete data.works[accountId];
  }
  
  delete data.accountStats[accountId];
  delete data.accountAnalyticsData[accountId];
  delete data.diagnoses[accountId];
  delete data.lastCollectInfo[accountId];
  
  saveData(data);
  logger.info('[AnalyticsStore] 清空账号数据:', accountId);
}

// ==================== 账号统计快照相关 ====================

export function getAccountStats(accountId: string, days?: number): AccountStatsSnapshot[] {
  const data = ensureInit();
  let stats = data.accountStats[accountId] || [];
  if (days && days > 0) {
    stats = stats.slice(-days);
  }
  return [...stats];
}

export function getLatestAccountStats(accountId: string): AccountStatsSnapshot | null {
  const data = ensureInit();
  const stats = data.accountStats[accountId] || [];
  if (stats.length === 0) return null;
  return stats[stats.length - 1];
}

export function getWorksCount(accountId: string): number {
  const data = ensureInit();
  return data.works[accountId]?.length || 0;
}

export function saveAccountStats(snapshot: AccountStatsSnapshot): void {
  const data = ensureInit();
  const accountId = snapshot.accountId;

  if (!data.accountStats[accountId]) {
    data.accountStats[accountId] = [];
  }

  const existingIdx = data.accountStats[accountId].findIndex(s => s.date === snapshot.date);
  if (existingIdx >= 0) {
    data.accountStats[accountId][existingIdx] = snapshot;
  } else {
    data.accountStats[accountId].push(snapshot);
    data.accountStats[accountId].sort((a, b) => a.date.localeCompare(b.date));
  }

  if (data.accountStats[accountId].length > 365) {
    data.accountStats[accountId] = data.accountStats[accountId].slice(-365);
  }

  saveData(data);
}

// ==================== 账号周期数据概况相关 ====================

export function saveAccountAnalytics(list: AccountAnalyticsPeriodData[]): number {
  const data = ensureInit();
  let savedCount = 0;

  for (const item of list) {
    const accountId = item.accountId;
    if (!data.accountAnalyticsData[accountId]) {
      data.accountAnalyticsData[accountId] = [];
    }

    const existingIdx = data.accountAnalyticsData[accountId].findIndex(
      s => s.accountId === item.accountId && s.period === item.period && s.startDate === item.startDate
    );

    if (existingIdx >= 0) {
      const existing = data.accountAnalyticsData[accountId][existingIdx];
      if (item.collectedAt >= existing.collectedAt) {
        data.accountAnalyticsData[accountId][existingIdx] = item;
      }
    } else {
      data.accountAnalyticsData[accountId].push(item);
    }
    savedCount++;
  }

  for (const accountId of Object.keys(data.accountAnalyticsData)) {
    data.accountAnalyticsData[accountId].sort((a, b) => a.collectedAt - b.collectedAt);
    if (data.accountAnalyticsData[accountId].length > 120) {
      data.accountAnalyticsData[accountId] = data.accountAnalyticsData[accountId].slice(-120);
    }
  }

  saveData(data);
  logger.info('[AnalyticsStore] 保存账号周期数据:', savedCount, '条');
  return savedCount;
}

export function getAccountAnalytics(accountId: string, limit?: number): AccountAnalyticsPeriodData[] {
  const data = ensureInit();
  const list = data.accountAnalyticsData[accountId] || [];
  if (limit && limit > 0) {
    return list.slice(-limit);
  }
  return [...list];
}

export function getLatestAccountAnalytics(
  accountId: string,
  period?: 'yesterday' | '7d' | '30d'
): AccountAnalyticsPeriodData | null {
  const data = ensureInit();
  let list = data.accountAnalyticsData[accountId] || [];
  if (period) {
    list = list.filter(s => s.period === period);
  }
  if (list.length === 0) return null;
  let latest = list[0];
  for (const item of list) {
    if (item.collectedAt > latest.collectedAt) {
      latest = item;
    }
  }
  return latest;
}

// ==================== 诊断结果相关 ====================

export function getDiagnosis(workId: string): WorkDiagnosis | undefined {
  const data = ensureInit();
  return data.diagnoses[workId];
}

export function saveDiagnosis(diagnosis: WorkDiagnosis): void {
  const data = ensureInit();
  data.diagnoses[diagnosis.workId] = diagnosis;
  saveData(data);
  logger.debug('[AnalyticsStore] 保存诊断结果: workId=', diagnosis.workId, 'score=', diagnosis.overallScore);
}

// ==================== 对标账号相关 ====================

export function getBenchmarks(ownerAccountId?: string): BenchmarkAccount[] {
  const data = ensureInit();
  let items = data.benchmarks;
  if (ownerAccountId) {
    items = items.filter(b => b.ownerAccountId === ownerAccountId);
  }
  return [...items];
}

export function addBenchmark(benchmark: Omit<BenchmarkAccount, 'id' | 'createdAt'>): BenchmarkAccount {
  const data = ensureInit();
  const newBenchmark: BenchmarkAccount = {
    ...benchmark,
    id: `bm_${generateId()}`,
    createdAt: Date.now(),
  };
  data.benchmarks.push(newBenchmark);
  saveData(data);
  logger.info('[AnalyticsStore] 添加对标账号:', newBenchmark.name);
  return newBenchmark;
}

export function updateBenchmark(id: string, updates: Partial<BenchmarkAccount>): BenchmarkAccount | null {
  const data = ensureInit();
  const idx = data.benchmarks.findIndex(b => b.id === id);
  if (idx < 0) return null;
  data.benchmarks[idx] = { ...data.benchmarks[idx], ...updates };
  saveData(data);
  return data.benchmarks[idx];
}

export function deleteBenchmark(id: string): boolean {
  const data = ensureInit();
  const beforeLen = data.benchmarks.length;
  data.benchmarks = data.benchmarks.filter(b => b.id !== id);
  delete data.benchmarkSnapshots[id];
  saveData(data);
  return data.benchmarks.length < beforeLen;
}

export function getBenchmarkSnapshots(benchmarkId: string): BenchmarkSnapshot[] {
  const data = ensureInit();
  return data.benchmarkSnapshots[benchmarkId] || [];
}

export function saveBenchmarkSnapshot(snapshot: Omit<BenchmarkSnapshot, 'id'>): BenchmarkSnapshot {
  const data = ensureInit();
  const newSnapshot: BenchmarkSnapshot = {
    ...snapshot,
    id: `bms_${generateId()}`,
  };
  if (!data.benchmarkSnapshots[snapshot.benchmarkId]) {
    data.benchmarkSnapshots[snapshot.benchmarkId] = [];
  }
  data.benchmarkSnapshots[snapshot.benchmarkId].push(newSnapshot);
  if (data.benchmarkSnapshots[snapshot.benchmarkId].length > 100) {
    data.benchmarkSnapshots[snapshot.benchmarkId] = data.benchmarkSnapshots[snapshot.benchmarkId].slice(-100);
  }
  saveData(data);
  return newSnapshot;
}

// ==================== 采集信息相关 ====================

export function getLastCollectInfo(accountId: string): {
  lastCollectTime: number;
  lastWorkId?: string;
  lastWorkPublishTime?: number;
} | null {
  const data = ensureInit();
  return data.lastCollectInfo[accountId] || null;
}

export function updateLastCollectInfo(
  accountId: string,
  info: { lastWorkId?: string; lastWorkPublishTime?: number },
): void {
  const data = ensureInit();
  const existing = data.lastCollectInfo[accountId] || { lastCollectTime: 0 };
  data.lastCollectInfo[accountId] = {
    ...existing,
    lastCollectTime: Date.now(),
    ...info,
  };
  saveData(data);
}
