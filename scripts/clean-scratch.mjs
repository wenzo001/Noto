#!/usr/bin/env node
/**
 * 本地工装残骸的清理与预算看守（缺口 G97）。
 *
 * 为什么要它：验证类工装各自往 `.logs/` 与 `.notera-dev/` 里写东西，而"用完就删"没人执行 ——
 * 一次 `verify-perf` 的 20000 条夹具就是 43 MB 的 sqlite，换一个 `RUN_TAG` 又多一份；
 * 实测 `.logs/` 涨到 **197 MB / 1155 个文件**。git 里看不见（`.gitignore` 早就挡了），
 * 所以它红不了任何门禁 —— 只能由这个脚本按预算砍。
 *
 *   node scripts/clean-scratch.mjs              # 清理并打印
 *   node scripts/clean-scratch.mjs --check      # 只报不删，超预算 exit 1（CI / 门禁那一头用这个）
 *   node scripts/clean-scratch.mjs --self-test  # "何时该删"那套数学的合成序列自检（臂数由脚本自己报）
 *
 * 三条口径写死在这里，改口径就改这一处：
 *  · **过期的就删**：超过 `logsKeepDays` 的删掉；`perf-*` 夹具目录只等 `perfKeepDays`
 *    （一次 20000 条的实验就是 43 MB，按三天等不起）；
 *  · **预算优先**：总量超 `logsMaxMb` 就从最旧的接着砍，砍到预算内为止 ——
 *    光按天数砍挡不住"一次实验造出 1 GB"那一形；
 *  · **现场保护**：最近 `logsKeepNewest` 项在预算那一轮不许动（正在排查这一轮的东西不是垃圾），
 *    砍不动就报 leftover，不假装成功。
 * EPERM（Windows 上文件还被进程握着）不当失败：重试两次，剩下的一律记成 leftover 报出来，
 * 由下一次运行接着收 —— 上一版 `verify-layout` 就是在这儿抛出去把整条门禁打断的。
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DAY = 86400000;

export const BUDGET = {
  logsDir: '.logs',
  // **两个口径，各自有实测的两点**（第卅二批改的就是这一格，缺口 G125）：
  //  · `logsMaxMb` 只管**残骸**（下面 `resident` 之外的那些项）。今天这台机器：残骸 1.5 MB；
  //    当年立这条守卫的病态形状是单次 43 MB 的 perf 夹具 / 累积 197 MB ⇒ 24 MB 落在两点之上、病灶之下。
  //  · `totalMaxMb` 管 `.logs` **总量**（含常驻现场）。常驻现场实测 57 MB（`g102-data`：布局门禁的库 + 3 份设计内备份），
  //    历史上最脏是 197 MB ⇒ 128 MB 是"总量还有余量、但涨到病灶那一级必红"。
  logsMaxMb: 24,
  totalMaxMb: 128,
  logsKeepDays: 3,
  // 地板从 40 降到 8：**这一条以前是恒真的** —— `.logs` 一共 42 项，"保护最近 40 项"等于
  // 每一项都在保护里，于是预算那一轮在任何磁盘状态下都删不掉东西，只能喊"请人工看"
  // （与 ㊻ 那次"假豁免宽过样本全体"同族）。留 8 项是"正在排查这一轮的东西"的真实量级。
  logsKeepNewest: 8,
  perfKeepDays: 1,
  // 被脚本引用的**常驻现场**：不是残骸，预算与删除都绕开它们（名单必须能被证伪 —— 列了却不存在就报）。
  resident: ['g102-data'],
  backupsDir: '.notera-dev/backups',
  backupsKeep: 1,
};

/**
 * 纯函数：什么时候删。输入是"一项东西"的读数（路径、字节、age 天数、是不是 perf 夹具目录），
 * 输出是该删的路径与删完剩下的字节。
 * 做成纯函数是为了能被合成序列自测 —— 判据若只能拿真磁盘跑，"0 个问题"与"扫描压根没跑"就分不开。
 */
export function planPrune(entries, b = BUDGET) {
  const maxBytes = b.logsMaxMb * 1048576;
  // 常驻现场（被脚本引用的那几格）**不进残骸这一本账**：既不预算轮里砍，也不计入超预算的分子。
  const resident = (e) => (b.resident ?? []).includes(e.name);
  const pool = entries.filter((e) => !resident(e));
  const residentBytes = entries.filter(resident).reduce((a, e) => a + e.bytes, 0);
  const sorted = [...pool].sort((x, y) => x.ageDays - y.ageDays);
  const doomed = new Set();
  let bytes = pool.reduce((a, e) => a + e.bytes, 0);
  // 第一轮：过期。 newest-N 那条地板只管预算那一轮 —— 放了三天的一篇日志不是"现场"。
  for (const e of sorted) {
    if (e.perf ? e.ageDays > b.perfKeepDays : e.ageDays > b.logsKeepDays) { doomed.add(e.path); bytes -= e.bytes; }
  }
  // 第二轮：预算。从**最旧**的开始砍到预算内，但最近 `logsKeepNewest` 项不动（现场保护）。
  // 注意 `sorted` 是"新→旧"，所以这一轮要反着走 —— 上一版顺着走，砍的是刚写的那一份。
  const floor = new Set(sorted.slice(0, b.logsKeepNewest).map((e) => e.path));
  for (const e of [...sorted].reverse()) {
    if (bytes <= maxBytes) break;
    if (floor.has(e.path) || doomed.has(e.path)) continue;
    doomed.add(e.path); bytes -= e.bytes;
  }
  return { doomed: [...doomed], remainingBytes: bytes, residentBytes, totalBytes: bytes + residentBytes };
}

function stat(path) {
  try { return statSync(path); } catch { return null; }
}

function entriesOf(dir, nowMs) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = stat(full);
    if (!s) continue;
    out.push({
      path: full,
      name,
      bytes: s.isDirectory() ? dirBytes(full) : s.size,
      ageDays: (nowMs - s.mtimeMs) / DAY,
      perf: /^perf-/.test(name),
    });
  }
  return out;
}

function dirBytes(dir) {
  let sum = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = stat(full);
    if (!s) continue;
    sum += s.isDirectory() ? dirBytes(full) : s.size;
  }
  return sum;
}

function removeTolerant(path, leftovers) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); return; } catch (error) {
      if (attempt === 2) leftovers.push(`${path} —— ${error.code ?? error.message}`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
}

/** 干活的那一半：算出该删的、删掉（EPERM 容忍）、回报。`dryRun` 只算不删。 */
export function sweep(b = BUDGET, { dryRun = false, nowMs = Date.now() } = {}) {
  const logs = join(ROOT, b.logsDir);
  const items = entriesOf(logs, nowMs);
  const plan = planPrune(items, b);
  const mb = (n) => (n / 1048576).toFixed(1);
  const report = {
    files: items.length,
    beforeMb: mb(items.reduce((a, e) => a + e.bytes, 0)),
    doomed: plan.doomed,
    afterMb: mb(plan.remainingBytes),
    residentMb: mb(plan.residentBytes),
    totalMb: mb(plan.totalBytes),
    // 残骸超预算，或**总量**超预算（常驻现场失控是另一件事，也要红）。
    overBudget: plan.remainingBytes > b.logsMaxMb * 1048576,
    overTotal: plan.totalBytes > (b.totalMaxMb ?? 1e9) * 1048576,
    // 豁免名单要能被证伪：列了却不在盘上 = 这条名单已经过期（与 §㉕ 那条"把手数量"同族）。
    staleResident: (b.resident ?? []).filter((n) => !items.some((e) => e.name === n)),
    leftovers: [],
    backupsRemoved: 0,
  };
  const leftovers = report.leftovers;
  for (const p of plan.doomed) if (!dryRun) removeTolerant(p, leftovers);

  const backups = join(ROOT, b.backupsDir);
  if (existsSync(backups)) {
    const rows = readdirSync(backups)
      .map((name) => ({ name, s: stat(join(backups, name)) }))
      .filter((r) => r.s && r.s.isFile())
      .sort((x, y) => y.s.mtimeMs - x.s.mtimeMs);
    for (const r of rows.slice(b.backupsKeep)) {
      if (!dryRun) removeTolerant(join(backups, r.name), leftovers);
      report.backupsRemoved += 1;
    }
  }
  return report;
}

function selfTest() {
  const b = { ...BUDGET, logsKeepNewest: 2, logsKeepDays: 3, perfKeepDays: 1, logsMaxMb: 10 };
  const MB = 1048576;
  const cases = [
    {
      name: '放了九天的该删，昨天的留着',
      in: [{ path: 'a', bytes: MB, ageDays: 0 }, { path: 'b', bytes: MB, ageDays: 1 }, { path: 'c', bytes: MB, ageDays: 9 }],
      want: ['c'],
    },
    {
      name: 'perf 夹具目录过一天就砍（一次实验 43 MB，按三天等不起）；同齡的普通日志不砍',
      in: [{ path: 'p', bytes: 43 * MB, ageDays: 1.5, perf: true }, { path: 'q', bytes: MB, ageDays: 1.5 }],
      want: ['p'],
    },
    {
      name: '都年轻但总量超预算 ⇒ 从**最旧**的开始砍到预算内，最近那两项不动',
      in: [{ path: 'a', bytes: 4 * MB, ageDays: 0 }, { path: 'b', bytes: 4 * MB, ageDays: 0.2 },
        { path: 'c', bytes: 4 * MB, ageDays: 0.4 }, { path: 'd', bytes: 4 * MB, ageDays: 0.6 }],
      want: ['d', 'c'],
    },
    {
      name: '全是刚写的（都在现场保护那一档里）⇒ 一条都不许砍，差额由调用方报 leftover',
      in: [{ path: 'a', bytes: 40 * MB, ageDays: 0 }, { path: 'b', bytes: 40 * MB, ageDays: 0.1 }],
      want: [],
    },
    { name: '空输入不该编出删除项', in: [], want: [] },
    // ↓ 这两臂是缺口 G125 补的：**旧的五臂永远测不到生产那档地板**（生产 `logsKeepNewest = 40`，
    //   而盘上一共 42 项 ⇒ 每一项都在"现场保护"里，预算那一轮恒久删不掉东西）。
    //   这一臂拿**生产的地板 8** 与**12 项**一起过：最旧的 4 项必须被砍（项数多于地板时砍得动）。
    {
      name: '项数多于地板时预算那一轮真的砍得动（生产档地板 8、12 项 ×2 MB、上限 10 MB ⇒ 最旧 4 项该走）',
      bp: { ...b, logsKeepNewest: 8, logsMaxMb: 10 },
      in: Array.from({ length: 12 }, (_, i) => ({ path: `p${i + 1}`, name: `p${i + 1}`, bytes: 2 * MB, ageDays: 0.01 * (i + 1) })),
      want: ['p9', 'p10', 'p11', 'p12'],
    },
    // 常驻现场不是残骸：放了九天也不许砍（它被脚本引用着，砍了就是把门禁的库删了）。
    {
      name: 'resident 名单里那一格即便过期也不进删除集（其余过期的照砍）',
      bp: { ...b, resident: ['lib'] },
      in: [{ path: 'lib', name: 'lib', bytes: 40 * MB, ageDays: 9 },
        { path: 'x', name: 'x', bytes: MB, ageDays: 9 }, { path: 'y', name: 'y', bytes: MB, ageDays: 0.2 }],
      want: ['x'],
    },
  ];
  let bad = 0;
  for (const c of cases) {
    // **按身份比，不按顺序比**：`doomed` 是一个集合（删除顺序不进契约），
    // 而 `for` 循环遍历的是"从最旧开始"，于是数组字面量当期望就会因位置而假红 ——
    // 这一臂第一跑就是这么红的（要 ["p9","p10","p11","p12"]，实际 ["p12","p11","p10","p9"]，是同一批东西）。
    const norm = (a) => [...a].sort().join('|');
    const got = planPrune(c.in, c.bp ?? b).doomed;
    const ok = norm(got) === norm(c.want);
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} ⇒ 该删 ${JSON.stringify(c.want)}，实际 ${JSON.stringify(got)}`);
  }
  console.log(bad === 0 ? `${cases.length} 臂全过（这条看守自己是活的）` : `${bad} 臂不符 —— 判据坏了，别看磁盘结论`);
  return bad === 0 ? 0 : 1;
}

// 只有被当命令跑才动手；被 import（arch-check 那条规则要的是纯函数）时不碰磁盘、不 exit。
const isCli = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/clean-scratch.mjs');
if (isCli) {
  const arg = process.argv[2] ?? '';
  if (arg === '--self-test') process.exit(selfTest());
  const r = sweep(BUDGET, { dryRun: arg === '--check' });
  console.log(`${arg === '--check' ? '预算检查' : '清理'}：${r.files} 项 ⇒ 删 ${r.doomed.length} 项（备份清掉 ${r.backupsRemoved} 份）`);
  console.log(`  残骸 ${r.afterMb} MB / 上界 ${BUDGET.logsMaxMb} MB ·（另有常驻现场 ${r.residentMb} MB，不计入这本账）· 总量 ${r.totalMb} MB / 上界 ${BUDGET.totalMaxMb} MB`);
  for (const l of r.leftovers) console.log(`  带不走（下次再收）：${l}`);
  for (const n of r.staleResident) console.log(`  豁免名单过期：${n} 不在盘上 —— 要么把它加回来，要么把这一格从名单里删掉`);
  if (r.overBudget) console.log(`  ⚠ 残骸砍完仍超预算（${r.afterMb} MB > ${BUDGET.logsMaxMb} MB）—— 只剩"最近 ${BUDGET.logsKeepNewest} 项"那一形，请人工看`);
  if (r.overTotal) console.log(`  ⚠ 总量超预算（${r.totalMb} MB > ${BUDGET.totalMaxMb} MB）—— 常驻现场本身在长，看 ` + BUDGET.resident.join('/') + ` 那几格`);
  process.exit(arg === '--check' && (r.overBudget || r.overTotal || r.doomed.length > 0 || r.staleResident.length > 0) ? 1 : 0);
}
