/**
 * 主窗口布局常量（主进程 / 渲染进程共享同一套尺寸，确保原生层与 Vue 层对齐）。
 * 数值须与 src/renderer/assets/styles.css + App.vue 的实际像素保持一致：
 *   - 侧栏宽度 250px
 *   - 全局任务选项卡条高度 48px
 *   - 账号信息条高度 40px
 *   - 账号 inner 子页签条高度 36px
 */
export const SIDEBAR_W = 250;
export const TASKBAR_H = 48;
export const ACCOUNT_INFO_H = 40;
export const ACCOUNT_INNER_H = 36;

/** 弹窗创作中心：tab 栏(38) + 工具条(36) 偏移 */
export const CREATOR_TAB_BAR_H = 38;
export const CREATOR_TOOLBAR_H = 36;
