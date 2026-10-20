/**
 * 三栏的宽度（第一百六十一批，P3 桌面可拖宽 + 记忆）。
 *
 * 为什么单独一个小 store、而不是塞进 `UiPrefs`：这两个数是**视图状态**，语义跟"字号/主题"不同 ——
 * 它们不该进 `explicit` 那本"用户改过默认值"的台账（那本账管的是"下次换默认时动不动你的值"），
 * 也不该随 `set_pref` 每拖一下就写一次库。落点是浏览器自己的 `localStorage`：
 * 2026-10-08 那条拍板就是"偏好只做本机持久、不上传"，栏宽更是如此 —— 一台手机的窗口宽度对另一台电脑没有意义。
 *
 * 默认值**不在**这里另抄一份：`DEFAULT` 下面的 260/340 与 `tokens.css` 里的 `--sidebar-w`/`--list-w` 是同一个数，
 * 由 `paneWidths.spec.ts` 直接读 tokens 原文来对账（两边各写一份字面量就是本仓的"词汇漂"那一族）。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export type PaneId = 'sidebar' | 'list';
export interface PaneWidths {
  sidebar: number;
  list: number;
}

export const PANE_DEFAULTS: PaneWidths = { sidebar: 260, list: 340 };
/** 上下界：再窄会把那一栏的表头挤成三行（156 批量的那个 109px），再宽会把编辑区压到读不了字。 */
export const PANE_LIMITS: Record<PaneId, { min: number; max: number }> = {
  sidebar: { min: 200, max: 420 },
  list: { min: 240, max: 560 },
};

const STORAGE_KEY = 'notera.paneWidths.v1';

export function clampPane(which: PaneId, value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : PANE_DEFAULTS[which];
  const { min, max } = PANE_LIMITS[which];
  return Math.min(max, Math.max(min, n));
}

export function readPaneWidths(): PaneWidths {
  if (typeof localStorage === 'undefined') return { ...PANE_DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PaneWidths>;
    return { sidebar: clampPane('sidebar', raw.sidebar), list: clampPane('list', raw.list) };
  } catch {
    // 坏数据当没存过：读不出来就用默认，不抛给启动流程。
    return { ...PANE_DEFAULTS };
  }
}

export const usePaneWidthsStore = defineStore('paneWidths', () => {
  const sidebar = ref(clampPane('sidebar', readPaneWidths().sidebar));
  const list = ref(clampPane('list', readPaneWidths().list));

  /** 挂到 `.app-shell` 上的那两颗 CSS 变量（两栏都以它为宽度来源）。 */
  const style = computed(() => ({
    '--sidebar-w': `${sidebar.value}px`,
    '--list-w': `${list.value}px`,
  }));

  function persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sidebar: sidebar.value, list: list.value }));
    } catch {
      // 存不下就当这一台不记得 —— 布局仍然照本次生效。
    }
  }

  function set(which: PaneId, value: unknown): void {
    const next = clampPane(which, value);
    if (which === 'sidebar') sidebar.value = next;
    else list.value = next;
  }

  function commit(): void {
    persist();
  }

  function reset(): void {
    sidebar.value = PANE_DEFAULTS.sidebar;
    list.value = PANE_DEFAULTS.list;
    persist();
  }

  return { sidebar, list, style, set, commit, reset };
});
