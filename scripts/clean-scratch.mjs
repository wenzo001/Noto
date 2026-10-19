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
 *   **其余任何参数一律拒绝（exit 2，先打印能用的三个）** —— 这一条是本脚本自己赔出来的：
 *   敲 `--help` 以前会被读成"不是 --check"，于是**直接按默认档删文件**（2026-10-18 因此销毁了
 *   `.logs/parallel-caps-batch-20261013.patch`，那是并行批次撤回主干之后**唯一那份可逆证明**，
 *   `.logs` 不进版本控制 ⇒ git 还得回来）。一条会删东西的命令，对拼错的 flag 不许沉默。
 *
 * 三条口径写死在这里，改口径就改这一处：
 *  · **过期的就删**：超过 `logsKeepDays` 的删掉；`perf-*` 夹具目录只等 `perfKeepDays`
 *    （一次 20000 条的实验就是 43 MB，按三天等不起）；
 *  · **预算优先**：总量超 `logsMaxMb` 就从最旧的接着砍，砍到预算内为止 ——
 *    光按天数砍挡不住"一次实验造出 1 GB"那一形；
 *  · **现场保护**：最近 `logsKeepNewest` 项在预算那一轮不许动（正在排查这一轮的东西不是垃圾），
 *    砍不动就报 leftover，不假装成功。
 * 第四条是这一批加的：**`*.patch` 是可逆证明，不是残骸** —— `.logs/*-pending.patch` 那类"半修先存下来"
 * 的补丁按仓内规矩本身就是"还没落地、落地了改名 `-applied`"的账，所以它**永不进删除集**，
 * 也不计进残骸预算（和常驻现场同一本账）。例外那一半（`*-applied.patch` 照收）有自己那一臂，
 * 免得"保护"扩成"整族都留"—— 那正是 [[feedback-dev-scratch-upper-bound]] 里那条最坏形状。
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
  // **可逆证明**：`.logs` 里的 `*.patch` 是"半修先存下来、落地了改名 `-applied`"那份账（见
  // `feedback-dev-scratch-upper-bound` 与 `park-half-fixes-as-patch-and-record-blocked`）。
  // 它们既不删也不计进残骸预算 —— 但例外那一半（`unprotected`）必须照收，
  // 否则"保护"又扩成"这一族整族都留"，那正是这条上界最坏的实现形状。
  protected: [/\.patch$/],
  unprotected: [/-applied\.patch$/],
  backupsDir: '.notera-dev/backups',
  backupsKeep: 1,
  /**
   * **常驻目录自己也在长**（第一百五十三批现场：`g102-data` 从设计时的 57 MB 长到 136 MB，
   * 把 `.logs` 总量顶到 144 MB > 128 ⇒ 那条预算门红了，而红得没人能怪它）。
   * 长出来的不是"现场"，是布局门禁那几条 restore / migration 腿**每跑一遍各留一份 ~19 MB 的库拷贝**，
   * 而 `resident` 那一格把整个目录豁免在残骸账外 ⇒ 没有任何东西管着它们。
   * 所以这里按"族"管：每一族只留最新 `keep` 份，其余是残骸。`--check` 数到超档的就**报红**，
   * 不喊"请人工看" —— 喊人看的那道门一年后被自己绕开（同一族教训）。
   */
  residentCopies: [
    { dir: '.logs/g102-data', re: /^notera\.sqlite\.pre-(restore|migration)\./, keep: 1, what: '门禁 restore/migration 腿留下的库拷贝' },
    { dir: '.logs/g102-data/backups', re: /^notera-.*\.sqlite$/, keep: 1, what: '迁移前自动备份' },
  ],
};

/**
 * 纯函数：一族文件里该删哪几份 —— 按 mtime 留最新 `keep` 份，其余全删。
 * 做成纯函数是为了能被合成序列打到（"扫到 0 项 ≠ 检查过"那条老规矩）：
 * 三份不同 mtime ⇒ 删 2 留 1；只有一份 ⇒ 删 0（这一臂挡的是"地板 ≥ 总数所以恒真"那个形状的反面 ——
 * 这里 `keep=1` 配一份时必须**不删**，配三份时必须删两份，两个方向都要有读数）。
 */
export function planCopies(files, keep = 1) {
  const sorted = [...files].sort((x, y) => y.mtimeMs - x.mtimeMs);
  const doomed = sorted.slice(Math.max(0, keep));
  return { doomed: doomed.map((f) => f.path), kept: sorted.length - doomed.length, bytes: doomed.reduce((a, f) => a + f.bytes, 0) };
}

/**
 * 纯函数：什么时候删。输入是"一项东西"的读数（路径、字节、age 天数、是不是 perf 夹具目录），
 * 输出是该删的路径与删完剩下的字节。
 * 做成纯函数是为了能被合成序列自测 —— 判据若只能拿真磁盘跑，"0 个问题"与"扫描压根没跑"就分不开。
 */
export function planPrune(entries, b = BUDGET) {
  const maxBytes = b.logsMaxMb * 1048576;
  // 常驻现场（被脚本引用的那几格）**不进残骸这一本账**：既不预算轮里砍，也不计入超预算的分子。
  const resident = (e) => (b.resident ?? []).includes(e.name);
  // 可逆证明走同一本账，但它的"过期那一半"由 `unprotected` 单独放行 —— 两个名单都是空的时恒不保护，
  // 所以这一族有没有牙全靠 selfTest 那三臂（扫到 0 项 ≠ 检查过）。
  const isProtected = (e) =>
    (b.protected ?? []).some((re) => re.test(e.name ?? '')) &&
    !(b.unprotected ?? []).some((re) => re.test(e.name ?? ''));
  const pool = entries.filter((e) => !resident(e) && !isProtected(e));
  const residentBytes = entries.filter((e) => resident(e) || isProtected(e)).reduce((a, e) => a + e.bytes, 0);
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

  /**
   * 常驻目录自己长出来的那些拷贝（每族只留最新 `keep` 份）。
   * 这一族以前**没人管**：`resident` 把整个目录豁免在残骸账外，于是"门禁每跑一遍留一份 19 MB 的库拷贝"
   * 这件事只会体现为"总量在涨"，而涨到顶了那条门只喊一句"看那几格"—— 不删、也不说哪一族。
   * 现在按族点名：`--check` 数到超档的就红（与残骸那本账同一个口径：能删的没删完就是没干净）。
   */
  report.copiesRemoved = 0;
  report.copiesOver = 0;
  let copiesBytes = 0;
  for (const fam of b.residentCopies ?? []) {
    const dir = join(ROOT, fam.dir);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((name) => fam.re.test(name))
      .map((name) => ({ path: join(dir, name), name, s: stat(join(dir, name)) }))
      .filter((f) => f.s && f.s.isFile())
      .map((f) => ({ path: f.path, bytes: f.s.size, mtimeMs: f.s.mtimeMs }));
    const plan = planCopies(files, fam.keep);
    report.copiesOver += plan.doomed.length;
    copiesBytes += plan.bytes;
    for (const p of plan.doomed) {
      if (!dryRun) removeTolerant(p, leftovers);
      report.copiesRemoved += 1;
    }
  }
  report.copiesMb = mb(copiesBytes);
  return report;
}

/**
 * 纯函数：把命令行读成一个模式，**认不出来就是 `refuse`**，绝不落到默认档。
 * 这一格是赔出来的：`--help` 以前被读成"不是 --check"⇒ 直接删（见文件头那段）。
 * 做成纯函数是为了能被 selfTest 打到 —— 否则"未知参数会停手"这句话本身又是一个没人验的主张。
 */
export function parseArgs(argv) {
  const known = { '--check': 'check', '--self-test': 'self-test' };
  const rest = argv.filter((a) => a !== '');
  if (rest.length === 0) return { mode: 'sweep' };
  if (rest.length > 1) return { mode: 'refuse', why: `只接受 0 或 1 个参数，收到 ${rest.length} 个：${rest.join(' ')}` };
  const mode = known[rest[0]];
  if (!mode) return { mode: 'refuse', why: `不认识的参数「${rest[0]}」` };
  return { mode };
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
    // ↓ 这三臂是 #8 补的：**一份唯一的可逆证明被 `--help` 那次默认档删掉了**，而删之前它既没被保护、
    //   也没任何一臂说过"`.patch` 该留"。三臂各挡一种错法：
    //   ① 没落地的那份必须留（名单漏了 ⇒ 红）；
    //   ② 已落地改名 `-applied` 的照收（名单写宽了、把整族都留 ⇒ 红 —— 那正是上界最坏的实现形状）；
    //   ③ 同齡的普通残骸照旧要删（名单写歪成 `/.*/` 那种恒保护 ⇒ 红，"假豁免宽过整族"这一族的老刀）。
    {
      name: '可逆证明（*-pending.patch / *-batch*.patch）放了九天也不许砍，已落地的 -applied 那份照收，普通残骸不受影响',
      in: [{ path: 'pend', name: 'parallel-caps-batch-20261013.patch', bytes: MB, ageDays: 9 },
        { path: 'half', name: 'g86-namehint-pending.patch', bytes: MB, ageDays: 9 },
        { path: 'done', name: 'icons62-applied.patch', bytes: MB, ageDays: 9 },
        { path: 'junk', name: 'probe-out.log', bytes: MB, ageDays: 9 }],
      want: ['done', 'junk'],
    },
    // 保护名单不许把预算算漏：可逆证明那几格记在"常驻/证明"那一本账里，
    // 而不是被无声地从分子里减掉后连总量也不报（否则盘涨了没人看得见）。
    {
      name: '可逆证明不计入残骸，但要计入 residentBytes（涨的是哪一本账要说得出）',
      in: [{ path: 'pend', name: 'x-pending.patch', bytes: 7 * MB, ageDays: 9 },
        { path: 'junk', name: 'old.log', bytes: MB, ageDays: 9 }],
      want: ['junk'],
      checkResident: 7 * MB,
    },
  ];
  let bad = 0;
  for (const c of cases) {
    // **按身份比，不按顺序比**：`doomed` 是一个集合（删除顺序不进契约），
    // 而 `for` 循环遍历的是"从最旧开始"，于是数组字面量当期望就会因位置而假红 ——
    // 这一臂第一跑就是这么红的（要 ["p9","p10","p11","p12"]，实际 ["p12","p11","p10","p9"]，是同一批东西）。
    const norm = (a) => [...a].sort().join('|');
    const plan = planPrune(c.in, c.bp ?? b);
    const got = plan.doomed;
    let ok = norm(got) === norm(c.want);
    if (ok && c.checkResident !== undefined && plan.residentBytes !== c.checkResident) {
      ok = false;
      console.log(`     residentBytes 期望 ${c.checkResident}，实际 ${plan.residentBytes} ⇒ 那本账记错了地方`);
    }
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} ⇒ 该删 ${JSON.stringify(c.want)}，实际 ${JSON.stringify(got)}`);
  }
  // ↓ 参数那一半也要有臂：**"未知参数会停手"这句话如果没被验过，它和当初那句"用完就删"是同一类主张**。
  // 关键那两臂是 `--help`（就是赔掉一份可逆证明的那一发）与拼错的那一发 —— 它们必须 refuse。
  const argCases = [
    { in: [], want: 'sweep' },
    { in: ['--check'], want: 'check' },
    { in: ['--self-test'], want: 'self-test' },
    { in: ['--help'], want: 'refuse' },
    { in: ['--chek'], want: 'refuse' },
    { in: ['.logs'], want: 'refuse' },
    { in: ['--check', '--self-test'], want: 'refuse' },
  ];
  for (const c of argCases) {
    const got = parseArgs(c.in).mode;
    const ok = got === c.want;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} 参数 ${JSON.stringify(c.in)} ⇒ 期望 ${c.want}，实际 ${got}`);
  }
  // 常驻目录里那一族拷贝（第一百五十三批补的）：**两臂各挡一种错法** ——
  // 只测"三份删两份"，把规则写成"逢文件就删"也照样过；只测"一份不删"，把规则写成"永远不删"也照样过。
  const copyCases = [
    { name: '同一族三份不同 mtime ⇒ 留最新一份、删两份', files: [
      { path: 'a', bytes: 19 * MB, mtimeMs: 100 }, { path: 'b', bytes: 19 * MB, mtimeMs: 300 }, { path: 'c', bytes: 19 * MB, mtimeMs: 200 }],
      keep: 1, want: ['a', 'c'], kept: 1 },
    { name: '只有一份 ⇒ 一份都不许删（"保护最近 N 项"的地板 ≥ 总数就是恒真那一族）', files: [{ path: 'only', bytes: MB, mtimeMs: 5 }], keep: 1, want: [], kept: 1 },
    { name: '空族 ⇒ 删 0（扫到 0 项不等于检查过，但也不许凭空报红）', files: [], keep: 1, want: [], kept: 0 },
  ];
  for (const c of copyCases) {
    const plan = planCopies(c.files, c.keep);
    const norm = (x) => [...x].sort().join('|');
    const ok = norm(plan.doomed) === norm(c.want) && plan.kept === c.kept;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} ⇒ 该删 ${JSON.stringify(c.want)} / 留 ${c.kept}，实际 ${JSON.stringify(plan.doomed)} / 留 ${plan.kept}`);
  }
  const arms = cases.length + argCases.length + copyCases.length;
  console.log(bad === 0 ? `${arms} 臂全过（这条看守自己是活的）` : `${bad} 臂不符 —— 判据坏了，别看磁盘结论`);
  return bad === 0 ? 0 : 1;
}

// 只有被当命令跑才动手；被 import（arch-check 那条规则要的是纯函数）时不碰磁盘、不 exit。
const isCli = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/clean-scratch.mjs');
if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'refuse') {
    console.error(`拒绝执行：${args.why}`);
    console.error('  这条命令会删文件，所以对没听见的参数不许沉默。可用的只有三个：');
    console.error('    node scripts/clean-scratch.mjs              # 清理并打印');
    console.error('    node scripts/clean-scratch.mjs --check      # 只报不删');
    console.error('    node scripts/clean-scratch.mjs --self-test  # 删除判据的合成序列自检');
    process.exit(2);
  }
  if (args.mode === 'self-test') process.exit(selfTest());
  const checking = args.mode === 'check';
  const r = sweep(BUDGET, { dryRun: checking });
  console.log(`${checking ? '预算检查' : '清理'}：${r.files} 项 ⇒ 删 ${r.doomed.length} 项（备份清掉 ${r.backupsRemoved} 份，常驻拷贝清掉 ${r.copiesRemoved} 份）`);
  console.log(`  残骸 ${r.afterMb} MB / 上界 ${BUDGET.logsMaxMb} MB ·（另有常驻现场 ${r.residentMb} MB，不计入这本账）· 总量 ${r.totalMb} MB / 上界 ${BUDGET.totalMaxMb} MB`);
  if (r.copiesOver > 0) console.log(`  ⚠ 常驻目录里的拷贝超档 ${r.copiesOver} 份（每族只留最新一份，可回收约 ${r.copiesMb} MB）—— 族名见 BUDGET.residentCopies`);
  for (const l of r.leftovers) console.log(`  带不走（下次再收）：${l}`);
  for (const n of r.staleResident) console.log(`  豁免名单过期：${n} 不在盘上 —— 要么把它加回来，要么把这一格从名单里删掉`);
  if (r.overBudget) console.log(`  ⚠ 残骸砍完仍超预算（${r.afterMb} MB > ${BUDGET.logsMaxMb} MB）—— 只剩"最近 ${BUDGET.logsKeepNewest} 项"那一形，请人工看`);
  if (r.overTotal) console.log(`  ⚠ 总量超预算（${r.totalMb} MB > ${BUDGET.totalMaxMb} MB）—— 常驻现场本身在长，看 ` + BUDGET.resident.join('/') + ` 那几格`);
  process.exit(checking && (r.overBudget || r.overTotal || r.doomed.length > 0 || r.copiesOver > 0 || r.staleResident.length > 0) ? 1 : 0);
}
