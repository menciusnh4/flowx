import { app, shell } from 'electron';
import { getStore } from '../store/SecureStore';
import { logger, writePublishLog, getPublishLogPath, getMainLogPath, queryPublishLogs, clearPublishLogs } from '../utils/logger';
import { AccountService, injectAccountCookies } from './AccountService';
import { getPlatform } from './platforms';
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
  // 存储定时发布任务的定时器句柄，用于支持级联取消
  private scheduledTimers = new Map<string, NodeJS.Timeout>();

  init() {
    if (this.ready) return;
    this.ready = true;
    const settings = getStore().get('settings') as { autoPublishConcurrency?: number } | undefined;
    this.concurrency = settings?.autoPublishConcurrency ?? 3;

    const tasks = getStore().get(TASKS_KEY) as PublishTask[] | undefined;
    if (tasks) {
      let tasksChanged = false;
      for (const t of tasks) {
        if (t.status === 'queued' || t.status === 'running') {
          t.status = 'failed';
          for (const item of t.items) {
            if (item.status === 'queued' || item.status === 'running') item.status = 'failed';
          }
          tasksChanged = true;
        } else if (t.status === 'scheduled') {
          // 处理软件重启时定时任务的恢复
          if (t.request?.scheduledAt) {
            if (t.request.scheduledAt > Date.now()) {
              // 时间还没到，重新拉起定时器
              const delay = t.request.scheduledAt - Date.now();
              const timer = setTimeout(() => {
                this.scheduledTimers.delete(t.id);
                this.runTask(t.id);
              }, delay);
              this.scheduledTimers.set(t.id, timer);
              logger.info(`[PublishEngine] 恢复定时任务 ${t.id}，将在 ${Math.round(delay / 1000)} 秒后执行`);
            } else {
              // 时间已经过了，置为 failed
              t.status = 'failed';
              for (const item of t.items) {
                if (item.status === 'scheduled') {
                  item.status = 'failed';
                  item.message = '在应用关闭期间错过了预定的发布时间';
                }
              }
              tasksChanged = true;
              logger.warn(`[PublishEngine] 定时任务 ${t.id} 的预定发布时间已过，标记为 failed`);
            }
          } else {
            t.status = 'failed';
            for (const item of t.items) {
              if (item.status === 'scheduled') item.status = 'failed';
            }
            tasksChanged = true;
          }
        }
        this.running.set(t.id, t);
      }
      if (tasksChanged) {
        getStore().set(TASKS_KEY, tasks);
      }
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
      const timer = setTimeout(() => {
        this.scheduledTimers.delete(taskId);
        this.runTask(taskId);
      }, delay);
      this.scheduledTimers.set(taskId, timer);
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

  /** 列出所有任务（历史） - 返回全部，用于统计 */
  listTasks(): PublishTask[] {
    return Array.from(this.running.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 分页查询任务列表
   * @param page 页码，从1开始
   * @param pageSize 每页数量，默认20
   * @returns { items: PublishTask[], total: number, page: number, pageSize: number }
   */
  listTasksPaged(page = 1, pageSize = 20): {
    items: PublishTask[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  } {
    const all = Array.from(this.running.values()).sort((a, b) => b.createdAt - a.createdAt);
    const total = all.length;
    const safePage = Math.max(1, page | 0);
    const safeSize = Math.min(100, Math.max(5, pageSize | 0));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const start = (safePage - 1) * safeSize;
    const items = all.slice(start, start + safeSize);
    return { items, total, page: safePage, pageSize: safeSize, totalPages };
  }

  /** 获取统计信息（轻量级，仅返回计数，不序列化完整任务列表） */
  getStats(): { total: number; todaySuccess: number; running: number; failed: number } {
    const all = Array.from(this.running.values());
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayTs = startOfToday.getTime();

    let total = all.length;
    let todaySuccess = 0;
    let running = 0;
    let failed = 0;

    for (const t of all) {
      if (t.status === 'success' && t.updatedAt >= todayTs) todaySuccess++;
      if (t.status === 'running' || t.status === 'queued') running++;
      if (t.status === 'failed') failed++;
    }

    return { total, todaySuccess, running, failed };
  }

  /** 取消任务 */
  cancel(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (!task) return false;
    // 如果是定时发布的任务且定时器存在，则清理掉它
    const timer = this.scheduledTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.scheduledTimers.delete(taskId);
    }
    this.queue = this.queue.filter((x) => x.taskId !== taskId);
    for (const item of task.items) {
      if (item.status === 'queued' || item.status === 'running' || item.status === 'scheduled') {
        item.status = 'cancelled';
      }
    }
    if (task.status === 'scheduled') {
      task.status = 'cancelled';
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

  /**
   * 重试失败的任务
   * - 只重试失败的账号（成功的跳过）
   * - 创建新的子任务条目，保留原始请求
   * - 如果全部账号都已成功，返回 null 表示无需重试
   */
  retry(taskId: string): string | null {
    const originalTask = this.running.get(taskId);
    if (!originalTask) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    // 找出失败或取消的子任务
    const failedItems = originalTask.items.filter(
      (item) => item.status === 'failed' || item.status === 'cancelled',
    );

    if (failedItems.length === 0) {
      return null; // 没有失败的账号，无需重试
    }

    // 收集需要重试的账号ID
    const retryAccountIds = failedItems.map((item) => item.accountId);

    // 构造新的发布请求（使用原始请求，但只包含失败的账号）
    const retryRequest: PublishRequest = {
      ...originalTask.request,
      accountIds: retryAccountIds,
    };

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId: originalTask.id,
      stage: 'retry',
      message: `发起重试，原任务=${originalTask.id}，失败账号数=${retryAccountIds.length}`,
      data: { retryAccountIds, originalStatus: originalTask.status },
    });

    // 提交新任务（复用submit逻辑）
    const newTaskId = this.submit(retryRequest);

    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId: newTaskId,
      stage: 'retry',
      message: `重试任务已创建，新任务ID=${newTaskId}，来源任务=${originalTask.id}`,
      data: { sourceTaskId: originalTask.id, retryAccountIds },
    });

    return newTaskId;
  }

  /** 获取单个任务详情（含日志） */
  getTaskDetail(taskId: string): { task: PublishTask | null; logs: PublishLogEntry[] } {
    const task = this.running.get(taskId) || null;
    const logs = queryPublishLogs({ taskId });
    return { task, logs };
  }

  /** 删除单条历史记录 */
  deleteTask(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (!task) return false;
    // 如果任务正在运行，不允许删除
    if (task.status === 'running' || task.status === 'queued') {
      throw new Error('任务正在执行中，无法删除');
    }
    // 如果是定时发布的任务，联动执行取消
    if (task.status === 'scheduled') {
      this.cancel(taskId);
    }
    this.running.delete(taskId);
    this.persist();
    writePublishLog({
      ts: Date.now(),
      level: 'info',
      taskId,
      stage: 'delete',
      message: '历史记录已删除',
    });
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
      // 获取平台的主域 homeUrl 作为注入上下文目标地址
      const platform = getPlatform(item.platform as any);
      const homeUrl = platform?.meta.homeUrl;

      // 注入 cookies 到该账号的 partition
      const cookieResult = await injectAccountCookies(accountId, homeUrl);
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

      // 两级分发（工厂方法 + 适配器模式）：
      //   Level 1: contentType → publishVideo / publishImage / publishArticle
      //   Level 2: platform   → 对应平台的实现（xiaohongshu / douyin / kuaishou）
      const onProgress = (p: number, message?: string) => {
        const np = Math.min(100, Math.max(0, p));
        item.progress = np;
        if (message) item.message = message;
        this.persist();
        this.notifyStatus(task);
      };

      const contentType = (task.request.contentType || 'video') as 'video' | 'image' | 'article';
      const { createPublishExecutor } = await import('./platforms/PlatformDispatcher');
      const executor = createPublishExecutor(item.platform, contentType);

      writePublishLog({
        ts: Date.now(),
        level: 'info',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'adapter',
        message: `调用 ${item.platform} 适配器执行 ${executor.method}`,
        data: { platform: item.platform, method: executor.method, contentType },
      });

      const result = await executor.execute(accountId, task.request, onProgress);
      item.status = result.status;
      item.progress = 100;
      item.resultUrl = result.resultUrl;
      item.message = result.message;
      item.finishedAt = result.finishedAt || Date.now();
      // 传递测试模式结果
      if (result.testResult) {
        item.testResult = result.testResult;
      }

      writePublishLog({
        ts: Date.now(),
        level: result.status === 'success' ? 'info' : 'error',
        taskId,
        accountId,
        platform: item.platform,
        stage: 'finish',
        message: `子任务完成，状态=${result.status}${result.testResult ? '（测试模式）' : ''}`,
        data: { status: result.status, resultUrl: result.resultUrl, message: result.message, testResult: result.testResult || undefined },
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
    const sorted = all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aliveWindows = windows.filter((w: any) => w && typeof w.isDestroyed === 'function' && !w.isDestroyed());
      const sentTo: number[] = [];
      let skippedPublishWindows = 0;
      for (const w of windows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyW = w as any;
          // 多层防御：窗口已销毁 / webContents 不存在 / webContents 自身已销毁
          if (!anyW || typeof anyW.isDestroyed !== 'function' || anyW.isDestroyed()) continue;
          const wc = anyW.webContents;
          if (!wc || typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue;
          if (typeof wc.send !== 'function') continue;

          // ✅ 关键修复：跳过发布窗口！对 creator.douyin.com / xiaohongshu.com 这类外部页面
          // 发送 IPC ('publish:statusChanged') 会导致它的 render frame 被销毁，
          // 从而让后续 executeJavaScript 调用全部失败 ("Render frame was disposed")
          // — 两种识别方式，任一命中就跳过：
          //   (a) 窗口自身带 _flowxPublishWindow=true 标记
          //   (b) webContents 已加载外部 URL（非 file:// 协议）
          let isPublishWin = false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((anyW as any)._flowxPublishWindow === true) {
              isPublishWin = true;
            } else {
              const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
              if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                // heuristic: 任何 http(s) URL 的窗口都不是我们需要发 IPC 的主窗口
                // — 主窗口用的是 file:// / vite dev server
                if (url.includes('douyin.com') || url.includes('xiaohongshu.com') || url.includes('kuaishou.com')) {
                  isPublishWin = true;
                }
              }
            }
          } catch { /* ignore */ }
          if (isPublishWin) {
            skippedPublishWindows++;
            continue;
          }

          try {
            wc.send('publish:statusChanged', payload);
            sentTo.push(anyW.id ?? -1);
          } catch (sendErr) {
            logger.debug('[Publish] notifyStatus: 单个窗口发送跳过', sendErr instanceof Error ? sendErr.message : String(sendErr));
          }
        } catch (outerErr) {
          logger.warn('[Publish] notifyStatus: 单个窗口预处理失败', outerErr);
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
          message: `已推送状态（第${c}次）：status=${task.status} overall=${overall}% sentToWindows=${sentTo.length} skippedPublishWindows=${skippedPublishWindows}`,
          data: {
            status: task.status,
            overallProgress: overall,
            notifyCount: c,
            totalWindows,
            aliveWindows: aliveWindows.length,
            skippedPublishWindows,
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
