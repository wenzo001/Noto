/**
 * 「没配同步，点一下却开始转」的回归门禁。
 *
 * 为什么这份 spec 存在（真机读数，不是推测）：
 *   空库 + 无账户，点侧栏徽标之后连采 24 次（12 秒）——
 *   `syncing,syncing,…,syncing` 一个不落，`aria-busy=true`，控制台零 error。
 *   F5 同形。见 `.logs/repro-click-spin.mjs`。
 *
 * 根因是**一条没人守的调用边**，不是状态机少一个落点：
 *   ① `sync_now` 命令只做 `dirty_ticks += 1` 然后回 `null`（HTTP 200），
 *      **它从不回错** —— 所以 `stores/sync.ts` 里那条 `no_account` 分支是死代码；
 *   ② 调度器只在壳里「首帧之后 + 当时已配好账户」才 spawn 一次，
 *      没配账户时**没有任何消费者**，于是永远不会有一条事件来把徽标从 `syncing` 带走。
 *   ⇒ 徽标进了 `syncing` 就是**永久**的。
 *
 * 因此判据打在「这一次调用发没发」与「徽标进没进 syncing」两层，
 * 而不是去正则切源码形状（那种写法在 `syncIdleAndSidebar.spec.ts` 里连栽三次）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import App from './App.vue';
import { stubLocalService, type LocalService } from './testing/http';
import { useSyncStore } from './stores/sync';

const ACCOUNT_CONFIGURED = {
  id: 'acct-1',
  label: '家里',
  baseUrl: 'https://dav.home.example/dav',
  rootPrefix: '/.notes',
  authKind: 'basic',
  username: 'me',
  tlsPolicy: 'strict',
  proxyMode: 'direct',
  bypass: [],
  enabled: true,
  hasCredential: true,
  credentialLive: true,
  credentialPersistent: true,
};

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await flushPromises();
  }
}

/** 空库、无账户 —— 与 `notera-cli serve` 的真读数一致：`account` 回 null，`sync_now` 回 null。 */
function makeService(account: unknown = null): LocalService {
  return stubLocalService({
    account: () => account,
    sync_now: () => null,
    stats: () => ({ notes: 0, folders: 1, attachments: 0, dbBytes: 1, notesInTrash: 0, inflightOps: 0, searchGeneration: 0, ftsRows: 0, userVersion: 1, tombstones: 0, tombstonesPurged: 0, dirtyNotes: 0, outboxPending: 0, conflictsOpen: 0 }),
    list_notes: () => ({ items: [], total: 0, truncated: false }),
    search: () => ({ items: [], total: 0, truncated: false, generation: 0 }),
    list_folders: () => [],
    list_trash: () => ({ items: [], total: 0, truncated: false }),
    sync_status: () => ({ phase: 'unconfigured', badge: 'offline', lastSuccessAt: null, pendingOps: 0, openConflicts: 0, messageKey: null, retryable: false }),
    list_conflicts: () => [],
    caps: () => ({}),
  });
}

const badgeKind = (wrapper: ReturnType<typeof mount>) =>
  wrapper.find('[data-testid="sync-badge"]').attributes('data-badge');

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

describe('没配同步时，点击不许假装在同步', () => {
  it('未配置账户：点徽标既不进 syncing，也不发 sync_now', async () => {
    const service = makeService(null);
    const wrapper = mount(App, { attachTo: document.body });
    await settle();
    expect(badgeKind(wrapper), '首帧该是静止的 idle').toBe('idle');

    await wrapper.find('[data-testid="sync-badge"]').trigger('click');
    await settle();

    expect(badgeKind(wrapper), '没配账户时点一下绝不能进"正在同步"').not.toBe('syncing');
    expect(badgeKind(wrapper)).toBe('idle');
    expect(service.callsOf('sync_now'), '根本不该发这一次同步请求').toHaveLength(0);
    expect(wrapper.text()).toContain('未配置同步');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('未配置账户：F5 同形（快捷键也是手动同步入口）', async () => {
    const service = makeService(null);
    const wrapper = mount(App, { attachTo: document.body });
    await settle();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await settle();

    expect(badgeKind(wrapper)).not.toBe('syncing');
    expect(service.callsOf('sync_now'), 'F5 不该在没有账户时发同步请求').toHaveLength(0);
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('未配置账户：点徽标把用户带到配置它的地方（设置页），而不是点了没反应', async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await settle();
    expect(wrapper.find('[data-testid="account-save"]').exists()).toBe(false);

    await wrapper.find('[data-testid="sync-badge"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="account-save"]').exists(), '要点该有去处：同步在设置页配').toBe(true);
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('配了但关了「启用同步」：静止，并且说的是"已关闭"而不是"未配置"', async () => {
    const service = makeService({ ...ACCOUNT_CONFIGURED, enabled: false });
    const wrapper = mount(App, { attachTo: document.body });
    await settle();

    await wrapper.find('[data-testid="sync-badge"]').trigger('click');
    await settle();

    expect(badgeKind(wrapper)).not.toBe('syncing');
    expect(service.callsOf('sync_now'), '用户明确关了同步，就不该有任何一轮').toHaveLength(0);
    expect(wrapper.text(), '关着却说"未配置"是另一句假话').toContain('同步已关闭');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});

describe('静止态要说清是哪一种静止（PROXY.md §7 那句"徽标停在需要凭据"）', () => {
  it('核心给了原因，那一句话必须**在屏幕上看得见**，不能只活在 aria-live 与 title 里', async () => {
    makeService(null);
    const wrapper = mount(App, { attachTo: document.body });
    await settle();

    useSyncStore().applySignal({ badge: 'offline', messageKey: 'sync.needsCredentials' });
    await settle();

    const detail = wrapper.find('[data-testid="sync-detail"]');
    expect(detail.exists(), '"为什么"那一格根本没渲染 ⇒ 用户只看见"离线"两个字').toBe(true);
    expect(detail.classes()).not.toContain('visually-hidden');
    expect(detail.text(), '要念得出的是核心给的那句具名原因').toContain('凭据');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});

describe('配好了同步，手动入口必须真的还能用', () => {
  it('已配置且启用：点徽标进 syncing 并发出 sync_now', async () => {
    const service = makeService(ACCOUNT_CONFIGURED);
    const wrapper = mount(App, { attachTo: document.body });
    await settle();
    // 配好了，启动那一轮本来就该发一次 —— 所以要量的是"这一次点击有没有加上去"，
    // 不是总数（钉总数会把"启动自动同步"这条合法调用也算成我的错）。
    const atBoot = service.callsOf('sync_now').length;
    expect(atBoot, '配好且开着：启动该自动同步一轮').toBe(1);

    await wrapper.find('[data-testid="sync-badge"]').trigger('click');
    await settle();

    expect(service.callsOf('sync_now'), '配好了就该真发这一次请求').toHaveLength(atBoot + 1);
    expect(badgeKind(wrapper)).toBe('syncing');
    expect(wrapper.find('[data-testid="account-save"]').exists(), '配好了就不该被踢到设置页').toBe(false);
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('启动时的自动同步也只跟配置走：关了就不自动同步', async () => {
    const service = makeService({ ...ACCOUNT_CONFIGURED, enabled: false });
    const wrapper = mount(App, { attachTo: document.body });
    await settle();

    expect(badgeKind(wrapper)).toBe('idle');
    expect(service.callsOf('sync_now'), '关掉启用之后，启动不该自动同步').toHaveLength(0);
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});

/**
 * （标签订正 2026-10-14：这里原来写的是 §11.4，而盘上那份规范快照只到 §9，§10/§11 没有原文 ——
 *   那个编号在仓内任何文本里都查不到出处（代码里其他 "11.4" 全是描边比例 1:11.4）。
 *   这一块真正对的是 §4.3 那行「失败：同步失败 + 一行屏幕可见的原因（不能只挂在 title 或 aria-live 上）」，故改成 §4.3；判据行为一字未动。）
 * §4.3「让路不是失败，但必须看得见」—— 这一块的来历要照实写：**我先把它当成缺口，其实是假发现**。
 * 那句话早就有可见出口（`SyncBadge.vue:87` 的 `<p v-if="sync.detail" data-testid="sync-detail">`，
 * 而 `detail` 就是 `state.messageKey ? messageFor(...)`），而且已经有两处证人：上面那条
 * `sync.needsCredentials` 与本仓库的浏览器腿 ㊵。我第一版读模板只读到第 80 行，漏看了 87 行，
 * 于是去"补"了一行——单测 72 全绿、typecheck 干净，**整跑腿 ㊵ 红**：同一句话说两遍，
 * 同步条从 108 顶到 148，520 档把库读数顶出视口、侧栏长出 31px 溢出。
 *
 * 所以这里**不重复**"看得见"那一条（已有证人），只钉那次事故自己那一格：
 * **同一句具名原因在可见的那几格里不许出现两遍**（aria-live 那一份是给读屏器的，
 * 不算重复 —— 少了下面那条正对照，"只出现一次"会在两份都没渲染时照样绿）。
 * 驱动走 `applySignal`，就是引擎 `SyncEvent::Deferred` 发的那一条（`badge = Offline` +
 * `message_key = sync.leaseHeld`）。**不走 `sync_status`**：那一发只回
 * `lastSuccessAt / divergenceHeld / pendingOps / openConflicts`，从不回徽标
 * （我第一版把它当徽标入口，四条全红在 `expected 'idle' to be 'offline'`）。
 */
describe('§4.3 具名原因那句可见的话不许说两遍（说两遍会顶掉 520 档的「设置」）', () => {
  const mountDeferred = async () => {
    makeService(ACCOUNT_CONFIGURED);
    const wrapper = mount(App, { attachTo: document.body });
    await settle();
    useSyncStore().applySignal({ badge: 'offline', messageKey: 'sync.leaseHeld' });
    await settle();
    return wrapper;
  };

  const visibleSyncbarTexts = (wrapper: ReturnType<typeof mount>) =>
    Array.from(wrapper.find('[data-testid="syncbar"]').element.childNodes)
      .filter((n) => (n as Element).nodeType === 1 && !(n as Element).classList?.contains('visually-hidden'))
      .map((n) => (n as Element).textContent?.trim() ?? '')
      .filter((s) => s.length > 0);

  it('这一句在看得见的那几格里**只出现一次**（重复会把同步条顶高，520 档就弄丢「设置」）', async () => {
    const wrapper = await mountDeferred();

    const hits = visibleSyncbarTexts(wrapper).filter((s) => /先让它/.test(s));
    expect(hits.length, `可见文字里出现了 ${hits.length} 遍：${JSON.stringify(hits)}`).toBe(1);
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('正对照：读屏器那一出口确实在场 —— 证明上一条的"恰好一次"不是"一次都没有"', async () => {
    const wrapper = await mountDeferred();

    const aria = wrapper.find('[data-testid="syncbar"] .visually-hidden');
    expect(aria.exists(), 'aria-live 那一格没渲染 ⇒ "可见的那份只有一次"是靠少渲染蒙的').toBe(true);
    expect(aria.text()).toContain('先让它');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('让路归**离线那一格**，不许说成"正在同步"，也不许清了原因只留"离线"两个字（§4.3）', async () => {
    const wrapper = await mountDeferred();

    expect(badgeKind(wrapper), '让路不是失败，也不是在动').toBe('offline');
    expect(wrapper.find('[data-testid="sync-detail"]').exists(), '离线那一格必须带上原因').toBe(true);
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});
