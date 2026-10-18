<script setup lang="ts">
/**
 * 编辑器里那一排标签 chip（ADR-0022）。
 *
 * 三件事决定了它长这样，改之前先读完：
 *  · **芯片上的名字来自核心**（`list_tags` 那一份），这里只按 id 取标题；
 *    认不出的 id 不画（`chipModel`），因为"它曾经叫什么"是第二份真相。
 *  · **写回是整份替换**（`set_note_tags`），与 pinned/color 同族：它占一格 rev，
 *    所以 notes store 那一条边必须把新 rev 交给编辑器（`setTags` 里已经做了）。
 *  · **输入框回车是"建或认"**：不在前端判同名 —— 同名（canonical 相等）由核心折叠，
 *    前端再算一遍就是那条静态判据禁的第二个执行者。
 */
import { computed, ref, watch } from 'vue';
import { useNoteStore } from '../stores/notes';
import { useTagStore, chipModel, toggleIn } from '../stores/tags';
import { useEditorStore } from '../stores/editor';
import { t } from '../i18n';
import AppPopover from './ui/AppPopover.vue';
import AppIcon from './ui/AppIcon.vue';

const notes = useNoteStore();
const tags = useTagStore();
const editor = useEditorStore();

const draft = ref('');
const busy = ref(false);

const noteId = computed(() => notes.selectedId);
const attached = computed<string[]>(() => (noteId.value ? notes.tagIdsByNote[noteId.value] ?? [] : []));
const chips = computed(() => chipModel(attached.value, tags.byId));
/** 只读与回收站都不给写：核心那两道闸门会拒，界面不许先画出一颗点了报错的按钮。 */
const writable = computed(() => noteId.value !== null && !notes.inTrash && editor.readOnlyReason === null);
/** 候选 = 还没挂上的那些，按输入框筛（这是显示层的方便，不是相等关系）。 */
const candidates = computed(() => tags.candidates(draft.value, 8).filter((tag) => !attached.value.includes(tag.id)));

watch(noteId, async (id) => {
  draft.value = '';
  if (id === null) return;
  if (tags.tags.length === 0) await tags.load();
  await notes.loadTagIds(id);
}, { immediate: true });
// `immediate` 不是保险丝，是这一排 chip 在窄屏上的唯一读法：390 那一档编辑器是 `v-if` 挂上去的，
// 点进行那一瞬间 `selectedId` 已经落定，之后没有"变化"可看 —— 只挂 watch 时打开的这篇**一颗 chip 都不画**
//（实测：1440 有、390 空，而库里明明挂着两颗）。宽屏只是碰巧赢在时序上（boot 时 store 晚于本组件赋值）。

async function write(next: string[]): Promise<void> {
  const id = noteId.value;
  if (id === null || busy.value) return;
  busy.value = true;
  try {
    await notes.setTags(id, next);
    // 计数那格是侧栏与选择器共用的读数：摘掉/加上之后核心那边已经变了，回一次账。
    await tags.load();
  } finally {
    busy.value = false;
  }
}

async function toggle(id: string): Promise<void> {
  await write(toggleIn(attached.value, id));
}

/** 回车 = 建或认：核心对同名（canonical 相等）返回已有那一颗，所以这里不会长出第二个身份。 */
async function createAndAttach(): Promise<void> {
  const title = draft.value.trim();
  if (title.length === 0 || busy.value) return;
  busy.value = true;
  let created = null;
  try {
    created = await tags.create(title);
  } finally {
    busy.value = false;
  }
  draft.value = '';
  if (created && !attached.value.includes(created.id)) await write(toggleIn(attached.value, created.id));
}
</script>

<template>
  <div v-if="noteId" class="tag-row" data-testid="tag-row">
    <span
      v-for="chip in chips"
      :key="chip.id"
      class="tag-chip"
      :data-testid="`tag-chip-${chip.id}`"
    >
      <span class="tag-chip__label">{{ chip.title }}</span>
      <button
        type="button"
        class="btn btn--quiet btn--icon tag-chip__x"
        :disabled="!writable || busy"
        :data-testid="`tag-detach-${chip.id}`"
        :aria-label="t('tags.remove', { title: chip.title })"
        :title="t('tags.remove', { title: chip.title })"
        @click="toggle(chip.id)"
      >
        <AppIcon :size="14" name="close" />
      </button>
    </span>

    <AppPopover
      v-if="writable"
      testid="tag-add-toggle"
      align="start"
      :label="t('tags.add')"
      :disabled="busy"
    >
      <template #glyph>
        <span class="tag-chip tag-chip--add">
          <AppIcon :size="14" name="plus" />
          <span class="tag-chip__label">{{ t('tags.add') }}</span>
        </span>
      </template>
      <template #default="{ close }">
        <div class="tag-panel" data-testid="tag-panel">
          <input
            v-model="draft"
            class="input tag-panel__input"
            type="text"
            data-testid="tag-input"
            :placeholder="t('tags.placeholder')"
            :aria-label="t('tags.placeholder')"
            @keydown.enter.prevent="createAndAttach"
          />
          <ul v-if="candidates.length > 0" class="tag-panel__list" role="list">
            <li v-for="tag in candidates" :key="tag.id">
              <button
                type="button"
                class="btn btn--quiet btn--block"
                :data-testid="`tag-attach-${tag.id}`"
                :aria-label="t('tags.attach', { title: tag.title })"
                @click="toggle(tag.id)"
              >
                {{ tag.title }}
                <span class="tag-panel__count">{{ t('tags.count', { count: tag.noteCount }) }}</span>
              </button>
            </li>
          </ul>
          <p v-else-if="draft.trim().length === 0" class="tag-panel__hint" data-testid="tags-none">
            {{ tags.tags.length === 0 ? t('tags.none') : t('tags.placeholder') }}
          </p>
          <button
            type="button"
            class="btn btn--quiet btn--block"
            data-testid="tag-create"
            :disabled="draft.trim().length === 0"
            @click="createAndAttach(); close()"
          >
            {{ t('tags.create', { title: draft.trim() }) }}
          </button>
        </div>
      </template>
    </AppPopover>
  </div>
</template>

<style scoped>
.tag-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  /* 挂在文档头那一行里：自己不加边框与内边距，行高由 `.pane-header` 那一层管（§3.4 逐像素贴住）。 */
  padding: 0;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--h-row);
  padding: 0 var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r-chip);
  background: var(--surface);
  color: var(--ink);
  font-size: var(--text-sm);
}

.tag-chip--add {
  border-style: dashed;
  color: var(--body);
}

.tag-chip__label {
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 摘掉那颗 ×：命中区交给 `.btn--icon`（app 级 44 的那一条），这里只管视觉大小。 */
.tag-chip__x {
  margin-right: calc(var(--sp-1) * -1);
}

.tag-chip__x :deep(svg) {
  color: var(--mute);
}

.tag-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 220px;
  padding: var(--sp-2);
}

.tag-panel__input {
  width: 100%;
}

.tag-panel__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.tag-panel__count {
  margin-left: var(--sp-2);
  color: var(--mute);
  font-size: var(--text-xs);
}

.tag-panel__hint {
  margin: 0;
  color: var(--mute);
  font-size: var(--text-xs);
}
</style>
