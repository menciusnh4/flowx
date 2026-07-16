# 文章发布 Markdown 编辑器优化方案

> 状态：已完成 ✅
> 日期：2026-07-15

## 一、背景与目标

### 1.1 现状
目前文章发布的正文输入为纯文本 textarea，用户只能输入纯文本内容，格式单一，无法满足长文创作的排版需求。

### 1.2 目标
在文章发布模式下，新增「纯文本 / Markdown」切换选项：
- **纯文本模式**：保持现有逻辑不变
- **Markdown 模式**：使用轻量级自研 Markdown 编辑器，左右分栏（左侧编辑 / 右侧预览），发布时将 Markdown 内容生成 `.md` 文件上传到平台

### 1.3 支持平台
- 小红书文章发布
- 抖音文章发布

### 1.4 支持的 Markdown 语法

小红书和抖音平台仅支持以下 Markdown 语法，编辑器已做相应精简：

| 功能 | 语法 | 说明 |
|------|------|------|
| 标题 | `#` / `##` / `###` | 一级/二级/三级标题 |
| 加粗 | `**文本**` | 粗体强调 |
| 斜体 | `*文本*` | 斜体强调 |
| 高亮 | `==文本==` | 黄色背景高亮 |
| 引用 | `> ` | 引用块 |
| 无序列表 | `- ` | 项目符号列表 |
| 有序列表 | `1. ` | 数字编号列表 |
| 图片 | `![alt](url)` | 图片插入 |

> 不支持的语法（删除线、代码块、链接、分割线、任务列表等）在编辑器工具栏中已屏蔽，避免用户输入后平台无法渲染。

---

## 二、前端实现

### 2.1 模式切换
在「描述」表单项上方增加模式切换控件（Radio Group）：
```
正文模式：(●) 纯文本  ( ) Markdown
```
- 默认选中「纯文本」，保持现有交互
- 切换到「Markdown」时，正文输入区域替换为 Markdown 编辑器
- 切换时自动迁移内容：
  - 纯文本 → Markdown：直接将内容作为 Markdown 源码
  - Markdown → 纯文本：清洗 Markdown 标记后回填

### 2.2 Markdown 编辑器组件：MarkdownEditor.vue

**自研轻量编辑器**，未引入 Jodit 等重型编辑器，原因：
- 仅需基础 Markdown 编辑功能，无需富文本编辑
- 自研可精确控制功能范围，避免平台不支持的语法
- 包体积更小，启动更快

**编辑器特性：**
- 工具栏：H1/H2/H3、加粗、斜体、高亮、引用、无序/有序列表、图片
- 左右分栏布局：左侧编辑 / 右侧实时预览
- 可拖拽分隔条调整左右宽度比例
- 同步滚动（编辑区滚动 → 预览区同步）
- 字数统计：排除 Markdown 标记和换行符，与平台限制计算一致
- 快捷键：Ctrl+B（加粗）、Ctrl+I（斜体）、Ctrl+H（高亮）、Tab（缩进）

### 2.3 渲染方案
- 使用 `marked` 库进行 Markdown → HTML 渲染
- 高亮语法（`==文本==`）通过自定义正则替换实现（`==文本==` → `<mark>文本</mark>`）
- 预览样式：类 GitHub 风格的简化版 CSS

### 2.4 字数限制计算
Markdown 模式下的有效字数 = 去除 Markdown 标记后的字符数（不含换行符）：
- 去除标题标记 `#`
- 去除加粗/斜体标记 `**` / `*`
- 去除高亮标记 `==`
- 去除引用标记 `>`
- 去除列表标记 `-` / `1.`
- 去除图片语法 `![alt](url)`

与纯文本模式的限制一致：
- 抖音：8000 字
- 小红书：10000 字

---

## 三、发布流程

### 3.1 整体流程

```
用户输入（Markdown 模式）
    │
    ├─→ 前端：实时预览（marked 渲染）
    │
    └─→ 点击发布
          │
          ├─ 生成 .md 临时文件
          │
          ├─ 平台适配器 publishArticle()
          │     │
          │     ├─ 导航到文章发布页
          │     │
          │     ├─ 点击「文档导入」/「一键导入」
          │     │
          │     ├─ 点击上传区域 → 生成 file input
          │     │
          │     ├─ CDP setFileInputFiles 上传 .md 文件
          │     │
          │     ├─ 等待内容自动填充
          │     │
          │     └─ 后续流程与纯文本一致
          │
          └─ 清理临时文件 → 返回结果
```

### 3.2 小红书上传流程

**入口位置**：一键排版页面的工具栏 → 文档导入图标 → 弹窗内上传区域

**关键元素：**
```
工具栏图标： .menu-item[doc-icon]  （通过 SVG path 特征识别）
弹窗：      .import-from-file-modal
上传区域：  .upload-area
文件 input： input[type=file][accept*=".md"]  （点击上传区域后动态生成）
```

**操作步骤：**
1. 进入文章编辑页（第一步：一键排版页面）
2. 点击工具栏的「文档导入」图标按钮
3. 等待导入弹窗出现（`.import-from-file-modal`）
4. 点击弹窗内的上传区域（`.upload-area`），触发 file input 生成
5. 通过 CDP 找到动态生成的 `input[type=file]` 元素
6. 调用 `DOM.setFileInputFiles` 上传 `.md` 文件
7. 等待页面自动填充正文内容（~2.5 秒）
8. 关闭导入弹窗
9. 后续流程与纯文本一致：一键排版 → 下一步 → 发布

**失败回退**：任何步骤失败时，自动清洗 Markdown 标记为纯文本，通过常规方式填写正文。

### 3.3 抖音上传流程

**入口位置**：「我要发文」引导页 → 「一键导入」按钮

**关键元素：**
```
引导页按钮： span.semi-button-content  （文本为"一键导入"）
上传弹窗：   .dy-creator-content-modal-body-wrapper
文件 input： input[type=file][accept*=".md"]
```

**操作步骤：**
1. 导航到文章发布页，检测是否在引导页
2. Markdown 模式：点击「一键导入」按钮（不点击"我要发文"）
3. 等待上传弹窗出现
4. 通过 CDP 找到 `input[type=file]` 元素
5. 调用 `DOM.setFileInputFiles` 上传 `.md` 文件
6. 等待页面跳转并自动填充内容（导航到编辑器页面）
7. 后续流程与纯文本一致：填写标题 → 上传封面 → 发布

**引导页检测策略**：
- 检测脚本只检测不点击，避免自动跳转导致 Markdown 上传逻辑失效
- Markdown 模式优先走"一键导入"路径
- 纯文本模式走"我要发文"路径
- 上传失败时回退：关闭弹窗 → 点击"我要发文" → 纯文本填写

### 3.4 临时文件管理

- 发布前生成 `.md` 临时文件到系统临时目录（`os.tmpdir()`）
- 文件命名：`{prefix}-{timestamp}.md`（prefix 为平台标识，如 `xhs-article` / `douyin-article`）
- 使用 `fs.mkdtempSync` 创建独立临时目录，避免文件名冲突
- 发布完成（成功或失败）后通过 `cleanupMarkdownTempFile()` 自动清理
- 清理时同时删除临时文件和临时目录

---

## 四、技术实现细节

### 4.1 类型定义（PublishRequest）

```typescript
interface PublishRequest {
  // ... 现有字段
  /**
   * 正文输入模式
   * - 'text': 纯文本（默认）
   * - 'markdown': Markdown 模式，需生成 .md 文件上传
   */
  contentMode?: 'text' | 'markdown';

  /**
   * Markdown 源码（contentMode === 'markdown' 时使用）
   */
  markdownContent?: string;
}
```

### 4.2 文件上传工具：uploadFileToInput

位于 `src/main/services/platforms/shared.ts`，通用 CDP 文件上传函数：

```typescript
export async function uploadFileToInput(
  win: BrowserWindow,
  filePath: string,
  selector: string,        // CSS 选择器，多个用逗号分隔
  log: (...args: any[]) => void,
  timeout: number = 5000,
): Promise<boolean>
```

**特点：**
- 轮询查找元素（默认每 500ms 一次），支持动态生成的 file input
- 多个选择器用逗号分隔，按顺序匹配
- 通过 `DOM.setFileInputFiles` 设置文件
- 失败返回 `false`，不抛异常

### 4.3 Markdown 临时文件工具

位于 `src/main/services/platforms/shared.ts`：

```typescript
// 创建 Markdown 临时文件，返回文件绝对路径
export function createMarkdownTempFile(content: string, prefix?: string): string

// 清理 Markdown 临时文件及目录
export function cleanupMarkdownTempFile(filePath: string): void
```

### 4.4 Markdown → 纯文本清洗

各平台适配器回退时使用的清洗规则（保持一致）：

```typescript
function cleanMarkdownToPlain(mdText: string): string {
  return mdText
    .replace(/!\[.*?\]\(.*?\)/g, '')       // 去除图片
    .replace(/^#{1,6}\s+/gm, '')            // 去除标题标记
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // 去除粗体
    .replace(/\*([^*]+)\*/g, '$1')          // 去除斜体
    .replace(/==([^=]+)==/g, '$1')          // 去除高亮
    .replace(/^>\s?/gm, '')                 // 去除引用
    .replace(/^[-*+]\s+/gm, '')             // 去除无序列表
    .replace(/^\d+\.\s+/gm, '');            // 去除有序列表
}
```

---

## 五、涉及文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/renderer/components/MarkdownEditor.vue` | 新增 | Markdown 编辑器组件（工具栏/分栏/预览/字数统计） |
| `src/renderer/components/PublishForm.vue` | 修改 | 模式切换 + 编辑器集成 + 验证规则 + 草稿支持 |
| `src/types/index.ts` | 修改 | PublishRequest 新增 contentMode / markdownContent |
| `src/main/services/platforms/shared.ts` | 修改 | 新增 uploadFileToInput + Markdown 临时文件工具 |
| `src/main/services/platforms/xiaohongshu.ts` | 修改 | 文章发布 Markdown 上传流程 + 回退逻辑 |
| `src/main/services/platforms/douyin.ts` | 修改 | 引导页检测重构 + Markdown 一键导入 + 回退逻辑 |
| `src/main/api/ApiServer.ts` | 修改 | API 发布支持 Markdown 字段 |

---

## 六、测试验证

### 测试结果（2026-07-15）

| 平台 | 场景 | 结果 |
|------|------|------|
| 小红书 | 文章发布 Markdown 上传 | ✅ 通过 |
| 抖音 | 文章发布 Markdown 上传 | ✅ 通过 |
| 小红书 | Markdown 上传失败回退纯文本 | ✅ 通过 |
| 抖音 | Markdown 上传失败回退纯文本 | ✅ 通过 |
| 前端 | 纯文本 / Markdown 模式切换 | ✅ 通过 |
| 前端 | 字数统计准确性 | ✅ 通过 |
| 前端 | 草稿保存与加载（Markdown 模式） | ✅ 通过 |

### 已知问题与注意事项

1. **平台 DOM 变更风险**：小红书和抖音的上传按钮/弹窗类名可能随版本变化，需持续维护选择器
2. **导入效果差异**：不同平台对 Markdown 的解析渲染效果可能略有差异（如高亮颜色、引用样式）
3. **图片上传限制**：Markdown 中的图片语法 `![alt](url)` 需要 URL 图片，本地图片需先上传图床

---

## 七、后续优化方向

- [ ] 图片上传：支持本地图片自动转 URL（对接图床服务）
- [ ] 模板功能：预设文章模板，一键填充
- [ ] 导入功能：支持从 URL / 剪贴板导入 Markdown 内容
- [ ] 深色模式：编辑器预览区深色主题适配
