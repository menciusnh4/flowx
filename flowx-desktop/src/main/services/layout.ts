/**
 * 主窗口布局常量（主进程 / 渲染进程共享同一套尺寸，确保原生层与 Vue 层对齐）。
 * 数值须与 src/renderer/assets/styles.css + App.vue 的实际像素保持一致：
 *   - 侧栏展开宽度 180px / 收起宽度 64px（详见 App.vue 的 .sidebar.collapsed）
 *   - 全局任务选项卡条高度 48px
 *   - 账号信息条高度 40px
 *   - 账号 inner 子页签条高度 36px
 */
export const SIDEBAR_W = 180;
/** 侧栏收起态宽度（仅图标轨）；实时浏览器原生层走 ResizeObserver 自动跟移，此常量仅供遗留 WebContentsView 首屏兜底 */
export const SIDEBAR_W_COLLAPSED = 64;
export const TASKBAR_H = 48;
export const ACCOUNT_INFO_H = 40;
export const ACCOUNT_INNER_H = 36;

/** 弹窗创作中心：tab 栏(38) + 工具条(36) 偏移 */
export const CREATOR_TAB_BAR_H = 38;
export const CREATOR_TOOLBAR_H = 36;
