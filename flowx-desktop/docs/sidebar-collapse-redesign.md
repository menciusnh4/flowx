# FlowX 侧栏收起效果重设计方案

> 角色：UI Designer（像素君） · 日期：2026-07-24 · 文件：`src/renderer/assets/styles.css`

## 问题诊断

1. **"被挤压"感** —— `.sidebar` 本身没有 `transition: width`，宽度从 180px 瞬间塌缩到 64px，所有文字 / logo 同帧 `opacity:0` / `display:none`，毫无过渡。
2. **"图标位置明显变化"** —— 收起态 `.sidebar.collapsed .nav-item { justify-content:center; padding:0 }` 把图标从展开态的「左对齐 + padding 12px」硬切到「正中央」，这个对齐方式突变导致图标在切换瞬间从左跳到正中，是最刺眼的漂移。

## 设计目标

- **图标零漂移**：展开 / 收起两态图标落在同一左缩进，切换时只淡出文字、图标纹丝不动。
- **平滑过渡**：侧栏宽度加 `transition`，消除挤压感。
- **视觉整洁**：收起态排成一条对齐的图标列（导航图标 / footer 头像 / 收起按钮统一左缩进）。
- **保留优良交互**：叶子项 hover 提示气泡、父级悬浮飞出子面板均不动。

## 改动清单（`src/renderer/assets/styles.css`）

1. `.sidebar` 增加 `transition: width .3s var(--ease), padding .3s var(--ease);` —— 消除挤压。
2. 展开态 `.nav-item` padding 改为 `0 14px 0 20px`，建立固定「图标列」左缩进 20px。
3. `.sidebar.collapsed` 栏宽 `64 → 68px`，`padding: 18px 0`。
4. 收起态 `.nav-item` 改为 `justify-content: flex-start; padding: 0 0 0 20px;` —— 与展开态同基准 → 零漂移（核心修复）。
5. 收起态 `.label` 改用 `opacity + translateX(-8px)` 平滑淡出滑走（替代瞬间隐藏）。
6. `.sidebar-foot .side-user` / `.collapse-toggle` 收起态统一 `justify-content: flex-start; padding-left: 20px`，与图标列对齐。
7. `.side-user-name` / `.tg-label` 收起态用 `opacity + translateX` 平滑淡出。
8. 提示气泡 `left` 微调为 `calc(100% + 12px)` 适配新栏宽。

## 验证步骤

- 仅渲染层 CSS 改动，无需主进程重启。
- 但历史有「多 electron 窗口 HMR 不推送」坑：先 `Stop-Process -Name electron -Force` 杀光残留，再 `npm run dev`，只看**新弹出**的 FlowX 窗口。
- 点左下角「收起菜单」观察：① 侧栏平滑收窄；② 图标位置稳定不跳；③ hover 叶子项出提示气泡；④ 父级 hover 飞出子面板。

## 可继续优化（可选）

- 收起态图标 hover 轻微放大（scale 1.06）增强反馈。
- 切换整段用更细腻缓动。
- 若坚持收起态图标「居中」而非左列，可让两态都居中（需同步展开态图标列），但会带来轻微横移——当前方案优先零漂移。
