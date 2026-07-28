import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential } from '../../../../types';
import { sleep } from '../../platforms/shared';

function parseZhNumber(text: string | number | undefined | null): number {
  if (text === undefined || text === null) return 0;
  if (typeof text === 'number') return text;
  const t = String(text).trim();
  if (!t) return 0;
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
      const overviewApi = 'https://creator.xiaohongshu.com/api/galaxy/creator/datacenter/overview';
      log('info', 'api', '调用概览数据 API');
      const resp: any = await this.fetchAPI(overviewApi, 'fetch-overview', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
        }
      });
      
      if (resp && resp.success && resp.data) {
        const data = resp.data;
        const followers = parseZhNumber(data.fans_num || data.follower_count || 0);
        const following = parseZhNumber(data.following_num || data.follow_count || 0);
        const likes = parseZhNumber(data.liked_num || data.like_count || 0);
        const collects = parseZhNumber(data.collected_num || data.collect_count || 0);
        const worksCount = parseZhNumber(data.note_num || data.notes_count || data.works_count || 0);

        log('info', 'result', '概览 API 数据提取完成', {
          followers, following, likes, collects, worksCount
        });

        return {
          followers,
          following,
          likes: likes + collects,
          worksCount,
          extra: {
            collects,
            likesOnly: likes,
          },
        };
      }
      log('warn', 'api-fallback', '概览 API 返回异常，回退到 DOM 解析');
    } catch (e) {
      log('warn', 'api-error', `概览 API 调用失败: ${(e as Error).message}，回退到 DOM 解析`);
    }

    return this.collectOverviewFallback(log);
  }

  private async collectOverviewFallback(log: ReturnType<typeof this.makeLog>) {
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

      function looksLikeNumber(text) {
        if (!text) return false;
        var t = text.trim();
        if (t.length === 0 || t.length > 15) return false;
        return /^[\\d,\\.]+[万千wkWK]?$/.test(t);
      }

      function findValueNearLabel(lines, labels) {
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          var matched = false;
          for (var l = 0; l < labels.length; l++) {
            if (line === labels[l] || line.indexOf(labels[l]) === 0 && line.length < labels[l].length + 8) {
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

        var followers = findValueNearLabel(lines, ['粉丝数', '粉丝']);
        var following = findValueNearLabel(lines, ['关注数', '关注']);
        var likes = 0;
        var collects = 0;
        var likeCollect = findValueNearLabel(lines, ['获赞与收藏', '获赞和收藏', '总获赞与收藏']);
        if (likeCollect > 0) {
          likes = likeCollect;
          collects = likeCollect;
        } else {
          likes = findValueNearLabel(lines, ['获赞数', '获赞', '点赞数', '点赞']);
          collects = findValueNearLabel(lines, ['收藏数', '收藏']);
        }
        var worksCount = findValueNearLabel(lines, ['笔记数', '笔记篇数', '作品数', '作品篇数']);

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
      }

      var result = { followers: 0, following: 0, likes: 0, worksCount: 0, collects: 0 };

      var selectors = [
        '.user-info', '.account-info', '.profile-card', '.user-card',
        '.header-info', '.top-info', '.data-card', '.stat-card',
        '.creator-info', '.creator-data', '.account-data',
        '[class*="user-info"]', '[class*="profile"]', '[class*="stat"]',
        '[class*="data-card"]'
      ];

      for (var s = 0; s < selectors.length; s++) {
        var els = document.querySelectorAll(selectors[s]);
        for (var e = 0; e < els.length; e++) {
          var txt = els[e].innerText || '';
          if (txt.length < 10 || txt.length > 2000) continue;
          var hasFan = txt.indexOf('粉丝') >= 0;
          var hasFollow = txt.indexOf('关注') >= 0;
          var hasLike = txt.indexOf('获赞') >= 0 || txt.indexOf('收藏') >= 0;
          if (hasFan && (hasFollow || hasLike)) {
            var extracted = extractFromText(txt);
            if (extracted.followers > 0 || extracted.likes > 0) {
              result.followers = extracted.followers || result.followers;
              result.following = extracted.following || result.following;
              result.likes = extracted.likes || result.likes;
              result.worksCount = extracted.worksCount || result.worksCount;
              result.collects = extracted.collects || result.collects;
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
    `, 'extract-xhs-overview');

    log('info', 'result', '账号概览数据提取完成（DOM 回退）', {
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

  async collectWorksList(limit: number = 50, incremental?: {
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
    impressions?: number;
    clickRate?: number;
    newFans?: number;
    avgPlayDuration?: number;
    extra?: Record<string, number | string>;
  }>> {
    const log = this.makeLog('xhs-works');

    try {
      const analysisUrl = 'https://creator.xiaohongshu.com/statistics/data-analysis?source=official';
      
      log('info', 'network-listen', '开始监听内容分析 API');
      await this.startNetworkCollect(/\/api\/galaxy\/creator\/datacenter\/note\/analyze\/list/);

      log('info', 'goto', '跳转到内容分析页');
      await this.goto(analysisUrl, 3000);
      
      await sleep(2000);
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
      let lastFirstNoteId = '';
      if (allWorks.length > 0 && allWorks[0].extra?.noteId) {
        lastFirstNoteId = allWorks[0].extra.noteId as string;
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
          
          let currentFirstNoteId = '';
          if (pageWorks.length > 0 && pageWorks[0].extra?.noteId) {
            currentFirstNoteId = pageWorks[0].extra.noteId as string;
          }
          
          if (added > 0 && lastFirstNoteId && currentFirstNoteId === lastFirstNoteId) {
            log('warn', 'page-same', `第 ${nextPage} 页数据与上一页相同，可能翻页未生效，停止翻页`);
            break;
          }
          if (added > 0) {
            lastFirstNoteId = currentFirstNoteId;
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
    return this.networkCollector.responses.length;
  }

  private getLatestResponse(): any | null {
    const responses = this.networkCollector.responses;
    if (responses.length === 0) return null;
    return responses[responses.length - 1].data;
  }

  private async waitForNewResponse(beforeCount: number, timeoutMs: number): Promise<any> {
    const log = this.makeLog('network');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.networkCollector.responses.length > beforeCount) {
        const latest = this.networkCollector.responses[this.networkCollector.responses.length - 1];
        log('info', 'new-response', `获取到新响应（第 ${this.networkCollector.responses.length} 个）`);
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
    if (!resp.success) {
      log('warn', 'parse-not-success', `响应不成功: code=${resp.code}, msg=${resp.msg || resp.message}`);
      return { added: 0, hitStop: false };
    }
    if (!resp.data) {
      log('warn', 'parse-no-data', '响应中没有 data 字段');
      return { added: 0, hitStop: false };
    }

    const items = resp.data.notes || resp.data.note_infos || resp.data.list || resp.data.items || [];
    if (items.length === 0) {
      log('warn', 'parse-empty-items', `data 中没有找到列表数据，data keys: ${Object.keys(resp.data).join(', ')}`);
    }
    let added = 0;
    let hitStop = false;

    for (const item of items) {
      const noteId = item.id || item.note_id || item.noteId || '';
      if (!noteId) continue;

      const workId = `xhs_${noteId}`;

      if (incremental?.lastWorkId && workId === incremental.lastWorkId) {
        log('info', 'incremental-stop', `遇到已采集的最后作品ID: ${workId}，增量停止`);
        hitStop = true;
        break;
      }

      const publishTimeRaw = item.post_time || item.publish_time || item.create_time || item.ctime || Date.now();
      const publishTime = typeof publishTimeRaw === 'number' ? publishTimeRaw * (publishTimeRaw < 1e12 ? 1000 : 1) : Date.now();

      if (incremental?.lastWorkPublishTime && publishTime <= incremental.lastWorkPublishTime) {
        log('info', 'incremental-stop', `遇到已采集的发布时间: ${new Date(publishTime).toISOString()}，增量停止`);
        hitStop = true;
        break;
      }

      if (seenIds.has(workId)) continue;
      seenIds.add(workId);

      const title = item.title || item.note_title || '';
      let coverUrl = item.cover || item.cover_url || item.thumb_url || '';
      if (coverUrl && coverUrl.startsWith('http://')) {
        coverUrl = coverUrl.replace('http://', 'https://');
      }
      const detailUrl = noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : '';
      
      const views = parseZhNumber(item.read_count || item.play_count || item.view_count || item.views || item.view || 0);
      const likes = parseZhNumber(item.like_count || item.likes || item.like || 0);
      const comments = parseZhNumber(item.comment_count || item.comments || item.comment || 0);
      const favorites = parseZhNumber(item.fav_count || item.collect_count || item.favorites || item.collect || 0);
      const shares = parseZhNumber(item.share_count || item.shares || item.share || 0);
      const impressions = parseZhNumber(item.imp_count || item.impression_count || item.exposure || item.impressions || 0);
      const clickRate = item.coverClickRate || item.ctr || item.click_rate || 0;
      const newFans = parseZhNumber(item.increase_fans_count || item.new_fans || item.new_follower || 0);
      const avgPlayDuration = item.view_time_avg || item.avg_play_duration || item.avg_play_time || item.avg_duration || 0;

      const isVideo = item.type === 2 || item.note_type === 'video' || item.media_type === 'video';
      const contentType = isVideo ? 'video' : (item.type === 1 ? 'article' : 'image');
      const duration = isVideo ? (item.duration || item.video_duration || 0) : 0;

      allWorks.push({
        workId,
        title,
        coverUrl,
        publishTime,
        detailUrl,
        duration,
        contentType: contentType as any,
        views,
        likes,
        comments,
        favorites,
        shares,
        impressions,
        clickRate: typeof clickRate === 'number' ? clickRate : parseFloat(clickRate) || 0,
        newFans,
        avgPlayDuration,
        extra: {
          noteId,
        }
      });
      added++;
    }

    return { added, hitStop };
  }

  private async clickNextPage(): Promise<boolean> {
    try {
      return await this.safeEval<boolean>(`
        var nextSelectors = [
          '.next', '.next-page', '.pagination-next', '.ant-pagination-next',
          '.d-pagination-next', '.page-next', '[class*="pagination-next"]',
          '.d-pagination .d-pagination-item-next', '.d-pagination-item-next'
        ];
        for (var s = 0; s < nextSelectors.length; s++) {
          var btn = document.querySelector(nextSelectors[s]);
          if (btn) {
            var isDisabled = btn.classList.contains('disabled') || btn.classList.contains('is-disabled') || btn.getAttribute('disabled') !== null;
            if (isDisabled) return false;
            btn.scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              btn.click();
              return true;
            } catch (e) {
              try {
                var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                btn.dispatchEvent(evt);
                return true;
              } catch (e2) {
                return false;
              }
            }
          }
        }

        var allBtns = document.querySelectorAll('button, a, li, div[class*="page"], span[class*="page"]');
        for (var i = 0; i < allBtns.length; i++) {
          var txt = (allBtns[i].innerText || '').trim();
          if (txt === '下一页' || txt === '>' || txt === '»' || txt === '→' || txt.indexOf('下一页') >= 0) {
            var isDis = allBtns[i].classList.contains('disabled') || allBtns[i].classList.contains('is-disabled') || allBtns[i].getAttribute('disabled') !== null;
            if (isDis) return false;
            allBtns[i].scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              allBtns[i].click();
              return true;
            } catch (e) {
              try {
                var evt2 = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                allBtns[i].dispatchEvent(evt2);
                return true;
              } catch (e3) {
                return false;
              }
            }
          }
        }
        return false;
      `, 'click-next-page');
    } catch {
      return false;
    }
  }

  private async collectWorksFallback(
    limit: number,
    log: ReturnType<typeof this.makeLog>,
    incremental?: { lastWorkId?: string; lastWorkPublishTime?: number },
  ): Promise<Array<any>> {
    const analysisUrl = 'https://creator.xiaohongshu.com/statistics/data-analysis?source=official';
    log('info', 'goto-fallback', '跳转到内容分析页（DOM 回退）');
    await this.goto(analysisUrl, 3000);
    await sleep(5000);

    try {
      await this.waitForAnalysisData(15000);
    } catch {
      log('warn', 'wait-timeout', '等待内容分析数据加载超时，继续尝试提取');
    }

    const totalPages = await this.getTotalPages();
    log('info', 'pages', `共 ${totalPages} 页数据`);

    const allWorks: Array<any> = [];
    const seenIds = new Set<string>();
    let lastFirstTitle = '';

    for (let page = 1; page <= totalPages && allWorks.length < limit; page++) {
      if (page > 1) {
        const nextClicked = await this.goToNextPage();
        if (!nextClicked) {
          const numClicked = await this.goToPage(page);
          if (!numClicked) {
            log('warn', 'page-fail', `跳转到第 ${page} 页失败`);
            break;
          }
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
        var selectors = ['.d-pagination-page', '.pagination .page-item', '.pagination li', '.ant-pagination-item', 'li.page-number'];
        var pages = null;
        for (var s = 0; s < selectors.length; s++) {
          pages = document.querySelectorAll(selectors[s]);
          if (pages.length > 0) break;
        }
        if (!pages || pages.length === 0) return 1;

        var maxPage = 1;
        for (var i = 0; i < pages.length; i++) {
          var txt = (pages[i].innerText || '').trim();
          var n = parseInt(txt, 10);
          if (!isNaN(n) && n > maxPage) {
            maxPage = n;
          }
        }
        return maxPage;
      `, 'get-total-pages');
    } catch {
      return 1;
    }
  }

  private async goToNextPage(): Promise<boolean> {
    try {
      return await this.safeEval<boolean>(`
        var nextSelectors = [
          '.next', '.next-page', '.pagination-next', '.ant-pagination-next',
          '.d-pagination-next', '.page-next', '[class*="pagination-next"]',
          '.d-pagination .d-pagination-item-next', '.d-pagination-item-next'
        ];
        for (var s = 0; s < nextSelectors.length; s++) {
          var btn = document.querySelector(nextSelectors[s]);
          if (btn) {
            var isDisabled = btn.classList.contains('disabled') || btn.classList.contains('is-disabled') || btn.getAttribute('disabled') !== null;
            if (isDisabled) return false;
            btn.scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              btn.click();
              return true;
            } catch (e) {
              try {
                var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                btn.dispatchEvent(evt);
                return true;
              } catch (e2) {
                return false;
              }
            }
          }
        }

        var allBtns = document.querySelectorAll('button, a, li, div[class*="page"], span[class*="page"]');
        for (var i = 0; i < allBtns.length; i++) {
          var txt = (allBtns[i].innerText || '').trim();
          if (txt === '下一页' || txt === '下一页' || txt === '>' || txt === '»' || txt === '→' || txt.indexOf('下一页') >= 0) {
            var isDis = allBtns[i].classList.contains('disabled') || allBtns[i].classList.contains('is-disabled') || allBtns[i].getAttribute('disabled') !== null;
            if (isDis) return false;
            allBtns[i].scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              allBtns[i].click();
              return true;
            } catch (e) {
              try {
                var evt2 = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                allBtns[i].dispatchEvent(evt2);
                return true;
              } catch (e3) {
                return false;
              }
            }
          }
        }
        return false;
      `, 'go-to-next-page');
    } catch {
      return false;
    }
  }

  private async goToPage(page: number): Promise<boolean> {
    try {
      const result = await this.safeEval<boolean>(`
        var selectors = ['.d-pagination-page', '.pagination .page-item', '.pagination li', '.ant-pagination-item', 'li.page-number', '.page-item', '.pagination-item'];
        var pages = null;
        for (var s = 0; s < selectors.length; s++) {
          pages = document.querySelectorAll(selectors[s]);
          if (pages.length > 0) break;
        }
        if (!pages || pages.length === 0) return false;

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

        function parseDuration(text) {
          if (!text) return 0;
          var t = text.trim();
          var m = t.match(/(\\d+)s/);
          if (m) return parseInt(m[1], 10) || 0;
          return 0;
        }

        function parseTime(text) {
          if (!text) return Date.now();
          var m = text.match(/发布于(\\d{4})-(\\d{2})-(\\d{2})\\s*(\\d{1,2}):(\\d{2})/);
          if (m) {
            return new Date(
              parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
              parseInt(m[4], 10), parseInt(m[5], 10)
            ).getTime();
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

        function extractNoteIdFromElement(el) {
          if (!el) return '';
          var href = el.getAttribute('href') || '';
          var m = href.match(/explore\\/([a-z0-9]+)/i);
          if (m) return m[1];
          var dataId = el.getAttribute('data-note-id') || el.getAttribute('data-id') || el.getAttribute('note-id') || '';
          if (dataId) return dataId;
          var allLinks = el.querySelectorAll('a[href*="explore"], a[href*="discovery/item"]');
          for (var i = 0; i < allLinks.length; i++) {
            var h = allLinks[i].getAttribute('href') || '';
            var m2 = h.match(/explore\\/([a-z0-9]+)/i);
            if (m2) return m2[1];
            var m3 = h.match(/note_id=([a-z0-9]+)/i);
            if (m3) return m3[1];
          }
          return '';
        }

        var noteElements = document.querySelectorAll('[class*="note-item"], [class*="list-item"], [class*="card"], tr, [class*="row"]');
        var works = [];
        var pageNum = ${page};

        for (var idx = 0; idx < noteElements.length; idx++) {
          var el = noteElements[idx];
          var txt = el.innerText || '';
          if (txt.indexOf('发布于') < 0) continue;
          
          var lines = txt.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          if (lines.length < 6) continue;

          var noteId = extractNoteIdFromElement(el);
          var title = '';
          var publishTime = 0;
          var nums = [];

          for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('发布于') === 0) {
              publishTime = parseTime(lines[i]);
              if (i > 0) title = dedupTitle(lines[i - 1]);
              for (var j = i + 1; j < lines.length && nums.length < 12; j++) {
                var line = lines[j];
                if (line.length > 30) break;
                if (/^[\\d.%s万wk,\\-]+$/.test(line) || line.indexOf('%') >= 0 || line.indexOf('s') >= 0) {
                  nums.push(line);
                } else {
                  break;
                }
              }
              break;
            }
          }

          if (!title || title.length < 5 || nums.length < 6) continue;

          var workId;
          if (noteId) {
            workId = 'xhs_' + noteId;
          } else {
            workId = 'xhs_' + Math.abs(title.split('').reduce(function(a, c) {
              return ((a << 5) - a + c.charCodeAt(0)) | 0;
            }, 0)).toString(36) + '_p' + pageNum + '_' + works.length;
          }

          var exposure = parseNum(nums[0] || '0');
          var views = parseNum(nums[1] || '0');
          var coverClickRate = parsePercent(nums[2] || '0');
          var likes = parseNum(nums[3] || '0');
          var comments = parseNum(nums[4] || '0');
          var favorites = parseNum(nums[5] || '0');
          var newFans = nums.length > 6 ? parseNum(nums[6] || '0') : 0;
          var shares = nums.length > 7 ? parseNum(nums[7] || '0') : 0;
          var avgDuration = nums.length > 8 ? parseDuration(nums[8] || '0') : 0;
          var danmaku = nums.length > 9 ? parseNum(nums[9] || '0') : 0;

          var isVideo = avgDuration > 0;

          works.push({
            workId: workId,
            title: title,
            coverUrl: '',
            publishTime: publishTime,
            detailUrl: noteId ? 'https://www.xiaohongshu.com/explore/' + noteId : '',
            duration: isVideo ? avgDuration : 0,
            contentType: isVideo ? 'video' : 'image',
            views: views,
            likes: likes,
            comments: comments,
            favorites: favorites,
            shares: shares,
            impressions: exposure,
            clickRate: coverClickRate,
            newFans: newFans,
            avgPlayDuration: avgDuration,
            extra: {
              danmaku: danmaku,
              noteId: noteId || ''
            }
          });
        }

        if (works.length > 0) return works;

        var bodyText = document.body.innerText || '';
        var bodyLines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
        var bodyWorks = [];
        var inDataSection = false;

        for (var i = 0; i < bodyLines.length; i++) {
          if (bodyLines[i] === '笔记基础信息') { inDataSection = true; continue; }
          if (!inDataSection) continue;

          var t = bodyLines[i];
          if (t.length < 5 || t.length > 100) continue;
          if (t === '详情数据') continue;
          if (t.indexOf('发布于') === 0) continue;
          if (t.match(/^[\\d.%s万wk,\\-]+$/)) continue;

          if (i + 1 < bodyLines.length && bodyLines[i + 1].indexOf('发布于') === 0) {
            var pubTime = parseTime(bodyLines[i + 1]);
            var bodyNums = [];
            var j = i + 2;
            while (j < bodyLines.length && bodyNums.length < 12) {
              var line = bodyLines[j];
              if (line === '详情数据') break;
              if (line.indexOf('发布于') === 0) break;
              if (line.length > 30) break;
              if (/^[\\d.%s万wk,\\-]+$/.test(line) || line.indexOf('%') >= 0 || line.indexOf('s') >= 0) {
                bodyNums.push(line);
                j++;
              } else {
                break;
              }
            }

            if (bodyNums.length >= 6) {
              t = dedupTitle(t);
              var bodyWorkId = 'xhs_' + Math.abs(t.split('').reduce(function(a, c) {
                return ((a << 5) - a + c.charCodeAt(0)) | 0;
              }, 0)).toString(36) + '_p' + pageNum + '_' + bodyWorks.length;

              var expo = parseNum(bodyNums[0] || '0');
              var vws = parseNum(bodyNums[1] || '0');
              var ctr = parsePercent(bodyNums[2] || '0');
              var lks = parseNum(bodyNums[3] || '0');
              var cmts = parseNum(bodyNums[4] || '0');
              var favs = parseNum(bodyNums[5] || '0');
              var nf = bodyNums.length > 6 ? parseNum(bodyNums[6] || '0') : 0;
              var shs = bodyNums.length > 7 ? parseNum(bodyNums[7] || '0') : 0;
              var avgDur = bodyNums.length > 8 ? parseDuration(bodyNums[8] || '0') : 0;
              var dmk = bodyNums.length > 9 ? parseNum(bodyNums[9] || '0') : 0;

              var isVid = avgDur > 0;

              bodyWorks.push({
                workId: bodyWorkId,
                title: t,
                coverUrl: '',
                publishTime: pubTime,
                detailUrl: '',
                duration: isVid ? avgDur : 0,
                contentType: isVid ? 'video' : 'image',
                views: vws,
                likes: lks,
                comments: cmts,
                favorites: favs,
                shares: shs,
                impressions: expo,
                clickRate: ctr,
                newFans: nf,
                avgPlayDuration: avgDur,
                extra: {
                  danmaku: dmk
                }
              });
            }
            i = j - 1;
          }
        }
        return bodyWorks;
      `, 'extract-analysis-page-' + page);

      return data;
    } catch (e) {
      logger.error('[XiaohongshuCollector] 提取内容分析页失败', { page, error: (e as Error).message });
      return [];
    }
  }
}
