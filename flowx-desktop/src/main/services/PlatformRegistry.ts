import { getAllPlatforms } from './platforms';
import type { PlatformMeta, PlatformType } from '../../types';

/**
 * 向后兼容：从统一注册表导出 PLATFORMS 对象
 * 旧代码中使用 `PLATFORMS[platform].authUrl` 等的地方无需修改
 */
const platformsList = getAllPlatforms();
const PLATFORMS: Record<string, PlatformMeta> = {};
platformsList.forEach((p) => {
  PLATFORMS[p.key] = p.meta;
});

export { PLATFORMS };

/** 向后兼容：获取所有已注册平台的 meta 列表 */
export function listPlatforms(): PlatformMeta[] {
  return Object.values(PLATFORMS);
}

/** 旧代码通过此函数判断平台是否支持 */
export function isPlatformSupported(key: PlatformType): boolean {
  return !!PLATFORMS[key];
}
