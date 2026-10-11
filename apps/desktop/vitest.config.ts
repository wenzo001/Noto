import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  envPrefix: ['VITE_'],
  test: {
    environment: 'jsdom',
    // jsdom 缺的浏览器 API 补在这里（组件里不许写"只在测试里成立"的分支）
    setupFiles: ['src/testing/dom-stubs.ts'],
    include: ['src/**/*.spec.ts'],
    globals: false,
    // css:true 才能让 `?raw` 拿到真内容；css:false 会把整个 CSS 模块 stub 成空串，
    // 于是 token 契约测试全部拿到 ''（假绿/假红都可能出现）。
    css: true,
    restoreMocks: true,
    /**
     * 环境预算，不是判据 —— 默认 5000ms 在 CI 上会**假红**：
     * 真读数（run 38112217400，2026-10-11）`syncClickGate.spec.ts:82` 用了 **5621ms** 然后
     * `Error: Test timed out in 5000ms`，而同一份代码本机跑是 ~1s 内过；同一批里
     * `notePinDot.spec.ts` 那条也到了 4320ms —— 差 0.7 秒就一起红。
     * 这些用例的耗时全在 `mount(App)` 整机挂载（jsdom + 全部 store + 定时器），
     * 与它们断言的东西无关；两个实测点（本机 ~1s / CI 5.6s）之间只能把上限抬高，
     * 断言一字不动。这一格是"多久算卡死"的上限，不是任何一条判据的预算 ——
     * 全仓库现在没有一条 `it(..., ms)` 自带预算，带时间断言的那些走的是 fake timers
     * （`vi.useFakeTimers` / `advanceTimersByTime`），抬高这个天花板动不到它们。
     */
    testTimeout: 20_000,
  },
});
