# TEP — 全局多任务选项卡 & 账号创作中心（技术实施方案）

> 文档状态：Draft v1（技术实施方案）｜ 关联 PRD：`PRD-全局多任务选项卡.md`（v3）
> 作者：高级开发工程师（吴八哥）｜ 日期：2026-07-16
> 技术栈：Electron + Vue3 + Pinia + vue-router + TypeScript + Vite + Element Plus

---

## 0. 目标与范围

把"点击左侧导航 / 进入账号创作中心"从"路由切换 / 弹独立窗口"升级为**主窗口内一条常驻任务选项卡栏**：

- **系统任务 tab**：左侧竖栏任意项 → 顶部开/激活一个 tab；切换不卸载、已填表单/滚动 100% 保留（头号痛点）。
- **账号创作中心 tab**：替代独立弹窗，内嵌进主窗口内容区；底层仍复用 `persist:account_${id}` 隔离 + `BrowserEnvService`。
- **账号内子页签**：创作中心 tab 内部复用现有 inner tab（新增/关闭/切换/前进后退/`target=_blank` 新 inner tab）。

**Non-goals（与 PRD 一致）**：左侧竖栏不动、不渲染 FlowX 自有粉丝看板、不做 tab 拖出独立窗口、不做跨账号会话合并。

---

## 1. 现状代码盘点（已实地确认）

| 关注点 | 现状 | 出处 |
|---|---|---|
| 应用外壳 | `App.vue`：`.sidebar` + `.content > .topbar + <router-view>` | `src/renderer/App.vue` |
| 路由 | `/publish/video\|image\|article` **共用 `Publish.vue`**；其余各路由独立组件 | `src/renderer/router/index.ts` |
| 弹窗 | `CreatorTabWindow`：独立 `BrowserWindow` + `WebContentsView`×N + 协议渲染 tab 栏 + IPC `creator-tab:*` | `src/main/windows/CreatorTabWindow.ts` |
| 入口 | `AccountPanel.openCreator` → `electronApi.openCreator` → `account:openCreator` → `getOrCreateCreatorWindow` | `AccountPanel.vue:575` / `electron.ts:60` / `account.ts:35` |
| 隔离 | `session.fromPartition('persist:account_${id}')` + `BrowserEnvService.applyEnvironment` | `CreatorTabWindow.ts:399` |
| 状态管理 | **Pinia 已启用**（`stores/account\|draft\|env\|publish.ts`） | `package.json` + `src/renderer/stores/` |
| 主窗口 | 单 `BrowserWindow`，preload 已桥接；`getMainWindow()` 可取引用 | `MainWindow.ts:114` |

---

## 2. 架构总览

**关键判断：两类 tab 用两套宿主机制，不能混。**

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ 侧栏(不动)│  任务选项卡条 (48px)  [系统tab…][📕账号A创作中心🔒][+]  [🔍]  │
│  250px   ├──────────────────────────────────────────────────────────┤
│          │  内容区（flex:1, min-height:0）                            │
│          │  ├─ 激活=系统 tab → Vue 组件实例（v-show 保活，状态不丢）   │
│          │  └─ 激活=账号 tab → 账号信息条+inner子页签(Vue)             │
│          │                    + WebContentsView(原生层, bounds=内容矩形)│
└──────────┴──────────────────────────────────────────────────────────┘
```

- **系统 tab = 纯 Vue 层**：渲染进程内用「按 tabId 的实例注册表」驱动，激活态 `v-show=true`、其余 `v-show=false`（实例不卸载 → 状态天然保留）。
- **账号 tab = 原生层 + Vue 层**：Vue 渲染账号信息条 + inner 子页签 + 一块**占位 div**；主进程把该账号的 `WebContentsView` 以 `addChildView` 挂到主窗口 `contentView`，`setBounds` 到内容矩形，叠在占位 div 之上。非激活时 `setVisible(false)` 让 Vue 层透出。

---

## 3. 关键技术决策（必须拍板的点）

### 3.1 状态保持：绝不能用 `<KeepAlive>`，必须用「按 tabId 实例模型」
**原因（已确认陷阱）**：`/publish/video`、`/publish/image`、`/publish/article` 三条路由**指向同一个 `Publish.vue` 组件**。`<KeepAlive include="Publish">` 只会缓存**一个**组件实例 → 三个发布 tab 共享同一份表单状态（视频填的串到文章）。

**方案**：自建 `WorkspaceView` 容器，`tabStore.tabs` 中每个系统 tab 渲染一个**独立组件实例**，用 `:key="tab.id"` 强制 Vue 区分。整组用 `v-show` 显隐，激活态可见、其余隐藏但实例存活。每个 tab 状态彼此独立、切换不丢。

- 路由表组件解析：`router/index.ts` 导出 `routeComponentMap: Record<path, RouteRecord['component']>`，`WorkspaceView` 据 tab.route 取 lazy component 并 `markRaw` 缓存已解析组件，避免重复 import。
- 路由仍保留（URL 同步 + 刷新恢复），但**渲染由 tabStore 驱动**，不再由 `<router-view>` 直接替换。

### 3.2 账号 WebContentsView 内嵌主窗口（宿主替换）
复用 `CreatorTabWindow` 的视图逻辑，抽成**宿主无关**的 `AccountWebViewController`：
- 构造参数传入一个 `Host` 接口：`{ addChildView(v), removeChildView(v), setBounds(v, rect), getContentRect(): Rect }`。
- 现有 `CreatorTabWindow` 改为 `Host=独立BrowserWindow` 的薄适配；新增 `MainWindowHost` 适配主窗口 `contentView`。
- **bounds 公式**（内容矩形）：
  - `x = 250`（侧栏宽）
  - `y = 48`（全局任务条高）
  - `width = winW - 250`
  - `height = winH - 48`
  - 账号 tab 内还有信息条(40)+inner 条(36)，由 Vue 层占位，原生 view 直接铺满内容矩形（信息条/inner 条是 Vue 控件，view 在它们下方的占位区绘制；切换 inner tab 时 view bounds 不变，仅 `setVisible`/换 active inner view）。
- **遮挡防护**：维护"当前激活账号 tab"；激活系统 tab 时，对**所有**账号 view `setVisible(false)`；激活账号 tab 时只显示该账号 active inner view，其余 `setVisible(false)`。

### 3.3 隔离能力零改动
`session.fromPartition('persist:account_${id}')` + `BrowserEnvService.applyEnvironment` 原样复用，仅把"为哪个宿主建 view"换掉。环境未配置时，`🔒` 徽章显示"未配置隔离"(warning)，不隐藏。

### 3.4 状态管理：新增 `stores/workspace.ts`（Pinia）
```ts
interface TabState {
  id: string;            // 系统: `sys:${route}`  账号: `acct:${accountId}`
  kind: 'system' | 'account';
  route?: string;        // 系统 tab 的路由
  accountId?: string;    // 账号 tab
  title: string;
  icon?: string;
  envBadge?: string;     // 账号 tab 隔离徽章文案
  dirty?: boolean;       // 含未保存内容（发布类）
}
state: { tabs: TabState[]; activeId: string; MAX = 20 }
actions: openSystemTab(route), openAccountTab(accountId, meta),
         activate(id), close(id), canAdd(): boolean
getters: activeTab, systemTabs, accountTabs
```
- 默认启动开 `dashboard`；`openXxx` 对已存在 id 仅 `activate`（去重）。
- `canAdd()` 在达 20 时返回 false → UI 禁用「+」+ Toast。

---

## 4. 实施阶段（建议 4 个 Phase，逐步可验证）

### Phase 0 — 基础设施
- 新增 `src/renderer/stores/workspace.ts`（Pinia store，含 TableState/dirty/MAX）。
- `router/index.ts` 导出 `routeComponentMap`（路径→lazy component），保留原 routes 不变。
- `src/types/index.ts` 增加 `WorkspaceTab` / 账号 webview 相关类型。

### Phase 1 — 系统任务 tab（核心痛点先解）
- 新增 `WorkspaceTabBar.vue`（48px：左 tab 区 flex:1 横向滚动、右搜索 280px；tab 项 32px、激活指示条、关闭 ×、含未保存 ●、`+` 按钮达限禁用）。
- 新增 `WorkspaceView.vue`：`tabStore.tabs` 映射为 `<div v-show="id===activeId" :key="id"><component :is="comp" v-bind="props"/></div>`；系统 tab 走此处，账号 tab 走 `AccountWorkspace`。
- 改 `App.vue`：插入 `WorkspaceTabBar`、把 `<router-view>` 换成 `<WorkspaceView>`、搜索框迁入任务条、移除 `.topbar` 标题。
- 改侧栏 `go()`：改为 `tabStore.openSystemTab(index)`（保留展开逻辑），不再直接 `router.push`（URL 仍由 store 同步）。
- **验收**：开「发布文章」打字 → 切「草稿箱」→ 切回 → 内容原样保留；视频/图文/文章 三个 tab 状态互不影响。

### Phase 2 — 账号创作中心 tab（主窗口内嵌 webview）
- 抽 `src/main/services/AccountWebViewController.ts`（宿主无关）：createTab/activateTab/closeTab + 前进后退刷新 + `target=_blank` 新 inner tab + partition + env + 通知事件。
- 新增 `src/main/services/MainWindowWebViewHost.ts`：实现 `Host` 接口（用 `getMainWindow().contentView`）。
- 新增主进程控制器 `WorkspaceWebViewController`（按 accountId 持有 `AccountWebViewController` 实例），监听主窗口 resize / 激活账号变化 → 重算 `setBounds` / `setVisible`。
- 新增 `AccountWorkspace.vue`：账号信息条（头像/昵称/🔒 环境全称/刷新/在浏览器打开）+ inner 子页签条（创作首页/笔记管理/数据分析/新开网页/`+`）+ 占位 div。
- IPC 新增 `workspace-webview:*` 命名空间（ensure / activateInner / setRect / navigate / back / forward / reload / newInner）+ 事件 `workspace-webview:tabs` / `:url`。复用 `creator-tab:*` 的事件结构，路由改为 accountId-based（不再 `winByWebContentsId`）。

### Phase 3 — 入口切换 & 弹窗移除
- 改 `AccountPanel.openCreator` → `electronApi.openAccountTab(row.id)` → `account:openAccountTab`（主进程 `ensure` 创建 webview + 通知渲染端 `tabStore.openAccountTab`）。
- 移除 `getOrCreateCreatorWindow` 的独立弹窗创建路径（过渡期可保留 `CreatorTabWindow` 作为 `Host` 适配但不再被入口调用；确认稳定后整文件删除）。
- `preload/index.ts` 暴露 `workspaceWebview` API + `onTabsUpdate/onUrlUpdate`；`electron.ts` 增加 `openAccountTab` + `workspaceWebview.*`。

### Phase 4 — 边界与打磨（对应 PRD Should/Could）
- 任务条溢出：横向滚动 + 两侧 24px 渐隐遮罩（CSS mask）。
- 达 20 上限：禁用「+」+ Toast。
- 含未保存关闭：发布类 tab 关 `×` 弹确认（store.dirty 标记，发布表单 `onInput` 置 dirty）。
- 空状态：全部系统 tab 关闭 → 自动开 `dashboard`。
- 启动恢复：tab 集（系统 routes + 账号 ids）持久化到 localStorage / userData JSON，启动恢复、默认 dashboard 激活。
- 隔离失效兜底：env 未配置 → 🔒 徽章显示"未配置隔离"(warning)。

---

## 5. 文件改动清单

### 新增
| 文件 | 作用 |
|---|---|
| `src/renderer/stores/workspace.ts` | 任务 tab Pinia store |
| `src/renderer/components/WorkspaceTabBar.vue` | 48px 任务选项卡条（含搜索） |
| `src/renderer/components/WorkspaceView.vue` | 按 tabId 实例渲染容器（系统 tab） |
| `src/renderer/components/AccountWorkspace.vue` | 账号 tab：信息条 + inner 子页签 + 占位 |
| `src/main/services/AccountWebViewController.ts` | 宿主无关的 WebContentsView + inner tab 控制器 |
| `src/main/services/MainWindowWebViewHost.ts` | 主窗口 contentView 宿主适配 |
| `src/main/services/WorkspaceWebViewController.ts` | 按 accountId 管理控制器 + resize/激活同步 |

### 修改
| 文件 | 改动 |
|---|---|
| `src/renderer/App.vue` | 插入任务条、`<router-view>`→`<WorkspaceView>`、搜索迁入、去 topbar 标题 |
| `src/renderer/router/index.ts` | 导出 `routeComponentMap` |
| `src/renderer/pages/AccountPanel.vue` | `openCreator`→`openAccountTab` |
| `src/main/ipc/account.ts` | `account:openCreator`→`account:openAccountTab`；注册 `workspace-webview:*` |
| `src/main/windows/CreatorTabWindow.ts` | 重构为复用 `AccountWebViewController`（过渡期保留，稳定后删） |
| `src/preload/index.ts` | 暴露 `workspaceWebview` API + 事件 |
| `src/renderer/utils/electron.ts` | 增加 `openAccountTab` + `workspaceWebview.*` |
| `src/types/index.ts` | 增加 workspace/webview 类型 |

### 删除（Phase 3 稳定后）
- `src/main/windows/CreatorTabWindow.ts`（弹窗整体废弃）

---

## 6. 风险与缓解（对照 PRD §9）

| 风险 | 缓解（已落地到方案） |
|---|---|
| R1 状态保持实现错（表单丢） | 用按 tabId 实例 + `v-show`，**不用 KeepAlive**（避开 Publish.vue 共用陷阱）；以「发布文章」做回归验收 |
| R2 原生 view 与 Vue 矩形不同步/遮挡 | 集中式 `WorkspaceWebViewController` 统一管 bounds；非激活账号 view 全 `setVisible(false)`；resize/激活变化即重算 |
| R3 多 webview 资源 | 上限 20；非激活仅隐藏不销毁（内存可控）；关闭即 `webContents.close()` 释放 |
| R4 侧栏/任务条被原生层盖住 | bounds 严格 `x≥250, y≥48`（侧栏+任务条之外）；该区点击归 Vue |

---

## 7. 测试策略

- **单元**：`workspace.ts` reducers（open 去重 / close 回退相邻 / 达 20 禁用 / dirty 标记）。
- **集成（无头 Electron 探针，复用前期做法）**：
  1. 开「发布文章」→ 输入文本 → 切「草稿箱」→ 切回 → 断言 DOM 文本保留。
  2. 开视频/图文/文章三个 tab → 各自填不同值 → 断言互不串。
  3. 开账号 tab → 断言主窗口 `addChildView` 被调用且 view bounds 在内容矩形内；切到系统 tab → 断言账号 view `setVisible(false)`。
- **回归**：现有 `matcher.test.ts`(9/9)、合规 e2e 不受影响（未触碰合规代码）。

---

## 8. 里程碑建议（供排期）

| 里程碑 | 范围 | 可独立交付/验证 |
|---|---|---|
| M1 | Phase 0 + Phase 1 | 系统任务 tab + 状态保持（**最先解决头号痛点**） |
| M2 | Phase 2 | 账号创作中心内嵌主窗口（含隔离） |
| M3 | Phase 3 | 入口切换 + 移除弹窗 |
| M4 | Phase 4 | 边界/持久化/打磨 |

> 建议 M1 优先排期：它不依赖原生层改造，纯 Vue 层即可验证"切换不丢内容"这一最核心诉求，风险最低、收益最高。

---

## 9. 待确认（开发前最后清单）
1. `routeComponentMap` 解析失败时的降级（路由表组件为函数，需 `markRaw` 缓存）。
2. 账号 tab 占位 div 与原生 view 的 z-index/透明处理：采用"Vue 占位区透明、原生 layer 叠其上"方案，需确认 MainWindow 是否启用 `transparent`/背景色（当前 `backgroundColor:'#ffffff'`，无碍）。
3. `openAccountTab` 与现有 `applyDouyinAntiCrash(win, ...)` 的兼容（原弹窗注入的防崩逻辑需迁移到主窗口宿主）。
4. 过渡期是否保留 `CreatorTabWindow` 作为可回退路径（建议保留一个版本后再删，降低风险）。
