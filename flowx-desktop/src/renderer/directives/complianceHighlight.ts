// 违禁词行内高亮指令 v-compliance-highlight
// 用法：<el-input v-compliance-highlight="compliance.fieldMatches('content')" ... />
// 原理：在输入框(.el-input/.el-textarea)内叠加一层透明的高亮层，按 matches 的
// start/end 把命中小段包成 <span class="ch-{level}">（仅画颜色下划线）。
// 高亮层从真实 textarea/input 复制字体度量，保证下划线与正文逐字对齐；
// 覆盖在输入框之上、pointer-events:none，不挡输入与光标。
import type { Directive } from 'vue';
import type { ComplianceMatch } from '../../types/compliance';
import './complianceHighlight.css';

interface Rec {
  input: HTMLTextAreaElement | HTMLInputElement;
  backdrop: HTMLElement;
  sync: () => void;
  reposition: () => void;
  onScroll: () => void;
  onInput: () => void;
  ro: ResizeObserver;
}

const store = new WeakMap<HTMLElement, Rec>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 复制真实输入框的字体/盒模型度量到高亮层，确保文字布局一致 → 下划线落在正确字符下
function copyMetrics(src: HTMLElement, dst: HTMLElement) {
  const cs = getComputedStyle(src);
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'textTransform', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent',
    'textAlign', 'whiteSpace', 'wordBreak', 'overflowWrap',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'boxSizing',
  ];
  for (const p of props) {
    // 运行时写入，跳过 TS 对 CSSProperties 键的校验
    (dst.style as any)[p] = (cs as any)[p];
  }
  // 边框仅用于对齐内容盒，颜色透明（真实边框由下层 textarea 绘制）
  dst.style.borderTopColor = 'transparent';
  dst.style.borderRightColor = 'transparent';
  dst.style.borderBottomColor = 'transparent';
  dst.style.borderLeftColor = 'transparent';
}

function render(input: HTMLTextAreaElement | HTMLInputElement, backdrop: HTMLElement, matches: ComplianceMatch[]) {
  const text = input.value;
  const sorted = (matches || [])
    .filter((m) => m && m.end > m.start && m.start >= 0 && m.end <= text.length)
    .sort((a, b) => a.start - b.start);

  let html = '';
  let i = 0;
  for (const m of sorted) {
    const s = m.start;
    const e = m.end;
    if (s < i) continue; // 重叠区间跳过，避免重复包裹
    html += esc(text.slice(i, s));
    html += `<span class="ch-${m.level}">${esc(text.slice(s, e))}</span>`;
    i = e;
  }
  html += esc(text.slice(i));
  backdrop.innerHTML = html;

  // 同步滚动（多行 textarea 滚动 / 单行 input 横向裁剪）
  backdrop.scrollTop = input.scrollTop;
  backdrop.scrollLeft = input.scrollLeft;
}

export const complianceHighlight: Directive<HTMLElement, ComplianceMatch[] | undefined> = {
  mounted(el, binding) {
    const input = el.querySelector('textarea, input') as HTMLTextAreaElement | HTMLInputElement | null;
    if (!input) return;

    // 宿主取 el-input / el-textarea 根节点（el 自身），让它成为定位上下文
    const host = el as HTMLElement;
    host.style.position = host.style.position || 'relative';

    const backdrop = document.createElement('div');
    backdrop.className = 'compliance-highlight-backdrop ' + (input.tagName === 'TEXTAREA' ? 'ch-textarea' : 'ch-input');
    copyMetrics(input, backdrop);

    // 关键修复：用 rect 差把高亮层精确覆盖「内层 input/textarea 的边框盒」，
    // 而不是铺满整个 el-input 根（否则会被 .el-input__wrapper 的 padding/边框
    // 偏移，导致单行输入框下划线错位、甚至被 overflow 裁掉）。
    backdrop.style.position = 'absolute';
    backdrop.style.margin = '0';
    backdrop.style.zIndex = '2';

    // 真实输入框置于下层（背景保留），高亮层透明覆盖在上层只画线
    input.style.position = input.style.position || 'relative';
    input.style.zIndex = input.style.zIndex || '1';

    host.appendChild(backdrop);

    const reposition = () => {
      const rHost = host.getBoundingClientRect();
      const rInput = input.getBoundingClientRect();
      backdrop.style.left = `${rInput.left - rHost.left}px`;
      backdrop.style.top = `${rInput.top - rHost.top}px`;
      backdrop.style.width = `${input.offsetWidth}px`;
      backdrop.style.height = `${input.offsetHeight}px`;
    };
    const sync = () => render(input, backdrop, binding.value || []);
    const onScroll = () => {
      backdrop.scrollTop = input.scrollTop;
      backdrop.scrollLeft = input.scrollLeft;
    };
    const onInput = () => sync();

    input.addEventListener('scroll', onScroll, { passive: true });
    input.addEventListener('input', onInput);

    // 输入框尺寸 / 位置变化（rows、窗口缩放、布局变动）重新对齐 + 同步度量
    const ro = new ResizeObserver(() => {
      reposition();
      copyMetrics(input, backdrop);
      sync();
    });
    ro.observe(input);
    ro.observe(host);

    reposition();
    sync();
    store.set(el, { input, backdrop, sync, reposition, onScroll, onInput, ro });
  },

  updated(el, binding) {
    const rec = store.get(el);
    if (rec) {
      rec.reposition();
      rec.sync();
    }
  },

  unmounted(el) {
    const rec = store.get(el);
    if (rec) {
      rec.input.removeEventListener('scroll', rec.onScroll);
      rec.input.removeEventListener('input', rec.onInput);
      rec.ro.disconnect();
      rec.backdrop.remove();
      store.delete(el);
    }
  },
};
