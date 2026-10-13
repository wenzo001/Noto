// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §1.4「控件高度」那张表第一次有了执行者 —— 而且这一格与 §1.3 圆角那一格**不在同一层**：
 * 圆角那格管的是"组件里不许手写数"，而这一格先管"词表本身不许漂"。
 * 2026-10-13 的裁定（`docs/design/SPEC-AMENDMENTS.md` A3）是**分层**：
 * §1.4 这六档管**视觉高度**，§5 的 44 管**命中区**。于是这六颗 token 是那一层的唯一词汇，
 * 它们的**值**一旦被顺手改掉（34 → 36、44 → 40），界面上没有任何东西会喊 —— 这一条就是为了让它喊。
 *
 * 期望值**逐字抄自** `docs/design/Noto-界面设计规范.from-share.txt` §1.4：
 *   24px 分组标题行 / 32px 工具条图标、导航行、模板按钮 / 34px 侧栏文件夹行 / 36px 输入框 /
 *   40px 主按钮、标题栏 / 44px 复选框、一切触摸目标下限
 * （不是从 `tokens.css` 反推的 —— 那份是被测对象，见 [[record-root-cause-only-after-reproducing-the-payload]]）。
 *
 * 本批**只钉声明层**（值不许漂），落到界面上是逐类改组件 + 整跑布局门禁那一刀，这张表不当"已经做到了"的证据。
 * 2026-10-13 之后的消费状况（对齐 A3 / A3.3 两条裁定）：
 * · 有消费者**且**整跑给它量过矩形的：`--h-group`（侧栏分组标题行，腿 71）、`--h-icon`（工具条图标 32）、
 *   `--h-input`（输入框涂装 36，命中由外层 `.input-hit` 的 label 补回 44）—— 后两档在腿 ㊲ 的 ROLE_TIERS 里；
 * · 有消费者但**整跑还没有一枚矩形**：`--h-btn`（40 那一档画在 `.titlebar` 的高度上，界面上只在桌面壳里出现）；
 * · **按 A3.3 结案、永远不会被消费**：`--h-nav` 与 `--h-row`（32/34 小于堆叠行的节距，用在导航行与侧栏文件夹行上
 *   会让相邻两行的命中区互相压住）—— 那两类继续按 §5 画 44，由腿 ㊲ 那条"结案那两类仍然 =44"钉着。
 * 这里不放"每档都要有人用"那种判据：它对那两颗结案的是假红，对剩下的又会替产品说假话。
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const TOKENS_CSS = readFileSync(SRC + 'styles/tokens.css', 'utf8')
  // 只删**从行首开批**的块注释：值里/串里的 `/*` 不算注释开头（i18n.ts 那一族的教训）
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

type Row = { name: string; value: string };
const rows: Row[] = [...TOKENS_CSS.matchAll(/^\s*(--(?:h-[a-z]+|touch))\s*:\s*([^;]+);/gm)]
  .map((m) => ({ name: m[1] ?? '', value: (m[2] ?? '').trim() }));
const declared = new Map(rows.map((r) => [r.name, r.value]));

/** §1.4 那张表的六档（导航行与工具条图标同值 32，所以本仓库把它们做成两颗 token）。 */
const WANT: Array<[string, string]> = [
  ['--h-group', '24px'],
  ['--h-icon', '32px'],
  ['--h-nav', '32px'],
  ['--h-row', '34px'],
  ['--h-input', '36px'],
  ['--h-btn', '40px'],
  ['--touch', '44px'],
];

describe('§1.4 控件高度的六档：值逐字对上那张表，且不许长出第七颗', () => {
  it('仪器自检：真的读到了七条声明（读到空表的话"没漂"只是没在看）', () => {
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const r of rows) expect(r.value, `${r.name} 的值不像一个长度`).toMatch(/^\d+(\.\d+)?px$/);
  });

  it('每一档的数与规范那一行一致（点名到具体哪一档漂了）', () => {
    const drifted = WANT.filter(([name, value]) => declared.get(name) !== value)
      .map(([name, want]) => `${name}: 期望 ${want}，实际 ${declared.get(name) ?? '没有这一颗'}`);
    expect(drifted, JSON.stringify(drifted)).toEqual([]);
  });

  it('词汇是**双向**一致的：多出一颗（第七档就在这一刀的形状）红，少一颗也红', () => {
    const got = [...declared.keys()].sort();
    const want = WANT.map(([n]) => n).sort();
    expect(got.filter((n) => !want.includes(n)), `多了：${JSON.stringify(got.filter((n) => !want.includes(n)))}`).toEqual([]);
    expect(want.filter((n) => !got.includes(n)), `少了：${JSON.stringify(want.filter((n) => !got.includes(n)))}`).toEqual([]);
  });

  it('牙齿：这一族名字的形状要认得"改一颗的名字"这种漂法（重命名会同时多一档少一档）', () => {
    const fake = new Map<string, string>([...WANT, ['--h-iconx', '32px'] as [string, string]]);
    fake.delete('--h-icon');
    const names = [...fake.keys()];
    expect(names.filter((n) => !WANT.some(([w]) => w === n))).toEqual(['--h-iconx']);
    expect(WANT.map(([w]) => w).filter((n) => !names.includes(n))).toEqual(['--h-icon']);
  });
});
