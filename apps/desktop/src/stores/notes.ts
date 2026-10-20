/** 列表：文件夹/全部/最近删除三种视图 + 即时搜索 + 选中态。 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useProvisionalStore } from './provisional';
import { callCommand } from '../api/bridge';
import {
  Commands,
  type Note,
  type NoteListRow,
  type NoteDoc,
  type SearchHit,
} from '../api/types';
import { createDebounced, SEARCH_DEBOUNCE_MS, type Debounced } from '../util/timing';
import { asBridgeError } from '../util/errors';
import { emptyDoc } from '../editor/model';
import { useEditorStore } from './editor';
import { useSettingsStore } from './settings';
import type { NoteSortKey } from './settings';
import { useToastStore } from './toasts';
import { t, type MessageKey } from '../i18n';

export type ListMode =
  | { kind: 'all' }
  | { kind: 'folder'; folderId: string | null }
  /** 侧栏点一颗标签（ADR-0022）。核心按**这一颗**筛，含"链接里还写着它的别名 id"的那些。 */
  | { kind: 'tag'; tagId: string }
  | { kind: 'trash' };

const PAGE_SIZE = 200;

/** 搜索一页的大小（§3.3）。回满这一页时界面要问一次总数、说「还有 N 条」。 */
const SEARCH_LIMIT = 80;
/** 那一次总数的上界（与核心 `DEFAULT_TOTAL_CAP` 同一个意思：到顶了说"以上"）。 */
const SEARCH_TOTAL_CAP = 200;

function rowFromNote(note: Note): NoteListRow {
  return {
    id: note.id,
    title: note.title,
    summary: note.summary ?? '',
    folderId: note.folderId ?? null,
    pinned: note.pinned ?? false,
    charCount: note.charCount ?? 0,
    hasAttachment: note.hasAttachment ?? false,
    updatedAt: note.updatedAt,
    createdAt: note.createdAt,
    deletedAt: note.deletedAt ?? null,
    color: note.color ?? null,
  };
}

export const useNoteStore = defineStore('notes', () => {
  const rows = ref<NoteListRow[]>([]);
  const mode = ref<ListMode>({ kind: 'all' });
  const loading = ref(false);
  const errorKey = ref<string | null>(null);
  const hasMore = ref(false);
  const selectedId = ref<string | null>(null);
  const query = ref('');
  const hits = ref<SearchHit[] | null>(null);
  /** §3.3 后一半：回满时那一次 count 的读数（`{ total, cap }`；没回满就是 null）。 */
  const searchTotal = ref<{ total: number; cap: number } | null>(null);
  const searching = ref(false);
  const searchErrorKey = ref<string | null>(null);
  const titles = ref<Record<string, string>>({});
  /** 每篇的活标签 id（核心解析过折叠与软删，见 `loadTagIds`）。按 id 存，不按位置。 */
  const tagIdsByNote = ref<Record<string, string[]>>({});

  const inTrash = computed(() => mode.value.kind === 'trash');

  /**
   * 这一档列表在偏好里的键（第一百五十三批"每文件夹记一次排序"）。
   * `folder` 那一档的 `folderId` 为 null 时算 `folder:default`（内置本），**不与 `all` 共用一个键** ——
   * "全部"和"某一个本子里"是两件事，共用就会让一次改动串到另一处（同族教训见
   * [[cross-table-link-belongs-in-production]]：能共用的不是同一个东西，就别共用那张表）。
   */
  const listKey = computed(() => {
    const m = mode.value;
    if (m.kind === 'folder') return `folder:${m.folderId ?? 'default'}`;
    if (m.kind === 'tag') return `tag:${m.tagId}`;
    return m.kind;
  });
  const settingsStore = useSettingsStore();
  /** 没记过 = `updated_desc`，也就是这一批之前那句写死的顺序（旧行为是默认值，不是一条特例）。 */
  const currentSort = computed<NoteSortKey>(() => settingsStore.prefs.sorts[listKey.value] ?? 'updated_desc');

  function setSort(sort: NoteSortKey): void {
    settingsStore.setListSort(listKey.value, sort);
    void load();
  }
  const searching_ = computed(() => query.value.trim().length > 0);
  const visibleRows = computed(() => rows.value);
  const pinnedRows = computed(() => rows.value.filter((row) => row.pinned === true));
  const restRows = computed(() => rows.value.filter((row) => row.pinned !== true));
  const titleOf = computed(() => (id: string) => titles.value[id] ?? '');
  /**
   * §3.3 的分档读数：**逐条读核心给的 `exact`**，不按位置切。
   *
   * 核心内部确实是用位置切的（`search.rs` 里 `if i < exact_count`），界面再抄一遍
   * 就是第二份判据 —— 哪天两档交叉返回，抄位置的这份会安静地数错。
   */
  const searchTiers = computed<{ exact: number; fuzzy: number } | null>(() => {
    if (hits.value === null) return null;
    let exact = 0;
    for (const hit of hits.value) if (hit.exact === true) exact += 1;
    return { exact, fuzzy: hits.value.length - exact };
  });

  /**
   * 列表栏底部那一格的**读数与用哪句**（呈现层的事实，不是组件里的字符串拼装）。
   *
   * 三种不画的形状：搜索态（那里说的是「找到 N 条」，两句并存会各说一件不同的事）、
   * 空库（归空态文案）、以及还在加载第一页。
   * `hasMore` 那一格必须换句子：还有下一页没取回来时说「共 N 条」就是把数报少。
   */
  const listReadout = computed<{ key: MessageKey; count: number } | null>(() => {
    if (hits.value !== null || loading.value || rows.value.length === 0) return null;
    return { key: hasMore.value ? 'list.rowsLoaded' : 'list.totalCount', count: rows.value.length };
  });

  let requestId = 0;

  function listArgs(offset: number): Record<string, unknown> {
    const args: Record<string, unknown> = { limit: PAGE_SIZE, offset };
    // 排序：每"一档列表"各记各的（第一百五十三批）。不传 = 核心那一档默认 = 这一批之前的写死顺序。
    args.sort = currentSort.value;
    if (mode.value.kind === 'trash') args.trash = true;
    else {
      args.trash = false;
      if (mode.value.kind === 'folder') args.folder = mode.value.folderId ?? null;
      // 标签那一格给的是 id，不是标题：相等关系只有核心那一处（ADR-0022 D3），
      // 界面按名字筛就是第二个执行者。
      if (mode.value.kind === 'tag') args.tagId = mode.value.tagId;
    }
    return args;
  }

  async function load(offset = 0, append = false): Promise<void> {
    const mine = ++requestId;
    loading.value = true;
    errorKey.value = null;
    try {
      const result = await callCommand<NoteListRow[]>(Commands.listNotes, listArgs(offset));
      if (mine !== requestId) return;
      const list = Array.isArray(result) ? result : [];
      rows.value = append ? [...rows.value, ...list] : list;
      hasMore.value = list.length === PAGE_SIZE;
      const next: Record<string, string> = { ...titles.value };
      for (const row of list) next[row.id] = row.title || '';
      titles.value = next;
      if (!append && rows.value.length > 0 && !rows.value.some((row) => row.id === selectedId.value)) {
        selectedId.value = rows.value[0]?.id ?? null;
      } else if (!append && rows.value.length === 0) {
        // **列表空了就必须把选中项也清掉**（原来漏了这一支）。
        //
        // 漏掉的后果，用户实测撞到了：「清除一切数据」之后侧栏显示 0 篇，
        // 而编辑器里还**留着刚被删掉那一篇的正文**—— 因为 selectedId 仍指向
        // 一个已经不存在的 id，编辑器照旧渲染它的内容。在回收站里那一篇
        // 还在正文之前挂着一句「这条在"最近删除"里，恢复后才能继续编辑。」，
        // 而它**已经被永久删除了**，那句话是假的。
        //
        // 顺带把标题缓存也丢掉：留着已删 id 的标题，只会让列表重挂载时
        // 凭空冒出一行"有标题但点不开"的条目。
        selectedId.value = null;
        titles.value = {};
      }
    } catch (error) {
      if (mine !== requestId) return;
      const bridge = asBridgeError(error);
      errorKey.value = bridge.messageKey;
      if (!append) rows.value = [];
      hasMore.value = false;
    } finally {
      if (mine === requestId) loading.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || loading.value) return;
    await load(rows.value.length, true);
  }

  async function setMode(next: ListMode, preferredId: string | null = null): Promise<void> {
    mode.value = next;
    hits.value = null;
    searching.value = false;
    query.value = '';
    debouncedSearch.cancel();
    selectedId.value = preferredId;
    await load();
    if (preferredId === null && rows.value.length === 0) selectedId.value = null;
  }

  async function refresh(): Promise<void> {
    await load();
  }

  /* ------------------------------------------------------------- 搜索 */

  async function runSearch(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      clearSearch();
      return;
    }
    const mine = ++requestId;
    searching.value = true;
    searchErrorKey.value = null;
    try {
      const result = await callCommand<SearchHit[]>(Commands.search, { text: trimmed.slice(0, 200), limit: SEARCH_LIMIT });
      if (mine !== requestId) return;
      const list = Array.isArray(result) ? result : [];
      hits.value = list;
      /**
       * §3.3 的后一半：**回满时才去问总数**（2026-10-09 用户拍板："搜索回满 80 就提示还有 N 条"）。
       * 只在回满时问，是因为这一问要走一次桥；没满时"还有多少"的答案就是 0，
       * 不必为一句不出现的话付一次往返。`cap` 是上界：到顶了界面说"以上"（见核心 `run_total`）。
       */
      searchTotal.value = null;
      if (list.length >= SEARCH_LIMIT) {
        const t = await callCommand<{ total: number; cap: number }>(Commands.searchTotal, {
          text: trimmed.slice(0, 200),
          cap: SEARCH_TOTAL_CAP,
        });
        if (mine === requestId && t && typeof t.total === 'number') searchTotal.value = t;
      }
      const next: Record<string, string> = { ...titles.value };
      for (const hit of list) {
        // 标题只认核心发的 `title`（缺口 G93）：以前这里拿片段前 40 字猜标题，而那一带
        // 是 DTO 还没有 `title` 键的年代留下的。露头的形状很日常 —— 在文件夹视图里搜、
        // 或库里 200 条开外：只要这篇不在已载入的列表里，屏幕上「标题」与「摘要」两行
        // 就是同一段正文。空标题的那篇也照核心给的走（界面上退「未命名」），不替它编一个。
        if (hit.noteId && !next[hit.noteId]) next[hit.noteId] = hit.title ?? '';
      }
      titles.value = next;
    } catch (error) {
      if (mine !== requestId) return;
      hits.value = [];
      searchErrorKey.value = asBridgeError(error).messageKey;
    } finally {
      if (mine === requestId) searching.value = false;
    }
  }

  const debouncedSearch: Debounced<[string]> = createDebounced((text: string) => void runSearch(text), SEARCH_DEBOUNCE_MS);

  function requestSearch(text: string): void {
    query.value = text;
    if (text.trim().length === 0) {
      debouncedSearch.cancel();
      clearSearch();
      return;
    }
    searching.value = true;
    debouncedSearch(text);
  }

  function clearSearch(): void {
    query.value = '';
    hits.value = null;
    searchTotal.value = null;
    searching.value = false;
    searchErrorKey.value = null;
  }

  /* ------------------------------------------------------------- 写入 */

  /**
   * §1 的"日记"入口：**一天一篇**，日子由核心按**本地日历日**算并找回/新建。
   * 前端不自己算日子、也不自己按标题找 —— 那就是第二份判据，核心那边一改这里就悄悄不一致。
   */
  async function openToday(): Promise<Note | null> {
    try {
      const today = await callCommand<{ note: Note; day: string; created: boolean }>(
        Commands.dailyNote,
        {},
      );
      // 「按了却看不见」不算做完：回收站视图、以及"日记落在默认本而当前看的是别的文件夹"，
      // 都要把视图换到「全部」并直接选上那一篇 —— 否则编辑器开了，列表里却没有它。
      const elsewhere =
        mode.value.kind === 'trash' ||
        (mode.value.kind === 'folder' && mode.value.folderId !== today.note.folderId);
      if (elsewhere) {
        await setMode({ kind: 'all' }, today.note.id);
      } else {
        await load();
        selectedId.value = today.note.id;
      }
      titles.value = { ...titles.value, [today.note.id]: today.note.title };
      // 与"新建笔记"同一件事：只选中不打开，用户看到的是一块空白面板（真窗口实测踩过）。
      await useEditorStore().open(today.note.id);
      return today.note;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return null;
    }
  }

  /**
   * 笔记的**条数**变了之后刷一次侧栏计数。
   *
   * 为什么必须在这里刷：侧栏「全部笔记 / 最近删除」旁边那两颗数读的是
   * `settings.stats`，而 `settings.loadStats()` 此前**只在 App.vue 启动时调一次**
   * （实测 `loadStats` 的调用点只有 App.vue 与 SettingsView 那几处）。
   * 于是新建/删除之后，列表里条目已经变了而侧栏数字还是旧的 ——
   * 用户看着"我明明建了 3 篇，数字却没动"，那是在说界面在说谎。
   *
   * 用 `void` 不await：统计是旁路，刷新失败不该把创建/删除这一步变成失败。
   */
  function refreshCounts(): void {
    void useSettingsStore().loadStats();
  }

  async function create(folderId: string | null, doc?: NoteDoc): Promise<Note | null> {
    try {
      const note = await callCommand<Note>(Commands.createNote, { folderId, doc: doc ?? emptyDoc() });
      refreshCounts();
      if (mode.value.kind === 'trash') await setMode({ kind: 'all' });
      else await load();
      selectedId.value = note.id;
      useProvisionalStore().mark(note.id);
      titles.value = { ...titles.value, [note.id]: note.title };
      // 新建之后立刻打开编辑器：只"选中"不"打开"，用户看到的是一块空白面板，
      // 连字都打不进去（真浏览器实测踩过：列表里有了条目，中间却没有光标）。
      await useEditorStore().open(note.id);
      return note;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return null;
    }
  }

  /**
   * 草稿态新建的收口（第一百六十二批，口径来自 Joplin 的 `reduxSharedMiddleware.ts:76-83`）：
   * **选中项换了**的时候，把除目标以外的 provisional 笔记软删（进回收站，不是永久删）。
   * 删不掉（库只读等）就把它留在这儿 —— 宁可多一篇空笔记，也不能把"没删成"说成"删了"。
   */
  async function disposeProvisional(next: string | null): Promise<void> {
    const prov = useProvisionalStore();
    const doomed = prov.pendingExcept(next);
    if (doomed.length === 0) return;
    let removed = 0;
    for (const id of doomed) {
      prov.forget(id);
      try {
        await callCommand<null>(Commands.deleteNote, { id });
        removed += 1;
      } catch {
        // 留着（见注释最后一句）
      }
    }
    if (removed > 0) {
      refreshCounts();
      await load();
    }
  }

  watch(selectedId, (next) => {
    void disposeProvisional(next);
  });

  const isProvisional = (id: string | null | undefined): boolean => useProvisionalStore().is(id);

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    try {
      const note = await callCommand<Note>(Commands.setNotePinned, { id, pinned });
      applyNoteUpdate(note);
      handRevToEditor(note);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  /**
   * §6「颜色」的笔记那一半（2026-10-09 拍板：笔记级颜色**当标签用**）。
   *
   * 与置顶/移到同一条路：它也是一次**元数据写**（占一格 rev），所以必须
   * `handRevToEditor` —— 不交接就是 G43 那个形状：编辑器还按旧的 `expectedRev` 出门，
   * 下一支自动保存被核心按 `stale_edit` 拒，用户刚打的字哪儿也没落。
   */
  async function setColor(id: string, color: string): Promise<void> {
    try {
      const note = await callCommand<Note>(Commands.setNoteColor, { id, color });
      applyNoteUpdate(note);
      handRevToEditor(note);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  /**
   * ADR-0022：设这篇笔记的标签集合（整份替换，与 pinned/color 同族）。
   *
   * 它同样占一格 rev，所以 `handRevToEditor` 不能省（理由与 `setColor` 上那段一样：
   * 不交接就是编辑器抱着旧 `expectedRev` 出门，下一支自动保存被 `stale_edit` 拒）。
   * 成功后**回读一次** `note_tags`：链接里的旧 id 可能被核心折叠改写（D4），
   * 界面要的是解析过的那一份，不是自己刚发出去的那一份。
   */
  async function setTags(id: string, tagIds: string[]): Promise<string[]> {
    try {
      await callCommand<Note>(Commands.setNoteTags, { id, tagIds });
      return await loadTagIds(id);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return tagIdsByNote.value[id] ?? [];
    }
  }

  /** 这篇的活标签 id（核心解析过别名与软删）。编辑器打开一篇时读一次。 */
  async function loadTagIds(id: string): Promise<string[]> {
    try {
      const raw = await callCommand<unknown>(Commands.noteTags, { id });
      const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      tagIdsByNote.value = { ...tagIdsByNote.value, [id]: list };
      return list;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return [];
    }
  }

  async function moveTo(id: string, folderId: string): Promise<void> {
    try {
      const note = await callCommand<Note>(Commands.setNoteFolder, { id, folderId });
      applyNoteUpdate(note);
      handRevToEditor(note);
      await load();
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  async function moveToTrash(id: string): Promise<void> {
    try {
      // 移走之前先把**这一篇**在飞/排队的保存结清（缺口 G41）。不结清的两种坏法都量到过：
      // 那支自动保存随后打在"已经在回收站里"的它身上 ⇒ 核心按 `constraint` 拒（`retryable=false`），
      // 用户那边是"字打了、屏幕上没落、也没有一句话说明去哪了"（lane 第 49 步 Del 那一判的读数）；
      // 或者那一支随这次切换被丢掉（`stores/trashFlush.spec.ts` 里打出来的就是这一种，edit_note 零条）。
      // 顺序摆正之后那几个字进的是"还在正常列表里"的那一篇。
      const editorStore = useEditorStore();
      if (editorStore.noteId === id) await editorStore.flush();
      await callCommand<null>(Commands.deleteNote, { id });
      refreshCounts();
      await load();
      // §4.9「每条 Toast 要说清没有丢什么」。这一行从列表里消失是**读模型**的行为（软删之后不再投影，
      // 缺口 G63 那一族），于是用户看到的只有"它没了"。恢复这条路是真的存在（`restore_note`），
      // 所以这句话不是安慰，是事实陈述。
      // 第一百五十二批（A 档「删除后可撤销」，Joplin 的 `TrashNotification`）：光陈述不够，
      // 要给一颗**点得动的**撤销 —— 而且这一条不自动消失（带动作的那一族，见 `stores/toasts.ts`）。
      useToastStore().pushText(t('state.movedToTrash'), 'info', {
        label: t('state.undo'),
        run: () => {
          void restore(id);
        },
      });
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  /**
   * 批量移到回收站（第一百五十七批，A 档 P5「多选 + 批量」）。两条口径是从单条那一路抄来的，不许各发明一套：
   *  · **每一篇出门前各自结清在飞的保存**（缺口 G41 那一条：把 `moveToTrash` 的顺序理由原样搬过来）；
   *  · **一条 toast 说清动了多少篇，并给一颗点得动的撤销**（§4.9 + 第一百五十二批那一族：带动作 ⇒ 不自动消失）。
   *
   * 中途失败就停在停的那一处，但**已经移走的那些必须可撤销** —— 所以 `done` 在 `return` 之前也要走到那条 toast，
   * 而不是只把错误摆出来（那样用户看到的是"N-1 篇没了、没有一句话、也没有出口"）。返回值 = 真移走的篇数。
   */
  async function batchMoveToTrash(ids: string[]): Promise<number> {
    const done: string[] = [];
    let failed: unknown = null;
    for (const id of ids) {
      try {
        const editorStore = useEditorStore();
        if (editorStore.noteId === id) await editorStore.flush();
        await callCommand<null>(Commands.deleteNote, { id });
        done.push(id);
      } catch (error) {
        failed = error;
        break;
      }
    }
    if (done.length > 0) {
      refreshCounts();
      await load();
      const moved = [...done];
      useToastStore().pushText(t('state.movedManyToTrash', { count: moved.length }), 'info', {
        label: t('state.undo'),
        run: () => {
          void batchRestore(moved);
        },
      });
    }
    if (failed) errorKey.value = asBridgeError(failed).messageKey;
    return done.length;
  }

  /** 撤销那一颗的落点：逐篇走单条 `restore`（同一个去处、同一套 rev 交接，不写第二份恢复路径）。 */
  async function batchRestore(ids: string[]): Promise<void> {
    for (const id of ids) await restore(id);
  }

  /**
   * 批量移动到某个文件夹。**这一条不给撤销**：移动不是破坏性的（再移回去就是反悔，且界面上一直有这条路），
   * 而"撤销"那颗一旦给移动，用户会以为它像删除那样只在本次运行里有效 —— 那是对承诺的误解。
   * 因此这条 toast 无动作位 ⇒ 按 §4.9 那一族自动消失。
   */
  async function batchMoveTo(ids: string[], folderId: string, folderName: string): Promise<number> {
    let n = 0;
    for (const id of ids) {
      try {
        const note = await callCommand<Note>(Commands.setNoteFolder, { id, folderId });
        applyNoteUpdate(note);
        handRevToEditor(note);
        n += 1;
      } catch (error) {
        errorKey.value = asBridgeError(error).messageKey;
        break;
      }
    }
    if (n > 0) {
      refreshCounts();
      await load();
      useToastStore().pushText(t('state.movedManyToFolder', { count: n, folder: folderName }), 'info');
    }
    return n;
  }

  /**
   * 批量加标签（多选那一批的后半截，采纳清单第 94 行）。
   *
   * 核心只有**逐篇**的 `set_note_tags`，而且它是**全量替换** ⇒ 这一发必须自己"读—并—写"：
   * ① 已有这颗的直接跳过（「加标签」是幂等的，不是"覆盖成只剩这颗"）；
   * ② 读不到"它原来有哪些"就**停**，不拿一个空数组去写 —— 那会把用户别的标签一起洗掉。
   * 返回真加上的篇数：界面据此决定说"加了 N 篇"还是"这几篇本来就有"。
   */
  async function batchAddTag(ids: string[], tagId: string, tagTitle: string): Promise<number> {
    let n = 0;
    for (const id of ids) {
      try {
        const raw = await callCommand<unknown>(Commands.noteTags, { id });
        if (!Array.isArray(raw)) {
          errorKey.value = 'state.tagReadFailed';
          break;
        }
        const current = raw.filter((x): x is string => typeof x === 'string');
        if (current.includes(tagId)) continue;
        const next = [...current, tagId];
        await callCommand<Note>(Commands.setNoteTags, { id, tagIds: next });
        tagIdsByNote.value = { ...tagIdsByNote.value, [id]: next };
        n += 1;
      } catch (error) {
        errorKey.value = asBridgeError(error).messageKey;
        break;
      }
    }
    if (n > 0) {
      useToastStore().pushText(t('state.taggedMany', { count: n, tag: tagTitle }), 'info');
    }
    return n;
  }

  /**
   * 导出选中的这几篇（第一百六十批）。走的是设置页那条 `export_data`，只把作用域换成 `noteIds`；
   * **不给 `path`** ⇒ 核心落到它自己的 `exports/` 目录并把真实路径回传，界面把那一句原样说出来 ——
   * 让用户自己去文件管理器里猜"导到哪了"是这一格最容易敷衍的地方。
   * 附件只带**这几篇自己**挂着的（核心那一侧按 `note_attachments` 取，不按文件夹扫）。
   */
  async function exportSelected(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    try {
      const r = await callCommand<{ path?: string; created?: number }>(Commands.exportData, {
        req: { noteIds: ids, includeAttachments: true, includeTrash: false },
      });
      const made = typeof r?.created === 'number' ? r.created : 0;
      if (typeof r?.path === 'string' && r.path.length > 0) {
        useToastStore().pushText(t('state.exportedMany', { count: made, path: r.path }), 'info');
      }
      return made;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return 0;
    }
  }

  async function restore(id: string): Promise<void> {
    try {
      await callCommand<null>(Commands.restoreNote, { id });
      refreshCounts();
      await load();
      // 恢复之后必须把这一篇**重读**进编辑器（缺口 G44）。不重读的读数（2026-10-02 真机）：
      // 回收站 → 点开它 → 点「恢复」→ 直接打字 ⇒ 屏幕上没字、桥那边一支写都没收到，
      // 也没有任何一句话说明为什么改不动 —— 因为编辑器的 `inTrash` 与 `rev` 是打开那一篇时
      // 从"还在回收站里"的状态 hydrate 来的，而 delete/restore 各自又推进了那一行的 rev。
      const editorStore = useEditorStore();
      if (editorStore.noteId === id) await editorStore.open(id, true);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  async function purge(id: string): Promise<void> {
    try {
      await callCommand<null>(Commands.purgeNote, { id });
      refreshCounts();
      await load();
      // 永久删除掉的那一篇如果正开在编辑器里，必须关掉（缺口 G45）。2026-10-02 真机读数：
      // 列表那边是对的（空态出现），但**编辑器还显示着那一篇的正文**，下面还挂着
      // 「这条在"最近删除"里，恢复后才能继续编辑。」—— 对一篇已经被永久删除的笔记，这句话是假话；
      // 往那块只读区打字，屏幕上连字都不出现，也没有任何一句话说明发生了什么。
      // （台账里我原先写"purge 靠选中项搬迁会自动关掉编辑器"，那是推的，量下来是反的。）
      const editorStore = useEditorStore();
      if (editorStore.noteId === id) await editorStore.open(null);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    }
  }

  function applyNoteUpdate(note: Note | null | undefined): void {
    // 用户**真的改过**它（编辑器保存成功 / 元数据写成功）⇒ 摘掉草稿标记（Joplin `Note.ts:915-917` 那条）。
    // 放在这里而不是"任何 load 之后"：拉列表不是改动，把它当改动就等于草稿永远不会被丢。
    useProvisionalStore().confirm(note?.id);
    if (!note || typeof note.id !== 'string') return;
    const existing = rows.value.find((row) => row.id === note.id);
    const row = rowFromNote(note);
    rows.value = existing ? rows.value.map((item) => (item.id === note.id ? { ...row, folderName: item.folderName ?? row.folderName } : item)) : [row, ...rows.value];
    titles.value = { ...titles.value, [note.id]: note.title };
  }

  /**
   * 把"同一行刚被推进的那格 rev"交给编辑器。
   *
   * 置顶与移到文件夹在核心里走的是同一条 `commit_edit`（pinned/folder 要能同步出去，就必须占一格 rev），
   * 而编辑器的 `rev` 平时只跟着自己的 `edit_note` 回包前进。不交接的实测形状（缺口 G43，2026-10-02 真机）：
   * 三次置顶把那一行推到 5，下一支自动保存仍报 `expectedRev=2` ⇒ 核心按 `stale_edit` 拒，
   * 用户刚打的字被回读换掉、哪儿也没落，屏幕上却写着"这条笔记在别处被改动了"。
   *
   * 只交给本地已成功的元数据写；远端同步下来的改动仍走编辑器的草稿冲突那一条路（`enterStale`），
   * 所以这里**不**放在 `applyNoteUpdate` 里。
   */
  function handRevToEditor(note: Note | null | undefined): void {
    if (!note || typeof note.id !== 'string' || typeof note.rev !== 'number') return;
    useEditorStore().adoptRev(note.id, note.rev);
  }

  function rowById(id: string | null | undefined): NoteListRow | undefined {
    if (!id) return undefined;
    return rows.value.find((row) => row.id === id);
  }

  /** 事件回流：后端说这些条目变了。若正是编辑器打开的那条，交由编辑器决定何时重载。 */
  async function invalidate(ids: readonly string[]): Promise<string | null> {
    await load();
    return ids.includes(selectedId.value ?? '') ? selectedId.value : null;
  }

  return {
    rows,
    visibleRows,
    pinnedRows,
    restRows,
    mode,
    inTrash,
    hasQuery: searching_,
    loading,
    errorKey,
    hasMore,
    selectedId,
    query,
    hits,
    searchTiers,
    listReadout,
    searching,
    searchErrorKey,
    titles,
    titleOf,
    load,
    loadMore,
    setMode,
    refresh,
    runSearch,
    requestSearch,
    clearSearch,
    create,
    openToday,
    setPinned,
    setColor,
    tagIdsByNote,
    setTags,
    loadTagIds,
    searchTotal,
    moveTo,
    moveToTrash,
    batchMoveToTrash,
    batchRestore,
    batchMoveTo,
    batchAddTag,
    exportSelected,
    isProvisional,
    restore,
    listKey,
    currentSort,
    setSort,
    purge,
    applyNoteUpdate,
    rowById,
    invalidate,
  };
});
