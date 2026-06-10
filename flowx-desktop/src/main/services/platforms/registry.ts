import type { PlatformType, PlatformMeta, AccountCapabilities } from '../../../types';
import type { PlatformAdapter } from './types';

/**
 * 全局平台注册表 —— 单独文件，避免循环依赖
 *
 * ⚠️ 此文件不 import 任何平台实现文件，也不做 side-effect。
 * 平台实现文件（xiaohongshu.ts / douyin.ts / kuaishou.ts）从此文件导入
 * registerPlatform，在文件末尾触发注册；
 * index.ts 从此文件导出公开 API，并做 side-effect import 加载所有平台。
 */
const registry = new Map<PlatformType, PlatformAdapter>();

/** 注册一个平台（幂等：相同 key 覆盖旧注册） */
export function registerPlatform(adapter: PlatformAdapter): void {
  registry.set(adapter.key, adapter);
  // eslint-disable-next-line no-console
  console.log(`[PlatformRegistry] 注册平台: ${adapter.key} (${adapter.meta.name})`);
}

/** 获取一个平台实现 */
export function getPlatform(key: PlatformType): PlatformAdapter | undefined {
  return registry.get(key);
}

/** 获取所有已注册平台 */
export function getAllPlatforms(): PlatformAdapter[] {
  return Array.from(registry.values());
}

/** 获取所有平台的 meta 信息 */
export function getAllPlatformMetas(): PlatformMeta[] {
  return Array.from(registry.values()).map((p) => p.meta);
}

/** 判断平台是否支持 */
export function isPlatformSupported(key: PlatformType): boolean {
  return registry.has(key);
}

/** 获取平台 capabilities（替代原先 AccountService.toInfo 的 switch） */
export function getPlatformCapabilities(key: PlatformType): AccountCapabilities {
  const p = registry.get(key);
  if (p) return p.capabilities;
  return { publishVideo: true, publishImage: false, publishArticle: false };
}

export { registry as __internalRegistry };
