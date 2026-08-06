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
│   │   │   ├── BrowserService.ts     # 浏览器视图管理（多标签 / 书签 / 内容提取 / 右键菜单）
│   │   │   ├── BrowserHistoryService.ts # 书签与历史记录服务
│   │   │   ├── ContentExtractor.ts   # 网页内容提取引擎（Readability + 站点规则 + 手动提取）
│   │   │   ├── ElementPicker.ts      # 元素拾取器（悬停高亮 / 点击确认 / 选择器推断）
│   │   │   ├── SiteRuleManager.ts    # 自定义站点规则管理器（CRUD / 匹配评分 / 持久化）
│   │   │   ├── PublishEngine.ts      # 发布引擎 / 并发控制 / IPC 推送
│   │   │   ├── PlatformAdapter.ts    # 平台适配器（各平台 publish 入口）
│   │   │   └── platforms/
│   │   │       ├── shared.ts         # 核心：窗口/导航/CDP/evalJS/填写/按钮点击
│   │   │       ├── douyin.ts         # 抖音
│   │   │       ├── xiaohongshu.ts    # 小红书
│   │   │       ├── kuaishou.ts       # 快手
│   │   │       ├── zhihu.ts          # 知乎
│   │   │       ├── wechat_channels.ts # 微信视频号
│   │   │       ├── wechat_official.ts # 微信公众号（仅账号管理）
│   │   │       ├── toutiao.ts        # 今日头条（头条号）：账号管理 + 微头条图文 + 西瓜视频合并版（detectLoggedIn 4 重判断 + 信息提取 4 字段 + weitoutiao 14 步 + xigua 10 步 + portrait 封面适配 + 上传中 30s 轮询）
│   │   │       ├── x.ts              # X/Twitter（仅账号管理）
│   │   │       ├── bilibili.ts       # B站（哔哩哔哩，仅账号管理）
│   │   │       └── weibo.ts          # 微博（账号管理 + 视频发布 + 图文/纯文本发布）
│   │   ├── ipc/
│   │   │   ├── index.ts              # IPC 注册（safeInvoke 封装）
│   │   │   ├── account.ts            # 账号通道
│   │   │   ├── browser.ts            # 浏览器通道（标签页 / 导航 / 内容提取 / 元素拾取 / 站点规则）
│   │   │   ├── browserHistory.ts     # 书签与历史记录通道
│   │   │   ├── publish.ts            # 发布通道
│   │   │   └── system.ts             # 系统信息 / 日志
│   │   ├── windows/
│   │   │   ├── MainWindow.ts         # 主窗口
│   │   │   ├── AboutWindow.ts        # 关于窗口（独立模态窗口，避免 WebContentsView 遮挡）
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
│   │   │   ├── Browser.vue           # 浏览器（多标签 + 内容提取 + 发布表单分栏 + 规则面板）
│   │   │   ├── AboutWindow.vue       # 关于窗口页面（独立窗口，无 header）
│   │   │   ├── RulesPanel.vue        # 站点规则管理（全局规则列表）
│   │   │   └── DraftBox.vue          # 草稿箱
│   │   ├── components/
│   │   │   ├── PublishForm.vue       # 发布表单组件（发布页/浏览器页复用）
│   │   │   ├── BrowserRulePanel.vue  # 浏览器内规则面板（Tab 集成，匹配规则 + 全部规则）
│   │   │   └── SiteRuleEditor.vue    # 规则编辑器（新建/编辑 + 可视化拾取）
│   │   └── stores/
│   │       ├── account.ts            # 账号列表 / 刷新状态
│   │       ├── browser.ts            # 浏览器状态（标签页 / 书签 / 历史）
│   │       ├── draft.ts              # 草稿箱
│   │       └── publish.ts            # 发布任务 / IPC 事件订阅 / 自动清理
│   └── types/
│       └── index.ts                  # 全局共享类型（PublishRequest / PlatformMeta 等）
├── docs/
│   ├── 平台技术文档（每平台一份，含账号接入+视频+图文+文章）
│   │   ├── 小红书平台技术文档.md
│   │   ├── 抖音平台技术文档.md       # 含稳定性修复方案（Electron 28 → 31）
│   │   ├── 快手平台技术文档.md
│   │   ├── 微博平台技术文档.md
│   │   ├── 知乎平台技术文档.md
│   │   ├── B站平台技术文档.md
│   │   ├── 今日头条平台技术文档.md   # 账号接入 + 微头条图文 + 西瓜视频 + 长文占位
│   │   └── 微信视频号平台技术文档.md
│   ├── 账号分析功能设计方案.md
│   ├── 用户自定义站点规则设计方案.md
│   └── 文章发布Markdown编辑器优化方案.md
├── package.json                      # Electron 31.7.7
├── vite.config.ts                    # Vite 配置
├── electron-builder.yml              # 打包配置（NSIS）
└── README.md                         # 本文件
```

---

## 当前已实现

### ✅ 账号管理

- 抖音 / 小红书 / 快手 / 微信视频号 / 知乎 / 微信公众号 / 今日头条 / X（Twitter）/ B站（哔哩哔哩）/ 微博平台扫码授权
- 每个账号独立 session partition（`persist:account_{id}`）
- cookies 使用 `safeStorage` 加密存储（操作系统级密钥）
- 从页面 DOM 提取昵称、头像、粉丝数、关注数、获赞数
- X（Twitter）平台支持 `window.__INITIAL_STATE__` 优先提取 + `SideNav_AccountSwitcher_Button` / `UserAvatar-Container-<handle>` 多数据源兜底
- B站（哔哩哔哩）基于 `SESSDATA` cookie 登录态 + `DedeUserID` 读取原生 UID，启用 28 种类引号字符严格净化，防止异常字符污染昵称/头像 URL
- 微博基于 `SUB` cookie 登录态 + 访客态（visitorSign）+ 个人tab/创作中心头像结构识别三重判断，`me.weibo.com` 创作中心支持「微博号（自定义）」和纯数字 UID 双 ID 提取，自有 CDN 域名强制升级 https；已完整支持视频发布（`weibo.com/upload/channel`，含封面生成等待 10 张候选图）和图文/纯文本发布（`weibo.com` 首页发布卡片，图片上传后校验缩略图+删除按钮）
- 支持刷新 token、编辑备注、删除账号
- 支持点击"打开创作中心"直接跳到对应平台后台
- **账号头像本地持久化（v0.1.5）**：
  - 三个入口统一覆盖：账号授权、刷新账号、批量健康检测都会把远程头像下载到本地
  - 每个账号只保留一份文件：`{userData}/avatars/avatar_{accountId}.{ext}`，下载前自动清理同账号所有历史头像（含旧 `acc_{id}_{hash}.{ext}` 命名格式）
  - **`flowx-avatar://` 自定义协议**：`flowx-avatar://avatar/{filename}` 由主进程 `protocol.handle` 拦截并直接返回本地文件二进制 Buffer，绕过 `webSecurity=true` 下 `file://` 在 `http://localhost`/生产窗口里被浏览器安全策略拦截的问题
  - **平台级 Referer 注入下载**：微博（weibo.com）、小红书（xiaohongshu.com）、抖音（douyin.com）、B站（bilibili.com）、快手（kuaishou.com）、微信视频号/公众号（channels.weixin.qq.com）、知乎（zhihu.com）都携带正确 Referer + 通用 UA 下载，绕过 sinaimg.cn/xhscdn 等域名的防盗链 + 短期签名校验
  - 失败自动 fallback：任何网络异常、非 2xx、非图片 Content-Type、<200 字节小文件都回退原远程 URL，绝不影响账号保存流程
  - 渲染层兜底：`AccountPanel.vue` / `AnalyticsPanel.vue` 的 normalize 函数优先识别 `flowx-avatar://` 协议透传，兼容 `file:///C:/...` 磁盘绝对路径、`data:` URI、`//xxx` 协议相对 URL

### ✅ 账号数据分析

- **多平台数据采集**：支持抖音、小红书、快手、微信视频号的作品数据采集
- **作品列表管理**：显示封面、标题、平台、账号、发布时间、点赞、评论、收藏等指标
- **多条件筛选**：
  - 按平台筛选（单选）
  - 按账号筛选（多选，使用平台账号ID如抖音号/小红书号）
  - 按关键词搜索（标题匹配）
  - 按指标排序（发布时间/点赞数/评论数/收藏数/分享数）
- **真分页**：服务端分页，默认 20 条/页
- **手动采集**：选择账号后点击"开始采集"，支持并发控制
- **本地存储**：所有数据保存在本地 electron-store，不上传云端，隐私安全
- **平台账号ID**：采集时自动保存各平台原生账号标识（抖音号/小红书号/快手号/视频号等），用于数据关联和筛选

### ✅ 一键发布

- 选择多个账号 → 上传素材 → 填写标题/话题 → 一键发布
- **今日头条微头条图文发布**（`mp.toutiao.com/profile_v4/weitoutiao/publish`）：
  - ProseMirror 富文本编辑器正文填写（含零宽字符/换行清理）
  - CDP 真实键盘逐个输入话题 `#文字` → 浮层推荐第一项匹配校验（连续 2 轮 firstItemText 稳定才判定 ready）→ 匹配成功点选，不匹配按官方提示「敲空格可取消插入话题」，绝不删文本/按 ESC（避免 ProseMirror 回退撤销前一个已插入话题）
  - 图片上传抽屉：CDP `DOM.setFileInputFiles` 注入本地文件 → `Runtime.callFunctionOn` 派发 change/input 事件 → 上传抽屉 success 标记 + `data-e2e="imageUploadConfirm-btn"` 确定按钮点击
  - 草稿撤销弹窗处理：「已恢复上次编辑未保存的内容」撤销按钮点击（33 轮轮询），清理残留图片（编辑器/抽屉/预览区）
  - 图片三道防线：抽屉内多余图片点 `.image-item-remove` 删除 → 抽屉确认后 `div.upload-list` 预览缩略图区 background-image URL 去重点 `i.image-remove-btn`（同 URL 只保留 1 张，绝不 removeChild 破坏 Vue DOM）
- **今日头条西瓜视频发布**（`mp.toutiao.com/profile_v4/xigua/upload-video`）：
  - 10 步标准流程：加载发布页 → 登录检测（未登录显示窗口等待 120s）→ 页面结构就绪校验 → CDP 视频文件注入 → 上传/转码进度轮询（最多 10 分钟，`uploading → scanning → finish` 阶段 + 表单渲染就绪才算完成，未达 100% 但表单就绪宽限通过）→ 标题自动补齐（最短 5 字最长 30 字，不足追加"精彩内容"）→ 简介填写（可选，竖版 small-video 表单可能无该字段）→ 话题（可选，竖版 small-video 可能无）→ **封面上传（横版 fakeUploadTrigger / 竖版 portrait .xigua-image-modify 「替换」按钮双路径 + Dialog2「上传中」30s 独立轮询等待）** → 发布按钮 3 次重试检测 disabled + 点击（footer 作用域加权）→ 发布结果轮询
  - 基于字节系统一 `xigua_upload-video-wrapper / garr-video-container / video-form-basic` 框架，和抖音创作平台发布结构同源；横版/竖版（small-video）自动适配（竖版封面 div.bg 存 background-image，无简介无话题）
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
- **分栏布局**：左侧浏览器 + 右侧 Tab 面板（发布编辑 / 提取规则），宽度可拖拽调节
- **一键提取内容**：自动提取网页正文、标题、图片，一键填充到发布表单
- **多策略提取引擎**：
  - **自定义站点规则**（优先级最高）：用户可视化配置，支持域名/正则匹配
  - 内置站点规则适配（微信公众号 / 知乎 / 今日头条 / 36氪 / 简书 / 少数派 / CSDN / 掘金 等 10+ 站点）
  - Readability.js 通用正文提取
  - 文本密度算法兜底
- **可视化元素拾取**：
  - 鼠标悬停高亮，点击确认选择
  - 自动推断 CSS 选择器（ID → Class → 属性 → 层级路径）
  - 支持多元素选择，自动推断公共选择器
  - ESC 取消、方向键切换层级
- **自定义站点规则管理**：
  - 浏览器内 Tab 面板管理，边浏览边配置
  - 当前网站匹配规则绿色高亮，一目了然
  - 支持 8 种选择器：正文、标题、作者、日期、站点名、图片、话题、移除元素
  - 支持图文/视频/文章多内容类型匹配
  - 右键菜单快捷创建自定义规则
- **手动提取**：
  - 右键菜单提取（图片 / 元素 / 整页 / 选择模式 / 添加自定义规则）
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
- 10 条测试用例全部通过（详见 `docs/抖音平台技术文档.md` 第三章）

---

## 核心设计要点速览

### 账号隔离（Partition）

每个账号分配一个持久化 session partition：`persist:account_{uuid}`

- 不同账号的 cookies、LocalStorage、IndexedDB 完全隔离
- 切换账号不会互相踢下线
- 在账号浏览器窗口中也能正常使用平台后台

### 头像本地持久化（Anti-Hotlink + Custom Protocol）

解决 sinaimg.cn / xhscdn.com 等 CDN 域名的「防盗链 Referer + 短期签名（KID/Expires/ssig）」导致账号列表头像 403/回退首字占位的问题。

```
采集阶段（主进程）：
  平台 DOM extractPageInfo() → 拿到带签名的 crop URL
        ↓
  AccountService.downloadAvatarToLocal(url, id, platform)
        ↓ （携带对应平台 Referer + UA 直连 CDN）
  userData/avatars/avatar_{accountId}.{ext}   ← 每个账号只保留这一份
        ↓
  SecureStore.avatar = "flowx-avatar://avatar/avatar_weibo_xxx.jpg"

渲染阶段（前端）：
  <img :src="normalizeAvatarSrc(cred.avatar)">
        ↓
  img src = "flowx-avatar://avatar/avatar_weibo_xxx.jpg"
        ↓ （主进程 protocol.handle 拦截）
  Response(buffer, { Content-Type: image/jpeg, Cache-Control: immutable })
        ↓
  页面显示本地文件二进制，完全绕过防盗链 + 签名过期
```

- **三入口覆盖**：账号授权（`beginAuthorization` Step6）、刷新账号（`refreshAccount`）、批量健康检测（`checkAccountHealth` 登录成功分支）都会走下载逻辑
- **一账号一文件**：`cleanupOldAvatarsFor()` 每次下载前删掉该账号所有旧文件（新 `avatar_` 前缀 + 旧 `acc_` 前缀都清理）
- **自定义协议注册**：`index.ts` 里通过 `registerSchemesAsPrivileged` 声明 `flowx-avatar`（standard + secure + supportFetchAPI + stream + bypassCSP + corsEnabled），`app.whenReady` 后 `protocol.handle` 拦截；文件名严格校验禁止 `..` 目录穿越
- **Referer 精确映射**：
  - weibo → `https://weibo.com/`
  - xiaohongshu → `https://www.xiaohongshu.com/`
  - douyin → `https://www.douyin.com/`
  - bilibili → `https://www.bilibili.com/`
  - kuaishou → `https://www.kuaishou.com/`
  - wechat_channels / wechat_official → `https://channels.weixin.qq.com/`
  - zhihu → `https://www.zhihu.com/`

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

## 版本记录

- **v0.1.6** — 微博视频+图文双发布 / 今日头条微头条+西瓜视频 / B站账号管理接入 / 账号头像本地持久化（flowx-avatar 自定义协议）/ 系统托盘图标 / macOS 适配 / 账号安全加固 / 8 平台技术文档合并

---

## 后续扩展

- ✍️ 内容创作模块（草稿管理 / 内容模板）
- 🌐 更多平台发布功能（B 站视频投稿 / 微博头条文章 / 微信公众号文章）
- 🔗 更多网站内容提取适配规则
- ⚡ 提取结果缓存 / 预提取优化
- 🔄 自动更新（electron-updater，需要配置私有发布地址）
- 🔌 插件系统（允许用户自定义平台适配器）
- 📤 规则导入导出（分享自定义站点规则）

---

## 相关文档

- **项目总览 README**：[上层目录 README](../README.md)
- **完整设计文档**：[../设计文档.md](../设计文档.md)（包含 PlatformDispatcher 工厂方法模式）
- **账号分析功能设计方案**：[`docs/账号分析功能设计方案.md`](./docs/账号分析功能设计方案.md)（多平台作品采集 / 多条件筛选 / 真分页 / 平台账号ID筛选）
- **用户自定义站点规则设计方案**：[`docs/用户自定义站点规则设计方案.md`](./docs/用户自定义站点规则设计方案.md)（可视化拾取 / 规则匹配 / 浏览器规则面板 / 顶部导航栏层级优化）
- **第四阶段-高级特性设计方案**：[`docs/第四阶段-高级特性设计方案.html`](./docs/第四阶段-高级特性设计方案.html)
- **浏览器与内容提取设计文档**：[`../content-extraction-optimization/content-extraction-optimization.html`](../content-extraction-optimization/content-extraction-optimization.html)
- **浏览器提取设计文档**：[`docs/浏览器提取设计文档.html`](./docs/浏览器提取设计文档.html)
- **内容提取优化设计文档**：[`docs/内容提取优化设计文档.html`](./docs/内容提取优化设计文档.html)
- **平台技术文档（每平台一份，含账号接入+视频+图文+文章）**：
  - **小红书**：[`docs/小红书平台技术文档.md`](./docs/小红书平台技术文档.md)（账号 + 视频 + 图文 + 文章，Shadow DOM 穿透 / ProseMirror / 多步排版）
  - **抖音**：[`docs/抖音平台技术文档.md`](./docs/抖音平台技术文档.md)（视频 + 图文 + 文章，含 Electron 28→31 稳定性修复方案 / WebAssembly 崩溃根因）
  - **快手**：[`docs/快手平台技术文档.md`](./docs/快手平台技术文档.md)（账号 + 视频 + 图文）
  - **微博**：[`docs/微博平台技术文档.md`](./docs/微博平台技术文档.md)（账号 + 视频 + 图文，FileChooser 拦截 + 真实 input 注入 + 10 张封面候选图）
  - **知乎**：[`docs/知乎平台技术文档.md`](./docs/知乎平台技术文档.md)（图文发布，ProseMirror 富文本编辑器原理）
  - **B站**：[`docs/B站平台技术文档.md`](./docs/B站平台技术文档.md)（账号管理完整接入，SESSDATA + DedeUserID，发布功能占位）
  - **今日头条**：[`docs/今日头条平台技术文档.md`](./docs/今日头条平台技术文档.md)（账号 + 微头条图文 + 西瓜视频 + 长文占位）
  - **微信视频号**：[`docs/微信视频号平台技术文档.md`](./docs/微信视频号平台技术文档.md)（账号 + 视频 + 图文）
- **文章发布 Markdown 编辑器**：[`docs/文章发布Markdown编辑器优化方案.md`](./docs/文章发布Markdown编辑器优化方案.md)（Markdown 编辑 / 分栏预览 / 平台文件上传）
- **platforms/ 目录**：[`src/main/services/platforms/`](./src/main/services/platforms/)（多平台独立实现 + shared.ts 共享工具）
- **PlatformDispatcher.ts**：[`src/main/services/platforms/PlatformDispatcher.ts`](./src/main/services/platforms/PlatformDispatcher.ts)（工厂方法分发器）
- **PublishEngine.ts**：[`src/main/services/PublishEngine.ts`](./src/main/services/PublishEngine.ts)
- **AccountService.ts**：[`src/main/services/AccountService.ts`](./src/main/services/AccountService.ts)
- **BrowserService.ts**：[`src/main/services/BrowserService.ts`](./src/main/services/BrowserService.ts)（浏览器视图管理）
- **ContentExtractor.ts**：[`src/main/services/ContentExtractor.ts`](./src/main/services/ContentExtractor.ts)（内容提取引擎）
- **Browser.vue**：[`src/renderer/pages/Browser.vue`](./src/renderer/pages/Browser.vue)（浏览器页面）
- **PublishForm.vue**：[`src/renderer/components/PublishForm.vue`](./src/renderer/components/PublishForm.vue)（发布表单组件）
- **BrowserRulePanel.vue**：[`src/renderer/components/BrowserRulePanel.vue`](./src/renderer/components/BrowserRulePanel.vue)（浏览器内规则面板）
- **SiteRuleEditor.vue**：[`src/renderer/components/SiteRuleEditor.vue`](./src/renderer/components/SiteRuleEditor.vue)（规则编辑器）
- **SiteRuleManager.ts**：[`src/main/services/SiteRuleManager.ts`](./src/main/services/SiteRuleManager.ts)（自定义站点规则管理器）
- **ElementPicker.ts**：[`src/main/services/ElementPicker.ts`](./src/main/services/ElementPicker.ts)（元素拾取器）
- **ContentExtractor.ts**：[`src/main/services/ContentExtractor.ts`](./src/main/services/ContentExtractor.ts)（内容提取引擎）
- **BrowserService.ts**：[`src/main/services/BrowserService.ts`](./src/main/services/BrowserService.ts)（浏览器视图管理）
