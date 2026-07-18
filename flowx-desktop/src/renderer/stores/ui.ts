import { defineStore } from 'pinia';

/**
 * 全局 UI 状态管理
 *
 * 主要用途：统一管理所有会"浮在页面上方"的弹层（下拉菜单、对话框、抽屉等），
 * 用于控制 WebContentsView 等原生控件的显隐，避免原生控件遮挡 HTML 弹层。
 *
 * 使用方式：
 *   const uiStore = useUiStore();
 *   uiStore.pushOverlay('my-dropdown');  // 弹层出现
 *   uiStore.popOverlay('my-dropdown');   // 弹层消失
 *
 *   // 在 Browser.vue 中监听：
 *   watch(() => uiStore.overlayCount, (count) => {
 *     if (count > 0) hideBrowserView();
 *     else showBrowserView();
 *   });
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    // 当前激活的弹层标识列表（用数组而不是计数器，方便调试和排查问题）
    _overlays: [] as string[],
  }),

  getters: {
    /** 当前激活的弹层数量 */
    overlayCount: (state) => state._overlays.length,

    /** 是否有弹层激活 */
    hasOverlay: (state) => state._overlays.length > 0,
  },

  actions: {
    /**
     * 推入一个弹层（弹层出现时调用）
     * @param key 弹层标识，用于排查和去重
     */
    pushOverlay(key: string) {
      // 防止重复推入
      if (!this._overlays.includes(key)) {
        this._overlays.push(key);
      }
    },

    /**
     * 弹出一个弹层（弹层消失时调用）
     * @param key 弹层标识
     */
    popOverlay(key: string) {
      const idx = this._overlays.indexOf(key);
      if (idx !== -1) {
        this._overlays.splice(idx, 1);
      }
    },

    /**
     * 检查指定弹层是否激活
     */
    isOverlayActive(key: string): boolean {
      return this._overlays.includes(key);
    },

    /**
     * 清空所有弹层（极端情况兜底）
     */
    clearOverlays() {
      this._overlays = [];
    },
  },
});
