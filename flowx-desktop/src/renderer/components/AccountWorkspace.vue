<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { electronApi } from '../utils/electron';
import { useWorkspaceStore } from '../stores/workspace';
import type { WorkspaceTab } from '../stores/workspace';

const props = defineProps<{ tab: WorkspaceTab }>();
const store = useWorkspaceStore();
const accountId = props.tab.accountId || '';
// partition 在组件实例生命周期内稳定（按账号固定），作为静态属性绑定，避免响应式重设触发 guest 重建
const partitionName = `persist:account_${accountId}`;

const avatar = ref<string>('');
const nickname = ref<string>(props.tab.title);
const envLabel = ref<string>('未配置隔离');
const envWarning = ref<boolean>(false);
const envFailed = ref<boolean>(false);
const envFailedReason = ref<string>('');

// 创作中心 <webview> 标签属性（按核心技术方案注入）
const guestPreloadPath = ref<string>(''); // 沙箱兼容访客预加载脚本的绝对路径（登录监控/统计/体检）
const resolvedUserAgent = ref<string>(''); // 该账号隔离分区实际生效的 UA（与 session 一致）
const loginState = ref<boolean | null>(null); // 登录态监控：null=检测中, true=已登录, false=未登录

// 自动化体检面板状态
const healthOpen = ref<boolean>(false);
const healthLoading = ref<boolean>(false);
const healthReport = ref<{
  ok: boolean;
  missing: string[];
  nodeCount: number;
  followers?: string;
  likes?: string;
} | null>(null);

interface InnerTab {
  id: string;
  url: string;
  /** 初始加载 URL（绑到 :src，不随导航更新，避免响应式重导航） */
  src: string;
  /** HTTP Referer（竞品方案：来自主进程拦截时回传，用于反爬防盗链） */
  referrer?: string;
  title: string;
  isLoading: boolean;
  /** 是否已触发过 loadURL；保证每个 webview 只加载一次，避免重复导航/竞态 */
  loaded: boolean;
}
const tabs = ref<InnerTab[]>([]);
const activeInnerId = ref<string>('');
const activeUrl = ref<string>('');
const homeUrl = ref<string>('');
const loadError = ref<boolean>(false);
const loadErrorMsg = ref<string>('');

// 当前激活子页签是否仍在加载（用于轻量加载遮罩）
const activeLoading = computed(() => !!tabs.value.find((t) => t.id === activeInnerId.value)?.isLoading);

// 每个 <webview> 实例的引用（按 tab id）。webview 是 Electron 自定义元素，类型用 any 规避。
const webviewRefs = new Map<string, any>();
const crashCounts = new Map<string, number>();
// 弹窗去重：仅防止「主进程 IPC」与「webview new-window 兜底」对同一 popup 双触发，
// 不影响用户主动新建/导航（与旧版会误删合法同 URL 页签的 600ms 去重不同）。
const recentPopup = new Map<string, number>();
function isDuplicatePopup(url: string): boolean {
  const now = Date.now();
  const last = recentPopup.get(url);
  if (last && now - last < 1000) return true;
  recentPopup.set(url, now);
  return false;
}
function setWebviewRef(id: string, el: any) {
  if (el && el.tagName === 'WEBVIEW') {
    webviewRefs.set(id, el);
    // 注意：新 tab 的 :src 始终为非空 url（见 addTab），否则 Electron 不会为 webview 创建 guest 进程，页面永久空白。
    // 弹窗拦截由「主进程 setWindowOpenHandler（在 guest 创建时经 web-contents-created 同步挂载）」为第一优先级，
    // 模板 @new-window 作为渲染层兜底（setWindowOpenHandler 返回 deny 后不会触发该事件）。
  } else {
    webviewRefs.delete(id);
  }
}
// 模板函数 ref 无法内联标注类型，用此包装返回带类型的回调，避免隐式 any
function refWebview(id: string) {
  return (el: any) => setWebviewRef(id, el);
}
function activeWebview(): any | undefined {
  return webviewRefs.get(activeInnerId.value);
}

// ---------- 账号信息 ----------
async function loadAccountInfo() {
  try {
    const acc = await electronApi.getAccount(accountId);
    if (acc) {
      avatar.value = acc.avatar || '';
      nickname.value = acc.nickname || props.tab.title;
      if (acc.envId) {
        const envs = await electronApi.listEnvironments();
        const env = envs.find((e) => e.id === acc.envId);
        envLabel.value = env?.name || '已隔离环境';
        envWarning.value = false;
      } else {
        envLabel.value = '未配置隔离';
        envWarning.value = true;
      }
    }
  } catch {
    /* ignore */
  }
}

// 加载超时兜底：15s 仍在 loading 则提示，不永远转圈
let loadTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
function startLoadTimeout(id: string) {
  if (loadTimeoutTimer) clearTimeout(loadTimeoutTimer);
  loadTimeoutTimer = setTimeout(() => {
    const t = tabs.value.find((x) => x.id === id);
    if (t && t.isLoading && id === activeInnerId.value) {
      loadError.value = true;
      loadErrorMsg.value = '创作中心加载超时（15s）。可能原因：网络不通、代理不可用、或 webview guest 未启动。点 ⟳ 重试。';
    }
  }, 15000);
}

// ---------- 预建隔离分区会话（主进程） ----------
async function ensureSession() {
  try {
    const res = await electronApi.workspaceWebview.ensure(accountId, props.tab.title);
    if (res.ok && res.url) {
      homeUrl.value = res.url;
      // 绑定该账号隔离分区实际生效的 User-Agent（与 session.fromPartition 设置的一致），
      // 通过 <webview :useragent> 注入，做到「每账号独立设备指纹」。
      resolvedUserAgent.value = res.userAgent || '';
      const id = `tab_${Date.now()}`;
      tabs.value = [{ id, url: res.url, src: res.url, title: '首页', isLoading: true, loaded: false }];
      activeInnerId.value = id;
      activeUrl.value = res.url;
      startLoadTimeout(id);
      if (res.env && !res.env.ok) {
        envFailed.value = true;
        envFailedReason.value = res.env.reason || '隔离环境失效，已回退本机直连';
      }
    } else {
      loadError.value = true;
      loadErrorMsg.value = res.error || '无法加载该账号的创作中心（账号不存在或隔离环境失效）';
    }
  } catch (e) {
    loadError.value = true;
    loadErrorMsg.value = '加载创作中心失败：' + (e instanceof Error ? e.message : String(e));
  }
}

// ---------- 访客预加载脚本路径（沙箱兼容） ----------
// 必须在创建 <webview> 之前拿到绝对路径并绑定到 :preload，否则 webview 创建后无法再应用 preload。
async function loadGuestPreloadPath() {
  try {
    const p = await electronApi.workspaceWebview.getGuestPreloadPath();
    // 关键保底：只接受 file:// 协议路径。若主进程未重启仍返回原生路径（D:\...），
    // webview 的 :preload 会解析失败 → guest 进程无法初始化 → 一直 loading。
    // 降级为空后 webview 不挂 preload，照常加载主页面（仅监控/体检不可用）。
    guestPreloadPath.value = p && p.startsWith('file://') ? p : '';
    console.log('[acw] guestPreloadPath =', guestPreloadPath.value || '(空，已降级)');
  } catch {
    guestPreloadPath.value = '';
  }
}

// ---------- webview 加载（幂等） ----------
// 关键修复点：不绑定 :src，改为 guest 挂上 embedder 后（@did-attach，此时 partition 已就绪）
// 显式 loadURL 一次。配合 partition 静态绑定，彻底消除「:src + :partition 竞态 → 首次导航被 abort（-3）」。
// loaded 标记保证只加载一次，切换/重试不会重复触发导航。
function ensureLoaded(id: string) {
  const wv = webviewRefs.get(id);
  const t = tabs.value.find((x) => x.id === id);
  if (!wv || !t || !t.url || t.loaded) return;
  t.loaded = true;
  // :src 已在 webview 创建时触发导航，此处不再 loadURL（避免重复导航竞态）
  console.log('[acw] ensureLoaded (src 已导航)', id, t.url);
}

// ---------- webview 事件 ----------
function onNav(id: string, e: any) {
  const url: string | undefined = e?.url;
  if (!url) return;
  const t = tabs.value.find((x) => x.id === id);
  if (t) {
    t.url = url;
    t.isLoading = false;
  }
  if (id === activeInnerId.value) {
    activeUrl.value = url;
    loadError.value = false; // 导航成功即清掉失败兜底
  }
}
function onTitle(id: string, e: any) {
  const title: string | undefined = e?.title;
  if (!title) return;
  // 过滤中转页/错误页的无意义标题（页面加载时短暂出现，非用户想看到的真实标题）
  const noiseTitles = ['about:blank', '你访问的页面不见了'];
  if (noiseTitles.includes(title)) return;
  const t = tabs.value.find((x) => x.id === id);
  if (t) t.title = title;
}
// 新窗口请求（target=_blank / window.open）统一重定向为「旁边加一个 inner 标签页」。
// 竞品方案：去除前端时间戳去重，完全信任主进程 setWindowOpenHandler 返回 { action: 'deny' } 的单点拦截
// （deny 会抑制渲染层 new-window 事件，不会双触发）。此处仅做渲染层兜底入口。
function openInNewInnerTab(url: string | undefined, referrer?: string) {
  console.log('[acw] openInNewInnerTab called, url =', url, '| referrer =', referrer);
  if (!url) { console.warn('[acw] openInNewInnerTab 跳过：url 为空'); return; }
  addTab(url, '新标签页', referrer);
  console.log('[acw] openInNewInnerTab → addTab', url);
}
// <webview> 的 new-window 事件：url 可能挂在 e.url，也可能挂在 e.detail.url（不同 Electron 版本行为不一）
function onNewWindow(e: any) {
  const url: string | undefined = e?.url || (e?.detail && e?.detail.url) || undefined;
  console.log('[acw] new-window 事件触发, url =', url, '| e.url =', e?.url, '| e.detail.url =', e?.detail?.url);
  e?.preventDefault?.();
  if (!url) { console.warn('[acw] new-window 跳过：url 为空'); return; }
  if (isDuplicatePopup(url)) { console.log('[acw] new-window 跳过：1s 内已处理相同 url（防双触发）'); return; }
  openInNewInnerTab(url);
}
// <webview> 挂上 embedder 后：加载一次 + 挂 setWindowOpenHandler
function onAttach(id: string) {
  console.log('[acw] did-attach', id, '| preload =', guestPreloadPath.value || '(空)');
  ensureLoaded(id);
  // 有 referrer 的新 tab：guest 已就绪，用 loadURL({ httpReferrer }) 还原防盗链来源头
  // （竞品方案：el.loadURL(url, { httpReferrer })；:src 已触发 guest 创建，此处二次导航携带 referrer）。
  const t = tabs.value.find((x) => x.id === id);
  const wv = webviewRefs.get(id);
  if (t?.referrer && wv) {
    try { wv.loadURL(t.url, { httpReferrer: t.referrer }); } catch { /* guest 未就绪，onDomReady 兜底 */ }
  }
}
// dom-ready 兜底：webContents 可能晚于 attach 就绪，故在此重试 ensureLoaded（万一 attach 时 loadURL 抛错）
function onDomReady(id: string) {
  const wv = webviewRefs.get(id);
  if (!wv) return;

  ensureLoaded(id);

  // 延迟 100ms 注册，确保主进程能成功找到 WebContents 实例，并传回当前组件的 accountId
  setTimeout(() => {
    try {
      const wcId = wv.getWebContentsId?.();
      if (wcId) {
        electronApi.workspaceWebview.registerPopups(wcId, accountId).then((res: any) => {
          if (res && res.ok === false) {
            console.warn('[acw] 主进程挂载拦截失败:', res.error);
          } else {
            console.log('[acw] registerPopups 挂载成功, wcId =', wcId);
          }
        }).catch((e: any) => {
          console.warn('[acw] registerPopups 接口调用失败:', e);
        });
      }
    } catch (e) {
      console.warn('[acw] getWebContentsId 获取失败:', e);
    }
  }, 100);

  // 兜底：guest 已就绪但仍未真正导航（src 异常 / loadURL 抛错），强制加载一次
  try {
    const cur = wv.getURL && wv.getURL();
    if (!cur) {
      const t = tabs.value.find((x) => x.id === id);
      if (t && t.url) {
        if (t.referrer) wv.loadURL(t.url, { httpReferrer: t.referrer });
        else wv.loadURL(t.url);
      }
    }
  } catch {
    /* noop */
  }
}
// 访客预加载脚本（沙箱内）通过 ipcRenderer.sendToHost 推送的消息（登录态监控等）
function onGuestMessage(id: string, e: any) {
  if (e?.channel && e.channel !== 'flowx-guest') return;
  const msg = e?.args && e.args[0];
  if (!msg || typeof msg !== 'object') return;
  if (id !== activeInnerId.value) return; // 仅处理当前激活子页签
  if (msg.type === 'login') {
    loginState.value = !!(msg.payload && msg.payload.loggedIn);
  }
  // stats/diagnosis/ready 等由「体检」按钮主动拉取，不常驻刷新
}
// 主帧加载失败：显示真实错误（含错误码），避免静默白屏。
// 过滤良性 abort（ERR_ABORTED=-3 等常见由导航替换引发的非致命码），避免误报白屏。
function onFailLoad(id: string, e: any) {
  if (!e?.isMainFrame) return;
  const code: number = e?.errorCode ?? 0;
  console.log('[acw] did-fail-load', id, 'code =', code, '| desc =', e?.errorDescription);
  if (code === -3 || code === -2) return; // ERR_ABORTED / ERR_FAILED：导航被替换，非真实失败
  if (id === activeInnerId.value) {
    loadError.value = true;
    loadErrorMsg.value = `页面加载失败（错误码 ${code}）：${e?.errorDescription || '未知错误'}`;
  }
}
function onCrashed(id: string) {
  const c = (crashCounts.get(id) || 0) + 1;
  crashCounts.set(id, c);
  // 崩溃兜底：最多 reload 1 次（与抖音防崩策略一致）
  if (c <= 1) webviewRefs.get(id)?.reload();
}
// 加载开始：仅首次加载显示全屏遮罩；页面已加载过内容后（getURL 有值），后续导航不遮罩，
// 避免内容已展示后被 SPA 内部跳转/自动刷新触发的全屏 spinner 盖住。
function onStartLoading(id: string, e?: any) {
  if (e && !e.isMainFrame) return;
  const wv = webviewRefs.get(id);
  if (wv) {
    try {
      if (wv.getURL && wv.getURL()) return;
    } catch { /* */ }
  }
  const t = tabs.value.find((x) => x.id === id);
  if (t) t.isLoading = true;
}
// 加载完成（权威信号）：无论 did-navigate 是否带 url，都清除遮罩。忽略子帧。
function onFinishLoad(id: string, e?: any) {
  if (e && !e.isMainFrame) return;
  const t = tabs.value.find((x) => x.id === id);
  if (t) t.isLoading = false;
  if (id === activeInnerId.value) loadError.value = false;
  if (loadTimeoutTimer) { clearTimeout(loadTimeoutTimer); loadTimeoutTimer = null; }
  console.log('[acw] did-finish-load', id);
}

// ---------- 自动化体检（DOM 诊断 + 数据抓取） ----------
// 由宿主通过 executeJavaScript 主动拉取访客 preload 暴露的 window.flowxGuest API（沙箱下同样可用）。
async function runHealthCheck() {
  const w = activeWebview();
  if (!w) return;
  healthOpen.value = true;
  healthLoading.value = true;
  try {
    const diag = await w.executeJavaScript('window.flowxGuest && window.flowxGuest.runDiagnosis()');
    const stats = await w.executeJavaScript('window.flowxGuest && window.flowxGuest.getCreatorStats()');
    healthReport.value = {
      ok: !!(diag && diag.ok),
      missing: (diag && diag.missing) || [],
      nodeCount: (diag && diag.nodeCount) || 0,
      followers: stats && stats.followers,
      likes: stats && stats.likes,
    };
  } catch {
    healthReport.value = { ok: false, missing: ['<无法读取>'], nodeCount: 0 };
  } finally {
    healthLoading.value = false;
  }
}

// ---------- 导航 ----------
function activateInner(id: string) {
  activeInnerId.value = id;
  const t = tabs.value.find((x) => x.id === id);
  if (t) {
    activeUrl.value = t.url;
    ensureLoaded(id); // 切到尚未加载的子页签时补加载
  }
  loadError.value = false; // 切 tab 时重置失败兜底，错误以激活项自身导航结果为准
}
function closeInner(id: string) {
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  webviewRefs.delete(id);
  crashCounts.delete(id);
  if (activeInnerId.value === id) {
    const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
    if (next) activateInner(next.id);
    else {
      activeInnerId.value = '';
      activeUrl.value = '';
    }
  }
}
function addTab(url: string, title: string, referrer?: string) {
  const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  // 关键修复：src 必须非空，否则 Electron 不为 webview 创建 guest 进程 → 新 tab 永远空白（「无法打开新跳转链接」根因）。
  // referrer 不靠 :src 注入，而是在 @did-attach 后用 loadURL({ httpReferrer }) 还原防盗链来源头（见 onAttach）。
  tabs.value.push({ id, url, src: url, referrer, title, isLoading: true, loaded: false });
  activeInnerId.value = id;
  activeUrl.value = url;
  loadError.value = false;
}
function back() {
  activeWebview()?.goBack();
}
function forward() {
  activeWebview()?.goForward();
}
function reload() {
  try { activeWebview()?.reload(); } catch { /* guest 未就绪 */ }
}
function home() {
  const w = activeWebview();
  if (w && homeUrl.value) w.loadURL(homeUrl.value);
}
function newInner() {
  addTab(homeUrl.value || 'about:blank', '新标签页');
}
function openInBrowser() {
  if (activeUrl.value) electronApi.openExternal(activeUrl.value).catch(() => {});
}
function toggleDevTools() {
  const w = activeWebview();
  if (!w) return;
  try {
    let opened = false;
    try {
      opened = !!w.getWebContents?.()?.isDevToolsOpened?.();
    } catch {
      opened = false;
    }
    if (opened) w.closeDevTools();
    else w.openDevTools();
  } catch {
    /* guest 未就绪，忽略 */
  }
}

// ---------- 生命周期 ----------
let unsubNewInnerTab: (() => void) | null = null;

onMounted(async () => {
  // 顺序关键：先取访客 preload 路径 + 账号信息，再 ensureSession 创建 webview，
  // 保证 :preload / :useragent 在 webview 首次创建前已就绪。
  await loadGuestPreloadPath();
  await loadAccountInfo();

  // 监听主进程回传的新 inner tab 请求（竞品方案：主进程 setWindowOpenHandler 拦截 → IPC 回传，accountId 过滤多账号实例）
  unsubNewInnerTab = electronApi.workspaceWebview.onNewInnerTab(({ url, referrer, accountId: msgAccountId }) => {
    console.log('[acw] 主进程回传 new-inner-tab, url =', url, '| msgAccountId =', msgAccountId, '| myAccountId =', accountId);
    if (msgAccountId !== accountId) { console.log('[acw] accountId 不匹配，忽略'); return; }
    if (isDuplicatePopup(url)) { console.log('[acw] new-inner-tab 跳过：1s 内已处理相同 url（防双触发）'); return; }
    addTab(url, '新标签页', referrer || undefined);
  });

  await ensureSession();
});

onBeforeUnmount(() => {
  if (unsubNewInnerTab) { unsubNewInnerTab(); unsubNewInnerTab = null; }
  webviewRefs.clear();
  crashCounts.clear();
  electronApi.workspaceWebview.close(accountId).catch(() => {});
});
</script>

<template>
  <div class="acw">
    <!-- 账号信息条（40px，与侧栏/任务条同一视觉语言） -->
    <div class="acw-info">
      <img v-if="avatar" class="acw-avatar" :src="avatar" alt="" />
      <span v-else class="acw-avatar acw-avatar--ph">{{ nickname.slice(0, 1) }}</span>
      <span class="acw-nick">{{ nickname }}</span>
      <span v-if="envFailed" class="acw-env warn" :title="envFailedReason || '隔离环境应用失败'">
        ⚠️ {{ envFailedReason || '隔离环境失效，已回退本机直连' }}
      </span>
      <span v-else class="acw-env" :class="{ warn: envWarning }" :title="envWarning ? '未绑定隔离环境：Cookie/代理/UA 与默认浏览器一致' : '已启用隔离环境（Cookie/代理/UA）'">
        🔒 {{ envLabel }}
      </span>
      <!-- 登录态监控（访客 preload 推送） -->
      <span
        class="acw-login"
        :class="loginState === null ? 'unknown' : (loginState ? 'on' : 'off')"
        :title="loginState === null ? '登录态检测中…' : (loginState ? '已登录' : '未登录')"
      >{{ loginState === null ? '● 检测中' : (loginState ? '✓ 已登录' : '○ 未登录') }}</span>
      <span class="acw-spacer"></span>
      <button class="acw-ibtn" title="自动化体检（DOM 诊断 / 数据抓取）" @click="runHealthCheck">🩺</button>
      <button class="acw-ibtn" title="刷新" @click="reload">⟳</button>
      <button class="acw-ibtn" title="开发者工具 (F12)" @click="toggleDevTools">🐞</button>
      <button class="acw-ibtn" title="在浏览器打开" @click="openInBrowser">↗</button>
    </div>

    <!-- inner 子页签条（36px） -->
    <div class="acw-inner">
      <div class="acw-inner-tabs">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="acw-itab"
          :class="{ active: t.id === activeInnerId }"
          @click="activateInner(t.id)"
        >
          <span class="acw-itab-title">{{ t.title || '新标签页' }}</span>
          <span class="acw-itab-close" @click.stop="closeInner(t.id)">×</span>
        </div>
        <button class="acw-itab-new" title="新子页签" @click="newInner">+</button>
      </div>
      <div class="acw-inner-nav">
        <button class="acw-navbtn" title="后退" @click="back">◀</button>
        <button class="acw-navbtn" title="前进" @click="forward">▶</button>
        <button class="acw-navbtn" title="首页" @click="home">⌂</button>
      </div>
    </div>

    <!-- DOM 内嵌：每个 inner 子页签一个 <webview>
         按核心技术方案挂载：
           :partition         → 每账号独立持久化沙盒分区（Cookie/缓存/凭证隔离）
           :useragent         → 每账号独立设备指纹（与 session.fromPartition 设置的 UA 一致）
           :preload           → 沙箱兼容访客预加载脚本（登录监控/统计抓取/DOM 体检）
           allowpopups        → 允许新窗口请求，由 setWindowOpenHandler 拦截并转为「旁边 inner 标签页」
           webpreferences     → contextIsolation=true 安全边界（恶意脚本无法穿透主进程）
         其余为稳定性修复：无 :src（did-attach 后 loadURL 一次）、-3/-2 良性 abort 过滤、加载遮罩。 -->
    <div class="acw-webviews">
      <div v-if="loadError" class="acw-error">
        <div class="acw-error-icon">⚠️</div>
        <div class="acw-error-msg">{{ loadErrorMsg }}</div>
      </div>
      <div v-else-if="activeLoading" class="acw-loading">
        <div class="acw-spinner"></div>
        <div class="acw-loading-text">正在加载创作中心…</div>
      </div>
      <webview
        v-for="t in tabs"
        :key="t.id"
        :ref="refWebview(t.id)"
        class="acw-webview"
        :class="{ 'is-active': t.id === activeInnerId }"
        :partition="partitionName"
        :useragent="resolvedUserAgent || null"
        :src="t.src"
        allowpopups
        webpreferences="contextIsolation=true"
        :style="{ display: t.id === activeInnerId ? 'flex' : 'none' }"
        @did-navigate="(e) => onNav(t.id, e)"
        @did-navigate-in-page="(e) => onNav(t.id, e)"
        @page-title-updated="(e) => onTitle(t.id, e)"
        @new-window="onNewWindow"
        @did-attach="onAttach(t.id)"
        @dom-ready="onDomReady(t.id)"
        @did-fail-load="(e) => onFailLoad(t.id, e)"
        @did-start-loading="(e) => onStartLoading(t.id)"
        @did-finish-load="(e) => onFinishLoad(t.id, e)"
        @crashed="onCrashed(t.id)"
        @ipc-message="(e) => onGuestMessage(t.id, e)"
      ></webview>

      <!-- 自动化体检面板 -->
      <div v-if="healthOpen" class="acw-health">
        <div class="acw-health-head">
          <span>🩺 自动化体检</span>
          <button class="acw-health-close" @click="healthOpen = false">×</button>
        </div>
        <div v-if="healthLoading" class="acw-health-loading">诊断中…</div>
        <div v-else-if="healthReport" class="acw-health-body">
          <div class="acw-health-row">
            <span>DOM 结构</span>
            <b :class="healthReport.ok ? 'ok' : 'bad'">{{ healthReport.ok ? '完整' : '缺失：' + healthReport.missing.join(', ') }}</b>
          </div>
          <div class="acw-health-row"><span>节点总数</span><b>{{ healthReport.nodeCount }}</b></div>
          <div v-if="healthReport.followers" class="acw-health-row"><span>粉丝</span><b>{{ healthReport.followers }}</b></div>
          <div v-if="healthReport.likes" class="acw-health-row"><span>点赞</span><b>{{ healthReport.likes }}</b></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.acw {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* 信息条 */
.acw-info {
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.acw-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--brand-grad-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--brand-indigo);
}
.acw-nick {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--ink);
}
.acw-env {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--brand-indigo);
  background: var(--brand-grad-soft);
  padding: 2px 9px;
  border-radius: var(--r-pill);
  cursor: default;
}
.acw-env.warn {
  color: #b45309;
  background: #fef3c7;
}
/* 登录态指示 */
.acw-login {
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--r-pill);
  cursor: default;
  white-space: nowrap;
}
.acw-login.on {
  color: #047857;
  background: #d1fae5;
}
.acw-login.off {
  color: #b45309;
  background: #fef3c7;
}
.acw-login.unknown {
  color: var(--muted);
  background: var(--brand-grad-soft);
}
.acw-spacer {
  flex: 1;
}
.acw-ibtn {
  width: 30px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 15px;
  cursor: pointer;
  /* 字形强制居中：避免文本符号(⟳)与 emoji(🩺🐞)因字体度量差异在按钮内错位 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.acw-ibtn:hover {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}

/* inner 子页签条 */
.acw-inner {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.acw-inner-tabs {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 0 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.acw-inner-tabs::-webkit-scrollbar {
  display: none;
}
.acw-itab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  height: 28px;
  padding: 0 8px;
  margin-bottom: 4px;
  background: var(--bg);
  border: 1px solid transparent;
  border-radius: 7px 7px 0 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  transition: background 0.15s, color 0.15s;
}
.acw-itab:hover {
  background: var(--brand-grad-soft);
}
.acw-itab.active {
  background: #fff;
  border-color: var(--line);
  color: var(--ink);
  font-weight: 600;
}
.acw-itab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acw-itab-close {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 13px;
  color: var(--muted);
}
.acw-itab-close:hover {
  background: var(--line);
  color: var(--ink);
}
.acw-itab-new {
  width: 26px;
  height: 26px;
  margin: 0 0 5px 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
}
.acw-itab-new:hover {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}
.acw-inner-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  border-left: 1px solid var(--line);
}
.acw-navbtn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
}
.acw-navbtn:hover {
  background: var(--brand-grad-soft);
  color: var(--brand-indigo);
}

/* webview 容器：flex 自适应铺满右侧 */
.acw-webviews {
  flex: 1;
  min-height: 0;
  position: relative;
  background: #fff;
}
.acw-webview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

/* 加载中遮罩（轻量，避免首屏空白无反馈） */
.acw-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--bg);
  color: var(--muted);
  z-index: 2;
}
.acw-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid var(--line);
  border-top-color: var(--brand-indigo);
  border-radius: 50%;
  animation: acw-spin 0.8s linear infinite;
}
@keyframes acw-spin {
  to {
    transform: rotate(360deg);
  }
}
.acw-loading-text {
  font-size: 13px;
}

/* 加载失败兜底（避免 ensure 失败时右侧纯空白、无任何提示） */
.acw-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: var(--bg);
  color: var(--muted);
}
.acw-error-icon {
  font-size: 40px;
}
.acw-error-msg {
  max-width: 420px;
  font-size: 13.5px;
  line-height: 1.6;
}

/* 自动化体检面板 */
.acw-health {
  position: absolute;
  top: 46px;
  right: 12px;
  width: 240px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
  z-index: 5;
  overflow: hidden;
}
.acw-health-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.acw-health-close {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
}
.acw-health-close:hover {
  background: var(--line);
}
.acw-health-loading {
  padding: 16px 12px;
  font-size: 12.5px;
  color: var(--muted);
}
.acw-health-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.acw-health-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.acw-health-row b {
  color: var(--ink);
  font-weight: 600;
}
.acw-health-row b.ok {
  color: #047857;
}
.acw-health-row b.bad {
  color: #dc2626;
}
</style>
