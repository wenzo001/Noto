/**
 * 删除之后的那颗「撤销」（第一百五十二批，A 档采纳项：Joplin 的 `TrashNotification`）。
 *
 * 三格，每格都带反向对照 —— 这一族的坏形状不是"没做"，是**做了一半看着挺像**：
 *  ① 带动作的那一条**不排**自动消失的定时器，而无动作那一族照旧排 4500ms。
 *    两个方向必须一起读：只测"不排"，把整族都改成不排也照样绿（撤销条留下了，别的提示再也不走）；
 *    只测"排"，那就是 §4.9 那一条自己的判据，看不见这一批新加的那一支。
 *  ② 两条出口互不串：点「撤销」⇒ 动作被调**一次**且这条消失；点「知道了」⇒ 这条消失而动作**一次都不被调**。
 *    （反过来的话，"我只是说这句我读过了"会顺手把一篇已经决定删掉的笔记恢复回来。）
 *  ③ 调用边：`moveToTrash` 推出去的那条，动作真打的是 `restore_note`、且 id 就是刚删的那一篇，
 *    库里那一行真的从"在回收站"回到"在活动"。绿单测遮不住坏调用边（[[verify-the-call-edge-not-just-the-callees-tests]]），
 *    所以这里断言的是**这次调用发没发、落库收成了什么**，不是"store 里有个 restore 函数"。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/toastUndo.spec.ts`
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ToastHost from './components/ToastHost.vue';
import { noteFixture, stubLocalService } from './testing/http';
import { useNoteStore } from './stores/notes';
import { useToastStore } from './stores/toasts';

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

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('① 计时：带动作的那一条不自己溜走', () => {
  it('无动作那一族照旧排 4500ms（这一支没被这一批改坏）', () => {
    const toasts = useToastStore();
    const { calls, timers } = recordingTimers();
    toasts.setTimers(timers as never);

    toasts.pushText('没有写进去。笔记还在原处，没有丢。');
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(4500);
  });

  it('带动作的那一条**一次都不排**（撤销的出口不许自己消失）', () => {
    const toasts = useToastStore();
    const { calls, timers } = recordingTimers();
    toasts.setTimers(timers as never);

    const made = toasts.pushText('已移到「最近删除」，30 天内可以恢复。', 'info', { label: '撤销', run: () => {} });
    expect(calls).toHaveLength(0);
    expect(toasts.items.map((item) => item.id)).toContain(made.id);
  });
});

describe('② 两条出口互不串', () => {
  it('点「撤销」：动作被调一次，且这条消失', async () => {
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    const run = vi.fn();
    const made = toasts.pushText('已移到「最近删除」，30 天内可以恢复。', 'info', { label: '撤销', run });

    const wrapper = mount(ToastHost);
    const action = wrapper.get('[data-testid="toast-action"]');
    expect(action.text()).toBe('撤销');
    await action.trigger('click');

    expect(run).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="toast-action"]').exists()).toBe(false);
    expect(toasts.items.map((item) => item.id)).not.toContain(made.id);
  });

  it('点「知道了」：这条消失，而动作**一次都不被调**（读过了不等于要反悔）', async () => {
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    const run = vi.fn();
    toasts.pushText('已移到「最近删除」，30 天内可以恢复。', 'info', { label: '撤销', run });

    const wrapper = mount(ToastHost);
    await wrapper.get('[data-testid="toast-ack"]').trigger('click');

    expect(run).toHaveBeenCalledTimes(0);
    expect(wrapper.find('[data-testid="toast-ack"]').exists()).toBe(false);
  });

  it('对照：没有动作的那一条不许多渲染一颗（`v-if` 不是摆设）', () => {
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    toasts.pushText('已存在本机');

    const wrapper = mount(ToastHost);
    expect(wrapper.find('[data-testid="toast-action"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="toast-ack"]')).toHaveLength(1);
  });

  it('`invoke` 对没有动作的那一条什么都不做（不许拿它当通用"点一下"）', () => {
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    const made = toasts.pushText('已存在本机');

    toasts.invoke(made.id);
    expect(toasts.items.map((item) => item.id)).toContain(made.id);
  });
});

describe('③ 调用边：删除那一刻推的那条，撤销真打得是同一篇', () => {
  const A = 'note-aaaa';
  const B = 'note-bbbb';

  function makeCore() {
    const trashed = new Set<string>();
    const seq: string[] = [];
    const ids = [A, B];
    const note = (id: string) =>
      noteFixture({
        id,
        rev: 3,
        doc: { v: 1, content: [{ id: 'abcd1234', type: 'paragraph', content: [{ text: `${id} 的正文` }] }] },
        deletedAt: trashed.has(id) ? '2026-10-19T00:00:00Z' : null,
      });
    stubLocalService({
      get_note: (args) => note(String(args.id)),
      list_notes: () => ids.map(note).filter((n) => !trashed.has(String(n.id))),
      delete_note: (args) => {
        seq.push(`delete:${String(args.id)}`);
        trashed.add(String(args.id));
        return null;
      },
      restore_note: (args) => {
        seq.push(`restore:${String(args.id)}`);
        trashed.delete(String(args.id));
        return null;
      },
    });
    return { seq, trashed };
  }

  it('撤销那颗真把这一篇放回活动列表：两条命令各发一次、id 是同一篇', async () => {
    const { seq, trashed } = makeCore();
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    const notes = useNoteStore();

    await notes.moveToTrash(A);
    expect(trashed.has(A)).toBe(true);
    const made = toasts.items[toasts.items.length - 1];
    expect(made?.action?.label, '删除那条没带动作 ⇒ 这一格在空转').toBe('撤销');

    toasts.invoke(made.id);
    await vi.waitFor(() => expect(seq).toContain(`restore:${A}`));

    expect(trashed.has(A)).toBe(false);
    expect(seq.filter((row) => row === `restore:${A}`)).toHaveLength(1);
    // 产品这边是 fire-and-forget（撤销那颗不该因为等列表而卡住），所以"列表回到活动"这一格
    // 要等自己落定 —— 等不到就是红（判的是结果，不是"有没有发命令"那一步）。
    await vi.waitFor(() => expect(notes.rows.map((row) => row.id)).toContain(A));
  });

  it('对照：撤销打的必须是**刚删的那一篇**，不是"当前选中的那一篇"', async () => {
    const { seq, trashed } = makeCore();
    const toasts = useToastStore();
    const { timers } = recordingTimers();
    toasts.setTimers(timers as never);
    const notes = useNoteStore();

    await notes.load();
    // 先把选中项挪到 B：如果那颗按钮拿的是"当前选中"，它恢复的就是 B —— 而 B 根本没被删。
    notes.selectedId = B;
    await notes.moveToTrash(A);
    const made = toasts.items[toasts.items.length - 1];
    expect(made?.action?.label, '删除那条没带动作 ⇒ 这一格在空转').toBe('撤销');

    toasts.invoke(made.id);
    await vi.waitFor(() => expect(seq).toContain(`restore:${A}`));

    expect(seq.filter((row) => row.startsWith('restore:'))).toEqual([`restore:${A}`]);
    expect(trashed.has(B), 'B 被牵连了：那颗拿的是"当前选中"而不是刚删的那一篇').toBe(false);
    await vi.waitFor(() => expect(notes.rows.map((row) => row.id)).toContain(A));
  });
});
