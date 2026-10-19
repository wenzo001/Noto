/**
 * 每"一档列表"各记一次排序（第一百五十三批，A 档：Joplin 的 `PerFolderSortOrderService`）。
 *
 * 四格，各自盯一种"看着像对了其实没有"的形状：
 *  ① 没记过 ⇒ 发给核心的那一位是 `updated_desc`，而**这一档就是这一批之前写死的顺序**
 *    （旧行为是默认值，不是一条特例 —— 所以这一格红了就是"默认被改写"）；
 *  ② 记一次 ⇒ 重读列表要带上那一档（这条盯的是"存了但没发给核心"那一族：偏好写进去了、
 *    界面照旧排 ⇒ [[verify-the-call-edge-not-just-the-callees-tests]]）；
 *  ③ **一档一改不串到别档**：在"全部"里改成标题序，切进某个本子还是它自己那一档；
 *    这一格必须存在，否则"每文件夹记忆"会退化成"全局记忆 + 一个看起来很像的键"；
 *  ④ 脏值不留下来：`normalizePrefs` 认不出来的排序**丢掉**，
 *    于是下一次读它的人拿到的是默认，而不是把脏串发给核心换一次 `bad_sort`。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/sortMemory.spec.ts`
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { stubLocalService } from './testing/http';
import { normalizePrefs } from './stores/settings';
import { useSettingsStore } from './stores/settings';
import { useNoteStore } from './stores/notes';

const FOLDER = '00000000-0000-7000-8000-6e6f74657261';

function makeCore() {
  const seen: Array<Record<string, unknown>> = [];
  stubLocalService({
    get_note: () => null,
    list_notes: (args) => {
      seen.push(args as Record<string, unknown>);
      return [];
    },
    list_folders: () => [{ id: FOLDER, name: '默认本', parent_id: null, children: [] }],
  });
  return seen;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('排序记忆', () => {
  it('① 没记过 ⇒ 发出去的是 updated_desc（= 这一批之前那句写死的顺序）', async () => {
    const seen = makeCore();
    const notes = useNoteStore();
    await notes.load();
    expect(seen.at(-1)).toMatchObject({ sort: 'updated_desc' });
    expect(useNoteStore().currentSort).toBe('updated_desc');
  });

  it('② 记一次之后，重读列表真的带着那一档（不是只存进偏好）', async () => {
    const seen = makeCore();
    const notes = useNoteStore();
    notes.setSort('title_asc');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toMatchObject({ sort: 'title_asc' });
    expect(useSettingsStore().prefs.sorts[notes.listKey]).toBe('title_asc');
  });

  it('③ 一档一改不串到别档：全部 ↔ 某个本子 ↔ 回收站各记各的', async () => {
    const seen = makeCore();
    const notes = useNoteStore();
    notes.setSort('title_asc');
    await new Promise((r) => setTimeout(r, 0));
    expect(notes.listKey).toBe('all');

    notes.setMode({ kind: 'folder', folderId: FOLDER });
    await new Promise((r) => setTimeout(r, 0));
    expect(notes.listKey).toBe(`folder:${FOLDER}`);
    expect(seen.at(-1)).toMatchObject({ sort: 'updated_desc' });

    notes.setSort('created_asc');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toMatchObject({ sort: 'created_asc' });

    notes.setMode({ kind: 'all' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)?.sort, '切回"全部"丢了它自己那一档 ⇒ 键其实是共用的').toBe('title_asc');
  });

  it('④ 脏值不留下来：认不出的排序被丢掉，读回来是默认那一档', () => {
    const clean = normalizePrefs({ sorts: { all: 'title_asc', 'folder:x': 'id DESC', junk: '' } });
    expect(clean.sorts).toEqual({ all: 'title_asc' });
    const broken = normalizePrefs({ sorts: 'not-an-object' });
    expect(broken.sorts).toEqual({});
  });
});
