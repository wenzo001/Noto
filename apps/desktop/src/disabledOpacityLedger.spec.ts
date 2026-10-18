/**
 * 第一百二十三批撞出来的那处**同屏两值**，做成可证伪的账（不是放宽、也不是注释）。
 *
 * 现场（探针 `.logs/disabled-opacity-probe.mjs`，真渲染读数）：回收站视图里三颗禁用控件同时上屏，
 * 两颗 `.btn` 是 `opacity: 0.45`，而自绘下拉那颗是 **0.5** ⇒ 设计稿 §4.9 那句「禁用 45%」与
 * 本项目反复立的「同屏必须同一档」有一句没做到。这一条**等用户拍**（台账 D22 / 任务 #115），
 * 所以这里不统一、不放宽，只把现状钉成账：
 *
 * ① 除名单里那一条，任何带 `disabled` 的规则都不许引入**别的**禁用透明度 ⇒ 第三值出现当场红（防扩散）；
 * ② 名单里那一条**必须仍然违规且值相等** ⇒ 哪天真把 0.5 对齐成 0.45，这一条会红，
 *    逼着改的人回来把豁免撤掉（见 [[register-debt-as-falsifiable-ledger]]：修掉不撤账就红）。
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
 * 已经登记待拍的豁免：文件 + 它现在那个值。拍板之后要么删这一条，要么整族消失。
 * ⚠ 这两条**不是手抄的名单**，是这条判据自己扫出来的事实（基线那一遍红的就是这两处）：
 *   探针只看到回收站那三颗同屏的（下拉 0.5 vs 按钮 0.45），而扫完全族之后**勾选框也是 0.5** ⇒
 *   D22 的问题比第一次报的那一颗宽，台账与任务 #115 都按这个口径读。
 */
const EXEMPT: Array<{ file: string; value: string; why: string }> = [
  { file: 'components/ui/AppSelect.vue', value: '0.5', why: 'D22 / 任务 #115：同屏禁用态两值等设计侧拍' },
  { file: 'components/ui/AppCheckbox.vue', value: '0.5', why: 'D22 / 任务 #115：同上（`.app-check__box:disabled` 与它那条 + 兄弟选择器两条都是 0.5）' },
];
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

  it('① 名单之外不许有第二种禁用透明度（防扩散）', () => {
    const offenders = rules.filter(
      (r) => r.value !== STANDARD && !EXEMPT.some((e) => e.file === r.file && e.value === r.value),
    );
    expect(offenders, `新出现的第二值：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('② 豁免名单里那一条必须**仍然**违规 —— 修好了就回来把账销掉', () => {
    for (const e of EXEMPT) {
      const hits = rules.filter((r) => r.file === e.file && r.value === e.value && /disabled/.test(r.selector));
      expect(
        hits.length,
        `${e.file} 里那条 ${e.value} 已经不在了 ⇒ ${e.why}：这件事要么已修，要么换了形状，请把豁免一起处置`,
      ).toBeGreaterThan(0);
    }
  });
});
