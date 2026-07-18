<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { electronApi } from '../utils/electron'
import SiteRuleEditor from '../components/SiteRuleEditor.vue'
import type { CustomSiteRule } from '../../types'

const rules = ref<CustomSiteRule[]>([])
const loading = ref(false)

// 编辑器状态
const editorVisible = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingRule = ref<CustomSiteRule | null>(null)

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

// 新建规则
function openCreate() {
  editingRule.value = null
  editorMode.value = 'create'
  editorVisible.value = true
}

// 编辑规则
function openEdit(rule: CustomSiteRule) {
  editingRule.value = rule
  editorMode.value = 'edit'
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

// 保存成功回调
function onSaved() {
  loadRules()
}

// 格式化时间
function formatTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', { hour12: false })
}

// 获取类型标签
function getTypeTags(types: string[]): string {
  if (!types || types.length === 0) return '通用'
  const map: Record<string, string> = {
    'image-text': '图文',
    'video': '视频',
    'article': '文章',
  }
  return types.map(t => map[t] || t).join(' / ')
}

onMounted(() => {
  loadRules()
})
</script>

<template>
  <div>
    <div class="panel">
      <div class="panel-header">
        <h2 class="section-title">提取规则管理</h2>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>&nbsp;添加规则
        </el-button>
      </div>

      <p class="section-desc">
        自定义站点提取规则，优先级高于内置规则。可通过 CSS 选择器精确控制提取内容。
      </p>

      <el-table v-loading="loading" :data="rules" border stripe style="margin-top: 16px">
        <el-table-column label="规则名称" prop="name" min-width="180">
          <template #default="{ row }">
            <div class="rule-name">
              <el-icon v-if="row.enabled" color="#67c23a"><CircleCheck /></el-icon>
              <el-icon v-else color="#c0c4cc"><Close /></el-icon>
              <span>{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="匹配方式" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.matchType === 'domain' ? 'info' : 'warning'">
              {{ row.matchType === 'domain' ? '域名' : '正则' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="匹配值" prop="matchValue" min-width="180">
          <template #default="{ row }">
            <code class="match-value">{{ row.matchValue }}</code>
          </template>
        </el-table-column>

        <el-table-column label="适用类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">
              {{ getTypeTags(row.contentTypes) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="使用次数" width="100" align="center">
          <template #default="{ row }">
            {{ row.useCount || 0 }}
          </template>
        </el-table-column>

        <el-table-column label="最后使用" width="170">
          <template #default="{ row }">
            {{ formatTime(row.lastUsedAt) }}
          </template>
        </el-table-column>

        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openEdit(row as CustomSiteRule)">编辑</el-button>
            <el-button
              size="small"
              :type="row.enabled ? 'warning' : 'success'"
              link
              @click="toggleRule(row as CustomSiteRule)"
            >
              {{ row.enabled ? '禁用' : '启用' }}
            </el-button>
            <el-button size="small" type="danger" link @click="deleteRule(row as CustomSiteRule)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="rules.length === 0 && !loading" class="empty-hint">
        暂无自定义规则，点击右上角"添加规则"创建。
      </div>
    </div>

    <!-- 规则编辑器 -->
    <SiteRuleEditor
      v-model="editorVisible"
      :mode="editorMode"
      :rule="editingRule"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.rule-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.match-value {
  font-family: monospace;
  font-size: 12px;
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 4px;
  color: #606266;
}
</style>
