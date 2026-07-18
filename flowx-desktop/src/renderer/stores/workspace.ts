import { defineStore } from 'pinia';

/* ============================================================
   任务选项卡工作区 store
   - 系统 tab：左侧竖栏任意项 / 「+」菜单 → 顶部开或激活一个 tab
   - 账号 tab：M2 阶段由主进程 webview 内嵌（此处仅建模 + 占位）
   - 核心约束：每个 tab = 独立组件实例（按 id 用 :key + v-show 保活），
     绝不用 <KeepAlive>，否则 /publish/* 三条路由共用的 Publish.vue 会串状态
   ============================================================ */

export interface WorkspaceTab {
  /** 系统: `sys:${route}`  账号: `acct:${accountId}` */
  id: string;
  kind: 'system' | 'account';
  route?: string;
  accountId?: string;
  title: string;
  icon?: string;
  /** 账号创作中心隔离徽章文案（M2 注入） */
  envBadge?: string;
  /** 含未保存内容（发布类），M4 用于关闭确认 */
  dirty?: boolean;
  /** 是否可关闭（仪表盘默认不可关） */
  closable?: boolean;
  /** 透传给页面组件的 props（例：发布页用 contentType 区分视频/图文/文章） */
  props?: Record<string, unknown>;
}

export interface RouteMetaItem {
  title: string;
  icon: string;
  props?: Record<string, unknown>;
  closable?: boolean;
}

/** 系统路由 → tab 元信息（单一真相源，侧栏/任务条/「+」菜单共用） */
export const ROUTE_META: Record<string, RouteMetaItem> = {
  '/dashboard': { title: '仪表盘', icon: '🏠', closable: false },
  '/accounts': { title: '账号管理', icon: '👤' },
  '/publish/video': { title: '发布视频', icon: '🎬', props: { contentType: 'video' } },
  '/publish/image': { title: '发布图文', icon: '🖼️', props: { contentType: 'image' } },
  '/publish/article': { title: '发布文章', icon: '📄', props: { contentType: 'article' } },
  '/publish/history': { title: '发布历史', icon: '🕘' },
  '/drafts': { title: '草稿箱', icon: '📝' },
  '/browser': { title: '浏览器', icon: '🌐' },
  '/settings/environments': { title: '环境配置', icon: '🌍' },
  '/settings/proxies': { title: '代理 IP 设置', icon: '🔀' },
  '/settings/api': { title: '对外接口', icon: '🔌' },
  '/settings/logs': { title: '日志管理', icon: '📜' },
};

/** 「+」菜单可添加的路由顺序 */
export const SYSTEM_ROUTES: string[] = Object.keys(ROUTE_META);

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    tabs: [] as WorkspaceTab[],
    activeId: '' as string,
    MAX: 20,
  }),
  getters: {
    activeTab: (s) => s.tabs.find((t) => t.id === s.activeId) ?? null,
    systemTabs: (s) => s.tabs.filter((t) => t.kind === 'system'),
    accountTabs: (s) => s.tabs.filter((t) => t.kind === 'account'),
    canAdd: (s) => s.tabs.length < s.MAX,
  },
  actions: {
    /** 打开/激活系统任务 tab。已存在则仅激活（去重）。达上限返回 false。
     *  extraProps 会合并进 tab.props，用于页面内跳转携带参数（如草稿 url）。 */
    openSystemTab(route: string, extraProps?: Record<string, unknown>): boolean {
      const id = `sys:${route}`;
      const existing = this.tabs.find((t) => t.id === id);
      if (existing) {
        this.activeId = id;
        return true;
      }
      if (!this.canAdd) return false;
      const meta = ROUTE_META[route];
      this.tabs.push({
        id,
        kind: 'system',
        route,
        title: meta?.title ?? route,
        icon: meta?.icon,
        props: { ...(meta?.props || {}), ...(extraProps || {}) },
        closable: meta?.closable ?? true,
      });
      this.activeId = id;
      return true;
    },

    /** 打开草稿编辑 tab：独立实例（不去重），便于同时编辑多个草稿；参数走 tab.props */
    openDraftTab(payload: { id: string; contentType: 'video' | 'image' | 'article'; title?: string }): boolean {
      const id = `draft:${payload.id}`;
      if (!this.canAdd) return false;
      const route = `/publish/${payload.contentType}`;
      const meta = ROUTE_META[route];
      this.tabs.push({
        id,
        kind: 'system',
        route,
        title: meta?.title ? `编辑草稿 · ${meta.title}` : '编辑草稿',
        icon: '✏️',
        props: { contentType: payload.contentType, draftId: payload.id },
        closable: true,
      });
      this.activeId = id;
      return true;
    },

    /** 打开/激活账号创作中心 tab（M2 真正内嵌 webview；M1 仅建模 + 占位） */
    openAccountTab(accountId: string, meta: { title: string; icon?: string; envBadge?: string }): boolean {
      const id = `acct:${accountId}`;
      const existing = this.tabs.find((t) => t.id === id);
      if (existing) {
        this.activeId = id;
        return true;
      }
      if (!this.canAdd) return false;
      this.tabs.push({
        id,
        kind: 'account',
        accountId,
        title: meta.title,
        icon: meta.icon ?? '📕',
        envBadge: meta.envBadge,
        closable: true,
      });
      this.activeId = id;
      return true;
    },

    activate(id: string) {
      if (this.tabs.some((t) => t.id === id)) this.activeId = id;
    },

    /** 关闭 tab；关闭激活项时回退到相邻项，或全部关闭则开 dashboard */
    close(id: string) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const tab = this.tabs[idx];
      if (tab.closable === false) return; // 仪表盘不可关
      this.tabs.splice(idx, 1);
      if (this.activeId === id) {
        const fallback = this.tabs[Math.min(idx, this.tabs.length - 1)];
        if (fallback) {
          this.activeId = fallback.id;
        } else {
          this.openSystemTab('/dashboard');
        }
      }
    },

    /** 关闭其他标签页：保留目标 tab + 所有不可关闭 tab（仪表盘） */
    closeOthers(exceptId: string) {
      const target = this.tabs.find((t) => t.id === exceptId);
      if (!target) return;
      this.tabs = this.tabs.filter((t) => t.id === exceptId || t.closable === false);
      this.activeId = exceptId;
    },

    /** 关闭右侧标签页：保留目标及其左侧 + 不可关闭 tab */
    closeRight(fromId: string) {
      const idx = this.tabs.findIndex((t) => t.id === fromId);
      if (idx === -1) return;
      this.tabs = this.tabs.filter((t, i) => i <= idx || t.closable === false);
      if (!this.tabs.some((t) => t.id === this.activeId)) {
        this.activeId = fromId;
      }
    },

    /** 关闭所有标签页：保留不可关闭 tab（仪表盘），全部可关则回退到仪表盘 */
    closeAll() {
      const keep = this.tabs.filter((t) => t.closable === false);
      if (keep.length > 0) {
        this.tabs = keep;
        if (!keep.some((t) => t.id === this.activeId)) {
          this.activeId = keep[keep.length - 1].id;
        }
      } else {
        this.openSystemTab('/dashboard');
      }
    },

    /** 启动默认：无 tab 时开仪表盘 */
    ensureDefault() {
      if (this.tabs.length === 0) this.openSystemTab('/dashboard');
    },

    markDirty(id: string, dirty: boolean) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) t.dirty = dirty;
    },

    setEnvBadge(id: string, badge: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) t.envBadge = badge;
    },

    /** M4：从持久化恢复任务选项卡布局（账号 tab 内嵌视图会随之重建） */
    restoreTabs(payload: { tabs: Array<Partial<WorkspaceTab>>; activeId: string }): void {
      const incoming = Array.isArray(payload.tabs) ? payload.tabs : [];
      const valid = incoming
        .filter((t): t is WorkspaceTab => !!t && !!t.id && (t.kind === 'system' || t.kind === 'account'))
        .map((t) => ({ ...(t as WorkspaceTab), dirty: false })); // 恢复时清掉脏标记（无法确认真实状态）
      if (valid.length === 0) {
        this.openSystemTab('/dashboard');
        return;
      }
      this.tabs = valid;
      const active = valid.find((t) => t.id === payload.activeId);
      this.activeId = active ? active.id : valid[0].id;
    },

    /** M4：生成可持久化的布局快照（剔除运行时字段） */
    snapshot(): { tabs: WorkspaceTab[]; activeId: string } {
      const raw = {
        tabs: this.tabs.map((t) => ({
          id: t.id,
          kind: t.kind,
          route: t.route,
          accountId: t.accountId,
          title: t.title,
          icon: t.icon,
          envBadge: t.envBadge,
          closable: t.closable,
          // ⚠️ 关键：store 中的 tab 是 Vue 响应式代理，嵌套的 props 也是 Proxy。
          // ipcRenderer.invoke 用结构化克隆序列化参数，遇到 Proxy 会抛
          // "An object could not be cloned"（M4 存盘一触发就崩的根因）。
          // 经 JSON 往返剥离响应式代理，确保传给主进程的是纯数据。
          props: t.props ? JSON.parse(JSON.stringify(t.props)) : undefined,
        })),
        activeId: this.activeId,
      };
      return raw;
    },
  },
});
