/**
 * 默认值迁移（第一百五十五批，A 档：Joplin 的 `Setting.ts:77-120`）。
 *
 * 要解决的问题只有一句：**以后改默认值时，不许盖掉那些从没设过的人；也不许改掉那些明确选过的人。**
 * 这两侧必须各有一条判据 —— 只测一侧的话，"永远用盘上的值"（第一侧红）与
 * "永远用默认值"（第二侧红）都能骗过另一侧。
 *
 * 跑法：`pnpm --dir apps/desktop exec vitest run src/defaultMigration.spec.ts`
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DEFAULT_PREFS, normalizePrefs, useSettingsStore, type UiPrefs } from './stores/settings';

/**
 * 一份"以后改过的默认"：四格**每一格**都与今天的默认不同。
 * 只改一格的话，另外三格的迁移根本没被执行过 —— 判据里"跟着默认走"这句话就只剩字号那一条腿
 * （[[enumerate-each-gate-leg-with-its-own-mutation]]：一张表有几个键，就要有几键各自的读数）。
 */
const NEW_DEFAULTS: UiPrefs = { ...DEFAULT_PREFS, theme: 'light', fontScale: 1.15, transparency: false, trayHint: true };

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe('没动过的键跟着默认值走', () => {
  it('只动过 theme ⇒ fontScale 即使盘上躺着一个旧值，也跟随新默认', () => {
    const got = normalizePrefs({ theme: 'dark', fontScale: 1, explicit: ['theme'] }, NEW_DEFAULTS);
    expect(got.theme).toBe('dark');
    expect(got.fontScale).toBe(1.15);
  });

  it('盘上什么都没有 ⇒ 全默认，且 explicit 是空的（不许凭空记成"用户动过"）', () => {
    const got = normalizePrefs({}, NEW_DEFAULTS);
    expect(got.fontScale).toBe(1.15);
    expect(got.explicit).toEqual([]);
  });

  it('盘上写着**旧默认**的那三格、但名单里没有它们 ⇒ 一起跟随新默认（这一格才是"迁移"这句话本身）', () => {
    const got = normalizePrefs(
      { theme: 'system', fontScale: 1, transparency: true, trayHint: false, explicit: ['fontScale'] },
      NEW_DEFAULTS,
    );
    expect(got.fontScale).toBe(1);
    expect(got.theme).toBe('light');
    expect(got.transparency).toBe(false);
    expect(got.trayHint).toBe(true);
  });

  it('名单里点了一格、盘上却没有那一格的值 ⇒ 用默认（两格是两次写事务，其中一次可以失败）', () => {
    const got = normalizePrefs({ theme: 'dark', explicit: ['theme', 'fontScale'] }, NEW_DEFAULTS);
    expect(got.theme).toBe('dark');
    expect(got.fontScale).toBe(1.15);
  });
});

describe('动过的键永远是他那一份', () => {
  it('明确选了 1（与新默认同值也算选过）⇒ 不许被新默认盖掉', () => {
    const got = normalizePrefs({ fontScale: 1, explicit: ['fontScale'] }, NEW_DEFAULTS);
    expect(got.fontScale).toBe(1);
  });

  it('主题、透明度、托盘提示三格各自都要保住（名单管的是**每一格**，不是只有字号会被改默认）', () => {
    const got = normalizePrefs(
      { theme: 'system', transparency: true, trayHint: false, explicit: ['theme', 'transparency', 'trayHint'] },
      NEW_DEFAULTS,
    );
    expect(got.theme).toBe('system');
    expect(got.transparency).toBe(true);
    expect(got.trayHint).toBe(false);
  });

  it('老记录没有 `explicit` 那一格 ⇒ 盘上有的键一律算他动过（这次改动自己不许变成数据丢失）', () => {
    const got = normalizePrefs({ theme: 'dark', fontScale: 1 }, NEW_DEFAULTS);
    expect(got.theme).toBe('dark');
    expect(got.fontScale).toBe(1);
    expect(got.explicit).toEqual(['fontScale', 'theme']);
  });
});

describe('名单本身不许脏', () => {
  it('`explicit` 里不认识的键名与非字符串项都被丢掉', () => {
    const got = normalizePrefs({ theme: 'light', explicit: ['theme', 'password', 7, null, 'sorts'] }, NEW_DEFAULTS);
    expect(got.explicit).toEqual(['theme']);
  });

  it('`sorts` 整格按显式处理：每条都是用户点过的那一档，不需要 `explicit` 也保得住', () => {
    const got = normalizePrefs({ sorts: { all: 'title_asc' } }, NEW_DEFAULTS);
    expect(got.sorts).toEqual({ all: 'title_asc' });
  });
});

describe('调用边：写一个键要同时记下"这个键动过"', () => {
  it('setTheme 之后 theme 进了名单，没碰过的 fontScale 不在名单里', () => {
    const settings = useSettingsStore();
    settings.setTheme('dark');
    expect(settings.prefs.explicit).toEqual(['theme']);
    expect(settings.prefs.fontScale).toBe(1);
  });

  it('setListSort 不往名单里塞 `sorts`（那一格永远显式，塞进去只会让下一次读它的人误判）', () => {
    const settings = useSettingsStore();
    settings.setListSort('all', 'title_desc');
    expect(settings.prefs.sorts.all).toBe('title_desc');
    expect(settings.prefs.explicit).toEqual([]);
  });

  it('同一个键改两次只记一次（名单是集合，不是流水账）', () => {
    const settings = useSettingsStore();
    settings.setTheme('dark');
    settings.setTheme('light');
    expect(settings.prefs.explicit).toEqual(['theme']);
  });
});
