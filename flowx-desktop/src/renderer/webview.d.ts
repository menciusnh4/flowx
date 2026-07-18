import 'vue';

// Electron <webview> 是自定义元素，vue-tsc 默认不识别其标签 / 属性 / 事件。
// 这里把它声明为一个「接受任意 props、可触发任意事件」的组件，避免模板类型检查报错。
// 运行期由 Electron 提供真实 webview 能力（partition 隔离、openDevTools 等）。
declare module 'vue' {
  interface GlobalComponents {
    webview: {
      new (): {
        $props: Record<string, unknown>;
        $attrs: Record<string, unknown>;
        $emit: (event: string, ...args: any[]) => void;
        $slots: Record<string, unknown>;
      };
    };
  }
}
