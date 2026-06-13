import { defineStore } from 'pinia';
import type {
  PublishItemProgress,
  PublishProgress,
  PublishRequest,
  PublishTask,
  PublishStatus,
} from '../../types';
import { electronApi } from '../utils/electron';

type LiveTaskStatus = PublishStatus | 'queued';

interface LiveTaskItem extends PublishItemProgress {
  accountId: string;
}

interface LiveTask {
  taskId: string;
  request: PublishRequest;
  status: LiveTaskStatus;
  overallProgress: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  items: LiveTaskItem[];
}

const LOG_PREFIX = '[PublishStore]';

export const usePublishStore = defineStore('publish', {
  state: () => ({
    // ========== 实时任务（正在 / 即将执行） ==========
    liveTasks: {} as Record<string, LiveTask>,
    _listenerInstalled: false,
    _listenerCleanup: null as (() => void) | null,
    // 自动清理已完成任务的定时器
    _autoRemoveTimers: {} as Record<string, number>,

    // ========== 历史任务（从主进程查询） ==========
    history: [] as PublishTask[],
    loading: false,
    historyError: '',

    // ========== 内部日志（可选展示到调试面板） ==========
    _log: [] as Array<{ ts: number; level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }>,
  }),
  getters: {
    hasLiveTasks(): boolean {
      // liveTasks 中的任务仍在面板展示，8/15 秒后由定时器自动移除
      return Object.keys(this.liveTasks).length > 0;
    },
    liveList(): LiveTask[] {
      // 按 startedAt desc 排序
      return Object.values(this.liveTasks).sort(
        (a, b) => (b.startedAt || 0) - (a.startedAt || 0),
      );
    },
    logs(): Array<{ ts: number; level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }> {
      return this._log.slice(-80);
    },
  },
  actions: {
    // ============== 日志 ==============
    _logLine(level: 'info' | 'warn' | 'error', msg: string, data?: unknown) {
      const ts = Date.now();
      this._log.push({ ts, level, msg, data });
      if (level === 'info') console.log(`${LOG_PREFIX} ${msg}`, data ?? '');
      else if (level === 'warn') console.warn(`${LOG_PREFIX} ${msg}`, data ?? '');
      else console.error(`${LOG_PREFIX} ${msg}`, data ?? '');
    },

    // ============== IPC 事件监听器 ==============
    ensureListener() {
      if (this._listenerInstalled) return;
      try {
        const cleanup = electronApi.onPublishStatusChanged((evt: unknown) => {
          const raw = evt as {
            taskId?: string;
            status?: string;
            overallProgress?: number;
            items?: Array<Record<string, unknown>>;
            error?: string;
            startedAt?: number;
            finishedAt?: number;
          };
          this._logLine('info', `receive statusChanged event`, {
            taskId: raw.taskId,
            status: raw.status,
            overallProgress: raw.overallProgress,
            itemsCount: raw.items?.length ?? 0,
            hasError: !!raw.error,
          });
          try {
            this._applyStatusUpdate(raw);
          } catch (e) {
            this._logLine('error', `applyStatusUpdate crash: ${e instanceof Error ? e.message : String(e)}`, { err: e });
          }
        });
        this._listenerCleanup = cleanup;
        this._listenerInstalled = true;
        this._logLine('info', `ensureListener: installed ok`);
      } catch (e) {
        this._logLine('error', `ensureListener fail: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    _applyStatusUpdate(raw: {
      taskId?: string;
      status?: string;
      overallProgress?: number;
      items?: Array<Record<string, unknown>>;
      error?: string;
      startedAt?: number;
      finishedAt?: number;
    }) {
      const taskId = raw.taskId;
      if (!taskId) {
        this._logLine('warn', `applyStatusUpdate: missing taskId, skip`);
        return;
      }

      const prev = this.liveTasks[taskId];
      const nextStatus = (raw.status as LiveTaskStatus) ?? prev?.status ?? 'running';
      const nextProgress = typeof raw.overallProgress === 'number' ? raw.overallProgress : (prev?.overallProgress ?? 0);

      // 合并 items：主进程推送的 item 结构里有 accountId/platform/status/progress/message/resultUrl
      const prevMap = new Map<string, LiveTaskItem>();
      if (prev) prev.items.forEach((i) => prevMap.set(i.accountId, i));

      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      const nextItems: LiveTaskItem[] = rawItems.length > 0
        ? rawItems.map((ri) => {
            const accountId = String(ri.accountId ?? '');
            const base = prevMap.get(accountId);
            return {
              accountId,
              platform: (ri.platform as string | undefined) ?? base?.platform ?? '',
              status: (ri.status as LiveTaskStatus) ?? base?.status ?? 'queued',
              progress: typeof ri.progress === 'number' ? ri.progress : (base?.progress ?? 0),
              message: (ri.message as string | undefined) ?? base?.message ?? '',
              resultUrl: (ri.resultUrl as string | undefined) ?? base?.resultUrl,
              startedAt: (ri.startedAt as number | undefined) ?? base?.startedAt,
              finishedAt: (ri.finishedAt as number | undefined) ?? base?.finishedAt,
            };
          })
        : (prev?.items ?? []).map((p) => ({ ...p }));

      this.liveTasks[taskId] = {
        taskId,
        request: prev?.request ?? { accountIds: [], title: '', contentType: 'video', mediaFiles: [], coverImage: '', tags: [], category: '', content: '' },
        status: nextStatus,
        overallProgress: nextProgress,
        items: nextItems,
        startedAt: raw.startedAt ?? prev?.startedAt,
        finishedAt: raw.finishedAt ?? prev?.finishedAt,
        error: raw.error ?? prev?.error,
      };

      // ✅ 关键修复：任务完成（success/failed）后，8 秒自动从 liveTasks 移除
      //    让"任务进行中"的标题消失，避免用户困惑"为什么发布成功了还在这里"
      if (nextStatus === 'success' || nextStatus === 'failed') {
        // 若已有旧定时器，先清理（可能任务从 failed 重试到 success）
        if (this._autoRemoveTimers[taskId]) {
          window.clearTimeout(this._autoRemoveTimers[taskId]);
        }
        const removeDelay = nextStatus === 'success' ? 8000 : 15000; // 成功展示 8s，失败展示 15s
        this._autoRemoveTimers[taskId] = window.setTimeout(() => {
          this._logLine('info', `auto-remove task ${taskId} (status=${nextStatus}) from liveTasks`);
          if (this.liveTasks[taskId]) {
            delete this.liveTasks[taskId];
          }
          delete this._autoRemoveTimers[taskId];
        }, removeDelay) as unknown as number;
      } else if (this._autoRemoveTimers[taskId]) {
        // 任务重新进入执行状态 → 取消之前计划的移除（例如从 failed 重试）
        window.clearTimeout(this._autoRemoveTimers[taskId]);
        delete this._autoRemoveTimers[taskId];
      }

      // 同步刷新 history 列表中对应 task（如果已存在），让界面一致
      const idx = this.history.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        const merged: PublishTask = {
          ...this.history[idx],
          status: nextStatus as PublishStatus,
          items: nextItems.map((i) => ({
            accountId: i.accountId,
            platform: i.platform as any,
            status: i.status as PublishStatus,
            progress: i.progress,
            message: i.message,
            resultUrl: i.resultUrl,
            startedAt: i.startedAt,
            finishedAt: i.finishedAt,
          })),
          updatedAt: Date.now(),
        };
        this.history[idx] = merged;
      }

      this._logLine('info', `applyStatusUpdate: task ${taskId}`, {
        prevStatus: prev?.status,
        newStatus: nextStatus,
        prevProgress: prev?.overallProgress,
        newProgress: nextProgress,
        itemsCount: nextItems.length,
      });
    },

    // ============== 提交任务 ==============
    async submit(request: PublishRequest): Promise<string> {
      this._logLine('info', `submit: start`, {
        contentType: request.contentType,
        accountIds: request.accountIds,
        title: request.title,
        mediaCount: request.mediaFiles.length,
      });
      try {
        this.ensureListener();
        const taskId = await electronApi.submitPublish(request);
        this._logLine('info', `submit: got taskId=${taskId}`);

        // 登记本地 live task（主进程随后会 push 多次更新，这里做兜底）
        if (!this.liveTasks[taskId]) {
          this.liveTasks[taskId] = {
            taskId,
            request,
            status: 'queued',
            overallProgress: 0,
            items: request.accountIds.map((id) => ({
              accountId: id,
              platform: '',
              status: 'queued',
              progress: 0,
              message: '排队中…',
            })),
            startedAt: Date.now(),
          };
        }

        // 立刻从主进程拉一次最新状态，避免等待第一次推送
        try {
          const info = await electronApi.getPublishProgress(taskId);
          if (info) {
            this._applyStatusUpdate({
              taskId: info.taskId,
              status: info.status,
              overallProgress: info.overallProgress,
              items: info.items as unknown as Array<Record<string, unknown>>,
            });
          }
        } catch { /* 忽略，主进程会通过事件推送 */ }

        this._logLine('info', `submit: done, task ${taskId} registered locally`);
        return taskId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._logLine('error', `submit failed: ${msg}`, { err: e });
        throw e;
      }
    },

    // ============== 历史记录 ==============
    async loadHistory() {
      this.loading = true;
      this.historyError = '';
      this._logLine('info', `loadHistory: querying main process`);
      try {
        const tasks = await electronApi.listTasks();
        this.history = tasks || [];
        this._logLine('info', `loadHistory: got ${this.history.length} tasks`);
      } catch (e) {
        this.historyError = e instanceof Error ? e.message : String(e);
        this._logLine('error', `loadHistory failed: ${this.historyError}`, { err: e });
      } finally {
        this.loading = false;
      }
    },

    // ============== 其他 ==============
    async cancelTask(taskId: string) {
      try {
        await electronApi.cancelPublish(taskId);
        this._logLine('info', `cancelTask: ${taskId} ok`);
      } catch (e) {
        this._logLine('error', `cancelTask ${taskId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    remove(taskId: string) {
      if (this.liveTasks[taskId]) {
        delete this.liveTasks[taskId];
        this._logLine('info', `remove: live task ${taskId} removed`);
      }
    },
  },
});
