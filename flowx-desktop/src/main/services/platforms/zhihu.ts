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
} from '../../../types';

/**
 * 知乎平台适配器
 *
 * 平台信息：
 *   - 创作者中心：https://www.zhihu.com/creator
 *   - 登录页：https://www.zhihu.com/signin
 *   - 登录态标识：cookie `z_c0` 存在且非空即为已登录
 *   - 视频发布页：https://www.zhihu.com/upload-video
 *
 * 页面结构要点：
 *   - 上传按钮：button.VideoUploadButton，文本"上传视频"
 *   - 文件输入：input.VideoUploadButton-fileInput[type="file"]
 *   - 标题输入：textarea[name="title"]，placeholder="标题"，上限 50 字符
 *   - 描述编辑器：contenteditable 的 DraftEditor，placeholder="分享你此刻的想法..."，上限 1000 字符
 *   - 发布按钮：button.VideoUploadForm-submitButton，文本"发布视频"
 *   - 视频标记（必选）：选择标记下拉框
 *   - 原创视频：默认勾选
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
    publishImage: false, // TODO: 待实现
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
 * 兼容接口：根据提供的文件类型自动选择发布方式。
 * 目前仅实现视频发布，图文和文章待实现。
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
  if (request.contentType === 'video' || hasVideo) {
    return publishVideo(accountId, request, onProgress);
  }
  return makeFailedResult(accountId, 'zhihu', `知乎暂不支持 ${request.contentType || '该'} 类型内容的发布`);
}

// ========================= 注册平台 =========================

const adapter: PlatformAdapter = {
  key: meta.key,
  meta,
  capabilities: meta.capabilities,
  detectLoggedIn,
  extractPageInfo,
  publishVideo,
  publish,
};

registerPlatform(adapter);

log('info', 'register', '知乎平台适配器已注册（视频发布已实现）');

export default adapter;
export { meta as zhihuMeta };
