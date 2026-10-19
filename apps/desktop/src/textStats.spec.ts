/**
 * `textStats` 与"字数口径"的判据（纯函数那一层）。
 *
 * 这一族的失败形状很具体：
 *  · 拿英文那套"按空格切词"数中文 ⇒ 一整篇中文算"1 词"，屏幕上"约 1 分钟"对任何中文长文都是假的；
 *  · 字数**两边两个口径** ⇒ 侧栏（核心的 `char_count`：码点、不含空白）与编辑器角上（曾经是 UTF-16 码元、含空白）
 *    对同一篇笔记报两个数 —— 这正是本批动手之前先对账抓到的那条。
 * 所有期望值都是**手算写死的字面量**，不拿被测函数的输出当期望（§43 那条：期望值的来路必须独立）。
 */
import { describe, expect, it } from 'vitest';
import type { Inline } from './api/types';
import { docCharCount, emptyParagraph, type EditorBlock } from './editor/model';
import { textStatsOf } from './editor/textStats';

function block(value: string): EditorBlock {
  const inline: Inline = { text: value };
  return emptyParagraph([inline]);
}

function blocks(...values: string[]): EditorBlock[] {
  return values.map((v) => block(v));
}

describe('文内统计的口径', () => {
  it('① 纯中文：三个字就是三个“字”，不是一“词”', () => {
    expect(textStatsOf(blocks('甲乙丙'))).toEqual({ chars: 3, words: 3, blocks: 1, minutes: 1 });
  });

  it('② 纯英文：空格分开的串算词，而**空格本身不进字数**', () => {
    expect(textStatsOf(blocks('hello world'))).toEqual({ chars: 10, words: 2, blocks: 1, minutes: 1 });
  });

  it('③ 混排：中文按字、拉丁按串，两边相加而不重复计', () => {
    // "阅读 2 articles" → 汉字 2 + 拉丁串 2（"2" 与 "articles"）= 4；字数 11（码点、去掉两个空格）
    expect(textStatsOf(blocks('阅读 2 articles'))).toEqual({ chars: 11, words: 4, blocks: 1, minutes: 1 });
  });

  it('④ 空文档与"只有空白"：四格全 0，时长不许说“约 1 分钟”', () => {
    expect(textStatsOf([])).toEqual({ chars: 0, words: 0, blocks: 0, minutes: 0 });
    expect(textStatsOf(blocks('   ', '\t\n'))).toEqual({ chars: 0, words: 0, blocks: 2, minutes: 0 });
  });

  it('⑤ 四百个汉字 ⇒ 向上取整到 2 分钟（300 字/分钟这条产品口径的证人）', () => {
    expect(textStatsOf(blocks('甲'.repeat(400)))).toMatchObject({ chars: 400, words: 400, minutes: 2 });
  });

  it('⑥ 撇号与连字符不断词', () => {
    expect(textStatsOf(blocks("don't end-user x"))).toMatchObject({ words: 3 });
  });

  it('⑦ 字数按码点不按 UTF-16：两个补充平面字符算 2 个（emoji 与扩展区汉字都别多数一遍）', () => {
    const stats = textStatsOf(blocks('𝐐𝐐')); // 两个 U+1D410，UTF-16 长度各 2
    expect(stats.chars).toBe(2);
    // 它既不在 CJK 表里、也不在拉丁串的字表里 ⇒ 词数 0：**"占几个字"与"算几个词"是两件事**，
    // 这里分开断言，免得以后有人为了让两者一致去改字表。
    expect(stats.words).toBe(0);
  });

  it('⑧ 多段：段数 = 块数（屏幕上的标签只能叫“段”，“行”要排版才量得到）', () => {
    expect(textStatsOf(blocks('第一段', '第二段', '第三段')).blocks).toBe(3);
  });
});

describe('字数只有一份口径（核心派生列的 UI 侧影子）', () => {
  /**
   * 这份 fixture 与期望值是**照核心那一侧的规则写的**：
   * `crates/notera-richtext/src/extract.rs` 的 `char_count = plain.chars().filter(!is_whitespace).count()`
   * （Rust 的 `chars()` 是 Unicode 标量值，等价于 JS 的 `for...of`）。
   * 它钉的是"规则相同"，不是"两边真通过一次序列化对过账"—— 后者要在真设备/真核心上跑，
   * 这一格按 §40 记着：**规则对得上，实调用没有跨语言证人**。
   * 变异（把 `docCharCount` 改回 `.replace(/\n/g,'').length`）⇒ ①② 两条一起红。
   */
  const MIXED = '中文 与 English 混排 𝐐';
  // 码点且去空白：中文6 + 与1 + English7 + 混排2 + 𝐐1 = 17? 逐字数过：
  // "中文"2、"与"1、"English"7、"混排"2、"𝐐"1 ⇒ 13（空格 3 个不进）
  it('核心口径：码点 + 不含空白，两侧算成同一个数', () => {
    expect(docCharCount(blocks(MIXED))).toBe(13);
    expect(textStatsOf(blocks(MIXED)).chars).toBe(13);
  });

  it('反向对照：空白与换行一律不进字数（侧栏与角上不许为这个差一格）', () => {
    expect(docCharCount(blocks('a b\tc\nd e'))).toBe(5);
  });
});
