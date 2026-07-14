# FlowX — 多平台内容发布工具

> 一站式多平台内容创作与发布工具，支持抖音、小红书、快手等主流内容平台。

---

## 项目简介

FlowX 是一款基于 Electron 的跨平台桌面客户端，旨在帮助内容创作者高效管理多平台账号，一键发布内容到多个平台，省去重复登录和重复发布的繁琐流程。

### 核心特性

- 🔐 **多账号管理** — 支持同时管理抖音、小红书、快手、微信视频号、微信公众号、知乎、今日头条等平台的多个账号，独立 session，互不影响
- 🚀 **一键发布** — 选择账号 → 上传素材 → 填写标题 → 点击发布 → 多平台同步完成
- 📅 **定时发布** — 支持配置定时推送。包含重启后未到期任务重调度、已过期检测变更为失效、历史记录同步呈现预发布时间并支持取消发布
- 📂 **多账号分类** — 账号可绑定多达 5 个不同的分类标签，支持在发布时按分类筛选目标账号
- 🛡️ **指纹UA与代理IP隔离** — 导航栏新增系统配置，支持独立指纹（User-Agent 模板一键随机生成）与出网代理（HTTP/SOCKS5，支持密码校验），实现防关联物理级隔离，针对微信等防爬严格平台特化了前置同步 UA 加固
- 📊 **实时进度** — 每个发布任务都有进度条和状态指示，随时了解当前状态
- 🔒 **本地加密存储** — 账号信息和 cookies 使用 `safeStorage` 加密存储在本地，不上传到任何服务器
- 💻 **自动化浏览器** — 基于 CDP（Chrome DevTools Protocol）实现文件注入和表单自动化

### 已支持平台

| 平台 | 视频发布 | 图文发布 | 文章发布 | 刷新账号 | 打开创作中心 |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 抖音 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 小红书 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 快手 | ✅ | ✅ | ❌ | ✅ | ✅ |
| 微信视频号 | ✅ | ✅ | ❌ | ✅ | ✅ |
| 微信公众号 | ❌ | ❌ | ❌ | ✅ | ✅ |
| 知乎 | ❌ | ❌ | ❌ | ✅ | ✅ |
| 今日头条 | ❌ | ❌ | ❌ | ✅ | ✅ |

> **图文发布**：支持封面图上传 + 标题/正文/话题填写，每个平台独立的 DOM 选择器和事件模拟

> **文章发布**：支持抖音和小红书的长文创作。抖音文章标题 30 字、正文 8000 字、**封面图必填（已解决动态input上传问题）**；小红书文章标题 64 字、正文不限制。小红书文章需走"一键排版 → 下一步 → 发布"的三步点击流程。抖音文章封面上传采用 JS DataTransfer 直接注入 + CDP 五层拦截架构，解决无持久化 input 元素的问题。

> **仅账号管理平台**：微信公众号、知乎、今日头条目前仅支持账号管理（登录态检测、账号信息提取、打开创作中心），发布功能待开发。微信公众号因需要管理员扫码确认发布，暂不支持自动发布。

> 各平台图文/文章发布的技术细节：CDP 文件上传 → ProseMirror 富文本填充 → Shadow DOM/iframe 穿透 → CDP 物理鼠标合成点击（isTrusted=true 穿透）。详见 `docs/` 目录下的平台技术文档。

---

## 快速开始

### 环境要求

- **Node.js** ≥ 18.0
- **npm** ≥ 9.0
- **OS**: Windows 10/11 (主要测试环境) / macOS (兼容性) / Linux (未测试)
- **内存**: 推荐 ≥ 8 GB（浏览器自动化占用较高）

### 安装与运行

```bash
# 1. 克隆项目
git clone git@github.com:menciusnh4/flowx.git
cd flowx

# 2. 安装依赖
cd flowx-desktop
npm install

# 3. 开发模式启动
npm run dev

# 4. 生产构建（生成安装包）
npm run build
```

首次启动后会进入主界面，按下列步骤开始使用：

1. 点击左侧"账号管理"
2. 点击"新增账号" → 选择平台 → 使用平台账号扫码登录
3. 登录后自动提取昵称、粉丝数等信息并加密保存
4. 切换到"发布"页 → 填写标题、上传视频 → 选择目标账号 → 一键发布
5. 观察进度面板，发布成功后自动归档

---

## 项目结构

```
flowx/
├── flowx-desktop/                 # 桌面客户端（Electron + Vue 3 + TypeScript）
│   ├── src/
│   │   ├── main/                   # Electron 主进程
│   │   │   ├── index.ts            # 应用入口（GPU 策略、单实例锁）
│   │   │   ├── services/           # 核心服务（账号/发布引擎/平台适配）
│   │   │   ├── ipc/                # IPC 通道（账号/发布/系统）
│   │   │   ├── store/              # 加密本地存储（electron-store + safeStorage）
│   │   │   └── windows/            # 窗口管理（主窗口/发布窗口）
│   │   ├── preload/                # 主进程/渲染进程安全桥接
│   │   ├── renderer/               # Vue 3 前端
│   │   │   ├── pages/              # 页面（账号管理/发布/仪表盘）
│   │   │   └── stores/             # Pinia 状态管理
│   │   └── types/                  # 共享类型定义
│   ├── docs/                       # 详细文档（抖音发布修复方案等）
│   ├── package.json                # Electron 31.7.7
│   └── vite.config.ts              # Vite 构建配置
├── 设计文档.md                     # 完整架构与模块设计文档
└── README.md                       # 本文件
```

---

## 技术栈

| 层级 | 技术 | 版本 | 用途 |
|:---|:---|:---|:---|
| 桌面框架 | Electron | 31.7.7 | 跨平台桌面应用（Chromium 126） |
| 前端框架 | Vue | 3.x (Composition API) | 渲染进程 UI |
| 语言 | TypeScript | 5.x | 类型安全 |
| UI 库 | Element Plus | latest | 组件库（表格/对话框/进度条等） |
| 状态管理 | Pinia | latest | 前端状态管理 |
| 构建工具 | Vite | 5.x | 快速开发 & HMR |
| 自动化协议 | CDP (Chrome DevTools Protocol) | - | 文件注入 / DOM 操作 |
| 本地存储 | electron-store + safeStorage | latest | 加密账号凭证 |
| 打包 | electron-builder | latest | NSIS 安装包 |

### 关键技术要点

1. **平台适配器模式** — 每个平台的发布流程独立实现（`douyin.ts` / `xiaohongshu.ts` / `kuaishou.ts`），`shared.ts` 只提供通用工具（窗口管理/导航跟踪/CDP 上传/evalJS 重试器），平台之间完全隔离
2. **两级分发器** — PlatformDispatcher 按 `platform + contentType` 分发到 `publishVideo`/`publishImage`/`publishArticle`
3. **导航稳定性** — 页面跳转后通过 `NavigationTracker` 等待 1.5~3 秒静默期，再执行 DOM 操作，避免"Render frame was disposed"
4. **账号隔离** — 每个账号独立 `persist:account_{id}` partition，天然隔离登录态
5. **Electron 版本策略** — 固定在 31.7.7（Chromium 126），已验证无渲染进程崩溃
6. **React 受控组件兼容** — 标题/正文填写通过 `document.execCommand('insertText')` 模拟原生输入，确保 React state 同步更新，避免重渲染时被清空
7. **CDP 文件上传** — 通过 Chrome DevTools Protocol `DOM.getDocument(pierce:true)` → `DOM.setFileInputFiles` 绕过浏览器安全限制，在主进程层面直接设置文件输入
8. **Closed Shadow DOM 穿透** — 小红书发布按钮 `<xhs-publish-btn>` 是自定义 web component，内部 shadow DOM 对外封闭。使用 CDP 深度扫描（`pierce:true`）穿透 shadow DOM，定位真正的 `<button>` 元素，再通过 `Input.dispatchMouseEvent` 合成鼠标事件触发点击

---

## 文档索引

| 文档 | 路径 | 说明 |
|:---|:---|:---|
| **设计文档** | [`设计文档.md`](./设计文档.md) | 完整架构设计、模块说明、扩展指南（含 PlatformDispatcher 工厂方法模式） |
| **小红书自动发布技术文档** | [`flowx-desktop/docs/小红书自动发布技术文档.md`](./flowx-desktop/docs/小红书自动发布技术文档.md) | Closed Shadow DOM / xhs-publish-btn / CDP 穿透点击 |
| **小红书图文发布技术文档** | [`flowx-desktop/docs/小红书图文发布技术文档.md`](./flowx-desktop/docs/小红书图文发布技术文档.md) | 图文发布专用：标题/正文/封面上传，发布按钮 shadow DOM 穿透 |
| **快手自动发布技术文档** | [`flowx-desktop/docs/快手自动发布技术文档.md`](./flowx-desktop/docs/快手自动发布技术文档.md) | Element UI / contenteditable / user-cnt__item 粉丝数解析 |
| **快手图文发布技术文档** | [`flowx-desktop/docs/快手图文发布技术文档.md`](./flowx-desktop/docs/快手图文发布技术文档.md) | 图文发布专用：URL 切换 / 标签限制（最多4个） / 标题字数 |
| **抖音发布稳定性修复方案** | [`flowx-desktop/docs/抖音发布稳定性修复方案.md`](./flowx-desktop/docs/抖音发布稳定性修复方案.md) | Electron 28→31 升级完整记录，含问题分析、测试用例、经验总结 |
| **抖音图文发布技术文档** | [`flowx-desktop/docs/抖音图文发布技术文档.md`](./flowx-desktop/docs/抖音图文发布技术文档.md) | 图文发布专用：`default-tab=3` URL / `button-dhlUZE primary-button` 发布按钮 / ProseMirror 富文本 |
| **抖音文章发布技术文档** | [`flowx-desktop/docs/抖音文章发布技术文档.md`](./flowx-desktop/docs/抖音文章发布技术文档.md) | 文章发布专用：`default-tab=5` URL / 标题 30 字 / 正文 8000 字 / React 受控组件 |
| **小红书文章发布技术文档** | [`flowx-desktop/docs/小红书文章发布技术文档.md`](./flowx-desktop/docs/小红书文章发布技术文档.md) | 文章发布专用：`target=article` URL / 三步点击（一键排版 → 下一步 → 发布） / 标题 64 字 / 正文无限制 |
| **平台适配器目录** | `flowx-desktop/src/main/services/platforms/` | xiaohongshu.ts / douyin.ts / kuaishou.ts（三个独立实现 + 共享 shared.ts） |
| **平台分发器** | `flowx-desktop/src/main/services/platforms/PlatformDispatcher.ts` | createExecutor(platform, contentType) — 工厂方法模式的核心 |
| **发布引擎实现** | `flowx-desktop/src/main/services/PublishEngine.ts` | 并发控制 / IPC 推送 / 重启恢复 / 任务状态管理 |

---

## 常见问题

### Q1: 为什么不使用开放平台 API，而要用浏览器自动化？

开放平台 API（如抖音开放平台）需申请开发者认证，且有发布频率、内容审核等限制。浏览器自动化的优势是：

- ✅ 不需要开发者认证，用自己的账号即可
- ✅ 能实现与手动发布完全一致的流程
- ✅ 支持所有平台（包括没有开放 API 的平台）
- ❌ 平台 UI 变化时需要适配 DOM 选择器

### Q2: 账号密码是否安全？

- **所有账号信息都保存在你的本地电脑**，使用操作系统级别的加密存储（Windows DPAPI / macOS Keychain）
- cookies 加密后写入 `electron-store`，即使有人拿到文件也无法解密
- FlowX 本身不收集、上传、存储任何账号信息到服务器

### Q3: 为什么发布速度这么慢？

- 视频上传依赖你的网络带宽
- 平台的内容审核是服务器端处理，客户端需要等待审核完成
- 多账号并发发布时，每个账号都开启一个独立浏览器窗口（占用内存 ~200 MB）
- 建议：并发数设置 2~3 比较合适

### Q4: 发布后平台会封号吗？

平台封号的核心触发条件是**发布频率异常**（如 1 分钟发 10 条）、**内容质量低**（搬运/重复内容）。本工具：

- 每次发布都模拟真实浏览器环境（真实 User-Agent、真实 cookies）
- 不会加速/跳过任何平台审核流程
- 建议按平台的合理发布频率使用（例如抖音每天 1~3 条）

### Q5: 支持哪些平台的视频发布？

当前已验证的平台：抖音、小红书、快手

其他平台的适配器接口已预留，后续可扩展。欢迎提交 PR。

---

## 开发与贡献

### 开发环境搭建

```bash
git clone git@github.com:menciusnh4/flowx.git
cd flowx/flowx-desktop
npm install
npm run dev
```

### 代码规范

- TypeScript 严格模式（`"strict": true`）
- 主进程 / 渲染进程 / 平台适配器三层分离
- IPC 通道使用统一的 `safeInvoke` 封装（位于 `src/main/ipc/`）
- 调试日志使用结构化字段 `{ platform, accountId, stage, message }`

### 新增平台适配

详见 [`设计文档.md`](./设计文档.md) 第 11 章"扩展指南"。核心流程：

1. 在 `src/main/services/platforms/` 新增 `xxx-platform.ts`
2. 提供 `meta`（平台 URL、选择器、内容类型支持）+ `publish()` + `detectLoggedIn()` + `extractPageInfo()`
3. 在 `PlatformAdapter.ts` 注册该平台

### 报告问题

请通过 GitHub Issues 报告问题，并附上：

- FlowX 版本号
- 操作系统 / 版本
- 详细的复现步骤
- 发布窗口的 DevTools console 截图（如能打开）

---

## 路线图

- **v1.0 ✅（已实现）** — 账号管理 + 一键发布 + 进度跟踪
- **v1.1 ✅（已实现）** — 发布历史页 / 数据统计 / 更稳定的图文发布 / 测试发布功能 / 浏览器内容提取 / 指纹UA与代理IP隔离
- **v1.2** — 账号管理平台扩展（微信公众号 ✅、知乎 ✅、今日头条 ✅、B 站等）
- **v1.3** — 插件系统（允许用户编写自定义平台适配器）
- **v2.0** — 内容创作模块（草稿管理 / 内容模板 / AI 辅助）

---

## 许可证

本项目仅供个人学习和研究使用。使用本工具进行多平台内容发布前，请仔细阅读各平台的用户协议和开发者规范。
