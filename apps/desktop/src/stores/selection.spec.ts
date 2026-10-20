/**
 * 多选状态（第一百五十七批）。跑法：
 * `pnpm --dir apps/desktop exec vitest run src/stores/selection.spec.ts`
 *
 * 这一族最贵的两种错法是"两个状态互相污染"与"扩选把已有选区洗掉"，所以两侧各有一条腿：
 *  · 勾了几篇**不许**换编辑器里那一篇（`notes.selectedId` 一字不动）；
 *  · 反过来打开一篇**不许**改选区；
 *  · Shift 扩选是**并进**，不是替换（替换的写法在第一次扩选就丢光用户已经勾的那几篇）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useNoteStore } from './notes';
import { useSelectionStore } from './selection';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('勾选本身', () => {
  it('点一下进选区、再点一下出选区，条数与包含判断各说各的', () => {
    const s = useSelectionStore();
    s.toggle('a');
    expect(s.ids).toEqual(['a']);
    expect(s.has('a')).toBe(true);
    expect(s.count).toBe(1);
    s.toggle('b');
    s.toggle('a');
    expect(s.ids).toEqual(['b']);
    expect(s.has('a')).toBe(false);
    expect(s.empty).toBe(false);
    s.toggle('b');
    expect(s.empty, '全部取消之后必须是空的（empty 与 count 不许各走一套）').toBe(true);
    expect(s.count).toBe(0);
  });
});

describe('两个状态互不污染', () => {
  it('进多选模式与勾几篇，都不许动"打开的是哪一篇"', () => {
    const notes = useNoteStore();
    const s = useSelectionStore();
    notes.selectedId = 'open-me';
    s.enter();
    s.toggle('x');
    s.toggle('y');
    expect(notes.selectedId, '勾选中不许把编辑器里那一篇换掉').toBe('open-me');
    expect(s.ids).toEqual(['x', 'y']);
  });

  it('退出多选要把选区收干净（留着勾着的 N 篇去按别的键，比看不见更糟）', () => {
    const s = useSelectionStore();
    s.enter();
    s.toggle('x');
    s.exit();
    expect(s.active).toBe(false);
    expect(s.ids).toEqual([]);
    expect(s.anchor).toBe(null);
  });
});

describe('Shift 扩选', () => {
  it('区间两头都含、方向反过来也一样，而且是**并进**已有选区', () => {
    const s = useSelectionStore();
    const order = ['1', '2', '3', '4', '5'];
    s.toggle('2');
    s.extend('4', order);
    expect(s.ids).toEqual(['2', '3', '4']);
    s.clear();
    s.toggle('4');
    s.extend('2', order);
    expect(s.ids, '倒着拖必须得到同一段').toEqual(['4', '2', '3']);
  });

  it('锚点不在这一份顺序里（换了列表档 / 那一篇被删了）⇒ 只勾目标这一篇，不猜区间', () => {
    const s = useSelectionStore();
    s.toggle('gone');
    s.extend('3', ['1', '2', '3']);
    expect(s.ids).toEqual(['gone', '3']);
    expect(s.anchor).toBe('3');
  });
});

describe('全选与批量之后的收口', () => {
  it('全选吃的是传进来的那份顺序（核心 `rows`），不是屏幕上可见那一段', () => {
    const s = useSelectionStore();
    const domWindow = ['a', 'b'];
    const coreRows = ['a', 'b', 'c', 'd', 'e'];
    s.selectAll(coreRows);
    expect(s.count, '虚拟列表的 DOM 窗口是子集，拿它当"全选"就是少选').toBe(5);
    expect(s.ids).toEqual(coreRows);
    expect(s.ids.includes('e'), domWindow.join(',')).toBe(true);
    expect(s.anchor).toBe('e');
  });

  it('批量动作只把自己处理掉的那几篇摘出去，其余留着；锚点若被处理掉就清空', () => {
    const s = useSelectionStore();
    s.toggle('a');
    s.toggle('c');
    s.toggle('b');
    expect(s.anchor, '锚点 = 最后一次点的那一颗（不是选区里第一颗）').toBe('b');
    s.removeMany(['a']);
    expect(s.ids).toEqual(['c', 'b']);
    expect(s.anchor, '锚点那颗还在 ⇒ 不许动它（下一步 Shift 还要用它取区间）').toBe('b');
    s.removeMany(['b']);
    expect(s.ids).toEqual(['c']);
    expect(s.anchor, '锚点那一已经被处理掉了 ⇒ 不能再拿它当区间端点').toBe(null);
  });

  it('空列表上的全选与空删除都不许凭空造出条数', () => {
    const s = useSelectionStore();
    s.selectAll([]);
    expect(s.ids).toEqual([]);
    expect(s.anchor).toBe(null);
    s.removeMany(['x']);
    expect(s.count).toBe(0);
  });
});
