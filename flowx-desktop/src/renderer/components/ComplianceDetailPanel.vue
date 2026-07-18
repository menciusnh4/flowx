<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ComplianceResult, ComplianceLevel } from '../../types/compliance';

const props = defineProps<{
  result: ComplianceResult;
  enabled?: boolean;
  scanning?: boolean;
  platformLabel?: string;
}>();
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'locate', field: string, start: number, end: number): void }>();

const enabled = computed(() => props.enabled ?? true);
const internalOpen = ref(false);
// 注意：Vue 会把未传入的 boolean prop 强转为 false（而非 undefined），
// 因此不能靠 `props.open === undefined` 判断受控/非受控。组件始终自管理展开态。
const isOpen = computed(() => internalOpen.value);

const highCount = computed(() => props.result.matches.filter((m) => m.level === 'high').length);
const midCount = computed(() => props.result.matches.filter((m) => m.level === 'mid').length);
const lowCount = computed(() => props.result.matches.filter((m) => m.level === 'low').length);
const hasHits = computed(() => props.result.matches.length > 0);

// 五态：off / scanning / block / warn / safe
const state = computed<'off' | 'scanning' | 'block' | 'warn' | 'safe'>(() => {
  if (!enabled.value) return 'off';
  if (props.scanning) return 'scanning';
  if (highCount.value > 0) return 'block';
  if (hasHits.value) return 'warn';
  return 'safe';
});

const platLabel = computed(() => props.platformLabel || '未选择账号');

const icon = computed(
  () =>
    ({ off: '🔕', scanning: '🔍', block: '🔴', warn: '⚠️', safe: '✅' } as Record<string, string>)[
      state.value
    ],
);
const text = computed(() => {
  switch (state.value) {
    case 'off':
      return '合规提示已关闭（fail-open）';
    case 'scanning':
      return '正在扫描…';
    case 'block':
      return `发现 ${highCount.value} 处高危违禁词，请重点关注（仍可发布）`;
    case 'warn':
      return `发现 ${midCount.value} 处中危、${lowCount.value} 处低危提示`;
    default:
      return '合规预检通过，未发现风险词';
  }
});
const sub = computed(() => {
  switch (state.value) {
    case 'off':
      return `${platLabel.value} · 关闭后不再扫描与提示`;
    case 'scanning':
      return `${platLabel.value} · 正在本地扫描`;
    case 'block':
      return `${platLabel.value} · 中危 ${midCount.value} · 低危 ${lowCount.value}（提示模式，不阻断）`;
    case 'warn':
      return `${platLabel.value} · 建议修改后再发布`;
    default:
      return `${platLabel.value} · 可安全发布`;
  }
});

function onToggle() {
  internalOpen.value = !internalOpen.value;
  emit('toggle');
}

function lvName(l: ComplianceLevel | 'none'): string {
  return l === 'high' ? '高危' : l === 'mid' ? '中危' : l === 'low' ? '低危' : '合规';
}
function fieldName(f: string): string {
  return ({ title: '标题', content: '正文', tags: '话题', summary: '摘要' } as Record<string, string>)[f] || f;
}
function platformName(p: string): string {
  return (
    {
      common: '通用',
      douyin: '抖音',
      xiaohongshu: '小红书',
      zhihu: '知乎',
      kuaishou: '快手',
      wechat_official: '微信公众号',
    } as Record<string, string>
  )[p] || p;
}
</script>

<template>
  <div class="cdp-wrap">
    <!-- 常驻合规状态条（对齐原型 compliance-prototype.html） -->
    <div class="compliance-bar" :class="state">
      <div class="cb-ic">{{ icon }}</div>
      <div class="cb-txt">
        <div class="cb-main">{{ text }}</div>
        <div class="cb-sub">{{ sub }}</div>
      </div>
      <button
        v-if="enabled && hasHits"
        class="cb-toggle"
        type="button"
        @click="onToggle"
      >
        查看 {{ result.matches.length }} 处提示 {{ isOpen ? '▴' : '▾' }}
      </button>
    </div>

    <!-- 集中式合规明细（默认折叠，受控高度，绝不挤压主表单） -->
    <div v-if="enabled && isOpen" class="compliance-detail">
      <div class="cd-head">
        <span>合规预检明细</span>
        <span class="cd-count">高危 {{ highCount }} · 中危 {{ midCount }} · 低危 {{ lowCount }}</span>
      </div>
      <div class="cd-list">
        <div v-if="!hasHits" class="cd-empty">未发现风险词 ✓</div>
        <div
          v-for="(m, i) in result.matches"
          v-else
          :key="i"
          class="hit"
          :class="m.level"
          @click="emit('locate', m.field, m.start, m.end)"
        >
          <span class="h-lv">{{ lvName(m.level) }}</span>
          <div class="h-body">
            <div class="h-word">
              命中「{{ m.term }}」
              <span class="h-plats">
                <span class="h-plat">{{ platformName(m.platform) }}</span>
                <span v-if="m.category" class="h-cat">{{ m.category }}</span>
              </span>
            </div>
            <div class="h-meta">{{ fieldName(m.field) }}</div>
            <div v-if="m.suggestion" class="h-suggest">替换建议：<b>{{ m.suggestion }}</b></div>
          </div>
          <button class="h-locate" type="button" @click.stop="emit('locate', m.field, m.start, m.end)">定位</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cdp-wrap { margin-bottom: 14px; }

/* 常驻状态条 */
.compliance-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  font-size: 13px;
  font-weight: 700;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.compliance-bar .cb-ic {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}
.compliance-bar .cb-txt { flex: 1; line-height: 1.35; min-width: 0; }
.compliance-bar .cb-sub { font-size: 11.5px; font-weight: 600; opacity: 0.85; margin-top: 1px; }
.cb-toggle {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(15, 23, 42, 0.08);
  color: inherit;
  cursor: pointer;
  transition: all 0.2s;
}
.cb-toggle:hover { background: #fff; }

.compliance-bar.safe { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.25); color: #0f9d6b; }
.compliance-bar.safe .cb-ic { background: rgba(16, 185, 129, 0.15); }
.compliance-bar.warn { background: #fffbeb; border-color: rgba(245, 158, 11, 0.3); color: #b97a09; }
.compliance-bar.warn .cb-ic { background: rgba(245, 158, 11, 0.16); }
.compliance-bar.block { background: #fef2f2; border-color: rgba(244, 63, 94, 0.32); color: #e11d48; }
.compliance-bar.block .cb-ic { background: rgba(244, 63, 94, 0.15); }
.compliance-bar.scanning { background: #eff6ff; border-color: rgba(59, 130, 246, 0.25); color: #2563eb; }
.compliance-bar.scanning .cb-ic { background: rgba(59, 130, 246, 0.15); }
.compliance-bar.off { background: #f1f5f9; border-color: rgba(15, 23, 42, 0.12); color: var(--muted, #64748b); }
.compliance-bar.off .cb-ic { background: rgba(148, 163, 184, 0.16); }

/* 明细面板 */
.compliance-detail {
  margin-top: 6px;
  margin-bottom: 4px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
}
.cd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.05);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--slate, #475569);
  background: #fafbff;
}
.cd-head .cd-count { font-weight: 600; color: var(--muted, #64748b); font-size: 11.5px; }
.cd-list { max-height: 230px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }
.cd-empty { padding: 18px; text-align: center; color: var(--faint, #94a3b8); font-size: 12.5px; }

/* 命中条目 */
.hit {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 12px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-left-width: 3px;
  cursor: pointer;
  transition: background 0.2s;
}
.hit:hover { background: #fafbff; }
.hit.high { border-left-color: #f43f5e; background: #fef7f8; }
.hit.mid { border-left-color: #f59e0b; background: #fffdf5; }
.hit.low { border-left-color: #3b82f6; background: #f7f9ff; }
.h-lv { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 7px; flex-shrink: 0; margin-top: 1px; }
.hit.high .h-lv { background: rgba(244, 63, 94, 0.12); color: #e11d48; }
.hit.mid .h-lv { background: rgba(245, 158, 11, 0.14); color: #b97a09; }
.hit.low .h-lv { background: rgba(39, 130, 246, 0.12); color: #2563eb; }
.h-body { flex: 1; min-width: 0; }
.h-word { font-weight: 800; color: var(--ink, #0f172a); font-size: 13px; }
.h-meta { font-size: 12px; color: var(--slate, #475569); margin-top: 2px; }
.h-suggest { font-size: 12px; color: var(--muted, #64748b); margin-top: 3px; }
.h-suggest b { color: var(--indigo, #6366f1); font-weight: 700; }
.h-plats { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
.h-plat { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 6px; color: #fff; background: #94a3b8; }
.h-cat { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 6px; color: #0f766e; background: rgba(13, 148, 136, 0.12); border: 1px solid rgba(13, 148, 136, 0.25); }
.h-locate {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--indigo, #6366f1);
  padding: 5px 10px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.08);
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}
.h-locate:hover { background: rgba(99, 102, 241, 0.16); }
</style>
