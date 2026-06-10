# FlowX 桌面端

> FlowX - 多平台内容发布桌面客户端（前期实现：抖音/小红书账号管理 + 一键发布）

## 技术栈

- Electron 28 + Vue 3 + TypeScript
- Element Plus（UI）
- Pinia（状态管理）
- electron-store（加密本地存储，使用 `safeStorage`）
- electron-updater（自动更新）
- Vite（构建工具）

## 快速开始

```bash
# 安装依赖
cd flowx-desktop
npm install

# 开发模式（同时启动 Vite dev server + Electron）
npm run dev

# 生产构建（生成安装包）
npm run build
```

## 目录结构

```
flowx-desktop/
├── src/
│   ├── main/             # Electron 主进程
│   │   ├── index.ts      # 入口
│   │   ├── windows/      # 窗口管理（MainWindow, AccountBrowserView）
│   │   ├── ipc/          # IPC 监听
│   │   ├── services/     # 业务服务（账号、发布引擎）
│   │   ├── store/        # 加密本地存储
│   │   └── utils/        # 日志等工具
│   ├── preload/          # preload 脚本（contextBridge）
│   ├── renderer/         # 渲染进程（Vue 应用）
│   │   ├── pages/        # 页面
│   │   ├── stores/       # Pinia stores
│   │   ├── components/   # 通用组件
│   │   └── router/       # 路由
│   └── types/            # 全局类型
└── package.json
```

## 当前已实现模块

- ✅ 账号管理（抖音/小红书授权、Token 加密存储）
- ✅ 一键发布（发布任务队列 + 平台适配器）
- ✅ 多开浏览器（每账号独立 session partition）
- ✅ 发布历史与进度跟踪

## 后续扩展

- 数据中心/统计分析
- 内容创作（草稿、模板）
- 更多平台（B 站、视频号、知乎等）
- 自动更新（electron-updater，需要配置发布地址）
