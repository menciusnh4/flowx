<script setup lang="ts">
import { ref } from 'vue';
import type { ComplianceResult, ComplianceLevel } from '../../types/compliance';

const visible = ref(false);
const data = ref<ComplianceResult | null>(null);
let resolver: ((v: boolean) => void) | null = null;

/** 命令式调用：返回 Promise<boolean>，true=仍要发布，false=去修改 */
function show(r: ComplianceResult): Promise<boolean> {
  data.value = r;
  visible.value = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}
function stillPublish() {
  visible.value = false;
  resolver?.(true);
  resolver = null;
}
function goEdit() {
  visible.value = false;
  resolver?.(false);
  resolver = null;
}

function lvName(l: ComplianceLevel): string {
  return l === 'high' ? '高危' : l === 'mid' ? '中危' : '低危';
}
function fieldName(f: string): string {
  return ({ title: '标题', content: '正文', tags: '话题', summary: '摘要' } as Record<string, string>)[f] || f;
}
function platformName(p: string): string {
  return p === 'common' ? '通用' : p === 'douyin' ? '抖音' : p === 'xiaohongshu' ? '小红书' : p;
}

defineExpose({ show });
</script>

<template>
  <div v-if="visible" class="cm-mask">
    <div class="cm-modal">
      <h3 class="cm-title">⚠️ 发布前合规提示</h3>
      <p class="cm-sub">检测到以下内容可能违反平台规范，请确认是否仍要发布（不拦截）：</p>
      <div class="cm-list">
        <div v-for="(m, i) in data?.matches" :key="i" class="cm-hit" :class="m.level">
          <span class="cm-lv">{{ lvName(m.level) }}</span>
          <span class="cm-term">「{{ m.term }}」</span>
          <span class="cm-meta">{{ fieldName(m.field) }} · {{ platformName(m.platform) }}</span>
        </div>
      </div>
      <div class="cm-acts">
        <button class="cm-btn ghost" type="button" @click="goEdit">去修改</button>
        <button class="cm-btn primary" type="button" @click="stillPublish">仍要发布</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(3px);
}
.cm-modal {
  width: 440px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 20px 22px;
  box-shadow: var(--shadow-lg);
}
.cm-title { margin: 0 0 6px; font-size: 16px; font-weight: 700; color: var(--ink); }
.cm-sub { margin: 0 0 12px; font-size: 12.5px; color: var(--muted); }
.cm-list {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  margin-bottom: 14px;
}
.cm-hit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  font-size: 12.5px;
  border-left: 3px solid transparent;
  border-bottom: 1px dashed var(--line);
}
.cm-hit:last-child { border-bottom: none; }
.cm-hit.high { border-left-color: #f43f5e; }
.cm-hit.mid { border-left-color: #f59e0b; }
.cm-hit.low { border-left-color: #3b82f6; }
.cm-lv { font-weight: 700; }
.cm-hit.high .cm-lv { color: #f43f5e; }
.cm-hit.mid .cm-lv { color: #f59e0b; }
.cm-hit.low .cm-lv { color: #3b82f6; }
.cm-term { font-weight: 600; color: var(--ink); }
.cm-meta { margin-left: auto; color: var(--muted); font-size: 11px; }
.cm-acts { display: flex; justify-content: flex-end; gap: 10px; }
.cm-btn {
  border: none;
  border-radius: var(--r-sm);
  padding: 9px 18px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
}
.cm-btn.ghost { background: var(--surface-2); color: var(--slate); border: 1px solid var(--line); }
.cm-btn.primary { background: var(--brand-grad); color: #fff; }
</style>
