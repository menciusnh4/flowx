<template>
  <div class="history-page-container">
    <div class="panel">
      <!-- 头部动作区 -->
      <div class="header-flex">
        <div class="title-wrap">
          <div class="title-icon-wrapper">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="title-section-info">
            <h2 class="history-section-title">发布历史</h2>
            <span class="section-subtitle">查看和管理已发布的内容记录</span>
          </div>
        </div>
        <div class="actions-wrap">
          <el-button @click="refresh" class="action-btn plain-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            <span>刷新</span>
          </el-button>
        </div>
      </div>

      <!-- 任务历史卡片列表 -->
      <div v-loading="publishStore.loading" class="task-card-list">
        <div v-for="row in publishStore.history" :key="row.id" class="flow-task-card">
          <!-- 头部：任务ID、发布类型与时间 -->
          <div class="task-card-header">
            <div class="header-left">
              <span class="task-id-lbl">ID:</span>
              <span class="task-id-val">{{ row.id }}</span>
              <span class="content-type-badge" :class="'type-' + row.request?.contentType">
                {{ contentTypeLabel(row.request?.contentType) }}
              </span>
              <span v-if="isTestTask(row)" class="content-type-badge type-test">🔍 测试</span>
            </div>
            <div class="header-right">
              <div class="status-capsule" :class="'status-' + row.status">
                <span class="status-dot"></span>
                <span>{{ statusLabel(row.status) }}</span>
              </div>
              <div class="task-time-info">
                <span>创建：{{ fmt(row.createdAt) }}</span>
                <span v-if="row.request?.scheduledAt" class="scheduled-time">
                  定时：{{ fmt(row.request.scheduledAt) }}
                </span>
              </div>
            </div>
          </div>

          <!-- 主体：发布内容与目标账号执行状况 -->
          <div class="task-card-body">
            <div class="task-main-info">
              <div class="task-info-layout">
                <!-- 首图与占位图 -->
                <div class="task-cover-wrapper" v-if="hasValidCover(row)">
                  <img 
                    :src="getLocalFileUrl(row.request.mediaFiles[0])" 
                    @error="onCoverError(row.id)" 
                    class="task-cover-img" 
                  />
                </div>
                
                <div class="task-detail-texts">
                  <h3 class="task-title">
                    <span v-if="!hasValidCover(row)" style="display: inline-flex; align-items: center;">
                      <span class="title-type-icon icon-video" v-if="row.request?.contentType === 'video'">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                      </span>
                      <span class="title-type-icon icon-image" v-else-if="row.request?.contentType === 'image'">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                      </span>
                      <span class="title-type-icon icon-article" v-else>
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      </span>
                    </span>
                    <span>{{ row.request?.title || row.request?.remark || '无标题发布' }}</span>
                  </h3>
                  <p class="task-desc-preview" v-if="row.request?.content">
                    {{ row.request.content.slice(0, 80) }}{{ row.request.content.length > 80 ? '...' : '' }}
                  </p>
                  <div class="task-meta-row">
                    <span class="meta-item-tag-num">
                      <span class="meta-emoji">🎯</span>
                      <span>目标账号：{{ row.items.length }} 个</span>
                    </span>
                    <div v-if="row.request?.tags && row.request.tags.length > 0" class="task-tags-group">
                      <span class="meta-bubble-tag" v-for="tag in row.request.tags" :key="tag">#{{ tag }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧分发账号列表 -->
            <div class="task-accounts-section">
              <div class="section-label">分发账号 ({{ row.items.length }})</div>
              <div class="accounts-badge-grid">
                <div v-for="item in row.items.slice(0, 6)" :key="item.accountId" class="history-account-card">
                  <div class="account-card-left">
                    <img v-if="getPlatformIconByItem(item)" :src="getPlatformIconByItem(item)" class="platform-logo" />
                    <div class="account-card-info">
                      <div class="account-nickname">{{ nicknameOf(item.accountId) }}</div>
                      <div class="account-handle">@{{ getPlatformHandle(item) }}</div>
                    </div>
                  </div>
                  <div class="account-card-right">
                    <!-- 成功绿勾 -->
                    <span class="status-icon-check" v-if="item.status === 'success'">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                    <!-- 失败红叉 -->
                    <span class="status-icon-cross" v-else-if="item.status === 'failed' || item.status === 'cancelled'">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </span>
                    <!-- 运行中菊花 -->
                    <span class="status-icon-running" v-else-if="item.status === 'running' || item.status === 'queued'">
                      <span class="running-mini-dot"></span>
                    </span>
                  </div>
                </div>
                <el-tooltip v-if="row.items.length > 6" :content="formatAccountList(row.items)">
                  <div class="accounts-more-badge">
                    +{{ row.items.length - 6 }}
                  </div>
                </el-tooltip>
              </div>
            </div>
          </div>

          <!-- 尾部：动作按钮区 -->
          <div class="task-card-footer">
            <div class="task-actions-group">
              <div class="action-pill pill-primary" @click="showDetail(row)">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                <span>查看详情</span>
              </div>
              <div
                v-if="row.status === 'scheduled'"
                class="action-pill pill-danger"
                @click="cancelTask(row)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <span>取消发布</span>
              </div>
              <div
                v-if="hasFailedItems(row)"
                class="action-pill pill-warning"
                :loading="retryingId === row.id"
                @click="retryTask(row)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                <span>重试</span>
              </div>
              <div
                v-if="isTestTask(row) && row.status !== 'running' && row.status !== 'queued'"
                class="action-pill pill-primary"
                :loading="retryingId === row.id"
                @click="retryTest(row)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                <span>重新测试</span>
              </div>
              <div
                v-if="isTestTask(row) && row.status !== 'running' && row.status !== 'queued'"
                class="action-pill pill-success"
                @click="retryAsPublish(row)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                <span>立即发布</span>
              </div>
              <el-popconfirm
                width="200"
                title="确定删除此发布记录？"
                @confirm="deleteTask(row)"
              >
                <template #reference>
                  <div class="action-pill pill-danger">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    <span>删除</span>
                  </div>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </div>
      </div>

      <div v-if="publishStore.history.length === 0 && !publishStore.loading" class="empty-hint">
        暂无发布记录，请到「一键发布」创建第一个任务。
      </div>

      <!-- 分页控件 -->
      <div v-if="publishStore.historyTotal > 0" class="pagination-wrapper">
        <el-pagination
          v-model:current-page="publishStore.historyPage"
          v-model:page-size="publishStore.historyPageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="publishStore.historyTotal"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </div>

    <!-- 详情弹窗 -->
    <el-dialog
      v-model="detailVisible"
      :title="'任务详情 - ' + (detailData?.task?.id || '')"
      width="850px"
      destroy-on-close
    >
      <div v-if="detailData?.task" class="detail-content">
        <!-- 卡片信息组 (Grouped Details Dashboard Card) -->
        <div class="detail-dashboard-card">
          <div class="dashboard-left-icon">
            <div class="dashboard-brand-circle">
              <!-- 根据 contentType 动态展示图标 -->
              <svg v-if="detailData.task.request?.contentType === 'video'" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
              <svg v-else-if="detailData.task.request?.contentType === 'image'" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
          </div>
          <div class="dashboard-right-meta">
            <!-- 第一排网格 -->
            <div class="dashboard-meta-row-1">
              <div class="meta-col">
                <span class="meta-label">任务ID</span>
                <span class="meta-val-id">
                  {{ detailData.task.id }}
                  <span class="copy-btn-wrap" @click="copyText(detailData.task.id)" title="复制任务ID">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </span>
                </span>
              </div>
              <div class="meta-col">
                <span class="meta-label">内容类型</span>
                <el-tag size="small" class="type-tag-orange">
                  {{ contentTypeLabel(detailData.task.request?.contentType) }}
                </el-tag>
              </div>
              <div class="meta-col">
                <span class="meta-label">整体状态</span>
                <span class="status-indicator-green" v-if="detailData.task.status === 'success'">
                  <span class="indicator-dot-green">✓</span>
                  <span>发布成功</span>
                </span>
                <span class="status-indicator-blue" v-else-if="detailData.task.status === 'running'">
                  <span class="indicator-dot-blue"></span>
                  <span>发布中</span>
                </span>
                <span class="status-indicator-red" v-else-if="detailData.task.status === 'failed'">
                  <span class="indicator-dot-red">✗</span>
                  <span>发布失败</span>
                </span>
                <el-tag v-else :type="statusTagType(detailData.task.status)" size="small">
                  {{ statusLabel(detailData.task.status) }}
                </el-tag>
              </div>
              <div class="meta-col">
                <span class="meta-label">分发账号数</span>
                <span class="meta-val-count">{{ detailData.task.items.length }} 个</span>
              </div>
            </div>
            <!-- 分割线 -->
            <div class="dashboard-divider"></div>
            <!-- 第二排时间与标签 -->
            <div class="dashboard-meta-row-2">
              <div class="meta-time-item">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="meta-small-icon"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span class="meta-time-label">创建时间</span>
                <span class="meta-time-val">{{ fmt(detailData.task.createdAt) }}</span>
              </div>
              <div class="meta-time-item">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="meta-small-icon"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span class="meta-time-label">更新时间</span>
                <span class="meta-time-val">{{ fmt(detailData.task.updatedAt) }}</span>
              </div>
              <div class="meta-time-item" v-if="detailData.task.request?.tags?.length">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="meta-small-icon"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                <span class="meta-time-label">标签</span>
                <span class="meta-tag-bubble-box">
                  <span class="meta-tag-bubble" v-for="t in detailData.task.request.tags" :key="t">#{{ t }}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 发布标题小卡片 -->
        <div class="detail-title-card" v-if="detailData.task.request?.title">
          <div class="title-card-left">
            <div class="title-letter-circle">T</div>
          </div>
          <div class="title-card-right">
            <div class="title-card-lbl">发布标题</div>
            <h4 class="title-card-val">{{ detailData.task.request.title }}</h4>
          </div>
        </div>

        <!-- 正文内容 (以精致圆角纯白卡片展示) -->
        <div v-if="detailData.task.request?.content" class="detail-custom-section">
          <div class="detail-section-headline">
            <span class="decor-bar"></span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="headline-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span class="headline-text">正文内容</span>
          </div>
          <div class="custom-content-box">
            <div class="scroll-content-inner">
              {{ detailData.task.request.content }}
            </div>
          </div>
        </div>

        <!-- 各账号执行结果 -->
        <div class="detail-custom-section">
          <div class="detail-section-headline">
            <span class="decor-bar"></span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="headline-icon"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <span class="headline-text">分发账号执行结果</span>
          </div>
          
          <div class="custom-table-container">
            <el-table :data="detailData.task.items" size="small" class="refined-detail-table">
              <el-table-column label="平台" width="90">
                <template #default="{ row }">
                  <div class="platform-column-cell">
                    <img v-if="getRealPlatformIcon(row.platform)" :src="getRealPlatformIcon(row.platform)" class="mini-platform-logo" />
                    <span>{{ platformLabel(row.platform) }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="账号" min-width="110">
                <template #default="{ row }">
                  <span class="account-name-cell">{{ nicknameOf(row.accountId) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="85">
                <template #default="{ row }">
                  <el-tag size="small" :type="itemStatusTagType(row.status)" class="refined-status-tag">
                    {{ statusLabel(row.status) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="进度" width="70">
                <template #default="{ row }">
                  <span class="progress-val-cell">{{ row.progress }}%</span>
                </template>
              </el-table-column>
              <el-table-column label="执行反馈/链接" min-width="180">
                <template #default="{ row }">
                  <div v-if="row.resultUrl" class="result-link-cell">
                    <el-link type="primary" :href="row.resultUrl" target="_blank" @click.stop="openUrl(row.resultUrl)">
                      查看作品
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:5px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </el-link>
                  </div>
                  <div v-else-if="row.message" class="error-msg-cell">
                    {{ row.message }}
                  </div>
                  <span v-else class="empty-val-cell">-</span>
                </template>
              </el-table-column>
              <el-table-column label="耗时" width="80">
                <template #default="{ row }">
                  <span class="duration-cell">{{ row.startedAt && row.finishedAt ? formatDuration(row.finishedAt - row.startedAt) : '-' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 测试结果详情 -->
        <div v-if="hasTestResult(detailData.task)" class="detail-custom-section">
          <div class="detail-section-headline">
            <span class="decor-bar"></span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="headline-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span class="headline-text">测试步骤校验详情</span>
          </div>
          
          <div class="refined-test-container">
            <div v-for="item in detailData.task.items.filter((i: any) => i.testResult)" :key="item.accountId" class="refined-test-item">
              <div class="test-item-header">
                <span class="test-item-account">
                  {{ platformLabel(item.platform) }} - {{ nicknameOf(item.accountId) }}
                </span>
                <el-tag :type="item.testResult?.publishButtonFound ? 'success' : 'danger'" size="small" effect="plain" class="refined-status-tag">
                  {{ item.testResult?.publishButtonFound ? '✓ 成功找到发布按钮' : '✗ 未找到发布按钮' }}
                </el-tag>
              </div>
              <div class="test-item-grid">
                <div class="test-field-box" :class="{ ok: item.testResult?.titleFilled }">
                  <span class="field-box-label">标题</span>
                  <span class="field-box-status">{{ item.testResult?.titleFilled ? '✓ 已填写' : '✗ 未填写' }}</span>
                </div>
                <div class="test-field-box" :class="{ ok: item.testResult?.contentFilled }">
                  <span class="field-box-label">内容/正文</span>
                  <span class="field-box-status">{{ item.testResult?.contentFilled ? '✓ 已填写' : '✗ 未填写' }}</span>
                </div>
                <div class="test-field-box" :class="{ ok: item.testResult?.tagsFilled }">
                  <span class="field-box-label">标签/话题</span>
                  <span class="field-box-status">{{ item.testResult?.tagsFilled ? '✓ 已填写' : '✗ 未填写' }}</span>
                </div>
                <div class="test-field-box" :class="{ ok: item.testResult?.coverUploaded }">
                  <span class="field-box-label">封面</span>
                  <span class="field-box-status">{{ item.testResult?.coverUploaded ? '✓ 已上传' : '✗ 未上传' }}</span>
                </div>
              </div>
              <div v-if="item.testResult?.note" class="test-item-note">
                💡 {{ item.testResult?.note }}
              </div>
            </div>
          </div>
        </div>

        <!-- 执行日志 -->
        <div v-if="detailData.logs && detailData.logs.length > 0" class="detail-custom-section">
          <div class="detail-section-headline">
            <span class="decor-bar"></span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="headline-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span class="headline-text">实时执行日志</span>
          </div>
          <div class="refined-log-box">
            <div
              v-for="(log, idx) in detailData.logs.slice(-50)"
              :key="idx"
              class="refined-log-line"
              :class="'log-' + log.level"
            >
              <span class="log-time">{{ fmt(log.ts) }}</span>
              <span class="log-lvl">[{{ log.level.toUpperCase() }}]</span>
              <span v-if="log.platform" class="log-plat">[{{ platformLabel(log.platform) }}]</span>
              <span v-if="log.accountId" class="log-acc">[{{ nicknameOf(log.accountId) }}]</span>
              <span class="log-stg">[{{ log.stage }}]</span>
              <span class="log-text">{{ log.message }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="refined-dialog-footer">
          <div class="footer-left-buttons">
            <el-button
              v-if="detailData?.task && hasFailedItems(detailData.task)"
              type="success"
              @click="openEditDialog(detailData.task)"
            >
              <el-icon><Edit /></el-icon>&nbsp;编辑重发
            </el-button>
            <el-button
              v-if="detailData?.task && hasFailedItems(detailData.task)"
              type="warning"
              :loading="retryingId === detailData.task.id"
              @click="retryTask(detailData.task)"
            >
              <el-icon><RefreshRight /></el-icon>&nbsp;重试失败账号
            </el-button>
          </div>
          <el-button @click="detailVisible = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 编辑重发弹窗 -->
    <el-dialog
      v-model="editDialogVisible"
      title="编辑后重新发布"
      width="560px"
      destroy-on-close
    >
      <div v-if="editTask" class="edit-form">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 16px;"
        >
          <template #title>
            将对以下 {{ failedAccounts.length }} 个失败账号重新发布：{{ failedAccountNames }}
          </template>
        </el-alert>

        <el-form label-width="80px" label-position="right">
          <el-form-item label="内容类型">
            <el-tag :type="contentTypeTagType(editTask.request?.contentType)">
              {{ contentTypeLabel(editTask.request?.contentType) }}
            </el-tag>
            <span style="margin-left: 12px; color: #909399; font-size: 12px;">（不可修改）</span>
          </el-form-item>

          <el-form-item label="标题">
            <el-input
              v-model="editForm.title"
              placeholder="请输入标题"
              maxlength="100"
              show-word-limit
            />
          </el-form-item>

          <el-form-item v-if="editForm.contentType !== 'article'" label="素材">
            <div class="edit-file-list">
              <div v-for="(f, idx) in editForm.mediaFiles" :key="idx" class="edit-file-item">
                <span class="file-name">{{ f }}</span>
                <el-button size="small" type="danger" link @click="removeEditMediaFile(f)">删除</el-button>
              </div>
            </div>
            <el-button size="small" @click="addEditMediaFiles" style="margin-top: 8px;">
              <el-icon><Plus /></el-icon>&nbsp;添加文件
            </el-button>
          </el-form-item>

          <el-form-item v-if="editForm.contentType === 'article'" label="封面图">
            <div class="edit-file-list">
              <div v-for="(f, idx) in editForm.mediaFiles" :key="idx" class="edit-file-item">
                <span class="file-name">{{ idx === 0 ? '📌 封面：' : '' }}{{ f }}</span>
                <el-button size="small" type="danger" link @click="removeEditMediaFile(f)">删除</el-button>
              </div>
            </div>
            <el-button size="small" @click="addEditMediaFiles" style="margin-top: 8px;">
              <el-icon><Plus /></el-icon>&nbsp;添加图片
            </el-button>
          </el-form-item>

          <el-form-item label="描述">
            <el-input
              v-model="editForm.content"
              type="textarea"
              :rows="editForm.contentType === 'article' ? 8 : 4"
              :placeholder="editForm.contentType === 'article'
                ? '请输入文章正文'
                : editForm.contentType === 'image'
                  ? '可选：为图文添加描述文案'
                  : '可选：为视频添加描述文案'"
              maxlength="5000"
              show-word-limit
            />
          </el-form-item>

          <el-form-item label="话题">
            <el-input
              v-model="editForm.tagsRaw"
              placeholder="多个话题用空格或逗号分隔，例如：美食探店 上海生活"
            />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-space>
          <el-button @click="editDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="editSubmitting" @click="submitEditAndPublish">
            <el-icon><Promotion /></el-icon>&nbsp;发布
          </el-button>
        </el-space>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { View, RefreshRight, Delete, Refresh, CircleClose, Edit, Plus, Promotion } from '@element-plus/icons-vue';
import { usePublishStore } from '../stores/publish';
import { useAccountStore } from '../stores/account';
import { electronApi } from '../utils/electron';
import type { PublishTask, PlatformType, PublishStatus, PublishLogEntry, PublishItemProgress, PublishRequest, ContentType } from '../../types';

import xiaohongshuIcon from '../assets/xiaohongshu.svg';
import douyinIcon from '../assets/douyin.svg';
import kuaishouIcon from '../assets/kuaishou.svg';
import wechatChannelsIcon from '../assets/wechat_channels.svg';
import zhihuIcon from '../assets/zhihu.png';
import toutiaoIcon from '../assets/toutiao.png';

const publishStore = usePublishStore();
const accountStore = useAccountStore();

function getRealPlatformIcon(p?: string | null): string {
  if (!p) return '';
  switch (p) {
    case 'xiaohongshu': return xiaohongshuIcon;
    case 'douyin': return douyinIcon;
    case 'kuaishou': return kuaishouIcon;
    case 'wechat_channels': return wechatChannelsIcon;
    case 'zhihu': return zhihuIcon;
    case 'toutiao': return toutiaoIcon;
    default: return '';
  }
}

function getPlatformIconByItem(item?: any): string {
  if (!item) return '';
  let p = item.platform;
  if (!p && item.accountId) {
    p = accountStore.accounts.find((a) => a.id === item.accountId)?.platform;
  }
  return getRealPlatformIcon(p);
}

function getPlatformHandle(item?: any): string {
  if (!item) return '';
  const nickname = nicknameOf(item.accountId);
  let p = item.platform;
  if (!p && item.accountId) {
    p = accountStore.accounts.find((a) => a.id === item.accountId)?.platform;
  }
  const suffix = p ? `_${p}` : '';
  return `${nickname.toLowerCase()}${suffix}`;
}

function getLocalFileUrl(path?: string | null): string {
  if (!path) return '';
  if (path.startsWith('http') || path.startsWith('data:')) return path;
  return `file://${path}`;
}

const failedCovers = ref<Set<string>>(new Set());

function onCoverError(taskId: string) {
  failedCovers.value.add(taskId);
}

function hasValidCover(row: any): boolean {
  if (!row?.id) return false;
  if (failedCovers.value.has(row.id)) return false;
  return !!(row.request?.mediaFiles && row.request.mediaFiles.length > 0);
}

const detailVisible = ref(false);
const detailData = ref<{ task: PublishTask | null; logs: PublishLogEntry[] } | null>(null);
const retryingId = ref<string | null>(null);

// ========== 编辑重发相关 ==========
const editDialogVisible = ref(false);
const editTask = ref<PublishTask | null>(null);
const editSubmitting = ref(false);
const editForm = ref({
  title: '',
  content: '',
  tagsRaw: '',
  mediaFiles: [] as string[],
  contentType: 'video' as ContentType,
});

const failedAccounts = computed(() => {
  if (!editTask.value) return [];
  return editTask.value.items.filter(
    (i) => i.status === 'failed' || i.status === 'cancelled'
  );
});

const failedAccountNames = computed(() => {
  return failedAccounts.value
    .map((i) => nicknameOf(i.accountId))
    .join('、');
});

function openEditDialog(task: any) {
  editTask.value = task as PublishTask;
  const req = task.request;
  editForm.value = {
    title: req?.title || '',
    content: req?.content || '',
    tagsRaw: (req?.tags || []).join(' '),
    mediaFiles: [...(req?.mediaFiles || [])],
    contentType: req?.contentType || 'video',
  };
  editDialogVisible.value = true;
}

async function addEditMediaFiles() {
  try {
    const isArticle = editForm.value.contentType === 'article';
    const filters = isArticle
      ? [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
      : undefined;
    const r = await electronApi.openFileDialog({ mode: 'files', filters });
    if (r && !r.canceled && r.filePaths && r.filePaths.length > 0) {
      editForm.value.mediaFiles = [...editForm.value.mediaFiles, ...r.filePaths];
      ElMessage.success(`已添加 ${r.filePaths.length} 个文件`);
    }
  } catch (e) {
    ElMessage.error('选择文件失败');
  }
}

function removeEditMediaFile(path: string) {
  editForm.value.mediaFiles = editForm.value.mediaFiles.filter((x) => x !== path);
}

async function submitEditAndPublish() {
  if (!editTask.value) return;

  if (!editForm.value.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }

  const failedAccountIds = failedAccounts.value.map((i) => i.accountId);
  if (failedAccountIds.length === 0) {
    ElMessage.warning('没有需要重发的失败账号');
    return;
  }

  if (editForm.value.contentType !== 'article' && editForm.value.mediaFiles.length === 0) {
    ElMessage.warning('请上传素材文件');
    return;
  }

  const tags = editForm.value.tagsRaw
    .split(/[,，\s]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0);

  const req: PublishRequest = {
    accountIds: failedAccountIds,
    title: editForm.value.title.trim(),
    content: editForm.value.content,
    mediaFiles: [...editForm.value.mediaFiles],
    contentType: editForm.value.contentType,
    tags: tags.length > 0 ? tags : undefined,
    remark: editTask.value.request?.remark,
    coverImage: editTask.value.request?.coverImage,
    category: editTask.value.request?.category,
  };

  editSubmitting.value = true;
  try {
    const newTaskId = await electronApi.submitPublish(req);
    ElMessage.success(`已创建发布任务，任务ID: ${newTaskId}`);
    editDialogVisible.value = false;
    detailVisible.value = false;
    await refresh();
  } catch (err) {
    ElMessage.error('发布失败: ' + (err as Error).message);
  } finally {
    editSubmitting.value = false;
  }
}

async function refresh() {
  await Promise.all([
    publishStore.loadHistoryPaged(),
    publishStore.loadStats(),
  ]);
}

function handlePageChange(page: number) {
  publishStore.loadHistoryPaged(page);
}

function handleSizeChange(size: number) {
  publishStore.loadHistoryPaged(1, size);
}

function nicknameOf(id: string): string {
  return accountStore.accounts.find((a) => a.id === id)?.nickname || id.slice(0, 8);
}

function fmt(ts?: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function contentTypeLabel(type?: string): string {
  switch (type) {
    case 'video': return '视频';
    case 'image': return '图文';
    case 'article': return '文章';
    default: return type || '-';
  }
}

function contentTypeTagType(type?: string): 'success' | 'warning' | 'info' | undefined {
  switch (type) {
    case 'video': return undefined;
    case 'image': return 'success';
    case 'article': return 'warning';
    default: return 'info';
  }
}

function platformLabel(p: PlatformType): string {
  switch (p) {
    case 'douyin': return '抖音';
    case 'xiaohongshu': return '小红书';
    case 'kuaishou': return '快手';
    default: return p;
  }
}

function statusLabel(s: PublishStatus): string {
  switch (s) {
    case 'success': return '发布成功';
    case 'failed': return '发布失败';
    case 'running': return '发布中';
    case 'queued': return '等待中';
    case 'cancelled': return '已取消';
    case 'scheduled': return '待发布';
    default: return s;
  }
}

function statusTagType(s: PublishStatus): 'success' | 'danger' | 'primary' | 'warning' | 'info' | undefined {
  switch (s) {
    case 'success': return 'success';
    case 'failed': return 'danger';
    case 'running': return 'primary';
    case 'queued': return 'info';
    case 'cancelled': return 'info';
    case 'scheduled': return 'warning';
    default: return 'info';
  }
}

function itemStatusTagType(s: PublishStatus): 'success' | 'danger' | 'primary' | 'warning' | 'info' | undefined {
  return statusTagType(s);
}

function hasFailedItems(task: any): boolean {
  if (task.status === 'running' || task.status === 'queued' || task.status === 'scheduled') return false;
  return task.items.some((i: PublishItemProgress) => i.status === 'failed' || i.status === 'cancelled');
}

/** 判断是否为测试任务 */
function isTestTask(task: any): boolean {
  return !!(task?.request?.testMode || task?.items?.some((i: any) => i.testResult));
}

/** 判断是否有测试结果 */
function hasTestResult(task: any): boolean {
  return !!(task?.items?.some((i: any) => i.testResult));
}

function formatTags(tags?: string[]): string {
  if (!tags || tags.length === 0) return '';
  return tags.map((t: string) => '#' + t).join(' ');
}

function formatAccountList(items: PublishItemProgress[]): string {
  return items.slice(6).map((i: PublishItemProgress) => nicknameOf(i.accountId)).join('、');
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}分${sec}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

async function openUrl(url: string) {
  try {
    await electronApi.openExternal(url);
  } catch {
    window.open(url, '_blank');
  }
}

function copyText(text: string) {
  navigator.clipboard.writeText(text);
  ElMessage.success('已复制到剪贴板');
}

async function showDetail(row: any) {
  try {
    const data = await electronApi.getTaskDetail(row.id as string);
    detailData.value = data;
    detailVisible.value = true;
  } catch (err) {
    ElMessage.error('获取详情失败: ' + (err as Error).message);
  }
}

async function retryTask(task: any) {
  try {
    await ElMessageBox.confirm(
      `将重试此任务中失败的账号（成功的账号不会重复发布），确定继续？`,
      '重试发布',
      { type: 'warning' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryPublish(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建重试任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.info('没有需要重试的失败账号');
    }
  } catch (err) {
    ElMessage.error('重试失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

/** 重新测试（测试任务专用） */
async function retryTest(task: any) {
  try {
    await ElMessageBox.confirm(
      `将对所有账号重新执行测试（不真正发布），确定继续？`,
      '重新测试',
      { type: 'info', confirmButtonText: '重新测试' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryAsTest(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建重新测试任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.warning('无法创建重新测试任务');
    }
  } catch (err) {
    ElMessage.error('重新测试失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

/** 立即发布（测试任务转正式发布） */
async function retryAsPublish(task: any) {
  try {
    await ElMessageBox.confirm(
      `将对所有账号立即执行正式发布（会真的发布内容），确定继续？`,
      '立即发布',
      { type: 'warning', confirmButtonText: '立即发布' },
    );
  } catch {
    return;
  }

  retryingId.value = task.id as string;
  try {
    const newTaskId = await electronApi.retryAsPublish(task.id as string);
    if (newTaskId) {
      ElMessage.success(`已创建发布任务，新任务ID: ${newTaskId}`);
      detailVisible.value = false;
      await refresh();
    } else {
      ElMessage.warning('无法创建发布任务');
    }
  } catch (err) {
    ElMessage.error('发布失败: ' + (err as Error).message);
  } finally {
    retryingId.value = null;
  }
}

async function deleteTask(task: any) {
  try {
    await electronApi.deleteTask(task.id as string);
    ElMessage.success('已删除');
    await refresh();
  } catch (err) {
    ElMessage.error('删除失败: ' + (err as Error).message);
  }
}

/**
 * 取消定时发布任务
 */
async function cancelTask(row: any) {
  try {
    await ElMessageBox.confirm(`确定取消任务「${row.id}」的定时发布吗？`, '取消定时发布', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await publishStore.cancelTask(row.id as string);
    ElMessage.success('已取消发布');
    await refresh();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(async () => {
  await accountStore.loadPlatforms();
  await accountStore.refreshAccounts();
  await publishStore.loadHistoryPaged(1);
});
</script>

<style scoped>
.empty-hint {
  text-align: center;
  color: #64748b;
  padding: 60px 0;
  font-size: 14px;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 24px;
  padding: 16px 0;
}

/* 美化分页组件 */
.pagination-wrapper :deep(.el-pagination) {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 总条数文本 */
.pagination-wrapper :deep(.el-pagination__total) {
  font-size: 13px;
  color: #64748b;
  font-weight: 600;
  margin-right: 12px;
}

/* 下拉页码选择器 */
.pagination-wrapper :deep(.el-select .el-input__wrapper) {
  border-radius: 8px !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  box-shadow: none !important;
  background: #ffffff !important;
  transition: all 0.25s ease;
  padding: 4px 12px !important;
}

.pagination-wrapper :deep(.el-select .el-input__wrapper:hover),
.pagination-wrapper :deep(.el-select .el-input.is-focus .el-input__wrapper) {
  border-color: rgba(99, 102, 241, 0.3) !important;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.08) !important;
}

/* 按钮及页码通用样式 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next),
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li) {
  background: #ffffff !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  border-radius: 8px !important;
  color: #64748b !important;
  font-weight: 600;
  min-width: 32px !important;
  height: 32px !important;
  line-height: 30px !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
  box-sizing: border-box;
}

/* 页码/按钮 Hover 状态 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev:hover),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next:hover),
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li:not(.is-active):hover) {
  color: #6366f1 !important;
  background: rgba(99, 102, 241, 0.04) !important;
  border-color: rgba(99, 102, 241, 0.2) !important;
  transform: translateY(-1px);
}

/* 激活选中的页码 */
.pagination-wrapper :deep(.el-pagination.is-background .el-pager li.is-active) {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
  color: #ffffff !important;
  border-color: transparent !important;
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.2) !important;
  transform: translateY(-1px);
}

/* 禁用状态 */
.pagination-wrapper :deep(.el-pagination.is-background .btn-prev:disabled),
.pagination-wrapper :deep(.el-pagination.is-background .btn-next:disabled) {
  background: #f8fafc !important;
  border-color: rgba(0, 0, 0, 0.03) !important;
  color: #cbd5e1 !important;
  cursor: not-allowed;
  transform: none !important;
}

/* 前往页码输入框 */
.pagination-wrapper :deep(.el-pagination__jump) {
  font-size: 13px;
  color: #64748b;
  font-weight: 600;
  margin-left: 12px;
}

.pagination-wrapper :deep(.el-pagination__jump .el-input__wrapper) {
  border-radius: 8px !important;
  border: 1px solid rgba(0, 0, 0, 0.05) !important;
  box-shadow: none !important;
  background: #ffffff !important;
  transition: all 0.25s ease;
  width: 44px !important;
  box-sizing: border-box;
}

.pagination-wrapper :deep(.el-pagination__jump .el-input__wrapper:hover),
.pagination-wrapper :deep(.el-pagination__jump .el-input.is-focus .el-input__wrapper) {
  border-color: rgba(99, 102, 241, 0.3) !important;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.08) !important;
}

.detail-content {
  max-height: 60vh;
  overflow-y: auto;
  overflow-x: hidden !important;
  box-sizing: border-box;
  padding-right: 14px;
}

/* 扁平化元数据网格 */
.task-metadata-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  background: rgba(99, 102, 241, 0.03);
  border: 1px solid rgba(99, 102, 241, 0.12);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-sizing: border-box;
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.02);
}

@media (max-width: 600px) {
  .task-metadata-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-label {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.meta-value {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.meta-value.mono {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  color: #475569;
  font-weight: 500;
}

.task-title-banner {
  background: rgba(99, 102, 241, 0.03);
  border: 1px solid rgba(99, 102, 241, 0.06);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
}

.task-title-banner.remark {
  background: rgba(15, 23, 42, 0.02);
  border-color: rgba(15, 23, 42, 0.04);
}

.banner-label {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.banner-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #6366f1;
}

.banner-remark {
  font-size: 13px;
  color: #1e293b;
  line-height: 1.5;
}

.scheduled-time {
  color: #e6a23c;
  font-weight: 600;
}

.meta-tag-bubble {
  display: inline-block;
  background: rgba(99, 102, 241, 0.06);
  color: #6366f1;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  margin-right: 6px;
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.detail-section {
  margin-top: 16px;
}

.detail-section-title {
  font-weight: 700;
  font-size: 14px;
  color: #1e293b;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.content-preview {
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
  color: #334155;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 150px;
  overflow-y: auto;
}

/* 终端风格日志区 */
.log-container {
  background: #0f172a;
  border-radius: 12px;
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.8;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2);
}

.log-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.log-line:last-child {
  border-bottom: none;
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-level {
  font-weight: 700;
  flex-shrink: 0;
}

.log-info .log-level { color: #38bdf8; }
.log-warn .log-level { color: #f59e0b; }
.log-error .log-level { color: #ef4444; }
.log-debug .log-level { color: #94a3b8; }

.log-platform {
  color: #34d399;
  font-weight: 600;
  flex-shrink: 0;
}

.log-account {
  color: #c084fc;
  font-weight: 600;
  flex-shrink: 0;
}

.log-stage {
  color: #fb7185;
  font-weight: 600;
  flex-shrink: 0;
}

.log-msg {
  color: #e2e8f0;
}

.log-error .log-msg {
  color: #fca5a5;
}

/* 编辑重发表单样式 */
.edit-form {
  padding: 0 8px;
}

.edit-file-list {
  max-height: 160px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.015);
  border: 1px solid rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  padding: 8px 12px;
}

.edit-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.02);
}

.edit-file-item:last-child {
  border-bottom: none;
}

.edit-file-item .file-name {
  font-size: 13px;
  color: #475569;
  word-break: break-all;
  flex: 1;
  margin-right: 8px;
  font-weight: 500;
}

/* 容器及 Header 动作区 */
.history-page-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: transparent;
}

.panel {
  background: #ffffff;
  border-radius: 16px;
  padding: 24px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.02);
  box-sizing: border-box;
}

.header-flex {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 24px;
}

.title-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-icon-wrapper {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6366f1;
}

.title-section-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.history-section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.2;
}

.history-section-title::before {
  display: none !important; /* 彻底移除全局伪元素带来的小竖线 */
}

.section-subtitle {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 500;
}

.actions-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.actions-wrap :deep(.el-button) {
  border-radius: 20px !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  padding: 8px 16px !important;
  height: auto !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

.actions-wrap .plain-btn {
  border: 1px solid rgba(99, 102, 241, 0.2) !important;
  background: #ffffff !important;
  color: #6366f1 !important;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.04) !important;
}

.actions-wrap .plain-btn:hover {
  border-color: rgba(99, 102, 241, 0.45) !important;
  background: rgba(99, 102, 241, 0.06) !important;
  color: #4f46e5 !important;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.08) !important;
}

/* 历史发布卡片流 */
.task-card-list {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.flow-task-card {
  background: #ffffff;
  border-top: 1.5px solid rgba(99, 102, 241, 0.2);
  border-left: none;
  border-right: none;
  border-bottom: none;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px -5px rgba(99, 102, 241, 0.04), 0 2px 10px -3px rgba(0, 0, 0, 0.02);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
}

.flow-task-card:hover {
  transform: translateY(-4px);
  border-top-color: rgba(99, 102, 241, 0.58);
  box-shadow: 0 16px 36px -4px rgba(99, 102, 241, 0.14), 0 4px 16px -2px rgba(99, 102, 241, 0.04);
}

.task-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px dashed rgba(0, 0, 0, 0.05);
  padding-bottom: 14px;
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-id-lbl {
  font-size: 11px;
  color: #64748b;
  font-weight: 700;
}

.task-id-val {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  color: #6366f1;
  font-weight: 700;
  margin-left: 2px;
}

/* 精美内容类型标签 */
.content-type-badge {
  font-size: 10px;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 6px;
}
.type-article {
  background: rgba(249, 115, 22, 0.08);
  color: #f97316;
}
.type-video {
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
}
.type-image {
  background: rgba(6, 182, 212, 0.08);
  color: #06b6d4;
}
.type-test {
  background: rgba(234, 179, 8, 0.08);
  color: #eab308;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* 精美状态胶囊 */
.status-capsule {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 800;
}
.status-success {
  background: rgba(16, 185, 129, 0.08);
  color: #10b981;
}
.status-success .status-dot {
  background: #10b981;
  box-shadow: 0 0 6px #10b981;
}
.status-failed, .status-cancelled {
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
}
.status-failed .status-dot, .status-cancelled .status-dot {
  background: #ef4444;
}
.status-running, .status-queued {
  background: rgba(59, 130, 246, 0.08);
  color: #3b82f6;
}
.status-running .status-dot, .status-queued .status-dot {
  background: #3b82f6;
  animation: pulseBlue 1.5s infinite;
}
.status-scheduled {
  background: rgba(245, 158, 11, 0.08);
  color: #f59e0b;
}
.status-scheduled .status-dot {
  background: #f59e0b;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  display: inline-block;
}

@keyframes pulseBlue {
  0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
  70% { box-shadow: 0 0 0 5px rgba(59, 130, 246, 0); }
  100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
}

.task-time-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.3;
  font-weight: 500;
  font-family: monospace;
}

.scheduled-time {
  color: #f59e0b;
  font-weight: 700;
}

/* 左右分栏布局 */
.task-card-body {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.task-main-info {
  flex: 1.4;
  min-width: 320px;
}

.task-info-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

/* 媒体首图系统 */
.task-cover-wrapper {
  position: relative;
  width: 100px;
  height: 100px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%);
  border: 1px solid rgba(0, 0, 0, 0.04);
}

.task-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: relative;
  z-index: 1;
}

.task-cover-img-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 0;
  color: rgba(99, 102, 241, 0.4);
}

.task-detail-texts {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.title-type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  margin-right: 8px;
  vertical-align: middle;
  flex-shrink: 0;
}
.icon-video {
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
}
.icon-image {
  background: rgba(6, 182, 212, 0.08);
  color: #06b6d4;
}
.icon-article {
  background: rgba(249, 115, 22, 0.08);
  color: #f97316;
}

.task-title {
  font-size: 16px;
  font-weight: 800;
  color: #0f172a;
  margin: 0 0 8px 0;
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: normal;
  word-break: break-all;
}

.task-desc-preview {
  font-size: 12px;
  color: #64748b;
  margin: 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.meta-item-tag-num {
  font-size: 11px;
  color: #64748b;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.meta-emoji {
  font-size: 12px;
}

.task-tags-group {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.meta-bubble-tag {
  font-size: 10px;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.05);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 700;
}

/* 右侧分发账号列表 */
.task-accounts-section {
  flex: 1;
  min-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-left: 1px solid rgba(0, 0, 0, 0.04);
  padding-left: 20px;
}

@media (max-width: 768px) {
  .task-accounts-section {
    border-left: none;
    padding-left: 0;
  }
}

.section-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.accounts-badge-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 高保真分发账号小卡片 */
.history-account-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.01);
  border: 1px solid #e2e8f0;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.01);
  transition: all 0.2s ease;
}

.history-account-card:hover {
  background: rgba(99, 102, 241, 0.03);
  border-color: rgba(99, 102, 241, 0.35);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.06);
}

.account-card-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.platform-logo {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.account-card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.account-nickname {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-handle {
  font-size: 10px;
  color: #94a3b8;
  font-family: monospace;
}

.account-card-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* 结果打勾/红叉 */
.status-icon-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.status-icon-cross {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.status-icon-running {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.running-mini-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #3b82f6;
  animation: pulseBlue 1.2s infinite;
}

.accounts-more-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(0, 0, 0, 0.03);
  color: #64748b;
  cursor: help;
  text-align: center;
  transition: all 0.2s;
}

.accounts-more-badge:hover {
  background: rgba(0, 0, 0, 0.06);
}

.task-card-footer {
  border-top: 1px dashed rgba(0, 0, 0, 0.05);
  padding-top: 14px;
  margin-top: auto;
}

.task-actions-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.task-actions-group .action-pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.25s ease;
  border: 1px solid transparent;
}

.task-actions-group .pill-primary {
  background: transparent;
  color: #6366f1;
}
.task-actions-group .pill-primary:hover {
  background: rgba(99, 102, 241, 0.08);
  color: #4f46e5;
  border-color: rgba(99, 102, 241, 0.12);
}

.task-actions-group .pill-success {
  background: transparent;
  color: #10b981;
}
.task-actions-group .pill-success:hover {
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
  border-color: rgba(16, 185, 129, 0.12);
}

.task-actions-group .pill-warning {
  background: transparent;
  color: #f97316;
}
.task-actions-group .pill-warning:hover {
  background: rgba(249, 115, 22, 0.08);
  color: #ea580c;
  border-color: rgba(249, 115, 22, 0.12);
}

.task-actions-group .pill-danger {
  background: transparent;
  color: #ef4444;
}
.task-actions-group .pill-danger:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.12);
}

/* 测试结果详情 */
.test-results-detail {
  margin-top: 16px;
}
.test-result-item {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 10px;
}
.test-result-item:last-child {
  margin-bottom: 0;
}
.test-result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.test-result-account {
  font-weight: 500;
  color: #606266;
  font-size: 13px;
}
.test-result-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}
.test-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 4px;
  border: 1px solid #f0d9a8;
}
.test-field.filled {
  border-color: #67c23a;
  background: #f0f9eb;
}
.test-field-label {
  font-size: 12px;
  color: #909399;
}
.test-field-value {
  font-size: 13px;
  font-weight: 500;
  color: #606266;
}
.test-field.filled .test-field-value {
  color: #67c23a;
}
.test-result-note {
  font-size: 12px;
  color: #e6a23c;
  margin-top: 8px;
  padding: 6px 10px;
  background: #fffbe6;
  border-radius: 4px;
}

/* 高保真任务详情弹窗美化 */
.detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部大面板卡片 */
.detail-dashboard-card {
  display: flex !important;
  align-items: flex-start !important;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(99, 102, 241, 0.01) 100%) !important;
  border: 1px solid rgba(99, 102, 241, 0.12) !important;
  border-radius: 16px !important;
  padding: 22px !important;
  gap: 18px !important;
  position: relative !important;
  height: auto !important;
  min-height: 120px !important;
  box-sizing: border-box !important;
}

.detail-dashboard-card::after {
  content: '';
  position: absolute;
  right: -20px;
  bottom: -20px;
  width: 120px;
  height: 120px;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.06) 0%, rgba(99, 102, 241, 0) 70%);
  border-radius: 50%;
  pointer-events: none;
}

.dashboard-left-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dashboard-brand-circle {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 10px rgba(99, 102, 241, 0.05);
}

.dashboard-right-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dashboard-meta-row-1 {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.meta-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.meta-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.meta-val-id {
  font-family: monospace;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.copy-btn-wrap {
  cursor: pointer;
  color: #94a3b8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.copy-btn-wrap:hover {
  color: #6366f1;
  background: rgba(99, 102, 241, 0.08);
}

.type-tag-orange {
  align-self: flex-start;
  background: rgba(249, 115, 22, 0.08) !important;
  color: #f97316 !important;
  border: 1px solid rgba(249, 115, 22, 0.15) !important;
  font-weight: 700;
  border-radius: 6px;
}

.status-indicator-green {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  padding: 2px 8px;
  border-radius: 20px;
  align-self: flex-start;
  border: 1px solid rgba(16, 185, 129, 0.15);
}

.indicator-dot-green {
  font-size: 11px;
}

.status-indicator-blue {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.08);
  padding: 2px 8px;
  border-radius: 20px;
  align-self: flex-start;
  border: 1px solid rgba(59, 130, 246, 0.15);
}

.indicator-dot-blue {
  width: 6px;
  height: 6px;
  background: #3b82f6;
  border-radius: 50%;
  animation: pulse-blue 1.5s infinite;
}

@keyframes pulse-blue {
  0% { transform: scale(0.9); opacity: 0.6; }
  50% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(0.9); opacity: 0.6; }
}

.status-indicator-red {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  padding: 2px 8px;
  border-radius: 20px;
  align-self: flex-start;
  border: 1px solid rgba(239, 68, 68, 0.15);
}

.indicator-dot-red {
  font-size: 11px;
}

.meta-val-count {
  font-size: 14px;
  font-weight: 800;
  color: #0f172a;
}

.dashboard-divider {
  height: 1px;
  background: rgba(99, 102, 241, 0.08);
}

.dashboard-meta-row-2 {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}

.meta-time-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.meta-small-icon {
  color: #94a3b8;
}

.meta-time-label {
  color: #64748b;
  font-weight: 500;
}

.meta-time-val {
  color: #334155;
  font-weight: 700;
}

.meta-tag-bubble-box {
  display: flex;
  gap: 4px;
}

.meta-tag-bubble {
  background: rgba(99, 102, 241, 0.06);
  color: #6366f1;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid rgba(99, 102, 241, 0.1);
}

/* 发布标题卡片 */
.detail-title-card {
  display: flex;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 12px;
  padding: 12px 18px;
  gap: 14px;
  align-items: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.015);
}

.title-card-left {
  flex-shrink: 0;
}

.title-letter-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(99, 102, 241, 0.08);
  color: #6366f1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
}

.title-card-right {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title-card-lbl {
  font-size: 10px;
  color: #94a3b8;
  font-weight: 700;
  text-transform: uppercase;
}

.title-card-val {
  font-size: 14px;
  font-weight: 800;
  color: #4f46e5;
  margin: 0;
}

/* 自定义卡片分区 */
.detail-custom-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 6px;
}

.detail-section-headline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.decor-bar {
  width: 3.5px;
  height: 14px;
  background: #6366f1;
  border-radius: 20px;
}

.headline-icon {
  color: #6366f1;
}

.headline-text {
  font-size: 13px;
  font-weight: 800;
  color: #1e293b;
}

/* 文本正文卡片框 */
.custom-content-box {
  background: #f8fafc;
  border: 1px solid #f1f5f9;
  border-radius: 12px;
  padding: 16px;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.01);
}

.scroll-content-inner {
  font-size: 13px;
  color: #334155;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
  padding-right: 6px;
}

/* 滚动条美化 */
.scroll-content-inner::-webkit-scrollbar,
.refined-log-box::-webkit-scrollbar {
  width: 5px;
}

.scroll-content-inner::-webkit-scrollbar-track,
.refined-log-box::-webkit-scrollbar-track {
  background: transparent;
}

.scroll-content-inner::-webkit-scrollbar-thumb,
.refined-log-box::-webkit-scrollbar-thumb {
  background: rgba(99, 102, 241, 0.2);
  border-radius: 4px;
}

.scroll-content-inner::-webkit-scrollbar-thumb:hover,
.refined-log-box::-webkit-scrollbar-thumb:hover {
  background: rgba(99, 102, 241, 0.4);
}

/* 自定义表格样式美化 */
.custom-table-container {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.01);
}

.refined-detail-table {
  --el-table-header-bg-color: #f8fafc !important;
  --el-table-border-color: #f1f5f9 !important;
}

.platform-column-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: #0f172a;
}

.mini-platform-logo {
  width: 18px;
  height: 18px;
  border-radius: 4px;
}

.account-name-cell {
  font-weight: 600;
  color: #475569;
  font-size: 12px;
}

.refined-status-tag {
  font-weight: 700;
  border-radius: 6px;
}

.progress-val-cell {
  font-family: monospace;
  font-weight: 700;
  color: #6366f1;
}

.result-link-cell .el-link {
  font-weight: 700;
  font-size: 12px;
}

.error-msg-cell {
  color: #ef4444;
  font-size: 11px;
  word-break: break-all;
  font-weight: 500;
  line-height: 1.4;
}

.empty-val-cell {
  color: #94a3b8;
}

.duration-cell {
  font-size: 11px;
  color: #64748b;
  font-weight: 500;
}

/* 测试步骤校验美化 */
.refined-test-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.refined-test-item {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.test-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.test-item-account {
  font-size: 13px;
  font-weight: 800;
  color: #334155;
}

.test-item-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.test-field-box {
  border: 1px solid #f1f5f9;
  background: #f8fafc;
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.test-field-box.ok {
  border-color: rgba(16, 185, 129, 0.15);
  background: rgba(16, 185, 129, 0.04);
}

.field-box-label {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 700;
}

.field-box-status {
  font-size: 11px;
  font-weight: 700;
  color: #94a3b8;
}

.test-field-box.ok .field-box-status {
  color: #10b981;
}

.test-item-note {
  font-size: 11px;
  color: #d97706;
  background: rgba(217, 119, 6, 0.06);
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(217, 119, 6, 0.1);
  font-weight: 500;
}

/* 实时执行日志美化 */
.refined-log-box {
  background: #0f172a;
  border-radius: 12px;
  padding: 14px 16px;
  max-height: 180px;
  overflow-y: auto;
}

.refined-log-line {
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  margin-bottom: 4px;
  color: #e2e8f0;
  word-break: break-all;
}

.refined-log-line:last-child {
  margin-bottom: 0;
}

.refined-log-line.log-info {
  color: #38bdf8;
}

.refined-log-line.log-warn {
  color: #fbbf24;
}

.refined-log-line.log-error {
  color: #f87171;
}

.log-time {
  color: #64748b;
  margin-right: 6px;
}

.log-lvl {
  font-weight: 700;
  margin-right: 6px;
}

.log-plat, .log-acc, .log-stg {
  color: #a78bfa;
  margin-right: 6px;
}

/* 弹窗底部两端对齐 */
.refined-dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.footer-left-buttons {
  display: flex;
  gap: 8px;
}
</style>