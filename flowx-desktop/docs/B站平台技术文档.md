# B站平台技术文档（合并版）

> 平台：B站 / 哔哩哔哩（bilibili.com）
> 创作中心：`https://member.bilibili.com/platform/upload-manager/article`
> 实现文件：`src/main/services/platforms/bilibili.ts`
> 图标文件：`src/renderer/assets/bilibili.png`
> 状态：✅ 账号管理 / 🚧 视频发布待实现 / 🚧 图文发布待实现 / 🚧 专栏文章发布待实现

---

## 目录总览

```
第一章  平台接入总览
  1.1 平台元信息配置
  1.2 功能能力矩阵
第二章  账号接入
  2.1 登录态检测（detectLoggedIn）
  2.2 账号信息提取（extractPageInfo）
  2.3 B站 UID 提取策略
  2.4 粉丝/关注/获赞数提取
第三章  视频发布 — 占位
第四章  图文/动态发布 — 占位
第五章  专栏文章发布 — 占位
第六章  排错指南
第七章  关键代码索引
```

---

## 第一章 平台接入总览

### 1.1 平台元信息配置（PlatformMeta）

| 字段 | 值 | 说明 |
|:---|:---|:---|
| `key` | `bilibili` | 平台唯一标识 |
| `name` | `B站` | UI 展示名 |
| `icon` | `B` | 兜底字符（有 PNG 图标时优先使用图标） |
| `platformAccountLabel` | `B站UID` | 平台账号 ID 标签 |
| `authUrl` | `https://member.bilibili.com/platform/upload-manager/article` | 授权窗口加载 URL |
| `publishUrl` | `https://member.bilibili.com/platform/upload-manager/article` | 发布页 URL |
| `homeUrl` | `https://member.bilibili.com/` | 平台首页 |
| `contentTypes` | `['video', 'image', 'article']` | 支持的内容类型（计划中） |

### 1.2 功能能力矩阵

| 功能模块 | `PublishRequest.contentType` | 入口 | 状态 |
|:---|:---:|:---|:---:|
| 账号接入 | - | `member.bilibili.com` | ✅ |
| 视频发布 | `video` | 创作中心「视频投稿」 | ❌ 待实现 |
| 图文/动态发布 | `image` | 创作中心「动态」 | ❌ 待实现 |
| 专栏文章发布 | `article` | 创作中心「专栏管理」 | ❌ 待实现 |

---

## 第二章 账号接入

### 2.1 登录态检测（detectLoggedIn）

**检测策略**：
```
1. URL 检测：
   - 未登录：URL 包含 login / passport / sso
   - 已登录：URL 包含 member.bilibili.com 且非登录页

2. Cookie 检测：
   - SESSDATA cookie 存在（B站核心登录态凭证）
   - bili_jct cookie（CSRF token，辅助判断）

3. DOM 辅助检测：
   - 用户头像 / 昵称元素存在
   - 页面文本包含「创作中心」「投稿」等关键词
```

**核心登录凭证 Cookie**：

| Cookie 名称 | 作用 |
|:---|:---|
| `SESSDATA` | **核心登录态凭证**（最重要，存在且非空即可认为已登录） |
| `bili_jct` | CSRF token（辅助判定，提交表单时需要） |
| `DedeUserID` | 用户 UID（辅助判定） |
| `DedeUserID__ckMd5` | UID 校验值（辅助判定） |

### 2.2 账号信息提取（extractPageInfo）

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `nickname` | `string` | 昵称 |
| `avatar` | `string` | 头像 URL |
| `platformAccountId` / `userId` | `string` | B站 UID（纯数字） |
| `fansCount` | `number?` | 粉丝数 |
| `followCount` | `number?` | 关注数 |
| `likeCount` | `number?` | 获赞数 |

### 2.3 B站 UID 提取策略

按优先级依次尝试：

| 策略 | 说明 |
|:---|:---|
| **Cookie DedeUserID** | 直接从 cookie 中读取（最准确） |
| **URL space.bilibili.com/{uid}** | 个人空间路径中提取 |
| **DOM 提取** | 页面链接 `href` 中含 `/space/` 的 UID |
| **body 文本匹配** | 正则匹配纯数字 UID（5-12 位） |

### 2.4 粉丝/关注/获赞数提取

**双路径方案**：
1. DOM class 含 number/count/num 的数字元素 + 兄弟 label 配对
2. body 全文正则双向兜底

支持「万 / 千 / 亿」后缀换算。

---

## 第三章 视频发布 — 占位

| 状态 | 说明 |
|:---:|:---|
| ❌ `publishVideo: false` | 未接入 |
| 建议入口 | 创作中心 → 视频投稿 → 上传视频 |
| 接入 TODO | 上传视频、填写标题/简介/分区、封面设置、发布按钮 |

---

## 第四章 图文/动态发布 — 占位

| 状态 | 说明 |
|:---:|:---|
| ❌ `publishImage: false` | 未接入 |
| 建议入口 | 创作中心 → 动态 → 发布动态 |
| 接入 TODO | 图片上传、文字填写、话题、发布按钮 |

---

## 第五章 专栏文章发布 — 占位

| 状态 | 说明 |
|:---:|:---|
| ❌ `publishArticle: false` | 未接入 |
| 建议入口 | 创作中心 → 专栏管理 → 发布专栏 |
| 接入 TODO | 标题、正文编辑器、封面、分类、发布按钮 |

---

## 第六章 排错指南

| 失败现象 | 可能原因 | 排查方法 |
|:---|:---|:---|
| 登录后仍判未登录 | SESSDATA cookie 未写入 | 检查 detectLoggedIn 日志的 cookie 列表 |
| UID 提取失败 | 新页面结构变化 | 检查 DedeUserID cookie 是否存在 |
| 授权窗口加载异常 | 网络问题或风控 | 检查页面 Network 面板 |

---

## 第七章 关键代码索引

| 文件 | 说明 |
|:---|:---|
| `src/main/services/platforms/bilibili.ts` | B站平台适配器（账号接入已实现） |
| `src/main/services/platforms/registry.ts` | `registerPlatform()` 注册中心 |
| `src/main/services/platforms/shared.ts` | 共享工具函数 |
| `src/main/services/platforms/index.ts` | 平台 import 清单 |
| `src/types/index.ts` | 类型定义 |
| `src/renderer/pages/AccountPanel.vue` | 账号授权面板 |
| `src/renderer/assets/bilibili.png` | B站平台图标 |
