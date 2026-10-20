/**
 * 批量那两路（第一百五十七批，A 档 P5）。跑法：
 * `node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop src/batchSelection.spec.ts`
 *
 * 这里断的是**调用边与结果**，不是"store 里有这个函数"：
 *  · 勾了 N 篇 ⇒ `delete_note` 必须正好 N 支、id 就是那 N 篇，多一支少一支都红；
 *  · 撤销那一条恢复的是**按下那一刻的那几篇的快照** —— 读活名单的写法在"用户删完又勾了别的"之后
 *    会把不相干的篇一起恢复回来（这一条有反向对照）；
 *  · 半途失败不许把已经移走的那几篇变成"没有出口"：返回的是真移走的篇数，而那条 toast 仍然带撤销；
 *  · 批量**移动**不给撤销 ⇒ 它按 §4.9 那一族自动消失（与删除那条互为对照：一个排 timer、一个不排）。
 *
 * "点完退出多选 / 半途失败留下没处理的那几篇还在选区里"这一半是组件里的编排，
 * 由整跑腿 82 在真浏览器里量（不在这里演，演出来的是假现场）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { noteFixture, stubLocalService } from './testing/http';
import { useNoteStore } from './stores/notes';
import { useToastStore } from './stores/toasts';

const A = 'note-aaaa';
const B = 'note-bbbb';
const C = 'note-cccc';
const ids = [A, B, C];

function makeCore(opts: { failOn?: string } = {}) {
  const trashed = new Set<string>();
  const folderOf = new Map<string, string>();
  const seq: string[] = [];
  const note = (id: string) =>
    noteFixture({
      id,
      rev: 3,
      folderId: folderOf.get(id) ?? null,
      doc: { v: 1, content: [{ id: `d${id}`, type: 'paragraph', content: [{ text: `${id} 的正文` }] }] },
      deletedAt: trashed.has(id) ? '2026-10-20T00:00:00Z' : null,
    });
  stubLocalService({
    get_note: (args) => note(String(args.id)),
    list_notes: () => ids.map(note).filter((n) => !trashed.has(String(n.id))),
    delete_note: (args) => {
      const id = String(args.id);
      if (opts.failOn === id) throw new Error('boom');
      seq.push(`delete:${id}`);
      trashed.add(id);
      return null;
    },
    restore_note: (args) => {
      seq.push(`restore:${String(args.id)}`);
      trashed.delete(String(args.id));
      return null;
    },
    set_note_folder: (args) => {
      const id = String(args.id);
      seq.push(`folder:${id}→${String(args.folderId)}`);
      folderOf.set(id, String(args.folderId));
      return note(id);
    },
  });
  return { seq, trashed, folderOf };
}

/** 记下 `set` 的排计时，与 `toastUndo.spec.ts` 同一把尺：带动作那一族不排 timer。 */
function recordingTimers() {
  const calls: Array<{ ms: number }> = [];
  return {
    calls,
    timers: {
      set: (_fn: () => void, ms: number) => {
        calls.push({ ms });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => {},
      now: () => 0,
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('批量删除', () => {
  it('三篇 ⇒ 三支 delete_note、id 就是那三篇，返回 3，且那条提示带撤销', async () => {
    const core = makeCore();
    const toasts = useToastStore();
    toasts.setTimers(recordingTimers().timers as never);
    const notes = useNoteStore();
    await notes.load();

    const moved = await notes.batchMoveToTrash([A, B, C]);
    expect(moved).toBe(3);
    expect(core.seq.filter((s) => s.startsWith('delete:')).sort()).toEqual([`delete:${A}`, `delete:${B}`, `delete:${C}`]);
    const made = toasts.items[toasts.items.length - 1];
    expect(made.text).toContain('3');
    expect(made.action?.label, '批量删除那条没带撤销 ⇒ 用户没有出口').toBe('撤销');
  });

  it('撤销恢复的是按下那一刻的三篇；之后再勾别的也不被一起恢复（快照，不是活名单）', async () => {
    const core = makeCore();
    const toasts = useToastStore();
    toasts.setTimers(recordingTimers().timers as never);
    const notes = useNoteStore();
    await notes.load();

    await notes.batchMoveToTrash([A, B]);
    const made = toasts.items[toasts.items.length - 1];
    // 按下撤销之前，用户又勾了 C（这一格防的是"闭包读活名单"那种写法）
    await notes.batchMoveToTrash([C]);
    const second = toasts.items[toasts.items.length - 1];

    toasts.invoke(made.id);
    // 逐篇恢复是**串行**的（每一篇都要重读一次列表，见 `restore` 里那步 `load()`）⇒
    // 等"两支都在"而不是等第一支，否则会读到"只恢复了一篇"的中间态（这一发我自己先踩过一次）。
    await vi.waitFor(() =>
      expect(core.seq.filter((s) => s.startsWith('restore:')).sort()).toEqual([`restore:${A}`, `restore:${B}`]),
    );
    expect(core.trashed.has(C), '第一条撤销把第二条那篇一起捞回来 = 撤了用户没打算撤的东西').toBe(true);

    toasts.invoke(second.id);
    await vi.waitFor(() => expect(core.seq).toContain(`restore:${C}`));
    expect(core.trashed.size).toBe(0);
  });

  it('第二支失败：只算真移走的那一支，但已经移走的必须有撤销出口，且错误摆出来', async () => {
    const core = makeCore({ failOn: B });
    const toasts = useToastStore();
    toasts.setTimers(recordingTimers().timers as never);
    const notes = useNoteStore();
    await notes.load();

    const moved = await notes.batchMoveToTrash([A, B, C]);
    expect(moved, '半途失败却报"三篇都移走了"是对用户的谎').toBe(1);
    expect(core.seq.filter((s) => s.startsWith('delete:'))).toEqual([`delete:${A}`]);
    expect(notes.errorKey, '失败没有任何具名原因 ⇒ 用户只看到少了一篇').toBeTruthy();
    const made = toasts.items[toasts.items.length - 1];
    expect(made.text).toContain('1');
    expect(made.action?.label).toBe('撤销');
    toasts.invoke(made.id);
    await vi.waitFor(() => expect(core.seq).toContain(`restore:${A}`));
  });

  it('空名单：一支都不发，也不许冒出一条"N 篇"的提示', async () => {
    const core = makeCore();
    const toasts = useToastStore();
    const notes = useNoteStore();
    await notes.load();
    expect(await notes.batchMoveToTrash([])).toBe(0);
    expect(core.seq).toEqual([]);
    expect(toasts.items).toEqual([]);
  });
});

describe('批量移动', () => {
  it('两篇 ⇒ 两支 set_note_folder、目标文件夹是同一个，返回 2', async () => {
    const core = makeCore();
    const toasts = useToastStore();
    toasts.setTimers(recordingTimers().timers as never);
    const notes = useNoteStore();
    await notes.load();

    const moved = await notes.batchMoveTo([A, B], 'folder-work', '工作');
    expect(moved).toBe(2);
    expect(core.seq.filter((s) => s.startsWith('folder:')).sort()).toEqual([
      `folder:${A}→folder-work`,
      `folder:${B}→folder-work`,
    ]);
    const made = toasts.items[toasts.items.length - 1];
    expect(made.text).toContain('工作');
    expect(made.action, '移动不给撤销（它不是破坏性的）；给了就是多许一个承诺').toBeUndefined();
  });

  it('对照：移动那条排了自动消失的计时，而删除那条一次都没排', async () => {
    makeCore();
    const toasts = useToastStore();
    const notes = useNoteStore();
    await notes.load();

    const move = recordingTimers();
    toasts.setTimers(move.timers as never);
    await notes.batchMoveTo([A], 'folder-work', '工作');
    expect(move.calls.map((c) => c.ms), '无动作那一族必须照旧 4500ms 自己走').toEqual([4500]);

    const trash = recordingTimers();
    toasts.setTimers(trash.timers as never);
    await notes.batchMoveToTrash([B]);
    expect(trash.calls, '带撤销的那一条不许自己溜走').toEqual([]);
  });
});
