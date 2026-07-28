import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential } from '../../../../types';
import { sleep } from '../../platforms/shared';

export class WechatChannelsCollector extends BaseCollector {
  constructor(account: AccountCredential) {
    super(account);
  }

  private async safeEval<T>(code: string, desc: string): Promise<T> {
    try {
      const wrapped = `
        (function() {
          try {
            var result = (function() { ${code} })();
            return { ok: true, data: result };
          } catch (e) {
            return { ok: false, error: e.message, stack: (e.stack || '').slice(0, 1000) };
          }
        })();
      `;
      const result = await this.eval(wrapped, desc) as { ok: boolean; data?: T; error?: string; stack?: string };
      if (!result.ok) {
        throw new Error(`[${desc}] 脚本逻辑错误: ${result.error}\n${result.stack || ''}`);
      }
      return result.data as T;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new Error(`[${desc}] 脚本执行失败: ${errMsg}`);
    }
  }

  private async evalInIframe<T>(iframeName: string, code: string, desc: string): Promise<T> {
    const wrapped = `
      (function() {
        try {
          function findContentIframe() {
            var iframes = document.querySelectorAll('iframe');
            var best = null;
            var bestScore = 0;
            for (var i = 0; i < iframes.length; i++) {
              var iframe = iframes[i];
              var name = iframe.name || iframe.id || '';
              var src = iframe.src || '';
              try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) continue;
                var bodyLen = (doc.body.innerText || '').length;
                var score = 0;
                if (name === '${iframeName}') score += 1000;
                if (name.indexOf('content') >= 0) score += 100;
                if (src.indexOf('content') >= 0) score += 50;
                if (src.indexOf('channels.weixin.qq.com') >= 0) score += 30;
                if (bodyLen > 100) score += Math.min(bodyLen / 100, 50);
                if (iframe.offsetWidth > 300 && iframe.offsetHeight > 300) score += 20;
                if (score > bestScore) {
                  bestScore = score;
                  best = iframe;
                }
              } catch (e) {
                // 跨域的 iframe 不可访问
              }
            }
            return best;
          }

          var iframe = findContentIframe();
          if (!iframe) {
            return { ok: false, error: 'iframe not found: ${iframeName}' };
          }
          var doc = iframe.contentDocument || iframe.contentWindow.document;
          if (!doc) {
            return { ok: false, error: 'iframe document not accessible' };
          }
          var fn = new Function('document', 'window', 'return (' + (function() { ${code} }).toString() + ')();');
          var result = fn(doc, iframe.contentWindow);
          return { ok: true, data: result, iframeName: iframe.name || iframe.id || '' };
        } catch (e) {
          return { ok: false, error: e.message, stack: (e.stack || '').slice(0, 1000) };
        }
      })();
    `;
    const result = await this.eval(wrapped, desc) as { ok: boolean; data?: T; error?: string; stack?: string; iframeName?: string };
    if (!result.ok) {
      throw new Error(`[${desc}] iframe脚本错误: ${result.error}\n${result.stack || ''}`);
    }
    return result.data as T;
  }

  async collectAccountOverview(): Promise<{
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  }> {
    const log = this.makeLog('channels-overview');

    const overviewUrl = 'https://channels.weixin.qq.com/platform';
    log('info', 'goto', '跳转到微信视频号助手首页');
    await this.goto(overviewUrl, 3000);
    await sleep(8000);

    try {
      await this.waitForContent(15000);
    } catch {
      // ignore
    }

    const data = await this.safeEval<{
      followers: number;
      following: number;
      likes: number;
      worksCount: number;
      videoCount: number;
      imageCount: number;
    }>(`
      function parseNum(text) {
        if (!text) return 0;
        var t = text.trim();
        if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
          var num = parseFloat(t.replace(/[万w]/g, ''));
          return Math.round(num * 10000);
        }
        if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
          var num2 = parseFloat(t.replace(/[千k]/g, ''));
          return Math.round(num2 * 1000);
        }
        var n = parseInt(t.replace(/,/g, ''), 10);
        return isNaN(n) ? 0 : n;
      }

      var followers = 0;
      var following = 0;
      var likes = 0;
      var videoCount = 0;
      var imageCount = 0;

      var textAll = document.body.innerText || '';
      var lines = textAll.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        var fanMatch = line.match(/^关注者([\\d,]+)$/);
        if (fanMatch) {
          followers = parseNum(fanMatch[1]);
        }

        var videoMatch = line.match(/^视频([\\d,]+)$/);
        if (videoMatch) {
          videoCount = parseNum(videoMatch[1]);
        }

        var imageMatch = line.match(/^图文([\\d,]+)$/) || line.match(/^图片([\\d,]+)$/);
        if (imageMatch) {
          imageCount = parseNum(imageMatch[1]);
        }

        if (line === '昨日数据') {
          for (var j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            if (lines[j] === '新增播放' && j + 1 < lines.length) {
              // 这是昨日数据，不是总数据，跳过
            }
          }
        }
      }

      var worksCount = videoCount + imageCount;

      return {
        followers: followers,
        following: following,
        likes: likes,
        worksCount: worksCount,
        videoCount: videoCount,
        imageCount: imageCount
      };
    `, 'extract-channels-overview');

    log('info', 'result', '账号概览数据提取完成', { ...data, extra: { videoCount: data.videoCount, imageCount: data.imageCount } });
    return {
      followers: data.followers,
      following: data.following,
      likes: data.likes,
      worksCount: data.worksCount,
      extra: {
        videoCount: data.videoCount,
        imageCount: data.imageCount,
      },
    };
  }

  async collectWorksList(limit: number = 20): Promise<Array<{
    workId: string;
    title: string;
    coverUrl?: string;
    publishTime: number;
    detailUrl?: string;
    duration?: number;
    contentType: 'video' | 'article' | 'image';
    views?: number;
    likes?: number;
    comments?: number;
    favorites?: number;
    shares?: number;
  }>> {
    const log = this.makeLog('channels-works');

    log('info', 'goto', '跳转到微信视频号助手首页');
    await this.goto('https://channels.weixin.qq.com/platform/', 3000);
    await sleep(5000);

    const allWorks: Array<any> = [];
    const seenIds = new Set<string>();

    const videoLimit = Math.ceil(limit / 2);
    const imageLimit = Math.ceil(limit / 2);

    try {
      log('info', 'collect-video', '开始采集视频列表');
      const videoWorks = await this.collectVideoWorks(videoLimit);
      log('info', 'video-count', `采集到 ${videoWorks.length} 条视频作品`);
      for (const w of videoWorks) {
        if (!seenIds.has(w.workId)) {
          seenIds.add(w.workId);
          allWorks.push(w);
        }
      }
    } catch (e) {
      log('warn', 'video-fail', `视频采集失败: ${(e as Error).message}`);
    }

    try {
      log('info', 'collect-image', '开始采集图文列表');
      const imageWorks = await this.collectImageWorks(imageLimit);
      log('info', 'image-count', `采集到 ${imageWorks.length} 条图文作品`);
      for (const w of imageWorks) {
        if (!seenIds.has(w.workId)) {
          seenIds.add(w.workId);
          allWorks.push(w);
        }
      }
    } catch (e) {
      log('warn', 'image-fail', `图文采集失败: ${(e as Error).message}`);
    }

    allWorks.sort((a, b) => b.publishTime - a.publishTime);

    const result = allWorks.slice(0, limit);
    log('info', 'done', `作品列表采集完成，共 ${result.length} 条（视频+图文）`);
    return result;
  }

  private async navigateToContentMenu(): Promise<void> {
    await this.safeEval(`
      var items = document.querySelectorAll('.common-menu-item');
      for (var i = 0; i < items.length; i++) {
        var txt = (items[i].innerText || '').trim();
        if (txt.indexOf('内容管理') >= 0) {
          items[i].click();
          break;
        }
      }
      return 'ok';
    `, 'click-content-menu');
    await sleep(2000);
  }

  private async clickSubMenu(keyword: string): Promise<boolean> {
    const result = await this.safeEval<boolean>(`
      var items = document.querySelectorAll('.common-menu-item, li, [class*="menu"] a, [class*="menu"] div');
      for (var i = 0; i < items.length; i++) {
        var txt = (items[i].innerText || '').trim();
        if (txt === '${keyword}' || (txt.indexOf('${keyword}') >= 0 && txt.length < 10)) {
          items[i].click();
          return true;
        }
      }
      return false;
    `, 'click-' + keyword);
    return result;
  }

  private async collectVideoWorks(limit: number): Promise<any[]> {
    const log = this.makeLog('channels-video');

    try {
      await this.navigateToContentMenu();
    } catch (e) {
      log('warn', 'nav-menu-fail', `内容菜单导航失败: ${(e as Error).message}`);
    }

    try {
      await this.clickSubMenu('视频');
      await sleep(8000);
    } catch (e) {
      log('warn', 'nav-video-fail', `视频菜单导航失败: ${(e as Error).message}`);
    }

    try {
      await this.waitForWorks(20000, 'video');
    } catch {
      log('warn', 'wait-timeout', '等待视频加载超时，继续尝试提取');
    }

    let works = await this.extractWorksPage('video');

    if (works.length < limit) {
      try {
        await this.scrollDown(Math.ceil(limit / 10));
        const moreWorks = await this.extractWorksPage('video');
        if (moreWorks.length > works.length) {
          works = moreWorks;
        }
      } catch (e) {
        log('warn', 'scroll-fail', `滚动加载失败: ${(e as Error).message}`);
      }
    }

    return works.slice(0, limit);
  }

  private async collectImageWorks(limit: number): Promise<any[]> {
    const log = this.makeLog('channels-image');

    try {
      await this.navigateToContentMenu();
    } catch (e) {
      log('warn', 'nav-menu-fail', `内容菜单导航失败: ${(e as Error).message}`);
    }

    let clicked = false;
    try {
      clicked = await this.clickSubMenu('图文');
    } catch (e) {
      log('warn', 'nav-image-fail', `图文菜单导航失败: ${(e as Error).message}`);
    }

    if (!clicked) {
      try {
        clicked = await this.clickSubMenu('图片');
      } catch {}
    }

    if (!clicked) {
      log('warn', 'no-image-menu', '未找到图文/图片菜单项，跳过图文采集');
      return [];
    }

    await sleep(8000);

    try {
      await this.waitForWorks(20000, 'image');
    } catch {
      log('warn', 'wait-timeout', '等待图文加载超时，继续尝试提取');
    }

    let works = await this.extractWorksPage('image');

    if (works.length < limit) {
      try {
        await this.scrollDown(Math.ceil(limit / 10));
        const moreWorks = await this.extractWorksPage('image');
        if (moreWorks.length > works.length) {
          works = moreWorks;
        }
      } catch (e) {
        log('warn', 'scroll-fail', `滚动加载失败: ${(e as Error).message}`);
      }
    }

    return works.slice(0, limit);
  }

  private async waitForContent(timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const hasContent = await this.safeEval<boolean>(`
          var txt = (document.body.innerText || '').trim();
          var hasFan = txt.indexOf('关注者') >= 0;
          var hasWork = txt.indexOf('视频') >= 0;
          return hasFan || hasWork;
        `, 'check-content');
        if (hasContent) return true;
      } catch {
        // ignore
      }
      await sleep(500);
    }
    return false;
  }

  private async waitForWorks(timeoutMs: number = 20000, type: 'video' | 'image' = 'video'): Promise<boolean> {
    const start = Date.now();
    const checkCode = `
      var bodyText = document.body ? (document.body.innerText || '') : '';
      var lines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
      var workCount = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].match(/^\\d{4}年\\d{2}月\\d{2}日/)) {
          workCount++;
        }
      }
      return workCount;
    `;

    while (Date.now() - start < timeoutMs) {
      try {
        const count = await this.evalInIframe<number>('content', checkCode, 'check-' + type + '-works');
        if (count > 0) return true;
      } catch {
        try {
          const count = await this.safeEval<number>(checkCode, 'check-' + type + '-works-main');
          if (count > 0) return true;
        } catch {
          // ignore
        }
      }
      await sleep(1000);
    }
    return false;
  }

  private async extractWorksPage(type: 'video' | 'image' = 'video'): Promise<Array<{
    workId: string;
    title: string;
    coverUrl?: string;
    publishTime: number;
    detailUrl?: string;
    duration?: number;
    contentType: 'video' | 'article' | 'image';
    views?: number;
    likes?: number;
    comments?: number;
    favorites?: number;
    shares?: number;
  }>> {
    try {
      const contentType = type === 'video' ? 'video' : 'image';

      const extractionCode = this.buildExtractionScript(type, contentType);

      let data: any[] = [];
      let usedIframe = true;
      try {
        data = await this.evalInIframe<any[]>('content', extractionCode, 'extract-' + type + '-works');
      } catch (e) {
        usedIframe = false;
        logger.warn('[WechatChannelsCollector] iframe提取失败，尝试主文档提取', { type, error: (e as Error).message });
        try {
          data = await this.safeEval<any[]>(extractionCode, 'extract-' + type + '-works-main');
        } catch (e2) {
          logger.error('[WechatChannelsCollector] 主文档提取也失败', { type, error: (e2 as Error).message });
          return [];
        }
      }

      if (!usedIframe && data.length === 0) {
        logger.warn('[WechatChannelsCollector] 主文档提取结果为空', { type });
      }

      return data.map(w => ({
        workId: w.workId,
        title: w.title,
        coverUrl: w.coverUrl || undefined,
        publishTime: w.publishTime,
        detailUrl: w.detailUrl || undefined,
        duration: w.duration || undefined,
        contentType: w.contentType as 'video' | 'article' | 'image',
        views: w.views,
        likes: w.likes,
        comments: w.comments,
        favorites: w.favorites,
        shares: w.shares,
      }));
    } catch (e) {
      logger.error('[WechatChannelsCollector] 提取作品列表失败', { type, error: (e as Error).message });
      return [];
    }
  }

  private buildExtractionScript(type: string, contentType: string): string {
    const stopKeywords = type === 'video'
      ? JSON.stringify(['发表视频', '视频管理', '特效创作', '合集', '秒剪'])
      : JSON.stringify(['发表图文', '图文管理', '发表图片', '图片管理']);

    return `
var __type = '` + type + `';
var __contentType = '` + contentType + `';
var __stopKeywords = ` + stopKeywords + `;

function parseNum(text) {
  if (!text) return 0;
  var t = text.trim();
  if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
    return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
  }
  if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
    return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
  }
  var n = parseInt(t.replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function parseTime(text) {
  if (!text) return Date.now();
  var t = text.trim();
  var m = t.match(/(\\d{4})年(\\d{2})月(\\d{2})日\\s*(\\d{1,2}):(\\d{2})/);
  if (m) {
    return new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10)
    ).getTime();
  }
  m = t.match(/(\\d{4})年(\\d{2})月(\\d{2})日/);
  if (m) {
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getTime();
  }
  return Date.now();
}

function isStopKeyword(line) {
  if (!line) return false;
  for (var i = 0; i < __stopKeywords.length; i++) {
    if (line.indexOf(__stopKeywords[i]) >= 0) return true;
  }
  if (__type === 'video' && /^视频\\s*\\(\\d+\\)$/.test(line)) return true;
  if (__type !== 'video' && /^图文\\s*\\(\\d+\\)$/.test(line)) return true;
  if (__type !== 'video' && /^图片\\s*\\(\\d+\\)$/.test(line)) return true;
  return false;
}

function cleanUrl(url) {
  if (!url) return '';
  var u = String(url).trim();
  u = u.replace(/^["'\\s]+/, '').replace(/["'\\s]+$/, '');
  if (u.indexOf('http') !== 0) return '';
  return u;
}

function extractCoverFromElement(el) {
  if (!el) return '';
  try {
    var imgs = el.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
      src = cleanUrl(src);
      if (src && src.indexOf('icon') < 0 && src.indexOf('logo') < 0) {
        var w = img.offsetWidth || 0;
        var h = img.offsetHeight || 0;
        if (w >= 40 && h >= 40) return src;
      }
    }
  } catch (e) {}
  try {
    var all = el.querySelectorAll ? el.querySelectorAll('*') : [];
    for (var j = 0; j < all.length; j++) {
      var elem = all[j];
      var bgi = '';
      if (elem.currentStyle) {
        bgi = elem.currentStyle.backgroundImage;
      } else if (window.getComputedStyle) {
        var st = window.getComputedStyle(elem, null);
        if (st) bgi = st.getPropertyValue('background-image') || '';
      }
      if (!bgi || bgi === 'none' || bgi.indexOf('url') < 0) continue;
      var m = bgi.match(/url\\(([^)]+)\\)/);
      if (!m) continue;
      var url = cleanUrl(m[1]);
      if (url && url.indexOf('icon') < 0 && url.indexOf('logo') < 0) {
        var ew = elem.offsetWidth || 0;
        var eh = elem.offsetHeight || 0;
        if (ew >= 40 && eh >= 40) return url;
      }
    }
  } catch (e) {}
  return '';
}

function extractFromText() {
  var bodyText = document.body ? (document.body.innerText || '') : '';
  var lines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
  var results = [];
  var seen = {};
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    var timeMatch = line.match(/^\\d{4}年\\d{2}月\\d{2}日\\s*\\d{1,2}:\\d{2}$/);
    if (timeMatch) {
      var publishTime = parseTime(line);
      var title = '';
      var titleIdx = i - 1;
      while (titleIdx >= 0) {
        var prevLine = lines[titleIdx];
        if (isStopKeyword(prevLine)) break;
        if (prevLine.length > 10) {
          title = prevLine;
          break;
        }
        titleIdx--;
      }
      var numbers = [];
      var numIdx = i + 1;
      while (numIdx < lines.length && numbers.length < 6) {
        var nextLine = lines[numIdx];
        if (nextLine.match(/^[\\d,]+$/)) {
          numbers.push(nextLine);
          numIdx++;
        } else if (nextLine === '置顶' || nextLine === '分享' || nextLine === '评论管理' ||
                   nextLine.indexOf('修改') >= 0 || nextLine.indexOf('可见') >= 0 ||
                   nextLine === '删除') {
          break;
        } else {
          break;
        }
      }
      if (title && numbers.length >= 3) {
        if (title.length > 80) title = title.slice(0, 80) + '...';
        var workId = 'wc_' + __type + '_' + Math.abs(title.split('').reduce(function(a, c) {
          return ((a << 5) - a + c.charCodeAt(0)) | 0;
        }, 0)).toString(36);
        if (!seen[workId]) {
          seen[workId] = true;
          results.push({
            workId: workId,
            title: title,
            coverUrl: '',
            publishTime: publishTime,
            detailUrl: '',
            duration: null,
            contentType: __contentType,
            views: parseNum(numbers[0] || '0'),
            likes: parseNum(numbers[1] || '0'),
            comments: parseNum(numbers[2] || '0'),
            favorites: parseNum(numbers[3] || '0'),
            shares: parseNum(numbers[4] || '0')
          });
        }
      }
    }
    i++;
  }
  return results;
}

function extractFromDOM() {
  var results = [];
  var seen = {};
  var candidates = [];
  var allElements = document.querySelectorAll ? document.querySelectorAll('*') : [];
  for (var i = 0; i < allElements.length; i++) {
    var el = allElements[i];
    var cls = el.className || '';
    if (typeof cls !== 'string') continue;
    var clsLower = cls.toLowerCase();
    if ((clsLower.indexOf('card') >= 0 || clsLower.indexOf('item') >= 0 || clsLower.indexOf('list-item') >= 0)
        && el.children && el.children.length >= 2) {
      var txt = (el.innerText || '').trim();
      if (txt.length > 20 && txt.length < 2000
          && txt.indexOf('年') >= 0 && txt.indexOf('月') >= 0 && txt.indexOf('日') >= 0) {
        candidates.push(el);
      }
    }
  }
  for (var c = 0; c < candidates.length; c++) {
    var card = candidates[c];
    var cardText = (card.innerText || '').trim();
    var lines = cardText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var title = '';
    var publishTime = 0;
    var numbers = [];
    var coverUrl = '';
    try { coverUrl = extractCoverFromElement(card); } catch (e) {}
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l];
      var timeMatch = line.match(/^(\\d{4}年\\d{2}月\\d{2}日\\s*\\d{1,2}:\\d{2})/);
      if (timeMatch) publishTime = parseTime(timeMatch[1]);
      if (line.match(/^[\\d,]+$/) || line.match(/^[\\d,.]+[万千]$/)) {
        numbers.push(line);
      }
    }
    for (var t = 0; t < lines.length; t++) {
      if (lines[t].length > 10 && lines[t].length < 200
          && lines[t].indexOf('年') < 0 && lines[t].indexOf('月') < 0
          && !lines[t].match(/^[\\d,]+$/)
          && lines[t] !== '置顶' && lines[t] !== '分享' && lines[t] !== '评论管理'
          && lines[t].indexOf('修改') < 0 && lines[t].indexOf('可见') < 0
          && lines[t] !== '删除') {
        title = lines[t];
        break;
      }
    }
    if (title && publishTime > 0 && numbers.length >= 3) {
      if (title.length > 80) title = title.slice(0, 80) + '...';
      var workId = 'wc_dom_' + __type + '_' + Math.abs(title.split('').reduce(function(a, c) {
        return ((a << 5) - a + c.charCodeAt(0)) | 0;
      }, 0)).toString(36);
      if (!seen[workId]) {
        seen[workId] = true;
        results.push({
          workId: workId,
          title: title,
          coverUrl: coverUrl,
          publishTime: publishTime,
          detailUrl: '',
          duration: null,
          contentType: __contentType,
          views: parseNum(numbers[0] || '0'),
          likes: parseNum(numbers[1] || '0'),
          comments: parseNum(numbers[2] || '0'),
          favorites: parseNum(numbers[3] || '0'),
          shares: parseNum(numbers[4] || '0')
        });
      }
    }
  }
  return results;
}

try {
  var domResults = extractFromDOM();
  if (domResults && domResults.length >= 3) return domResults;
} catch (e) {}

return extractFromText();
`;
  }

  private async scrollDown(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      try {
        await this.evalInIframe('content', `
          window.scrollBy(0, window.innerHeight * 0.8);
          return 'ok';
        `, 'scroll-down');
      } catch {
        try {
          await this.safeEval(`
            window.scrollBy(0, window.innerHeight * 0.8);
            return 'ok';
          `, 'scroll-down-main');
        } catch {
          // ignore
        }
      }
      await sleep(1500);
    }
  }
}
