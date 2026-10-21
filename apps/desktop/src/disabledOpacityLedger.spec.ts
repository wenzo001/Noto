/**
 * 第一百二十三批撞出来的那处**同屏两值**，做成可证伪的账（不是放宽、也不是注释）。
 *
 * 现场（探针 `.logs/disabled-opacity-probe.mjs`，真渲染读数）：回收站视图里三颗禁用控件同时上屏，
 * 两颗 `.btn` 是 `opacity: 0.45`，而自绘下拉那颗是 **0.5** ⇒ 设计稿 §4.9 那句「禁用 45%」与
 * 本项目反复立的「同屏必须同一档」有一句没做到。当时登记成 D22 等拍；
 * **2026-10-21 按原文销账**：规范 §状态表写的就是 `禁用 | opacity: 0.45 | 同左`，盘上没有任何一句
 * 给浮层控件另立一档 ⇒ "等拍的两条路"里那条"承认浮层走另一档"从来没有依据，剩下的只有"没落"。
 * 于是把 0.5 对齐成 0.45（AppSelect 一条 + AppCheckbox 两条），并把这本账换成**正向要求**：
 *
 * ① 任何带 `disabled` 的规则都不许写第二种禁用透明度（豁免名单已清零，防扩散）；
 * ② 销过账的那两族必须真的存在且每条都写着标准值 ⇒ 改回 0.5 就红，
 *    而"名单空了所以通过"这一族空转由 `mine.length > 0` 那一臂挡住（见 register-debt-as-falsifiable-ledger 那条纪律）。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/disabledOpacityLedger.spec.ts`
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 运行期 vitest 的 SSR transform 真注入 __dirname（本机 710 条全绿为证）；CI 的 vue-tsc 用浏览器 tsconfig 不认它
// ⇒ 这里只做环境声明，取路径的代码一字不改（run 39085500758 的三条 TS2304 就是这个）。
declare const __dirname: string;
const SRC = join(__dirname);
/**
 * 已经销账的两族：**销账不等于放下要求** —— 它们从"豁免"变成"必须写标准值"，改回去就红（见 ②）。
 * 销账的依据是原文，不是我拍的：`docs/design/Noto-界面设计规范.v2.md` §状态表写着
 * `禁用 | opacity: 0.45 | 同左`，而盘上**没有**任何一句给浮层控件另立一档的原文 ⇒
 * D22 那格从前写"等拍的两条路"，第二条（承认浮层走另一档）从来没有规范依据。
 */
const RETIRED: readonly string[] = ['components/ui/AppSelect.vue', 'components/ui/AppCheckbox.vue'];
const STANDARD = '0.45';

type Rule = { file: string; selector: string; value: string };

/** 扫 `src` 下所有 .css 与 .vue（`<style>` 段里）的样式块，取出"选择器带 disabled 且正文写了 opacity"的那些。 */
function disabledOpacityRules(): Rule[] {
  const out: Rule[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name;
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.(css|vue)$/.test(name) || /\.spec\./.test(name)) continue;
      const text = name.endsWith('.vue')
        ? (readFileSync(full, 'utf8').match(/<style[^>]*>([\s\S]*)<\/style>/g) ?? []).join('\n')
        : readFileSync(full, 'utf8');
      for (const block of text.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
        const selector = block.slice(0, block.indexOf('{')).trim();
        if (!/disabled/.test(selector)) continue;
        const m = /opacity:\s*([0-9.]+)/.exec(block.slice(block.indexOf('{')));
        if (!m) continue;
        out.push({ file: full.slice(SRC.length + 1).replace(/\\/g, '/'), selector, value: m[1] });
      }
    }
  };
  walk(SRC);
  return out;
}

describe('禁用态透明度那本账（D22）', () => {
  const rules = disabledOpacityRules();

  it('扫到了东西（一条空账比没账更糟）', () => {
    expect(rules.length, '一条带 disabled 的 opacity 声明都没扫到 ⇒ 本判据在空转').toBeGreaterThan(0);
    expect(rules.some((r) => r.value === STANDARD)).toBe(true);
  });

  it('① 任何带 disabled 的规则都不许写第二种禁用透明度（豁免名单已清零）', () => {
    const offenders = rules.filter((r) => r.value !== STANDARD);
    expect(offenders, `非 ${STANDARD} 的禁用透明度：${JSON.stringify(offenders)}`).toEqual([]);
  });

  /**
   * ② 从前这条的作用是"豁免还在违规 ⇒ 别偷偷销账"。账销完之后它换成**正向要求**：
   *    这两族必须真的在扫得到的名单里、且每条都写着标准值 —— 空名单不算通过（`RETIRED` 里
   *    任何一条扫不到规则就当场红，防的是文件改名/规则消失后这条臂静默空转）。
   */
  it('② 销过账的那两族必须写着标准值（改回 0.5 就红，不是"名单空了所以通过"）', () => {
    for (const file of RETIRED) {
      const mine = rules.filter((r) => r.file === file);
      expect(mine.length, `${file} 一条带 disabled 的 opacity 都没扫到 ⇒ 这条臂在空转（文件改名了？规则没了？）`).toBeGreaterThan(0);
      const bad = mine.filter((r) => r.value !== STANDARD);
      expect(bad, `${file} 又长出非 ${STANDARD} 的禁用透明度：${JSON.stringify(bad)}`).toEqual([]);
    }
  });
});
