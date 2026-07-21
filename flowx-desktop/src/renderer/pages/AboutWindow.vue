<template>
  <div class="about-window-container">
    <div class="about-content">
      <div class="about-header">
        <div class="about-logo">
          <el-icon :size="48" color="#409eff"><Promotion /></el-icon>
        </div>
        <div class="about-info">
          <h2>FlowX Desktop</h2>
          <p class="about-subtitle">多平台内容发布工具</p>
          <p class="about-version">版本：v{{ version || '0.1.0' }}</p>
        </div>
      </div>

      <div class="about-desc">
        <p>
          FlowX 是一款基于 Electron 的跨平台桌面客户端，旨在帮助内容创作者高效管理多平台账号，
          一键发布内容到多个平台，省去重复登录和重复发布的繁琐流程。
        </p>
        <p>支持抖音、小红书、快手、微信视频号、知乎、今日头条等主流内容平台。</p>
      </div>

      <el-tabs v-model="activeTab" class="about-tabs">
        <el-tab-pane label="功能特性" name="features">
          <div class="feature-list">
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>多账号管理，独立 session，互不影响</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>一键发布，多平台同步完成</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>定时发布，重启自动恢复调度</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>指纹 UA 与代理 IP 隔离，防关联</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>内置浏览器，一键提取网页内容</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>自定义站点规则，可视化元素拾取</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>测试发布模式，降低误发风险</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>本地加密存储，保障账号安全</span>
            </div>
            <div class="feature-item">
              <el-icon color="#67c23a"><CircleCheck /></el-icon>
              <span>对外 API 接口，支持第三方集成</span>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="更新日志" name="changelog">
          <div class="changelog-content" v-html="changelogHtml"></div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <div class="about-footer">
      <el-button type="primary" @click="handleClose">关闭</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { electronApi } from '../utils/electron';

const version = ref<string>('');
const activeTab = ref('features');
const changelogHtml = ref('');

async function loadChangelog() {
  try {
    const content = await electronApi.readChangelog();
    if (content) {
      changelogHtml.value = simpleMarkdownToHtml(content);
    }
  } catch (e) {
    changelogHtml.value = '<p style="color: #909399;">加载更新日志失败</p>';
  }
}

function simpleMarkdownToHtml(md: string): string {
  let html = md;
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = '<div class="md-content">' + html + '</div>';
  return html;
}

function handleClose() {
  window.close();
}

onMounted(async () => {
  try {
    const info = await electronApi.getSystemInfo();
    version.value = info.version;
  } catch {
    version.value = '0.1.0';
  }
  loadChangelog();
});
</script>

<style scoped>
.about-window-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f7fa;
  padding: 24px;
  box-sizing: border-box;
  overflow: hidden;
}

.about-content {
  flex: 1;
  overflow-y: auto;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  box-sizing: border-box;
}

.about-header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 16px;
}

.about-logo {
  width: 72px;
  height: 72px;
  background: #ecf5ff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.about-info h2 {
  margin: 0 0 4px 0;
  font-size: 22px;
  color: #303133;
}

.about-subtitle {
  margin: 0 0 4px 0;
  color: #606266;
  font-size: 14px;
}

.about-version {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.about-desc {
  color: #606266;
  font-size: 14px;
  line-height: 1.7;
  margin-bottom: 16px;
}

.about-desc p {
  margin: 0 0 8px 0;
}

.about-tabs {
  margin-top: 10px;
}

.feature-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 20px;
  padding: 10px 0;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #606266;
}

.changelog-content {
  max-height: 300px;
  overflow-y: auto;
  padding: 10px 4px;
  font-size: 14px;
  line-height: 1.7;
  color: #606266;
}

.changelog-content :deep(h1) {
  font-size: 20px;
  margin: 16px 0 12px 0;
  color: #303133;
}

.changelog-content :deep(h2) {
  font-size: 17px;
  margin: 14px 0 10px 0;
  color: #303133;
}

.changelog-content :deep(h3) {
  font-size: 15px;
  margin: 12px 0 8px 0;
  color: #303133;
}

.changelog-content :deep(li) {
  margin: 4px 0 4px 20px;
}

.changelog-content :deep(blockquote) {
  margin: 10px 0;
  padding: 8px 12px;
  background: #f5f7fa;
  border-left: 4px solid #409eff;
  color: #606266;
}

.changelog-content :deep(strong) {
  color: #303133;
}

.about-footer {
  display: flex;
  justify-content: center;
  padding-top: 16px;
}
</style>
