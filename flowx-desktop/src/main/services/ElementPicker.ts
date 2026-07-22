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

  // 路径提示 tooltip
  var pathTooltip = document.createElement('div');
  pathTooltip.id = '__flowx_picker_path_tooltip';
  pathTooltip.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(15,23,42,0.95);color:#e2e8f0;padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.35);border:1px solid #334155;max-width:90vw;max-height:50vh;overflow-y:auto;pointer-events:none;display:none;backdrop-filter:blur(8px);scrollbar-width:thin;scrollbar-color:#475569 #1e293b;';
  document.body.appendChild(pathTooltip);

  // 底部提示栏
  var infoBar = document.createElement('div');
  infoBar.id = '__flowx_picker_info';
  infoBar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#0f172a;color:#fff;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 -4px 20px rgba(0,0,0,0.3);';
  infoBar.innerHTML = \`
    <div style="display:flex;align-items:center;gap:16px;">
      <span style="font-weight:600;font-size:14px;">🎯 拾取${label}元素</span>
      <span style="opacity:0.7;">${mode === 'multi' ? '多选模式：点击多个同类元素' : '单选模式：点击目标元素'}</span>
      <span id="__flowx_picker_count" style="background:#334155;padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer;position:relative;transition:background 0.2s;">已选 0 个</span>
    </div>
    <div style="display:flex;align-items:center;gap:16px;">
      <span style="opacity:0.6;font-size:12px;">右键选层级 · ↑ 父元素 ↓ 子元素 ← 上一个 → 下一个</span>
      ${mode === 'multi' ? '<button id="__flowx_picker_confirm" style="background:#22c55e;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">确认选择 (Enter)</button>' : ''}
      <button id="__flowx_picker_cancel" style="background:#475569;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">取消 (ESC)</button>
    </div>
  \`;
  document.body.appendChild(infoBar);

  // 已选元素预览面板
  var selectedPreview = document.createElement('div');
  selectedPreview.id = '__flowx_picker_selected_preview';
  selectedPreview.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:2147483646;background:#1e293b;color:#f1f5f9;padding:12px;border-radius:12px;box-shadow:0 -8px 30px rgba(0,0,0,0.35);border:1px solid #334155;display:none;backdrop-filter:blur(8px);max-width:90vw;max-height:60vh;overflow-y:auto;';
  document.body.appendChild(selectedPreview);

  // 右键菜单
  var contextMenu = document.createElement('div');
  contextMenu.id = '__flowx_picker_context_menu';
  contextMenu.style.cssText = 'position:fixed;z-index:2147483647;background:#1e293b;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,0.4);border:1px solid #334155;padding:6px;min-width:300px;max-width:400px;display:none;backdrop-filter:blur(8px);';
  contextMenu.innerHTML = \`
    <div style="padding:6px 12px;font-size:11px;opacity:0.5;text-transform:uppercase;letter-spacing:0.5px;">选择层级</div>
    <div id="__flowx_menu_ancestors" style="max-height:300px;overflow-y:auto;margin:4px 0;border-top:1px solid #334155;border-bottom:1px solid #334155;"></div>
    <div style="padding:6px 12px;font-size:11px;opacity:0.5;text-transform:uppercase;letter-spacing:0.5px;">快捷选择</div>
    <div class="__flowx_menu_item __flowx_quick_item" data-action="short" style="padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;">
      <span style="color:#22c55e;font-size:14px;">⚡</span>
      <span style="flex:1;">简化路径</span>
      <span id="__flowx_menu_short_path" style="font-size:11px;opacity:0.5;font-family:ui-monospace,monospace;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
    </div>
    <div class="__flowx_menu_item __flowx_quick_item" data-action="full" style="padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;">
      <span style="color:#3b82f6;font-size:14px;">🔗</span>
      <span style="flex:1;">完整路径</span>
      <span id="__flowx_menu_full_path" style="font-size:11px;opacity:0.5;font-family:ui-monospace,monospace;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
    </div>
    <div style="height:1px;background:#334155;margin:4px 0;"></div>
    <div class="__flowx_menu_item" data-action="inspect" style="padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;">
      <span style="font-size:14px;">🔍</span>
      <span>检查元素 (DevTools)</span>
    </div>
    <div class="__flowx_menu_item" data-action="cancel" style="padding:8px 12px;border-radius:6px;cursor:pointer;opacity:0.6;">
      取消 (ESC)
    </div>
  \`;
  document.body.appendChild(contextMenu);

  // ========== 工具函数 ==========

  function updateOverlay(el, overlay, color) {
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  // 刷新所有高亮框位置（滚动时调用）
  function refreshAllOverlays() {
    if (hoverEl) updateOverlay(hoverEl, hoverOverlay, 'blue');
    if (navEl) updateOverlay(navEl, hoverOverlay, 'blue');
    if (selectedElements.length > 0) updateSelectedOverlay();
    if (selectedElements.length >= 2) {
      var commonSel = inferCommonSelector(selectedElements);
      highlightMatches(commonSel);
    }
    if ((hoverEl || navEl) && pathTooltip.style.display !== 'none') {
      updatePathTooltip(hoverEl || navEl);
    }
  }

  // 更新路径 tooltip（层级列表形式）
  function updatePathTooltip(el) {
    if (!el || el === document.body || el === document.documentElement) {
      pathTooltip.style.display = 'none';
      return;
    }
    var chain = getAncestorChain(el);
    if (chain.length === 0) {
      pathTooltip.style.display = 'none';
      return;
    }

    var html = '';
    for (var i = 0; i < chain.length; i++) {
      var ancestor = chain[i];
      var label = getElementLabel(ancestor);
      var indent = i * 16;
      var isLast = i === chain.length - 1;
      var bgColor = isLast ? 'rgba(59,130,246,0.15)' : 'transparent';
      var textColor = isLast ? '#93c5fd' : '#94a3b8';
      var fontWeight = isLast ? '600' : '400';
      var prefix = isLast ? '▶ ' : '  ';
      html += '<div style="padding:3px 12px 3px ' + (12 + indent) + 'px;background:' + bgColor + ';color:' + textColor + ';font-weight:' + fontWeight + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + prefix + label + '</div>';
    }
    pathTooltip.innerHTML = html;
    pathTooltip.style.display = 'block';

    var rect = el.getBoundingClientRect();
    var tooltipRect = pathTooltip.getBoundingClientRect();
    var top = rect.top - tooltipRect.height - 8;
    var left = rect.left;

    if (top < 8) {
      top = rect.bottom + 8;
    }
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tooltipRect.width - 8;
    }
    if (left < 8) left = 8;

    pathTooltip.style.top = top + 'px';
    pathTooltip.style.left = left + 'px';
  }

  // 滚动时刷新位置（使用 requestAnimationFrame 节流）
  var scrollRafId = null;
  function onScroll() {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(function() {
      scrollRafId = null;
      refreshAllOverlays();
    });
  }

  // 生成单个元素的唯一选择器（完整路径）
  function getFullSelector(el) {
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

  // 生成单个元素的简化选择器（最短唯一路径）
  function getShortSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);

    var candidates = [];

    var cur = el;
    var depth = 0;
    var maxDepth = 5;

    while (cur && cur.nodeType === 1 && cur !== document.body && depth < maxDepth) {
      var parts = [];
      var temp = el;
      var levels = 0;

      while (temp && temp !== cur && temp !== document.body) {
        var sel = temp.tagName.toLowerCase();
        if (temp.className && typeof temp.className === 'string') {
          var classes = temp.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); });
          if (classes.length > 0) {
            sel += '.' + classes.map(function(c) { return CSS.escape(c); }).slice(0, 2).join('.');
          }
        }
        parts.unshift(sel);
        temp = temp.parentElement;
        levels++;
      }

      if (cur.className && typeof cur.className === 'string') {
        var curClasses = cur.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); });
        if (curClasses.length > 0) {
          var parentSel = cur.tagName.toLowerCase() + '.' + curClasses.map(function(c) { return CSS.escape(c); }).slice(0, 2).join('.');
          var fullSel = parentSel + ' ' + parts.join(' ');
          candidates.push(fullSel);

          if (curClasses.length >= 1) {
            var singleClassSel = '.' + CSS.escape(curClasses[0]) + ' ' + parts.join(' ');
            candidates.push(singleClassSel);
          }
        }
      }

      if (depth === 0 && cur.className && typeof cur.className === 'string') {
        var elClasses = cur.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); });
        for (var i = 0; i < Math.min(elClasses.length, 3); i++) {
          candidates.push('.' + CSS.escape(elClasses[i]));
        }
        if (elClasses.length >= 2) {
          candidates.push('.' + elClasses.slice(0, 2).map(function(c) { return CSS.escape(c); }).join('.'));
        }
      }

      cur = cur.parentElement;
      depth++;
    }

    candidates.sort(function(a, b) { return a.length - b.length; });

    for (var i = 0; i < candidates.length; i++) {
      try {
        var matched = document.querySelectorAll(candidates[i]);
        if (matched.length === 1 && matched[0] === el) {
          return candidates[i];
        }
      } catch (e) {}
    }

    return getFullSelector(el);
  }

  // 图片模式下的智能选择器：
  // - 如果目标是 img，直接返回其选择器
  // - 如果目标不是 img 但包含后代 img，返回「目标选择器 img」
  // - 否则返回普通选择器
  function getImageAwareSelector(el) {
    if (!el) return '';
    if (currentFieldType !== 'image') {
      return getShortSelector(el);
    }
    if (el.tagName === 'IMG') {
      return getShortSelector(el);
    }
    var imgs = el.querySelectorAll('img');
    if (imgs.length > 0) {
      return getShortSelector(el) + ' img';
    }
    return getShortSelector(el);
  }

  // 兼容旧调用
  function getUniqueSelector(el) {
    return getShortSelector(el);
  }

  // 获取元素的祖先链（从最外层父级到当前元素）
  function getAncestorChain(el) {
    var chain = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      chain.unshift(cur);
      cur = cur.parentElement;
    }
    return chain;
  }

  // 获取单个元素的简短选择器表示（用于层级显示）
  function getElementLabel(el) {
    var label = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var classes = el.className.trim().split(/\\s+/).filter(function(c) { return c && !/^\\d/.test(c); });
      if (classes.length > 0) {
        label += '.' + classes.slice(0, 2).join('.');
      }
    }
    return label;
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
    if (e.target === contextMenu || e.target.closest('#__flowx_picker_context_menu')) return;
    if (contextMenu.style.display !== 'none') return;
    hoverEl = e.target;
    updateOverlay(hoverEl, hoverOverlay, 'blue');
    updatePathTooltip(hoverEl);
  }

  function onClick(e) {
    if (e.target === infoBar || e.target.closest('#__flowx_picker_info')) {
      return;
    }
    if (e.target === selectedPreview || e.target.closest('#__flowx_picker_selected_preview')) {
      return;
    }
    if (e.target === contextMenu || e.target.closest('#__flowx_picker_context_menu')) {
      e.preventDefault();
      e.stopPropagation();
      handleContextMenuClick(e);
      return;
    }
    if (contextMenu.style.display !== 'none') {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    var target = e.target;
    if (!target || target === document.body) return;

    if (currentMode === 'single') {
      var selector = getImageAwareSelector(target);
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
    updateSelectedPreview();
  }

  // 更新已选元素预览面板
  function updateSelectedPreview() {
    if (selectedElements.length === 0) {
      selectedPreview.style.display = 'none';
      return;
    }

    var isImageType = currentFieldType === 'image';
    var html = '<div style="font-size:12px;opacity:0.6;margin-bottom:8px;">已选 ' + selectedElements.length + ' 个元素</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;">';

    for (var i = 0; i < selectedElements.length; i++) {
      var el = selectedElements[i];
      var thumb = '';
      var label = '';

      if (isImageType) {
        var img = el.tagName === 'IMG' ? el : el.querySelector('img');
        if (img && img.src) {
          thumb = '<img src="' + img.src + '" style="width:100%;height:80px;object-fit:cover;border-radius:6px;display:block;">';
        } else {
          var bgImage = window.getComputedStyle(el).backgroundImage;
          if (bgImage && bgImage !== 'none') {
            var urlMatch = bgImage.match(/url\\(["']?([^"']+)["']?\\)/);
            if (urlMatch && urlMatch[1]) {
              thumb = '<img src="' + urlMatch[1] + '" style="width:100%;height:80px;object-fit:cover;border-radius:6px;display:block;">';
            }
          }
        }
        label = (el.alt || img && img.alt || '图片 ' + (i + 1)).slice(0, 20);
      } else {
        var text = (el.textContent || '').trim().slice(0, 20);
        thumb = '<div style="width:100%;height:80px;background:#334155;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;opacity:0.6;padding:4px;overflow:hidden;">' + (text || '元素 ' + (i + 1)) + '</div>';
        label = getElementLabel(el);
      }

      html += '<div data-idx="' + i + '" class="__flowx_preview_item" style="cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid transparent;transition:border-color 0.15s;">' +
        (thumb || '<div style="width:100%;height:80px;background:#334155;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;opacity:0.6;">无预览</div>') +
        '<div style="font-size:10px;padding:4px;opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-family:ui-monospace,monospace;">' + label + '</div>' +
        '</div>';
    }

    html += '</div>';
    html += '<div style="font-size:11px;opacity:0.4;margin-top:8px;text-align:center;">点击可移除</div>';
    selectedPreview.innerHTML = html;

    var previewItems = selectedPreview.querySelectorAll('.__flowx_preview_item');
    previewItems.forEach(function(item, idx) {
      item.addEventListener('mouseenter', function() {
        item.style.borderColor = '#22c55e';
        var el = selectedElements[idx];
        if (el) updateOverlay(el, selectedOverlay, 'green');
      });
      item.addEventListener('mouseleave', function() {
        item.style.borderColor = 'transparent';
        if (selectedElements.length > 0) {
          updateOverlay(selectedElements[selectedElements.length - 1], selectedOverlay, 'green');
        } else {
          selectedOverlay.style.display = 'none';
        }
      });
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        selectedElements.splice(idx, 1);
        updateSelectedCount();
        updateSelectedOverlay();
        if (selectedElements.length >= 2) {
          var commonSel = inferCommonSelector(selectedElements);
          highlightMatches(commonSel);
        } else {
          matchOverlay.style.display = 'none';
        }
      });
    });
  }

  // 显示/隐藏已选预览
  function showSelectedPreview() {
    if (selectedElements.length > 0) {
      selectedPreview.style.display = 'block';
    }
  }

  function hideSelectedPreview() {
    selectedPreview.style.display = 'none';
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
      if (contextMenu.style.display !== 'none') {
        hideContextMenu();
        return;
      }
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
    var selector = getImageAwareSelector(target);
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
      updatePathTooltip(navEl);
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

  // 滚动到视图中（仅在元素顶部不可见时滚动到顶部对齐）
  function scrollIntoViewIfNeeded(el) {
    var rect = el.getBoundingClientRect();
    var infoBarHeight = infoBar.offsetHeight || 50;

    if (rect.top < 0) {
      window.scrollBy({ top: rect.top - 10, behavior: 'smooth' });
    } else if (rect.bottom > window.innerHeight - infoBarHeight && rect.top > window.innerHeight / 2) {
      window.scrollBy({ top: rect.top - 10, behavior: 'smooth' });
    }
  }

  // ========== 右键菜单 ==========

  var contextMenuTarget = null;
  var menuAncestors = [];  // 层级元素数组
  var contextMenuPos = { x: 0, y: 0 };  // 右键点击坐标

  function onContextMenu(e) {
    if (e.target === infoBar || e.target.closest('#__flowx_picker_info')) return;
    if (e.target === contextMenu || e.target.closest('#__flowx_picker_context_menu')) return;
    e.preventDefault();
    e.stopPropagation();

    var target = e.target;
    if (!target || target === document.body || target === document.documentElement) return;

    contextMenuTarget = target;
    menuAncestors = getAncestorChain(target);
    contextMenuPos = { x: e.clientX, y: e.clientY };

    var ancestorsContainer = document.getElementById('__flowx_menu_ancestors');
    if (ancestorsContainer) {
      var isImageMode = currentFieldType === 'image';
      var html = '';
      for (var i = 0; i < menuAncestors.length; i++) {
        var ancestor = menuAncestors[i];
        var label = getElementLabel(ancestor);
        var indent = i * 16;
        var isLast = i === menuAncestors.length - 1;
        var prefixIcon = isLast ? '🎯' : '└';
        var imgBadge = '';
        if (isImageMode) {
          var imgCount = ancestor.querySelectorAll('img').length;
          if (imgCount > 0) {
            imgBadge = '<span class="__flowx_ancestor_img_btn" data-ancestor-img="' + i + '" style="font-size:10px;opacity:0.7;background:#1e3a5f;color:#93c5fd;padding:2px 6px;border-radius:4px;cursor:pointer;flex-shrink:0;white-space:nowrap;" title="以此层级为容器，获取所有后代 img">🖼️ ' + imgCount + '张</span>';
          }
        }
        html += '<div class="__flowx_menu_item __flowx_ancestor_item" data-ancestor-index="' + i + '" style="padding:6px 12px 6px ' + (12 + indent) + 'px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:ui-monospace,monospace;font-size:12px;">' +
          '<span style="font-size:10px;opacity:0.5;width:16px;">' + prefixIcon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span>' +
          imgBadge +
          '<span style="font-size:10px;opacity:0.4;">L' + (i + 1) + '</span>' +
          '</div>';
      }
      ancestorsContainer.innerHTML = html;

      var ancestorItems = ancestorsContainer.querySelectorAll('.__flowx_ancestor_item');
      ancestorItems.forEach(function(item, idx) {
        item.addEventListener('mouseenter', function() {
          item.style.backgroundColor = '#334155';
          var el = menuAncestors[idx];
          if (el) {
            updateOverlay(el, hoverOverlay, 'blue');
          }
        });
        item.addEventListener('mouseleave', function() {
          item.style.backgroundColor = '';
          if (contextMenuTarget) {
            updateOverlay(contextMenuTarget, hoverOverlay, 'blue');
          }
        });
      });

      var imgBtns = ancestorsContainer.querySelectorAll('.__flowx_ancestor_img_btn');
      imgBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(btn.getAttribute('data-ancestor-img'), 10);
          confirmAncestorImgSelector(idx);
        });
        btn.addEventListener('mouseenter', function(e) {
          e.stopPropagation();
          var idx = parseInt(btn.getAttribute('data-ancestor-img'), 10);
          var ancestor = menuAncestors[idx];
          if (ancestor) {
            var firstImg = ancestor.querySelector('img');
            if (firstImg) {
              updateOverlay(firstImg, matchOverlay, 'purple');
            }
          }
        });
        btn.addEventListener('mouseleave', function(e) {
          e.stopPropagation();
          matchOverlay.style.display = 'none';
        });
      });
    }

    var shortPathEl = document.getElementById('__flowx_menu_short_path');
    var fullPathEl = document.getElementById('__flowx_menu_full_path');
    if (shortPathEl) shortPathEl.textContent = getShortSelector(target);
    if (fullPathEl) fullPathEl.textContent = getFullSelector(target);

    contextMenu.style.display = 'block';

    var menuRect = contextMenu.getBoundingClientRect();
    var x = e.clientX;
    var y = e.clientY;

    if (x + menuRect.width > window.innerWidth - 8) {
      x = window.innerWidth - menuRect.width - 8;
    }
    if (y + menuRect.height > window.innerHeight - 8) {
      y = window.innerHeight - menuRect.height - 8;
    }
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';

    pathTooltip.style.display = 'none';
  }

  function hideContextMenu() {
    contextMenu.style.display = 'none';
    contextMenuTarget = null;
    menuAncestors = [];
    contextMenuPos = { x: 0, y: 0 };
  }

  function handleContextMenuClick(e) {
    e.stopPropagation();
    e.preventDefault();

    var item = e.target.closest('.__flowx_menu_item');
    if (!item) return;

    var ancestorIndex = item.getAttribute('data-ancestor-index');
    if (ancestorIndex !== null) {
      var idx = parseInt(ancestorIndex, 10);
      var el = menuAncestors[idx];
      if (el) {
        if (currentFieldType === 'image') {
          var imgCount = el.querySelectorAll('img').length;
          if (imgCount > 0) {
            confirmAncestorImgSelector(idx);
          } else {
            confirmWithElement(el);
          }
        } else {
          confirmWithElement(el);
        }
      }
      return;
    }

    var action = item.getAttribute('data-action');
    if (!action || !contextMenuTarget) {
      hideContextMenu();
      return;
    }

    if (action === 'short') {
      confirmWithSelector(getShortSelector(contextMenuTarget), contextMenuTarget);
    } else if (action === 'full') {
      confirmWithSelector(getFullSelector(contextMenuTarget), contextMenuTarget);
    } else if (action === 'inspect') {
      notifyInspect(contextMenuPos.x, contextMenuPos.y);
      hideContextMenu();
    } else {
      hideContextMenu();
    }
  }

  // 使用指定祖先层级作为容器 + 后代 img 的选择器
  function confirmAncestorImgSelector(ancestorIndex) {
    var ancestor = menuAncestors[ancestorIndex];
    if (!ancestor) return;
    var imgs = ancestor.querySelectorAll('img');
    if (imgs.length === 0) {
      hideContextMenu();
      return;
    }

    var parentSel = getShortSelector(ancestor);
    var imgSelector = parentSel + ' img';

    var matchCount = 0;
    try {
      matchCount = document.querySelectorAll(imgSelector).length;
    } catch (e) {
      matchCount = imgs.length;
    }

    if (currentMode === 'single') {
      var firstImg = imgs[0];
      var previewText = firstImg && firstImg.alt ? firstImg.alt : '';
      cleanup();
      notifyResult({
        pickerType: currentFieldType,
        selector: imgSelector,
        mode: 'single',
        selectedCount: 1,
        matchCount: matchCount,
        previewText: previewText,
      });
    } else {
      selectedElements = Array.from(imgs);
      updateSelectedCount();
      updateSelectedOverlay();
      if (selectedElements.length >= 2) {
        var commonSel = imgSelector;
        highlightMatches(commonSel);
      }
      hideContextMenu();
    }
  }

  function confirmWithElement(el) {
    if (!el) return;
    var selector = getImageAwareSelector(el);
    confirmWithSelector(selector, el);
  }

  function confirmWithSelector(selector, targetEl) {
    var target = targetEl || contextMenuTarget;
    if (!target) return;

    if (currentMode === 'single') {
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
      var idx = selectedElements.indexOf(target);
      if (idx >= 0) {
        selectedElements.splice(idx, 1);
      } else {
        selectedElements.push(target);
      }
      updateSelectedCount();
      updateSelectedOverlay();
      if (selectedElements.length >= 2) {
        var commonSel = inferCommonSelector(selectedElements);
        highlightMatches(commonSel);
      } else {
        matchOverlay.style.display = 'none';
      }
      hideContextMenu();
    }
  }

  function confirmSelection() {
    if (selectedElements.length === 0) {
      cleanup();
      notifyCancel();
      return;
    }

    // 图片模式：将所有选中元素展开为实际的 img 元素
    var finalElements = selectedElements;
    if (currentFieldType === 'image') {
      var allImgs = [];
      var seen = new Set();
      for (var i = 0; i < selectedElements.length; i++) {
        var el = selectedElements[i];
        if (el.tagName === 'IMG') {
          if (!seen.has(el)) {
            seen.add(el);
            allImgs.push(el);
          }
        } else {
          var imgs = el.querySelectorAll('img');
          for (var j = 0; j < imgs.length; j++) {
            if (!seen.has(imgs[j])) {
              seen.add(imgs[j]);
              allImgs.push(imgs[j]);
            }
          }
        }
      }
      if (allImgs.length > 0) {
        finalElements = allImgs;
      }
    }

    var commonSel = inferCommonSelector(finalElements);
    var matchCount = 0;
    try {
      matchCount = document.querySelectorAll(commonSel).length;
    } catch (e) {
      matchCount = finalElements.length;
    }

    var previewText = finalElements[0] ? (finalElements[0].textContent || '').trim().slice(0, 80) : '';

    cleanup();
    notifyResult({
      pickerType: currentFieldType,
      selector: commonSel,
      mode: 'multi',
      selectedCount: finalElements.length,
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

  function notifyInspect(x, y) {
    console.log('__FLOWX_PICKER_INSPECT__:' + JSON.stringify({ x: x, y: y }));
    document.dispatchEvent(new CustomEvent('flowx:picker-inspect', { detail: { x: x, y: y } }));
  }

  // ========== 清理 ==========

  function cleanup() {
    window.__flowx_picker_active = false;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    if (scrollRafId) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    if (hoverOverlay.parentNode) hoverOverlay.parentNode.removeChild(hoverOverlay);
    if (selectedOverlay.parentNode) selectedOverlay.parentNode.removeChild(selectedOverlay);
    if (matchOverlay.parentNode) matchOverlay.parentNode.removeChild(matchOverlay);
    if (pathTooltip.parentNode) pathTooltip.parentNode.removeChild(pathTooltip);
    if (infoBar.parentNode) infoBar.parentNode.removeChild(infoBar);
    if (selectedPreview.parentNode) selectedPreview.parentNode.removeChild(selectedPreview);
    if (contextMenu.parentNode) contextMenu.parentNode.removeChild(contextMenu);
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
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);

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

  // 已选计数按钮 hover 显示预览
  var countBtn = document.getElementById('__flowx_picker_count');
  if (countBtn) {
    countBtn.addEventListener('mouseenter', function() {
      countBtn.style.backgroundColor = '#475569';
      showSelectedPreview();
    });
    countBtn.addEventListener('mouseleave', function() {
      countBtn.style.backgroundColor = '';
      setTimeout(function() {
        if (!selectedPreview.matches(':hover')) {
          hideSelectedPreview();
        }
      }, 150);
    });
  }

  // 预览面板 hover 保持显示
  selectedPreview.addEventListener('mouseenter', function() {
    selectedPreview.style.display = 'block';
  });
  selectedPreview.addEventListener('mouseleave', function() {
    hideSelectedPreview();
  });

  // 右键菜单项 hover 效果
  var menuItems = contextMenu.querySelectorAll('.__flowx_menu_item');
  menuItems.forEach(function(item) {
    item.addEventListener('mouseenter', function() {
      item.style.backgroundColor = '#334155';
    });
    item.addEventListener('mouseleave', function() {
      item.style.backgroundColor = '';
    });
  });

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
