import { describe, expect, it } from 'vitest';
import { CARRIERS, ICONS } from './components/ui/icons';

/**
 * §2 的门禁：**图标一律 SVG，不许再用 Unicode 字形顶替**。
 *
 * 设计稿给的理由（原话摘要）：☰ ↻  ⌫ ⇤  ▾ ✎ 这类字形依赖各平台字体回退 ——
 * Windows 的 Segoe UI 与 macOS 的 SF Pro 形状必然不同，而本项目是"一份前端服务四端"。
 * 这条以前只是文档里的一句话，所以侧栏的 ＋、置顶的 ●/○、同步五格的 ✓ ↻ ○ ! ·、
 * 附件那颗 ▤/▦、拖拽把手 ⠿、工具条的 ⇤ ⇥ 全都还是字形。
 *
 * 判据刻意只抓两种形状，避免把散文也抓进来：
 *  ① 元素的**全部文字内容**就是一个字形字符（`>●<`）；
 *  ② `icon` / `glyph` 这类"图标位"的属性值里出现字形。
 * 注释一律先抹掉 —— 不抹会撞上 Vue 开发模式的 `<!--v-if-->` 与我写在模板里的说明，
 * 那是我在第 ㉔ 腿刚踩过的假红来源。
 */
const FILES = import.meta.glob<string>('../**/*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** §2 点名的那一批，加上这次替换掉的。 */
const GLYPH = [...'☰↻⌫⇤⇥▾✎＋○●◎✓✔▤▦⠿★☆→‹›≡×✕✖•'];

/**
 * 符号类（Sm/Sc/Sk/So）—— 拿一个符号当图标用这一族的本体。
 * 枚举式黑名单永远少一个字符：这条门禁写完的同一晚，ToastHost 那颗 U+00D7 就从表缝里漏了出去
 * → 由类别判据兜底，上面那张表只用来兜 <‹ ›> 那一类标点形状的。
 */
const SYMBOL = /\p{S}/u;

/**
 * 第三类 `\p{S}` 也抓不到的：**ASCII 标点当状态标记**。
 * `BannerHost` 那条"库版本过新"的横幅前缀就是一个裸的 `!`（U+0021 是标点，不是符号类），
 * 而它干的活与 ⚠ 一模一样 —— 字体不同就长得不同，且与旁边 1.75px 描边的图标不成一套。
 * 判据：元素内容只有**一个既不是字母、也不是数字、也不是空白**的字符。
 *
 * ⚠️ 这里放过字母与数字是**刻意的，但代价是这一条抓不到"字母当图标位"**（B/I/U/S、那颗字号 A）。
 * 我原先在注释里把这一格写成"§2.4 认的通用认知"，那是把规范读反了：§2.4 的原话是
 * 「文字类用 SVG 路径画，**不用** B/I 字形 …… 但语义沿用 B/I/U/S 的通用认知」——
 * 后半句约束的是**画出来的形状**，不是许可继续打字母。源码扫描分不出"图标位"与"文字标签"
 * （块型菜单里的 `H1` 就是给人读的），所以那一族由 `verify-layout` 第 ㉟ 腿在渲染后的 DOM 上判：
 * **按钮的直接文本恰是一个字母/数字，而可访问名来自 aria-label ⇒ 那个字符在当图标**。
 */
const PUNCT_MARK = /^[^\p{L}\p{N}\p{M}\s]$/u;

function templateOf(text: string): string {
  const start = text.indexOf('<template');
  const end = text.lastIndexOf('</template>');
  if (start < 0 || end < 0) return '';
  return text.slice(start, end).replace(/<!--[\s\S]*?-->/g, '');
}

describe('§2 图标必须是 SVG，不许是 Unicode 字形', () => {
  const violations: string[] = [];
  let scanned = 0;

  for (const [file, raw] of Object.entries(FILES)) {
    const tpl = templateOf(raw);
    if (tpl.length === 0) continue;
    scanned += 1;
    for (const m of tpl.matchAll(/>([^<>]+)</g)) {
      const inner = (m[1] ?? '').trim();
      if (inner.length === 1 && (GLYPH.includes(inner) || SYMBOL.test(inner) || PUNCT_MARK.test(inner))) {
        violations.push(`${file} 元素内容是一个字形「${inner}」`);
      }
    }
    for (const m of tpl.matchAll(/\b(?:icon|glyph)(?::|=)\s*=?\s*"([^"]*)"/g)) {
      const value = m[1] ?? '';
      if ([...value].some((c) => GLYPH.includes(c) || SYMBOL.test(c))) {
        violations.push(`${file} 图标位属性给了字形「${value}」`);
      }
    }
  }

  it('扫描真的覆盖到了足够多的组件（否则"零违规"是空转）', () => {
    expect(scanned).toBeGreaterThanOrEqual(20);
    expect(Object.keys(FILES).length).toBeGreaterThanOrEqual(20);
  });

  it('界面上没有任何一个位置在用 Unicode 字形当图标', () => {
    expect(violations, `还有 ${violations.length} 处：\n${violations.join('\n')}`).toEqual([]);
  });
});

/**
 * §2.2 / §2.3 的载体规则里可机检的**两句**：
 *  ① **同族共享同一条基形**（规范：五格云"共用同一片云轮廓，只换内部徽标"）；
 *  ② **不同族不许共用基形**（规范原话："不同语义必须用不同载体，绝不同组混用"，
 *     而 v1 犯的正是"同步五格与保存三态都用圆圈 + 符号，两枚撞脸"）。
 * 以前这里只有 ① 的两族（云 / 文档），② 一句都没量过 —— 而 §2.2 的"撞脸"其实**是 ② 那一半**，
 * 只守 ① 等于把规范那半句话留在了注释里。
 *
 * 两处已知破的地方走**登记台账**（不是注释）：台账必须"确实命中过"才算生效，
 * 而且**只准命中登记的那几对** —— 设计师的真 SVG 一到，这两条会红着提醒"撤掉豁免"（同 §5 那条"登记表要能被证伪"）。
 */
describe('§2.2 载体：同族共享同一条基形，异族不许共用基形', () => {
  // 基形 = 那条外轮廓。`solid`（实心态）与 `d`（描边态）画的是同一个形状的两种上法 ⇒ 都算基形。
  const baseOf = (n: string): string | undefined => {
    const icon = (ICONS as Record<string, { d?: string[]; solid?: string[] }>)[n];
    return [...(icon?.d ?? []), ...(icon?.solid ?? [])][0];
  };
  const groups = Object.keys(CARRIERS);
  const basesOf = (g: string) => new Set((CARRIERS as Record<string, string[]>)[g].map(baseOf));

  it('仪器自检：族与成员都真的扫到了（扫到空表这两条会集体空转）', () => {
    expect(groups.length).toBeGreaterThanOrEqual(4);
    const total = groups.reduce((a, g) => a + (CARRIERS as Record<string, string[]>)[g].length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
    expect(groups.every((g) => [...basesOf(g)].every((b) => typeof b === 'string' && b.length > 3)), '有成员的基形读不出来').toBe(true);
  });

  // ① 同族一条基形。star 那一族登记在案：实心与空心两枚现在是**两条不同的星形路径**（不是同一条的两面上法），
  //    真 SVG 到手要改成同一条轮廓 + 换填充。台账不命中就红，多命中也红。
  const WITHIN_FAMILY_REGISTERED: Array<[string, number]> = [['star', 2]];
  it('① 同族必须共享同一条基形（例外只准是登记台账里那几对，且必须真的命中）', () => {
    const bad = groups
      .map((g) => ({ g, n: basesOf(g).size, members: (CARRIERS as Record<string, string[]>)[g].length }))
      .filter((x) => x.members >= 2 && x.n !== 1);
    const extra = bad.filter((x) => !WITHIN_FAMILY_REGISTERED.some(([g, n]) => g === x.g && n === x.n));
    const unused = WITHIN_FAMILY_REGISTERED.filter(([g, n]) => !bad.some((x) => x.g === g && x.n === n));
    expect(extra, `这些族没共享基形又没登记：${JSON.stringify(extra)}`).toEqual([]);
    expect(unused, `台账里这几条已经不复存在（真 SVG 到了就撤掉它）：${JSON.stringify(unused)}`).toEqual([]);
  });

  // ② 异族不许共用基形。**台账现在是空的**：这一条真去量的时候发现 `icons.ts` 那条注释
  // （"附件那两颗也是纸，与保存同载体"）**已经过期** —— 附件那颗的第一条路径与保存那一族的 `DOC` 基形不同，
  // 五族之间没有任何一对共用基形。台账留空不是"没有这一判"，而是"这一判现在零例外"：
  // 谁以后把两族的轮廓抄成同一条，② 立刻红；哪天确实需要共用，就必须在这里登记下来（并写为什么）。
  const CROSS_FAMILY_REGISTERED: Array<[string, string]> = [];
  it('② 不同族之间不许共用同一条基形（撞脸就是 §2.2 点名的那个 v1 错误），例外同样走可证伪的台账', () => {
    const collisions: Array<[string, string]> = [];
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const a = basesOf(groups[i]);
        const b = basesOf(groups[j]);
        if ([...a].some((x) => b.has(x))) collisions.push([groups[i], groups[j]]);
      }
    }
    const same = (p: [string, string], q: [string, string]) => (p[0] === q[0] && p[1] === q[1]) || (p[0] === q[1] && p[1] === q[0]);
    const extra = collisions.filter((p) => !CROSS_FAMILY_REGISTERED.some((q) => same(p, q)));
    const unused = CROSS_FAMILY_REGISTERED.filter((q) => !collisions.some((p) => same(p, q)));
    expect(extra, `这两族共用了基形又没登记：${JSON.stringify(extra)}`).toEqual([]);
    expect(unused, `共用基形的台账里这几对已经不成立了（撤掉它）：${JSON.stringify(unused)}`).toEqual([]);
  });
});
