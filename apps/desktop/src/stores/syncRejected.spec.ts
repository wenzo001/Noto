/**
 * 「是哪几条没上来」（任务 #4 ②）在界面这一侧的形状。
 *
 * 引擎那一半钉的是"身份要出得来"（`engine.rs` 两条：单条那一族带 `n/rej1`、
 * 批量那一族**故意**空着），这里钉的是那句话**怎么说**：
 *  ① 都有名字 ⇒ 点名 + 数量按真数说；
 *  ② 一部分说不出 ⇒ 那部分单独一句，不混进名字里，也**绝不拿 id 冒充标题**；
 *  ③ 一条都没有 ⇒ 整句不说（空态是一句断言，没读过就不能说）；
 *  ④ 对照：桥根本没带这一键（旧核心 / 命令失败）⇒ 同样整句不说，不抛错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { stubLocalService } from '../testing/http';
import { useSyncStore } from './sync';

const statusWith = (items: unknown[]) => ({
  phase: 'online',
  badge: 'failed',
  lastSuccessAt: null,
  pendingOps: 0,
  openConflicts: 0,
  messageKey: 'sync.applyRejected',
  retryable: true,
  rejectedItems: items,
});

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync_status.rejectedItems ⇒ 那一句', () => {
  it('① 都有名字：点名，数量按真数说', async () => {
    stubLocalService({
      sync_status: () => statusWith([
        { kind: 'n', id: 'aaa', title: '甲篇', reason: '同 rev 不同内容' },
        { kind: 'n', id: 'bbb', title: '乙篇', reason: null },
      ]),
    });
    const sync = useSyncStore();
    await sync.refreshStatus();
    expect(sync.rejectedLine).toContain('有 2 条没同步进来');
    expect(sync.rejectedLine).toContain('甲篇');
    expect(sync.rejectedLine).toContain('乙篇');
    expect(sync.rejectedLine).not.toContain('说不出');
  });

  it('② 一部分说不出：那部分单独一句，id 一个字母都不许漏进那句话', async () => {
    stubLocalService({
      sync_status: () => statusWith([
        { kind: 'n', id: 'aaa', title: '甲篇', reason: null },
        { kind: 'n', id: '', title: null, reason: null },
        { kind: 'n', id: '', title: null, reason: null },
      ]),
    });
    const sync = useSyncStore();
    await sync.refreshStatus();
    const line = sync.rejectedLine ?? '';
    expect(line).toContain('有 3 条');
    expect(line).toContain('甲篇');
    expect(line).toContain('另有 2 条说不出是哪几条');
    expect(line, '说不出的那部分不许拿 kind/id 冒充名字').not.toMatch(/[A-Za-z]/);
  });

  it('③ 一条都没有 ⇒ 整句不说', async () => {
    stubLocalService({ sync_status: () => statusWith([]) });
    const sync = useSyncStore();
    await sync.refreshStatus();
    expect(sync.rejectedLine).toBeNull();
  });

  it('④ 对照：桥没带这一键（旧核心）⇒ 同样不说，也不抛错', async () => {
    stubLocalService({ sync_status: () => ({ badge: 'failed', pendingOps: 0, openConflicts: 0 }) });
    const sync = useSyncStore();
    await expect(sync.refreshStatus()).resolves.toBeUndefined();
    expect(sync.rejectedLine).toBeNull();
  });
});
