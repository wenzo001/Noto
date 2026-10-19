/**
 * `findInNote` 的判据（纯函数那一层）。
 *
 * 这一层全是"关系"判据，不碰 DOM —— 所以它能挡住三种形状：
 *  ① 空查询被当成"处处命中"（那样"0 处"那句永远说不出口，屏幕上还会糊一片选区）；
 *  ② 偏移按整篇累加（调用方要的是**块内**偏移，与 `applySelection` 同一坐标系）；
 *  ③ 游标前进写成 +1 ⇒ 重叠命中（`aaa` 里找 `aa` 得两处，浏览器与原生编辑器都给一处）。
 * 每条都配了反向那一格：只断言"找到了"而没有"不该找到的没找到"，就还是半把尺子。
 */
import { describe, expect, it } from 'vitest';
import type { Inline } from './api/types';
import { emptyParagraph, type EditorBlock } from './editor/model';
import { findMatches, nextIndex, prevIndex } from './editor/findInNote';

/** 造一块正文：走模型自己的构造函数，只往里面塞一段文字。
 *  自己拼 block 的字面量 = 第二份模型形状，字段一改这里就悄悄不对了。 */
function text(id: string, value: string): EditorBlock {
  const inline: Inline = { text: value };
  return { ...emptyParagraph([inline]), id };
}

describe('文内查找的命中（纯函数）', () => {
  it('① 命中位置是块内偏移，且长度等于查询长度', () => {
    const hits = findMatches([text('b1', '今天天气不错，明天也还不错')], '不错');
    expect(hits).toEqual([
      { blockId: 'b1', start: 4, end: 6 },
      { blockId: 'b1', start: 11, end: 13 },
    ]);
  });

  it('② 空查询与全空白查询 ⇒ 零处（不许"处处命中"）', () => {
    const blocks = [text('b1', '甲')];
    expect(findMatches(blocks, '')).toEqual([]);
    expect(findMatches(blocks, '   ')).toEqual([]);
  });

  it('③ 大小写不敏感，但返回的是**原文**的偏移（不改文档）', () => {
    const hits = findMatches([text('b1', 'Noto 同步 NOTO 协议')], 'noto');
    expect(hits.map((h) => [h.start, h.end])).toEqual([[0, 4], [8, 12]]);
  });

  it('④ 跨块按文档顺序，blockId 各归各（偏移不许累加）', () => {
    const hits = findMatches([text('b1', '甲乙'), text('b2', '乙丙乙')], '乙');
    expect(hits).toEqual([
      { blockId: 'b1', start: 1, end: 2 },
      { blockId: 'b2', start: 0, end: 1 },
      { blockId: 'b2', start: 2, end: 3 },
    ]);
  });

  it('⑤ 不重叠前进：`aaa` 里找 `aa` 只算一处（重叠会多出一处假的"下一处"）', () => {
    expect(findMatches([text('b1', 'aaa')], 'aa')).toHaveLength(1);
  });

  it('⑥ 查不到的形状各有对照：比正文长 / 被分成两块 / 空文档', () => {
    expect(findMatches([text('b1', '短')], '短短')).toEqual([]);
    expect(findMatches([text('b1', 'AB'), text('b2', 'CD')], 'ABCD')).toEqual([]);
    expect(findMatches([], '任何东西')).toEqual([]);
  });

  it('⑦ 下一处/上一处：到末尾折回，零处给 -1，从"还没跳"起步时上一处落在最后', () => {
    expect(nextIndex(3, -1)).toBe(0);
    expect(nextIndex(3, 2)).toBe(0);
    expect(prevIndex(3, -1)).toBe(2);
    expect(prevIndex(3, 0)).toBe(2);
    expect(nextIndex(0, 0)).toBe(-1);
    expect(prevIndex(0, 5)).toBe(-1);
  });

  it('⑧ 查询两端带空格 ⇒ 按去过空白的串匹配（用户多打一个空格不该变成"0 处"）', () => {
    expect(findMatches([text('b1', '甲乙丙')], '  乙  ')).toEqual([{ blockId: 'b1', start: 1, end: 2 }]);
  });
});
