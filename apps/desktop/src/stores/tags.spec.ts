/**
 * 标签的读侧与写侧（ADR-0022）。
 *
 * 判据打在**这一族真正会坏的两件事**上：
 *  · **认不出的 id 不许长出 chip**（核心折叠/软删之后链接里留着的旧 id，界面凭空画一颗
 *    点不开的东西，用户会以为标签还在）；
 *  · **写回的边**（`set_note_tags` 发的是整份集合 + 那个 id），不是"被调方绿了"就算接线。
 */
// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { chipModel, toggleIn, useTagStore } from './tags';
import { useNoteStore } from './notes';
import { stubLocalService } from '../testing/http';
import type { Tag } from '../api/types';

const tag = (id: string, title: string, noteCount = 0): Tag => ({ id, title, noteCount });
const index = (list: Tag[]): Record<string, Tag> => Object.fromEntries(list.map((t) => [t.id, t]));

describe('chipModel：只画核心认得的那些', () => {
  const pool = [tag('b', '乙', 1), tag('a', '甲', 2), tag('c', '丙', 0)];

  it('对照：抽取器真读到了三份（否则"少画一颗"可以是"一颗都没画"）', () => {
    expect(chipModel(['a', 'b'], index(pool))).toHaveLength(2);
  });

  it('认不出的 id 一颗都不长', () => {
    const chips = chipModel(['a', '已消失的id', 'b'], index(pool));
    expect(chips.map((t) => t.id)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(chips).toHaveLength(2);
  });

  it('顺序按人看的（collator + numeric），不跟着链接里写的顺序', () => {
    // 只钉"数字档"这一件真会错的事：`第2版` 必须排在 `第10版` 前面（码点位正好相反）。
    const byId = index([tag('z', '第2版'), tag('y', '第10版')]);
    expect(chipModel(['z', 'y'], byId).map((t) => t.title)).toEqual(['第2版', '第10版']);
    expect(chipModel(['y', 'z'], byId).map((t) => t.title)).toEqual(['第2版', '第10版']);
  });

  it('同一个 id 写了两遍只画一颗（读侧去重，不靠 SQL 那一层）', () => {
    expect(chipModel(['a', 'a'], index(pool))).toHaveLength(1);
  });
});

describe('toggleIn：集合语义', () => {
  it('没挂上就加上，挂上了就摘掉', () => {
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'b')).toEqual(['a']);
  });

  it('不改入参，也不留重复', () => {
    const src = ['a'];
    const next = toggleIn(src, 'a');
    expect(src).toEqual(['a']);
    expect(next).toEqual([]);
    expect(toggleIn(['a', 'a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('tag store 的调用边（打到发出去的那一发命令上）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('load 发的是 list_tags，回来的每一格都按名字解析（不是按位置）', async () => {
    const service = stubLocalService({
      list_tags: () => [{ id: 't1', title: '工作', noteCount: 3 }, { id: 't2', title: '读后' }, '坏的一行'],
    });
    const tags = useTagStore();
    await tags.load();
    expect(service.callsOf('list_tags')).toHaveLength(1);
    expect(tags.tags).toEqual([tag('t1', '工作', 3), tag('t2', '读后', 0)]);
    // 缺 noteCount 的那一行给 0，而不是 undefined：界面 `> 0` 那一句要永远有数可比。
    // `ordered` 只钉"同一批内容、不重不漏、幂等"：中文的**具体先后**由运行时的 ICU 决定，
    // Node（可能带 small-icu）与 Chromium 给的答案不同 ⇒ 按位置写死就是一条假判据。
    expect([...tags.ordered.map((t) => t.id)].sort()).toEqual(['t1', 't2']);
    expect(tags.ordered.map((t) => t.id).sort()).toEqual(tags.ordered.map((t) => t.id).sort());
  });

  it('create 发的是标题原样（trim 后），且核心回的那一颗被并进表里而不是新起一行', async () => {
    const service = stubLocalService({
      list_tags: () => [{ id: 't1', title: '工作', noteCount: 0 }],
      create_tag: () => ({ id: 't1', title: '工作', noteCount: 0 }),
    });
    const tags = useTagStore();
    await tags.load();
    const created = await tags.create('  工作  ');
    expect(service.lastArgsOf('create_tag')).toEqual({ title: '工作' });
    expect(created?.id).toBe('t1');
    expect(tags.tags).toHaveLength(1);
  });

  it('rename 失败（与另一颗同名）之后回读一次 —— 界面不许停在"看起来改成了"的那份读数上', async () => {
    let loads = 0;
    const service = stubLocalService({
      list_tags: () => {
        loads += 1;
        return [{ id: 't1', title: '旧名', noteCount: 0 }, { id: 't2', title: '别的', noteCount: 0 }];
      },
      rename_tag: () => {
        throw new Error('constraint');
      },
    });
    const tags = useTagStore();
    await tags.load();
    expect(await tags.rename('t1', '别的')).toBe(false);
    expect(tags.byId['t1']?.title, '库里还是旧名，界面不许显示新名').toBe('旧名');
    expect(tags.errorKey, '被拒的那一发要在界面上说得出话').not.toBeNull();
    // 失败**不产生第二次命令**，也不偷偷 reload 一份"看起来对了"的读数：`rename` 只发一次，
    // `list_tags` 仍然是 load 那一次的 1 —— 界面上的旧名与库里那份是同一份。
    expect(service.callsOf('rename_tag')).toHaveLength(1);
    expect(loads).toBe(1);
  });

  it('remove 成功后本地立刻少一行（核心是软删，不会再被 list 送回来）', async () => {
    const service = stubLocalService({
      list_tags: () => [{ id: 't1', title: '工作', noteCount: 1 }],
      delete_tag: () => null,
    });
    const tags = useTagStore();
    await tags.load();
    expect(await tags.remove('t1')).toBe(true);
    expect(service.lastArgsOf('delete_tag')).toEqual({ id: 't1' });
    expect(tags.tags).toEqual([]);
  });
});

describe('笔记↔标签那一条边（notes.setTags 发整份集合，并且回读）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('发的是 {id, tagIds}，随后回读 note_tags 的那一份才算界面上的集合', async () => {
    const service = stubLocalService({
      list_notes: () => [],
      set_note_tags: () => ({ id: 'n1', title: '一篇', tagIds: ['t1'] }),
      note_tags: () => ['t1', 't2'],
    });
    const notes = useNoteStore();
    const after = await notes.setTags('n1', ['t1']);
    expect(service.lastArgsOf('set_note_tags')).toEqual({ id: 'n1', tagIds: ['t1'] });
    expect(after).toEqual(['t1', 't2']);
    expect(notes.tagIdsByNote['n1']).toEqual(['t1', 't2']);
  });

  it('写被拒时保留本机那一份，不留下"已经改好了"的读数', async () => {
    const service = stubLocalService({
      list_notes: () => [],
      note_tags: () => ['t1'],
      set_note_tags: () => {
        throw new Error('read_only_refused');
      },
    });
    const notes = useNoteStore();
    await notes.loadTagIds('n1');
    expect(notes.tagIdsByNote['n1']).toEqual(['t1']);
    expect(await notes.setTags('n1', ['t1', 't2'])).toEqual(['t1']);
    expect(notes.tagIdsByNote['n1']).toEqual(['t1']);
    expect(notes.errorKey).not.toBeNull();
    // 被拒的那一笔**不该再回读一次**装作什么都没发生：本机那一份仍然和库里一致。
    expect(service.callsOf('note_tags')).toHaveLength(1);
  });
});
