import { logger } from '../../utils/logger';
import type { CollectProgress, CollectTask, CollectTaskResult } from '../../../types';

type TaskHandler = (task: CollectTask, onProgress: (p: Partial<CollectProgress>) => void) => Promise<CollectTaskResult>;

interface QueueTask {
  task: CollectTask;
  handler: TaskHandler;
  onProgress: (p: Partial<CollectProgress>) => void;
  onComplete: (result: CollectTaskResult) => void;
  onError: (err: Error) => void;
  started: boolean;
  completed: boolean;
  progress: CollectProgress;
}

export class CollectTaskQueue {
  private queue: QueueTask[] = [];
  private runningCount = 0;
  private maxConcurrency: number;
  private destroyed = false;

  constructor(maxConcurrency: number = 2) {
    this.maxConcurrency = maxConcurrency;
  }

  setMaxConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, n);
    this.tryRunNext();
  }

  getStatus(): {
    queued: number;
    running: number;
    completed: number;
  } {
    const queued = this.queue.filter(t => !t.started).length;
    const running = this.queue.filter(t => t.started && !t.completed).length;
    const completed = this.queue.filter(t => t.completed).length;
    return { queued, running, completed };
  }

  addTask(
    task: CollectTask,
    handler: TaskHandler,
    onProgress?: (p: CollectProgress) => void,
  ): Promise<CollectTaskResult> {
    return new Promise((resolve, reject) => {
      const queueTask: QueueTask = {
        task,
        handler,
        onProgress: (p) => {
          queueTask.progress = { ...queueTask.progress, ...p };
          if (onProgress) onProgress(queueTask.progress);
        },
        onComplete: (result) => {
          queueTask.completed = true;
          resolve(result);
          this.runningCount--;
          logger.info(`[CollectQueue] 任务完成: ${task.id}, 剩余运行: ${this.runningCount}`);
          this.tryRunNext();
        },
        onError: (err) => {
          if (queueTask.started) {
            this.runningCount--;
            logger.warn(`[CollectQueue] 任务失败: ${task.id}, 错误: ${err.message}`);
          }
          queueTask.completed = true;
          reject(err);
          this.tryRunNext();
        },
        started: false,
        completed: false,
        progress: {
          taskId: task.id,
          status: 'queued',
          progress: 0,
          message: '等待中...',
          currentStage: 'waiting',
          collectedCount: 0,
          totalCount: 0,
        },
      };

      this.queue.push(queueTask);
      logger.info(`[CollectQueue] 加入任务: ${task.id} (${task.accountId}/${task.type})`);
      this.tryRunNext();
    });
  }

  private tryRunNext(): void {
    if (this.destroyed) return;
    if (this.runningCount >= this.maxConcurrency) return;

    const next = this.queue.find(t => !t.started && !t.completed);
    if (!next) return;

    this.runningCount++;
    next.started = true;
    next.progress.status = 'running';
    next.progress.message = '开始采集...';

    logger.info(`[CollectQueue] 开始执行任务: ${next.task.id}, 当前并发: ${this.runningCount}/${this.maxConcurrency}`);

    const taskId = next.task.id;
    const onProgress = (p: Partial<CollectProgress>) => next.onProgress(p);

    next.handler(next.task, onProgress)
      .then(result => next.onComplete(result))
      .catch(err => next.onError(err instanceof Error ? err : new Error(String(err))));
  }

  cancelTask(taskId: string): boolean {
    const idx = this.queue.findIndex(t => t.task.id === taskId);
    if (idx < 0) return false;
    const task = this.queue[idx];
    if (!task.started) {
      task.completed = true;
      this.queue.splice(idx, 1);
      task.onError(new Error('任务已取消'));
      return true;
    }
    return false;
  }

  getActiveTasks(): CollectTask[] {
    return this.queue.filter(t => t.started && !t.completed).map(t => t.task);
  }

  getTaskProgress(taskId: string): CollectProgress | null {
    const task = this.queue.find(t => t.task.id === taskId);
    return task ? task.progress : null;
  }

  destroy(): void {
    this.destroyed = true;
    for (const task of this.queue) {
      if (!task.started && !task.completed) {
        task.completed = true;
        task.onError(new Error('队列已销毁'));
      }
    }
    this.queue = [];
  }
}
