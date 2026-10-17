/**
 * §4.6「凭据三时点」里**设置页那两格**（缺口 G133）。
 *
 * 三时点各自那句话的**依据不是同一样东西**：填前那句读能力位（`caps.keychain`），
 * 存后那句读 toast，重启后那句读核心回传的三个位（`hasCredential` / `credentialLive` / `credentialPersistent`）。
 * 「存后」与「徽标那一格的重启后」早就有证人（`settingsCredential.spec.ts`、`fifthCellAndTransport.spec.ts:80`），
 * 而这里这两句从前**只有渲染、没有断言** —— 于是"该说的时候不说"与"不该说的时候乱说"两个方向都无人守着：
 * 前者让用户在退出后才发现口令没了，后者当着有系统凭据库的用户造假警告。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsView from './views/SettingsView.vue';
import { stubLocalService } from './testing/http';
import { useSettingsStore } from './stores/settings';

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await flushPromises();
  }
}

/** 挂设置页，并按给定的能力位与账户三位把现场摆好。 */
async function renderWith(options: {
  keychain: 'none' | 'keychain';
  account: Record<string, unknown> | null;
}): Promise<ReturnType<typeof mount>> {
  stubLocalService({ account: () => options.account });
  const settings = useSettingsStore();
  settings.setCaps({ keychain: options.keychain });
  const wrapper = mount(SettingsView);
  await settle();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useRealTimers();
});

describe('填前那句（依据 = 这台设备有没有系统凭据库）', () => {
  it('没有凭据库 ⇒ 敲口令之前就得先说"只留在这次运行里"', async () => {
    const wrapper = await renderWith({ keychain: 'none', account: null });
    const hint = wrapper.find('[data-testid="credential-store-none"]');
    expect(hint.exists(), `敲口令之前那句必须在场；页面上现有：${wrapper.text().slice(0, 120)}`).toBe(true);
    expect(hint.text()).toContain('这台设备没有系统凭据库');
  });

  it('正对照：这台设备留得住口令时，那句不许出现（出现就是当着用户造假警告）', async () => {
    const wrapper = await renderWith({ keychain: 'keychain', account: null });
    expect(wrapper.find('[data-testid="credential-store-none"]').exists()).toBe(false);
  });
});

describe('只活本次那句（依据 = 核心回传的 credentialLive / credentialPersistent 两位）', () => {
  const account = (bits: Record<string, unknown>) => ({
    id: 'acct-1',
    baseUrl: 'https://dav.home.example/dav',
    enabled: true,
    hasCredential: true,
    ...bits,
  });

  it('这一轮拿得到但留不住 ⇒ 「只在这次运行里有效」在场', async () => {
    const wrapper = await renderWith({
      keychain: 'none',
      account: account({ credentialLive: true, credentialPersistent: false }),
    });
    const hint = wrapper.find('[data-testid="credential-volatile"]');
    expect(hint.exists(), `两位是 live 且不 persistent，这句必须在场；页面上现有：${wrapper.text().slice(0, 120)}`).toBe(true);
    expect(hint.text()).toContain('只在这次运行里有效');
  });

  it('正对照：留得住（persistent）时这句不许出现 —— 说了就把稳的说成不稳的', async () => {
    const wrapper = await renderWith({
      keychain: 'keychain',
      account: account({ credentialLive: true, credentialPersistent: true }),
    });
    expect(wrapper.find('[data-testid="credential-volatile"]').exists()).toBe(false);
  });
});
