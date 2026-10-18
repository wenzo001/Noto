<script setup lang="ts">
/**
 * 侧栏的标签那一族（ADR-0022）：列出活标签、点一下筛、就地改名、删除前用悬浮窗确认。
 *
 * 三条与规范/裁定绑定的形状：
 *  · 顺序来自 `tags.ordered`（`Collator` + `numeric`），这里不再各算一遍；
 *  · 计数来自核心（`list_tags` 的 `noteCount`，别名链接已改写计到 winner）——
 *    界面**不数笔记**，那是第二个执行者；
 *  · 删除的确认走悬浮层（§6 那条"提示应该是悬浮窗的层级，而不是底下占了一个"）。
 */
import { nextTick, ref } from 'vue';
import { useTagStore } from '../stores/tags';
import { useNoteStore } from '../stores/notes';
import { useShellStore } from '../stores/shell';
import { t, messageFor } from '../i18n';
import AppIcon from './ui/AppIcon.vue';
import AppPopover from './ui/AppPopover.vue';
import type { Tag } from '../api/types';

const tags = useTagStore();
const notes = useNoteStore();
const shell = useShellStore();

const editingId = ref<string | null>(null);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function isActive(id: string): boolean {
  return shell.view === 'workspace' && notes.mode.kind === 'tag' && notes.mode.tagId === id;
}

function openTag(id: string): void {
  void notes.setMode({ kind: 'tag', tagId: id });
  shell.openList();
}

function lookAll(): void {
  void notes.setMode({ kind: 'all' });
  shell.openList();
}

function beginRename(tag: Tag): void {
  editingId.value = tag.id;
  draft.value = tag.title;
  void nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

async function commitRename(id: string): Promise<void> {
  if (editingId.value !== id) return;
  editingId.value = null;
  const title = draft.value.trim();
  if (title.length === 0 || title === tags.byId[id]?.title) return;
  const ok = await tags.rename(id, title);
  // 改名失败（例如与另一颗同名）不能留下一行"看起来改成了"的读数：回读一次，
  // 让界面显示的永远是库里那一份。
  if (!ok) await tags.load();
}

function rowRef(el: Element | { $el?: Element } | null): void {
  // 模板里不能直接 `instanceof HTMLInputElement`（那一层看不到全局 DOM 构造器），
  // 所以照 FolderTree 的做法把收 ref 的活收进 script。
  const node = el instanceof Element ? el : (el?.$el ?? null);
  inputEl.value = node instanceof HTMLInputElement ? node : null;
}

async function removeTag(id: string, close: () => void): Promise<void> {
  close();
  if (!(await tags.remove(id))) {
    await tags.load();
    return;
  }
  // 正在按这颗筛 → 回到"全部"，否则列表停在一片空行上而侧栏已经没有那颗了。
  if (notes.mode.kind === 'tag' && notes.mode.tagId === id) await notes.setMode({ kind: 'all' });
  else await notes.load();
}
</script>

<template>
  <section class="tags" :aria-label="t('tags.section')" data-testid="tag-section">
    <div class="tags__head">
      <h3 class="tags__title">{{ t('tags.section') }}</h3>
      <button
        v-if="notes.mode.kind === 'tag'"
        type="button"
        class="btn btn--quiet tags__clear"
        data-testid="tag-browse-clear"
        @click="lookAll"
      >
        {{ t('tags.filterClear') }}
      </button>
    </div>

    <p v-if="tags.errorKey" class="tags__error" data-testid="tag-error">{{ messageFor(tags.errorKey) }}</p>

    <p v-if="tags.ordered.length === 0 && !tags.loading" class="tags__empty" data-testid="tags-none">
      {{ t('tags.none') }}
    </p>

    <ul v-else class="tags__list" role="list">
      <li v-for="tag in tags.ordered" :key="tag.id" class="tags__item">
        <div class="tags__row" :data-active="isActive(tag.id) ? 'true' : 'false'" data-testid="tag-row-item">
          <input
            v-if="editingId === tag.id"
            :ref="rowRef"
            v-model="draft"
            class="input tags__input"
            type="text"
            data-testid="tag-rename-input"
            :aria-label="t('sidebar.rename')"
            @keydown.enter.prevent="commitRename(tag.id)"
            @keydown.esc.prevent="editingId = null"
            @blur="commitRename(tag.id)"
          />
          <template v-else>
            <button
              type="button"
              class="tags__name"
              :data-testid="`tag-${tag.id}`"
              @click="openTag(tag.id)"
            >
              <span class="tags__label">{{ tag.title }}</span>
              <span v-if="tag.noteCount > 0" class="tags__count">{{ tag.noteCount }}</span>
            </button>
            <button
              type="button"
              class="btn btn--quiet btn--icon"
              data-testid="tag-rename"
              :title="t('sidebar.rename')"
              :aria-label="t('sidebar.rename')"
              @click="beginRename(tag)"
            >
              <AppIcon :size="16" name="pencil" />
            </button>
            <AppPopover
              testid="tag-delete"
              align="end"
              :label="t('tags.delete', { title: tag.title })"
            >
              <template #default="{ close }">
                <div class="tags__confirm" data-testid="tag-delete-panel">
                  <p class="tags__confirm-text">{{ t('tags.delete', { title: tag.title }) }}</p>
                  <button
                    type="button"
                    class="btn btn--danger btn--block"
                    data-testid="tag-delete-confirm"
                    :aria-pressed="'false'"
                    @click="removeTag(tag.id, close)"
                  >
                    {{ t('list.delete') }}
                  </button>
                </div>
              </template>
            </AppPopover>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.tags {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  border-top: 1px solid var(--line);
  margin-top: var(--sp-2);
}

.tags__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.tags__title {
  margin: 0;
  color: var(--mute);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.tags__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tags__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--touch);
  border-radius: var(--r-row);
}

.tags__row[data-active='true'] {
  background: var(--accent-soft);
}

.tags__name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--touch);
  padding: 0 var(--sp-2);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: start;
}

.tags__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tags__count {
  margin-left: auto;
  color: var(--mute);
  font-size: var(--text-xs);
}

.tags__input {
  flex: 1;
}

.tags__clear {
  font-size: var(--text-xs);
}

.tags__empty,
.tags__error {
  margin: 0;
  color: var(--mute);
  font-size: var(--text-sm);
}

.tags__error {
  color: var(--danger);
}

.tags__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 200px;
  padding: var(--sp-2);
}

.tags__confirm-text {
  margin: 0;
  color: var(--body);
  font-size: var(--text-sm);
}
</style>
