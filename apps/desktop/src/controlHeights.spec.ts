// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 *   `--h-input`（输入框涂装 36，命中由外层 `.input-hit` 的 label 补回 44）、`--h-btn`（40 那一行有两个主语，
 *   现在两个都有人：`.titlebar` 的高度与 `.btn--primary` 的涂装 —— 后者在腿 ㊲ 的 ROLE_TIERS 里带 `where:'settings'`）；
 * · **按 A3.3 / A3.5 结案、不走小档**：`--h-nav` 与 `--h-row`（32/34 小于堆叠行的节距，用在导航行与侧栏文件夹行上
 *   会让相邻两行的命中区互相压住）—— 那两类继续按 §5 画 44，由腿 ㊲ 那条"结案那两类仍然 =44"钉着；
 *   `自绘下拉` 按 **A3.5** 同归 44（它住在"堆叠 + 滚动口"的表单里，带子是画在盒子外面的悬挑而滚动口两轴都裁 ⇒
 *   落点成不成立取决于当时滚到哪儿）；这一格现在也有执行者：`ROLE_TIERS` 里 `{ 自绘下拉, want: 44 }` 那一行。
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

/**
 * §2.5 那张尺寸表的**容器**那一行，原话：`28 / 44 / 52 —— 触摸目标容器尺寸（不是图标本身放大）`。
 * 上面那个 describe 给 §1.4 的六档做了逐档归属 + 双向闸，而这一行以前**没有同形的裁定**
 * （`SPEC-GAP-AUDIT-2026-10-14.md` 第 7 条）：44 有人、52 只在整跑里被间接量过、**28 连主人都不明**。
 *
 * 今天实测（裁定记在 `SPEC-AMENDMENTS.md` A6，D13 等用户追认）：
 * · **44** 的主人 = `--touch`（`tokens.css:111`）—— 值是上面那张表第 7 行钉的那一颗，这一格补的是"它就是 §2.5 那一行的 44"；
 * · **52** 的主人 = 移动端底部胶囊里那颗 tab 的容器高（`base.css:684` 的 `.dock__tab { height: 52px }`，
 *   与 §3.5"每个 tab 56×52"同一个数）；`tokens.css:138` 也有一颗 52px，那是 `--nb-handle-gutter`（§2.4 拖拽把手的留位），
 *   **不是**触摸容器 —— 所以这一格点名到 `.dock__tab`，不写"全仓只有一颗 52"那种假话；
 * · **28 没有任何容器主人**。全源里 `28px` 只出现在两处，都不属于"竖着的容器"这一族：
 *   `EditorToolbar.vue:371` 的 `width: 28px` 是 §3.4 右缘那道渐隐的**宽**，`editor.css:190` 那句是 §1.5 的**行高**（1.4 = 28px）。
 *   ⇒ 按 A3.3 / A3.5 同一个形状结案：**比 44 小的档不做容器**，因为 §5 那句"≥44×44"永远赢。
 *
 * ⚠ 这一把量的是 `height` / `min-height` 那两位，**故意不认** `width` 与 `line-height`（不然会把 §3.4 与 §1.5 误伤成违规）；
 * 也量不到 JS 里算出来的高度 —— 那一格归整跑的矩形（腿 ㊲/65），两边不互相冒充。
 */
describe('§2.5 触摸目标容器：三个数各有主人，28 这一档按 A6 结案', () => {
  const strip = (t: string): string =>
    t
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/^[ \t]*<!--[\s\S]*?-->$/gm, '');

  const files: string[] = [];
  (function walk(dir: string, prefix: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (/\.(vue|css)$/.test(e.name)) files.push(rel);
    }
  })(SRC, '');
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

  /** 容器那一族 = 竖着的那两位。宽与行高不归这里管。 */
  const containerHeights = (text: string): string[] =>
    [...strip(text).matchAll(/(?:^|\n)\s*(?:height|min-height)\s*:\s*(\d+(?:\.\d+)?px)\s*(?:;|$)/g)].map((m) => m[1] ?? '');

  const hits28 = files.flatMap((rel) => containerHeights(read(rel)).filter((v) => v === '28px').map(() => rel));
  const baseCss = strip(read('styles/base.css'));
  const dockTabBlock = /(^|\n)\.dock__tab\s*\{([^}]*)\}/.exec(baseCss)?.[2] ?? '';

  it('仪器自检：文件真扫到了、`.dock__tab` 那一块真读得出来（扫空表这几条会集体空转）', () => {
    expect(files.length, '一个 .vue/.css 都没扫到').toBeGreaterThan(20);
    expect(dockTabBlock.length, '读不到 .dock__tab 那个规则块').toBeGreaterThan(20);
  });

  it('52 的主人是 .dock__tab，那两个数都不许漂（44 那一档已有主人 = `--touch`，归上面那个 describe，这里不重复钉）', () => {
    expect(/(^|\n)\s*height:\s*52px\s*;/.test(dockTabBlock), '.dock__tab 的容器高不是规范那个 52（§3.5「每个 tab 56×52」）').toBe(true);
    expect(/(^|\n)\s*width:\s*56px\s*;/.test(dockTabBlock), '.dock__tab 的容器宽不是规范那个 56').toBe(true);
  });

  it('28 这一档没有任何容器主人（双向闸：冒出一颗 height/min-height:28px 就红着要归属）', () => {
    expect(hits28, `这些声明把 28 当成了容器高，可 §2.5 那一行还没给它主人（见 A6 / D13）：${JSON.stringify(hits28)}`).toEqual([]);
  });

  it('牙齿：竖着那两位要被抓，宽与行高不许误伤（合成串，不碰源文件）', () => {
    expect(containerHeights('.x {\n  height: 28px;\n}')).toEqual(['28px']);
    expect(containerHeights('.x {\n  min-height: 28px;\n}')).toEqual(['28px']);
    expect(containerHeights('.x {\n  width: 28px;\n}'), '§3.4 那道渐隐的宽被当成容器了').toEqual([]);
    expect(containerHeights('.x {\n  line-height: 28px;\n}'), '§1.5 的行高被当成容器了').toEqual([]);
  });
});

/**
 * 列表那一栏的表头 —— 第一百五十五批那一遍整跑（腿 ㊻）红出来的修法，钉在这儿当静态证人。
 *
 * 病是第一百五十三批带进来的：列表那一栏是**定宽栏**（整跑实测 1440 与 390 两档的可用内容宽都只有 ~315px，
 * 因为窄的是栏目而不是窗口），而那一排放着标题 + 四颗动作。多一颗之后 flex 只能先吃标题：
 * 红的那一遍量到 390 那档 `clientWidth=40 / scrollWidth=67`，**1440 那档 `clientWidth=0`** ——
 * 用户读不到"自己在哪一栏"，而屏幕上没有任何一句话说明这件事（§5 禁的就是这一族）。
 *
 * 修法两句话，两条各配一把牙齿：**放不下就折行**（付的是高度，不是信息），**标题的基准换成内容宽**且全文挂在 `title` 上。
 * 这里认的是**能生效的那一句声明**（[[static-gate-must-name-the-binding-declaration]]），不是"文件里出现过这个词"。
 */
const declOf = (css: string, sel: string): string => {
  const m = new RegExp(`\\n\\s*${sel}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : '';
};
const headerWraps = (css: string): boolean => /(^|\n)\s*flex-wrap:\s*wrap\s*;/.test(declOf(css, '.pane-header'));
const titleHoldsItsWidth = (css: string): boolean => /(^|\n)\s*flex:\s*0\s+1\s+auto\s*;/.test(declOf(css, '.pane-title'));
const titleCarriesFullText = (vue: string): boolean => /class="pane-title"[^>]*:title="listTitle"/.test(vue);

describe('定宽栏的表头：多一颗动作时先让位的是折行，不是标题（§1.2 + §5）', () => {
  const baseCss = readFileSync(join(SRC, 'styles', 'base.css'), 'utf8');
  const noteList = readFileSync(join(SRC, 'components', 'NoteList.vue'), 'utf8');

  it('仪器自检：两条声明与那一行模板都真读得出来（读空串这几条会集体空转）', () => {
    expect(declOf(baseCss, '.pane-header').length, '读不到 .pane-header 那一条声明').toBeGreaterThan(20);
    expect(declOf(baseCss, '.pane-title').length, '读不到 .pane-title 那一条声明').toBeGreaterThan(20);
    expect(/class="pane-title"/.test(noteList), 'NoteList 里找不到那颗标题').toBe(true);
  });

  it('.pane-header 会折行；放不下的是这一排，不是那几个字', () => {
    expect(headerWraps(baseCss), '.pane-header 没有 flex-wrap: wrap —— 定宽栏里多一颗按钮就会先压标题').toBe(true);
  });

  it('.pane-title 的基准是内容宽（`flex: 1` 那种把 0 当基准的写法就是这一次红出来的形状）', () => {
    expect(titleHoldsItsWidth(baseCss), '.pane-title 不是 flex: 0 1 auto').toBe(true);
    expect(/text-overflow:\s*ellipsis/.test(declOf(baseCss, '.pane-title')), '省略号那一格没写，长文件夹名会硬切').toBe(true);
  });

  it('被裁的那一段一字不差挂在 `title` 上（§5 的出口②；触屏没有 hover，这一格只算兜底不算解法）', () => {
    expect(titleCarriesFullText(noteList), '那颗标题没把 listTitle 挂到 title 上').toBe(true);
  });

  it('牙齿：三种坏形状各红一条，好的那一版不误伤（合成串，不碰源文件）', () => {
    expect(headerWraps('\n.pane-header {\n  display: flex;\n}\n'), '摘掉 wrap 却没红').toBe(false);
    expect(headerWraps('\n.pane-header {\n  flex-wrap: nowrap;\n}\n'), 'nowrap 被当成会折行').toBe(false);
    expect(titleHoldsItsWidth('\n.pane-title {\n  flex: 1;\n  min-width: 0;\n}\n'), '旧写法（基准 0）却没红').toBe(false);
    expect(titleCarriesFullText('<span class="pane-title">{{ listTitle }}</span>'), '摘掉 title 绑定却没红').toBe(false);
    expect(titleCarriesFullText('<span class="pane-title" :title="other">{{ listTitle }}</span>'), 'title 挂错了对象').toBe(false);
  });
});
