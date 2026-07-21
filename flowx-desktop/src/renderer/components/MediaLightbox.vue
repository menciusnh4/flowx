<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 大图数据源（base64 data URL 数组，复用既有 imageUrlCache，不重复读文件） */
    images: string[]
    /** 当前展示索引 */
    index: number
    /** 封面图索引（仅文章模式首图）；传 -1 表示无封面标识 */
    coverIndex?: number
  }>(),
  { coverIndex: -1 },
)

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'update:index', i: number): void
}>()

const current = computed(() => {
  if (props.images.length === 0) return 0
  return Math.min(Math.max(props.index, 0), props.images.length - 1)
})

const isCover = computed(() => props.coverIndex >= 0 && current.value === props.coverIndex)

function close() {
  emit('update:visible', false)
}

function prev() {
  if (props.images.length === 0) return
  emit('update:index', (current.value - 1 + props.images.length) % props.images.length)
}

function next() {
  if (props.images.length === 0) return
  emit('update:index', (current.value + 1) % props.images.length)
}

function onKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
}

// 打开时挂键盘监听，关闭时移除
watch(
  () => props.visible,
  (v) => {
    if (v) window.addEventListener('keydown', onKey)
    else window.removeEventListener('keydown', onKey)
  },
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="lb-mask" @click.self="close">
      <button type="button" class="lb-close" title="关闭（Esc / 点击遮罩）" @click="close">✕</button>

      <button
        v-if="images.length > 1"
        type="button"
        class="lb-nav lb-prev"
        title="上一张（←）"
        @click.stop="prev"
      >
        ‹
      </button>

      <div class="lb-stage">
        <img v-if="images[current]" :src="images[current]" class="lb-img" alt="预览大图" />
        <div v-if="isCover" class="lb-cover-tag">★ 当前封面</div>
        <div v-if="images.length > 1" class="lb-counter">{{ current + 1 }} / {{ images.length }}</div>
      </div>

      <button
        v-if="images.length > 1"
        type="button"
        class="lb-nav lb-next"
        title="下一张（→）"
        @click.stop="next"
      >
        ›
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.lb-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.78);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: lb-fade 0.18s ease;
}

@keyframes lb-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.lb-stage {
  position: relative;
  max-width: 90vw;
  max-height: 88vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lb-img {
  max-width: 90vw;
  max-height: 88vh;
  object-fit: contain;
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
  background: #fff;
}

.lb-cover-tag {
  position: absolute;
  top: 12px;
  left: 12px;
  background: var(--brand-indigo, #6366f1);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 8px;
}

.lb-counter {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: rgba(15, 23, 42, 0.7);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 8px;
}

.lb-close {
  position: absolute;
  top: 20px;
  right: 24px;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.lb-close:hover {
  background: rgba(255, 255, 255, 0.28);
}

.lb-nav {
  width: 48px;
  height: 48px;
  margin: 0 18px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, transform 0.15s;
}
.lb-nav:hover {
  background: rgba(255, 255, 255, 0.28);
  transform: scale(1.06);
}
</style>
