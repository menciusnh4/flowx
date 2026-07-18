// 词库加载 + 合并 + 构建 trie（带缓存）
// 词库 JSON 为多 schema，运行时由 normalize() 统一归一化为 RawTerm[]（含 suggestion 替换建议）。
// 合并规则：common 全量 + 平台文件；平台词后插入覆盖 common 同名词。
// 未知平台：仅扫 common（不报错、不阻断）。

import common from '../../resources/compliance/common.json';
import douyin from '../../resources/compliance/douyin.json';
import xiaohongshu from '../../resources/compliance/xiaohongshu.json';
import zhihu from '../../resources/compliance/zhihu.json';
import kuaishou from '../../resources/compliance/kuaishou.json';
import wechatOfficial from '../../resources/compliance/wechat_official.json';
import type { ComplianceDictionaryFile, ComplianceLevel } from '../../../types/compliance';
import { buildTrie, type ACNode, type RawTerm } from './matcher';

/** 词库原始 JSON（多 schema，归一化前不做强类型约束） */
type RawDict = any;

const FILES: Record<ComplianceDictionaryFile, RawDict> = {
  common,
  douyin,
  xiaohongshu,
  zhihu,
  kuaishou,
  wechat_official: wechatOfficial,
};

/** 参与「common + 平台」合并的平台词库（common 始终全量） */
const KNOWN_PLATFORMS: ComplianceDictionaryFile[] = [
  'douyin',
  'xiaohongshu',
  'kuaishou',
  'wechat_official',
  'zhihu',
];

// ============ 等级映射 ============
/** 中文等级（高/中/低）→ ComplianceLevel */
function cnLevel(s: string | undefined): ComplianceLevel | null {
  if (!s) return null;
  if (s.includes('高')) return 'high';
  if (s.includes('中')) return 'mid';
  if (s.includes('低')) return 'low';
  return null;
}

/** emoji 等级（🔴 绝对违禁 / 🟡 高风险 / 🟢 敏感）→ ComplianceLevel */
function emojiLevel(s: string | undefined): ComplianceLevel {
  if (!s) return 'mid';
  if (s.includes('绝对违禁') || s.includes('高风险')) return 'high';
  if (s.includes('敏感')) return 'low';
  return 'mid';
}

/** 抖音/小红书 富格式无逐词等级，按分类名兜底（刷量造假更重） */
function douyinCatLevel(cat: string): ComplianceLevel {
  if (cat.includes('刷量造假')) return 'high';
  return 'mid';
}

/**
 * 归一化任意 schema 的原始词库为 RawTerm[]。
 * 支持的 schema：
 *  - rich（words_by_category）：抖音/小红书，词 = {w, r}；等级按分类名兜底
 *  - rich-subcat（categories[cat].sub_categories[sub][] = {w, r}）：通用，等级按 category.risk_level
 *  - simple（categories[].words[] = {word, risk_level}）：知乎/快手/公众号，等级逐词
 *  - legacy（{high, mid, low} 字符串数组）：向后兼容旧格式
 * suggestion 仅在 rich / rich-subcat 中存在；simple / legacy 无替换建议（UI 优雅降级不展示）。
 */
function normalize(raw: RawDict, platform: ComplianceDictionaryFile): RawTerm[] {
  const out: RawTerm[] = [];
  if (!raw) return out;

  // 1) rich：words_by_category（抖音 / 小红书）
  if (raw.words_by_category && typeof raw.words_by_category === 'object' && !Array.isArray(raw.words_by_category)) {
    for (const cat of Object.keys(raw.words_by_category)) {
      const level = douyinCatLevel(cat);
      for (const w of raw.words_by_category[cat] || []) {
        if (w && w.w) out.push({ term: w.w, level, platform, suggestion: w.r || undefined, category: cat });
      }
    }
    return out;
  }

  // 2) rich-subcat：categories[cat].sub_categories（通用违禁词库）
  if (raw.categories && typeof raw.categories === 'object' && !Array.isArray(raw.categories)) {
    for (const catKey of Object.keys(raw.categories)) {
      const cat = raw.categories[catKey];
      const level = emojiLevel(cat?.risk_level);
      const catName = cat?.category_name || catKey;
      const subs = cat?.sub_categories || {};
      for (const subKey of Object.keys(subs)) {
        const arr = subs[subKey];
        if (!Array.isArray(arr)) continue;
        for (const w of arr) {
          if (w && w.w) out.push({ term: w.w, level, platform, suggestion: w.r || undefined, category: catName });
        }
      }
    }
    return out;
  }

  // 3) simple：categories[]（知乎 / 快手 / 公众号 / 抖音 / 小红书，统一后同结构）
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      for (const w of c?.words || []) {
        if (!w || !w.word) continue;
        const lv = cnLevel(w.risk_level) || 'mid';
        out.push({
          term: w.word,
          level: lv,
          platform,
          category: c?.category || undefined,
          suggestion: w.suggestion || undefined, // 抖音/小红书统一后带替换建议，知乎/快手/公众号无则留空
        });
      }
    }
    return out;
  }

  // 4) legacy：{high, mid, low} 字符串数组（向后兼容）
  if (Array.isArray(raw.high)) {
    for (const lv of ['high', 'mid', 'low'] as ComplianceLevel[]) {
      for (const term of raw[lv] || []) {
        if (term) out.push({ term, level: lv, platform });
      }
    }
    return out;
  }

  return out;
}

const cache = new Map<string, ACNode>();

export const dictionary = {
  /** 取某平台的合并 trie（common + 平台；带缓存） */
  get(platform: string): ACNode {
    const cached = cache.get(platform);
    if (cached) return cached;

    const terms: RawTerm[] = normalize(FILES.common, 'common');
    if ((KNOWN_PLATFORMS as string[]).includes(platform)) {
      terms.push(...normalize(FILES[platform as ComplianceDictionaryFile], platform as ComplianceDictionaryFile));
    }
    const trie = buildTrie(terms);
    cache.set(platform, trie);
    return trie;
  },

  /** 预热已知平台 trie（在 IPC 注册时调用一次） */
  warmup(): Promise<void> {
    for (const p of KNOWN_PLATFORMS) this.get(p);
    this.get('common');
    return Promise.resolve();
  },

  /** 清空缓存（测试 / P2 热更后调用） */
  reset(): void {
    cache.clear();
  },

  /**
   * P2 热更预留：从 extraResources 读取外部词库 JSON 覆盖。
   * P0 不接调用。
   */
  async loadFromExtraResources(_path?: string): Promise<void> {
    // TODO(P2): 读取外部词库并 rebuild cache
  },
};
