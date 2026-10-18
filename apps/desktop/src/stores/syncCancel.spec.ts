/**
 * 「停止这一轮」（任务 #4 第一件）在界面这一侧的接线。
 *
 * 这里钉的不是"引擎会不会停"（那一半在 `crates/notera-sync/tests/engine.rs` 三条里，
 * 两条取消 + 一条对照），钉的是**界面不许替核心宣布结果**这一格：
 *  ① 调用边：按下去真的发了一发 `sync_cancel`，而且只发一发；回执 `true` 时 store **不动徽标**
 *    —— "停了"这句话要由核心那一轮收尾时报（`sync.cancelled`），界面自己翻会翻出假话；
 *  ② 回执 `false`（此刻根本没有轮次在跑）⇒ 立刻重问一次 `sync_status`，让界面回到事实，
 *    而不是留着那颗刚按下的按钮的余晖；
 *  ③ 命令失败 ⇒ 返回 false、重问、不抛到界面上（这一格缺席不影响徽标那五格）；
 *  ④ 对照：命令名的字面串在前端声明里就是 `sync_cancel` —— 打错一个字母，①②③ 会一起红，
 *    但红的是"发不出去"，看不出是名字错了；这一条给的是那一形的直接证人。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { Commands } from '../api/types';
import { stubLocalService } from '../testing/http';
import { useSyncStore } from './sync';

const STATUS_SYNCING = {
  phase: 'online',
  badge: 'syncing',
  lastSuccessAt: null,
  pendingOps: 3,
  openConflicts: 0,
  messageKey: null,
  retryable: false,
};

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync_cancel 的接线', () => {
  it('④ 对照：命令名就是核心那一条 arm 的字面串', () => {
    expect(Commands.syncCancel).toBe('sync_cancel');
  });

  it('① 按下去发且只发一发；回执 true 时 store 不自己翻徽标', async () => {
    const service = stubLocalService({
      sync_cancel: () => ({ running: true }),
      sync_status: () => STATUS_SYNCING,
    });
    const sync = useSyncStore();
    await sync.refreshStatus();
    const before = sync.badge;
    const callsBefore = service.callsOf('sync_cancel').length;
    expect(await sync.cancelRound()).toBe(true);
    expect(service.callsOf('sync_cancel')).toHaveLength(callsBefore + 1);
    expect(sync.badge, '"停了"要由核心报，界面不许先翻').toBe(before);
  });

  it('② 回执 false（没有在跑的轮次）⇒ 重问一次状态，不留下界面上的假话', async () => {
    let statusCalls = 0;
    stubLocalService({
      sync_cancel: () => ({ running: false }),
      sync_status: () => {
        statusCalls += 1;
        return { ...STATUS_SYNCING, badge: 'synced' };
      },
    });
    const sync = useSyncStore();
    expect(await sync.cancelRound()).toBe(false);
    expect(statusCalls, '拿到 false 之后必须去问一次事实').toBeGreaterThanOrEqual(1);
    // 徽标本身不归这条 spec 管：没配账户时它折到 `idle`（那是 `syncLastSuccess` / 五格那一族钉的事）。
    // 这里只证"按空了会去问一次"，问回来的值由 store 自己折。
  });

  it('③ 命令失败 ⇒ false + 重问，不抛错', async () => {
    let statusCalls = 0;
    stubLocalService({
      sync_status: () => {
        statusCalls += 1;
        return STATUS_SYNCING;
      },
      // 故意不提供 sync_cancel：桩会回 404，等于核心还没有这一条 arm
    });
    const sync = useSyncStore();
    await expect(sync.cancelRound()).resolves.toBe(false);
    expect(statusCalls).toBeGreaterThanOrEqual(1);
  });
});
