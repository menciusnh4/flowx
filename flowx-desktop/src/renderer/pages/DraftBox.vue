<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useDraftStore } from '../stores/draft'
import type { PublishDraft, ContentType } from '../../types'

const router = useRouter()
const draftStore = useDraftStore()

const loading = ref(false)
const activeTab = ref<'all' | ContentType>('all')

onMounted(async () => {
  loading.value = true
  try {
    await draftStore.loadDrafts()
  } finally {
    loading.value = false
  }
})

const filteredDrafts = computed(() => {
  if (activeTab.value === 'all') return draftStore.drafts
  return draftStore.drafts.filter(d => d.contentType === activeTab.value)
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

function contentTypeLabel(type: string): string {
  const map: Record<string, string> = { video: '视频', image: '图文', article: '文章' }
  return map[type] || type
}

function contentTypeIcon(type: string): string {
  const map: Record<string, string> = { video: '🎬', image: '🖼️', article: '📝' }
  return map[type] || '📄'
}

// 正文摘要（取 formData.content 前 120 字）
function excerpt(draft: PublishDraft): string {
  const content = (draft.formData as any)?.content
  return content ? String(content).slice(0, 120) : '暂无内容描述'
}

// 素材数量
function mediaCount(draft: PublishDraft): number {
  return (draft.formData as any)?.mediaFiles?.length || 0
}

// 编辑草稿 - 跳转到对应类型的发布页并加载草稿
function editDraft(draft: PublishDraft) {
  const type =
    draft.contentType === 'image' || draft.contentType === 'article'
      ? draft.contentType
      : 'video'
  router.push({ path: `/publish/${type}`, query: { draftId: draft.id } })
}

// 在浏览器中打开（如果有 sourceUrl）
function openInBrowser(draft: PublishDraft) {
  if (draft.sourceUrl) {
    router.push({ path: '/browser', query: { url: draft.sourceUrl } })
  }
}

// 删除草稿
async function deleteDraft(draft: PublishDraft) {
  try {
    await ElMessageBox.confirm(`确定要删除草稿「${draft.title.slice(0, 30)}」吗？`, '确认删除', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const ok = await draftStore.deleteDraft(draft.id)
    if (ok) {
      ElMessage.success('已删除')
    }
  } catch {
    // 用户取消
  }
}

// 新建草稿
function newDraft() {
  router.push('/publish/video')
}
</script>

<template>
  <div class="draft-box-page">
    <!-- 头部：草稿计数 + 新建 -->
    <div class="db-header">
      <div class="db-stats">
        <span class="db-stat"><i class="sdot indigo"></i><b>{{ draftStore.drafts.length }}</b> 条草稿</span>
      </div>
      <button class="btn primary" @click="newDraft">＋ 新建</button>
    </div>

    <!-- 类型筛选（原型 pill） -->
    <div class="db-filters">
      <button class="pill" :class="{ active: activeTab === 'all' }" @click="activeTab = 'all'">全部</button>
      <button class="pill" :class="{ active: activeTab === 'video' }" @click="activeTab = 'video'">视频</button>
      <button class="pill" :class="{ active: activeTab === 'image' }" @click="activeTab = 'image'">图文</button>
      <button class="pill" :class="{ active: activeTab === 'article' }" @click="activeTab = 'article'">文章</button>
    </div>

    <div v-loading="loading" class="draft-grid">
      <div v-if="!loading && filteredDrafts.length === 0" class="empty">
        <div class="eic">📭</div>
        <p>暂无草稿</p>
      </div>

      <article v-for="draft in filteredDrafts" :key="draft.id" class="dcard">
        <div class="dm" @click="editDraft(draft)">
          <div class="dh">
            <span class="chip">{{ contentTypeIcon(draft.contentType) }} {{ contentTypeLabel(draft.contentType) }}</span>
            <span class="dtime">{{ formatTime(draft.updatedAt) }}</span>
          </div>
          <h3 class="dt">{{ draft.title || '（无标题）' }}</h3>
          <p class="dex">{{ excerpt(draft) }}</p>
          <div class="dmeta">
            <span v-if="draft.sourceUrl" class="src" @click.stop="openInBrowser(draft)">🔗 来源链接</span>
            <span v-if="mediaCount(draft)">📎 {{ mediaCount(draft) }} 个素材</span>
          </div>
        </div>
        <div class="da">
          <button class="btn sm" @click="editDraft(draft)">编辑</button>
          <button class="btn sm danger" @click="deleteDraft(draft)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.draft-box-page {
  padding: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
/* 头部 */
.db-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.db-stats {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.db-stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}
.db-stat b {
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
}
.sdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sdot.indigo { background: var(--brand-indigo); }

/* 通用按钮（对齐原型 .btn） */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 16px;
  border-radius: 11px;
  font-weight: 700;
  font-size: 13px;
  font-family: inherit;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--slate);
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  white-space: nowrap;
}
.btn:hover {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
}
.btn.primary {
  background: var(--brand-grad);
  color: #fff;
  border-color: transparent;
  box-shadow: var(--shadow-md);
}
.btn.primary:hover {
  filter: brightness(1.05);
  color: #fff;
}
.btn.sm {
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  border-radius: 9px;
}
.btn.danger {
  color: var(--danger);
}
.btn.danger:hover {
  border-color: rgba(244, 63, 94, 0.4);
  color: var(--danger);
  background: rgba(244, 63, 94, 0.05);
}
/* 筛选 pill */
.db-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.pill {
  padding: 7px 14px;
  border-radius: 20px;
  font-size: 12.5px;
  font-weight: 700;
  font-family: inherit;
  background: var(--surface);
  border: 1px solid var(--line);
  color: var(--slate);
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
}
.pill:hover {
  border-color: var(--brand-indigo);
  color: var(--brand-indigo);
}
.pill.active {
  background: var(--brand-grad);
  border-color: transparent;
  color: #fff;
  box-shadow: var(--shadow-sm);
}
/* 网格 */
.draft-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 16px;
  align-content: start;
  padding-bottom: 8px;
}
/* 卡片 */
.dcard {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: all var(--t) var(--ease);
  display: flex;
  flex-direction: column;
}
.dcard:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--line-strong);
  transform: translateY(-2px);
}
.dm {
  padding: 15px;
  flex: 1;
  cursor: pointer;
}
.dh {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 9px;
}
.chip {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}
.dtime {
  font-size: 11.5px;
  color: var(--faint);
}
.dt {
  font-size: 15px;
  font-weight: 800;
  color: var(--ink);
  margin: 0 0 7px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dex {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.55;
  margin: 0 0 9px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dmeta {
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: var(--faint);
}
.dmeta .src {
  color: var(--brand-indigo);
  cursor: pointer;
  font-weight: 600;
}
.dmeta .src:hover {
  text-decoration: underline;
}
.da {
  display: flex;
  gap: 7px;
  padding: 10px 15px;
  border-top: 1px solid var(--line);
  justify-content: flex-end;
}
/* 空状态 */
.empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 50px 20px;
  color: var(--faint);
}
.empty .eic {
  font-size: 46px;
  margin-bottom: 12px;
  opacity: 0.6;
}
</style>
