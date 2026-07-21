import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { getStore } from '../store/SecureStore';
import type { PublishDraft, ContentType } from '../../types';

const MAX_DRAFTS = 100;

/** 草稿图片持久化目录 */
function getDraftImagesDir(): string {
  const dir = path.join(app.getPath('userData'), 'draft_images');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 临时图片目录 */
function getTempImagesDir(): string {
  return path.join(app.getPath('userData'), 'temp_images');
}

/**
 * 判断路径是否是临时图片目录中的文件
 */
function isTempImage(filePath: string): boolean {
  if (!filePath) return false;
  const tempDir = getTempImagesDir();
  try {
    return filePath.startsWith(tempDir) && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * 将临时图片移动/复制到草稿持久化目录
 * 返回新的文件路径
 */
function persistDraftImage(draftId: string, srcPath: string, index: number): string {
  const draftDir = path.join(getDraftImagesDir(), draftId);
  if (!fs.existsSync(draftDir)) {
    fs.mkdirSync(draftDir, { recursive: true });
  }

  const ext = path.extname(srcPath).toLowerCase() || '.jpg';
  const filename = `img_${index}_${Date.now()}${ext}`;
  const destPath = path.join(draftDir, filename);

  try {
    // 复制文件（保留原临时文件，避免影响其他操作）
    fs.copyFileSync(srcPath, destPath);
    return destPath;
  } catch (e) {
    console.warn('[DraftService] persist image failed:', srcPath, e);
    return srcPath; // 失败则返回原路径
  }
}

/**
 * 处理草稿的媒体文件：将临时图片持久化到草稿目录
 */
function persistDraftMediaFiles(draftId: string, mediaFiles: string[]): string[] {
  if (!mediaFiles || mediaFiles.length === 0) return mediaFiles;

  return mediaFiles.map((file, idx) => {
    if (isTempImage(file)) {
      return persistDraftImage(draftId, file, idx);
    }
    return file;
  });
}

/**
 * 清理草稿的图片目录
 */
function cleanupDraftImages(draftId: string): void {
  const draftDir = path.join(getDraftImagesDir(), draftId);
  try {
    if (fs.existsSync(draftDir)) {
      fs.rmSync(draftDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[DraftService] cleanup draft images failed:', draftId, e);
  }
}

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

  const draftId = generateDraftId();
  const now = Date.now();

  // 持久化媒体文件（将临时图片复制到草稿目录）
  const persistedMediaFiles = persistDraftMediaFiles(draftId, data.formData.mediaFiles || []);

  // 持久化封面图片
  let persistedCoverImage = data.formData.coverImage || '';
  if (persistedCoverImage && isTempImage(persistedCoverImage)) {
    persistedCoverImage = persistDraftImage(draftId, persistedCoverImage, -1);
  }

  const draft: PublishDraft = {
    id: draftId,
    title: data.title || `草稿 ${new Date(now).toLocaleString('zh-CN')}`,
    contentType: data.contentType,
    formData: {
      ...data.formData,
      mediaFiles: persistedMediaFiles,
      coverImage: persistedCoverImage,
    },
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

  // 如果更新了 formData，需要持久化其中新增的临时图片
  let updatedFormData = patch.formData;
  if (updatedFormData) {
    let finalMediaFiles = updatedFormData.mediaFiles;
    let finalCoverImage = updatedFormData.coverImage;

    // 持久化新增的媒体文件
    if (finalMediaFiles) {
      const existingFiles = drafts[idx].formData.mediaFiles || [];
      const newFiles = finalMediaFiles.filter(f => !existingFiles.includes(f));
      const persistedNewFiles = persistDraftMediaFiles(id, newFiles);
      finalMediaFiles = finalMediaFiles.map(f => {
        const newIdx = newFiles.indexOf(f);
        if (newIdx !== -1) {
          return persistedNewFiles[newIdx];
        }
        return f;
      });
    }

    // 持久化封面图片（如果是新的临时文件）
    if (finalCoverImage && finalCoverImage !== drafts[idx].formData.coverImage && isTempImage(finalCoverImage)) {
      finalCoverImage = persistDraftImage(id, finalCoverImage, -1);
    }

    updatedFormData = {
      ...updatedFormData,
      mediaFiles: finalMediaFiles ?? drafts[idx].formData.mediaFiles,
      coverImage: finalCoverImage ?? drafts[idx].formData.coverImage,
    };
  }

  const updated: PublishDraft = {
    ...drafts[idx],
    ...patch,
    formData: updatedFormData ?? drafts[idx].formData,
    updatedAt: Date.now(),
    wordCount: updatedFormData?.content?.length ?? drafts[idx].wordCount,
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

  // 清理草稿的图片文件
  cleanupDraftImages(id);

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
