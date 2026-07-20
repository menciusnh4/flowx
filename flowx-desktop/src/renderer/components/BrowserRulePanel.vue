<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { electronApi } from '../utils/electron'
import SiteRuleEditor from './SiteRuleEditor.vue'
import type { CustomSiteRule, ExtractedContent } from '../../types'

const props = defineProps<{
  currentUrl: string
  viewId: string | null
}>()

const emit = defineEmits<{
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
const deleteConfirmVisible = ref(false)
const ruleToDelete = ref<CustomSiteRule | null>(null)

function confirmDelete(rule: CustomSiteRule) {
  ruleToDelete.value = rule
  deleteConfirmVisible.value = true
}

async function doDelete() {
  if (!ruleToDelete.value) return
  try {
    await electronApi.browser.deleteCustomRule(ruleToDelete.value.id)
    ElMessage.success('删除成功')
    deleteConfirmVisible.value = false
    ruleToDelete.value = null
    await loadRules()
  } catch (e: any) {
    ElMessage.error(e.message || '删除失败')
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

// 暴露方法给父组件
defineExpose({
  openCreate,
  openEdit,
  loadRules,
})

// 组件挂载时加载规则
onMounted(() => {
  loadRules()
})
</script>

<template>
  <div class="rule-panel">
    <div class="panel-scroll-content">
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
    <div v-if="matchedRules.length === 0 && currentUrl" class="no-match-hint">
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
            <el-button size="small" type="danger" @click="confirmDelete(rule)">删除</el-button>
          </div>
        </div>

        <div v-if="otherRules.length === 0 && !loading" class="empty-hint">
          暂无规则
        </div>
      </div>
    </div>
    </div>

    <!-- 删除确认遮罩 -->
    <div v-if="deleteConfirmVisible" class="confirm-mask" @click.self="deleteConfirmVisible = false">
      <div class="confirm-box">
        <div class="confirm-header">
          <el-icon color="#f56c6c" size="22px"><Warning /></el-icon>
          <span class="confirm-title">确认删除</span>
        </div>
        <div class="confirm-body">
          确定删除规则"{{ ruleToDelete?.name }}"吗？
        </div>
        <div class="confirm-footer">
          <el-button size="small" @click="deleteConfirmVisible = false">取消</el-button>
          <el-button size="small" type="danger" @click="doDelete">删除</el-button>
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
  position: relative;
  box-sizing: border-box;
}

.panel-scroll-content {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
}

/* ========== 顶部操作区 ========== */
.panel-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* ========== 规则分区 ========== */
.rule-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #606266;
}

/* ========== 规则列表 ========== */
.rule-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-card {
  padding: 10px 12px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  background: #fff;
  transition: all 0.2s;
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
  color: #909399;
  margin-bottom: 4px;
  flex-wrap: wrap;
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

.match-value {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  padding: 1px 4px;
  background: #f5f7fa;
  border-radius: 3px;
  color: #606266;
}

.rule-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* ========== 无匹配提示 ========== */
.no-match-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  font-size: 13px;
  color: #e6a23c;
}

.no-match-hint .el-button {
  margin-left: auto;
}

/* ========== 空状态 ========== */
.empty-hint {
  text-align: center;
  padding: 20px;
  color: #c0c4cc;
  font-size: 13px;
}

/* ========== 删除确认框 ========== */
.confirm-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.confirm-box {
  width: 320px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.confirm-body {
  padding: 20px;
  font-size: 14px;
  color: #606266;
  line-height: 1.6;
}

.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
}
</style>
