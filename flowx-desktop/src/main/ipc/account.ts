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
  safeInvoke('account:beginAuth', (platform: PlatformType) =>
    AccountService.beginAuthorization(platform),
  );

  // 删除账号
  safeInvoke('account:delete', (id: string) => AccountService.deleteAccount(id));

  // 更新账号（昵称/备注）
  safeInvoke(
    'account:update',
    (id: string, patch: { nickname?: string; remark?: string }) =>
      AccountService.updateAccount(id, patch),
  );

  // 手动刷新 token
  safeInvoke('account:refresh', (id: string) => AccountService.refreshToken(id));

  // 用已保存登录态打开平台创作中心窗口（验证登录态）
  safeInvoke('account:openCreator', (id: string) => AccountService.openCreatorPlatform(id));
}
