import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * 消除开发期 MaxListenersExceededWarning：
 * vite-plugin-electron 在每次主进程/preload 热重启时会向同一个 Vite
 * 开发服务器（http.Server）重复注册 `close` 监听器（用于关闭时杀掉 Electron），
 * 多次重启后会超过 Node 默认上限 10 触发报警。该警告非致命，此处仅提高上限消除噪音。
 */
function raiseDevServerMaxListeners(): Plugin {
  return {
    name: 'raise-dev-server-max-listeners',
    configureServer(server) {
      // 返回的函数在 httpServer 监听后执行，此时 server.httpServer 已就绪
      return () => {
        server.httpServer?.setMaxListeners(50);
      };
    },
  };
}


// FlowX 桌面端 Vite 配置
// - 渲染进程: Vue 3 + TS
// - 主进程: Electron (TypeScript)
// - preload: TS，通过 contextBridge 暴露安全 API
// - vite-plugin-electron 推荐做法：
//   * 由 plugin 的 onstart 回调 spawn Electron 进程
//   * 渲染进程 Vite dev server 就绪后才启动 Electron，避免 "ERR_CONNECTION_REFUSED"
export default defineConfig(({ command }) => {
  const isProd = command === 'build';

  return {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@main': resolve(__dirname, 'src/main'),
        '@types': resolve(__dirname, 'src/types'),
      },
    },
    plugins: [
      vue(),
      raiseDevServerMaxListeners(),
      electron([
        {
          // 主进程入口
          entry: 'src/main/index.ts',
          onstart(options) {
            // 关键修复：由 Vite 回调负责启动 Electron，保证 Vite dev server 已在监听端口
            // 主进程内部读取 process.env.VITE_DEV_SERVER_URL 即可
            options.startup();
          },
          vite: {
            build: {
              outDir: 'dist-electron/main',
              sourcemap: true,
              minify: false,
              rollupOptions: {
                external: [
                  'electron',
                  'electron-store',
                  'electron-log',
                  'electron-updater',
                ],
              },
            },
          },
        },
        {
          // preload 脚本
          entry: 'src/preload/index.ts',
          onstart(options) {
            // 热更新：preload 重编译后重载窗口
            options.reload();
          },
          vite: {
            build: {
              outDir: 'dist-electron/preload',
              sourcemap: true,
              minify: false,
              rollupOptions: {
                external: ['electron'],
              },
            },
          },
        },
      ]),
      renderer(),
    ],
    server: {
      // 关键修复：强制 IPv4，避免 Windows 上 localhost 解析为 IPv6 (::1) 导致 connection refused
      host: '127.0.0.1',
      port: 41730, // 使用不常用的高位端口，避免与常见开发服务冲突
      strictPort: false, // 端口被占用时自动尝试下一个可用端口
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
