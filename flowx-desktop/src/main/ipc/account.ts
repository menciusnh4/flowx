import { safeInvoke } from './index';
import { AccountService } from '../services/AccountService';
import { PLATFORMS, listPlatforms } from '../services/PlatformRegistry';
import type { PlatformType } from '../../types';

export function registerAccountIpc(): void {
  // 获取支持的平台列表
  safeInvoke('account:listPlatforms', () => listPlatforms());

  // 获取所有账号
  safeInvoke('account:list', () => AccountService.listAccounts());

  // 单个账号详情
  safeInvoke('account:get', (id: string) => AccountService.getAccount(id));

  // 启动授权流程：打开浏览器弹窗让用户登录，返回新账号
  safeInvoke('account:beginAuth', (platform: PlatformType, envId?: string | null) =>
    AccountService.beginAuthorization(platform, envId),
  );

  // 删除账号
  safeInvoke('account:delete', (id: string) => AccountService.deleteAccount(id));

  // 更新账号（昵称/备注/分类/环境）
  safeInvoke(
    'account:update',
    (id: string, patch: { nickname?: string; remark?: string; categoryIds?: string[]; envId?: string | null }) =>
      AccountService.updateAccount(id, patch),
  );

  // 手动刷新 token
  safeInvoke('account:refresh', (id: string) => AccountService.refreshToken(id));

  // 用已保存登录态打开平台创作中心窗口（验证登录态）
  safeInvoke('account:openCreator', (id: string) => AccountService.openCreatorPlatform(id));

  // 单个账号健康检测（静默检测，不弹用户可编辑的窗口）
  safeInvoke('account:healthCheck', (id: string) => AccountService.checkAccountHealth(id));

  // 批量检测所有账号的登录态/统计信息
  safeInvoke('account:healthCheckAll', () => AccountService.checkAllAccountsHealth());

  // 启动/配置定时健康检测（intervalMs = 0 停止）
  safeInvoke(
    'account:setHealthCheckInterval',
    (intervalMs: number, initialDelayMs = 0) => {
      AccountService.startHealthCheckTimer(intervalMs, initialDelayMs);
      return true;
    },
  );

  // 获取当前健康检测配置（供 UI 展示）
  safeInvoke('account:getHealthCheckConfig', () => AccountService.getHealthCheckConfig());

  // 更新健康检测配置（同时持久化保存 + 重启定时器）
  safeInvoke(
    'account:setHealthCheckConfig',
    (cfg: { intervalMs: number; initialDelayMs?: number; enabled?: boolean }) =>
      AccountService.setHealthCheckConfig(cfg),
  );

  // 获取所有分类
  safeInvoke('account:listCategories', () => AccountService.listCategories());

  // 创建分类
  safeInvoke('account:createCategory', (name: string) => AccountService.createCategory(name));

  // 修改分类
  safeInvoke('account:updateCategory', (id: string, name: string) => AccountService.updateCategory(id, name));

  // 删除分类
  safeInvoke('account:deleteCategory', (id: string) => AccountService.deleteCategory(id));
}
