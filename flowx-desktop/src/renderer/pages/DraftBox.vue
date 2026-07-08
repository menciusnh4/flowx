<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { useDraftStore } from '../stores/draft'
import type { PublishDraft, ContentType } from '../../types'

const router = useRouter()
const draftStore = useDraftStore()

const loading = ref(false)
const activeTab = ref<'all' | ContentType>('all')
const searchQuery = ref('')

onMounted(async () => {
  loading.value = true
  try {
    await draftStore.loadDrafts()
  } finally {
    loading.value = false
  }
})

// 计算过滤后的草稿列表
const filteredDrafts = computed(() => {
  return draftStore.drafts.filter(d => {
    // 搜索匹配 (标题 or 内容)
    const titleMatch = d.title.toLowerCase().includes(searchQuery.value.toLowerCase())
    const content = (d.formData as any)?.content || ''
    const contentMatch = content.toLowerCase().includes(searchQuery.value.toLowerCase())
    const matchesSearch = searchQuery.value ? (titleMatch || contentMatch) : true
    
    // Tab分类匹配
    const matchesTab = activeTab.value === 'all' ? true : d.contentType === activeTab.value
    
    return matchesSearch && matchesTab
  })
})

const totalDraftsCount = computed(() => {
  return filteredDrafts.value.length
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}` // 还原参考图的时间格式，例如 "07-10 15:04"
}

function contentTypeLabel(type: string): string {
  const map: Record<string, string> = { video: '视频', image: '图文', article: '文章' }
  return map[type] || type
}

function contentTypeIcon(type: string): string {
  const map: Record<string, string> = { video: '🎬', image: '🖼️', article: '📝' }
  return map[type] || '📄'
}

// 编辑草稿
function editDraft(draft: PublishDraft) {
  router.push({ path: '/publish', query: { draftId: draft.id } })
}

// 在浏览器中打开
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
    <!-- 页面头部栏 -->
    <div class="page-header">
      <div class="header-left">
        <h2 class="section-title">草稿箱</h2>
        <span class="draft-count-badge">共 {{ draftStore.drafts.length }} 篇草稿</span>
      </div>
      <div class="header-right">
        <el-input
          v-model="searchQuery"
          placeholder="搜索草稿标题、内容..."
          :prefix-icon="Search"
          class="search-input"
          clearable
        />
        <el-button class="new-draft-btn" @click="newDraft">+ 新建</el-button>
      </div>
    </div>

    <!-- 胶囊样式分类 Tabs -->
    <div class="custom-tabs">
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'all' }" 
        @click="activeTab = 'all'"
      >
        <span class="tab-icon">📁</span> 全部
      </button>
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'video' }" 
        @click="activeTab = 'video'"
      >
        <span class="tab-icon">🎬</span> 视频
      </button>
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'image' }" 
        @click="activeTab = 'image'"
      >
        <span class="tab-icon">🖼️</span> 图文
      </button>
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'article' }" 
        @click="activeTab = 'article'"
      >
        <span class="tab-icon">📄</span> 文章
      </button>
    </div>

    <!-- 草稿卡片列表网格 -->
    <div v-loading="loading" class="draft-list">
      <el-empty v-if="!loading && totalDraftsCount === 0" :image-size="100" description="暂无草稿" />

      <div v-for="draft in filteredDrafts" :key="draft.id" class="draft-card" :data-type="draft.contentType">
        <!-- 顶部 3D 拟态封面 -->
        <div class="draft-cover" @click="editDraft(draft)">
          <div class="cover-bg" :class="draft.contentType">
            <!-- 视频类型的播放按钮与时长 -->
            <template v-if="draft.contentType === 'video'">
              <div class="play-btn-wrapper">
                <span class="play-icon">▶</span>
              </div>
            </template>
            
            <!-- 图文相册 3D 堆叠 -->
            <template v-else-if="draft.contentType === 'image'">
              <div class="stack-photos">
                <div class="photo photo-back"></div>
                <div class="photo photo-front">
                  <span class="photo-inner-icon">🏞️</span>
                </div>
              </div>
            </template>
            
            <!-- 文章 3D 纸张堆叠 -->
            <template v-else-if="draft.contentType === 'article'">
              <div class="stack-papers">
                <div class="paper paper-back"></div>
                <div class="paper paper-front">
                  <div class="paper-line long"></div>
                  <div class="paper-line medium"></div>
                  <div class="paper-line short"></div>
                </div>
              </div>
            </template>
          </div>
          
          <!-- 左上角浮动标签 -->
          <div class="cover-type-tag" :class="draft.contentType">
            {{ contentTypeIcon(draft.contentType) }} {{ contentTypeLabel(draft.contentType) }}
          </div>
        </div>

        <!-- 卡片内容区域 -->
        <div class="draft-main" @click="editDraft(draft)">
          <div class="draft-title-row">
            <h3 class="draft-title">
              {{ draft.title || '未命名草稿' }}
              <span class="edit-icon-inline">✏️</span>
            </h3>
            <span class="draft-time">{{ formatTime(draft.updatedAt) }}</span>
          </div>
          <p class="draft-excerpt">
            {{ (draft.formData as any)?.content?.slice(0, 95) || '暂无内容描述' }}
          </p>
          <div class="draft-footer">
            <div class="meta-left">
              <span v-if="draft.sourceUrl" class="source-tag" @click.stop="openInBrowser(draft)">
                🔗 来源链接
              </span>
              <span v-if="(draft.formData as any)?.mediaFiles?.length" class="meta-item">
                📎 {{ (draft.formData as any).mediaFiles.length }} 个素材
              </span>
            </div>
            <div class="actions-right" @click.stop>
              <el-button class="action-edit-btn" @click="editDraft(draft)">编辑</el-button>
              <el-button class="action-delete-btn" @click="deleteDraft(draft)">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18"/>
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-box-page {
  padding: 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

/* 页面头部栏 */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-left .section-title {
  margin: 0 !important;
}

.draft-count-badge {
  background: rgba(15, 23, 42, 0.05);
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 20px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-input {
  width: 240px;
}

.search-input :deep(.el-input__wrapper) {
  border-radius: 20px !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.05) inset !important;
  background: #ffffff !important;
  padding-left: 12px;
}
.search-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #6366f1 inset !important;
}

.new-draft-btn {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
  border: none !important;
  color: #ffffff !important;
  font-weight: 700 !important;
  border-radius: 20px !important;
  padding: 8px 18px !important;
  height: auto !important;
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.18), 0 10px 25px rgba(99, 102, 241, 0.38) !important;
  transition: all 0.25s ease !important;
}

.new-draft-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(99, 102, 241, 0.22), 0 16px 36px rgba(99, 102, 241, 0.58) !important;
}

/* 胶囊样式分类 Tabs */
.custom-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

.tab-btn {
  border: 1px solid rgba(0, 0, 0, 0.04);
  background: #ffffff;
  color: #64748b;
  font-size: 13px;
  font-weight: 700;
  padding: 6px 14px;
  border-radius: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.01);
}

.tab-btn.active {
  border-color: rgba(99, 102, 241, 0.25);
  background: rgba(99, 102, 241, 0.04);
  color: #6366f1;
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.05);
}

.tab-btn:hover:not(.active) {
  border-color: rgba(0, 0, 0, 0.08);
  color: #1e293b;
}

.tab-icon {
  font-size: 14px;
}

.draft-list {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
  align-content: start;
  padding-top: 4px;
  padding-bottom: 12px;
}

/* 草稿卡片容器 */
.draft-card {
  background: var(--glass-bg, rgba(255, 255, 255, 0.85));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: var(--glass-border, 1px solid rgba(0, 0, 0, 0.05));
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

.draft-card:hover {
  transform: translateY(-5px);
  border-color: rgba(99, 102, 241, 0.24);
  background: #ffffff;
  box-shadow: 0 16px 36px -4px rgba(99, 102, 241, 0.15), 0 4px 12px -4px rgba(0, 0, 0, 0.04);
}

/* 顶部 3D 拟态封面 */
.draft-cover {
  height: 130px;
  position: relative;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  margin: 2px 2px 0 2px;
  border-radius: 14px 14px 0 0;
}

.cover-bg {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-radius: 14px 14px 0 0;
  overflow: hidden;
  transition: transform 0.5s cubic-bezier(0.25, 0.8, 0.25, 1);
}

.draft-card:hover .cover-bg {
  transform: scale(1.04);
}

.cover-bg.video {
  background: linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%);
}

.cover-bg.image {
  background: linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%);
}

.cover-bg.article {
  background: linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%);
}

.play-btn-wrapper {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transition: all 0.25s ease;
}

.play-icon {
  font-size: 14px;
  color: #1e293b;
  margin-left: 2px;
}

.draft-card:hover .play-btn-wrapper {
  transform: scale(1.1);
  background: #ffffff;
}

.video-duration {
  position: absolute;
  bottom: 8px;
  right: 8px;
  background: rgba(15, 23, 42, 0.6);
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

/* 拟态 3D 纸张/相册堆叠 */
.stack-papers,
.stack-photos {
  position: relative;
  width: 70px;
  height: 50px;
}

.paper,
.photo {
  position: absolute;
  border-radius: 6px;
  background: #ffffff;
  border: 1.5px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.paper-back {
  width: 42px;
  height: 50px;
  left: 6px;
  top: -3px;
  transform: rotate(-10deg);
  opacity: 0.6;
  background: rgba(255, 255, 255, 0.8);
}

.paper-front {
  width: 42px;
  height: 50px;
  left: 18px;
  top: 1px;
  transform: rotate(5deg);
  padding: 8px 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.paper-line {
  height: 2px;
  background: #e2e8f0;
  border-radius: 1px;
}
.paper-line.long { width: 100%; }
.paper-line.medium { width: 70%; }
.paper-line.short { width: 45%; }

.draft-card:hover .paper-front {
  transform: translateY(-4px) rotate(8deg);
}
.draft-card:hover .paper-back {
  transform: translateY(-2px) rotate(-14deg);
}

.photo-back {
  width: 46px;
  height: 36px;
  left: 4px;
  top: 1px;
  transform: rotate(-8deg);
  opacity: 0.6;
}

.photo-front {
  width: 46px;
  height: 36px;
  left: 16px;
  top: 5px;
  transform: rotate(6deg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.photo-inner-icon {
  font-size: 16px;
}

.draft-card:hover .photo-front {
  transform: translateY(-4px) rotate(10deg);
}
.draft-card:hover .photo-back {
  transform: translateY(-2px) rotate(-12deg);
}

/* 左上角浮动标签 */
.cover-type-tag {
  position: absolute;
  top: 10px;
  left: 10px;
  font-size: 10px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.02em;
  z-index: 3;
}
.cover-type-tag.video { background: #fef3c7; color: #d97706; }
.cover-type-tag.image { background: #dcfce7; color: #059669; }
.cover-type-tag.article { background: #e0e7ff; color: #4f46e5; }

/* 内容区域 */
.draft-main {
  padding: 16px 18px 18px 18px;
  cursor: pointer;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.draft-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.draft-title {
  font-size: 15px;
  font-weight: 700;
  color: #1e293b;
  margin: 0;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edit-icon-inline {
  font-size: 10px;
  color: #94a3b8;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.draft-card:hover .edit-icon-inline {
  opacity: 1;
}

.draft-time {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
  font-weight: 500;
}

.draft-excerpt {
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  height: 38.4px; /* 严格对齐两行高度 */
}

/* 整合底部栏 */
.draft-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
  gap: 12px;
}

.meta-left {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
  align-items: center;
}

.source-tag {
  color: #6366f1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  transition: all 0.2s ease;
}

.source-tag:hover {
  color: #4f46e5;
  text-decoration: none;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.actions-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-edit-btn {
  border-radius: 20px !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  padding: 5px 12px !important;
  height: auto !important;
  border: 1px solid rgba(99, 102, 241, 0.15) !important;
  background: rgba(99, 102, 241, 0.04) !important;
  color: #6366f1 !important;
  transition: all 0.25s ease !important;
}

.action-edit-btn:hover {
  background: #6366f1 !important;
  color: #ffffff !important;
  border-color: #6366f1 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
}

.action-delete-btn {
  width: 24px !important;
  height: 24px !important;
  padding: 0 !important;
  border-radius: 50% !important;
  border: 1px solid rgba(239, 68, 68, 0.15) !important;
  background: rgba(239, 68, 68, 0.04) !important;
  color: #ef4444 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: all 0.25s ease !important;
  font-size: 11px !important;
  min-width: unset !important;
}

.action-delete-btn:hover {
  background: rgba(239, 68, 68, 0.16) !important;
  color: #e11d48 !important;
  border-color: rgba(239, 68, 68, 0.35) !important;
  box-shadow: 0 4px 10px rgba(239, 68, 68, 0.08) !important;
}

</style>
