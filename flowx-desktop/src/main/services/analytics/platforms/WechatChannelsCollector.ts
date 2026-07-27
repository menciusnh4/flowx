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
          var iframe = document.querySelector('iframe[name="${iframeName}"]');
          if (!iframe) {
            return { ok: false, error: 'iframe not found: ${iframeName}' };
          }
          var doc = iframe.contentDocument || iframe.contentWindow.document;
          if (!doc) {
            return { ok: false, error: 'iframe document not accessible' };
          }
          var fn = new Function('document', 'window', 'return (' + (function() { ${code} }).toString() + ')();');
          var result = fn(doc, iframe.contentWindow);
          return { ok: true, data: result };
        } catch (e) {
          return { ok: false, error: e.message, stack: (e.stack || '').slice(0, 1000) };
        }
      })();
    `;
    const result = await this.eval(wrapped, desc) as { ok: boolean; data?: T; error?: string; stack?: string };
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
      var lines = textAll.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        var fanMatch = line.match(/^关注者([\\d,]+)$/);
        if (fanMatch) {
          followers = parseNum(fanMatch[1]);
        }

        var workMatch = line.match(/^视频([\\d,]+)$/);
        if (workMatch) {
          worksCount = parseNum(workMatch[1]);
        }

        if (line === '昨日数据') {
          for (var j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            if (lines[j] === '新增播放' && j + 1 < lines.length) {
              // 这是昨日数据，不是总数据，跳过
            }
          }
        }
      }

      return {
        followers: followers,
        following: following,
        likes: likes,
        worksCount: worksCount
      };
    `, 'extract-channels-overview');

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
    const log = this.makeLog('channels-works');

    log('info', 'goto', '从首页导航到视频管理页');
    await this.goto('https://channels.weixin.qq.com/platform/', 3000);
    await sleep(5000);

    try {
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

      await this.safeEval(`
        var items = document.querySelectorAll('.common-menu-item, li, [class*="menu"]');
        for (var i = 0; i < items.length; i++) {
          var txt = (items[i].innerText || '').trim();
          if (txt === '视频' || (txt.indexOf('视频') >= 0 && txt.length < 6)) {
            items[i].click();
            break;
          }
        }
        return 'ok';
      `, 'click-video');
      await sleep(10000);
    } catch (e) {
      log('warn', 'nav-fail', `菜单导航失败: ${(e as Error).message}`);
    }

    try {
      await this.waitForWorks(20000);
    } catch {
      log('warn', 'wait-timeout', '等待作品加载超时，继续尝试提取');
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

  private async waitForWorks(timeoutMs: number = 20000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = await this.evalInIframe<number>('content', `
          var bodyText = document.body ? (document.body.innerText || '') : '';
          var lines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          var workCount = 0;
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].match(/^\\d{4}年\\d{2}月\\d{2}日/)) {
              workCount++;
            }
          }
          return workCount;
        `, 'check-works');
        if (count > 0) return true;
      } catch {
        // ignore
      }
      await sleep(1000);
    }
    return false;
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
      const data = await this.evalInIframe<any[]>('content', `
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
              if (prevLine.indexOf('发表视频') >= 0 ||
                  prevLine.indexOf('视频管理') >= 0 ||
                  prevLine.indexOf('特效创作') >= 0 ||
                  prevLine.indexOf('合集') >= 0 ||
                  prevLine.indexOf('秒剪') >= 0 ||
                  prevLine.match(/^视频\\s*\\(\\d+\\)$/)) {
                break;
              }
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
              title = dedupTitle(title);
              title = title.length > 80 ? title.slice(0, 80) + '...' : title;

              var workId = 'wc_' + Math.abs(title.split('').reduce(function(a, c) {
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
                  contentType: 'video',
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
      `, 'extract-channels-works');

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
      logger.error('[WechatChannelsCollector] 提取作品列表失败', { error: (e as Error).message });
      return [];
    }
  }

  private async scrollDown(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      try {
        await this.evalInIframe('content', `
          window.scrollBy(0, window.innerHeight * 0.8);
          return 'ok';
        `, 'scroll-down');
      } catch {
        // ignore
      }
      await sleep(1500);
    }
  }
}
