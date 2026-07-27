import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential } from '../../../../types';
import { sleep } from '../../platforms/shared';

function generateWorkId(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  }
  return `xhs_${Math.abs(hash).toString(36)}`;
}

function parseDurationToSeconds(durationStr: string): number | undefined {
  if (!durationStr) return undefined;
  const parts = durationStr.split(':');
  if (parts.length === 2) {
    const min = parseInt(parts[0], 10) || 0;
    const sec = parseInt(parts[1], 10) || 0;
    return min * 60 + sec;
  }
  if (parts.length === 3) {
    const hour = parseInt(parts[0], 10) || 0;
    const min = parseInt(parts[1], 10) || 0;
    const sec = parseInt(parts[2], 10) || 0;
    return hour * 3600 + min * 60 + sec;
  }
  return undefined;
}

function parseZhNumber(text: string): number {
  if (!text) return 0;
  const t = text.trim();
  if (t.includes('w') || t.includes('万')) {
    const num = parseFloat(t.replace(/[w万]/g, ''));
    return Math.round(num * 10000);
  }
  if (t.includes('k') || t.includes('千')) {
    const num = parseFloat(t.replace(/[k千]/g, ''));
    return Math.round(num * 1000);
  }
  const n = parseInt(t.replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function parsePublishTimeToTimestamp(text: string): number {
  if (!text) return Date.now();
  const t = text.trim();

  const now = new Date();

  let m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) {
    const date = new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
    );
    return date.getTime();
  }

  m = t.match(/(\d{1,2})[-/月](\d{1,2})/);
  if (m) {
    const date = new Date(
      now.getFullYear(),
      parseInt(m[1], 10) - 1,
      parseInt(m[2], 10),
    );
    return date.getTime();
  }

  m = t.match(/(\d+)天前/);
  if (m) {
    return Date.now() - parseInt(m[1], 10) * 24 * 3600 * 1000;
  }

  m = t.match(/(\d+)小时前/);
  if (m) {
    return Date.now() - parseInt(m[1], 10) * 3600 * 1000;
  }

  m = t.match(/(\d+)分钟前/);
  if (m) {
    return Date.now() - parseInt(m[1], 10) * 60 * 1000;
  }

  if (t.includes('刚刚') || t.includes('今天')) {
    return Date.now();
  }
  if (t.includes('昨天')) {
    return Date.now() - 24 * 3600 * 1000;
  }
  if (t.includes('前天')) {
    return Date.now() - 2 * 24 * 3600 * 1000;
  }

  return Date.now();
}

function dedupTitle(title: string): string {
  if (!title) return title;
  const len = title.length;
  for (let i = 1; i <= Math.floor(len / 2); i++) {
    if (len % i === 0) {
      const seg = title.slice(0, i);
      let repeat = true;
      for (let j = i; j < len; j += i) {
        if (title.slice(j, j + i) !== seg) {
          repeat = false;
          break;
        }
      }
      if (repeat) return seg;
    }
  }
  return title;
}

export class XiaohongshuCollector extends BaseCollector {
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

  async collectAccountOverview(): Promise<{
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  }> {
    const log = this.makeLog('xhs-overview');

    const overviewUrl = 'https://creator.xiaohongshu.com/creator/home';
    log('info', 'goto', '跳转到小红书创作者中心首页');
    await this.goto(overviewUrl, 3000);
    await sleep(6000);

    try {
      await this.waitForContent(10000);
    } catch {
      // ignore
    }

    const data = await this.safeEval<{
      followers: number;
      following: number;
      likes: number;
      worksCount: number;
      collects?: number;
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
      var worksCount = 0;
      var collects = 0;

      var textAll = document.body.innerText || '';
      var lines = textAll.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '粉丝数' && i > 0) {
          followers = parseNum(lines[i - 1]);
        }
        if (line === '关注数' && i > 0) {
          following = parseNum(lines[i - 1]);
        }
        if (line === '获赞与收藏' && i > 0) {
          var val = parseNum(lines[i - 1]);
          likes = val;
          collects = val;
        }
        if (line.indexOf('笔记数') >= 0 && i > 0) {
          worksCount = parseNum(lines[i - 1]);
        }
      }

      if (worksCount === 0) {
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('笔记') >= 0 && lines[j].indexOf('管理') < 0) {
            var m = lines[j].match(/([\\d,万]+)\\s*笔记/);
            if (m) {
              worksCount = parseNum(m[1]);
              break;
            }
          }
        }
      }

      return {
        followers: followers,
        following: following,
        likes: likes,
        worksCount: worksCount,
        collects: collects
      };
    `, 'extract-xhs-overview');

    log('info', 'result', '账号概览数据提取完成', {
      followers: data.followers,
      following: data.following,
      likes: data.likes,
      worksCount: data.worksCount,
      collects: data.collects,
    });

    return {
      followers: data.followers,
      following: data.following,
      likes: data.likes,
      worksCount: data.worksCount,
      extra: {
        collects: data.collects || 0,
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
    const log = this.makeLog('xhs-works');

    log('info', 'goto', '从首页导航到笔记管理页');
    await this.goto('https://creator.xiaohongshu.com/creator/home', 3000);
    await sleep(5000);

    try {
      await this.safeEval(`
        var allEls = document.querySelectorAll('div, span');
        for (var i = 0; i < allEls.length; i++) {
          var txt = (allEls[i].innerText || '').trim();
          if (txt === '笔记管理') {
            var el = allEls[i];
            var depth = 0;
            while (el && depth < 5) {
              var style = window.getComputedStyle(el);
              if (style.cursor === 'pointer' || el.tagName === 'BUTTON' || el.tagName === 'A' || el.onclick) {
                el.click();
                break;
              }
              el = el.parentElement;
              depth++;
            }
            break;
          }
        }
        'ok';
      `, 'click-notes-menu');
      await sleep(5000);
    } catch (e) {
      log('warn', 'click-fail', `点击导航失败: ${(e as Error).message}`);
    }

    try {
      await this.waitForWorks(10000);
    } catch {
      log('warn', 'wait-timeout', '等待作品卡片超时，继续尝试提取');
    }

    const works = await this.extractWorksPage();

    if (works.length < limit) {
      try {
        await this.scrollDown(Math.ceil(limit / 10));
        const moreWorks = await this.extractWorksPage();
        if (moreWorks.length > works.length) {
          works.splice(0, works.length, ...moreWorks);
        }
      } catch (e) {
        log('warn', 'scroll-fail', `滚动加载失败: ${(e as Error).message}`);
      }
    }

    const result = works.slice(0, limit);
    log('info', 'done', `作品列表采集完成，共 ${result.length} 条`);
    return result;
  }

  private async waitForContent(timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const hasContent = await this.safeEval<boolean>(`
          var txt = (document.body.innerText || '').trim();
          var hasFan = txt.indexOf('粉丝') >= 0;
          var hasNote = txt.indexOf('笔记') >= 0;
          return hasFan || hasNote;
        `, 'check-content');
        if (hasContent) return true;
      } catch {
        // ignore
      }
      await sleep(500);
    }
    return false;
  }

  private async waitForWorks(timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = await this.safeEval<number>(`
          var cards = document.querySelectorAll('[class*="note-card"], [class*="video-card"], [class*="works-card"], [class*="note-item"], [class*="item-card"]');
          return cards.length;
        `, 'check-works');
        if (count > 0) return true;
      } catch {
        // ignore
      }
      await sleep(500);
    }
    return false;
  }

  private async probePage(): Promise<Record<string, unknown>> {
    try {
      return await this.safeEval<Record<string, unknown>>(`
        var allDivs = document.querySelectorAll('div');
        var sampleClasses = [];
        var classSet = {};
        for (var i = 0; i < allDivs.length && sampleClasses.length < 50; i++) {
          var cls = allDivs[i].className;
          if (typeof cls === 'string' && cls.length > 5 && cls.length < 60) {
            if (!classSet[cls]) {
              classSet[cls] = true;
              sampleClasses.push(cls);
            }
          }
        }
        var imgs = document.querySelectorAll('img');
        var coverUrls = [];
        for (var j = 0; j < imgs.length && coverUrls.length < 5; j++) {
          if (imgs[j].src && imgs[j].src.indexOf('http') === 0) {
            coverUrls.push(imgs[j].src.slice(0, 100));
          }
        }
        var links = document.querySelectorAll('a');
        var linkUrls = [];
        for (var k = 0; k < links.length && linkUrls.length < 5; k++) {
          if (links[k].href && links[k].href.indexOf('http') === 0) {
            linkUrls.push(links[k].href.slice(0, 120));
          }
        }
        var bodyText = document.body.innerText || '';
        var lines = bodyText.split('\\n').filter(function(l) { return l.trim().length > 0; }).slice(0, 30);
        var noteCards = document.querySelectorAll('[class*="note-card"], [class*="video-card"], [class*="works-card"], [class*="note-item"], [class*="item-card"]').length;
        return {
          bodyTextLen: bodyText.length,
          allImgs: imgs.length,
          allLinks: links.length,
          allDivs: allDivs.length,
          noteCards: noteCards,
          sampleClasses: sampleClasses.slice(0, 30),
          sampleImgs: coverUrls,
          sampleLinks: linkUrls,
          firstLines: lines
        };
      `, 'probe-page');
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private async extractWorksPage(): Promise<Array<{
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
      const data = await this.safeEval<any[]>(`
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

        function parseTime(text) {
          if (!text) return Date.now();
          var t = text.trim();
          var m = t.match(/(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})[\\sT]+(\\d{1,2}):(\\d{1,2})/);
          if (m) {
            return new Date(
              parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
              parseInt(m[4], 10), parseInt(m[5], 10)
            ).getTime();
          }
          m = t.match(/(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})/);
          if (m) {
            return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getTime();
          }
          return Date.now();
        }

        function dedupTitle(title) {
          if (!title) return title;
          var len = title.length;
          for (var i = 1; i <= Math.floor(len / 2); i++) {
            if (len % i === 0) {
              var seg = title.slice(0, i);
              var repeat = true;
              for (var j = i; j < len; j += i) {
                if (title.slice(j, j + i) !== seg) { repeat = false; break; }
              }
              if (repeat) return seg;
            }
          }
          return title;
        }

        var cards = document.querySelectorAll('.note-card');
        var results = [];
        var seen = {};

        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var text = card.innerText || '';
          if (!text || text.trim().length < 5) continue;

          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          if (lines.length < 3) continue;

          var title = '';
          var publishTime = Date.now();
          var views = 0;
          var likes = 0;
          var favorites = 0;
          var comments = 0;
          var shares = 0;

          var numIdx = 0;
          var numbers = [];

          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];

            var dateMatch = line.match(/^\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}/);
            if (dateMatch) {
              publishTime = parseTime(line);
              continue;
            }

            var pureNum = line.match(/^[\\d,]+$/);
            if (pureNum && line.length < 10) {
              numbers.push(line);
              continue;
            }

            if (!title && line.length > 2 && line.length < 100) {
              title = line;
            }
          }

          if (numbers.length >= 4) {
            views = parseNum(numbers[0]);
            likes = parseNum(numbers[1]);
            favorites = parseNum(numbers[2]);
            comments = parseNum(numbers[3]);
            if (numbers.length >= 5) shares = parseNum(numbers[4]);
          }

          if (!title) continue;
          title = dedupTitle(title);

          var imgEl = card.querySelector('img');
          var coverUrl = imgEl ? imgEl.src : '';

          var linkEl = card.querySelector('a');
          var detailUrl = linkEl ? linkEl.href : '';

          var workId = 'xhs_' + Math.abs(title.split('').reduce(function(a, c) {
            return ((a << 5) - a + c.charCodeAt(0)) | 0;
          }, 0)).toString(36);

          if (seen[workId]) continue;
          seen[workId] = true;

          results.push({
            workId: workId,
            title: title,
            coverUrl: coverUrl,
            publishTime: publishTime,
            detailUrl: detailUrl,
            duration: null,
            contentType: 'image',
            views: views,
            likes: likes,
            comments: comments,
            favorites: favorites,
            shares: shares
          });
        }

        return results;
      `, 'extract-xhs-works');

      return data.map(w => ({
        workId: w.workId,
        title: w.title,
        coverUrl: w.coverUrl,
        publishTime: w.publishTime,
        detailUrl: w.detailUrl,
        duration: w.duration || undefined,
        contentType: w.contentType as 'video' | 'article' | 'image',
        views: w.views,
        likes: w.likes,
        comments: w.comments,
        favorites: w.favorites,
        shares: w.shares,
      }));
    } catch (e) {
      logger.error('[XiaohongshuCollector] 提取作品列表失败', { error: (e as Error).message });
      return [];
    }
  }

  private async scrollDown(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      try {
        await this.eval(`
          window.scrollBy(0, window.innerHeight * 0.8);
          'ok';
        `, 'scroll-down');
      } catch {
        // ignore
      }
      await sleep(1500);
    }
  }
}
