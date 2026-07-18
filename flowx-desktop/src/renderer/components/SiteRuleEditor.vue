<script setup lang="ts">
import { ref, computed, watch, nextTick, toRaw } from 'vue'
import { ElMessage } from 'element-plus'
import { electronApi } from '../utils/electron'
import type { CustomSiteRule, PickerFieldType, PublishContentType } from '../../types'

const props = defineProps<{
  modelValue: boolean
  rule?: CustomSiteRule | null
  mode: 'create' | 'edit'
  /** 预填的域名（从当前页面创建时） */
  presetDomain?: string
  /** 当前浏览器视图ID（用于拾取器和测试） */
  viewId?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', rule: CustomSiteRule): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

// 表单数据
const form = ref<Partial<CustomSiteRule>>({
  name: '',
  enabled: true,
  matchType: 'domain',
  matchValue: '',
  contentTypes: [],
  contentSelector: '',
  titleSelector: '',
  bylineSelector: '',
  dateSelector: '',
  siteName: '',
  imageSelector: '',
  tagsSelector: '',
  removeSelectors: [],
  remark: '',
})

const formRef = ref<any>(null)
const loading = ref(false)
const testing = ref(false)
const testResult = ref<{ success: boolean; title?: string; length?: number; imageCount?: number; tags?: string[]; error?: string } | null>(null)

// 拾取器状态
const pickingField = ref<PickerFieldType | null>(null)

// 发布类型选项
const contentTypeOptions: Array<{ value: PublishContentType; label: string; icon: string }> = [
  { value: 'image-text', label: '图文发布', icon: '🖼️' },
  { value: 'video', label: '视频发布', icon: '🎬' },
  { value: 'article', label: '文章发布', icon: '📰' },
]

// 字段配置（用于拾取器按钮）
const fieldConfigs: Array<{
  key: PickerFieldType
  label: string
  icon: string
  mode: 'single' | 'multi'
  prop: keyof CustomSiteRule
  isList?: boolean
}> = [
  { key: 'title', label: '标题选择器', icon: '📌', mode: 'single', prop: 'titleSelector' },
  { key: 'content', label: '正文选择器', icon: '📝', mode: 'single', prop: 'contentSelector' },
  { key: 'image', label: '图片选择器', icon: '🖼️', mode: 'multi', prop: 'imageSelector' },
  { key: 'tags', label: '话题标签选择器', icon: '🏷️', mode: 'multi', prop: 'tagsSelector' },
  { key: 'byline', label: '作者选择器', icon: '👤', mode: 'single', prop: 'bylineSelector' },
  { key: 'date', label: '日期选择器', icon: '📅', mode: 'single', prop: 'dateSelector' },
  { key: 'remove', label: '移除元素', icon: '🗑️', mode: 'multi', prop: 'removeSelectors', isList: true },
]

const dialogTitle = computed(() => props.mode === 'create' ? '添加自定义规则' : '编辑规则')

// 监听打开
watch(visible, async (val) => {
  if (val) {
    testResult.value = null
    if (props.mode === 'edit' && props.rule) {
      form.value = { ...props.rule }
    } else {
      form.value = {
        name: '',
        enabled: true,
        matchType: 'domain',
        matchValue: props.presetDomain || '',
        contentTypes: [],
        contentSelector: '',
        titleSelector: '',
        bylineSelector: '',
        dateSelector: '',
        siteName: '',
        imageSelector: '',
        tagsSelector: '',
        removeSelectors: [],
        remark: '',
      }
      // 自动生成名称
      if (props.presetDomain) {
        form.value.name = `${props.presetDomain} 规则`
      }
    }
    // 监听拾取器结果
    electronApi.browser.onPickerResult(handlePickerResult)
    electronApi.browser.onPickerCancelled(handlePickerCancelled)
  } else {
    // 清理拾取器
    if (pickingField.value && props.viewId) {
      electronApi.browser.stopPicker(props.viewId)
    }
    pickingField.value = null
  }
})

// 拾取器结果处理
function handlePickerResult(data: { viewId: string; result: any }) {
  if (data.viewId !== props.viewId) return
  const { pickerType, selector } = data.result

  const config = fieldConfigs.find(c => c.key === pickerType)
  if (!config) return

  if (config.isList) {
    // 列表类型（如 removeSelectors），追加
    const list = (form.value as any)[config.prop] as string[]
    if (!list.includes(selector)) {
      list.push(selector)
    }
  } else {
    // 单值类型，直接替换
    ;(form.value as any)[config.prop] = selector
  }

  pickingField.value = null
  ElMessage.success(`已拾取${config.label}`)
}

function handlePickerCancelled(data: { viewId: string }) {
  if (data.viewId !== props.viewId) return
  pickingField.value = null
}

// 开始拾取
async function startPicking(fieldType: PickerFieldType, mode: 'single' | 'multi') {
  if (!props.viewId) {
    ElMessage.warning('请先在浏览器中打开页面')
    return
  }
  try {
    pickingField.value = fieldType
    await electronApi.browser.startPicker(props.viewId, fieldType, mode)
  } catch (e) {
    ElMessage.error('启动拾取器失败')
    pickingField.value = null
  }
}

// 添加移除选择器（手动输入）
const newRemoveSelector = ref('')
function addRemoveSelector() {
  if (!newRemoveSelector.value.trim()) return
  form.value.removeSelectors?.push(newRemoveSelector.value.trim())
  newRemoveSelector.value = ''
}
function removeRemoveSelector(idx: number) {
  form.value.removeSelectors?.splice(idx, 1)
}

// 测试规则
async function testRule() {
  if (!props.viewId) {
    ElMessage.warning('请先在浏览器中打开页面')
    return
  }
  if (!form.value.contentSelector) {
    ElMessage.warning('请先填写正文选择器')
    return
  }

  testing.value = true
  testResult.value = null
  try {
    const result = await electronApi.browser.testCustomRule(
      props.viewId,
      buildRuleData() as any,
    )
    if (result) {
      testResult.value = {
        success: true,
        title: result.title,
        length: result.length,
        imageCount: result.images?.length || 0,
        tags: result.tags || [],
      }
    } else {
      testResult.value = { success: false, error: '未提取到有效内容' }
    }
  } catch (e: any) {
    testResult.value = { success: false, error: e.message || '测试失败' }
  } finally {
    testing.value = false
  }
}

// 构建纯对象数据（去除响应式代理，避免 IPC 克隆错误）
function buildRuleData(): Partial<CustomSiteRule> & { contentSelector: string } {
  const raw = toRaw(form.value)
  // 先用 JSON 深拷贝彻底去除所有层级的响应式代理
  const plain = JSON.parse(JSON.stringify(raw))
  const data: any = {}
  // 只复制有效字段，跳过 undefined
  const fields = [
    'name', 'enabled', 'matchType', 'matchValue', 'pathPattern',
    'contentTypes', 'contentSelector', 'titleSelector', 'bylineSelector',
    'dateSelector', 'siteName', 'imageSelector', 'tagsSelector',
    'removeSelectors', 'remark', 'source',
  ]
  for (const f of fields) {
    const val = (plain as any)[f]
    if (val !== undefined) {
      data[f] = val
    }
  }
  return data
}

// 保存
async function handleSave() {
  if (!form.value.name?.trim()) {
    ElMessage.warning('请输入规则名称')
    return
  }
  if (!form.value.matchValue?.trim()) {
    ElMessage.warning('请输入匹配域名')
    return
  }
  if (!form.value.contentSelector?.trim()) {
    ElMessage.warning('请输入正文选择器')
    return
  }

  loading.value = true
  try {
    let saved: CustomSiteRule
    const ruleData = buildRuleData()
    if (props.mode === 'create') {
      saved = await electronApi.browser.createCustomRule({
        ...ruleData,
        enabled: ruleData.enabled ?? true,
        matchType: ruleData.matchType || 'domain',
        contentTypes: ruleData.contentTypes || [],
        removeSelectors: ruleData.removeSelectors || [],
        source: 'manual',
      } as any)
      ElMessage.success('规则创建成功')
    } else {
      saved = (await electronApi.browser.updateCustomRule(props.rule!.id, ruleData))!
      ElMessage.success('规则更新成功')
    }
    emit('saved', saved)
    visible.value = false
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-drawer
    v-model="visible"
    :title="dialogTitle"
    direction="rtl"
    size="560px"
    :before-close="() => visible = false"
    destroy-on-close
  >
    <div class="rule-editor">
      <el-form :model="form" label-width="100px" label-position="right">
        <!-- 基础信息 -->
        <el-form-item label="规则名称">
          <el-input v-model="form.name" placeholder="如：我的博客规则" />
        </el-form-item>

        <el-form-item label="启用状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="禁用" />
        </el-form-item>

        <el-divider content-position="left">匹配规则</el-divider>

        <el-form-item label="匹配方式">
          <el-radio-group v-model="form.matchType">
            <el-radio value="domain">域名包含</el-radio>
            <el-radio value="regex">正则表达式</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="匹配值">
          <el-input
            v-model="form.matchValue"
            :placeholder="form.matchType === 'domain' ? '如：example.com' : '如：/blog\\.example\\.com\\/post\\//i'"
          />
        </el-form-item>

        <el-form-item label="适用类型">
          <el-checkbox-group v-model="form.contentTypes">
            <el-checkbox v-for="opt in contentTypeOptions" :key="opt.value" :value="opt.value">
              {{ opt.icon }} {{ opt.label }}
            </el-checkbox>
          </el-checkbox-group>
          <div class="form-hint">不选表示适用于所有发布类型</div>
        </el-form-item>

        <el-divider content-position="left">提取规则</el-divider>

        <!-- 正文选择器（必填） -->
        <el-form-item label="正文选择器">
          <div class="picker-input">
            <el-input v-model="form.contentSelector" placeholder="CSS 选择器，如 .article-content" />
            <el-button
              :type="pickingField === 'content' ? 'warning' : 'primary'"
              @click="startPicking('content', 'single')"
            >
              {{ pickingField === 'content' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
        </el-form-item>

        <!-- 标题选择器 -->
        <el-form-item label="标题选择器">
          <div class="picker-input">
            <el-input v-model="form.titleSelector" placeholder="可选，如 h1.title" />
            <el-button
              :type="pickingField === 'title' ? 'warning' : 'primary'"
              @click="startPicking('title', 'single')"
            >
              {{ pickingField === 'title' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
        </el-form-item>

        <!-- 图片选择器 -->
        <el-form-item label="图片选择器">
          <div class="picker-input">
            <el-input v-model="form.imageSelector" placeholder="可选，如 .article-content img" />
            <el-button
              :type="pickingField === 'image' ? 'warning' : 'primary'"
              @click="startPicking('image', 'multi')"
            >
              {{ pickingField === 'image' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
          <div class="form-hint">多选模式：点击多张图片，自动推断通用选择器</div>
        </el-form-item>

        <!-- 话题标签选择器 -->
        <el-form-item label="话题标签">
          <div class="picker-input">
            <el-input v-model="form.tagsSelector" placeholder="可选，如 .tags a" />
            <el-button
              :type="pickingField === 'tags' ? 'warning' : 'primary'"
              @click="startPicking('tags', 'multi')"
            >
              {{ pickingField === 'tags' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
          <div class="form-hint">多选模式：点击多个话题标签</div>
        </el-form-item>

        <!-- 作者、日期 -->
        <el-form-item label="作者选择器">
          <div class="picker-input">
            <el-input v-model="form.bylineSelector" placeholder="可选" />
            <el-button
              :type="pickingField === 'byline' ? 'warning' : 'primary'"
              @click="startPicking('byline', 'single')"
            >
              {{ pickingField === 'byline' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
        </el-form-item>

        <el-form-item label="日期选择器">
          <div class="picker-input">
            <el-input v-model="form.dateSelector" placeholder="可选" />
            <el-button
              :type="pickingField === 'date' ? 'warning' : 'primary'"
              @click="startPicking('date', 'single')"
            >
              {{ pickingField === 'date' ? '拾取中...' : '拾取' }}
            </el-button>
          </div>
        </el-form-item>

        <el-form-item label="站点名称">
          <el-input v-model="form.siteName" placeholder="可选，如：我的博客" />
        </el-form-item>

        <!-- 移除元素 -->
        <el-form-item label="移除元素">
          <div class="remove-selectors">
            <div v-for="(sel, idx) in form.removeSelectors" :key="idx" class="remove-item">
              <span class="remove-sel">{{ sel }}</span>
              <el-button size="small" type="danger" link @click="removeRemoveSelector(idx)">移除</el-button>
            </div>
            <div class="picker-input">
              <el-input v-model="newRemoveSelector" placeholder="输入选择器或点击拾取" />
              <el-button
                :type="pickingField === 'remove' ? 'warning' : 'primary'"
                @click="startPicking('remove', 'multi')"
              >
                {{ pickingField === 'remove' ? '拾取中...' : '拾取' }}
              </el-button>
              <el-button @click="addRemoveSelector">添加</el-button>
            </div>
          </div>
        </el-form-item>

        <el-divider content-position="left">备注</el-divider>

        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="可选，备注说明" />
        </el-form-item>
      </el-form>

      <!-- 测试结果 -->
      <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
        <template v-if="testResult.success">
          <div class="test-title">✅ 提取测试成功</div>
          <div class="test-row"><span>标题：</span>{{ testResult.title }}</div>
          <div class="test-row"><span>正文字数：</span>{{ testResult.length }} 字</div>
          <div class="test-row"><span>图片数量：</span>{{ testResult.imageCount }} 张</div>
          <div v-if="testResult.tags && testResult.tags.length > 0" class="test-row">
            <span>话题标签：</span>
            <span class="test-tags">{{ testResult.tags.join('、') }}</span>
          </div>
        </template>
        <template v-else>
          <div class="test-title">❌ 提取测试失败</div>
          <div class="test-error">{{ testResult.error }}</div>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <el-button @click="visible = false">取消</el-button>
        <el-button :loading="testing" @click="testRule">测试规则</el-button>
        <el-button type="primary" :loading="loading" @click="handleSave">保存</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.rule-editor {
  padding: 0 8px;
}

.picker-input {
  display: flex;
  gap: 8px;
  flex: 1;
}

.picker-input :deep(.el-input) {
  flex: 1;
}

.form-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.remove-selectors {
  width: 100%;
}

.remove-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: #f5f7fa;
  border-radius: 4px;
  margin-bottom: 4px;
}

.remove-sel {
  font-family: monospace;
  font-size: 12px;
  color: #606266;
}

.test-result {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #f5f7fa;
}

.test-result.success {
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
}

.test-result.error {
  background: #fef0f0;
  border: 1px solid #fde2e2;
}

.test-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.test-row {
  font-size: 13px;
  color: #606266;
  margin: 4px 0;
}

.test-row span {
  color: #909399;
}

.test-tags {
  color: #409eff !important;
}

.test-error {
  font-size: 13px;
  color: #f56c6c;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
