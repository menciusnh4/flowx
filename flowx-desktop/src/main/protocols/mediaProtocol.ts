import { protocol } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * 自定义媒体协议：flowx-media://
 *
 * 用于渲染进程内 <video>/<img> 预览本地媒体文件，而不把整个文件读进渲染进程内存
 * （视频几十~几百 MB 会爆堆）。主进程以流式 ReadableStream 喂给 <video>，浏览器边下边播。
 *
 * 为什么不用 file:// 或 objectURL：
 *   - 主窗口 webSecurity:true 不可关，且 dev 下渲染进程是 localhost、与 file:// 跨源被 CSP 拦截；
 *   - objectURL 需把整视频读进渲染进程内存，内存治理目标冲突。
 * 这是 Electron 官方推荐的 file:// 替代方案（与既有 TAB_BAR_PROTOCOL 同一思路）。
 *
 * 安全：仅放行「绝对路径 + 媒体扩展名白名单 + 文件存在」的本地文件。
 *   用户所选媒体保留在原始位置（桌面/下载/D 盘任意处），故白名单不能用固定目录
 *   （否则预览 404）；改用扩展名白名单即可杜绝 /etc/passwd 这类非媒体文件读取。
 */

export const MEDIA_PROTOCOL = 'flowx-media'

/** 媒体扩展名白名单：协议只服务这些类型，从根上杜绝任意文件泄露 */
const ALLOWED_EXT = new Set<string>([
  // 视频
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v',
  // 音频（图文/视频附带的音频预览预留）
  '.mp3', '.wav', '.ogg', '.m4a',
  // 图片
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
])

const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

function mimeOf(p: string): string {
  return MIME_MAP[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/** 从 flowx-media://<encoded-path> 还原本地绝对路径 */
function parseFilePath(reqUrl: string): string {
  const m = reqUrl.match(/^flowx-media:\/\/(.+)$/s)
  if (!m) return ''
  // 渲染进程用 encodeURIComponent 编码整条绝对路径，这里还原
  return decodeURIComponent(m[1])
}

export function registerMediaProtocol(): void {
  if ((protocol as { isProtocolHandled?: (s: string) => boolean }).isProtocolHandled?.(MEDIA_PROTOCOL)) {
    return
  }
  protocol.handle(MEDIA_PROTOCOL, (request) => {
    try {
      const filePath = parseFilePath(request.url)
      const ext = path.extname(filePath).toLowerCase()

      // 安全闸门：非绝对路径 / 非媒体扩展名 / 文件不存在 / 不是普通文件 → 404
      if (
        !path.isAbsolute(filePath) ||
        !ALLOWED_EXT.has(ext) ||
        !fs.existsSync(filePath) ||
        !fs.statSync(filePath).isFile()
      ) {
        return new Response('Not Found', { status: 404 })
      }

      // Node ReadStream → Web ReadableStream（Electron 的 Response 支持 web stream body）
      const stream = fs.createReadStream(filePath)
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.on('data', (chunk: Buffer | string) =>
            controller.enqueue(typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk)) : new Uint8Array(chunk)),
          )
          stream.on('end', () => controller.close())
          stream.on('error', (err) => controller.error(err))
        },
        cancel() {
          stream.destroy()
        },
      })

      return new Response(webStream, {
        headers: {
          'Content-Type': mimeOf(filePath),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Error', { status: 500 })
    }
  })
}
