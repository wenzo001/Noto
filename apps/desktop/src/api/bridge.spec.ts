/**
 * 壳内通道的契约测试。
 *
 * 为什么单独钉这一组：Rust 侧只注册了 **一个** Tauri 命令
 * （`notera_command(name, args)` → `commands::dispatch`），两边靠字面量对齐。
 * 字面量漂了不会编译错、也不会有类型错，只会在真窗口里表现为"每个按钮都没反应"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, callCommand, currentTransport, inTauri, onUiEvent, pickOpenPath, pickSavePath } from './bridge';

const invoke = vi.fn();
const listened: Array<{ name: string; handler: (e: { payload: unknown }) => void }> = [];
let fire: ((payload: unknown) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    listened.push({ name, handler });
    fire = (payload: unknown) => handler({ payload });
    return Promise.resolve(() => {});
  },
}));

function asTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true, writable: true });
}
function asBrowser() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: undefined, configurable: true, writable: true });
}
async function flush() {
  // 通道是 `await import('@tauri-apps/api/event')` 惰性建立的，需要让宏任务队列转一圈。
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  invoke.mockReset();
  listened.length = 0;
  fire = null;
});

describe('Tauri 通道契约', () => {
  beforeEach(asTauri);

  it('命令名与载荷形状必须和壳里的 `notera_command(name, args)` 逐字对齐', async () => {
    invoke.mockResolvedValue({ ok: true, payload: { id: 'x' } });
    const args = { id: '0192a000-0000-7000-8000-000000000001', doc: { v: 1, content: [] }, expectedRev: 4 };
    await expect(callCommand('edit_note', args)).resolves.toEqual({ id: 'x' });

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invoke.mock.calls[0];
    expect(cmd).toBe('notera_command');
    expect(Object.keys(payload as object).sort()).toEqual(['args', 'name']);
    expect(payload).toEqual({ name: 'edit_note', args });
  });

  it('ok:false 的拒绝载荷折成 BridgeError，并带上 messageKey 与 retryable', async () => {
    invoke.mockRejectedValue({ code: 'offline', messageKey: 'error.offline', retryable: true });
    await expect(callCommand('sync_status', {})).rejects.toMatchObject({
      name: 'BridgeError',
      code: 'offline',
      messageKey: 'error.offline',
      retryable: true,
    });
  });

  it('stale_edit 的真实 rev 从 detail 里取到（冲突流程要用它做"重新加载"）', async () => {
    invoke.mockRejectedValue({
      code: 'stale_edit',
      messageKey: 'note.staleEdit',
      retryable: false,
      detail: { expected: 4, actual: 7 },
    });
    const err = (await callCommand('edit_note', { id: 'a', doc: {}, expectedRev: 4 }).catch((e: unknown) => e)) as BridgeError;
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.isStaleEdit).toBe(true);
    expect(err.actualRev).toBe(7);
  });

  it('事件名字面量与壳里的 EVENT_NAME 一致，且载荷能到达订阅者', async () => {
    const seen: unknown[] = [];
    onUiEvent((e) => seen.push(e));
    await flush();
    expect(listened.map((l) => l.name)).toContain('notera://event');

    fire?.({ kind: 'sync', badge: 'syncing', progress: null, errorCode: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'sync', badge: 'syncing' });
  });

  it('通道判定：有 __TAURI_INTERNALS__ 才是 tauri，没有就是 http', async () => {
    expect(inTauri()).toBe(true);
    expect(currentTransport()).toBe('tauri');
    asBrowser();
    expect(inTauri()).toBe(false);
    expect(currentTransport()).toBe('http');
  });
});

describe('HTTP 通道的裸标量正文', () => {
  function reply(body: string, status = 200) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }));
  }

  beforeEach(() => {
    asBrowser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 这一族的证人：核心对"这一篇不存在""没配账户"回的是**裸 `null`**（4 字节，实测 `curl` 打出来的）。
   * 桥以前只看首字符是不是 `{`/`[`，那 4 字节于是长成字符串 `"null"` 交到调用方手里 —— 真值。
   * 界面上四处在 `if (!note)`（编辑器两开、草稿收口、设置页读账户），每一个都会被它骗成"东西在"。
   * 用 `toBe` 而不是 `toBeFalsy`：假值里就含着 `"null"` 这种形状，宽松的比较正好抓不到这次的真缺陷。
   */
  it('裸 null 的正文 ⇒ 解析成 null，不是字符串 "null"', async () => {
    reply('null');
    const note = await callCommand<{ id: string } | null>('get_note', { id: '01a15900-0000-7000-8000-000000000000' });
    expect(note).toBe(null);
    expect(typeof note).toBe('object');
  });

  it('裸 false 与裸数字也照 JSON 解（`Boolean("false")` 是 true，这一族不能只修 null）', async () => {
    reply('false');
    expect(await callCommand<boolean>('some_flag', {})).toBe(false);
    reply('0');
    expect(await callCommand<number>('some_count', {})).toBe(0);
  });

  it('对照臂一：对象正文照旧拆包（这条修复不许把正常载荷弄坏）', async () => {
    reply('{"id":"x","title":"甲"}');
    expect(await callCommand<{ id: string }>('get_note', { id: 'x' })).toEqual({ id: 'x', title: '甲' });
    reply('{"ok":true,"payload":{"id":"y"}}');
    expect(await callCommand<{ id: string }>('get_note', { id: 'y' })).toEqual({ id: 'y' });
  });

  it('对照臂二：解析不动的原文留着（壳内对话框给的是裸路径，不是 JSON）', async () => {
    reply('D:/x/备份.zip');
    expect(await callCommand<string>('pick_thing', {})).toBe('D:/x/备份.zip');
  });

  it('对照臂三：4xx 的拒绝载荷仍折成 BridgeError（错误那一支不经过这次的改动也不能变）', async () => {
    reply('{"code":"not_found","messageKey":"cmd.not_found","retryable":false}', 400);
    await expect(callCommand('delete_note', { id: 'x' })).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('系统文件对话框（G75）', () => {
  it('浏览器通道：unavailable 且一个 invoke 都不发（插件 IPC 只在壳里）', async () => {
    asBrowser();
    const r = await pickSavePath('', [{ name: 'z', extensions: ['zip'] }]);
    expect(r).toEqual({ kind: 'unavailable', why: 'not-in-tauri' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('壳内 save：命令名与选项逐字对齐（少一个依赖，命令名就写在调用点上）', async () => {
    asTauri();
    invoke.mockResolvedValue('D:/x/备份.zip');
    const r = await pickSavePath('D:/seed.zip', [{ name: 'Noto 备份包（.zip）', extensions: ['zip'] }]);
    expect(r).toEqual({ kind: 'picked', path: 'D:/x/备份.zip' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invoke.mock.calls[0];
    expect(cmd).toBe('plugin:dialog|save');
    expect(payload).toEqual({
      options: { defaultPath: 'D:/seed.zip', filters: [{ name: 'Noto 备份包（.zip）', extensions: ['zip'] }] },
    });
  });

  it('壳内 open：单文件、非目录（这两个参数错了会在真壳里变成"选目录时也当文件"）', async () => {
    asTauri();
    invoke.mockResolvedValue('C:/a.enex');
    await expect(pickOpenPath([{ name: 'n', extensions: ['enex'] }])).resolves.toEqual({ kind: 'picked', path: 'C:/a.enex' });
    const [cmd, payload] = invoke.mock.calls[0];
    expect(cmd).toBe('plugin:dialog|open');
    expect(payload).toEqual({
      options: { multiple: false, directory: false, filters: [{ name: 'n', extensions: ['enex'] }] },
    });
  });

  it('取消（null）与空串都算 cancelled —— 那是用户的决定，不是错误', async () => {
    asTauri();
    invoke.mockResolvedValueOnce(null);
    await expect(pickOpenPath([{ name: 'n', extensions: ['zip'] }])).resolves.toEqual({ kind: 'cancelled' });
    invoke.mockResolvedValueOnce('   ');
    await expect(pickOpenPath([{ name: 'n', extensions: ['zip'] }])).resolves.toEqual({ kind: 'cancelled' });
  });

  it('被 ACL 拒（G75 的 before 原文）⇒ unavailable 且带着原文，绝不静默', async () => {
    asTauri();
    invoke.mockRejectedValue(
      new Error('dialog.save not allowed. Permissions associated with this command: dialog:allow-save, dialog:default'),
    );
    const r = await pickSavePath('', [{ name: 'n', extensions: ['zip'] }]);
    expect(r.kind).toBe('unavailable');
    expect((r as { why: string }).why).toContain('not allowed');
  });
});
