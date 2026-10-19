/**
 * 标签（ADR-0022）：可同步的实体，多值组织语义。
 *
 * 两条口径写在这里，组件不许各自再实现一遍：
 *  · **相等关系不在这里**。`canonical`（NFKC + 全小写）只有核心算，
 *    界面拿到的 `id` 才是身份；这里没有任何 `toLowerCase()`/`normalize()` 参与比较
 *    —— 那条静态判据扫的就是"第二个执行者"。
 *  · **显示排序是这里的**（比较器见下方 `compareTags`：钉死 `zh-Hans-CN` 的 `Collator` + `numeric: true`）。
 *    核心的 `ORDER BY … COLLATE NOCASE` 只管 ASCII 大小写，中文按码点位，
 *    所以列表给的是"能比较"的顺序，不是"人看的"顺序。
 *    排序不是相等关系，因此这一份不算第二个执行者。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { callCommand } from '../api/bridge';
import { Commands, type Tag } from '../api/types';
import { asBridgeError } from '../util/errors';

/** 核心给的每一格必须逐格验：`id` 不是字符串就不能当身份用。 */
function ensureTag(value: unknown): Tag | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    noteCount: typeof raw.noteCount === 'number' && Number.isFinite(raw.noteCount) ? raw.noteCount : 0,
  };
}

/**
 * 显示顺序的比较器 —— **locale 必须写死，不许留 `undefined`**。
 *
 * 从前这里是 `new Intl.Collator(undefined, …)`，而 `undefined` 的意思是"取宿主默认语言"。
 * 后果不是难看，是**两台设备给同一批标签画出不同先后**：本机系统语言是 zh ⇒ 拼音序（甲 jiǎ 在 乙 yǐ 前）；
 * CI 那台 Node 默认 en ⇒ CLDR root 对汉字按码位（乙 U+4E59 在 甲 U+7532 前）。
 * 2026-10-19 就是远程 `pnpm test` 把这件事撞出来的（`tagChipsMount.spec.ts` 红在 `['乙','甲'] ≠ ['甲','乙']`）。
 * 本产品只有简中一版（`JOPLIN-VS-NOTO-FEATURE-MAP.md` §3.4 语言那一行），所以"跟着宿主语言变"没有任何产品理由。
 *
 * 两条实测口径，别照文档想当然：
 *  · 钉 locale 就够了 —— CLDR 给 `zh` 的**默认**排法就是拼音；
 *  · 再加 `collation: 'pinyin'` **是空选项**：`resolvedOptions().collation` 回报 `default`，
 *    写了等于没写，所以这里不写（写了会让下一个人以为它生效）。
 * 看守在 `arch-check` 的 `static:intl-collator-locale-pinned`（静态扫构造）——
 * **行为判据抓不到这一族**：本机恰好是 zh，改回 `undefined` 在本地照样全绿。
 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 标签之间的先后：先按人看的名字顺序，同一名再按 id —— 一处实现，chip 那一排与侧栏那一族共用。 */
export function compareTags(a: Tag, b: Tag): number {
  return collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1);
}

export const useTagStore = defineStore('tags', () => {
  const tags = ref<Tag[]>([]);
  const loading = ref(false);
  const errorKey = ref<string | null>(null);

  const byId = computed<Record<string, Tag>>(() => {
    const out: Record<string, Tag> = {};
    for (const t of tags.value) out[t.id] = t;
    return out;
  });

  /** 侧栏那一份：按人看的顺序，不按码点。 */
  const ordered = computed<Tag[]>(() =>
    [...tags.value].sort(compareTags),
  );

  async function load(): Promise<void> {
    loading.value = true;
    errorKey.value = null;
    try {
      const result = await callCommand<unknown[]>(Commands.listTags, {});
      tags.value = (Array.isArray(result) ? result : [])
        .map(ensureTag)
        .filter((t): t is Tag => t !== null);
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 建一颗。**同名（canonical 相等）核心不会建第二颗**，它把已有那一颗原样返回 ——
   * 所以这里"拿到回包就 upsert 进本地表"是安全的：不会产生第二个身份。
   */
  async function create(title: string): Promise<Tag | null> {
    const draft = title.trim();
    if (draft.length === 0) return null;
    errorKey.value = null;
    try {
      const tag = ensureTag(await callCommand(Commands.createTag, { title: draft }));
      if (!tag) return null;
      upsert(tag);
      return tag;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return null;
    }
  }

  async function rename(id: string, title: string): Promise<boolean> {
    const draft = title.trim();
    if (draft.length === 0) return false;
    errorKey.value = null;
    try {
      const tag = ensureTag(await callCommand(Commands.renameTag, { id, title: draft }));
      if (!tag) return false;
      upsert(tag);
      return true;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return false;
    }
  }

  async function remove(id: string): Promise<boolean> {
    errorKey.value = null;
    try {
      await callCommand(Commands.deleteTag, { id });
      // 核心是软删除：行还在库里，但它不再是"活标签"，界面上这一行要立刻消失。
      tags.value = tags.value.filter((t) => t.id !== id);
      return true;
    } catch (error) {
      errorKey.value = asBridgeError(error).messageKey;
      return false;
    }
  }

  function upsert(tag: Tag): void {
    const at = tags.value.findIndex((t) => t.id === tag.id);
    if (at >= 0) tags.value.splice(at, 1, tag);
    else tags.value.push(tag);
  }

  /** 输入框里的候选：按标题包含关系筛（这是**显示层的方便**，不是相等关系；
   *  真同名以核心为准 —— 用户敲回车走 `create`，核心自己会认出已有那一颗）。 */
  function candidates(query: string, limit = 8): Tag[] {
    const q = query.trim();
    const pool = ordered.value;
    if (q.length === 0) return pool.slice(0, limit);
    return pool.filter((t) => t.title.includes(q)).slice(0, limit);
  }

  return { tags, ordered, byId, loading, errorKey, load, create, rename, remove, candidates };
});

/**
 * 编辑器那一排 chip 的模型：`{id,title}`，按人看的顺序，**认不出的 id 不出现**。
 *
 * 为什么不显示"某个已删标签的残留引用"：那种 id 只有核心知道它为什么不在（折叠/软删），
 * 界面凭一个空位猜"它曾经叫什么"是第二份真相。读侧 `note_tags` 本来也已经滤掉了它们，
 * 这里的 filter 只是防"界面拿到一份没解析过的原样列"（那时宁可少画一颗，也不画一颗点不开的）。
 *
 * 去重也是在这里：链接那一列是**别人写的记录**（远端那一版可能写着两个同一个 id），
 * 不去重就会长出两颗一模一样的 chip，而摘掉其中一颗会两颗一起消失 —— 用户看见的是"点一下少两颗"。
 */
export function chipModel(ids: readonly string[], byId: Record<string, Tag>): Tag[] {
  const seen = new Set<string>();
  const picked: Tag[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const found = byId[id];
    if (!found) continue;
    seen.add(id);
    picked.push(found);
  }
  return picked.sort(compareTags);
}

/** 加/摘同一颗：集合语义（已存在就移除）。返回**排序且去重**的新数组，不改入参。 */
export function toggleIn(ids: readonly string[], id: string): string[] {
  const set = new Set(ids);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set].sort();
}
