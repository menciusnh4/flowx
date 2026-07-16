// 发布合规预检 composable（渲染端）
// 监听表单字段 → 300ms 防抖 → 调主进程 compliance:scan（单一真理源）→ 暴露 result/badges。
// 仅提示：扫描失败 fail-open（不展示提示，不影响发布）。
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { electronApi } from '../utils/electron';
import type {
  ComplianceResult,
  ComplianceLevel,
  ComplianceMatch,
  ComplianceScanRequest,
} from '../../types/compliance';

export interface ComplianceFieldSource {
  title: string;
  content: string;
  tags: string[];
  summary: string;
}

const EMPTY: ComplianceResult = { level: 'none', hasHigh: false, hasAny: false, matches: [], scannedAt: 0 };
const LV_RANK: Record<ComplianceLevel | 'none', number> = { none: 0, low: 1, mid: 2, high: 3 };

export function useCompliance(opts: {
  fields: () => ComplianceFieldSource;
  platforms: () => string[];
  enabled: () => boolean;
}) {
  const result = ref<ComplianceResult>(EMPTY);
  const scanning = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    if (!opts.enabled()) {
      result.value = EMPTY;
      return;
    }
    const plats = opts.platforms();
    if (plats.length === 0) {
      result.value = EMPTY;
      return;
    }
    const fields = opts.fields();
    scanning.value = true;
    try {
      // 逐平台扫描后合并（P0 仅 douyin/xhs；去重由主进程词库保证）
      const merged: ComplianceMatch[] = [];
      let top: ComplianceResult['level'] = 'none';
      for (const p of plats) {
        const req: ComplianceScanRequest = { platform: p, fields };
        const r = await electronApi.compliance.scan(req);
        for (const m of r.matches) merged.push(m);
        if (LV_RANK[r.level] > LV_RANK[top]) top = r.level;
      }
      result.value = {
        level: top,
        hasHigh: top === 'high',
        hasAny: merged.length > 0,
        matches: merged,
        scannedAt: Date.now(),
      };
    } catch {
      result.value = EMPTY; // fail-open：扫描异常不阻断、不提示
    } finally {
      scanning.value = false;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, 300);
  }

  const stop = watch(
    () => [
      opts.fields().title,
      opts.fields().content,
      opts.fields().tags.join(' '),
      opts.fields().summary,
      opts.platforms().join(','),
      opts.enabled(),
    ],
    () => schedule(),
    { deep: true },
  );

  onMounted(() => void run());
  onUnmounted(() => {
    if (timer) clearTimeout(timer);
    stop();
  });

  /** 按字段聚合的角标（最高等级 + 命中数） */
  const badges = computed<Record<string, { level: ComplianceLevel; count: number }>>(() => {
    const map: Record<string, { level: ComplianceLevel; count: number }> = {};
    for (const m of result.value.matches) {
      const cur = map[m.field];
      if (!cur) {
        map[m.field] = { level: m.level, count: 1 };
      } else {
        cur.count += 1;
        if (LV_RANK[m.level] > LV_RANK[cur.level]) cur.level = m.level;
      }
    }
    return map;
  });

  function fieldMatches(field: string): ComplianceMatch[] {
    return result.value.matches.filter((m) => m.field === field);
  }

  return { result, scanning, badges, fieldMatches, run };
}
