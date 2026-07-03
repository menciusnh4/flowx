import { safeInvoke } from './index';
import { ApiServer } from '../services/ApiServer';

export function registerApiServerIpc(): void {
  // 获取 API 服务配置
  safeInvoke('apiServer:getConfig', () => {
    return ApiServer.getInstance().getConfig();
  });

  // 保存 API 服务配置
  safeInvoke('apiServer:saveConfig', (config: { enabled?: boolean; port?: number; apiKey?: string }) => {
    const server = ApiServer.getInstance();
    server.saveConfig(config);
    // 如果启用状态或端口变了，重启服务
    return server.restart().then(() => {
      return {
        config: server.getConfig(),
        running: server.isRunning(),
      };
    });
  });

  // 获取服务运行状态
  safeInvoke('apiServer:status', () => {
    const server = ApiServer.getInstance();
    return {
      running: server.isRunning(),
      config: server.getConfig(),
    };
  });

  // 启动服务
  safeInvoke('apiServer:start', () => {
    return ApiServer.getInstance().start().then(() => {
      return { running: true };
    });
  });

  // 停止服务
  safeInvoke('apiServer:stop', () => {
    return ApiServer.getInstance().stop().then(() => {
      return { running: false };
    });
  });
}
