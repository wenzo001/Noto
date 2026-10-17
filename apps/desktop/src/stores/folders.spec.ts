/**
 * 文件夹树规范化。这里刻意用**真桥原样吐出来的 JSON**（不是手搓的理想形状）：
 * /cmd/list_folders 下发的是嵌套树，而曾经只有平铺输入被测过 —— 于是测试全绿、
 * 产品里子文件夹却整个隐形（侧栏、"移动到"下拉、导出选择器都只剩根）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { stubLocalService, stubServiceDown } from '../testing/http';
import { buildTree, flattenTree, useFolderStore } from './folders';

/** 形状与键名照抄 dev 桥响应，含 null 的 color / systemKind。 */
function treeNode(id: string, parentId: string | null, name: string, children: unknown[] = []): Record<string, unknown> {
  return { children, color: null, id, name, noteCount: 0, parentId, systemKind: null };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('超过 64 个文件夹（缺口 G132 的现场）', () => {
  /**
   * `flattenTree` 里那个 `limit = 64` **不是产品决定**，是函数自己的默认值，
   * 而它喂的是四个用户看得见的面：侧栏文件夹列表（`FolderTree.vue:42`）、
   * 「移到」下拉（`WorkspaceView.vue:52`）、导出选择器（`SettingsView.vue:738`）、
   * 删除确认里那句"东西会去哪"（`FolderTree.vue:170` 取 `defaultNode`）。
   * 规范 §7 把"文件夹选择器 64 条硬上限"列成**未决**（"这些格子上先别作画"），
   * 核心侧一条限制都没有（全仓 grep `MAX_FOLDER` / `folder_limit` 为空）——
   * 于是今天的事实是：界面在没人拍过的情况下静默裁掉了第 65 个之后的文件夹。
   * §5「文本裁切不许静默裁掉」管的就是这一族。
   */
  it('121 个文件夹要一个都不隐形，`byId` 与 `defaultNode` 也不许被上限摘掉', async () => {
    const kids = Array.from({ length: 120 }, (_, i) =>
      treeNode(`f${i}`, null, `夹${String(i).padStart(3, '0')}`),
    );
    const tree = [...kids, { ...treeNode('default', null, '默认本'), systemKind: 'default' }];
    stubLocalService({ list_folders: () => tree });
    const folders = useFolderStore();
    await folders.load();
    expect(folders.flat.length).toBe(121);
    expect(folders.byId.size).toBe(121);
    // 排在第 65 个之后的那一个，也得能被查到 —— 它就是「移到」下拉里消失的那一类
    expect(folders.byId.get('f119')?.node.name).toBe('夹119');
    expect(folders.defaultNode?.node.id).toBe('default');
  });

  /** 「默认本」被排在第 65 个之后时，删除确认里那句"东西会去哪"就取到空字符串。 */
  it('默认本排在第 65 个之后时也要认得它（那是删除确认里唯一的落点）', async () => {
    // 一条 121 层深的链：桥下发的是**嵌套**树，所以从链尾往回包 children；
    // 深度优先遍历 ⇒ 链尾那一个天然排在第 121 位，不靠中文排序的运气
    let children: unknown[] = [];
    const root = (() => {
      let node: Record<string, unknown> = { ...treeNode('c120', 'c119', '层120', []), systemKind: 'default' };
      children = [node];
      for (let i = 119; i >= 0; i -= 1) {
        node = treeNode(`c${i}`, i === 0 ? null : `c${i - 1}`, `层${i}`, children);
        children = [node];
      }
      return node;
    })();
    stubLocalService({ list_folders: () => [root] });
    const folders = useFolderStore();
    await folders.load();
    expect(folders.flat.length, '链上 121 层一个都不许隐形').toBe(121);
    expect(folders.defaultNode?.node.id, '排在第 121 位的默认本也必须被认出来').toBe('c120');
  });

  /** 直接对导出的纯函数下手：**默认值不许是一个静默的截断**。 */
  it('`flattenTree` 不传 limit 时不许截断 —— 64 不是产品决定，是函数自己的默认值', () => {
    const kids = Array.from({ length: 121 }, (_, i) => treeNode(`k${i}`, null, `夹${String(i).padStart(3, '0')}`));
    expect(flattenTree(buildTree(kids)).length).toBe(121);
    // 而**显式**要限流是另一件事：给了数字就照办
    //（§7 那一格真要拍"选择器只列前 N 条"，得连"还有 M 条"一起画，先例是 §3.3 搜索回满那一句）
    expect(flattenTree(buildTree(kids), 10).length).toBe(10);
  });
});

describe('后端给的嵌套树', () => {
  it('子层一个都不许丢，顺序按深度优先', async () => {
    const tree = [
      treeNode('root', null, '默认本', [
        treeNode('a', 'root', '项目', [treeNode('b', 'a', '细节')]),
        treeNode('c', 'root', '会议'),
      ]),
    ];
    stubLocalService({ list_folders: () => tree });
    const folders = useFolderStore();
    await folders.load();
    // 同级按名称排序（zh 校对），所以这里钉的是"谁在、第几层、路径是什么"，不是 DFS 顺序
    expect(folders.flat.map((entry) => `${entry.depth}:${entry.node.name}`).sort()).toEqual(
      ['0:默认本', '1:会议', '1:项目', '2:细节'].sort(),
    );
    expect(folders.byId.get('b')?.path.join(' / ')).toBe('默认本 / 项目 / 细节');
    expect(folders.byId.get('c')?.path.join(' / ')).toBe('默认本 / 会议');
  });

  it('同一棵树不论先给父还是先给孙都能拼好', () => {
    const parent = treeNode('a', null, '父', [treeNode('b', 'a', '子')]);
    expect(buildTree([parent]).flatMap((r) => (r.children ?? []).map((c) => c.name))).toEqual(['子']);
    expect(buildTree([treeNode('b', 'a', '子'), parent]).flatMap((r) => (r.children ?? []).map((c) => c.name))).toEqual(['子']);
  });

  it('自环不许把树撑爆', () => {
    const loop = treeNode('x', 'x', '自环');
    const built = buildTree([loop]);
    expect(built.map((n) => n.id)).toEqual(['x']);
  });

  /**
   * 0.0.66（缺口 G63）起这是一格**可达状态**：核心交给界面的那一排不再含回收站里的文件夹，
   * 而对端把某个父级打成墓碑时不会替本机重新挂子层（`apply` 只写 `deleted_at`）。
   * 于是"父不在这一排里、子还在"必须顶到最上面 —— 静默丢掉就是"文件夹连同里面的笔记一起消失"。
   */
  it('父不在这一排里（被回收站滤掉）时，子层顶到最上面而不是消失', async () => {
    stubLocalService({ list_folders: () => [treeNode('root', null, '默认本'), treeNode('kid', 'gone', '无父的子层')] });
    const folders = useFolderStore();
    await folders.load();
    expect(folders.flat.map((entry) => `${entry.depth}:${entry.node.name}`).sort()).toEqual(
      ['0:无父的子层', '0:默认本'].sort(),
    );
  });
});

/**
 * §6-11「颜色」的调用边（第 39 刀）。
 *
 * 这里钉的是**这次调用发没发、发的形状对不对**，不是核心那一位列存没存下（后者由
 * `crates/notera-host/tests/folder_color.rs` 拿真序列化输出验）。绿单测掩盖坏调用边是
 * 本仓库反复栽过的一族：色点画得出来，前提是界面把 `set_folder_color` 按这个名字、
 * 这两个键发出去。
 */
describe('给文件夹上色', () => {
  it('按命令名与两个键发出去，且树上那一行立刻跟着变', async () => {
    const svc = stubLocalService({
      list_folders: () => [treeNode('root', null, '默认本', [treeNode('a', 'root', '项目')])],
      set_folder_color: () => ({ ...treeNode('a', 'root', '项目'), color: '#c2410c' }),
    });
    const folders = useFolderStore();
    await folders.load();
    await folders.setColor('a', '#c2410c');
    expect(svc.callsOf('set_folder_color').length, '一次都没发命令：色点是画上去的假象').toBe(1);
    expect(svc.lastArgsOf('set_folder_color')).toEqual({ color: '#c2410c', id: 'a' });
    expect(folders.byId.get('a')?.node.color).toBe('#c2410c');
  });

  it('清掉颜色发的是 null，不是空串', async () => {
    const svc = stubLocalService({
      list_folders: () => [treeNode('a', null, '项目')],
      set_folder_color: () => treeNode('a', null, '项目'),
    });
    const folders = useFolderStore();
    await folders.load();
    await folders.setColor('a', null);
    expect(svc.lastArgsOf('set_folder_color')).toEqual({ color: null, id: 'a' });
    expect(folders.byId.get('a')?.node.color ?? null).toBe(null);
  });

  /** 失败时不许先把点抹掉再报错：那会让用户以为是自己点错了，而且下一次同步会拿这个假状态去比。 */
  it('命令没成（本地服务不在）时那一行保持原色，并把错留给界面说', async () => {
    stubLocalService({ list_folders: () => [{ ...treeNode('a', null, '项目'), color: '#1e40af' }] });
    const folders = useFolderStore();
    await folders.load();
    expect(folders.byId.get('a')?.node.color).toBe('#1e40af');
    stubServiceDown();
    await folders.setColor('a', '#c2410c');
    expect(folders.byId.get('a')?.node.color, '发失败了却已经把颜色改掉 —— 屏幕说的是假话').toBe('#1e40af');
    expect(typeof folders.errorKey === 'string' && folders.errorKey.length > 0, '失败没留下任何可显示的错误键').toBe(true);
  });
});
