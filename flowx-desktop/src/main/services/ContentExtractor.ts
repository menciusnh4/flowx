import { getViewWebContents } from './BrowserService';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// ========== 类型定义 ==========

/** 提取的图片信息 */
export interface ExtractedImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  aspectRatio: number;
  caption?: string;
  position: number;
  isLikelyContent: boolean;
}

/** 内容提取结果 */
export interface ExtractedContent {
  title: string;
  content: string; // HTML 格式（已清理）
  textContent: string; // 纯文本（已清理）
  excerpt: string; // 摘要
  byline: string; // 作者/来源
  length: number;
  siteName: string;
  pageUrl: string;
  images: ExtractedImage[];
  /** 提取策略 */
  extractStrategy?: 'auto' | 'manual' | 'readability' | 'site-rule';
  /** 置信度评分 0-100 */
  confidence?: number;
  /** 是否仅提取了图片（无文本内容） */
  isImageOnly?: boolean;
}

/** 手动提取选项 */
export interface ManualExtractOptions {
  /** 提取模式：替换或追加 */
  mode: 'replace' | 'append';
  /** 指定元素的 CSS 选择器（右键菜单时使用） */
  selector?: string;
}

// ========== Readability 加载 ==========

let readabilitySource: string | null = null;

function loadReadabilitySource(): string | null {
  if (readabilitySource !== null) return readabilitySource;
  try {
    // 从 node_modules 加载 Readability
    const readabilityPath = require.resolve('@mozilla/readability/Readability.js');
    if (fs.existsSync(readabilityPath)) {
      readabilitySource = fs.readFileSync(readabilityPath, 'utf-8');
      logger.info('[ContentExtractor] Readability.js 已加载');
      return readabilitySource;
    }
  } catch (e) {
    logger.warn('[ContentExtractor] 无法加载 Readability.js:', e);
  }
  readabilitySource = '';
  return null;
}

// ========== 网站适配规则引擎 ==========

interface SiteRule {
  /** 规则名称 */
  name: string;
  /** URL 匹配正则 */
  match: RegExp;
  /** 标题选择器 */
  titleSelector?: string;
  /** 正文选择器 */
  contentSelector: string;
  /** 作者/来源选择器 */
  bylineSelector?: string;
  /** 发布时间选择器 */
  dateSelector?: string;
  /** 站点名称 */
  siteName?: string;
  /** 内容图片选择器（可选，默认从正文内找） */
  imageSelector?: string;
  /** 需要移除的选择器（正文内噪音） */
  removeSelectors?: string[];
}

const SITE_RULES: SiteRule[] = [
  {
    name: 'wechat',
    match: /mp\.weixin\.qq\.com/i,
    titleSelector: '#activity-name, .rich_media_title',
    contentSelector: '#js_content, .rich_media_content',
    bylineSelector: '#js_name, .rich_media_meta_nickname',
    dateSelector: '#publish_time, .rich_media_meta_list em',
    siteName: '微信公众号',
    removeSelectors: ['.qr_code_pc', '.rich_media_tool', '#js_pc_qr_code', '.reward_area', '.like_comment_area'],
  },
  {
    name: 'zhihu-zhuanlan',
    match: /zhuanlan\.zhihu\.com\/p\//i,
    titleSelector: '.Post-Title',
    contentSelector: '.Post-RichText, .RichText.ztext',
    bylineSelector: '.AuthorInfo-name, .UserLink-link',
    dateSelector: '.ContentItem-time',
    siteName: '知乎专栏',
    removeSelectors: ['.ContentItem-actions', '.Post-StickyBanner', '.Recommendations-Main', '.Reward'],
  },
  {
    name: 'zhihu-answer',
    match: /zhihu\.com\/question\/\d+\/answer/i,
    titleSelector: '.QuestionHeader-title',
    contentSelector: '.AnswerCard .RichText',
    bylineSelector: '.AuthorInfo-name',
    dateSelector: '.ContentItem-time',
    siteName: '知乎问答',
    removeSelectors: ['.ContentItem-actions', '.AnswerCard-more', '.Reward'],
  },
  {
    name: 'zhihu-question',
    match: /zhihu\.com\/question\/\d+$/i,
    titleSelector: '.QuestionHeader-title',
    contentSelector: '.QuestionRichText',
    siteName: '知乎问题',
    removeSelectors: ['.QuestionHeader-footer', '.Question-mainColumn .Card'],
  },
  {
    name: 'toutiao',
    match: /toutiao\.com\/article\//i,
    titleSelector: 'h1.article-title, .article-header h1',
    contentSelector: '.article-content, article',
    bylineSelector: '.article-meta .name, .author-info',
    dateSelector: '.article-meta .time, .publish-time',
    siteName: '今日头条',
    removeSelectors: ['.article-hold', '.recommend', '.comment-board', '.article-bottom-bar'],
  },
  {
    name: '36kr',
    match: /36kr\.com\/p\//i,
    titleSelector: 'h1.article-title, .article-title',
    contentSelector: '.article-content, .common-width.content',
    bylineSelector: '.article-author-name, .author-info',
    dateSelector: '.article-meta-time, .time',
    siteName: '36氪',
    removeSelectors: ['.ad', '.recommend', '.article-bottom', '.kr-embedded-app'],
  },
  {
    name: 'jianshu',
    match: /jianshu\.com\/p\//i,
    titleSelector: 'h1.title',
    contentSelector: '.show-content-free, article',
    bylineSelector: '.author .name, .info .name',
    dateSelector: '.publish-time',
    siteName: '简书',
    removeSelectors: ['.show-content-free .image-package .image-caption', '.support-author', '.comment-block'],
  },
  {
    name: 'sspai',
    match: /sspai\.com\/post\//i,
    titleSelector: 'h1.title',
    contentSelector: '.article-content, .content',
    bylineSelector: '.author-info .name, .article-info a',
    dateSelector: '.article-info time, .date',
    siteName: '少数派',
    removeSelectors: ['.article-actions', '.recommend-articles', '.paywalled'],
  },
  {
    name: 'csdn',
    match: /blog\.csdn\.net\//i,
    titleSelector: '#articleContentId, .title-article, h1.title',
    contentSelector: '#content_views, article',
    bylineSelector: '.follow-nickName, .user-info .name',
    dateSelector: '.time',
    siteName: 'CSDN',
    removeSelectors: ['.blog-tags-box', '.article-copyright', '.recommend-box', '.hide-article-box', '.csdn-common-report', '.blog-footer-bottom'],
  },
  {
    name: 'juejin',
    match: /juejin\.cn\/post\//i,
    titleSelector: 'h1.article-title',
    contentSelector: '.markdown-body, article',
    bylineSelector: '.author-info-block .username',
    dateSelector: '.meta-box time',
    siteName: '掘金',
    removeSelectors: ['.article-suspended-panel', '.article-end', '.recommend-list', '.comment-list', '.footer-common'],
  },
];

/**
 * 根据 URL 查找匹配的站点规则
 */
function findSiteRule(url: string): SiteRule | null {
  for (const rule of SITE_RULES) {
    if (rule.match.test(url)) {
      return rule;
    }
  }
  return null;
}

// ========== 主入口：自动提取 ==========

export async function extractContentFromView(viewId: string): Promise<ExtractedContent | null> {
  const wc = getViewWebContents(viewId);
  if (!wc) throw new Error('视图不存在');

  if (wc.isLoading()) {
    throw new Error('页面尚未加载完成，请等待页面加载完毕后再提取');
  }

  try {
    // 获取当前页面 URL
    const pageUrl = wc.getURL();

    // 1. 优先尝试站点适配规则
    const siteRule = findSiteRule(pageUrl);
    if (siteRule) {
      logger.info(`[ContentExtractor] 匹配站点规则: ${siteRule.name} (${siteRule.siteName})`);
      const siteResult = await trySiteRuleExtract(wc, siteRule, pageUrl);
      if (siteResult && siteResult.content) {
        logger.info(`[ContentExtractor] 站点规则提取成功: ${siteResult.title?.slice(0, 30)}, 字数: ${siteResult.length}`);
        return siteResult;
      }
      logger.warn(`[ContentExtractor] 站点规则提取失败，回退到 Readability`);
    }

    // 2. 尝试 Readability 提取
    const readabilityResult = await tryReadabilityExtract(wc);
    if (readabilityResult && readabilityResult.confidence && readabilityResult.confidence >= 60) {
      logger.info(`[ContentExtractor] Readability 提取成功，置信度: ${readabilityResult.confidence}`);
      return readabilityResult;
    }

    // 3. 回退到改进的文本密度算法
    const result = await wc.executeJavaScript(buildAutoExtractScript());

    if (!result || result.error) {
      logger.error('[ContentExtractor] 提取失败:', result?.error || '未知错误');
      // 如果 Readability 有结果但置信度低，仍然返回
      if (readabilityResult) return readabilityResult;
      return null;
    }

    return result as ExtractedContent;
  } catch (e) {
    logger.error('[ContentExtractor] executeJavaScript error:', e);
    throw new Error(`内容提取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ========== Readability 提取 ==========

async function tryReadabilityExtract(wc: Electron.WebContents): Promise<ExtractedContent | null> {
  const source = loadReadabilitySource();
  if (!source) return null;

  try {
    const script = `
(function() {
  try {
    ${source}

    // Clone document to avoid mutating the original
    var docClone = document.cloneNode(true);

    // Create a Readability instance
    var reader = new Readability(docClone, {
      charThreshold: 200,
      classesToPreserve: ['figure', 'figcaption'],
    });

    var article = reader.parse();

    if (!article) return null;

    // ========== 文本清理管线 ==========
    function cleanText(text) {
      if (!text) return '';

      // 1. 移除零宽字符和控制字符
      text = text.replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u0000-\\u001F\\u007F]/g, '');

      // 2. 统一换行符
      text = text.replace(/\\r\\n?/g, '\\n');

      // 3. 统一空格：全角空格→半角，&nbsp;→空格（已经是DOM解析后的空格）
      text = text.replace(/\\u3000/g, ' ');

      // 4. 合并连续空格为单个空格
      text = text.replace(/[ \\t]+/g, ' ');

      // 5. 处理换行：每行首尾去空格
      var lines = text.split('\\n').map(function(line) { return line.trim(); });

      // 6. 合并连续空行（3个以上→1个空行）
      var result = [];
      var emptyCount = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] === '') {
          emptyCount++;
          if (emptyCount <= 1) result.push('');
        } else {
          emptyCount = 0;
          result.push(lines[i]);
        }
      }

      // 7. 首尾去空行
      while (result.length > 0 && result[0] === '') result.shift();
      while (result.length > 0 && result[result.length - 1] === '') result.pop();

      return result.join('\\n');
    }

    // ========== 图片收集与过滤 ==========
    function collectImagesFromHTML(htmlString, baseUrl) {
      var parser = new DOMParser();
      var doc = parser.parseFromString('<div id="__ext_root">' + htmlString + '</div>', 'text/html');
      var root = doc.getElementById('__ext_root');
      if (!root) return [];

      var images = [];
      var imgEls = root.querySelectorAll('img');
      var adDomains = /doubleclick|googlesyndication|amazon-adsystem|googleadservices|adservice|adnxs|moatads|criteo|outbrain|taboola/i;

      imgEls.forEach(function(img, idx) {
        var src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || '';
        if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return;

        // 转绝对路径
        try { src = new URL(src, baseUrl).href; } catch(e) {}

        // URL 过滤：广告域名
        if (adDomains.test(src)) return;

        var w = parseInt(img.getAttribute('width') || img.naturalWidth || '0', 10);
        var h = parseInt(img.getAttribute('height') || img.naturalHeight || '0', 10);
        var alt = (img.getAttribute('alt') || '').trim();

        // 语义过滤：类名/alt包含广告相关
        var cls = (img.className || '') + ' ' + (img.id || '') + ' ' + alt;
        if (/icon|avatar|logo|sprite|emoji|badge|qrcode|qr-code|advert|ad-banner/i.test(cls)) return;

        // 尝试获取 caption (figure > figcaption)
        var caption = '';
        var parent = img.parentElement;
        if (parent) {
          var fig = parent.tagName === 'FIGURE' ? parent : parent.closest('figure');
          if (fig) {
            var cap = fig.querySelector('figcaption');
            if (cap) caption = (cap.textContent || '').trim();
          }
        }

        // 计算宽高比
        var aspectRatio = (w > 0 && h > 0) ? w / h : 1;

        // 尺寸过滤：跳过已知小图
        var isContent = true;
        if (w > 0 && h > 0) {
          if (w < 200 || h < 100) isContent = false;
          if (aspectRatio < 0.2 || aspectRatio > 5) isContent = false;
        }

        images.push({
          url: src,
          alt: alt,
          width: w,
          height: h,
          aspectRatio: Math.round(aspectRatio * 100) / 100,
          caption: caption,
          position: idx,
          isLikelyContent: isContent,
        });
      });

      // 去重（按 URL）
      var seen = {};
      var unique = [];
      for (var i = 0; i < images.length; i++) {
        if (!seen[images[i].url]) {
          seen[images[i].url] = true;
          unique.push(images[i]);
        }
      }

      // 排序：内容图在前，按尺寸从大到小
      unique.sort(function(a, b) {
        if (a.isLikelyContent !== b.isLikelyContent) return a.isLikelyContent ? -1 : 1;
        var areaA = a.width * a.height;
        var areaB = b.width * b.height;
        return areaB - areaA;
      });

      return unique.slice(0, 50);
    }

    var textContent = cleanText(article.textContent || '');
    var images = collectImagesFromHTML(article.content || '', location.href);

    // 计算置信度
    var confidence = 50;
    if (textContent.length > 500) confidence += 15;
    if (textContent.length > 1000) confidence += 10;
    if (article.byline) confidence += 5;
    if (article.siteName) confidence += 5;
    if (images.length > 0 && images.some(function(img) { return img.isLikelyContent; })) confidence += 10;
    if ((article.content || '').indexOf('<p>') >= 0) confidence += 5;
    confidence = Math.min(confidence, 100);

    return {
      title: (article.title || '').trim(),
      content: article.content || '',
      textContent: textContent,
      excerpt: textContent.slice(0, 200),
      byline: (article.byline || '').trim(),
      length: textContent.length,
      siteName: (article.siteName || '').trim(),
      pageUrl: location.href,
      images: images,
      extractStrategy: 'readability',
      confidence: confidence,
    };
  } catch(e) {
    return { error: e.message };
  }
})()
`;

    const result = await wc.executeJavaScript(script);
    if (result && !result.error) {
      return result as ExtractedContent;
    }
    return null;
  } catch (e) {
    logger.warn('[ContentExtractor] Readability 提取失败，回退到默认算法:', e);
    return null;
  }
}

// ========== 站点规则提取 ==========

async function trySiteRuleExtract(
  wc: Electron.WebContents,
  rule: SiteRule,
  pageUrl: string,
): Promise<ExtractedContent | null> {
  try {
    // 构造站点规则提取脚本
    const removeSelectorsJson = JSON.stringify(rule.removeSelectors || []);
    const titleSel = JSON.stringify(rule.titleSelector || '');
    const contentSel = JSON.stringify(rule.contentSelector);
    const bylineSel = JSON.stringify(rule.bylineSelector || '');
    const dateSel = JSON.stringify(rule.dateSelector || '');
    const siteName = JSON.stringify(rule.siteName || '');

    const script = `
(function() {
  try {
    // ========== 文本清理管线 ==========
    function cleanText(text) {
      if (!text) return '';
      text = text.replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u0000-\\u001F\\u007F]/g, '');
      text = text.replace(/\\r\\n?/g, '\\n');
      text = text.replace(/\\u3000/g, ' ');
      text = text.replace(/[ \\t]+/g, ' ');
      var lines = text.split('\\n').map(function(line) { return line.trim(); });
      var result = [];
      var emptyCount = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] === '') { emptyCount++; if (emptyCount <= 1) result.push(''); }
        else { emptyCount = 0; result.push(lines[i]); }
      }
      while (result.length > 0 && result[0] === '') result.shift();
      while (result.length > 0 && result[result.length - 1] === '') result.pop();
      return result.join('\\n');
    }

    // ========== 清理 HTML 内容 ==========
    function cleanContentHTML(el) {
      var clone = el.cloneNode(true);

      // 移除噪音元素
      var noiseSelectors = ${removeSelectorsJson};
      noiseSelectors.forEach(function(sel) {
        try { clone.querySelectorAll(sel).forEach(function(n) { n.remove(); }); } catch(e) {}
      });

      // 移除脚本、样式、导航等通用噪音
      clone.querySelectorAll('script, style, noscript, iframe, nav, footer, aside').forEach(function(n) { n.remove(); });

      // 移除隐藏元素
      clone.querySelectorAll('[hidden], [style*="display:none"], [style*="visibility:hidden"]').forEach(function(n) { n.remove(); });

      // 移除空标签
      clone.querySelectorAll('p, div, span').forEach(function(p) {
        var txt = (p.textContent || '').trim();
        if (txt === '' && !p.querySelector('img, video, figure')) {
          if (!p.id && (!p.className || p.className.trim() === '')) p.remove();
        }
      });

      // 处理图片：确保有 src
      clone.querySelectorAll('img').forEach(function(img) {
        var src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
        if (src) { img.setAttribute('src', src); } else { img.remove(); }
        // 移除可能的追踪属性
        img.removeAttribute('data-src');
        img.removeAttribute('data-original');
      });

      return clone.innerHTML;
    }

    // ========== 收集图片 ==========
    function collectImages(el) {
      var images = [];
      var adDoms = /doubleclick|googlesyndication|amazon-adsystem|googleadservices|adservice|adnxs|moatads|criteo|outbrain|taboola|pixel|tracker|beacon|analytics/i;

      el.querySelectorAll('img').forEach(function(img, idx) {
        var src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (!src || src.startsWith('data:') || adDoms.test(src)) return;

        var w = parseInt(img.getAttribute('width') || img.naturalWidth || 0);
        var h = parseInt(img.getAttribute('height') || img.naturalHeight || 0);
        var rect = img.getBoundingClientRect();
        if (!w) w = Math.round(rect.width);
        if (!h) h = Math.round(rect.height);

        if (w < 50 || h < 50) return;
        var ar = h > 0 ? w / h : 1;
        if (ar < 0.3 || ar > 5) return;

        var isContent = w >= 200 && h >= 100 && ar >= 0.5 && ar <= 3;

        // 找 caption
        var caption = '';
        var parent = img.parentElement;
        for (var i = 0; i < 3 && parent; i++) {
          var cap = parent.querySelector('figcaption, .caption, .image-caption, [class*="caption"]');
          if (cap) { caption = (cap.textContent || '').trim(); break; }
          parent = parent.parentElement;
        }

        try { src = new URL(src, location.href).href; } catch(e) {}

        images.push({
          url: src,
          alt: (img.getAttribute('alt') || '').trim(),
          width: w,
          height: h,
          aspectRatio: ar,
          caption: caption,
          position: idx,
          isLikelyContent: isContent,
        });
      });

      // 去重
      var seen = {};
      var unique = [];
      for (var i = 0; i < images.length; i++) {
        if (!seen[images[i].url]) { seen[images[i].url] = true; unique.push(images[i]); }
      }

      // 排序：内容图片优先，大的优先
      unique.sort(function(a, b) {
        if (a.isLikelyContent !== b.isLikelyContent) return a.isLikelyContent ? -1 : 1;
        return (b.width * b.height) - (a.width * a.height);
      });

      return unique.slice(0, 30);
    }

    // ========== 提取字段 ==========
    function queryText(sel) {
      if (!sel) return '';
      var el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    }

    var contentEl = document.querySelector(${contentSel});
    if (!contentEl) return null;

    var title = queryText(${titleSel}) || document.title || '';
    var contentHTML = cleanContentHTML(contentEl);
    var textContent = cleanText(contentEl.textContent || '');
    var byline = queryText(${bylineSel});
    var dateStr = queryText(${dateSel});
    var images = collectImages(contentEl);

    if (textContent.length < 50) return null;

    var confidence = 85; // 站点规则基础置信度高
    if (textContent.length > 1000) confidence += 5;
    if (images.length > 0) confidence += 5;
    if (byline) confidence += 5;
    confidence = Math.min(confidence, 100);

    return {
      title: cleanText(title),
      content: contentHTML,
      textContent: textContent,
      excerpt: textContent.slice(0, 200),
      byline: byline,
      length: textContent.length,
      siteName: ${siteName},
      pageUrl: ${JSON.stringify(pageUrl)},
      images: images,
      extractStrategy: 'site-rule',
      confidence: confidence,
    };
  } catch(e) {
    return { error: e.message };
  }
})()
`;

    const result = await wc.executeJavaScript(script);
    if (result && !result.error) {
      return result as ExtractedContent;
    }
    if (result?.error) {
      logger.warn(`[ContentExtractor] 站点规则提取脚本错误: ${result.error}`);
    }
    return null;
  } catch (e) {
    logger.warn('[ContentExtractor] 站点规则提取失败:', e);
    return null;
  }
}

// ========== 手动提取：从指定元素提取 ==========

export async function extractContentFromElement(
  viewId: string,
  selector: string,
  options: ManualExtractOptions = { mode: 'replace' },
): Promise<ExtractedContent | null> {
  const wc = getViewWebContents(viewId);
  if (!wc) throw new Error('视图不存在');

  try {
    const script = buildManualExtractScript(selector);
    const result = await wc.executeJavaScript(script);

    if (!result || result.error) {
      logger.error('[ContentExtractor] 手动提取失败:', result?.error);
      return null;
    }

    return {
      ...(result as ExtractedContent),
      extractStrategy: 'manual',
      confidence: 90, // 手动选择置信度高
    };
  } catch (e) {
    logger.error('[ContentExtractor] 手动提取 error:', e);
    throw new Error(`手动提取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ========== 注入元素选择器脚本（进入选择模式） ==========

export async function startElementSelector(viewId: string): Promise<void> {
  const wc = getViewWebContents(viewId);
  if (!wc) throw new Error('视图不存在');

  // 检查是否已经在选择模式
  const isActive = await wc.executeJavaScript('!!window.__flowx_selector_active');
  if (isActive) return;

  await wc.executeJavaScript(buildSelectorScript());
  logger.info('[ContentExtractor] 元素选择模式已启动');
}

export async function stopElementSelector(viewId: string): Promise<void> {
  const wc = getViewWebContents(viewId);
  if (!wc) return;
  try {
    await wc.executeJavaScript(`
      if (window.__flowx_selector_cleanup) {
        window.__flowx_selector_cleanup();
      }
    `);
  } catch (e) {
    logger.warn('[ContentExtractor] 停止选择模式失败:', e);
  }
}

// ========== 注入右键菜单提取脚本（供主进程 context-menu 事件调用） ==========

export async function getElementInfoAtPoint(
  viewId: string,
  x: number,
  y: number,
): Promise<{ selector: string; tagName: string; textPreview: string; imageSrc?: string } | null> {
  const wc = getViewWebContents(viewId);
  if (!wc) return null;

  try {
    const script = `
(function() {
  var el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;

  // 向上查找有意义的容器元素
  while (el && el !== document.body) {
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim();
    if (text.length > 50 || tag === 'article' || tag === 'section' || tag === 'p' || tag === 'img') {
      break;
    }
    el = el.parentElement;
  }
  if (!el) el = document.body;

  // 生成唯一 CSS 选择器
  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var sel = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).filter(function(c) { return c; });
        if (cls.length > 0) sel += '.' + cls.map(function(c) { return CSS.escape(c); }).join('.');
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(s) { return s.tagName === el.tagName; });
        if (siblings.length > 1) {
          sel += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
        }
      }
      path.unshift(sel);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  var tagName = el.tagName.toLowerCase();
  var textPreview = (el.textContent || '').trim().slice(0, 100);
  var imageSrc = tagName === 'img' ? el.src : null;

  return {
    selector: getSelector(el),
    tagName: tagName,
    textPreview: textPreview,
    imageSrc: imageSrc,
  };
})()
`;
    return await wc.executeJavaScript(script);
  } catch (e) {
    logger.warn('[ContentExtractor] 获取元素信息失败:', e);
    return null;
  }
}

// ========== 构建自动提取脚本（改进版文本密度算法） ==========

function buildAutoExtractScript(): string {
  return `
(function() {
  try {
    // ========== 文本清理函数 ==========
    function cleanText(text) {
      if (!text) return '';
      text = text.replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g, '');
      text = text.replace(/\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F/g, '');
      text = text.replace(/\\r\\n?/g, '\\n');
      text = text.replace(/\\u3000/g, ' ');
      text = text.replace(/[ \\t]+/g, ' ');
      var lines = text.split('\\n').map(function(line) { return line.trim(); });
      var result = [];
      var emptyCount = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] === '') {
          emptyCount++;
          if (emptyCount <= 1) result.push('');
        } else {
          emptyCount = 0;
          result.push(lines[i]);
        }
      }
      while (result.length > 0 && result[0] === '') result.shift();
      while (result.length > 0 && result[result.length - 1] === '') result.pop();
      return result.join('\\n');
    }

    function getText(el) {
      return cleanText(el.textContent || '');
    }

    function getLinkDensity(el) {
      var textLen = getText(el).length;
      if (textLen === 0) return 0;
      var linkText = 0;
      el.querySelectorAll('a').forEach(function(a) {
        linkText += (a.textContent || '').trim().length;
      });
      return linkText / textLen;
    }

    // 改进的节点评分
    function scoreNode(el) {
      var score = 0;
      var text = getText(el);
      var textLen = text.length;
      if (textLen < 20) return -100;

      score += Math.min(textLen / 50, 30);

      var pCount = el.querySelectorAll('p').length;
      score += pCount * 2;

      var hCount = el.querySelectorAll('h1, h2, h3, h4').length;
      score += hCount * 1.5;

      var linkDensity = getLinkDensity(el);
      if (linkDensity > 0.5) score -= 15;
      else if (linkDensity > 0.3) score -= 8;
      else if (linkDensity < 0.1) score += 5;

      var imgCount = el.querySelectorAll('img').length;
      if (imgCount > 0 && imgCount < 20) score += imgCount;

      var cls = (el.className || '') + ' ' + (el.id || '');
      var positive = /article|content|post|entry|main|body|text|story|detail|news|art-|rich_media|rich-text|article-content/i;
      var negative = /comment|nav|menu|header|footer|sidebar|widget|ad|advertis|promo|related|recommend|share|social|tag|category|nav|login|register|popup|modal|dialog|banner|breadcrumb|pagination|search/i;
      if (positive.test(cls)) score += 15;
      if (negative.test(cls)) score -= 20;

      var tag = el.tagName.toLowerCase();
      if (tag === 'article') score += 20;
      if (tag === 'main') score += 15;
      if (tag === 'section') score += 5;
      if (tag === 'nav' || tag === 'aside' || tag === 'header' || tag === 'footer') score -= 15;

      // 父元素惩罚：如果父元素分数也高，优先取子元素（避免嵌套）
      if (el.parentElement) {
        var parentTag = el.parentElement.tagName.toLowerCase();
        if (parentTag === 'article' || parentTag === 'main') score -= 3;
      }

      return score;
    }

    // ========== 1. 找到最佳内容容器 ==========
    var candidates = document.querySelectorAll(
      'article, main, section, div, ' +
      '[class*="content"], [class*="article"], [class*="post"], [class*="entry"], [class*="rich"], ' +
      '[id*="content"], [id*="article"], [id*="post"]'
    );
    var bestEl = null;
    var bestScore = -Infinity;

    candidates.forEach(function(el) {
      // 跳过太小或隐藏的元素
      if (!el.offsetParent && el !== document.body) return;
      var score = scoreNode(el);
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    });

    if (!bestEl || bestScore < 10) {
      bestEl = document.body;
    }

    // ========== 2. 提取标题 ==========
    var title = '';
    var ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) title = ogTitle.getAttribute('content') || '';
    if (!title) {
      var h1 = document.querySelector('h1');
      if (h1) title = (h1.textContent || '').trim();
    }
    if (!title) {
      var itemTitle = document.querySelector('[itemprop="headline"]');
      if (itemTitle) title = (itemTitle.textContent || '').trim();
    }
    if (!title) title = document.title || '';
    title = title.trim();

    // ========== 3. 提取作者/来源 ==========
    var byline = '';
    var authorMeta = document.querySelector('meta[name="author"], meta[property="article:author"]');
    if (authorMeta) byline = authorMeta.getAttribute('content') || '';
    if (!byline) {
      var authorEl = document.querySelector('.author, .byline, .writer, .source, .author-name, [class*="author"], [class*="writer"], [itemprop="author"]');
      if (authorEl) byline = (authorEl.textContent || '').trim().slice(0, 50);
    }

    // ========== 4. 提取站点名称 ==========
    var siteName = '';
    var ogSite = document.querySelector('meta[property="og:site_name"]');
    if (ogSite) siteName = ogSite.getAttribute('content') || '';
    if (!siteName) {
      try { siteName = location.hostname.replace(/^www\\./, ''); } catch(e) {}
    }

    // ========== 5. 清理内容 ==========
    var clone = bestEl.cloneNode(true);

    var removeSelectors = [
      'script', 'style', 'noscript', 'iframe', 'svg:not(:has(img))',
      'nav', 'header:not(article header)', 'footer:not(article footer)', 'aside',
      '.ad', '.advertisement', '.advert', '.ads', '.adsbygoogle',
      '.comment', '.comments', '.comment-list', '.comment-area',
      '.share', '.social', '.social-share', '.share-bar',
      '.sidebar', '.widget', '.related', '.recommend', '.recommendation',
      '.nav', '.navigation', '.pager', '.pagination',
      '.toolbar', '.action', '.actions', '.btn-group', '.button-group',
      '.login', '.register', '.popup', '.modal', '.dialog',
      '.breadcrumb', '.search', '.search-box',
      'form', 'input', 'button', 'select', 'textarea',
      '[class*="ad-"]', '[class*="ads-"]', '[class*="advert"]',
      '[class*="banner"]', '[class*="popup"]', '[class*="modal"]',
      '[id*="ad-"]', '[id*="ads-"]', '[id*="banner"]',
      '[hidden]', '[style*="display:none"]', '[style*="visibility:hidden"]',
    ];

    removeSelectors.forEach(function(sel) {
      try {
        clone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
      } catch(e) {}
    });

    // 移除空的块级元素
    clone.querySelectorAll('p, div, section, span').forEach(function(el) {
      var html = el.innerHTML.trim();
      var text = (el.textContent || '').trim();
      if (text === '' && !el.querySelector('img, video, iframe')) {
        // 保留有意义的空行，但移除完全空且无属性的元素
        if (!el.id && (!el.className || el.className.trim() === '')) {
          el.remove();
        }
      }
    });

    // ========== 6. 图片收集与过滤 ==========
    var images = [];
    var adDomains = /doubleclick|googlesyndication|amazon-adsystem|googleadservices|adservice|adnxs|moatads|criteo|outbrain|taboola|pixel|tracker|beacon|analytics/i;

    var imgEls = clone.querySelectorAll('img');
    imgEls.forEach(function(img, idx) {
      var src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') ||
                img.getAttribute('data-lazy-src') || img.getAttribute('data-srcset') || '';
      if (src) {
        // srcset 可能是多 URL，取第一个
        src = src.split(',')[0].trim().split(' ')[0];
      }
      if (!src || src.startsWith('data:') || src.startsWith('javascript:') || src.startsWith('about:')) return;

      try { src = new URL(src, location.href).href; } catch(e) {}

      if (adDomains.test(src)) return;

      var w = parseInt(img.getAttribute('width') || img.naturalWidth || (img.style && img.style.width) || '0', 10);
      var h = parseInt(img.getAttribute('height') || img.naturalHeight || (img.style && img.style.height) || '0', 10);
      var alt = (img.getAttribute('alt') || '').trim();

      var cls = (img.className || '') + ' ' + (img.id || '') + ' ' + alt;
      if (/icon|avatar|logo|sprite|emoji|badge|qrcode|qr-code|advert|loading|placeholder|blank/i.test(cls)) return;

      // 检查父级元素是否是链接到非内容页面
      var parentLink = img.closest('a');
      if (parentLink) {
        var href = parentLink.getAttribute('href') || '';
        if (/login|register|signup|download|app/i.test(href)) return;
      }

      var caption = '';
      var parent = img.parentElement;
      if (parent) {
        var fig = parent.tagName === 'FIGURE' ? parent : parent.closest('figure');
        if (fig) {
          var cap = fig.querySelector('figcaption');
          if (cap) caption = (cap.textContent || '').trim();
        }
      }

      var aspectRatio = (w > 0 && h > 0) ? w / h : 1;
      var isContent = true;

      if (w > 0 && h > 0) {
        if (w < 200 || h < 100) isContent = false;
        if (aspectRatio < 0.2 || aspectRatio > 5) isContent = false;
        // 1x1 像素（追踪图）
        if (w <= 2 && h <= 2) isContent = false;
      }

      images.push({
        url: src,
        alt: alt,
        width: w,
        height: h,
        aspectRatio: Math.round(aspectRatio * 100) / 100,
        caption: caption,
        position: idx,
        isLikelyContent: isContent,
      });
    });

    // URL 去重
    var seenUrls = {};
    var uniqueImages = [];
    for (var i = 0; i < images.length; i++) {
      if (!seenUrls[images[i].url]) {
        seenUrls[images[i].url] = true;
        uniqueImages.push(images[i]);
      }
    }

    // 排序：内容图优先，大的优先
    uniqueImages.sort(function(a, b) {
      if (a.isLikelyContent !== b.isLikelyContent) return a.isLikelyContent ? -1 : 1;
      var areaA = (a.width || 300) * (a.height || 200);
      var areaB = (b.width || 300) * (b.height || 200);
      return areaB - areaA;
    });

    var finalImages = uniqueImages.slice(0, 50);

    // ========== 7. 提取纯文本并清理 ==========
    var textContent = getText(clone);

    // ========== 8. 计算置信度 ==========
    var confidence = 40;
    if (textContent.length > 300) confidence += 15;
    if (textContent.length > 800) confidence += 10;
    if (textContent.length > 2000) confidence += 5;
    var contentImages = finalImages.filter(function(img) { return img.isLikelyContent; });
    if (contentImages.length > 0) confidence += 10;
    if (clone.querySelectorAll('h1, h2, h3').length > 0) confidence += 5;
    if (clone.querySelectorAll('p').length >= 3) confidence += 10;
    var linkD = getLinkDensity(clone);
    if (linkD < 0.2) confidence += 5;
    if (byline) confidence += 5;
    confidence = Math.min(confidence, 95);

    return {
      title: title,
      content: clone.innerHTML || '',
      textContent: textContent,
      excerpt: textContent.slice(0, 200),
      byline: byline.trim(),
      length: textContent.length,
      siteName: siteName.trim(),
      pageUrl: location.href,
      images: finalImages,
      extractStrategy: 'auto',
      confidence: confidence,
    };
  } catch(e) {
    return { error: e.message };
  }
})()
`;
}

// ========== 构建手动提取脚本 ==========

function buildManualExtractScript(selector: string): string {
  return `
(function() {
  try {
    function cleanText(text) {
      if (!text) return '';
      text = text.replace(/[\\u200B-\\u200D\\uFEFF\\u00AD]/g, '');
      text = text.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '');
      text = text.replace(/\\r\\n?/g, '\\n');
      text = text.replace(/\\u3000/g, ' ');
      text = text.replace(/[ \\t]+/g, ' ');
      var lines = text.split('\\n').map(function(line) { return line.trim(); });
      var result = [];
      var emptyCount = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] === '') {
          emptyCount++;
          if (emptyCount <= 1) result.push('');
        } else {
          emptyCount = 0;
          result.push(lines[i]);
        }
      }
      while (result.length > 0 && result[0] === '') result.shift();
      while (result.length > 0 && result[result.length - 1] === '') result.pop();
      return result.join('\\n');
    }

    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: '未找到指定元素: ' + ${JSON.stringify(selector)} };

    var tagName = el.tagName.toLowerCase();

    // ========== 特殊处理：图片元素 ==========
    if (tagName === 'img') {
      var src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
      if (src) {
        try { src = new URL(src, location.href).href; } catch(e) {}
      }
      if (!src) return { error: '无法获取图片地址' };

      var iw = parseInt(el.getAttribute('width') || el.naturalWidth || '0', 10);
      var ih = parseInt(el.getAttribute('height') || el.naturalHeight || '0', 10);
      var imgAlt = (el.getAttribute('alt') || '').trim();

      return {
        title: (document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                 document.querySelector('h1')?.textContent || document.title || '').trim(),
        content: '',
        textContent: '',
        excerpt: '[图片]',
        byline: '',
        length: 0,
        siteName: (document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
                    location.hostname.replace(/^www\./, '')).trim(),
        pageUrl: location.href,
        images: [{
          url: src, alt: imgAlt, width: iw, height: ih,
          aspectRatio: (iw > 0 && ih > 0) ? Math.round((iw / ih) * 100) / 100 : 1,
          caption: '', position: 0, isLikelyContent: true,
        }],
        extractStrategy: 'manual',
        isImageOnly: true,
      };
    }

    // 清理：移除脚本和样式
    var clone = el.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, form, input, button, [hidden]').forEach(function(n) { n.remove(); });

    // 图片收集（复用同样的过滤逻辑）
    var images = [];
    var adDomains = /doubleclick|googlesyndication|amazon-adsystem|googleadservices|adservice|adnxs|moatads|criteo|outbrain|taboola/i;

    clone.querySelectorAll('img').forEach(function(img, idx) {
      var src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') ||
                img.getAttribute('data-lazy-src') || '';
      if (src) src = src.split(',')[0].trim().split(' ')[0];
      if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return;
      try { src = new URL(src, location.href).href; } catch(e) {}
      if (adDomains.test(src)) return;

      var w = parseInt(img.getAttribute('width') || img.naturalWidth || '0', 10);
      var h = parseInt(img.getAttribute('height') || img.naturalHeight || '0', 10);
      var alt = (img.getAttribute('alt') || '').trim();

      var cls = (img.className || '') + ' ' + (img.id || '') + ' ' + alt;
      if (/icon|avatar|logo|sprite|emoji|badge|qrcode|advert|loading/i.test(cls)) return;

      var aspectRatio = (w > 0 && h > 0) ? w / h : 1;
      var isContent = true;
      if (w > 0 && h > 0) {
        if (w < 100 || h < 60) isContent = false;
        if (w <= 2 && h <= 2) isContent = false;
      }

      images.push({
        url: src, alt: alt, width: w, height: h,
        aspectRatio: Math.round(aspectRatio * 100) / 100,
        caption: '', position: idx, isLikelyContent: isContent,
      });
    });

    var seen = {};
    var uniqueImgs = [];
    for (var i = 0; i < images.length; i++) {
      if (!seen[images[i].url]) { seen[images[i].url] = true; uniqueImgs.push(images[i]); }
    }
    uniqueImgs.sort(function(a, b) {
      if (a.isLikelyContent !== b.isLikelyContent) return a.isLikelyContent ? -1 : 1;
      return (b.width * b.height) - (a.width * a.height);
    });

    var textContent = cleanText(clone.textContent || '');
    var title = (document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                 document.querySelector('h1')?.textContent || document.title || '').trim();
    var siteName = (document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
                    location.hostname.replace(/^www\\./, '')).trim();

    return {
      title: title,
      content: clone.innerHTML || '',
      textContent: textContent,
      excerpt: textContent.slice(0, 200),
      byline: '',
      length: textContent.length,
      siteName: siteName,
      pageUrl: location.href,
      images: uniqueImgs.slice(0, 30),
    };
  } catch(e) {
    return { error: e.message };
  }
})()
`;
}

// ========== 构建元素选择器脚本 ==========

function buildSelectorScript(): string {
  return `
(function() {
  if (window.__flowx_selector_active) return;
  window.__flowx_selector_active = true;

  // 创建高亮遮罩
  var overlay = document.createElement('div');
  overlay.id = '__flowx_selector_overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:rgba(37,99,235,0.15);border:2px solid #2563eb;border-radius:2px;transition:all 0.1s ease;box-shadow:0 0 0 1px rgba(255,255,255,0.5);';
  document.body.appendChild(overlay);

  // 创建信息提示
  var info = document.createElement('div');
  info.id = '__flowx_selector_info';
  info.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0f172a;color:#fff;padding:10px 20px;border-radius:8px;font-family:-apple-system,sans-serif;font-size:13px;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  info.textContent = '点击选择元素提取内容 | ESC 取消 | ↑↓ 切换层级';
  document.body.appendChild(info);

  var currentEl = null;

  function updateOverlay(el) {
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      info.textContent = '点击选择元素提取内容 | ESC 取消 | ↑↓ 切换层级';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    var textPreview = ((el.textContent || '').trim().slice(0, 60)).replace(/\\n/g, ' ');
    info.textContent = tag + id + cls + ' — "' + textPreview + '"  | 点击提取 | ESC 取消 | ↑↓ 切换';
  }

  function onMouseOver(e) {
    if (e.target === overlay || e.target === info) return;
    currentEl = e.target;
    updateOverlay(currentEl);
  }

  function onClick(e) {
    if (e.target === overlay || e.target === info) return;
    e.preventDefault();
    e.stopPropagation();
    if (currentEl) {
      // 获取元素选择器
      function getSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        var path = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          var sel = cur.tagName.toLowerCase();
          if (cur.className && typeof cur.className === 'string') {
            var classes = cur.className.trim().split(/\\s+/).filter(function(c) { return c; });
            if (classes.length > 0) sel += '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
          }
          var parent = cur.parentElement;
          if (parent) {
            var siblings = Array.from(parent.children).filter(function(s) { return s.tagName === cur.tagName; });
            if (siblings.length > 1) {
              sel += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
            }
          }
          path.unshift(sel);
          cur = cur.parentElement;
        }
        return path.join(' > ');
      }

      var selector = getSelector(currentEl);
      cleanup();

      // 通过 console.log 通知主进程（无 preload 时的通信方式）
      console.log('__FLOX_SELECT__:' + JSON.stringify({ selector: selector }));
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      console.log('__FLOX_SELECT_CANCEL__');
      document.dispatchEvent(new CustomEvent('flowx:selector-cancelled'));
    } else if (e.key === 'ArrowUp' && currentEl && currentEl.parentElement && currentEl.parentElement !== document.body) {
      e.preventDefault();
      currentEl = currentEl.parentElement;
      updateOverlay(currentEl);
    } else if (e.key === 'ArrowDown' && currentEl && currentEl.firstElementChild) {
      e.preventDefault();
      // 向下找到第一个可见的子元素
      var children = currentEl.children;
      for (var i = 0; i < children.length; i++) {
        if (children[i].offsetParent) {
          currentEl = children[i];
          updateOverlay(currentEl);
          break;
        }
      }
    } else if (e.key === 'Enter' && currentEl) {
      e.preventDefault();
      onClick({ target: currentEl, preventDefault: function(){}, stopPropagation: function(){} });
    }
  }

  function cleanup() {
    window.__flowx_selector_active = false;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (info.parentNode) info.parentNode.removeChild(info);
    delete window.__flowx_selector_cleanup;
  }

  window.__flowx_selector_cleanup = cleanup;

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  // 改变鼠标样式
  document.body.style.cursor = 'crosshair';
  var origCursor = document.body.style.cursor;

  var origCleanup = cleanup;
  window.__flowx_selector_cleanup = function() {
    origCleanup();
    document.body.style.cursor = origCursor || '';
  };
})()
`;
}
