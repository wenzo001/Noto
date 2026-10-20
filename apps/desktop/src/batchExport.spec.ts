/**
 * 批量导出（第一百六十批，采纳清单第 94 行最后一个动作）。跑法：
 * `node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop src/batchExport.spec.ts`
 *
 * 断的是**调用边与载荷**：
 *  · 作用域是 `noteIds`（不是 `folderIds`）—— 拿文件夹作用域去"导出选中的几篇"会把整个本都打进去；
 *  · **不给 `path`**：核心自己落到 `exports/` 并把真实路径回传，界面把那句原样说出来；
 *  · 附件跟着这几篇走（`includeAttachments: true`），回收站不带（`includeTrash: false`）；
 *  · 空选区一发都不发。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { noteFixture, stubLocalService } from './testing/http';
import { useNoteStore } from './stores/notes';
import { useToastStore } from './stores/toasts';

const A = 'note-aaaa';
const B = 'note-bbbb';

function makeCore(opts: { fail?: boolean } = {}) {
  const reqs: Array<Record<string, unknown>> = [];
  stubLocalService({
    list_notes: () => [noteFixture({ id: A, rev: 2 }), noteFixture({ id: B, rev: 2 })],
    get_note: (args) => noteFixture({ id: String(args.id), rev: 2 }),
    export_data: (args) => {
      if (opts.fail) throw new Error('boom');
      reqs.push((args.req ?? {}) as Record<string, unknown>);
      return { path: 'C:/data/exports/notera-202610201234.zip', created: 2, counts: { notes: 2 } };
    },
  });
  return { reqs };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useToastStore().setTimers({
    set: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clear: () => {},
    now: () => 0,
  } as never);
});

describe('批量导出', () => {
  it('作用域是 noteIds（不是 folderIds）、不带 path、带附件不带回收站', async () => {
    const core = makeCore();
    const notes = useNoteStore();
    await notes.load();

    const n = await notes.exportSelected([A, B]);
    expect(n).toBe(2);
    expect(core.reqs.length).toBe(1);
    const req = core.reqs[0];
    expect(req.noteIds, '选中的两篇要原样交给核心').toEqual([A, B]);
    expect(req.folderIds, '不许用文件夹作用域冒充"选中的几篇"').toBeUndefined();
    expect(req.path, '不给 path ⇒ 核心落到 exports/ 并回传真实路径').toBeUndefined();
    expect(req.includeAttachments).toBe(true);
    expect(req.includeTrash).toBe(false);
  });

  it('提示语里要带**核心回传的真实路径**（不写路径 = 让用户去文件管理器里猜）', async () => {
    makeCore();
    const notes = useNoteStore();
    await notes.load();

    await notes.exportSelected([A]);
    const made = useToastStore().items[useToastStore().items.length - 1];
    expect(made.text).toContain('notera-202610201234.zip');
  });

  it('空选区 ⇒ 一条命令都不发', async () => {
    const core = makeCore();
    const notes = useNoteStore();
    await notes.load();
    expect(await notes.exportSelected([])).toBe(0);
    expect(core.reqs).toEqual([]);
  });

  it('核心拒绝（比如目标已存在）⇒ 返回 0、errorKey 有值、也不冒一句"已导出"', async () => {
    makeCore({ fail: true });
    const notes = useNoteStore();
    await notes.load();
    const before = useToastStore().items.length;

    expect(await notes.exportSelected([A])).toBe(0);
    expect(notes.errorKey).toBeTruthy();
    expect(useToastStore().items.length).toBe(before);
  });
});
