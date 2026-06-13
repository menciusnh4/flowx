import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import { runStandardPublish } from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities } from '../../../types';

const meta: PlatformMeta = {
  key: 'xiaohongshu',
  name: '小红书',
  icon: '📕',
  platformAccountLabel: '小红书号',
  authUrl: 'https://creator.xiaohongshu.com/creator/home',
  publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
  homeUrl: 'https://creator.xiaohongshu.com/creator/home',
  contentTypes: ['video', 'image'],
  capabilities: { publishVideo: true, publishImage: true, publishArticle: false } as AccountCapabilities,
  nicknameSelectors: ['.account-name', '.user-name', '.nickname', '[class*="account-name"]'],
  avatarSelectors: ['img.user_avatar', '.user-info img', 'img[class*="avatar"]'],
  loginKeywords: ['创作中心', '数据中心', '作品管理', '发布笔记', '发布视频', '我的', '粉丝', '数据分析', '数据看板'],
};

const adapter: PlatformAdapter = {
  key: 'xiaohongshu',
  meta,
  capabilities: meta.capabilities,

  async detectLoggedIn(win): Promise<LoginCheckResult> {
    try {
      const url = win.webContents.getURL();
      const info: any = await win.webContents.executeJavaScript(`
        (function () {
          var bodyText = document.body ? (document.body.innerText || '') : '';
          var curUrl = location.href;
          var keywords = ${JSON.stringify(meta.loginKeywords)};
          var matched = [];
          // 1) 登录页黑名单：URL 含 login/401/redirectReason/signin 直接判定未登录
          var isLoginPage = /login|passport|redirectReason|signin|401|signup/i.test(curUrl);
          // 2) 精确 DOM 检查：必须有账号名元素（如 .account-name 或 .user-name）
          var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
          var hasAccountEl = false;
          var rawNick = '';
          for (var i = 0; i < nickSels.length; i++) {
            var el = document.querySelector(nickSels[i]);
            if (el && el.textContent && el.textContent.trim() && el.textContent.trim().length > 0) {
              hasAccountEl = true;
              rawNick = el.textContent.trim();
              break;
            }
          }
          // 3) 关键字检查
          for (var j = 0; j < keywords.length; j++) {
            if (bodyText.indexOf(keywords[j]) !== -1) matched.push(keywords[j]);
          }
          // 综合判定：URL 非登录页 AND (有账号元素 OR 多关键字命中)
          var loggedIn = !isLoginPage && (hasAccountEl || matched.length >= 3);
          return {
            loggedIn: loggedIn,
            matched: matched,
            title: document.title,
            url: curUrl,
            isLoginPage: isLoginPage,
            hasAccountEl: hasAccountEl,
            rawNick: rawNick,
            body: bodyText.slice(0, 150),
          };
        })();
      `);
      return {
        loggedIn: info.loggedIn,
        url: info.url || url,
        title: info.title || '',
        matchedKeywords: info.matched,
      };
    } catch (e) {
      return { loggedIn: false, url: '', title: '' };
    }
  },

  async extractPageInfo(win): Promise<ExtractedAccountInfo> {
    // 从页面 DOM 提取昵称、头像、平台账号ID、粉丝/关注/获赞数据
    // 修复说明：
    //   1) 更宽松的数字解析：支持 "1.2 万"、"12,345"、"12345" 等
    //   2) 支持同元素 "标签+数字"（如 "粉丝 1.2万"）
    //   3) 不依赖相邻元素顺序，防止 "·" 分隔符破坏 currentNumStr
    const result: any = await win.webContents.executeJavaScript(`
      (function () {
        var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };

        // ============ 通用数字解析函数 ============
        function parseNumber(raw) {
          if (!raw || typeof raw !== 'string') return null;
          var s = raw.trim();
          if (!s) return null;
          // 去掉千分位和空格
          s = s.replace(/[,\\s]/g, '');
          // 提取数字部分 + 单位
          var m = s.match(/^(\\d+(?:\\.\\d+)?)\\s*([万亿万千wWkK]?)/);
          if (!m) {
            // 尝试：整个字符串就是纯数字
            var m2 = s.match(/^\\d+(?:\\.\\d+)?$/);
            if (!m2) return null;
            var v2 = parseFloat(m2[0]);
            return isNaN(v2) ? null : Math.round(v2);
          }
          var num = parseFloat(m[1]);
          if (isNaN(num)) return null;
          var unit = m[2] || '';
          if (/[万wW]/.test(unit)) num = Math.round(num * 10000);
          else if (/[千kK]/.test(unit)) num = Math.round(num * 1000);
          else if (/亿/.test(unit)) num = Math.round(num * 100000000);
          else num = Math.round(num);
          return num;
        }

        // ============ 昵称 ============
        var nickSels = ${JSON.stringify(meta.nicknameSelectors)};
        for (var si = 0; si < nickSels.length; si++) {
          var el = document.querySelector(nickSels[si]);
          if (el && el.textContent && el.textContent.trim()) { r.nickname = el.textContent.trim(); break; }
        }
        // 头像
        var avSels = ${JSON.stringify(meta.avatarSelectors)};
        for (var ai = 0; ai < avSels.length; ai++) {
          var el2 = document.querySelector(avSels[ai]);
          if (el2 && el2.getAttribute) {
            var src = el2.getAttribute('src') || '';
            if (src && /^https?:\\/\\//.test(src)) { r.avatar = src; break; }
          }
        }
        // 平台账号 ID（小红书账号）
        try {
          var allDivs = document.querySelectorAll('div, span, p');
          for (var i = 0; i < allDivs.length; i++) {
            var txt = (allDivs[i].textContent || '').trim();
            var m = txt.match(/小红书账号[\\s:：]*([0-9A-Za-z_\\-]+)/);
            if (m) { r.platformAccountId = m[1]; break; }
          }
        } catch (e) {}

        // ============ 粉丝/关注/获赞（新算法） ============
        // 策略：遍历所有文本节点，对每个元素尝试三种匹配：
        //   A) 单元素内含 "标签 数字" —— "粉丝 1.2万"
        //   B) 在所有文本块中查找独立数字，按距离最近的标签归属
        //   C) 查找 "粉丝数: 1234" 这种格式
        try {
          var candidateNodes = document.querySelectorAll('div, span, p, a, li');
          var textBlobs = [];  // { text: string, index: number }
          for (var j = 0; j < candidateNodes.length; j++) {
            var tRaw = (candidateNodes[j].textContent || '').trim();
            if (!tRaw) continue;
            // 限制单元素长度（过长的是正文段落）
            if (tRaw.length > 40) continue;
            textBlobs.push({ text: tRaw, index: j });
          }

          function trySetCount(kw, numStr) {
            if (!numStr) return false;
            var n = parseNumber(numStr);
            if (n === null) return false;
            if (/粉丝/.test(kw)) {
              if (r.fansCount === null) r.fansCount = n;
              return true;
            } else if (/关注/.test(kw)) {
              if (r.followCount === null) r.followCount = n;
              return true;
            } else if (/获赞|收藏|点赞/.test(kw)) {
              if (r.likeCount === null) r.likeCount = n;
              return true;
            }
            return false;
          }

          // ---------- 方法 A：单元素 "数字+标签" / "标签+数字" 模式 ----------
          // 注意：先执行"数字+标签"（小红书实际格式是 "16 关注数"、"12 粉丝数"）
          // 后执行"标签+数字"，使用严格正则，防止 "关注数12粉丝数62" 被错误拆分
          for (var a = 0; a < textBlobs.length; a++) {
            var blob = textBlobs[a].text;
            // A1: 严格 "数字 + 标签" 模式（必须是完整的元素文本）
            var mDigitFirst = blob.match(/^(\d+(?:\.\d+)?\s*[万wWkK千]?)\s*(粉丝数?|关注数?|获赞(?:与收藏)?)$/);
            if (mDigitFirst) {
              trySetCount(mDigitFirst[2], mDigitFirst[1]);
              continue;
            }
            // A2: 严格 "标签 + 数字" 模式
            var mLabelFirst = blob.match(/^(粉丝数?|关注数?|获赞(?:与收藏)?|点赞数?|收藏数?)\s*[:：]?\s*(\d+(?:\.\d+)?\s*[万wWkK千]?)$/);
            if (mLabelFirst) {
              trySetCount(mLabelFirst[1], mLabelFirst[2]);
            }
          }

          // ---------- 方法 B：标签 + 数字 分离模式 ----------
          // 精确：收集所有纯标签元素和纯数字元素，然后按最近距离配对
          var pureLabels = [];  // {index, label}
          var pureNumbers = {}; // index -> number
          for (var b = 0; b < textBlobs.length; b++) {
            var tText = textBlobs[b].text;
            // 纯标签元素（只包含标签关键字，不含数字）
            var labelMatch = tText.match(/^(粉丝数?|关注数?|获赞(?:与收藏)?|获赞数?)$/);
            if (labelMatch) {
              pureLabels.push({ index: b, label: labelMatch[1] });
              continue;
            }
            // 纯数字元素
            var pn = parseNumber(tText);
            if (pn !== null && pn > 0 && pn < 1000000000) {
              pureNumbers[b] = pn;
            }
          }
          // 为每个纯标签找最近的数字元素
          for (var bi = 0; bi < pureLabels.length; bi++) {
            var pl = pureLabels[bi];
            var needFans = /粉丝/.test(pl.label) && r.fansCount === null;
            var needFollow = /关注/.test(pl.label) && r.followCount === null;
            var needLike = /获赞|收藏/.test(pl.label) && r.likeCount === null;
            if (!needFans && !needFollow && !needLike) continue;

            // 在 ±8 范围内找最近的数字元素
            var bestNum = null;
            var bestDist = 99;
            var numKeys = Object.keys(pureNumbers);
            for (var nk = 0; nk < numKeys.length; nk++) {
              var nIdx = parseInt(numKeys[nk]);
              var dist = Math.abs(nIdx - pl.index);
              if (dist > 0 && dist <= 8 && dist < bestDist) {
                bestNum = pureNumbers[nIdx];
                bestDist = dist;
              }
            }
            if (bestNum !== null) {
              if (needFans) r.fansCount = bestNum;
              else if (needFollow) r.followCount = bestNum;
              else if (needLike) r.likeCount = bestNum;
            }
          }

          // ---------- 方法 C：全文扫描兜底（保守正则）----------
          // 只匹配 "数字 标签" 或 "标签 数字" 的紧邻格式，避免 "关注数12粉丝数62" 被错误拆解
          var fullText = document.body ? (document.body.innerText || '') : '';
          function scanFullTextC(pattern) {
            var matches = fullText.match(pattern);
            if (matches) {
              // 取第一个非空的捕获组（支持可选捕获）
              for (var gi = 1; gi < matches.length; gi++) {
                if (matches[gi]) return parseNumber(matches[gi]);
              }
            }
            return null;
          }
          if (r.fansCount === null) {
            // 匹配 "12粉丝" / "粉丝 12" / "粉丝数 12" / "粉丝数:12"
            var fd = scanFullTextC(/(\d+(?:\.\d+)?[万wWkK千]?)\s*粉丝|粉丝\s*[数:：]?\s*(\d+(?:\.\d+)?[万wWkK千]?)/i);
            if (fd !== null) r.fansCount = fd;
          }
          if (r.followCount === null) {
            var fl = scanFullTextC(/(\d+(?:\.\d+)?[万wWkK千]?)\s*关注|关注\s*[数:：]?\s*(\d+(?:\.\d+)?[万wWkK千]?)/i);
            if (fl !== null) r.followCount = fl;
          }
          if (r.likeCount === null) {
            var lc = scanFullTextC(/(\d+(?:\.\d+)?[万wWkK千]?)\s*(?:获赞|点赞|收藏)|(?:获赞|点赞|收藏)[与\s]*[与收藏数:：]*\s*(\d+(?:\.\d+)?[万wWkK千]?)/i);
            if (lc !== null) r.likeCount = lc;
          }
        } catch (e) {}

        return r;
      })();
    `).catch(() => ({}));
    return {
      nickname: result.nickname || '',
      avatar: result.avatar || undefined,
      platformAccountId: result.platformAccountId || undefined,
      fansCount: typeof result.fansCount === 'number' ? result.fansCount : undefined,
      followCount: typeof result.followCount === 'number' ? result.followCount : undefined,
      likeCount: typeof result.likeCount === 'number' ? result.likeCount : undefined,
    };
  },

  async publish(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback,
  ): Promise<PublishItemProgress> {
    return runStandardPublish(accountId, request, onProgress, {
      platform: 'xiaohongshu',
      meta: { publishUrl: meta.publishUrl, homeUrl: meta.homeUrl },
      detectLoggedIn: (win: BrowserWindow) => this.detectLoggedIn(win),
      publishKeywords: ['发布', '立即发布', '发布笔记', '发布视频'],
      enablePostClickVerify: true,
      fillWaitMs: 1500,
    });
  },
};

// 注册到全局注册表
registerPlatform(adapter);

export default adapter;
export { meta as xiaohongshuMeta };
