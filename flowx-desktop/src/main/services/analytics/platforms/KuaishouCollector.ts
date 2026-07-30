import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential, AccountAnalyticsPeriodData } from '../../../../types';
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

    // 优先使用快手数据中心页面——顶部导航栏固定显示：昵称 N粉丝 N关注 N获赞
    const overviewUrl = 'https://cp.kuaishou.com/statistics/works';
    log('info', 'goto', '跳转到快手数据中心作品页（含账号概览信息）');
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
        if (text == null) return 0;
        if (typeof text === 'number') return isNaN(text) ? 0 : text;
        var t = String(text).trim();
        if (!t) return 0;
        t = t.replace(/[,\\s]/g, '');
        var wm = t.match(/^([\\d.]+)([万wW亿千kK])?$/);
        if (!wm) {
          var n = parseFloat(t);
          return isNaN(n) ? 0 : Math.round(n);
        }
        var base = parseFloat(wm[1]);
        if (wm[2]) {
          if (/[万wW]/.test(wm[2])) base *= 10000;
          else if (/[千kK]/.test(wm[2])) base *= 1000;
          else if (/[亿]/.test(wm[2])) base *= 100000000;
        }
        return Math.round(base);
      }

      function looksLikeNumber(text) {
        if (!text) return false;
        var t = String(text).trim();
        if (t.length === 0 || t.length > 20) return false;
        return /^[\\d,\\.]+[万千wW亿kK]?$/.test(t);
      }

      function findByLabelValuePair(lines, labels) {
        for (var i = 0; i < lines.length; i++) {
          var line = (lines[i] || '').trim();
          var matched = false;
          for (var l = 0; l < labels.length; l++) {
            if (line === labels[l] || (line.indexOf(labels[l]) === 0 && line.length < labels[l].length + 5)) {
              matched = true; break;
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

      // ========== 关键修复：解析紧凑文本格式 「N粉丝N关注N获赞」「N粉丝 N关注 N获赞」 ==========
      function parseCompactText(text) {
        var res = { followers: 0, following: 0, likes: 0, worksCount: 0 };
        if (!text) return res;
        var s = String(text).replace(/[,，\\s]/g, '');

        // 粉丝数: <数字>粉丝
        var fm = s.match(/([\\d.]+[wW万亿千kK]?)粉丝/);
        if (fm && fm[1]) res.followers = parseNum(fm[1]);
        else {
          var fm2 = s.match(/粉丝[:：]*([\\d.]+[wW万亿千kK]?)/);
          if (fm2 && fm2[1]) res.followers = parseNum(fm2[1]);
        }

        // 关注数: <数字>关注
        var flm = s.match(/([\\d.]+[wW万亿千kK]?)关注/);
        if (flm && flm[1]) res.following = parseNum(flm[1]);
        else {
          var flm2 = s.match(/关注[:：]*([\\d.]+[wW万亿千kK]?)/);
          if (flm2 && flm2[1]) res.following = parseNum(flm2[1]);
        }

        // 获赞: <数字>获赞
        var lm = s.match(/([\\d.]+[wW万亿千kK]?)获赞/);
        if (lm && lm[1]) res.likes = parseNum(lm[1]);
        else {
          var lm2 = s.match(/获赞[:：]*([\\d.]+[wW万亿千kK]?)/);
          if (lm2 && lm2[1]) res.likes = parseNum(lm2[1]);
          else {
            // 兜底：点赞
            var lm3 = s.match(/点赞[:：]*([\\d.]+[wW万亿千kK]?)/);
            if (lm3 && lm3[1]) res.likes = parseNum(lm3[1]);
          }
        }

        // 作品数: <数字>作品
        var wm = s.match(/([\\d.]+[wW万亿千kK]?)作品/);
        if (wm && wm[1]) res.worksCount = parseNum(wm[1]);
        else {
          var wm2 = s.match(/作品[:：]*([\\d.]+[wW万亿千kK]?)/);
          if (wm2 && wm2[1]) res.worksCount = parseNum(wm2[1]);
        }

        return res;
      }

      function extractFromText(text) {
        var lines = String(text || '').split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
        return {
          followers: findByLabelValuePair(lines, ['粉丝', '粉丝数', '粉丝量']),
          following: findByLabelValuePair(lines, ['关注', '关注数', '关注量']),
          likes: findByLabelValuePair(lines, ['获赞', '总赞', '点赞', '总获赞', '累计赞']),
          worksCount: findByLabelValuePair(lines, ['作品数', '作品数量', '总作品', '全部作品', '发布作品', '我的作品']),
        };
      }

      function mergeResult(a, b) {
        return {
          followers: a.followers || b.followers,
          following: a.following || b.following,
          likes: a.likes || b.likes,
          worksCount: a.worksCount || b.worksCount,
        };
      }

      var result = { followers: 0, following: 0, likes: 0, worksCount: 0 };

      // ========== 第一步：顶部 header / nav 命中概率最高，先扫 ==========
      var topSelectors = [
        'header', '.header', '[class*="header"]',
        'nav', '.nav', '[class*="nav-bar"]', '[class*="navbar"]',
        '.user-info', '[class*="user-info"]',
        '.account-info', '[class*="account-info"]',
        '[class*="top-bar"]', '[class*="topbar"]',
      ];

      for (var s = 0; s < topSelectors.length; s++) {
        var els = document.querySelectorAll(topSelectors[s]);
        for (var e = 0; e < els.length; e++) {
          var txt = els[e].innerText || '';
          if (txt.length < 3 || txt.length > 5000) continue;
          // 先用正则「N粉丝N关注N获赞」精准匹配
          if (txt.indexOf('粉丝') >= 0 && txt.indexOf('关注') >= 0) {
            var compact = parseCompactText(txt);
            if (compact.followers > 0 || compact.following > 0 || compact.likes > 0) {
              result = mergeResult(result, compact);
            }
            // 再用 label-value 兜底
            var lineBased = extractFromText(txt);
            result = mergeResult(result, lineBased);
          }
        }
      }

      // ========== 第二步：如果还没取到，扩大范围到各种卡片 ==========
      var anyEmpty = result.followers === 0 || result.following === 0 || result.likes === 0;
      if (anyEmpty) {
        var selectors = [
          '.profile-card', '.user-card',
          '.header-info', '.top-info', '.data-card', '.stat-card',
          '[class*="profile"]', '[class*="stat"]', '[class*="info-card"]',
        ];
        for (var s2 = 0; s2 < selectors.length; s2++) {
          var els2 = document.querySelectorAll(selectors[s2]);
          for (var e2 = 0; e2 < els2.length; e2++) {
            var txt2 = els2[e2].innerText || '';
            if (txt2.length < 10 || txt2.length > 3000) continue;
            var hasFan = txt2.indexOf('粉丝') >= 0;
            var hasFollow = txt2.indexOf('关注') >= 0;
            var hasLike = txt2.indexOf('获赞') >= 0 || txt2.indexOf('点赞') >= 0;
            if (hasFan || hasFollow || hasLike) {
              var compact2 = parseCompactText(txt2);
              result = mergeResult(result, compact2);
              var lb = extractFromText(txt2);
              result = mergeResult(result, lb);
            }
          }
        }
      }

      // ========== 第三步：整页文本兜底 + 正则 ==========
      if (result.followers === 0 && result.likes === 0 && result.worksCount === 0) {
        var bodyText = document.body.innerText || '';
        var compact3 = parseCompactText(bodyText);
        result = mergeResult(result, compact3);
        if (result.followers === 0) {
          var bodyResult = extractFromText(bodyText);
          result = mergeResult(result, bodyResult);
        }
      }

      // ========== 第四步：兜底：直接找 window / __INITIAL_STATE__ / script JSON ==========
      try {
        var wholeHtml = document.documentElement.outerHTML;
        if (!result.followers || !result.following || !result.likes) {
          var fromHtml = parseCompactText(wholeHtml);
          result = mergeResult(result, fromHtml);
        }
      } catch (_) {}

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

  async collectAccountAnalytics(): Promise<AccountAnalyticsPeriodData[]> {
    const log = this.makeLog('ks-analytics');
    const accountId = this.account.id;
    const collectedAt = Date.now();

    const worksUrl = 'https://cp.kuaishou.com/statistics/works';
    log('info', 'goto', '跳转到快手作品数据分析页');
    await this.goto(worksUrl, 3000);
    await sleep(6000);

    try {
      await this.waitForContent(10000);
    } catch {
      // ignore
    }

    log('info', 'extract-peer', '开始提取账号诊断雷达数据');
    const peerCompare = await this.extractPeerCompare(log);

    log('info', 'collect-periods', '开始按周期采集核心数据趋势');
    const periods: Array<'7d' | '30d'> = ['7d', '30d'];
    const result: AccountAnalyticsPeriodData[] = [];

    for (const period of periods) {
      log('info', 'switch-period', `切换到 ${period} 周期`);
      const periodLabel = period === '7d' ? '近7天' : '近30天';
      await this.clickPeriodRadio(periodLabel, log);
      await sleep(2000);

      const trendData = await this.extractTrendData(log, period);

      const periodData: AccountAnalyticsPeriodData = {
        id: `${accountId}_${period}_${collectedAt}`,
        accountId,
        platform: 'kuaishou',
        period,
        peerCompare,
        ...trendData,
        collectedAt,
      };

      result.push(periodData);
    }

    log('info', 'done', '账号分析采集完成', { periods: result.length });
    return result;
  }

  private async extractPeerCompare(log: ReturnType<typeof this.makeLog>): Promise<any[]> {
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

        function parseBeatPct(text) {
          if (!text) return -1;
          var t = text.trim();
          var beatMatch = t.match(/超过(\\d+(?:\\.\\d+)?)%/);
          if (beatMatch) {
            return parseFloat(beatMatch[1]);
          }
          var belowMatch = t.match(/低于(\\d+(?:\\.\\d+)?)%/);
          if (belowMatch) {
            return 100 - parseFloat(belowMatch[1]);
          }
          var numMatch = t.match(/(\\d+(?:\\.\\d+)?)%/);
          if (numMatch) {
            return parseFloat(numMatch[1]);
          }
          return -1;
        }

        var DIMENSION_MAP = [
          { labels: ['播放量', '播放'], dimension: 'views', key: '播放量' },
          { labels: ['投稿量', '投稿', '作品数', '作品量'], dimension: 'submissionCount', key: '投稿量' },
          { labels: ['收入量', '收入', '收益'], dimension: 'revenue', key: '收入量' },
          { labels: ['粉丝净增', '净增粉丝', '净增粉'], dimension: 'netFans', key: '粉丝净增' },
          { labels: ['铁粉总量', '铁粉数', '铁粉'], dimension: 'coreFansCount', key: '铁粉总量' },
          { labels: ['评论量', '评论数', '评论'], dimension: 'comments', key: '评论量' }
        ];

        function findDimensionKey(line) {
          for (var d = 0; d < DIMENSION_MAP.length; d++) {
            for (var l = 0; l < DIMENSION_MAP[d].labels.length; l++) {
              if (line === DIMENSION_MAP[d].labels[l] ||
                  (line.indexOf(DIMENSION_MAP[d].labels[l]) >= 0 &&
                   line.length < DIMENSION_MAP[d].labels[l].length + 10)) {
                return DIMENSION_MAP[d];
              }
            }
          }
          return null;
        }

        function extractValueAround(lines, idx) {
          for (var step = 1; step <= 6; step++) {
            if (idx + step < lines.length) {
              var next = lines[idx + step].trim();
              if (/^[\\d,\\.]+[万千%]?$/.test(next) && next.length <= 15) {
                if (next.indexOf('%') >= 0) {
                  return parseBeatPct(next);
                }
                return parseNum(next);
              }
              if (next.indexOf('超过') >= 0 || next.indexOf('低于') >= 0) {
                return parseBeatPct(next);
              }
            }
            if (idx - step >= 0) {
              var prev = lines[idx - step].trim();
              if (/^[\\d,\\.]+[万千%]?$/.test(prev) && prev.length <= 15) {
                if (prev.indexOf('%') >= 0) {
                  return parseBeatPct(prev);
                }
                return parseNum(prev);
              }
              if (prev.indexOf('超过') >= 0 || prev.indexOf('低于') >= 0) {
                return parseBeatPct(prev);
              }
            }
          }
          return 0;
        }

        function extractBeatPctAround(lines, idx) {
          for (var step = 1; step <= 8; step++) {
            if (idx + step < lines.length) {
              var next = lines[idx + step].trim();
              if (next.indexOf('超过') >= 0 || next.indexOf('低于') >= 0) {
                return parseBeatPct(next);
              }
              if (next.indexOf('%') >= 0 && next.length <= 20) {
                return parseBeatPct(next);
              }
            }
            if (idx - step >= 0) {
              var prev = lines[idx - step].trim();
              if (prev.indexOf('超过') >= 0 || prev.indexOf('低于') >= 0) {
                return parseBeatPct(prev);
              }
              if (prev.indexOf('%') >= 0 && prev.length <= 20) {
                return parseBeatPct(prev);
              }
            }
          }
          return -1;
        }

        var results = [];
        var found = {};

        var cardSelectors = [
          '[class*="radar"]', '[class*="diagnose"]', '[class*="diagnosis"]',
          '[class*="peer"]', '[class*="compare"]', '[class*="account-card"]',
          '[class*="data-card"]', '[class*="stat-card"]', '[class*="metric-card"]'
        ];

        var allTexts = [];
        for (var s = 0; s < cardSelectors.length; s++) {
          try {
            var cards = document.querySelectorAll(cardSelectors[s]);
            for (var c = 0; c < cards.length; c++) {
              var txt = (cards[c].innerText || '').trim();
              if (txt.length >= 20 && txt.length <= 3000) {
                allTexts.push(txt);
              }
            }
          } catch (e) {}
        }

        var bodyText = document.body.innerText || '';
        allTexts.push(bodyText);

        for (var ti = 0; ti < allTexts.length; ti++) {
          var text = allTexts[ti];
          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var dimInfo = findDimensionKey(line);
            if (!dimInfo) continue;
            if (found[dimInfo.dimension]) continue;

            var mine = extractValueAround(lines, i);
            var beatPct = extractBeatPctAround(lines, i);

            if (beatPct >= 0 || mine > 0) {
              results.push({
                dimension: dimInfo.key,
                mine: mine || 0,
                beatPct: beatPct
              });
              found[dimInfo.dimension] = true;
            }
          }

          if (results.length >= 6) break;
        }

        return results;
      `, 'extract-peer-compare');

      log('info', 'peer-done', `提取到 ${data.length} 个维度的同类对比数据`);
      return data;
    } catch (e) {
      log('warn', 'peer-fail', `账号诊断提取失败: ${(e as Error).message}`);
      return [];
    }
  }

  private async clickPeriodRadio(label: string, log: ReturnType<typeof this.makeLog>): Promise<boolean> {
    try {
      const result = await this.safeEval<boolean>(`
        var targetLabel = '${label}';
        var allElements = document.querySelectorAll('*');
        var clicked = false;

        for (var i = 0; i < allElements.length; i++) {
          var el = allElements[i];
          var txt = '';
          try {
            txt = (el.innerText || el.textContent || '').trim();
          } catch (e) {
            continue;
          }
          if (txt !== targetLabel && !(txt.indexOf(targetLabel) >= 0 && txt.length <= targetLabel.length + 4)) continue;

          var tagName = (el.tagName || '').toLowerCase();
          if (tagName === 'input' || tagName === 'radio' || el.getAttribute('role') === 'radio') {
            try {
              el.click();
              clicked = true;
              break;
            } catch (e) {}
          }

          try {
            el.click();
            clicked = true;
            break;
          } catch (e2) {
            try {
              var parent = el.parentElement;
              if (parent) {
                parent.click();
                clicked = true;
                break;
              }
            } catch (e3) {}
          }
        }

        if (!clicked) {
          var radios = document.querySelectorAll('input[type="radio"], [role="radio"]');
          for (var r = 0; r < radios.length; r++) {
            var radio = radios[r];
            var radioTxt = '';
            try {
              radioTxt = (radio.parentElement ? (radio.parentElement.innerText || '') : '') || '';
              radioTxt = radioTxt.trim();
            } catch (e4) {}
            if (radioTxt.indexOf(targetLabel) >= 0) {
              try {
                radio.click();
                clicked = true;
                break;
              } catch (e5) {}
            }
          }
        }

        if (!clicked) {
          var spans = document.querySelectorAll('span, label, div, a, li');
          for (var j = 0; j < spans.length; j++) {
            var sp = spans[j];
            var spTxt = '';
            try {
              spTxt = (sp.innerText || '').trim();
            } catch (e6) {
              continue;
            }
            if (spTxt.indexOf(targetLabel) >= 0 && spTxt.length <= 20) {
              try {
                sp.click();
                clicked = true;
                break;
              } catch (e7) {}
            }
          }
        }

        if (!clicked) {
          try {
            var e9 = document.getElementById('e9');
            if (e9 && targetLabel === '近7天') {
              e9.click();
              clicked = true;
            }
          } catch (e8) {}
          try {
            var e24 = document.getElementById('e24');
            if (e24 && targetLabel === '近30天') {
              e24.click();
              clicked = true;
            }
          } catch (e9) {}
        }

        return clicked;
      `, 'click-period-' + label);

      log('info', 'period-click', `点击 ${label}: ${result ? '成功' : '失败'}`);
      return result;
    } catch (e) {
      log('warn', 'period-click-fail', `点击 ${label} 异常: ${(e as Error).message}`);
      return false;
    }
  }

  private async extractTrendData(
    log: ReturnType<typeof this.makeLog>,
    period: '7d' | '30d'
  ): Promise<Partial<AccountAnalyticsPeriodData>> {
    try {
      const raw = await this.safeEval<Record<string, any>>(`
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

        function parseChangePct(text) {
          if (!text) return null;
          var t = text.trim();
          if (t.indexOf('--') >= 0 || t.indexOf('- -') >= 0) return null;
          var match = t.match(/([+\\-]?\\d+(?:\\.\\d+)?)%/);
          if (match) return parseFloat(match[1]);
          var numMatch = t.match(/昨日\\s*([+\\-]?\\d+(?:\\.\\d+)?)/);
          if (numMatch) return parseFloat(numMatch[1]);
          return null;
        }

        var METRIC_MAP = [
          { labels: ['播放量', '播放数', '播放次数'], key: 'views', type: 'num' },
          { labels: ['点赞量', '点赞数', '点赞次数'], key: 'likes', type: 'num' },
          { labels: ['净增粉丝量', '净增粉丝', '粉丝净增', '净增粉量'], key: 'netFans', type: 'num' },
          { labels: ['完播率'], key: 'completionRate', type: 'percent' },
          { labels: ['评论量', '评论数', '评论次数'], key: 'comments', type: 'num' },
          { labels: ['分享量', '分享数', '转发量', '转发数'], key: 'shares', type: 'num' },
          { labels: ['作品量', '作品数', '发布作品数', '投稿数', '投稿量'], key: 'publishCount', type: 'num' },
          { labels: ['完成播放量', '完播数', '完成播放次数'], key: 'completedViews', type: 'num' },
          { labels: ['涨粉量', '涨粉数', '新增粉丝量', '新增粉丝数', '新增关注'], key: 'newFans', type: 'num' }
        ];

        function findMetricKey(line) {
          for (var m = 0; m < METRIC_MAP.length; m++) {
            for (var l = 0; l < METRIC_MAP[m].labels.length; l++) {
              if (line === METRIC_MAP[m].labels[l] ||
                  (line.indexOf(METRIC_MAP[m].labels[l]) >= 0 &&
                   line.length <= METRIC_MAP[m].labels[l].length + 10)) {
                return METRIC_MAP[m];
              }
            }
          }
          return null;
        }

        function extractMetricCardValue(lines, idx, metricType) {
          var value = 0;
          var changePct = null;

          for (var step = 1; step <= 8; step++) {
            if (idx + step < lines.length) {
              var next = lines[idx + step].trim();

              if ((next.indexOf('昨日') >= 0 || next.indexOf('环比') >= 0) && changePct === null) {
                changePct = parseChangePct(next);
              }

              if (value === 0) {
                if (metricType === 'percent') {
                  if (/^[+\\-]?\\d+(?:\\.\\d+)?%$/.test(next) ||
                      (/^\\d+(?:\\.\\d+)?$/.test(next) && parseFloat(next) <= 100 && parseFloat(next) >= 0)) {
                    value = parsePercent(next);
                  }
                } else {
                  if (/^[+\\-]?[\\d,\\.]+[万千]?$/.test(next) && next.length <= 15) {
                    value = parseNum(next);
                  }
                }
              }

              if (value !== 0 && changePct !== null) break;
            }

            if (idx - step >= 0) {
              var prev = lines[idx - step].trim();

              if ((prev.indexOf('昨日') >= 0 || prev.indexOf('环比') >= 0) && changePct === null) {
                changePct = parseChangePct(prev);
              }

              if (value === 0) {
                if (metricType === 'percent') {
                  if (/^[+\\-]?\\d+(?:\\.\\d+)?%$/.test(prev) ||
                      (/^\\d+(?:\\.\\d+)?$/.test(prev) && parseFloat(prev) <= 100 && parseFloat(prev) >= 0)) {
                    value = parsePercent(prev);
                  }
                } else {
                  if (/^[+\\-]?[\\d,\\.]+[万千]?$/.test(prev) && prev.length <= 15) {
                    value = parseNum(prev);
                  }
                }
              }

              if (value !== 0 && changePct !== null) break;
            }
          }

          return { value, changePct };
        }

        function buildMetric(value, changePct, unit) {
          return {
            value: value || 0,
            changePct: changePct !== undefined ? changePct : null,
            unit: unit || undefined
          };
        }

        var result = {};
        var found = {};

        var cardSelectors = [
          '[class*="metric-card"]', '[class*="stat-card"]', '[class*="data-card"]',
          '[class*="trend"]', '[class*="trend-card"]', '[class*="core-data"]',
          '[class*="card-item"]', '[class*="indicator"]', '[class*="index-card"]',
          '[class*="overview"] [class*="item"]', '[class*="summary"] [class*="card"]'
        ];

        var allTexts = [];
        for (var s = 0; s < cardSelectors.length; s++) {
          try {
            var cards = document.querySelectorAll(cardSelectors[s]);
            for (var c = 0; c < cards.length; c++) {
              var txt = (cards[c].innerText || '').trim();
              if (txt.length >= 5 && txt.length <= 1000) {
                allTexts.push(txt);
              }
            }
          } catch (e) {}
        }

        var bodyText = document.body.innerText || '';
        allTexts.push(bodyText);

        for (var ti = 0; ti < allTexts.length; ti++) {
          var text = allTexts[ti];
          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var metricInfo = findMetricKey(line);
            if (!metricInfo) continue;
            if (found[metricInfo.key]) continue;

            var extracted = extractMetricCardValue(lines, i, metricInfo.type);

            if (extracted.value > 0 || extracted.changePct !== null) {
              var unit = metricInfo.type === 'percent' ? '%' : undefined;
              result[metricInfo.key] = buildMetric(extracted.value, extracted.changePct, unit);
              found[metricInfo.key] = true;
            }
          }

          if (Object.keys(found).length >= METRIC_MAP.length) break;
        }

        return result;
      `, 'extract-trend-' + period);

      const mapped: Partial<AccountAnalyticsPeriodData> = {};
      for (const key of Object.keys(raw)) {
        const val = raw[key];
        if (val && typeof val === 'object' && ('value' in val)) {
          (mapped as any)[key] = val;
        }
      }

      const count = Object.keys(mapped).length;
      log('info', 'trend-done', `[${period}] 提取到 ${count} 个核心指标`);
      return mapped;
    } catch (e) {
      log('warn', 'trend-fail', `[${period}] 核心数据提取失败: ${(e as Error).message}`);
      return {};
    }
  }
}
