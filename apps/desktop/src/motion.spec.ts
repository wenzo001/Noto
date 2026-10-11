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

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

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
