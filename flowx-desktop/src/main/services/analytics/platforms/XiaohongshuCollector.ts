import { logger } from '../../../utils/logger';
import { BaseCollector } from '../BaseCollector';
import type { AccountCredential, AccountAnalyticsPeriodData, AnalyticsMetricValue, PeerCompare } from '../../../../types';
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

  async collectAccountAnalytics(): Promise<AccountAnalyticsPeriodData[]> {
    const log = this.makeLog('xhs-analytics');
    const analyticsUrl = 'https://creator.xiaohongshu.com/statistics/account/v2?source=official';

    log('info', 'goto', '跳转到账号数据分析页');
    await this.goto(analyticsUrl, 3000);
    await sleep(5000);

    try {
      await this.waitForAccountAnalyticsContent(15000);
    } catch {
      log('warn', 'wait-timeout', '等待数据分析内容加载超时，继续尝试');
    }

    log('info', 'extract-peer', '提取账号诊断维度数据');
    const peerCompare = await this.extractPeerCompare();
    log('info', 'peer-result', `账号诊断提取完成，共 ${peerCompare.length} 个维度`);

    const periods: Array<'7d' | '30d'> = ['7d', '30d'];
    const results: AccountAnalyticsPeriodData[] = [];
    const collectedAt = Date.now();
    // 用于记录 7d 的关键指标指纹，避免切换周期不生效导致 7d/30d 完全一致
    let period7dFingerprint = '';
    function buildFingerprint(m: Record<string, AnalyticsMetricValue>): string {
      const keys = ['曝光数', '观看数', '点赞数', '评论数', '收藏数', '分享数', '净涨粉', '新增关注', '取消关注', '主页访客', '总发布'];
      return keys.map(k => {
        const v = m[k]; if (!v) return '';
        return `${k}=${v.value}${typeof v.changePct === 'number' ? ',' + v.changePct : ''}`;
      }).join('|');
    }

    for (const period of periods) {
      log('info', `period-${period}`, `开始采集周期 ${period} 数据`);

      const periodText = period === '7d' ? '近7日' : '近30日';
      const periodClicked = await this.clickPeriodTab(periodText);
      if (!periodClicked) {
        log('warn', `period-click-fail`, `点击周期 ${periodText} 失败，尝试继续`);
      }
      await sleep(2000);

      const metricMap: Record<string, AnalyticsMetricValue> = {};

      const tabs = [
        { key: '观看数据', metrics: ['曝光数', '观看数', '封面点击率', '平均观看时长', '观看总时长', '视频完播率'] },
        { key: '互动数据', metrics: ['点赞数', '评论数', '收藏数', '分享数'] },
        { key: '涨粉数据', metrics: ['净涨粉', '新增关注', '取消关注', '主页访客', '主页转粉率'] },
        { key: '发布数据', metrics: ['总发布', '发布视频', '发布图文'] },
      ];

      for (const tab of tabs) {
        log('info', `tab-${tab.key}`, `切换到 ${tab.key} Tab`);
        const tabClicked = await this.clickContentTab(tab.key);
        if (!tabClicked) {
          log('warn', `tab-click-fail`, `点击 ${tab.key} Tab 失败，尝试继续`);
        }
        await sleep(1500);

        const blocks = await this.extractCreatorBlocks();
        log('info', `blocks-${tab.key}`, `提取到 ${blocks.length} 个 creator-block`);

        for (const block of blocks) {
          const metric = this.parseCreatorBlock(block);
          if (metric && metric.name) {
            metricMap[metric.name] = {
              value: metric.value,
              changePct: metric.changePct,
              unit: metric.unit,
            };
          }
        }
      }

      // ============ 周期校验：30d 的数据不能和 7d 完全一致 ============
      if (period === '7d') {
        period7dFingerprint = buildFingerprint(metricMap);
        log('debug', 'fingerprint-7d', period7dFingerprint || '<empty>');
      } else if (period === '30d') {
        const curFingerprint = buildFingerprint(metricMap);
        log('debug', 'fingerprint-30d', curFingerprint || '<empty>');
        if (period7dFingerprint && curFingerprint && curFingerprint === period7dFingerprint) {
          log('warn', 'period-dup', `检测到 30d 数据与 7d 完全一致，周期切换可能未生效，重试一次 30d 点击`);
          // 重试：强制按 segment-item / active 路径再次点击
          await this.safeEval<void>(`
            (async function() {
              var T = function(ms){ return new Promise(function(r){setTimeout(r,ms);}); };
              var all = document.querySelectorAll('[class*="segment-item"], [class*="SegmentItem"], button, [class*="time-item"], [class*="period-item"]');
              for (var i=0;i<all.length;i++) {
                var t = (all[i].innerText||'').trim();
                if (t === '近30日' || (t.indexOf('近30')>=0 && t.length<10)) {
                  try { all[i].scrollIntoView({block:'center'}); } catch(_){}
                  try { all[i].click(); }
                  catch(e) { try { var ev=new MouseEvent('click',{bubbles:true,cancelable:true}); all[i].dispatchEvent(ev);} catch(_){} }
                  await T(1500);
                  return;
                }
              }
            })();
          `, 'period-30d-retry');
          await sleep(2500);

          // 重新拉一遍 4 个 tab 的 creator-block
          const retryMetricMap: Record<string, AnalyticsMetricValue> = {};
          for (const tab of tabs) {
            await this.clickContentTab(tab.key);
            await sleep(1200);
            const blocks = await this.extractCreatorBlocks();
            for (const block of blocks) {
              const metric = this.parseCreatorBlock(block);
              if (metric?.name) {
                retryMetricMap[metric.name] = {
                  value: metric.value, changePct: metric.changePct, unit: metric.unit,
                };
              }
            }
          }
          const retryFP = buildFingerprint(retryMetricMap);
          log('debug', 'fingerprint-30d-retry', retryFP || '<empty>');
          // 只有 retry 和 7d 不同时才覆盖，否则继续用原数据（可能确实数据就一样，日志提示一下就行）
          if (retryFP && retryFP !== period7dFingerprint) {
            Object.keys(retryMetricMap).forEach(k => { metricMap[k] = retryMetricMap[k]; });
          } else {
            log('warn', 'period-dup-retry-fail', `重试后 30d 数据仍与 7d 一致，可能是账号 30 天内确无数据，保留结果`);
          }
        }
      }

      const accountId = this.account.id;
      const periodData: AccountAnalyticsPeriodData = {
        id: `${accountId}_${period}_${collectedAt}`,
        accountId,
        platform: 'xiaohongshu',
        period,
        impressions: metricMap['曝光数'],
        views: metricMap['观看数'],
        coverClickRate: metricMap['封面点击率'],
        avgWatchDurationSec: metricMap['平均观看时长'],
        totalWatchDurationSec: metricMap['观看总时长'],
        completionRate: metricMap['视频完播率'],
        likes: metricMap['点赞数'],
        comments: metricMap['评论数'],
        favorites: metricMap['收藏数'],
        shares: metricMap['分享数'],
        netFans: metricMap['净涨粉'],
        newFans: metricMap['新增关注'],
        lostFans: metricMap['取消关注'],
        profileViews: metricMap['主页访客'],
        profileToFanRate: metricMap['主页转粉率'],
        publishCount: metricMap['总发布'],
        publishVideoCount: metricMap['发布视频'],
        publishImageCount: metricMap['发布图文'],
        peerCompare,
        collectedAt,
      };

      results.push(periodData);
      log('info', `period-done-${period}`, `周期 ${period} 数据采集完成`);
    }

    log('info', 'done', '账号分析数据全部采集完成');
    return results;
  }

  private async waitForAccountAnalyticsContent(timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const hasContent = await this.safeEval<boolean>(`
          var txt = (document.body.innerText || '').trim();
          var hasCreatorBlock = document.querySelectorAll('div.creator-block').length > 0;
          var hasWatch = txt.indexOf('观看数') >= 0 || txt.indexOf('观看数据') >= 0;
          return hasCreatorBlock || hasWatch;
        `, 'check-analytics-content');
        if (hasContent) return true;
      } catch {
        // ignore
      }
      await sleep(500);
    }
    return false;
  }

  private async extractPeerCompare(): Promise<PeerCompare[]> {
    try {
      return await this.safeEval<PeerCompare[]>(`
        function parseNum(text) {
          if (!text) return 0;
          var t = String(text).trim();
          if (!t) return 0;
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

        function parseBeatPct(text) {
          if (!text) return -1;
          var t = String(text).trim();
          var m = t.match(/超过[^\\d]*(\\d+(?:\\.\\d+)?)%/);
          if (m) return parseFloat(m[1]);
          var m2 = t.match(/(\\d+(?:\\.\\d+)?)%[^\\d]*同类/);
          if (m2) return parseFloat(m2[1]);
          var m3 = t.match(/(\\d+(?:\\.\\d+)?)%/);
          if (m3) return parseFloat(m3[1]);
          return -1;
        }

        var dimensionMap = {
          '观看数': '观看数',
          '观看': '观看数',
          '互动数': '互动数',
          '互动': '互动数',
          '涨粉数': '涨粉数',
          '涨粉': '涨粉数',
          '主页访客数': '主页访客数',
          '主页访客': '主页访客数',
          '发布数': '发布数',
          '发布': '发布数'
        };

        var result = [];

        var suggestionSelectors = [
          '.suggestionData', '.suggestionItem', '.suggestion-item', '.suggestion-data',
          '[class*="suggestion"]', '[class*="diagnosis"]', '[class*="diagnose"]',
          '.account-diagnosis', '.accountDiagnosis', '.creator-diagnosis', '.peer-compare',
          '.radar-chart', '[class*="radar"]', '.data-overview', '.top-diagnosis'
        ];

        var containers = [];
        for (var s = 0; s < suggestionSelectors.length; s++) {
          var els = document.querySelectorAll(suggestionSelectors[s]);
          for (var e = 0; e < els.length; e++) {
            containers.push(els[e]);
          }
        }

        var allItems = [];
        if (containers.length > 0) {
          for (var c = 0; c < containers.length; c++) {
            var children = containers[c].querySelectorAll('div, li, span, p, a, section');
            for (var ch = 0; ch < children.length; ch++) {
              allItems.push(children[ch]);
            }
          }
        }

        var topLevelCards = document.querySelectorAll('div[class*="card"], div[class*="stat"], div[class*="metric"], div[class*="data-item"], div[class*="item"]');
        for (var tl = 0; tl < topLevelCards.length; tl++) {
          allItems.push(topLevelCards[tl]);
        }

        var seenDimensions = {};

        for (var i = 0; i < allItems.length; i++) {
          var el = allItems[i];
          var txt = (el.innerText || '').trim();
          if (!txt || txt.length < 3 || txt.length > 100) continue;

          var lines = txt.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
          if (lines.length < 2) continue;

          var dimension = null;
          var value = 0;
          var beatPct = -1;

          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            for (var key in dimensionMap) {
              if (line.indexOf(key) >= 0 && line.length < key.length + 10) {
                dimension = dimensionMap[key];
                break;
              }
            }
            if (dimension) break;
          }

          if (!dimension) continue;
          if (seenDimensions[dimension]) continue;

          for (var li2 = 0; li2 < lines.length; li2++) {
            var line2 = lines[li2];
            var bp = parseBeatPct(line2);
            if (bp >= 0) {
              beatPct = bp;
            }
            var v = parseNum(line2);
            if (v > 0 && value === 0) {
              value = v;
            }
          }

          if (dimension && (value > 0 || beatPct >= 0)) {
            seenDimensions[dimension] = true;
            result.push({
              dimension: dimension,
              mine: value,
              beatPct: beatPct >= 0 ? beatPct : -1
            });
          }
        }

        if (result.length < 5) {
          var bodyText = (document.body.innerText || '').trim();
          var bodyLines = bodyText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

          var dimKeys = Object.keys(dimensionMap);
          for (var bi = 0; bi < bodyLines.length; bi++) {
            var bline = bodyLines[bi];
            for (var dk = 0; dk < dimKeys.length; dk++) {
              var dimKey = dimKeys[dk];
              var mappedDim = dimensionMap[dimKey];
              if (seenDimensions[mappedDim]) continue;
              if (bline.indexOf(dimKey) >= 0 && bline.length < dimKey.length + 15) {
                var bValue = 0;
                var bBeat = -1;
                for (var step = 0; step < 5; step++) {
                  var checkIdx = bi + step;
                  if (checkIdx < bodyLines.length) {
                    var checkLine = bodyLines[checkIdx];
                    var cv = parseNum(checkLine);
                    if (cv > 0 && bValue === 0) bValue = cv;
                    var cb = parseBeatPct(checkLine);
                    if (cb >= 0) bBeat = cb;
                  }
                }
                if (bValue > 0 || bBeat >= 0) {
                  seenDimensions[mappedDim] = true;
                  result.push({
                    dimension: mappedDim,
                    mine: bValue,
                    beatPct: bBeat >= 0 ? bBeat : -1
                  });
                }
              }
            }
          }
        }

        return result;
      `, 'extract-peer-compare');
    } catch (e) {
      logger.error('[XiaohongshuCollector] 提取账号诊断失败', { error: (e as Error).message });
      return [];
    }
  }

  private async clickPeriodTab(periodText: string): Promise<boolean> {
    try {
      return await this.safeEval<boolean>(`
        (async function() {
          var targetText = '${periodText}';
          var TICK = function(ms) { return new Promise(function(r){ setTimeout(r, ms); }); };

          // ========== 1. 收集所有可点击候选，优先小范围精确元素 ==========
          var all = document.querySelectorAll('*');
          var exactHits = [];   // 完全匹配文本的元素
          var fuzzyHits = [];   // 模糊匹配的元素

          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var t = (el.innerText || el.textContent || '').trim();
            if (!t) continue;
            // 完全匹配
            if (t === targetText) {
              var childCount = el.querySelectorAll('*').length;
              // 越靠近叶子(child越少)越精准，排前面
              exactHits.push({ el: el, children: childCount });
            }
            // 模糊匹配：长度稍长一点点就包含关键字，避免包含其它周期文字
            else if (t.length <= targetText.length + 6 && t.indexOf(targetText) >= 0) {
              var c2 = el.querySelectorAll('*').length;
              fuzzyHits.push({ el: el, children: c2 });
            }
          }
          // 子节点越少越靠前
          exactHits.sort(function(a, b) { return a.children - b.children; });
          fuzzyHits.sort(function(a, b) { return a.children - b.children; });

          var candidates = exactHits.concat(fuzzyHits);
          if (candidates.length === 0) return false;

          // 辅助：检查某个元素的父链中是否含 active/selected/current 等类
          function hasActive(el) {
            var cur = el;
            var steps = 0;
            while (cur && steps < 8) {
              if (cur.nodeType !== 1) { cur = cur.parentNode; steps++; continue; }
              var cls = (cur.className || '').toString();
              if (/(active|selected|current|checked|on)/i.test(cls)) return true;
              cur = cur.parentNode;
              steps++;
            }
            return false;
          }
          // 执行点击（多种策略）
          function doClick(el) {
            try {
              el.click();
              return true;
            } catch(e) {}
            try {
              var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              el.dispatchEvent(ev);
              return true;
            } catch(e2) { return false; }
          }

          // ========== 2. 逐个候选尝试，点击后等 800ms 再校验是否 active ==========
          var maxTry = Math.min(candidates.length, 15);
          for (var k = 0; k < maxTry; k++) {
            var cand = candidates[k].el;

            // 先滚动到视图内
            try { cand.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch(_) {}
            await TICK(100);

            // 检查点击前状态
            var prevActive = hasActive(cand);

            var ok = doClick(cand);
            if (!ok) continue;

            await TICK(800);

            // 点击后检查：是否获得 active（或者它的父链变 active）
            var nowActive = hasActive(cand);
            // 判胜条件：
            //  a) 点击后变为 active；
            //  b) 或者原本就是 active（如默认的近7日首次）；
            //  c) 或者在 body 中可以找到「近30日」变成 active 类（跨元素判断）
            if (nowActive) return true;

            // 兜底：如果候选原本就是 active 且点完没变，说明是目标默认态，也算命中
            if (prevActive) {
              // 再做一次数据层面的双重校验：找至少一个 creator-block 存在，或看是否含 targetText 所在元素现在处于激活态
              var bodyText = document.body.innerText || '';
              // 模糊回退：直接认为点击了，留给上层 sleep 等待实际刷新
              return true;
            }
          }

          // ========== 3. 兜底：直接按 d-segment-item 精确按钮点击 ==========
          try {
            var segItems = document.querySelectorAll('[class*="segment-item"], [class*="SegmentItem"], button[class*="time"], button[class*="period"]');
            for (var j = 0; j < segItems.length; j++) {
              var txt2 = (segItems[j].innerText || '').trim();
              if (txt2 === targetText || (txt2.length <= targetText.length + 8 && txt2.indexOf(targetText) >= 0)) {
                doClick(segItems[j]);
                await TICK(600);
                return true;
              }
            }
          } catch(_) {}

          return false;
        })();
      `, 'click-period-' + periodText);
    } catch {
      return false;
    }
  }

  private async clickContentTab(tabText: string): Promise<boolean> {
    try {
      return await this.safeEval<boolean>(`
        var targetText = '${tabText}';
        var selectors = [
          'div[class*="tab"]', 'span[class*="tab"]', 'button[class*="tab"]',
          'div[class*="header"] span', 'div[class*="header"] div',
          'li[class*="tab"]', 'a[class*="tab"]',
          '[role="tab"]', '[class*="nav"] div', '[class*="nav"] span'
        ];

        var candidates = [];
        for (var s = 0; s < selectors.length; s++) {
          var els = document.querySelectorAll(selectors[s]);
          for (var i = 0; i < els.length; i++) {
            candidates.push(els[i]);
          }
        }

        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var txt = (el.innerText || '').trim();
          if (txt === targetText) {
            el.scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              el.click();
              return true;
            } catch (e) {
              try {
                var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                el.dispatchEvent(evt);
                return true;
              } catch (e2) {
                continue;
              }
            }
          }
        }

        for (var i2 = 0; i2 < candidates.length; i2++) {
          var el2 = candidates[i2];
          var txt2 = (el2.innerText || '').trim();
          if (txt2.indexOf(targetText) >= 0 && txt2.length < targetText.length + 5) {
            el2.scrollIntoView({ behavior: 'auto', block: 'center' });
            try {
              el2.click();
              return true;
            } catch (e3) {
              try {
                var evt2 = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                el2.dispatchEvent(evt2);
                return true;
              } catch (e4) {
                continue;
              }
            }
          }
        }

        return false;
      `, 'click-content-tab-' + tabText);
    } catch {
      return false;
    }
  }

  private async extractCreatorBlocks(): Promise<string[]> {
    try {
      return await this.safeEval<string[]>(`
        var blocks = document.querySelectorAll('div.creator-block');
        var result = [];
        for (var i = 0; i < blocks.length; i++) {
          var txt = (blocks[i].innerText || '').trim();
          if (txt) result.push(txt);
        }
        if (result.length === 0) {
          var fallbackSelectors = [
            'div[class*="creator-block"]', 'div[class*="metric-block"]',
            'div[class*="stat-block"]', 'div[class*="data-block"]',
            'div[class*="indicator"]', 'div[class*="index-item"]',
            'div[class*="item-card"]', 'div[class*="block-item"]'
          ];
          for (var s = 0; s < fallbackSelectors.length; s++) {
            var fb = document.querySelectorAll(fallbackSelectors[s]);
            for (var j = 0; j < fb.length; j++) {
              var txt2 = (fb[j].innerText || '').trim();
              if (txt2 && txt2.length >= 3 && txt2.length <= 100) {
                result.push(txt2);
              }
            }
            if (result.length > 0) break;
          }
        }
        return result;
      `, 'extract-creator-blocks');
    } catch (e) {
      logger.error('[XiaohongshuCollector] 提取 creator-block 失败', { error: (e as Error).message });
      return [];
    }
  }

  private parseCreatorBlock(blockText: string): { name: string; value: number; changePct: number | null; unit?: string } | null {
    if (!blockText) return null;
    const lines = blockText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) return null;

    const name = lines[0];
    const valueString = lines[1] || '';
    const changeString = lines[2] || '';

    let value = 0;
    let unit: string | undefined = undefined;

    const vs = valueString;

    if (vs.includes('秒')) {
      unit = '秒';
      const numPart = vs.replace(/秒/g, '').trim();
      value = parseZhNumber(numPart);
    } else if (vs.includes('分钟')) {
      unit = '分钟';
      const numPart = vs.replace(/分钟/g, '').trim();
      const minutes = parseZhNumber(numPart);
      value = Math.round(minutes * 60);
    } else if (vs.includes('%')) {
      unit = '%';
      const numPart = vs.replace(/%/g, '').trim();
      value = parseFloat(numPart) || 0;
    } else {
      value = parseZhNumber(vs);
    }

    let changePct: number | null = null;
    const cs = changeString;
    if (cs.includes('环比') || cs.includes('%')) {
      const match = cs.match(/环比\s*([+-]?\d+(?:\.\d+)?)%/);
      if (match) {
        changePct = parseFloat(match[1]);
      } else {
        const match2 = cs.match(/([+-]\d+(?:\.\d+)?)%/);
        if (match2) {
          changePct = parseFloat(match2[1]);
        } else {
          const match3 = cs.match(/(\d+(?:\.\d+)?)%/);
          if (match3) {
            if (cs.includes('下降') || cs.includes('减少') || cs.includes('-')) {
              changePct = -parseFloat(match3[1]);
            } else {
              changePct = parseFloat(match3[1]);
            }
          }
        }
      }
    }

    return { name, value, changePct, unit };
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
