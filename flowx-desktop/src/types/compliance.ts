// 发布合规预检（P0）类型定义
// 范围：文本违禁词扫描（抖音 + 小红书，纯本地，仅提示不拦截）

/** 命中等级：高危 / 中危 / 低危 */
export type ComplianceLevel = 'high' | 'mid' | 'low';

/** 单条命中（扫描返回的最小单元） */
export interface ComplianceMatch {
  /** 命中的违禁词 */
  term: string;
  /** 分级 */
  level: ComplianceLevel;
  /** 来源字段 */
  field: 'title' | 'content' | 'tags' | 'summary';
  /** 字符起索引（用于定位 / 高亮） */
  start: number;
  /** 字符止索引（不含） */
  end: number;
  /** 命中来自哪个平台词库（common / douyin / xiaohongshu） */
  platform: string;
  /** 建议替换（P2 对象形态提供，P0 可选） */
  suggestion?: string;
}

/** 扫描结果（聚合） */
export interface ComplianceResult {
  /** 取命中最高等级；无命中为 'none' */
  level: ComplianceLevel | 'none';
  /** 是否含高危（仅用于提示样式，不用于阻断） */
  hasHigh: boolean;
  /** 是否有任意命中 */
  hasAny: boolean;
  /** 全部命中明细 */
  matches: ComplianceMatch[];
  /** 扫描时间戳 */
  scannedAt: number;
}

/** 扫描入参（直接复用 PublishRequest 字段，零新增数据通路） */
export interface ComplianceScanRequest {
  /** PlatformType（= string） */
  platform: string;
  fields: {
    title: string;
    content?: string;
    tags?: string[];
    summary?: string;
  };
}

/** 持久化设置 */
export interface ComplianceSettings {
  /** 是否开启合规提示；默认 true；关闭 = fail-open */
  promptEnabled: boolean;
}

/** 词库 JSON 单文件结构（P0：字符串数组；P2 升级为对象数组） */
export interface ComplianceWordFile {
  high: string[];
  mid: string[];
  low: string[];
}

/** 平台词库文件标识 */
export type ComplianceDictionaryFile = 'common' | 'douyin' | 'xiaohongshu';
