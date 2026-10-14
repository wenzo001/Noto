// @vitest-environment node
/**
 * §8 第一问 / §4.3：核心错误词表里每一个 messageKey，都必须经**真的那一个** `messageFor` 拿到具体文案。
 *
 * 为什么钉这一条，以及为什么名单不许手抄：
 * `crates/notera-core/src/error.rs::message_key()` 是核心往外说的唯一一份词汇表，
 * `apps/desktop/src/i18n.ts::messageFor` 是界面把它翻成人话的唯一一处。两者中间靠一条隐式约定接上 ——
 * "剥掉已知前缀，再查 `error.<剩下的部分>`"。而这条约定在**两个地方各有一份实现**：
 * i18n 里的 `TOAST_PREFIXES`，和 `scripts/arch-check.mjs` 里那条 `normalizeKey`。
 * 谁改了自己那一份而另一边没跟着改，arch-check 照样绿（它拿自己那份算式自己比），
 * 用户看到的却是那句"操作没有成功，可以稍后再试"。
 *
 * `i18n.spec.ts` 那份 `COMMAND_CODES` 是**手抄**的 `cmd.*` 名单，覆盖不到这张表；
 * 所以本条直接从 error.rs 的 `message_key()` 函数体派生名单（改一个键名这边就红，不需要人记得同步两份表）。
 *
 * 判据打在**渲染前的最后一跳**（`messageFor` 的返回值），不是打在"键存在"上：
 * 后者 arch-check 早就有，而那正是本次要防的漂移看不见的原因。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS, messageFor } from './i18n';

// 取目录走本仓既有写法（`negativePromises.spec.ts` 那一族）：这里的 TS 配置不认 `node:path` 的 dirname。
const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(SRC, '..', '..', '..');
const ERROR_RS = readFileSync(join(ROOT, 'crates/notera-core/src/error.rs'), 'utf8');

/**
 * 只取 `message_key()` 那一个函数体：别的 match 臂（`retryable()`、`blocks_local_writes()`）里也有 `=> "…"`。
 *
 * 解析在**每条腿里面**跑（不是模块顶层）：锚点没了的时候，模块顶层抛会让整个文件加载失败，
 * 读数是一条"没跑完"，而不是哪条腿红了 —— 那和真红不是一回事，排查时要多绕一圈。
 */
let cached: string[] | null = null;
function coreKeys(): string[] {
  if (cached) return cached;
  const start = ERROR_RS.indexOf('pub fn message_key');
  expect(start, 'error.rs 里找不到 `pub fn message_key` —— 核心词汇表换了地方，本条正在空转').toBeGreaterThan(-1);
  const body = ERROR_RS.slice(start);
  const end = body.indexOf('\n    }\n');
  expect(end, '`message_key()` 的函数体切不出来（缩进形状变了？）—— 本条正在空转').toBeGreaterThan(-1);
  cached = [...new Set([...body.slice(0, end).matchAll(/=>\s*"([a-z_]+\.[A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1] ?? ''))].sort();
  return cached;
}

const GENERIC = messageFor('__definitely_not_a_key__');
const registered = new Set<string>(MESSAGE_KEYS);

describe('核心错误词表 → 界面文案那一跳', () => {
  it('名单是从 error.rs 原文派生的，且形状都是 `命名空间.键`', () => {
    const keys = coreKeys();
    // 自检：解析挂了会得到 0 条，下面所有"零违规"都会变成常绿。
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+\.[A-Za-z][A-Za-z0-9_]*$/);
    // 派生出来的必须真是那张表：抽查两条已知在用的键（不是由被测代码算出的期望值）。
    expect(keys).toContain('sync.protocol_mismatch');
    expect(keys).toContain('attach.missing');
  });

  it('每个键都拿得到一句具体话，不落到通用兜底、也不原样印出键名', () => {
    const offenders: string[] = [];
    for (const key of coreKeys()) {
      const text = messageFor(key);
      if (text === GENERIC) offenders.push(`${key} → 通用兜底`);
      else if (text === key) offenders.push(`${key} → 键名原样`);
      else if (text.length < 2) offenders.push(`${key} → 短到一个符号：${text}`);
      else if (/[{}]|←|\*\*|`/.test(text)) offenders.push(`${key} → 带占位符或标记：${text}`);
    }
    expect(offenders, `这些核心错误在屏幕上说不清：\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * 这一族是**最脆的那几条**：核心说 `sync.x`，而文案登记的是 `error.x`，全靠剥前缀接上。
   * 钉住"确实有几条走这条路"，是为了让上面那条判据不至于只在"两边都写全名"的世界里才有效 ——
   * 一旦 `TOAST_PREFIXES` 被改坏，这几条就是第一批变红的。
   */
  it('剥前缀才命中的那几条，必须被真的走到（否则这份表对归一化根本没有依赖，本条在空转）', () => {
    const viaNormalization = coreKeys().filter((key) => !registered.has(key));
    expect(viaNormalization.length, '至少要有一条是靠剥前缀接上的 —— 现在一条都没有，说明本条没主语').toBeGreaterThan(0);
    for (const key of viaNormalization) {
      expect(messageFor(key), `${key} 登记的是另一个名字，剥前缀后必须仍拿得到话`).not.toBe(GENERIC);
    }
  });

  /**
   * 两个不同的错误不许说成同一句话。§8 第一问要的是"只看界面就能分辨发生了什么"，
   * 而"两句一模一样"是这条最容易被漏掉的红：登记时复制粘贴一行、只改键名，扫描器一条都不会红。
   */
  it('不同键的文案不许彼此相同（两句不同的错误不能说成同一句）', () => {
    const byText = new Map<string, string[]>();
    for (const key of coreKeys()) {
      const text = messageFor(key);
      byText.set(text, [...(byText.get(text) ?? []), key]);
    }
    const clashes = [...byText].filter(([, keys]) => keys.length > 1).map(([text, keys]) => `${keys.join(' / ')} → 「${text}」`);
    expect(clashes, `这些核心错误在屏幕上是同一句话：\n${clashes.join('\n')}`).toEqual([]);
  });
});
