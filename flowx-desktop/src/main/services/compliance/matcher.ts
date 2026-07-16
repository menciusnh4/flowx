// Aho-Corasick 多模式匹配（零依赖自实现）
// 用于文本违禁词扫描：中文无词边界 = 子串匹配，trie 一次扫描全部命中。
// 英文统一 toLowerCase；重叠词通过 failure link 回退保证不漏。

import type { ComplianceLevel } from '../../../types/compliance';

export interface ACNode {
  children: Map<string, ACNode>;
  fail: ACNode | null;
  /** 末节点命中的词（非末节点为 null） */
  term: string | null;
  level: ComplianceLevel | null;
  /** 来源词库（common / douyin / xiaohongshu），用于平台标注 */
  platform: string | null;
}

/** 构建 trie 的原始词条 */
export interface RawTerm {
  term: string;
  level: ComplianceLevel;
  platform: string;
}

/** 单条扫描命中（未回填 field，由 caller 补全） */
export interface ScanHit {
  term: string;
  level: ComplianceLevel;
  platform: string;
  start: number;
  end: number;
}

/**
 * 构建 Aho-Corasick trie。
 * 平台词后插入可覆盖 common 同名词（末节点 field 取最后写入）。
 */
export function buildTrie(terms: RawTerm[]): ACNode {
  const root: ACNode = { children: new Map(), fail: null, term: null, level: null, platform: null };

  for (const { term, level, platform } of terms) {
    if (!term) continue;
    let cur = root;
    for (const ch of term.toLowerCase()) {
      if (!cur.children.has(ch)) {
        cur.children.set(ch, { children: new Map(), fail: null, term: null, level: null, platform: null });
      }
      cur = cur.children.get(ch)!;
    }
    // 末节点记录词 + 等级 + 平台（后写覆盖先写）
    cur.term = term;
    cur.level = level;
    cur.platform = platform;
  }

  // BFS 建立 failure links（标准 AC 算法）
  const queue: ACNode[] = [];
  for (const child of root.children.values()) {
    child.fail = root;
    queue.push(child);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [ch, child] of cur.children) {
      let f = cur.fail;
      while (f && !f.children.has(ch)) f = f.fail;
      child.fail = f ? (f.children.get(ch) ?? root) : root;
      queue.push(child);
    }
  }

  return root;
}

/**
 * 在 text 上扫描所有命中。
 * 时间复杂度 O(|text| + 命中数 × 平均回退深度)。
 */
export function search(root: ACNode, text: string): ScanHit[] {
  const hits: ScanHit[] = [];
  if (!text) return hits;
  let cur = root;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    while (cur !== root && !cur.children.has(ch)) cur = cur.fail!;
    if (cur.children.has(ch)) cur = cur.children.get(ch)!;
    // 沿 failure 链收集所有以当前位置结尾的词（重叠词不漏）
    let node: ACNode | null = cur;
    while (node && node.term) {
      const term = node.term;
      hits.push({
        term,
        level: node.level!,
        platform: node.platform!,
        start: i - term.length + 1,
        end: i + 1,
      });
      node = node.fail;
    }
  }
  return hits;
}
