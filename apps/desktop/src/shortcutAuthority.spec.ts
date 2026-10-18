/**
 * D21 = 方案 A 的**最后一格**（2026-10-18）：既然「应用内那张键位表是唯一权威」，
 * 那么**处理程序认的字面必须都在表里写着** —— 否则表外还有一套说了算的键位，
 * 就是 §7 陷阱一那个形状的复发（两张表各说各话），而这条以前**没有任何执行者**：
 * G131 那两条跨表判据钉的是「原生菜单 ⇄ `SHORTCUTS`」，`App.vue` 的真处理程序是第三方，没人对过。
 *
 * 现场（本批写这条时抓到的）：`App.vue:135` 认 `Ctrl+F`（不带 Shift）走 `focusSearch()`，
 * 而 `SHORTCUTS` 里搜索那一行只有 `Ctrl+K`，`F` 只出现在 `Ctrl+Shift+F`（插入附件）。
 * ⇒ 屏幕上、表里、菜单上都只说 K，而真按 F 有反应 —— 用户学到的是第三套。
 *
 * 只收 **mod（Ctrl/⌘）且不按 Alt** 那一族的单字符字面：`Escape` / `Alt+←` 这类导航键不是产品意义上的
 * "快捷键行"，把它们算进来就是把判据写成恒红（§45「不会红的断言比没有断言更糟」的反面）。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/shortcutAuthority.spec.ts`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from './platform/caps';

/** `App.vue` 里 mod 那一族真认的单字符字面 ⇒ 归一成 `Ctrl+X` / `Ctrl+Shift+X`。 */
function handlerChords(): string[] {
  const src = readFileSync(join(__dirname, 'App.vue'), 'utf8');
  // 只看 `if (mod && !event.altKey)` 那一个块（到它自己的收尾大括号为止），
  // 不把 F5 / Delete / Escape 那些裸功能键与导航键算进来。
  const start = src.indexOf('if (mod && !event.altKey)');
  expect(start, 'App.vue 里找不到 mod 那一块 ⇒ 本判据在空转').toBeGreaterThan(-1);
  const block = src.slice(start, start + 1400);
  const chords: string[] = [];
  // `(.)` 那种写法会把源码里的 `'\\'`（转义的两个字符）整个漏掉 —— 漏了不报错，
  // 只是那一行从此没有证人，反向臂就会红在"表里写着处理程序却不认"这种假话上（第一百十批那一族假阳性）。
  for (const m of block.matchAll(/key === '([^']*)'((?: && (?:!)?event\.shiftKey))?/g)) {
    const [, raw, shift] = m;
    let ch = raw === '\\\\' ? '\\' : raw.length === 1 ? raw : null;
    if (ch === null) continue; // `backspace` / `arrowleft` 这类名字键不是这一族的单字符字面
    ch = ch.toUpperCase();
    chords.push(shift === ' && event.shiftKey' ? `Ctrl+Shift+${ch}` : `Ctrl+${ch}`);
  }
  return [...new Set(chords)];
}

/** 表里写着的那些字面（Windows 档；⌘ 那一列由同一行的 `macKeys` 承担，不在这条判据的射程）。 */
function declaredChords(): Set<string> {
  const set = new Set<string>();
  for (const entry of SHORTCUTS) {
    if (entry.keys.length === 1 && entry.keys[0].length > 1) continue; // `F5` / `Del` 这种裸键
    set.add(entry.keys.join('+'));
  }
  return set;
}

describe('键位表是唯一权威（D21 方案 A）', () => {
  it('处理程序认的 mod 组合键，每一个都必须在表里写着', () => {
    const honored = handlerChords();
    const declared = declaredChords();
    const undeclared = honored.filter((chord) => !declared.has(chord));
    expect(undeclared, `表外权威：${undeclared.join(' / ')} 有实现却没在 SHORTCUTS 里`).toEqual([]);
  });

  it('对照臂：这一族确实收到了东西（解析空转就是仪器坏了，不是没问题）', () => {
    const honored = handlerChords();
    expect(honored.length).toBeGreaterThanOrEqual(5);
    expect(honored).toContain('Ctrl+N');
    expect(honored).toContain('Ctrl+K');
  });

  it('反向臂：表里那些有实现的行，处理程序真的认（少一行就是界面上摆一个按了没反应的键）', () => {
    const honored = handlerChords();
    for (const id of ['new-note', 'search', 'collapse', 'pin', 'settings']) {
      const row = SHORTCUTS.find((entry) => entry.id === id);
      expect(row, `表里少了 ${id} 这一行`).toBeTruthy();
      expect(honored, `${id} 那行的组合键在表里写着，处理程序却不认`).toContain(row!.keys.join('+'));
    }
  });
});
