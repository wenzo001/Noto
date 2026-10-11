/**
 * §2.3「同步五格（语义不可改）」的**接线**那一半：状态 → 字形 → 会不会转。
 *
 * 为什么这份 spec 存在：五格的语义此前只有第五格被浏览器量过一次（㉛：`sync-idle`、
 * `animation-name=none`、`getAnimations()=0`），另外四格的"哪一格配哪一个字形""转圈的只有正在同步"
 * 从来没有判据 —— 换错字形、把离线也挂上动画，屏幕上都不会红。
 *
 * **颜色那一半不在这里断**：jsdom 不把 SFC 的 scoped 样式套到元素上，在这里读 `color` 只会
 * 绿得好看。颜色与"属性真生效"的渲染证据在 `verify-layout` 的腿 59 里量。
 * 两半合起来才是 §2.3 那张表：**接线**（这里）+ **渲染**（浏览器）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { VueWrapper } from '@vue/test-utils';
import App from './App.vue';
import { SYNC_ICONS, type IconName } from './components/ui/icons';
import { stubLocalService } from './testing/http';
import { useSyncStore } from './stores/sync';

const CELLS: Array<{ badge: string; icon: IconName; spins: boolean }> = [
  { badge: 'synced', icon: 'sync-synced', spins: false },
  { badge: 'syncing', icon: 'sync-syncing', spins: true },
  { badge: 'offline', icon: 'sync-offline', spins: false },
  { badge: 'failed', icon: 'sync-failed', spins: false },
  { badge: 'idle', icon: 'sync-idle', spins: false },
];

function makeService(): void {
  stubLocalService({
    account: () => null,
    sync_now: () => null,
    stats: () => ({ notes: 0, folders: 1, attachments: 0, dbBytes: 1, notesInTrash: 0, inflightOps: 0 }),
    list_notes: () => ({ items: [], total: 0, truncated: false }),
    search: () => ({ items: [], total: 0, truncated: false, generation: 0 }),
    list_folders: () => [],
    list_trash: () => ({ items: [], total: 0, truncated: false }),
    sync_status: () => ({ phase: 'unconfigured', badge: 'offline', lastSuccessAt: null, pendingOps: 0, openConflicts: 0, messageKey: null, retryable: false }),
    list_conflicts: () => [],
    caps: () => ({}),
  });
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('EventSource', undefined);
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('§2.3 五格各自吃哪一个字形、谁才许转（接线层）', () => {
  it('五格逐一对得上：状态 → `data-badge` → 字形 → `data-spin`', async () => {
    makeService();
    const wrapper: VueWrapper = mount(App, { attachTo: document.body });
    await settle();
    const sync = useSyncStore();
    const strip = wrapper.find('[data-testid="syncbar"]');
    // 仪器自检：量不到这一格就是选择器过期，后面全是空判据
    expect(strip.exists(), '侧栏同步条没渲染（选择器过期？）').toBe(true);

    for (const cell of CELLS) {
      sync.applySignal({ badge: cell.badge });
      await settle();
      const glyph = wrapper.find('[data-testid="syncbar"] svg');
      expect(strip.attributes('data-badge'), `状态 ${cell.badge} 没落到那一格上`).toBe(cell.badge);
      expect(glyph.attributes('data-icon'), `状态 ${cell.badge} 的字形不对`).toBe(cell.icon);
      expect(glyph.attributes('data-spin'), `状态 ${cell.badge} 的"转不转"不对`).toBe(cell.spins ? 'true' : 'false');
    }
    wrapper.unmount();
  });

  it('转圈的**只有**"正在同步"一格（§2.3：唯一会转的 / 第五格绝对静止）', async () => {
    makeService();
    const wrapper: VueWrapper = mount(App, { attachTo: document.body });
    await settle();
    const sync = useSyncStore();
    const spinning: string[] = [];
    for (const cell of CELLS) {
      sync.applySignal({ badge: cell.badge });
      await settle();
      if (wrapper.find('[data-testid="syncbar"] svg').attributes('data-spin') === 'true') spinning.push(cell.badge);
    }
    expect(spinning, JSON.stringify(spinning)).toEqual(['syncing']);
    wrapper.unmount();
  });

  it('字形表本身不许漂：五格五个字形，且都从同一张 `SYNC_ICONS` 里来', async () => {
    for (const cell of CELLS) {
      expect(SYNC_ICONS[cell.badge], `SYNC_ICONS 里 ${cell.badge} 那一格漂了`).toBe(cell.icon);
    }
    expect(new Set(Object.values(SYNC_ICONS)).size, '五格共用车轮廓但内部徽标必须各不同').toBe(5);
  });
});
