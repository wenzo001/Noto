#!/usr/bin/env node
/**
 * 推送前的本地台面：**把 CI 那一份步骤清单当唯一来源跑一遍**（缺口 G143）。
 *
 * 为什么要它：2026-10-19 远程 `PR 门禁` 连着红了 7 次推送，而我本地每次都"全绿"。
 * 逐条对下来，红的是 `cargo fmt --all --check` —— CI 有、我的习惯清单里没有的那一步。
 * 也就是说我本地那套"台面"从来就不是 CI 那套；差的那几格（fmt / check-versions /
 * check-icons / check-brand / pnpm build）一直没人跑，直到 GitHub 替我跑。
 *
 * 修法不是"再往我的清单里补五条命令"—— 那只是第二份名单，早晚会再漂一次。
 * 这里改成**读 `.github/workflows/ci.yml` 自己解析**：
 *  · 阻断步 = 有 `run:` 且没有 `continue-on-error: true`；
 *  · 命令、`working-directory` 都照 CI 那一行取（本仓库**根目录没有 package.json**，
 *    前端四条必须在 `apps/desktop` 里跑 —— 在根跑会红成"找不到脚本"，那是仪器的错不是产品的）；
 *  · 标了 `# ci-only: <原因>` 的步跳过并**把原因打出来**。标记**只认缩进 ≥8 空格的行**，
 *    也就是必须写在步骤块**里面**：写在步骤上面那段说明注释里（6 空格）属于**上一条**步骤，
 *    认错了会把没标的那条跳过、把标了的那条跑掉 —— 两种都是假绿；
 *  · 解析完先自证三件事：认出的步数 == 文件里 `run:` 的条数；阻断步里必须看得见
 *    `cargo fmt --all --check`、`cargo clippy` 与 `node scripts/arch-check.mjs`；阻断步 ≥ 8 条。
 *    少任何一条就 exit 3 —— "workflow 改形状导致解析出 0 步"绝不能绿成"全都通过了"。
 *
 * 用法：
 *   node scripts/prepush-gates.mjs            # 跑（约 20–25 分钟，独占机器）
 *   node scripts/prepush-gates.mjs --list     # 只列解析结果，不跑
 *   其余任何参数一律拒绝（exit 2）—— 与 clean-scratch 同一条规矩：会跑东西的命令不许对拼错的 flag 沉默。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (arg !== undefined && arg !== '--list') {
  console.error(`不认识的参数 "${arg}"（可用：无参数 = 跑，--list = 只看解析结果）`);
  console.error('能用的就这两个 —— 这一步会真的执行命令，所以不许对拼错的 flag 沉默。');
  process.exit(2);
}

const yml = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').split(/\r?\n/);

/** 解析 `- name:` / `run:` / `working-directory` / `continue-on-error` / `# ci-only:`，按出现顺序拼成步骤表。 */
function parseSteps(lines) {
  const steps = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nameM = line.match(/^\s*-\s+name:\s*(.+)$/);
    if (nameM) {
      if (cur) steps.push(cur);
      cur = { name: nameM[1].trim(), run: null, cwd: ROOT, blocking: true, ciOnly: null, line: i + 1 };
      continue;
    }
    if (!cur) continue;
    if (/^\s*continue-on-error:\s*true/.test(line)) cur.blocking = false;
    const wdM = line.match(/^\s*working-directory:\s*(.+)$/);
    if (wdM) cur.cwd = join(ROOT, wdM[1].trim().replace(/^['"]|['"]$/g, ''));
    // 步骤块**内**（≥8 空格）、且还没读到 `run:` —— 两个条件一起才认 ci-only，见头注释。
    // 连续多行 `# ci-only:` 是**一条原因写不下**，拼起来，别让最后一行把前面几行顶掉。
    const onlyM = line.match(/^ {8,}#\s*ci-only:\s*(.+)$/);
    if (onlyM && cur.run === null) {
      cur.ciOnly = cur.ciOnly ? `${cur.ciOnly} ${onlyM[1].trim()}` : onlyM[1].trim();
    }
    const runM = line.match(/^\s*run:\s*(\|)?\s*(.*)$/);
    if (runM) {
      const [, block, inline] = runM;
      if (block) {
        const body = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          if (/^\s{8,}\S/.test(lines[j])) body.push(lines[j].trim());
          else if (lines[j].trim() === '') body.push('');
          else break;
        }
        cur.run = body.join('\n').trim();
      } else if (inline) {
        cur.run = inline.trim();
      }
    }
  }
  if (cur) steps.push(cur);
  return steps.filter((s) => s.run);
}

const steps = parseSteps(yml);
const blocking = steps.filter((s) => s.blocking);
const runnable = blocking.filter((s) => !s.ciOnly);
const skipped = blocking.filter((s) => s.ciOnly);

// 自证①：认出的步数必须等于文件里 `run:` 的条数 —— 解析器漏一条，就是"少跑一条还报绿"。
const runLines = yml.filter((l) => /^\s+run:/.test(l)).length;
if (steps.length !== runLines) {
  console.error(`##[error] 文件里有 ${runLines} 条 run:，只解析出 ${steps.length} 步 —— 解析失效，拒绝开跑`);
  process.exit(3);
}

// 自证②：这三条就是"红过 7 次却没人在本地跑"的那一类，必须看得见。
const mustSee = ['cargo fmt --all --check', 'cargo clippy', 'node scripts/arch-check.mjs'];
const joined = blocking.map((s) => s.run).join('\n');
for (const need of mustSee) {
  if (!joined.includes(need)) {
    console.error(`##[error] 解析 ci.yml 没认出必须存在的阻断步 "${need}"（workflow 形状变了？` +
      `认出 ${blocking.length} 条阻断步）—— 拒绝把"没跑到"当成"跑过了"`);
    process.exit(3);
  }
}
if (blocking.length < 8) {
  console.error(`##[error] 只认出 ${blocking.length} 条阻断步（少于 8），怀疑解析失效，拒绝开跑`);
  process.exit(3);
}

console.log(`解析 ci.yml：共 ${steps.length} 步，阻断 ${blocking.length} 条，` +
  `本机跑 ${runnable.length} 条，标 ci-only 跳过 ${skipped.length} 条`);
for (const s of skipped) console.log(`  跳过（ci-only）：${s.name} —— ${s.ciOnly}`);

if (arg === '--list') {
  for (const s of runnable) {
    console.log(`  将跑：${s.name}  [${s.cwd.replace(ROOT, '.')}]  →  ${s.run.split('\n')[0].slice(0, 80)}`);
  }
  process.exit(0);
}

let failed = 0;
for (const s of runnable) {
  const started = Date.now();
  process.stdout.write(`\n=== ${s.name} ===\n`);
  // GITHUB_WORKSPACE 只有 CI 才有；CI 那两条 `cargo test` / `pnpm test` 要往它下面落日志，
  // 本机不给就变成 `mkdir -p /.logs-ci` —— 红在仪器上。
  // **指到 `.logs/prepush` 而不是仓库根**（第一遍就这么干的，结果 CI 那两条 tee 在仓库根种出
  // 一个 `.logs-ci/`：工作树变脏，整跑的 exit 4 前置与 `tag-release --push` 都会被它顶掉 ——
  // 而那是仪器的脏，不是产品的脏）。`.logs` 既被 ignore、又有 `clean-scratch` 的预算看守。
  const r = spawnSync('bash', ['-c', s.run], {
    cwd: s.cwd,
    stdio: 'inherit',
    env: { ...process.env, GITHUB_WORKSPACE: join(ROOT, '.logs', 'prepush') },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.status === 0) {
    console.log(`PASS ${s.name}（${secs}s）`);
  } else {
    failed += 1;
    console.log(`FAIL ${s.name} 退出码 ${r.status}（${secs}s）`);
  }
}
console.log(`\nprepush-gates：${runnable.length - failed} / ${runnable.length} 条通过`);
if (failed > 0) {
  console.log('##[error] 有步骤红 —— 不许推。');
  process.exit(1);
}
