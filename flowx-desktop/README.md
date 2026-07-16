# FlowX Desktop

> FlowX 桌面客户端 — 多平台内容发布工具的桌面实现（Electron + Vue 3 + TypeScript）

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|:---|:---|:---|:---|
| 桌面框架 | **Electron** | **31.7.7** | Chromium 126（关键版本，解决渲染进程崩溃） |
| 前端 | Vue | 3.x | Composition API |
| 语言 | TypeScript | 5.x | 严格模式 |
| UI | Element Plus | latest | 后台风格组件库 |
| 状态 | Pinia | latest | 轻量模块化 store |
| 自动化协议 | CDP (Chrome DevTools Protocol) | - | 文件注入 / DOM 操作 |
| 存储 | electron-store + safeStorage | latest | 加密本地账号凭证 |
| 构建 | Vite + vite-plugin-electron | latest | 快速开发 & HMR |
| 打包 | electron-builder | latest | NSIS 安装包 |

---

## 快速开始

### 开发模式

```bash
# 安装依赖
cd flowx-desktop
npm install

# 启动（Vite dev server + Electron 窗口）
npm run dev
```

### 生产构建

```bash
# 生成 Windows 安装包（.exe）
npm run build

# 构建产物位置
# flowx-desktop/dist/      # 前端静态资源
# flowx-desktop/release/    # Electron 安装包
```

---

## 目录结构

```
flowx-desktop/
├── src/
│   ├── main/                         # Electron 主进程
│   │   ├── index.ts                  # 应用入口（GPU 策略 / 单实例锁 / 窗口创建）
│   │   ├── services/
│   │   │   ├── AccountService.ts     # 账号授权 / Cookie 注入 / 信息提取
│   │   │   ├── BrowserService.ts     # 浏览器视图管理（多标签 / 书签 / 内容提取）
│   │   │   ├── BrowserHistoryService.ts # 书签与历史记录服务
│   │   │   ├── ContentExtractor.ts   # 网页内容提取引擎（Readability + 站点规则 + 手动提取）
│   │   │   ├── PublishEngine.ts      # 发布引擎 / 并发控制 / IPC 推送
│   │   │   ├── PlatformAdapter.ts    # 平台适配器（各平台 publish 入口）
│   │   │   └── platforms/
│   │   │       ├── shared.ts         # 核心：窗口/导航/CDP/evalJS/填写/按钮点击
│   │   │       ├── douyin.ts         # 抖音
│   │   │       ├── xiaohongshu.ts    # 小红书
│   │   │       └── kuaishou.ts       # 快手
│   │   ├── ipc/
│   │   │   ├── index.ts              # IPC 注册（safeInvoke 封装）
│   │   │   ├── account.ts            # 账号通道
│   │   │   ├── browser.ts            # 浏览器通道（标签页 / 导航 / 内容提取）
│   │   │   ├── browserHistory.ts     # 书签与历史记录通道
│   │   │   ├── publish.ts            # 发布通道
│   │   │   └── system.ts             # 系统信息 / 日志
│   │   ├── windows/
│   │   │   ├── MainWindow.ts         # 主窗口
│   │   │   └── AccountBrowserView.ts # 账号浏览窗口
│   │   ├── store/
│   │   │   └── SecureStore.ts        # 加密存储（safeStorage + electron-store）
│   │   └── utils/
│   │       └── logger.ts             # 统一日志格式
│   ├── preload/
│   │   └── index.ts                  # contextBridge 暴露白名单 API
│   ├── renderer/                      # Vue 3 前端
│   │   ├── pages/
│   │   │   ├── Dashboard.vue         # 仪表盘
│   │   │   ├── AccountPanel.vue      # 账号管理
│   │   │   ├── Publish.vue           # 一键发布
│   │   │   ├── History.vue           # 发布历史（重试/编辑重发/重新测试/立即发布）
│   │   │   ├── Browser.vue           # 浏览器（多标签 + 内容提取 + 发布表单分栏）
│   │   │   └── DraftBox.vue          # 草稿箱
│   │   ├── components/
│   │   │   └── PublishForm.vue       # 发布表单组件（发布页/浏览器页复用）
│   │   └── stores/
│   │       ├── account.ts            # 账号列表 / 刷新状态
│   │       ├── browser.ts            # 浏览器状态（标签页 / 书签 / 历史）
│   │       ├── draft.ts              # 草稿箱
│   │       └── publish.ts            # 发布任务 / IPC 事件订阅 / 自动清理
│   └── types/
│       └── index.ts                  # 全局共享类型（PublishRequest / PlatformMeta 等）
├── docs/
│   └── 抖音发布稳定性修复方案.md      # 关键问题解决记录（Electron 28 → 31）
├── package.json                      # Electron 31.7.7
├── vite.config.ts                    # Vite 配置
├── electron-builder.yml              # 打包配置（NSIS）
└── README.md                         # 本文件
```

---

## 当前已实现

### ✅ 账号管理

- 抖音 / 小红书 / 快手 平台扫码授权
- 每个账号独立 session partition（`persist:account_{id}`）
- cookies 使用 `safeStorage` 加密存储（操作系统级密钥）
- 从页面 DOM 提取昵称、头像、粉丝数、关注数、获赞数
- 支持刷新 token、编辑备注、删除账号
- 支持点击"打开创作中心"直接跳到对应平台后台

### ✅ 一键发布

- 选择多个账号 → 上传素材 → 填写标题/话题 → 一键发布
- **测试模式**：点击"测试发布"，仅填写表单不真正发布，高亮标记发布按钮，窗口保持打开供检查
- **测试结果检测**：自动检测标题/内容/标签/封面是否填写，发布按钮是否找到，生成可视化测试报告
- **文章摘要**：文章发布支持独立的摘要字段（抖音 30 字，小红书 1000 字）
- **文章话题弹窗**：抖音文章话题通过专用弹窗搜索添加（最多 5 个），非正文追加方式
- **小红书文章话题**：在第三步摘要框中通过模拟键盘输入插入话题标签
- **Markdown 编辑器**：文章发布支持纯文本 / Markdown 模式切换，左右分栏实时预览，支持标题/加粗/斜体/高亮/引用/列表/图片，发布时生成 .md 文件上传到平台（小红书/抖音）
- 并发控制（默认 3 个并行，可调）
- 实时进度推送（每个账号独立状态）
- 失败分支保留发布窗口，方便手动处理
- 发布后 3 秒自动关闭窗口 + 8 秒后从"任务进行中"面板移除
- 自动处理草稿/二次确认对话框
- 草稿箱：保存未发布内容，支持从草稿继续编辑
- 发布类型切换自动清理不兼容的选中账号（如切换到文章自动取消微信视频号选中）

### ✅ 发布历史

- 查看所有发布任务的历史记录，支持分页（默认 10 条/页，可配置 10/20/50/100）
- 任务状态一目了然：成功/失败/发布中/已取消/待发布，测试任务带🔍标记
- 各账号执行结果标签化展示（前 4 个直接显示，超出悬浮查看）
- **测试任务操作**：
  - **重新测试**：对所有账号重新执行测试（不真正发布），用于验证修复效果
  - **立即发布**：将测试任务转为正式发布，确认无误后一键发布
- **失败任务操作**：
  - **重试**：仅重试失败的账号（成功的不重复发布）
  - **编辑重发**：修改标题/内容/话题/素材后，对失败账号重新发布
- **定时任务操作**：支持取消待发布的定时任务
- 任务详情弹窗：查看完整请求参数、各账号结果、测试报告、执行日志（最多 50 条）

### ✅ 浏览器与内容提取

- **多标签浏览器**：基于 Electron WebContentsView，支持新建/切换/关闭标签页
- **环境隔离**：支持选择浏览器环境（User-Agent / 代理配置），每个标签独立 session
- **分栏布局**：左侧浏览器 + 右侧发布表单，宽度比 2:1，支持拖拽调节
- **一键提取内容**：自动提取网页正文、标题、图片，一键填充到发布表单
- **多策略提取引擎**：
  - 站点规则适配（微信公众号 / 知乎 / 今日头条 / 36氪 / 简书 / 少数派 / CSDN / 掘金 等 10+ 站点）
  - Readability.js 通用正文提取
  - 文本密度算法兜底
- **手动提取**：
  - 右键菜单提取（图片 / 元素 / 整页 / 选择模式）
  - 元素选择模式（悬停高亮 / 点击确认 / ESC 取消 / 方向键切换层级）
  - 光标位置插入（手动提取不覆盖已有内容）
- **文本清理**：七步清理管线（零宽字符 / 换行 / 空格 / 空行 / 首尾清理）
- **图片智能过滤**：五级过滤（广告域名 / data URI / 尺寸 / 比例 / 语义）
- **置信度评分**：三色标签显示提取质量（绿 ≥80 / 橙 50-79 / 红 <50）
- **书签 & 历史记录**：收藏夹管理、访问历史记录、侧边栏展示
- **SSL 证书处理**：证书错误可选择继续访问
- **DevTools**：F12 / 右键检查元素，调试浏览器页面

### ✅ 自动化技术

- CDP `DOM.setFileInputFiles` 注入本地文件
- `NavigationTracker` 等待 SPA 页面稳定（避免 "Render frame was disposed"）
- `evalJS` 带 6 次重试 + 临时错误识别
- React 受控组件兼容（原生 setter + input/change/blur 三重事件）
- 发布按钮候选列表 + Shadow DOM 穿透
- IPC 消息窗口过滤（防止把消息发到外部 URL 窗口）

### ✅ 稳定性

- Electron 31.7.7（Chromium 126）
- 禁用 GPU 加速 + 软件渲染 fallback
- 发布窗口 `render-process-gone` 后自动 reload 1 次兜底
- 10 条测试用例全部通过（详见 `docs/抖音发布稳定性修复方案.md`）

---

## 核心设计要点速览

### 账号隔离（Partition）

每个账号分配一个持久化 session partition：`persist:account_{uuid}`

- 不同账号的 cookies、LocalStorage、IndexedDB 完全隔离
- 切换账号不会互相踢下线
- 在账号浏览器窗口中也能正常使用平台后台

### 平台适配器模式

```typescript
// 每个平台只需要：meta + detectLoggedIn + publishKeywords
// 90% 流程由 runStandardPublish 通用处理
const adapter = getAdapter('douyin');
await adapter.publish(accountId, request, onProgress);
```

### IPC 状态推送

```
PublishEngine.submit()          # 主进程 → 记录任务
        ↓ (for each account)
runStandardPublish → onProgress # 回调更新进度
        ↓ (IPC send)
publish:statusChanged → 渲染层  # webContents.send 主动推送
        ↓
stores/publish.ts 合并状态     # _applyStatusUpdate
        ↓
Vue 响应式更新 → 进度面板刷新
```

### 调试日志

发布页面底部有调试日志面板（点击"显示调试日志"切换），展示：

- 每个 IPC 推送事件的前后状态变化
- 每个账号子任务的 stage / progress
- 失败任务的错误消息

如果没有问题，不需要打开；遇到问题时可快速定位。

---

## 后续扩展

- 📊 数据中心 / 统计分析（发布量 / 平台分布 / 趋势）
- ✍️ 内容创作模块（草稿管理 / 内容模板）
- 🌐 更多平台（B 站、微信公众号、知乎、视频号等）
- 🔗 更多网站内容提取适配规则
- ⚡ 提取结果缓存 / 预提取优化
- 🔄 自动更新（electron-updater，需要配置私有发布地址）
- 🔌 插件系统（允许用户自定义平台适配器）

---

## 相关文档

- **项目总览 README**：[上层目录 README](../README.md)
- **完整设计文档**：[../设计文档.md](../设计文档.md)（包含 PlatformDispatcher 工厂方法模式）
- **浏览器与内容提取设计文档**：[`../content-extraction-optimization/content-extraction-optimization.html`](../content-extraction-optimization/content-extraction-optimization.html)
- **小红书自动发布技术文档**：[`docs/小红书自动发布技术文档.md`](./docs/小红书自动发布技术文档.md)（Closed Shadow DOM / CDP 穿透）
- **小红书图文发布技术文档**：[`docs/小红书图文发布技术文档.md`](./docs/小红书图文发布技术文档.md)（ProseMirror 富文本 / 多图上传）
- **小红书文章发布技术文档**：[`docs/小红书文章发布技术文档.md`](./docs/小红书文章发布技术文档.md)（多步排版 / 摘要填写 / 话题插入）
- **快手自动发布技术文档**：[`docs/快手自动发布技术文档.md`](./docs/快手自动发布技术文档.md)（Element UI / contenteditable / user-cnt__item 提取）
- **快手图文发布技术文档**：[`docs/快手图文发布技术文档.md`](./docs/快手图文发布技术文档.md)
- **抖音图文发布技术文档**：[`docs/抖音图文发布技术文档.md`](./docs/抖音图文发布技术文档.md)
- **抖音文章发布技术文档**：[`docs/抖音文章发布技术文档.md`](./docs/抖音文章发布技术文档.md)（封面上传 / 话题弹窗 / 摘要字段）
- **文章发布 Markdown 编辑器**：[`docs/文章发布Markdown编辑器优化方案.md`](./docs/文章发布Markdown编辑器优化方案.md)（Markdown 编辑 / 分栏预览 / 平台文件上传）
- **微信视频号图文技术文档**：[`docs/微信视频图文技术文档.md`](./docs/微信视频图文技术文档.md)（微前端 iframe / CDP 物理点击）
- **抖音发布稳定性修复方案**：[`docs/抖音发布稳定性修复方案.md`](./docs/抖音发布稳定性修复方案.md)
- **platforms/ 目录**：[`src/main/services/platforms/`](./src/main/services/platforms/)（三个平台独立实现 + shared.ts 共享工具）
- **PlatformDispatcher.ts**：[`src/main/services/platforms/PlatformDispatcher.ts`](./src/main/services/platforms/PlatformDispatcher.ts)（工厂方法分发器）
- **PublishEngine.ts**：[`src/main/services/PublishEngine.ts`](./src/main/services/PublishEngine.ts)
- **AccountService.ts**：[`src/main/services/AccountService.ts`](./src/main/services/AccountService.ts)
- **BrowserService.ts**：[`src/main/services/BrowserService.ts`](./src/main/services/BrowserService.ts)（浏览器视图管理）
- **ContentExtractor.ts**：[`src/main/services/ContentExtractor.ts`](./src/main/services/ContentExtractor.ts)（内容提取引擎）
- **Browser.vue**：[`src/renderer/pages/Browser.vue`](./src/renderer/pages/Browser.vue)（浏览器页面）
- **PublishForm.vue**：[`src/renderer/components/PublishForm.vue`](./src/renderer/components/PublishForm.vue)（发布表单组件）
