#!/usr/bin/env node
// 移动壳复用桌面那份前端产物（`apps/mobile/src-tauri/tauri.conf.json` 的 `frontendDist`）。
// 这条检查回答一个 APK 那边问不出来的问题：**要被嵌进去的那份 dist 到底在不在、是不是真产物**。
//   - `index.html` 必须在（tauri 的入口）；
//   - 至少一个 `.js` 必须在（不然打开是白屏）；
//   - 总体积要有个**下界**（`vue-tsc` + vite 出来的东西不可能只有几 KB，太小就是构建坏了）；
//   - 总体积还要有个**上界**（缺口 G61）：这条此前只有下界，于是"包一路涨"是**没有人在看**的 ——
//     UI-REDESIGN-BRIEF §4 那一格记着主包 281 kB（gzip ≈94 kB）并写着"仓库目前没有体积门禁"，
//     而增长本身是真实的（216 → 281 kB 就走完了"界面重构 v2"那几十刀）。
//     上界的作用不是"不许变大"，而是"变大的那次要被说出来、并在这里留下新预算的读数"。
// 为什么放在这儿而不是去 APK 里找 JS：tauri v2 是把前端资源**嵌进 Rust 的 `.so`**（`tauri_build`
// 在编壳时把它们打进二进制），APK 的 `assets/` 里根本不会有 `.js`
// —— 这条是 run #17 的 `aapt list` 读数教出来的（那包里 `assets/` 只有 `tauri.conf.json`，
//   而 `native-code: arm64-v8a` 是有的）。所以"UI 进没进包"要在**嵌之前**看，不在包里看。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const root = argv.find((a) => !a.startsWith('--'));
const minBytes = Number(arg('--min-bytes', 40 * 1024));
// 上界的口径在 2026-10-18 改过一次。从前它**排除 `.map`**，理由是「sourcemap 是本机调试用的，
// 生产壳里不加载」—— 那句对「加载」成立、对「进包」不成立：`frontendDist: "../dist"` 是整目录嵌进
// 二进制的（盘上没有 `.taurignore`、也没有排除项），所以 map 躺着没人读，也一样进安装器
// （本机实测：dist 2 199 157 B 里 **1 807 573 B 是 `.map`**，单个 index-*.js.map 1 632 844 B）。
// 现在 `build.sourcemap = false`（`apps/desktop/vite.config.ts`），这条上界改成算**全部字节**、
// 一个扩展名都不排除 ⇒ "谁把 map 打开"由门禁当场拦，不再靠注释提醒。
// **本机差分（2026-10-18，同一棵 0.0.142 树，只改这一处开关）**：
// 关 map 前 dist = 2 199 157 B（含 4 份 `.map` 共 1 807 573 B）→ 关 map 后 dist = **408 835 B / 7 个文件**
// （JS 356 872 + CSS 49 567 + 其余 2 396），少 **1 790 322 B（-81.4%）**，那些字节以前是**随安装器发给每个用户**的。
// 上界仍取 512 KiB = 当前值之上约 1.28 倍：够日常改动，涨到"一次加了很多东西"就红。
// **刀与对照（2026-10-18 实测）**：往 dist 的 `assets/` 里塞一份 **2 431 579 B** 的 `.map`（base64 撑出来的），
// 同一份变异跑两版脚本 —— 改后这版 **FAIL**（`进包合计 2 840 414 … 其中 .map 2 431 579`，exit 1），
// 而 `git show HEAD:` 取出的改前那版 **全过**（它那句 `.map 不计` 就是瞎的地方，exit 0）。
// ⇒ 这条门禁新增的力气全在"不再按扩展名排除"这一句上，不是把数字改小了。
// 变了就显式改这一行，并把新读数写进 commit 与 CHANGELOG —— 那正是这条门禁要的"说出来"。
const maxBytes = Number(arg('--max-bytes', 512 * 1024));
if (!root) {
  console.error('用法：check-frontend-dist.mjs <dist 目录> [--min-bytes 40960] [--max-bytes 524288]');
  process.exit(2);
}

const walk = (dir, acc) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    // 相对路径统一成正斜杠：Windows 上 `join` 给的是反斜杠，
    // 不统一的话 `basename` 切不出来，"index.html 引用了哪个 chunk"这条会永远判不过（本机就是这么红的）。
    else acc.push({ path: p.slice(root.length + 1).split(/[\\/]+/).join('/'), size: st.size });
  }
  return acc;
};

let files;
try {
  files = walk(root, []);
} catch (e) {
  console.error(`读不到 dist 目录 ${root}：${e.message}`);
  process.exit(2);
}
const failures = [];
const total = files.reduce((s, f) => s + f.size, 0);
const index = files.find((f) => f.path === 'index.html');
if (!index) failures.push(`没有 ${root}/index.html —— tauri 的入口不在，壳起来没有页面可加载`);
else if (index.size < 200) failures.push(`index.html 只有 ${index.size} 字节，不像构建出来的入口`);

const js = files.filter((f) => f.path.endsWith('.js'));
if (js.length === 0) failures.push('dist 里一个 .js 都没有 —— 打开必然是白屏');
const css = files.filter((f) => f.path.endsWith('.css'));
if (total < minBytes) failures.push(`dist 总共 ${total} 字节，小于下限 ${minBytes}，像是一次坏掉的构建`);

// 上界算的是**dist 里的每一个字节**，不再按扩展名排除任何东西。逐类仍分开报，
// 这样红的时候直接看得是 JS 涨了还是 CSS 涨了，而不是只看到一个总数。
// 从前它排除 `.map`，那句理由（"生产壳里不加载"）对「加载」成立、对「进包」不成立：
// `tauri.conf.json` 的 `frontendDist: "../dist"` 整目录嵌进二进制，盘上没有 `.taurignore` 也没有排除项
// —— `.map` 就算运行时没人读，也照样躺在安装器里。现在谁把 `build.sourcemap` 改回 true 这条就当场红。
const breakdown = (re) =>
  files.filter((f) => re.test(f.path)).reduce((s, f) => s + f.size, 0);
const shippedBytes = total;
const shippedJs = breakdown(/\.[cm]?js$/);
const shippedCss = breakdown(/\.css$/);
const mapBytes = breakdown(/\.map$/);
if (shippedBytes > maxBytes) {
  failures.push(
    `进包合计 ${shippedBytes} 字节（JS ${shippedJs} + CSS ${shippedCss} + 其余 ${shippedBytes - shippedJs - shippedCss}；其中 .map ${mapBytes}），` +
      `超过上界 ${maxBytes} —— 包在变大（缺口 G61 这条门禁就是为它立的）。` +
      `真是有意加的，就把 --max-bytes 与这条注释里的读数一起改大，并把新数字写进 commit 与 CHANGELOG，别默认放过`,
  );
}

// 入口得真的引用某个 js/chunk，否则"文件在但没人加载"也是白屏
if (index) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const referenced = js.some((f) => html.includes(f.path.split('/').pop()));
  if (!referenced) failures.push('index.html 里没有引用任何一个 dist 里的 .js —— 界面加载不到');
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`check-frontend-dist: ${failures.length} 条不过`);
  process.exit(1);
}
console.log(
  `check-frontend-dist: 全过（${files.length} 个文件 / ${total} 字节 / JS ${js.length} 个 / CSS ${css.length} 个）` +
    `；进包合计 ${shippedBytes} / 上界 ${maxBytes} 字节（JS ${shippedJs} + CSS ${shippedCss} + 其余 ${shippedBytes - shippedJs - shippedCss}；.map ${mapBytes}，一律计入）`,
);
