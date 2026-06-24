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

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export function setupLogger() {
  if (initialized) return;
  initialized = true;

  // 主进程日志
  log.transports.file.level = 'info';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.file.fileName = 'main.log';
  log.transports.console.level = 'debug';
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

  // 发布独立日志文件
  publishLogger.transports.file.level = 'debug';
  publishLogger.transports.file.maxSize = 20 * 1024 * 1024; // 20MB
  publishLogger.transports.file.fileName = 'publish.log';
  publishLogger.transports.file.format =
    '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{processType}] {text}';
  publishLogger.transports.console.level = false as any; // 发布日志不打印到控制台（主 log 已打）

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

/** 获取 publish.log 文件完整路径 */
export function getPublishLogPath(): string {
  return path.join(getLogsDir(), 'publish.log');
}

/** 获取 main.log 文件完整路径 */
export function getMainLogPath(): string {
  return path.join(getLogsDir(), 'main.log');
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
