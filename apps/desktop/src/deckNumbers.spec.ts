/**
 * G136：设计稿（PPTX 文字存档）点名的四个数，从前**只有声明、没有证人** ——
 * 改错了没有任何一条腿会红（本台账一直在扫的"含糊证人"那一族）。这一份把四句各自钉死：
 *
 *   ①「4.5s 自动消失」→ `stores/toasts.ts` 交给定时器的那个数**必须就是 4500**（不是从常量算出来的期望值）
 *   ②「带『知道了』」→ 每条 toast 渲染出来的那颗按钮，文字必须是「知道了」，按下去这条才消失
 *   ③「最宽 520px」→ `base.css` 里 `.toast-host` 那一条声明里必须写着 `min(520px`
 *   ④「禁用 45%」→ `base.css` 里带 `disabled` 的那一条声明里必须写着 `opacity: 0.45`
 *
 * ③④ 是静态判据（认的是**能生效的那一句声明**，不是"文件里出现过这个数"）：
 * 渲染后的几何交给布局门禁，这一层只保证"改了 CSS 的那一句、这条就红"。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/deckNumbers.spec.ts`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import ToastHost from './components/ToastHost.vue';
import { useToastStore } from './stores/toasts';

/** 记下 `set` 收到的延迟与回调，不真的等时间流逝 —— ① 要验的就是"传出去的那个数"。 */
function recordingTimers() {
  const calls: Array<{ ms: number; fn: () => void }> = [];
  return {
    calls,
    timers: {
      set: (fn: () => void, ms: number) => {
        calls.push({ ms, fn });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => {},
      now: () => 0,
    },
  };
}

describe('设计稿点名的四个数（G136）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('①「4.5s 自动消失」：排的那一支就是 4500 ms，且它真的把这条撤掉', () => {
    const toasts = useToastStore();
    const { calls, timers } = recordingTimers();
    toasts.setTimers(timers as never);

    const made = toasts.pushText('已移到「最近删除」，随时可以恢复。');
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(4500);

    expect(toasts.items.map((item) => item.id)).toContain(made.id);
    calls[0].fn();
    expect(toasts.items.map((item) => item.id)).not.toContain(made.id);
  });

  it('②「带『知道了』」：那颗按钮写的是这句话，按下这条才走', async () => {
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    toasts.pushText('没有写进去。笔记还在原处，没有丢。');

    const wrapper = mount(ToastHost);
    const ack = wrapper.get('[data-testid="toast-ack"]');
    expect(ack.text()).toBe('知道了');

    await ack.trigger('click');
    expect(wrapper.find('[data-testid="toast-ack"]').exists()).toBe(false);
  });

  it('③「最宽 520px」：`.toast-host` 那一条声明里就写着 min(520px', () => {
    const host = cssRule('.toast-host');
    expect(host).not.toBeNull();
    expect(host).toContain('min(520px');
  });

  it('④「禁用 45%」：按钮那颗的 `.btn:disabled` 就写着 opacity: 0.45', () => {
    // 指名到**那一条例**：deck 那句的主语是"按钮 · 禁用"，而 base.css 里带 `disabled` 的规则不止一条
    // （`.field:disabled` 只换底色）。取第一条命中会绿着量到错的条例 —— 所以按整条选择器点名。
    const btnDisabled = cssRule('.btn:disabled');
    expect(btnDisabled).not.toBeNull();
    expect(btnDisabled).toContain('opacity: 0.45');
  });

  it('④对照：带 `disabled` 的规则不止一条 ⇒ "取第一条"这条判据本身不成立', () => {
    const css = readFileSync(join(__dirname, 'styles', 'base.css'), 'utf8');
    const names = (css.match(/[^{}]*\{[^{}]*\}/g) ?? [])
      .map((block) => block.slice(0, block.indexOf('{')).trim())
      .filter((name) => /disabled/.test(name));
    expect(names.length).toBeGreaterThan(1);
    expect(names.some((name) => name === '.btn:disabled')).toBe(true);
  });
});

/**
 * 从 `base.css` 里取某个选择器那一条声明的正文。
 * 判据必须认"能生效的那一句声明"，所以是先按选择器找到那条，再看它自己那一段里有没有那个值。
 */
function cssRule(selector: string | RegExp): string | null {
  const css = readFileSync(join(__dirname, 'styles', 'base.css'), 'utf8');
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
  const want = typeof selector === 'string' ? (name: string) => name.includes(selector) : (name: string) => selector.test(name);
  const hit = blocks.find((block) => want(block.slice(0, block.indexOf('{'))));
  if (!hit) return null;
  return hit.slice(hit.indexOf('{') + 1, hit.lastIndexOf('}'));
}
