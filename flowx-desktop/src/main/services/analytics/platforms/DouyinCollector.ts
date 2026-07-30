import { BaseCollector } from '../BaseCollector';
import type { AccountCredential, AccountAnalyticsPeriodData, AnalyticsMetricValue, PeerCompare } from '../../../../types';
import { sleep } from '../../platforms/shared';

const DOUYIN_CREATOR_HOME = 'https://creator.douyin.com/creator-micro/home';
const DOUYIN_CONTENT_MANAGE = 'https://creator.douyin.com/creator-micro/content/manage';
const DOUYIN_DATA_CENTER = 'https://creator.douyin.com/creator-micro/data-center/operation';

function parseNumber(text: string | null | undefined): number {
  if (!text) return 0;
  const clean = text.trim().replace(/[,\s]/g, '');
  const match = clean.match(/^(\d+(?:\.\d+)?)([万wWkK千])?$/);
  if (!match) return 0;
  let n = parseFloat(match[1]);
  if (match[2]) {
    if (/[万wW]/.test(match[2])) n *= 10000;
    else if (/[千kK]/.test(match[2])) n *= 1000;
  }
  return Math.round(n);
}

export class DouyinCollector extends BaseCollector {
  constructor(account: AccountCredential) {
    super(account);
  }

  private async safeEval<T>(code: string, desc: string): Promise<T> {
    try {
      const wrapped = `
        (function() {
          try {
            var result = (function() {
              ${code}
            })();
            return { ok: true, data: result };
          } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e), stack: e && e.stack ? String(e.stack).slice(0, 500) : '' };
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
      if (errMsg.indexOf('脚本逻辑错误') >= 0) {
        throw e;
      }
      throw new Error(`[${desc}] 脚本执行失败: ${errMsg}`);
    }
  }

  private async waitForContent(minTextLen: number = 1000, timeoutMs: number = 30000): Promise<boolean> {
    const log = this.makeLog('wait-content');
    const start = Date.now();
    let checkCount = 0;
    while (Date.now() - start < timeoutMs) {
      checkCount++;
      try {
        const info = await this.safeEval<{ textLen: number; url: string; title: string; links: number; imgs: number }>(`
          return {
            textLen: (document.body.innerText || '').length,
            url: location.href,
            title: document.title,
            links: document.querySelectorAll('a').length,
            imgs: document.querySelectorAll('img').length
          };
        `, `check-content-${checkCount}`);
        log('debug', 'check', `第${checkCount}次检测: textLen=${info.textLen}, links=${info.links}, imgs=${info.imgs}, url=${info.url}`);
        if (info.textLen >= minTextLen) {
          log('info', 'ready', `页面内容加载完成，textLen=${info.textLen}`);
          return true;
        }
      } catch {
        /* ignore check errors */
      }
      await sleep(2000);
    }
    log('warn', 'timeout', `等待页面内容超时（${timeoutMs}ms）`);
    return false;
  }

  private async waitForWorksCards(timeoutMs: number = 30000): Promise<boolean> {
    const log = this.makeLog('wait-works');
    const start = Date.now();
    let checkCount = 0;
    while (Date.now() - start < timeoutMs) {
      checkCount++;
      try {
        const info = await this.safeEval<{ cardCount: number; url: string; textLen: number }>(`
          var cards = document.querySelectorAll('[class*="video-card"], [class*="work-card"], [class*="content-card"]');
          return {
            cardCount: cards.length,
            url: location.href,
            textLen: (document.body.innerText || '').length
          };
        `, `check-cards-${checkCount}`);
        log('debug', 'check', `第${checkCount}次检测: cards=${info.cardCount}, textLen=${info.textLen}, url=${info.url}`);
        if (info.cardCount > 0) {
          log('info', 'ready', `检测到 ${info.cardCount} 个作品卡片，页面已就绪`);
          return true;
        }
      } catch {
        /* ignore check errors */
      }
      await sleep(2000);
    }
    log('warn', 'timeout', `等待作品卡片超时（${timeoutMs}ms）`);
    return false;
  }

  async collectAccountOverview(): Promise<{
    followers: number;
    following: number;
    likes: number;
    worksCount: number;
    extra?: Record<string, number>;
  }> {
    const log = this.makeLog('douyin-overview');

    if (!this.win) {
      await this.initWindow();
    }
    if (!this.win) throw new Error('窗口初始化失败');

    log('info', 'goto', '跳转到创作中心首页');
    await this.goto(DOUYIN_CREATOR_HOME, 3000);
    await this.waitForContent(800, 20000);

    const data = await this.safeEval<{ followers: number; following: number; likes: number; worksCount: number }>(`
        function _parse(text) {
          try {
            var clean = (text || '').trim().replace(/[,\\s]/g, '');
            var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千])?$/);
            if (!pm) return 0;
            var n = parseFloat(pm[1]);
            if (pm[2]) { if (/[万wW]/.test(pm[2])) n *= 10000; else if (/[千kK]/.test(pm[2])) n *= 1000; }
            return Math.round(n);
          } catch (e) { return 0; }
        }

        var r = { followers: 0, following: 0, likes: 0, worksCount: 0 };

        var metricItems = document.querySelectorAll('[class*="metric-item"], [class*="MetricItem"], [class*="stat-item"], [class*="StatItem"]');
        for (var i = 0; i < metricItems.length; i++) {
          var item = metricItems[i];
          var text = (item.innerText || item.textContent || '').trim();
          if (!text || text.length > 80) continue;
          
          var lines = text.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
          if (lines.length < 2) continue;
          
          var numVal = 0;
          var label = '';
          
          for (var li = 0; li < lines.length; li++) {
            var v = _parse(lines[li]);
            if (v > 0 && numVal === 0) {
              numVal = v;
            } else if (!label && lines[li].length < 10) {
              label = lines[li];
            }
          }
          
          if (numVal <= 0 || !label) continue;
          
          if (/粉丝/.test(label)) r.followers = Math.max(r.followers, numVal);
          else if (/关注/.test(label)) r.following = Math.max(r.following, numVal);
          else if (/获赞|点赞|收藏|喜欢/.test(label)) r.likes = Math.max(r.likes, numVal);
          else if (/作品|内容|视频|发布/.test(label)) r.worksCount = Math.max(r.worksCount, numVal);
        }

        var numSpans = document.querySelectorAll('[class*="number-"], [class*="Number-"], [class*="count-"], [class*="Count-"]');
        for (var i = 0; i < numSpans.length; i++) {
          var sp = numSpans[i];
          var val = _parse(sp.textContent || '');
          if (val <= 0) continue;
          var parent = sp.parentElement;
          var label = '';
          if (parent) {
            var clone = parent.cloneNode(true);
            var clones = clone.querySelectorAll('[class*="number-"], [class*="Number-"], [class*="count-"], [class*="Count-"]');
            for (var ci = 0; ci < clones.length; ci++) { clones[ci].textContent = ''; }
            label = (clone.textContent || '').trim();
          }
          if (!label && parent) label = (parent.textContent || '').replace(/[\\d.万千\\s,]/g, '').trim();
          if (/粉丝/.test(label)) r.followers = Math.max(r.followers, val);
          else if (/关注/.test(label)) r.following = Math.max(r.following, val);
          else if (/获赞|点赞|收藏|喜欢/.test(label)) r.likes = Math.max(r.likes, val);
          else if (/作品|内容|视频|发布/.test(label)) r.worksCount = Math.max(r.worksCount, val);
        }

        return r;
      `, 'extract-overview');

    log('info', 'result', '账号概览数据提取完成', data);
    return data;
  }

  async collectAccountAnalytics(): Promise<AccountAnalyticsPeriodData[]> {
    const log = this.makeLog('douyin-analytics');

    if (!this.win) {
      await this.initWindow();
    }
    if (!this.win) throw new Error('窗口初始化失败');

    log('info', 'goto', '跳转到数据中心运营页');
    await this.goto(DOUYIN_DATA_CENTER, 3000);
    await this.waitForContent(800, 20000);

    log('info', 'peer-compare', '开始提取账号诊断 peerCompare 数据');
    const peerCompare = await this.safeEval<PeerCompare[]>(`
      function _parseNum(text) {
        try {
          var clean = (text || '').trim().replace(/[,\\s]/g, '');
          var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千%])?$/);
          if (!pm) return 0;
          var n = parseFloat(pm[1]);
          if (pm[2]) {
            if (/[万wW]/.test(pm[2])) n *= 10000;
            else if (/[千kK]/.test(pm[2])) n *= 1000;
          }
          return Math.round(n);
        } catch (e) { return 0; }
      }

      function _parsePct(text) {
        if (!text) return -1;
        var t = (text || '').trim();
        var m = t.match(/(\\d+(?:\\.\\d+)?)\\s*%/);
        if (!m) return -1;
        return Math.round(parseFloat(m[1]));
      }

      var results = [];
      var keywords = ['投稿活跃度', '视频播放量', '视频完播率', '互动指数', '粉丝净增量'];

      var allDivs = document.querySelectorAll('div');
      for (var i = 0; i < allDivs.length; i++) {
        var div = allDivs[i];
        var text = (div.innerText || div.textContent || '').trim();
        if (!text) continue;

        for (var ki = 0; ki < keywords.length; ki++) {
          var kw = keywords[ki];
          if (text.indexOf(kw) >= 0 && text.length < 300) {
            var already = false;
            for (var ri = 0; ri < results.length; ri++) {
              if (results[ri].dimension === kw) { already = true; break; }
            }
            if (already) continue;

            var lines = text.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
            var mine = 0;
            var peer = 0;
            var beatPct = -1;

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              if (line.indexOf(kw) >= 0) continue;

              if (line.indexOf('低于') >= 0 || line.indexOf('超过') >= 0) {
                var bp = _parsePct(line);
                if (bp >= 0) {
                  if (line.indexOf('低于') >= 0) {
                    beatPct = Math.max(0, 100 - bp);
                  } else {
                    beatPct = bp;
                  }
                }
                continue;
              }

              if (/同类|作者|平均/.test(line)) {
                var pv = _parseNum(line);
                if (pv > 0 && peer === 0) peer = pv;
                continue;
              }

              var nv = _parseNum(line);
              if (nv > 0 && mine === 0) mine = nv;
            }

            if (mine > 0 || peer > 0 || beatPct >= 0) {
              results.push({
                dimension: kw,
                mine: mine,
                peer: peer || undefined,
                beatPct: beatPct
              });
            }
          }
        }

        if (results.length >= keywords.length) break;
      }

      if (results.length === 0) {
        var bodyText = (document.body.innerText || '').trim();
        for (var ki2 = 0; ki2 < keywords.length; ki2++) {
          var kw2 = keywords[ki2];
          var idx = bodyText.indexOf(kw2);
          if (idx < 0) continue;
          var snippet = bodyText.slice(Math.max(0, idx - 100), idx + 200);
          var lines2 = snippet.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);

          var mine2 = 0;
          var peer2 = 0;
          var beatPct2 = -1;

          for (var li2 = 0; li2 < lines2.length; li2++) {
            var line2 = lines2[li2];
            if (line2.indexOf(kw2) >= 0) continue;

            if (line2.indexOf('低于') >= 0 || line2.indexOf('超过') >= 0) {
              var bp2 = _parsePct(line2);
              if (bp2 >= 0) {
                if (line2.indexOf('低于') >= 0) beatPct2 = Math.max(0, 100 - bp2);
                else beatPct2 = bp2;
              }
              continue;
            }

            if (/同类|作者|平均/.test(line2)) {
              var pv2 = _parseNum(line2);
              if (pv2 > 0 && peer2 === 0) peer2 = pv2;
              continue;
            }

            var nv2 = _parseNum(line2);
            if (nv2 > 0 && mine2 === 0) mine2 = nv2;
          }

          if (mine2 > 0 || peer2 > 0 || beatPct2 >= 0) {
            var already2 = false;
            for (var ri2 = 0; ri2 < results.length; ri2++) {
              if (results[ri2].dimension === kw2) { already2 = true; break; }
            }
            if (!already2) {
              results.push({
                dimension: kw2,
                mine: mine2,
                peer: peer2 || undefined,
                beatPct: beatPct2
              });
            }
          }
        }
      }

      return results;
    `, 'extract-peer-compare');

    log('info', 'peer-compare-done', `账号诊断提取完成，共 ${peerCompare.length} 个维度`, { count: peerCompare.length, dimensions: peerCompare.map(p => ({ dimension: p.dimension, mine: p.mine, beatPct: p.beatPct })) });

    const periods: Array<{ key: 'yesterday' | '7d' | '30d'; label: string }> = [
      { key: 'yesterday', label: '昨日' },
      { key: '7d', label: '近7天' },
      { key: '30d', label: '近30天' },
    ];

    const resultList: AccountAnalyticsPeriodData[] = [];
    const collectedAt = Date.now();

    for (const period of periods) {
      log('info', 'period-click', `切换周期: ${period.label}`);
      try {
        await this.safeEval(`
          (function() {
            var clicked = false;
            var candidates = document.querySelectorAll('div, button, li, span, a');
            for (var i = 0; i < candidates.length; i++) {
              var el = candidates[i];
              var text = (el.innerText || el.textContent || '').trim();
              if (text === '${period.label}' && !clicked) {
                var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                if (rect && rect.width > 0 && rect.height > 0) {
                  el.click();
                  clicked = true;
                }
              }
            }
            if (!clicked) {
              var allText = (document.body.innerText || '').trim();
              var idx = allText.indexOf('${period.label}');
              if (idx >= 0) {
                var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                var node;
                while (node = walker.nextNode()) {
                  var nt = (node.innerText || node.textContent || '').trim();
                  if (nt === '${period.label}' && !clicked) {
                    try { node.click(); clicked = true; } catch(e) {}
                  }
                }
              }
            }
            return clicked;
          })();
        `, `click-period-${period.key}`);
      } catch (e) {
        log('warn', 'period-click-fail', `切换周期失败: ${period.label}`, { error: (e as Error).message });
      }

      await sleep(2000);

      log('info', 'extract-period', `提取 ${period.label} 数据表现卡片`);
      const periodData = await this.safeEval<{
        views?: AnalyticsMetricValue;
        profileViews?: AnalyticsMetricValue;
        likes?: AnalyticsMetricValue;
        shares?: AnalyticsMetricValue;
        comments?: AnalyticsMetricValue;
        coverClickRate?: AnalyticsMetricValue;
        netFans?: AnalyticsMetricValue;
        lostFans?: AnalyticsMetricValue;
        extra: Record<string, any>;
      }>(`
        function _parseNum(text) {
          try {
            var clean = (text || '').trim().replace(/[,\\s]/g, '');
            var pm = clean.match(/^(-?\\d+(?:\\.\\d+)?)([万wWkK千%])?$/);
            if (!pm) return 0;
            var n = parseFloat(pm[1]);
            if (pm[2]) {
              if (/[万wW]/.test(pm[2])) n *= 10000;
              else if (/[千kK]/.test(pm[2])) n *= 1000;
            }
            return Math.round(n);
          } catch (e) { return 0; }
        }

        function _parseChangePct(text) {
          if (!text) return null;
          var t = (text || '').trim();
          var m = t.match(/([+-]?\\d+(?:\\.\\d+)?)\\s*%/);
          if (!m) return null;
          return parseFloat(m[1]);
        }

        function _makeMetric(text, unit) {
          if (!text) return undefined;
          var lines = text.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
          if (lines.length === 0) return undefined;

          var value = 0;
          var changePct = null;
          var foundValue = false;

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/环比|昨日|前日|上周|上月/.test(line)) {
              var cp = _parseChangePct(line);
              if (cp !== null) changePct = cp;
              continue;
            }
            if (/^[+-]/.test(line) && line.indexOf('%') >= 0) {
              var cp2 = _parseChangePct(line);
              if (cp2 !== null) changePct = cp2;
              continue;
            }
            if (!foundValue) {
              var nv = _parseNum(line);
              if (nv !== 0 || /[\\d]/.test(line)) {
                value = nv;
                foundValue = true;
              }
            }
          }

          if (!foundValue && lines.length > 0) {
            value = _parseNum(lines[lines.length - 1]);
          }

          return {
            value: value,
            changePct: changePct,
            unit: unit || undefined
          };
        }

        var result = {
          views: undefined,
          profileViews: undefined,
          likes: undefined,
          shares: undefined,
          comments: undefined,
          coverClickRate: undefined,
          netFans: undefined,
          lostFans: undefined,
          extra: {}
        };

        var labelMap = {
          '播放量': 'views',
          '播放': 'views',
          '主页访问': 'profileViews',
          '主页访客': 'profileViews',
          '作品点赞': 'likes',
          '点赞': 'likes',
          '作品分享': 'shares',
          '分享': 'shares',
          '作品评论': 'comments',
          '评论': 'comments',
          '封面点击率': 'coverClickRate',
          '净增粉丝': 'netFans',
          '净增关注': 'netFans',
          '取关粉丝': 'lostFans',
          '取消关注': 'lostFans',
          '总粉丝量': 'fansTotal',
          '粉丝总数': 'fansTotal',
          '总粉丝': 'fansTotal'
        };

        var metricUnitMap = {
          'coverClickRate': '%'
        };

        var cardSelectors = [
          '[class*="card"]',
          '[class*="Card"]',
          '[class*="metric"]',
          '[class*="Metric"]',
          '[class*="stat"]',
          '[class*="Stat"]',
          '[class*="item"]',
          '[class*="Item"]'
        ];

        var candidates = [];
        for (var si = 0; si < cardSelectors.length; si++) {
          try {
            var found = document.querySelectorAll(cardSelectors[si]);
            for (var fi = 0; fi < found.length; fi++) {
              if (candidates.indexOf(found[fi]) === -1) {
                candidates.push(found[fi]);
              }
            }
          } catch (e) {}
        }

        for (var ci = 0; ci < candidates.length; ci++) {
          var card = candidates[ci];
          var text = (card.innerText || card.textContent || '').trim();
          if (!text || text.length < 4 || text.length > 300) continue;

          var matchedLabel = null;
          var matchedField = null;
          var labels = Object.keys(labelMap);
          for (var li = 0; li < labels.length; li++) {
            if (text.indexOf(labels[li]) >= 0) {
              matchedLabel = labels[li];
              matchedField = labelMap[labels[li]];
              break;
            }
          }
          if (!matchedLabel) continue;

          var lines = text.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
          var labelLineIdx = -1;
          for (var lli = 0; lli < lines.length; lli++) {
            if (lines[lli].indexOf(matchedLabel) >= 0) {
              labelLineIdx = lli;
              break;
            }
          }
          if (labelLineIdx < 0) continue;

          var cardText = lines.slice(labelLineIdx).join('\\n');
          var unit = metricUnitMap[matchedField] || undefined;
          var metric = _makeMetric(cardText, unit);

          if (matchedField === 'fansTotal') {
            if (metric) result.extra.fansTotal = metric.value;
          } else {
            if (metric) result[matchedField] = metric;
          }
        }

        var bodyText = (document.body.innerText || '').trim();
        var bodyLines = bodyText.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
        for (var bli = 0; bli < bodyLines.length; bli++) {
          var bl = bodyLines[bli];
          var labels2 = Object.keys(labelMap);
          for (var li2 = 0; li2 < labels2.length; li2++) {
            if (bl === labels2[li2] || bl.indexOf(labels2[li2] + '\\n') === 0 || bl.indexOf(labels2[li2] + ' ') === 0) {
              var field2 = labelMap[labels2[li2]];
              if (field2 === 'fansTotal' && result.extra.fansTotal) continue;
              if (field2 !== 'fansTotal' && result[field2]) continue;

              var snippetLines = [];
              for (var sj = 0; sj < 5 && bli + sj < bodyLines.length; sj++) {
                snippetLines.push(bodyLines[bli + sj]);
              }
              var snippetText = snippetLines.join('\\n');
              var unit2 = metricUnitMap[field2] || undefined;
              var metric2 = _makeMetric(snippetText, unit2);

              if (field2 === 'fansTotal') {
                if (metric2) result.extra.fansTotal = metric2.value;
              } else {
                if (metric2) result[field2] = metric2;
              }
            }
          }
        }

        return result;
      `, `extract-period-${period.key}`);

      log('info', 'period-extracted', `${period.label} 数据提取完成`, periodData);

      const id = `${this.account.id}_${period.key}_${collectedAt}`;
      const periodRecord: AccountAnalyticsPeriodData = {
        id,
        accountId: this.account.id,
        platform: 'douyin',
        period: period.key,
        peerCompare: period.key === 'yesterday' ? peerCompare : undefined,
        views: periodData.views,
        profileViews: periodData.profileViews,
        likes: periodData.likes,
        shares: periodData.shares,
        comments: periodData.comments,
        coverClickRate: periodData.coverClickRate,
        netFans: periodData.netFans,
        lostFans: periodData.lostFans,
        extra: Object.keys(periodData.extra).length > 0 ? periodData.extra : undefined,
        collectedAt,
      };

      resultList.push(periodRecord);
    }

    log('info', 'done', '账号周期分析采集完成', { count: resultList.length });
    return resultList;
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
  }>> {
    const log = this.makeLog('douyin-works');

    if (!this.win) {
      await this.initWindow();
    }
    if (!this.win) throw new Error('窗口初始化失败');

    try {
      log('info', 'network-listen', '开始监听作品管理 API');
      await this.startNetworkCollect(/\/janus\/douyin\/creator\/pc\/work_list/);

      log('info', 'goto', '跳转到作品管理页');
      await this.goto(DOUYIN_CONTENT_MANAGE, 3000);
      await sleep(5000);
      
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

      let hasMore = firstPageData?.has_more ?? false;
      let page = 1;
      const maxPages = 50;
      let lastFirstAwemeId = '';
      if (allWorks.length > 0 && allWorks[0].extra?.awemeId) {
        lastFirstAwemeId = allWorks[0].extra.awemeId as string;
      }

      while (hasMore && allWorks.length < limit && page < maxPages && !hitIncrementalStop) {
        const beforeCount = this.getResponseCount();
        
        const scrolled = await this.tryScrollToBottom();
        if (!scrolled) {
          log('info', 'scroll-fail', '滚动到底部失败，停止加载');
          break;
        }

        try {
          const nextPageData = await this.waitForNewResponse(beforeCount, 15000);
          
          const pageWorks: Array<any> = [];
          const pageSeen = new Set<string>();
          const pageResult = this.parseAndAddWorks(nextPageData, pageWorks, pageSeen, log);
          const added = pageResult.added;
          
          let currentFirstAwemeId = '';
          if (pageWorks.length > 0 && pageWorks[0].extra?.awemeId) {
            currentFirstAwemeId = pageWorks[0].extra.awemeId as string;
          }
          
          if (added > 0 && lastFirstAwemeId && currentFirstAwemeId === lastFirstAwemeId) {
            log('warn', 'page-same', '新数据与上一页相同，可能加载未生效，停止加载');
            break;
          }
          if (added > 0) {
            lastFirstAwemeId = currentFirstAwemeId;
          }

          const mainResult = this.parseAndAddWorks(nextPageData, allWorks, seenIds, log, incremental);
          hitIncrementalStop = mainResult.hitStop;
          page++;
          log('info', 'page-works', `第 ${page} 页提取到 ${mainResult.added} 条作品（CDP 监听方式），累计 ${allWorks.length} 条${hitIncrementalStop ? '，增量停止' : ''}`);
          
          hasMore = nextPageData?.has_more ?? false;
          
          if (mainResult.added === 0 && !hitIncrementalStop) break;
          if (hitIncrementalStop) break;
        } catch (e) {
          log('warn', 'page-timeout', '等待新数据超时，停止加载');
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

  private async tryScrollToBottom(): Promise<boolean> {
    try {
      await this.safeEval(`
        window.scrollTo(0, document.body.scrollHeight);
        return true;
      `, 'scroll-to-bottom');
      return true;
    } catch {
      return false;
    }
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
    if (resp.status_code !== 0) {
      log('warn', 'parse-not-success', `响应不成功: status_code=${resp.status_code}`);
      return { added: 0, hitStop: false };
    }
    
    let items: any[] = [];
    const possibleLists = ['items', 'aweme_list', 'list', 'works', 'photos', 'records'];
    for (const key of possibleLists) {
      if (Array.isArray(resp[key])) {
        items = resp[key];
        break;
      }
    }
    if (items.length === 0 && resp.data) {
      for (const key of possibleLists) {
        if (Array.isArray(resp.data[key])) {
          items = resp.data[key];
          break;
        }
      }
    }
    
    if (!Array.isArray(items) || items.length === 0) {
      log('info', 'parse-empty-list', '列表为空');
      return { added: 0, hitStop: false };
    }

    let count = 0;
    let hitStop = false;
    for (const item of items) {
      const awemeId = item.aweme_id || item.id || item.work_id || item.awemeId || '';
      if (!awemeId) continue;

      const workId = `dy_${awemeId}`;

      if (incremental?.lastWorkId && workId === incremental.lastWorkId) {
        log('info', 'incremental-stop', `遇到已采集的最后作品ID: ${workId}，增量停止`);
        hitStop = true;
        break;
      }

      const publishTimeRaw = item.create_time || item.publish_time || item.ctime || Date.now();
      const publishTime = typeof publishTimeRaw === 'number' ? publishTimeRaw * (publishTimeRaw < 1e12 ? 1000 : 1) : Date.now();

      if (incremental?.lastWorkPublishTime && publishTime <= incremental.lastWorkPublishTime) {
        log('info', 'incremental-stop', `遇到已采集的发布时间: ${new Date(publishTime).toISOString()}，增量停止`);
        hitStop = true;
        break;
      }

      if (seenIds.has(workId)) continue;
      seenIds.add(workId);

      const title = item.desc || item.title || item.caption || '';
      const coverUrl = item.cover || item.cover_url || item.thumb_url || (item.video && item.video.cover) || '';
      const detailUrl = awemeId ? `https://www.douyin.com/video/${awemeId}` : '';
      const duration = item.duration || (item.video && item.video.duration) || 0;
      
      const statistics = item.statistics || item.stats || item.metrics || {};
      const views = parseNumber(String(statistics.play_count || statistics.view_count || statistics.views || 0));
      const likes = parseNumber(String(statistics.digg_count || statistics.like_count || statistics.likes || 0));
      const comments = parseNumber(String(statistics.comment_count || statistics.comments || 0));
      const favorites = parseNumber(String(statistics.collect_count || statistics.favorites || 0));
      const shares = parseNumber(String(statistics.share_count || statistics.shares || 0));

      let contentType: 'video' | 'article' | 'image' = 'video';
      if (item.images && item.images.length > 0) contentType = 'image';
      if (item.article_url || item.is_article) contentType = 'article';

      allWorks.push({
        workId,
        title,
        coverUrl,
        publishTime,
        detailUrl,
        duration: typeof duration === 'number' ? Math.floor(duration / 1000) : 0,
        contentType,
        views,
        likes,
        comments,
        favorites,
        shares,
        extra: {
          awemeId,
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
    const cardsReady = await this.waitForWorksCards(30000);
    if (!cardsReady) {
      log('warn', 'cards-not-ready', '未检测到作品卡片，继续尝试采集');
    }

    const works: Array<{
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
    }> = [];

    const seenIds = new Set<string>();
    let lastCount = 0;
    let stableScrolls = 0;
    const maxScrolls = 15;
    let scrollCount = 0;

    while (scrollCount < maxScrolls && stableScrolls < 3 && works.length < limit) {
      scrollCount++;

      let pageWorks: Array<{
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
      }> = [];

      try {
        pageWorks = await this.safeEval<typeof pageWorks>(`
          function _parseNum(text) {
            try {
              var clean = (text || '').trim().replace(/[,\\s]/g, '');
              var pm = clean.match(/^(\\d+(?:\\.\\d+)?)([万wWkK千])?$/);
              if (!pm) return 0;
              var n = parseFloat(pm[1]);
              if (pm[2]) { if (/[万wW]/.test(pm[2])) n *= 10000; else if (/[千kK]/.test(pm[2])) n *= 1000; }
              return Math.round(n);
            } catch (e) { return 0; }
          }

          function _parseDuration(text) {
            if (!text) return 0;
            var parts = text.trim().split(':');
            if (parts.length === 2) {
              var m = parseInt(parts[0]);
              var s = parseInt(parts[1]);
              if (!isNaN(m) && !isNaN(s) && m >= 0 && m < 200 && s >= 0 && s < 60) return m * 60 + s;
            }
            return 0;
          }

          function _parseChineseTime(text) {
            if (!text) return 0;
            try {
              var t = text.trim();
              var m = t.match(/(\\d{4})[年\\/\\-](\\d{1,2})[月\\/\\-](\\d{1,2})[日\\s]*(\\d{1,2})[:：](\\d{2})/);
              if (m) {
                var d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]));
                if (!isNaN(d.getTime())) return d.getTime();
              }
              var m2 = t.match(/(\\d{4})[年\\/\\-](\\d{1,2})[月\\/\\-](\\d{1,2})/);
              if (m2) {
                var d2 = new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
                if (!isNaN(d2.getTime())) return d2.getTime();
              }
            } catch (e) {}
            return 0;
          }

          function _extractWorkId(card) {
            if (!card) return '';
            var links = card.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="/article/"]');
            for (var i = 0; i < links.length; i++) {
              var href = links[i].getAttribute('href') || '';
              var m = href.match(/\\/video\\/([a-zA-Z0-9_-]+)/);
              if (m) return m[1];
              var m2 = href.match(/\\/note\\/([a-zA-Z0-9_-]+)/);
              if (m2) return m2[1];
            }
            var dataId = card.getAttribute('data-aweme-id') || card.getAttribute('data-id') || card.getAttribute('aweme-id') || '';
            if (dataId) return dataId;
            return '';
          }

          var results = [];
          var seen = {};

          var cardSelectors = [
            '[class*="video-card"]',
            '[class*="work-card"]',
            '[class*="content-card"]',
          ];

          var candidates = [];
          for (var si = 0; si < cardSelectors.length; si++) {
            try {
              var found = document.querySelectorAll(cardSelectors[si]);
              for (var fi = 0; fi < found.length; fi++) {
                if (candidates.indexOf(found[fi]) === -1) {
                  candidates.push(found[fi]);
                }
              }
            } catch (e) {}
          }

          var filtered = [];
          for (var ci = 0; ci < candidates.length; ci++) {
            var isNested = false;
            for (var cj = 0; cj < candidates.length; cj++) {
              if (ci !== cj && candidates[cj].contains(candidates[ci])) {
                isNested = true;
                break;
              }
            }
            if (!isNested) filtered.push(candidates[ci]);
          }
          candidates = filtered;

          for (var ci = 0; ci < candidates.length; ci++) {
            var card = candidates[ci];
            try {
              var cardText = (card.innerText || card.textContent || '').trim();
              if (!cardText || cardText.length < 20) continue;

              var lines = cardText.split(/\\n/).map(function(s){ return s.trim(); }).filter(Boolean);
              if (lines.length < 5) continue;

              var title = '';
              var duration = 0;
              var publishTime = 0;
              var views = 0, likes = 0, comments = 0, shares = 0;
              var coverUrl = '';
              var detailUrl = '';
              var workId = _extractWorkId(card);
              var isValidCard = false;

              var imgEl = card.querySelector('img');
              if (imgEl) coverUrl = imgEl.src || '';

              if (!coverUrl) {
                var bgMatch = cardText ? null : null;
                var styledEl = card.querySelector('[style*="background-image"]');
                if (styledEl) {
                  var bgStyle = styledEl.getAttribute('style') || '';
                  var bgUrlMatch = bgStyle.match(/url\\(['"]?([^'")]+)['"]?\\)/);
                  if (bgUrlMatch) coverUrl = bgUrlMatch[1];
                }
              }

              var hasPlay = /播放/.test(cardText);
              var hasLike = /点赞/.test(cardText);
              if (hasPlay && hasLike) isValidCard = true;

              if (!isValidCard) continue;

              for (var li = 0; li < lines.length; li++) {
                var line = lines[li];
                if (!line) continue;

                var durVal = _parseDuration(line);
                if (durVal > 0 && durVal < 36000 && duration === 0) {
                  duration = durVal;
                  continue;
                }

                var tVal = _parseChineseTime(line);
                if (tVal > 0 && publishTime === 0) {
                  publishTime = tVal;
                  continue;
                }

                var nVal = _parseNum(line);
                if (nVal > 0 && li > 0) {
                  var prevLine = lines[li - 1];
                  if (/播放|观看|浏览/.test(prevLine)) { if (views === 0) views = nVal; continue; }
                  if (/点赞|赞/.test(prevLine)) { if (likes === 0) likes = nVal; continue; }
                  if (/评论/.test(prevLine)) { if (comments === 0) comments = nVal; continue; }
                  if (/分享|转发/.test(prevLine)) { if (shares === 0) shares = nVal; continue; }
                  if (/收藏|喜欢/.test(prevLine)) { continue; }
                }
              }

              for (var ti = 0; ti < lines.length; ti++) {
                var tline = lines[ti];
                if (tline && tline.length > 3 && tline.length < 80
                    && !/^\\d+$/.test(tline)
                    && !_parseDuration(tline)
                    && !_parseChineseTime(tline)
                    && !_parseNum(tline)
                    && !/(播放|点赞|评论|分享|收藏|已发布|审核中|未通过)/.test(tline)
                    && !/(编辑|设置|置顶|删除|作品|管理)/.test(tline)
                    && !/^\\d{1,2}:\\d{2}$/.test(tline)) {
                  title = tline;
                  break;
                }
              }
              if (!title) {
                for (var ti2 = 0; ti2 < lines.length; ti2++) {
                  var tl2 = lines[ti2];
                  if (tl2 && tl2.length > 5 && tl2.length < 100 && !/^[\\d:：]+$/.test(tl2)) {
                    title = tl2;
                    break;
                  }
                }
              }
              if (!title) title = '未命名作品';

              if (title) {
                var t = title.trim();
                var tlen = t.length;
                for (var halfLen = Math.floor(tlen / 2); halfLen >= tlen / 3; halfLen--) {
                  var firstHalf = t.slice(0, halfLen).trim();
                  var secondHalf = t.slice(halfLen).trim();
                  if (firstHalf === secondHalf && firstHalf.length >= 3) {
                    title = firstHalf;
                    break;
                  }
                }
              }

              if (!workId && title) {
                workId = 'dy_' + Math.abs(title.split('').reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0)).toString(36);
              }
              if (!workId || seen[workId]) continue;
              seen[workId] = true;

              var contentType = 'video';
              if (/图文|图片|image|photo/i.test(cardText)) contentType = 'image';
              if (/文章|article/i.test(cardText)) contentType = 'article';

              if (workId && !detailUrl) {
                detailUrl = 'https://www.douyin.com/video/' + workId;
              }

              results.push({
                workId: workId,
                title: title,
                coverUrl: coverUrl,
                publishTime: publishTime,
                detailUrl: detailUrl,
                duration: duration,
                contentType: contentType,
                views: views,
                likes: likes,
                comments: comments,
                shares: shares,
              });
            } catch (e) {}
          }

          return results;
        `, 'extract-works-page');
      } catch (e) {
        log('error', 'extract-fail', '提取作品列表失败', { error: e instanceof Error ? e.message : String(e) });
        break;
      }

      let hitIncrementalStop = false;
      for (const w of pageWorks) {
        if (incremental?.lastWorkId && w.workId === incremental.lastWorkId) {
          log('info', 'incremental-stop', `[DOM回退] 遇到已采集的最后作品ID: ${w.workId}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (incremental?.lastWorkPublishTime && w.publishTime && w.publishTime <= incremental.lastWorkPublishTime) {
          log('info', 'incremental-stop', `[DOM回退] 遇到已采集的发布时间: ${new Date(w.publishTime).toISOString()}，增量停止`);
          hitIncrementalStop = true;
          break;
        }
        if (!seenIds.has(w.workId)) {
          seenIds.add(w.workId);
          works.push(w);
        }
      }

      if (hitIncrementalStop) break;

      if (works.length === lastCount) {
        stableScrolls++;
      } else {
        stableScrolls = 0;
        lastCount = works.length;
      }

      log('info', 'scroll', `滚动 ${scrollCount} 次，已采集 ${works.length} 条作品（本页 ${pageWorks.length} 条）`);

      if (works.length >= limit) break;

      try {
        await this.eval(`(function(){ window.scrollBy(0, window.innerHeight * 0.85); return 'ok'; })()`, 'scroll-down');
      } catch { /* ignore */ }
      await sleep(1500);
    }

    const limited = works.slice(0, limit);
    log('info', 'done', `作品列表采集完成（DOM 回退），共 ${limited.length} 条`);
    return limited;
  }
}
