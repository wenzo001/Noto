<script setup lang="ts">
/**
 * 文内查找条（采纳 Joplin 的 `showLocalSearch`，A 档）。
 *
 * 形状上的四条决定：
 *  · **贴在状态条上面，不浮在正文上**。浮层会自造最坏深度，还会把刚跳到的那一行盖住；
 *    `.editor-corner` 本来就是占位的，查找条跟它同一条流 ⇒ 命中那一行永远在条的上方可见。
 *  · **三颗动作复用共享的 `btn btn--quiet btn--icon`**（与标签那颗 × 同一份实现）。
 *    不自己写一遍圆角/焦点环/禁用档 —— 那会长出第二个执行者，而 44 与 0.45 这两格本仓已经反复红过。
 *  · **只读态也在**（找词在只读里同样有用），但它自己一个字都不写：命中靠选区，不往正文插东西。
 *  · 计数那句话在零处时说"没有匹配"，不许写"第 0 / 0"那种看着像有匹配的数。
 */
import { computed } from 'vue';
import { t } from '../i18n';
import AppIcon from './ui/AppIcon.vue';

const props = defineProps<{
  query: string;
  total: number;
  /** 当前停在哪一处（-1 = 还没跳）。 */
  current: number;
}>();

const emit = defineEmits<{
  (e: 'update:query', value: string): void;
  (e: 'next'): void;
  (e: 'prev'): void;
  (e: 'close'): void;
}>();

const value = computed({
  get: () => props.query,
  set: (raw: string) => emit('update:query', raw),
});

/** `current` 是 0 基的下标，屏幕上要说第几处 ⇒ +1。 */
const counter = computed(() =>
  props.total === 0
    ? t('editor.findNone')
    : t('editor.findCount', { current: props.current + 1, total: props.total }),
);
</script>

<template>
  <div class="find-bar" role="search" data-testid="find-bar">
    <input
      v-model="value"
      class="find-bar__input text-sm"
      type="search"
      inputmode="search"
      enterkeyhint="search"
      :placeholder="t('editor.findPlaceholder')"
      :aria-label="t('editor.find')"
      data-testid="find-input"
      @keydown.enter.exact.prevent="emit('next')"
      @keydown.enter.shift.exact.prevent="emit('prev')"
      @keydown.esc.prevent="emit('close')"
    />
    <span class="find-bar__count text-sm text-muted" data-testid="find-count">{{ counter }}</span>
    <div class="find-bar__actions">
      <button
        type="button"
        class="btn btn--quiet btn--icon"
        :aria-label="t('editor.findPrev')"
        :disabled="total === 0"
        data-testid="find-prev"
        @click="emit('prev')"
      >
        <AppIcon name="chevron-up" :size="20" />
      </button>
      <button
        type="button"
        class="btn btn--quiet btn--icon"
        :aria-label="t('editor.findNext')"
        :disabled="total === 0"
        data-testid="find-next"
        @click="emit('next')"
      >
        <AppIcon name="chevron-down" :size="20" />
      </button>
      <button
        type="button"
        class="btn btn--quiet btn--icon"
        :aria-label="t('editor.findClose')"
        data-testid="find-close"
        @click="emit('close')"
      >
        <AppIcon name="close" :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.find-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--canvas);
}

.find-bar__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--touch);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-chip);
  background: var(--surface);
  color: var(--ink);
}

.find-bar__count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.find-bar__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex: 0 0 auto;
}
</style>
