import http, { IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PublishEngine } from './PublishEngine';
import { AccountService } from './AccountService';
import { PLATFORMS } from './PlatformRegistry';
import { getStore } from '../store/SecureStore';
import { logger } from '../utils/logger';
import type { PublishRequest, ContentType } from '../../types';

export interface ApiServerConfig {
  enabled: boolean;
  port: number;
  apiKey?: string;
}

const DEFAULT_CONFIG: ApiServerConfig = {
  enabled: false,
  port: 37652,
  apiKey: '',
};

/**
 * 对外 HTTP API 服务
 *
 * 提供 REST API 接口，允许外部程序调用一键发布功能：
 * - GET  /api/accounts       获取账号列表
 * - POST /api/publish        提交发布任务，返回任务 ID
 * - GET  /api/publish/:id    查询发布任务状态
 */
export class ApiServer {
  private server: http.Server | null = null;
  private config: ApiServerConfig = { ...DEFAULT_CONFIG };
  private static instance: ApiServer | null = null;

  private constructor() {
    this.loadConfig();
  }

  static getInstance(): ApiServer {
    if (!ApiServer.instance) {
      ApiServer.instance = new ApiServer();
    }
    return ApiServer.instance;
  }

  /**
   * 从存储中加载配置
   */
  private loadConfig(): void {
    const stored = getStore().get('apiServer') as ApiServerConfig | undefined;
    if (stored) {
      this.config = { ...DEFAULT_CONFIG, ...stored };
    }
  }

  /**
   * 保存配置到存储
   */
  saveConfig(config: Partial<ApiServerConfig>): void {
    this.config = { ...this.config, ...config };
    getStore().set('apiServer', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): ApiServerConfig {
    return { ...this.config };
  }

  /**
   * 启动服务（如果配置了启用）
   */
  startIfEnabled(): void {
    if (this.config.enabled) {
      this.start().catch((e) => {
        logger.error(`[ApiServer] 启动失败: ${e.message}`);
      });
    }
  }

  /**
   * 启动 HTTP 服务
   */
  async start(): Promise<void> {
    if (this.server) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error(`[ApiServer] 请求处理错误: ${err.message}`);
          this.sendJson(res, 500, { error: 'Internal Server Error', message: err.message });
        });
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        logger.info(`[ApiServer] HTTP API 服务已启动，端口: ${this.config.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        logger.error(`[ApiServer] 服务错误: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * 停止 HTTP 服务
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('[ApiServer] HTTP API 服务已停止');
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * 重启服务
   */
  async restart(): Promise<void> {
    await this.stop();
    if (this.config.enabled) {
      await this.start();
    }
  }

  /**
   * 检查服务是否运行中
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    // 预检请求
    if (req.method === 'OPTIONS') {
      this.sendJson(res, 204, {});
      return;
    }

    // API Key 验证
    if (this.config.apiKey && this.config.apiKey.length > 0) {
      const apiKey = req.headers['x-api-key'] as string || '';
      if (apiKey !== this.config.apiKey) {
        // 也检查 Authorization: Bearer xxx 格式
        const authHeader = req.headers['authorization'] as string || '';
        const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (bearerKey !== this.config.apiKey) {
          this.sendJson(res, 401, { error: 'Unauthorized', message: '无效的 API Key' });
          return;
        }
      }
    }

    if (!req.url) {
      this.sendJson(res, 400, { error: 'Bad Request', message: '无效的请求 URL' });
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    try {
      // GET /api/accounts - 获取账号列表
      if (pathname === '/api/accounts' && req.method === 'GET') {
        await this.handleGetAccounts(req, res, parsedUrl);
        return;
      }

      // POST /api/publish - 提交发布任务
      if (pathname === '/api/publish' && req.method === 'POST') {
        await this.handlePublish(req, res);
        return;
      }

      // GET /api/publish/:taskId - 查询任务状态
      const publishMatch = pathname.match(/^\/api\/publish\/([^/]+)$/);
      if (publishMatch && req.method === 'GET') {
        await this.handleGetPublishStatus(req, res, publishMatch[1]);
        return;
      }

      // GET /api/health - 健康检查
      if (pathname === '/api/health' && req.method === 'GET') {
        this.sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
        return;
      }

      this.sendJson(res, 404, { error: 'Not Found', message: '接口不存在' });
    } catch (err) {
      logger.error(`[ApiServer] 处理请求异常: ${(err as Error).message}`);
      this.sendJson(res, 500, { error: 'Internal Server Error', message: (err as Error).message });
    }
  }

  /**
   * GET /api/accounts - 获取账号列表
   * 可选查询参数：
   *   - platform: 按平台过滤
   *   - status: 按状态过滤（active/expired/disabled）
   */
  private async handleGetAccounts(
    _req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL,
  ): Promise<void> {
    const accounts = AccountService.listAccounts();
    const platform = parsedUrl.searchParams.get('platform');
    const status = parsedUrl.searchParams.get('status');

    let filtered = accounts;
    if (platform) {
      filtered = filtered.filter((a) => a.platform === platform);
    }
    if (status) {
      filtered = filtered.filter((a) => a.status === status);
    }

    // 获取分类映射
    const categories = AccountService.listCategories();
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    // 脱敏处理，只返回必要字段
    const result = filtered.map((a) => ({
      id: a.id,
      platform: a.platform,
      nickname: a.nickname,
      avatar: a.avatar || '',
      userId: a.userId || '',
      platformAccountId: a.platformAccountId || '',
      fansCount: a.fansCount || 0,
      followCount: a.followCount || 0,
      likeCount: a.likeCount || 0,
      status: a.status,
      remark: a.remark || '',
      categoryIds: a.categoryIds || [],
      categoryNames: (a.categoryIds || []).map((id) => categoryMap.get(id) || '').filter((n) => n),
      envId: a.envId || '',
      capabilities: a.capabilities,
      authorizedAt: a.authorizedAt,
    }));

    this.sendJson(res, 200, {
      code: 0,
      message: 'success',
      data: result,
      total: result.length,
    });
  }

  /**
   * 判断是否是远程 URL（http/https 链接）
   */
  private isRemoteUrl(filePath: string): boolean {
    return /^https?:\/\//i.test(filePath);
  }

  /**
   * 下载远程文件到本地临时目录
   * 返回本地文件路径
   */
  private async downloadRemoteFile(url: string): Promise<string> {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';

    // 从 URL 中提取文件名，如果没有则生成一个
    let fileName = path.basename(parsedUrl.pathname);
    if (!fileName || !path.extname(fileName)) {
      // 没有文件名或扩展名，生成一个带时间戳的文件名
      const ext = this.guessExtensionFromUrl(url);
      fileName = `api_download_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    }

    // 确保临时目录存在
    const tmpDir = path.join(os.tmpdir(), 'flowx-api-downloads');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const localPath = path.join(tmpDir, fileName);

    return new Promise((resolve, reject) => {
      const client = isHttps ? https : http;
      const file = fs.createWriteStream(localPath);

      const request = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 60000,
      }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // 处理重定向
          file.close();
          const redirectUrl = new URL(response.headers.location, url).toString();
          this.downloadRemoteFile(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          reject(new Error(`下载失败，状态码: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          logger.info(`[ApiServer] 文件下载完成: ${url} -> ${localPath}`);
          resolve(localPath);
        });
      });

      request.on('error', (err) => {
        file.close();
        // 清理部分下载的文件
        if (fs.existsSync(localPath)) {
          fs.unlink(localPath, () => {});
        }
        reject(new Error(`下载错误: ${err.message}`));
      });

      request.on('timeout', () => {
        request.destroy();
        file.close();
        if (fs.existsSync(localPath)) {
          fs.unlink(localPath, () => {});
        }
        reject(new Error('下载超时'));
      });
    });
  }

  /**
   * 根据 URL 猜测文件扩展名
   */
  private guessExtensionFromUrl(url: string): string {
    const lowerUrl = url.toLowerCase();
    // 常见的视频格式
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('video/mp4')) return '.mp4';
    if (lowerUrl.includes('.mov')) return '.mov';
    if (lowerUrl.includes('.avi')) return '.avi';
    if (lowerUrl.includes('.mkv')) return '.mkv';
    // 常见的图片格式
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) return '.jpg';
    if (lowerUrl.includes('.png')) return '.png';
    if (lowerUrl.includes('.gif')) return '.gif';
    if (lowerUrl.includes('.webp')) return '.webp';
    if (lowerUrl.includes('.bmp')) return '.bmp';
    // 默认用 .tmp
    return '.tmp';
  }

  /**
   * 处理 mediaFiles，将远程 URL 下载到本地
   * 返回处理后的本地文件路径数组
   */
  private async processMediaFiles(mediaFiles: string[]): Promise<string[]> {
    const results: string[] = [];

    for (const file of mediaFiles) {
      if (this.isRemoteUrl(file)) {
        logger.info(`[ApiServer] 正在下载远程文件: ${file}`);
        const localPath = await this.downloadRemoteFile(file);
        results.push(localPath);
      } else {
        // 本地文件，直接使用
        results.push(file);
      }
    }

    return results;
  }

  /**
   * 根据平台限制验证发布内容
   * 返回错误信息数组，为空表示验证通过
   */
  private validatePublishContent(
    accountIds: string[],
    title: string,
    content: string | undefined,
    contentType: ContentType,
  ): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 收集所有涉及的平台
    const platforms = new Set<string>();
    for (const id of accountIds) {
      const acc = AccountService.getAccount(id);
      if (acc) {
        platforms.add(acc.platform);
      }
    }

    // 逐个平台验证
    for (const platformKey of platforms) {
      const meta = PLATFORMS[platformKey];
      if (!meta) continue;

      const platformName = meta.name || platformKey;

      // 根据内容类型获取限制
      let titleLimit: number | undefined;
      let contentLimit: number | undefined;
      let minContent: number | undefined;

      if (contentType === 'article' && meta.articleLimits) {
        titleLimit = meta.articleLimits.title;
        contentLimit = meta.articleLimits.content;
        minContent = meta.articleLimits.minContent;
      } else if (meta.contentLimits) {
        titleLimit = meta.contentLimits.title;
        contentLimit = meta.contentLimits.content;
      }

      // 验证标题长度
      if (titleLimit !== undefined && title.length > titleLimit) {
        errors.push(
          `${platformName}标题不能超过 ${titleLimit} 字，当前 ${title.length} 字`,
        );
      }

      // 验证正文长度（最大限制）
      if (contentLimit !== undefined && content && content.length > contentLimit) {
        errors.push(
          `${platformName}正文/描述不能超过 ${contentLimit} 字，当前 ${content.length} 字`,
        );
      }

      // 验证正文最小长度（文章类型）
      if (minContent !== undefined && contentType === 'article') {
        const contentLen = content ? content.length : 0;
        if (contentLen < minContent) {
          errors.push(
            `${platformName}文章正文不能少于 ${minContent} 字，当前 ${contentLen} 字`,
          );
        }
      }

      // 验证账号是否支持该内容类型
      for (const id of accountIds) {
        const acc = AccountService.getAccount(id);
        if (acc && acc.platform === platformKey) {
          const canPublish =
            (contentType === 'video' && acc.capabilities.publishVideo) ||
            (contentType === 'image' && acc.capabilities.publishImage) ||
            (contentType === 'article' && acc.capabilities.publishArticle);
          if (!canPublish) {
            errors.push(
              `账号 "${acc.nickname}" (${platformName}) 不支持发布${
                contentType === 'video' ? '视频' : contentType === 'image' ? '图文' : '文章'
              }`,
            );
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * POST /api/publish - 提交发布任务
   * 请求体（JSON）：
   *   - accountIds: string[]    目标账号 ID 列表（必填）
   *   - title: string           标题（必填）
   *   - content?: string        正文/描述
   *   - mediaFiles: string[]    媒体文件路径列表（必填）
   *   - contentType: string     内容类型：video/image/article（必填）
   *   - tags?: string[]         话题标签
   *   - scheduledAt?: number    定时发布时间戳（毫秒）
   *   - remark?: string         备注/草稿名
   *   - coverImage?: string     封面图路径
   */
  private async handlePublish(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);

    // 基本参数校验
    if (!body.accountIds || !Array.isArray(body.accountIds) || body.accountIds.length === 0) {
      this.sendJson(res, 400, { code: 400, message: 'accountIds 不能为空且必须是数组' });
      return;
    }
    if (!body.title || typeof body.title !== 'string') {
      this.sendJson(res, 400, { code: 400, message: 'title 不能为空' });
      return;
    }
    if (!body.mediaFiles || !Array.isArray(body.mediaFiles) || body.mediaFiles.length === 0) {
      this.sendJson(res, 400, { code: 400, message: 'mediaFiles 不能为空且必须是数组' });
      return;
    }
    if (!body.contentType || !['video', 'image', 'article'].includes(body.contentType)) {
      this.sendJson(res, 400, { code: 400, message: 'contentType 必须是 video、image 或 article' });
      return;
    }

    // 验证账号是否存在
    const validAccountIds: string[] = [];
    for (const id of body.accountIds) {
      const acc = AccountService.getAccount(id);
      if (acc && acc.status === 'active') {
        validAccountIds.push(id);
      }
    }

    if (validAccountIds.length === 0) {
      this.sendJson(res, 400, { code: 400, message: '没有有效的账号（账号不存在或状态异常）' });
      return;
    }

    // 验证内容是否符合各平台限制
    const validation = this.validatePublishContent(
      validAccountIds,
      body.title,
      body.content,
      body.contentType as ContentType,
    );
    if (!validation.valid) {
      this.sendJson(res, 400, {
        code: 400,
        message: '内容验证失败',
        errors: validation.errors,
      });
      return;
    }

    // 处理 mediaFiles：下载远程文件到本地
    let processedMediaFiles: string[];
    try {
      processedMediaFiles = await this.processMediaFiles(body.mediaFiles);
    } catch (err) {
      this.sendJson(res, 400, {
        code: 400,
        message: '媒体文件下载失败: ' + (err as Error).message,
      });
      return;
    }

    // 处理 coverImage：如果是远程 URL 也下载
    let processedCoverImage: string | undefined;
    if (body.coverImage) {
      try {
        const coverFiles = await this.processMediaFiles([body.coverImage]);
        processedCoverImage = coverFiles[0];
      } catch (err) {
        this.sendJson(res, 400, {
          code: 400,
          message: '封面图下载失败: ' + (err as Error).message,
        });
        return;
      }
    }

    // 构造发布请求
    const request: PublishRequest = {
      accountIds: validAccountIds,
      title: body.title,
      content: body.content,
      mediaFiles: processedMediaFiles,
      contentType: body.contentType as ContentType,
      tags: body.tags,
      scheduledAt: body.scheduledAt,
      remark: body.remark || 'API 发布',
      coverImage: processedCoverImage,
    };

    // 提交任务
    const taskId = PublishEngine.submit(request);

    logger.info(`[ApiServer] 发布任务已创建: ${taskId}，账号数: ${validAccountIds.length}`);

    this.sendJson(res, 200, {
      code: 0,
      message: '发布任务创建成功',
      data: {
        taskId,
        accountCount: validAccountIds.length,
        skippedAccounts: body.accountIds.length - validAccountIds.length,
      },
    });
  }

  /**
   * GET /api/publish/:taskId - 查询发布任务状态
   */
  private async handleGetPublishStatus(
    _req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): Promise<void> {
    const { task } = PublishEngine.getTaskDetail(taskId);

    if (!task) {
      this.sendJson(res, 404, { code: 404, message: '任务不存在' });
      return;
    }

    const progress = PublishEngine.getProgress(taskId);

    this.sendJson(res, 200, {
      code: 0,
      message: 'success',
      data: {
        taskId: task.id,
        status: task.status,
        overallProgress: progress?.overallProgress ?? (task.status === 'success' ? 100 : task.status === 'failed' ? 100 : 0),
        title: task.request?.title || '',
        contentType: task.request?.contentType || '',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        errorMessage: task.errorMessage || '',
        totalAccounts: task.items.length,
        successCount: task.items.filter((i) => i.status === 'success').length,
        failedCount: task.items.filter((i) => i.status === 'failed').length,
        runningCount: task.items.filter((i) => i.status === 'running').length,
        pendingCount: task.items.filter((i) => i.status === 'queued' || i.status === 'scheduled').length,
        cancelledCount: task.items.filter((i) => i.status === 'cancelled').length,
        items: task.items.map((item) => ({
          accountId: item.accountId,
          platform: item.platform,
          status: item.status,
          progress: item.progress,
          message: item.message || '',
          resultUrl: item.resultUrl || '',
          startedAt: item.startedAt || null,
          finishedAt: item.finishedAt || null,
        })),
      },
    });
  }

  /**
   * 解析 JSON 请求体
   */
  private parseJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 10 * 1024 * 1024) {
          // 限制 10MB
          reject(new Error('请求体过大'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON 解析失败'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * 发送 JSON 响应
   */
  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  }
}
