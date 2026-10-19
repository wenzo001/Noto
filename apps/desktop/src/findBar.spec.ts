/**
 * 查找条那一格（`FindBar.vue`）。
 *
 * 这里能验的是**契约**：三颗动作发得出对应的事件、输入框把值原样交出去、计数那两句说得对。
 * **验不到的是几何**（44 的命中区、跳过去那一行真的进了视野）—— 那一格在整跑的一条腿里，
 * 不在 jsdom 里（jsdom 不排版，量到的 0×0 不算数）。两条各说各的，别拿这条当那条已过。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FindBar from './components/FindBar.vue';

/** 本仓的 i18n 是自家 `i18n.ts` 的 `t()`（**没有 vue-i18n 这个依赖**），
 *  所以这里不装插件、不需要 createI18n —— 组件直接用模块级 `t`。 */
function make(total = 3, current = 0, query = '乙') {
  return mount(FindBar, { props: { total, current, query } });
}

describe('查找条的契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 计数说有几处就说第几处：1 基给屏幕，0 基留在props', () => {
    expect(make(3, 0).find('[data-testid="find-count"]').text()).toBe('第 1 / 3 处');
    expect(make(3, 2).find('[data-testid="find-count"]').text()).toBe('第 3 / 3 处');
  });

  it('② 零处时说"没有匹配"，不许写出"第 0 / 0 处"那种看着像有匹配的数', () => {
    const w = make(0, -1, '查不到的串');
    expect(w.find('[data-testid="find-count"]').text()).toBe('没有匹配');
    // 反向那一格：没有匹配时上下两颗必须禁掉（按了不发出的按钮是死控件）
    expect(w.find('[data-testid="find-prev"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-testid="find-next"]').attributes('disabled')).toBeDefined();
    // 但关闭那一颗永远点得着 —— 关掉不是"命中之后的动作"
    expect(w.find('[data-testid="find-close"]').attributes('disabled')).toBeUndefined();
  });

  it('③ 三颗动作各自发对应的事件', async () => {
    const w = make();
    await w.find('[data-testid="find-next"]').trigger('click');
    await w.find('[data-testid="find-prev"]').trigger('click');
    await w.find('[data-testid="find-close"]').trigger('click');
    expect(w.emitted('next')).toHaveLength(1);
    expect(w.emitted('prev')).toHaveLength(1);
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('④ 回车=下一处、Shift+回车=上一处、Esc=关闭（键盘路径与点按钮等价）', async () => {
    const w = make();
    const input = w.find('[data-testid="find-input"]');
    await input.trigger('keydown', { key: 'Enter' });
    await input.trigger('keydown', { key: 'Enter', shiftKey: true });
    await input.trigger('keydown', { key: 'Escape' });
    expect(w.emitted('next')).toHaveLength(1);
    expect(w.emitted('prev')).toHaveLength(1);
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('⑤ 输入把值原样交出去（不改大小写、不去空格 —— 修剪是匹配那一层的事，这里说了不算）', async () => {
    const w = make(0, -1, '');
    await w.find('[data-testid="find-input"]').setValue('  混合 Case  ');
    const emitted = w.emitted('update:query');
    expect(emitted?.at(-1)?.[0]).toBe('  混合 Case  ');
  });

  it('⑥ 每一颗都有名字（aria-label），且这一族挂在 role="search" 里', () => {
    const w = make();
    for (const id of ['find-prev', 'find-next', 'find-close', 'find-input']) {
      const el = w.find(`[data-testid="${id}"]`);
      expect(el.attributes('aria-label'), `${id} 没有可读名字`).toBeTruthy();
    }
    expect(w.find('[role="search"]').exists()).toBe(true);
  });
});
