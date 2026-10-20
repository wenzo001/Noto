/**
 * 三栏可拖宽（第一百六十一批，P3）。跑法：
 * `node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop src/paneWidths.spec.ts`
 *
 * 钉四件事：
 *  ① **默认值与 tokens 是同一个数**（用 `import.meta.glob` 读 css 原文，与 `layoutBreakpoints.spec.ts`
 *     同一把尺；不在这里抄第二份 260/340 —— 两边各写一份字面量就是本仓"词汇漂"那一族）；
 *  ② 夹在上下界里（两侧各一条：小于 min 夹到 min、大于 max 夹到 max）；
 *  ③ 坏数据/读不到 ⇒ 默认值，不抛给启动流程；
 *  ④ **本机持久**：改完落 localStorage，换一个 pinia 重建 store 还能读回同一个宽度
 *     （2026-10-08 那条拍板：偏好只做本机持久、不上传）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PANE_DEFAULTS, PANE_LIMITS, clampPane, readPaneWidths, usePaneWidthsStore } from './stores/paneWidths';

const CSS = import.meta.glob<string>('./styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const TOKENS = Object.values(CSS).join('\n');

function tokenPx(name: string): number {
  const m = new RegExp(`${name}\\s*:\\s*(\\d+)px`).exec(TOKENS);
  return Number(m?.[1]);
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe('栏宽的默认值与 tokens 是同一个数', () => {
  it('--sidebar-w / --list-w 就是 PANE_DEFAULTS 那两颗（读不到就是正则坏了）', () => {
    expect(tokenPx('--sidebar-w'), '读不到 --sidebar-w ⇒ 正则坏了，下面那条就是空判据').toBeGreaterThan(0);
    expect(tokenPx('--sidebar-w')).toBe(PANE_DEFAULTS.sidebar);
    expect(tokenPx('--list-w')).toBe(PANE_DEFAULTS.list);
  });
});

describe('夹在上下界里', () => {
  it('小于 min ⇒ 夹到 min；大于 max ⇒ 夹到 max；两栏各测两侧', () => {
    expect(clampPane('sidebar', 10)).toBe(PANE_LIMITS.sidebar.min);
    expect(clampPane('sidebar', 9999)).toBe(PANE_LIMITS.sidebar.max);
    expect(clampPane('list', 10)).toBe(PANE_LIMITS.list.min);
    expect(clampPane('list', 9999)).toBe(PANE_LIMITS.list.max);
  });

  it('非数 / NaN / 小数：回落默认或取整（不许把 NaN 送进 CSS 变量）', () => {
    expect(clampPane('sidebar', Number.NaN)).toBe(PANE_DEFAULTS.sidebar);
    expect(clampPane('list', '420' as unknown as number)).toBe(PANE_DEFAULTS.list);
    expect(clampPane('list', 300.6)).toBe(301);
  });

  it('坏掉的 localStorage ⇒ 默认值，不抛', () => {
    localStorage.setItem('notera.paneWidths.v1', '{这不是 JSON');
    expect(readPaneWidths()).toEqual(PANE_DEFAULTS);
    localStorage.setItem('notera.paneWidths.v1', JSON.stringify({ sidebar: 'wide', list: null }));
    expect(readPaneWidths()).toEqual(PANE_DEFAULTS);
  });
});

describe('本机持久', () => {
  it('改完落盘：换一个 pinia 重建 store，读回同一个宽度', () => {
    const a = usePaneWidthsStore();
    a.set('sidebar', 330);
    a.set('list', 410);
    a.commit();
    expect(a.style['--sidebar-w']).toBe('330px');
    expect(a.style['--list-w']).toBe('410px');

    setActivePinia(createPinia());
    const b = usePaneWidthsStore();
    expect(b.sidebar).toBe(330);
    expect(b.list).toBe(410);
  });

  it('拖动越界不会把宽度写穿：落盘的也是夹过的那个数', () => {
    const s = usePaneWidthsStore();
    s.set('sidebar', 9999);
    s.commit();
    const raw = JSON.parse(localStorage.getItem('notera.paneWidths.v1') ?? '{}');
    expect(raw.sidebar).toBe(PANE_LIMITS.sidebar.max);
  });

  it('双击复位：回到 tokens 那两颗，并落盘', () => {
    const s = usePaneWidthsStore();
    s.set('sidebar', 400);
    s.commit();
    s.reset();
    expect(s.sidebar).toBe(PANE_DEFAULTS.sidebar);
    expect(s.list).toBe(PANE_DEFAULTS.list);
    expect(JSON.parse(localStorage.getItem('notera.paneWidths.v1') ?? '{}')).toEqual(PANE_DEFAULTS);
  });
});
