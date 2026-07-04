/**
 * 平台注册表入口
 *
 * 设计说明（避免循环依赖）：
 *   1. registry.ts  ← 纯注册表：只有 Map + registerPlatform/getPlatform，不 import 任何平台
 *   2. xiaohongshu.ts / douyin.ts / kuaishou.ts  ← 从 './registry' 导入 registerPlatform
 *   3. 本文件（index.ts）从 './registry' 导出公开 API，然后 side-effect import 各平台
 *
 * 这样就不会出现 "index.ts 加载 xiaohongshu.ts → xiaohongshu.ts 回 index.ts 拿 registerPlatform
 * → 但 const registry 还没初始化" 的 TDZ 错误。
 *
 * ⚠️ 新增平台：只需在下方 import 列表加一行即可
 */
export {
  registerPlatform,
  getPlatform,
  getAllPlatforms,
  getAllPlatformMetas,
  isPlatformSupported,
  getPlatformCapabilities,
  __internalRegistry,
} from './registry';

// 共享工具函数（polyfill 注入 / 窗口创建 / 上传 等）
export {
  applyDouyinAntiCrash,
  makePublishWindow,
  makeFailedResult,
  uploadViaCDP,
  sleep,
  makePublishLogger,
} from './shared';

// Side effect imports —— 触发各平台的 registerPlatform() 调用
import './xiaohongshu';
import './douyin';
import './kuaishou';
import './wechat_channels';
import './zhihu';
import './toutiao';
// 👇 新增平台：在这里加一行 import './<platformKey>';
