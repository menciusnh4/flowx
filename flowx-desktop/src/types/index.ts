// 全局类型定义 - 主进程与渲染进程共享

/** 支持的平台（由注册时校验） */
export type PlatformType = string;

/** 已知平台 key 列表（仅用于默认 UI 展示，实际支持以注册表为准） */
export const KNOWN_PLATFORMS: string[] = ['douyin', 'xiaohongshu', 'kuaishou', 'wechat_channels', 'wechat_official', 'zhihu', 'toutiao'];

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
  /** 文章发布的字数限制（独立于图文/视频） */
  articleLimits?: {
    /** 文章标题最大字符数（超出将被截断，默认不限制） */
    title?: number;
    /** 文章正文最大字符数（undefined 表示不限制，超出将被截断） */
    content?: number;
    /** 文章正文最小字符数（发布前验证，不足则提示用户） */
    minContent?: number;
    /** 文章摘要/简介最大字符数（超出将被截断，默认不限制） */
    summary?: number;
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
  /** 账号所属分类的 id 列表 */
  categoryIds?: string[];
  /** 账号绑定的浏览器环境配置 id */
  envId?: string | null;
  /** 账号支持的发布能力（根据 platform 推断） */
  capabilities: AccountCapabilities;
}

/** 账号分类 */
export interface AccountCategory {
  id: string;
  name: string;
  createdAt: number;
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
  /** 账号所属分类的 id 列表 */
  categoryIds?: string[];
  /** 账号绑定的浏览器环境配置 id */
  envId?: string | null;
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
  /** 封面图片路径（视频发布可选，文章发布抖音必填） */
  coverImage?: string;
  /** 分类（部分平台需要） */
  category?: string;
  /** 文章摘要/简介（仅文章发布时使用，各平台按需填充到对应字段） */
  summary?: string;
  /** 测试模式：不真的点击发布按钮，仅验证表单填写是否正常 */
  testMode?: boolean;
  /**
   * 正文输入模式（仅文章发布时使用）
   * - 'text': 纯文本（默认），直接填写到编辑器
   * - 'markdown': Markdown 模式，生成 .md 文件后通过平台文档导入功能上传
   */
  contentMode?: 'text' | 'markdown';
  /**
   * Markdown 源码（contentMode === 'markdown' 时使用）
   * 发布时将生成 .md 临时文件，通过平台的文档导入功能上传
   */
  markdownContent?: string;
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
  /** 测试模式结果 */
  testResult?: PublishTestResult;
}

/** 发布测试结果 */
export interface PublishTestResult {
  /** 标题是否填写成功 */
  titleFilled: boolean;
  /** 文章摘要是否填写成功（仅文章发布） */
  summaryFilled?: boolean;
  /** 内容/正文是否填写成功 */
  contentFilled: boolean;
  /** 标签/话题是否填写成功 */
  tagsFilled: boolean;
  /** 封面是否上传成功 */
  coverUploaded: boolean;
  /** 是否找到发布按钮 */
  publishButtonFound: boolean;
  /** 发布按钮位置信息（用于高亮显示） */
  publishButtonInfo?: {
    text: string;
    selector: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 检测到的表单字段列表 */
  formFields?: {
    type: string;
    label: string;
    filled: boolean;
    selector?: string;
  }[];
  /** 备注信息 */
  note?: string;
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

/** 发布草稿（保存未发布的内容，随时继续编辑） */
export interface PublishDraft {
  id: string;
  title: string;
  contentType: ContentType;
  formData: {
    title: string;
    content: string;
    tagsRaw: string;
    mediaFiles: string[];
    coverImage: string;
    selectedAccountIds: string[];
    publishTimeType: 'now' | 'scheduled';
    scheduledTime: number | null;
  };
  /** 来源网页 URL（从浏览器提取的草稿有此字段） */
  sourceUrl?: string;
  /** 来源网站名称 */
  sourceSite?: string;
  /** 封面预览图路径（用于列表缩略图） */
  coverPreview?: string;
  /** 正文字数（列表展示用） */
  wordCount: number;
  createdAt: number;
  updatedAt: number;
  status: 'draft' | 'published';
}

/** 发布进度查询结果 */
export interface ProgressInfo {
  taskId: string;
  status: PublishStatus;
  items: PublishItemProgress[];
  overallProgress: number;
}

/** 分页查询结果 */
export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 发布统计信息（轻量级，不加载完整任务列表） */
export interface PublishStats {
  /** 总任务数 */
  total: number;
  /** 今日成功数 */
  todaySuccess: number;
  /** 运行中任务数 */
  running: number;
  /** 失败任务数 */
  failed: number;
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

/** 代理 IP 配置 */
export interface ProxyConfig {
  id: string;
  name: string;
  type: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  createdAt: number;
}

/** 代理 IP 测试结果 */
export interface ProxyTestResult {
  ok: boolean;
  /** 延迟（毫秒），失败时为 -1 */
  latency: number;
  /** 测试的目标 URL */
  targetUrl: string;
  /** 失败原因 */
  error?: string;
  /** 返回的 IP 地址（如果能获取到） */
  outboundIp?: string;
}

/** 浏览器环境配置 */
export interface BrowserEnvironment {
  id: string;
  name: string;
  userAgent: string;
  proxyId?: string | null;
  createdAt: number;
}

/** 浏览器收藏夹 */
export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  /** 网站名称/域名（便于展示） */
  siteName?: string;
  /** 文件夹 ID，undefined 表示根目录 */
  folderId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 浏览器收藏夹文件夹 */
export interface BrowserBookmarkFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
}

/** 浏览器历史记录 */
export interface BrowserHistoryItem {
  id: string;
  url: string;
  title: string;
  /** 访问时间戳（毫秒） */
  visitTime: number;
  /** 来源标签页 ID（可选，用于追踪） */
  viewId?: string;
}

/** 提取的图片信息 */
export interface ExtractedImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  aspectRatio: number;
  caption?: string;
  position: number;
  isLikelyContent: boolean;
}

/** 内容提取结果 */
export interface ExtractedContent {
  title: string;
  /** HTML 格式内容（已清理） */
  content: string;
  /** 纯文本（已清理格式） */
  textContent: string;
  /** 摘要（前 200 字） */
  excerpt: string;
  /** 作者/来源 */
  byline: string;
  /** 正文字数 */
  length: number;
  /** 站点名称 */
  siteName: string;
  /** 页面 URL */
  pageUrl: string;
  /** 提取到的图片列表（已过滤） */
  images: ExtractedImage[];
  /** 提取策略 */
  extractStrategy?: 'auto' | 'manual' | 'readability' | 'site-rule' | 'custom-rule';
  /** 置信度评分 0-100 */
  confidence?: number;
  /** 是否仅提取了图片（无文本内容） */
  isImageOnly?: boolean;
  /** 话题/标签列表 */
  tags?: string[];
  /** 自定义规则 ID（规则提取时填充） */
  ruleId?: string;
}

// ========== 自定义站点规则 ==========

/** 规则匹配方式 */
export type RuleMatchType = 'domain' | 'regex';

/** 发布类型（用于规则匹配和右键菜单排序） */
export type PublishContentType = 'image-text' | 'video' | 'article';

/** 自定义站点规则 */
export interface CustomSiteRule {
  /** 规则唯一 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;

  // ===== 匹配规则 =====
  /** 匹配方式：domain（域名包含） / regex（正则表达式） */
  matchType: RuleMatchType;
  /** 匹配值：domain 模式下是域名字符串，regex 模式下是正则表达式字符串 */
  matchValue: string;
  /** 路径匹配（可选，进一步限制路径范围） */
  pathPattern?: string;
  /**
   * 适用的发布类型（可多选）
   * 为空数组表示适用于所有类型
   */
  contentTypes: PublishContentType[];

  // ===== 提取规则 =====
  /** 标题选择器（CSS 选择器，可为空） */
  titleSelector?: string;
  /** 正文选择器（CSS 选择器，必填） */
  contentSelector: string;
  /** 作者/来源选择器（可选） */
  bylineSelector?: string;
  /** 发布时间选择器（可选） */
  dateSelector?: string;
  /** 站点名称（可选，不填则自动从页面获取） */
  siteName?: string;
  /** 图片选择器（可选，不填则从正文内自动查找） */
  imageSelector?: string;
  /** 话题/标签选择器（可选，提取文章的话题标签列表） */
  tagsSelector?: string;
  /** 需要移除的噪音元素选择器列表 */
  removeSelectors: string[];

  // ===== 元数据 =====
  /** 规则备注/说明 */
  remark?: string;
  /** 规则来源：manual（手动创建）/ quick-save（一键保存）/ import（导入） */
  source: 'manual' | 'quick-save' | 'import';
  /** 使用次数统计 */
  useCount: number;
  /** 最后使用时间 */
  lastUsedAt?: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** 拾取器字段类型 */
export type PickerFieldType =
  | 'title'
  | 'content'
  | 'image'
  | 'tags'
  | 'byline'
  | 'date'
  | 'remove';

/** 拾取器结果 */
export interface PickerResult {
  /** 拾取的字段类型 */
  pickerType: PickerFieldType;
  /** 生成的 CSS 选择器 */
  selector: string;
  /** 拾取模式 */
  mode: 'single' | 'multi';
  /** 选中的元素数量 */
  selectedCount: number;
  /** 多选模式下推断选择器匹配的元素数 */
  matchCount?: number;
  /** 元素文本预览 */
  previewText?: string;
}

/** 草稿规则（快速拾取时的临时状态） */
export interface RuleDraft {
  name: string;
  matchType: 'domain';
  matchValue: string;
  contentTypes: PublishContentType[];
  titleSelector?: string;
  contentSelector?: string;
  bylineSelector?: string;
  dateSelector?: string;
  imageSelector?: string;
  tagsSelector?: string;
  removeSelectors: string[];
  /** 拾取会话是否进行中 */
  pickerSessionActive: boolean;
  /** 最后一次拾取的字段类型 */
  lastPickerType?: PickerFieldType;
}

/** 规则测试结果 */
export interface RuleTestResult {
  success: boolean;
  title?: string;
  contentLength?: number;
  imageCount?: number;
  tags?: string[];
  error?: string;
  preview?: {
    title: string;
    excerpt: string;
    imageCount: number;
  };
}

// ==================== 账号分析模块类型 ====================

/** 作品基础信息 */
export interface WorkItem {
  /** 作品唯一 ID（平台内部 ID） */
  id: string;
  /** 所属平台 */
  platform: PlatformType;
  /** 所属账号 ID */
  accountId: string;
  /** 作品标题 */
  title: string;
  /** 封面图 URL（可选） */
  coverUrl?: string;
  /** 内容类型 */
  contentType: ContentType;
  /** 发布时间戳（毫秒） */
  publishTime: number;
  /** 作品详情页 URL（用于跳转） */
  detailUrl?: string;
  /** 作品时长（秒，视频类） */
  duration?: number;
  /** 首次采集时间 */
  firstCollectedAt: number;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

/** 作品数据指标 */
export interface WorkMetrics {
  /** 快照唯一 ID */
  id: string;
  /** 关联作品 ID */
  workId: string;
  /** 所属账号 ID */
  accountId: string;
  /** 所属平台 */
  platform: PlatformType;
  /** 播放量/阅读量/浏览量 */
  views: number;
  /** 点赞数 */
  likes: number;
  /** 评论数 */
  comments: number;
  /** 收藏数 */
  favorites: number;
  /** 转发/分享数 */
  shares: number;
  /** 完播率（百分比，0-100，视频平台特有） */
  completionRate?: number;
  /** 平均播放时长（秒） */
  avgPlayDuration?: number;
  /** 新增粉丝数（该作品带来的） */
  newFans?: number;
  /** 曝光量/展现量 */
  impressions?: number;
  /** 点击率 = 播放/曝光（百分比） */
  clickRate?: number;
  /** 互动率 = (赞+评+藏+转)/播放（百分比） */
  interactionRate?: number;
  /** 转粉率 = 新增粉丝/播放（百分比） */
  fanConversionRate?: number;
  /** 采集时间戳 */
  collectedAt: number;
}

/** 账号时间序列统计快照（按天聚合） */
export interface AccountStatsSnapshot {
  /** 快照唯一 ID */
  id: string;
  /** 账号 ID */
  accountId: string;
  /** 统计日期（YYYY-MM-DD） */
  date: string;
  /** 粉丝总数（当日末） */
  fansCount: number;
  /** 关注数 */
  followCount?: number;
  /** 总获赞数 */
  totalLikeCount?: number;
  /** 当日新增粉丝 */
  newFans?: number;
  /** 当日总播放/阅读量 */
  totalViews?: number;
  /** 当日总互动数（赞+评+藏+转） */
  totalInteractions?: number;
  /** 当日发布作品数 */
  worksPublished?: number;
  /** 当日平均完播率 */
  avgCompletionRate?: number;
  /** 当日平均互动率 */
  avgInteractionRate?: number;
  /** 采集时间戳 */
  collectedAt: number;
}

/** 单作品诊断结果 */
export interface WorkDiagnosis {
  /** 关联作品 ID */
  workId: string;
  /** 综合评分（0-100） */
  overallScore: number;
  /** 各维度评分 */
  dimensionScores: {
    hook: number;
    content: number;
    engagement: number;
    conversion: number;
    clickThrough: number;
  };
  /** 问题列表 */
  issues: Array<{
    type: 'hook' | 'content' | 'engagement' | 'conversion' | 'clickThrough';
    severity: 'low' | 'medium' | 'high';
    title: string;
    description: string;
    metric?: {
      name: string;
      value: number;
      benchmark: number;
      unit?: string;
    };
  }>;
  /** 优化建议列表 */
  suggestions: Array<{
    priority: 'high' | 'medium' | 'low';
    title: string;
    detail: string;
    actionableStep?: string;
  }>;
  /** 生成时间 */
  generatedAt: number;
  /** 诊断引擎版本 */
  engineVersion: string;
}

/** 对标账号配置 */
export interface BenchmarkAccount {
  /** 本地唯一 ID */
  id: string;
  /** 所属主账号 ID（谁的对标） */
  ownerAccountId: string;
  /** 对标账号平台 */
  platform: PlatformType;
  /** 对标账号的平台主页 URL */
  profileUrl: string;
  /** 对标账号名称 */
  name: string;
  /** 对标账号头像 URL */
  avatar?: string;
  /** 对标账号的平台用户 ID */
  platformUserId?: string;
  /** 对标类型：直接竞品/潜在竞品/行业标杆 */
  type: 'direct' | 'potential' | 'benchmark';
  /** 自定义备注 */
  remark?: string;
  /** 最近一次采集时间 */
  lastCollectedAt?: number;
  /** 创建时间 */
  createdAt: number;
  /** 启用状态 */
  enabled: boolean;
}

/** 对标账号数据快照（公开数据） */
export interface BenchmarkSnapshot {
  id: string;
  benchmarkId: string;
  fansCount: number;
  worksCount: number;
  totalLikes?: number;
  recentWorks: Array<{
    workId: string;
    title: string;
    coverUrl?: string;
    publishTime: number;
    likes: number;
    comments: number;
    favorites?: number;
    views?: number;
  }>;
  collectedAt: number;
}

/** 行业基准数据 */
export interface IndustryBenchmark {
  platform: PlatformType;
  fanRange: '0-1k' | '1k-10k' | '10k-100k' | '100k-1M' | '1M+';
  contentType: ContentType;
  completionRate: {
    excellent: number;
    good: number;
    warning: number;
  };
  interactionRate: {
    excellent: number;
    good: number;
    warning: number;
  };
  clickRate: {
    excellent: number;
    good: number;
    warning: number;
  };
  fanConversionRate: {
    excellent: number;
    good: number;
    warning: number;
  };
}

/** 账号分析配置 */
export interface AnalyticsConfig {
  /** 是否启用自动采集 */
  autoCollectEnabled: boolean;
  /** 自动采集间隔（小时） */
  autoCollectIntervalHours: number;
  /** 同时最大采集任务数 */
  maxConcurrentCollects: number;
  /** 采集窗口空闲关闭时间（分钟） */
  collectWindowIdleCloseMinutes: number;
  /** 作品采集上限（每次采集的作品数） */
  workCollectLimit: number;
  /** LLM API 配置 */
  llmConfig?: {
    provider: string;
    apiKey?: string;
    apiBase?: string;
    model?: string;
    enabled: boolean;
  };
}

/** 全量采集参数 */
export interface CollectAllParams {
  accountId: string;
  /** 是否强制全量采集（false = 增量模式） */
  forceFull?: boolean;
  /** 作品数量上限 */
  workLimit?: number;
}

/** 全量采集结果 */
export interface CollectAllResult {
  taskId: string;
  status: 'running' | 'success' | 'failed';
  /** 已采集作品数 */
  collectedCount: number;
  /** 总作品数（预估） */
  totalCount?: number;
  /** 错误信息（失败时） */
  error?: string;
}

/** 采集进度事件 */
export interface CollectProgressEvent {
  taskId: string;
  phase: 'overview' | 'works' | 'detail';
  current: number;
  total: number;
  message?: string;
}

/** 采集任务 */
export interface CollectTask {
  id: string;
  accountId: string;
  platform: PlatformType;
  type: 'overview' | 'works' | 'all';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** 采集进度（详细） */
export interface CollectProgress {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  currentStage: string;
  collectedCount: number;
  totalCount: number;
  error?: string;
}

/** 采集任务结果 */
export interface CollectTaskResult {
  taskId: string;
  success: boolean;
  collectedCount: number;
  overview?: {
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  };
  collectedAt: number;
  error?: string;
}

/** 分页结果 */
export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 作品诊断参数 */
export interface DiagnoseWorkParams {
  accountId: string;
  workId: string;
  /** 是否使用 LLM 增强 */
  useLLM?: boolean;
}

/** 对标对比参数 */
export interface CompareParams {
  ownerAccountId: string;
  benchmarkIds: string[];
  /** 对比维度 */
  dimensions?: string[];
  /** 时间范围 */
  timeRange?: '7d' | '30d' | '90d' | 'all';
}

/** 对标对比结果 */
export interface CompareResult {
  accounts: Array<{
    id: string;
    name: string;
    avatar?: string;
    isOwner: boolean;
  }>;
  metrics: Array<{
    key: string;
    name: string;
    values: Record<string, number | string>;
    unit?: string;
  }>;
  trendData: Array<{
    date: string;
    values: Record<string, number>;
  }>;
  topWorks: Array<{
    rank: number;
    works: Record<string, { title: string; value: number; metric: string }>;
  }>;
}

/** 作品列表查询参数 */
export interface WorksQueryParams {
  accountId: string;
  page?: number;
  pageSize?: number;
  /** 排序字段 */
  sortBy?: 'publishTime' | 'views' | 'likes' | 'comments' | 'favorites' | 'completionRate' | 'interactionRate';
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
  /** 内容类型筛选 */
  contentType?: ContentType;
  /** 时间范围（开始时间戳） */
  startTime?: number;
  /** 时间范围（结束时间戳） */
  endTime?: number;
  /** 关键词搜索（标题） */
  keyword?: string;
}
