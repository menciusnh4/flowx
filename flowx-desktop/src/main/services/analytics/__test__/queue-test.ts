/**
 * CollectTaskQueue 并发队列自测（纯逻辑，无外部依赖）
 * 用法：npx tsx --test src/main/services/analytics/__test__/queue-test.ts
 */

import { CollectTaskQueue } from '../CollectTaskQueue';
import type { CollectTask, CollectProgress, CollectTaskResult } from '../../../../types';

let passCount = 0;
let failCount = 0;

function assert(condition: unknown, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n🧪 ${name}`);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.catch((e) => {
        failCount++;
        console.error(`  ❌ 异常: ${e.message}`);
      });
    }
    return Promise.resolve();
  } catch (e) {
    failCount++;
    console.error(`  ❌ 异常: ${(e as Error).message}`);
    return Promise.resolve();
  }
}

function makeTask(id: string): CollectTask {
  return {
    id,
    accountId: 'test_account',
    platform: 'douyin',
    type: 'all',
    status: 'queued',
    createdAt: Date.now(),
  };
}

function makeResult(taskId: string, success: boolean = true): CollectTaskResult {
  return { taskId, success, collectedCount: 0, collectedAt: Date.now() };
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('CollectTaskQueue 并发队列 - 自测');
  console.log('='.repeat(60));

  // 测试1：基本入队与执行
  await test('基本入队与执行', async () => {
    const queue = new CollectTaskQueue(2);
    let executed = 0;

    const result = await queue.addTask(
      makeTask('task_001'),
      async (task, onProgress) => {
        executed++;
        onProgress({ progress: 50, message: '执行中' });
        return makeResult(task.id);
      },
    );

    assert(executed === 1, '任务被执行 1 次');
    assert(result.success === true, '任务结果 success = true');
    assert(result.taskId === 'task_001', '任务 ID 正确');

    queue.destroy();
  });

  // 测试2：并发控制
  await test('并发控制', async () => {
    const queue = new CollectTaskQueue(2);
    let running = 0;
    let maxRunning = 0;
    const results: string[] = [];

    const tasks = [1, 2, 3, 4].map((i) => makeTask(`task_concurrent_${i}`));

    const promises = tasks.map((task) =>
      queue.addTask(task, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 200));
        results.push(task.id);
        running--;
        return makeResult(task.id);
      }),
    );

    await Promise.all(promises);

    assert(maxRunning <= 2, `最大并发数不超过 2（实际: ${maxRunning}）`);
    assert(results.length === 4, '4 个任务全部完成');

    queue.destroy();
  });

  // 测试3：任务取消
  await test('任务取消（排队中）', async () => {
    const queue = new CollectTaskQueue(1);

    const p1 = queue
      .addTask(makeTask('task_long'), async () => {
        await new Promise((r) => setTimeout(r, 500));
        return makeResult('task_long');
      })
      .catch(() => makeResult('task_long', false));

    const p2 = queue
      .addTask(makeTask('task_queued'), async () => {
        return makeResult('task_queued');
      })
      .catch(() => makeResult('task_queued', false));

    const cancelled = queue.cancelTask('task_queued');
    assert(cancelled === true, '排队中的任务可以取消');

    const results = await Promise.all([p1, p2]);
    assert(results[0].success === true, '正在执行的任务正常完成');
    assert(results[1].success === false, '被取消的任务返回失败');

    queue.destroy();
  });

  // 测试4：进度通知
  await test('进度通知', async () => {
    const queue = new CollectTaskQueue(1);
    const progressValues: number[] = [];

    await queue.addTask(
      makeTask('task_progress'),
      async (_t, onProgress) => {
        onProgress({ progress: 20, message: '阶段1' });
        onProgress({ progress: 50, message: '阶段2' });
        onProgress({ progress: 100, message: '完成' });
        return makeResult('task_progress');
      },
      (p) => {
        progressValues.push(p.progress);
      },
    );

    assert(progressValues.length >= 3, `收到至少 3 次进度通知（实际: ${progressValues.length}）`);
    assert(progressValues[progressValues.length - 1] === 100, '最后一次进度为 100');

    const savedProgress = queue.getTaskProgress('task_progress');
    assert(savedProgress !== null, '能查询到任务进度');
    assert(savedProgress?.progress === 100, '保存的进度为 100');

    queue.destroy();
  });

  // 测试5：队列状态查询
  await test('队列状态查询', async () => {
    const queue = new CollectTaskQueue(1);

    const status1 = queue.getStatus();
    assert(status1.queued === 0 && status1.running === 0 && status1.completed === 0, '初始队列为空');

    const tasks = [1, 2, 3].map((i) => makeTask(`task_status_${i}`));
    const promises = tasks.map((task) =>
      queue.addTask(task, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return makeResult(task.id);
      }),
    );

    const status2 = queue.getStatus();
    assert(status2.queued === 2, `有 2 个任务在排队（实际: ${status2.queued}）`);
    assert(status2.running === 1, `有 1 个任务在运行（实际: ${status2.running}）`);

    await Promise.all(promises);

    const status3 = queue.getStatus();
    assert(status3.completed === 3, `3 个任务完成（实际: ${status3.completed}）`);
    assert(status3.running === 0, '0 个任务在运行');

    queue.destroy();
  });

  // 测试6：动态调整并发数
  await test('动态调整并发数', async () => {
    const queue = new CollectTaskQueue(1);
    let running = 0;
    let maxRunning = 0;

    const tasks = [1, 2, 3, 4].map((i) => makeTask(`task_dyn_${i}`));
    const promises = tasks.map((task) =>
      queue.addTask(task, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 200));
        running--;
        return makeResult(task.id);
      }),
    );

    // 把并发调到 3
    queue.setMaxConcurrency(3);

    await Promise.all(promises);

    assert(maxRunning <= 3, `调整后最大并发不超过 3（实际: ${maxRunning}）`);

    queue.destroy();
  });

  // 测试7：错误处理
  await test('错误处理', async () => {
    const queue = new CollectTaskQueue(2);

    let caughtError: Error | null = null;
    try {
      await queue.addTask(makeTask('task_error'), async () => {
        throw new Error('测试错误');
      });
    } catch (e) {
      caughtError = e as Error;
    }

    assert(caughtError !== null, '任务抛出的错误能被捕获');
    assert(caughtError?.message === '测试错误', '错误信息正确');

    queue.destroy();
  });

  // ========== 总结 ==========
  console.log('\n' + '='.repeat(60));
  console.log(`测试完成：✅ 通过 ${passCount} 项，❌ 失败 ${failCount} 项`);
  console.log('='.repeat(60));

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('测试运行失败:', e);
  process.exit(1);
});
