import { safeInvoke } from './index';
import {
  listDrafts,
  getDraft,
  createDraft,
  updateDraft,
  deleteDraft,
  searchDrafts,
} from '../services/DraftService';
import type { PublishDraft, ContentType } from '../../types';

export function registerDraftIpc(): void {
  safeInvoke<PublishDraft[]>(
    'draft:list',
    (contentType?: ContentType) => {
      if (contentType) {
        return listDrafts().filter((d) => d.contentType === contentType);
      }
      return listDrafts();
    },
  );

  safeInvoke<PublishDraft | null>(
    'draft:get',
    (id: string) => {
      return getDraft(id);
    },
  );

  safeInvoke<PublishDraft>(
    'draft:create',
    (data: Parameters<typeof createDraft>[0]) => {
      return createDraft(data);
    },
  );

  safeInvoke<PublishDraft | null>(
    'draft:update',
    (id: string, patch: Parameters<typeof updateDraft>[1]) => {
      return updateDraft(id, patch);
    },
  );

  safeInvoke<boolean>(
    'draft:delete',
    (id: string) => {
      return deleteDraft(id);
    },
  );

  safeInvoke<PublishDraft[]>(
    'draft:search',
    (keyword: string) => {
      return searchDrafts(keyword);
    },
  );
}
