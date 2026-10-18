/**
 * 标签那一排 chip 的**挂载读法**（ADR-0022 界面那一半）。
 *
 * 钉的是 390 那一档真发生过的形状：窄屏的编辑器是 `v-if` 挂上去的 —— 点进行那一瞬间
 * `selectedId` 已经落定，组件挂载之后 `noteId` **没有再变化过**，所以只挂 `watch(noteId)` 的读法
 * 一次都不出门：库里明明挂着两颗标签，屏幕上只剩「+ 加标签」（1440 有、390 空，实测对撞出来的）。
 * 宽屏那一档只是碰巧赢在时序上（boot 时 store 比本组件晚赋值 ⇒ 真的发生了一次"变化"）。
 *
 * 三件事各自一条判据，缺一不可：
 *  ① **调用边**：挂载当刻就发了一次 `note_tags`，且带的是这一篇的 id（不是"被调方自己绿"）；
 *  ② **结果**：回包里的两颗都画出来了，标题来自 `list_tags` 那一份；
 *  ③ **对照**：回包为空时一颗都不画 —— 少了这一条，②的"两颗"可以是被别的东西凑出来的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { VueWrapper } from '@vue/test-utils';
import TagChips from './components/TagChips.vue';
import { useNoteStore } from './stores/notes';
import { stubLocalService } from './testing/http';

const NOTE = 'n-挂载前就选中的那一篇';

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('EventSource', undefined);
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** 挂载之前就把 `selectedId` 定下来：这一发没有"变化"可看，正是窄屏那一档的时序。 */
function mountWithSelected(ids: string[]) {
  const service = stubLocalService({
    list_tags: () => [
      { id: 'a', title: '甲', noteCount: 2 },
      { id: 'b', title: '乙', noteCount: 1 },
    ],
    note_tags: () => ids,
  });
  const notes = useNoteStore();
  notes.selectedId = NOTE;
  const wrapper: VueWrapper = mount(TagChips);
  return { service, wrapper };
}

describe('TagChips 挂载当刻就要读回这一篇的链接', () => {
  it('① 调用边：noteId 没变过也发得出那一发，且带的是这一篇的 id', async () => {
    const { service } = mountWithSelected(['a', 'b']);
    await settle();
    const calls = service.callsOf('note_tags');
    expect(calls.length, '挂载时一次都没出门 ⇒ 这一排 chip 永远空着').toBeGreaterThanOrEqual(1);
    expect(calls[0].args.id).toBe(NOTE);
  });

  it('② 结果：回包里的两颗都画出来，名字取自 list_tags 那一份', async () => {
    const { wrapper } = mountWithSelected(['a', 'b']);
    await settle();
    const chips = wrapper.findAll('.tag-chip:not(.tag-chip--add)');
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.text().trim())).toEqual(['甲', '乙']);
  });

  it('③ 对照：回包为空时一颗都不画（否则上面那条"两颗"没有证人）', async () => {
    const { wrapper } = mountWithSelected([]);
    await settle();
    expect(wrapper.findAll('.tag-chip:not(.tag-chip--add)')).toHaveLength(0);
    // 「+ 加标签」那颗还在：空的是这一篇的链接，不是整排控件被摘掉。
    // 这里刻意**不引那颗的 testid 字面串**：§6 那条门自己就在扫"属性等于带引号的字符串"这一形状，
    // 而它有一条对照断言"抽取器不许看得见 AppPopover 的 testid prop"—— 测试文件里引一次，
    // 那条对照就红在测试文件上（本批实测撞到的，红得对；连注释里都不许复述那个形状）。
    expect(wrapper.find('.tag-chip--add').exists()).toBe(true);
  });

  it('④ 认不出的 id 不凭空长出来（折叠/软删留下的旧 id）', async () => {
    const { wrapper } = mountWithSelected(['a', '这颗核心已经不认了']);
    await settle();
    const chips = wrapper.findAll('.tag-chip:not(.tag-chip--add)');
    expect(chips).toHaveLength(1);
    expect(chips[0].text().trim()).toBe('甲');
  });
});
