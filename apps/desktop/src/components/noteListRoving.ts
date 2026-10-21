/**
 * 列表的 roving tabindex（D27 拍 C，2026-10-21）。
 *
 * 为什么要有这一层：以前每一行都是 `tabindex="0"`，123 条的库从侧栏走到编辑器要按 **533 次 Tab**
 * （实测见 `.logs/probe-tabwalk.json`）。改成"整个列表只占 1 个 Tab 位、方向键在行间移动"之后，
 * 列表这一段固定是 1 站，与库里有多少条无关。
 *
 * 这两个函数是**纯的**：DOM 那层只负责 focus 与滚动。这样"按一下方向键到底去哪一行"可以被单测钉死，
 * 不用起浏览器。
 */
export type RovingKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * 这一栏唯一那个 Tab 位落在哪一行（`null` = 空列表，没有 Tab 位）。
 *
 * 口径：选中的那一行；选中不在当前列表里（切了文件夹 / 搜索换了结果）时退回第一行 ——
 * 否则整个列表会**没有任何一个 tabindex=0**，键盘用户再也进不来。
 */
export function tabStopId(ids: readonly string[], selectedId: string | null): string | null {
  if (ids.length === 0) return null;
  return selectedId !== null && ids.includes(selectedId) ? selectedId : ids[0];
}

/**
 * 方向键的落点（在**全量**列表里的下标，不是屏幕上那一段虚拟窗口）。
 *
 * 不绕回：到头就停在原地 —— 原生列表的常见口径，也避免"一直按 ↓ 会跳回第一行"那种意外。
 */
export function rovingTargetIndex(currentIndex: number, key: RovingKey, length: number): number {
  if (length <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= length) {
    return key === 'End' ? length - 1 : 0;
  }
  switch (key) {
    case 'ArrowDown':
      return Math.min(currentIndex + 1, length - 1);
    case 'ArrowUp':
      return Math.max(currentIndex - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
  }
}
