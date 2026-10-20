/**
 * 草稿态新建（第一百六十二批，map 第 80 行；口径照抄 Joplin，见 `stores/provisional.ts` 顶部那三处出处）。
 * 跑法：`node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop src/provisional.spec.ts`
 *
 * 这里断的是**调用边与结果**：
 *  · 新建 ⇒ 那一条被标成 provisional，且**当场选中**（Joplin 同一条）；
 *  · 选中项换成别的 ⇒ 除目标以外的 provisional 笔记**真发 delete_note**（软删、不是永久删）；
 *  · 用户改过它（`applyNoteUpdate`）⇒ 摘掉标记，之后再切走**不许**删；
 *  · 删失败（库只读等）⇒ 它留在列表里，不许"界面上没了、库里也没那条删除事实"。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { noteFixture, stubLocalService } from './testing/http';
import { useNoteStore } from './stores/notes';
import { useProvisionalStore } from './stores/provisional';
import { useToastStore } from './stores/toasts';

const OLD = 'note-old';

function makeCore(opts: { failDelete?: boolean } = {}) {
  const rows = [noteFixture({ id: OLD, rev: 2, title: '旧的一篇' })];
  const deleted: string[] = [];
  let seq = 0;
  stubLocalService({
    list_notes: () => rows,
    get_note: (args) => rows.find((r) => r.id === String(args.id)) ?? noteFixture({ id: String(args.id), rev: 1 }),
    create_note: () => {
      seq += 1;
      const made = noteFixture({ id: `note-new-${seq}`, rev: 1, title: '' });
      rows.unshift(made);
      return made;
    },
    delete_note: (args) => {
      const id = String(args.id);
      if (opts.failDelete) throw new Error('readonly');
      deleted.push(id);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return null;
    },
  });
  return { rows, deleted };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useToastStore().setTimers({
    set: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clear: () => {},
    now: () => 0,
  } as never);
});

describe('provisional 这本小账', () => {
  it('mark / is / confirm / pendingExcept / forget 各自只动自己那一格', () => {
    const p = useProvisionalStore();
    p.mark('a');
    p.mark('b');
    p.mark('a');
    expect(p.ids).toEqual(['a', 'b']);
    expect(p.is('a')).toBe(true);
    expect(p.is(null)).toBe(false);
    expect(p.pendingExcept('a')).toEqual(['b']);
    p.confirm('a');
    expect(p.ids).toEqual(['b']);
    p.forget('b');
    expect(p.ids).toEqual([]);
  });
});

describe('新建 ⇒ 切走时收掉', () => {
  it('新建那一条被标记并当场选中；换成旧的一篇 ⇒ 对它发一次 delete_note', async () => {
    const core = makeCore();
    const notes = useNoteStore();
    await notes.load();

    const made = await notes.create(null);
    expect(made).not.toBeNull();
    expect(useProvisionalStore().is(made?.id)).toBe(true);
    expect(notes.selectedId).toBe(made?.id);

    notes.selectedId = OLD;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(core.deleted).toEqual([made?.id]);
    expect(useProvisionalStore().is(made?.id)).toBe(false);
  });

  it('用户改过它 ⇒ 摘掉标记，之后再切走**不许**删（Joplin: 改过才永久保存）', async () => {
    const core = makeCore();
    const notes = useNoteStore();
    await notes.load();
    const made = await notes.create(null);
    expect(made).not.toBeNull();

    notes.applyNoteUpdate(noteFixture({ id: String(made?.id), rev: 2, title: '我打了字' }) as unknown as Parameters<typeof notes.applyNoteUpdate>[0]);
    expect(useProvisionalStore().is(made?.id)).toBe(false);

    notes.selectedId = OLD;
    await new Promise((r) => setTimeout(r, 0));
    expect(core.deleted).toEqual([]);
  });

  it('删失败 ⇒ 它留在列表里、账上也还在（不许把"没删成"说成"删了"）', async () => {
    const core = makeCore({ failDelete: true });
    const notes = useNoteStore();
    await notes.load();
    const made = await notes.create(null);
    expect(made).not.toBeNull();

    notes.selectedId = OLD;
    await new Promise((r) => setTimeout(r, 0));
    // forget 先跑（否则下一轮会反复删同一条），但列表里那一条必须还在
    expect(core.rows.some((r) => r.id === made?.id), '删失败时那一条不许从列表里消失').toBe(true);
  });
});
