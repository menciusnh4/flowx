# 更新日志

All notable changes to the FlowX Desktop project will be documented in this file.

---

## [v0.1.7] - 2026-07-30

> X（Twitter）平台账号管理接入 · 多源账号信息精准提取 · 前端平台图标集成

### ✨ 亮点速览

- 🐦 **X（Twitter）账号管理接入** — 全新平台适配器 `x.ts`，支持扫码授权、登录态检测、昵称/头像/handle/粉丝数/关注数提取、刷新账号信息、打开创作中心
- 🧠 **多源账号信息提取策略** — 优先从 `window.__INITIAL_STATE__`（`state.entities.users.entities` / `state.user` / `state.session.user` / `state.currentUser`）提取昵称、头像、handle；同时支持 `SideNav_AccountSwitcher_Button` DOM、`UserAvatar-Container-<handle>` data-testid、meta/title 等 8 级兜底策略
- 🎨 **前端 X 平台图标集成** — 新增 `assets/x.svg`（黑底白 X 风格），并在账号管理页、仪表盘、数据分析页三个页面的 `PLATFORM_ICONS` 中完成映射
- 🔧 **发布功能占位实现** — `publishVideo / publishImage / publishArticle` 默认返回"发布功能开发中"提示，避免平台选择时出现空实现异常

### 🚀 新功能

#### 1. X（Twitter）平台适配器（`src/main/services/platforms/x.ts`）

| 能力 | 实现方式 |
|---|---|
| **登录态检测** | 优先 `auth_token` + `ct0` cookie → URL 保护页命中 → DOM 辅助（Home 导航/Compose 按钮/Profile 链接/退出文本）综合判断 |
| **昵称提取** | ① `window.__INITIAL_STATE__` 多路径 → ② `SideNav_AccountSwitcher_Button` 内 span 过滤 @ → ③ 按钮内 `[aria-label]` → ④ `User-Name` → ⑤ `UserAvatar-Container-*` 子 `[aria-label]` → ⑥ `og:title` → ⑦ `document.title` |
| **头像提取** | ① `__INITIAL_STATE__` 中 `profile_image_url_https` / `profile_image_url` → ② 账号切换按钮 `img` → ③ `UserAvatar-Container-*` 容器 `img` → ④ `AppTabBar_Profile_Link img` → ⑤ meta `og:image` → ⑥ 兜底 `pbs.twimg.com/profile_images` |
| **Handle 提取** | ① `__INITIAL_STATE__` 中 `screen_name`（正则校验 `^[a-zA-Z0-9_]{1,15}$`）→ ② `UserAvatar-Container-<handle>` data-testid 正则提取 → ③ 按钮 `@xxx` 文本 → ④ 按钮内 `a[href]` → ⑤ 个人资料链接 → ⑥ title/meta → ⑦ body 全文 |
| **创作中心 URL** | `https://x.com/home` |
| **发布入口 URL** | `https://x.com/compose/post`（占位，发布功能待开发） |

#### 2. 平台注册表与类型扩展

- `src/types/index.ts`：`KNOWN_PLATFORMS` 数组新增 `'x'`
- `src/main/services/platforms/index.ts`：新增 `import './x'` 隐式注册入口
- `PlatformMeta.contentLimits`：推文正文字数限制 280 字符；长推文（article）限制 25000 字符
- `PlatformMeta.nicknameSelectors / avatarSelectors`：列出 DOM 兜底选择器，供外部诊断工具使用
- `capabilities`：`publishVideo / publishImage / publishArticle` 均设为 `false`，明确当前仅账号管理

#### 3. 前端三页图标映射

| 页面 | 文件 | 变更 |
|---|---|---|
| 账号管理 | `AccountPanel.vue` | `import iconX from '../assets/x.svg'` + `PLATFORM_ICONS.x = iconX` |
| 仪表盘 | `Dashboard.vue` | 同上 |
| 数据分析 | `AnalyticsPanel.vue` | 同上 |

### 📐 设计要点

- **分层兜底**：每个字段（昵称/头像/handle）均采用 `window.__INITIAL_STATE__` 第一层 + DOM 精确匹配第二层 + meta/title 第三层 + body 全文第四层的四级架构；任何一层失败都不会影响其他字段
- **用户偏好对齐**：handle 提取使用 `platformAccountId` 字段（符合「用平台原生账号 ID 筛选」的偏好），并对从 `data-testid` 提取的 handle 做严格 `^[a-zA-Z0-9_]{1,15}$` 校验，避免脏数据
- **失败安全**：所有注入脚本使用独立 try-catch，单个脚本失败仅记录 warn 日志，整个 `extractPageInfo` 一定会返回至少 `{ nickname: '' }`，不会向上层抛异常
- **向后兼容**：`meta.icon = 'X'` 字符串占位保留，`PLATFORM_ICONS.x` 前端映射优先于 meta.icon；两者并存不冲突

### 🧪 验证结果

- 对 `x.ts` 中 **4 个 `executeJavaScript` 注入脚本**（登录检测 / 昵称提取 / 头像提取 / handle 提取）做独立语法校验，全部通过
- TypeScript 平台适配器接口方法签名校验通过（`detectLoggedIn` / `extractPageInfo` / `publish`）

---

## [v0.1.6] - 2026-07-29

> 知乎平台数据分析接入 · CDP API 监听精准采集 · 账号周期数据 · 增量采集稳定化

### ✨ 亮点速览

- 🧠 **知乎数据分析新增接入** — 知乎平台已加入数据分析采集范围，覆盖「账号概览 / 作品列表 / 内容分析周期数据 / 关注者分析周期数据」四个模块
- 📡 **作品列表改走官方 API 监听（CDP Debugger Network）** — 不再依赖 DOM 文本解析为主方案；直接拦截 `GET /api/v4/creators/creations/v2/all` JSON 响应，标题/时间/指标全部来自接口原始字段，解决之前「4 条作品抓 5 页 20 条重复、标题带类型前缀、发布时间是当天、指标（views/likes/favorites/shares）互相串位」等一批顽疾
- 📊 **内容分析 + 关注者分析周期数据（近 7 天 / 近 30 天）** — 内容分析从「最近 7 天 / 最近 14 天 / 最近 30 天 / 累计」tab 取阅读/播放/赞同/喜欢/收藏/评论/转发等全量指标；关注者分析单独采集新增/减少/净增关注者，30 天周期额外补充活跃关注者
- 🔁 **增量采集再加固** — workId 改稳定命名（`zh_${type}_${creationId}`），不再带页码/索引哈希；`paging.is_end=true` 时立即停止翻页，不会多跑 4 页重复数据
- 🏗️ **回退保障** — CDP API 监听链路任何一步异常（Debugger 附加、未拿到第一页响应、翻页超时等）**自动回退 DOM 解析**，不会整个采集任务失败

### 🚀 新功能

#### 1. 知乎账号分析接入

左侧「数据分析」平台筛选、账号注册流程均支持知乎（平台 key = `zhihu`，显示名「知乎」，与发布模块的平台适配器已对齐、自动复用）。

- **作品列表采集**（[ZhihuCollector.ts](flowx-desktop/src/main/services/analytics/platforms/ZhihuCollector.ts)）
  - 入口页面：`https://www.zhihu.com/creator/manage/creation/all`
  - 主方案：CDP 监听 `/api/v4/creators/creations/v2/all`，原生 JSON 字段，支持 answer / article / pin（想法）/ zvideo（视频）四种创作类型
  - 回退方案：DOM 解析，对作品行的「数值-数值-标签」三段式格式（如图片想法 `[2, 114, 被浏览]`）做 i-2 向前看双格容错
- **账号概览采集**（`collectAccountOverview`）
  - 作品数：内容管理页「共 N 条内容」+ 列表聚合兜底
  - 粉丝数：关注者分析页「关注者总数 / 总关注者数」
  - 获赞数：内容分析页「累计」周期的 `赞同总量 + 喜欢总量` 双字段和
  - 关注数：关注者分析页匹配「关注数 / 关注了」
- **周期数据采集**（`collectAccountAnalytics`，近 7 天 + 近 30 天各一份）
  - 内容分析：`https://www.zhihu.com/creator/analytics/work/all`，周期 tab 切换支持「最近 7 天/近7天/7日 / 最近 30 天/近30天/30日」多种写法（去空格、去 `&nbsp;`、忽略大小写匹配），并对 7d/30d 数据做指纹校验，若一致会重试点击 30d 周期
  - 关注者分析：`https://www.zhihu.com/creator/followers`，采集新增关注者、减少关注者、净增关注者，30d 周期额外存「近 30 日活跃关注者」到 `coreFansCount`

#### 2. 知乎作品 API 字段映射（`parseApiPageWorks`）

| 输出字段 | 真实 API 路径 | 备注 |
|---|---|---|
| workId | `zh_${item.type}_${data.id\|url_token}` | 稳定唯一，增量/去重基于它 |
| title | 1. `data.title`；2. pin→`content[type=text].title`；3. pin→HTML 去标签首句；4. `excerpt`；5. `[${type}] ${id}` 兜底 | 自动剥离「回答/文章/想法/视频」类型前缀 |
| coverUrl | `new_thumbnail / thumbnail / cover`；pin→图块的 `watermark_url / url / original_url` | `http://` 自动转 `https://` |
| detailUrl | answer=`question/${qid}/answer/${id}`；article=`zhuanlan.zhihu.com/p/${id}`；pin=`pin/${id}`；zvideo=`zvideo/${id}` | 全部可直接在浏览器打开 |
| publishTime | `data.created_time * 1000`（秒级才乘） | 真实时间戳，不再是「当天」 |
| views | `reaction.read_count \|\| view_count \|\| play_count` | 兼容「阅读/被浏览/播放」三种口径 |
| likes | `reaction.vote_up_count`（知乎的「赞同」） | |
| comments | `reaction.comment_count` | |
| favorites | `reaction.collect_count`（知乎的「收藏」） | |
| shares | `reaction.repin_count \|\| share_count`（知乎的「转发」） | |
| extra.likesZhihu | `reaction.like_count`（知乎的「喜欢」） | 与 `赞同 / 收藏` 独立分开，不再互相覆盖 |

#### 3. 翻页与去重策略（解决重复采集）

| 停止触发 | 位置 | 效果 |
|---|---|---|
| `paging.is_end === true` | `parseApiPageWorks` 返回 | 第一页命中就不再点「下一页」，不会再 4 条抓成 20 条 |
| `workId` 已在全局 seenIds | 单条循环 | 同作品（跨页/同页重复）只保留第一次出现 |
| `incremental.lastWorkId` 命中 | 单条循环 | 增量采集时直接 break 当前页 + 下一页 |
| `incremental.lastWorkPublishTime >= publishTime` | 单条循环 | 同上，秒级时间戳精度不再会误停/漏停 |
| 翻页 click 失败 / waitForNewResponse 超时 | while 循环 | break 并 warn，不挂死 |
| page >= 50 | while 条件 | 保险上限 |

### 🐛 修复与优化

- **修复「点击知乎采集」直接报错「暂不支持平台: zhihu」** — 实际是已编译的旧 `dist-electron` 产物没有跑新的 `createCollector`；明确部署流程：每次改动采集器后需要重新 `vite build`（或在 dev 模式 vite-plugin-electron 会自动编译），本次已统一重打
- **修复小红书 7d/30d 数据指纹一致时误抓成同一份** — 沿用已有的指纹校验 + 30d 强制重试点击（本次一并给知乎对齐同样的策略）
- **修复快手概览粉丝/关注数都为 0** — 沿用已有的 `parseCompactText` 紧凑型解析与创作数据页访问 URL 校准
- **修复账号概览 `worksCount` 一直为 0** — `collectAccountOverview()` 结果中的 `worksCount` 已正确存入 DB 的 `worksCount` 字段，并在页面 onMounted 选中默认账号后 `loadAccountStats` 会重新触发

### 🔧 技术实现

- **采集器注册**：`AnalyticsService.createCollector` 的 switch 已新增 `case 'zhihu' → new ZhihuCollector(account)`
- **平台枚举**：`types/index.ts` 的 `KNOWN_PLATFORMS` 已包含 `'zhihu'`，前端平台下拉自动显示
- **前端概览 OVERVIEW_GROUPS 兼容**：指标 key 未做平台过滤，知乎产出的 `views/likes/comments/favorites/shares/newFans/lostFans/netFans` 都能直接渲染
- **主进程产物**：`npx vite build`（只跑 Vite，跳过 `vue-tsc --noEmit`，避免抖音/小红书采集器的历史 TS 错误阻断构建；历史错误会在后续单独修）

---

## [v0.1.5] - 2026-07-28

> 账号数据分析功能 · 多平台作品采集 · 多条件筛选 · 真分页

### ✨ 亮点速览

- 📊 **账号数据分析** — 新增账号分析页面，支持多平台作品数据采集和展示
- 🔍 **多条件筛选** — 支持按平台、账号、关键词筛选，按发布时间/点赞/评论等排序
- 📄 **真分页** — 服务端分页，默认 20 条/页，数据量大也流畅
- 🎯 **平台账号ID** — 采集时保存各平台原生账号标识（抖音号/小红书号/快手号/视频号等），筛选使用平台账号ID，稳定可靠
- 📱 **微信视频号图文采集** — 支持视频号图文作品采集，与视频采集独立分开

### 🚀 新功能

#### 1. 账号数据分析页面

新增左侧导航"数据分析"菜单，包含作品列表和数据概览功能。

- **作品列表展示**：封面图、标题、平台图标+平台名称+平台账号ID、发布时间、点赞数、评论数、收藏数、分享数
- **多维度筛选**：
  - 平台筛选（单选下拉框，带平台图标）
  - 账号筛选（多选下拉框，显示头像+昵称+平台账号ID）
  - 关键词搜索（匹配标题）
  - 排序方式（发布时间/点赞数/评论数/收藏数/分享数，升序/降序）
- **搜索按钮**：筛选条件变更不立即查询，点击"搜索"按钮后才执行，避免频繁刷新
- **重置按钮**：一键清空所有筛选条件
- **真分页**：后端分页，前端只加载当前页数据，默认 20 条/页

#### 2. 作品数据采集

选择账号后点击"开始采集"，自动从各平台创作者后台采集作品数据。

- **支持平台**：抖音、小红书、快手、微信视频号
- **采集内容**：作品ID、标题、封面、发布时间、播放/点赞/评论/收藏/分享等指标
- **并发控制**：默认 2 并发，可配置，避免开太多窗口占资源
- **增量采集**：记录上次采集位置，只采集新作品（后续版本完善）
- **平台账号ID**：采集时自动保存各平台原生账号标识，用于数据关联和筛选

#### 3. 微信视频号图文采集

视频号的视频和图文是两个独立的列表，分别采集。

- **视频采集**：从"视频管理"页面采集视频作品
- **图文采集**：从"图文管理"页面采集图文作品
- **脚本重构**：使用 `buildExtractionScript` 方法构建提取脚本，字符串拼接替代模板字符串，避免转义问题
- **停止关键词**：视频和图文分别使用不同的停止关键词判断是否到底

### 🐛 修复与优化

- **平台图标显示**：从本地 `assets` 目录导入 SVG/PNG 图标资源，修复图标加载失败问题
- **账号下拉框头像错位**：自定义头像样式，替代 `el-avatar` 组件，解决多选下拉框中头像与文字不对齐问题
- **筛选条件状态管理**：筛选条件统一在 store 中管理，翻页时不会丢失筛选条件
- **类型兼容**：平台账号ID筛选时使用 `String()` 转换，避免数字/字符串类型不匹配的问题
- **筛选逻辑统一**：所有筛选条件（平台/账号/关键词等）采用统一的过滤方式，逻辑更清晰可靠

### 🔧 技术实现

- **数据存储**：使用 electron-store 持久化存储，key = `analyticsData`
- **数据结构**：`works` 按 `accountId` 分桶存储，`workMetrics` 按 `workId` 存储指标
- **筛选架构**：全量数据加载 → 统一过滤 → 排序 → 分页截取
- **IPC 通道**：`analytics:getWorks` 分页查询，`analytics:collectWorks` 采集作品
- **类型安全**：TypeScript 严格模式，`WorksQueryParams` / `WorkItem` / `WorkMetrics` 完整类型定义

---

## [v0.1.4] - 2026-07-23

> 自定义规则智能提取 · 图文文章自动切换 · Markdown 转换 · 图片拾取优化

### ✨ 亮点速览

- 🧠 **智能内容类型选择** — 自定义规则同时配置图文和文章时，正文超过 1000 字自动选择文章模式，更符合长文阅读习惯
- 📝 **HTML 自动转 Markdown** — 文章模式下自动将提取的 HTML 内容转换为 Markdown 格式，适配小红书/抖音文档导入发布
- 🖼️ **图片拾取容器选择** — 拾取图片时支持选择父级容器，自动提取所有后代图片，不再需要逐张点选
- 🎯 **图片选择器智能感知** — 图片模式下选择器自动追加 ` img` 后代选择器，解决容器选择器无法提取图片的问题
- 📋 **多选预览面板** — 图片/话题多选模式下底部显示已选数量，支持 hover 预览和点击移除

### 🚀 新功能

#### 1. 智能内容类型选择

自定义规则同时配置「图文」和「文章」两种类型时，根据正文长度自动选择最优发布类型。

- **长文自动切文章**：正文超过 1000 字 → 自动选择文章类型
- **短文保持图文**：正文 1000 字及以下 → 使用图文类型
- **全入口生效**：规则面板「应用提取」、浏览器右键菜单「使用自定义规则提取」均支持
- **规则 ID 透传**：提取结果携带 ruleId，渲染进程据此获取规则配置做智能判断

#### 2. HTML 转 Markdown 自动填充

文章模式下自动将提取的 HTML 正文转换为 Markdown 格式，直接填充到 Markdown 编辑器。

- **Turndown 引擎**：使用 turndown 库转换，支持标题、粗体、列表、引用、代码块等常用语法
- **图片自动过滤**：转换时自动移除正文中的图片标签，适配小红书/抖音 Markdown 不支持图片的限制
- **双模式兼容**：替换模式和追加模式均支持 Markdown 内容填充
- **降级保障**：转换失败时自动回退到纯文本模式，不影响正常使用

#### 3. 图片拾取容器选择优化

拾取图片时支持选择父级容器元素，自动提取容器内所有后代图片。

- **智能选择器生成**：新增 `getImageAwareSelector` 函数，图片模式下自动追加 ` img` 后代选择器
- **四级入口统一**：onClick、selectElement、confirmWithElement、confirmSelection 全部使用智能选择器
- **父级容器拾取**：右键菜单「选择父级作为图片容器」，一层一层向上选择容器
- **后代图片提取**：选择器匹配容器元素时，自动提取所有层级的后代 img 元素

#### 4. 多选预览面板

图片和话题多选模式下，页面底部显示已选元素预览栏。

- **实时计数**：显示已选数量（"已选 X 个"）
- **Hover 预览**：鼠标悬停已选标签时高亮页面对应元素
- **点击移除**：点击已选标签的 × 按钮即可移除，支持随时调整
- **确认/取消按钮**：预览栏内置确认和取消按钮，操作更便捷

### ⚡ 体验优化

- 元素拾取器方向键导航改为顶部对齐，不再滚动到视口中间
- 鼠标悬停路径提示改为层级列表形式，一行显示一级，右键可选择层级
- 右键菜单「检查元素」打开独立 DevTools 窗口（detach 模式）
- 修复右键菜单层级选择时左键点击穿透的问题
- 修复多选模式下确认/取消按钮无反应的问题

### 🐛 修复

- 修复图片选择器选中容器元素时无法提取图片的问题
- 修复右键菜单使用自定义规则提取时没有智能判断内容类型的问题
- 修复多选模式下 infoBar 点击事件阻止冒泡导致按钮失效的问题
- 修复方向键导航时页面自动滚动到中间的问题

### 📦 技术细节

| 类别 | 详情 |
|------|------|
| 新增依赖 | `turndown`、`@types/turndown`（HTML 转 Markdown） |
| 新增函数 | `getImageAwareSelector`、`resolveContentTypeByRule` |
| 新增字段 | `ExtractedContent.ruleId`（规则提取时填充） |
| 修改文件 | `src/main/services/ContentExtractor.ts`、`src/main/services/ElementPicker.ts`、`src/renderer/pages/Browser.vue`、`src/types/index.ts` |
| 转换规则 | ATX 风格标题、围栏代码块、短横线列表、图片自动过滤 |

### 🔄 升级方式

**Windows 用户**：下载最新版安装包，直接运行安装即可自动覆盖旧版本。用户数据和账号信息将完整保留。

---

## [v0.1.3] - 2026-07-21

> 浏览器层级体验优化 · 原生菜单 · 独立模态窗口 · 拾取器滚动同步

### ✨ 亮点速览

- 🖱️ **顶部导航栏原生菜单** — 系统配置改用 Electron 原生 Menu，彻底解决 WebContentsView 遮挡问题，浏览器不再闪烁
- 🪟 **关于窗口独立化** — 「关于」改为独立模态 BrowserWindow，打开时浏览器内容不消失
- 🎯 **拾取器滚动同步** — 修复元素拾取器高亮框在网页滚动时错位的问题，滚动实时跟随
- 📄 **设计文档 Markdown 化** — 用户自定义站点规则设计方案新增 Markdown 版本，新增顶部导航栏层级优化章节

### 🚀 新功能

#### 1. 原生菜单替换 HTML 下拉

顶部导航栏的「系统配置」下拉菜单改用 Electron 原生 `Menu` 实现，从根本上解决 WebContentsView 层级遮挡问题。

- **原生菜单层级最高**：由操作系统管理，不会被 WebContentsView 遮挡
- **浏览器零闪烁**：移除了顶部导航栏 hover 隐藏浏览器的临时方案，鼠标经过导航栏时浏览器完全不动
- **菜单项独立触发器**：用 `div.native-menu-trigger` + 自定义样式替代 `el-menu-item`，脱离 `el-menu` 事件系统，避免事件冲突
- **IPC 封装**：主进程 `system:popupNativeMenu`，渲染进程 `electronApi.popupNativeMenu()`

#### 2. 关于窗口独立 BrowserWindow

「关于」对话框从 `el-dialog` 改为独立的模态 `BrowserWindow`，打开时不再需要隐藏浏览器。

- **模态窗口**：`modal: true` + `parent: mainWindow`，保持模态对话框的交互体验
- **无导航栏模式**：路由新增 `meta.hideHeader` 标记，`App.vue` 条件渲染顶部导航栏
- **独立页面组件**：新增 `AboutWindow.vue`，内容与原对话框一致
- **居中显示**：相对于主窗口居中，大小固定 720×600

#### 3. 元素拾取器滚动同步修复

修复了浏览器规则配置中「拾取网页元素」功能在网页滚动时高亮框错位的问题。

- **坐标计算修正**：`getBoundingClientRect()` 返回视口坐标，`position: fixed` 用视口坐标，去除多余的 `scrollX/scrollY` 偏移
- **滚动实时同步**：监听 `window.scroll` 事件，滚动时刷新所有高亮框位置
- **窗口缩放同步**：监听 `window.resize` 事件，窗口大小变化时也刷新位置
- **性能优化**：使用 `requestAnimationFrame` 节流，避免滚动时高频重绘

### 🐛 修复

- 修复顶部导航栏下拉菜单被 WebContentsView 遮挡的问题
- 修复点击「关于」时浏览器内容隐藏的问题
- 修复元素拾取器高亮框在网页滚动时错位的问题
- 修复元素拾取器高亮框位置计算偏移的问题（双重滚动偏移）

### 📝 文档

- 新增 `用户自定义站点规则设计方案.md`（Markdown 版本，从 HTML 转换）
- 设计文档新增第 13.3 节：顶部导航栏下拉菜单层级问题
- 设计文档版本升级至 1.2
- README 目录结构更新（新增 AboutWindow.ts / AboutWindow.vue）
- 文档索引链接更新为 Markdown 版本

### 📦 技术细节

| 类别 | 详情 |
|------|------|
| 新增文件 | `src/main/windows/AboutWindow.ts`、`src/renderer/pages/AboutWindow.vue`、`docs/用户自定义站点规则设计方案.md` |
| 修改文件 | `src/main/ipc/system.ts`、`src/preload/index.ts`、`src/renderer/App.vue`、`src/renderer/router/index.ts`、`src/renderer/utils/electron.ts`、`src/main/services/ElementPicker.ts` |
| 移除代码 | App.vue 中 header hover 隐藏浏览器逻辑、el-dialog 关于对话框 |

---

## [v0.1.2] - 2026-07-18

> 用户自定义站点规则 · 可视化元素拾取 · 浏览器内规则管理 · 内容类型匹配

### ✨ 亮点速览

- 🎯 **自定义站点规则** — 可视化配置网页内容提取规则，优先级高于内置规则
- 🖱️ **元素拾取器** — 鼠标悬停高亮、点击确认，自动推断 CSS 选择器
- 🧩 **浏览器内规则面板** — 右侧 Tab 式管理（发布编辑 + 提取规则），边浏览边配置
- 🏷️ **内容类型匹配** — 规则支持图文/视频/文章多类型，自动匹配最优规则
- 📊 **规则匹配评分** — 域名匹配 + 类型匹配加权评分，智能选择最佳规则

### 🚀 新功能

#### 1. 用户自定义站点规则

支持用户通过**可视化方式**自定义网页内容提取规则，不再受限于内置站点规则，任何网站都能精准提取。

- **规则模型**：名称、匹配方式（域名/正则）、匹配值、内容类型、启用状态、使用次数
- **选择器配置**：正文、标题、作者、日期、站点名、图片、话题、移除元素
- **优先级机制**：自定义规则 > 内置站点规则 > Readability 通用提取 > 文本密度兜底
- **本地存储**：规则数据加密保存，支持导入导出（后续扩展）

#### 2. 可视化元素拾取器

在浏览器页面上**直接点选元素**即可生成 CSS 选择器，无需手动编写，零门槛配置规则。

- **悬停高亮**：鼠标移动时实时高亮当前元素，蓝色边框 + 半透明遮罩
- **点击确认**：左键点击选中元素，自动推断最优 CSS 选择器
- **多元素选择**：支持选择多个同类元素，自动推断公共选择器（提取列表/图集）
- **键盘操作**：ESC 取消拾取、方向键切换元素层级
- **选择器推断算法**：从 ID → Class → 属性 → 层级路径，优先选择最稳定、最简洁的选择器

#### 3. 浏览器内规则管理面板

规则管理深度集成到浏览器界面，**右侧 Tab 面板**与发布表单并排展示，边浏览边配置规则。

- **Tab 切换**：「发布编辑」与「提取规则」一键切换
- **当前网站匹配**：自动识别当前网页匹配的规则，绿色标记一目了然
- **快捷操作**：应用提取、编辑、启用/禁用、删除
- **草稿状态**：未保存的规则带徽章提示，避免误操作丢失
- **无匹配引导**：当前网站无规则时，一键创建本站规则

#### 4. 右键菜单快捷创建

在浏览器页面**右键即可快速添加自定义规则**，根据点击位置智能推断要配置的字段。

- 右键菜单新增「添加自定义规则」入口
- 自动打开右侧规则面板并进入新建状态
- 支持从图片、链接、正文等不同位置右键创建
- 自定义规则按匹配度排序，优先显示最相关的规则

#### 5. 内容类型匹配

每条规则可绑定**多个内容类型**（图文/视频/文章），提取时根据当前发布类型自动匹配最优规则。

- 规则支持配置适用的内容类型（可多选）
- 匹配评分：域名完全匹配 + 类型匹配 = 最高优先级
- 类型不匹配的规则自动过滤，避免干扰
- 未配置类型的规则适用于所有类型（兼容旧规则）

### ⚡ 体验优化

- 右侧面板从抽屉式改为 Tab 分栏式，彻底解决 z-index 遮挡浏览器视图问题
- 规则保存时自动去除 Vue 响应式代理，修复 "An object could not be cloned" 错误
- 拾取器启动时自动切换到规则面板，操作流程更顺畅
- 匹配规则卡片绿色高亮，视觉上快速区分
- 规则列表按使用次数排序，常用规则靠前展示

### 🔧 技术实现

- **SiteRuleManager**：单例规则管理器，CRUD + 匹配评分 + 持久化
- **ElementPicker**：元素拾取服务，悬停高亮 + 点击捕获 + 选择器推断
- **BrowserRulePanel.vue**：浏览器内规则管理面板组件
- **SiteRuleEditor.vue**：规则编辑器（新建/编辑复用）
- **IPC 通道**：`browser:startPicker` / `browser:pickerResult` / `browser:pickerCancelled` / `site-rule:*`
- **数据模型**：`CustomSiteRule` / `RuleDraft` / `PickerResult` / `PickerFieldType`

### 📊 数据概览

| 指标 | 数值 |
|:---|:---|
| 核心用例通过率 | 100% |
| 支持平台数量 | 8 个 |
| 发布内容类型 | 视频 / 图文 / 文章 |
| 自定义规则字段 | 8 种选择器 + 2 种匹配方式 + 3 种内容类型 |

### 🔄 升级方式

**Windows 用户**：下载最新版安装包，直接运行安装即可自动覆盖旧版本。用户数据和账号信息将完整保留。

---

## [v0.1.1] - 2026-07-10

> 多平台内容发布工具 · 新增微信视频号支持 · 浏览器内容提取 · 测试发布模式 · 对外 API 接口

### ✨ 亮点速览

- 🏷️ **多账号分类** — 自定义分类分组管理
- 🔒 **环境隔离** — 浏览器指纹 UA 与代理 IP 独立隔离
- 📝 **内容提取** — 自动化浏览器一键提取网页内容至发布表单
- 🧪 **测试发布** — 填写完成后停留确认，无误后再发布
- 🔌 **API 接口** — 提供对外 HTTP 接口，支持第三方系统调用一键发布

### 🚀 新功能

#### 1. 多账号分类管理

支持将账号按**自定义分类**进行分组管理，解决账号数量多时查找和管理困难的问题。

- 创建和管理自定义分类（如"工作号"、"个人号"、"测试号"等）
- 每个账号可绑定一个或多个分类
- 发布页面支持按分类快速筛选账号
- 分类数据加密本地存储，保障数据安全

#### 2. 浏览器指纹 UA 与代理 IP 隔离

每个浏览器环境拥有**独立的 User-Agent 和代理 IP**，实现真正的环境隔离，避免账号关联风险。

- 自定义 User-Agent，模拟不同设备和浏览器
- 支持 HTTP / SOCKS5 代理配置，每个环境独立出口 IP
- 浏览器环境管理面板，可创建、编辑、删除环境
- 发布任务可选择指定的浏览器环境执行

#### 3. 自动化浏览器网页内容提取

内置多标签浏览器，支持**一键提取网页正文、标题、图片**，直接填充到发布表单，大幅提升内容创作效率。

- 多策略提取引擎：站点规则适配 + Readability 通用提取 + 文本密度兜底
- 支持微信公众号、知乎、今日头条、36氪、简书等 10+ 主流站点
- 分栏布局：左侧浏览器 + 右侧发布表单，宽度可拖拽调节
- 右键菜单手动提取：图片、元素、整页、元素选择模式
- 图片智能过滤：广告域名、尺寸、比例、语义五级过滤

#### 4. 测试发布模式

**仅填写表单不真正发布**，自动停留在发布页供人工确认，确认无误后再一键发布，降低误发风险。

- 测试模式下发布按钮自动高亮标记，醒目易识别
- 自动检测表单填写状态：标题、正文、话题、封面是否填写
- 生成可视化测试报告，每项检测结果一目了然
- 发布历史支持"重新测试"和"立即发布"操作
- 测试窗口保持打开，方便手动检查每一项内容

#### 5. 微信视频号一键发布

新增**微信视频号**平台支持，视频和图文内容均可一键发布，覆盖微信生态内容分发。

- 视频发布：支持视频上传 + 标题 + 描述 + 话题
- 图文发布：支持多图上传 + 标题 + 描述文案
- 微前端 iframe 架构适配，Shadow DOM 双层穿透点击
- CDP 物理鼠标事件合成（isTrusted=true），绕过风控检测
- 同步阻塞式 UA 净化，避免平台识别自动化特征

#### 6. 账号管理新增今日头条与知乎

账号管理平台扩展，新增**今日头条**和**知乎**两个内容平台，为后续发布能力做准备。

| 平台 | 状态 |
|:---|:---|
| 🎵 抖音 | ✅ 已支持 |
| 📕 小红书 | ✅ 已支持 |
| ⚡ 快手 | ✅ 已支持 |
| 💬 微信视频号 | ✅ 已支持（v0.1.1 新增） |
| 📰 今日头条 | ✅ 账号管理（v0.1.1 新增） |
| 💡 知乎 | ✅ 账号管理（v0.1.1 新增） |
| 📺 哔哩哔哩 | ✅ 账号管理 |
| 📢 微博 | ✅ 账号管理 |

#### 7. 对外 API 接口（支持接口一键发布）

提供 **HTTP REST API 接口**，允许第三方系统通过接口调用 FlowX 的发布能力，实现自动化工作流集成。

- 本地 HTTP 服务（默认端口可配置），支持 JSON 请求
- 接口提交发布任务，支持多账号、多平台批量发布
- 支持查询发布状态、获取发布结果、取消任务
- 支持测试模式接口调用，便于自动化测试
- Token 鉴权机制，保障接口调用安全
- 可与工作流工具（如 n8n、Zapier）或自建系统无缝对接

### ⚡ 稳定性提升

针对发布过程中的各种异常场景进行系统性优化，**大幅提升发布成功率**和用户体验。

- Electron 升级至 31.7.7（Chromium 126），从根源解决渲染进程崩溃问题
- 导航跟踪器优化，避免"Render frame was disposed"错误
- 发布类型切换自动清理不兼容的选中账号（如切换到文章自动取消视频号选中）
- 失败任务保留发布窗口，方便手动处理和排查
- 发布失败支持重试、编辑重发，无需从头填写
- evalJS 6 次重试 + 临时错误识别，增强 DOM 操作稳定性

### 📊 数据概览

| 指标 | 数值 |
|:---|:---|
| 核心用例通过率 | 100% |
| 支持平台数量 | 8 个 |
| 发布内容类型 | 视频 / 图文 / 文章 |

### 🔄 升级方式

**Windows 用户**：下载最新版安装包，直接运行安装即可自动覆盖旧版本。用户数据和账号信息将完整保留。

---

## [v0.1.0] - 2026-06-01

- 初始版本发布
- 支持抖音、小红书、快手三大平台
- 视频/图文一键发布
- 账号管理与加密存储
- 发布任务并发控制
