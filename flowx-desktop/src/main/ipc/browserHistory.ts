import { safeInvoke } from './index';
import {
  listBookmarks,
  listAllBookmarks,
  isBookmarked,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  deleteBookmarkByUrl,
  searchBookmarks,
  listBookmarkFolders,
  createBookmarkFolder,
  deleteBookmarkFolder,
  listHistory,
  listHistoryPaged,
  addHistory,
  deleteHistory,
  clearHistory,
  searchHistory,
  getHistoryStats,
} from '../services/BrowserHistoryService';
import type { BrowserBookmark, BrowserBookmarkFolder, BrowserHistoryItem } from '../../types';

export function registerBrowserHistoryIpc(): void {
  // ========== 收藏夹 ==========

  safeInvoke<BrowserBookmark[]>(
    'browserHistory:listBookmarks',
    (folderId?: string | null) => {
      return listBookmarks(folderId);
    },
  );

  safeInvoke<BrowserBookmark[]>(
    'browserHistory:listAllBookmarks',
    () => {
      return listAllBookmarks();
    },
  );

  safeInvoke<boolean>(
    'browserHistory:isBookmarked',
    (url: string) => {
      return isBookmarked(url);
    },
  );

  safeInvoke<BrowserBookmark>(
    'browserHistory:addBookmark',
    (data: { url: string; title: string; siteName?: string; folderId?: string }) => {
      return addBookmark(data);
    },
  );

  safeInvoke<BrowserBookmark | null>(
    'browserHistory:updateBookmark',
    (id: string, patch: Partial<Pick<BrowserBookmark, 'title' | 'url' | 'folderId' | 'siteName'>>) => {
      return updateBookmark(id, patch);
    },
  );

  safeInvoke<boolean>(
    'browserHistory:deleteBookmark',
    (id: string) => {
      return deleteBookmark(id);
    },
  );

  safeInvoke<boolean>(
    'browserHistory:deleteBookmarkByUrl',
    (url: string) => {
      return deleteBookmarkByUrl(url);
    },
  );

  safeInvoke<BrowserBookmark[]>(
    'browserHistory:searchBookmarks',
    (keyword: string) => {
      return searchBookmarks(keyword);
    },
  );

  safeInvoke<BrowserBookmarkFolder[]>(
    'browserHistory:listBookmarkFolders',
    () => {
      return listBookmarkFolders();
    },
  );

  safeInvoke<BrowserBookmarkFolder>(
    'browserHistory:createBookmarkFolder',
    (name: string, parentId?: string) => {
      return createBookmarkFolder(name, parentId);
    },
  );

  safeInvoke<boolean>(
    'browserHistory:deleteBookmarkFolder',
    (folderId: string) => {
      return deleteBookmarkFolder(folderId);
    },
  );

  // ========== 历史记录 ==========

  safeInvoke<BrowserHistoryItem[]>(
    'browserHistory:listHistory',
    (limit?: number) => {
      return listHistory(limit);
    },
  );

  safeInvoke<{
    items: BrowserHistoryItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>(
    'browserHistory:listHistoryPaged',
    (page?: number, pageSize?: number) => {
      return listHistoryPaged(page, pageSize);
    },
  );

  safeInvoke<BrowserHistoryItem>(
    'browserHistory:addHistory',
    (data: { url: string; title: string; viewId?: string }) => {
      return addHistory(data);
    },
  );

  safeInvoke<boolean>(
    'browserHistory:deleteHistory',
    (id: string) => {
      return deleteHistory(id);
    },
  );

  safeInvoke<number>(
    'browserHistory:clearHistory',
    (beforeTs?: number) => {
      return clearHistory(beforeTs);
    },
  );

  safeInvoke<BrowserHistoryItem[]>(
    'browserHistory:searchHistory',
    (keyword: string, limit?: number) => {
      return searchHistory(keyword, limit);
    },
  );

  safeInvoke<{ total: number; today: number; thisWeek: number }>(
    'browserHistory:getHistoryStats',
    () => {
      return getHistoryStats();
    },
  );
}
