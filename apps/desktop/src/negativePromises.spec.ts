// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 规范里"不许有 / 不画 / 不渲染"那一族 —— 四条**否定式承诺**第一次各有执行者：
 *
 *  - **§2.5**「禁用态不画灰图标。能力不存在就根本不渲染那颗控件」：
 *    这一句的来历是规范自己写的教训（每一颗假开关被 fake-true 之后又删除）。
 *    判法：`:disabled` 的表达式里**不许**出现能力位（那是"画一颗灰的骗人"），
 *    能力位只能出现在 `v-if` 上（不渲染）。正向对照用"确有 `v-if` 绑能力位"来证明这条扫的是真机制。
 *  - **§4.5**「没有「全部用远端覆盖」这类批量动作（刻意不做）」：
 *    把冲突面板那几颗动作**做成集合**钉住 —— 多一颗（哪怕叫「全部…」）就红，少一颗也红
 *    （只判"没有批量"的那一类写法会在改名为 `conflict-overwrite-all` 时静默通过）。
 *  - **§4.7**「传输安全 ≠ 本地静态加密。本地库加密未实现 ⇒ 界面上任何『本地数据已加密』的说法都是假话」。
 *  - **§4.8**「导出：一种格式（系统自有 ZIP 包）。没有 Markdown / HTML / PDF / 纯文本导出」。
 *
 * 四条都是**读磁盘字节**（同 `motion.spec.ts` 的理由：`?raw` glob 对刚改写的文件会读旧/读空，
 * 而这一族判据全部要靠"往源文件里加一条违规"来验它有没有牙）。
 * 每条都配**正向对照**：先证明那个词/那颗键真的在文件里被读到，再断言它不在该在的地方 ——
 * 少了对照，"整个文件没扫到任何东西"与"承诺成立"长得一模一样。
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/**
 * 去注释：**只删"从行首开批"的块注释**。行中间的 `/*` 不算注释开头 ——
 * `settings.proxyBypass` 的值里就写着 `/*.域名`，把它当开把会把 297→388 整段涂黑：
 * 我因此扫到"0 条 sidebar.color*"，而那十行明明躺在文件里（同一族坑与 `awk` 字段错位那次一样，
 * 是仪器坏了不是产品没有）。行注释与 `<!-- -->` 同样只认行首。
 */
function stripComments(text: string): string {
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*<!--[\s\S]*?-->$/gm, '');
}

/** 递归枚举目录里的文件（相对 `src/`），只留给定后缀。 */
function listFiles(ext: string[], dir = SRC, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(ext, join(dir, entry.name), rel));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** i18n 的 `'key': 'value'` 对（这个文件就是这一种形状，不需要 AST）。 */
function i18nPairs(): Array<{ key: string; value: string }> {
  const text = stripComments(read('i18n.ts'));
  return [...text.matchAll(/'([a-zA-Z][\w.]*?)'\s*:\s*'([^']*)'/g)].map((m) => ({ key: m[1], value: m[2] }));
}

/** 全仓的 `data-testid` 值（去注释后扫；模板串那种 `` `x-${id}` `` 不匹配，落不进名单也不该落进）。
 *  §3.3 与 §6 标签那一格都用这一份名单 —— 两处各写一遍抽取器迟早会长成两套口径。 */
function allTestIds(): string[] {
  const ids: string[] = [];
  for (const rel of listFiles(['.vue', '.ts'])) {
    const text = stripComments(read(rel));
    for (const m of text.matchAll(/data-testid="([^"$`]+)"/g)) ids.push(m[1]);
  }
  return ids;
}

describe('§2.5 能力不存在的控件必须不渲染（不许画一颗灰的骗人）', () => {
  const CAPABILITY = /\bcaps\b|capabilit|tray|globalShortcut|nativeMenu|notification|keychain|windowChrome|transparency|libraryReadOnly/i;
  const files = listFiles(['.vue']);
  const disabledHits: string[] = [];
  let vIfOnCaps = 0;
  for (const rel of files) {
    const text = stripComments(read(rel));
    for (const m of text.matchAll(/:disabled="([^"]*)"/g)) {
      if (CAPABILITY.test(m[1] ?? '')) disabledHits.push(`${rel} :disabled="${m[1]}"`);
    }
    for (const m of text.matchAll(/v-if="([^"]*)"/g)) {
      if (CAPABILITY.test(m[1] ?? '')) vIfOnCaps += 1;
    }
  }
  it('正向对照：能力位确实被用在 `v-if` 上（否则下面那条"零违规"可能只是没扫到机制）', () => {
    expect(files.length, '一个 .vue 都没扫到').toBeGreaterThan(10);
    expect(vIfOnCaps, '全工程没有一处 `v-if` 绑能力位 ⇒ 这条判据无从成立').toBeGreaterThan(0);
  });
  it('没有任何一颗控件靠 `:disabled` 表达"这台设备没这个能力"', () => {
    expect(disabledHits, JSON.stringify(disabledHits)).toEqual([]);
  });
});

/**
 * §6 那张"已声明但零消费者的能力位"清单（规范原话：**生物识别 · 系统分享 · 文件选择器 · 紧凑工具条 ·
 * 安全区 · 拖放** —— "在这些被真正接上之前不许画对应控件"）。
 *
 * 上面那条 §2.5 拦的是"画一颗灰的骗人"，**拦不住这一格**：一颗 `v-if="caps.compactToolbar"` 的控件
 * 完全满足 §2.5（不渲染就不骗人），但它违反的是 §6 —— 因为那个能力**根本还没接**。
 * 这是两句不同的承诺：§2.5 说"别骗人"，§6 说"别发明"。
 *
 * 判法：每个键在**界面侧**（`.vue` 与 `stores` / `api` / `editor` 那些 `.ts`，排除 `platform/caps.ts`
 * 自己与所有 `.spec.ts`）的读者必须为零；唯一例外走台账，并且**台账每一条都要真命中**
 * （登记了又不存在 ⇒ 红，撤了又冒出来 ⇒ 也红 —— 同 `iconSystem.spec.ts` 那一族）。
 *
 * 今天的实测：`dragAndDrop` 已真接上（`RichEditor.vue:612,633` 那个 drop 处理器），其余五个键全仓零读者。
 * ⚠ 所以 §6 那一行把 `拖放` 也列进"零消费者"是**规范清单过期**，不是这里多放行了一格 —— 更正记在
 * `SPEC-AMENDMENTS.md` 的 A5，别照着那一行去删处理器。
 */
describe('§6 零消费者的能力位：真接上之前不许在界面里露头', () => {
  const SIX = ['biometric', 'shareSheet', 'filePicker', 'compactToolbar', 'safeArea', 'dragAndDrop'];
  const WIRED: Array<{ key: string; why: string }> = [
    { key: 'dragAndDrop', why: 'RichEditor.vue 的 drop 处理器（真读者、真行为 —— 任务 #36 与腿 ㊴）' },
  ];

  /** 三种读法：`caps.k` / `caps['k']` / 解构 `{ k } = …caps`。少认一种就是给违规留一扇门。 */
  const readerRe = (key: string): RegExp =>
    new RegExp(`caps\\s*\\.\\s*${key}\\b|caps\\[\\s*['"]${key}['"]\\s*\\]|\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*=\\s*[^;\\n]*caps`);

  const viewFiles = listFiles(['.vue', '.ts']).filter(
    (rel) => !rel.endsWith('platform/caps.ts') && !rel.endsWith('.spec.ts'),
  );
  const hitsOf = (key: string): string[] => {
    const re = readerRe(key);
    const out: string[] = [];
    for (const rel of viewFiles) {
      if (re.test(stripComments(read(rel)))) out.push(rel);
    }
    return out;
  };

  it('仪器自检：六个键名都真的在 PlatformCaps 接口里，界面侧也真扫到了文件（名单不是手抄的 fiction）', () => {
    const iface = /interface PlatformCaps\s*\{([\s\S]*?)\n\}/.exec(stripComments(read('platform/caps.ts')))?.[1] ?? '';
    expect(iface.length, '读不到 PlatformCaps 那个接口块').toBeGreaterThan(40);
    for (const key of SIX) {
      expect(new RegExp(`(^|\\n)\\s*${key}:`).test(iface), `规范 §6 列的 ${key} 在 caps.ts 里根本没有这一位`).toBe(true);
    }
    expect(viewFiles.length, '界面侧一个文件都没扫到').toBeGreaterThan(15);
  });

  it('牙齿：三种读法的合成串都要被抓到，而别的键不许被误伤（不碰源文件）', () => {
    for (const sample of [
      '<button v-if="caps.shareSheet">',
      "<button v-if=\"caps['shareSheet']\">",
      'const { shareSheet } = store.caps;',
    ]) {
      expect(readerRe('shareSheet').test(sample), `这种写法抓不到：${sample}`).toBe(true);
    }
    expect(readerRe('shareSheet').test('<button v-if="caps.tray">'), '误伤了别的能力位').toBe(false);
  });

  /**
   * §6 那条"别发明"最省事的绕法不是 `caps.safeArea`（上面那条腿抓得到），而是**把整张能力表通用渲染**：
   * `Object.keys(caps)` 列成一排开关、`caps[name]` 用变量当下标、`v-for="c in caps"` ——
   * 三种写法里没有任何键名出现，所以 `readerRe` 那把尺子量到的是"零读者"，而实际上每一位都被读了。
   * 2026-10-16 撤回报错那条 #88 时扫的就是这一格：当时**确实不存在**这种写法，但**没有东西守着它不许出现**。
   */
  const genericRe = /Object\.(?:keys|entries|values)\s*\(\s*[^)]*\bcaps\b|\bcaps\s*\[\s*[A-Za-z_$][\w$]*\s*\]|\bv-for="[^"]*\bcaps\b/;

  it('牙齿（不碰源文件）：通用渲染那三种写法都要被抓，而字面量下标那种合法读法不许误伤', () => {
    for (const sample of [
      'const keys = Object.keys(settings.caps);',
      'const shown = Object.entries(caps).map(([k, v]) => k);',
      'const value = caps[name];',
      '<li v-for="c in caps" :key="c">{{ c }}</li>',
    ]) {
      expect(genericRe.test(sample), `这种绕法抓不到：${sample}`).toBe(true);
    }
    for (const sample of ['caps["safeArea"]', "caps['compactToolbar']", 'capsMap[3]']) {
      expect(genericRe.test(sample), `误伤了字面量/别的下标：${sample}`).toBe(false);
    }
  });

  it('通用渲染今天必须不存在：界面侧不许把整张能力表读成控件（§6 的绕法口）', () => {
    const offenders: string[] = [];
    for (const rel of viewFiles) {
      if (genericRe.test(stripComments(read(rel)))) offenders.push(rel);
    }
    expect(offenders, `界面侧出现"整表读 caps"的写法 —— 那会让没接的能力位自己长出控件：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('没登记成"真接上"的那几个键，界面侧一处都不许读它；登记的那条必须真命中', () => {
    const unregistered = SIX.filter((k) => !WIRED.some((w) => w.key === k));
    const exposed = unregistered.flatMap((k) => hitsOf(k).map((rel) => `${k}@${rel}`));
    expect(exposed, `这些能力位还没实现就被界面读了（§6：不许画对应控件）：${JSON.stringify(exposed)}`).toEqual([]);
    const stale = WIRED.filter((w) => hitsOf(w.key).length === 0);
    expect(stale, `台账里这几条已经不成立了（处理器被撤掉了就删账）：${JSON.stringify(stale.map((s) => s.key))}`).toEqual([]);
  });
});

/**
 * §4.9 那句「禁用态不写"为什么不能点" —— 那是把责任推给用户。**要么给出原因文案，
 * 要么在条件不满足时根本不渲染这颗控件**」（规范原话，两臂择一）。
 *
 * 以前这一句**只有后半个分支有人**：`negativePromises.spec.ts` 的 §2.5 那族守的是"能力不存在就不渲染"，
 * 而"用户可控的条件把那颗按钮禁死了、屏幕上却一个字没说"这一臂**零证人**（审计第 8 条）。
 *
 * 数过之后这一格的面积其实**很小**（按上面那把同一分类尺子数的，25 处匹配，不是 grep 的行数）：
 * · **8 处**是共享组件的透传（`props.disabled` / `isDisabled` / `readOnly` / `props.confirmDisabled`）—— 条件不在这里，
 *   主语在调用点，这里量了也不算数；
 * · **13 处**是瞬态的"正在忙"（`settings.dataBusy` ×9、`attBusy !== null` ×2、`sync.busy`、`settings.accountSaving`）——
 *   这一族是不是"不需要原因文案"是一个**口径**，不是我量出来的事实，登记成 D14 等拍；
 * · **3 处**是 `!canEdit`（`WorkspaceView.vue`）—— 那三颗对应 §4.2 的只读四行，"说清为什么"那一半
 *   已由 §4.2 的执行者守着（见 `SPEC-GAP-AUDIT-2026-10-14.md` 末尾那份"不该再报"清单），不在这一格里重复钉；
 * · **1 处是用户可控条件把动作禁死了**：`SidebarPanel.vue` 那颗新建/重命名弹窗的
 *   `:confirm-disabled="newName.trim().length === 0"`，而那个 `<AppDialog>` 里**没有任何一句原因**。
 *
 * 所以这一族只钉那 1 处的形状："同一份 template 里必须有一句可见文案共用同一个条件"，
 * 并且把今天这处缺陷走**可证伪台账**（缺陷被修掉 ⇒ 台账不命中 ⇒ 红，逼着撤账；
 * 新长出一处没修的 ⇒ 不在台账 ⇒ 红）。这样这条腿既不是"已经做到了"的假话，也不会变成没人守的空话。
 */
describe('§4.9 禁用态的两臂：把动作禁死了就得说一句为什么（不许两臂都不选）', () => {
  const viewFiles = listFiles(['.vue']);

  type Site = { rel: string; expr: string; hasReason: boolean };
  /** `:confirm-disabled="…"` 的调用点 + 同一份模板里是否有另一处 `v-if` 引用同一个变量并渲染文字。 */
  const sites = (): Site[] => {
    const out: Site[] = [];
    for (const rel of viewFiles) {
      const text = stripComments(read(rel));
      for (const m of text.matchAll(/:confirm-disabled="([^"]*)"/g)) {
        const expr = m[1] ?? '';
        // 条件里出现的标识符（newName.trim() ⇒ newName）
        const ids = [...expr.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g)].map((x) => x[1] ?? '');
        const shared = new Set(['trim', 'length', 'value', 'toString', 'includes', 'size', 'not', 'null', 'undefined', 'true', 'false']);
        const vars = ids.filter((i) => !shared.has(i));
        const hasReason = [...text.matchAll(/v-if="([^"]*)"/g)].some((v) => {
          const cond = v[1] ?? '';
          return vars.some((x) => new RegExp(`\\b${x}\\b`).test(cond));
        });
        out.push({ rel, expr, hasReason });
      }
    }
    return out;
  };

  /**
   * 已知缺陷台账（**不是豁免**：它记的是"这一处还没修"）。
   * 2026-10-14 第七十三批：`SidebarPanel.vue` 那颗「确认」的原因文案补上了（同一条件的 `.field-hint`），
   * 所以这一条**按台账要求撤掉** —— 留着不撤会被 `unused` 那条判据红。
   * 台账现在是空的：这一族的形状仍由"多一处没修就红"（`extra`）与上面那条合成串牙齿守着。
   */
  const REGISTERED: Array<{ rel: string; expr: string }> = [];

  it('仪器自检：这一族真扫到了调用点（扫到 0 处与"承诺成立"长得一模一样）', () => {
    expect(viewFiles.length, '一个 .vue 都没扫到').toBeGreaterThan(10);
    expect(sites().length, '一处 `:confirm-disabled` 都没扫到 ⇒ 下面两条都是空转').toBeGreaterThanOrEqual(1);
  });

  it('牙齿：同一份模板里有一句共用条件的文案，就必须放行（合成串，不碰源文件）', () => {
    const pair = '<AppDialog :confirm-disabled="x.length === 0" /><p v-if="x.length === 0">名字还空着。</p>';
    const alone = '<AppDialog :confirm-disabled="x.length === 0" /><p>随便一句不相干的话</p>';
    const guarded = (t: string): boolean => {
      const expr = /:confirm-disabled="([^"]*)"/.exec(t)?.[1] ?? '';
      const vars = [...expr.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g)].map((m) => m[1] ?? '')
        .filter((i) => !['length', 'trim', 'value', 'null'].includes(i));
      return [...t.matchAll(/v-if="([^"]*)"/g)].some((v) => vars.some((x) => new RegExp(`\\b${x}\\b`).test(v[1] ?? '')));
    };
    expect(guarded(pair), '有共用条件的文案却被判成缺原因').toBe(true);
    expect(guarded(alone), '没有文案却放行 ⇒ 这条腿没有牙').toBe(false);
  });

  it('把动作禁死又没有原因的那一处，必须正是台账里那一条（多一处红、被修掉了也红）', () => {
    const bad = sites().filter((s) => !s.hasReason).map((s) => ({ rel: s.rel, expr: s.expr }));
    const same = (a: { rel: string; expr: string }, b: { rel: string; expr: string }) => a.rel === b.rel && a.expr === b.expr;
    const extra = bad.filter((b) => !REGISTERED.some((r) => same(r, b)));
    const unused = REGISTERED.filter((r) => !bad.some((b) => same(b, r)));
    expect(extra, `新长出一处"禁死了却不说为什么"（§4.9 两臂都不选）：${JSON.stringify(extra)}`).toEqual([]);
    expect(unused, `台账里这几处已经不成立了（原因文案补上了就撤账）：${JSON.stringify(unused.map((u) => u.rel))}`).toEqual([]);
  });
});

describe('§4.5 冲突面板的动作恰好是"逐条"那三颗（批量动作是刻意不做的）', () => {
  const text = read('views/ConflictsView.vue');
  const buttons = [...text.matchAll(/<button[^>]*data-testid="(conflict-[a-z-]+)"[^>]*>/g)].map((m) => m[1]);
  const ALLOWED = ['conflict-keep-both', 'conflict-manual-merge', 'conflict-open-note'];
  it('仪器自检：这一屏真的扫到了动作按钮（扫到 0 颗不算"没有批量动作"）', () => {
    expect(buttons.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });
  it('动作集合与规范一致：多一颗就红（包括「全部用远端覆盖」那一类），少一颗也红', () => {
    expect([...new Set(buttons)].sort(), JSON.stringify(buttons)).toEqual([...ALLOWED].sort());
  });
});

/**
 * §0.2「界面不许说协议话」—— 规范那一条点名九个词，并且**自己声称"有 eslint + grep 门禁"**。
 * 那半句在今天是不成立的：`arch-check` 的 `layer:ui-protocol-vocab` 扫的是**另一份名单**
 * （`arch-check.mjs:267` 那一行，全是线协议上的方法名与头字段，一个中文字都没有）落在源码里，
 * 与这九个字不是同一份名单；`eslint.config.js`
 * 里一条词汇禁令都没有 ⇒ 这一格就是那份承诺的执行者。
 *
 * 面为什么只取 i18n 的**值**：`arch-check` 的 `hygiene:rust-message-keys-registered` 已经钉住
 * "文案键唯一登记处 = `i18n.ts`"，所以扫这一份就是扫用户可见文案（模板里另写一句的说法本身就被那条门拦住）。
 *
 * 「清单」为什么不能一刀切：它在界面上有三种**正当**用法（待办清单 / 编辑器的勾选块 / 备份清单），
 * 整词禁掉会红三处合法现场 —— 扫到一片红同样不等于抓对了。于是它只在"被用来称呼 manifest 那个内部对象"
 * 的那一族键里禁：同步那一族（`sync.`）与错误码发下来的键。⚠ `sync.cap.strongEtag` 与 `sync.divergence`
 * 这两句到屏幕的路都是**间接**的（前者 `serverCaps.ts` 动态拼键、后者 `notera-core/src/error.rs` 的错误码注册表），
 * 所以"grep 键名找不到消费者"在这里等于假阴性 —— 判据只看文案本身，不看它怎么被取到。
 */
describe('§0.2 界面不许说协议话（九个词不许出现在用户可见文案）', () => {
  /** 名单逐字抄自规范 §0.2 那一行，**不许由被测文案反推**（那等于让被测对象给自己出题）。 */
  const HARD = /\bWebDAV\b|\bETag\b|\bmanifest\b|\btombstone\b|\brevision\b|\bpull\b|\bpush\b|墓碑/i;
  const SYNC_FAMILY = /^(sync|error)\./;
  const hits = (pairs: Array<{ key: string; value: string }>): string[] =>
    pairs
      .filter((p) => HARD.test(p.value) || (SYNC_FAMILY.test(p.key) && p.value.includes('清单')))
      .map((p) => `${p.key}=${p.value}`);

  it('仪器自检：这一族面真的在盘上（否则"零违规"与"什么都没扫到"长得一模一样）', () => {
    const pairs = i18nPairs();
    expect(pairs.length, 'i18n 的键值对数量').toBeGreaterThan(400);
    // 反例证人必须在场：这三处的「清单」是正常中文，不许被这把刀碰
    for (const k of ['template.todo', 'tb.checklist', 'settings.backupLoading']) {
      expect(pairs.some((p) => p.key === k && p.value.includes('清单')), `${k} 必须还在说「清单」`).toBe(true);
    }
    expect(pairs.some((p) => p.key.startsWith('sync.')), '同步那一族必须在场').toBe(true);
  });

  it('牙齿：三种说法都要被同一把尺子抓到（合成串，不碰源文件）', () => {
    const caught = hits([
      { key: 'sync.probe', value: '服务器的 ETag 对不上' },
      { key: 'settings.addr', value: '你的 WebDAV 地址' },
      { key: 'sync.diverge', value: '远端的清单与本机对不上' },
    ]);
    expect(caught.length, '三句假话必须全被抓到').toBe(3);
    // 而合法的那三处「清单」与一句普通的"拉取更新"式中文不许误伤
    expect(
      hits([
        { key: 'template.todo', value: '待办清单' },
        { key: 'tb.checklist', value: '清单' },
        { key: 'settings.backupLoading', value: '正在读这台设备的备份清单…' },
        { key: 'list.newNote', value: '新建笔记' },
      ]),
      '反例证人被误伤了',
    ).toEqual([]);
  });

  it('今天没有任何一句用户可见文案在说协议话', () => {
    expect(hits(i18nPairs()), '这些句子把内部对象说给了用户听').toEqual([]);
  });
});


describe('§4.7 界面不许说"本地数据已加密"（本地库加密未实现）', () => {
  const pairs = i18nPairs();
  const CLAIM = /本地[^']{0,10}加密|已加密|静态加密|存储加密|at[\s-]?rest/i;
  it('正向对照：文案里确实出现过「加密」这个词（这条判的不是"整个文件没有这个字"）', () => {
    expect(pairs.length).toBeGreaterThan(100);
    expect(pairs.filter((p) => p.value.includes('加密')).length).toBeGreaterThanOrEqual(2);
  });
  it('没有任何一句文案把"本地已加密"说成事实', () => {
    const hits = pairs.filter((p) => CLAIM.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §6-7 + §7「端到端加密」—— 2026-10-14 用户拍**不开放**（裁定写进 `docs/design/SPEC-AMENDMENTS.md` A4）：
 * 原语层全部做完（AES-256-GCM-SIV、24 个恢复词、密钥轮换、无密钥设备检测）而**零界面入口**，
 * 规范 §8 第三问禁的正是"画出不存在的功能"。
 *
 * ⚠ 这一格在拍板之前**没有守卫**：§4.7 那条 CLAIM 抓的是"本地已加密"那种谎，
 * 有人把"开启 → 派生 → 展示恢复词 → 解锁"那套接上，现有门禁全部照绿。
 * 一个"不做什么"的决定如果没有判据钉住，它就只是那次会话里说过的话 —— 所以先补判据，再改台账。
 * 三面都扫：用户可见文案、控件身份（`data-testid`）、界面侧对那套命令的调用点。
 */
describe('§6-7 端到端加密不开放 ⇒ 界面上不许出现它的任何入口', () => {
  const CLAIM = /端到端加密|端到端密钥|恢复词|开启加密|重新加密|密钥轮换|\bvault\b|e2ee/i;
  const pairs = i18nPairs();
  const ids = allTestIds();
  /** 调用点只扫 `.vue` 与**非测试**的 `.ts`：spec 里出现 `vault` 是"有人在写测试"，不是"界面上有入口"。 */
  const callSites = listFiles(['.vue', '.ts'])
    .filter((rel) => !rel.endsWith('.spec.ts'))
    .flatMap((rel) => {
      const text = stripComments(read(rel));
      const hits: string[] = [];
      for (const m of text.matchAll(/\b(vault|Vault|recoveryWords|derive_key|rotate_key)\b/g)) hits.push(`${rel}:${m[1]}`);
      return hits;
    });
  it('仪器自检：两面都真的读到了东西（文案键 ≥100、testid ≥50 —— 否则"没扫到"与"承诺成立"长得一模一样）', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(100);
    expect(ids.length).toBeGreaterThanOrEqual(50);
  });
  it('牙齿：同一把尺子打得中「加密已开启 / 输入恢复词解锁」这类接线（合成串，不碰源文件）', () => {
    const fake = ['端到端加密已开启', '输入 24 个恢复词解锁这台设备', 'settings.vault.enable', 'vault-status'];
    const caught = fake.filter((s) => CLAIM.test(s));
    expect(caught.length, JSON.stringify({ 打中: caught.length, 样本: fake })).toBe(fake.length);
  });
  it('用户可见文案里没有一句提到这套流程', () => {
    const hits = pairs.filter((p) => CLAIM.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
  it('没有一颗控件带着它的身份（testid 与界面侧调用点两面）', () => {
    const idHits = ids.filter((id) => CLAIM.test(id));
    expect(idHits, `testid：${JSON.stringify(idHits)}`).toEqual([]);
    expect(callSites, `界面侧调用点：${JSON.stringify(callSites.slice(0, 8))}`).toEqual([]);
  });
});

describe('§4.8 导出只有一种格式（不许出现第二种）', () => {
  const pairs = i18nPairs();
  const FORMAT = /markdown|html|pdf|纯文本|\.txt|docx|word/i;
  const exportKeys = pairs.filter((p) => p.key.startsWith('settings.export'));
  const importKeys = pairs.filter((p) => p.key.startsWith('settings.import'));
  it('仪器自检：导出与导入两侧都有键（否则"导出侧没有格式词"是空判据）', () => {
    expect(exportKeys.length).toBeGreaterThanOrEqual(3);
    // 导入侧**合法地**写着 Markdown / .enex —— 它必须被扫到，才证明这条区分了两侧而不是没扫。
    expect(importKeys.filter((p) => FORMAT.test(p.value)).length).toBeGreaterThanOrEqual(1);
  });
  it('导出侧的文案里不许出现第二种格式（Markdown / HTML / PDF / 纯文本都是发明能力）', () => {
    const hits = exportKeys.filter((p) => FORMAT.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §6「明确不做」剩下那几条里，能在这台机器上静态扫出来的三条：厂商账号 / 多账户、服务端搜索、
 * 版本历史上传。形状沿用上面四条（读磁盘字节 + 每条配对照），但这里配**两种**对照，因为这三条
 * 的现实情况是"这个词一辈子没出现过"—— 只断言"扫到 0 处"与"整个判据没牙"长得一模一样：
 *  ① 语料侧对照：被扫的键空间必须真的有内容（搜索/历史这些能力是**做了**的，键一定在）；
 *  ② 牙齿对照：拿同一支正则去打一句**故意写的假话**，必须命中 —— 证明红的是"没有假话"，不是"正则写错了"。
 */
describe('§6 不做厂商账号、不做多账户（只有 WebDAV 那一格自己填地址与账户）', () => {
  const pairs = i18nPairs();
  const VENDOR = /小米|华为|苹果账号|Apple\s?ID|Google\s?(账号|账户)|OneDrive|Dropbox|坚果云|印象笔记|语雀|飞书|WPS\s?云|登录.{0,6}(厂商|第三方|云服务)|切换账号|多账号|多个账号/i;
  it('对照①：文案里"账户/账号"这一族是真在场的（同步账户那几个键）——否则"零违规"只是没扫到东西', () => {
    expect(pairs.filter((p) => p.key.startsWith('settings.account') || /账户|账号/.test(p.value)).length).toBeGreaterThanOrEqual(3);
  });
  it('对照②：这一族写法一旦被说出来，正则必须抓得住（牙齿自检）', () => {
    expect(VENDOR.test('用小米账号登录')).toBe(true);
    expect(VENDOR.test('切换账号')).toBe(true);
  });
  it('没有任何一句文案把厂商登录或多账户说成产品能力', () => {
    const hits = pairs.filter((p) => VENDOR.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§6 搜索只搜本机：不许说"服务器/远端在替你搜"', () => {
  const pairs = i18nPairs();
  // 只钉"搜索这件事发生在服务器那一侧"。`查` 单独进判据会把 §6-9 附件那格「服务器上还没查过」
  // 也圈进来 —— 那一句说的是这份附件的字节在不在远端，与搜索无关（它是下面那条反面对照的对象）。
  const SERVER_SIDE = /(服务器|远端|云端|服务端).{0,8}(搜索|检索|索引)|搜索.{0,6}(来自|在)服务器/i;
  it('对照①：搜索这一族键是真的在场（搜索做了，扫描面不为空）', () => {
    expect(pairs.filter((p) => /search/i.test(p.key) || /搜索/.test(p.value)).length).toBeGreaterThanOrEqual(5);
  });
  it('对照②：正则对"服务端搜索"那句假话必须命中', () => {
    expect(SERVER_SIDE.test('服务器正在为你搜索')).toBe(true);
    expect(SERVER_SIDE.test('搜索结果来自服务器')).toBe(true);
  });
  it('对照③：合法在场的那句"服务器上还没查过"（附件的远端账）不许被误伤', () => {
    const ledger = pairs.find((p) => p.key === 'settings.attRemoteUnknown');
    expect(ledger, '被扫的那一句已经不在了，对照失效').not.toBeUndefined();
    expect(SERVER_SIDE.test(ledger?.value ?? ''), ledger?.value).toBe(false);
  });
  it('没有任何一句文案把搜索说成发生在服务器那一侧', () => {
    const hits = pairs.filter((p) => SERVER_SIDE.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §6 剩下那四条：**代理模式只有那五档**（没有 PAC）、**没有插件系统**、
 * **没有表格单元格级合并**、**没有实时多端光标协同**。
 * 这四条的现实与上面三条一样："这些词一辈子没出现过" ⇒ 只断言"扫到 0 处"与"整个判据没牙"长成一个样，
 * 所以每条都配 ① 语料侧对照（被扫的那一族真有内容）+ ② 牙齿对照（同一支判据必须抓住故意写的假话）。
 * 代理那档不用词表用**集合双向差集**：规范说的是"不做 PAC 执行"，而产品那边是一列**有限选项**
 * —— 有限集合就该按集合判（多一档红、少一档也红），这才分辨得出"偷偷加了一档 pac"。
 */
describe('§6 代理只有那五档：不做 PAC 自动代理脚本执行', () => {
  const src = read('views/SettingsView.vue');
  // 从模板那个 `proxyOptions` 数组里把 `value:` 现取出来（不复制一份常量当判据 —— 那会变成同源自证）
  const extract = (text: string): string[] => {
    const block = /const proxyOptions[^=]*=\s*\[([\s\S]*?)\];/.exec(text);
    if (!block) return [];
    return [...block[1].matchAll(/value:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  };
  const ALLOWED = ['direct', 'system', 'http', 'https', 'socks5'];
  const got = extract(src);
  it('对照①：这一列选项真被扫到了（读到空数组就等于这条从没在看东西）', () => {
    expect(got.length).toBeGreaterThanOrEqual(5);
  });
  it('对照②：牙齿自检 —— 同一支提取器面对"偷偷加了一档 pac"必须抓到（否则"零违规"只是判据没在看）', () => {
    const fake = extract("const proxyOptions: Array<{ value: ProxyMode }> = [\n  { value: 'pac', label: 'settings.proxyPac' },\n  { value: 'socks5', label: 'x' },\n];");
    expect(fake).toContain('pac');
  });
  it('选项集合与规范那一格**双向**一致：多一档（PAC 就在这一刀的形状）红，少一档也红', () => {
    expect([...got].sort()).toEqual([...ALLOWED].sort());
  });
  it('文案侧也不许出现 PAC / 自动配置脚本那一档（用户看得见的那句同样不许发明）', () => {
    const PAC = /PAC|自动代理|代理脚本|自动配置(脚本|文件)/i;
    const hits = i18nPairs().filter((p) => p.key.startsWith('settings.proxy') && PAC.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(PAC.test('使用 PAC 自动代理脚本'), '牙齿：这句假话必须被抓住').toBe(true);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§6 没有插件系统：不许画"安装/启用插件"那一类入口', () => {
  const pairs = i18nPairs();
  const PLUGIN = /(安装|启用|停用|浏览|管理|市场).{0,6}(插件|扩展)|(插件|扩展)(市场|列表|中心|管理)|第三方扩展/i;
  it('对照①：被扫的文案面不为空（工具条与设置这些族都在）', () => {
    expect(pairs.filter((p) => p.key.startsWith('settings.') || p.key.startsWith('toolbar.') || /工具|更多/.test(p.value)).length).toBeGreaterThanOrEqual(10);
  });
  it('对照②：正则对"插件市场""启用扩展"那两句假话必须命中', () => {
    expect(PLUGIN.test('浏览插件市场')).toBe(true);
    expect(PLUGIN.test('启用扩展以增强编辑器')).toBe(true);
  });
  it('没有任何一句文案把插件/扩展说成产品能力', () => {
    const hits = pairs.filter((p) => PLUGIN.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§6 没有表格单元格级合并：「合并」只许是冲突逐条与导入并库那一族', () => {
  const pairs = i18nPairs();
  // 这一条**故意不能写成 /合并/**：产品里 `我来合并`（冲突逐条）、`合并出来的`（副本来源）、
  // `合并进现有库`（导入模式）三句都是合法在场的。判据要钉的是"单元格/表格级合并"那一格。
  const CELL = /(单元格|表格|格子).{0,8}(合并|拆分)|合并.{0,8}(单元格|格子)|单元格级/i;
  it('对照①：合法的「合并」这一族确实在场 —— 这条判的不是"整个文件没有这个字"', () => {
    expect(pairs.filter((p) => /合并/.test(p.value)).length).toBeGreaterThanOrEqual(2);
  });
  it('对照②：正则对"支持单元格级合并"那句假话必须命中', () => {
    expect(CELL.test('表格支持单元格级合并')).toBe(true);
    expect(CELL.test('选中单元格后合并')).toBe(true);
  });
  it('没有任何一句文案把单元格/表格合并说成产品能力', () => {
    const hits = pairs.filter((p) => CELL.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§6 没有多人协作与实时光标：不许说"看见对方在编辑 / 光标在那一侧"', () => {
  const pairs = i18nPairs();
  const COLLAB = /(实时|多人|协同|协作).{0,10}(编辑|光标|在线)|对方(的)?光标|协作者|共同编辑|谁(也)?在(编辑|改)/;
  it('对照①：「同步 / 设备 / 别的设备」这一族在场（同步做了，这一族就是最容易顺手写成"协作"的那族）', () => {
    expect(pairs.filter((p) => /同步|设备/.test(p.value)).length).toBeGreaterThanOrEqual(5);
  });
  it('对照②：正则对"多人实时协作""对方的光标"那两句假话必须命中', () => {
    expect(COLLAB.test('支持多人实时协作编辑')).toBe(true);
    expect(COLLAB.test('你能看到对方的光标')).toBe(true);
  });
  it('没有任何一句文案把实时协作或对方光标说成产品能力', () => {
    const hits = pairs.filter((p) => COLLAB.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('§6 版本历史只在本机：不许说历史被上传/同步到远端', () => {
  const pairs = i18nPairs();
  const UPLOADED = /(历史|版本).{0,10}(上传|同步到|存放在|备份到).{0,8}(服务器|远端|云端)|远端.{0,6}(保留|存).{0,6}历史/i;
  it('对照①：版本历史这一族键是真的在场（§6-8 的浏览与回滚做了）', () => {
    expect(pairs.filter((p) => /histor|版本|历史/i.test(p.key) || /历史|版本/.test(p.value)).length).toBeGreaterThanOrEqual(5);
  });
  it('对照②：正则对"历史已上传"那句假话必须命中', () => {
    expect(UPLOADED.test('历史已上传到服务器')).toBe(true);
    expect(UPLOADED.test('版本记录存放在远端')).toBe(true);
  });
  it('没有任何一句文案把版本历史说成存在服务器那一侧', () => {
    const hits = pairs.filter((p) => UPLOADED.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §3.3 那句「没有筛选器、没有正则、没有按文件夹搜、没有日期分面」—— 四句否定式承诺以前**零证人**
 * （那一节里只有"搜索不搜回收站"那半句有执行者）。
 *
 * 扫**两面**，因为这两面会各自漏：
 *  · **文案面**：一句文案把这四样说成产品能力 = 发明能力（与 §4.8「没有 Markdown/HTML/PDF 导出」同族）；
 *  · **控件面**：画了一颗入口但没起中文名字 —— 文案面干净，入口照样在屏幕上。
 *
 * 载荷面**不重复**：`stores/notes.spec.ts` 已经拿 `toEqual({ text, limit })` 钉死了 `search` 那一发
 * 只有这两位（加一档文件夹范围 / 日期区间 / 正则开关都会红）。这一族的"谁在守什么"写在这儿，
 * 免得下一个人以为还欠着。
 */
describe('§3.3 搜索只有"一个词"这一件事：没有筛选器 / 正则 / 按文件夹搜 / 日期分面', () => {
  const pairs = i18nPairs();
  const searchKeys = pairs.filter((p) => /search|tier/i.test(p.key) || /搜索|找到|没列出来/.test(p.value));
  const BAN_TEXT = /筛选|过滤|正则|\bregex\b|按文件夹搜|限定文件夹|文件夹内搜|分面|分面|facet|日期范围|时间范围|按日期搜|高级搜索/i;
  // 控件面用的是**入口名**（英文 testid），与文案面两套词 —— 一把尺子量不到两边。
  const BAN_TESTID = /(filter|facet|regex|scope|date-?range|advanced)/i;

  it('对照①：搜索那一族的文案真在场（≥5 条）—— 否则"零违规"只是没扫到东西', () => {
    expect(searchKeys.length).toBeGreaterThanOrEqual(5);
  });

  it('对照②：四句假话各打一遍，文案面那条尺子必须句句命中（牙齿自检）', () => {
    for (const lie of ['可以按日期范围筛选', '启用正则搜索', '只在当前文件夹内搜索', '搜索结果按时间分面']) {
      expect(BAN_TEXT.test(lie), lie).toBe(true);
    }
  });

  it('对照③：控件面的尺子既要抓得住假入口，也不许把规范真要求的那几颗拦下来（双向）', () => {
    for (const id of ['search-folder-scope', 'search-date-range', 'regex-toggle', 'result-facet']) {
      expect(BAN_TESTID.test(id), id).toBe(true);
    }
    // 反面对照：这些是**在场的合法名字**，被误伤就说明尺子宽到会把规范要的东西也判成违规。
    for (const okId of ['search-input', 'search-clear', 'search-found', 'search-more', 'search-tier-hint', 'tier-exact', 'tier-fuzzy', 'search-empty']) {
      expect(BAN_TESTID.test(okId), okId).toBe(false);
    }
  });

  it('对照④：抽取器读到的是真名单（≥150 个 testid，且上面那八颗都在里面）—— 抽不到东西的扫描等于没检查', () => {
    const ids = new Set(allTestIds());
    expect(ids.size).toBeGreaterThanOrEqual(150);
    for (const okId of ['search-input', 'search-clear', 'tier-exact', 'tier-fuzzy', 'search-tier-hint']) {
      expect(ids.has(okId), `名单里读不到 ${okId}（选择器或抽取器坏了）`).toBe(true);
    }
  });

  it('主判据·文案面：没有任何一句把筛选器/正则/按文件夹搜/日期分面说成产品能力', () => {
    const hits = pairs.filter((p) => BAN_TEXT.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('主判据·控件面：全仓没有任何一颗入口的名字落进那四个词', () => {
    const hits = [...new Set(allTestIds())].filter((id) => BAN_TESTID.test(id));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

/**
 * §5 / §8 交叉的一格：**注册了却没人引用的文案键**（死键）以前没有执行者。
 * `i18n.spec.ts` 只管反方向（用到的键必须登记），所以"把一句界面说明改掉、屏幕上却一个字没变"没人守 ——
 * 这一族在本仓库里已经撞过好几回（`list.rowsLoaded` 上岗前就是个死键）。
 *
 * 三条口径是这条能不能用的前提（都是量出来的，不是猜的）：
 *  · **前端没有字面引用 ≠ 死键**：核心发出的 `messageKey` 也算消费者 ⇒ 扫 `crates/**` 的字面量。
 *  · **动态拼接**（`` t(`sync.${badge}`) ``、`` labelKey: `editor.origin${…}` ``）要长出**前缀名单**，
 *    且前缀的字符类**必须允许点** —— 第一版我写成 `[a-zA-Z_]+\.`，于是 `sync.cap.` 与 `editor.origin`
 *    两种形状全漏，测出来的"死键"里十分之三是我的抽取器瞎（这条教训进台账）。
 *  · 四本账各配下界自检，再加一条**牙齿自检**：抽取器要认得它声称认得的每一种位置。
 */
describe('§5 文案死键：登记的每一句都必须有人引用（前端字面量 / 核心 messageKey / 动态前缀）', () => {
  const ROOT = join(SRC, '..', '..', '..');

  const registered = new Set(i18nPairs().map((p) => p.key));
  const NAMESPACE_SET = new Set([...registered].map((k) => k.split('.')[0] ?? ''));

  /** 前端这一侧取**高召回**口径：任何一处带命名空间前缀的字符串字面量都算"有人在引用"。
   *  方向很重要：正向那条（用到的键必须登记）要**严格**，否则会误伤 `v-model="settings.draft.x"`；
   *  反向这一条只要判"全仓没有一处引用"，宁可放过也不能冤枉 —— 过窄的抽取器会把好文案报成死键，
   *  我第一版就是这样（`list.purgeConfirm` / `a11y.skipToSearch` 明明在用，只是不落在 `t()` 或 `字段: '…'` 那两种位置里）。 */
  function scanFrontend(text: string, keys: Set<string>, prefixes: Set<string>): void {
    for (const m of text.matchAll(/['"`]([a-zA-Z_][\w]*\.[A-Za-z0-9_.]+)['"`]/g)) keys.add(m[1]);
    for (const m of text.matchAll(/`([a-zA-Z_][\w.]*)\$\{/g)) prefixes.add(m[1]);
    for (const m of text.matchAll(/['"]([a-zA-Z_][\w.]*)['"]\s*\+\s*/g)) prefixes.add(m[1]);
  }

  function rustFiles(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) rustFiles(f, acc);
      else if (e.name.endsWith('.rs')) acc.push(f);
    }
    return acc;
  }

  const frontendUsed = new Set<string>();
  const dynamicPrefixes = new Set<string>();
  for (const rel of listFiles(['.ts', '.vue'])) {
    if (rel.endsWith('.spec.ts') || rel === 'i18n.ts') continue;
    scanFrontend(stripComments(read(rel)), frontendUsed, dynamicPrefixes);
  }

  const hostUsed = new Set<string>();
  for (const f of rustFiles(join(ROOT, 'crates'))) {
    for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/"([a-zA-Z_]+\.[A-Za-z0-9_]+)"/g)) {
      if (NAMESPACE_SET.has(m[1].split('.')[0] ?? '')) hostUsed.add(m[1]);
    }
  }

  const dead = [...registered].filter((k) =>
    !frontendUsed.has(k) && !hostUsed.has(k) && ![...dynamicPrefixes].some((pre) => k.startsWith(pre)));

  it('仪器自检：四本账都读到了东西（任何一本空了，"零死键"就是没扫）', () => {
    expect(registered.size).toBeGreaterThanOrEqual(200);
    expect(frontendUsed.size).toBeGreaterThanOrEqual(120);
    expect(hostUsed.size).toBeGreaterThanOrEqual(20);
    expect(dynamicPrefixes.size).toBeGreaterThanOrEqual(3);
  });

  it('牙齿：抽取器认得它声称认得的四种位置（少一种，这一族就会静默失明）', () => {
    const probe = [
      "const a = t('zz.probeT');",
      "const b = { labelKey: 'zz.probeField' };",
      'const c = `zz.probeDyn${x}`;',
      "const d = 'zz.probePre' + x;",
      'const e = `zz.deep.inner${x}`;',
    ].join('\n');
    const keys = new Set<string>();
    const prefixes = new Set<string>();
    scanFrontend(probe, keys, prefixes);
    expect([...keys].sort()).toEqual(['zz.probeField', 'zz.probePre', 'zz.probeT']);
    // 动态那两枚**不该**进 keys（它们没有闭合的字面量键），但必须进 prefixes：
    expect(keys.has('zz.probeDyn')).toBe(false);
    expect(keys.has('zz.deep.inner')).toBe(false);
    // 前缀必须**容得下带点的段**：`sync.cap.` 与 `zz.deep.inner` 都是这种形状（漏了它们就会报假死键）
    expect([...prefixes].sort()).toEqual(['zz.deep.inner', 'zz.probeDyn', 'zz.probePre']);
  });

  it('每一句登记的文案都有人引用（死键必须点名）', () => {
    expect(dead, JSON.stringify(dead)).toEqual([]);
  });
});

/**
 * §6 的最后一格「标签（tag）不做（数据模型里根本不存在）」—— **2026-10-13 按用户拍板改口**：
 * 归类语义由笔记 / 文件夹的**单值颜色**承担，不提供 tag 数据结构（改口全文见 `docs/design/SPEC-AMENDMENTS.md`）。
 * 这一格此前是 §6 十条里唯一零证人的那一格，其余九条各有执行者（上面那九个 describe）。
 *
 * 判**四面**，因为每一面各自会漏，而"改口"只有落在数据模型上才分辨得出是口径还是撒谎：
 *  · **schema 面**：往迁移里加一个 `tags` 表 / `notes.tags` 列 = 把标签系统做进数据模型；
 *  · **DTO 面**：表还没动而行类型先长出 `tags: Vec<String>` —— 下一步界面就能用它，且这一层漂移不留 SQL 痕迹；
 *  · **控件面**：画了入口却没起中文名字（文案面干净，入口照样在屏幕上）；
 *  · **文案面**：模型没变而界面上先说"给笔记打标签" = 发明能力（与 §4.8、§3.3 同族）。
 *
 * **命名撞车必须分辨得出来**（与「合并」那一格同一个教训）：`notera-importer` 的 `unknown_enml_tags`
 * 是 ENEX 里没映射上的 **ENML 元素名**，`version-now-tag` 是版本历史"当前那一版"的记号 —— 两位都不许被冤枉；
 * 而"不许被冤枉"本身也要一条在场的反向自检守着：豁免名单一旦退化成"永远命中不到东西"就是假绿。
 */
describe('§6 标签那一格（改口后）：没有 tag 数据结构，归类的唯一入口是单值颜色', () => {
  const REPO = join(SRC, '..', '..', '..');
  const readRepo = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
  /** 违规的名字集合：**整段**叫 tag/tags/label/labels（撞名的长名字不进这一族）。 */
  const TAG_NAME = /^(tags?|labels?)$/i;

  const sqlBlock = (text: string, table: string): string => {
    const hit = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(`, 'i').exec(text);
    if (!hit) return '';
    const end = text.indexOf('\n);', hit.index);
    return end < 0 ? text.slice(hit.index) : text.slice(hit.index, end);
  };
  /** 列名 = 每行第一个小写标识符、后面紧跟大写类型名（`CHECK` / `PRIMARY` 那类约束行自然落不进）。 */
  const sqlColumns = (block: string): string[] =>
    [...block.matchAll(/^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/gm)].map((m) => m[1] ?? '');
  const rustStruct = (text: string, name: string): string => {
    const hit = new RegExp(`pub struct ${name} \\{`).exec(text);
    if (!hit) return '';
    const end = text.indexOf('\n}', hit.index);
    return end < 0 ? text.slice(hit.index) : text.slice(hit.index, end);
  };
  const rustFields = (block: string): string[] =>
    [...block.matchAll(/^\s*pub\s+([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1] ?? '');
  const tsInterface = (text: string, name: string): string => {
    const hit = new RegExp(`export interface ${name} \\{`).exec(text);
    if (!hit) return '';
    const end = text.indexOf('\n}', hit.index);
    return end < 0 ? text.slice(hit.index) : text.slice(hit.index, end);
  };
  const tsFields = (block: string): string[] =>
    [...block.matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*:/gm)].map((m) => m[1] ?? '');

  const migrationFiles = readdirSync(join(REPO, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const migrationSql = migrationFiles.map((f) => readRepo(join('migrations', f))).join('\n');
  const tableNames = [...migrationSql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1] ?? '');
  const noteCols = sqlColumns(sqlBlock(migrationSql, 'notes'));
  const folderCols = sqlColumns(sqlBlock(migrationSql, 'folders'));

  const storeTypes = readRepo('crates/notera-store/src/types.rs');
  const rustBlocks = ['Note', 'NoteListRow', 'Folder'].map((n) => rustStruct(storeTypes, n));
  const frontTypes = read('api/types.ts');
  const tsBlocks = ['Note', 'Folder'].map((n) => tsInterface(frontTypes, n));
  const enexFields = rustFields(rustStruct(readRepo('crates/notera-importer/src/enex.rs'), 'EnexNote'));
  const ids = new Set(allTestIds());

  it('对照①：schema 面真读到了那两个块（表名、列数、color 都在）—— 抽到空块的话"没有标签列"等于没扫', () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(3);
    expect(tableNames.length).toBeGreaterThanOrEqual(10);
    expect(tableNames).toContain('notes');
    expect(noteCols.length).toBeGreaterThanOrEqual(10);
    expect(folderCols.length).toBeGreaterThanOrEqual(8);
    expect(noteCols).toContain('color');
    expect(folderCols).toContain('color');
  });

  it('对照②：DTO 面真读到了那五块，且每块都带 color（颜色的替身在模型里是在场的）', () => {
    const blocks: Array<[string, string[]]> = [
      ...['Note', 'NoteListRow', 'Folder'].map((n) => [`rust:${n}`, rustFields(rustStruct(storeTypes, n))] as [string, string[]]),
      ...['Note', 'Folder'].map((n) => [`ts:${n}`, tsFields(tsInterface(frontTypes, n))] as [string, string[]]),
    ];
    for (const [label, fields] of blocks) {
      expect(fields.length, `${label} 只读到 ${fields.length} 个字段（块没解析到）`).toBeGreaterThanOrEqual(6);
      expect(fields, `${label} 块里读不到 color`).toContain('color');
    }
  });

  it('对照③·牙齿：三支抽取器面对故意写的标签形状必须都抓到（否则"零违规"可以是"解析器没在看"）', () => {
    expect(sqlColumns('CREATE TABLE notes (\n  id TEXT PRIMARY KEY,\n  tags TEXT,\n)')).toContain('tags');
    expect(rustFields('pub struct Note {\n    pub id: EntityId,\n    pub tags: Vec<String>,\n}')).toContain('tags');
    expect(tsFields('export interface Note {\n  id: Uuid;\n  labels?: string[];\n}')).toContain('labels');
    expect(TAG_NAME.test('tags')).toBe(true);
    expect(TAG_NAME.test('unknown_enml_tags')).toBe(false);
  });

  it('对照④·撞名的两位真在场并被放过（ENML 元素名 ≠ 笔记的标签；版本记号 ≠ 标签入口）', () => {
    expect(enexFields.filter((f) => /tags/i.test(f))).toEqual(['unknown_enml_tags']);
    expect(enexFields.filter((f) => TAG_NAME.test(f))).toEqual([]);
    expect(ids.has('version-now-tag'), '名单里读不到 version-now-tag（豁免的对象已经不在了）').toBe(true);
  });

  it('主判据·schema 面：没有任何一张表的表名落进标签那一族', () => {
    const hits = tableNames.filter((t) => TAG_NAME.test(t));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('主判据·schema 面：notes / folders 两块的列名里没有标签那一族', () => {
    const hits = [...noteCols, ...folderCols].filter((c) => TAG_NAME.test(c));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('主判据·DTO 面（Rust）：Note / NoteListRow / Folder 三块都不许长出标签字段', () => {
    const hits = rustBlocks.flatMap(rustFields).filter((f) => TAG_NAME.test(f));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('主判据·DTO 面（前端）：Note / Folder 两个 interface 都不许长出标签字段', () => {
    const hits = tsBlocks.flatMap(tsFields).filter((f) => TAG_NAME.test(f));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('主判据·控件面：全仓入口的名字里没有标签那一族，而颜色那一族真在场', () => {
    const hits = [...ids].filter((id) => /(^|-)tags?(-|$)/i.test(id) && id !== 'version-now-tag');
    expect(hits, JSON.stringify(hits)).toEqual([]);
    // 替身真的在场：归类的入口只有颜色那一族（§6-11 + 2026-10-09 拍板"只做侧栏小色点"）
    for (const ok of ['note-color-panel', 'folder-color-panel', 'note-color-none', 'folder-color-none']) {
      expect(ids.has(ok), `名单里读不到 ${ok}`).toBe(true);
    }
  });

  it('主判据·文案面：没有任何一句把"打标签 / 标签库"说成产品能力，而颜色的说法在场', () => {
    const pairs = i18nPairs();
    const BAN = /(打标签|加标签|添加标签|新建标签|标签库|标签管理|标签系统|标签列表|多个标签|按标签(找|搜)|给笔记标签)/;
    for (const lie of ['给笔记打标签', '标签管理', '支持多个标签', '按标签搜索笔记']) {
      expect(BAN.test(lie), lie).toBe(true);
    }
    const hits = pairs.filter((p) => BAN.test(p.value)).map((p) => `${p.key}=${p.value}`);
    expect(hits, JSON.stringify(hits)).toEqual([]);
    // 替身那一族按**名字**钉住，不只数条数：只写"≥3 条"的话，删掉其中一句也不会红（k7 那把空刀就是这么留下的）
    expect(pairs.find((p) => p.key === 'sidebar.colorTitle'), '颜色选择器那一句标题不在了').not.toBeUndefined();
    expect(pairs.filter((p) => p.key.startsWith('sidebar.color')).length).toBeGreaterThanOrEqual(3);
  });
});
