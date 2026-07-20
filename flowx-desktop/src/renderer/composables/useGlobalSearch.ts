// 全局搜索（顶栏搜索框）编排逻辑
// 聚合五源：功能模块 / 草稿 / 账号 / 书签 / 历史。
// 复用既有 IPC（electronApi.draft.search / browserHistory.searchBookmarks / searchHistory / listAccounts），后端零改动。
// 分组顺序与上限、打开行为严格遵循 PRD（pm/全局搜索-功能需求.md）。
import { ref, computed } from 'vue';
import { electronApi } from '../utils/electron';
import { ROUTE_META, useWorkspaceStore } from '../stores/workspace';
import { useAccountStore } from '../stores/account';
import type { AccountInfo, ContentType } from '../../types';

export type SearchKind = 'module' | 'draft' | 'account' | 'bookmark' | 'history';

export interface SearchResult {
  kind: SearchKind;
  /** 结果内唯一 key（用于 v-for 与 active 比对） */
  key: string;
  /** 所属分组名（功能模块 / 草稿 / 账号 / 书签 / 历史） */
  group: string;
  title: string;
  subtitle?: string;
  icon: string;
  /** 打开动作负载 */
  action:
    | { type: 'module'; route: string }
    | { type: 'draft'; id: string; contentType: ContentType }
    | { type: 'account'; accountId: string }
    | { type: 'url'; url: string };
}

/** 每源最多展示条数（PRD：本期截断 8 条，"查看全部"留后续迭代） */
const LIMIT = 8;
/** 输入防抖（PRD：debounce ~150ms） */
const DEBOUNCE = 150;

/** 平台 key → 中文名（仅用于账号结果副标题，避免依赖异步 listPlatforms） */
const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  bilibili: 'B站',
  wechat_channels: '视频号',
  wechat_official: '公众号',
  weibo: '微博',
  zhihu: '知乎',
  toutiao: '头条',
};

function platformLabel(p: string): string {
  return PLATFORM_LABEL[p] ?? p;
}

function contentTypeLabel(c: ContentType): string {
  return c === 'video' ? '视频' : c === 'image' ? '图文' : c === 'article' ? '文章' : c;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function matchAccount(a: AccountInfo, lower: string): boolean {
  return (
    (a.nickname || '').toLowerCase().includes(lower) ||
    (a.remark || '').toLowerCase().includes(lower) ||
    (a.platformAccountId || '').toLowerCase().includes(lower) ||
    (a.userId || '').toLowerCase().includes(lower) ||
    platformLabel(a.platform).toLowerCase().includes(lower)
  );
}

export function useGlobalSearch() {
  const store = useWorkspaceStore();
  const accountStore = useAccountStore();

  const query = ref('');
  const loading = ref(false);
  const open = ref(false);
  const results = ref<SearchResult[]>([]);
  const activeIndex = ref(0);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const hasQuery = computed(() => query.value.trim().length > 0);
  const resultCount = computed(() => results.value.length);

  async function runSearch() {
    const q = query.value.trim();
    if (!q) {
      results.value = [];
      loading.value = false;
      open.value = false;
      return;
    }
    loading.value = true;
    open.value = true;
    try {
      const [drafts, accounts, bookmarks, history] = await Promise.all([
        electronApi.draft.search(q),
        electronApi.listAccounts(),
        electronApi.browserHistory.searchBookmarks(q),
        electronApi.browserHistory.searchHistory(q, 20),
      ]);
      const lower = q.toLowerCase();
      const out: SearchResult[] = [];

      // 1) 功能模块（最前）：匹配标题或路由 path
      for (const [route, meta] of Object.entries(ROUTE_META)) {
        if (meta.title.toLowerCase().includes(lower) || route.toLowerCase().includes(lower)) {
          out.push({
            kind: 'module',
            key: `module:${route}`,
            group: '功能模块',
            title: meta.title,
            subtitle: route,
            icon: meta.icon,
            action: { type: 'module', route },
          });
        }
      }

      // 2) 草稿
      for (const d of drafts.slice(0, LIMIT)) {
        const snippet = d.formData?.content ? ' · ' + truncate(d.formData.content, 36) : '';
        out.push({
          kind: 'draft',
          key: `draft:${d.id}`,
          group: '草稿',
          title: d.title || '(无标题草稿)',
          subtitle: contentTypeLabel(d.contentType) + snippet,
          icon: '📝',
          action: { type: 'draft', id: d.id, contentType: d.contentType },
        });
      }

      // 3) 账号（客户端过滤，复用已加载或实时拉取）
      for (const a of accounts.filter((acc) => matchAccount(acc, lower)).slice(0, LIMIT)) {
        const sub = [platformLabel(a.platform), a.remark || a.platformAccountId || '']
          .filter(Boolean)
          .join(' · ');
        out.push({
          kind: 'account',
          key: `account:${a.id}`,
          group: '账号',
          title: a.nickname || '(未命名账号)',
          subtitle: sub || undefined,
          icon: '👤',
          action: { type: 'account', accountId: a.id },
        });
      }

      // 4) 书签
      for (const b of bookmarks.slice(0, LIMIT)) {
        out.push({
          kind: 'bookmark',
          key: `bm:${b.id}`,
          group: '书签',
          title: b.title || b.url,
          subtitle: b.siteName || b.url,
          icon: '🔖',
          action: { type: 'url', url: b.url },
        });
      }

      // 5) 历史
      for (const h of history.slice(0, LIMIT)) {
        out.push({
          kind: 'history',
          key: `hist:${h.id}`,
          group: '历史',
          title: h.title || h.url,
          subtitle: h.url,
          icon: '🕘',
          action: { type: 'url', url: h.url },
        });
      }

      results.value = out;
      activeIndex.value = 0;
    } catch (e) {
      console.error('[globalSearch] 搜索失败', e);
      results.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 输入变化：防抖触发搜索（空输入直接关闭面板） */
  function onInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!query.value.trim()) {
      results.value = [];
      open.value = false;
      return;
    }
    open.value = true;
    debounceTimer = setTimeout(runSearch, DEBOUNCE);
  }

  /** 聚焦搜索框：若有残留关键词，立即重跑并展开面板（便于再次查看结果） */
  function onFocus() {
    if (query.value.trim()) {
      open.value = true;
      void runSearch();
    }
  }

  /** 选中某结果：执行对应导航并关闭面板 */
  function select(r: SearchResult) {
    switch (r.action.type) {
      case 'module':
        store.openSystemTab(r.action.route);
        break;
      case 'draft':
        store.openDraftTab({ id: r.action.id, contentType: r.action.contentType, title: r.title });
        break;
      case 'account':
        store.openSystemTab('/accounts');
        accountStore.locateAccount(r.action.accountId);
        break;
      case 'url':
        store.openBrowserWithUrl(r.action.url);
        break;
    }
    close();
  }

  function close() {
    open.value = false;
    results.value = [];
    activeIndex.value = 0;
  }

  /** 键盘上下移动高亮项（循环） */
  function move(delta: number) {
    const n = results.value.length;
    if (n === 0) return;
    activeIndex.value = (activeIndex.value + delta + n) % n;
  }

  function setActive(i: number) {
    activeIndex.value = i;
  }

  function selectActive() {
    const r = results.value[activeIndex.value];
    if (r) select(r);
  }

  return {
    query,
    loading,
    open,
    results,
    activeIndex,
    hasQuery,
    resultCount,
    onInput,
    onFocus,
    runSearch,
    select,
    close,
    move,
    setActive,
    selectActive,
  };
}
