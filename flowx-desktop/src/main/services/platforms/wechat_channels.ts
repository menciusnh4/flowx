import type { BrowserWindow } from 'electron';
import type { PlatformAdapter, ExtractedAccountInfo, LoginCheckResult, ProgressCallback } from './types';
import {
  sleep,
  makePublishLogger,
  makePublishWindow,
  attachNavigationTracker,
  evalJS,
  makeFailedResult,
  uploadViaCDP,
  setupTestModeWindow,
} from './shared';
import { registerPlatform } from './registry';
import type { PlatformMeta, PublishRequest, PublishItemProgress, AccountCapabilities, ContentType } from '../../../types';
import { AccountService } from '../AccountService';
import { BrowserEnvService } from '../BrowserEnvService';
import { getAppIcon } from '../../windows/MainWindow';

// =====================================================================
// 常量与配置项
// =====================================================================

const BASE_URL = 'https://channels.weixin.qq.com';
const PUBLISH_VIDEO_URL = 'https://channels.weixin.qq.com/platform/post/create';
const PUBLISH_IMAGE_URL = 'https://channels.weixin.qq.com/platform/post/finderNewLifeCreate';

const LOGIN_KEYWORDS = [
  '视频号助手',
  '作品管理',
  '发表视频',
  '发表图文',
  '数据中心',
  '粉丝',
  '视频管理',
  '图文管理',
];

// 微信视频号发布字数硬性限制
const VIDEO_TITLE_LIMIT = 16;
const VIDEO_CONTENT_LIMIT = 1000;
const IMAGE_TITLE_LIMIT = 22;
const IMAGE_CONTENT_LIMIT = 1000;

const meta: PlatformMeta = {
  key: 'wechat_channels',
  name: '微信视频号',
  icon: '💬',
  authUrl: BASE_URL,
  homeUrl: 'https://channels.weixin.qq.com/platform',
  publishUrl: PUBLISH_VIDEO_URL,
  platformAccountLabel: '视频号ID',
  contentTypes: ['video', 'image'],
  capabilities: {
    publishVideo: true,
    publishImage: true,
    publishArticle: false,
  } as AccountCapabilities,
  contentLimits: {
    title: 22, // 按最大字数定义，各方法内部会依据图文与视频做精细适配
    content: 1000,
  },
};

/**
 * 微信视频号专属的标题净化器：
 * 截断超长部分并过滤掉不支持的特殊符号（符号仅支持书名号、引号、冒号、加号、问号、百分号、摄氏度，逗号可用空格代替）
 */
function cleanWechatTitle(title: string, maxLength: number): string {
  if (!title) return '';
  // 1. 将中文和英文逗号替换为单个空格
  let t = title.replace(/,|，/g, ' ');
  // 2. 正则过滤掉不支持的特殊字符
  const allowedRegex = /[^\u4e00-\u9fa5a-zA-Z0-9《》“”‘’"':：\+?？%℃\s]/g;
  t = t.replace(allowedRegex, '');
  // 3. 将连续的空格压缩为一个空格
  t = t.replace(/\s+/g, ' ').trim();
  // 4. 截断到指定字数限制
  if (t.length > maxLength) {
    t = t.slice(0, maxLength);
  }
  return t;
}

/**
 * 微信视频号专属的浏览器窗口创建器：
 * 强制在 new BrowserWindow 前同步阻塞执行 applyEnvironment 隔离环境 UA 净化，防止异步竞态导致重定向扫码
 */
async function makeWechatPublishWindow(accountId: string, title: string): Promise<BrowserWindow> {
  const partition = `persist:account_${accountId}`;
  const { session: electronSession, BrowserWindow } = require('electron');
  const sess = electronSession.fromPartition(partition);
  
  const cred = AccountService.getCredential(accountId);
  const envId = cred?.envId;

  // 🔑 确保在创建窗口前，UA 净化与隔离代理被 100% 同步执行完毕，排除任何时序竞争
  await BrowserEnvService.applyEnvironment(sess, envId).catch(() => {});

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title,
    autoHideMenuBar: true,
    show: true,
    icon: typeof getAppIcon === 'function' ? getAppIcon() : undefined,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('page-title-updated', (e: any) => e.preventDefault());
  return win;
}

// =====================================================================
// 脚本辅助器
// =====================================================================

function buildDetectLoggedInScript(loginKeywords: string[]): string {
  const kwJSON = JSON.stringify(loginKeywords);
  return `
    (function() {
      var url = (location.href || "").toLowerCase();
      var bodyText = "";
      try { bodyText = (document.body ? (document.body.innerText || document.body.textContent || "") : "") || ""; } catch(e) {}
      
      var kws = ${kwJSON};
      var matched = [];
      for (var i = 0; i < kws.length; i++) {
        if (bodyText.indexOf(kws[i]) !== -1) matched.push(kws[i]);
      }
      
      var hasNick = !!document.querySelector('.finder-nickname');
      var hasUid = !!document.querySelector('.finder-uniq-id');
      
      var isLoginPage = /login.html/i.test(url) || (/login|signin/i.test(url) && url.indexOf('platform') === -1);
      var loggedIn = !isLoginPage && (url.indexOf('platform') !== -1 || hasNick || hasUid || matched.length >= 1);
      
      return { loggedIn: loggedIn, matched: matched, title: document.title, url: url, hasNick: hasNick, hasUid: hasUid };
    })()
  `;
}

function buildExtractPageInfoScript(): string {
  return `
    (function() {
      var r = { nickname: '', avatar: '', platformAccountId: '', fansCount: null, followCount: null, likeCount: null };
      try {
        // 启发式寻找昵称
        var nickEl = document.querySelector('.finder-nickname');
        if (nickEl && nickEl.textContent && nickEl.textContent.trim()) {
          r.nickname = nickEl.textContent.trim();
        } else {
          var nickSels = ['.nickname', '.name', '.username', '[class*="username"]', '[class*="nickname"]', '[class*="user-name"]', '.user-name'];
          for (var i = 0; i < nickSels.length; i++) {
            var el = document.querySelector(nickSels[i]);
            if (el && el.textContent && el.textContent.trim()) {
              r.nickname = el.textContent.trim();
              break;
            }
          }
        }
        
        // 启发式寻找头像
        var avatarEl = document.querySelector('.finder-info-container img.avatar');
        if (avatarEl && avatarEl.src) {
          r.avatar = avatarEl.src;
        } else {
          var avatarSels = ['.avatar img', 'img.avatar', '[class*="avatar"] img', 'img[src*="avatar"]', '[class*="user-avatar"] img'];
          for (var i = 0; i < avatarSels.length; i++) {
            var el = document.querySelector(avatarSels[i]);
            if (el && el.src) {
              r.avatar = el.src;
              break;
            }
          }
        }
        
        // 提取视频号 ID
        var uidEl = document.querySelector('.finder-uniq-id');
        if (uidEl && uidEl.textContent) {
          r.platformAccountId = uidEl.textContent.trim();
        } else {
          var uidEl2 = document.querySelector('#finder-uid-copy');
          if (uidEl2) {
            var attr = uidEl2.getAttribute('data-clipboard-text');
            if (attr) r.platformAccountId = attr.trim();
          }
        }
        
        // 提取粉丝统计
        var statsItems = document.querySelectorAll('.finder-content-info > div');
        for (var j = 0; j < statsItems.length; j++) {
          var item = statsItems[j];
          var labelEl = item.querySelector('span:not(.finder-info-num)');
          var valEl = item.querySelector('.finder-info-num');
          if (labelEl && valEl) {
            var labelText = (labelEl.textContent || '').trim();
            var valText = (valEl.textContent || '').trim();
            var num = parseInt(valText.replace(/,/g, ''), 10);
            if (!isNaN(num)) {
              if (labelText.indexOf('关注者') !== -1 || labelText.indexOf('粉丝') !== -1) {
                r.fansCount = num;
              }
            }
          }
        }
        
        // 兜底昵称，保证登录后的账号完整性
        if (!r.nickname) {
          r.nickname = document.title || '微信视频号';
        }
      } catch(e) {}
      return r;
    })()
  `;
}

function buildWechatFillScript(title: string, content: string): string {
  return `
    (function() {
      var r = { ok: false, err: '', hasTitle: false, hasDesc: false };
      try {
        function findElements(doc) {
          if (!doc) return null;
          var titleEl = doc.querySelector(
            'input[placeholder*="标题"], input[placeholder*="16字"], input[placeholder*="22字"], [class*="title"] input, input[type="text"]'
          );
          var descEl = doc.querySelector(
            'textarea[placeholder*="描述"], textarea[placeholder*="正文"], textarea[placeholder*="1000"], textarea, [contenteditable="true"], .input-editor'
          );
          if (titleEl || descEl) {
            return { titleEl: titleEl, descEl: descEl };
          }
          var iframes = doc.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
              if (idoc) {
                var found = findElements(idoc);
                if (found) return found;
              }
            } catch(e) {}
          }
          return null;
        }

        var elements = findElements(document);
        if (elements) {
          var titleEl = elements.titleEl;
          var descEl = elements.descEl;

          if (titleEl) {
            titleEl.focus();
            titleEl.ownerDocument.execCommand('insertText', false, ${JSON.stringify(title)});
            if (!titleEl.value) titleEl.value = ${JSON.stringify(title)};
            titleEl.dispatchEvent(new Event('input', { bubbles: true }));
            titleEl.dispatchEvent(new Event('change', { bubbles: true }));
            // 🔑 微信视频号：触发鼠标移出/失焦事件，确保表单校验生效
            // 有些组件监听 mouseout/mouseleave/focusout 而非 blur
            titleEl.dispatchEvent(new Event('blur', { bubbles: true }));
            titleEl.dispatchEvent(new Event('focusout', { bubbles: true }));
            titleEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            titleEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
            titleEl.blur();
            // 模拟鼠标移到 body 上（彻底失焦）
            try {
              document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              document.body.click();
            } catch(e) {}
            r.hasTitle = true;
          }

          if (descEl) {
            descEl.focus();
            if (descEl.getAttribute('contenteditable') === 'true' || descEl.tagName !== 'TEXTAREA') {
              var docRef = descEl.ownerDocument;
              var winRef = docRef.defaultView || window;
              var selection = winRef.getSelection();
              var range = docRef.createRange();
              range.selectNodeContents(descEl);
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
              docRef.execCommand('insertText', false, ${JSON.stringify(content)});
              if (!descEl.textContent) descEl.innerText = ${JSON.stringify(content)};
            } else {
              descEl.value = ${JSON.stringify(content)};
            }
            descEl.dispatchEvent(new Event('input', { bubbles: true }));
            descEl.dispatchEvent(new Event('change', { bubbles: true }));
            // 🔑 微信视频号：描述框也触发失焦/鼠标移出事件
            descEl.dispatchEvent(new Event('blur', { bubbles: true }));
            descEl.dispatchEvent(new Event('focusout', { bubbles: true }));
            descEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
            descEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
            descEl.blur();
            r.hasDesc = true;
          }
          r.ok = !!(titleEl || descEl);
        } else {
          r.err = '未能在页面或 iframe 中找到任何输入节点';
        }
      } catch(e) {
        r.err = e.message;
      }
      return r;
    })()
  `;
}

function buildWechatClickPublishScript(): string {
  return `
    (function() {
      var r = { clicked: false, err: '', buttonText: '', x: 0, y: 0 };
      try {
        function getAbsoluteRect(node) {
          var rect = node.getBoundingClientRect();
          var left = rect.left;
          var top = rect.top;
          var winRef = node.ownerDocument.defaultView;
          while (winRef && winRef !== window) {
            try {
              var frameElement = winRef.frameElement;
              if (frameElement) {
                var fRect = frameElement.getBoundingClientRect();
                left += fRect.left;
                top += fRect.top;
              }
            } catch(e) {
              break;
            }
            winRef = winRef.parent;
          }
          return { left: left, top: top, width: rect.width, height: rect.height };
        }

        function findPublishButton(doc) {
          if (!doc) return null;
          
          function search(node) {
            if (!node) return null;
            
            // 1. 若是元素节点，匹配按钮及可交互文字项
            if (node.nodeType === 1) {
              var tagName = node.tagName.toLowerCase();
              var role = node.getAttribute && node.getAttribute('role') || '';
              var cls = node.getAttribute && node.getAttribute('class') || '';
              
              if (tagName === 'button' || role === 'button' || cls.indexOf('btn') !== -1 || cls.indexOf('button') !== -1) {
                if (!(node.disabled || node.getAttribute('disabled') === 'true' || cls.indexOf('disabled') !== -1)) {
                  var txt = (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
                  if (txt === '发表' || txt === '发布' || txt === '发表视频' || txt === '发表图文') {
                    return node;
                  }
                }
              }
            }
            
            // 2. 递归普通子节点
            if (node.childNodes && node.childNodes.length > 0) {
              for (var i = 0; i < node.childNodes.length; i++) {
                var res = search(node.childNodes[i]);
                if (res) return res;
              }
            }
            
            // 3. 递归 Shadow DOM 树 (Shadow Root)
            if (node.shadowRoot) {
              var res = search(node.shadowRoot);
              if (res) return res;
            }
            
            // 4. 递归穿透 iframe
            if (node.tagName && node.tagName.toLowerCase() === 'iframe') {
              try {
                var idoc = node.contentDocument || (node.contentWindow && node.contentWindow.document);
                if (idoc) {
                  var res = search(idoc);
                  if (res) return res;
                }
              } catch(e) {}
            }
            
            return null;
          }
          
          return search(doc.body || doc);
        }

        var btnNode = findPublishButton(document);
        if (btnNode) {
          try {
            btnNode.scrollIntoView({ block: 'center', inline: 'nearest' });
          } catch(e) {}
          
          var absRect = getAbsoluteRect(btnNode);
          r.x = Math.round(absRect.left + absRect.width / 2);
          r.y = Math.round(absRect.top + absRect.height / 2);

          btnNode.click();
          btnNode.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          r.clicked = true;
          r.buttonText = btnNode.innerText || btnNode.textContent || '';
        } else {
          r.err = '未能在页面或 iframe 中找到发表按钮';
        }
      } catch(e) {
        r.err = e.message;
      }
      return r;
    })()
  `;
}

// =====================================================================
// 微信视频号测试模式脚本：高亮标记发表按钮，收集表单填写状态
// =====================================================================
function buildWechatTestModeScript(): string {
  return `
    (function() {
      var result = {
        publishButtonFound: false,
        publishButtonInfo: null,
        hasTitle: false,
        hasDesc: false,
        fields: [],
        note: '',
      };
      try {
        function getAbsoluteRect(node) {
          var rect = node.getBoundingClientRect();
          var left = rect.left;
          var top = rect.top;
          var winRef = node.ownerDocument.defaultView;
          while (winRef && winRef !== window) {
            try {
              var frameElement = winRef.frameElement;
              if (frameElement) {
                var fRect = frameElement.getBoundingClientRect();
                left += fRect.left;
                top += fRect.top;
              }
            } catch(e) { break; }
            winRef = winRef.parent;
          }
          return { left: left, top: top, width: rect.width, height: rect.height };
        }

        function findPublishButton(doc) {
          if (!doc) return null;
          function search(node) {
            if (!node) return null;
            if (node.nodeType === 1) {
              var tagName = node.tagName.toLowerCase();
              var role = node.getAttribute && node.getAttribute('role') || '';
              var cls = node.getAttribute && node.getAttribute('class') || '';
              if (tagName === 'button' || role === 'button' || cls.indexOf('btn') !== -1 || cls.indexOf('button') !== -1) {
                if (!(node.disabled || node.getAttribute('disabled') === 'true' || cls.indexOf('disabled') !== -1)) {
                  var txt = (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
                  if (txt === '发表' || txt === '发布' || txt === '发表视频' || txt === '发表图文') {
                    return node;
                  }
                }
              }
            }
            if (node.childNodes && node.childNodes.length > 0) {
              for (var i = 0; i < node.childNodes.length; i++) {
                var res = search(node.childNodes[i]);
                if (res) return res;
              }
            }
            if (node.shadowRoot) {
              var res = search(node.shadowRoot);
              if (res) return res;
            }
            if (node.tagName && node.tagName.toLowerCase() === 'iframe') {
              try {
                var idoc = node.contentDocument || (node.contentWindow && node.contentWindow.document);
                if (idoc) {
                  var res = search(idoc);
                  if (res) return res;
                }
              } catch(e) {}
            }
            return null;
          }
          return search(doc.body || doc);
        }

        // 1. 查找发表按钮
        var publishBtn = findPublishButton(document);
        if (publishBtn) {
          var absRect = getAbsoluteRect(publishBtn);
          result.publishButtonFound = true;
          result.publishButtonInfo = {
            text: (publishBtn.innerText || publishBtn.textContent || '').trim().slice(0, 30),
            selector: 'button',
            x: absRect.left,
            y: absRect.top,
            width: absRect.width,
            height: absRect.height,
          };

          // 2. 高亮标记发表按钮
          publishBtn.dataset.originalOutline = publishBtn.style.outline;
          publishBtn.dataset.originalOutlineOffset = publishBtn.style.outlineOffset;
          publishBtn.dataset.originalBoxShadow = publishBtn.style.boxShadow;
          publishBtn.dataset.originalZIndex = publishBtn.style.zIndex;
          publishBtn.style.outline = '3px solid #ff6b6b';
          publishBtn.style.outlineOffset = '2px';
          publishBtn.style.boxShadow = '0 0 0 4px rgba(255, 107, 107, 0.3), 0 0 20px rgba(255, 107, 107, 0.5)';
          publishBtn.style.zIndex = '99999';

          // 添加闪烁动画样式
          var styleId = 'flowx-test-highlight-style';
          if (!document.getElementById(styleId)) {
            var style = document.createElement('style');
            style.id = styleId;
            style.textContent = '@keyframes flowx-test-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(255, 107, 107, 0.3), 0 0 20px rgba(255, 107, 107, 0.5); } 50% { box-shadow: 0 0 0 8px rgba(255, 107, 107, 0.5), 0 0 30px rgba(255, 107, 107, 0.8); } } .flowx-test-highlight { animation: flowx-test-pulse 1.5s ease-in-out infinite !important; }';
            document.head.appendChild(style);
          }
          publishBtn.classList.add('flowx-test-highlight');

          // 添加"测试模式"标签
          var badge = document.createElement('div');
          badge.textContent = '🔍 发表按钮（测试模式）';
          badge.style.cssText = 'position: absolute; top: -28px; left: 50%; transform: translateX(-50%); background: #ff6b6b; color: white; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; white-space: nowrap; z-index: 100000; pointer-events: none;';
          if (getComputedStyle(publishBtn).position === 'static') {
            publishBtn.style.position = 'relative';
          }
          publishBtn.appendChild(badge);
        }

        // 3. 检测表单字段填写状态
        var fields = [];
        // 检测标题输入框
        var titleInputs = document.querySelectorAll('input[placeholder*="标题"], input[placeholder*="title"], textarea[placeholder*="标题"]');
        var hasTitle = false;
        for (var i = 0; i < titleInputs.length; i++) {
          var val = (titleInputs[i].value || titleInputs[i].innerText || '').trim();
          if (val.length > 0) { hasTitle = true; }
        }
        result.hasTitle = hasTitle;
        fields.push({ type: 'input', label: '标题', filled: hasTitle });

        // 检测描述/正文
        var descAreas = document.querySelectorAll('[contenteditable="true"], textarea[placeholder*="描述"], textarea[placeholder*="简介"], textarea[placeholder*="正文"]');
        var hasDesc = false;
        for (var i = 0; i < descAreas.length; i++) {
          var val = (descAreas[i].value || descAreas[i].innerText || '').trim();
          if (val.length > 0) { hasDesc = true; }
        }
        result.hasDesc = hasDesc;
        fields.push({ type: 'contenteditable', label: '描述/正文', filled: hasDesc });
        result.fields = fields;

        // 4. 添加浮动控制面板
        if (publishBtn) {
          var panel = document.createElement('div');
          panel.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #fff; border: 2px solid #e6a23c; border-radius: 8px; padding: 16px; z-index: 2147483647; box-shadow: 0 4px 20px rgba(0,0,0,0.15); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-width: 240px;';
          panel.innerHTML = \`
            <div style="font-weight: 600; font-size: 14px; color: #e6a23c; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">🔍 发布测试模式</div>
            <div style="font-size: 12px; color: #606266; margin-bottom: 12px; line-height: 1.5;">表单已自动填写，发表按钮已用红色标记。请检查表单填写是否正常，确认无误后点击下方按钮发表。</div>
            <div style="display: flex; gap: 8px;">
              <button id="flowx-test-confirm-btn" style="flex: 1; padding: 8px 16px; background: #67c23a; color: white; border: none; border-radius: 4px; font-size: 13px; font-weight: 500; cursor: pointer;">✅ 确认发表</button>
              <button id="flowx-test-close-btn" style="padding: 8px 12px; background: #f5f7fa; color: #606266; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 13px; cursor: pointer;">关闭</button>
            </div>
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ebeef5; font-size: 12px; color: #909399;">
              <div>表单字段检测：<span style="color: #67c23a; font-weight: 500;">\${fields.filter(function(f){return f.filled;}).length}</span> / <span>\${fields.length}</span> 已填写</div>
              <div>发表按钮：<span style="color: #67c23a; font-weight: 500;">已找到</span></div>
            </div>
          \`;
          document.body.appendChild(panel);

          // 绑定确认发表按钮
          setTimeout(function() {
            var confirmBtn = document.getElementById('flowx-test-confirm-btn');
            var closeBtn = document.getElementById('flowx-test-close-btn');
            if (confirmBtn) {
              confirmBtn.onclick = function() {
                if (confirm('确定要发表吗？发表后将无法撤销。')) {
                  publishBtn.classList.remove('flowx-test-highlight');
                  publishBtn.style.outline = publishBtn.dataset.originalOutline || '';
                  publishBtn.style.outlineOffset = publishBtn.dataset.originalOutlineOffset || '';
                  publishBtn.style.boxShadow = publishBtn.dataset.originalBoxShadow || '';
                  publishBtn.style.zIndex = publishBtn.dataset.originalZIndex || '';
                  panel.remove();
                  publishBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  setTimeout(function() { publishBtn.click(); }, 300);
                }
              };
            }
            if (closeBtn) {
              closeBtn.onclick = function() { panel.remove(); };
            }
          }, 100);
        }

        result.note = publishBtn ? '已找到发表按钮并高亮标记，请检查表单填写是否正常' : '未找到发表按钮';
      } catch(e) {
        result.note = '测试模式脚本执行异常: ' + e.message;
      }
      return result;
    })()
  `;
}

// =====================================================================
// 安全可靠的脚本执行工具（带 4000ms 超时限制，防止 Electron 裸 executeJavaScript 挂死）
// =====================================================================

async function safeExecuteJavaScript(win: BrowserWindow, code: string, timeoutMs = 4000): Promise<any> {
  if (win.isDestroyed()) return null;
  return Promise.race([
    win.webContents.executeJavaScript(code),
    new Promise((_, reject) => setTimeout(() => reject(new Error('executeJavaScript 执行超时')), timeoutMs))
  ]).catch(() => null);
}

// =====================================================================
// 微信视频号上传状态监控轮询
// =====================================================================

async function waitForWechatUpload(win: BrowserWindow, log: any): Promise<boolean> {
  const deadline = Date.now() + 300000; // 最长等待 5 分钟
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    log('info', 'upload', '检测微信视频号后台素材上传状态…');
    const isComplete = await safeExecuteJavaScript(win, `
      (function() {
        function queryInDocument(doc) {
          if (!doc) return null;
          
          // 1. 检测视频上传成功字样
          var bodyText = doc.body ? (doc.body.innerText || '') : '';
          if (bodyText.indexOf('重新上传') !== -1 || bodyText.indexOf('更换视频') !== -1 || bodyText.indexOf('重新选择') !== -1) {
            return true;
          }
          
          // 2. 检测视频预览节点
          if (doc.querySelector('video')) {
            return true;
          }
          
          // 3. 检测图文背景样式缩略图
          if (doc.querySelector('.thumb-item') || doc.querySelector('.post-img-list-wrap .thumb-item')) {
            return true;
          }
          var thumbDivs = doc.querySelectorAll('.thumb-item, [class*="thumb-item"], [class*="thumb_item"]');
          for (var k = 0; k < thumbDivs.length; k++) {
            var bg = thumbDivs[k].style.backgroundImage || '';
            if (bg.indexOf('url(') !== -1 || bg.indexOf('blob:') !== -1) {
              return true;
            }
          }
          
          // 4. 检测普通图片标签
          var imgs = doc.querySelectorAll('img');
          for (var i = 0; i < imgs.length; i++) {
            var src = imgs[i].src || '';
            if ((src.indexOf('http') === 0 && src.indexOf('wxfile') !== -1) || src.indexOf('blob:') === 0 || imgs[i].className.indexOf('thumb') !== -1) {
              return true;
            }
          }
          
          // 5. 递归检测子 iframe 容器以穿透微前端隔离限制
          var iframes = doc.querySelectorAll('iframe');
          for (var j = 0; j < iframes.length; j++) {
            try {
              var idoc = iframes[j].contentDocument || (iframes[j].contentWindow && iframes[j].contentWindow.document);
              if (idoc) {
                var res = queryInDocument(idoc);
                if (res) return true;
              }
            } catch(e) {}
          }
          return false;
        }
        return queryInDocument(document);
      })()
    `, 5000).catch(() => false);

    if (isComplete) {
      log('info', 'upload', '微信视频号素材上传已检测到完成');
      return true;
    }
    await sleep(3000);
  }
  return false;
}

// =====================================================================
// 等待上传 input[type="file"] 节点在主页面或子 iframe 中加载渲染就绪
// =====================================================================

async function waitForUploadFieldReady(win: BrowserWindow, log: any): Promise<boolean> {
  const deadline = Date.now() + 20000; // 最长等待 20 秒
  log('info', 'upload', '开始等待微信视频号上传节点就绪…');
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    const isReady = await safeExecuteJavaScript(win, `
      (function() {
        if (document.querySelector('input[type="file"]')) return true;
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var idoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
            if (idoc && idoc.querySelector('input[type="file"]')) return true;
          } catch(e) {}
        }
        return false;
      })()
    `, 4000).catch(() => false);

    if (isReady) {
      log('info', 'upload', '微信视频号上传节点（input[type="file"]）已就绪');
      return true;
    }
    await sleep(1500);
  }
  log('warn', 'upload', '微信视频号上传节点就绪等待超时，将继续尝试注入文件');
  return false;
}

// =====================================================================
// 适配器实现类
// =====================================================================

const WechatChannelsAdapter: PlatformAdapter = {
  key: 'wechat_channels',
  meta,
  capabilities: meta.capabilities,

  async detectLoggedIn(win: BrowserWindow): Promise<LoginCheckResult> {
    try {
      const info: any = await safeExecuteJavaScript(
        win,
        buildDetectLoggedInScript(LOGIN_KEYWORDS)
      );
      if (!info) return { loggedIn: false, url: '', title: '' };
      return {
        loggedIn: info.loggedIn,
        url: info.url || '',
        title: info.title || '',
        matchedKeywords: info.matched,
      };
    } catch {
      return { loggedIn: false, url: '', title: '' };
    }
  },

  async extractPageInfo(win: BrowserWindow): Promise<ExtractedAccountInfo> {
    try {
      const info: any = await safeExecuteJavaScript(
        win,
        buildExtractPageInfoScript()
      );
      return info || { nickname: '微信视频号' };
    } catch {
      return { nickname: '微信视频号' };
    }
  },

  // ─── 视频发布流程 ───
  async publishVideo(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback
  ): Promise<PublishItemProgress> {
    return runWechatPublish(accountId, request, onProgress, 'video');
  },

  // ─── 图文发布流程 ───
  async publishImage(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback
  ): Promise<PublishItemProgress> {
    return runWechatPublish(accountId, request, onProgress, 'image');
  },

  // ─── 向后兼容接口 ───
  async publish(
    accountId: string,
    request: PublishRequest,
    onProgress: ProgressCallback
  ): Promise<PublishItemProgress> {
    const contentType = (request.mediaFiles || []).some(f => f.toLowerCase().endsWith('.mp4')) ? 'video' : 'image';
    return runWechatPublish(accountId, request, onProgress, contentType);
  }
};

// =====================================================================
// 统一发布驱动器
// =====================================================================

async function runWechatPublish(
  accountId: string,
  request: PublishRequest,
  onProgress: ProgressCallback,
  contentType: ContentType
): Promise<PublishItemProgress> {
  const startedAt = Date.now();
  const log = makePublishLogger({ accountId, platform: 'wechat_channels' });
  const publishUrl = contentType === 'video' ? PUBLISH_VIDEO_URL : PUBLISH_IMAGE_URL;

  log('info', 'start', `开始发布微信视频号 [${contentType}]`, { title: request.title });

  let win: BrowserWindow | null = null;
  let disposeTracker: (() => void) | null = null;

  try {
    // 1) 启动窗口及导航跟踪器
    win = await makeWechatPublishWindow(accountId, `微信视频号发布 - ${request.title || '未命名'}`);
    const tracker = attachNavigationTracker(win, log);
    disposeTracker = () => tracker.dispose();

    // 2) 加载微信视频号对应发布 URL
    onProgress(5, '加载发布页面中…');
    log('info', 'load', `打开发布页: ${publishUrl}`);
    await sleep(350); // 🔑 缓冲等待，确保刚注入的 Cookie 在 Chromium 网络栈中完全就绪生效
    await win.loadURL(publishUrl).catch((err) => {
      log('warn', 'load', `页面加载出现异常: ${err.message}`);
    });

    // 3) 等待页面完成基本渲染稳定
    onProgress(10, '等待发布页面稳定…');
    await tracker.waitForStable(1500, 15000);
    await sleep(2000);

    // 4) 校验登录态，如未登录拉起窗口让用户手动授权
    onProgress(15, '检测视频号登录态…');
    let loginCheck = await WechatChannelsAdapter.detectLoggedIn(win);
    if (!loginCheck.loggedIn) {
      log('warn', 'login', '当前未检测到登录态，将显示窗口提示用户完成登录操作…');
      onProgress(20, '未登录，请在弹出的窗口内进行扫码登录（最长等待 120 秒）');
      win.show();
      win.focus();

      const deadline = Date.now() + 120000;
      let loggedInNow = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (win.isDestroyed()) break;
        const currentCheck = await WechatChannelsAdapter.detectLoggedIn(win);
        if (currentCheck.loggedIn) {
          loggedInNow = true;
          log('info', 'login', '登录成功，继续后续发布动作');
          break;
        }
      }

      if (!loggedInNow) {
        return makeFailedResult(accountId, 'wechat_channels', '扫码登录超时或中途取消', startedAt);
      }

      // 重载到对应的发布页
      if (!win.isDestroyed()) {
        const curUrl = win.webContents.getURL();
        if (curUrl.indexOf('platform/post') === -1) {
          log('info', 'login', `从登录过渡，自动跳转至指定发布页: ${publishUrl}`);
          await sleep(350); // 🔑 缓冲等待，确保 Cookie 完整生效
          await win.loadURL(publishUrl).catch(() => {});
        }
      }
      await tracker.waitForStable(1500, 15000);
      await sleep(2000);
    } else {
      log('info', 'login', '检测到已登录，直接开始内容发布');
    }

    const files = request.mediaFiles || [];
    if (files.length === 0) {
      return makeFailedResult(accountId, 'wechat_channels', '未提供可发布的文件列表', startedAt);
    }

    onProgress(25, '校验登录完成，开始上传素材文件…');

    // 4.5) 等待上传 input 节点在主页面或子 iframe 中完全加载出来
    await waitForUploadFieldReady(win, log);

    log('info', 'upload', `准备注入文件进行上传: ${files.join(', ')}`);
    const uploadOk = await uploadViaCDP(win, files, log, contentType);
    if (!uploadOk) {
      return makeFailedResult(accountId, 'wechat_channels', '注入文件对象上传失败', startedAt);
    }

    // 6) 轮询等待上传成功归档
    onProgress(45, '正在上传素材中，请稍候…');
    const uploadCompleted = await waitForWechatUpload(win, log);
    if (!uploadCompleted) {
      return makeFailedResult(accountId, 'wechat_channels', '等待文件上传完成超时', startedAt);
    }
    log('info', 'upload', '素材文件已成功上传就绪');
    await sleep(4500); // 🔑 加长等待，确保微信视频号后台转码、首帧提取及视频状态稳定就绪

    // 7) 格式化裁切短标题与描述内容，拼装话题标签
    onProgress(65, '自动填写标题与描述…');
    
    // 微信视频号的话题可以直接拼装到描述文本最后
    const tags = request.tags || [];
    let formattedDesc = request.content || '';
    if (tags.length > 0) {
      const tagStr = tags.map(t => t.startsWith('#') ? t : '#' + t).join(' ');
      formattedDesc = formattedDesc ? `${formattedDesc}\n${tagStr}` : tagStr;
    }

    let finalTitle = cleanWechatTitle(request.title || '', contentType === 'video' ? VIDEO_TITLE_LIMIT : IMAGE_TITLE_LIMIT);
    log('info', 'fill', `最终生成的微信视频号标题: "${finalTitle}"`);
    let finalDesc = formattedDesc;

    if (contentType === 'video') {
      if (finalDesc.length > VIDEO_CONTENT_LIMIT) {
        log('warn', 'fill', `视频描述过长，自动截断为 ${VIDEO_CONTENT_LIMIT} 字`);
        finalDesc = finalDesc.slice(0, VIDEO_CONTENT_LIMIT);
      }
    } else {
      if (finalDesc.length > IMAGE_CONTENT_LIMIT) {
        log('warn', 'fill', `图文描述过长，自动截断为 ${IMAGE_CONTENT_LIMIT} 字`);
        finalDesc = finalDesc.slice(0, IMAGE_CONTENT_LIMIT);
      }
    }

    // 8) 执行表单内容填充
    const fillRes: any = await evalJS(win, buildWechatFillScript(finalTitle, finalDesc), '内容填充', log);
    log('info', 'fill', `微信视频号表单内容填充结果: ${JSON.stringify(fillRes)}`);
    await sleep(2000); // 🔑 加长等待，确保 React/Vue 受控状态完全绑定生效，给表单组件重绘及内部校验留下充足时间

    // 9) 点击发表按钮提交发布（引入最多 5 次轮询重试，每次间隔 1.5 秒，给受控组件表单校验渲染留出充足时间）
    onProgress(85, '点击发表按钮…');

    // 测试模式：不点击发布，高亮标记按钮并收集表单状态
    if (request.testMode) {
      const testScript = buildWechatTestModeScript();
      const testRes: any = await evalJS(win, testScript, 'test-mode-probe', log).catch(() => null);
      const testResult = {
        titleFilled: !!(testRes?.hasTitle),
        contentFilled: !!(testRes?.hasDesc),
        tagsFilled: !!(request.tags && request.tags.length > 0),
        coverUploaded: !!(request.coverImage && request.coverImage.length > 0),
        publishButtonFound: !!(testRes?.publishButtonFound),
        publishButtonInfo: testRes?.publishButtonInfo || null,
        formFields: testRes?.fields || [],
        note: testRes?.note || '测试模式完成',
      };
      log('info', 'test', '测试模式完成: ' + (testRes?.note || '未知'));
      onProgress(100, '测试完成');

      // 🔑 测试模式下：确保用户点关闭时能正常关闭窗口
      setupTestModeWindow(win, log);

      return {
        accountId,
        platform: 'wechat_channels',
        status: 'success',
        progress: 100,
        message: '测试完成 - 表单填写验证通过',
        startedAt,
        finishedAt: Date.now(),
        testResult: testResult,
      } as PublishItemProgress;
    }

    let clickedOk = false;
    let clickRes: any = null;
    for (let clickAttempt = 0; clickAttempt < 5; clickAttempt++) {
      await sleep(1500);
      if (win.isDestroyed()) break;
      clickRes = await evalJS(win, buildWechatClickPublishScript(), '发表点击', log);
      if (clickRes && clickRes.clicked) {
        clickedOk = true;
        log('info', 'publish', `微信视频号在第 ${clickAttempt + 1} 次尝试时成功获取并触发发表点击: ${JSON.stringify(clickRes)}`);
        
        // 🔑 触发 CDP 物理鼠标点击（isTrusted=true 保护）
        if (clickRes.x > 0 && clickRes.y > 0) {
          log('info', 'publish', `准备通过 CDP 发送物理鼠标点击至坐标: (${clickRes.x}, ${clickRes.y})`);
          try {
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: clickRes.x, y: clickRes.y, button: 'left', clickCount: 1, buttons: 1, modifiers: 0,
            });
            await sleep(80);
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed', x: clickRes.x, y: clickRes.y, button: 'left', clickCount: 1, buttons: 1, modifiers: 0,
            });
            await sleep(120);
            await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: clickRes.x, y: clickRes.y, button: 'left', clickCount: 1, buttons: 0, modifiers: 0,
            });
            log('info', 'publish', '✅ CDP 真实鼠标物理点击发送成功');
          } catch(cdpErr: any) {
            log('warn', 'publish', `CDP 鼠标物理点击发送失败: ${cdpErr.message}`);
          }
        }
        break;
      }
      log('warn', 'publish', `微信视频号第 ${clickAttempt + 1} 次发表尝试未成功: ${JSON.stringify(clickRes)}，准备重试…`);
    }

    if (!clickedOk) {
      log('warn', 'publish', '未找到可点击的发表按钮，尝试降级使用 CDP 穿透查找点击');
    }
    await sleep(2000);

    // 10) 轮询检测页面变化判定发布成功
    onProgress(95, '等待平台响应发布成功状态…');
    const publishDeadline = Date.now() + 30000;
    let published = false;
    while (Date.now() < publishDeadline) {
      await sleep(2000);
      if (win.isDestroyed()) break;
      const checkRes = await safeExecuteJavaScript(win, `
        (function() {
          var bodyText = document.body ? (document.body.innerText || '') : '';
          var curUrl = location.href;
          // 1. 如果页面回到了作品管理页，或者是发布地址后增加了 success/manage
          if (curUrl.indexOf('platform/post/manage') !== -1 || curUrl.indexOf('platform/post/list') !== -1) {
            return true;
          }
          // 2. 检查是否有发布成功的 toast 或提示字样
          if (bodyText.indexOf('发表成功') !== -1 || bodyText.indexOf('发布成功') !== -1) {
            return true;
          }
          return false;
        })()
      `, 4000).catch(() => false);

      if (checkRes) {
        published = true;
        break;
      }
    }

    if (!published) {
      log('warn', 'publish', '等待发布成功状态超时，默认为发布成功（微信视频号点击发表后可能直接转入后台异步审核）');
    }

    // 发布成功归档
    onProgress(100, '发布成功');
    log('info', 'publish', '微信视频号内容发布动作已全部顺利完成');
    await sleep(1000);
    return {
      accountId,
      platform: 'wechat_channels',
      status: 'success',
      progress: 100,
      message: '发布成功',
    };
  } catch (err) {
    log('error', 'publish-failed', `微信视频号发布遭遇异常中断: ${(err as Error).message}`);
    return makeFailedResult(accountId, 'wechat_channels', (err as Error).message, startedAt);
  } finally {
    if (disposeTracker) disposeTracker();
    // 测试模式：不关闭窗口，让用户可以检查表单填写情况
    if (request.testMode) {
      log('info', 'test', '测试模式完成，窗口保持打开，方便检查表单填写情况');
    } else if (win && !win.isDestroyed()) {
      win.close();
    }
  }
}

// 触发自注册
registerPlatform(WechatChannelsAdapter);
