import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Noto 前端构建配置。dev 端口固定 5173（Playwright / 文档均以该端口为准）。
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  envPrefix: ['VITE_'],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // src-tauri 与 Rust 侧产物不属于前端编译输入，忽略以免无谓重启
      ignored: ['**/src-tauri/**', '**/dist/**', '**/node_modules/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // 关 map 不是"省一步调试"，是**这条链路上 map 会随包发出去**：
    // `tauri.conf.json` 的 `frontendDist: "../dist"` 整目录嵌进二进制，盘上没有 `.taurignore`、也没有排除项，
    // 而 `tauri build` 的 beforeBuildCommand 就是 `pnpm build` ⇒ `pnpm build` 出多少 map，安装器里就躺多少。
    // 本机实测 2026-10-18：dist 2 199 157 B 里 **1 807 573 B 是 `.map`**（单个 index-*.js.map 1 632 844 B），
    // 那是"可读回的前端源码"被打包发给每一个用户，同时把安装器抬重。
    // 要调试 release 壳就临时把这里改成 `'source-map'` 本地出一遍，别让它默认进产物。
    sourcemap: false,
  },
});
