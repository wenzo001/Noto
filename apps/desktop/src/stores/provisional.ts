/**
 * 「草稿态新建」（第一百六十二批，map 第 80 行 / A 档最后一条）。
 *
 * **这不是我发明的口径，是照抄 Joplin 的那三处实现**（`.vendor/joplin` 里逐行读出来的）：
 *  · `gui/WindowCommandsAndDialogs/commands/newNote.ts:27-46` —— 新建时 `Note.save({…}, {provisional: true})`：
 *    笔记**当场落库**（不是"先不建"），只是打上 provisional 标记，然后立刻选中它；
 *  · `lib/components/shared/reduxSharedMiddleware.ts:76-83` —— 收到 `NOTE_SELECT` / `NAV_BACK` 时，
 *    把除**目标那一条**以外的所有 provisional 笔记 `Note.delete`（软删，进回收站）；
 *  · `lib/models/Note.ts:915-917` —— "只有用户**真的改过**它，才会被永久保存" ⇒ 改过就摘掉标记。
 * 列表里的淡化（`gui/NoteList/style.scss:51`）照第 4 条落成一行 `opacity`。
 *
 * 为什么标记活在内存里、不落库：Joplin 也把它放在 reducer 的 `provisionalNoteIds`（进程内存）里。
 * 重启之后一条都没被改过的空笔记就留在那儿——这与 Joplin 一致；要更狠（重启也清）是另一件事，不在这一批。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useProvisionalStore = defineStore('provisional', () => {
  /** 这一台进程里"新建且还没被改过"的那些 id（按创建顺序，量小，数组够用）。 */
  const ids = ref<string[]>([]);

  function is(id: string | null | undefined): boolean {
    return typeof id === 'string' && ids.value.includes(id);
  }

  function mark(id: string): void {
    if (!ids.value.includes(id)) ids.value = [...ids.value, id];
  }

  /** 用户改过它（编辑器保存成功 / 元数据写成功）⇒ 转正，走了也不再丢。 */
  function confirm(id: string | null | undefined): void {
    if (typeof id !== 'string') return;
    if (!ids.value.includes(id)) return;
    ids.value = ids.value.filter((x) => x !== id);
  }

  /** 切走时要收掉的那些（Joplin 那条规则：**除目标以外**全部）。 */
  function pendingExcept(target: string | null | undefined): string[] {
    return ids.value.filter((x) => x !== target);
  }

  function forget(id: string): void {
    ids.value = ids.value.filter((x) => x !== id);
  }

  return { ids, is, mark, confirm, pendingExcept, forget };
});
