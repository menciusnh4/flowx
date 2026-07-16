// 平台品牌图标（SVG/PNG），通过 Vite import 引入。
// 作为全应用唯一的平台 logo 来源，账号管理 / 发布表单等页面统一引用，确保视觉一致。
import iconXiaohongshu from '../assets/xiaohongshu.svg';
import iconDouyin from '../assets/douyin.svg';
import iconKuaishou from '../assets/kuaishou.svg';
import iconBilibili from '../assets/bilibili.svg';
import iconWechatChannels from '../assets/wechat_channels.svg';
import iconWeibo from '../assets/weibo.png';
import iconZhihu from '../assets/zhihu.png';
import iconToutiao from '../assets/toutiao.png';

export const PLATFORM_ICONS: Record<string, string> = {
  xiaohongshu: iconXiaohongshu,
  douyin: iconDouyin,
  kuaishou: iconKuaishou,
  bilibili: iconBilibili,
  wechat_channels: iconWechatChannels,
  weibo: iconWeibo,
  zhihu: iconZhihu,
  toutiao: iconToutiao,
};

/** 获取平台图标 URL，找不到则返回空字符串 */
export function getPlatformIcon(p?: string): string {
  if (!p) return '';
  return PLATFORM_ICONS[p] || '';
}
