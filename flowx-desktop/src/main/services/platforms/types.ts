import { BrowserWindow } from 'electron';
import type {
  PlatformType,
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
  ContentType,
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
 * 统一的平台适配者接口（适配器模式）
 *
 * 设计原则：
 *  1. 单一职责：每个平台文件只关心自己的 DOM 结构/页面流程，不影响其他平台
 *  2. 两级分发：发布引擎先按 contentType → 再按 platform 分发到具体方法
 *     (publishVideo / publishImage / publishArticle)
 *  3. 面向接口：所有平台实现同一套协议，调用方（PublishEngine + PlatformDispatcher）
 *     只需知道接口，不需关心具体平台实现
 *
 * 每个平台（抖音/小红书/快手等）实现一个该接口的对象，
 * 通过 registerPlatform() 注册到全局注册表。
 *
 * 添加新平台的步骤：
 *   1. 在 src/main/services/platforms/ 下新建 <platformKey>.ts
 *   2. 实现 PlatformAdapter 接口（publishVideo / publishImage 等至少一个）
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
   */
  detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult>;

  /**
   * 从当前窗口的页面中提取账号信息（昵称/头像/粉丝数据等）
   */
  extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo>;

  // ─── 发布方法（按内容类型区分，两级分发的第二级）─────────

  /**
   * 发布视频内容。实现方式：打开平台的视频发布页 → 上传视频文件 →
   * 填写标题/正文/话题 → 点击发布按钮 → 返回结果。
   */
  publishVideo?(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;

  /**
   * 发布图文（图片 + 文字）内容。
   */
  publishImage?(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;

  /**
   * 发布纯文章（长文/动态），目前仅抖音支持。
   */
  publishArticle?(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;

  // ─── 向后兼容（旧接口，最终会移除）─────────────────────

  /**
   * 旧版通用发布接口（不区分内容类型），作为向后兼容保留。
   * 新代码请使用 publishVideo / publishImage / publishArticle。
   *
   * @deprecated 请使用按内容类型区分的方法
   */
  publish(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;
}

/** 发布执行器：封装了 content-type → platform method 的分发逻辑 */
export interface PublishExecutor {
  /** 底层平台 key */
  platform: PlatformType;
  /** 将要调用的方法名（用于调试） */
  method: 'publishVideo' | 'publishImage' | 'publishArticle' | 'publish';
  /** 执行发布 */
  execute(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress>;
}
