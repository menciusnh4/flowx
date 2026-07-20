import { getViewWebContents } from './BrowserService';
import { logger } from '../utils/logger';
import type { PickerFieldType, PickerResult } from '../../types';

/**
 * 元素拾取器服务
 * - 单选模式：点击单个元素，生成唯一选择器
 * - 多选模式：点击多个同类元素，自动推断通用选择器
 */
class ElementPickerService {
  /**
   * 启动拾取器
   * @param viewId 视图 ID
   * @param fieldType 拾取的字段类型
   * @param mode 拾取模式：single（单选）/ multi（多选）
   */
  async startPicker(
    viewId: string,
    fieldType: PickerFieldType,
    mode: 'single' | 'multi' = 'single',
  ): Promise<boolean> {
    const wc = getViewWebContents(viewId);
    if (!wc) throw new Error('视图不存在');

    // 检查是否已有拾取器在运行
    const isActive = await wc.executeJavaScript('!!window.__flowx_picker_active');
    if (isActive) {
      // 切换拾取类型
      await wc.executeJavaScript(`
        if (window.__flowx_picker_setType) {
          window.__flowx_picker_setType(${JSON.stringify(fieldType)}, ${JSON.stringify(mode)});
        }
      `);
      // 让 BrowserView 获取焦点
      wc.focus();
      return true;
    }

    const script = this.buildPickerScript(fieldType, mode);
    await wc.executeJavaScript(script);

    // 让 BrowserView 获取焦点，确保键盘事件（方向键）能被拾取器捕获
    wc.focus();

    logger.info(`[ElementPicker] 启动拾取器: ${fieldType} (${mode})`);
    return true;
  }

  /**
   * 停止拾取器
   */
  async stopPicker(viewId: string): Promise<boolean> {
    const wc = getViewWebContents(viewId);
    if (!wc) return false;
    try {
      await wc.executeJavaScript(`
        if (window.__flowx_picker_cleanup) {
          window.__flowx_picker_cleanup();
        }
      `);
      logger.info('[ElementPicker] 停止拾取器');
      return true;
    } catch (e) {
      logger.warn('[ElementPicker] 停止拾取器失败:', e);
      return false;
    }
  }

  /**
   * 构建拾取器脚本
   */
  private buildPickerScript(fieldType: PickerFieldType, mode: 'single' | 'multi'): string {
    const fieldLabels: Record<PickerFieldType, string> = {
      title: '标题',
      content: '正文',
      image: '图片',
      tags: '话题标签',
      byline: '作者',
      date: '日期',
      remove: '移除元素',
    };
    const label = fieldLabels[fieldType] || fieldType;

    return `
(function() {
  if (window.__flowx_picker_active) return;
  window.__flowx_picker_active = true;

  var currentFieldType = ${JSON.stringify(fieldType)};
  var currentMode = ${JSON.stringify(mode)};
  var selectedElements = [];  // 多选模式下已选中的元素
  var hoverEl = null;
  var navEl = null;  // 键盘导航选中的元素

  // ========== 创建 UI ==========

  // 悬停高亮（蓝色）
  var hoverOverlay = document.createElement('div');
  hoverOverlay.id = '__flowx_picker_hover';
  hoverOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:rgba(59,130,246,0.15);border:2px solid #3b82f6;border-radius:2px;transition:all 0.1s ease;display:none;';
  document.body.appendChild(hoverOverlay);

  // 已选高亮（绿色）
  var selectedOverlay = document.createElement('div');
  selectedOverlay.id = '__flowx_picker_selected';
  selectedOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:rgba(34,197,94,0.12);border:2px dashed #22c55e;border-radius:2px;display:none;';
  document.body.appendChild(selectedOverlay);

  // 匹配预览高亮（紫色虚线）
  var matchOverlay = document.createElement('div');
  matchOverlay.id = '__flowx_picker_match';
  matchOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;background:rgba(168,85,247,0.08);border:2px dotted #a855f7;border-radius:2px;display:none;';
  document.body.appendChild(matchOverlay);

  // 底部提示栏
  var infoBar = document.createElement('div');
  infoBar.id = '__flowx_picker_info';
  infoBar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#0f172a;color:#fff;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 -4px 20px rgba(0,0,0,0.3);';
  infoBar.innerHTML = \`
    <div style="display:flex;align-items:center;gap:16px;">
      <span style="font-weight:600;font-size:14px;">🎯 拾取${label}元素</span>
      <span style="opacity:0.7;">${mode === 'multi' ? '多选模式：点击多个同类元素' : '单选模式：点击目标元素'}</span>
      <span id="__flowx_picker_count" style="background:#334155;padding:2px 8px;border-radius:12px;font-size:12px;">已选 0 个</span>
    </div>
    <div style="display:flex;align-items:center;gap:16px;">
      <span style="opacity:0.6;font-size:12px;">↑ 父元素 ↓ 子元素 ← 上一个 → 下一个</span>
      ${mode === 'multi' ? '<button id="__flowx_picker_confirm" style="background:#22c55e;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">确认选择 (Enter)</button>' : ''}
      <button id="__flowx_picker_cancel" style="background:#475569;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">取消 (ESC)</button>
    </div>
  \`;
  document.body.appendChild(infoBar);

  // ========== 工具函数 ==========

  function updateOverlay(el, overlay, color) {
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = (rect.left + window.scrollX) + 'px';
    overlay.style.top = (rect.top + window.scrollY) + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  // 生成单个元素的唯一选择器
  function getUniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      var sel = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        var classes = cur.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); });
        if (classes.length > 0) sel += '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
      }
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(s) { return s.tagName === cur.tagName; });
        if (siblings.length > 1) {
          sel += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      path.unshift(sel);
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  // 获取元素的"指纹"信息（用于推断通用选择器）
  function getElementFingerprint(el) {
    var tag = el.tagName.toLowerCase();
    var classes = el.className && typeof el.className === 'string'
      ? el.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); })
      : [];
    var parentTag = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
    var parentClasses = el.parentElement && el.parentElement.className && typeof el.parentElement.className === 'string'
      ? el.parentElement.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); })
      : [];
    return { tag: tag, classes: classes, parentTag: parentTag, parentClasses: parentClasses };
  }

  // ========== 多选模式：通用选择器推断 ==========

  function inferCommonSelector(elements) {
    if (elements.length === 0) return '';
    if (elements.length === 1) return getUniqueSelector(elements[0]);

    var fps = elements.map(getElementFingerprint);

    // 1. 尝试：相同 tag + 相同 class + 相同父级
    var commonClasses = fps[0].classes.filter(function(c) {
      return fps.every(function(fp) { return fp.classes.includes(c); });
    });
    var commonParentClasses = fps[0].parentClasses.filter(function(c) {
      return fps.every(function(fp) { return fp.parentClasses.includes(c); });
    });
    var sameTag = fps.every(function(fp) { return fp.tag === fps[0].tag; });
    var sameParentTag = fps.every(function(fp) { return fp.parentTag === fps[0].parentTag; });

    // 优先级1：父级 class + tag + class（最精确）
    if (sameParentTag && commonParentClasses.length > 0 && sameTag && commonClasses.length > 0) {
      var parentSel = fps[0].parentTag + '.' + commonParentClasses.slice(0, 3).map(function(c) { return CSS.escape(c); }).join('.');
      var childSel = fps[0].tag + '.' + commonClasses.slice(0, 3).map(function(c) { return CSS.escape(c); }).join('.');
      var selector = parentSel + ' ' + childSel;
      if (validateSelector(selector, elements)) return selector;
    }

    // 优先级2：tag + class（次精确）
    if (sameTag && commonClasses.length > 0) {
      var selector2 = fps[0].tag + '.' + commonClasses.slice(0, 3).map(function(c) { return CSS.escape(c); }).join('.');
      if (validateSelector(selector2, elements)) return selector2;
    }

    // 优先级3：仅 class
    if (commonClasses.length > 0) {
      var selector3 = '.' + commonClasses.slice(0, 3).map(function(c) { return CSS.escape(c); }).join('.');
      if (validateSelector(selector3, elements)) return selector3;
    }

    // 优先级4：父级 tag + tag
    if (sameParentTag && sameTag) {
      var selector4 = fps[0].parentTag + ' > ' + fps[0].tag;
      if (validateSelector(selector4, elements)) return selector4;
    }

    // 优先级5：仅 tag（最宽泛）
    if (sameTag) {
      return fps[0].tag;
    }

    // 兜底：返回第一个元素的选择器
    return getUniqueSelector(elements[0]);
  }

  // 验证选择器是否能选中所有给定元素
  function validateSelector(selector, elements) {
    try {
      var matched = document.querySelectorAll(selector);
      var matchedSet = new Set(matched);
      return elements.every(function(el) { return matchedSet.has(el); });
    } catch (e) {
      return false;
    }
  }

  // 高亮所有匹配的元素（紫色虚线框）
  function highlightMatches(selector) {
    // 简单起见，只显示第一个匹配元素的位置作为预览
    try {
      var first = document.querySelector(selector);
      if (first) {
        updateOverlay(first, matchOverlay, 'purple');
      } else {
        matchOverlay.style.display = 'none';
      }
    } catch (e) {
      matchOverlay.style.display = 'none';
    }
  }

  // ========== 事件处理 ==========

  function onMouseOver(e) {
    if (e.target === infoBar || e.target.closest('#__flowx_picker_info')) return;
    hoverEl = e.target;
    updateOverlay(hoverEl, hoverOverlay, 'blue');
  }

  function onClick(e) {
    if (e.target === infoBar || e.target.closest('#__flowx_picker_info')) return;
    e.preventDefault();
    e.stopPropagation();

    var target = e.target;
    if (!target || target === document.body) return;

    if (currentMode === 'single') {
      // 单选模式：直接完成
      var selector = getUniqueSelector(target);
      var previewText = (target.textContent || '').trim().slice(0, 80);
      cleanup();
      notifyResult({
        pickerType: currentFieldType,
        selector: selector,
        mode: 'single',
        selectedCount: 1,
        previewText: previewText,
      });
    } else {
      // 多选模式：添加到已选列表
      var idx = selectedElements.indexOf(target);
      if (idx >= 0) {
        // 取消选择
        selectedElements.splice(idx, 1);
      } else {
        selectedElements.push(target);
      }

      updateSelectedCount();
      updateSelectedOverlay();

      // 如果已选 >= 2，推断通用选择器并预览
      if (selectedElements.length >= 2) {
        var commonSel = inferCommonSelector(selectedElements);
        highlightMatches(commonSel);
      } else {
        matchOverlay.style.display = 'none';
      }
    }
  }

  function updateSelectedCount() {
    var countEl = document.getElementById('__flowx_picker_count');
    if (countEl) {
      countEl.textContent = '已选 ' + selectedElements.length + ' 个';
    }
  }

  function updateSelectedOverlay() {
    // 简化：高亮最后选中的元素
    if (selectedElements.length > 0) {
      updateOverlay(selectedElements[selectedElements.length - 1], selectedOverlay, 'green');
    } else {
      selectedOverlay.style.display = 'none';
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      notifyCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentMode === 'multi' && selectedElements.length >= 1) {
        confirmSelection();
      } else if (currentMode === 'single' && navEl) {
        // 单选模式：用方向键选中后按 Enter 确认
        selectElement(navEl);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      handleArrowKey(e.key);
    }
  }

  // 选中指定元素（完成拾取）
  function selectElement(target) {
    if (!target || target === document.body) return;
    var selector = getUniqueSelector(target);
    var previewText = (target.textContent || '').trim().slice(0, 80);
    cleanup();
    notifyResult({
      pickerType: currentFieldType,
      selector: selector,
      mode: 'single',
      selectedCount: 1,
      previewText: previewText,
    });
  }

  // 方向键导航
  function handleArrowKey(key) {
    // 如果还没有导航元素，用当前悬停元素或 body 的第一个子元素开始
    if (!navEl || !document.body.contains(navEl)) {
      navEl = hoverEl && hoverEl !== document.body ? hoverEl : document.body.firstElementChild;
    }
    if (!navEl) return;

    var nextEl = null;

    if (key === 'ArrowUp') {
      // 向上：父元素
      nextEl = navEl.parentElement;
      if (nextEl && nextEl === document.documentElement) nextEl = null;
    } else if (key === 'ArrowDown') {
      // 向下：第一个可用的子元素
      nextEl = navEl.firstElementChild;
      while (nextEl && !isElementUsable(nextEl)) {
        nextEl = nextEl.nextElementSibling;
      }
    } else if (key === 'ArrowLeft') {
      // 向左：上一个兄弟元素
      nextEl = navEl.previousElementSibling;
      while (nextEl && !isElementUsable(nextEl)) {
        nextEl = nextEl.previousElementSibling;
      }
    } else if (key === 'ArrowRight') {
      // 向右：下一个兄弟元素
      nextEl = navEl.nextElementSibling;
      while (nextEl && !isElementUsable(nextEl)) {
        nextEl = nextEl.nextElementSibling;
      }
    }

    if (nextEl && nextEl !== document.documentElement && nextEl !== document.body) {
      navEl = nextEl;
      hoverEl = nextEl;
      updateOverlay(navEl, hoverOverlay, 'blue');
      // 滚动到视图中
      scrollIntoViewIfNeeded(navEl);
    }
  }

  // 判断元素是否可用（跳过脚本、样式等不可见元素）
  function isElementUsable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return true;
  }

  // 滚动到视图中（如果需要）
  function scrollIntoViewIfNeeded(el) {
    var rect = el.getBoundingClientRect();
    var vh = window.innerHeight;
    if (rect.top < 0 || rect.bottom > vh) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function confirmSelection() {
    if (selectedElements.length === 0) {
      cleanup();
      notifyCancel();
      return;
    }

    var commonSel = inferCommonSelector(selectedElements);
    var matchCount = 0;
    try {
      matchCount = document.querySelectorAll(commonSel).length;
    } catch (e) {
      matchCount = selectedElements.length;
    }

    var previewText = selectedElements[0] ? (selectedElements[0].textContent || '').trim().slice(0, 80) : '';

    cleanup();
    notifyResult({
      pickerType: currentFieldType,
      selector: commonSel,
      mode: 'multi',
      selectedCount: selectedElements.length,
      matchCount: matchCount,
      previewText: previewText,
    });
  }

  // ========== 通知主进程 ==========

  function notifyResult(result) {
    console.log('__FLOWX_PICKER_RESULT__:' + JSON.stringify(result));
    document.dispatchEvent(new CustomEvent('flowx:picker-result', { detail: result }));
  }

  function notifyCancel() {
    console.log('__FLOWX_PICKER_CANCEL__');
    document.dispatchEvent(new CustomEvent('flowx:picker-cancelled'));
  }

  // ========== 清理 ==========

  function cleanup() {
    window.__flowx_picker_active = false;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (hoverOverlay.parentNode) hoverOverlay.parentNode.removeChild(hoverOverlay);
    if (selectedOverlay.parentNode) selectedOverlay.parentNode.removeChild(selectedOverlay);
    if (matchOverlay.parentNode) matchOverlay.parentNode.removeChild(matchOverlay);
    if (infoBar.parentNode) infoBar.parentNode.removeChild(infoBar);
    delete window.__flowx_picker_cleanup;
    delete window.__flowx_picker_setType;
    delete window.__flowx_picker_active;
  }

  window.__flowx_picker_cleanup = cleanup;

  // 切换拾取类型（运行时切换）
  window.__flowx_picker_setType = function(fieldType, mode) {
    currentFieldType = fieldType;
    currentMode = mode;
    selectedElements = [];
    updateSelectedCount();
    selectedOverlay.style.display = 'none';
    matchOverlay.style.display = 'none';

    var labels = { title:'标题', content:'正文', image:'图片', tags:'话题标签', byline:'作者', date:'日期', remove:'移除元素' };
    var label = labels[fieldType] || fieldType;
    var titleEl = infoBar.querySelector('span[style*="font-weight"]');
    if (titleEl) titleEl.textContent = '🎯 拾取' + label + '元素';

    var modeEl = infoBar.querySelectorAll('span')[1];
    if (modeEl) modeEl.textContent = mode === 'multi' ? '多选模式：点击多个同类元素' : '单选模式：点击目标元素';
  };

  // ========== 绑定事件 ==========

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  // 确认按钮（多选模式）
  var confirmBtn = document.getElementById('__flowx_picker_confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      confirmSelection();
    });
  }

  // 取消按钮
  var cancelBtn = document.getElementById('__flowx_picker_cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      cleanup();
      notifyCancel();
    });
  }

  // 改变鼠标样式
  var origCursor = document.body.style.cursor;
  document.body.style.cursor = 'crosshair';

  var origCleanup = cleanup;
  window.__flowx_picker_cleanup = function() {
    origCleanup();
    document.body.style.cursor = origCursor || '';
  };
})()
`;
  }
}

// 单例
export const elementPicker = new ElementPickerService();
