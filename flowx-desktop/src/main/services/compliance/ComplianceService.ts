// 发布合规预检服务（主进程唯一权威）
// 职责：scanText 扫描字段命中；getSettings/setSettings 持久化提示开关。
// 仅提示，不阻断；异常由调用方（PublishEngine / IPC）包成 fail-open。

import { dictionary } from './dictionary';
import { search } from './matcher';
import { getStore } from '../../store/SecureStore';
import type {
  ComplianceResult,
  ComplianceScanRequest,
  ComplianceSettings,
  ComplianceMatch,
  ComplianceLevel,
} from '../../../types/compliance';

const DEFAULT_SETTINGS: ComplianceSettings = { promptEnabled: true };

const LEVEL_ORDER: Record<ComplianceLevel | 'none', number> = {
  none: 0,
  low: 1,
  mid: 2,
  high: 3,
};

export const ComplianceService = {
  /** 扫描单平台多字段，返回聚合结果 */
  scanText(platform: string, fields: ComplianceScanRequest['fields']): ComplianceResult {
    const trie = dictionary.get(platform); // common + 平台合并（带缓存）
    const matches: ComplianceMatch[] = [];

    const fieldList: Array<[ComplianceMatch['field'], string]> = [
      ['title', fields.title ?? ''],
      ['content', fields.content ?? ''],
      ['summary', fields.summary ?? ''],
      ['tags', (fields.tags ?? []).join(' ')], // 话题数组 join 后扫描
    ];

    for (const [field, text] of fieldList) {
      if (!text) continue; // 空字段跳过，不误提示
      for (const hit of search(trie, text)) {
        matches.push({ ...hit, field });
      }
    }

    const top = matches.reduce<ComplianceLevel | 'none'>(
      (acc, m) => (LEVEL_ORDER[m.level] > LEVEL_ORDER[acc] ? m.level : acc),
      'none',
    );

    return {
      level: top,
      hasHigh: top === 'high',
      hasAny: matches.length > 0,
      matches,
      scannedAt: Date.now(),
    };
  },

  getSettings(): ComplianceSettings {
    const stored = getStore().get('compliance');
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  },

  setSettings(patch: Partial<ComplianceSettings>): ComplianceSettings {
    const next: ComplianceSettings = { ...this.getSettings(), ...patch };
    getStore().set('compliance', next);
    return next;
  },
};
