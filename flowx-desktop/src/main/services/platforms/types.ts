import { BrowserWindow } from 'electron';
import type {
  PlatformType,
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
} from '../../../types';

/** 从页面 DOM 中提取的账号信息（授权/刷新时使用） */
export interface ExtractedAccountInfo {
  /** 昵称 */
  nickname: string;
  /** 头像 URL（https:// 开头） */
  avatar?: string;
  /** 平台内展示的账号标识（如抖音号/小红书号） */
  platformAccountId?: string;
  /** 粉丝数 */
  fansCount?: number;
  /** 关注数 */
  followCount?: number;
  /** 获赞数 */
  likeCount?: number;
}

/** 登录状态检测结果 */
export interface LoginCheckResult {
  loggedIn: boolean;
  url: string;
  title: string;
  /** 命中的关键字（如有） */
  matchedKeywords?: string[];
}

/** 进度回调 */
export type ProgressCallback = (progress: number, message?: string) => void;

/**
 * 统一的平台适配者接口
 * 每个平台（抖音/小红书/快手等）实现一个该接口的对象，
 * 通过 registerPlatform() 注册到全局注册表。
 *
 * 添加新平台的步骤：
 *   1. 在 src/main/services/platforms/ 下新建 <platformKey>.ts
 *   2. 实现 PlatformAdapter 接口
 *   3. 在该文件末尾调用 registerPlatform(adapter)
 *   4. 在 src/main/services/platforms/index.ts 的 sideEffectImports 中添加一行 import
 */
export interface PlatformAdapter {
  /** 平台 key（如 'douyin'、'xiaohongshu'），全局唯一 */
  readonly key: PlatformType;

  /** 平台元信息 */
  readonly meta: PlatformMeta;

  /** 等价于 meta.key，方便某些场景使用 */
  readonly capabilities: AccountCapabilities;

  /**
   * 检测当前窗口中的页面是否处于已登录状态
   * 默认实现：检查 body 文本是否含 meta.loginKeywords 中的任意关键字
   * 平台可以重写此方法以做更精确的判断（如检查特定 DOM 元素）
   */
  detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult>;

  /**
   * 从当前窗口的页面中提取账号信息（昵称/头像/粉丝数据等）
   * 默认实现：用 meta.nicknameSelectors / meta.avatarSelectors + 通用粉丝数据提取逻辑
   * 平台可以重写此方法以实现更精确的提取
   */
  extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo>;

  /**
   * 执行一次发布
   * @param accountId  目标账号 id（用于定位 browser session partition）
   * @param request    发布内容（标题/正文/媒体文件/话题等）
   * @param onProgress 进度回调（0-100）
   */
  publish(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;
}
