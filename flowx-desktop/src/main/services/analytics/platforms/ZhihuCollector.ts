import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential, AccountAnalyticsPeriodData, AnalyticsMetricValue } from '../../../../types';
import { sleep } from '../../platforms/shared';

function generateWorkId(title: string, page: number, index: number): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  }
  return `zh_${Math.abs(hash).toString(36)}_p${page}_${index}`;
}

function parseZhNumber(text: string | number | undefined | null): number {
  if (text === undefined || text === null) return 0;
  if (typeof text === 'number') return isNaN(text) ? 0 : text;
  const t = String(text).trim();
  if (!t) return 0;
  if (t.includes('w') || t.includes('万')) {
    const num = parseFloat(t.replace(/[w万]/g, ''));
    return Math.round(num * 10000);
  }
  if (t.includes('亿')) {
    const num = parseFloat(t.replace(/[亿]/g, ''));
    return Math.round(num * 100000000);
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
  const m = text.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?\s*(\d{1,2})?[:：]?(\d{1,2})?/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const hour = m[4] ? parseInt(m[4], 10) : 0;
    const min = m[5] ? parseInt(m[5], 10) : 0;
    const ts = new Date(year, month, day, hour, min).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  const m2 = text.match(/发布于\s*(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?/);
  if (m2) {
    const ts = new Date(
      parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10),
    ).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  const m3 = text.match(/(\d+)\s*(分钟|小时|天|周|月|年)前/);
  if (m3) {
    const num = parseInt(m3[1], 10);
    const unit = m3[2];
    let diffMs = 0;
    if (unit === '分钟') diffMs = num * 60 * 1000;
    else if (unit === '小时') diffMs = num * 60 * 60 * 1000;
    else if (unit === '天') diffMs = num * 24 * 60 * 60 * 1000;
    else if (unit === '周') diffMs = num * 7 * 24 * 60 * 60 * 1000;
    else if (unit === '月') diffMs = num * 30 * 24 * 60 * 60 * 1000;
    else if (unit === '年') diffMs = num * 365 * 24 * 60 * 60 * 1000;
    if (diffMs > 0) return Date.now() - diffMs;
  }
  return Date.now();
}

export class ZhihuCollector extends BaseCollector {
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

  private async waitForContent(timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const hasContent = await this.safeEval<boolean>(`
          var txt = (document.body.innerText || '').trim();
          var hasFan = txt.indexOf('关注者') >= 0 || txt.indexOf('粉丝') >= 0;
          var hasWork = txt.indexOf('作品') >= 0 || txt.indexOf('内容') >= 0 || txt.indexOf('创作') >= 0;
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

  async collectAccountOverview(): Promise<{
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  }> {
    const log = this.makeLog('zh-overview');

    if (!this.win || this.win.isDestroyed()) {
      log('info', 'init-window', '初始化采集窗口');
      await this.initWindow();
    }

    const finalData = { followers: 0, following: 0, likes: 0, worksCount: 0 };
    const extra: Record<string, number> = {};

    // ---- 1) 内容管理页：提取作品数 worksCount ----
    try {
      log('info', 'goto-works', '跳转到内容管理页提取作品数');
      await this.goto('https://www.zhihu.com/creator/manage/creation/all', 3000);
      await sleep(6000);
      try { await this.waitForContent(10000); } catch {}

      const worksPageData = await this.safeEval<{ worksCount: number; approves: number; favors: number; likesAgg: number }>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim().replace(/[,\\s]/g, '');
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
          if (t.indexOf('亿') >= 0) return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
          var n = parseInt(t, 10);
          return isNaN(n) ? 0 : n;
        }
        var txt = document.body.innerText || '';
        var worksCount = 0;
        var m1 = txt.match(/共\\s*([\\d,\\.]+[万千亿]?)\\s*条内容/);
        if (m1 && m1[1]) worksCount = parseNum(m1[1]);
        if (worksCount === 0) {
          var m2 = txt.match(/共\\s*([\\d,\\.]+[万千亿]?)\\s*条/);
          if (m2 && m2[1]) worksCount = parseNum(m2[1]);
        }
        if (worksCount === 0) {
          var m3 = txt.match(/全部[^\\d]{0,10}([\\d,\\.]+[万千亿]?)/);
          if (m3 && m3[1]) worksCount = parseNum(m3[1]);
        }
        var approves = 0, favors = 0;
        // 累加每行作品的赞同/喜欢作为兜底估算（仅在后续内容分析页取不到时用）
        var lines = txt.split('\\n').map(function(l){ return l.trim(); }).filter(Boolean);
        for (var i = 0; i < lines.length; i++) {
          if ((lines[i] === '赞同' || lines[i].indexOf('赞同') >= 0 && lines[i].length < 6) && i + 1 < lines.length) {
            if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i + 1])) approves += parseNum(lines[i + 1]);
          }
          if ((lines[i] === '喜欢' || lines[i].indexOf('喜欢') >= 0 && lines[i].length < 6) && i + 1 < lines.length) {
            if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i + 1])) favors += parseNum(lines[i + 1]);
          }
        }
        return { worksCount: worksCount, approves: approves, favors: favors, likesAgg: approves + favors };
      `, 'extract-works-count');
      if (worksPageData?.worksCount > 0) finalData.worksCount = worksPageData.worksCount;
      if (worksPageData?.approves > 0) extra.approvesFromWorks = worksPageData.approves;
      if (worksPageData?.favors > 0) extra.favorsFromWorks = worksPageData.favors;
      if (worksPageData?.likesAgg > 0) extra.likesFromWorks = worksPageData.likesAgg;
      log('info', 'works-count', `内容管理页作品数: ${finalData.worksCount}`);
    } catch (e) {
      log('warn', 'works-count-fail', `内容管理页提取失败: ${(e as Error).message}`);
    }

    // ---- 2) 关注者分析页：提取粉丝数 followers ----
    try {
      log('info', 'goto-followers', '跳转到关注者分析页提取粉丝数');
      await this.goto('https://www.zhihu.com/creator/followers', 3000);
      await sleep(6000);
      try { await this.waitForContent(10000); } catch {}

      const followersData = await this.safeEval<{ followers: number; following: number }>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim().replace(/[,\\s]/g, '');
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
          if (t.indexOf('亿') >= 0) return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
          var n = parseInt(t, 10);
          return isNaN(n) ? 0 : n;
        }
        var followers = 0, following = 0;
        var txt = document.body.innerText || '';
        var lines = txt.split('\\n').map(function(l){ return l.trim(); }).filter(Boolean);
        // 关注者总数 / 总关注者
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var isFollowersLabel = line === '关注者总数' || line === '总关注者' || line === '总关注者数' ||
            (line.indexOf('关注者总数') >= 0 && line.length <= 12) ||
            (line.indexOf('总关注者') >= 0 && line.length <= 12);
          if (isFollowersLabel && followers === 0) {
            for (var step = 1; step <= 8 && followers === 0; step++) {
              if (i + step < lines.length && /^[\\d,\\.]+[万千亿]?$/.test(lines[i + step])) followers = parseNum(lines[i + step]);
              if (i - step >= 0 && /^[\\d,\\.]+[万千亿]?$/.test(lines[i - step])) followers = parseNum(lines[i - step]);
            }
          }
          var isFollowingLabel = line === '关注数' || line === '关注了' || line === '关注总数' ||
            (line.indexOf('关注了') >= 0 && line.length <= 10);
          if (isFollowingLabel && following === 0) {
            for (var step2 = 1; step2 <= 8 && following === 0; step2++) {
              if (i + step2 < lines.length && /^[\\d,\\.]+[万千亿]?$/.test(lines[i + step2])) following = parseNum(lines[i + step2]);
              if (i - step2 >= 0 && /^[\\d,\\.]+[万千亿]?$/.test(lines[i - step2])) following = parseNum(lines[i - step2]);
            }
          }
          if (followers > 0 && following > 0) break;
        }
        if (followers === 0) {
          var m = txt.match(/(?:关注者总数|总关注者)[^\\d]{0,10}([\\d,\\.]+[万千亿]?)/);
          if (m && m[1]) followers = parseNum(m[1]);
        }
        return { followers: followers, following: following };
      `, 'extract-followers-overview');
      if (followersData?.followers > 0) finalData.followers = followersData.followers;
      if (followersData?.following > 0) finalData.following = followersData.following;
      log('info', 'followers-count', `关注者分析页粉丝数: ${finalData.followers}, 关注数: ${finalData.following}`);
    } catch (e) {
      log('warn', 'followers-count-fail', `关注者分析页提取失败: ${(e as Error).message}`);
    }

    // ---- 3) 内容分析页：切「累计」提取 likes = 赞同总量 + 喜欢总量 ----
    try {
      log('info', 'goto-analytics', '跳转到内容分析页提取累计获赞');
      await this.goto('https://www.zhihu.com/creator/analytics/work/all', 3000);
      await sleep(6000);
      try { await this.waitForAnalyticsContent(12000); } catch {}

      // 点击「累计」周期标签
      try {
        await this.clickPeriodTab('累计', '全部', log);
        await sleep(2200);
      } catch {}

      const cumLikes = await this.safeEval<{ approves: number; favors: number; likes: number }>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim().replace(/[,\\s]/g, '');
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
          if (t.indexOf('亿') >= 0) return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
          var n = parseInt(t, 10);
          return isNaN(n) ? 0 : n;
        }
        var txt = document.body.innerText || '';
        var lines = txt.split('\\n').map(function(l){ return l.trim(); }).filter(Boolean);
        var approves = 0, favors = 0;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var isApproveLabel = line === '赞同总量' || line === '总赞同' || line === '累计赞同' ||
            (line.indexOf('赞同总量') >= 0 && line.length <= 12) ||
            (line.indexOf('赞同数') >= 0 && line.length <= 8) ||
            line === '赞同';
          if (isApproveLabel && approves === 0) {
            for (var step = 1; step <= 10 && approves === 0; step++) {
              if (i + step < lines.length) {
                if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i + step])) approves = parseNum(lines[i + step]);
                else { var pn = parseNum(lines[i + step]); if (pn > 0) approves = pn; }
              }
              if (i - step >= 0) {
                if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i - step])) approves = approves || parseNum(lines[i - step]);
                else { var pn2 = parseNum(lines[i - step]); if (pn2 > 0) approves = approves || pn2; }
              }
            }
          }
          var isFavorLabel = line === '喜欢总量' || line === '总喜欢' || line === '累计喜欢' ||
            (line.indexOf('喜欢总量') >= 0 && line.length <= 12) ||
            (line.indexOf('喜欢数') >= 0 && line.length <= 8) ||
            line === '喜欢' || line === '收藏总量' || line === '收藏';
          if (isFavorLabel && favors === 0) {
            for (var step2 = 1; step2 <= 10 && favors === 0; step2++) {
              if (i + step2 < lines.length) {
                if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i + step2])) favors = parseNum(lines[i + step2]);
                else { var pn3 = parseNum(lines[i + step2]); if (pn3 > 0) favors = pn3; }
              }
              if (i - step2 >= 0) {
                if (/^[\\d,\\.]+[万千亿]?$/.test(lines[i - step2])) favors = favors || parseNum(lines[i - step2]);
                else { var pn4 = parseNum(lines[i - step2]); if (pn4 > 0) favors = favors || pn4; }
              }
            }
          }
          if (approves > 0 && favors > 0) break;
        }
        return { approves: approves, favors: favors, likes: approves + favors };
      `, 'extract-cumulative-likes');
      if (cumLikes?.likes > 0) finalData.likes = cumLikes.likes;
      if (cumLikes?.approves > 0) extra.approvesTotal = cumLikes.approves;
      if (cumLikes?.favors > 0) extra.favorsTotal = cumLikes.favors;
      log('info', 'likes-count', `内容分析页累计获赞(赞同+喜欢): ${finalData.likes}`);
    } catch (e) {
      log('warn', 'likes-count-fail', `内容分析页累计点赞提取失败: ${(e as Error).message}`);
    }

    // ---- 4) 兜底：如果前面没取到，用作品列表聚合估算 likes ----
    if (finalData.likes === 0 && typeof extra.likesFromWorks === 'number' && extra.likesFromWorks > 0) {
      finalData.likes = extra.likesFromWorks;
      log('info', 'likes-fallback', `使用作品列表聚合估算 likes: ${finalData.likes}`);
    }

    log('info', 'result', '账号概览数据采集完成', {
      followers: finalData.followers,
      following: finalData.following,
      likes: finalData.likes,
      worksCount: finalData.worksCount,
      extra,
    });

    return {
      followers: finalData.followers,
      following: finalData.following,
      likes: finalData.likes,
      worksCount: finalData.worksCount,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
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
    extra?: Record<string, number | string>;
  }>> {
    const log = this.makeLog('zh-works');

    if (!this.win || this.win.isDestroyed()) {
      log('info', 'init-window', '初始化采集窗口');
      await this.initWindow();
    }

    try {
      log('info', 'network-listen', '开始监听知乎作品列表 creations/v2/all API');
      await this.startNetworkCollect(/\/api\/v4\/creators\/creations\/v2\/all/);

      const worksUrl = 'https://www.zhihu.com/creator/manage/creation/all';
      log('info', 'goto', '跳转到内容管理（作品列表）页');
      await this.goto(worksUrl, 3000);
      await sleep(5000);

      const firstPageData = this.getLatestResponse();
      if (!firstPageData) {
        throw new Error('未获取到第一页 creations/v2/all 响应');
      }
      log('info', 'first-page', '第一页 API 响应已捕获');

      const allWorks: Array<any> = [];
      const seenIds = new Set<string>();

      const firstResult = this.parseApiPageWorks(firstPageData, allWorks, seenIds, log, incremental);
      log('info', 'page-works', `第 1 页解析完成，新增 ${firstResult.added} 条${firstResult.hitStop ? '，增量停止' : ''}${firstResult.isEnd ? '，API 报告已到末页' : ''}`);

      let page = 1;
      const maxPages = 50;
      let hitIncrementalStop = firstResult.hitStop;
      let isEnd = firstResult.isEnd;
      let totals = firstResult.totals;
      if (totals != null) {
        log('info', 'totals', `API 返回作品总数: ${totals}`);
      }

      while (allWorks.length < limit && page < maxPages && !hitIncrementalStop && !isEnd) {
        const nextPage = page + 1;
        const beforeCount = this.getResponseCount();
        const clicked = await this.clickWorksNextPage();
        if (!clicked) {
          log('info', 'page-click-fail', `跳转到第 ${nextPage} 页失败，停止翻页`);
          break;
        }

        try {
          const nextPageData = await this.waitForNewResponse(beforeCount, 15000);
          const pageResult = this.parseApiPageWorks(nextPageData, allWorks, seenIds, log, incremental);
          page = nextPage;
          hitIncrementalStop = pageResult.hitStop;
          if (pageResult.isEnd) isEnd = true;
          if (pageResult.totals != null) totals = pageResult.totals;
          log('info', 'page-works', `第 ${page} 页新增 ${pageResult.added} 条，累计 ${allWorks.length} 条${hitIncrementalStop ? '，增量停止' : ''}${isEnd ? '，已到末页' : ''}`);

          if (pageResult.added === 0 && !hitIncrementalStop) break;
          if (hitIncrementalStop) break;
        } catch (e) {
          log('warn', 'page-timeout', `第 ${nextPage} 页等待超时，停止翻页: ${(e as Error).message}`);
          break;
        }

        if (allWorks.length >= limit) break;
        await sleep(500);
      }

      this.stopNetworkCollect();

      if (allWorks.length > 0) {
        const result = allWorks.slice(0, limit);
        log('info', 'done', `作品列表采集完成，共 ${result.length} 条（CDP API 监听方式）`);
        return result;
      }
    } catch (e) {
      log('warn', 'cdp-error', `CDP API 监听方式失败: ${(e as Error).message}`);
      try { this.stopNetworkCollect(); } catch {}
    }

    log('info', 'fallback', '回退到 DOM 解析方式');
    return this.collectWorksFallback(limit, log, incremental);
  }

  private getResponseCount(): number {
    return (this as any).networkCollector?.responses?.length ?? 0;
  }

  private getLatestResponse(): any | null {
    const responses = (this as any).networkCollector?.responses ?? [];
    if (responses.length === 0) return null;
    return responses[responses.length - 1].data;
  }

  private async waitForNewResponse(beforeCount: number, timeoutMs: number): Promise<any> {
    const log = this.makeLog('network');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const count = this.getResponseCount();
      if (count > beforeCount) {
        const responses = (this as any).networkCollector.responses;
        const latest = responses[responses.length - 1];
        log('info', 'new-response', `获取到新响应（第 ${responses.length} 个）`);
        return latest.data;
      }
      await sleep(200);
    }
    throw new Error(`等待新响应超时（${timeoutMs}ms）`);
  }

  private parseApiPageWorks(
    resp: any,
    allWorks: Array<any>,
    seenIds: Set<string>,
    log: ReturnType<typeof this.makeLog>,
    incremental?: { lastWorkId?: string; lastWorkPublishTime?: number },
  ): { added: number; hitStop: boolean; isEnd: boolean; totals: number | null } {
    if (!resp) {
      log('warn', 'parse-empty', '响应为空');
      return { added: 0, hitStop: false, isEnd: false, totals: null };
    }
    // 知乎 creations/v2/all 顶层直接是 { paging: {...}, data: [...] }，没有 success 字段
    const items: any[] = Array.isArray(resp.data) ? resp.data : [];
    const paging = resp.paging || null;
    const isEnd: boolean = !!paging?.is_end;
    const totals: number | null = typeof (paging?.totals ?? paging?.totals_real) === 'number'
      ? (paging.totals ?? paging.totals_real)
      : null;

    if (items.length === 0) {
      log('warn', 'parse-empty-items', `响应 data 为空数组，paging=${JSON.stringify(paging).slice(0, 200)}`);
    }

    let added = 0;
    let hitStop = false;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const itemType: string = typeof item.type === 'string' ? item.type : '';
      const data: any = item.data || {};
      const reaction: any = item.reaction || {};

      const id = String(data.id || data.url_token || '').trim();
      if (!id) continue;

      const workId = `zh_${itemType || 'creation'}_${id}`;

      if (incremental?.lastWorkId && workId === incremental.lastWorkId) {
        log('info', 'incremental-stop', `遇到已采集的最后作品ID: ${workId}，增量停止`);
        hitStop = true;
        break;
      }

      const publishTimeRaw: number = Number(data.created_time || data.published_time || data.updated_time || 0);
      const publishTime: number = publishTimeRaw > 0
        ? (publishTimeRaw < 1e12 ? publishTimeRaw * 1000 : publishTimeRaw)
        : Date.now();

      if (incremental?.lastWorkPublishTime && publishTime > 0 && publishTime <= incremental.lastWorkPublishTime) {
        log('info', 'incremental-stop', `遇到已采集的发布时间: ${new Date(publishTime).toISOString()}，增量停止`);
        hitStop = true;
        break;
      }

      if (seenIds.has(workId)) continue;
      seenIds.add(workId);

      // 标题：answer / article 直接用 data.title；pin 用 content[i].type=text 的 title 或 HTML 首段纯文本
      let title: string = String(data.title || '').trim();
      if (!title && itemType === 'pin' && Array.isArray(data.content)) {
        for (const blk of data.content) {
          if (!blk || typeof blk !== 'object') continue;
          const blkType = String(blk.type || '');
          if (blkType === 'text') {
            const t = String(blk.title || '').trim();
            if (t) { title = t; break; }
            // 没有 title 字段时，取 blk.content 的 HTML 里第一段纯文本
            const raw = String(blk.own_text || blk.content || '').trim();
            if (raw) {
              const plain = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
              const firstSentence = plain.split(/[。！？!?\n]/)[0]?.trim();
              if (firstSentence) { title = firstSentence.length > 80 ? firstSentence.slice(0, 80) + '…' : firstSentence; break; }
            }
          }
        }
      }
      if (!title) {
        const excerpt = String(data.excerpt || '').trim();
        title = excerpt ? (excerpt.length > 80 ? excerpt.slice(0, 80) + '…' : excerpt) : `[${itemType || '创作'}] ${id}`;
      }

      // 封面：优先 data.new_thumbnail / thumbnail / data.cover / pin content[].type=image 的 watermark_url / url
      let coverUrl: string = String(data.new_thumbnail || data.thumbnail || data.cover || '').trim();
      if (!coverUrl && itemType === 'pin' && Array.isArray(data.content)) {
        for (const blk of data.content) {
          if (!blk || typeof blk !== 'object') continue;
          const blkType = String(blk.type || '');
          if (blkType === 'image') {
            const u = String(blk.watermark_url || blk.url || blk.original_url || '').trim();
            if (u) { coverUrl = u; break; }
          }
        }
      }
      if (coverUrl && coverUrl.startsWith('http://')) coverUrl = coverUrl.replace('http://', 'https://');

      // 详情链接：answer → /question/${question_id}/answer/${id}；article → zhuanlan.zhihu.com/p/${id}；pin → /pin/${id}；video → /zvideo/${id}
      let detailUrl = '';
      if (itemType === 'answer') {
        const qid = String(data.question_id || '').trim();
        if (qid) detailUrl = `https://www.zhihu.com/question/${qid}/answer/${id}`;
        else detailUrl = `https://www.zhihu.com/answer/${id}`;
      } else if (itemType === 'article') {
        detailUrl = `https://zhuanlan.zhihu.com/p/${id}`;
      } else if (itemType === 'pin') {
        detailUrl = `https://www.zhihu.com/pin/${id}`;
      } else if (itemType === 'zvideo' || itemType === 'video') {
        detailUrl = `https://www.zhihu.com/zvideo/${id}`;
      } else if (data.url) {
        detailUrl = String(data.url);
      }

      // 指标：read_count → views；vote_up_count → likes；comment_count → comments；collect_count → favorites；like_count → extra.likesZhihu；repin_count → shares
      const readCount = Number(reaction.read_count ?? reaction.view_count ?? reaction.play_count ?? 0);
      const voteUp = Number(reaction.vote_up_count ?? 0);
      const likeCount = Number(reaction.like_count ?? 0);
      const collect = Number(reaction.collect_count ?? 0);
      const comment = Number(reaction.comment_count ?? 0);
      const repin = Number(reaction.repin_count ?? reaction.share_count ?? 0);
      const duration: number = Number(data.duration ?? 0) || 0;

      // contentType：answer/article → article；pin（无图）/drama 等 → image；video / zvideo / is_video_answer → video
      let contentType: 'video' | 'article' | 'image' = 'article';
      if (itemType === 'video' || itemType === 'zvideo' || Number(data.is_video_answer ?? 0) === 1) {
        contentType = 'video';
      } else if (itemType === 'pin') {
        contentType = 'image';
      } else if (itemType === 'answer' || itemType === 'article' || itemType === 'question') {
        contentType = 'article';
      }

      const extra: Record<string, number | string> = {
        sourceType: itemType,
        creationId: id,
      };
      if (duration > 0) extra.durationRaw = String(duration);
      if (likeCount > 0) extra.likesZhihu = String(likeCount);
      if (typeof (reaction.view_count ?? null) === 'number') extra.viewCount = String(reaction.view_count);
      if (Number(data.question_id ?? 0) > 0) extra.questionId = String(data.question_id);

      allWorks.push({
        workId,
        title,
        coverUrl: coverUrl || undefined,
        publishTime,
        detailUrl: detailUrl || undefined,
        duration: duration || undefined,
        contentType,
        views: readCount || undefined,
        likes: voteUp || undefined,
        comments: comment || undefined,
        favorites: collect || undefined,
        shares: repin || undefined,
        extra,
      });
      added++;
    }

    return { added, hitStop, isEnd, totals };
  }

  private async clickWorksNextPage(): Promise<boolean> {
    try {
      return await this.safeEval<boolean>(`
        var selectors = [
          '.ant-pagination-next',
          '[class*="pagination"] [class*="next"]',
          '[class*="Pagination"] [class*="Next"]',
          '.next-page',
          '.page-next',
          '.d-pagination-item-next',
          '[class*="pagination-next"]',
          '[class*="PaginationNext"]',
        ];
        for (var s = 0; s < selectors.length; s++) {
          var els = document.querySelectorAll(selectors[s]);
          for (var ei = 0; ei < els.length; ei++) {
            var btn = els[ei];
            if (!btn) continue;
            try {
              var style = window.getComputedStyle(btn);
              if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            } catch(_) {}
            try {
              if (btn.classList && (btn.classList.contains('disabled') || btn.classList.contains('is-disabled'))) return false;
              if (btn.getAttribute && btn.getAttribute('disabled') !== null) return false;
              var ad = btn.getAttribute && btn.getAttribute('aria-disabled');
              if (ad === 'true' || ad === true) return false;
            } catch(_) {}
            try { btn.scrollIntoView({behavior:'auto', block:'center'}); } catch(_){}
            try { btn.click(); return true; }
            catch(e) {
              try { var ev = new MouseEvent('click',{bubbles:true,cancelable:true,view:window}); btn.dispatchEvent(ev); return true; }
              catch(_) {}
            }
          }
        }
        var all = document.querySelectorAll('button, a, span, li, div, [role="button"]');
        var nextTexts = ['下一页', '下页', '›', '»', '>'];
        for (var j = 0; j < all.length; j++) {
          var t = '';
          try { t = (all[j].innerText || all[j].textContent || '').trim(); } catch(_){ continue; }
          if (!t) continue;
          var matched = false;
          for (var ni = 0; ni < nextTexts.length; ni++) { if (t === nextTexts[ni]) { matched = true; break; } }
          if (!matched && (t.length <= 8 && t.indexOf('下一页') >= 0)) matched = true;
          if (!matched) continue;
          var el = all[j];
          try {
            if (el.classList && (el.classList.contains('disabled') || el.classList.contains('is-disabled'))) return false;
            if (el.getAttribute && el.getAttribute('disabled') !== null) return false;
            var aad = el.getAttribute && el.getAttribute('aria-disabled');
            if (aad === 'true') return false;
          } catch(_){}
          try { el.scrollIntoView({behavior:'auto', block:'center'}); } catch(_){}
          try { el.click(); return true; }
          catch(e2) {
            try { var ev2 = new MouseEvent('click',{bubbles:true,cancelable:true,view:window}); el.dispatchEvent(ev2); return true; }
            catch(_){}
          }
        }
        return false;
      `, 'click-works-next-page');
    } catch {
      return false;
    }
  }

  private async collectWorksFallback(
    limit: number,
    log: ReturnType<typeof this.makeLog>,
    incremental?: { lastWorkId?: string; lastWorkPublishTime?: number },
  ): Promise<Array<any>> {
    const worksUrl = 'https://www.zhihu.com/creator/manage/creation/all';
    log('info', 'goto', '跳转到内容管理（作品列表）页');
    await this.goto(worksUrl, 3000);
    await sleep(5000);

    try {
      await this.waitForContent(10000);
    } catch {
      // ignore
    }

    const allWorks: Array<any> = [];
    const seenIds = new Set<string>();
    let hitIncrementalStop = false;
    const maxPages = Math.max(1, Math.ceil(limit / 10));
    let page = 1;
    let lastCount = -1;
    let pageWithNoNewCount = 0;

    while (allWorks.length < limit && page <= maxPages && !hitIncrementalStop) {
      const pageWorks = await this.extractWorksPage(page, log);
      log('info', 'page-extract', `第 ${page} 页提取到 ${pageWorks.length} 条候选作品`);

      if (pageWorks.length === 0 && lastCount === 0) {
        log('info', 'page-empty-consecutive', '连续两页无数据，停止滚动');
        break;
      }
      lastCount = pageWorks.length;

      let pageAdded = 0;
      for (const work of pageWorks) {
        if (incremental?.lastWorkId && work.workId === incremental.lastWorkId) {
          log('info', 'incremental-stop', `遇到已采集的最后作品ID: ${work.workId}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (incremental?.lastWorkPublishTime && work.publishTime && work.publishTime <= incremental.lastWorkPublishTime) {
          log('info', 'incremental-stop', `遇到已采集的发布时间: ${new Date(work.publishTime).toISOString()}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (seenIds.has(work.workId)) continue;
        seenIds.add(work.workId);
        allWorks.push(work);
        pageAdded++;
        if (allWorks.length >= limit) break;
      }

      log('info', 'page-works', `第 ${page} 页新增 ${pageAdded} 条，累计 ${allWorks.length} 条${hitIncrementalStop ? '，增量停止' : ''}`);

      if (hitIncrementalStop) break;
      if (allWorks.length >= limit) break;

      if (pageAdded === 0) {
        pageWithNoNewCount++;
        if (pageWithNoNewCount >= 2) {
          log('info', 'no-new-data', `连续 2 页没有新增作品（页面可能已到底），停止分页`);
          break;
        }
      } else {
        pageWithNoNewCount = 0;
      }

      try {
        const scrollResult = await this.safeEval<{
          reachedBottom: boolean;
          hasNextButton: boolean;
          clickedNext: boolean;
          scrollMade: boolean;
        }>(`
          (async function() {
            var T = function(ms){ return new Promise(function(r){setTimeout(r,ms);}); };
            var res = { reachedBottom: false, hasNextButton: false, clickedNext: false, scrollMade: false };

            // 先优先尝试点击分页器「下一页 / › / 下一页」
            var nextTexts = ['下一页', '下一页 >', '›', '>', '»', '下页'];
            function normalize(s) { return String(s||'').replace(/[\\s\\u00a0]/g,'').toLowerCase(); }
            var btns = document.querySelectorAll('button, a, li, span, [role="button"], [class*="page"] *, [class*="Page"] *');
            for (var bi = 0; bi < btns.length; bi++) {
              var btn = btns[bi];
              var txt = '';
              try { txt = (btn.innerText || btn.textContent || '').trim(); } catch(_) { continue; }
              if (!txt) continue;
              var matched = false;
              for (var ni = 0; ni < nextTexts.length; ni++) {
                if (txt === nextTexts[ni]) { matched = true; break; }
              }
              var tn = normalize(txt);
              if (!matched && (tn === 'next' || tn === 'nextpage' || tn.indexOf('下一页') === 0)) matched = true;
              if (!matched) continue;
              // 排除 disabled 元素
              try {
                if (btn.hasAttribute && btn.hasAttribute('disabled')) continue;
                var cls = (btn.className || '').toString();
                if (/disabled|Disabled|is-disabled|aria-disabled="true"/.test(cls)) continue;
                var aria = btn.getAttribute && btn.getAttribute('aria-disabled');
                if (aria === 'true' || aria === true) continue;
              } catch(_) {}
              res.hasNextButton = true;
              try { btn.scrollIntoView({block:'center', behavior:'auto'}); } catch(_) {}
              await T(150);
              try { btn.click(); res.clickedNext = true; }
              catch(e) { try { var ev=new MouseEvent('click',{bubbles:true,cancelable:true,view:window}); btn.dispatchEvent(ev); res.clickedNext=true;} catch(_){} }
              if (res.clickedNext) return res;
            }

            // 没找到分页按钮 → 用 scrollToBottom 直到到底
            var scrollCount = 0;
            var lastHeight = document.body.scrollHeight;
            while (scrollCount < 3) {
              window.scrollBy(0, Math.max(window.innerHeight * 0.8, 800));
              res.scrollMade = true;
              await T(450);
              var newH = document.body.scrollHeight;
              if (newH === lastHeight) scrollCount++;
              else scrollCount = 0;
              lastHeight = newH;
            }
            var atBottom = (window.innerHeight + Math.ceil(window.scrollY || window.pageYOffset || 0)) >= (document.body.scrollHeight - 50);
            res.reachedBottom = atBottom || scrollCount >= 3;
            return res;
          })();
        `, 'scroll-or-nextpage-' + page);
        log('info', 'pagination', `翻页/滚动结果: `, scrollResult);
        if (scrollResult?.reachedBottom && !scrollResult.clickedNext) {
          log('info', 'reached-bottom', `已滚动到页面底部且未找到下一页按钮，停止分页`);
          break;
        }
        await sleep(scrollResult.clickedNext ? 2200 : 1500);
      } catch (e) {
        log('warn', 'scroll-fail', `滚动/翻页失败: ${(e as Error).message}`);
      }

      page++;
    }

    const result = allWorks.slice(0, limit);
    log('info', 'done', `作品列表采集完成，共 ${result.length} 条`);
    return result;
  }

  private async extractWorksPage(page: number, log: ReturnType<typeof this.makeLog>): Promise<Array<any>> {
    try {
      return await this.safeEval<any[]>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim();
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
            return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
          }
          if (t.indexOf('亿') >= 0) {
            return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
          }
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
            return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
          }
          var n = parseInt(t.replace(/,/g, ''), 10);
          return isNaN(n) ? 0 : n;
        }

        function parseTime(text) {
          if (!text) return Date.now();
          var m = text.match(/(\\d{4})[-\\/年](\\d{1,2})[-\\/月](\\d{1,2})日?\\s*(\\d{1,2})?[:：]?(\\d{1,2})?/);
          if (m) {
            var ts = new Date(
              parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10),
              parseInt(m[4]||'0',10), parseInt(m[5]||'0',10)
            ).getTime();
            if (!isNaN(ts) && ts > 0) return ts;
          }
          // 解析「发布于/编辑于 MM-DD」或「发布于/编辑于 YY-MM-DD」（缺少年份时默认当年，若晚于今天则去年）
          var mShort = text.match(/(发布于|编辑于)\\s+(\\d{1,2})[-\\/月](\\d{1,2})日?/);
          if (mShort) {
            var now = new Date();
            var year = now.getFullYear();
            var month = parseInt(mShort[2],10)-1;
            var day = parseInt(mShort[3],10);
            var candidate = new Date(year, month, day).getTime();
            if (!isNaN(candidate) && candidate > now.getTime() + 24*3600*1000) {
              candidate = new Date(year-1, month, day).getTime();
            }
            if (!isNaN(candidate) && candidate > 0) return candidate;
          }
          var mShortY = text.match(/(发布于|编辑于)\\s+(\\d{2})[-\\/](\\d{1,2})[-\\/](\\d{1,2})/);
          if (mShortY) {
            var y = parseInt(mShortY[2],10) + 2000;
            var mo = parseInt(mShortY[3],10)-1;
            var d = parseInt(mShortY[4],10);
            var tsY = new Date(y, mo, d).getTime();
            if (!isNaN(tsY) && tsY > 0) return tsY;
          }
          var m2 = text.match(/发布于\\s*(\\d{4})[-\\/年](\\d{1,2})[-\\/月](\\d{1,2})日?/);
          if (m2) {
            var ts2 = new Date(parseInt(m2[1],10), parseInt(m2[2],10)-1, parseInt(m2[3],10)).getTime();
            if (!isNaN(ts2) && ts2 > 0) return ts2;
          }
          var m3 = text.match(/(\\d+)\\s*(分钟|小时|天|周|月|年)前/);
          if (m3) {
            var num = parseInt(m3[1], 10);
            var unit = m3[2];
            var diff = 0;
            if (unit === '分钟') diff = num * 60 * 1000;
            else if (unit === '小时') diff = num * 60 * 60 * 1000;
            else if (unit === '天') diff = num * 24 * 60 * 60 * 1000;
            else if (unit === '周') diff = num * 7 * 24 * 60 * 60 * 1000;
            else if (unit === '月') diff = num * 30 * 24 * 60 * 60 * 1000;
            else if (unit === '年') diff = num * 365 * 24 * 60 * 60 * 1000;
            if (diff > 0) return Date.now() - diff;
          }
          return Date.now();
        }

        function extractTitle(fullText) {
          if (!fullText) return '';
          var firstLine = fullText.split('\\n')[0] || '';
          var trimmed = firstLine.trim();
          if (trimmed.length > 120) {
            var cutIdx = trimmed.indexOf('。');
            if (cutIdx > 0 && cutIdx < 120) return trimmed.slice(0, cutIdx + 1);
            var spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 0 && spaceIdx < 120) return trimmed.slice(0, spaceIdx);
            return trimmed.slice(0, 120) + '...';
          }
          return trimmed;
        }

        function detectType(text, href) {
          var t = String(text || '') + ' ' + String(href || '');
          if (t.indexOf('视频') >= 0 || /\\/video\\//.test(href) || t.indexOf('播放量') >= 0) return 'video';
          if (t.indexOf('想法') >= 0 || t.indexOf('图文') >= 0 || t.indexOf('图片') >= 0 || t.indexOf('Pin') >= 0 || t.indexOf('pin') >= 0) return 'image';
          if (/\\/answer\\//.test(href) || /\\/question\\//.test(href)) return 'article';
          if (/\\/p\\//.test(href) || t.indexOf('文章') >= 0 || t.indexOf('专栏') >= 0) return 'article';
          return 'article';
        }

        function extractWorkId(row, href, title) {
          if (row && row.getAttribute) {
            var dataId = row.getAttribute('data-id') || row.getAttribute('data-work-id') || row.getAttribute('data-creation-id') || row.getAttribute('data-key') || row.id;
            if (dataId && /^[a-zA-Z0-9_\\-]+$/.test(dataId) && dataId.length > 3) {
              return 'zh_' + dataId;
            }
          }
          if (href) {
            var am = href.match(/\\/answer\\/(\\d+)/);
            if (am) return 'zh_answer_' + am[1];
            var pm = href.match(/\\/p\\/(\\d+)/);
            if (pm) return 'zh_article_' + pm[1];
            var vm = href.match(/\\/video\\/(\\d+)/);
            if (vm) return 'zh_video_' + vm[1];
            var qm = href.match(/\\/question\\/(\\d+)/);
            if (qm) return 'zh_question_' + qm[1];
            var zm = href.match(/\\/zvideo\\/(\\d+)/);
            if (zm) return 'zh_zvideo_' + zm[1];
            var cim = href.match(/[?&]creation_id=([a-zA-Z0-9_\\-]+)/);
            if (cim) return 'zh_creation_' + cim[1];
          }
          // 纯文本兜底：用标题+发布时间（ms）哈希，跨页稳定，不依赖 page/index
          var hash = 0;
          var titleStr = String(title || '') + (href ? ('|' + href) : '');
          if (titleStr.length <= 1) return '';  // 空作品后续直接跳过
          for (var i = 0; i < titleStr.length; i++) {
            hash = ((hash << 5) - hash + titleStr.charCodeAt(i)) | 0;
          }
          return 'zh_h_' + Math.abs(hash).toString(36);
        }

        function extractMetrics(lines, startIdx, range) {
          var res = { views: 0, likes: 0, comments: 0, favorites: 0, shares: 0, likesZhihu: 0 };
          var isNum = function(s) { return /^[\\d,\\.]+[万千亿]?$/.test(String(s||'')) && String(s).length < 12; };
          var end = Math.min(lines.length, startIdx + range);
          for (var i = startIdx; i < end; i++) {
            var line = lines[i];
            var next = i + 1 < end ? lines[i + 1] : '';
            var prev1 = i - 1 >= startIdx ? lines[i - 1] : '';
            var prev2 = i - 2 >= startIdx ? lines[i - 2] : '';
            // 优先匹配：数值（i-1/i-2）在前、标签（i）在后（知乎常见格式）
            var numByLabel = 0;
            if (isNum(prev1)) numByLabel = parseNum(prev1);
            else if (isNum(prev2)) numByLabel = parseNum(prev2);
            var lineMatchInline = line.match(/[:：]?\\s*([\\d,\\.]+[万千亿]?)/);
            var inlineNum = lineMatchInline ? parseNum(lineMatchInline[1]) : 0;
            var nextNum = (next && isNum(next)) ? parseNum(next) : 0;

            var isViewLabel = line.indexOf('阅读量') >= 0 || line === '阅读' || line === '阅读数' ||
              line === '浏览量' || line === '浏览' || line === '被浏览' ||
              line === '播放量' || line === '播放数';
            var isLikeLabel = line.indexOf('赞同') >= 0 || line === '点赞' ||
              line === '获赞' || line === '点赞数';
            var isCommentLabel = line === '评论' || line === '评论数' || line === '评论量';
            var isFavLabel = line === '收藏' || line === '收藏数';
            var isFavorLabel = line === '喜欢' || line === '喜欢数';
            var isShareLabel = line === '分享' || line === '分享数' || line === '转发';

            if (isViewLabel) {
              if (res.views === 0) {
                if (nextNum > 0) res.views = nextNum;
                else if (numByLabel > 0) res.views = numByLabel;
                else if (inlineNum > 0) res.views = inlineNum;
              }
            }
            if (isLikeLabel) {
              if (res.likes === 0) {
                if (nextNum > 0) res.likes = nextNum;
                else if (numByLabel > 0) res.likes = numByLabel;
                else if (inlineNum > 0) res.likes = inlineNum;
              }
            }
            if (isCommentLabel) {
              if (res.comments === 0) {
                if (nextNum > 0) res.comments = nextNum;
                else if (numByLabel > 0) res.comments = numByLabel;
                else if (inlineNum > 0) res.comments = inlineNum;
              }
            }
            if (isFavLabel) {
              // 收藏 → favorites
              if (res.favorites === 0) {
                if (nextNum > 0) res.favorites = nextNum;
                else if (numByLabel > 0) res.favorites = numByLabel;
                else if (inlineNum > 0) res.favorites = inlineNum;
              }
            }
            if (isFavorLabel) {
              // 喜欢 → likesZhihu（存在 extra 里，不覆盖 favorites）
              if (res.likesZhihu === 0) {
                if (nextNum > 0) res.likesZhihu = nextNum;
                else if (numByLabel > 0) res.likesZhihu = numByLabel;
                else if (inlineNum > 0) res.likesZhihu = inlineNum;
              }
            }
            if (isShareLabel) {
              if (res.shares === 0) {
                if (nextNum > 0) res.shares = nextNum;
                else if (numByLabel > 0) res.shares = numByLabel;
                else if (inlineNum > 0) res.shares = inlineNum;
              }
            }
          }
          return res;
        }

        var rowSelectors = [
          '[class*="ManageCreationItem"]',
          '[class*="creation-item"]',
          '[class*="CreationItem"]',
          'tbody tr',
          '[data-za-detail-path*="creation"]',
          '[class*="list-item"]',
          '[class*="row-item"]',
          '[class*="Table"] [class*="Row"]',
          '[class*="table-row"]',
          '[class*="ContentItem"]',
          '[class*="content-item"]',
          '[class*="ListItem"]',
          'li[class*="item"]',
          'div[class*="Item"]'
        ];

        var rows = [];
        var seenRows = new Set();
        for (var si = 0; si < rowSelectors.length; si++) {
          try {
            var found = document.querySelectorAll(rowSelectors[si]);
            for (var fi = 0; fi < found.length; fi++) {
              var rowEl = found[fi];
              var txt = (rowEl.innerText || '').trim();
              if (!txt || txt.length < 5 || txt.length > 3000) continue;
              if (seenRows.has(rowEl)) continue;
              seenRows.add(rowEl);
              rows.push(rowEl);
            }
          } catch (_) {}
        }

        function stripTypePrefix(s) {
          var t = String(s || '').trim();
          var prefixes = ['回答', '文章', '视频', '想法', '提问', '专栏', '播客', '图文'];
          for (var i = 0; i < prefixes.length; i++) {
            var p = prefixes[i];
            if (t.indexOf(p) === 0 && t.length > p.length) {
              var rest = t.slice(p.length).trim();
              if (rest.length > 0) { t = rest; break; }
            }
          }
          return t;
        }

        var pageNum = ${page};
        var works = [];
        var globalIndex = 0;

        for (var ri = 0; ri < rows.length; ri++) {
          var row = rows[ri];
          var rowText = (row.innerText || '').trim();
          if (!rowText) continue;

          var lines = rowText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          if (lines.length < 2) continue;

          var coverUrl = '';
          var imgs = row.querySelectorAll('img');
          for (var ii = 0; ii < imgs.length; ii++) {
            var src = imgs[ii].getAttribute('src') || imgs[ii].getAttribute('data-src') || '';
            if (src && src.indexOf('http') === 0 && src.length > 10) { coverUrl = src; break; }
          }

          var detailUrl = '';
          var links = row.querySelectorAll('a');
          for (var li = 0; li < links.length; li++) {
            var hr = links[li].getAttribute('href') || '';
            if (hr && (hr.indexOf('/answer/') >= 0 || hr.indexOf('/p/') >= 0 || hr.indexOf('/video/') >= 0 || hr.indexOf('/zvideo/') >= 0 || hr.indexOf('/question/') >= 0 || hr.indexOf('zhihu.com') >= 0)) {
              detailUrl = hr.indexOf('http') === 0 ? hr : ('https://www.zhihu.com' + (hr.charAt(0) === '/' ? '' : '/') + hr);
              break;
            }
          }
          if (!detailUrl && row.getAttribute) {
            var rowHref = row.getAttribute('href') || row.getAttribute('data-href') || '';
            if (rowHref) detailUrl = rowHref.indexOf('http') === 0 ? rowHref : ('https://www.zhihu.com' + (rowHref.charAt(0) === '/' ? '' : '/') + rowHref);
          }

          var title = '';
          var titleEls = row.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"]');
          for (var ti = 0; ti < titleEls.length; ti++) {
            var ttxt = (titleEls[ti].innerText || '').trim();
            if (ttxt && ttxt.length > 1) { title = stripTypePrefix(ttxt); break; }
          }
          if (!title) {
            for (var li2 = 0; li2 < lines.length; li2++) {
              var line = lines[li2];
              if (line.indexOf('发布于') >= 0 || line.indexOf('编辑于') >= 0 || /^\\d{4}[-年]/.test(line)) break;
              if (line === '回答' || line === '文章' || line === '视频' || line === '想法' || line === '图文' || line === '全部' || line === '提问' || line === '专栏' || line === '播客') continue;
              if (line === '已发布' || line === '审核中' || line === '草稿' || line === '已删除') continue;
              if (/^[\\d,\\.]+[万千亿]?$/.test(line)) continue;
              if (line.indexOf('阅读') >= 0 || line.indexOf('赞同') >= 0 || line.indexOf('评论') >= 0 || line.indexOf('喜欢') >= 0 || line.indexOf('收藏') >= 0 || line.indexOf('分享') >= 0 || line.indexOf('被浏览') >= 0 || line.indexOf('转发') >= 0) continue;
              if (line.length > 2) { title = stripTypePrefix(extractTitle(line)); break; }
            }
          }
          if (!title && lines.length > 0) title = stripTypePrefix(extractTitle(lines[0]));
          if (!title) continue;

          var publishTime = Date.now();
          for (var pi = 0; pi < lines.length; pi++) {
            var pl = lines[pi];
            if (pl.indexOf('发布于') >= 0 || pl.indexOf('编辑于') >= 0 || /\\d{4}[-年]/.test(pl) || (/前$/.test(pl) && /\\d+/.test(pl))) {
              publishTime = parseTime(pl);
              break;
            }
          }

          var contentType = detectType(rowText, detailUrl);

          var metrics = extractMetrics(lines, 0, lines.length);

          var workId = extractWorkId(row, detailUrl, title);
          // 空/无效 workId 说明该 row 不是有效作品行（可能是父容器重复匹配），直接跳过
          if (!workId) continue;
          globalIndex++;

          var extra = { rowIndex: ri, page: pageNum };
          if (metrics.likesZhihu > 0) extra.likesZhihu = metrics.likesZhihu;

          works.push({
            workId: workId,
            title: title,
            coverUrl: coverUrl,
            publishTime: publishTime,
            detailUrl: detailUrl,
            duration: 0,
            contentType: contentType,
            views: metrics.views,
            likes: metrics.likes,
            comments: metrics.comments,
            favorites: metrics.favorites,
            shares: metrics.shares,
            extra: extra
          });
        }

        if (works.length < 3) {
          var bodyText = document.body.innerText || '';
          var bodyLines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          var bIdx = 0;
          var fallbackCount = 0;
          while (bIdx < bodyLines.length && fallbackCount < 5) {
            var bl = bodyLines[bIdx];
            if (bl.indexOf('发布于') >= 0 || bl.indexOf('编辑于') >= 0 || (bl.indexOf('赞同') >= 0 && bIdx > 3)) {
              var ft = stripTypePrefix(extractTitle(bodyLines[Math.max(0, bIdx - 3)] || bodyLines[Math.max(0, bIdx - 2)] || bodyLines[Math.max(0, bIdx - 1)] || bl));
              if (ft && ft.length > 2) {
                var fpub = parseTime(bl);
                var fmetrics = extractMetrics(bodyLines, Math.max(0, bIdx - 3), 15);
                var fid = extractWorkId(null, '', ft);
                if (fid) {
                  var fextra = { source: 'fallback-body' };
                  if (fmetrics.likesZhihu > 0) fextra.likesZhihu = fmetrics.likesZhihu;
                  works.push({
                    workId: fid,
                    title: ft,
                    coverUrl: '',
                    publishTime: fpub,
                    detailUrl: '',
                    duration: 0,
                    contentType: 'article',
                    views: fmetrics.views,
                    likes: fmetrics.likes,
                    comments: fmetrics.comments,
                    favorites: fmetrics.favorites,
                    shares: fmetrics.shares,
                    extra: fextra
                  });
                  fallbackCount++;
                }
              }
            }
            bIdx++;
          }
        }

        return works;
      `, 'extract-works-page-' + page);
    } catch (e) {
      log('warn', 'extract-page-fail', `提取第 ${page} 页作品失败: ${(e as Error).message}`);
      return [];
    }
  }

  async collectAccountAnalytics(): Promise<AccountAnalyticsPeriodData[]> {
    const log = this.makeLog('zh-analytics');
    const accountId = this.account.id;
    const collectedAt = Date.now();

    if (!this.win || this.win.isDestroyed()) {
      log('info', 'init-window', '初始化采集窗口');
      await this.initWindow();
    }

    const analyticsUrl = 'https://www.zhihu.com/creator/analytics/work/all';
    log('info', 'goto', '跳转到数据分析-内容分析页');
    await this.goto(analyticsUrl, 3000);
    await sleep(6000);

    try {
      await this.waitForAnalyticsContent(12000);
    } catch (e) {
      log('warn', 'wait-timeout', `等待数据分析内容加载超时: ${(e as Error).message}`);
    }

    log('info', 'extract-peer', '开始提取同类对比维度数据');
    const peerCompare = await this.extractPeerCompare(log);
    log('info', 'peer-result', `同类对比提取完成，共 ${peerCompare.length} 个维度`);

    const periods: Array<'7d' | '30d'> = ['7d', '30d'];
    const result: AccountAnalyticsPeriodData[] = [];
    let period7dFingerprint = '';
    function buildFingerprint(m: Record<string, AnalyticsMetricValue>): string {
      const keys = ['impressions', 'views', 'likes', 'comments', 'favorites', 'shares', 'newFans'];
      return keys.map(k => {
        const v = m[k]; if (!v) return '';
        return `${k}=${v.value}${typeof v.changePct === 'number' ? ',' + v.changePct : ''}`;
      }).join('|');
    }

    for (const period of periods) {
      log('info', 'switch-period', `切换到 ${period} 周期`);
      const periodLabel = period === '7d' ? '最近 7 天' : '最近 30 天';
      const altLabel = period === '7d' ? '近7天' : '近30天';
      await this.clickPeriodTab(periodLabel, altLabel, log);
      await sleep(2000);

      const rawMetrics = await this.extractAnalyticsMetrics(log, period);

      if (period === '7d') {
        period7dFingerprint = buildFingerprint(rawMetrics);
        log('debug', 'fingerprint-7d', period7dFingerprint || '<empty>');
      } else if (period === '30d') {
        const curFP = buildFingerprint(rawMetrics);
        log('debug', 'fingerprint-30d', curFP || '<empty>');
        if (period7dFingerprint && curFP && curFP === period7dFingerprint) {
          log('warn', 'period-dup', `检测到 30d 数据与 7d 完全一致，周期切换可能未生效，重试一次 30d 点击`);
          await this.forceClickPeriod('最近 30 天', '近30天', log);
          await sleep(2500);
          const retryMetrics = await this.extractAnalyticsMetrics(log, period);
          const retryFP = buildFingerprint(retryMetrics);
          log('debug', 'fingerprint-30d-retry', retryFP || '<empty>');
          if (retryFP && retryFP !== period7dFingerprint) {
            Object.keys(retryMetrics).forEach(k => { (rawMetrics as any)[k] = retryMetrics[k]; });
          } else {
            log('warn', 'period-dup-retry-fail', `重试后 30d 数据仍与 7d 一致，可能账号确无变化，保留结果`);
          }
        }
      }

      const periodData: AccountAnalyticsPeriodData = {
        id: `${accountId}_${period}_${collectedAt}`,
        accountId,
        platform: 'zhihu',
        period,
        impressions: rawMetrics.impressions,
        views: rawMetrics.views,
        avgWatchDurationSec: rawMetrics.avgWatchDurationSec,
        likes: rawMetrics.likes,
        comments: rawMetrics.comments,
        favorites: rawMetrics.favorites,
        shares: rawMetrics.shares,
        interactions: rawMetrics.interactions,
        newFans: rawMetrics.newFans,
        lostFans: rawMetrics.lostFans,
        netFans: rawMetrics.netFans,
        peerCompare,
        collectedAt,
      };

      result.push(periodData);
      log('info', 'period-done', `周期 ${period} 采集完成`);
    }

    log('info', 'done', '内容分析采集完成，即将采集关注者数据', { periods: result.length });

    try {
      log('info', 'goto-followers', '跳转到数据分析-关注者页');
      const followersUrl = 'https://www.zhihu.com/creator/followers';
      await this.goto(followersUrl, 3000);
      await sleep(6000);

      try {
        await this.waitForContent(10000);
      } catch {
        log('warn', 'wait-followers-timeout', '等待关注者分析页加载超时，继续尝试');
      }

      for (const period of periods) {
        log('info', 'switch-followers-period', `关注者分析切换到 ${period} 周期`);
        const periodLabel = period === '7d' ? '最近 7 天' : '最近 30 天';
        const altLabel = period === '7d' ? '近7天' : '近30天';
        await this.clickPeriodTab(periodLabel, altLabel, log);
        await sleep(2200);

        const followerMetrics = await this.safeEval<Record<string, number>>(`
          function parseNum(text) {
            if (!text) return 0;
            var t = String(text).trim();
            if (!t) return 0;
            if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
              return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
            }
            if (t.indexOf('亿') >= 0) {
              return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
            }
            if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
              return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
            }
            var n = parseInt(t.replace(/,/g, ''), 10);
            return isNaN(n) ? 0 : n;
          }

          var MAP = [
            { labels: ['新增关注者', '新增关注', '新增粉丝', '涨粉'], key: 'newFans' },
            { labels: ['减少关注者', '减少关注', '取关', '流失粉丝', '掉粉', '取消关注'], key: 'lostFans' },
            { labels: ['关注者变化', '净增关注者', '净增关注', '净增粉丝', '粉丝净增', '净涨粉'], key: 'netFans' },
            { labels: ['近30日活跃关注者', '近30天活跃关注者', '活跃关注者（近30天）', '活跃关注者(近30天)', '活跃关注者', '活跃粉丝'], key: 'coreFansCount' },
            { labels: ['关注者总数', '粉丝总数', '总粉丝', '粉丝量'], key: 'followersTotal' },
          ];

          var lines = (document.body.innerText || '').split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
          var found = {};

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            for (var m = 0; m < MAP.length; m++) {
              var mm = MAP[m];
              if (found[mm.key]) continue;
              var matched = false;
              for (var ll = 0; ll < mm.labels.length; ll++) {
                var lab = mm.labels[ll];
                if (line === lab) { matched = true; break; }
                if (line.indexOf(lab) >= 0 && line.length <= lab.length + 15) { matched = true; break; }
              }
              if (!matched) continue;
              for (var step = 1; step <= 10; step++) {
                if (i + step < lines.length && found[mm.key] === undefined) {
                  var next = lines[i + step];
                  if (/^[+\\-]?[\\d,\\.]+[万千亿]?$/.test(next) && next.length <= 15) {
                    found[mm.key] = parseNum(next);
                    break;
                  }
                  var pn = parseNum(next);
                  if (pn !== 0 || (found[mm.key] === undefined && (next === '0' || next === '+0' || next === '-0'))) {
                    found[mm.key] = pn;
                    break;
                  }
                }
                if (i - step >= 0 && found[mm.key] === undefined) {
                  var prev = lines[i - step];
                  if (/^[+\\-]?[\\d,\\.]+[万千亿]?$/.test(prev) && prev.length <= 15) {
                    found[mm.key] = parseNum(prev);
                    break;
                  }
                  var pn2 = parseNum(prev);
                  if (pn2 !== 0) {
                    found[mm.key] = pn2;
                    break;
                  }
                }
              }
              if (found[mm.key] === undefined) found[mm.key] = 0;
            }
            if (Object.keys(found).length >= MAP.length) break;
          }

          return found;
        `, 'extract-follower-period-' + period);

        log('info', 'follower-metrics', `[${period}] 关注者指标`, followerMetrics);

        const target = result.find(x => x.period === period);
        if (target && followerMetrics) {
          if (typeof followerMetrics.newFans === 'number') {
            target.newFans = {
              value: followerMetrics.newFans,
              changePct: target.newFans?.changePct ?? null,
              unit: undefined,
            };
          }
          if (typeof followerMetrics.lostFans === 'number') {
            target.lostFans = {
              value: followerMetrics.lostFans,
              changePct: target.lostFans?.changePct ?? null,
              unit: undefined,
            };
          }
          if (typeof followerMetrics.netFans === 'number') {
            target.netFans = {
              value: followerMetrics.netFans,
              changePct: target.netFans?.changePct ?? null,
              unit: undefined,
            };
          } else if (typeof followerMetrics.newFans === 'number' && typeof followerMetrics.lostFans === 'number') {
            target.netFans = {
              value: followerMetrics.newFans - followerMetrics.lostFans,
              changePct: null,
              unit: undefined,
            };
          }
          if (period === '30d' && typeof followerMetrics.coreFansCount === 'number') {
            target.coreFansCount = {
              value: followerMetrics.coreFansCount,
              changePct: null,
              unit: undefined,
            };
          }
          if (typeof followerMetrics.followersTotal === 'number' && followerMetrics.followersTotal > 0) {
            if (!target.extra) target.extra = {};
            target.extra.followersTotal = followerMetrics.followersTotal;
          }
        }
      }
    } catch (e) {
      log('warn', 'followers-collect-fail', `关注者采集失败，保留内容分析数据即可: ${(e as Error).message}`);
    }

    log('info', 'done', '账号分析（含内容分析+关注者）采集完成', { periods: result.length });
    return result;
  }

  private async waitForAnalyticsContent(timeoutMs: number = 12000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const hasContent = await this.safeEval<boolean>(`
          var txt = (document.body.innerText || '').trim();
          var hasImpression = txt.indexOf('曝光') >= 0 || txt.indexOf('展现') >= 0 || txt.indexOf('阅读量') >= 0 || txt.indexOf('阅读数') >= 0 || txt.indexOf('阅读总量') >= 0 || txt.indexOf('赞同总量') >= 0;
          var hasPeriod = txt.indexOf('近7天') >= 0 || txt.indexOf('近30天') >= 0 || txt.indexOf('最近 7 天') >= 0 || txt.indexOf('最近 30 天') >= 0 || txt.indexOf('最近7天') >= 0 || txt.indexOf('最近30天') >= 0 || txt.indexOf('累计') >= 0;
          var hasDataCard = document.querySelectorAll('[class*="card"], [class*="metric"], [class*="stat"]').length > 0;
          return (hasImpression && hasPeriod) || hasDataCard;
        `, 'check-analytics-content');
        if (hasContent) return true;
      } catch {
        // ignore
      }
      await sleep(800);
    }
    return false;
  }

  private async extractPeerCompare(log: ReturnType<typeof this.makeLog>): Promise<any[]> {
    try {
      return await this.safeEval<any[]>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim();
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
            var num = parseFloat(t.replace(/[万w]/g, ''));
            return Math.round(num * 10000);
          }
          if (t.indexOf('亿') >= 0) {
            var num2 = parseFloat(t.replace(/[亿]/g, ''));
            return Math.round(num2 * 100000000);
          }
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
            var num3 = parseFloat(t.replace(/[千k]/g, ''));
            return Math.round(num3 * 1000);
          }
          var n = parseInt(t.replace(/,/g, ''), 10);
          return isNaN(n) ? 0 : n;
        }

        function parseBeatPct(text) {
          if (!text) return -1;
          var t = String(text).trim();
          var beatMatch = t.match(/超过[^\\d]*(\\d+(?:\\.\\d+)?)%/);
          if (beatMatch) return parseFloat(beatMatch[1]);
          var belowMatch = t.match(/低于[^\\d]*(\\d+(?:\\.\\d+)?)%/);
          if (belowMatch) return 100 - parseFloat(belowMatch[1]);
          var peerMatch = t.match(/同类[^\\d]*(\\d+(?:\\.\\d+)?)%/);
          if (peerMatch) return parseFloat(peerMatch[1]);
          var numMatch = t.match(/(\\d+(?:\\.\\d+)?)%/);
          if (numMatch) return parseFloat(numMatch[1]);
          return -1;
        }

        var DIMENSIONS = [
          { labels: ['曝光量', '曝光', '展现量', '展现'], key: '曝光量' },
          { labels: ['阅读量', '阅读数', '阅读', '播放量', '播放数'], key: '阅读量' },
          { labels: ['点赞量', '点赞数', '点赞', '赞同'], key: '点赞量' },
          { labels: ['评论量', '评论数', '评论'], key: '评论量' },
          { labels: ['收藏量', '收藏数', '收藏', '喜欢量', '喜欢数'], key: '收藏量' },
          { labels: ['分享量', '分享数', '分享', '转发量', '转发数'], key: '分享量' },
          { labels: ['涨粉', '新增关注', '净增关注', '粉丝净增'], key: '涨粉量' },
        ];

        function findDim(line) {
          for (var d = 0; d < DIMENSIONS.length; d++) {
            for (var l = 0; l < DIMENSIONS[d].labels.length; l++) {
              var label = DIMENSIONS[d].labels[l];
              if (line === label || (line.indexOf(label) >= 0 && line.length < label.length + 10)) {
                return DIMENSIONS[d];
              }
            }
          }
          return null;
        }

        var results = [];
        var foundDim = {};

        var selectors = [
          '[class*="radar"]', '[class*="diagnose"]', '[class*="diagnosis"]',
          '[class*="peer"]', '[class*="compare"]', '[class*="same-industry"]',
          '[class*="account-card"]', '[class*="data-card"]', '[class*="stat-card"]',
          '[class*="metric-card"]', '[class*="benchmark"]', '[class*="level"]',
        ];

        var allTexts = [];
        for (var s = 0; s < selectors.length; s++) {
          try {
            var cards = document.querySelectorAll(selectors[s]);
            for (var c = 0; c < cards.length; c++) {
              var txt = (cards[c].innerText || '').trim();
              if (txt.length >= 20 && txt.length <= 3000) {
                allTexts.push(txt);
              }
            }
          } catch (_) {}
        }
        allTexts.push(document.body.innerText || '');

        for (var ti = 0; ti < allTexts.length; ti++) {
          var text = allTexts[ti];
          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var dim = findDim(line);
            if (!dim || foundDim[dim.key]) continue;

            var mine = 0;
            var beatPct = -1;

            for (var step = 1; step <= 8; step++) {
              if (mine === 0 && i + step < lines.length) {
                var next = lines[i + step].trim();
                if (/^[\\d,\\.]+[万千亿]?$/.test(next) && next.length <= 15) mine = parseNum(next);
                else { var mv = parseNum(next); if (mv > 10) mine = mv; }
              }
              if (mine === 0 && i - step >= 0) {
                var prev = lines[i - step].trim();
                if (/^[\\d,\\.]+[万千亿]?$/.test(prev) && prev.length <= 15) mine = parseNum(prev);
                else { var pv = parseNum(prev); if (pv > 10) mine = pv; }
              }
              if (beatPct < 0 && i + step < lines.length) beatPct = parseBeatPct(lines[i + step]);
              if (beatPct < 0 && i - step >= 0) beatPct = parseBeatPct(lines[i - step]);
              if (mine > 0 && beatPct >= 0) break;
            }

            if (mine > 0 || beatPct >= 0) {
              results.push({
                dimension: dim.key,
                mine: mine || 0,
                beatPct: beatPct,
              });
              foundDim[dim.key] = true;
            }
          }
          if (Object.keys(foundDim).length >= DIMENSIONS.length) break;
        }

        return results;
      `, 'extract-peer-compare');
    } catch (e) {
      log('warn', 'peer-fail', `同类对比提取失败: ${(e as Error).message}`);
      return [];
    }
  }

  private async clickPeriodTab(primaryLabel: string, altLabel: string, log: ReturnType<typeof this.makeLog>): Promise<boolean> {
    try {
      const result = await this.safeEval<boolean>(`
        var pLabel = '${primaryLabel}';
        var aLabel = '${altLabel}';
        function normalize(s) {
          return String(s || '').replace(/[\\s\\u00a0]/g, '').toLowerCase();
        }
        var pNorm = normalize(pLabel);
        var aNorm = normalize(aLabel);
        var all = document.querySelectorAll('*');
        var exact = [];
        var fuzzy = [];

        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var t = '';
          try { t = (el.innerText || el.textContent || '').trim(); } catch(_) { continue; }
          if (!t) continue;
          var tNorm = normalize(t);
          var hit = false;
          if (t === pLabel || t === aLabel || tNorm === pNorm || tNorm === aNorm) {
            hit = true;
          }
          if (hit) {
            var cc = el.querySelectorAll('*').length;
            exact.push({ el: el, c: cc });
            continue;
          }
          if (tNorm && tNorm.length <= Math.max(pNorm.length, aNorm.length) + 10) {
            if ((tNorm.indexOf(pNorm) >= 0 || tNorm.indexOf(aNorm) >= 0)) {
              var cc2 = el.querySelectorAll('*').length;
              fuzzy.push({ el: el, c: cc2 });
            }
          }
        }

        exact.sort(function(a, b) { return a.c - b.c; });
        fuzzy.sort(function(a, b) { return a.c - b.c; });
        var cands = exact.concat(fuzzy);
        if (cands.length === 0) return false;

        function doClick(el) {
          try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch(_) {}
          try { el.click(); return true; } catch(e) {}
          try {
            var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(ev);
            return true;
          } catch(e2) { return false; }
        }

        function hasActive(el) {
          var cur = el;
          for (var s = 0; s < 8 && cur; s++) {
            if (cur.nodeType !== 1) { cur = cur.parentNode; continue; }
            var cls = (cur.className || '').toString();
            if (/(active|selected|current|checked|on|Active|Selected|Current)/.test(cls)) return true;
            cur = cur.parentNode;
          }
          return false;
        }

        var maxTry = Math.min(cands.length, 15);
        for (var k = 0; k < maxTry; k++) {
          var cand = cands[k].el;
          var prevActive = hasActive(cand);
          var ok = doClick(cand);
          if (!ok) continue;
          if (!prevActive || k === 0) return true;
        }
        return cands.length > 0;
      `, 'click-period-' + primaryLabel);
      log('info', 'period-click', `点击周期 ${primaryLabel}/${altLabel}: ${result ? '成功' : '未命中元素，继续'}`);
      return result;
    } catch (e) {
      log('warn', 'period-click-fail', `点击周期异常: ${(e as Error).message}`);
      return false;
    }
  }

  private async forceClickPeriod(primaryLabel: string, altLabel: string, log: ReturnType<typeof this.makeLog>): Promise<void> {
    try {
      await this.safeEval<void>(`
        (async function() {
          var T = function(ms){ return new Promise(function(r){setTimeout(r,ms);}); };
          var pLabel = '${primaryLabel}';
          var aLabel = '${altLabel}';
          function normalize(s) {
            return String(s || '').replace(/[\\s\\u00a0]/g, '').toLowerCase();
          }
          var pNorm = normalize(pLabel);
          var aNorm = normalize(aLabel);
          var selectors = [
            '[class*="segment-item"]', '[class*="SegmentItem"]',
            'button', '[class*="time-item"]', '[class*="period-item"]',
            '[class*="tab"]', '[class*="Tab"]',
            'li', 'span', 'a', 'div[role="tab"]',
          ];
          for (var si = 0; si < selectors.length; si++) {
            var items = document.querySelectorAll(selectors[si]);
            for (var ii = 0; ii < items.length; ii++) {
              var el = items[ii];
              var t = '';
              try { t = (el.innerText || '').trim(); } catch(_) { continue; }
              var tNorm = normalize(t);
              var match = t === pLabel || t === aLabel || tNorm === pNorm || tNorm === aNorm;
              if (!match) {
                if (tNorm && tNorm.length <= Math.max(pNorm.length, aNorm.length) + 10) {
                  match = (tNorm.indexOf(pNorm) >= 0 || tNorm.indexOf(aNorm) >= 0);
                }
              }
              if (match) {
                try { el.scrollIntoView({block:'center'}); } catch(_) {}
                try { el.click(); }
                catch(e) { try { var ev=new MouseEvent('click',{bubbles:true,cancelable:true}); el.dispatchEvent(ev);} catch(_){} }
                await T(1500);
                return;
              }
            }
          }
        })();
      `, 'force-click-period');
      log('info', 'force-click', `强制周期点击已执行`);
    } catch (e) {
      log('warn', 'force-click-fail', `强制周期点击失败: ${(e as Error).message}`);
    }
  }

  private async extractAnalyticsMetrics(
    log: ReturnType<typeof this.makeLog>,
    period: '7d' | '30d'
  ): Promise<Record<string, AnalyticsMetricValue>> {
    try {
      const raw = await this.safeEval<Record<string, any>>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim();
          if (!t) return 0;
          if (t.indexOf('万') >= 0 || t.indexOf('w') >= 0) {
            return Math.round(parseFloat(t.replace(/[万w]/g, '')) * 10000);
          }
          if (t.indexOf('亿') >= 0) {
            return Math.round(parseFloat(t.replace(/[亿]/g, '')) * 100000000);
          }
          if (t.indexOf('千') >= 0 || t.indexOf('k') >= 0) {
            return Math.round(parseFloat(t.replace(/[千k]/g, '')) * 1000);
          }
          var n = parseInt(t.replace(/,/g, ''), 10);
          return isNaN(n) ? 0 : n;
        }

        function parsePercent(text) {
          if (!text) return 0;
          var t = String(text).trim().replace('%', '');
          var n = parseFloat(t);
          return isNaN(n) ? 0 : n;
        }

        function parseDurationSec(text) {
          if (!text) return 0;
          var t = String(text).trim();
          if (!t) return 0;
          var hm = t.match(/(\\d+)\\s*小时\\s*(\\d+)\\s*分钟/);
          if (hm) return parseInt(hm[1],10) * 3600 + parseInt(hm[2],10) * 60;
          var h1 = t.match(/(\\d+(?:\\.\\d+)?)\\s*小时/);
          if (h1) return Math.round(parseFloat(h1[1]) * 3600);
          var ms = t.match(/(\\d+)\\s*分\\s*(\\d+)\\s*秒/);
          if (ms) return parseInt(ms[1],10) * 60 + parseInt(ms[2],10);
          var m1 = t.match(/(\\d+(?:\\.\\d+)?)\\s*分/);
          if (m1) return Math.round(parseFloat(m1[1]) * 60);
          var s1 = t.match(/(\\d+(?:\\.\\d+)?)\\s*秒/);
          if (s1) return Math.round(parseFloat(s1[1]));
          var pn = parseNum(t);
          if (pn > 0 && pn < 10000) return pn;
          return 0;
        }

        function parseChangePct(text) {
          if (!text) return null;
          var t = String(text).trim();
          if (t.indexOf('--') >= 0 || t.indexOf('- -') >= 0 || t.indexOf('暂无') >= 0) return null;
          var m = t.match(/([+\\-]?\\d+(?:\\.\\d+)?)%/);
          if (m) return parseFloat(m[1]);
          var upDown = t.match(/(环比|较上周期|较上期|同比)[^+\\-\\d]*([+\\-]?\\d+(?:\\.\\d+)?)%?/);
          if (upDown) return parseFloat(upDown[2]);
          var dirMatch = t.match(/(上升|上涨|增长|增加|下降|减少|下跌)[^\\d]*(\\d+(?:\\.\\d+)?)%?/);
          if (dirMatch) {
            var n = parseFloat(dirMatch[2]);
            if (dirMatch[1].indexOf('下') >= 0 || dirMatch[1].indexOf('减') >= 0) n = -n;
            return n;
          }
          return null;
        }

        var METRIC_MAP = [
          { labels: ['曝光量', '曝光数', '曝光', '展现量', '展现数', '展现'], key: 'impressions', type: 'num' },
          { labels: ['阅读量', '阅读数', '阅读', '播放量', '播放数', '播放', '浏览量', '浏览', '被浏览', '阅读总量', '播放总量'], key: 'views', type: 'num' },
          { labels: ['平均阅读时长', '平均播放时长', '平均观看时长', '人均阅读时长', '人均播放时长'], key: 'avgWatchDurationSec', type: 'duration' },
          { labels: ['点赞量', '点赞数', '点赞', '赞同数', '赞同量', '赞同', '赞同总量', '点赞总量'], key: 'likes', type: 'num' },
          { labels: ['评论量', '评论数', '评论', '评论总量'], key: 'comments', type: 'num' },
          { labels: ['收藏量', '收藏数', '收藏', '喜欢量', '喜欢数', '喜欢', '喜欢总量', '收藏总量'], key: 'favorites', type: 'num' },
          { labels: ['分享量', '分享数', '分享', '转发量', '转发数', '转发', '分享总量', '转发总数', '转发总量'], key: 'shares', type: 'num' },
          { labels: ['互动量', '互动数', '总互动', '互动总量'], key: 'interactions', type: 'num' },
          { labels: ['涨粉', '新增关注', '新增粉丝', '新增关注者', '粉丝新增', '关注者新增', '新增关注者数'], key: 'newFans', type: 'num' },
          { labels: ['取关', '取消关注', '减少关注', '流失粉丝', '粉丝流失', '掉粉', '减少关注者数'], key: 'lostFans', type: 'num' },
          { labels: ['净增关注', '净增粉丝', '净增关注者', '粉丝净增', '关注者净增', '净涨粉', '关注者变化'], key: 'netFans', type: 'num' },
        ];

        function findMetricKey(line) {
          for (var m = 0; m < METRIC_MAP.length; m++) {
            for (var l = 0; l < METRIC_MAP[m].labels.length; l++) {
              var label = METRIC_MAP[m].labels[l];
              if (line === label || (line.indexOf(label) >= 0 && line.length <= label.length + 12)) {
                return METRIC_MAP[m];
              }
            }
          }
          return null;
        }

        function extractValue(lines, idx, metricType) {
          var value = 0;
          var changePct = null;

          for (var step = 1; step <= 8; step++) {
            if (idx + step < lines.length) {
              var next = lines[idx + step].trim();
              if (changePct === null) {
                var cp = parseChangePct(next);
                if (cp !== null) changePct = cp;
              }
              if (value === 0) {
                if (metricType === 'num') {
                  if (/^[+\\-]?[\\d,\\.]+[万千亿]?$/.test(next) && next.length <= 15) value = parseNum(next);
                  else { var pn = parseNum(next); if (pn > 0) value = pn; }
                } else if (metricType === 'duration') {
                  value = parseDurationSec(next);
                }
              }
            }
            if (idx - step >= 0) {
              var prev = lines[idx - step].trim();
              if (changePct === null) {
                var cp2 = parseChangePct(prev);
                if (cp2 !== null) changePct = cp2;
              }
              if (value === 0) {
                if (metricType === 'num') {
                  if (/^[+\\-]?[\\d,\\.]+[万千亿]?$/.test(prev) && prev.length <= 15) value = parseNum(prev);
                  else { var pn2 = parseNum(prev); if (pn2 > 0) value = pn2; }
                } else if (metricType === 'duration') {
                  value = parseDurationSec(prev);
                }
              }
            }
            if (value !== 0 && changePct !== null) break;
          }
          return { value, changePct };
        }

        var result = {};
        var found = {};

        var cardSelectors = [
          '[class*="metric-card"]', '[class*="stat-card"]', '[class*="data-card"]',
          '[class*="trend"]', '[class*="trend-card"]', '[class*="core-data"]',
          '[class*="card-item"]', '[class*="indicator"]', '[class*="index-card"]',
          '[class*="overview"] [class*="item"]', '[class*="summary"] [class*="card"]',
          '[class*="Overview"]', '[class*="Metrics"]', '[class*="metrics"]',
          '[class*="data-overview"]', '[class*="DataOverview"]',
          '[class*="content-analysis"]', '[class*="ContentAnalysis"]',
        ];

        var allTexts = [];
        for (var s = 0; s < cardSelectors.length; s++) {
          try {
            var cards = document.querySelectorAll(cardSelectors[s]);
            for (var c = 0; c < cards.length; c++) {
              var txt = (cards[c].innerText || '').trim();
              if (txt.length >= 5 && txt.length <= 1500) {
                allTexts.push(txt);
              }
            }
          } catch (_) {}
        }
        allTexts.push(document.body.innerText || '');

        for (var ti = 0; ti < allTexts.length; ti++) {
          var text = allTexts[ti];
          var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var metricInfo = findMetricKey(line);
            if (!metricInfo || found[metricInfo.key]) continue;

            var extracted = extractValue(lines, i, metricInfo.type);
            if (extracted.value > 0 || extracted.changePct !== null) {
              var unit = undefined;
              if (metricInfo.type === 'duration') unit = '秒';
              result[metricInfo.key] = {
                value: extracted.value || 0,
                changePct: extracted.changePct !== undefined ? extracted.changePct : null,
                unit: unit,
              };
              found[metricInfo.key] = true;
            }
          }
          if (Object.keys(found).length >= METRIC_MAP.length) break;
        }

        return result;
      `, 'extract-analytics-' + period);

      const mapped: Record<string, AnalyticsMetricValue> = {};
      for (const key of Object.keys(raw)) {
        const val = (raw as any)[key];
        if (val && typeof val === 'object' && ('value' in val)) {
          mapped[key] = {
            value: val.value ?? 0,
            changePct: typeof val.changePct === 'number' ? val.changePct : null,
            unit: val.unit,
          };
        }
      }

      const count = Object.keys(mapped).length;
      log('info', 'metrics-done', `[${period}] 提取到 ${count} 个核心指标`);
      return mapped;
    } catch (e) {
      log('warn', 'metrics-fail', `[${period}] 核心指标提取失败: ${(e as Error).message}`);
      return {};
    }
  }
}
