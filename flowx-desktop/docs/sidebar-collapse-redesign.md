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
3. `.sidebar.collapsed` 栏宽 `64 → 72px`，`padding: 18px 0 18px 14px`（**关键**：左内边距与展开态一致 = 14px，使所有图标 x 坐标在两态相同）。
4. 收起态 `.nav-item` 保持 `justify-content: flex-start; padding: 0 0 0 20px;` —— 图标左缘 x = 14(侧栏) + 20 = 34px，与展开态完全一致 → 零漂移（核心修复）。
5. 收起态 `.label` / `.logo-text` 改用 `opacity + translateX(-8px)` 平滑淡出滑走（替代瞬间隐藏）。
6. **footer 与开关同步对齐**：收起态 `.sidebar-foot` 左内边距 = 12px（同展开）、`.side-user` = 11px（同展开）、`.collapse-toggle` = 10px（同展开）—— 头像 x=37px、开关图标 x=24px 两态一致，同样零漂移。
7. `.side-user-name` / `.tg-label` / `.nav-label`(分组标题) 收起态淡出 / 隐藏，避免文字溢出窄栏。
8. 提示气泡 `left: calc(100% + 12px)` 适配新栏宽。

## 验证步骤

- 仅渲染层 CSS 改动，无需主进程重启。
- 但历史有「多 electron 窗口 HMR 不推送」坑：先 `Stop-Process -Name electron -Force` 杀光残留，再 `npm run dev`，只看**新弹出**的 FlowX 窗口。
- 点左下角「收起菜单」观察：① 侧栏平滑收窄；② 图标位置稳定不跳；③ hover 叶子项出提示气泡；④ 父级 hover 飞出子面板。

## QA 复查（第二轮：零漂移实测）

第一轮提交（`ecd9ae3`）后被复查发现一个**漂移遗漏**：当时只把 `.nav-item` 在两态都设成 `padding-left:20px`，却忽略了展开态 `.sidebar` 自身有 `padding:18px 14px`（水平 14px），而收起态被设成 `padding:18px 0`（水平 0）。容器左内边距不一致，导致图标实际 x 仍漂移：

| 元素 | 展开 x | 收起 x（旧） | 漂移 |
|---|---|---|---|
| 导航图标 | 14+20 = 34 | 0+20 = 20 | 14px |
| 头像 | 14+12+11 = 37 | 0+0+20 = 20 | 17px |
| 开关图标 | 14+10 = 24 | 0+20 = 20 | 4px |

**修正逻辑**：零漂移的本质是「两态每个嵌套层的左内边距逐项相等」，而不是只对齐叶子节点。修正后收起态逐项镜像展开态内边距（侧栏 14 / foot 12 / user 11 / toggle 10），栏宽增到 72px 容纳 30px 头像不溢出。复测 x 全部恒定：导航 34 / 头像 37 / 开关 24，切换时图标纹丝不动（见交互原型）。

## 可继续优化（可选）

- 收起态图标 hover 轻微放大（scale 1.06）增强反馈。
- 切换整段用更细腻缓动。
- 若坚持收起态图标「居中」而非左列，可让两态都居中（需同步展开态图标列），但会带来轻微横移——当前方案优先零漂移。
