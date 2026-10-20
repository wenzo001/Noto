/**
 * 批量加标签（第一百五十九批，采纳清单第 94 行那半截）。跑法：
 * `node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop src/batchTag.spec.ts`
 *
 * 这里断的是**调用边与载荷**，不是"store 里有这个函数"：
 *  · 核心只有逐篇的 `set_note_tags`，而它是**全量替换** ⇒ 这一发必须"读—并—写"：
 *    已经有这颗的**不发**，发出去的那几支载荷必须含这篇**原有**的标签（少了就是把别人的标签洗掉）；
 *  · 读不到现有标签就**停**：拿空清单去写，用户原来那些标签会一起没；
 *  · 一篇都没真加上时**不许**冒出一句"已加 0 篇"（那是报一件没发生的事）。
 *
 * 界面那一半（悬浮层里的按钮、44pt、"加完标签清单的计数跟着动"）由整跑腿 84 在真浏览器里量。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { noteFixture, stubLocalService } from './testing/http';
import { useNoteStore } from './stores/notes';
import { useToastStore } from './stores/toasts';

const A = 'note-aaaa';
const B = 'note-bbbb';
const C = 'note-cccc';
const ids = [A, B, C];
const TAG = 'tag-新';
const OLD = 'tag-旧';

function makeCore(opts: { failWriteOn?: string; badReadOn?: string } = {}) {
  const tagsOf = new Map<string, string[]>([
    [A, [OLD]],
    [B, [TAG]], // 这一篇本来就有 ⇒ 不许再发
    [C, []],
  ]);
  const seq: string[] = [];
  stubLocalService({
    list_notes: () => ids.map((id) => noteFixture({ id, rev: 2 })),
    get_note: (args) => noteFixture({ id: String(args.id), rev: 2 }),
    note_tags: (args) => {
      const id = String(args.id);
      if (opts.badReadOn === id) return { nonsense: true };
      seq.push(`read:${id}`);
      return tagsOf.get(id) ?? [];
    },
    set_note_tags: (args) => {
      const id = String(args.id);
      if (opts.failWriteOn === id) throw new Error('boom');
      const list = (args.tagIds as string[]).slice();
      seq.push(`write:${id}:[${list.join(',')}]`);
      tagsOf.set(id, list);
      return noteFixture({ id, rev: 3 });
    },
  });
  return { seq, tagsOf };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

/** 这一批的 toast 只排 timer 的那一族；给它一把记排队的尺，免得真的等 4.5 秒。 */
function quietTimers() {
  useToastStore().setTimers({
    set: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clear: () => {},
    now: () => 0,
  } as never);
}

describe('批量加标签', () => {
  it('三篇里有一篇本来就有 ⇒ 读三支、只写两支，且写出去的载荷保留各篇原有的标签（并集，不是覆盖）', async () => {
    const core = makeCore();
    quietTimers();
    const notes = useNoteStore();
    await notes.load();

    const n = await notes.batchAddTag([A, B, C], TAG, '新');
    expect(n, '真加上的篇数：B 本来就有，不该算进去').toBe(2);
    expect(core.seq.filter((s) => s.startsWith('read:')).sort()).toEqual(
      [`read:${A}`, `read:${B}`, `read:${C}`],
    );
    const writes = core.seq.filter((s) => s.startsWith('write:')).sort();
    expect(writes, '写了哪几篇：B 不许再发一次（幂等），A 与 C 各一支').toEqual([
      `write:${A}:[${OLD},${TAG}]`,
      `write:${C}:[${TAG}]`,
    ]);
    expect(core.tagsOf.get(A), 'A 原来那颗要还在 —— 少了就是拿全量替换当增量用').toEqual([OLD, TAG]);
  });

  it('全都本来就有 ⇒ 一支都不发、返回 0、也不冒"已加 0 篇"那句', async () => {
    const core = makeCore();
    quietTimers();
    const notes = useNoteStore();
    await notes.load();
    const before = useToastStore().items.length;

    const n = await notes.batchAddTag([B], TAG, '新');
    expect(n).toBe(0);
    expect(core.seq.filter((s) => s.startsWith('write:'))).toEqual([]);
    expect(useToastStore().items.length, '一件事都没发生就不许说一句"已加 0 篇"').toBe(before);
  });

  it('读不到现有标签 ⇒ 停在那一篇、一支都不写（拿空清单去覆盖会洗掉用户原来的标签）', async () => {
    const core = makeCore({ badReadOn: A });
    quietTimers();
    const notes = useNoteStore();
    await notes.load();

    const n = await notes.batchAddTag([A, C], TAG, '新');
    expect(n).toBe(0);
    expect(core.seq.filter((s) => s.startsWith('write:')), '读失败之后不许有任何写').toEqual([]);
    expect(notes.errorKey).toBe('state.tagReadFailed');
  });

  it('半途失败：已经加上的算数、返回的篇数就是真加上那几篇（不谎报也不吞掉）', async () => {
    const core = makeCore({ failWriteOn: C });
    quietTimers();
    const notes = useNoteStore();
    await notes.load();

    const n = await notes.batchAddTag([A, C], TAG, '新');
    expect(n).toBe(1);
    expect(core.seq.filter((s) => s.startsWith('write:'))).toEqual([`write:${A}:[${OLD},${TAG}]`]);
  });

  it('空选区 ⇒ 一条命令都不发（连读都不读）', async () => {
    const core = makeCore();
    quietTimers();
    const notes = useNoteStore();
    await notes.load();
    core.seq.length = 0;

    expect(await notes.batchAddTag([], TAG, '新')).toBe(0);
    expect(core.seq).toEqual([]);
  });
});
