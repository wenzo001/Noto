/**
 * §2.3 第五格的三句静止 + §4.7 两档传输警告各有各的话（缺口 G86 / G88）。
 *
 * G86 的旧形状不是"少了第三句"，是**第三句被折进了另一格**：核心在缺凭据时发
 * `badge: Offline` + `message_key: sync.needsCredentials`，于是屏幕上写的是"离线"——
 * 那一句在 §4.3 里说的是"改动会先存在本机"（网络那侧的事），而真相是
 * "这台设备的口令只活在上一次运行里"（门根本没开）。两个事实共用一格，
 * 用户就会去查网络，而该做的动作是去设置里重填一次口令。
 *
 * 这里断言的是三句**互相分得开**、"连不上本地服务"的优先级更高（§4.3），
 * 以及最危险那一档的告警形态与文案都与其他档分开。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { stubLocalService } from './testing/http';
import { useSettingsStore } from './stores/settings';
import { useSyncStore } from './stores/sync';
import { messageFor, t } from './i18n';

/** 读源码用 `import.meta.glob` 而不是 `node:fs`：本项目没装 `@types/node`（同一形状见 uiFeedback.spec.ts）。 */
const FILES = import.meta.glob<string>('./**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function read(rel: string): string {
  const found = FILES[`./${rel}`];
  if (found === undefined) throw new Error(`扫不到这个文件：${rel}（glob 的键是相对本 spec 的路径）`);
  return found;
}

/** 三句静止的说法，按 §2.3 的原文顺序。 */
const SAYINGS = ['未配置同步', '同步已关闭', '需要重新填写口令'] as const;

function accountFixture(extra: Record<string, unknown>) {
  return { id: 'acct-1', baseUrl: 'https://dav.example.com/dav', username: 'u', enabled: true, ...extra };
}

/** 换一个账户形状 = 重开一个 pinia + 重跑一次 loadAccount（这一格的真入口）。 */
async function withAccount(fixture: unknown) {
  setActivePinia(createPinia());
  stubLocalService({ account: () => fixture });
  await useSettingsStore().loadAccount();
  return useSyncStore();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useRealTimers();
});

describe('第五格的三句静止（§2.3 / G86）', () => {
  it('三句是三个不同的说法 —— 谁也不许被折成谁', () => {
    expect(new Set(SAYINGS).size, '三句必须互不相同').toBe(3);
  });

  it('没配过账户：说的是"未配置同步"', async () => {
    const sync = await withAccount(null);
    expect(useSettingsStore().hasAccount).toBe(false);
    expect(sync.label).toBe(t('sync.idle'));
  });

  it('配了但把「启用同步」关了：说的是"同步已关闭"，不许念成"未配置同步"', async () => {
    const sync = await withAccount(accountFixture({ enabled: false, hasCredential: true, credentialLive: true }));
    expect(sync.label).toBe(t('sync.disabled'));
    expect(sync.label).not.toBe(t('sync.idle'));
  });

  it('配了、也开着，但这台设备的口令只剩引用：说"需要重新填写口令"，而且归到**第五格**而不是"离线"', async () => {
    const sync = await withAccount(accountFixture({ hasCredential: true, credentialLive: false }));
    expect(useSettingsStore().credentialSavedButGone).toBe(true);

    // 核心在这一格发的就是 offline + needs_credentials —— 屏幕上那一格必须是静止的第五格。
    sync.applySignal({ badge: 'offline', messageKey: 'sync.needsCredentials' });

    expect(sync.badge, '折叠后的原始位仍是 offline：改的是呈现，不是把事实抹掉').toBe('offline');
    expect(sync.shownBadge).toBe('idle');
    expect(sync.label).toBe(t('sync.needsPassword'));
    expect(sync.detail, '原因那句要换成说得准的"重填一次就能继续"').toBe(t('settings.credentialGone'));
  });

  it('正对照：口令这一轮还在时，同一发 offline 不许被折成第五格（那是真离线）', async () => {
    const sync = await withAccount(accountFixture({ hasCredential: true, credentialLive: true }));
    sync.applySignal({ badge: 'offline', messageKey: 'sync.needsCredentials' });

    expect(sync.shownBadge).toBe('offline');
    expect(sync.label).toBe(t('sync.offline'));
  });

  it('§4.3 的优先级：连不上本地服务那一格，不许被缺口令盖过去', async () => {
    const sync = await withAccount(accountFixture({ hasCredential: true, credentialLive: false }));
    sync.setLink('unreachable');
    sync.applySignal({ badge: 'offline', messageKey: 'sync.needsCredentials' });

    expect(sync.shownBadge).toBe('offline');
  });

  it('静止那三格绝不冒"正在同步"：三种形状下那一格与说法都不是忙', async () => {
    for (const fixture of [
      null,
      accountFixture({ enabled: false, hasCredential: true, credentialLive: true }),
      accountFixture({ hasCredential: true, credentialLive: false }),
    ]) {
      const sync = await withAccount(fixture);
      sync.applySignal({ badge: 'idle' });
      expect(sync.shownBadge).not.toBe('syncing');
      expect(sync.label).not.toBe(t('sync.syncing'));
    }
  });

  it('点了那一格不许发一轮注定 407 的同步：sync_now 一发不出，那一格也不许翻成忙或失败', async () => {
    const service = stubLocalService({
      account: () => accountFixture({ hasCredential: true, credentialLive: false }),
      // 故意让它"会成功"：断言的是**这次调用到底发没发**，不是返回值。
      sync_now: () => null,
    });
    setActivePinia(createPinia());
    await useSettingsStore().loadAccount();
    const sync = useSyncStore();

    await sync.syncNow();

    expect(service.callsOf('sync_now'), '这一轮根本不可能认证成功；发出去就是把"重填口令"说成"同步失败"').toHaveLength(0);
    expect(sync.shownBadge).toBe('idle');
    expect(sync.label).toBe(t('sync.needsPassword'));
  });

  it('正对照：口令这一轮还在时，同一个入口照常发那一发', async () => {
    const service = stubLocalService({
      account: () => accountFixture({ hasCredential: true, credentialLive: true }),
      sync_now: () => null,
    });
    setActivePinia(createPinia());
    await useSettingsStore().loadAccount();

    await useSyncStore().syncNow();

    expect(service.callsOf('sync_now')).toHaveLength(1);
  });
});

describe('传输安全两档各有各的话（§4.7 / G88）', () => {
  const view = read('views/SettingsView.vue');

  it('明文 HTTP 与"跳过证书校验"用的是**两个**文案键，不是同一句', () => {
    expect(view).toMatch(/usesPlainHttp[\s\S]{0,300}?sync\.insecureWarn/);
    expect(view).toMatch(/insecureLocal'[\s\S]{0,400}?sync\.certSkipWarn/);
    expect(t('sync.insecureWarn')).not.toBe(t('sync.certSkipWarn'));
  });

  it('跳过证书校验那一句要说清"链路上别人能读到、还能伪装成你的服务器"', () => {
    const copy = t('sync.certSkipWarn');
    expect(copy).toContain('能读到');
    expect(copy).toContain('伪装');
    expect(copy).toContain('内网');
  });

  it('那一档是**警告块**（banner + role=alert），不是一句 field-hint', () => {
    const tag = view.match(/<div[^>]*data-testid="warn-cert-skip"[^>]*>/);
    expect(tag, '找不到那条告警的那颗元素').not.toBeNull();
    expect(tag?.[0]).toMatch(/class="banner banner--danger"/);
    expect(tag?.[0]).toMatch(/role="alert"/);
    expect(tag?.[0], '一句 field-hint 不是"显著告警"').not.toMatch(/field-hint/);
  });
});

/**
 * §4.3「两套库指向同一个远端目录 → 停下告警，绝不合并」——把核心那一发真信号从界面这一侧灌一次。
 *
 * 为什么这一格单独有腿（2026-10-14 更正过口径）：**通路本身早就有证人**（上面第五格那族就是灌
 * `{badge, messageKey}` 断文案），所以缺的不是"messageKey 会不会变成一句话"，而是
 * **这一个键从来没被那样灌过一次** —— 键名漂了、或者"停下"这一格被折进别的说法里，今天都不会红。
 * 核心那一侧发得出（`notera-host/src/lib.rs:2401-2408` → `Badge::Failed` + `sync.root_mismatch`），
 * 触发它的现场只有命令路径测试（`crates/notera-host/tests/crash_recovery.rs:231`）。
 * 期望值**不写 `t('sync.root_mismatch')`**：那会把"键还在不在"这种漂移自我掩盖掉，
 * 所以主张按规范那一句的**内容**逐条钉（另一个库 / 已停止 / 下一步去哪儿）。
 */
describe('§4.3 两库撞同一远端目录：停下告警那一发（root_mismatch）', () => {
  const COPY = '这个服务器上已经是另一个 Noto 库了';

  async function failedWith(messageKey: string, account: Record<string, unknown> = { hasCredential: true, credentialLive: true }) {
    const sync = await withAccount(accountFixture(account));
    sync.applySignal({ badge: 'failed', messageKey });
    return sync;
  }

  it('核心发的那一句会真的成为屏幕上那句原因：不是通用兜底，也不是那句「同步失败」', async () => {
    const sync = await failedWith('sync.root_mismatch');
    expect(sync.detail, '那一格的原因句没出来（键漂了或被折掉了）').toContain(COPY);
    // 三条主张逐条钉：这是"停下"、是"两个库不许合"、且给了下一步。
    expect(sync.detail).toContain('已停止同步');
    expect(sync.detail).toContain('混在一起');
    expect(sync.detail).toContain('路径');
    // 反向腿：不许是那句通用兜底，也不许是"还没有配置服务器"（§4.3 里这是两件事）。
    expect(sync.detail).not.toBe(messageFor('__definitely_not_a_key__'));
    expect(sync.detail).not.toContain('还没有配置同步服务器');
  });

  it('那一格是"失败"，不是忙 —— 停下之后不许还在转圈', async () => {
    const sync = await failedWith('sync.root_mismatch');
    expect(sync.shownBadge).toBe('failed');
    expect(sync.label).not.toBe(t('sync.syncing'));
  });

  it('徽标那句和原因那句不许是同一句话（同一句不许说两遍）', async () => {
    const sync = await failedWith('sync.root_mismatch');
    expect(sync.label).not.toBe(sync.detail);
    expect(sync.label?.length).toBeGreaterThan(0);
  });

  /**
   * §4.3 的优先级：这一格最像"被顺手折进第五格"（口令只剩引用 + 一个失败）。
   * 折的条件是 `badge === 'offline'`，`failed` 不在其列 —— 这一条就是把那条边界钉住：
   * 两库相撞是**已经停下并要人改配置**，不是"重填一次口令就能继续"。
   */
  it('就算这台设备的口令也只剩引用，那一格也不许被折成"需要重新填写口令"', async () => {
    const sync = await failedWith('sync.root_mismatch', { hasCredential: true, credentialLive: false });
    expect(useSettingsStore().credentialSavedButGone, '夹具要先把"只剩引用"造出来才测得到这一条').toBe(true);
    expect(sync.shownBadge).toBe('failed');
    expect(sync.detail).toContain(COPY);
  });
});
