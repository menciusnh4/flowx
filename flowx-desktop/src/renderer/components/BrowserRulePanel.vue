<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { electronApi } from '../utils/electron'
import SiteRuleEditor from './SiteRuleEditor.vue'
import type { CustomSiteRule, RuleDraft, PickerFieldType, ExtractedContent } from '../../types'

const props = defineProps<{
  currentUrl: string
  viewId: string | null
  draft: RuleDraft | null
  pickerActive: boolean
  currentPickerField: PickerFieldType | null
}>()

const emit = defineEmits<{
  (e: 'start-picker', fieldType: PickerFieldType, mode: 'single' | 'multi'): void
  (e: 'test-draft'): void
  (e: 'save-draft'): void
  (e: 'cancel-draft'): void
  (e: 'open-editor'): void
  (e: 'apply-rule', payload: { rule: CustomSiteRule; result: ExtractedContent }): void
}>()

const rules = ref<CustomSiteRule[]>([])
const loading = ref(false)
const keyword = ref('')

// 编辑器
const editorVisible = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingRule = ref<CustomSiteRule | null>(null)
const presetDomain = ref('')

// 匹配当前网站的规则
const matchedRules = computed(() => {
  if (!props.currentUrl) return []
  try {
    const hostname = new URL(props.currentUrl).hostname
    return rules.value.filter(r => {
      if (!r.enabled) return false
      if (r.matchType === 'domain') {
        return hostname.includes(r.matchValue)
      } else if (r.matchType === 'regex') {
        try {
          const regex = new RegExp(r.matchValue, 'i')
          return regex.test(props.currentUrl)
        } catch {
          return false
        }
      }
      return false
    })
  } catch {
    return []
  }
})

// 其他规则
const otherRules = computed(() => {
  const matchedIds = new Set(matchedRules.value.map(r => r.id))
  let result = rules.value.filter(r => !matchedIds.has(r.id))
  if (keyword.value.trim()) {
    const kw = keyword.value.trim().toLowerCase()
    result = result.filter(r =>
      r.name.toLowerCase().includes(kw) ||
      r.matchValue.toLowerCase().includes(kw)
    )
  }
  return result
})

// 已拾取字段数量
const pickedCount = computed(() => {
  if (!props.draft) return 0
  let count = 0
  if (props.draft.titleSelector) count++
  if (props.draft.contentSelector) count++
  if (props.draft.imageSelector) count++
  if (props.draft.tagsSelector) count++
  if (props.draft.bylineSelector) count++
  if (props.draft.dateSelector) count++
  if (props.draft.removeSelectors.length > 0) count++
  return count
})

// 加载规则
async function loadRules() {
  loading.value = true
  try {
    rules.value = await electronApi.browser.listCustomRules()
  } catch (e: any) {
    ElMessage.error(e.message || '加载规则失败')
  } finally {
    loading.value = false
  }
}

// 获取当前域名
function getCurrentDomain(): string {
  if (!props.currentUrl) return ''
  try {
    return new URL(props.currentUrl).hostname
  } catch {
    return ''
  }
}

// 新建规则（自动填充当前域名）
function openCreate() {
  editingRule.value = null
  editorMode.value = 'create'
  presetDomain.value = getCurrentDomain()
  editorVisible.value = true
}

// 编辑规则
function openEdit(rule: CustomSiteRule) {
  editingRule.value = rule
  editorMode.value = 'edit'
  presetDomain.value = ''
  editorVisible.value = true
}

// 切换启用
async function toggleRule(rule: CustomSiteRule) {
  try {
    await electronApi.browser.toggleCustomRule(rule.id)
    await loadRules()
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败')
  }
}

// 删除规则
async function deleteRule(rule: CustomSiteRule) {
  try {
    await ElMessageBox.confirm(`确定删除规则"${rule.name}"吗？`, '确认删除', {
      type: 'warning',
    })
    await electronApi.browser.deleteCustomRule(rule.id)
    ElMessage.success('删除成功')
    await loadRules()
  } catch (e: any) {
    if (e !== 'cancel') {
      ElMessage.error(e.message || '删除失败')
    }
  }
}

// 应用规则到当前页面
async function applyRule(rule: CustomSiteRule) {
  if (!props.viewId) {
    ElMessage.warning('当前没有打开的页面')
    return
  }
  try {
    const result = await electronApi.browser.applyCustomRule(props.viewId, rule.id)
    if (result) {
      emit('apply-rule', { rule, result })
    } else {
      ElMessage.warning('该规则在此页面未提取到有效内容')
    }
  } catch (e: any) {
    ElMessage.error(e.message || '提取失败')
  }
}

// 保存成功回调
function onSaved() {
  loadRules()
}

// 获取字段标签
function getFieldLabel(field: PickerFieldType): string {
  const map: Record<PickerFieldType, string> = {
    content: '正文',
    title: '标题',
    image: '图片',
    tags: '标签',
    byline: '作者',
    date: '日期',
    remove: '排除元素',
  }
  return map[field] || field
}

// 拾取字段列表
const pickerFields: { key: PickerFieldType; label: string; mode: 'single' | 'multi'; icon: string }[] = [
  { key: 'title', label: '标题', mode: 'single', icon: 'Edit' },
  { key: 'content', label: '正文', mode: 'single', icon: 'Document' },
  { key: 'image', label: '图片', mode: 'multi', icon: 'Picture' },
  { key: 'tags', label: '标签', mode: 'multi', icon: 'PriceTag' },
  { key: 'byline', label: '作者', mode: 'single', icon: 'User' },
  { key: 'date', label: '日期', mode: 'single', icon: 'Calendar' },
  { key: 'remove', label: '排除元素', mode: 'multi', icon: 'Close' },
]

// 组件挂载时加载规则
onMounted(() => {
  loadRules()
})
</script>

<template>
  <div class="rule-panel">
    <!-- 草稿模式 -->
    <div v-if="draft" class="draft-section">
      <div class="draft-header">
        <div class="draft-title">
          <el-icon color="#409eff"><MagicStick /></el-icon>
          <span>快速拾取模式</span>
          <el-tag size="small" type="info">{{ pickedCount }} 个字段</el-tag>
        </div>
        <el-button size="small" text type="danger" @click="emit('cancel-draft')">
          取消
        </el-button>
      </div>

      <div class="draft-name">
        <el-input
          :model-value="draft.name"
          placeholder="规则名称（如：xxx文章提取）"
          size="small"
          @input="(v) => { if (draft) draft.name = v as string }"
        />
      </div>

      <!-- 拾取字段按钮 -->
      <div class="picker-buttons">
        <div
          v-for="field in pickerFields"
          :key="field.key"
          class="picker-btn"
          :class="{
            active: currentPickerField === field.key,
            picked: (draft as any)[field.key] || (field.key === 'remove' && draft.removeSelectors.length > 0),
          }"
          @click="emit('start-picker', field.key, field.mode)"
        >
          <span class="picker-label">{{ field.label }}</span>
          <span class="picker-status">
            <template v-if="(draft as any)[field.key] || (field.key === 'remove' && draft.removeSelectors.length > 0)">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
            </template>
            <template v-else-if="currentPickerField === field.key">
              <el-icon class="picking"><Aim /></el-icon>
            </template>
            <template v-else>
              <el-icon color="#c0c4cc"><Plus /></el-icon>
            </template>
          </span>
        </div>
      </div>

      <!-- 已拾取的选择器预览 -->
      <div v-if="pickedCount > 0" class="picked-preview">
        <div
          v-for="field in pickerFields"
          :key="'prev-' + field.key"
          v-show="(draft as any)[field.key] || (field.key === 'remove' && draft.removeSelectors.length > 0)"
          class="picked-item"
        >
          <span class="picked-label">{{ field.label }}：</span>
          <code class="picked-selector">
            {{ field.key === 'remove' ? draft.removeSelectors.join(', ') : (draft as any)[field.key] }}
          </code>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="draft-actions">
        <el-button size="small" @click="emit('open-editor')">
          <el-icon><Setting /></el-icon>&nbsp;完整编辑
        </el-button>
        <el-button size="small" type="warning" @click="emit('test-draft')" :disabled="!draft.contentSelector">
          <el-icon><View /></el-icon>&nbsp;测试提取
        </el-button>
        <el-button size="small" type="primary" @click="emit('save-draft')" :disabled="!draft.contentSelector">
          <el-icon><Check /></el-icon>&nbsp;保存规则
        </el-button>
      </div>

      <!-- 提示信息 -->
      <div v-if="pickerActive" class="picker-tip">
        <el-icon color="#e6a23c"><Warning /></el-icon>
        <span>请在浏览器页面点击选择{{ currentPickerField ? getFieldLabel(currentPickerField) : '元素' }}，按 Esc 取消</span>
      </div>
    </div>

    <!-- 顶部操作区 -->
    <div class="panel-actions">
      <el-input
        v-model="keyword"
        placeholder="搜索规则..."
        size="small"
        clearable
        style="flex: 1"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" size="small" @click="openCreate">
        <el-icon><Plus /></el-icon>&nbsp;新建
      </el-button>
    </div>

    <!-- 当前网站匹配 -->
    <div v-if="matchedRules.length > 0" class="rule-section">
      <div class="section-title">
        <el-icon color="#67c23a"><CircleCheck /></el-icon>
        <span>当前网站匹配 ({{ matchedRules.length }})</span>
      </div>
      <div class="rule-list">
        <div
          v-for="rule in matchedRules"
          :key="rule.id"
          class="rule-card matched"
        >
          <div class="rule-card-header">
            <span class="rule-name">{{ rule.name }}</span>
            <el-tag size="small" effect="dark" type="success">匹配</el-tag>
          </div>
          <div class="rule-card-meta">
            <el-tag size="small" :type="rule.matchType === 'domain' ? 'info' : 'warning'">
              {{ rule.matchType === 'domain' ? '域名' : '正则' }}
            </el-tag>
            <code class="match-value">{{ rule.matchValue }}</code>
          </div>
          <div class="rule-card-meta">
            <span class="meta-label">类型：</span>
            <span class="meta-value">
              {{ rule.contentTypes && rule.contentTypes.length > 0 ? rule.contentTypes.join(' / ') : '通用' }}
            </span>
          </div>
          <div class="rule-card-actions">
            <el-button size="small" type="primary" @click="applyRule(rule)">
              <el-icon><MagicStick /></el-icon>&nbsp;应用提取
            </el-button>
            <el-button size="small" @click="openEdit(rule)">编辑</el-button>
            <el-button size="small" :type="rule.enabled ? 'warning' : 'success'" @click="toggleRule(rule)">
              {{ rule.enabled ? '禁用' : '启用' }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 无匹配提示 -->
    <div v-if="matchedRules.length === 0 && currentUrl && !draft" class="no-match-hint">
      <el-icon color="#e6a23c"><Warning /></el-icon>
      <span>当前网站暂无匹配规则</span>
      <el-button type="primary" size="small" link @click="openCreate">
        为本站创建规则
      </el-button>
    </div>

    <!-- 全部规则 -->
    <div class="rule-section">
      <div class="section-title">
        <el-icon color="#909399"><Collection /></el-icon>
        <span>全部规则 ({{ otherRules.length }})</span>
      </div>

      <div v-loading="loading" class="rule-list">
        <div
          v-for="rule in otherRules"
          :key="rule.id"
          class="rule-card"
          :class="{ disabled: !rule.enabled }"
        >
          <div class="rule-card-header">
            <span class="rule-name">{{ rule.name }}</span>
            <el-tag v-if="!rule.enabled" size="small" type="info">已禁用</el-tag>
          </div>
          <div class="rule-card-meta">
            <el-tag size="small" :type="rule.matchType === 'domain' ? 'info' : 'warning'">
              {{ rule.matchType === 'domain' ? '域名' : '正则' }}
            </el-tag>
            <code class="match-value">{{ rule.matchValue }}</code>
          </div>
          <div class="rule-card-meta">
            <span class="meta-label">类型：</span>
            <span class="meta-value">
              {{ rule.contentTypes && rule.contentTypes.length > 0 ? rule.contentTypes.join(' / ') : '通用' }}
            </span>
            <span class="meta-divider">|</span>
            <span class="meta-label">使用：</span>
            <span class="meta-value">{{ rule.useCount || 0 }} 次</span>
          </div>
          <div class="rule-card-actions">
            <el-button size="small" type="primary" @click="applyRule(rule)" :disabled="!rule.enabled">
              <el-icon><MagicStick /></el-icon>&nbsp;应用提取
            </el-button>
            <el-button size="small" @click="openEdit(rule)">编辑</el-button>
            <el-button size="small" :type="rule.enabled ? 'warning' : 'success'" @click="toggleRule(rule)">
              {{ rule.enabled ? '禁用' : '启用' }}
            </el-button>
            <el-button size="small" type="danger" @click="deleteRule(rule)">删除</el-button>
          </div>
        </div>

        <div v-if="otherRules.length === 0 && !loading" class="empty-hint">
          暂无规则
        </div>
      </div>
    </div>

    <!-- 规则编辑器 -->
    <SiteRuleEditor
      v-model="editorVisible"
      :mode="editorMode"
      :rule="editingRule"
      :view-id="viewId || undefined"
      :preset-domain="presetDomain"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.rule-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  gap: 12px;
  overflow-y: auto;
  box-sizing: border-box;
}

/* ========== 草稿模式 ========== */
.draft-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: #ecf5ff;
  border: 1px solid #b3d8ff;
  border-radius: 8px;
}

.draft-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: #409eff;
}

.draft-name {
  margin-top: 2px;
}

.picker-buttons {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.picker-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 12px;
}

.picker-btn:hover {
  border-color: #409eff;
  color: #409eff;
}

.picker-btn.active {
  background: #409eff;
  border-color: #409eff;
  color: #fff;
}

.picker-btn.picked {
  border-color: #67c23a;
  color: #67c23a;
}

.picker-btn.active.picked {
  background: #67c23a;
  border-color: #67c23a;
  color: #fff;
}

.picker-label {
  font-size: 12px;
}

.picker-status {
  font-size: 16px;
  display: flex;
  align-items: center;
}

.picking {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.picked-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: #fff;
  border-radius: 4px;
  max-height: 100px;
  overflow-y: auto;
}

.picked-item {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 11px;
}

.picked-label {
  color: #909399;
  flex-shrink: 0;
}

.picked-selector {
  font-family: monospace;
  font-size: 11px;
  color: #606266;
  background: #f5f7fa;
  padding: 1px 4px;
  border-radius: 3px;
  word-break: break-all;
  flex: 1;
}

.draft-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.picker-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #fdf6ec;
  border-radius: 4px;
  font-size: 12px;
  color: #e6a23c;
}

/* ========== 操作区 ========== */
.panel-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

/* ========== 规则分区 ========== */
.rule-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  padding-bottom: 4px;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}

.rule-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.rule-card {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
  transition: all 0.2s;
  flex-shrink: 0;
}

.rule-card:hover {
  border-color: #c0c4cc;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.rule-card.matched {
  border-color: #67c23a;
  background: #f0f9eb;
}

.rule-card.disabled {
  opacity: 0.6;
}

.rule-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.rule-name {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.rule-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #606266;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.match-value {
  font-family: monospace;
  font-size: 11px;
  background: #f5f7fa;
  padding: 1px 5px;
  border-radius: 3px;
  color: #606266;
}

.meta-label {
  color: #909399;
}

.meta-value {
  color: #606266;
}

.meta-divider {
  color: #dcdfe6;
}

.rule-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.no-match-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 8px;
  font-size: 13px;
  color: #e6a23c;
  flex-wrap: wrap;
}

.empty-hint {
  text-align: center;
  padding: 20px;
  color: #909399;
  font-size: 13px;
}
</style>
