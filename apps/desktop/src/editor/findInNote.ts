/**
 * 文内查找（采纳自 Joplin 的 `showLocalSearch`，`docs/JOPLIN-VS-NOTO-FEATURE-MAP.md` §3.1 那一行 ✅）。
 *
 * 这一份是**纯函数**：只吃笔记的块模型，不碰 DOM、不碰选区、不写任何东西。
 * 三条形状上的决定，都不是随手选的：
 *  · **偏移量按"块"算，不按整篇算**。编辑器的可编辑面是**每块一个 `contenteditable`**
 *    （`RichEditor.vue` 用 `[data-block-id="…"] .nb-content` 取那一格），
 *    而 `applySelection(root, start, end)` 的坐标就是**那个 root 里的模型偏移**。
 *    所以命中项必须带 `blockId`，否则调用方还得自己再算一遍块边界 —— 那会长出第二份真相。
 *  · 文本取自 `blockText()`，与界面渲染、保存、导出走的是**同一份读法**。
 *    自己再拼一遍 inline 文本，就会出现"查找命中的字与屏幕上看的字不一样"。
 *  · **不许改文档**。查找只读；跳下一处靠选区（`applySelection` + `caretInView`），
 *    不靠往正文里插 `<mark>` —— 那会把笔记弄脏并触发一次保存，用户只是找了个词。
 */
import { blockText, type EditorBlock } from './model';

export interface FindMatch {
  readonly blockId: string;
  /** 块内模型偏移，**含**起点。 */
  readonly start: number;
  /** **不含**终点，所以 `end - start` 恒等于**去过空白并折叠大小写之后**的那串 needle 的长度
   *  （`query` 本身可以带首尾空格 —— 长度以 needle 为准，见 `findMatches`）。 */
  readonly end: number;
}

/**
 * 找出 `query` 在这一批块里的每一处出现，按**文档顺序**返回（块的先后 = 块的模型顺序）。
 *
 * 口径：
 *  · 空 / 全空白的查询 ⇒ **零处**，而不是"每处都算命中"（`''` 在任意位置都能匹配，
 *    把它当命中会画出一屏的选中区，还会让"0 处"那一句永远说不出口）；
 *  · 大小写不敏感（`toLowerCase` 只用来比，不改原文 —— CJK 走这条分支是恒等变换）；
 *  · **不重叠**：命中之后游标前进整个 needle 的长度，所以 `aaa` 里找 `aa` 得 1 处 ——
 *    这是浏览器与原生编辑器的一致行为，不是简化；
 *  · 跨块的词**不合并**（每块是独立的一段文字；一个词被分成两个块，本来就是两段）。
 */
export function findMatches(blocks: readonly EditorBlock[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const out: FindMatch[] = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (text.length === 0) continue;
    const hay = text.toLowerCase();
    for (let from = 0;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      out.push({ blockId: block.id, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return out;
}

/**
 * 下一处的下标：`current` 是**当前停在哪一处**（-1 = 还没跳）。到末尾折回第一处。
 * 零处 ⇒ -1 —— 调用方那句要写"0 处"，不许画一个不存在的选择。
 */
export function nextIndex(count: number, current: number): number {
  if (count <= 0) return -1;
  return (current + 1) % count;
}

/** 上一处：从"还没跳"起步要落到**最后一处**，而不是第一处（浏览器的查找条就是这个行为）。 */
export function prevIndex(count: number, current: number): number {
  if (count <= 0) return -1;
  // `-1`（还没跳）不能直接套模：`(-1 - 1 + count) % count` 给的是 `count - 2`，
  // 也就是"倒数第二处"—— 第一次按「上一处」就跳错一格。
  if (current < 0) return count - 1;
  return (current - 1 + count) % count;
}
