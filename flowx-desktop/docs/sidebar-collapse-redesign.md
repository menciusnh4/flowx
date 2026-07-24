# FlowX 侧栏收起效果 · 最终方案

> 角色：UI Designer（像素君） · 日期：2026-07-24 · 文件：`src/renderer/assets/styles.css`
> **权威依据**：`flowx-ui-redesign/sidebar-collapse-prototype.html`（UI 给出的原型，最终以它为准）

## 结论

侧栏收起效果**对齐 UI 原型**：展开 180px → 收起 64px，图标整体**居中**、Logo 收为 40px「F」方块居中、Footer 收为头像居中，全程 `0.3s` 平滑过渡，无挤压 / 无变形 / Logo 不下落。

## 之前的错误尝试（已作废）

- `ecd9ae3` / `8eb1bb8` 把收起态做成了 **72px + 图标靠左 20px 的「零漂移」列**，与 UI 原型相反，用户确认「丑陋 / 挤压 / 变形」。已废弃。
- 早期版本用 `position:absolute` 隐藏文字，脱离文档流导致布局抖动（疑似 Logo 下落的诱因）。最终改用 `opacity:0 + width:0 + overflow:hidden`，不脱离文档流。

## 最终改动清单（`src/renderer/assets/styles.css`）

1. `.sidebar` 已有 `transition: width .3s var(--ease), padding .3s var(--ease);` —— 平滑收窄，消除挤压跳变。
2. `.sidebar.collapsed`：`width:64px; padding:18px 12px; gap:8px`（对齐原型）。
3. `.sidebar.collapsed .sidebar-logo`：`justify-content:center; padding:2px 0 16px` —— 40px Logo 方块居中，文字 `opacity:0; width:0` 收起。
4. `.sidebar.collapsed .nav-item`：`justify-content:center; padding:0; gap:0` —— 图标居中。
5. `.sidebar.collapsed .nav-item .label`：`opacity:0; width:0; overflow:hidden` —— 平滑收宽为 0（非 absolute）。
6. `.sidebar.collapsed .nav-sub`：`display:none`（收起态用悬浮飞出面板代替内联展开）。
7. `.sidebar.collapsed .nav-label`：分组标题 `opacity:0; height:0` 隐藏，避免溢出窄栏。
8. `.sidebar.collapsed .sidebar-foot` / `.side-user` / `.collapse-toggle`：均 `justify-content:center; padding` 收为居中，文字 `width:0` 收起。
9. 收起态交互保留：叶子项 hover → 右侧提示气泡；父级（工作台 / 一键发布 / 系统配置）hover → 右侧飞出子面板（点击父级可钉住）。

## 审查 / 验证

- 参照原型（权威）：`flowx-ui-redesign/sidebar-collapse-prototype.html`
- 本地可审查副本：`flowx-desktop/prototype/sidebar-collapse.html`（已同步为同一套居中收拢规则）
- 真机验证（Electron 多窗口老坑）：先 `Stop-Process -Name electron -Force` 清残留，再 `npm run dev`，只看新弹出的 FlowX 窗口。点左下「收起菜单」观察：平滑收窄、图标居中不跳、Logo 居中不下落、hover 出气泡 / 飞出面板。

## 落盘提交

- `ecd9ae3` + `8eb1bb8`（错误尝试，已作废但仍保留在历史上）
- 最终修正：重港口 styles.css 收起态为「居中 64px」+ 同步 `prototype/sidebar-collapse.html`（待提交）
