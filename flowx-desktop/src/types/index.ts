// 全局类型定义 - 主进程与渲染进程共享

/** 支持的平台（由注册时校验） */
export type PlatformType = string;

/** 已知平台 key 列表（仅用于默认 UI 展示，实际支持以注册表为准） */
export const KNOWN_PLATFORMS: string[] = ['douyin', 'xiaohongshu', 'kuaishou'];

/** 平台元信息 */
export interface PlatformMeta {
  key: PlatformType;
  name: string;
  icon: string;
  /** 授权页面（创作服务平台登录页） */
  authUrl: string;
  /** 发布页面 */
  publishUrl: string;
  /** 后台主页 */
  homeUrl: string;
  /** 发布支持的内容类型 */
  contentTypes: ContentType[];
  /** 账号支持的发布能力 */
  capabilities: AccountCapabilities;
  /** 平台内账号标识的显示名（如"抖音号"/"小红书号"/"快手号"） */
  platformAccountLabel: string;
  /** 授权时 DOM 提取昵称的选择器（按顺序尝试） */
  nicknameSelectors?: string[];
  /** 授权时 DOM 提取头像的选择器（按顺序尝试，取 img 的 src） */
  avatarSelectors?: string[];
  /** 页面已登录的启发式关键字（body 文本中含任意即判为已登录） */
  loginKeywords?: string[];
  /** 平台字数限制（按中文"字符"计算，一个中文/字母/数字/符号均算 1 字） */
  contentLimits?: {
    /** 标题最大字符数（超出将被截断，默认不限制） */
    title?: number;
    /** 正文/描述最大字符数（超出将被截断，默认不限制） */
    content?: number;
  };
}

/** 内容类型 */
export type ContentType = 'video' | 'image' | 'article';

/** 账号支持的发布能力 */
export interface AccountCapabilities {
  publishVideo: boolean;
  publishImage: boolean;
  publishArticle: boolean;
}

/** 账号健康检测配置（主进程与渲染进程共享） */
export interface HealthCheckConfig {
  /** 检测间隔（毫秒） */
  intervalMs: number;
  /** 首次启动延迟（毫秒） */
  initialDelayMs: number;
  /** 是否启用自动检测 */
  enabled: boolean;
}

/** 账号信息（渲染层可见的脱敏版本） */
export interface AccountInfo {
  id: string;
  platform: PlatformType;
  nickname: string;
  avatar?: string;
  /** 平台用户 ID（如小红书 a1） */
  userId?: string;
  /** 抖音号 / 小红书号（平台内展示的账号标识） */
  platformAccountId?: string;
  /** 粉丝数 */
  fansCount?: number;
  /** 关注数 */
  followCount?: number;
  /** 获赞数 */
  likeCount?: number;
  /** 授权时间 */
  authorizedAt: number;
  /** token 过期时间戳（毫秒） */
  expiresAt?: number;
  /** 账号状态 */
  status: 'active' | 'expired' | 'disabled';
  /** 最近一次健康检测的时间戳（毫秒），由 checkAccountHealth 维护 */
  lastChecked?: number;
  /** 备注（可选） */
  remark?: string;
  /** 账号支持的发布能力（根据 platform 推断） */
  capabilities: AccountCapabilities;
}

/** 平台授权凭证（仅主进程可见，加密存储） */
export interface AccountCredential {
  id: string;
  platform: PlatformType;
  /** 从浏览器 cookies/localStorage 里收集的登录态（value 已加密） */
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
    /** 过期时间戳（毫秒），-1 表示 session cookie */
    expirationDate?: number;
  }>;
  /** 用户标识（如 open_id / sec_user_id / 小红书 a1） */
  userId?: string;
  /** 用户名/昵称 */
  nickname: string;
  avatar?: string;
  /** 抖音号 / 小红书号（平台内展示的账号标识） */
  platformAccountId?: string;
  /** 粉丝数 */
  fansCount?: number;
  /** 关注数 */
  followCount?: number;
  /** 获赞数 */
  likeCount?: number;
  /** 原始登录地址 */
  authUrl: string;
  /** 授权时间 */
  authorizedAt: number;
  /** 大致过期时间（heuristic） */
  expiresAt?: number;
  /** 最近一次健康检测的时间戳（毫秒），由 checkAccountHealth 维护 */
  lastChecked?: number;
}

/** 发布内容请求 */
export interface PublishRequest {
  /** 目标账号 id 列表 */
  accountIds: string[];
  /** 内容标题 */
  title: string;
  /** 正文内容（图文/视频描述） */
  content?: string;
  /** 本地文件路径（视频或图片文件，多图时传数组） */
  mediaFiles: string[];
  /** 内容类型 */
  contentType: ContentType;
  /** 话题/标签 */
  tags?: string[];
  /** 定时发布时间（毫秒时间戳），不填则立即发布 */
  scheduledAt?: number;
  /** 备注/草稿名 */
  remark?: string;
}

/** 发布任务状态 */
export type PublishStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'scheduled';

/** 单个账号的发布进度 */
export interface PublishItemProgress {
  accountId: string;
  platform: PlatformType;
  status: PublishStatus;
  progress: number; // 0-100
  message?: string;
  resultUrl?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 发布任务（含多账号进度） */
export interface PublishTask {
  id: string;
  request: PublishRequest;
  items: PublishItemProgress[];
  status: PublishStatus;
  createdAt: number;
  updatedAt: number;
  errorMessage?: string;
}

/** 发布进度查询结果 */
export interface ProgressInfo {
  taskId: string;
  status: PublishStatus;
  items: PublishItemProgress[];
  overallProgress: number;
}

/** 发布日志条目（结构化，方便在 App 内可查看） */
export interface PublishLogEntry {
  /** 时间戳（毫秒） */
  ts: number;
  /** 日志级别 */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** 关联的发布任务 ID（可选） */
  taskId?: string;
  /** 关联的账号 ID（可选） */
  accountId?: string;
  /** 关联的平台（可选） */
  platform?: PlatformType;
  /** 日志阶段标签，如 "submit" | "queue" | "cookie" | "adapter" | "success" | "error" */
  stage?: string;
  /** 主要内容 */
  message: string;
  /** 附加的结构化数据（JSON 可序列化） */
  data?: Record<string, unknown>;
}

/** 日志查询参数 */
export interface PublishLogQuery {
  taskId?: string;
  accountId?: string;
  /** 只看最近多少条（默认 500） */
  limit?: number;
  /** 最小级别（如只看 error） */
  minLevel?: 'info' | 'warn' | 'error';
}

/** 应用版本/系统信息 */
export interface SystemInfo {
  version: string;
  platform: string;
  electronVersion: string;
  appPath: string;
  logsDir: string;
  publishLogPath: string;
  mainLogPath: string;
}

/** 更新信息 */
export interface UpdateInfo {
  available: boolean;
  version?: string;
  releaseNotes?: string;
  downloadUrl?: string;
}
