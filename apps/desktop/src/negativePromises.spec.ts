// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 规范里"不许有 / 不画 / 不渲染"那一族 —— 四条**否定式承诺**第一次各有执行者：
 *
 *  - **§2.5**「禁用态不画灰图标。能力不存在就根本不渲染那颗控件」：
 *    这一句的来历是规范自己写的教训（每一颗假开关被 fake-true 之后又删除）。
 *    判法：`:disabled` 的表达式里**不许**出现能力位（那是"画一颗灰的骗人"），
 *    能力位只能出现在 `v-if` 上（不渲染）。正向对照用"确有 `v-if` 绑能力位"来证明这条扫的是真机制。
 *  - **§4.5**「没有「全部用远端覆盖」这类批量动作（刻意不做）」：
 *    把冲突面板那几颗动作**做成集合**钉住 —— 多一颗（哪怕叫「全部…」）就红，少一颗也红
 *    （只判"没有批量"的那一类写法会在改名为 `conflict-overwrite-all` 时静默通过）。
 *  - **§4.7**「传输安全 ≠ 本地静态加密。本地库加密未实现 ⇒ 界面上任何『本地数据已加密』的说法都是假话」。
 *  - **§4.8**「导出：一种格式（系统自有 ZIP 包）。没有 Markdown / HTML / PDF / 纯文本导出」。
 *
 * 四条都是**读磁盘字节**（同 `motion.spec.ts` 的理由：`?raw` glob 对刚改写的文件会读旧/读空，
 * 而这一族判据全部要靠"往源文件里加一条违规"来验它有没有牙）。
 * 每条都配**正向对照**：先证明那个词/那颗键真的在文件里被读到，再断言它不在该在的地方 ——
 * 少了对照，"整个文件没扫到任何东西"与"承诺成立"长得一模一样。
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** 递归枚举目录里的文件（相对 `src/`），只留给定后缀。 */
function listFiles(ext: string[], dir = SRC, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(ext, join(dir, entry.name), rel));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** i18n 的 `'key': 'value'` 对（这个文件就是这一种形状，不需要 AST）。 */
function i18nPairs(): Array<{ key: string; value: string }> {
  const text = read('i18n.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...text.matchAll(/'([a-zA-Z][\w.]*?)'\s*:\s*'([^']*)'/g)].map((m) => ({ key: m[1], value: m[2] }));
}

describe('§2.5 能力不存在的控件必须不渲染（不许画一颗灰的骗人）', () => {
  const CAPABILITY = /\bcaps\b|capabilit|tray|globalShortcut|nativeMenu|notification|keychain|windowChrome|transparency|libraryReadOnly/i;
  const files = listFiles(['.vue']);
  const disabledHits: string[] = [];
  let vIfOnCaps = 0;
  for (const rel of files) {
    const text = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of text.matchAll(/:disabled="([^"]*)"/g)) {
      if (CAPABILITY.test(m[1] ?? '')) disabledHits.push(`${rel} :disabled="${m[1]}"`);
    }
    for (const m of text.matchAll(/v-if="([^"]*)"/g)) {
      if (CAPABILITY.test(m[1] ?? '')) vIfOnCaps += 1;
    }
  }
  it('正向对照：能力位确实被用在 `v-if` 上（否则下面那条"零违规"可能只是没扫到机制）', () => {
    expect(files.length, '一个 .vue 都没扫到').toBeGreaterThan(10);
    expect(vIfOnCaps, '全工程没有一处 `v-if` 绑能力位 ⇒ 这条判据无从成立').toBeGreaterThan(0);
  });
  it('没有任何一颗控件靠 `:disabled` 表达"这台设备没这个能力"', () => {
    expect(disabledHits, JSON.stringify(disabledHits)).toEqual([]);
  });
});

describe('§4.5 冲突面板的动作恰好是"逐条"那三颗（批量动作是刻意不做的）', () => {
  const text = read('views/ConflictsView.vue');
  const buttons = [...text.matchAll(/<button[^>]*data-testid="(conflict-[a-z-]+)"[^>]*>/g)].map((m) => m[1]);
  const ALLOWED = ['conflict-keep-both', 'conflict-manual-merge', 'conflict-open-note'];
  it('仪器自检：这一屏真的扫到了动作按钮（扫到 0 颗不算"没有批量动作"）', () => {
    expect(buttons.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });
  it('动作集合与规范一致：多一颗就红（包括「全部用远端覆盖」那一类），少一颗也红', () => {
    expect([...new Set(buttons)].sort(), JSON.stringify(buttons)).toEqual([...ALLOWED].sort());
  });
});

describe('§4.7 界面不许说"本地数据已加密"（本地库加密未实现）', () => {
  const pairs = i18nPairs();
  const CLAIM = /本地[^']{0,10}加密|已加密|静态加密|存储加密|at[\s-]?rest/i;
  it('正向对照：文案里确实出现过「加密」这个词（这条判的不是"整个文件没有这个字"）', () => {
    expect(pairs.length).toBeGreaterThan(100);
    expect(pairs.filter((p) => p.value.includes('加密')).length).toBeGreaterThanOrEqual(2);
  });
  it('没有任何一句文案把"本地已加密"说成事实', () => {
    const hits = pairs.filter((p) => CLAIM.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§4.8 导出只有一种格式（不许出现第二种）', () => {
  const pairs = i18nPairs();
  const FORMAT = /markdown|html|pdf|纯文本|\.txt|docx|word/i;
  const exportKeys = pairs.filter((p) => p.key.startsWith('settings.export'));
  const importKeys = pairs.filter((p) => p.key.startsWith('settings.import'));
  it('仪器自检：导出与导入两侧都有键（否则"导出侧没有格式词"是空判据）', () => {
    expect(exportKeys.length).toBeGreaterThanOrEqual(3);
    // 导入侧**合法地**写着 Markdown / .enex —— 它必须被扫到，才证明这条区分了两侧而不是没扫。
    expect(importKeys.filter((p) => FORMAT.test(p.value)).length).toBeGreaterThanOrEqual(1);
  });
  it('导出侧的文案里不许出现第二种格式（Markdown / HTML / PDF / 纯文本都是发明能力）', () => {
    const hits = exportKeys.filter((p) => FORMAT.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});
