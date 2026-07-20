import { session } from 'electron';
import { listAllBookmarks } from './BrowserHistoryService';

const NEWTAB_PROTOCOL = 'flowx-newtab';
const NEWTAB_HOST = 'page';

let protocolRegistered = false;

/**
 * 注册新标签页自定义协议
 * 必须在 app.whenReady() 之后调用
 */
export function registerNewTabProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;

  // 在浏览器会话中注册协议（BrowserView 使用的是 persist:flowx_browser 分区）
  const sess = session.fromPartition('persist:flowx_browser');
  sess.protocol.handle(NEWTAB_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname === NEWTAB_HOST) {
      const html = await generateNewTabHtml();
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  });
}

/**
 * 获取新标签页 URL
 */
export function getNewTabUrl(): string {
  return `${NEWTAB_PROTOCOL}://${NEWTAB_HOST}`;
}

/**
 * 生成新标签页 HTML（服务端注入收藏夹数据）
 */
async function generateNewTabHtml(): Promise<string> {
  // 从服务端获取收藏夹数据，直接注入到 HTML 中
  let bookmarks: Array<{ title: string; url: string; favicon: string }> = [];
  try {
    const allBookmarks = await listAllBookmarks();
    bookmarks = allBookmarks.slice(0, 24).map((bm) => {
      let favicon = '';
      try {
        const hostname = new URL(bm.url).hostname;
        favicon = hostname.charAt(0).toUpperCase();
      } catch {
        favicon = bm.title.charAt(0).toUpperCase();
      }
      return { title: bm.title, url: bm.url, favicon };
    });
  } catch {
    // 忽略错误，显示空状态
  }

  const bookmarksHtml = bookmarks.length > 0
    ? bookmarks.map((bm) => `
        <a href="#" class="bookmark-item" data-url="${escapeHtml(bm.url)}" title="${escapeHtml(bm.title)}">
          <div class="bookmark-favicon">${bm.favicon}</div>
          <div class="bookmark-title">${escapeHtml(bm.title)}</div>
        </a>
      `).join('')
    : `
      <div class="empty-state">
        <div class="icon">📭</div>
        <div class="text">暂无收藏，快去收藏喜欢的网站吧</div>
      </div>
    `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>新标签页</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 60px 20px 40px;
    color: #fff;
  }
  .logo {
    font-size: 48px;
    font-weight: 700;
    margin-bottom: 8px;
    letter-spacing: 2px;
  }
  .subtitle {
    font-size: 14px;
    opacity: 0.8;
    margin-bottom: 40px;
  }
  .search-box {
    width: 100%;
    max-width: 600px;
    margin-bottom: 50px;
  }
  .search-input-wrap {
    display: flex;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 50px;
    padding: 6px 6px 6px 24px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    transition: box-shadow 0.2s;
  }
  .search-input-wrap:focus-within {
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.25);
  }
  .search-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: 16px;
    background: transparent;
    color: #333;
    padding: 12px 0;
  }
  .search-btn {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border: none;
    padding: 12px 32px;
    border-radius: 50px;
    font-size: 15px;
    cursor: pointer;
    font-weight: 500;
    transition: opacity 0.2s;
  }
  .search-btn:hover { opacity: 0.9; }
  .bookmarks-section {
    width: 100%;
    max-width: 900px;
    flex: 1;
  }
  .section-title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title .icon { font-size: 20px; }
  .bookmarks-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 16px;
  }
  .bookmark-item {
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    padding: 16px 12px;
    cursor: pointer;
    text-align: center;
    transition: all 0.2s;
    text-decoration: none;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .bookmark-item:hover {
    background: rgba(255, 255, 255, 0.25);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  }
  .bookmark-favicon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    font-weight: 600;
    color: #667eea;
  }
  .bookmark-title {
    font-size: 13px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-all;
  }
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    opacity: 0.7;
  }
  .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
  .empty-state .text { font-size: 14px; }
  .footer {
    margin-top: 30px;
    font-size: 12px;
    opacity: 0.5;
  }
</style>
</head>
<body>
  <div class="logo">FlowX</div>
  <div class="subtitle">高效内容创作助手</div>

  <div class="search-box">
    <form id="searchForm" class="search-input-wrap">
      <input type="text" id="searchInput" class="search-input" placeholder="搜索或输入网址" autofocus>
      <button type="submit" class="search-btn">搜索</button>
    </form>
  </div>

  <div class="bookmarks-section">
    <div class="section-title">
      <span class="icon">⭐</span>
      <span>收藏夹</span>
    </div>
    <div id="bookmarksGrid" class="bookmarks-grid">
      ${bookmarksHtml}
    </div>
  </div>

  <div class="footer">FlowX Browser</div>

<script>
(function() {
  // 点击收藏夹跳转
  document.querySelectorAll('.bookmark-item').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.preventDefault();
      var url = el.getAttribute('data-url');
      if (url) {
        window.location.href = url;
      }
    });
  });

  // 搜索功能
  document.getElementById('searchForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var input = document.getElementById('searchInput');
    var query = input.value.trim();
    if (!query) return;

    // 判断是否是 URL
    var isUrl = /^(https?:\\/\\/)?([\\da-z.-]+)\\.([a-z.]{2,6})([\\/\\w .-]*)*\\/?/.test(query);
    if (isUrl && !query.includes(' ')) {
      if (!/^https?:\\/\\//i.test(query)) {
        query = 'https://' + query;
      }
      window.location.href = query;
    } else {
      // 百度搜索
      window.location.href = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query);
    }
  });
})();
</script>
</body>
</html>`;
}

/**
 * HTML 转义
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
