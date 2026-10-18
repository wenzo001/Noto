#!/usr/bin/env node
/**
 * `collect-release-assets` 的体积上界**有没有牙**（缺口 #3 的证人）。
 *
 * 为什么单独一个脚本而不是"跑一次看看"：上界表里的数一旦立起来，它最容易坏的形状不是写错，
 * 而是**静默不生效** —— 正则在文件名上落空、`>` 写成 `>=`、新产物类型不在表里没人管。
 * 这三种都不会让发版变红，只会让"包不能变大"这句话变成注释。所以把六臂留在仓里，
 * 由 `arch-check` 每次复跑（与 `hygiene:scratch-budget-guarded` 拿 `clean-scratch --self-test` 同一个做法）。
 *
 *   node scripts/verify-release-ceilings.mjs        # 六臂全过 exit 0；任何一臂不符 exit 1
 *
 * 现场是**合成稀疏文件**（`truncate`），不写真字节、也不碰 `dist-artifacts`；
 * 落点取系统临时目录而不是 `.logs` —— 这条腿自己不该变成下一批的残骸
 * （见 `feedback-dev-scratch-upper-bound`：工装造的现场由工装自己收尾）。
 */
import { mkdirSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const V = '0.0.999';
const MB = 1024 * 1024;

/**
 * 2026-10-18 从 `gh release view v0.0.145 --json assets` 抄下来的**真读数**。
 * 它是 C1 那一臂的对照：这五个数必须**全绿**，否则上界表等于在拦今天自己的包。
 * 改了 `CEILINGS` 而这里没跟着改 ⇒ 要么 C1 红（新上界拦住了真产物），要么 C2/C3 红（上界松到没牙）。
 */
const REAL = {
  'Noto_0.0.999_x64-setup.exe': 5580477,
  'Noto_0.0.999_x64.msi': 7774208,
  'Noto_0.0.999_aarch64.dmg': 6686703,
  'Noto_0.0.999_universal.app.zip': 6635987,
  'app-universal-release-unsigned.apk': 15460569,
};

const ARMS = [
  { name: 'C1 对照：v0.0.145 那五个真读数必须全绿', spec: REAL, want: 0 },
  { name: 'C2 安装器只超上界 1 字节 ⇒ 必须红并点名那一档', spec: { ...REAL, 'Noto_0.0.999_x64-setup.exe': 8 * MB + 1 }, want: 1, wantMsg: 'Windows NSIS 安装器' },
  { name: 'C3 APK 退回 debug 档（156,465,300 B）⇒ 必须红', spec: { ...REAL, 'app-universal-release-unsigned.apk': 156465300 }, want: 1, wantMsg: 'Android APK' },
  { name: 'C4 表外新产物类型（tar.gz）⇒ 必须红，不许静默不设上界', spec: { ...REAL, 'Noto_0.0.999_x64.tar.gz': 4 * MB }, want: 1, wantMsg: '不在体积上界表里' },
  { name: 'C5 旧的 1 MiB 地板还得有牙（加新判据不许拆旧的）', spec: { ...REAL, 'Noto_0.0.999_x64-setup.exe': 500 }, want: 1, wantMsg: '不像一份完整的产物' },
  { name: 'C6 缺一种平台包 ⇒ 必须红（这一臂挡的是"上界那段改动把五种交付物的断言挪走了"）', spec: { ...REAL, 'app-universal-release-unsigned.apk': undefined }, want: 1, wantMsg: '缺 Android APK' },
];

const mk = (dir, spec) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, size] of Object.entries(spec)) {
    const p = join(dir, name);
    writeFileSync(p, '');
    truncateSync(p, size);
  }
};

const base = join(tmpdir(), `notera-ceilings-${process.pid}`);
let bad = 0;
for (const arm of ARMS) {
  const spec = Object.fromEntries(Object.entries(arm.spec).filter(([, v]) => v !== undefined));
  const dir = join(base, arm.name.slice(0, 2));
  mk(dir, spec);
  const out = `${dir}-out`;
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'collect-release-assets.mjs'), '--src', dir, '--out', out, '--version', V], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  rmSync(out, { recursive: true, force: true });
  const codeOk = r.status === arm.want;
  const msgOk = arm.want === 0 || text.includes(arm.wantMsg);
  const ok = codeOk && msgOk;
  if (!ok) bad += 1;
  if (ok) {
    console.log(`ok   ${arm.name}`);
  } else {
    const why = `（退出码 ${r.status} 期望 ${arm.want}${msgOk ? '' : `；没读到「${arm.wantMsg}」`}）`;
    console.log(`FAIL ${arm.name}${why}`);
    console.log(text.split('\n').slice(-6).map((l) => `     ${l}`).join('\n'));
  }
}
rmSync(base, { recursive: true, force: true });
console.log(bad === 0 ? `verify-release-ceilings: ${ARMS.length} 臂全过（上界这条门是活的）` : `verify-release-ceilings: ${bad} 臂不符 —— 判据坏了，别看发版结论`);
process.exit(bad === 0 ? 0 : 1);
