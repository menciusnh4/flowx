import log from 'electron-log';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { PublishLogEntry, PublishLogQuery } from '../../types';

let initialized = false;

// 独立的 publish 日志文件 logger（不与主 logger 混用传输）
const publishLogger = log.create({ logId: 'publish' });

// 结构化日志环形缓冲（内存里保存最新的，便于渲染端查询并显示）
const MAX_MEMORY_LOGS = 2000;
const memoryLogs: PublishLogEntry[] = [];

// 日志保留天数
const LOG_RETENTION_DAYS = 14;

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** 获取当前日期字符串 YYYY-MM-DD */
function getDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 清理过期日志文件（保留最近 N 天） */
function cleanupOldLogs(logsDir: string, prefix: string, suffix: string, retentionDays: number) {
  try {
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir);
    const now = Date.now();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      // 从文件名中提取日期，例如 main-2026-07-09.log
      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const fileDate = new Date(dateMatch[1]).getTime();
      if (isNaN(fileDate)) continue;
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(logsDir, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // 清理失败不影响日志写入
  }
}

export function setupLogger() {
  if (initialized) return;
  initialized = true;

  const logsDir = getLogsDir();

  // 主进程日志 - 按天生成文件
  log.transports.file.level = 'info';
  log.transports.file.maxSize = 20 * 1024 * 1024; // 单文件最大 20MB
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.file.resolvePath = (variables: any) => {
    const dateStr = getDateStr();
    return path.join(logsDir, `main-${dateStr}.log`);
  };
  log.transports.console.level = 'debug';
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

  // 发布独立日志文件 - 按天生成文件
  publishLogger.transports.file.level = 'debug';
  publishLogger.transports.file.maxSize = 30 * 1024 * 1024; // 单文件最大 30MB
  publishLogger.transports.file.format =
    '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{processType}] {text}';
  publishLogger.transports.file.resolvePath = (variables: any) => {
    const dateStr = getDateStr();
    return path.join(logsDir, `publish-${dateStr}.log`);
  };
  publishLogger.transports.console.level = false as any; // 发布日志不打印到控制台（主 log 已打）

  // 启动时清理过期日志
  cleanupOldLogs(logsDir, 'main-', '.log', LOG_RETENTION_DAYS);
  cleanupOldLogs(logsDir, 'publish-', '.log', LOG_RETENTION_DAYS);

  // 捕获未处理异常
  process.on('uncaughtException', (err) => {
    log.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason);
  });
}

/** 主进程通用 logger */
export const logger = {
  debug: (...args: unknown[]) => log.debug(...args),
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => log.error(...args),
};

/** 获取日志目录 */
export function getLogsDir(): string {
  try {
    // electron-log 默认把日志写到 userData/logs 下
    const userData = app.getPath('userData');
    const candidate = path.join(userData, 'logs');
    if (!fs.existsSync(candidate)) {
      try { fs.mkdirSync(candidate, { recursive: true }); } catch { /* ignore */ }
    }
    return candidate;
  } catch {
    return app.getPath('userData');
  }
}

/** 获取 publish.log 文件完整路径（当天） */
export function getPublishLogPath(): string {
  const dateStr = getDateStr();
  return path.join(getLogsDir(), `publish-${dateStr}.log`);
}

/** 获取 main.log 文件完整路径（当天） */
export function getMainLogPath(): string {
  const dateStr = getDateStr();
  return path.join(getLogsDir(), `main-${dateStr}.log`);
}

/** 获取指定日期的日志文件路径 */
export function getLogPathByDate(type: 'main' | 'publish', date: Date): string {
  const dateStr = getDateStr(date);
  const prefix = type === 'main' ? 'main' : 'publish';
  return path.join(getLogsDir(), `${prefix}-${dateStr}.log`);
}

/** 列出所有日志文件（按日期倒序） */
export function listLogFiles(type: 'main' | 'publish'): { date: string; path: string; size: number }[] {
  try {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) return [];
    const prefix = type === 'main' ? 'main-' : 'publish-';
    const files = fs.readdirSync(logsDir);
    const result: { date: string; path: string; size: number }[] = [];
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith('.log')) continue;
      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const fullPath = path.join(logsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        result.push({ date: dateMatch[1], path: fullPath, size: stat.size });
      } catch {
        // ignore
      }
    }
    // 按日期倒序
    result.sort((a, b) => b.date.localeCompare(a.date));
    return result;
  } catch {
    return [];
  }
}

// --- 发布结构化日志 API（PublishEngine / PlatformAdapter 调用）---

function levelWeight(level: PublishLogEntry['level']): number {
  switch (level) {
    case 'debug': return 0;
    case 'info': return 1;
    case 'warn': return 2;
    case 'error': return 3;
  }
}

/** 写入一条发布结构化日志（同时写入内存环形缓冲 + publish.log 文件） */
export function writePublishLog(entry: PublishLogEntry) {
  // 写内存（FIFO 环形缓冲）
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.splice(0, memoryLogs.length - MAX_MEMORY_LOGS);
  }

  // 写文件（单行 JSON，便于未来 grep/解析）
  try {
    const tag = [
      entry.taskId ? `task=${entry.taskId}` : '',
      entry.accountId ? `acc=${entry.accountId}` : '',
      entry.platform ? `plat=${entry.platform}` : '',
      entry.stage ? `stage=${entry.stage}` : '',
    ].filter(Boolean).join(' ');

    const payload = entry.data ? ` | data=${JSON.stringify(entry.data)}` : '';
    const line = `${tag} ${entry.message}${payload}`.trim();

    switch (entry.level) {
      case 'error':
        publishLogger.error(line);
        logger.error(`[Publish] ${line}`);
        break;
      case 'warn':
        publishLogger.warn(line);
        logger.warn(`[Publish] ${line}`);
        break;
      case 'debug':
        publishLogger.debug(line);
        logger.debug(`[Publish] ${line}`);
        break;
      default:
        publishLogger.info(line);
        logger.info(`[Publish] ${line}`);
    }
  } catch (err) {
    // 日志出错不影响业务流程
    console.error('[publishLog] write failed:', err);
  }
}

/** 查询发布日志（渲染端通过 IPC 调用） */
export function queryPublishLogs(query: PublishLogQuery = {}): PublishLogEntry[] {
  const limit = Math.max(1, Math.min(2000, query.limit ?? 500));
  const minWeight = query.minLevel ? levelWeight(query.minLevel) : 0;
  const results: PublishLogEntry[] = [];

  // 倒序扫描；因为新日志 push 到尾部
  for (let i = memoryLogs.length - 1; i >= 0; i--) {
    const e = memoryLogs[i];
    if (levelWeight(e.level) < minWeight) continue;
    if (query.taskId && e.taskId !== query.taskId) continue;
    if (query.accountId && e.accountId !== query.accountId) continue;
    results.push(e);
    if (results.length >= limit) break;
  }

  return results; // 结果按时间倒序
}

/** 清空内存日志 */
export function clearPublishLogs(): void {
  memoryLogs.length = 0;
}
