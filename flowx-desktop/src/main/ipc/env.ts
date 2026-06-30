import { safeInvoke } from './index';
import { BrowserEnvService } from '../services/BrowserEnvService';
import type { ProxyConfig, BrowserEnvironment } from '../../types';

export function registerEnvIpc(): void {
  // ==================== 代理 IP 配置 IPC 监听 ====================

  safeInvoke('env:listProxies', () => {
    return BrowserEnvService.listProxies();
  });

  safeInvoke('env:createProxy', (data: Omit<ProxyConfig, 'id' | 'createdAt'>) => {
    return BrowserEnvService.createProxy(data);
  });

  safeInvoke('env:updateProxy', (id: string, patch: Partial<Omit<ProxyConfig, 'id' | 'createdAt'>>) => {
    return BrowserEnvService.updateProxy(id, patch);
  });

  safeInvoke('env:deleteProxy', (id: string) => {
    return BrowserEnvService.deleteProxy(id);
  });

  // ==================== 浏览器环境配置 IPC 监听 ====================

  safeInvoke('env:listEnvironments', () => {
    return BrowserEnvService.listEnvironments();
  });

  safeInvoke('env:createEnvironment', (data: Omit<BrowserEnvironment, 'id' | 'createdAt'>) => {
    return BrowserEnvService.createEnvironment(data);
  });

  safeInvoke('env:updateEnvironment', (id: string, patch: Partial<Omit<BrowserEnvironment, 'id' | 'createdAt'>>) => {
    return BrowserEnvService.updateEnvironment(id, patch);
  });

  safeInvoke('env:deleteEnvironment', (id: string) => {
    return BrowserEnvService.deleteEnvironment(id);
  });
}
