# B站（哔哩哔哩）平台接入技术文档

> 平台：哔哩哔哩 / B站（bilibili.com）
> 接入范围：账号管理（登录态检测 + 账号信息提取）
> 创作中心：`https://member.bilibili.com/`（未登录自动跳转至 passport.bilibili.com 登录页）
> 实现文件：`src/main/services/platforms/bilibili.ts`
> 图标文件：`src/renderer/assets/bilibili.png`
> 状态：✅ 账号管理已实现 / 🚧 发布功能待实现

---

## 一、平台元信息配置

### 1.1 基础信息（PlatformMeta）

| 字段 | 值 | 说明 |
|:---|:---|:---|
| `key` | `bilibili` | 平台唯一标识 |
| `name` | `哔哩哔哩` | UI 展示名 |
| `icon` | `B` | 兜底字符（有 PNG 图标时优先使用图标） |
| `platformAccountLabel` | `UID` | 平台账号 ID 标签（B站账号编号叫 UID） |
| `authUrl` | `https://member.bilibili.com/` | 授权窗口加载 URL（创作中心） |
| `publishUrl` | `https://member.bilibili.com/v2#/upload/video/frame` | 视频发布页 |
| `homeUrl` | `https://member.bilibili.com/` | 平台首页 |
| `contentTypes` | `['video', 'image', 'article']` | 支持的内容类型（理论上） |

### 1.2 内容长度限制

| 限制类型 | 标题 | 正文 | 说明 |
|:---|:---|:---|:---|
| `contentLimits`（动态/图文） | 80 字 | 2000 字 | 动态 / 普通图文发布 |
| `articleLimits`（专栏） | 100 字 | 20000 字 | 专栏文章（bilibili 专栏） |

### 1.3 能力声明（AccountCapabilities）

当前三项全部为 `false`（占位实现，实际调用会返回「B 站视频/图文/专栏发布功能尚未实现」）：

```typescript
capabilities: {
  publishVideo: false,   // TODO: 视频投稿
  publishImage: false,   // TODO: 图文动态 / 专栏配图
  publishArticle: false, // TODO: 专栏文章
}
```

---

## 二、登录态检测（detectLoggedIn）

### 2.1 检测优先级（四重验证）

```
1. Cookie 检测（最高优先级）：SESSDATA 存在且非空 → 已登录
2. URL 检测：当前页处于 passport.bilibili.com / 登录相关路径 → 未登录
3. 域名检测：当前 URL 属于 member.bilibili.com 或 space.bilibili.com 且非登录页 → 加分项
4. DOM 辅助检测：查找用户信息元素 + 页面文本关键字（"创作中心"/"退出登录"/"投稿"等）
```

### 2.2 核心登录凭证 Cookie

| Cookie 名称 | 作用 |
|:---|:---|
| `SESSDATA` | **核心登录态凭证**，存在且非空即可认为已登录 |
| `bili_jct` | CSRF Token（发布功能时会用到，目前仅做标记） |
| `DedeUserID` / `DedeUserID__ckMd5` | 用户 UID 与校验（可辅助获取账号 ID） |

### 2.3 URL 判定规则

```typescript
// 未登录：处于 B 站统一登录域
isLoginPage = currentUrl.includes('passport.bilibili.com')
           || currentUrl.includes('/login')
           || currentUrl.includes('bilibili.com/login');

// 登录成功：进入创作中心或个人空间域
inBackend = (currentUrl.includes('member.bilibili.com')
          || currentUrl.includes('space.bilibili.com'))
          && !isLoginPage;
```

### 2.4 DOM 辅助检测（executeJavaScript）

在页面上检查以下元素/文本：

| 检查项 | 说明 |
|:---|:---|
| 昵称元素 | `.user-info .name` / `.username` / `[class*="user-name"]` / `[class*="nickname"]` |
| 页面关键字 | 「创作中心」「内容管理」「数据中心」「退出登录」「投稿」「我的主页」 |
| 组合判断 | 有昵称元素 **或** (有「退出登录」+ 有侧边栏菜单关键字) → 视为 DOM 已登录 |

### 2.5 返回的 LoginCheckResult

- `loggedIn = !!SESSDATA && !isLoginPage`（Cookie 优先）
- `matchedKeywords`：汇总所有命中的 cookie 名 + URL 标志 + DOM 标志，便于调试

---

## 三、账号信息提取（extractPageInfo）

### 3.1 提取范围

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `nickname` | `string` | 用户昵称 |
| `avatar` | `string` | 头像 URL（http → https 强制升级） |
| `platformAccountId` / `userId` | `string` | B 站 UID（纯数字，8-12 位） |
| `fansCount` | `number?` | 粉丝数 |
| `followCount` | `number?` | 关注数 |
| `likeCount` | `number?` | 获赞 / 点赞 / 播放 / 转评赞总数（根据页面可拿到的字段） |

### 3.2 字符安全净化（Guarding）

B站适配器实现了与微信视频号同等级的**严格字符净化**：

1. **QUOTE_LIKE_CHARCODES（28 种类引号字符黑名单）** — 逐字符剔除（U+0027、U+2018…U+201F、中文「」『』等）
2. **控制字符替换** — `\t \n \r \v \f` → 空格，连续空白合并为单个空格
3. **URL 规范化** — 协议相对路径 `//xxx.com` 补 `https:`，正文杂糅文本用正则提取首个 `https?://` URL
4. **B站自有域名强制升级 http→https**

#### B 站强制 HTTPS 的域名白名单：
```
bilibili.com, bilibili.cn, hdslb.com, b23.tv, bilivideo.com,
acgvideo.com, bilibili.tv, biligame.com, bilibiliapi.com,
bilibicdn.com, bilibili.work, biliapi.com, biliimg.com,
bilicdn1.com, bilicdn2.com, bilicdn3.com, bilicdn4.com,
bilicdn5.com, wdfpstatic.com
```

### 3.3 UID（platformAccountId）提取策略

按优先级依次尝试，命中即停止：

| 策略 | 说明 |
|:---|:---|
| **DedeUserID Cookie** | 从 `electron session.cookies` 中直接读取 `DedeUserID`，格式即为纯数字 UID |
| **URL 匹配** | 创作中心页带参数 `/xxxxx` 或空间域 `space.bilibili.com/12345678` → 正则 `\/(\d{8,12})` |
| **用户头像链接** | `a[href*="space.bilibili.com"]` → 从 `href` 中再走一次 URL 正则 |
| **body 文本匹配** | 「UID：12345678」「UID 12345678」 → 正则 `/UID[：:\s]*(\d{5,12})/` |

### 3.4 昵称提取选择器（按优先级尝试）

```
.user-info .name
.username
.nick-name
[class*="user-name"]
[class*="nickname"]
.header .name
.topbar-user .name
.nameBox .userName
.person_name
.name
h1
```

### 3.5 头像提取选择器（按优先级尝试）

B站创作中心的实际 DOM：
```html
<a class="avatar el-popover__reference">
  <img class="custom-lazy-img" src="//i0.hdslb.com/xxx.jpg">
</a>
```

选择器优先级：
```
a.avatar img.custom-lazy-img
img.custom-lazy-img
a[href*="space.bilibili.com"] img
.avatar img / a.avatar img
[class*="avatar"] img
img.avatar
.user-info img / .header img / .topbar-user img
.wave-icon img
```

### 3.6 粉丝/关注/获赞 数提取

采用**双路径**方案（任一命中即填充）：

#### 路径 A：DOM class 含 `number` / `count` / `num` 的数字元素 + 兄弟 label 配对

- 遍历所有 `[class*="number"], [class*="count"], [class*="num"]` 元素
- 对其文本做数字解析（支持「万 / 千 / 百 / 亿」后缀换算）
- 在同级 children 中找 label 文本：包含"粉丝"→fansCount、"关注"→followCount、"获赞/点赞/收藏/转评赞/播放"→likeCount
- 若找不到兄弟 label，再检查父元素 `textContent` 中是否有相关关键词

#### 路径 B：body 全文正则兜底（双向，解决 label 和数字的前后位置）

如粉丝数：
```
标签在前：/(粉丝|粉丝数)[^0-9]{0,5}(\d+(?:\.\d+)?[万千百亿]?)/
标签在后：/(\d+(?:\.\d+)?[万千百亿]?)[^0-9]{0,5}(粉丝|粉丝数)/
```

---

## 四、发布功能（待实现占位）

### 4.1 三个占位函数均返回 `makeFailedResult`

| 函数 | 失败原因文本 |
|:---|:---|
| `publishVideo()` | `'B 站视频发布功能待实现'` |
| `publishImage()` | `'B 站图文发布功能待实现'` |
| `publishArticle()` | `'B 站专栏发布功能待实现'` |

通用 `publish()` 入口按 `request.contentType` 分发到上述三者。

### 4.2 未来对接参考页面

- **视频投稿页**：`https://member.bilibili.com/v2#/upload/video/frame`
- **专栏投稿页**：`https://member.bilibili.com/v2#/upload/article/article`
- **动态（图文）**：创作中心首页或 `t.bilibili.com`

发布功能实现时建议参考知乎文档的「10步流程」+「CDP 文件上传」+「Draft.js/exeCommand 富文本填写」模式。

---

## 五、接入流程回顾（如何接入的 B 站）

本项目所有新平台接入都遵循以下 **5 步接入 SOP**：

```
步骤 1：新建 platforms/<key>.ts  适配器 + registerPlatform()
步骤 2：编辑 platforms/index.ts  追加 side-effect import
步骤 3：编辑 types/index.ts       追加 KNOWN_PLATFORMS 数组项
步骤 4：前端图标注册              AccountPanel/Dashboard/AnalyticsPanel PLATFORM_ICONS 加 import + 映射
步骤 5：PublishForm 工具函数     platformName() / iconOf() 加硬编码映射
```

**B站已完成：**
- ✅ [bilibili.ts](file:///e:/WORK/flowx/flowx-desktop/src/main/services/platforms/bilibili.ts) 适配器
- ✅ `platforms/index.ts` side-effect import
- ✅ `KNOWN_PLATFORMS` 含 `bilibili`
- ✅ `PLATFORM_ICONS` 三处（AccountPanel / Dashboard / AnalyticsPanel）均已 import `iconBilibili from 'assets/bilibili.png'` 并注册
- ✅ PublishForm `platformName` / `iconOf` 已映射「哔哩哔哩」+ 📺

---

## 六、排错指南

### 6.1 登录 / 授权相关

| 现象 | 可能原因 | 排查方法 |
|:---|:---|:---|
| 扫码成功但仍判定「未登录」 | Cookie 未写入当前 partition，或写入后立即失效 | 检查 `detectLoggedIn` 日志中的 `matchedKeywords`，看 SESSDATA 是否被记录 |
| 一直停在登录页不跳转 | B 站风控：需要二次验证 / 验证码 | 登录窗口保持打开，等用户手动完成验证 |
| 授权成功但 UID 没取到 | Cookie 的 DedeUserID 被 HttpOnly 限制无法从 JS 侧读（本实现从 electron session 读，可绕过） | 看 `extractPageInfo` 日志里是否有「从 Cookie 提取到 UID」的记录 |

### 6.2 信息提取相关

| 现象 | 可能原因 | 排查方法 |
|:---|:---|:---|
| 昵称/头像提取为 `''` | B 站前端改版，选择器失效 | 用 DevTools 打开创作中心 DOM，对照 `nicknameSelectors` / `avatarSelectors` 数组更新 |
| 头像 URL 以 `//` 开头 | B 站默认返回协议相对路径 | 适配器的 `_normalizeUrl` 已处理（自动补 `https:`），看诊断日志是否走到该分支 |
| 粉丝数一直为 `n/a` | B 站创作中心数据卡片 DOM 换了 class | 看 DOM 提取脚本的返回值，补充 class 关键字匹配 |
| 头像末尾包含异常字符 / 引号 | 新版 DOM 返回的属性带杂糅字符 | 检查「[CHARCODE] guardAvatar」诊断日志，追加黑名单字符到 `QUOTE_LIKE_CHARCODES` |

### 6.3 调试技巧

1. **打开授权窗口 DevTools**：在 AccountService.openAuthWindow 创建完 `win` 后临时加一行 `win.webContents.openDevTools()`
2. **验证 Cookie**：Console 中执行
   ```javascript
   document.cookie.split(';').map(s => s.trim()).filter(s => s.startsWith('SESSDATA') || s.startsWith('DedeUserID'))
   ```
3. **验证昵称选择器**：Console 中依次执行以下，看哪条有返回
   ```javascript
   document.querySelector('.user-info .name')?.textContent
   document.querySelector('[class*="user-name"]')?.textContent
   document.querySelector('.nick-name')?.textContent
   ```
4. **强制触发 extractPageInfo**：在授权成功回调的 `afterLoginCheck` 打断点查看返回值

---

## 七、未来变更风险点

1. **创作中心 URL 改版**：`member.bilibili.com/v2` 路径可能被替换
2. **类名哈希化 / 组件替换**：`custom-lazy-img`、`avatar` 等 class 可能因 Vue/React 组件重构变化
3. **登录 Cookie 改名**：`SESSDATA` → 改名时同步修改 detectLoggedIn
4. **UI 布局变化**：粉丝/关注/获赞的数据卡片 class 命名可能调整
5. **新增风控字段**：发布投稿时可能需要 Geetest 等验证码，届时发布流程需引入用户辅助

---

## 八、关键代码文件索引

| 文件 | 说明 |
|:---|:---|
| `src/main/services/platforms/bilibili.ts` | B 站平台适配器（登录检测 + 信息提取 + 发布占位） |
| `src/main/services/platforms/registry.ts` | `registerPlatform()` 注册中心 |
| `src/main/services/platforms/shared.ts` | `makePublishLogger` / `makeFailedResult` 等共享工具 |
| `src/main/services/platforms/index.ts` | 所有平台 side-effect import 清单 |
| `src/types/index.ts` | `KNOWN_PLATFORMS` / `PlatformMeta` / `AccountCapabilities` 类型 |
| `src/renderer/pages/AccountPanel.vue` | 账号授权 + 平台列表两列布局 |
| `src/renderer/pages/Dashboard.vue` | 仪表盘 PLATFORM_ICONS 注册 |
| `src/renderer/pages/AnalyticsPanel.vue` | 数据分析面板 PLATFORM_ICONS 注册 |
| `src/renderer/components/PublishForm.vue` | 发布表单 `platformName()` / `iconOf()` 映射 |
| `src/renderer/assets/bilibili.png` | B 站平台图标（PNG 方形 48x48+） |
