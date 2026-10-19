/**
 * 文内统计（采纳 Joplin 的 `NoteContentPropertiesDialog`，`JOPLIN-VS-NOTO-FEATURE-MAP.md` §3.1 那一行）。
 *
 * **这一份存在的唯一理由是中文**。英文那套"按空格切词"直接搬到中文上会得到"整篇一个词"，
 * 而它现在被拿来估阅读时长 ⇒ 屏幕上的那句"约 N 分钟"对中文用户是假的。
 * 口径（与 `docs/design/*.md` 的中文阅读场景一致，不是随便挑的常数）：
 *  · **字**：CJK 字符逐个算（汉字没有空格分词）；
 *  · **词**：非 CJK 的拉丁/数字串按连续段算一个（`don't`、`1.0` 这种带标点的一串算一个）；
 *  · 两者相加才是"字数 + 词数"那一句里的"量"，**不重复计**（CJK 字符不会同时进词数）；
 *  · **阅读时长**：中文 300 字/分钟、拉丁 200 词/分钟（保守值），向上取整、最少 1 分钟 ——
 *    这两个常数是**产品口径**，改了要在这里说清是谁改的、为什么。
 *
 * 与渲染有关的那两格**故意不做**：屏幕上"几行"取决于视口宽度与排版，jsdom 量不到、
 * 也不该在这里编一个数 —— 所以这里给的是**段数**（= 块数），标签就叫"段"。
 * 把"段"写成"行"是本仓在 §8 那条"报告不许钉住它自己会重写的读数"同族的谎。
 */
import { blockText, docCharCount, type EditorBlock } from './model';

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const LATIN_RUN = /[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F'’\-]*/g;

export interface TextStats {
  /** 码位数的正文长度（不是 UTF-16 长度 —— emoji 与补充平面汉字会差）。 */
  readonly chars: number;
  /** CJK 单字数 + 拉丁词数。 */
  readonly words: number;
  /** 块数（界面上叫"段"）。 */
  readonly blocks: number;
  /** 分钟，向上取整、最少 1（零内容时为 0）。 */
  readonly minutes: number;
}

const CJK_PER_MINUTE = 300;
const WORDS_PER_MINUTE = 200;

export function textStatsOf(blocks: readonly EditorBlock[]): TextStats {
  let cjk = 0;
  let latinWords = 0;
  for (const block of blocks) {
    const text = blockText(block);
    if (text.length === 0) continue;
    for (const ch of text) {
      if (CJK.test(ch)) cjk += 1;
    }
    latinWords += (text.replace(new RegExp(CJK.source, 'g'), ' ').match(LATIN_RUN) ?? []).length;
  }
  // 字数只有一份算法：核心的 `char_count` 是什么口径，这里就是什么口径（见 `docCharCount` 的注释）。
  const chars = docCharCount(blocks);
  const words = cjk + latinWords;
  const minutes = words === 0
    ? 0
    : Math.max(1, Math.ceil(cjk / CJK_PER_MINUTE + latinWords / WORDS_PER_MINUTE));
  return { chars, words, blocks: blocks.length, minutes };
}
