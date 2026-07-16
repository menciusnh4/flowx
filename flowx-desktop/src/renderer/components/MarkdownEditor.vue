<template>
  <div class="markdown-editor-wrapper">
    <div class="md-toolbar">
      <div class="md-toolbar-left">
        <button type="button" class="md-tool-btn" title="一级标题" @click="insertHeading(1)">H1</button>
        <button type="button" class="md-tool-btn" title="二级标题" @click="insertHeading(2)">H2</button>
        <button type="button" class="md-tool-btn" title="三级标题" @click="insertHeading(3)">H3</button>
        <span class="md-toolbar-divider"></span>
        <button type="button" class="md-tool-btn" title="粗体" @click="insertWrap('**', '**')"><b>B</b></button>
        <button type="button" class="md-tool-btn" title="斜体" @click="insertWrap('*', '*')"><i>I</i></button>
        <button type="button" class="md-tool-btn" title="高亮" @click="insertWrap('==', '==')"><mark style="background:#fff3cd;padding:0 4px;border-radius:2px;">A</mark></button>
        <span class="md-toolbar-divider"></span>
        <button type="button" class="md-tool-btn" title="引用" @click="insertPrefix('> ')">"</button>
        <span class="md-toolbar-divider"></span>
        <button type="button" class="md-tool-btn" title="无序列表" @click="insertPrefix('- ')">•</button>
        <button type="button" class="md-tool-btn" title="有序列表" @click="insertOrderedList">1.</button>
        <span class="md-toolbar-divider"></span>
        <button type="button" class="md-tool-btn" title="图片" @click="insertImage">🖼</button>
      </div>
      <div class="md-toolbar-right">
        <span class="md-word-count">{{ effectiveLength }} / {{ maxLength ? maxLength : '不限' }} 字</span>
      </div>
    </div>

    <div class="md-split-container" :style="{ height: editorHeight + 'px' }">
      <div class="md-editor-pane">
        <div class="md-pane-header">Markdown 编辑</div>
        <textarea
          ref="textareaRef"
          v-model="innerValue"
          class="md-textarea"
          :placeholder="placeholder"
          @input="handleInput"
          @keydown="handleKeydown"
          @scroll="syncScroll"
          spellcheck="false"
        ></textarea>
      </div>
      <div class="md-divider" @mousedown="startDrag">
        <div class="md-divider-handle">⋮⋮</div>
      </div>
      <div class="md-preview-pane">
        <div class="md-pane-header">实时预览</div>
        <div class="md-preview-content" ref="previewRef">
          <div class="markdown-body" v-html="renderedHtml"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { marked } from 'marked'

interface Props {
  modelValue: string
  placeholder?: string
  maxLength?: number
  height?: number
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '请输入 Markdown 内容...',
  maxLength: undefined,
  height: 400,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'input', value: string): void
}>()

const innerValue = ref(props.modelValue)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const previewRef = ref<HTMLDivElement | null>(null)
const editorHeight = computed(() => props.height)

// 有效字数（排除换行符和 Markdown 标记）
const effectiveLength = computed(() => {
  if (!innerValue.value) return 0
  // 先去除 Markdown 标记，再去除换行符
  let text = innerValue.value
  // 去除图片语法 ![alt](url)
  text = text.replace(/!\[.*?\]\(.*?\)/g, '')
  // 去除标题 #
  text = text.replace(/^#{1,6}\s+/gm, '')
  // 去除粗体/斜体标记
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/\*([^*]+)\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/_([^_]+)_/g, '$1')
  // 去除高亮标记 ==文本==
  text = text.replace(/==([^=]+)==/g, '$1')
  // 去除引用 >
  text = text.replace(/^>\s?/gm, '')
  // 去除列表标记 - * 1.
  text = text.replace(/^[-*+]\s+/gm, '')
  text = text.replace(/^\d+\.\s+/gm, '')
  // 去除换行符
  text = text.replace(/[\n\r]/g, '')
  return text.length
})

// 渲染后的 HTML
const renderedHtml = computed(() => {
  if (!innerValue.value) {
    return '<p style="color:#999;">预览区域</p>'
  }
  try {
    let html = marked.parse(innerValue.value) as string
    // 支持高亮语法 ==文本==
    html = html.replace(/==([^=]+)==/g, '<mark>$1</mark>')
    return html
  } catch (e) {
    return `<p style="color:red;">渲染错误: ${(e as Error).message}</p>`
  }
})

// 同步滚动
function syncScroll() {
  if (!textareaRef.value || !previewRef.value) return
  const textarea = textareaRef.value
  const preview = previewRef.value
  const scrollRatio = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight)
  preview.scrollTop = scrollRatio * (preview.scrollHeight - preview.clientHeight)
}

// 监听外部值变化
watch(() => props.modelValue, (newVal) => {
  if (newVal !== innerValue.value) {
    innerValue.value = newVal
  }
})

function handleInput() {
  emit('update:modelValue', innerValue.value)
  emit('input', innerValue.value)
}

// 获取当前选中的文本
function getSelection() {
  const ta = textareaRef.value
  if (!ta) return { start: 0, end: 0, text: '' }
  return {
    start: ta.selectionStart,
    end: ta.selectionEnd,
    text: ta.value.substring(ta.selectionStart, ta.selectionEnd),
  }
}

// 插入内容
function insertAtCursor(before: string, after: string = '', placeholder: string = '') {
  const ta = textareaRef.value
  if (!ta) return
  const sel = getSelection()
  const selectedText = sel.text || placeholder
  const newText = before + selectedText + after
  const newValue =
    ta.value.substring(0, sel.start) + newText + ta.value.substring(sel.end)
  innerValue.value = newValue
  emit('update:modelValue', newValue)
  emit('input', newValue)
  nextTick(() => {
    ta.focus()
    const newCursorPos = sel.start + before.length + selectedText.length
    ta.setSelectionRange(sel.start + before.length, newCursorPos)
  })
}

// 插入标题
function insertHeading(level: number) {
  const ta = textareaRef.value
  if (!ta) return
  const sel = getSelection()
  // 找到当前行
  const lineStart = ta.value.lastIndexOf('\n', sel.start - 1) + 1
  const lineEnd = ta.value.indexOf('\n', sel.start)
  const lineEndPos = lineEnd === -1 ? ta.value.length : lineEnd
  const currentLine = ta.value.substring(lineStart, lineEndPos)
  const hasHeading = /^#{1,6}\s/.test(currentLine)
  let newLine: string
  if (hasHeading) {
    // 移除已有标题标记
    newLine = currentLine.replace(/^#{1,6}\s/, '')
  } else {
    newLine = '#'.repeat(level) + ' ' + currentLine
  }
  const newValue =
    ta.value.substring(0, lineStart) + newLine + ta.value.substring(lineEndPos)
  innerValue.value = newValue
  emit('update:modelValue', newValue)
  emit('input', newValue)
  nextTick(() => {
    ta.focus()
    ta.setSelectionRange(lineStart + newLine.length, lineStart + newLine.length)
  })
}

// 插入包裹标记（粗体、斜体等）
function insertWrap(before: string, after: string) {
  insertAtCursor(before, after, '选中文字')
}

// 插入行前缀（引用、列表等）
function insertPrefix(prefix: string) {
  const ta = textareaRef.value
  if (!ta) return
  const sel = getSelection()
  // 找到当前行开头
  const lineStart = ta.value.lastIndexOf('\n', sel.start - 1) + 1
  const currentLine = ta.value.substring(lineStart, sel.start)
  // 检查是否已有该前缀
  if (currentLine.startsWith(prefix)) {
    // 移除前缀
    const newValue =
      ta.value.substring(0, lineStart) +
      currentLine.substring(prefix.length) +
      ta.value.substring(sel.start)
    innerValue.value = newValue
    emit('update:modelValue', newValue)
    emit('input', newValue)
    nextTick(() => {
      ta.focus()
      ta.setSelectionRange(sel.start - prefix.length, sel.end - prefix.length)
    })
  } else {
    // 添加前缀
    const newValue =
      ta.value.substring(0, lineStart) + prefix + ta.value.substring(lineStart)
    innerValue.value = newValue
    emit('update:modelValue', newValue)
    emit('input', newValue)
    nextTick(() => {
      ta.focus()
      ta.setSelectionRange(sel.start + prefix.length, sel.end + prefix.length)
    })
  }
}

// 插入有序列表
function insertOrderedList() {
  insertPrefix('1. ')
}

// 插入图片
function insertImage() {
  insertAtCursor('![', '](url)', '图片描述')
}

// 快捷键支持
function handleKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + B 粗体
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault()
    insertWrap('**', '**')
  }
  // Ctrl/Cmd + I 斜体
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
    e.preventDefault()
    insertWrap('*', '*')
  }
  // Ctrl/Cmd + H 高亮
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault()
    insertWrap('==', '==')
  }
  // Tab 键缩进
  if (e.key === 'Tab') {
    e.preventDefault()
    const ta = textareaRef.value
    if (!ta) return
    const sel = getSelection()
    if (e.shiftKey) {
      // 减少缩进
      const lineStart = ta.value.lastIndexOf('\n', sel.start - 1) + 1
      if (ta.value.substring(lineStart, lineStart + 2) === '  ') {
        const newValue =
          ta.value.substring(0, lineStart) +
          ta.value.substring(lineStart + 2)
        innerValue.value = newValue
        emit('update:modelValue', newValue)
        emit('input', newValue)
        nextTick(() => {
          ta.setSelectionRange(sel.start - 2, sel.end - 2)
        })
      }
    } else {
      // 增加缩进
      const newValue =
        ta.value.substring(0, sel.start) + '  ' + ta.value.substring(sel.end)
      innerValue.value = newValue
      emit('update:modelValue', newValue)
      emit('input', newValue)
      nextTick(() => {
        ta.setSelectionRange(sel.start + 2, sel.end + 2)
      })
    }
  }
}

// 拖拽分隔条
let isDragging = false
let startX = 0
let startLeftWidth = 0

function startDrag(e: MouseEvent) {
  isDragging = true
  startX = e.clientX
  const container = document.querySelector('.md-split-container') as HTMLElement
  const editorPane = document.querySelector('.md-editor-pane') as HTMLElement
  if (container && editorPane) {
    startLeftWidth = editorPane.offsetWidth
  }
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
  e.preventDefault()
}

function onDrag(e: MouseEvent) {
  if (!isDragging) return
  const container = document.querySelector('.md-split-container') as HTMLElement
  const editorPane = document.querySelector('.md-editor-pane') as HTMLElement
  if (container && editorPane) {
    const diff = e.clientX - startX
    const newWidth = startLeftWidth + diff
    const containerWidth = container.offsetWidth
    const minWidth = 150
    const maxWidth = containerWidth - 150
    const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth))
    const percent = (clampedWidth / containerWidth) * 100
    editorPane.style.flex = `0 0 ${percent}%`
  }
}

function stopDrag() {
  isDragging = false
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
}

onMounted(() => {
  // 配置 marked
  marked.setOptions({
    breaks: true,
    gfm: true,
  })
})
</script>

<style scoped>
.markdown-editor-wrapper {
  width: 100%;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}

.md-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: #f5f7fa;
  border-bottom: 1px solid #dcdfe6;
  flex-wrap: wrap;
  gap: 4px;
}

.md-toolbar-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
}

.md-toolbar-right {
  display: flex;
  align-items: center;
}

.md-tool-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #606266;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.md-tool-btn:hover {
  background: #e4e7ed;
  color: #409eff;
}

.md-toolbar-divider {
  width: 1px;
  height: 18px;
  background: #dcdfe6;
  margin: 0 4px;
}

.md-word-count {
  font-size: 12px;
  color: #909399;
}

.md-split-container {
  display: flex;
  width: 100%;
  overflow: hidden;
}

.md-editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.md-pane-header {
  padding: 6px 12px;
  font-size: 12px;
  color: #909399;
  background: #fafafa;
  border-bottom: 1px solid #ebeef5;
  text-align: center;
}

.md-textarea {
  flex: 1;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  color: #303133;
  background: #fff;
  box-sizing: border-box;
}

.md-divider {
  width: 6px;
  background: #ebeef5;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  flex-shrink: 0;
}

.md-divider:hover {
  background: #dcdfe6;
}

.md-divider-handle {
  font-size: 10px;
  color: #c0c4cc;
  letter-spacing: -1px;
  user-select: none;
}

.md-preview-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fafafa;
}

.md-preview-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

/* Markdown 预览样式 */
:deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.7;
  color: #303133;
  word-wrap: break-word;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4),
:deep(.markdown-body h5),
:deep(.markdown-body h6) {
  margin-top: 20px;
  margin-bottom: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: #1f2937;
}

:deep(.markdown-body h1) {
  font-size: 24px;
  border-bottom: 1px solid #ebeef5;
  padding-bottom: 8px;
}

:deep(.markdown-body h2) {
  font-size: 20px;
  border-bottom: 1px solid #ebeef5;
  padding-bottom: 6px;
}

:deep(.markdown-body h3) {
  font-size: 17px;
}

:deep(.markdown-body h4) {
  font-size: 15px;
}

:deep(.markdown-body p) {
  margin: 10px 0;
}

:deep(.markdown-body a) {
  color: #409eff;
  text-decoration: none;
}

:deep(.markdown-body a:hover) {
  text-decoration: underline;
}

:deep(.markdown-body strong) {
  font-weight: 600;
}

:deep(.markdown-body em) {
  font-style: italic;
}

:deep(.markdown-body del) {
  text-decoration: line-through;
  color: #909399;
}

:deep(.markdown-body mark) {
  background: #fff3cd;
  padding: 1px 4px;
  border-radius: 2px;
  color: inherit;
}

:deep(.markdown-body blockquote) {
  margin: 10px 0;
  padding: 8px 12px;
  border-left: 4px solid #dcdfe6;
  background: #f5f7fa;
  color: #606266;
}

:deep(.markdown-body blockquote p) {
  margin: 0;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  margin: 10px 0;
  padding-left: 24px;
}

:deep(.markdown-body li) {
  margin: 4px 0;
}

:deep(.markdown-body ul li) {
  list-style-type: disc;
}

:deep(.markdown-body ol li) {
  list-style-type: decimal;
}

:deep(.markdown-body code) {
  background: #f0f2f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  color: #e6a23c;
}

:deep(.markdown-body pre) {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 10px 0;
}

:deep(.markdown-body pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 13px;
}

:deep(.markdown-body hr) {
  border: none;
  border-top: 1px solid #ebeef5;
  margin: 16px 0;
}

:deep(.markdown-body img) {
  max-width: 100%;
  border-radius: 4px;
}

:deep(.markdown-body table) {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0;
}

:deep(.markdown-body th),
:deep(.markdown-body td) {
  border: 1px solid #dcdfe6;
  padding: 8px 12px;
  text-align: left;
}

:deep(.markdown-body th) {
  background: #f5f7fa;
  font-weight: 600;
}

:deep(.markdown-body input[type="checkbox"]) {
  margin-right: 6px;
}
</style>
