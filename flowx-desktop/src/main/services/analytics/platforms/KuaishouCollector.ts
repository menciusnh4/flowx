import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential } from '../../../../types';
import { sleep } from '../../platforms/shared';

function generateWorkId(title: string, page: number, index: number): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  }
  return `ks_${Math.abs(hash).toString(36)}_p${page}_${index}`;
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

function parsePercent(text: string): number {
  if (!text) return 0;
  const t = text.trim().replace('%', '');
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function parsePublishTime(text: string): number {
  if (!text) return Date.now();
  const m = text.match(/发布于\s*(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    return new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10),
    ).getTime();
  }
  const m2 = text.match(/发布于\s*(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}):(\d{2})/);
  if (m2) {
    return new Date(
      parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10),
      parseInt(m2[4], 10), parseInt(m2[5], 10),
    ).getTime();
  }
  return Date.now();
}

function extractTitle(fullText: string): string {
  if (!fullText) return '';
  const firstLine = fullText.split('\n')[0] || '';
  const trimmed = firstLine.trim();
  if (trimmed.length > 80) {
    const cutIdx = trimmed.indexOf('。');
    if (cutIdx > 0 && cutIdx < 80) return trimmed.slice(0, cutIdx + 1);
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0 && spaceIdx < 80) return trimmed.slice(0, spaceIdx);
    return trimmed.slice(0, 80) + '...';
  }
  return trimmed;
}

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

      function looksLikeNumber(text) {
        if (!text) return false;
        var t = text.trim();
        if (t.length === 0 || t.length > 15) return false;
        return /^[\\d,\\.]+[万千wkWK]?$/.test(t);
      }

      function findByLabelValuePair(lines, labels) {
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          var matched = false;
          for (var l = 0; l < labels.length; l++) {
            if (line === labels[l] || line.indexOf(labels[l]) === 0 && line.length < labels[l].length + 5) {
              matched = true;
              break;
            }
          }
          if (!matched) continue;

          for (var step = 1; step <= 4; step++) {
            if (i - step >= 0 && looksLikeNumber(lines[i - step])) {
              return parseNum(lines[i - step]);
            }
          }
          for (var step2 = 1; step2 <= 4; step2++) {
            if (i + step2 < lines.length && looksLikeNumber(lines[i + step2])) {
              return parseNum(lines[i + step2]);
            }
          }
        }
        return 0;
      }

      function extractFromText(text) {
        var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

        return {
          followers: findByLabelValuePair(lines, ['粉丝', '粉丝数', '粉丝量']),
          following: findByLabelValuePair(lines, ['关注', '关注数', '关注量']),
          likes: findByLabelValuePair(lines, ['获赞', '总赞', '点赞', '总获赞']),
          worksCount: findByLabelValuePair(lines, ['作品数', '作品数量', '总作品', '全部作品'])
        };
      }

      var result = { followers: 0, following: 0, likes: 0, worksCount: 0 };

      var selectors = [
        '.user-info', '.account-info', '.profile-card', '.user-card',
        '.header-info', '.top-info', '.data-card', '.stat-card',
        '[class*="user-info"]', '[class*="profile"]', '[class*="stat"]'
      ];

      for (var s = 0; s < selectors.length; s++) {
        var els = document.querySelectorAll(selectors[s]);
        for (var e = 0; e < els.length; e++) {
          var txt = els[e].innerText || '';
          if (txt.length < 10 || txt.length > 2000) continue;
          var hasFan = txt.indexOf('粉丝') >= 0;
          var hasFollow = txt.indexOf('关注') >= 0;
          var hasLike = txt.indexOf('获赞') >= 0 || txt.indexOf('点赞') >= 0;
          if (hasFan && (hasFollow || hasLike)) {
            var extracted = extractFromText(txt);
            if (extracted.followers > 0 || extracted.likes > 0) {
              result.followers = extracted.followers || result.followers;
              result.following = extracted.following || result.following;
              result.likes = extracted.likes || result.likes;
              result.worksCount = extracted.worksCount || result.worksCount;
            }
          }
        }
      }

      if (result.followers === 0 && result.likes === 0 && result.worksCount === 0) {
        var bodyText = document.body.innerText || '';
        var bodyResult = extractFromText(bodyText);
        result = bodyResult;
      }

      return result;
    `, 'extract-ks-overview');

    log('info', 'result', '账号概览数据提取完成', data);
    return data;
  }

  async collectWorksList(limit: number = 20, incremental?: {
    lastWorkId?: string;
    lastWorkPublishTime?: number;
  }): Promise<Array<{
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
    completionRate?: number;
    newFans?: number;
    extra?: Record<string, number | string>;
  }>> {
    const log = this.makeLog('ks-works');

    try {
      const analysisUrl = 'https://cp.kuaishou.com/statistics/article';
      
      log('info', 'network-listen', '开始监听作品分析 API');
      await this.startNetworkCollect(/\/rest\/cp\/creator\/analysis\/pc\/photo\/list/);

      log('info', 'goto', '跳转到作品分析页');
      await this.goto(analysisUrl, 3000);
      
      await sleep(8000);
      const firstPageData = await this.getLatestResponse();
      if (!firstPageData) {
        throw new Error('未获取到第一页数据');
      }
      log('info', 'first-page', '第一页 API 响应已捕获');

      const allWorks: Array<any> = [];
      const seenIds = new Set<string>();
      let hitIncrementalStop = false;

      const firstPageResult = this.parseAndAddWorks(firstPageData, allWorks, seenIds, log, incremental);
      const firstPageCount = firstPageResult.added;
      hitIncrementalStop = firstPageResult.hitStop;
      log('info', 'page-works', `第 1 页提取到 ${firstPageCount} 条作品（CDP 监听方式）${hitIncrementalStop ? '，增量停止' : ''}`);

      let page = 1;
      const maxPages = 50;
      let lastFirstPhotoId = '';
      if (allWorks.length > 0 && allWorks[0].extra?.photoId) {
        lastFirstPhotoId = allWorks[0].extra.photoId as string;
      }

      while (allWorks.length < limit && page < maxPages && !hitIncrementalStop) {
        const nextPage = page + 1;
        const beforeCount = this.getResponseCount();
        
        const clicked = await this.goToPage(nextPage);
        if (!clicked) {
          log('info', 'page-click-fail', `跳转到第 ${nextPage} 页失败，停止翻页`);
          break;
        }

        try {
          const nextPageData = await this.waitForNewResponse(beforeCount, 15000);
          
          const pageWorks: Array<any> = [];
          const pageSeen = new Set<string>();
          const pageResult = this.parseAndAddWorks(nextPageData, pageWorks, pageSeen, log);
          const added = pageResult.added;
          
          let currentFirstPhotoId = '';
          if (pageWorks.length > 0 && pageWorks[0].extra?.photoId) {
            currentFirstPhotoId = pageWorks[0].extra.photoId as string;
          }
          
          if (added > 0 && lastFirstPhotoId && currentFirstPhotoId === lastFirstPhotoId) {
            log('warn', 'page-same', `第 ${nextPage} 页数据与上一页相同，可能翻页未生效，停止翻页`);
            break;
          }
          if (added > 0) {
            lastFirstPhotoId = currentFirstPhotoId;
          }

          const mainResult = this.parseAndAddWorks(nextPageData, allWorks, seenIds, log, incremental);
          hitIncrementalStop = mainResult.hitStop;
          page++;
          log('info', 'page-works', `第 ${page} 页提取到 ${mainResult.added} 条作品（CDP 监听方式），累计 ${allWorks.length} 条${hitIncrementalStop ? '，增量停止' : ''}`);
          
          if (mainResult.added === 0 && !hitIncrementalStop) break;
          if (hitIncrementalStop) break;
        } catch (e) {
          log('warn', 'page-timeout', `第 ${nextPage} 页等待超时，停止翻页`);
          break;
        }

        if (allWorks.length >= limit) break;
        await sleep(500);
      }

      this.stopNetworkCollect();

      if (allWorks.length > 0) {
        const result = allWorks.slice(0, limit);
        log('info', 'done', `作品列表采集完成，共 ${result.length} 条（CDP 监听方式）`);
        return result;
      }
    } catch (e) {
      log('warn', 'cdp-error', `CDP 监听方式失败: ${(e as Error).message}`);
      try { this.stopNetworkCollect(); } catch {}
    }

    log('info', 'fallback', '回退到 DOM 解析方式');
    return this.collectWorksFallback(limit, log, incremental);
  }

  private getResponseCount(): number {
    return (this as any).networkCollector.responses.length;
  }

  private getLatestResponse(): any | null {
    const responses = (this as any).networkCollector.responses;
    if (responses.length === 0) return null;
    return responses[responses.length - 1].data;
  }

  private async waitForNewResponse(beforeCount: number, timeoutMs: number): Promise<any> {
    const log = this.makeLog('network');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if ((this as any).networkCollector.responses.length > beforeCount) {
        const responses = (this as any).networkCollector.responses;
        const latest = responses[responses.length - 1];
        log('info', 'new-response', `获取到新响应（第 ${responses.length} 个）`);
        return latest.data;
      }
      await sleep(200);
    }
    
    throw new Error(`等待新响应超时（${timeoutMs}ms）`);
  }

  private parseAndAddWorks(
    resp: any,
    allWorks: Array<any>,
    seenIds: Set<string>,
    log: ReturnType<typeof this.makeLog>,
    incremental?: { lastWorkId?: string; lastWorkPublishTime?: number },
  ): { added: number; hitStop: boolean } {
    if (!resp) {
      log('warn', 'parse-empty', '响应为空');
      return { added: 0, hitStop: false };
    }
    log('info', 'parse-debug', `响应结构: keys=${JSON.stringify(Object.keys(resp))}`);
    if (resp.data) {
      log('info', 'parse-debug-data', `data 结构: keys=${JSON.stringify(Object.keys(resp.data))}`);
    }
    if (resp.result !== 1) {
      log('warn', 'parse-not-success', `响应不成功: result=${resp.result}`);
      return { added: 0, hitStop: false };
    }
    const data = resp.data || {};
    const photoList = data.photoList || {};
    
    let items: any[] = [];
    if (Array.isArray(photoList)) {
      items = photoList;
    } else if (photoList && typeof photoList === 'object') {
      const possibleLists = ['photoItems', 'list', 'items', 'photos', 'photoList', 'records'];
      for (const key of possibleLists) {
        if (Array.isArray((photoList as any)[key])) {
          items = (photoList as any)[key];
          break;
        }
      }
    }
    if (items.length === 0 && Array.isArray(data.list)) items = data.list;
    if (items.length === 0 && Array.isArray(data.items)) items = data.items;
    if (items.length === 0) {
      log('info', 'parse-empty-list', '列表为空');
      return { added: 0, hitStop: false };
    }

    let count = 0;
    let hitStop = false;
    for (const item of items) {
      const photoId = item.photoId || item.photo_id || item.id || '';
      if (!photoId) continue;

      const workId = `ks_${photoId}`;

      if (incremental?.lastWorkId && workId === incremental.lastWorkId) {
        log('info', 'incremental-stop', `遇到已采集的最后作品ID: ${workId}，增量停止`);
        hitStop = true;
        break;
      }

      const publishTimeRaw = item.publishTime || item.publish_time || item.create_time || item.ctime || Date.now();
      const publishTime = typeof publishTimeRaw === 'number' ? publishTimeRaw * (publishTimeRaw < 1e12 ? 1000 : 1) : Date.now();

      if (incremental?.lastWorkPublishTime && publishTime <= incremental.lastWorkPublishTime) {
        log('info', 'incremental-stop', `遇到已采集的发布时间: ${new Date(publishTime).toISOString()}，增量停止`);
        hitStop = true;
        break;
      }

      if (seenIds.has(workId)) continue;
      seenIds.add(workId);

      const title = item.title || item.caption || item.name || '';
      const coverUrl = item.cover || item.cover_url || item.thumb_url || '';
      const detailUrl = photoId ? `https://www.kuaishou.com/short-video/${photoId}` : '';
      const duration = item.duration || 0;
      
      const views = parseZhNumber(String(item.playCount || item.view_count || item.play_count || item.views || 0));
      const likes = parseZhNumber(String(item.likeCount || item.like_count || item.likes || 0));
      const comments = parseZhNumber(String(item.commentCount || item.comment_count || item.comments || 0));
      const favorites = parseZhNumber(String(item.collectCount || item.collect_count || item.favorites || 0));
      const newFans = parseZhNumber(String(item.followCount || item.new_fans || item.fans_increase || 0));
      const completionRate = parsePercent(String(item.fpr || item.completion_rate || item.finish_rate || item.completeRate || 0));
      const shares = parseZhNumber(String(item.shareCount || item.share_count || item.shares || 0));

      allWorks.push({
        workId,
        title,
        coverUrl,
        publishTime,
        detailUrl,
        duration,
        contentType: 'video' as const,
        views,
        likes,
        comments,
        favorites,
        shares,
        completionRate,
        newFans,
        extra: {
          photoId,
        }
      });
      count++;
    }

    return { added: count, hitStop };
  }

  private async collectWorksFallback(
    limit: number,
    log: ReturnType<typeof this.makeLog>,
    incremental?: { lastWorkId?: string; lastWorkPublishTime?: number },
  ): Promise<Array<any>> {
    try {
      await this.waitForAnalysisData(15000);
    } catch {
      log('warn', 'wait-timeout', '等待作品分析数据加载超时，继续尝试提取');
    }

    const totalPages = await this.getTotalPages();
    log('info', 'pages', `共 ${totalPages} 页数据`);

    const allWorks: Array<any> = [];
    const seenIds = new Set<string>();
    let lastFirstTitle = '';

    for (let page = 1; page <= totalPages && allWorks.length < limit; page++) {
      if (page > 1) {
        const clicked = await this.goToPage(page);
        if (!clicked) {
          log('warn', 'page-fail', `跳转到第 ${page} 页失败`);
          break;
        }
        await sleep(2000);
        try {
          await this.waitForAnalysisData(8000);
        } catch {
          // ignore
        }
      }

      const pageWorks = await this.extractAnalysisPage(page);
      if (pageWorks.length > 0 && lastFirstTitle && pageWorks[0].title === lastFirstTitle) {
        log('warn', 'page-same', `第 ${page} 页数据与上一页相同，可能翻页未生效，停止翻页`);
        break;
      }
      if (pageWorks.length > 0) {
        lastFirstTitle = pageWorks[0].title;
      }

      let pageCount = 0;
      let hitIncrementalStop = false;
      for (const work of pageWorks) {
        if (incremental?.lastWorkId && work.workId === incremental.lastWorkId) {
          log('info', 'incremental-stop', `[DOM回退] 遇到已采集的最后作品ID: ${work.workId}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (incremental?.lastWorkPublishTime && work.publishTime && work.publishTime <= incremental.lastWorkPublishTime) {
          log('info', 'incremental-stop', `[DOM回退] 遇到已采集的发布时间: ${new Date(work.publishTime).toISOString()}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (seenIds.has(work.workId)) continue;
        seenIds.add(work.workId);
        allWorks.push(work);
        pageCount++;
        if (allWorks.length >= limit) break;
      }

      log('info', 'page-works', `第 ${page} 页提取到 ${pageCount} 条作品（DOM）${hitIncrementalStop ? '，增量停止' : ''}`);

      if (hitIncrementalStop) break;
      if (allWorks.length >= limit) break;
      if (pageWorks.length === 0) break;
    }

    const result = allWorks.slice(0, limit);
    log('info', 'done', `作品列表采集完成（DOM 回退），共 ${result.length} 条`);
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

  private async waitForAnalysisData(timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = await this.safeEval<number>(`
          var txt = document.body.innerText || '';
          var lines = txt.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          var count = 0;
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('发布于') === 0) count++;
          }
          return count;
        `, 'check-analysis-data');
        if (count > 0) return true;
      } catch {
        // ignore
      }
      await sleep(1000);
    }
    return false;
  }

  private async getTotalPages(): Promise<number> {
    try {
      return await this.safeEval<number>(`
        var pages = document.querySelectorAll('.el-pager li, .pagination li, [class*="page-item"]');
        var maxPage = 1;
        for (var i = 0; i < pages.length; i++) {
          var txt = (pages[i].innerText || '').trim();
          var n = parseInt(txt, 10);
          if (!isNaN(n) && n > maxPage && n <= 100) {
            maxPage = n;
          }
        }
        return maxPage;
      `, 'get-total-pages');
    } catch {
      return 1;
    }
  }

  private async goToPage(page: number): Promise<boolean> {
    try {
      const result = await this.safeEval<boolean>(`
        var pages = document.querySelectorAll('.el-pager li, .pagination li, [class*="page-item"]');
        var target = null;
        for (var i = 0; i < pages.length; i++) {
          var txt = (pages[i].innerText || '').trim();
          var num = parseInt(txt, 10);
          if (!isNaN(num) && num === ${page}) {
            target = pages[i];
            break;
          }
        }
        if (!target) return false;

        var isDisabled = target.classList.contains('disabled') || target.classList.contains('is-disabled') || target.classList.contains('active') || target.getAttribute('disabled') !== null;
        if (isDisabled) return false;

        target.scrollIntoView({ behavior: 'auto', block: 'center' });

        var clicked = false;
        try {
          target.click();
          clicked = true;
        } catch (e) {
          clicked = false;
        }

        if (!clicked) {
          try {
            var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            target.dispatchEvent(evt);
            clicked = true;
          } catch (e2) {
            clicked = false;
          }
        }

        return clicked;
      `, 'go-to-page-' + page);
      return result;
    } catch {
      return false;
    }
  }

  private async extractAnalysisPage(page: number): Promise<Array<any>> {
    try {
      const data = await this.safeEval<any[]>(`
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

        function parsePercent(text) {
          if (!text) return 0;
          var t = text.trim().replace('%', '');
          var n = parseFloat(t);
          return isNaN(n) ? 0 : n;
        }

        function parseTime(text) {
          if (!text) return Date.now();
          var m = text.match(/发布于\\s*(\\d{4})-(\\d{2})-(\\d{2})\\s*(\\d{1,2}):(\\d{2}):(\\d{2})/);
          if (m) {
            return new Date(
              parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
              parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)
            ).getTime();
          }
          var m2 = text.match(/发布于\\s*(\\d{4})-(\\d{2})-(\\d{2})\\s*(\\d{1,2}):(\\d{2})/);
          if (m2) {
            return new Date(
              parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10),
              parseInt(m2[4], 10), parseInt(m2[5], 10)
            ).getTime();
          }
          return Date.now();
        }

        function extractTitle(fullText) {
          if (!fullText) return '';
          var firstLine = fullText.split('\\n')[0] || '';
          var trimmed = firstLine.trim();
          if (trimmed.length > 80) {
            var cutIdx = trimmed.indexOf('。');
            if (cutIdx > 0 && cutIdx < 80) return trimmed.slice(0, cutIdx + 1);
            var spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 0 && spaceIdx < 80) return trimmed.slice(0, spaceIdx);
            return trimmed.slice(0, 80) + '...';
          }
          return trimmed;
        }

        var bodyText = document.body.innerText || '';
        var lines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

        var works = [];
        var pageNum = ${page};

        var i = 0;
        while (i < lines.length) {
          if (lines[i].indexOf('发布于') === 0) {
            var publishTime = parseTime(lines[i]);

            var titleLines = [];
            var j = i - 1;
            while (j >= 0 && j >= i - 20) {
              if (lines[j] === '查看数据' || lines[j] === '流量助推' ||
                  lines[j] === '公开作品' || lines[j].indexOf('作品分析') >= 0 ||
                  lines[j].indexOf('近90天') >= 0) {
                break;
              }
              if (lines[j].length > 3) {
                titleLines.unshift(lines[j]);
              }
              j--;
            }
            var fullTitle = titleLines.join(' ');
            var title = extractTitle(fullTitle);

            var metrics = {};
            var k = i + 1;
            var currentLabel = '';
            while (k < lines.length && k < i + 30) {
              var line = lines[k];
              if (line.indexOf('发布于') === 0) break;
              if (line === '查看数据' || line === '流量助推' || line.indexOf('助推') >= 0) {
                k++;
                continue;
              }

              if (line === '播放量' || line === '播放' || line === '播放数') {
                currentLabel = 'views';
                k++;
                continue;
              }
              if (line === '完播率') {
                currentLabel = 'completionRate';
                k++;
                continue;
              }
              if (line === '评论量' || line === '评论数' || line === '评论') {
                currentLabel = 'comments';
                k++;
                continue;
              }
              if (line === '点赞量' || line === '点赞数' || line === '点赞') {
                currentLabel = 'likes';
                k++;
                continue;
              }
              if (line === '收藏量' || line === '收藏数' || line === '收藏') {
                currentLabel = 'favorites';
                k++;
                continue;
              }
              if (line === '涨粉量' || line === '涨粉数' || line === '涨粉' || line === '新增粉丝') {
                currentLabel = 'newFans';
                k++;
                continue;
              }
              if (line === '分享量' || line === '分享数' || line === '分享') {
                currentLabel = 'shares';
                k++;
                continue;
              }

              if (currentLabel && /^[\\d,\\.\\-%万千]+$/.test(line)) {
                if (currentLabel === 'completionRate') {
                  metrics.completionRate = parsePercent(line);
                } else {
                  metrics[currentLabel] = parseNum(line);
                }
                currentLabel = '';
              }
              k++;
            }

            if (title && title.length > 3 && (metrics.views || metrics.likes)) {
              var workId = 'ks_' + Math.abs(title.split('').reduce(function(a, c) {
                return ((a << 5) - a + c.charCodeAt(0)) | 0;
              }, 0)).toString(36) + '_p' + pageNum + '_' + works.length;

              works.push({
                workId: workId,
                title: title,
                coverUrl: '',
                publishTime: publishTime,
                detailUrl: '',
                duration: 0,
                contentType: 'video',
                views: metrics.views || 0,
                likes: metrics.likes || 0,
                comments: metrics.comments || 0,
                favorites: metrics.favorites || 0,
                shares: metrics.shares || 0,
                completionRate: metrics.completionRate || 0,
                newFans: metrics.newFans || 0
              });
            }
          }
          i++;
        }
        return works;
      `, 'extract-analysis-page-' + page);

      return data;
    } catch (e) {
      logger.error('[KuaishouCollector] 提取作品分析页失败', { page, error: (e as Error).message });
      return [];
    }
  }
}
