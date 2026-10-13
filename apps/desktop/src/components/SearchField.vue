<script setup lang="ts">
import { ref } from 'vue';
import { useNoteStore } from '../stores/notes';
import { t } from '../i18n';
import AppIcon from './ui/AppIcon.vue';

const notes = useNoteStore();
const inputEl = ref<HTMLInputElement | null>(null);

function onInput(event: Event): void {
  notes.requestSearch((event.target as HTMLInputElement).value);
}

function focus(): void {
  inputEl.value?.focus();
  inputEl.value?.select();
}

function clear(): void {
  notes.clearSearch();
  inputEl.value?.focus();
}

defineExpose({ focus, clear });
</script>

<template>
  <!-- 这一层必须是 label：§1.4 把输入框的涂装收成 36，§5 的 44 由这一层补 —— 而"点行里的空白也能
       聚焦输入框"靠的是 label 的原生转发，换成 div 就只剩样式，命中区会静默缩回 36。
       输入框排在这颗 label 的第一个可标注后代位上（清除那颗在它后面），转发才落得对。 -->
  <label class="search input-hit">
    <input
      id="note-search"
      ref="inputEl"
      class="input search__input"
      type="search"
      role="searchbox"
      autocomplete="off"
      spellcheck="false"
      :aria-label="t('list.searchPlaceholder')"
      :placeholder="t('list.searchPlaceholder')"
      :value="notes.query"
      data-testid="search-input"
      @input="onInput"
      @keydown.escape.prevent="clear()"
    />
    <button v-if="notes.query" type="button" class="btn btn--quiet btn--icon search__clear" :aria-label="t('state.dismiss')" data-testid="search-clear" @click="clear">
      <AppIcon :size="18" name="close" />
    </button>
  </label>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: center;
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}

.search__input {
  padding-right: var(--sp-12);
}

.search__input::-webkit-search-cancel-button {
  display: none;
}

.search__clear {
  position: absolute;
  right: var(--sp-3);
}
</style>
