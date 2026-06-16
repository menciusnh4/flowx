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
│   │   │   └── Publish.vue           # 发布表单 + 进度面板
│   │   └── stores/
│   │       ├── account.ts            # 账号列表 / 刷新状态
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
- 并发控制（默认 3 个并行，可调）
- 实时进度推送（每个账号独立状态）
- 失败分支保留发布窗口，方便手动处理
- 发布后 3 秒自动关闭窗口 + 8 秒后从"任务进行中"面板移除
- 自动处理草稿/二次确认对话框

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
- 🔄 自动更新（electron-updater，需要配置私有发布地址）
- 🔌 插件系统（允许用户自定义平台适配器）

---

## 相关文档

- **项目总览 README**：[上层目录 README](../README.md)
- **完整设计文档**：[../设计文档.md](../设计文档.md)（包含 PlatformDispatcher 工厂方法模式）
- **小红书自动发布技术文档**：[`docs/小红书自动发布技术文档.md`](./docs/小红书自动发布技术文档.md)（Closed Shadow DOM / CDP 穿透）
- **快手自动发布技术文档**：[`docs/快手自动发布技术文档.md`](./docs/快手自动发布技术文档.md)（Element UI / contenteditable / user-cnt__item 提取）
- **抖音发布稳定性修复方案**：[`docs/抖音发布稳定性修复方案.md`](./docs/抖音发布稳定性修复方案.md)
- **platforms/ 目录**：[`src/main/services/platforms/`](./src/main/services/platforms/)（三个平台独立实现 + shared.ts 共享工具）
- **PlatformDispatcher.ts**：[`src/main/services/platforms/PlatformDispatcher.ts`](./src/main/services/platforms/PlatformDispatcher.ts)（工厂方法分发器）
- **PublishEngine.ts**：[`src/main/services/PublishEngine.ts`](./src/main/services/PublishEngine.ts)
- **AccountService.ts**：[`src/main/services/AccountService.ts`](./src/main/services/AccountService.ts)
