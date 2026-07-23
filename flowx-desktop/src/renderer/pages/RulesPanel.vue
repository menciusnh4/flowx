<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { electronApi } from '../utils/electron'
import SiteRuleEditor from '../components/SiteRuleEditor.vue'
import type { CustomSiteRule, PagedResult } from '../../types'
import ListPager from '../components/ListPager.vue'

// 列表走服务端分页，编辑器仍引用单条规则对象
const pagedResult = ref<PagedResult<CustomSiteRule>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 10,
  totalPages: 1,
})
const currentPage = ref(1)
const pageSize = ref(10)
const loading = ref(false)

// 编辑器状态
const editorVisible = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingRule = ref<CustomSiteRule | null>(null)

// 加载当前页（服务端分页），删除/编辑/切换后复用
async function loadRules() {
  await loadList(currentPage.value, pageSize.value)
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
    await loadList(1, pageSize.value)
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

// ============ 服务端分页（筛选下推主进程，列表走 queryRules） ============
/** 加载某一页（服务端分页）；越界页码回退到末页，避免删除/刷新后空白 */
async function loadList(page: number, size: number) {
  loading.value = true
  try {
    let res = await electronApi.browser.listCustomRulesPaged({}, page, size)
    if (res.items.length === 0 && res.total > 0 && page !== res.totalPages) {
      res = await electronApi.browser.listCustomRulesPaged({}, res.totalPages, size)
    }
    pagedResult.value = res
    currentPage.value = res.page
  } catch (e: any) {
    ElMessage.error(e.message || '加载规则失败')
  } finally {
    loading.value = false
  }
}

/** 翻页 / 改每页大小：由 ListPager 的 @change 触发 */
function onPagerChange(page: number, size: number) {
  loadList(page, size)
}
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

      <div v-loading="loading" class="data-list" style="--cols: minmax(180px,1.8fr) 120px minmax(180px,1.8fr) 120px 100px 170px 220px; margin-top: 16px">
        <header class="data-list__head">
          <div>规则名称</div>
          <div>匹配方式</div>
          <div>匹配值</div>
          <div>适用类型</div>
          <div>使用次数</div>
          <div>最后使用</div>
          <div class="data-list__actions">操作</div>
        </header>

        <article class="data-list__row" v-for="rule in pagedResult.items" :key="rule.id">
          <div class="rule-name">
            <el-icon v-if="rule.enabled" color="#67c23a"><CircleCheck /></el-icon>
            <el-icon v-else color="#c0c4cc"><Close /></el-icon>
            <span>{{ rule.name }}</span>
          </div>
          <div>
            <el-tag size="small" :type="rule.matchType === 'domain' ? 'info' : 'warning'">
              {{ rule.matchType === 'domain' ? '域名' : '正则' }}
            </el-tag>
          </div>
          <div><code class="match-value">{{ rule.matchValue }}</code></div>
          <div>
            <el-tag size="small" effect="plain">{{ getTypeTags(rule.contentTypes) }}</el-tag>
          </div>
          <div>{{ rule.useCount || 0 }}</div>
          <div>{{ formatTime(rule.lastUsedAt) }}</div>
          <div class="data-list__actions">
            <button class="icon-btn primary" type="button" title="编辑" @click="openEdit(rule)">
              <el-icon><Edit /></el-icon>
            </button>
            <button
              class="icon-btn"
              type="button"
              :class="rule.enabled ? 'warning' : 'success'"
              :title="rule.enabled ? '禁用' : '启用'"
              @click="toggleRule(rule)"
            >
              <el-icon><Switch /></el-icon>
            </button>
            <button class="icon-btn danger" type="button" title="删除" @click="deleteRule(rule)">
              <el-icon><Delete /></el-icon>
            </button>
          </div>
        </article>
      </div>

      <ListPager
        v-if="pagedResult.total > 0"
        v-model:page="currentPage"
        v-model:pageSize="pageSize"
        :total="pagedResult.total"
        unit="条规则"
        @change="onPagerChange"
      />

      <div v-if="pagedResult.items.length === 0 && !loading" class="empty-hint">
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
