// ============================================================
// PlatformDispatcher —— 工厂方法 + 两级分发器
//
// 职责（单一职责原则）：
//   1. 根据 contentType 选择调用方向（publishVideo / publishImage / publishArticle）
//   2. 根据 platformKey 从注册表找到对应的 PlatformAdapter
//   3. 返回一个 PublishExecutor，由调用方执行实际发布
//
// 调用链：
//   PublishEngine.runItem()
//     → PlatformDispatcher.createExecutor(platform, contentType)
//       → executor.execute(accountId, request, onProgress)
//         → adapter.publishVideo() / publishImage() / publishArticle()
//
// 设计意图：
//   - 让 PublishEngine 不关心"怎么发布"（各平台的页面结构、按钮定位、上传方式），
//     只关心"调用哪个适配器"
//   - 每个平台适配器文件只关心自己的 DOM 结构，不耦合到其他平台
//   - 新增平台只需实现 PlatformAdapter + 注册，不修改此文件
//   - 新增内容类型只需在 switchMap 中添加一行，不修改平台实现
// ============================================================

import type {
  ContentType,
  PlatformType,
  PublishItemProgress,
  PublishRequest,
} from '../../../types';
import type {
  PlatformAdapter,
  ProgressCallback,
  PublishExecutor,
} from './types';
import { getPlatform } from './registry';

/**
 * 从注册表查找平台适配器。
 * 找不到时抛出带明确提示的错误，便于在发布引擎中捕获。
 */
export function requirePlatformAdapter(platform: PlatformType): PlatformAdapter {
  const adapter = getPlatform(platform);
  if (!adapter) {
    throw new Error(
      `[PlatformDispatcher] 未找到平台适配器: ${platform}。` +
      `请确认 src/main/services/platforms/${platform}.ts 已实现 ` +
      `PlatformAdapter 接口并通过 registerPlatform() 注册。`,
    );
  }
  return adapter;
}

/**
 * 内容类型 → 平台方法名 映射表（第一级分发）
 */
type MethodKey = 'publishVideo' | 'publishImage' | 'publishArticle' | 'publish';

function contentTypeToMethod(contentType: ContentType): MethodKey {
  switch (contentType) {
    case 'video':
      return 'publishVideo';
    case 'image':
      return 'publishImage';
    case 'article':
      return 'publishArticle';
    default:
      return 'publish'; // 兜底：走旧接口
  }
}

/**
 * 工厂方法：根据 platform + contentType 创建发布执行器
 *
 * 返回的 PublishExecutor 封装了"用哪一个平台适配器、调用哪一个方法"的决策。
 * 这让 PublishEngine 保持干净：它只需调用 execute()，不需要知道具体平台的 DOM 结构。
 *
 * 降级策略：
 *   - 若平台未实现对应 contentType 方法（例如小红书没有 publishArticle），
 *     则 fallback 到通用 publish()
 *   - 若连 publish() 也没有（理论上不应该发生，因为 publish() 是必选接口），
 *     则抛出明确错误
 */
export function createPublishExecutor(
  platform: PlatformType,
  contentType: ContentType,
): PublishExecutor {
  const adapter = requirePlatformAdapter(platform);
  const preferredMethod = contentTypeToMethod(contentType);

  // 检查平台是否实现了对应方法
  // (TypeScript 层面 publishVideo 等是可选方法，运行时可能不存在)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawAdapter = adapter as any;
  if (typeof rawAdapter[preferredMethod] === 'function') {
    return {
      platform,
      method: preferredMethod as MethodKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (accountId: string, request: PublishRequest, onProgress: ProgressCallback): Promise<PublishItemProgress> => {
        return rawAdapter[preferredMethod](accountId, request, onProgress);
      },
    };
  }

  // 降级：平台未实现特定方法，使用通用 publish()
  // 这是一个兼容层，确保旧的平台实现（仅实现了 publish()）仍能工作
  if (typeof adapter.publish === 'function') {
    return {
      platform,
      method: 'publish',
      execute: (
        accountId: string,
        request: PublishRequest,
        onProgress: ProgressCallback,
      ): Promise<PublishItemProgress> => {
        return adapter.publish(accountId, request, onProgress);
      },
    };
  }

  // 理论上不会到达此处（因为 PlatformAdapter 接口要求 publish 必实现）
  throw new Error(
    `[PlatformDispatcher] 平台 ${platform} 未实现 ${preferredMethod}() 或 publish() 方法`,
  );
}

/**
 * 便捷方法：直接执行发布（等同于 createExecutor(...).execute(...)）
 */
export function executePublish(
  platform: PlatformType,
  contentType: ContentType,
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return createPublishExecutor(platform, contentType).execute(accountId, request, onProgress);
}
