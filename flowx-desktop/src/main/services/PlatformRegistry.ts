import type { PlatformMeta, PlatformType } from '../../types';

// 平台注册表 - 集中管理所有接入平台的 URL/内容类型等静态信息
// 注: 抖音创作服务平台和小红书创作者中心的登录地址经常变更，以用户实际访问地址为准。

export const PLATFORMS: Record<PlatformType, PlatformMeta> = {
  douyin: {
    key: 'douyin',
    name: '抖音',
    icon: '🎵',
    // 抖音创作服务平台（登录/发布）
    authUrl: 'https://creator.douyin.com/',
    publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    homeUrl: 'https://creator.douyin.com/',
    contentTypes: ['video', 'image', 'article'],
  },
  xiaohongshu: {
    key: 'xiaohongshu',
    name: '小红书',
    icon: '📕',
    // 小红书专业号/创作中心
    authUrl: 'https://www.xiaohongshu.com/',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    homeUrl: 'https://www.xiaohongshu.com/',
    contentTypes: ['image', 'video', 'article'],
  },
};

export function listPlatforms(): PlatformMeta[] {
  return Object.values(PLATFORMS);
}
