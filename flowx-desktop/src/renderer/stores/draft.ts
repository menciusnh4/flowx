import { defineStore } from 'pinia';
import type { PublishDraft, ContentType } from '../../types';
import { electronApi } from '../utils/electron';

const LOG_PREFIX = '[DraftStore]';

export const useDraftStore = defineStore('drafts', {
  state: () => ({
    drafts: [] as PublishDraft[],
    loading: false,
    error: '',
    // 当前编辑的草稿 ID（用于自动保存）
    currentDraftId: null as string | null,
    _autoSaveTimer: null as number | null,
  }),
  getters: {
    draftList(): PublishDraft[] {
      return this.drafts;
    },
    count(): number {
      return this.drafts.length;
    },
    byType(): (type: ContentType) => PublishDraft[] {
      return (type: ContentType) => this.drafts.filter((d) => d.contentType === type);
    },
  },
  actions: {
    // ============== 查询 ==============
    async loadDrafts(contentType?: ContentType) {
      this.loading = true;
      this.error = '';
      try {
        const list = await electronApi.draft.list(contentType);
        this.drafts = list || [];
        console.log(`${LOG_PREFIX} loadDrafts: ${this.drafts.length} items`);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        console.error(`${LOG_PREFIX} loadDrafts failed: ${this.error}`);
      } finally {
        this.loading = false;
      }
    },

    async getDraft(id: string): Promise<PublishDraft | null> {
      try {
        return await electronApi.draft.get(id);
      } catch (e) {
        console.error(`${LOG_PREFIX} getDraft failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },

    async searchDrafts(keyword: string): Promise<PublishDraft[]> {
      try {
        return await electronApi.draft.search(keyword);
      } catch (e) {
        console.error(`${LOG_PREFIX} searchDrafts failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },

    // ============== 增删改 ==============
    async createDraft(data: {
      title: string;
      contentType: ContentType;
      formData: PublishDraft['formData'];
      sourceUrl?: string;
      sourceSite?: string;
      coverPreview?: string;
    }): Promise<PublishDraft | null> {
      try {
        const draft = await electronApi.draft.create(data);
        // 插入到本地列表开头
        this.drafts.unshift(draft);
        this.currentDraftId = draft.id;
        console.log(`${LOG_PREFIX} createDraft: id=${draft.id}, title=${draft.title}`);
        return draft;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`${LOG_PREFIX} createDraft failed: ${msg}`);
        return null;
      }
    },

    async updateDraft(id: string, patch: Partial<Pick<PublishDraft, 'title' | 'contentType' | 'formData' | 'coverPreview' | 'status'>>): Promise<PublishDraft | null> {
      try {
        const updated = await electronApi.draft.update(id, patch);
        if (updated) {
          const idx = this.drafts.findIndex((d) => d.id === id);
          if (idx >= 0) {
            this.drafts[idx] = updated;
          }
        }
        return updated;
      } catch (e) {
        console.error(`${LOG_PREFIX} updateDraft failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },

    async deleteDraft(id: string): Promise<boolean> {
      try {
        const ok = await electronApi.draft.delete(id);
        if (ok) {
          this.drafts = this.drafts.filter((d) => d.id !== id);
          if (this.currentDraftId === id) {
            this.currentDraftId = null;
          }
        }
        return ok;
      } catch (e) {
        console.error(`${LOG_PREFIX} deleteDraft failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },

    // ============== 自动保存 ==============
    /**
     * 设置当前编辑的草稿（用于自动保存）
     */
    setCurrentDraft(draftId: string | null) {
      this.currentDraftId = draftId;
      this._clearAutoSaveTimer();
    },

    /**
     * 触发自动保存（防抖 3 秒）
     */
    scheduleAutoSave(data: {
      title: string;
      contentType: ContentType;
      formData: PublishDraft['formData'];
      coverPreview?: string;
    }) {
      this._clearAutoSaveTimer();
      this._autoSaveTimer = window.setTimeout(() => {
        this._doAutoSave(data);
      }, 3000) as unknown as number;
    },

    async _doAutoSave(data: {
      title: string;
      contentType: ContentType;
      formData: PublishDraft['formData'];
      coverPreview?: string;
    }) {
      if (this.currentDraftId) {
        // 更新已有草稿
        await this.updateDraft(this.currentDraftId, {
          title: data.title,
          contentType: data.contentType,
          formData: data.formData,
          coverPreview: data.coverPreview,
        });
      } else {
        // 创建新草稿
        const draft = await this.createDraft(data);
        if (draft) {
          this.currentDraftId = draft.id;
        }
      }
    },

    _clearAutoSaveTimer() {
      if (this._autoSaveTimer) {
        clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = null;
      }
    },

    /**
     * 立即保存（手动保存草稿时调用）
     */
    async saveNow(data: {
      title: string;
      contentType: ContentType;
      formData: PublishDraft['formData'];
      coverPreview?: string;
      sourceUrl?: string;
      sourceSite?: string;
    }): Promise<PublishDraft | null> {
      this._clearAutoSaveTimer();
      if (this.currentDraftId) {
        return this.updateDraft(this.currentDraftId, {
          title: data.title,
          contentType: data.contentType,
          formData: data.formData,
          coverPreview: data.coverPreview,
        });
      }
      return this.createDraft(data);
    },

    /**
     * 加载草稿到当前编辑（从草稿箱加载时调用）
     */
    async loadDraftForEdit(id: string): Promise<PublishDraft | null> {
      const draft = await this.getDraft(id);
      if (draft) {
        this.currentDraftId = id;
      }
      return draft;
    },

    /**
     * 重置当前草稿状态（新建空白表单时调用）
     */
    resetCurrentDraft() {
      this._clearAutoSaveTimer();
      this.currentDraftId = null;
    },
  },
});
