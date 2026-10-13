/**
 * 本项目**没装 `@types/node`**（否则 `vue-tsc` 会因为这份声明缺失而在别处产生歧义；
 * 现有源码扫描类 spec 一律用 `import.meta.glob` 正是绕开这一点 —— 见 uiFeedback.spec.ts 的注释）。
 *
 * 例外是 `motion.spec.ts`：它在 `@vitest-environment node` 下**直接读磁盘字节**，刻意不走 vite 管线
 * （`?raw` glob 在"文件刚被改写"时实测读回过旧内容与空串，那样的仪器当不了变异证明的证人）。
 * 所以这里补一份**只覆盖用到的那几个函数**的最小声明；新增用法时要同步扩这张表。
 */
declare module 'node:fs' {
  interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  /** §6 标签那一格要按后缀挑迁移文件，取的是**名字**而不是 Dirent（两参那一支重载挑不到它）。 */
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
