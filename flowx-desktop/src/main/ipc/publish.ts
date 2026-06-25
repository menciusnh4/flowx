import { safeInvoke } from './index';
import { PublishEngine } from '../services/PublishEngine';
import type { PublishRequest, PublishLogQuery } from '../../types';

export function registerPublishIpc(): void {
  // 提交发布任务 -> 返回 taskId
  safeInvoke('publish:submit', (req: PublishRequest) => PublishEngine.submit(req));

  // 查询进度
  safeInvoke('publish:progress', (taskId: string) => PublishEngine.getProgress(taskId));

  // 取消任务
  safeInvoke('publish:cancel', (taskId: string) => PublishEngine.cancel(taskId));

  // 获取所有任务（历史记录）
  safeInvoke('publish:list', () => PublishEngine.listTasks());

  // 分页查询任务列表
  safeInvoke('publish:listPaged', (page?: number, pageSize?: number) =>
    PublishEngine.listTasksPaged(page || 1, pageSize || 20),
  );

  // 获取统计信息（轻量级）
  safeInvoke('publish:getStats', () => PublishEngine.getStats());

  // 重试失败任务 -> 返回新的 taskId，或 null（无需重试）
  safeInvoke('publish:retry', (taskId: string) => PublishEngine.retry(taskId));

  // 获取任务详情（含日志）
  safeInvoke('publish:detail', (taskId: string) => PublishEngine.getTaskDetail(taskId));

  // 删除单条历史记录
  safeInvoke('publish:delete', (taskId: string) => PublishEngine.deleteTask(taskId));

  // 修改并发数
  safeInvoke('publish:setConcurrency', (n: number) => {
    PublishEngine.setConcurrency(n);
    return true;
  });

  // 获取发布日志文件路径信息
  safeInvoke('publish:getLogPaths', () => PublishEngine.getLogPaths());

  // 打开日志所在目录
  safeInvoke('publish:openLogDir', () => PublishEngine.openLogDir());

  // 查询结构化发布日志（按 taskId/accountId 过滤、倒序返回）
  safeInvoke('publish:queryLogs', (query?: PublishLogQuery) => PublishEngine.queryLogs(query || {}));

  // 清空内存日志
  safeInvoke('publish:clearLogs', () => PublishEngine.clearLogs());
}
