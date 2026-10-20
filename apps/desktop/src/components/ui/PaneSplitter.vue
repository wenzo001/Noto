<script setup lang="ts">
/**
 * 三栏之间的拖动把手（第一百六十一批，P3）。桌面三栏才出现；两栏/单栏由 CSS 直接藏掉。
 *
 * 命中带刻意比画出来的那条线宽（10px）：鼠标手势要的是"抓得住"，不是"看得见多粗"。
 * 键盘：左右箭头 ±16、Shift+左右 ±64 —— **不占全局键位**（D21/A11 那张表名额是满的，
 * 这一发只在把手自己拿到焦点时生效）。双击 = 回到 tokens 里那两颗默认值。
 */
import { ref } from 'vue';
import { t } from '../../i18n';
import { PANE_LIMITS, usePaneWidthsStore, type PaneId } from '../../stores/paneWidths';

const props = defineProps<{ which: PaneId; testid: string }>();
const panes = usePaneWidthsStore();
const dragging = ref(false);
let startX = 0;
let startW = 0;

function width(): number {
  return props.which === 'sidebar' ? panes.sidebar : panes.list;
}

function onPointerDown(ev: PointerEvent): void {
  dragging.value = true;
  startX = ev.clientX;
  startW = width();
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  panes.set(props.which, startW + (ev.clientX - startX));
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
  // 落盘只在松手那一刻：拖的过程中每移动一像素写一次 localStorage 是没必要的抖动。
  panes.commit();
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  const step = ev.shiftKey ? 64 : 16;
  panes.set(props.which, width() + (ev.key === 'ArrowRight' ? step : -step));
  panes.commit();
}
</script>

<template>
  <div
    class="splitter"
    :class="{ 'splitter--dragging': dragging }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="t('layout.resize')"
    :aria-valuenow="width()"
    :aria-valuemin="PANE_LIMITS[which].min"
    :aria-valuemax="PANE_LIMITS[which].max"
    :data-testid="testid"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKey"
    @dblclick="panes.reset()"
  />
</template>
