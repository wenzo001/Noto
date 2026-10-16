// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §1.6 动效纪律：**只动画不引起布局的属性**（规范原句："只动画 transform 与 opacity（GPU 加速）"）。
 *
 * 它与 §4.9 自己的悬停规格（"底转 --sunken"、120ms 过渡表）**字面冲突** —— 一份要求"只 transform/opacity"，
 * 另一份的交互反馈本来就要动画底色。处理方式与前一个冲突（§1.4 的控件高度 vs §5 的 44pt）同一条先例：
 * **把冲突钉成断言**，选一个两边都成立、还能挡住真危险的读法 ——
 *   · **禁**：布局几何类（width / height / top / left / margin / padding / font-size / line-height /
 *     flex 系列 / grid 系列 / gap 等）
 *     以及 `all`（它会把布局属性悄悄带进来）—— 那才是 §1.6"GPU 加速"那句话真正要拦的（重排 + 掉帧）；
 *   · **允许**：transform / opacity（§1.6 明写），以及 background(-color) / border-color / color / filter /
 *     box-shadow（§4.9 的悬停反馈要求这些；小面积、只重绘）。
 * 从今往后口径分歧由这张表裁决，不再靠"读着像不像"。
 *
 * 两侧对照都在：被禁的每一条一枚合成样本、必须被抓；被允许的每一条一枚、必须放行；
 * 真实文件扫描还有一条"扫到的文件数下界"（scan 空转 = 全绿的那种假绿）。
 *
 * 扫描**故意不走 vite 的模块管线**（原先是 `import.meta.glob` + `?raw`）：2026-10-10 做变异自证时，
 * 同一份磁盘上刚追加过 `.zz-mutation` 的 base.css，glob 先返回**旧内容**、再返回**空串** ——
 * 一个会把"刚改过的文件"读错/读空的仪器，当不了变异证明的证人。改成 `node:fs` 直接读 `src/` 下的
 * 每个 .vue/.css，读到的就是这一刻磁盘上的字节。
 */
const BANNED = [
  'width', 'height', 'top', 'left', 'right', 'bottom', 'inset',
  'margin', 'margin-top', 'margin-left', 'padding', 'padding-left',
  'font-size', 'line-height', 'letter-spacing',
  'flex-basis', 'grid-template-columns', 'grid-template-rows', 'gap', 'all',
];
const ALLOWED = ['transform', 'opacity', 'background', 'background-color', 'border-color', 'color', 'filter', 'box-shadow'];

/**
 * 与 `negativePromises.spec.ts` 同一把尺子（那处修在 `dc8a03b`）：单行注释认任意位置，
 * **多行块只认行首开批**。原来这一条是不锚行首的那把（正则里那段非贪婪跨行匹配），
 * 一份**值**里偶然出现的块注释开批符号（例如 content 里写了一对斜杠加星号）会被当成"开批"，
 * 一路吃到后面某处的收批符号，中间整段语料被静默吞掉 —— 这条门禁从此什么都不判，还一路绿。
 * （2026-10-13 在 i18n.ts 上真的发生过，一次吞掉 191 行。）
 * ⚠ 这段注释里不许出现那对收批符号本身 —— 写进去就会把这段注释当场关掉，剩下的句子变成代码。
 *   本仓踩过这条，记在 "注释里那对符号会自己咬断自己" 那条口径里（这一版就犯过一次）。
 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[^\n]*?\*\//g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');

/** 一枚 transition / transition-property 声明里"第一个 token = 被动画的属性名"。 */
function transitionProps(text: string): string[] {
  const stripped = stripComments(text);
  const out: string[] = [];
  for (const m of stripped.matchAll(/transition(?:-property)?\s*:\s*([^;{}]+)[;}]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const first = part.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (first) out.push(first);
    }
  }
  return out;
}

/** `@keyframes` 块内部声明的属性名（用花括号计数取块，别用贪婪正则）。 */
function keyframeProps(text: string): string[] {
  const stripped = stripComments(text);
  const out: string[] = [];
  const re = /@keyframes\s+[\w-]+\s*\{/g;
  let m = re.exec(stripped);
  while (m) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < stripped.length && depth > 0; i++) {
      if (stripped[i] === '{') depth += 1;
      else if (stripped[i] === '}') depth -= 1;
    }
    const block = stripped.slice(re.lastIndex, Math.max(re.lastIndex, i - 1));
    for (const d of block.matchAll(/([a-z-]+)\s*:/g)) {
      const prop = d[1];
      if (prop) out.push(prop);
    }
    m = re.exec(stripped);
  }
  return out;
}

const flaggedIn = (text: string): string[] =>
  [...transitionProps(text), ...keyframeProps(text)].filter((p) => BANNED.includes(p));

/** 从磁盘枚举 `src/` 下的 .vue/.css（相对本文件所在目录），键形如 `./styles/base.css`。 */
function walk(dirAbs: string, prefix: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dirAbs, entry.name), rel, out);
    else if (/\.(vue|css)$/.test(entry.name)) out[rel] = readFileSync(join(dirAbs, entry.name), 'utf8');
  }
}

const FILES: Record<string, string> = {};
walk(fileURLToPath(new URL('.', import.meta.url)), '.', FILES);

describe('§1.6 动效纪律（与 §4.9 的冲突已钉成表）', () => {
  it('仪器自检：扫源码这条路真的扫到了文件，且已知文件的字节真的读进来了（空转 = 全绿的那种假绿）', () => {
    expect(Object.keys(FILES).length).toBeGreaterThan(20);
    // 曾经出现过"文件在盘上、读回来是空串"（glob 管线缓存），这条下界把那种读空钉死。
    expect(FILES['./styles/base.css']?.length ?? 0).toBeGreaterThan(1000);
  });

  it('被禁的每一条合成样本都必须被抓到（名单里的每一条各自来一枚）', () => {
    for (const prop of BANNED) {
      const sample = `.x { transition: ${prop} var(--motion-fast) var(--ease); }`;
      expect(flaggedIn(sample), `transition: ${prop} 没被抓到`).toContain(prop);
    }
    // keyframes 里同样要抓
    const kf = `@keyframes zz { from { ${BANNED[0]}: 1px; } to { ${BANNED[0]}: 2px; } }`;
    expect(flaggedIn(kf)).toContain(BANNED[0]);
  });

  it('被允许的每一条合成样本都必须放行（反向：名单不能宽到把 §4.9 的悬停反馈也拦下）', () => {
    for (const prop of ALLOWED) {
      const sample = `.x { transition: ${prop} var(--motion-fast) var(--ease); }`;
      expect(flaggedIn(sample), `transition: ${prop} 被误伤`).toEqual([]);
    }
  });

  it('真实源码：没有任何一处动画/过渡碰布局几何或 all', () => {
    const hits: Array<{ file: string; prop: string }> = [];
    for (const [file, text] of Object.entries(FILES)) {
      for (const prop of flaggedIn(text)) hits.push({ file, prop });
    }
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §1.6 的 token 表 + §4.9 的「动画参数」表 —— 这四个数以前**一次都没被读过**：
 * `tokens.spec.ts` 那一条只断 reduced-motion 下 `--motion-fast: 0ms`（连 `--motion-base` 都没读），
 * 上面那个 describe 只禁 property、从不读值，整跑那几腿读的是 `animationName` 与 `getAnimations().length`。
 * 也就是说"谁把 120ms 抄成 150ms、谁把圈改成 1.2s"这件事当时**没有执行者**。
 *
 * 期望值一律从规范原文抄（下面那几行就是原文），不许由被测的 CSS 反推：
 *   §1.6 Token 表：`--motion-fast 120ms` / `--motion-base 220ms`
 *   §4.9 动画参数表：`悬停 / 按下 120ms，cubic-bezier(0.2, 0, 0, 1)`、`浮层进出 220ms，同曲线`、
 *                    `同步转圈 1.4s linear infinite`
 *   §4.9 收尾那句：`prefers-reduced-motion 下全部时长归零，同步动画降级为静止指示`
 */
describe('§1.6 / §4.9 动效那四个数与归零的执行者', () => {
  const tokensCss = stripComments(FILES['./styles/tokens.css'] ?? '');

  /** 一处 `animation:` 简写声明（不碰 `animation-duration` 那类长写法 —— 归零用的就是长写法）。 */
  function animationsIn(text: string): string[] {
    const stripped = stripComments(text);
    const out: string[] = [];
    for (const m of stripped.matchAll(/(?:^|[;{\s])animation\s*:\s*([^;{}]+)[;}]/g)) {
      const decl = (m[1] ?? '').trim().replace(/\s+/g, ' ');
      if (decl) out.push(decl);
    }
    return out;
  }

  /** `@media … <feature> … {` 那一整块的正文（花括号计数；贪婪正则会吃掉后面整个文件）。 */
  function mediaBlock(text: string, feature: string): string {
    const stripped = stripComments(text);
    const re = new RegExp(`@media[^{]*${feature}[^{]*\\{`, 'gm');
    const m = re.exec(stripped);
    if (!m) return '';
    let depth = 1;
    let i = re.lastIndex;
    for (; i < stripped.length && depth > 0; i += 1) {
      if (stripped[i] === '{') depth += 1;
      else if (stripped[i] === '}') depth -= 1;
    }
    return stripped.slice(re.lastIndex, Math.max(re.lastIndex, i - 1));
  }

  const ANIM_SITES: Array<{ file: string; decl: string }> = [];
  for (const [file, text] of Object.entries(FILES)) {
    for (const decl of animationsIn(text)) ANIM_SITES.push({ file, decl });
  }

  /**
   * 规范 §4.9 只给了**一种**循环动画（同步转圈 1.4s linear infinite）。源码里其余每一处各有来历，
   * 走**可证伪台账**（同 `iconSystem.spec.ts` 那两条）：台账必须真的命中，多命中与不命中都红 ——
   * 所以"再加一处野动画"必须当场登记，而登记了又不存在的那条会红着提醒撤账。
   */
  const SPEC_SPIN = 'sync-spin 1.4s linear infinite';
  const REGISTERED: Array<{ file: string; decl: string; why: string }> = [
    {
      file: './styles/base.css',
      decl: 'pulse 1.4s ease-in-out infinite',
      why: '加载骨架（`.skeleton__row`）。§4.9 那张场景表里**没有"加载态"这一行**，所以 1.4s 是沿用、ease-in-out 也不在规范曲线上 —— 这是规范欠的一行，不是这里的违规；要改先补规范。',
    },
    // 2026-10-14：这里原本还有第二条 —— `.badge[data-badge='syncing'] .badge__glyph` 上那句 `spin 1.6s`
    // （不合规范的 1.4s，挂在一族没有模板消费者的死 CSS 上）。那块死 CSS 被删掉之后这条台账**必须一起撤**，
    // 否则这一族会红在"登记了又不成立"那一臂 —— 这正是它设计出来的样子（欠账还得掉，不是记一次就永远挂着）。
  ];

  it('仪器自检：token 与 animation 都真的扫到了（扫空表这几条会集体空转）', () => {
    expect(tokensCss.length).toBeGreaterThan(1000);
    // 死 CSS 那处被删掉之后，源码里的 animation 从 5 处变成 4 处（三处同步转圈 + 一处骨架 pulse）
    expect(ANIM_SITES.length).toBeGreaterThanOrEqual(4);
    // 已知那四处必须都在：底栏那颗、状态条那颗、编辑器里那颗、骨架
    const spinners = ANIM_SITES.filter((s) => s.decl === SPEC_SPIN).length;
    expect(spinners, `同步转圈那三处应当都在，实测 ${spinners}`).toBe(3);
  });

  it('§1.6 那两个时长与 §4.9 那条曲线，原样写在 tokens 里', () => {
    const decl = (property: string) => new RegExp(`(^|\\n)\\s*${property}:\\s*([^;\\n]+);`).exec(tokensCss)?.[2]?.trim();
    expect(decl('--motion-fast'), '--motion-fast 不是规范 §1.6 的 120ms').toBe('120ms');
    expect(decl('--motion-base'), '--motion-base 不是规范 §1.6 的 220ms').toBe('220ms');
    // 规范那行写的是 cubic-bezier(0.2, 0, 0, 1)：空格与数字一个都不许改，它是悬停/按下/浮层共用的那一条
    expect(decl('--ease'), '--ease 不是规范 §4.9 的 cubic-bezier(0.2, 0, 0, 1)').toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('过渡时长必须走这两个 token（写了字面数值的过渡不归 §1.6 那"归零"管）', () => {
    const literals: Array<{ file: string; decl: string }> = [];
    for (const [file, text] of Object.entries(FILES)) {
      const stripped = stripComments(text);
      for (const m of stripped.matchAll(/transition(?:-property)?\s*:\s*([^;{}]+)[;}]/g)) {
        const decl = (m[1] ?? '').trim();
        for (const part of decl.split(',')) {
          if (/\d+(?:\.\d+)?m?s/.test(part) && !part.includes('var(--motion')) {
            literals.push({ file, decl: part.trim() });
          }
        }
      }
    }
    expect(literals, JSON.stringify(literals)).toEqual([]);
  });

  /**
   * 上面那条拦住了"字面数值"，可它自己有一条**空转的画法**：谁把过渡整行删掉，
   * 那条照样绿（扫到 0 项 ≠ 检查过），而 §4.9 要的"悬停 120ms 淡入"从此没有执行者 ——
   * 和用户点了没反应的按钮是同一族缺陷，只是这次坏的是"没有过渡"而不是"过渡太长"。
   * 所以这一条**点名两档各自的消费者**，再补一条总量下界（今日实测 6 处，分布在 4 个文件）。
   */
  it('§4.9 那两档必须各有真消费者：按钮的悬停走 fast、抽屉浮层进出走 base', () => {
    const base = stripComments(FILES['./styles/base.css'] ?? '');
    const block = (selector: string) => {
      const m = new RegExp(`^${selector}\\s*\\{([^}]*)\\}`, 'm').exec(base);
      expect(m, `base.css 里找不到 ${selector} 这一个规则块`).not.toBeNull();
      return m?.[1] ?? '';
    };
    const has = (text: string, token: string) =>
      new RegExp(`transition:[^;]*${token}[^;]*var\\(--ease\\)`).test(text);

    expect(has(block('\\.btn'), '--motion-fast'), '.btn 不再用 --motion-fast 过渡（§4.9 悬停/按下那一档 120ms）').toBe(true);
    expect(has(block("\\.app-shell\\[data-layout='one'\\] \\.pane--sidebar"), '--motion-base'),
      '侧栏抽屉不再用 --motion-base 进出（§4.9 浮层进出那一档 220ms）').toBe(true);

    let tokenTransitions = 0;
    for (const text of Object.values(FILES)) {
      tokenTransitions += [...stripComments(text).matchAll(/transition(?:-property)?\s*:[^;{}]*var\(--motion/g)].length;
    }
    // ⚠ 这个下界是**这条扫描自己数出来的 6**，不是 grep 的行数 —— 第一次写成 6（照 grep 抄），
    // 于是 K9 那一刀（拿掉一处 token 过渡）没能让它红：AppCheckbox.vue 里有一条跨行的声明，grep 数成 1、这里数成 2。
    // 6 = AppCheckbox 1 + base.css 3（.btn / 抽屉 / dock）+ editor.css 2。少一处就得写下为什么。
    // 2026-10-16 第八十二批：AppCheckbox 的画框从"CSS 画的方框 + ::after 那颗勾"换成 §2.2 的 SVG 载体，
    // 那条 `::after` 的 transform 过渡随之失去主语 ⇒ 这个文件从 2 处降到 1 处（**动的属性仍是两个**：color 与 opacity）。
    // 下界跟着改成 6，不是消音：这一族原来那两处里有**一处已经不存在**，硬留 7 就等于要求代码里再长出一条没人用的过渡。
    // 牙齿复验过 —— 拿掉 AppCheckbox 这一处，总数 5 仍然红（K9 那一刀的判定不受影响）。
    expect(tokenTransitions, '用 token 的过渡掉出 6 处（AppCheckbox 1 + base.css 3 + editor.css 2）—— 删掉过渡=§4.9 那一档没人执行了').toBeGreaterThanOrEqual(6);
  });

  it('每一处 animation: 只能等于规范那句同步转圈；例外只准台账里那几条，且必须真的命中', () => {
    const same = (a: { file: string; decl: string }, b: { file: string; decl: string }) =>
      a.file === b.file && a.decl === b.decl;
    const rest = ANIM_SITES.filter((s) => s.decl !== SPEC_SPIN);
    const extra = rest.filter((s) => !REGISTERED.some((r) => same(r, s)));
    const unused = REGISTERED.filter((r) => !rest.some((s) => same(s, r)));
    expect(extra, `这些 animation: 既不是规范那一句也没登记：${JSON.stringify(extra)}`).toEqual([]);
    expect(unused, `台账里这两条已经不成立了（死代码删掉了就撤账）：${JSON.stringify(unused.map((u) => u.decl))}`).toEqual([]);
  });

  it('reduced-motion 的执行者必须拦得住硬编码的 1.4s —— 只把 token 归零不算归零', () => {
    const block = mediaBlock(FILES['./styles/tokens.css'] ?? '', 'prefers-reduced-motion');
    expect(block.length, '找不到 prefers-reduced-motion 那一块').toBeGreaterThan(0);
    // 两个时长都得归零（规范原话是"全部时长归零"）
    expect(/--motion-fast:\s*0ms/.test(block), 'reduced-motion 下 --motion-fast 没归零').toBe(true);
    expect(/--motion-base:\s*0ms/.test(block), 'reduced-motion 下 --motion-base 没归零').toBe(true);
    // ⚠ 关键在这一条：三处同步转圈写的都是**字面** 1.4s，不认 token ——
    // 只有那条通配 `*` 的 !important 才真把它们按住。以前这一句谁都没读，删掉它整套门禁仍然全绿。
    expect(/\*\s*,/.test(block), 'reduced-motion 里没有通配 * 的那一条（字面时长就没人管了）').toBe(true);
    expect(/animation-duration:[^;\n]*!important/.test(block), '通配那条没把 animation-duration 压成 !important').toBe(true);
    expect(/transition-duration:[^;\n]*!important/.test(block), '通配那条没把 transition-duration 压成 !important').toBe(true);
    // 无限循环必须收成 1 次：时长归零但 iteration 还是 infinite 的话，圈会一直重跑（掉 CPU、也不叫"静止指示"）
    expect(/animation-iteration-count:\s*1\s*!important/.test(block), '循环没收成 1 次 —— "降级为静止指示"没落实').toBe(true);
  });
});
