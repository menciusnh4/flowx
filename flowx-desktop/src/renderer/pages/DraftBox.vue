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

// 编辑草稿 - 跳转到发布页并加载草稿
function editDraft(draft: PublishDraft) {
  router.push({ path: '/publish', query: { draftId: draft.id } })
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
  router.push('/publish')
}
</script>

<template>
  <div class="draft-box-page">
    <div class="page-header">
      <h2>草稿箱</h2>
      <el-button type="primary" @click="newDraft">新建</el-button>
    </div>

    <el-tabs v-model="activeTab" class="draft-tabs">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="视频" name="video" />
      <el-tab-pane label="图文" name="image" />
      <el-tab-pane label="文章" name="article" />
    </el-tabs>

    <div v-loading="loading" class="draft-list">
      <el-empty v-if="!loading && filteredDrafts.length === 0" description="暂无草稿" />

      <div v-for="draft in filteredDrafts" :key="draft.id" class="draft-card">
        <div class="draft-main" @click="editDraft(draft)">
          <div class="draft-header">
            <span class="type-tag">{{ contentTypeIcon(draft.contentType) }} {{ contentTypeLabel(draft.contentType) }}</span>
            <span class="draft-time">{{ formatTime(draft.updatedAt) }}</span>
          </div>
          <h3 class="draft-title">{{ draft.title || '（无标题）' }}</h3>
          <p class="draft-excerpt">
            {{ (draft.formData as any)?.content?.slice(0, 120) || '暂无内容描述' }}
          </p>
          <div class="draft-meta">
            <span v-if="draft.sourceUrl" class="source-tag" @click.stop="openInBrowser(draft)">
              🔗 来源链接
            </span>
            <span v-if="(draft.formData as any)?.mediaFiles?.length">
              📎 {{ (draft.formData as any).mediaFiles.length }} 个素材
            </span>
          </div>
        </div>
        <div class="draft-actions">
          <el-button size="small" @click="editDraft(draft)">编辑</el-button>
          <el-button size="small" type="danger" plain @click="deleteDraft(draft)">删除</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-box-page {
  padding: 20px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}
.draft-tabs {
  margin-bottom: 16px;
}
.draft-list {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  align-content: start;
}
.draft-card {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.draft-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  border-color: #d0d4dc;
}
.draft-main {
  padding: 16px;
  cursor: pointer;
  flex: 1;
}
.draft-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.type-tag {
  font-size: 12px;
  color: #606266;
  background: #f5f7fa;
  padding: 2px 8px;
  border-radius: 4px;
}
.draft-time {
  font-size: 12px;
  color: #909399;
}
.draft-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 8px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.draft-excerpt {
  font-size: 13px;
  color: #606266;
  line-height: 1.5;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.draft-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #909399;
}
.source-tag {
  color: #409eff;
  cursor: pointer;
}
.source-tag:hover {
  text-decoration: underline;
}
.draft-actions {
  display: flex;
  border-top: 1px solid #f0f2f5;
  padding: 10px 16px;
  gap: 8px;
  justify-content: flex-end;
}
</style>
