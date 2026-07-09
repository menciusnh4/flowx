import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { BrowserEnvService } from './BrowserEnvService';

/**
 * 下载图片到本地临时目录
 * 返回下载后的本地文件路径列表
 */
export async function downloadImages(
  imageUrls: string[],
  options?: {
    envId?: string | null;
    maxCount?: number;
    timeoutMs?: number;
  }
): Promise<string[]> {
  const maxCount = options?.maxCount ?? 9; // 最多下载 9 张
  const timeoutMs = options?.timeoutMs ?? 10000; // 单张超时 10s

  // 确保临时目录存在
  const tempDir = path.join(app.getPath('userData'), 'temp_images');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 清理旧文件（保留最近 1 小时的）
  cleanupOldFiles(tempDir);

  const urlsToDownload = imageUrls.slice(0, maxCount);
  const results: string[] = [];

  // 串行下载（避免并发过多）
  for (let i = 0; i < urlsToDownload.length; i++) {
    const url = urlsToDownload[i];
    try {
      const localPath = await downloadSingleImage(url, tempDir, i, timeoutMs, options?.envId);
      if (localPath) {
        results.push(localPath);
      }
    } catch (e) {
      console.warn(`[ImageDownloader] 下载失败: ${url}`, e);
    }
  }

  return results;
}

/**
 * 下载单张图片
 */
function downloadSingleImage(
  url: string,
  saveDir: string,
  index: number,
  timeoutMs: number,
  envId?: string | null
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';

      // 从 URL 提取扩展名
      let ext = path.extname(parsedUrl.pathname).slice(1).toLowerCase();
      if (!ext || !['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
        ext = 'jpg'; // 默认 jpg
      }

      const filename = `img_${Date.now()}_${index}.${ext}`;
      const filePath = path.join(saveDir, filename);

      const requestOptions: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': parsedUrl.origin + '/',
        },
      };

      const requester = isHttps ? https : http;

      const req = requester.request(requestOptions, (res) => {
        // 处理重定向
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            downloadSingleImage(redirectUrl, saveDir, index, timeoutMs, envId).then(resolve);
            return;
          }
        }

        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }

        // 检查 Content-Type 是否为图片
        const contentType = res.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          resolve(null);
          return;
        }

        const fileStream = fs.createWriteStream(filePath);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          // 检查文件大小，太小的可能不是有效图片
          try {
            const stats = fs.statSync(filePath);
            if (stats.size < 100) { // 小于 100 字节忽略
              fs.unlinkSync(filePath);
              resolve(null);
            } else {
              resolve(filePath);
            }
          } catch {
            resolve(null);
          }
        });

        fileStream.on('error', () => {
          try { fs.unlinkSync(filePath); } catch {}
          resolve(null);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.on('error', () => {
        resolve(null);
      });

      req.end();
    } catch (e) {
      console.warn('[ImageDownloader] request error:', e);
      resolve(null);
    }
  });
}

/**
 * 清理临时目录中超过 1 小时的文件
 */
function cleanupOldFiles(dir: string): void {
  try {
    const now = Date.now();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 60 * 60 * 1000) { // 1 小时
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}
