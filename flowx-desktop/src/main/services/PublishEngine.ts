import { app, shell } from 'electron';
import { getStore } from '../store/SecureStore';
import { logger, writePublishLog, getPublishLogPath, getMainLogPath, queryPublishLogs, clearPublishLogs } from '../utils/logger';
import { AccountService, injectAccountCookies } from './AccountService';
import { getAdapter } from './PlatformAdapter';
import type {
  PublishItemProgress,
  PublishRequest,
  PublishStatus,
  PublishTask,
  ProgressInfo,
  PlatformType,
  PublishLogEntry,
  PublishLogQuery,
} from '../../types';

const TASKS_KEY = 'publishTasks';

// ============================================================
// 发布引擎：负责：
// - 接收渲染层提交的发布任务
// - 生成任务 ID，持久化到本地存储
// - 按账号拆分子任务（per-account）
// - 通过 TaskQueue 串行/并行执行（默认并行度可配）
// - 通过 IPC 主动推送进度（publish:statusChanged）
// - 每一步都记录结构化日志（publish.log + 内存缓冲）
// ============================================================

function getBrowserWindow() {
  // 延迟导入避免循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('electron');
  return mod.BrowserWindow;
}

class PublishEngineClass {
  private ready = false;
  private running = new Map<string, PublishTask>();
  private concurrency = 3;
  private queue: Array<{ taskId: string; accountId: string }> = [];
  private activeCount = 0;
  // 记录每个 taskId 累计通知次数（调试用）
  private notifyCounters = new Map<string, number>();

  init() {
    if (this.ready) return;
    this.ready = true;
    const settings = getStore().get('settings') as { autoPublishConcurrency?: number } | undefined;
    this.concurrency = settings?.autoPublishConcurrency ?? 3;

    const tasks = getStore().get(TASKS_KEY) as PublishTask[] | undefined;
    if (tasks) {
      for (const t of tasks) {
        if (t.status === 'queued' || t.status === 'running') t.status = 'failed';
        for (const item of t.items) {
          if (item.status === 'queued' || item.status === 'running') item.status = 'failed';
        }
        this.running.set(t.id, t);
      }
      getStore().set(TASKS_KEY, tasks);
    }
    logger.info('[PublishEngine] 初始化完成，并发数:', this.concurrency);
    writePublishLog({
      ts: Date.now(),
      level: 'info',
      stage: 'init',
      message: `引擎初始化完成，并发数=${this.concurrency}`,
      data: { concurrency: this.concurrency },
    });
  }

  setConcurrency(n: number) {
    this.concurrency = Math.max(1, Math.min(20, n | 0));
    logger.info('[PublishEngine] 并发数设置为:', this.concurrency);
  }

  // ----------- 对外 API -----------

  /** 提交发布任务 */
  submit(request: PublishRequest): string {
    const taskId = 'task_' + Math.random().toString(36).slice(2, 10);

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      stage: 'submit',
      message: `收到发布任务，目标账号=${request.accountIds.length}个，标题=${request.title}`,
      data: {
        contentType: request.contentType,
        accountIds: request.accountIds,
        title: request.title,
        mediaCount: request.mediaFiles.length,
        tags: request.tags,
        scheduledAt: request.scheduledAt,
      },
    });

    // 为每个账号构造子任务条目，并查出平台
    const items: PublishItemProgress[] = request.accountIds.map((accountId) => {
      const cred = AccountService.getCredential(accountId);
      const platform: PlatformType = cred?.platform || 'douyin';
      writePublishLog({
        ts: Date.now(),
        level: 'debug',
        taskId,
        accountId,
        platform,
        stage: 'submit',
        message: `子任务已登记`,
        data: { platform, credentialFound: !!cred },
      });
      return {
        accountId,
        platform,
        status: 'queued',
        progress: 0,
        startedAt: undefined,
        finishedAt: undefined,
      } as PublishItemProgress;
    });

    const task: PublishTask = {
      id: taskId,
      request,
      items,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.running.set(taskId, task);
    this.notifyCounters.set(taskId, 0);
    this.persist();

    // ✅ 关键改进：提交成功后立即向渲染层推送一条初始事件（queued 状态），
    //    保证渲染层能立即看到这个任务，而不依赖 onProgress 的第一次触发
    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      stage: 'submit',
      message: `已登记，立即推送初始状态到渲染层`,
      data: { status: 'queued', itemCount: items.length },
    });
    this.notifyStatus(task, /*verbose*/ true);

    // 定时发布
    if (request.scheduledAt && request.scheduledAt > Date.now()) {
      task.status = 'scheduled';
      for (const item of task.items) item.status = 'scheduled';
      this.persist();
      const delay = request.scheduledAt - Date.now();
      logger.info('[Publish] 定时任务', taskId, '将在', Math.round(delay / 1000), '秒后执行');
      writePublishLog({
        ts: Date.now(),
        level: 'info',
        taskId,
        stage: 'schedule',
        message: `定时任务，将在 ${Math.round(delay / 1000)}s 后执行`,
        data: { scheduledAt: request.scheduledAt },
      });
      setTimeout(() => this.runTask(taskId), delay);
      return taskId;
    }

    // 立即执行
    this.runTask(taskId);
    return taskId;
  }

  /** 查询任务进度 */
  getProgress(taskId: string): ProgressInfo | null {
    const task = this.running.get(taskId);
    if (!task) return null;
    const overall = task.items.length === 0
      ? 0
      : Math.round(task.items.reduce((s, x) => s + x.progress, 0) / task.items.length);
    return {
      taskId,
      status: task.status,
      items: task.items,
      overallProgress: overall,
    };
  }

  /** 列出所有任务（历史） */
  listTasks(): PublishTask[] {
    return Array.from(this.running.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 取消任务 */
  cancel(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (!task) return false;
    this.queue = this.queue.filter((x) => x.taskId !== taskId);
    for (const item of task.items) {
      if (item.status === 'queued' || item.status === 'running') item.status = 'cancelled';
    }
    this.aggregateTaskStatus(task);
    this.persist();
    this.notifyStatus(task);
    writePublishLog({
      ts: Date.now(),
      level: 'warn',
      taskId,
      stage: 'cancel',
      message: '任务被用户取消',
    });
    return true;
  }

  /** 获取发布日志文件路径 & 打开 */
  getLogPaths() {
    return {
      publishLog: getPublishLogPath(),
      mainLog: getMainLogPath(),
      dir: (() => {
        try { return app.getPath('userData'); } catch { return ''; }
      })(),
    };
  }

  /** 打开日志所在目录 */
  async openLogDir(): Promise<boolean> {
    try {
      const dir = app.getPath('userData');
      await shell.openPath(dir);
      return true;
    } catch {
      return false;
    }
  }

  /** 查询结构化发布日志 */
  queryLogs(query?: PublishLogQuery): PublishLogEntry[] {
    return queryPublishLogs(query || {});
  }

  /** 清空内存日志 */
  clearLogs(): boolean {
    clearPublishLogs();
    return true;
  }

  // ----------- 内部调度 -----------

  private runTask(taskId: string) {
    const task = this.running.get(taskId);
    if (!task) {
      logger.warn('[PublishEngine] runTask: 找不到任务', taskId);
      return;
    }

    task.status = 'running';
    task.updatedAt = Date.now();
    this.persist();
    this.notifyStatus(task);

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      stage: 'start',
      message: `任务开始执行，子任务数=${task.items.length}`,
      data: { itemCount: task.items.length },
    });

    // 把每个账号丢入任务队列（按并发执行）
    for (const item of task.items) {
      this.queue.push({ taskId, accountId: item.accountId });
    }
    this.drain();
  }

  private drain() {
    while (this.activeCount >= this.concurrency) return;
    const next = this.queue.shift();
    if (!next) return;
    this.activeCount++;
    logger.info('[Publish] 并发:', this.activeCount, '/', this.concurrency, '队列剩余:', this.queue.length);
    this.runItem(next.taskId, next.accountId).finally(() => {
      this.activeCount--;
      setImmediate(() => this.drain());
    });
  }

  private async runItem(taskId: string, accountId: string) {
    const task = this.running.get(taskId);
    if (!task) return;
    const item = task.items.find((x) => x.accountId === accountId);
    if (!item) return;

    // 账号有效性检查
    const info = AccountService.getAccount(accountId);
    if (!info) {
      item.status = 'failed';
      item.progress = 100;
      item.message = '账号不存在';
      this.persist();
      this.notifyStatus(task);
      writePublishLog({
        ts: Date.now(), level: 'error', taskId, accountId,
        platform: item.platform, stage: 'validate', message: '账号不存在或凭证丢失',
      });
      return;
    }
    if (info.status === 'expired') {
      item.status = 'failed';
      item.progress = 100;
      item.message = '账号已过期，请重新授权';
      this.persist();
      this.notifyStatus(task);
      writePublishLog({
        ts: Date.now(), level: 'error', taskId, accountId,
        platform: item.platform, stage: 'validate', message: '账号已过期',
      });
      return;
    }

    item.status = 'running';
    item.progress = 5;
    item.startedAt = Date.now();
    this.persist();
    this.notifyStatus(task);

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      accountId,
      platform: item.platform,
      stage: 'cookie',
      message: '准备注入 cookies 到账号 partition',
    });

    try {
      // 注入 cookies 到该账号的 partition
      const cookieResult = await injectAccountCookies(accountId);
      writePublishLog({
        ts: Date.now(),
        level: 'info',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'cookie',
        message: `cookies 注入完成 (成功=${cookieResult.ok}, 失败=${cookieResult.fail}, 跳过=${cookieResult.skipped})`,
        data: { ok: cookieResult.ok, skipped: cookieResult.skipped, fail: cookieResult.fail },
      });

      item.progress = 15;
      this.persist();
      this.notifyStatus(task);

      // 调用平台适配器执行真实发布
      const adapter = getAdapter(item.platform);
      const onProgress = (p: number, message?: string) => {
        const np = Math.min(100, Math.max(0, p));
        item.progress = np;
        if (message) item.message = message;
        this.persist();
        this.notifyStatus(task);
      };

      writePublishLog({
        ts: Date.now(),
        level: 'info',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'adapter',
        message: `调用 ${item.platform} 适配器执行发布`,
        data: { platform: item.platform },
      });

      const result = await adapter.publish(accountId, task.request, onProgress);
      item.status = result.status;
      item.progress = 100;
      item.resultUrl = result.resultUrl;
      item.message = result.message;
      item.finishedAt = result.finishedAt || Date.now();

      writePublishLog({
        ts: Date.now(),
        level: result.status === 'success' ? 'info' : 'error',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'finish',
        message: `子任务完成，状态=${result.status}`,
        data: { status: result.status, resultUrl: result.resultUrl, message: result.message },
      });
    } catch (err) {
      item.status = 'failed';
      item.progress = 100;
      const msg = err instanceof Error ? err.message : String(err);
      item.message = msg;
      writePublishLog({
        ts: Date.now(),
        level: 'error',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'error',
        message: `发布异常: ${msg}`,
        data: { stack: err instanceof Error ? err.stack : undefined },
      });
      logger.error('[Publish] 发布失败', accountId, err);
    }

    // 汇总整任务状态
    this.aggregateTaskStatus(task);
    this.persist();
    this.notifyStatus(task);

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      stage: 'aggregate',
      message: `任务汇总状态=${task.status}`,
      data: { status: task.status, items: task.items.map((i) => ({ accountId: i.accountId, status: i.status, progress: i.progress })) },
    });
  }

  private aggregateTaskStatus(task: PublishTask) {
    const hasRunning = task.items.some((x) => x.status === 'running' || x.status === 'queued');
    const hasFailed = task.items.some((x) => x.status === 'failed');
    const allSuccess = task.items.every((x) => x.status === 'success');

    if (hasRunning) task.status = 'running';
    else if (allSuccess) task.status = 'success';
    else if (hasFailed) task.status = 'failed';
    else task.status = 'success';

    task.updatedAt = Date.now();
  }

  private persist() {
    const all = Array.from(this.running.values());
    const sorted = all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    getStore().set(TASKS_KEY, sorted as never);
  }

  /**
   * 向渲染层推送任务状态。
   * 增加了详细日志：windows 数量、payload 结构、是否成功发出。
   */
  private notifyStatus(task: PublishTask, verbose = false) {
    try {
      const BW = getBrowserWindow();
      const windows = BW.getAllWindows();
      const overall = task.items.length === 0
        ? 0
        : Math.round(task.items.reduce((s, x) => s + x.progress, 0) / task.items.length);

      const payload = {
        taskId: task.id,
        status: task.status,
        items: task.items,
        overallProgress: overall,
        startedAt: task.items[0]?.startedAt,
        finishedAt: (task.items.every((i) => i.finishedAt) && task.items[0]?.finishedAt) || undefined,
      };

      const totalWindows = windows.length;
      const aliveWindows = windows.filter((w: { isDestroyed: () => boolean }) => !w.isDestroyed());
      const sentTo: number[] = [];
      for (const w of aliveWindows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (w as any).webContents.send('publish:statusChanged', payload);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sentTo.push((w as any).id ?? -1);
        } catch (sendErr) {
          logger.warn('[Publish] notifyStatus: 单个窗口发送失败', sendErr);
        }
      }

      // 计数
      const c = (this.notifyCounters.get(task.id) ?? 0) + 1;
      this.notifyCounters.set(task.id, c);

      if (verbose || c === 1 || c % 5 === 0 || task.status === 'success' || task.status === 'failed') {
        writePublishLog({
          ts: Date.now(),
          level: 'info',
          taskId: task.id,
          stage: 'notify',
          message: `已推送状态（第${c}次）：status=${task.status} overall=${overall}% sentToWindows=${sentTo.length}`,
          data: {
            status: task.status,
            overallProgress: overall,
            notifyCount: c,
            totalWindows,
            aliveWindows: aliveWindows.length,
            itemSummary: task.items.map((i) => `${i.accountId}:${i.status}/${i.progress}`),
          },
        });
      }

      if (sentTo.length === 0) {
        // 没有可发送的窗口，也要记录一条日志，便于排查
        writePublishLog({
          ts: Date.now(),
          level: 'warn',
          taskId: task.id,
          stage: 'notify',
          message: `⚠️ 没有可用的 BrowserWindow，无法向渲染层推送状态（totalWindows=${totalWindows}）`,
          data: { totalWindows, aliveWindowsCount: aliveWindows.length },
        });
      }
    } catch (err) {
      logger.warn('[Publish] 推送状态失败:', err instanceof Error ? err.message : String(err));
      writePublishLog({
        ts: Date.now(),
        level: 'error',
        taskId: task.id,
        stage: 'notify-error',
        message: `推送状态异常：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

export const PublishEngine = new PublishEngineClass();
