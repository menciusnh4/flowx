import { getStore } from '../store/SecureStore';
import type { PublishDraft, ContentType } from '../../types';

const MAX_DRAFTS = 100;

/**
 * 生成草稿 ID
 */
function generateDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取所有草稿（按更新时间倒序）
 */
export function listDrafts(): PublishDraft[] {
  const store = getStore();
  const drafts = store.get('publishDrafts') || [];
  return [...drafts].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 获取单个草稿
 */
export function getDraft(id: string): PublishDraft | null {
  const store = getStore();
  const drafts = store.get('publishDrafts') || [];
  return drafts.find((d) => d.id === id) || null;
}

/**
 * 创建草稿
 */
export function createDraft(data: {
  title: string;
  contentType: ContentType;
  formData: PublishDraft['formData'];
  sourceUrl?: string;
  sourceSite?: string;
  coverPreview?: string;
}): PublishDraft {
  const store = getStore();
  const drafts = store.get('publishDrafts') || [];

  // 检查数量限制
  if (drafts.length >= MAX_DRAFTS) {
    throw new Error(`草稿数量已达上限（${MAX_DRAFTS} 条），请先清理部分草稿`);
  }

  const now = Date.now();
  const draft: PublishDraft = {
    id: generateDraftId(),
    title: data.title || `草稿 ${new Date(now).toLocaleString('zh-CN')}`,
    contentType: data.contentType,
    formData: data.formData,
    sourceUrl: data.sourceUrl,
    sourceSite: data.sourceSite,
    coverPreview: data.coverPreview,
    wordCount: data.formData.content?.length || 0,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
  };

  drafts.push(draft);
  store.set('publishDrafts', drafts);
  return draft;
}

/**
 * 更新草稿
 */
export function updateDraft(
  id: string,
  patch: Partial<Pick<PublishDraft, 'title' | 'contentType' | 'formData' | 'coverPreview' | 'status'>>,
): PublishDraft | null {
  const store = getStore();
  const drafts = store.get('publishDrafts') || [];
  const idx = drafts.findIndex((d) => d.id === id);
  if (idx === -1) return null;

  const updated: PublishDraft = {
    ...drafts[idx],
    ...patch,
    updatedAt: Date.now(),
    wordCount: patch.formData?.content?.length ?? drafts[idx].wordCount,
  };

  drafts[idx] = updated;
  store.set('publishDrafts', drafts);
  return updated;
}

/**
 * 删除草稿
 */
export function deleteDraft(id: string): boolean {
  const store = getStore();
  const drafts = store.get('publishDrafts') || [];
  const filtered = drafts.filter((d) => d.id !== id);
  if (filtered.length === drafts.length) return false;
  store.set('publishDrafts', filtered);
  return true;
}

/**
 * 标记草稿为已发布
 */
export function markDraftPublished(id: string): boolean {
  const result = updateDraft(id, { status: 'published' });
  return !!result;
}

/**
 * 搜索草稿（按标题关键词）
 */
export function searchDrafts(keyword: string): PublishDraft[] {
  const drafts = listDrafts();
  if (!keyword.trim()) return drafts;
  const kw = keyword.toLowerCase();
  return drafts.filter((d) => d.title.toLowerCase().includes(kw));
}

/**
 * 按内容类型筛选
 */
export function listDraftsByType(contentType: ContentType): PublishDraft[] {
  return listDrafts().filter((d) => d.contentType === contentType);
}
