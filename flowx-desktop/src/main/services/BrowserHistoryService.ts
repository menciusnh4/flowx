import { getStore } from '../store/SecureStore';
import type { BrowserBookmark, BrowserBookmarkFolder, BrowserHistoryItem } from '../../types';

const MAX_HISTORY_ITEMS = 500;
const MAX_BOOKMARKS = 200;

// ========== 收藏夹相关 ==========

function generateBookmarkId(): string {
  return `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateFolderId(): string {
  return `bmf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateHistoryId(): string {
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取所有收藏夹（按更新时间倒序）
 */
export function listBookmarks(folderId?: string | null): BrowserBookmark[] {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  let filtered: BrowserBookmark[];
  if (folderId === undefined || folderId === null) {
    filtered = bookmarks.filter((b: BrowserBookmark) => !b.folderId);
  } else {
    filtered = bookmarks.filter((b: BrowserBookmark) => b.folderId === folderId);
  }
  return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 获取所有收藏夹（含所有文件夹）
 */
export function listAllBookmarks(): BrowserBookmark[] {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  return [...bookmarks].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 检查 URL 是否已收藏
 */
export function isBookmarked(url: string): boolean {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  return bookmarks.some((b: BrowserBookmark) => b.url === url);
}

/**
 * 添加收藏
 */
export function addBookmark(data: {
  url: string;
  title: string;
  siteName?: string;
  folderId?: string;
}): BrowserBookmark {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];

  // 检查是否已存在相同 URL
  const existing = bookmarks.find((b: BrowserBookmark) => b.url === data.url);
  if (existing) {
    // 更新已有的收藏
    existing.title = data.title || existing.title;
    existing.siteName = data.siteName || existing.siteName;
    if (data.folderId !== undefined) {
      existing.folderId = data.folderId;
    }
    existing.updatedAt = Date.now();
    store.set('browserBookmarks', bookmarks);
    return existing;
  }

  // 检查数量限制
  if (bookmarks.length >= MAX_BOOKMARKS) {
    throw new Error(`收藏夹数量已达上限（${MAX_BOOKMARKS} 条），请先清理部分收藏`);
  }

  const now = Date.now();
  const bookmark: BrowserBookmark = {
    id: generateBookmarkId(),
    url: data.url,
    title: data.title || data.url,
    siteName: data.siteName,
    folderId: data.folderId,
    createdAt: now,
    updatedAt: now,
  };

  bookmarks.push(bookmark);
  store.set('browserBookmarks', bookmarks);
  return bookmark;
}

/**
 * 更新收藏
 */
export function updateBookmark(
  id: string,
  patch: Partial<Pick<BrowserBookmark, 'title' | 'url' | 'folderId' | 'siteName'>>,
): BrowserBookmark | null {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  const idx = bookmarks.findIndex((b: BrowserBookmark) => b.id === id);
  if (idx === -1) return null;

  const updated: BrowserBookmark = {
    ...bookmarks[idx],
    ...patch,
    updatedAt: Date.now(),
  };

  bookmarks[idx] = updated;
  store.set('browserBookmarks', bookmarks);
  return updated;
}

/**
 * 删除收藏
 */
export function deleteBookmark(id: string): boolean {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  const filtered = bookmarks.filter((b: BrowserBookmark) => b.id !== id);
  if (filtered.length === bookmarks.length) return false;
  store.set('browserBookmarks', filtered);
  return true;
}

/**
 * 根据 URL 删除收藏
 */
export function deleteBookmarkByUrl(url: string): boolean {
  const store = getStore();
  const bookmarks = store.get('browserBookmarks') || [];
  const filtered = bookmarks.filter((b: BrowserBookmark) => b.url !== url);
  if (filtered.length === bookmarks.length) return false;
  store.set('browserBookmarks', filtered);
  return true;
}

/**
 * 搜索收藏
 */
export function searchBookmarks(keyword: string): BrowserBookmark[] {
  const bookmarks = listAllBookmarks();
  if (!keyword.trim()) return bookmarks;
  const kw = keyword.toLowerCase();
  return bookmarks.filter(
    (b) =>
      b.title.toLowerCase().includes(kw) ||
      b.url.toLowerCase().includes(kw) ||
      (b.siteName && b.siteName.toLowerCase().includes(kw)),
  );
}

/**
 * 获取所有收藏夹文件夹
 */
export function listBookmarkFolders(): BrowserBookmarkFolder[] {
  const store = getStore();
  const folders = store.get('browserBookmarkFolders') || [];
  return [...folders].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 创建收藏夹文件夹
 */
export function createBookmarkFolder(name: string, parentId?: string): BrowserBookmarkFolder {
  const store = getStore();
  const folders = store.get('browserBookmarkFolders') || [];

  const folder: BrowserBookmarkFolder = {
    id: generateFolderId(),
    name,
    parentId,
    createdAt: Date.now(),
  };

  folders.push(folder);
  store.set('browserBookmarkFolders', folders);
  return folder;
}

/**
 * 删除收藏夹文件夹（同时将其内的收藏移到根目录）
 */
export function deleteBookmarkFolder(folderId: string): boolean {
  const store = getStore();
  const folders = store.get('browserBookmarkFolders') || [];
  const filtered = folders.filter((f: BrowserBookmarkFolder) => f.id !== folderId);
  if (filtered.length === folders.length) return false;

  // 将该文件夹内的收藏移到根目录
  const bookmarks = store.get('browserBookmarks') || [];
  const updatedBookmarks = bookmarks.map((b: BrowserBookmark) =>
    b.folderId === folderId ? { ...b, folderId: undefined, updatedAt: Date.now() } : b,
  );

  store.set('browserBookmarkFolders', filtered);
  store.set('browserBookmarks', updatedBookmarks);
  return true;
}

// ========== 历史记录相关 ==========

/**
 * 获取历史记录（按访问时间倒序）
 */
export function listHistory(limit?: number): BrowserHistoryItem[] {
  const store = getStore();
  const history = store.get('browserHistory') || [];
  const sorted = [...history].sort((a, b) => b.visitTime - a.visitTime);
  if (limit && limit > 0) {
    return sorted.slice(0, limit);
  }
  return sorted;
}

/**
 * 分页获取历史记录
 */
export function listHistoryPaged(page = 1, pageSize = 50): {
  items: BrowserHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} {
  const all = listHistory();
  const total = all.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return { items, total, page, pageSize, totalPages };
}

/**
 * 添加历史记录
 * 如果同一 URL 在最近 5 分钟内已有记录，则更新访问时间而不是新增
 */
export function addHistory(data: { url: string; title: string; viewId?: string }): BrowserHistoryItem {
  const store = getStore();
  const history = store.get('browserHistory') || [];

  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;

  // 检查同一 URL 最近 5 分钟内是否已有记录
  const recentIdx = history.findIndex(
    (h: BrowserHistoryItem) => h.url === data.url && now - h.visitTime < FIVE_MINUTES,
  );

  if (recentIdx !== -1) {
    // 更新已有记录
    history[recentIdx].visitTime = now;
    history[recentIdx].title = data.title || history[recentIdx].title;
    if (data.viewId) {
      history[recentIdx].viewId = data.viewId;
    }
    store.set('browserHistory', history);
    return history[recentIdx];
  }

  const item: BrowserHistoryItem = {
    id: generateHistoryId(),
    url: data.url,
    title: data.title || data.url,
    visitTime: now,
    viewId: data.viewId,
  };

  history.push(item);

  // 超过上限时删除最旧的记录
  if (history.length > MAX_HISTORY_ITEMS) {
    const sorted = [...history].sort((a, b) => a.visitTime - b.visitTime);
    const toRemove = history.length - MAX_HISTORY_ITEMS;
    const oldestIds = new Set(sorted.slice(0, toRemove).map((h) => h.id));
    const kept = history.filter((h: BrowserHistoryItem) => !oldestIds.has(h.id));
    store.set('browserHistory', kept);
  } else {
    store.set('browserHistory', history);
  }

  return item;
}

/**
 * 删除单条历史记录
 */
export function deleteHistory(id: string): boolean {
  const store = getStore();
  const history = store.get('browserHistory') || [];
  const filtered = history.filter((h: BrowserHistoryItem) => h.id !== id);
  if (filtered.length === history.length) return false;
  store.set('browserHistory', filtered);
  return true;
}

/**
 * 清除指定时间之前的历史记录
 * @param beforeTs 时间戳，不传则清除全部
 */
export function clearHistory(beforeTs?: number): number {
  const store = getStore();
  const history = store.get('browserHistory') || [];
  let kept: BrowserHistoryItem[];
  if (beforeTs === undefined) {
    kept = [];
  } else {
    kept = history.filter((h: BrowserHistoryItem) => h.visitTime >= beforeTs);
  }
  const removed = history.length - kept.length;
  store.set('browserHistory', kept);
  return removed;
}

/**
 * 搜索历史记录
 */
export function searchHistory(keyword: string, limit = 50): BrowserHistoryItem[] {
  const history = listHistory();
  if (!keyword.trim()) return history.slice(0, limit);
  const kw = keyword.toLowerCase();
  return history
    .filter(
      (h) =>
        h.title.toLowerCase().includes(kw) ||
        h.url.toLowerCase().includes(kw),
    )
    .slice(0, limit);
}

/**
 * 获取历史记录统计
 */
export function getHistoryStats(): { total: number; today: number; thisWeek: number } {
  const store = getStore();
  const history = store.get('browserHistory') || [];
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;

  let today = 0;
  let thisWeek = 0;

  for (const h of history) {
    if (h.visitTime >= todayStart) today++;
    if (h.visitTime >= weekStart) thisWeek++;
  }

  return {
    total: history.length,
    today,
    thisWeek,
  };
}
