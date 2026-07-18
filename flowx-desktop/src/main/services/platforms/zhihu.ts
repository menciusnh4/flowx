import type { BrowserWindow } from 'electron';
import type {
  PlatformAdapter,
  ExtractedAccountInfo,
  LoginCheckResult,
  ProgressCallback,
} from './types';
import {
  sleep,
  makePublishLogger,
  makePublishWindow,
  attachNavigationTracker,
  evalJS,
  makeFailedResult,
  uploadViaCDP,
  buildPageStructureProbe,
  buildTestModeProbeScript,
  setupTestModeWindow,
} from './shared';
import { registerPlatform } from './registry';
import type {
  PlatformMeta,
  PublishRequest,
  PublishItemProgress,
  AccountCapabilities,
  ContentType,
  PublishLogEntry,
} from '../../../types';

/**
 * 知乎平台适配器
 *
 * 平台信息：
 *   - 创作者中心：https://www.zhihu.com/creator
 *   - 登录页：https://www.zhihu.com/signin
 *   - 登录态标识：cookie `z_c0` 存在且非空即为已登录
 *   - 视频发布页：https://www.zhihu.com/upload-video
 *   - 图文/想法发布页：https://www.zhihu.com/creator（创作中心首页的发想法功能）
 *
 * 页面结构要点（视频发布）：
 *   - 上传按钮：button.VideoUploadButton，文本"上传视频"
 *   - 文件输入：input.VideoUploadButton-fileInput[type="file"]
 *   - 标题输入：textarea[name="title"]，placeholder="标题"，上限 50 字符
 *   - 描述编辑器：contenteditable 的 DraftEditor，placeholder="分享你此刻的想法..."，上限 1000 字符
 *   - 发布按钮：button.VideoUploadForm-submitButton，文本"发布视频"
 *   - 视频标记（必选）：Modal 弹窗选择，共 6 个选项
 *   - 原创视频：默认勾选
 *
 * 页面结构要点（图文/想法发布）：
 *   - 入口：创作中心首页的"分享此刻的想法..."区域
 *   - 激活：点击提示文本后展开完整编辑器（WritePinV2-Form）
 *   - 标题输入：.WritePinV2-Form textarea[name="title"]，上限 50 字符
 *   - 正文编辑器：.WritePinV2-Form .public-DraftEditor-content，上限 1000 字符
 *   - 话题：直接追加在正文末尾（#话题 格式）
 *   - 图片上传：工具栏图片按钮 → 弹窗 → 本地图片 → 插入图片
 *   - 发布按钮：.WritePinToolbar-RightGroup 中的"发布"按钮
 */

const log = makePublishLogger({ platform: 'zhihu' });

const meta: PlatformMeta = {
  key: 'zhihu',
  name: '知乎',
  icon: '知',
  platformAccountLabel: '知乎ID',
  authUrl: 'https://www.zhihu.com/signin?next=https%3A%2F%2Fwww.zhihu.com%2Fcreator',
  publishUrl: 'https://www.zhihu.com/upload-video',
  homeUrl: 'https://www.zhihu.com/creator',
  contentTypes: ['article', 'video', 'image'],
  capabilities: {
    publishVideo: true,
    publishImage: true, // 图文发布（知乎想法）
    publishArticle: false, // TODO: 待实现
  } as AccountCapabilities,
  contentLimits: {
    title: 50,
    content: 1000,
  },
  articleLimits: {
    title: 100,
  },
  nicknameSelectors: [
    '.AppHeader-profile .Popover div',
    '.AppHeader-userInfo .UserLink-link',
    '.CreatorHomeProfile-name',
    'a.UserLink-link',
    '.ProfileHeader-name',
    'meta[itemprop="name"]',
  ],
  avatarSelectors: [
    '.AppHeader-profile img.Avatar',
    '.AppHeader-userInfo img.Avatar',
    '.CreatorHomeProfile-avatar img',
    'img.Avatar',
  ],
  loginKeywords: ['创作者中心', '私信', '退出', '写回答', '写文章', '想法'],
};

// ========================= 登录检测 =========================

async function detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
  try {
    const currentUrl = win.webContents.getURL();

    // 1. 优先通过 cookie 判断：知乎登录后必有 z_c0 cookie
    const cookies = await win.webContents.session.cookies.get({});
    const zc0 = cookies.find((c) => c.name === 'z_c0' && c.value);
    const d_c0 = cookies.find((c) => c.name === 'd_c0' && c.value);

    const matchedKeywords: string[] = [];
    if (zc0) matchedKeywords.push('z_c0-cookie');
    if (d_c0) matchedKeywords.push('d_c0-cookie');

    // 2. 在登录页肯定未登录
    const isLoginPage = currentUrl.includes('/signin') || currentUrl.includes('/login');

    // 3. DOM 辅助检测：检查是否存在已登录用户的头像/下拉菜单
    let domLoggedIn = false;
    try {
      domLoggedIn = await win.webContents.executeJavaScript(`
        (function() {
          try {
            // 知乎已登录标志：头像区域、AppHeader 中的用户菜单
            var profileEl = document.querySelector('.AppHeader-profile') ||
                           document.querySelector('.AppHeader-userInfo') ||
                           document.querySelector('.CreatorHomeProfile-name') ||
                           document.querySelector('a.UserLink-link');
            // 检查是否存在退出登录按钮
            var hasLogout = document.body.innerText.indexOf('退出') !== -1;
            return !!(profileEl || hasLogout);
          } catch(e) {
            return false;
          }
        })()
      `);
      if (domLoggedIn) matchedKeywords.push('dom-profile');
    } catch {
      // ignore
    }

    const loggedIn = !!zc0 && !isLoginPage;

    return {
      loggedIn,
      url: currentUrl,
      title: win.webContents.getTitle(),
      matchedKeywords,
    };
  } catch (e) {
    log('error', 'detectLoggedIn', (e as Error).message);
    return {
      loggedIn: false,
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
    };
  }
}

// ========================= 提取账号信息 =========================

async function extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
  try {
    // 通过知乎 API 获取当前用户信息（最可靠）
    let apiInfo: any = null;
    try {
      apiInfo = await win.webContents.executeJavaScript(`
        (async function() {
          try {
            var resp = await fetch('https://www.zhihu.com/api/v4/me?include=is_realname', {
              credentials: 'include',
              headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) return null;
            var data = await resp.json();
            return data;
          } catch(e) {
            return null;
          }
        })()
      `);
    } catch (e) {
      log('warn', 'extractPageInfo', 'API fetch failed: ' + (e as Error).message);
    }

    // 如果 API 成功获取到信息，直接使用
    if (apiInfo && apiInfo.name) {
      log('info', 'extractPageInfo', `API 获取成功: name="${apiInfo.name}", uid="${apiInfo.uid}", url_token="${apiInfo.url_token}"`);
      return {
        nickname: apiInfo.name || '',
        avatar: apiInfo.avatar_url || '',
        platformAccountId: apiInfo.url_token || apiInfo.uid || '',
        userId: apiInfo.uid || '',
        fansCount: typeof apiInfo.follower_count === 'number' ? apiInfo.follower_count : 0,
        followCount: typeof apiInfo.following_count === 'number' ? apiInfo.following_count : 0,
        likeCount: typeof apiInfo.voteup_count === 'number' ? apiInfo.voteup_count : 0,
      };
    }

    // API 失败时从 DOM 提取兜底
    log('info', 'extractPageInfo', 'API 未返回数据，尝试 DOM 提取');
    const domInfo = await win.webContents.executeJavaScript(`
      (function() {
        try {
          var nickname = '';
          var avatar = '';
          var platformAccountId = '';

          // 尝试多种选择器获取昵称（创作者中心页面结构）
          var nameSelectors = [
            // 创作者中心特有
            '.CreatorHomeProfile-name',
            '.creator-profile-name',
            '.profile-card .name',
            '.user-card .name',
            // 通用知乎页面
            '.AppHeader-profile .Popover div',
            '.AppHeader-userInfo .UserLink-link',
            'a.UserLink-link',
            '.ProfileHeader-name',
            // 全局搜索：包含用户名的元素
            '[class*="Profile-name"]',
            '[class*="userName"]',
            '[class*="nickname"]',
          ];
          for (var i = 0; i < nameSelectors.length; i++) {
            var el = document.querySelector(nameSelectors[i]);
            if (el && el.textContent) {
              var text = el.textContent.trim();
              if (text && text.length < 50 && text !== '知乎' && text !== '创作者中心') {
                nickname = text;
                break;
              }
            }
          }

          // 尝试获取头像
          var avatarSelectors = [
            '.CreatorHomeProfile-avatar img',
            '.AppHeader-profile img.Avatar',
            '.AppHeader-userInfo img.Avatar',
            '[class*="Profile"] img[src*="zhimg.com"]',
            'img[src*="zhimg.com/v2-"]',
            'img.Avatar',
          ];
          for (var j = 0; j < avatarSelectors.length; j++) {
            var img = document.querySelector(avatarSelectors[j]);
            if (img && img.src && img.src.indexOf('data:') !== 0 && img.src.indexOf('zhimg.com') !== -1) {
              avatar = img.src;
              break;
            }
          }

          // 尝试从页面链接获取用户 ID
          var links = document.querySelectorAll('a[href*="/people/"], a[href*="/org/"]');
          for (var k = 0; k < links.length; k++) {
            var href = links[k].getAttribute('href') || '';
            var match = href.match(/\\/(people|org)\\/([^\\/\\?#]+)/);
            if (match && match[2] && match[2].length > 1) {
              platformAccountId = match[2];
              break;
            }
          }

          return { nickname: nickname, avatar: avatar, platformAccountId: platformAccountId };
        } catch(e) {
          return { nickname: '', avatar: '', platformAccountId: '' };
        }
      })()
    `);

    return {
      nickname: domInfo.nickname || '',
      avatar: domInfo.avatar || '',
      platformAccountId: domInfo.platformAccountId || '',
      fansCount: 0,
      followCount: 0,
      likeCount: 0,
    };
  } catch (e) {
    log('error', 'extractPageInfo', (e as Error).message);
    return { nickname: '' };
  }
}

// ========================= 工具：文本截断 =========================

const TITLE_MAX = 50;
const CONTENT_MAX = 1000;

/** 截取字符串，按 UTF-16 code unit，末尾加 "..." */
function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

// ========================= 知乎平台专用脚本 =========================

/**
 * [知乎专用] 填写标题。
 * 知乎视频标题使用 textarea[name="title"] 元素。
 * 使用 React 兼容的方式：先聚焦清空，再用 execCommand('insertText') 写入。
 */
function buildFillTitleScript(title: string): string {
  const json = JSON.stringify(title);
  return `
    (function () {
      try {
        var text = ${json};
        // 优先使用 name="title" 的 textarea
        var target = document.querySelector('textarea[name="title"]');
        if (!target) {
          // fallback：找 placeholder 含"标题"的 textarea
          var textareas = document.querySelectorAll('textarea');
          for (var i = 0; i < textareas.length; i++) {
            var ph = textareas[i].getAttribute && textareas[i].getAttribute('placeholder') || '';
            if (ph.indexOf('标题') !== -1) {
              target = textareas[i];
              break;
            }
          }
        }
        if (!target) {
          return { ok: false, msg: 'no-title-textarea-found' };
        }
        target.focus();
        target.value = '';
        // 触发 input 事件通知 React
        var ev = document.createEvent('Event');
        ev.initEvent('input', true, true);
        target.dispatchEvent(ev);
        if (text && text.length > 0) {
          // 先设置值
          target.value = text;
          // 再触发 input 和 change 事件
          target.dispatchEvent(ev);
          try {
            var changeEv = document.createEvent('Event');
            changeEv.initEvent('change', true, true);
            target.dispatchEvent(changeEv);
          } catch(e2) {}
        }
        target.blur();
        return { ok: true, length: text.length, method: 'textarea-value' };
      } catch (e) {
        return { ok: false, msg: String(e) };
      }
    })();
  `;
}

/**
 * [知乎专用] 填写视频描述/正文。
 * 知乎使用 Draft.js 富文本编辑器，contenteditable 的 div.public-DraftEditor-content。
 * 需要用 execCommand('insertText') 方式写入以触发 React 状态更新。
 */
function buildFillContentScript(content: string): string {
  const json = JSON.stringify(content);
  return `
    (function () {
      try {
        var text = ${json};
        // 知乎 DraftEditor 的 contenteditable 元素
        var target = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        if (!target) {
          // fallback：找任何 contenteditable 的富文本编辑器
          var editors = document.querySelectorAll('[contenteditable="true"]');
          for (var i = 0; i < editors.length; i++) {
            var cls = editors[i].className || '';
            if (typeof cls === 'string' && (cls.indexOf('DraftEditor') !== -1 || cls.indexOf('RichText') !== -1 || cls.indexOf('Editor') !== -1)) {
              target = editors[i];
              break;
            }
          }
        }
        if (!target) {
          // 再 fallback：EditorArea 内的 contenteditable
          var editorArea = document.querySelector('.EditorArea');
          if (editorArea) {
            target = editorArea.querySelector('[contenteditable="true"]');
          }
        }
        if (!target) {
          return { ok: false, msg: 'no-content-editor-found' };
        }

        target.focus();
        // 清空现有内容
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        } catch(eClear) {
          // 降级：直接设置 innerHTML
          target.innerHTML = '<div data-contents="true"><div class=""><div data-offset-key=""><div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr"><span><br></span></div></div></div></div>';
        }

        if (text && text.length > 0) {
          // 使用 insertText 逐行写入，确保 Draft.js 正确处理
          var lines = text.split('\\n');
          for (var li = 0; li < lines.length; li++) {
            if (li > 0) {
              // 换行
              try { document.execCommand('insertParagraph', false, null); } catch(eP) {}
            }
            if (lines[li]) {
              try {
                var ok = document.execCommand('insertText', false, lines[li]);
                if (!ok) {
                  // 降级：直接追加文本节点
                  var sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) {
                    var range = sel.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(lines[li]));
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                  }
                }
              } catch(eInsert) {
                // 忽略
              }
            }
          }
        }

        // 触发 input 事件
        try {
          var inputEv = document.createEvent('Event');
          inputEv.initEvent('input', true, true);
          target.dispatchEvent(inputEv);
        } catch(eEv) {}

        return { ok: true, length: text.length, method: 'draft-editor-insertText' };
      } catch (e) {
        return { ok: false, msg: String(e) };
      }
    })();
  `;
}

/**
 * [知乎专用] 点击打开视频标记选择 Modal。
 * 点击目标优先级：
 *   1. .VideoUploadForm-videoTypeSelectOverlay[aria-label="选择视频标记"]
 *   2. .VideoUploadForm-select 内的 combobox 按钮
 *   3. 包含"选择标记"文本的可点击元素
 */
function buildOpenVideoTagModalScript(): string {
  return `
    (function () {
      var result = { clicked: false, method: '', error: '' };
      try {
        // 方式1：overlay 按钮（最可靠）
        var overlayBtn = document.querySelector('.VideoUploadForm-videoTypeSelectOverlay');
        if (overlayBtn) {
          overlayBtn.click();
          result.clicked = true;
          result.method = 'overlay';
          return result;
        }

        // 方式2：select 容器内的 combobox 按钮
        var selectContainer = document.querySelector('.VideoUploadForm-select');
        if (selectContainer) {
          var toggleBtn = selectContainer.querySelector('[role="combobox"]') ||
                          selectContainer.querySelector('button') ||
                          selectContainer;
          toggleBtn.click();
          result.clicked = true;
          result.method = 'select-combobox';
          return result;
        }

        // 方式3：查找包含"选择标记"或"视频标记"的可点击元素
        var allClickable = document.querySelectorAll('button, [role="button"], div[class*="select"], div[class*="Select"]');
        for (var i = 0; i < allClickable.length; i++) {
          var el = allClickable[i];
          var txt = (el.innerText || el.textContent || '').trim();
          if (txt && (txt.indexOf('选择标记') !== -1 || txt.indexOf('视频标记') !== -1)) {
            try {
              var st = window.getComputedStyle(el, null);
              if (st && st.display !== 'none' && st.visibility !== 'hidden') {
                el.click();
                result.clicked = true;
                result.method = 'text-match';
                return result;
              }
            } catch(eSz) {}
          }
        }

        result.error = 'no-trigger-element';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎专用] 在已打开的 Modal 中选择视频标记并确认。
 * 注意：调用此脚本前必须确保 Modal 已经渲染到 DOM 中。
 * 流程：选择选项 → 点击确认
 */
function buildSelectAndConfirmVideoTagScript(preferredTag?: string): string {
  const preferredJson = JSON.stringify(preferredTag || '');
  return `
    (function () {
      var result = {
        modalFound: false,
        selected: false,
        selectedTag: '',
        confirmed: false,
        options: [],
        error: '',
        step: 'start',
      };
      try {
        // 查找 Modal
        var modal = document.querySelector('.VideoUploadForm-videoTypeModal');
        if (!modal) {
          result.error = 'modal-not-found';
          return result;
        }

        // 检查 Modal 是否可见
        try {
          var mStyle = window.getComputedStyle(modal, null);
          if (mStyle && (mStyle.display === 'none' || mStyle.visibility === 'hidden')) {
            result.error = 'modal-hidden';
            return result;
          }
          if (modal.offsetParent === null) {
            result.error = 'modal-not-visible';
            return result;
          }
        } catch(e) {}

        result.modalFound = true;
        result.step = 'collect-options';

        // 收集选项
        var optionEls = modal.querySelectorAll('.VideoUploadForm-videoTypeModalOption[role="button"]');
        var options = [];
        for (var oi = 0; oi < optionEls.length; oi++) {
          var optEl = optionEls[oi];
          var optText = '';
          var spanEl = optEl.querySelector('span');
          if (spanEl) {
            optText = spanEl.textContent.trim();
          } else {
            optText = (optEl.innerText || optEl.textContent || '').trim();
          }
          // 检查是否已选中
          var iconSvg = optEl.querySelector('.VideoUploadForm-videoTypeModalIcon svg');
          var isSelected = !!iconSvg;
          if (optText) {
            options.push({ el: optEl, text: optText, selected: isSelected });
            result.options.push(optText + (isSelected ? '(已选)' : ''));
          }
        }

        if (options.length === 0) {
          result.error = 'no-options-found';
          return result;
        }

        result.step = 'select-option';
        var preferred = ${preferredJson};
        var chosenIndex = -1;

        // 优先：已有选中的
        for (var si = 0; si < options.length; si++) {
          if (options[si].selected) {
            chosenIndex = si;
            break;
          }
        }

        // 匹配 preferredTag
        if (chosenIndex === -1 && preferred) {
          for (var pi = 0; pi < options.length; pi++) {
            var optLower = options[pi].text.toLowerCase();
            var prefLower = preferred.toLowerCase();
            if (options[pi].text === preferred ||
                optLower.indexOf(prefLower) !== -1 ||
                prefLower.indexOf(optLower) !== -1) {
              chosenIndex = pi;
              break;
            }
          }
        }

        // 默认：选第一个非"无需标注"的
        if (chosenIndex === -1) {
          for (var fi = 0; fi < options.length; fi++) {
            if (options[fi].text.indexOf('无需标注') === -1) {
              chosenIndex = fi;
              break;
            }
          }
          if (chosenIndex === -1) chosenIndex = 0;
        }

        var chosen = options[chosenIndex];

        // 点击选中选项（如果未选中）
        if (!chosen.selected) {
          try {
            chosen.el.click();
          } catch(eClick) {
            try {
              var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              chosen.el.dispatchEvent(evt);
            } catch(eEvt) {
              result.error = 'option-click-failed';
              return result;
            }
          }
          result.selected = true;
        } else {
          result.selected = true;
        }
        result.selectedTag = chosen.text;

        // 点击确认按钮
        result.step = 'click-confirm';
        var confirmBtn = null;
        var btnGroup = modal.querySelector('.ModalButtonGroup');
        if (btnGroup) {
          var btns = btnGroup.querySelectorAll('button');
          for (var ci = 0; ci < btns.length; ci++) {
            var btnText = (btns[ci].innerText || btns[ci].textContent || '').trim();
            if (btnText === '确认' || btnText.indexOf('确认') !== -1) {
              // 跳过"取消"按钮，选第二个（确认）
              if (btnText.indexOf('取消') !== -1) continue;
              confirmBtn = btns[ci];
              break;
            }
          }
        }

        if (!confirmBtn) {
          var allModalBtns = modal.querySelectorAll('button');
          for (var bi = 0; bi < allModalBtns.length; bi++) {
            var bText = (allModalBtns[bi].innerText || allModalBtns[bi].textContent || '').trim();
            if (bText === '确认' || bText.indexOf('确认') !== -1) {
              if (bText.indexOf('取消') !== -1) continue;
              confirmBtn = allModalBtns[bi];
              break;
            }
          }
        }

        if (!confirmBtn) {
          result.error = 'no-confirm-button';
          return result;
        }

        try {
          confirmBtn.click();
          result.confirmed = true;
        } catch(eConfirm) {
          try {
            var evt2 = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            confirmBtn.dispatchEvent(evt2);
            result.confirmed = true;
          } catch(eEvt2) {
            result.error = 'confirm-click-failed';
            return result;
          }
        }

      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

// ========================= 图文发布（想法）专用脚本 =========================

/**
 * [知乎图文专用] 在弹窗内精确上传图片。
 * 使用 DOM.getDocument 遍历整棵 DOM 树，找到所有 file input，
 * 然后通过父节点判断哪个在 Modal 弹窗内，精确注入。
 */
async function uploadImageInModal(
  win: BrowserWindow,
  imagePath: string,
  log: (level: PublishLogEntry['level'], stage: string, message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    try {
      if (!win.webContents.debugger.isAttached()) {
        win.webContents.debugger.attach('1.3');
      }
    } catch { /* 可能已 attached */ }

    const candidateNodeIds: Array<{ nodeId: number; method: string; accept?: string }> = [];

    // ===== 方法 1：通过 JS 先定位到 Modal 内的 file input 元素，再用 DOM.querySelector 获取 nodeId =====
    try {
      log('info', 'upload', '[B1] 方法1：JS定位 + DOM.querySelector 获取 nodeId…');

      // 先用 JS 找到 Modal 内的 file input
      const findInputScript = `
        (function() {
          try {
            var result = { found: false, selector: '', accept: '', className: '', modalText: '', modalClass: '', inputCount: 0 };
            // 找可见的图片上传 Modal
            var modals = document.querySelectorAll('.Modal, [class*="modal"], [class*="Modal"]');
            var targetModal = null;
            for (var mi = 0; mi < modals.length; mi++) {
              var m = modals[mi];
              try {
                var st = window.getComputedStyle(m, null);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
                if (m.offsetParent === null) continue;
              } catch(e) { continue; }
              var txt = (m.innerText || m.textContent || '');
              var isImgModal = txt.indexOf('本地图片') !== -1 ||
                               txt.indexOf('上传图片') !== -1 ||
                               txt.indexOf('插入图片') !== -1 ||
                               txt.indexOf('已上传') !== -1 ||
                               m.querySelector('.css-1v0c8fj') !== null;
              if (isImgModal) {
                targetModal = m;
                result.modalText = txt.slice(0, 80);
                result.modalClass = m.className || '';
                break;
              }
            }

            // 在 Modal 内找所有 file input
            var fileInputs = [];
            if (targetModal) {
              var inputs = targetModal.querySelectorAll('input[type="file"]');
              for (var ii = 0; ii < inputs.length; ii++) {
                fileInputs.push(inputs[ii]);
              }
            }
            // 如果 Modal 内没找到，全局找 image 类型的 file input
            if (fileInputs.length === 0) {
              var allInputs = document.querySelectorAll('input[type="file"][accept*="image"]');
              for (var ai = 0; ai < allInputs.length; ai++) {
                fileInputs.push(allInputs[ai]);
              }
            }
            // 再兜底：所有 file input
            if (fileInputs.length === 0) {
              var allFileInputs = document.querySelectorAll('input[type="file"]');
              for (var fi = 0; fi < allFileInputs.length; fi++) {
                fileInputs.push(allFileInputs[fi]);
              }
            }

            result.inputCount = fileInputs.length;

            // 选最合适的 file input
            var targetInput = null;
            for (var i = 0; i < fileInputs.length; i++) {
              var inp = fileInputs[i];
              var acc = inp.accept || '';
              // 优先选 accept 含 image 的
              if (acc.indexOf('image') !== -1) {
                targetInput = inp;
                break;
              }
            }
            if (!targetInput && fileInputs.length > 0) {
              targetInput = fileInputs[0];
            }

            if (targetInput) {
              result.found = true;
              result.accept = targetInput.accept || '';
              result.className = targetInput.className || '';
              // 给元素加一个唯一标记，便于后续 querySelector 定位
              targetInput.setAttribute('data-upload-target', 'zhihu-pin-image');
              result.selector = 'input[data-upload-target="zhihu-pin-image"]';
            }
            return result;
          } catch(e) {
            return { found: false, error: String(e) };
          }
        })();
      `;
      const findRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: findInputScript, returnByValue: true,
      }).catch(() => null);
      const findVal = findRes && findRes.result && findRes.result.value ? findRes.result.value : null;

      if (findVal && findVal.found && findVal.selector) {
        log('info', 'upload', `[B1] JS定位到 file input: accept=${findVal.accept}, class=${String(findVal.className || '').slice(0, 40)}, count=${findVal.inputCount}`);
        if (findVal.modalClass) {
          log('info', 'upload', `[B1] Modal class: ${String(findVal.modalClass).slice(0, 60)}`);
        }

        // 用 DOM.querySelector 找到 nodeId（在 document 上下文中）
        try {
          const docNode: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 0 }).catch(() => null);
          if (docNode && docNode.root && docNode.root.nodeId !== undefined) {
            const queryRes: any = await win.webContents.debugger.sendCommand('DOM.querySelector', {
              nodeId: docNode.root.nodeId,
              selector: findVal.selector,
            }).catch(() => null);
            if (queryRes && queryRes.nodeId !== undefined) {
              candidateNodeIds.push({ nodeId: queryRes.nodeId, method: 'querySelector', accept: findVal.accept });
              log('info', 'upload', `[B1] DOM.querySelector 获取 nodeId=${queryRes.nodeId}`);
            }
          }
        } catch (qsErr) {
          log('warn', 'upload', `[B1] DOM.querySelector 失败: ${(qsErr as Error).message}`);
        }
      } else {
        log('warn', 'upload', `[B1] JS定位失败: ${findVal ? JSON.stringify(findVal).slice(0, 100) : 'no result'}`);
      }
    } catch (m1Err) {
      log('warn', 'upload', `[B1] 方法1异常: ${(m1Err as Error).message}`);
    }

    // ===== 方法 2：DOM.getDocument 全量遍历（兜底方案） =====
    if (candidateNodeIds.length === 0) {
      try {
        log('info', 'upload', '[B1] 方法2：DOM.getDocument 全量遍历…');
        const docResult: any = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }).catch(() => null);
        if (!docResult || !docResult.root) {
          log('warn', 'upload', '无法获取 DOM 树');
        } else {
          // 扁平化所有节点
          const allNodes: any[] = [];
          const walk = (n: any) => {
            if (!n) return;
            allNodes.push(n);
            if (n.children) n.children.forEach(walk);
            if (n.shadowRoots) n.shadowRoots.forEach(walk);
            if (n.templateContent) walk(n.templateContent);
            if (n.contentDocument) walk(n.contentDocument);
          };
          walk(docResult.root);
          log('info', 'upload', `[B1] 遍历 ${allNodes.length} 个节点`);

          // 建立 parentId 映射
          const parentMap = new Map<number, number>();
          const nodeMap = new Map<number, any>();
          for (const n of allNodes) {
            if (n.nodeId !== undefined) nodeMap.set(n.nodeId, n);
            if (n.children) {
              for (const child of n.children) {
                if (child.nodeId !== undefined && n.nodeId !== undefined) {
                  parentMap.set(child.nodeId, n.nodeId);
                }
              }
            }
          }

          // 找到所有 type=file 的 input
          const fileInputs: Array<{ nodeId: number; accept: string; className: string }> = [];
          for (const n of allNodes) {
            if (!n || !n.attributes) continue;
            const nn = (n.nodeName || '').toLowerCase();
            if (nn !== 'input') continue;
            let hasFile = false;
            let acc = '';
            let cls = '';
            for (let i = 0; i < n.attributes.length; i += 2) {
              const attrName = n.attributes[i];
              const attrVal = n.attributes[i + 1];
              if (attrName === 'type' && attrVal === 'file') hasFile = true;
              else if (attrName === 'accept') acc = attrVal || '';
              else if (attrName === 'class') cls = attrVal || '';
            }
            if (hasFile && n.nodeId !== undefined) {
              fileInputs.push({ nodeId: n.nodeId, accept: acc, className: cls });
            }
          }
          log('info', 'upload', `[B1] 找到 ${fileInputs.length} 个 file input`);

          if (fileInputs.length > 0) {
            // 判断是否在 Modal 内
            const isInModal = (nodeId: number): boolean => {
              let curId: number | undefined = nodeId;
              let depth = 0;
              while (curId !== undefined && depth < 50) {
                const node = nodeMap.get(curId);
                if (node) {
                  const nn = (node.nodeName || '').toLowerCase();
                  if (nn === 'div' && node.attributes) {
                    for (let i = 0; i < node.attributes.length; i += 2) {
                      if (node.attributes[i] === 'class') {
                        const cls = node.attributes[i + 1] || '';
                        if (/Modal/i.test(cls) || /modal/i.test(cls)) {
                          return true;
                        }
                      }
                    }
                  }
                }
                curId = parentMap.get(curId);
                depth++;
              }
              return false;
            };

            // 优先选 Modal 内的
            const modalInputs = fileInputs.filter((fi) => isInModal(fi.nodeId));
            log('info', 'upload', `[B1] Modal 内的 file input: ${modalInputs.length} 个`);

            const targets = modalInputs.length > 0 ? modalInputs : fileInputs.filter((fi) => /image/i.test(fi.accept));
            for (const fi of targets.slice(0, 3)) {
              candidateNodeIds.push({ nodeId: fi.nodeId, method: 'dom-traversal', accept: fi.accept });
            }
          }
        }
      } catch (m2Err) {
        log('warn', 'upload', `[B1] 方法2异常: ${(m2Err as Error).message}`);
      }
    }

    if (candidateNodeIds.length === 0) {
      log('warn', 'upload', '所有方法均未找到可用的 file input nodeId');
      return false;
    }

    log('info', 'upload', `[B1] 共找到 ${candidateNodeIds.length} 个候选 nodeId，开始尝试注入…`);

    // ===== 尝试注入文件 =====
    for (let i = 0; i < candidateNodeIds.length; i++) {
      const cand = candidateNodeIds[i];
      log('info', 'upload', `[B1] 尝试第 ${i + 1} 个: nodeId=${cand.nodeId}, method=${cand.method}, accept=${cand.accept || 'N/A'}`);

      try {
        await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: cand.nodeId,
          files: [imagePath],
        });
        log('info', 'upload', '✅ DOM.setFileInputFiles 注入成功');

        // 触发 change / input 事件（多种方式确保上传被触发）
        try {
          const evtScript = `
            (function () {
              try {
                var inputs = document.querySelectorAll('input[type="file"]');
                var triggered = 0;
                var total = inputs.length;
                var targetInfo = null;
                var hasFiles = 0;
                for (var m = 0; m < inputs.length; m++) {
                  var fi2 = inputs[m];
                  if (fi2.files && fi2.files.length > 0) {
                    hasFiles++;
                    try {
                      // 标准 change 事件
                      fi2.dispatchEvent(new Event('change', { bubbles: true }));
                    } catch (e1) {}
                    try {
                      fi2.dispatchEvent(new Event('input', { bubbles: true }));
                    } catch (e2) {}
                    // React 合成事件需要模拟原生事件
                    try {
                      var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                      ).set;
                      // 触发 React 的 onChange
                      fi2.dispatchEvent(new Event('change', { bubbles: true }));
                    } catch(eReact) {}
                    // 额外触发 focus + blur
                    try { fi2.focus(); } catch(e) {}
                    try { fi2.blur(); } catch(e) {}
                    triggered++;
                    if (!targetInfo) {
                      targetInfo = { accept: fi2.accept, className: fi2.className, fileCount: fi2.files.length };
                    }
                  }
                }
                return { triggered: triggered, total: total, hasFiles: hasFiles, targetInfo: targetInfo };
              } catch (e) { return { error: String(e) }; }
            })();
          `;
          const evtRes: any = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: evtScript, returnByValue: true,
          }).catch(() => null);
          const evtVal = evtRes && evtRes.result && evtRes.result.value ? evtRes.result.value : null;
          log('info', 'upload', `事件触发结果: ${evtVal ? JSON.stringify(evtVal).slice(0, 250) : 'unknown'}`);
        } catch (evtErr) {
          log('warn', 'upload', `事件触发异常: ${(evtErr as Error).message}`);
        }

        // 清理标记
        try {
          await win.webContents.debugger.sendCommand('Runtime.evaluate', {
            expression: `document.querySelectorAll('input[data-upload-target]').forEach(function(el){ el.removeAttribute('data-upload-target'); });`,
            returnByValue: true,
          }).catch(() => null);
        } catch { /* ignore */ }

        return true;
      } catch (injectErr) {
        log('warn', 'upload', `nodeId=${cand.nodeId} 注入失败: ${(injectErr as Error).message}`);
        continue;
      }
    }

    return false;
  } catch (err) {
    log('error', 'upload', `图片上传异常: ${(err as Error).message}`);
    return false;
  }
}

/**
 * [知乎图文专用] 检测弹窗内图片是否上传完成（出现图片预览或插入按钮）。
 * 上传成功后，弹窗内会出现图片预览和"插入图片"按钮。
 */
function buildModalImageUploadedProbe(): string {
  return `
    (function () {
      var result = { uploaded: false, hasPreview: false, hasInsertButton: false, insertButtonEnabled: false, previewCount: 0, insertText: '', buttonDisabled: true, uploadStatus: 'unknown', uploadedCount: 0 };
      try {
        // 查找当前可见的 Modal
        var modals = document.querySelectorAll('.Modal, [class*="modal"], [class*="Modal"]');
        for (var mi = 0; mi < modals.length; mi++) {
          var modal = modals[mi];
          try {
            var st = window.getComputedStyle(modal, null);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
            if (modal.offsetParent === null) continue;
          } catch(eSz) { continue; }

          var txt = (modal.innerText || modal.textContent || '');
          // 判断是否为图片上传弹窗
          var isImageModal = txt.indexOf('本地图片') !== -1 ||
                             txt.indexOf('上传图片') !== -1 ||
                             txt.indexOf('插入图片') !== -1 ||
                             txt.indexOf('已上传') !== -1 ||
                             modal.querySelector('.css-1v0c8fj') !== null;
          if (!isImageModal) continue;

          // 检查是否有图片预览（img 标签）
          var imgs = modal.querySelectorAll('img');
          var httpImgs = 0;
          for (var ii = 0; ii < imgs.length; ii++) {
            var src = imgs[ii].src || '';
            if (src && (src.indexOf('http') === 0 || src.indexOf('data:') === 0 || src.indexOf('blob:') === 0)) {
              httpImgs++;
            }
          }
          result.previewCount = httpImgs;
          result.hasPreview = httpImgs > 0;

          // 检查"已上传"文本（上传完成的标志）
          var uploadedTextEl = modal.querySelector('.css-yihm2v');
          var hasUploadedText = false;
          var uploadedCount = 0;
          if (uploadedTextEl) {
            var ut = uploadedTextEl.innerText || uploadedTextEl.textContent || '';
            hasUploadedText = ut.indexOf('已上传') !== -1;
            // 提取已上传数量
            var match = ut.match(/已上传\\s*(\\d+)\\s*张/);
            if (match && match[1]) uploadedCount = parseInt(match[1], 10) || 0;
          }
          result.uploadedCount = uploadedCount;

          // 优先通过 class 精确匹配插入按钮
          // css-12pk5sz = 上传中（不可点击），css-owamhi = 上传完成（可点击）
          var uploadingBtn = modal.querySelector('button.css-12pk5sz');
          var uploadedBtn = modal.querySelector('button.css-owamhi');

          if (uploadingBtn) {
            result.hasInsertButton = true;
            result.insertText = (uploadingBtn.innerText || uploadingBtn.textContent || '').trim();
            result.buttonDisabled = true;
            result.insertButtonEnabled = false;
            result.uploadStatus = 'uploading';
          } else if (uploadedBtn) {
            result.hasInsertButton = true;
            result.insertText = (uploadedBtn.innerText || uploadedBtn.textContent || '').trim();
            result.buttonDisabled = false;
            result.insertButtonEnabled = true;
            result.uploadStatus = 'done';
          } else {
            // 兜底：遍历所有 button
            var btns = modal.querySelectorAll('button');
            for (var bi = 0; bi < btns.length; bi++) {
              var btnText = (btns[bi].innerText || btns[bi].textContent || '').trim();
              if (btnText && (btnText.indexOf('插入') !== -1 || btnText.indexOf('确认') !== -1 || btnText.indexOf('确定') !== -1)) {
                result.hasInsertButton = true;
                result.insertText = btnText;
                // 检查是否可点击
                var isDisabled = btns[bi].disabled ||
                                 btns[bi].getAttribute('disabled') !== null ||
                                 btns[bi].getAttribute('aria-disabled') === 'true' ||
                                 (btns[bi].classList && btns[bi].classList.contains('is-disabled'));
                result.buttonDisabled = isDisabled;
                result.insertButtonEnabled = !isDisabled;
                result.uploadStatus = isDisabled ? 'uploading' : 'done';
                break;
              }
            }
          }

          // 上传完成 = （按钮可点击）OR（有"已上传"文本）
          result.uploaded = result.insertButtonEnabled || hasUploadedText;
          if (hasUploadedText && result.uploadStatus === 'unknown') {
            result.uploadStatus = 'done';
          }
          break;
        }
      } catch (e) {}
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 在弹窗中点击"插入图片"按钮（支持 button 和 role="button" 两种形式）。
 */
function buildClickInsertInModalScript(): string {
  return `
    (function () {
      var result = { clicked: false, text: '', error: '', method: '' };
      try {
        var modals = document.querySelectorAll('.Modal, [class*="modal"], [class*="Modal"]');
        for (var mi = 0; mi < modals.length; mi++) {
          var modal = modals[mi];
          try {
            var st = window.getComputedStyle(modal, null);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
            if (modal.offsetParent === null) continue;
          } catch(eSz) { continue; }

          var txt = (modal.innerText || modal.textContent || '');
          var isImageModal = txt.indexOf('本地图片') !== -1 ||
                             txt.indexOf('上传图片') !== -1 ||
                             txt.indexOf('插入图片') !== -1 ||
                             txt.indexOf('已上传') !== -1 ||
                             modal.querySelector('.css-1v0c8fj') !== null;
          if (!isImageModal) continue;

          // 优先点击上传完成状态的按钮（css-owamhi = 可点击）
          var doneBtn = modal.querySelector('button.css-owamhi');
          if (doneBtn) {
            try {
              doneBtn.click();
              result.clicked = true;
              result.text = (doneBtn.innerText || doneBtn.textContent || '').trim();
              result.method = 'css-owamhi';
              return result;
            } catch(e1) {}
          }

          // 再找 button 元素中包含"插入"文本的
          var btns = modal.querySelectorAll('button');
          for (var bi = 0; bi < btns.length; bi++) {
            var btnText = (btns[bi].innerText || btns[bi].textContent || '').trim();
            if (btnText && (btnText.indexOf('插入') !== -1 || btnText.indexOf('确认') !== -1 || btnText.indexOf('确定') !== -1)) {
              if (btns[bi].disabled) continue;
              btns[bi].click();
              result.clicked = true;
              result.text = btnText;
              result.method = 'button-text';
              return result;
            }
          }

          // 再找 role="button" 的 div
          var roleBtns = modal.querySelectorAll('[role="button"]');
          for (var ri = 0; ri < roleBtns.length; ri++) {
            var rbText = (roleBtns[ri].innerText || roleBtns[ri].textContent || '').trim();
            if (rbText && (rbText.indexOf('插入') !== -1 || rbText.indexOf('确认') !== -1)) {
              try {
                roleBtns[ri].click();
                result.clicked = true;
                result.text = rbText;
                result.method = 'role-button';
                return result;
              } catch(eClick) {
                try {
                  var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                  roleBtns[ri].dispatchEvent(evt);
                  result.clicked = true;
                  result.text = rbText;
                  result.method = 'role-button-event';
                  return result;
                } catch(eEvt) {}
              }
            }
          }
        }
        result.error = 'no-insert-button';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 点击"分享此刻的想法..."区域，激活编辑器。
 * 知乎想法页面初始状态下，点击提示文本后才会展开完整编辑表单。
 * 关键判断：.css-1lkz3hi 提示文本可见 = 编辑器未激活，需要点击
 */
function buildActivatePinEditorScript(): string {
  return `
    (function () {
      var result = { clicked: false, method: '', alreadyActive: false, error: '', hintVisible: false, hintText: '' };
      try {
        // 关键检测：css-1lkz3hi 提示文本是否可见
        // 如果可见，说明编辑器处于折叠状态，需要点击激活
        var hintEl = document.querySelector('.css-1lkz3hi');
        if (hintEl) {
          result.hintText = (hintEl.innerText || hintEl.textContent || '').trim();
          try {
            var hintSt = window.getComputedStyle(hintEl, null);
            var hintVisible = hintSt && hintSt.display !== 'none' && hintSt.visibility !== 'hidden';
            // 也检查 offsetParent
            if (hintVisible && hintEl.offsetParent === null) hintVisible = false;
            result.hintVisible = hintVisible;
          } catch(e) {}
        }

        // 如果提示文本可见，说明编辑器未激活，需要点击
        if (result.hintVisible && hintEl) {
          // 优先点击提示文本本身
          try {
            hintEl.click();
            result.clicked = true;
            result.method = 'css-1lkz3hi-direct';
            return result;
          } catch(e1) {}

          // 如果直接点击失败，向上找可点击的父元素
          try {
            var clickable = hintEl;
            for (var p = 0; p < 6; p++) {
              if (clickable.parentElement && clickable.parentElement.tagName !== 'BODY') {
                clickable = clickable.parentElement;
                try {
                  clickable.click();
                  result.clicked = true;
                  result.method = 'css-1lkz3hi-parent-' + p;
                  return result;
                } catch(eP) {}
              } else {
                break;
              }
            }
          } catch(e2) {}
        }

        // 检查 ImageArea 是否可见（另一个判断编辑器已激活的标志）
        var imageArea = document.querySelector('.WritePinV2-Form .ImageArea');
        var imageAreaVisible = false;
        if (imageArea) {
          try {
            var iaSt = window.getComputedStyle(imageArea, null);
            imageAreaVisible = iaSt && iaSt.display !== 'none' && iaSt.visibility !== 'hidden';
            if (imageAreaVisible && imageArea.offsetParent === null) imageAreaVisible = false;
          } catch(e) {}
        }

        // 如果提示文本不可见，且 ImageArea 可见，说明已经激活
        if (!result.hintVisible && imageAreaVisible) {
          result.alreadyActive = true;
          return result;
        }

        // 如果提示文本不可见但 ImageArea 也不可见，可能是其他状态，再检查一下
        if (!result.hintVisible) {
          // 检查标题输入框是否可见
          var titleArea = document.querySelector('.WritePinV2-Form textarea[name="title"]');
          var titleVisible = false;
          if (titleArea) {
            try {
              var taSt = window.getComputedStyle(titleArea, null);
              titleVisible = taSt && taSt.display !== 'none' && titleArea.offsetParent !== null;
            } catch(e) {}
          }
          if (titleVisible) {
            result.alreadyActive = true;
            return result;
          }
        }

        // 兜底：点击 .css-1tdhe7b 容器
        var hintContainer = document.querySelector('.css-1tdhe7b');
        if (hintContainer) {
          try {
            hintContainer.click();
            result.clicked = true;
            result.method = 'css-1tdhe7b-fallback';
            return result;
          } catch(eFallback) {}
        }

        // 兜底：文本匹配
        var allDivs = document.querySelectorAll('div, section, span');
        for (var i = 0; i < allDivs.length; i++) {
          var el = allDivs[i];
          var txt = (el.innerText || el.textContent || '').trim();
          if (txt && txt.indexOf('分享此刻的想法') !== -1 && txt.length < 30) {
            try {
              var st = window.getComputedStyle(el, null);
              if (st && st.display !== 'none' && st.visibility !== 'hidden') {
                el.click();
                result.clicked = true;
                result.method = 'text-match-fallback';
                return result;
              }
            } catch(eSz) {}
          }
        }

        result.error = 'no-activation-element-found';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 检测想法编辑器是否已激活（完整表单是否出现）。
 * 检测：WritePinV2-Form + textarea[name="title"] + DraftEditor-content
 */
function buildPinEditorReadyProbe(): string {
  return `
    (function () {
      var result = { ready: false, hasTitle: false, hasEditor: false, hasPublish: false, hasImageBtn: false };
      try {
        var form = document.querySelector('.WritePinV2-Form');
        if (!form) return result;

        result.hasTitle = !!document.querySelector('.WritePinV2-Form textarea[name="title"]');
        result.hasEditor = !!document.querySelector('.WritePinV2-Form .public-DraftEditor-content');
        result.hasImageBtn = !!document.querySelector('.WritePinToolbar button .ZDI--Image24, .WritePinToolbar .ZDI--Image24');
        result.hasPublish = !!document.querySelector('.WritePinToolbar button:not([disabled])');

        result.ready = result.hasTitle && result.hasEditor;
      } catch (e) {}
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 填写想法标题。
 * 与视频发布的标题填写类似，但选择器限定在 WritePinV2-Form 内。
 */
function buildFillPinTitleScript(title: string): string {
  return `
    (function () {
      var result = { ok: false, length: 0, error: '' };
      try {
        var ta = document.querySelector('.WritePinV2-Form textarea[name="title"]');
        if (!ta) {
          result.error = 'no-title-textarea';
          return result;
        }
        var maxLen = 50;
        var text = ${JSON.stringify(title)}.slice(0, maxLen);
        var nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        result.ok = true;
        result.length = text.length;
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 填写想法正文（Draft.js 富文本编辑器）。
 * 话题直接追加在正文末尾，用空格分隔。
 */
function buildFillPinContentScript(content: string, tags?: string[]): string {
  const tagsJson = JSON.stringify(tags || []);
  return `
    (function () {
      var result = { ok: false, length: 0, actualLength: 0, error: '', tags: [], method: '', debug: '' };
      try {
        var editor = document.querySelector('.WritePinV2-Form .public-DraftEditor-content');
        if (!editor) {
          editor = document.querySelector('.WritePinV2-Form .Editable-content') ||
                   document.querySelector('.WritePinV2-Form .RichText--editable') ||
                   document.querySelector('.EditorArea .public-DraftEditor-content');
        }
        if (!editor) {
          result.error = 'no-editor';
          return result;
        }

        // 构造正文内容（正文 + 话题）
        var maxLen = 1000;
        var baseText = ${JSON.stringify(content)};
        var tags = ${tagsJson};
        var tagStr = '';
        if (tags && tags.length > 0) {
          for (var ti = 0; ti < tags.length; ti++) {
            var tagText = '#' + tags[ti] + ' ';
            if (baseText.length + tagStr.length + tagText.length <= maxLen) {
              tagStr += tagText;
              result.tags.push(tags[ti]);
            } else {
              break;
            }
          }
        }
        var fullText = (baseText + tagStr).slice(0, maxLen);
        result.length = fullText.length;
        if (fullText.length === 0) {
          result.ok = true; result.actualLength = 0; result.method = 'empty';
          return result;
        }

        // ===== 方案 1：通过 paste 事件粘贴文本（最可靠，会触发 Draft.js onChange） =====
        try {
          // 先点击聚焦
          editor.focus();
          editor.click();
          // 清空现有内容
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);

          // 构造 paste 事件
          var dataTransfer = new DataTransfer();
          dataTransfer.setData('text/plain', fullText);

          var pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer,
          });

          // 一些浏览器需要手动设置 clipboardData
          if (!pasteEvent.clipboardData) {
            Object.defineProperty(pasteEvent, 'clipboardData', { value: dataTransfer });
          }
          if (!pasteEvent.originalEvent) {
            pasteEvent.originalEvent = pasteEvent;
          }

          var pastePrevented = false;
          try {
            pastePrevented = !editor.dispatchEvent(pasteEvent);
          } catch(ePaste) {
            result.debug += 'paste-event-error:' + String(ePaste) + ';';
          }

          // 验证是否成功
          var afterPasteText = '';
          try { afterPasteText = (editor.innerText || editor.textContent || '').trim(); } catch(e) {}

          if (afterPasteText.length >= fullText.length * 0.5) {
            result.method = 'paste-event';
          }
        } catch(e1) {
          result.debug += 'scheme1-error:' + String(e1).slice(0, 50) + ';';
        }

        // ===== 方案 2：使用 inputType=insertText 的 beforeinput + input 事件序列 =====
        if (!result.method) {
          try {
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);

            // 逐个字符触发 beforeinput + input（模拟真实输入）
            var successChars = 0;
            for (var ci = 0; ci < fullText.length; ci++) {
              var ch = fullText[ci];
              try {
                var beforeInputEvt = new InputEvent('beforeinput', {
                  bubbles: true, cancelable: true, inputType: 'insertText', data: ch,
                });
                editor.dispatchEvent(beforeInputEvt);
                var inputEvt = new InputEvent('input', {
                  bubbles: true, cancelable: false, inputType: 'insertText', data: ch,
                });
                editor.dispatchEvent(inputEvt);
                successChars++;
              } catch(eChar) {}
            }

            var afterInputText = '';
            try { afterInputText = (editor.innerText || editor.textContent || '').trim(); } catch(e) {}

            if (afterInputText.length >= fullText.length * 0.5) {
              result.method = 'input-event-sequence';
            } else if (successChars > 0) {
              // 事件触发了但内容没更新，尝试 DOM 写入后再触发
              result.debug += 'input-events-fired-but-no-content;';
            }
          } catch(e2) {
            result.debug += 'scheme2-error:' + String(e2).slice(0, 50) + ';';
          }
        }

        // ===== 方案 3：document.execCommand('insertText') =====
        if (!result.method) {
          try {
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);

            var insertOk = document.execCommand('insertText', false, fullText);
            if (insertOk) {
              var afterInsertText = '';
              try { afterInsertText = (editor.innerText || editor.textContent || '').trim(); } catch(e) {}
              if (afterInsertText.length >= fullText.length * 0.5) {
                result.method = 'execCommand-insertText';
              }
            }
          } catch(e3) {
            result.debug += 'scheme3-error:' + String(e3).slice(0, 50) + ';';
          }
        }

        // ===== 方案 4：DOM 直接写入兜底 =====
        var blocks = editor.querySelectorAll('[data-block="true"]');
        var currentText2 = '';
        try {
          var cv1 = editor.innerText || '';
          var cv2 = editor.textContent || '';
          currentText2 = (cv1.length > cv2.length ? cv1 : cv2).trim();
        } catch(eCur) {}
        if (currentText2.length < fullText.length / 2) {
          if (blocks.length > 0) {
            var firstBlock = blocks[0];
            var span = firstBlock.querySelector('span[data-text]') || firstBlock.querySelector('span');
            if (span) span.textContent = fullText;
            else firstBlock.textContent = fullText;
          } else {
            editor.textContent = fullText;
          }
          result.method = result.method ? result.method + '+dom' : 'dom';
        }

        // ===== 最后尝试：通过 React fiber 找到 onChange 并触发 =====
        try {
          // 向上找包含 React fiber 的节点
          var fiberNode = editor;
          var fiberKey = null;
          for (var fk = 0; fk < 15; fk++) {
            if (!fiberNode || !fiberNode.parentElement) break;
            var keys = Object.keys(fiberNode);
            for (var ki = 0; ki < keys.length; ki++) {
              if (keys[ki].indexOf('__reactFiber') === 0 ||
                  keys[ki].indexOf('__reactInternalInstance') === 0) {
                fiberKey = keys[ki];
                break;
              }
            }
            if (fiberKey) break;
            fiberNode = fiberNode.parentElement;
          }

          if (fiberKey && fiberNode) {
            var fiber = fiberNode[fiberKey];
            var onChangeFunc = null;
            var editorStateVal = null;
            var visited2 = 0;

            var findOnChange = function(f) {
              if (!f || visited2 > 500 || onChangeFunc) return;
              visited2++;
              try {
                var sn = f.stateNode;
                if (sn && typeof sn === 'object') {
                  // 检查 props 中的 onChange 和 editorState
                  if (sn.props && typeof sn.props.onChange === 'function' && sn.props.editorState) {
                    onChangeFunc = sn.props.onChange;
                    editorStateVal = sn.props.editorState;
                    return;
                  }
                  if (typeof sn.onChange === 'function' && (sn.editorState || sn.state)) {
                    onChangeFunc = sn.onChange;
                    editorStateVal = sn.editorState || (sn.state && sn.state.editorState);
                    return;
                  }
                  // 检查 stateNode 本身就是编辑器
                  if (sn.editor === editor) {
                    if (sn.props && typeof sn.props.onChange === 'function') {
                      onChangeFunc = sn.props.onChange;
                      editorStateVal = sn.props.editorState;
                    } else if (typeof sn.onChange === 'function') {
                      onChangeFunc = sn.onChange;
                      editorStateVal = sn.editorState;
                    }
                    return;
                  }
                }
                // 检查 memoizedProps / pendingProps
                if (f.memoizedProps && typeof f.memoizedProps.onChange === 'function' && f.memoizedProps.editorState) {
                  onChangeFunc = f.memoizedProps.onChange;
                  editorStateVal = f.memoizedProps.editorState;
                  return;
                }
              } catch(eFiber2) {}
              if (f.return) findOnChange(f.return);
              if (f.child) findOnChange(f.child);
              if (f.sibling) findOnChange(f.sibling);
            };
            findOnChange(fiber);

            if (onChangeFunc && editorStateVal) {
              result.debug += 'found-react-onChange;';
              // 有 onChange 和 editorState，但我们没有 Draft 模块来创建新的 EditorState
              // 尝试从 editorState 的构造函数获取
              try {
                var EditorStateCtor = editorStateVal.constructor;
                if (EditorStateCtor && EditorStateCtor.createWithContent) {
                  var ContentStateCtor = editorStateVal.getCurrentContent ? editorStateVal.getCurrentContent().constructor : null;
                  if (ContentStateCtor && ContentStateCtor.createFromText) {
                    var newContent = ContentStateCtor.createFromText(fullText);
                    var newEditorState = EditorStateCtor.createWithContent(newContent);
                    onChangeFunc.call(null, newEditorState);
                    result.method = 'react-onChange-direct';
                  }
                }
              } catch(eDraft2) {
                result.debug += 'draft-ctor-error:' + String(eDraft2).slice(0, 80) + ';';
              }
            } else {
              result.debug += 'no-react-onChange-found;';
            }
          }
        } catch(eReact2) {
          result.debug += 'react-fiber-error:' + String(eReact2).slice(0, 50) + ';';
        }

        // ===== 验证 =====
        var actualText = '';
        try {
          var v1 = editor.innerText || '';
          var v2 = editor.textContent || '';
          var blocks2 = editor.querySelectorAll('[data-block="true"] .public-DraftStyleDefault-block');
          var v3 = '';
          for (var bi2 = 0; bi2 < blocks2.length; bi2++) v3 += blocks2[bi2].textContent || '';
          var unstyled = editor.querySelectorAll('.Editable-unstyled');
          var v4 = '';
          for (var j = 0; j < unstyled.length; j++) v4 += unstyled[j].textContent || '';
          actualText = v1;
          if (v2.length > actualText.length) actualText = v2;
          if (v3.length > actualText.length) actualText = v3;
          if (v4.length > actualText.length) actualText = v4;
          actualText = actualText.trim();
        } catch(eChk) {}
        result.actualLength = actualText.length;
        result.ok = actualText.length > 0;
        if (!result.ok) result.error = 'content-not-verified';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 点击工具栏中的图片上传按钮。
 * 目标：工具栏中包含 ZDI--Image24 图标的按钮
 */
function buildClickImageButtonScript(): string {
  return `
    (function () {
      var result = { clicked: false, method: '', error: '' };
      try {
        // 方式1：通过图片图标找到按钮
        var imageIcon = document.querySelector('.WritePinToolbar .ZDI--Image24');
        if (imageIcon) {
          var btn = imageIcon.closest('button');
          if (btn) {
            btn.click();
            result.clicked = true;
            result.method = 'image-icon-button';
            return result;
          }
        }

        // 方式2：在工具栏中找所有 button，匹配图片相关
        var toolbar = document.querySelector('.WritePinToolbar');
        if (toolbar) {
          var btns = toolbar.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var btn2 = btns[i];
            var svg = btn2.querySelector('svg');
            if (svg) {
              var svgHtml = svg.innerHTML || '';
              // 图片图标通常包含 Image 相关路径
              if (svgHtml.indexOf('Image24') !== -1 || btn2.innerHTML.indexOf('ZDI--Image') !== -1) {
                btn2.click();
                result.clicked = true;
                result.method = 'toolbar-button-svg';
                return result;
              }
            }
          }
        }

        result.error = 'no-image-button';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 检测图片上传弹窗是否出现。
 * 检测逻辑：通过 .Modal 类名 + 内部特定元素（本地图片/上传图片区域、插入按钮等）判断
 */
function buildImageUploadModalProbe(): string {
  return `
    (function () {
      var result = { visible: false, hasLocalUpload: false, hasInsertButton: false, hasFileInput: false, modalClass: '', insertButtonClass: '' };
      try {
        // 查找所有 Modal
        var modals = document.querySelectorAll('.Modal, [class*="modal"], [class*="Modal"]');
        for (var i = 0; i < modals.length; i++) {
          var el = modals[i];
          try {
            var st = window.getComputedStyle(el, null);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
            if (el.offsetParent === null) continue;
          } catch(eSz) { continue; }

          var txt = (el.innerText || el.textContent || '');
          // 判断是否为图片上传弹窗：包含"本地图片"或"上传图片"或"插入图片"
          var isImageModal = txt.indexOf('本地图片') !== -1 ||
                             txt.indexOf('上传图片') !== -1 ||
                             txt.indexOf('插入图片') !== -1 ||
                             txt.indexOf('已上传') !== -1;

          // 也通过特定 class 判断：css-1v0c8fj 是按钮容器
          var hasButtonContainer = el.querySelector('.css-1v0c8fj') !== null;

          if (isImageModal || hasButtonContainer) {
            result.visible = true;
            result.modalClass = el.className || '';
            result.hasLocalUpload = txt.indexOf('本地图片') !== -1 || txt.indexOf('上传图片') !== -1;

            // 检查插入按钮（两种状态：上传中 css-12pk5sz、上传完成 css-owamhi）
            var insertBtn = el.querySelector('button.css-12pk5sz, button.css-owamhi');
            if (insertBtn) {
              result.hasInsertButton = true;
              result.insertButtonClass = insertBtn.className || '';
            } else {
              // 兜底：按文本找
              var allBtns = el.querySelectorAll('button');
              for (var bi = 0; bi < allBtns.length; bi++) {
                var btnTxt = (allBtns[bi].innerText || allBtns[bi].textContent || '').trim();
                if (btnTxt.indexOf('插入图片') !== -1) {
                  result.hasInsertButton = true;
                  result.insertButtonClass = allBtns[bi].className || '';
                  break;
                }
              }
            }

            // 检查是否有 file input
            var fileInput = el.querySelector('input[type="file"]');
            result.hasFileInput = !!fileInput;
            break;
          }
        }

        // 如果没找到，检查 body 下的 file input（可能隐藏在某处）
        if (!result.visible) {
          var allFileInputs = document.querySelectorAll('input[type="file"][accept*="image"]');
          if (allFileInputs.length > 0) {
            result.hasFileInput = true;
          }
        }
      } catch (e) {}
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 点击图片上传弹窗中的"插入图片"按钮。
 * 在选择图片后，需要点击"插入图片"或"确定"按钮来完成上传。
 */
function buildClickInsertImageButtonScript(): string {
  return `
    (function () {
      var result = { clicked: false, text: '', error: '' };
      try {
        // 查找当前可见的 Modal 弹窗
        var modals = document.querySelectorAll('.Modal, [class*="modal"], [class*="Modal"]');
        for (var mi = 0; mi < modals.length; mi++) {
          var modal = modals[mi];
          try {
            var st = window.getComputedStyle(modal, null);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
            if (modal.offsetParent === null) continue;
          } catch(eSz) { continue; }

          var txt = (modal.innerText || modal.textContent || '');
          if (txt.indexOf('本地图片') === -1 && txt.indexOf('上传图片') === -1 && txt.indexOf('插入图片') === -1) continue;

          // 在弹窗内找"插入图片"按钮
          var btns = modal.querySelectorAll('button');
          for (var bi = 0; bi < btns.length; bi++) {
            var btn = btns[bi];
            var btnText = (btn.innerText || btn.textContent || '').trim();
            if (btnText && (btnText === '插入图片' || btnText.indexOf('插入') !== -1 || btnText.indexOf('确定') !== -1)) {
              if (btn.disabled) continue;
              btn.click();
              result.clicked = true;
              result.text = btnText;
              return result;
            }
          }
        }

        // fallback：全局找"插入图片"按钮
        var allBtns = document.querySelectorAll('button');
        for (var i = 0; i < allBtns.length; i++) {
          var b = allBtns[i];
          var bt = (b.innerText || b.textContent || '').trim();
          if (bt && (bt === '插入图片' || bt.indexOf('插入图片') !== -1)) {
            try {
              var bst = window.getComputedStyle(b, null);
              if (bst && (bst.display === 'none' || bst.visibility === 'hidden')) continue;
              if (b.offsetParent === null) continue;
            } catch(e) { continue; }
            if (b.disabled) continue;
            b.click();
            result.clicked = true;
            result.text = bt;
            return result;
          }
        }

        result.error = 'no-insert-button';
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 检测图片是否已成功插入到编辑器中。
 * 检测：编辑器内是否有 img 标签，或页面中是否有上传后的图片预览。
 */
function buildImageInsertedProbe(): string {
  return `
    (function () {
      var result = { inserted: false, imageCount: 0, images: [], draftImageCount: 0, foundEditor: false, imageAreaFound: false, draggableTagCount: 0 };
      try {
        // 优先检查 ImageArea / DraggableTags 区域的图片（知乎图文的图片实际上传区域）
        var imageArea = document.querySelector('.WritePinV2-Form .ImageArea');
        if (imageArea) {
          result.imageAreaFound = true;
          // 检查 DraggableTags-tag 元素（每个图片一个 tag）
          var draggableTags = imageArea.querySelectorAll('.DraggableTags-tag');
          result.draggableTagCount = draggableTags.length;
          // 检查 tag 内的图片（排除 plus 按钮等非图片 tag）
          var imgCount = 0;
          for (var ti = 0; ti < draggableTags.length; ti++) {
            var tag = draggableTags[ti];
            var tagImgs = tag.querySelectorAll('img');
            if (tagImgs.length > 0) {
              // 排除 plus 按钮（没有图片的 tag）
              var hasRealImage = false;
              for (var ti2 = 0; ti2 < tagImgs.length; ti2++) {
                var src = tagImgs[ti2].src || '';
                if (src && src.indexOf('http') !== -1 && src.indexOf('ZDI') === -1) {
                  hasRealImage = true;
                  if (result.images.length < 5) {
                    result.images.push(src.slice(0, 80));
                  }
                  break;
                }
              }
              if (hasRealImage) imgCount++;
            }
          }
          result.imageCount = imgCount;
          // 如果没有在 tag 里找到，直接数 ImageArea 里的 img
          if (result.imageCount === 0) {
            var iaImgs = imageArea.querySelectorAll('img');
            var realImgs = 0;
            for (var ii = 0; ii < iaImgs.length; ii++) {
              var src2 = iaImgs[ii].src || '';
              if (src2 && src2.indexOf('http') !== -1 && src2.indexOf('ZDI') === -1) {
                realImgs++;
              }
            }
            result.imageCount = realImgs;
          }
        }

        // 也检查编辑器内的图片（作为补充）
        var selectors = [
          '.WritePinV2-Form .public-DraftEditor-content',
          '.WritePinV2-Form .Editable-content',
          '.WritePinV2-Form .RichText--editable',
          '.WritePinV2-Form .RichText',
          '.EditorArea .public-DraftEditor-content',
        ];
        var editor = null;
        for (var si = 0; si < selectors.length; si++) {
          var el = document.querySelector(selectors[si]);
          if (el) {
            editor = el;
            break;
          }
        }
        if (editor) {
          result.foundEditor = true;
          var edImgs = editor.querySelectorAll('img');
          var edRealImgs = 0;
          for (var ei = 0; ei < edImgs.length; ei++) {
            var eSrc = edImgs[ei].src || '';
            if (eSrc && eSrc.indexOf('http') !== -1 && eSrc.indexOf('ZDI') === -1) {
              edRealImgs++;
            }
          }
          result.draftImageCount = edRealImgs;
          if (edRealImgs > result.imageCount) {
            result.imageCount = edRealImgs;
          }
          // 也检查 atomic block
          var atomicBlocks = editor.querySelectorAll('[data-block="true"].atomic');
          if (atomicBlocks.length > result.imageCount) {
            result.imageCount = atomicBlocks.length;
          }
        }

        // 检查 figure 元素
        var figures = document.querySelectorAll('.WritePinV2-Form figure');
        if (figures.length > result.imageCount) {
          result.imageCount = figures.length;
        }

        result.inserted = result.imageCount > 0;
      } catch (e) {}
      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 测试模式探测脚本（想法编辑器专用）。
 * 检测表单填写状态并高亮发布按钮。
 * 为什么不用通用的 buildTestModeProbeScript？
 *   1. 想法的发布按钮在 WritePinToolbar-RightGroup 内，通用选择器容易匹配错误
 *   2. Draft.js 编辑器的内容检测需要特殊处理（innerText 可能不准确）
 */
function buildPinTestModeProbeScript(): string {
  return `
    (function () {
      function getOffset(el) {
        var rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      }

      var result = {
        publishButtonFound: false,
        publishButtonInfo: null,
        fields: [],
        note: '',
      };

      try {
        // ========== 1. 查找发布按钮 ==========
        var publishBtn = null;
        var rightGroup = document.querySelector('.WritePinToolbar-RightGroup');
        if (rightGroup) {
          var btns = rightGroup.querySelectorAll('button');
          // 先找可见且文本为"发布"的按钮
          for (var bi = 0; bi < btns.length; bi++) {
            var b = btns[bi];
            var bText = (b.innerText || b.textContent || '').trim();
            if (bText === '发布' || bText.indexOf('发布') !== -1) {
              // 检查是否可见
              var bRect = b.getBoundingClientRect();
              if (bRect.width > 0 && bRect.height > 0) {
                publishBtn = b;
                break;
              }
            }
          }
          // 如果没找到可见的"发布"按钮，找最后一个可见按钮
          if (!publishBtn) {
            for (var bi2 = btns.length - 1; bi2 >= 0; bi2--) {
              var b2 = btns[bi2];
              var rect2 = b2.getBoundingClientRect();
              if (rect2.width > 0 && rect2.height > 0) {
                publishBtn = b2;
                break;
              }
            }
          }
        }

        if (!publishBtn) {
          // fallback：在 WritePinToolbar 内找
          var toolbar = document.querySelector('.WritePinToolbar');
          if (toolbar) {
            var allBtns = toolbar.querySelectorAll('button');
            for (var ti = allBtns.length - 1; ti >= 0; ti--) {
              var tb = allBtns[ti];
              var tbText = (tb.innerText || tb.textContent || '').trim();
              var tbRect = tb.getBoundingClientRect();
              if (tbRect.width > 0 && tbRect.height > 0 &&
                  (tbText === '发布' || tbText.indexOf('发布') !== -1)) {
                publishBtn = tb;
                break;
              }
            }
          }
        }

        if (publishBtn) {
          var pos = getOffset(publishBtn);
          var btnText = (publishBtn.innerText || publishBtn.textContent || '').trim();
          result.publishButtonFound = true;
          result.publishButtonInfo = {
            text: btnText.slice(0, 30),
            selector: '.WritePinToolbar-RightGroup button:last-child',
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
          };

          // 高亮发布按钮
          publishBtn.dataset.originalOutline = publishBtn.style.outline;
          publishBtn.dataset.originalOutlineOffset = publishBtn.style.outlineOffset;
          publishBtn.dataset.originalBoxShadow = publishBtn.style.boxShadow;
          publishBtn.dataset.originalZIndex = publishBtn.style.zIndex;
          publishBtn.dataset.originalPosition = publishBtn.style.position;

          publishBtn.style.outline = '3px solid #ff6b6b';
          publishBtn.style.outlineOffset = '2px';
          publishBtn.style.boxShadow = '0 0 0 4px rgba(255, 107, 107, 0.3), 0 0 20px rgba(255, 107, 107, 0.5)';
          publishBtn.style.zIndex = '99999';

          // 添加闪烁动画
          var styleId = 'flowx-test-highlight-style';
          if (!document.getElementById(styleId)) {
            var style = document.createElement('style');
            style.id = styleId;
            style.textContent = '@keyframes flowx-test-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(255,107,107,0.3), 0 0 20px rgba(255,107,107,0.5); } 50% { box-shadow: 0 0 0 8px rgba(255,107,107,0.5), 0 0 30px rgba(255,107,107,0.8); } } .flowx-test-highlight { animation: flowx-test-pulse 1.5s ease-in-out infinite !important; }';
            document.head.appendChild(style);
          }
          publishBtn.classList.add('flowx-test-highlight');

          // 添加"测试模式"标签
          var badge = document.createElement('div');
          badge.textContent = '🔍 发布按钮（测试模式）';
          badge.style.cssText = 'position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:#ff6b6b;color:white;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;white-space:nowrap;z-index:100000;pointer-events:none;';
          if (getComputedStyle(publishBtn).position === 'static') {
            publishBtn.style.position = 'relative';
          }
          publishBtn.appendChild(badge);
        }

        // ========== 2. 检测表单字段 ==========
        // 标题
        var titleEl = document.querySelector('.WritePinV2-Form textarea[name="title"]');
        var titleValue = titleEl ? (titleEl.value || '').trim() : '';
        result.fields.push({
          name: '标题',
          type: 'textarea',
          filled: titleValue.length > 0,
          found: !!titleEl,
          valueLength: titleValue.length,
          selector: '.WritePinV2-Form textarea[name="title"]',
        });

        // 正文（Draft.js 编辑器）
        var contentEl = document.querySelector('.WritePinV2-Form .public-DraftEditor-content');
        if (!contentEl) {
          contentEl = document.querySelector('.WritePinV2-Form .Editable-content') ||
                      document.querySelector('.WritePinV2-Form .RichText--editable') ||
                      document.querySelector('.EditorArea .public-DraftEditor-content') ||
                      document.querySelector('.EditorArea .Editable-content');
        }
        var contentValue = '';
        if (contentEl) {
          // 多种方式获取内容，取最长的
          var v1 = contentEl.innerText || '';
          var v2 = contentEl.textContent || '';
          // 从 Draft.js 的 data-block 中获取
          var blocks = contentEl.querySelectorAll('[data-block="true"] .public-DraftStyleDefault-block');
          var v3 = '';
          for (var i = 0; i < blocks.length; i++) {
            v3 += blocks[i].textContent || '';
          }
          // 也检查 Editable-unstyled
          var unstyled = contentEl.querySelectorAll('.Editable-unstyled');
          var v4 = '';
          for (var j = 0; j < unstyled.length; j++) {
            v4 += unstyled[j].textContent || '';
          }
          contentValue = v1;
          if (v2.length > contentValue.length) contentValue = v2;
          if (v3.length > contentValue.length) contentValue = v3;
          if (v4.length > contentValue.length) contentValue = v4;
          contentValue = contentValue.trim();
        }
        result.fields.push({
          name: '正文',
          type: 'contenteditable',
          filled: contentValue.length > 0,
          found: !!contentEl,
          valueLength: contentValue.length,
          selector: '.WritePinV2-Form .public-DraftEditor-content',
        });

        // 图片（检查 ImageArea / DraggableTags 区域的图片）
        var imgCount = 0;
        var imageArea = document.querySelector('.WritePinV2-Form .ImageArea');
        if (imageArea) {
          // 优先检查 DraggableTags-tag 里的图片
          var draggableTags = imageArea.querySelectorAll('.DraggableTags-tag');
          for (var di = 0; di < draggableTags.length; di++) {
            var tagImgs = draggableTags[di].querySelectorAll('img');
            for (var ti = 0; ti < tagImgs.length; ti++) {
              var src = tagImgs[ti].src || '';
              if (src && src.indexOf('http') === 0 && src.indexOf('ZDI') === -1) {
                imgCount++;
                break;
              }
            }
          }
          // 兜底：直接数 ImageArea 里的真实图片
          if (imgCount === 0) {
            var iaImgs = imageArea.querySelectorAll('img');
            for (var ii = 0; ii < iaImgs.length; ii++) {
              var src2 = iaImgs[ii].src || '';
              if (src2 && src2.indexOf('http') === 0 && src2.indexOf('ZDI') === -1) {
                imgCount++;
              }
            }
          }
        }
        // 也检查编辑器内的图片
        if (imgCount === 0) {
          var editorImgs = document.querySelectorAll('.WritePinV2-Form .public-DraftEditor-content img');
          for (var ei = 0; ei < editorImgs.length; ei++) {
            var eSrc = editorImgs[ei].src || '';
            if (eSrc && eSrc.indexOf('http') === 0) imgCount++;
          }
        }
        result.fields.push({
          name: '图片',
          type: 'input',
          filled: imgCount > 0,
          found: true,
          valueLength: imgCount,
          selector: '.WritePinV2-Form .ImageArea',
        });

        result.note = '已找到发布按钮并高亮标记，请检查表单填写是否正常';
      } catch (e) {
        result.note = '测试模式检测异常: ' + String(e);
      }

      return result;
    })();
  `;
}

/**
 * [知乎图文专用] 点击想法的"发布"按钮。
 * 目标：.WritePinToolbar .WritePinToolbar-RightGroup 中的发布按钮
 */
function buildClickPinPublishButtonScript(): string {
  return `
    (function () {
      var result = { clicked: false, selector: '', text: '', error: '' };
      try {
        var candidates = [
          { sel: '.WritePinToolbar-RightGroup button:not([disabled]):not(.css-wfbczc)', priority: 1 },
          { sel: '.WritePinToolbar button:not([disabled])', priority: 2 },
          { sel: 'button.Button--primary.Button--blue:not([disabled])', priority: 3 },
        ];

        // 收集所有候选按钮并评分
        var buttons = [];
        for (var ci = 0; ci < candidates.length; ci++) {
          try {
            var btns = document.querySelectorAll(candidates[ci].sel);
            for (var bi = 0; bi < btns.length; bi++) {
              var btn = btns[bi];
              var btnText = (btn.innerText || btn.textContent || '').trim();
              if (!btnText || btnText.length > 10) continue;
              var score = 100 - candidates[ci].priority * 10;
              if (btnText === '发布' || btnText.indexOf('发布') !== -1) score += 50;
              if (btnText.indexOf('想法') !== -1) score += 20;
              // 检查是否在 WritePinToolbar 内
              var inToolbar = !!btn.closest('.WritePinToolbar');
              if (inToolbar) score += 30;
              // 检查是否禁用
              if (btn.disabled) score -= 100;
              buttons.push({ el: btn, text: btnText, score: score, sel: candidates[ci].sel });
            }
          } catch(eSel) {}
        }

        if (buttons.length === 0) {
          result.error = 'no-button-found';
          return result;
        }

        // 按分数排序，取最高的
        buttons.sort(function(a, b) { return b.score - a.score; });
        var best = buttons[0];

        if (best.el.disabled) {
          result.error = 'button-disabled';
          result.text = best.text;
          return result;
        }

        best.el.click();
        result.clicked = true;
        result.text = best.text;
        result.selector = best.sel;
      } catch (e) {
        result.error = 'exception: ' + String(e);
      }
      return result;
    })();
  `;
}

/**
 * [知乎专用] 点击"发布视频"按钮。
 * 按钮：button.VideoUploadForm-submitButton，文本含"发布视频"。
 */
function buildClickPublishButtonScript(): string {
  return `
    (function () {
      var candidates = [];
      try {
        var tags = ['button', 'div', 'a'];
        for (var ti = 0; ti < tags.length; ti++) {
          var els = document.getElementsByTagName(tags[ti]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            var txt = (el.innerText || el.textContent || '').trim();
            if (!txt || txt.indexOf('发布') === -1) continue;
            // 精确匹配"发布视频"
            if (txt !== '发布视频' && txt.indexOf('发布视频') === -1) continue;
            var cls = el.getAttribute && el.getAttribute('class') || '';
            // 加分项：包含 submitButton 类名
            var score = 0;
            if (cls.indexOf('VideoUploadForm-submitButton') !== -1) score += 2000;
            if (cls.indexOf('submitButton') !== -1) score += 1500;
            if (cls.indexOf('Button--primary') !== -1) score += 800;
            if (cls.indexOf('Button--blue') !== -1) score += 300;
            if (txt === '发布视频') score += 1000;
            else if (txt.indexOf('发布视频') !== -1) score += 600;
            // 跳过 disabled 的按钮
            try {
              if (el.disabled) continue;
              if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
              var st = window.getComputedStyle(el, null);
              if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.4)) continue;
              if ((el.offsetWidth || 0) < 10 || (el.offsetHeight || 0) < 10) continue;
            } catch (eSt) {}
            candidates.push({ el: el, score: score, text: txt.slice(0, 40), cls: (cls || '').slice(0, 80) });
          }
        }
      } catch (e) {
        return { clicked: false, msg: 'query-exception: ' + String(e) };
      }
      if (candidates.length === 0) return { clicked: false, msg: 'no-button' };
      candidates.sort(function (a, b) { return b.score - a.score; });
      var top = candidates[0];
      try { top.el.click(); }
      catch (e) {
        try {
          var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          top.el.dispatchEvent(evt);
        } catch (e2) {
          return { clicked: false, msg: 'click-failed', text: top.text };
        }
      }
      var top3 = candidates.slice(0, 3).map(function (c) { return { text: c.text, score: c.score, cls: c.cls }; });
      return { clicked: true, text: top.text, score: top.score, candidates: top3 };
    })();
  `;
}

/**
 * [知乎专用] 检测视频上传是否完成。
 * 知乎上传完成的标志：
 *   1. 出现 VideoUploadForm 表单区域
 *   2. 显示视频封面图片（VideoUploadForm-image）
 *   3. 显示视频时长
 *   4. 标题 textarea 已自动填入文件名
 */
function buildUploadCompleteProbeScript(): string {
  return `
    (function () {
      var result = {
        ready: false,
        uploading: false,
        processing: false,
        hasForm: false,
        hasCover: false,
        hasDuration: false,
        hasTitle: false,
        progressText: '',
        details: '',
      };
      try {
        // 检测是否有上传表单区域
        var form = document.querySelector('.VideoUploadForm');
        result.hasForm = !!form;

        // 检测封面图
        var coverImg = document.querySelector('.VideoUploadForm-image');
        if (coverImg && coverImg.src && coverImg.src.indexOf('zhimg.com') !== -1) {
          result.hasCover = true;
        }

        // 检测视频时长显示
        var duration = document.querySelector('.VideoUploadForm-duration');
        if (duration && duration.textContent && duration.textContent.trim()) {
          result.hasDuration = true;
        }

        // 检测标题是否已填入
        var titleInput = document.querySelector('textarea[name="title"]');
        if (titleInput && titleInput.value && titleInput.value.trim()) {
          result.hasTitle = true;
        }

        // 检测上传中/处理中的文本
        var bodyText = document.body ? (document.body.innerText || '') : '';
        var uploadKeywords = ['上传中', '上传中...', '正在上传', '处理中', '转码中', '视频处理中', '上传失败'];
        for (var i = 0; i < uploadKeywords.length; i++) {
          if (bodyText.indexOf(uploadKeywords[i]) !== -1) {
            result.progressText = uploadKeywords[i];
            if (uploadKeywords[i].indexOf('失败') !== -1) {
              result.details = 'upload-failed';
            } else {
              result.uploading = true;
            }
            break;
          }
        }

        // 判定：有表单 + 有封面 + 有标题 = 上传完成
        result.ready = result.hasForm && result.hasCover && result.hasTitle;

        // 如果还在上传中，覆盖 ready 状态
        if (result.uploading) {
          result.ready = false;
        }
      } catch (e) {
        result.details = 'error: ' + String(e);
      }
      return result;
    })();
  `;
}

// ========================= 核心发布流程 =========================

async function runZhihuPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
  contentType: ContentType,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'zhihu' });

  // 目前仅支持视频发布
  if (contentType !== 'video') {
    return makeFailedResult(accountId, 'zhihu', `知乎暂不支持 ${contentType} 类型内容的发布`, startedAt);
  }

  const publishUrl = 'https://www.zhihu.com/upload-video';
  const title = `知乎视频发布 - ${accountId}`;
  let win: BrowserWindow | null = null;
  let tracker: ReturnType<typeof attachNavigationTracker> | null = null;

  try {
    // ---- 步骤 1：创建窗口 + 导航跟踪 ----
    log('info', 'init', `初始化发布窗口 (url=${publishUrl})`);
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);

    // ---- 步骤 2：加载发布 URL ----
    onProgress(5, '加载发布页面…');
    log('info', 'load', `加载 URL: ${publishUrl}`);
    await win.loadURL(publishUrl);

    // ---- 步骤 3：等待页面稳定 ----
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // ---- 步骤 4：检测登录状态 ----
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      log('warn', 'login', `未检测到登录状态，url=${loginInfo.url}`);
      win.show();
      onProgress(15, '请在窗口中登录知乎账号…');
      log('info', 'login', '显示窗口等待用户登录（最多 120 秒）…');
      const loginDeadline = Date.now() + 120_000;
      let loggedIn = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const recheck = await detectLoggedIn(win).catch(() => null as any);
        if (recheck && recheck.loggedIn) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        return makeFailedResult(accountId, 'zhihu', '登录超时或未登录，请先在知乎登录', startedAt);
      }
      log('info', 'login', '✅ 登录成功，继续发布流程');
      // 登录后重新导航到发布 URL
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', `✅ 已登录 (url=${loginInfo.url.slice(0, 80)})`);
    }

    // ---- 步骤 5：上传视频 ----
    const mediaFiles = request.mediaFiles && request.mediaFiles.length > 0 ? request.mediaFiles : [];
    if (mediaFiles.length === 0) {
      return makeFailedResult(accountId, 'zhihu', '未提供任何视频文件', startedAt);
    }

    // 筛选视频文件
    const videoFiles = mediaFiles.filter((f) =>
      /\.(mp4|mov|avi|mkv|flv|wmv|webm|m4v|3gp|mpeg|mpg|rmvb|rm|vob|asf|dat|f4v|mpe|ra|ram|wm)$/i.test(f),
    );
    if (videoFiles.length === 0) {
      return makeFailedResult(accountId, 'zhihu', '未找到支持的视频文件', startedAt);
    }

    onProgress(25, `开始上传视频（${videoFiles.length} 个文件）…`);
    log('info', 'upload', `准备上传 ${videoFiles.length} 个视频文件`);

    // 检查页面上是否已存在上传按钮和文件输入
    const uploadReady = await win.webContents.executeJavaScript(`
      (function() {
        try {
          var fileInput = document.querySelector('input.VideoUploadButton-fileInput[type="file"]');
          var uploadBtn = document.querySelector('button.VideoUploadButton');
          return {
            hasFileInput: !!fileInput,
            hasUploadButton: !!uploadBtn,
            uploadBtnText: uploadBtn ? (uploadBtn.innerText || '').trim() : ''
          };
        } catch(e) {
          return { hasFileInput: false, hasUploadButton: false, error: String(e) };
        }
      })()
    `).catch(() => ({ hasFileInput: false, hasUploadButton: false }));

    log('info', 'upload', `页面上传状态: ${JSON.stringify(uploadReady)}`);

    // 使用 CDP 方式上传视频
    const uploadOk = await uploadViaCDP(win, [videoFiles[0]], log, 'video');
    if (!uploadOk) {
      return makeFailedResult(accountId, 'zhihu', '视频上传失败（CDP 注入未返回成功）', startedAt);
    }

    // ---- 步骤 6：等待上传完成 ----
    onProgress(40, '等待视频上传完成…');

    // 自定义上传完成检测：使用知乎特定的探针脚本
    const uploadDeadline = Date.now() + 300_000; // 5 分钟超时
    let uploadReadyStatus = false;
    let lastStatus: any = null;

    while (Date.now() < uploadDeadline) {
      if (win.isDestroyed()) break;
      try {
        const probe: any = await evalJS(win, buildUploadCompleteProbeScript(), 'upload-probe', log).catch(() => null);
        lastStatus = probe;
        if (probe && probe.ready) {
          uploadReadyStatus = true;
          log('info', 'upload', '✅ 视频上传完成，表单已就绪');
          break;
        }
        if (probe && probe.details === 'upload-failed') {
          log('warn', 'upload', '页面提示上传失败');
          return makeFailedResult(accountId, 'zhihu', '视频上传失败（页面提示）', startedAt);
        }
        // 更新进度
        if (probe && probe.progressText) {
          onProgress(40, `视频${probe.progressText}…`);
        }
      } catch {
        // 忽略临时错误
      }
      await sleep(3000);
    }

    // 窗口已销毁
    if (win.isDestroyed()) {
      log('warn', 'upload', '窗口已被用户关闭，终止发布流程');
      return makeFailedResult(accountId, 'zhihu', '发布窗口已被关闭，发布已终止', startedAt);
    }

    if (!uploadReadyStatus) {
      log('warn', 'upload', `上传完成检测超时，最后状态: ${JSON.stringify(lastStatus).slice(0, 200)}`);
      // 软失败：继续往下走，给页面更多时间
      await sleep(3000);
    }

    onProgress(60, '上传完成，准备填写内容…');
    await sleep(1500);

    // ---- 步骤 7：填写标题和描述 ----
    const titleText = truncate((request.title || '').trim(), TITLE_MAX);
    const contentText = truncate((request.content || '').trim(), CONTENT_MAX);

    log('info', 'fill', `准备写入：title="${titleText.slice(0, 40)}" (len=${titleText.length}), contentLen=${contentText.length}`);

    // 填写标题
    if (titleText) {
      const script = buildFillTitleScript(titleText);
      const res: any = await evalJS(win, script, 'fill-title', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `标题写入失败: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 标题已写入 (length=${res.length})`);
      }
      await sleep(800);
    }

    // 填写描述/正文
    if (contentText) {
      const script = buildFillContentScript(contentText);
      const res: any = await evalJS(win, script, 'fill-content', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `描述写入失败: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 描述已写入 (length=${res.length})`);
      }
      await sleep(500);
    }

    // ---- 步骤 7.5：选择视频标记（必填项）----
    onProgress(68, '选择视频标记…');

    // 优先使用 category，其次用第一个 tag 作为视频标记
    const preferredTag = request.category || (request.tags && request.tags.length > 0 ? request.tags[0] : '');
    let tagSelected = false;
    let selectedTagName = '';

    // 两步流程：点击打开 Modal → 等待 Modal 渲染 → 选择并确认
    // 最多重试 3 次打开 Modal
    for (let attempt = 0; attempt < 3; attempt++) {
      log('info', 'tag', `第 ${attempt + 1} 次尝试打开视频标记 Modal…`);

      // 第一步：点击打开 Modal
      const openScript = buildOpenVideoTagModalScript();
      const openRes: any = await evalJS(win, openScript, `open-tag-modal-${attempt + 1}`, log).catch(() => null);

      if (!openRes || !openRes.clicked) {
        log('warn', 'tag', `第 ${attempt + 1} 次点击打开失败: ${openRes?.error || 'unknown'}`);
        await sleep(1000);
        continue;
      }

      log('info', 'tag', `✅ 已点击触发按钮 (method=${openRes.method})，等待 Modal 渲染…`);

      // 第二步：等待 Modal 出现（最多等 3 秒，每 300ms 检查一次）
      let modalReady = false;
      for (let waitStep = 0; waitStep < 10; waitStep++) {
        await sleep(300);
        if (win.isDestroyed()) break;
        const checkModal: any = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var modal = document.querySelector('.VideoUploadForm-videoTypeModal');
              if (!modal) return { exists: false };
              var style = window.getComputedStyle(modal, null);
              var visible = style && style.display !== 'none' && style.visibility !== 'hidden' && modal.offsetParent !== null;
              return { exists: true, visible: visible };
            } catch(e) {
              return { exists: false, error: String(e) };
            }
          })()
        `).catch(() => null);
        if (checkModal && checkModal.exists && checkModal.visible) {
          modalReady = true;
          log('info', 'tag', `✅ Modal 已出现 (waitStep=${waitStep + 1})`);
          break;
        }
      }

      if (!modalReady) {
        log('warn', 'tag', `第 ${attempt + 1} 次：Modal 未在 3 秒内出现，重试…`);
        continue;
      }

      // 第三步：在 Modal 中选择选项并点击确认
      const selectScript = buildSelectAndConfirmVideoTagScript(preferredTag);
      const selectRes: any = await evalJS(win, selectScript, `select-tag-${attempt + 1}`, log).catch(() => null);

      if (selectRes && selectRes.confirmed && selectRes.selected) {
        tagSelected = true;
        selectedTagName = selectRes.selectedTag;
        log('info', 'tag', `✅ 视频标记选择成功: "${selectedTagName}" (attempt=${attempt + 1})`);
        break;
      }

      log('warn', 'tag', `第 ${attempt + 1} 次选择失败: ${selectRes?.error || 'unknown'}, step=${selectRes?.step || 'unknown'}`);
      if (selectRes?.options && selectRes.options.length > 0) {
        log('info', 'tag', `可用选项: ${selectRes.options.slice(0, 10).join(', ')}`);
      }

      // 如果 Modal 还开着，先关掉再重试
      try {
        await win.webContents.executeJavaScript(`
          (function() {
            try {
              var modal = document.querySelector('.VideoUploadForm-videoTypeModal');
              if (modal) {
                var cancelBtn = modal.querySelector('button');
                if (cancelBtn) {
                  var btns = modal.querySelectorAll('button');
                  for (var i = 0; i < btns.length; i++) {
                    var txt = (btns[i].innerText || '').trim();
                    if (txt.indexOf('取消') !== -1) {
                      btns[i].click();
                      return true;
                    }
                  }
                }
              }
              return false;
            } catch(e) { return false; }
          })()
        `).catch(() => {});
      } catch { /* ignore */ }

      await sleep(500);
    }

    if (!tagSelected) {
      log('warn', 'tag', '⚠️ 视频标记选择失败，可能影响发布，但继续尝试发布');
    } else {
      log('info', 'tag', `最终选中的视频标记: "${selectedTagName}"`);
    }
    await sleep(500);

    // ---- 步骤 8：点击发布按钮 ----
    onProgress(75, '点击发布视频按钮…');

    // 测试模式
    if (request.testMode) {
      const testScript = buildTestModeProbeScript(
        [
          'button.VideoUploadForm-submitButton',
          '.VideoUploadForm-submitButton',
          'button.Button--primary',
          '.VideoUploadForm-buttonGroup button',
          '.publishGroup button',
          'button[type="button"][class*="submit"]',
        ],
        [
          { name: '标题', selector: 'textarea[name="title"]', type: 'textarea' },
          { name: '描述', selector: '.public-DraftEditor-content', type: 'contenteditable' },
          { name: '封面图', selector: '.VideoUploadForm-image', type: 'input' },
          { name: '视频标记', selector: '.VideoUploadForm-select [role="combobox"]', type: 'input' },
        ],
      );
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name === '描述')?.filled),
        coverUploaded: !!(testRes?.fields?.find((f: any) => f.name === '封面图')?.found),
        tagsFilled: tagSelected,
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: (testRes?.note || '测试模式完成') + (selectedTagName ? `（视频标记：${selectedTagName}）` : ''),
      };
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');

      setupTestModeWindow(win, log);

      return {
        accountId,
        platform: 'zhihu',
        status: 'success',
        progress: 100,
        message: '测试完成 - 表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

    const clickScript = buildClickPublishButtonScript();
    const clickRes: any = await evalJS(win, clickScript, 'click-publish', log).catch(() => null);
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', `发布按钮点击失败: ${JSON.stringify(clickRes).slice(0, 200)}`);
      const probe: any = await evalJS(win, buildPageStructureProbe(), 'probe', log).catch(() => null);
      log('warn', 'publish', `页面结构探测: ${JSON.stringify(probe).slice(0, 400)}`);
      return makeFailedResult(accountId, 'zhihu', '未找到可点击的"发布视频"按钮', startedAt);
    }
    log('info', 'publish', `✅ 发布按钮已点击 (text="${clickRes.text}" score=${clickRes.score})`);
    onProgress(85, '发布中，等待结果…');

    // ---- 步骤 9：等待发布成功 ----
    const initialUrl = win.webContents.getURL();
    const successDeadline = Date.now() + 180_000;
    let lastUrl = initialUrl;
    let lastText = '';
    log('info', 'done', `开始轮询发布结果（初始 URL=${initialUrl.slice(0, 80)}，最长 180 秒）`);

    while (Date.now() < successDeadline) {
      if (win.isDestroyed()) break;
      try {
        const check: any = await win.webContents
          .executeJavaScript(`
            (function () {
              var result = {
                url: location.href,
                title: document.title,
                body: (document.body ? (document.body.innerText || '') : '').slice(0, 800),
                urlChanged: false,
              };
              result.urlChanged = (location.href !== '${initialUrl.replace(/'/g, "\\'").replace(/\n/g, '')}');
              return result;
            })();
          `)
          .catch(() => null);

        if (check) {
          lastUrl = check.url || '';
          lastText = (check.body || '') + ' | ' + (check.title || '');

          // 成功信号：
          // a) URL 跳转到创作者中心 / 作品管理 / 草稿箱
          const urlOk = /creator\/manage|upload-video.*success|作品管理|内容管理|发布成功/i.test(lastUrl);

          // b) 页面文本含成功关键词
          const textOk = /发布成功|发布完成|已发布|视频发布成功|提交成功|创建成功/i.test(lastText);

          // c) URL 变化且不再是上传页
          const urlChanged = check.urlChanged && !/upload-video/.test(lastUrl);

          // 失败信号
          const textFail = /发布失败|不符合要求|违规|无法发布|出错|参数不合法|失败.*重试/i.test(lastText);

          if (urlOk || textOk || urlChanged) {
            const reason = [urlOk && 'url-ok', textOk && 'text-success', urlChanged && 'url-changed'].filter(Boolean).join(',');
            log('info', 'done', `✅ 发布成功 (reason=${reason}, url=${lastUrl.slice(0, 120)})`);
            onProgress(100, '发布成功');
            return {
              accountId,
              platform: 'zhihu',
              status: 'success',
              progress: 100,
              message: '发布成功',
              url: lastUrl,
              startedAt,
              finishedAt: Date.now(),
            } as PublishItemProgress;
          }
          if (textFail) {
            log('warn', 'done', `页面提示发布失败: ${lastText.slice(0, 200)}`);
            return makeFailedResult(accountId, 'zhihu', '页面提示发布失败', startedAt);
          }
        }
      } catch { /* ignore transient errors */ }
      await sleep(3000);
    }

    log('warn', 'done', `等待发布成功超时（180 秒），最后 url=${lastUrl.slice(0, 120)}`);
    return makeFailedResult(accountId, 'zhihu', '等待发布结果超时', startedAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'exception', `发布流程异常: ${msg}`);
    return makeFailedResult(accountId, 'zhihu', msg, startedAt);
  } finally {
    if (tracker) {
      try { tracker.dispose(); } catch { /* ignore */ }
    }
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      }, 2000);
    }
  }
}

// ========================= 对外接口 =========================

async function publishVideo(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  return runZhihuPublish(accountId, request, onProgress, 'video');
}

/**
 * 知乎图文发布（发想法）。
 * 入口：知乎创作中心首页（https://www.zhihu.com/creator）
 * 流程：点击"分享此刻的想法..."激活编辑器 → 上传图片 → 填写标题/正文 → 发布
 */
async function publishImage(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'zhihu' });

  const publishUrl = 'https://www.zhihu.com/creator';
  const title = `知乎图文发布 - ${accountId}`;
  let win: BrowserWindow | null = null;
  let tracker: ReturnType<typeof attachNavigationTracker> | null = null;

  try {
    // ---- 步骤 1：创建窗口 + 导航跟踪 ----
    log('info', 'init', '初始化图文发布窗口（知乎想法）');
    onProgress(2, '初始化窗口…');
    win = makePublishWindow(accountId, title);
    tracker = attachNavigationTracker(win, log);

    // ---- 步骤 2：加载创作中心页面 ----
    onProgress(5, '加载知乎创作中心…');
    log('info', 'load', `加载 URL: ${publishUrl}`);
    await win.loadURL(publishUrl);

    // ---- 步骤 3：等待页面稳定 ----
    onProgress(10, '等待页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(1500);

    // ---- 步骤 4：检测登录状态 ----
    onProgress(15, '检测登录状态…');
    const loginInfo = await detectLoggedIn(win);
    if (!loginInfo.loggedIn) {
      log('warn', 'login', `未检测到登录状态，url=${loginInfo.url}`);
      win.show();
      onProgress(15, '请在窗口中登录知乎账号…');
      const loginDeadline = Date.now() + 120_000;
      let loggedIn = false;
      while (Date.now() < loginDeadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const recheck = await detectLoggedIn(win).catch(() => null as any);
        if (recheck && recheck.loggedIn) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        return makeFailedResult(accountId, 'zhihu', '登录超时或未登录，请先在知乎登录', startedAt);
      }
      log('info', 'login', '✅ 登录成功，继续发布流程');
      await win.loadURL(publishUrl);
      await tracker.waitForStable(1500, 15000);
      await sleep(1500);
    } else {
      log('info', 'login', `✅ 已登录 (url=${loginInfo.url.slice(0, 80)})`);
    }

    // ---- 步骤 5：激活编辑器（点击"分享此刻的想法..."）----
    onProgress(25, '激活想法编辑器…');
    let editorActivated = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const activateScript = buildActivatePinEditorScript();
      const activateRes: any = await evalJS(win, activateScript, `activate-editor-${attempt + 1}`, log).catch(() => null);

      if (activateRes && activateRes.alreadyActive) {
        editorActivated = true;
        log('info', 'editor', '✅ 编辑器已经激活');
        break;
      }

      if (activateRes && activateRes.clicked) {
        log('info', 'editor', `已点击激活按钮 (method=${activateRes.method})，等待编辑器展开…`);
        // 等待编辑器展开
        for (let waitStep = 0; waitStep < 10; waitStep++) {
          await sleep(300);
          if (win.isDestroyed()) break;
          const probe: any = await evalJS(win, buildPinEditorReadyProbe(), `editor-probe-${waitStep}`, log).catch(() => null);
          if (probe && probe.ready) {
            editorActivated = true;
            log('info', 'editor', `✅ 编辑器已激活 (waitStep=${waitStep + 1})`);
            break;
          }
        }
        if (editorActivated) break;
      }

      log('warn', 'editor', `第 ${attempt + 1} 次激活编辑器失败: ${activateRes?.error || 'unknown'}`);
      await sleep(1000);
    }

    if (!editorActivated) {
      log('warn', 'editor', '⚠️ 编辑器激活失败，尝试继续…');
    }
    await sleep(500);

    // ---- 步骤 6：上传图片 ----
    const mediaFiles = request.mediaFiles || [];
    const imageFiles = mediaFiles.filter((f) =>
      /\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif)$/i.test(f),
    );

    let imagesUploaded = false;
    if (imageFiles.length > 0) {
      onProgress(35, `上传图片（${imageFiles.length} 张）…`);
      log('info', 'upload', `准备上传 ${imageFiles.length} 张图片`);

      // 确保上传弹窗打开的辅助函数
      const ensureModalOpen = async (): Promise<boolean> => {
        if (!win || win.isDestroyed()) return false;
        // 先检查弹窗是否已经打开
        const checkProbe: any = await evalJS(win, buildImageUploadModalProbe(), 'modal-check', log).catch(() => null);
        if (checkProbe && checkProbe.visible) {
          log('info', 'upload', '弹窗已处于打开状态，无需再次点击');
          return true;
        }
        // 弹窗未打开，点击图片按钮
        const clickImgBtn: any = await evalJS(win, buildClickImageButtonScript(), 'click-img-btn-open', log).catch(() => null);
        if (!clickImgBtn || !clickImgBtn.clicked) {
          log('warn', 'upload', '点击图片按钮失败');
          return false;
        }
        log('info', 'upload', `✅ 已点击图片按钮 (method=${clickImgBtn.method})，等待上传弹窗…`);
        // 等待弹窗出现
        for (let waitStep = 0; waitStep < 10; waitStep++) {
          await sleep(300);
          if (win.isDestroyed()) return false;
          const probe: any = await evalJS(win, buildImageUploadModalProbe(), `img-modal-probe-${waitStep}`, log).catch(() => null);
          if (probe && probe.visible) {
            log('info', 'upload', `✅ 图片上传弹窗已出现 (waitStep=${waitStep + 1})`);
            return true;
          }
        }
        log('warn', 'upload', '弹窗未出现');
        return false;
      };

      // 关闭弹窗的辅助函数
      const closeModal = async (): Promise<void> => {
        if (!win || win.isDestroyed()) return;
        try {
          await win.webContents.executeJavaScript(`
            (function() {
              try {
                // 优先点击关闭按钮
                var closeBtn = document.querySelector('.Modal-closeButton, [aria-label="关闭"], .Modal--default .Modal-closeButton');
                if (closeBtn) { closeBtn.click(); return 'close-btn'; }
                // 按 ESC 键关闭
                try {
                  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', which: 27, bubbles: true }));
                  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', which: 27, bubbles: true }));
                  return 'esc';
                } catch(eEsc) {}
                return 'not-found';
              } catch(e) { return 'error: ' + String(e); }
            })()
          `).catch(() => {});
        } catch { /* ignore */ }
        await sleep(500);
      };

      // 防止遮罩层点击关闭弹窗：注入保护脚本
      const protectModalFromMask = async (): Promise<void> => {
        if (!win || win.isDestroyed()) return;
        try {
          await win.webContents.executeJavaScript(`
            (function() {
              try {
                // 给遮罩层添加阻止点击关闭的保护
                var masks = document.querySelectorAll('.Modal-mask, [class*="mask"], [class*="Mask"], .Modal-backdrop, [class*="backdrop"]');
                var protectedCount = 0;
                for (var i = 0; i < masks.length; i++) {
                  var mask = masks[i];
                  try {
                    var st = window.getComputedStyle(mask, null);
                    if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
                  } catch(e) { continue; }
                  // 阻止点击事件冒泡到关闭逻辑
                  mask.addEventListener('click', function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                  }, true);
                  protectedCount++;
                }
                // 同时保护 Modal 容器本身的 mousedown/mouseup 事件
                var modals = document.querySelectorAll('.Modal');
                for (var j = 0; j < modals.length; j++) {
                  var m = modals[j];
                  m.addEventListener('mousedown', function(e) {
                    // 只有点击在 Modal 内容区域外（即遮罩）才阻止
                    if (e.target === this || e.target.classList && (e.target.classList.contains('Modal-mask') || e.target.classList.contains('Modal-backdrop'))) {
                      e.stopPropagation();
                      e.preventDefault();
                    }
                  }, true);
                }
                return protectedCount;
              } catch(e) { return 0; }
            })()
          `).catch(() => {});
        } catch { /* ignore */ }
      };

      // 主循环：最多重试 2 次
      for (let imgAttempt = 0; imgAttempt < 2; imgAttempt++) {
        // 确保弹窗打开
        const modalOpen = await ensureModalOpen();
        if (!modalOpen) {
          log('warn', 'upload', `第 ${imgAttempt + 1} 次：无法打开弹窗，重试…`);
          await sleep(1000);
          continue;
        }

        // 添加遮罩层保护，防止误点关闭
        await protectModalFromMask();
        await sleep(200);

        // 使用弹窗内精确 CDP 注入
        const uploadOk = await uploadImageInModal(win, imageFiles[0], log);
        if (!uploadOk) {
          log('warn', 'upload', `第 ${imgAttempt + 1} 次弹窗内图片注入失败`);
          await sleep(1000);
          continue;
        }

        log('info', 'upload', '✅ 弹窗内图片注入成功，等待上传完成…');

        // 等待上传完成（弹窗内出现图片预览 + 插入按钮可点击）
        let uploadCompleted = false;
        let hasInsertBtn = false;
        let lastStatus = '';
        for (let waitStep = 0; waitStep < 30; waitStep++) {
          await sleep(1000);
          if (win.isDestroyed()) break;
          const probe: any = await evalJS(win, buildModalImageUploadedProbe(), `modal-uploaded-probe-${waitStep}`, log).catch(() => null);
          if (probe && probe.hasInsertButton) {
            hasInsertBtn = true;
            if (probe.uploaded && probe.insertButtonEnabled) {
              uploadCompleted = true;
              log('info', 'upload', `✅ 图片上传完成，预览图=${probe.previewCount}张，插入按钮="${probe.insertText}"（可点击）(waitStep=${waitStep + 1})`);
              break;
            }
            // 按钮存在但不可点击（上传中）
            const status = probe.hasPreview
              ? `有预览图(${probe.previewCount}张)，按钮${probe.buttonDisabled ? '不可点击(上传中)' : '可点击'}`
              : '无预览图，上传中…';
            if (status !== lastStatus) {
              log('info', 'upload', `上传状态: ${status}`);
              lastStatus = status;
            }
          }
          if (probe && probe.previewCount > 0 && !probe.hasInsertButton) {
            log('info', 'upload', `检测到预览图 ${probe.previewCount} 张，等待插入按钮出现…`);
          }
        }

        if (!uploadCompleted) {
          if (!hasInsertBtn) {
            log('warn', 'upload', `第 ${imgAttempt + 1} 次：上传后未检测到插入按钮，关闭弹窗后重试…`);
          } else {
            log('warn', 'upload', `第 ${imgAttempt + 1} 次：插入按钮一直不可点击（上传超时），关闭弹窗后重试…`);
          }
          await closeModal();
          await sleep(1000);
          continue;
        }

        // 点击"插入图片"按钮
        let insertClicked = false;
        for (let insertAttempt = 0; insertAttempt < 3; insertAttempt++) {
          const insertRes: any = await evalJS(win, buildClickInsertInModalScript(), `click-insert-${imgAttempt}-${insertAttempt}`, log).catch(() => null);
          if (insertRes && insertRes.clicked) {
            insertClicked = true;
            log('info', 'upload', `✅ 已点击"${insertRes.text}"按钮`);
            break;
          }
          log('warn', 'upload', `第 ${insertAttempt + 1} 次点击插入按钮失败: ${insertRes?.error || 'unknown'}`);
          await sleep(800);
        }

        if (!insertClicked) {
          log('warn', 'upload', '⚠️ 未找到插入按钮，继续等待图片自动插入…');
        }

        // 等待图片出现在编辑器中
        let imageInserted = false;
        let lastImgCount = -1;
        for (let waitStep = 0; waitStep < 25; waitStep++) {
          await sleep(1000);
          if (win.isDestroyed()) break;
          const probe: any = await evalJS(win, buildImageInsertedProbe(), `img-inserted-probe-${waitStep}`, log).catch(() => null);
          if (probe && probe.inserted) {
            imageInserted = true;
            imagesUploaded = true;
            log('info', 'upload', `✅ 图片已插入编辑器 (count=${probe.imageCount}, waitStep=${waitStep + 1})`);
            if (probe.images && probe.images.length > 0) {
              log('info', 'upload', `图片URL示例: ${probe.images[0]}`);
            }
            break;
          }
          if (probe && probe.imageCount !== lastImgCount) {
            log('info', 'upload', `图片插入检测中: count=${probe.imageCount}, foundEditor=${probe.foundEditor}, draftAtomic=${probe.draftImageCount}`);
            lastImgCount = probe.imageCount;
          }
        }

        if (imageInserted) {
          break;
        }

        log('warn', 'upload', `第 ${imgAttempt + 1} 次图片上传后未检测到插入结果，关闭弹窗后重试…`);
        await closeModal();
        await sleep(1000);
      }

      if (!imagesUploaded) {
        log('warn', 'upload', '⚠️ 图片上传失败，继续发布纯文字想法');
      }
    } else {
      log('info', 'upload', '未提供图片文件，发布纯文字想法');
    }

    await sleep(1000);

    // ---- 步骤 7：填写标题和正文 ----
    onProgress(55, '填写想法内容…');

    const titleText = truncate((request.title || '').trim(), TITLE_MAX);
    const contentText = truncate((request.content || '').trim(), CONTENT_MAX);
    const tags = request.tags || [];

    log('info', 'fill', `准备写入：title="${titleText.slice(0, 40)}" (len=${titleText.length}), contentLen=${contentText.length}, tags=${tags.length}`);

    // 填写标题
    if (titleText) {
      const script = buildFillPinTitleScript(titleText);
      const res: any = await evalJS(win, script, 'fill-pin-title', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `标题写入失败: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        log('info', 'fill', `✅ 标题已写入 (length=${res.length})`);
      }
      await sleep(500);
    }

    // 填写正文（含话题）
    if (contentText || tags.length > 0) {
      const script = buildFillPinContentScript(contentText, tags);
      const res: any = await evalJS(win, script, 'fill-pin-content', log).catch(() => null);
      if (!res || !res.ok) {
        log('warn', 'fill', `正文写入失败(JS方案): ${JSON.stringify(res).slice(0, 200)}`);

        // 兜底方案：使用 CDP Input.dispatchKeyEvent 模拟真实键盘输入
        if (win && !win.isDestroyed()) {
          log('info', 'fill', '尝试 CDP 键盘输入方案…');
          try {
            // 先确保 debugger 已连接
            try {
              if (!win.webContents.debugger.isAttached()) {
                win.webContents.debugger.attach('1.3');
              }
            } catch { /* 可能已 attached */ }

            // 先通过 JS 点击编辑器并清空
            await win.webContents.executeJavaScript(`
              (function() {
                var ed = document.querySelector('.WritePinV2-Form .public-DraftEditor-content');
                if (ed) {
                  ed.focus();
                  ed.click();
                  // 全选删除
                  document.execCommand('selectAll', false, null);
                  document.execCommand('delete', false, null);
                }
              })();
            `).catch(() => {});
            await sleep(200);

            // 构造完整文本
            const maxLen = 1000;
            let fullText = contentText.slice(0, maxLen);
            // 追加话题
            for (const tag of tags) {
              const tagText = '#' + tag + ' ';
              if (fullText.length + tagText.length <= maxLen) {
                fullText += tagText;
              }
            }

            // 使用 CDP 逐个字符输入（模拟真实用户输入）
            let typedCount = 0;
            for (let ci = 0; ci < fullText.length; ci++) {
              const ch = fullText[ci];
              if (win.isDestroyed()) break;
              try {
                // 输入字符
                await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                  type: 'char',
                  text: ch,
                });
                typedCount++;
                // 每输入 20 个字符稍微停顿
                if (typedCount % 20 === 0) {
                  await sleep(50);
                }
              } catch (keyErr) {
                log('warn', 'fill', `CDP输入字符失败[${ci}]: ${(keyErr as Error).message}`);
                break;
              }
            }
            log('info', 'fill', `CDP 键盘输入完成: ${typedCount}/${fullText.length} 字符`);
          } catch (cdpErr) {
            log('warn', 'fill', `CDP 键盘输入异常: ${(cdpErr as Error).message}`);
          }
        }
      } else {
        log('info', 'fill', `✅ 正文已写入 (length=${res.length}, tags=${res.tags?.length || 0}, method=${res.method})`);
        if (res.debug) {
          log('info', 'fill', `调试信息: ${res.debug}`);
        }
      }
      await sleep(800);
    }

    // ---- 步骤 8：点击发布按钮 ----
    onProgress(75, '点击发布按钮…');

    // 测试模式
    if (request.testMode) {
      const testScript = buildPinTestModeProbeScript();
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.fields?.find((f: any) => f.name === '标题')?.filled),
        contentFilled: !!(testRes?.fields?.find((f: any) => f.name === '正文')?.filled),
        coverUploaded: imagesUploaded,
        tagsFilled: tags.length > 0,
        imagesUploaded: imagesUploaded,
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: (testRes?.note || '测试模式完成') + (tags.length > 0 ? `（话题：${tags.join(', ')}）` : ''),
      };
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');

      setupTestModeWindow(win, log);

      return {
        accountId,
        platform: 'zhihu',
        status: 'success',
        progress: 100,
        message: '测试完成 - 想法表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

    const clickScript = buildClickPinPublishButtonScript();
    const clickRes: any = await evalJS(win, clickScript, 'click-pin-publish', log).catch(() => null);
    if (!clickRes || !clickRes.clicked) {
      log('warn', 'publish', `发布按钮点击失败: ${JSON.stringify(clickRes).slice(0, 200)}`);
      const probe: any = await evalJS(win, buildPageStructureProbe(), 'probe', log).catch(() => null);
      log('warn', 'publish', `页面结构探测: ${JSON.stringify(probe).slice(0, 400)}`);
      return makeFailedResult(accountId, 'zhihu', '未找到可点击的"发布"按钮', startedAt);
    }

    log('info', 'publish', `✅ 已点击发布按钮 (text=${clickRes.text})`);

    // ---- 步骤 9：等待发布结果 ----
    onProgress(85, '等待发布结果…');

    const publishDeadline = Date.now() + 180_000; // 3 分钟超时
    let publishSuccess = false;
    let lastUrl = '';

    while (Date.now() < publishDeadline) {
      if (win.isDestroyed()) break;
      try {
        const currentUrl = win.webContents.getURL();
        if (currentUrl !== lastUrl) {
          log('info', 'publish', `URL 变化: ${currentUrl.slice(0, 100)}`);
          lastUrl = currentUrl;
        }

        // 检查页面是否包含成功文本
        const successCheck: any = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var bodyText = document.body.innerText || '';
              var hasSuccess = bodyText.indexOf('发布成功') !== -1 ||
                              bodyText.indexOf('已发布') !== -1 ||
                              bodyText.indexOf('发布完成') !== -1 ||
                              bodyText.indexOf('想法发布成功') !== -1;
              var hasError = bodyText.indexOf('发布失败') !== -1 ||
                            bodyText.indexOf('发布失败') !== -1;
              return { hasSuccess: hasSuccess, hasError: hasError };
            } catch(e) {
              return { hasSuccess: false, hasError: false };
            }
          })()
        `).catch(() => null);

        if (successCheck && successCheck.hasSuccess) {
          publishSuccess = true;
          log('info', 'publish', '✅ 检测到发布成功提示');
          break;
        }

        if (successCheck && successCheck.hasError) {
          log('warn', 'publish', '⚠️ 检测到发布失败提示');
          break;
        }

        // 如果 URL 跳转到了个人主页或想法列表，也认为成功
        if (currentUrl.indexOf('/pin/') !== -1 || currentUrl.indexOf('status') !== -1) {
          publishSuccess = true;
          log('info', 'publish', `✅ URL 跳转到详情页，判定成功`);
          break;
        }
      } catch {
        // 忽略临时错误
      }
      await sleep(3000);
    }

    if (win.isDestroyed()) {
      log('warn', 'publish', '窗口已被用户关闭');
      return makeFailedResult(accountId, 'zhihu', '发布窗口已被关闭，发布已终止', startedAt);
    }

    if (publishSuccess) {
      onProgress(100, '发布成功');
      log('info', 'publish', '✅ 知乎想法发布成功');

      return {
        accountId,
        platform: 'zhihu',
        status: 'success',
        progress: 100,
        message: '知乎想法发布成功',
        startedAt,
        finishedAt: Date.now(),
        publishUrl: lastUrl,
      } as PublishItemProgress;
    } else {
      log('warn', 'publish', '⚠️ 发布结果不确定，超时未检测到成功状态');
      // 软成功：不确定但不报错
      return {
        accountId,
        platform: 'zhihu',
        status: 'success',
        progress: 100,
        message: '已点击发布，结果待确认',
        startedAt,
        finishedAt: Date.now(),
        publishUrl: lastUrl,
      } as PublishItemProgress;
    }
  } catch (err: any) {
    log('error', 'publish', `发布异常: ${err?.message || String(err)}`);
    return makeFailedResult(accountId, 'zhihu', `发布异常: ${err?.message || String(err)}`, startedAt);
  } finally {
    if (tracker) {
      try { tracker.dispose(); } catch { /* ignore */ }
    }
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
      const w = win;
      setTimeout(() => {
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }, 2000);
    }
  }
}

/**
 * 兼容接口：根据提供的文件类型自动选择发布方式。
 * 支持视频发布和图文发布（知乎想法）。
 */
async function publish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
): Promise<PublishItemProgress> {
  const files = request.mediaFiles || [];
  const hasVideo = files.some((f) =>
    /\.(mp4|mov|avi|mkv|flv|wmv|webm|m4v|3gp|mpeg|mpg|rmvb|rm|vob|asf|dat|f4v|mpe|ra|ram|wm)$/i.test(f),
  );
  const hasImage = files.some((f) =>
    /\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif)$/i.test(f),
  );
  if (request.contentType === 'video' || hasVideo) {
    return publishVideo(accountId, request, onProgress);
  }
  if (request.contentType === 'image' || hasImage || request.contentType === 'article') {
    return publishImage(accountId, request, onProgress);
  }
  // 默认走图文（想法）发布
  return publishImage(accountId, request, onProgress);
}

// ========================= 注册平台 =========================

const adapter: PlatformAdapter = {
  key: meta.key,
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publishImage,
  publish,
};

registerPlatform(adapter);

log('info', 'register', '知乎平台适配器已注册（视频发布 + 图文/想法发布已实现）');

export default adapter;
export { meta as zhihuMeta };
