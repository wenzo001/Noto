/**
 * 多选状态（第一百五十七批，A 档 P5：Joplin 的 `MultiNoteActions` + `useOnKeyDown` 的 Shift/Ctrl+A）。
 *
 * 为什么单独一个 store 而不是塞进 `notes.selectedId`：那两位说的是两件不同的事 ——
 * "现在打开的是哪一篇"（驱动编辑器、驱动 `get_note`）与"这次批量动作要打在哪些篇上"。
 * 混用会出两种坏法：选中集跟着打开的那一篇走 ⇒ 点一下编辑器就把批量范围改成一篇；
 * 反过来打开状态被多选污染 ⇒ 用户只是勾了几篇，正文区却换了一篇。
 * 这条边界由 `selection.spec.ts` 里"设多选不许动 `selectedId`"那条钉着。
 *
 * 名单存的是 **id 的有序数组**而不是 Set：Vue 的响应式对 Set 要额外小心，
 * 而这里要的只有"包含判断 + 顺序无关的遍历 + 一个数得出的条数"。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export const useSelectionStore = defineStore('selection', () => {
  /** 多选模式：表头那颗「选择」开的。开着的时候点行 = 切换勾选，不再是"打开这一篇"。 */
  const active = ref(false);
  const ids = ref<string[]>([]);
  /** Shift 扩选的锚点（上一次点的这一篇）。**顺序权威是核心给的那份 `rows`**，不是屏幕上那一段 DOM。 */
  const anchor = ref<string | null>(null);

  const count = computed(() => ids.value.length);
  const empty = computed(() => ids.value.length === 0);

  function has(id: string): boolean {
    return ids.value.includes(id);
  }

  function enter(): void {
    active.value = true;
  }

  /** 退出一定要把选区收掉：留着勾着的 N 篇去按别的键，比看不见更糟（同"关掉只读能力要收选区"那一族）。 */
  function exit(): void {
    active.value = false;
    ids.value = [];
    anchor.value = null;
  }

  function toggle(id: string): void {
    ids.value = has(id) ? ids.value.filter((x) => x !== id) : [...ids.value, id];
    anchor.value = id;
  }

  /**
   * Shift 扩选：取 `order`（核心那份 id 顺序）里锚点与目标之间的一段，**并进**已有选区。
   * 锚点不在 `order` 里（换了列表档、或那一篇已被删）⇒ 只选目标这一篇，不猜区间。
   */
  function extend(id: string, order: string[]): void {
    const from = anchor.value === null ? -1 : order.indexOf(anchor.value);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) {
      toggle(id);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const slice = order.slice(lo, hi + 1);
    ids.value = Array.from(new Set([...ids.value, ...slice]));
    anchor.value = id;
  }

  /** 全选的是**这一档列表已经读到的那几篇**（`rows`），不是屏幕上可见的那一段：虚拟列表的 DOM 窗口只是子集。 */
  function selectAll(order: string[]): void {
    ids.value = [...order];
    anchor.value = order.length > 0 ? order[order.length - 1] ?? null : null;
  }

  function clear(): void {
    ids.value = [];
    anchor.value = null;
  }

  /** 批量动作落地之后把已经处理掉的那些摘出去（不清空 ⇒ 用户能接着做第二件事）。 */
  function removeMany(remove: string[]): void {
    const gone = new Set(remove);
    ids.value = ids.value.filter((x) => !gone.has(x));
    if (anchor.value !== null && gone.has(anchor.value)) anchor.value = null;
  }

  return { active, ids, anchor, count, empty, has, enter, exit, toggle, extend, selectAll, clear, removeMany };
});
