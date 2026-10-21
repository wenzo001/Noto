// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rovingTargetIndex, tabStopId } from './noteListRoving';

/**
 * D27 拍 C（2026-10-21）：列表改成 roving tabindex + 方向键。
 *
 * 分两层判：
 *  · **行为**：纯函数把"哪个方向键落到哪一行 / 哪一行占 Tab 位"钉死（边界、空列表、选中不在列表里）；
 *  · **调用边**：`NoteList.vue` 真的用了这两个函数、真的把 `tabindex` 绑成 0/-1、真的挂了四个方向键 ——
 *    只测纯函数会放过"函数写对了但界面没接上"（[[verify-the-call-edge-not-just-the-callees-tests]]）。
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const NOTE_LIST = readFileSync(join(SRC, 'NoteList.vue'), 'utf8');

describe('noteListRoving：方向键落点', () => {
  it('↓/↑ 一步一步走，到头停在原地（不绕回）', () => {
    expect(rovingTargetIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(rovingTargetIndex(1, 'ArrowDown', 3)).toBe(2);
    expect(rovingTargetIndex(2, 'ArrowDown', 3)).toBe(2);
    expect(rovingTargetIndex(2, 'ArrowUp', 3)).toBe(1);
    expect(rovingTargetIndex(1, 'ArrowUp', 3)).toBe(0);
    expect(rovingTargetIndex(0, 'ArrowUp', 3)).toBe(0);
  });

  it('Home/End 直接到两端', () => {
    expect(rovingTargetIndex(5, 'Home', 10)).toBe(0);
    expect(rovingTargetIndex(5, 'End', 10)).toBe(9);
  });

  it('空列表没有落点；下标越界时从第一行重新开始（End 落在最后一行）', () => {
    expect(rovingTargetIndex(0, 'ArrowDown', 0)).toBe(-1);
    expect(rovingTargetIndex(-1, 'ArrowDown', 4)).toBe(0);
    expect(rovingTargetIndex(99, 'ArrowUp', 4)).toBe(0);
    expect(rovingTargetIndex(99, 'End', 4)).toBe(3);
  });
});

describe('noteListRoving：Tab 位', () => {
  const ids = ['a', 'b', 'c'];
  it('选中的那一行；选中不在列表里退回第一行；空列表没有 Tab 位', () => {
    expect(tabStopId(ids, 'b')).toBe('b');
    expect(tabStopId(ids, 'zzz')).toBe('a');
    expect(tabStopId(ids, null)).toBe('a');
    expect(tabStopId([], 'a')).toBeNull();
  });
});

describe('noteListRoving：界面真的接上了（调用边）', () => {
  it('仪器自检：读到的是一份像样的 NoteList.vue（否则下面的"接到了"可能只是没读到）', () => {
    expect(NOTE_LIST.length).toBeGreaterThan(2000);
    expect(NOTE_LIST.includes('function moveRowFocus')).toBe(true);
  });

  it('每个行只在自己是 tabStop 时占 0，其余是 -1', () => {
    expect(NOTE_LIST.includes(':tabindex="entry.id === rovingId ? 0 : -1"')).toBe(true);
    expect(NOTE_LIST.includes('const rovingId = computed(() => tabStopId(orderIds.value, notes.selectedId))')).toBe(true);
    // 旧的"每一行都是 0"不许回来
    expect(NOTE_LIST.includes('tabindex="0"')).toBe(false);
  });

  it('四个方向键都挂上了，并且都走 moveRowFocus', () => {
    for (const [mod, key] of [
      ['down', 'ArrowDown'],
      ['up', 'ArrowUp'],
      ['home', 'Home'],
      ['end', 'End'],
    ] as const) {
      expect(NOTE_LIST.includes(`@keydown.${mod}.prevent="moveRowFocus(entry, '${key}')"`), `${mod} 没挂上`).toBe(true);
    }
    expect(NOTE_LIST.includes('rovingTargetIndex(index, key, entries.value.length)')).toBe(true);
  });
});
