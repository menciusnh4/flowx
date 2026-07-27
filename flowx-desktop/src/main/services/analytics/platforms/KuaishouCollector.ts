import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential } from '../../../../types';
import { sleep } from '../../platforms/shared';

export class KuaishouCollector extends BaseCollector {
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
    const log = this.makeLog('ks-overview');

    const overviewUrl = 'https://cp.kuaishou.com/';
    log('info', 'goto', '跳转到快手创作者中心首页');
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

      var textAll = document.body.innerText || '';
      var lines = textAll.split('\\n').filter(function(l) { return l.trim().length > 0; });

      var fanIdx = -1;
      var followIdx = -1;
      var likeIdx = -1;
      var workIdx = -1;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '粉丝' || line.indexOf('粉丝数') >= 0 || (line.indexOf('粉丝') >= 0 && line.length < 10)) fanIdx = i;
        if (line === '关注' || (line.indexOf('关注') >= 0 && line.length < 10)) followIdx = i;
        if (line.indexOf('获赞') >= 0 || line.indexOf('总赞') >= 0) likeIdx = i;
        if (line.indexOf('作品') >= 0 && line.length < 10) workIdx = i;
      }

      function findNearbyNumber(idx, direction) {
        if (idx < 0 || idx >= lines.length) return 0;
        for (var step = 1; step <= 5; step++) {
          var pos = direction > 0 ? idx + step : idx - step;
          if (pos >= 0 && pos < lines.length) {
            var txt = lines[pos].trim();
            var m = txt.match(/^[\d,\.]+[万千]?$/);
            if (m) return parseNum(txt);
          }
        }
        return 0;
      }

      if (fanIdx >= 0) followers = findNearbyNumber(fanIdx, 1) || findNearbyNumber(fanIdx, -1);
      if (followIdx >= 0) following = findNearbyNumber(followIdx, 1) || findNearbyNumber(followIdx, -1);
      if (likeIdx >= 0) likes = findNearbyNumber(likeIdx, 1) || findNearbyNumber(likeIdx, -1);
      if (workIdx >= 0) worksCount = findNearbyNumber(workIdx, 1) || findNearbyNumber(workIdx, -1);

      return {
        followers: followers,
        following: following,
        likes: likes,
        worksCount: worksCount
      };
    `, 'extract-ks-overview');

    log('info', 'result', '账号概览数据提取完成', data);
    return data;
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
    const log = this.makeLog('ks-works');

    const worksUrl = 'https://cp.kuaishou.com/article/manage/video';
    log('info', 'goto', '跳转到作品管理页');
    await this.goto(worksUrl, 3000);
    await sleep(6000);

    try {
      await this.safeEval(`
        var tabs = document.querySelectorAll('.works-manage__status .el-tabs__item');
        for (var i = 0; i < tabs.length; i++) {
          if ((tabs[i].innerText || '').indexOf('已发布') >= 0) {
            tabs[i].click();
            break;
          }
        }
        return 'clicked';
      `, 'click-published');
      await sleep(4000);
    } catch {
      // ignore
    }

    try {
      await this.waitForWorks(10000);
    } catch {
      log('warn', 'wait-timeout', '等待作品卡片超时，继续尝试提取');
    }

    let works = await this.extractWorksPage();

    if (works.length < limit) {
      try {
        await this.scrollDown(Math.ceil(limit / 10));
        const moreWorks = await this.extractWorksPage();
        if (moreWorks.length > works.length) {
          works = moreWorks;
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
          var hasWork = txt.indexOf('作品') >= 0;
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

  private async waitForWorks(timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = await this.safeEval<number>(`
          var cards = document.querySelectorAll('[class*="video-card"], [class*="work-card"], [class*="item-card"], [class*="works-item"], [class*="video-item"]');
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
        var videoCards = document.querySelectorAll('[class*="video-card"], [class*="work-card"], [class*="item-card"], [class*="works-item"], [class*="video-item"]').length;
        return {
          bodyTextLen: bodyText.length,
          allImgs: imgs.length,
          allLinks: links.length,
          allDivs: allDivs.length,
          videoCards: videoCards,
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

        function extractTitle(fullText) {
          if (!fullText) return '';
          var firstLine = fullText.split('\\n')[0] || '';
          firstLine = firstLine.trim();
          if (firstLine.length > 60) {
            var cutIdx = firstLine.indexOf('。');
            if (cutIdx > 0 && cutIdx < 60) return firstLine.slice(0, cutIdx + 1);
            cutIdx = firstLine.indexOf(' ');
            if (cutIdx > 0 && cutIdx < 60) return firstLine.slice(0, cutIdx);
            return firstLine.slice(0, 60) + '...';
          }
          return firstLine;
        }

        var cards = document.querySelectorAll('[class*="video-card"], [class*="work-card"], [class*="item-card"], [class*="works-item"], [class*="video-item"]');
        var filtered = [];
        for (var i = 0; i < cards.length; i++) {
          var isNested = false;
          for (var j = 0; j < cards.length; j++) {
            if (i !== j && cards[j].contains(cards[i])) { isNested = true; break; }
          }
          if (!isNested) filtered.push(cards[i]);
        }

        var results = [];
        var seen = {};
        for (var k = 0; k < filtered.length; k++) {
          var card = filtered[k];
          var text = card.innerText || '';
          if (!text || text.trim().length < 20) continue;

          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          if (lines.length < 4) continue;

          var hasPublished = false;
          var timeIdx = -1;
          for (var li = 0; li < lines.length; li++) {
            if (lines[li] === '已发布') hasPublished = true;
            if (lines[li].match(/^\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}/) && timeIdx < 0) timeIdx = li;
          }

          if (!hasPublished || timeIdx < 0) continue;

          var publishTime = parseTime(lines[timeIdx]);

          var numbers = [];
          for (var ni = timeIdx + 1; ni < lines.length; ni++) {
            var line = lines[ni];
            if (line.match(/^[\\d,万万千千.]+$/)) {
              numbers.push(line);
            } else if (line.indexOf('流量助推') >= 0 || line.indexOf('推广') >= 0) {
              continue;
            }
          }

          var views = 0, likes = 0, comments = 0;
          if (numbers.length >= 1) views = parseNum(numbers[0]);
          if (numbers.length >= 2) likes = parseNum(numbers[1]);
          if (numbers.length >= 3) comments = parseNum(numbers[2]);

          var fullText = lines.slice(0, timeIdx - 1).join(' ');
          var title = extractTitle(fullText);
          if (!title && lines.length > 0) title = lines[0].slice(0, 60);

          if (!title || title.length < 2) continue;

          var imgEl = card.querySelector('img');
          var coverUrl = imgEl ? imgEl.src : '';

          var linkEl = card.querySelector('a');
          var detailUrl = linkEl ? linkEl.href : '';

          var workId = 'ks_' + Math.abs(title.split('').reduce(function(a, c) {
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
            contentType: 'video',
            views: views,
            likes: likes,
            comments: comments,
            favorites: 0,
            shares: 0
          });
        }

        return results;
      `, 'extract-ks-works');

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
      logger.error('[KuaishouCollector] 提取作品列表失败', { error: (e as Error).message });
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
