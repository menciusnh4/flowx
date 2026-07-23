import { getStore } from '../store/SecureStore';
import { logger } from '../utils/logger';
import type { CustomSiteRule, PublishContentType, RuleTestResult, PagedResult, RuleQueryFilter } from '../../types';

/**
 * 站点规则管理器
 * - 管理内置规则和自定义规则
 * - 自定义规则优先级高于内置规则
 * - 支持增删改查、匹配测试
 */
class SiteRuleManager {
  private customRules: CustomSiteRule[] = [];
  private initialized = false;

  /** 初始化：从存储加载自定义规则 */
  init(): void {
    if (this.initialized) return;
    try {
      const store = getStore();
      const rules = store.get('customSiteRules') as CustomSiteRule[] | undefined;
      this.customRules = rules || [];
      this.initialized = true;
      logger.info(`[SiteRuleManager] 已加载 ${this.customRules.length} 条自定义规则`);
    } catch (e) {
      logger.error('[SiteRuleManager] 加载自定义规则失败:', e);
      this.customRules = [];
      this.initialized = true;
    }
  }

  // ========== 查询 ==========

  /** 获取所有自定义规则 */
  getCustomRules(): CustomSiteRule[] {
    this.ensureInit();
    return [...this.customRules].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 服务端分页查询自定义规则（预留 keyword/matchType/enabled/contentTypes 筛选） */
  queryRules(
    filter: RuleQueryFilter = {},
    page = 1,
    pageSize = 10,
  ): PagedResult<CustomSiteRule> {
    this.ensureInit();
    let list = [...this.customRules].sort((a, b) => b.updatedAt - a.updatedAt);
    const q = (filter.keyword || '').trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.matchValue.toLowerCase().includes(q),
      );
    }
    if (filter.matchType) {
      list = list.filter((r) => r.matchType === filter.matchType);
    }
    if (typeof filter.enabled === 'boolean') {
      list = list.filter((r) => r.enabled === filter.enabled);
    }
    if (filter.contentTypes && filter.contentTypes.length > 0) {
      const want = new Set(filter.contentTypes);
      list = list.filter(
        (r) => r.contentTypes.length === 0 || r.contentTypes.some((t) => want.has(t)),
      );
    }
    const total = list.length;
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 10));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const start = (safePage - 1) * safeSize;
    return {
      items: list.slice(start, start + safeSize),
      total,
      page: safePage,
      pageSize: safeSize,
      totalPages,
    };
  }

  /** 获取启用的自定义规则 */
  getEnabledCustomRules(): CustomSiteRule[] {
    return this.getCustomRules().filter(r => r.enabled);
  }

  /** 根据 ID 获取规则 */
  getRuleById(id: string): CustomSiteRule | null {
    this.ensureInit();
    return this.customRules.find(r => r.id === id) || null;
  }

  /**
   * 根据 URL 查找匹配的自定义规则
   * 优先级：域名匹配 + 路径匹配 > 仅域名匹配 > 正则匹配
   */
  findMatchingRule(url: string, contentType?: PublishContentType): CustomSiteRule | null {
    this.ensureInit();
    const enabled = this.customRules.filter(r => r.enabled);

    // 按匹配质量排序：类型匹配 > 域名匹配 > 路径匹配
    const matched = enabled
      .map(rule => ({ rule, score: this.calculateMatchScore(rule, url, contentType) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (matched.length > 0) {
      logger.info(`[SiteRuleManager] 匹配到自定义规则: ${matched[0].rule.name} (score: ${matched[0].score})`);
      return matched[0].rule;
    }
    return null;
  }

  /** 计算规则的匹配分数（0 表示不匹配） */
  private calculateMatchScore(
    rule: CustomSiteRule,
    url: string,
    contentType?: PublishContentType,
  ): number {
    let score = 0;

    // 域名/正则匹配
    if (rule.matchType === 'domain') {
      try {
        const hostname = new URL(url).hostname;
        if (hostname.includes(rule.matchValue)) {
          score += 100;
          // 更精确的匹配（完全相等 > 子域名）
          if (hostname === rule.matchValue || hostname === 'www.' + rule.matchValue) {
            score += 50;
          }
        } else {
          return 0;
        }
      } catch {
        return 0;
      }
    } else if (rule.matchType === 'regex') {
      try {
        const regex = new RegExp(rule.matchValue, 'i');
        if (!regex.test(url)) return 0;
        score += 80;
      } catch {
        return 0;
      }
    }

    // 路径匹配
    if (rule.pathPattern) {
      try {
        const pathname = new URL(url).pathname;
        const pathRegex = new RegExp(rule.pathPattern, 'i');
        if (pathRegex.test(pathname)) {
          score += 30;
        } else {
          // 有路径模式但不匹配，降低优先级
          score -= 50;
        }
      } catch {
        // 路径模式无效，忽略
      }
    }

    // 发布类型匹配
    if (contentType && rule.contentTypes.length > 0) {
      if (rule.contentTypes.includes(contentType)) {
        score += 20;
      } else {
        score -= 10;
      }
    }

    // 使用次数加权（常用的优先）
    score += Math.min(rule.useCount, 10);

    return score;
  }

  /** 获取匹配当前 URL 的所有规则（用于右键菜单排序） */
  getRulesForContextMenu(url: string, contentType?: PublishContentType): {
    siteMatchTypeMatch: CustomSiteRule[];
    siteMatchOnly: CustomSiteRule[];
    typeMatchOnly: CustomSiteRule[];
    others: CustomSiteRule[];
  } {
    this.ensureInit();
    const enabled = this.customRules.filter(r => r.enabled);

    const siteMatchTypeMatch: CustomSiteRule[] = [];
    const siteMatchOnly: CustomSiteRule[] = [];
    const typeMatchOnly: CustomSiteRule[] = [];
    const others: CustomSiteRule[] = [];

    for (const rule of enabled) {
      const matchesSite = this.matchesDomain(rule, url);
      const matchesType = rule.contentTypes.length === 0
        || (contentType !== undefined && rule.contentTypes.includes(contentType));

      if (matchesSite && matchesType) {
        siteMatchTypeMatch.push(rule);
      } else if (matchesSite) {
        siteMatchOnly.push(rule);
      } else if (matchesType && contentType) {
        typeMatchOnly.push(rule);
      } else {
        others.push(rule);
      }
    }

    // 按使用次数排序
    const sortByUsage = (a: CustomSiteRule, b: CustomSiteRule) =>
      (b.useCount || 0) - (a.useCount || 0);

    siteMatchTypeMatch.sort(sortByUsage);
    siteMatchOnly.sort(sortByUsage);
    typeMatchOnly.sort(sortByUsage);
    others.sort(sortByUsage);

    return { siteMatchTypeMatch, siteMatchOnly, typeMatchOnly, others };
  }

  private matchesDomain(rule: CustomSiteRule, url: string): boolean {
    try {
      if (rule.matchType === 'domain') {
        const hostname = new URL(url).hostname;
        return hostname.includes(rule.matchValue);
      } else if (rule.matchType === 'regex') {
        const regex = new RegExp(rule.matchValue, 'i');
        return regex.test(url);
      }
    } catch { /* ignore */ }
    return false;
  }

  // ========== 增删改 ==========

  /** 创建规则 */
  createRule(data: Omit<CustomSiteRule, 'id' | 'createdAt' | 'updatedAt' | 'useCount' | 'source'> & { source?: CustomSiteRule['source'] }): CustomSiteRule {
    this.ensureInit();
    const now = Date.now();
    const rule: CustomSiteRule = {
      ...data,
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      source: data.source || 'manual',
    };
    this.customRules.push(rule);
    this.save();
    logger.info(`[SiteRuleManager] 创建规则: ${rule.name} (${rule.id})`);
    return rule;
  }

  /** 更新规则 */
  updateRule(id: string, patch: Partial<CustomSiteRule>): CustomSiteRule | null {
    this.ensureInit();
    const idx = this.customRules.findIndex(r => r.id === id);
    if (idx === -1) return null;

    const updated: CustomSiteRule = {
      ...this.customRules[idx],
      ...patch,
      id, // 确保 ID 不变
      updatedAt: Date.now(),
    };
    this.customRules[idx] = updated;
    this.save();
    logger.info(`[SiteRuleManager] 更新规则: ${updated.name} (${id})`);
    return updated;
  }

  /** 删除规则 */
  deleteRule(id: string): boolean {
    this.ensureInit();
    const idx = this.customRules.findIndex(r => r.id === id);
    if (idx === -1) return false;

    const name = this.customRules[idx].name;
    this.customRules.splice(idx, 1);
    this.save();
    logger.info(`[SiteRuleManager] 删除规则: ${name} (${id})`);
    return true;
  }

  /** 切换规则启用状态 */
  toggleRule(id: string): boolean {
    const rule = this.getRuleById(id);
    if (!rule) return false;
    this.updateRule(id, { enabled: !rule.enabled });
    return true;
  }

  /** 记录使用次数 */
  incrementUsage(id: string): void {
    const rule = this.getRuleById(id);
    if (!rule) return;
    const idx = this.customRules.findIndex(r => r.id === id);
    if (idx !== -1) {
      this.customRules[idx].useCount += 1;
      this.customRules[idx].lastUsedAt = Date.now();
      this.save();
    }
  }

  // ========== 导入导出 ==========

  /** 导出所有自定义规则 */
  exportRules(): CustomSiteRule[] {
    return this.getCustomRules();
  }

  /** 导入规则（合并，ID 冲突时重命名） */
  importRules(rules: CustomSiteRule[], mode: 'merge' | 'replace' = 'merge'): number {
    this.ensureInit();
    let count = 0;

    if (mode === 'replace') {
      this.customRules = rules.map(r => ({
        ...r,
        id: this.generateId(),
        updatedAt: Date.now(),
      }));
      count = rules.length;
    } else {
      for (const rule of rules) {
        // 检查是否已存在同名同域名的规则
        const exists = this.customRules.some(
          r => r.name === rule.name && r.matchValue === rule.matchValue,
        );
        if (exists) continue;

        this.customRules.push({
          ...rule,
          id: this.generateId(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          useCount: 0,
          source: 'import',
        });
        count++;
      }
    }

    this.save();
    logger.info(`[SiteRuleManager] 导入规则: ${count} 条 (mode: ${mode})`);
    return count;
  }

  // ========== 内部方法 ==========

  private ensureInit(): void {
    if (!this.initialized) {
      this.init();
    }
  }

  private generateId(): string {
    return 'rule_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  private save(): void {
    try {
      const store = getStore();
      store.set('customSiteRules', this.customRules);
    } catch (e) {
      logger.error('[SiteRuleManager] 保存规则失败:', e);
    }
  }
}

// 单例
export const siteRuleManager = new SiteRuleManager();
