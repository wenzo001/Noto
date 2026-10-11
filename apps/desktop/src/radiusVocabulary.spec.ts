// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §1.3「圆角只允许这三种，不混用第四种」第一次有执行者。
 *
 * 规范给的是三颗 token 与各自用途：`--r-row` 6px（侧栏行 hover、图标底）、
 * `--r-card` 10px（卡片、搜索框、输入框）、`--r-chip` 9999px（所有按钮，胶囊）。
 * `styles/base.css` 一直守这条（20 多处全走 token），漂的是组件里那几处手写的数：
 * `.erase-confirm` 8px、`.workspace__reopen` 8px、两处 `<mark>` 2px —— 这一批把它们迁回 token（登记 G113）。
 *
 * 豁免表**必须真的命中过**：`editor.css` 那颗 `.nb-gutter--dot::after` 的 `50%` 是几何圆点
 * （记事本行首那个点），不是控件圆角 —— 但它哪天被删了，这一条也要红着提醒"表里那条是历史残留"，
 * 否则豁免表会像 44pt 那一族一样悄悄烂掉（同 §8 那条"登记表要能被证伪"）。
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const TOKENS = ['r-row', 'r-card', 'r-chip'] as const;
/** 允许 `var(--r-x)` 与带兜底的 `var(--r-x, 6px)` —— 走的还是同一颗 token。 */
const tokenOf = (value: string): string | null => {
  const m = /^var\(--(r-row|r-card|r-chip)(\s*,\s*[^)]+)?\)$/.exec(value);
  return m ? m[1] : null;
};
const EXEMPT = [
  { file: 'styles/editor.css', decl: '50%', why: '行首那颗圆点是几何圆（跟着字号缩放的 ::after），不是控件的圆角词汇' },
];

function listFiles(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFiles(join(dir, entry.name), rel, out);
    else if (/\.(vue|css)$/.test(entry.name)) out.push(rel);
  }
}

const files: string[] = [];
listFiles(SRC, '', files);

type Decl = { file: string; value: string };
const decls: Decl[] = [];
for (const rel of files) {
  const text = readFileSync(join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(/border(?:-[a-z-]+)?-radius\s*:\s*([^;{}]+)/g)) {
    decls.push({ file: rel, value: (m[1] ?? '').trim().toLowerCase() });
  }
}

const isExempt = (d: Decl): boolean =>
  EXEMPT.some((e) => d.file.endsWith(e.file) && d.value === e.decl.toLowerCase());

describe('§1.3 圆角词汇：只有那三颗 token（豁免表要能被证伪）', () => {
  it('仪器自检：真的扫到了成批的圆角声明，且三颗 token 都在用（空扫不算"没混用"）', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(decls.length).toBeGreaterThan(20);
    for (const token of TOKENS) {
      expect(decls.filter((d) => tokenOf(d.value) === token).length, `--${token} 一次都没出现 ⇒ 这条判据在空转`).toBeGreaterThan(0);
    }
  });

  it('没有任何一处圆角用第四种值（不在三颗 token 里、也不在带理由的豁免表里）', () => {
    const bad = decls
      .filter((d) => tokenOf(d.value) === null && !isExempt(d))
      .map((d) => `${d.file}: border-radius: ${d.value}`);
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });

  it('豁免表不许烂掉：每一条都必须真的命中过至少一处', () => {
    const dead = EXEMPT.filter((e) => !decls.some((d) => isExempt(d) && d.file.endsWith(e.file) && d.value === e.decl.toLowerCase()));
    expect(dead.map((d) => d.file + ' ' + d.decl), JSON.stringify(dead)).toEqual([]);
  });
});
