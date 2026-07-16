// 词库加载 + 合并 + 构建 trie（带缓存）
// P0：Vite 静态 import 三个 JSON（构建期打包，不联网）。
// 合并规则：common 全量 + 平台文件；平台词后插入覆盖 common 同名词。
// 未知平台：仅扫 common（不报错、不阻断）。

import common from '../../resources/compliance/common.json';
import douyin from '../../resources/compliance/douyin.json';
import xiaohongshu from '../../resources/compliance/xiaohongshu.json';
import type { ComplianceWordFile, ComplianceDictionaryFile, ComplianceLevel } from '../../../types/compliance';
import { buildTrie, type ACNode, type RawTerm } from './matcher';

const FILES: Record<ComplianceDictionaryFile, ComplianceWordFile> = {
  common: common as ComplianceWordFile,
  douyin: douyin as ComplianceWordFile,
  xiaohongshu: xiaohongshu as ComplianceWordFile,
};

const LEVELS: ComplianceLevel[] = ['high', 'mid', 'low'];
const KNOWN_PLATFORMS: ComplianceDictionaryFile[] = ['douyin', 'xiaohongshu'];

function toTerms(file: ComplianceWordFile, platform: string): RawTerm[] {
  const out: RawTerm[] = [];
  for (const lv of LEVELS) {
    for (const term of file[lv]) {
      if (term) out.push({ term, level: lv, platform });
    }
  }
  return out;
}

const cache = new Map<string, ACNode>();

export const dictionary = {
  /** 取某平台的合并 trie（common + 平台；带缓存） */
  get(platform: string): ACNode {
    const cached = cache.get(platform);
    if (cached) return cached;

    const terms: RawTerm[] = toTerms(FILES.common, 'common');
    if ((KNOWN_PLATFORMS as string[]).includes(platform)) {
      terms.push(...toTerms(FILES[platform as ComplianceDictionaryFile], platform));
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
