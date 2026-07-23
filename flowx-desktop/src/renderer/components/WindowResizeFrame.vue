<script setup lang="ts">
// 自定义窗口边缘缩放（frame:false 后 OS 原生边框缩放失效）
// 8 向 hit-test：在窗口四边/四角叠加透明热区，mousedown 抓取起始几何，
// mousemove 计算新 bounds 经 IPC 调主进程 setBounds。
import { onBeforeUnmount, onMounted } from 'vue';
import { electronApi } from '../utils/electron';

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 1024;
const MIN_H = 720;

interface Start {
  dir: Dir;
  b: { x: number; y: number; width: number; height: number };
  mx: number;
  my: number;
}
let start: Start | null = null;
let raf = 0;
let pending: { x: number; y: number; width: number; height: number } | null = null;

const cursors: Record<Dir, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  sw: 'nesw-resize',
};

function flush() {
  raf = 0;
  if (pending) {
    const b = pending;
    pending = null;
    void electronApi.setWindowBounds(b);
  }
}

function onMove(e: MouseEvent) {
  if (!start) return;
  const dx = e.screenX - start.mx;
  const dy = e.screenY - start.my;
  const b = { ...start.b };
  if (start.dir.includes('e')) b.width = Math.max(MIN_W, b.width + dx);
  if (start.dir.includes('s')) b.height = Math.max(MIN_H, b.height + dy);
  if (start.dir.includes('w')) {
    const nw = Math.max(MIN_W, b.width - dx);
    b.x = b.x + b.width - nw;
    b.width = nw;
  }
  if (start.dir.includes('n')) {
    const nh = Math.max(MIN_H, b.height - dy);
    b.y = b.y + b.height - nh;
    b.height = nh;
  }
  pending = b;
  if (!raf) raf = requestAnimationFrame(flush);
}

function onUp() {
  start = null;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  pending = null;
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  document.body.style.userSelect = '';
}

async function onDown(e: MouseEvent, dir: Dir) {
  e.preventDefault();
  if (await electronApi.isMaximizedWindow()) return; // 最大化态禁用边缘缩放
  const b = await electronApi.getWindowBounds();
  if (!b) return;
  start = { dir, b, mx: e.screenX, my: e.screenY };
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

onMounted(() => {
  for (const dir of DIRS) {
    const el = document.querySelector<HTMLElement>(`.rsz-${dir}`);
    if (el) {
      el.style.cursor = cursors[dir];
      el.addEventListener('mousedown', (e) => onDown(e, dir));
    }
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
});
</script>

<template>
  <!-- 透明边缘缩放热区：容器不拦截事件，仅四边/四角（4px/8px）拦截 -->
  <div class="rsz-frame" aria-hidden="true">
    <div class="rsz rsz-n"></div>
    <div class="rsz rsz-s"></div>
    <div class="rsz rsz-e"></div>
    <div class="rsz rsz-w"></div>
    <div class="rsz rsz-ne"></div>
    <div class="rsz rsz-nw"></div>
    <div class="rsz rsz-se"></div>
    <div class="rsz rsz-sw"></div>
  </div>
</template>

<style scoped>
.rsz-frame {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9000;
}
.rsz {
  position: absolute;
  pointer-events: auto;
}
/* 四边 4px */
.rsz-n,
.rsz-s {
  left: 0;
  right: 0;
  height: 4px;
}
.rsz-n {
  top: 0;
}
.rsz-s {
  bottom: 0;
}
.rsz-e,
.rsz-w {
  top: 0;
  bottom: 0;
  width: 4px;
}
.rsz-e {
  right: 0;
}
.rsz-w {
  left: 0;
}
/* 四角 8px */
.rsz-ne,
.rsz-nw,
.rsz-se,
.rsz-sw {
  width: 8px;
  height: 8px;
}
.rsz-ne {
  top: 0;
  right: 0;
}
.rsz-nw {
  top: 0;
  left: 0;
}
.rsz-se {
  bottom: 0;
  right: 0;
}
.rsz-sw {
  bottom: 0;
  left: 0;
}
</style>
