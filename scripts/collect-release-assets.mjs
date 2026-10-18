#!/usr/bin/env node
// publish job 的收口检查：把三条出包腿的 Actions Artifacts 摊平成**可贴进 GitHub Release 的一堆文件**，
// 并在贴之前断言"三平台的包真的都在、且是这一版的"。
//
// 为什么这条必须存在（run #18 教出来的）：三条腿全绿之后，红的是 `gh release create` ——
// 它只收 regular file，而 `dist-artifacts/*` 里摊出来一个**目录** `Notera.app/`（§7 承诺的是 `.app.zip`，
// 目录本来就不该出现在这儿）。"job 绿"和"Release 上有用户能下载的三平台包"是两件事，
// §4/§5 要的是后者，所以这一步不能靠 `gh` 自己报错来发现。
//
// 判据都是"看得见的缺项"，不是"应该没问题"：
//   - 裸的 `.app` 目录 ⇒ 直接红（该在 macOS job 里压成 zip，不在这里偷偷 zip）；
//   - 五种产物缺任何一种 ⇒ 红；
//   - 安装器类文件名里带着 `_这一版_` ⇒ 不带就是"贴了别的版本的包"（Windows 那条腿刚踩过这个坑）；
//   - 体积**下限**逐个断（空包 / 半截上传那种"gh 照收不误"的形状）；
//   - 体积**上界**逐档断，而且**不在表里的新产物类型也红**（缺口 #3：用户的抱怨一是"安装包太大"，
//     这一条守的是我们这边别把它加回去 —— 两个实测点写在下面 `CEILINGS` 那段注释里）。
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const src = arg('--src');
const out = arg('--out');
const version = arg('--version');
// 每个产物的体积下限：真正的包不可能小于 1 MiB（0.0.41 实测最窄的是 NSIS 安装器 5.40 MiB）。
// 这条断的是"产物是空的 / 上传半路断了"—— 那种形状 `gh release` 会照收不误。
const minBytes = Number(arg('--min-bytes') ?? 1024 * 1024);
if (!src || !out || !version) {
  console.error('用法：collect-release-assets.mjs --src <产物目录> --out <目标目录> --version <版本号> [--min-bytes 1048576]');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`版本号 ${version} 不像 x.y.z —— 文件名里"是不是这一版"这条就没法判`);
  process.exit(2);
}

// 递归摊平。目录型产物（.app）不在这里处理：见上面注释，见到就红。
const seenDirs = [];
const files = [];
const walk = (dir) => {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    console.error(`读不到 ${dir}：${e.message}`);
    process.exit(2);
  }
  for (const name of names) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name.endsWith('.app') || name.endsWith('.bundle')) seenDirs.push(p);
      walk(p);
    } else if (st.isFile()) {
      files.push({ path: p, size: st.size });
    }
  }
};
try {
  walk(src);
} catch (e) {
  console.error(`摊不开产物目录 ${src}：${e.message}`);
  process.exit(2);
}

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b));
const byName = new Map();
const failures = [];

for (const f of files) {
  const name = basename(f.path);
  const prev = byName.get(name);
  if (prev === undefined) {
    byName.set(name, f);
    continue;
  }
  // 同名不同内容 ⇒ 不能随便挑一个（挑错就是把用户的包贴错）。同名同内容才是重复投递，丢掉一份。
  if (prev.size === f.size && sameBytes(prev.path, f.path)) {
    console.log(`跳过重复产物：${name}（两份字节相同）`);
    continue;
  }
  failures.push(`两个不同的产物撞在同一个文件名上：${prev.path} 与 ${f.path} —— 得在出包那条腿里改名，不能在这里猜`);
}

if (seenDirs.length > 0) {
  failures.push(
    `产物里有裸的目录型 bundle：${seenDirs.join('、')} —— ` +
      `gh release 只收 regular file，CI-CD §7 承诺的是 .app.zip，该在 macOS 那条腿里压好再上传`,
  );
}

// 体积下限逐个断：空包 / 半截上传在这儿就该红，而不是等用户下载到一个装不上的文件。
for (const [name, f] of byName) {
  if (f.size < minBytes) failures.push(`${name} 只有 ${f.size} 字节（下限 ${minBytes}）—— 不像一份完整的产物`);
}

/**
 * 体积**上界**（缺口 #3；用户 2026-10-18 抱怨一"每个平台的安装包太大了"说的是 Joplin，
 * 而这条门守的是"别把它变成我们的问题"）。口径与 `scripts/check-frontend-dist.mjs` 同一条：
 * **上界的作用不是"不许变大"，是"变大的那一次必须被说出来，并在这里留下新预算的读数"**。
 * 每一档都记着它自己的实测读数（2026-10-18，v0.0.145 那批真产物，`gh release view` 的 `assets[].size`），
 * 余量倍数就写在旁边 —— 没有读数的那个数就是凭空拍的，凭空拍的阈值既不指方向也守不住。
 *
 * 两个数值得留在这段注释里，因为它们解释了为什么 APK 那一档最宽：
 *  · Android 从 debug 档换到 release 档：**156,465,300 B → 15,460,569 B（10.1×）** ——
 *    上一批那 149 MiB 不是"包坏了"，是档位（debug 不裁剪、不压缩、留 mini-debug-info）；
 *  · 用户真正会装的那一档（Windows `*-setup.exe`）今天是 **5,580,477 B**，
 *    同一份对照表里 Joplin 3.7.21 是 ~93 MiB ⇒ **体积不是我们的缺陷，往后把它加上去才是**。
 */
const MB = 1024 * 1024;
const CEILINGS = [
  { label: 'Windows NSIS 安装器', pick: /-setup\.exe$/i, maxBytes: 8 * MB, reading: 5580477 },
  { label: 'Windows MSI', pick: /_x64.*\.msi$/i, maxBytes: 11 * MB, reading: 7774208 },
  { label: 'macOS 磁盘镜像', pick: /\.dmg$/i, maxBytes: 10 * MB, reading: 6686703 },
  { label: 'macOS app 包（zip）', pick: /\.app\.zip$/i, maxBytes: 10 * MB, reading: 6635987 },
  { label: 'Android APK', pick: /\.apk$/i, maxBytes: 24 * MB, reading: 15460569 },
];
const ceilingHits = new Set();
for (const [name, f] of byName) {
  const hit = CEILINGS.filter((c) => c.pick.test(name));
  for (const c of hit) ceilingHits.add(name);
  for (const c of hit) {
    if (f.size > c.maxBytes) {
      failures.push(
        `${c.label} 的 ${name} 是 ${f.size} 字节，超过上界 ${c.maxBytes}（预算建立时的读数是 ${c.reading}）` +
          ` —— 包在变大。真是有意的，就把这一档的上界与旁边那个读数一起改大，并写进 commit 与 CHANGELOG，别默认放过`,
      );
    }
  }
}
// 没有对应档位的新产物类型 ⇒ 红。少了这一格，"上界"对第一个不在表里的产物类型就是**静默不检查**
// （与"扫到 0 项 ≠ 检查过"同一族：名单漏一档不会让门变红，只会让那一档没人看）。
const unbounded = [...byName.keys()].filter((n) => !ceilingHits.has(n) && n !== 'SHA256SUMS.txt');
for (const n of unbounded) {
  failures.push(`${n} 不在体积上界表里（现有档位：${CEILINGS.map((c) => c.label).join('、')}）—— 新增产物类型要先给它立一档，不许让它绕过这条门`);
}

// 五种交付物：§4 的"三平台包"＋ §5 的"构建产物随版本走"。
const required = [
  { label: 'Windows MSI', pick: (n) => /_x64.*\.msi$/i.test(n), versioned: true },
  { label: 'Windows NSIS 安装器', pick: (n) => /-setup\.exe$/i.test(n), versioned: true },
  { label: 'macOS 磁盘镜像', pick: (n) => /\.dmg$/i.test(n), versioned: true },
  { label: 'macOS app 包（zip）', pick: (n) => /\.app\.zip$/i.test(n), versioned: true },
  // gradle 的 APK 文件名里没有版本号（versionName 由 check-apk-badging.mjs 在包内断言），
  // 这里只断它在不在，不断名字。
  { label: 'Android APK', pick: (n) => /\.apk$/i.test(n), versioned: false },
];
const names = [...byName.keys()];
for (const r of required) {
  const hit = names.filter(r.pick);
  if (hit.length === 0) {
    failures.push(`缺 ${r.label}：贴上去的文件里没有这一个平台的包（现有：${names.join('、') || '空'}）`);
    continue;
  }
  if (r.versioned) {
    const wrong = hit.filter((n) => !n.includes(`_${version}_`));
    if (wrong.length > 0) {
      failures.push(`${r.label} 的名字里不含 _${version}_ ：${wrong.join('、')} —— 这贴的不是这一版的包`);
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`collect-release-assets: ${failures.length} 条不过（扫到 ${files.length} 个文件）`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const report = [];
for (const [name, f] of [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  copyFileSync(f.path, join(out, name));
  const digest = createHash('sha256').update(readFileSync(join(out, name))).digest('hex');
  report.push(`${digest}  ${name}`);
}
// 清单自己不进清单（它是算完别人之后才写的）；格式跟 `sha256sum` 一致（两个空格），`sha256sum -c` 能直接吃。
writeFileSync(join(out, 'SHA256SUMS.txt'), `${report.join('\n')}\n`, 'utf8');
console.log(report.join('\n'));
// 把"这一版的每个包多大、离上界还有多少"打在日志里 —— 阈值本身留在上面那张表，
// 而**当前读数**归这一步每次自己印（第一百十五批从 CI 步骤名里摘掉的就是"把一次实测抄成长期标签"）。
const mb = (n) => (n / MB).toFixed(2);
for (const [name, f] of [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const c = CEILINGS.find((x) => x.pick.test(name));
  console.log(`  体积：${name} = ${mb(f.size)} MiB${c ? ` / 上界 ${mb(c.maxBytes)} MiB（预算读数 ${mb(c.reading)} MiB）` : '（清单文件，不设上界）'}`);
}
console.log(`collect-release-assets: ${report.length} 个产物已摊平进 ${out}（SHA256SUMS.txt 一并生成）`);
