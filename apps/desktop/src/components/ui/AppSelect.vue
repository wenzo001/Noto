<script setup lang="ts">
/**
 * 统一的下拉选择：外观由本项目的 token 决定，行为交给 Headless UI。
 *
 * 为什么不用原生 `<select>`：它的展开面板是**操作系统**画的 —— 同一份代码在
 * Windows 是 Fluent 那一套、在 macOS 是原生那一圈、手机上又是一层原生覆盖，
 * 用户那句「Windows 与 Mac 的 UI 要一致」在这里就没有解。
 * 交给无头库之后，键盘（↑↓ / Home / End / Esc / 首字母跳转）由库负责，
 * 我们只写样式，不再自己实现一遍下拉的行为。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/vue';
import AppIcon from './AppIcon.vue';

export interface SelectOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly SelectOption[];
    /** 读屏与 `labelledby` 用的名字（原生 select 以前靠旁边的 <label> 蹭名字）。 */
    label: string;
    testid?: string;
    disabled?: boolean;
  }>(),
  { testid: 'app-select', disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.options[0]?.label ?? '',
);

/**
 * 面板落点：下面装得下就往下面开，装不下就翻到上面 —— 这套数学本仓早就有（`AppPopover.vue`），
 * 缺的只是把它接到 `AppSelect` 上。之前面板是流内 `static`，永远贴着触发键往下排、**完全不认视口**：
 * 2026-10-13 实测同一颗 TLS 下拉，触发键靠上时面板 `701→887` 恰好装得下，靠下时 `806→992` 出屏 42 像素
 * —— 于是"选项在不在屏上"取决于当时页面里画了多少别的东西，那既不是判据能钉的东西，更不是用户体验。
 *
 * 三条从 `AppPopover` 抄来的硬约束，一条都不能省：
 * ① **先清掉上一轮的 top/left 再量自然尺寸** —— 留着会把这一轮读歪（连开两次会一路往屏幕外跑）；
 * ② **量到的值直接写到节点上，不走响应式 `:style`** —— 多一次重渲染曾在整跑里惹出"Esc 关不掉那层"；
 * ③ **等一拍再量** —— 面板这一刻刚挂上，同帧读到的尺寸不算数。
 *
 * 触发用的是 MutationObserver 而不是库的 open 事件：1.7.23 的 `Listbox` 不把 open 事件化
 * （只在插槽里给），而面板本来就是"开着才挂、关着就卸"——观察挂载这件事本身就是那一下开关，
 * 不用去猜库的内部。`!panel.style.top` 那一格保证只在**刚挂上**时算一次，不被无关变动反复重算。
 */
const EDGE = 8;
const GAP = 4;
const wrap = ref<HTMLElement | null>(null);
let observer: MutationObserver | null = null;

function placePanel(panel: HTMLElement, trigger: HTMLElement): void {
  panel.style.top = '';
  panel.style.left = '';
  const t = trigger.getBoundingClientRect();
  const r = panel.getBoundingClientRect();
  const vh = document.documentElement.clientHeight;
  const vw = document.documentElement.clientWidth;
  const fitsBelow = t.bottom + GAP + r.height <= vh - EDGE;
  const top = fitsBelow ? t.bottom + GAP : Math.max(EDGE, t.top - GAP - r.height);
  panel.style.top = `${Math.round(top - t.top)}px`;
  // 横向只夹不移：面板与触发键同宽起步，超出视口时往里收（列表行里那颗「移到」就是这形状）
  const left = Math.max(EDGE, Math.min(t.left, vw - r.width - EDGE));
  panel.style.left = `${Math.round(left - t.left)}px`;
}

onMounted(() => {
  const host = wrap.value;
  if (!host) return;
  observer = new MutationObserver(() => {
    const panel = host.querySelector<HTMLElement>('.app-select__panel');
    const trigger = host.querySelector<HTMLElement>('.app-select');
    if (!(panel && trigger) || panel.style.top !== '') return;
    // 等一拍：上面这一帧面板的尺寸还只是"挂上了"，量它会读到未布局的数
    void Promise.resolve().then(() => {
      if (panel.isConnected) placePanel(panel, trigger);
    });
  });
  observer.observe(host, { childList: true, subtree: true });
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="wrap" class="app-select-wrap">
    <Listbox
      :model-value="props.modelValue"
      :disabled="props.disabled"
      @update:model-value="emit('update:modelValue', String($event))"
    >
      <ListboxButton class="app-select" :data-testid="props.testid" :aria-label="props.label">
        <span class="app-select__value">{{ currentLabel }}</span>
        <AppIcon class="app-select__chevron" :size="16" name="chevron-down" />
      </ListboxButton>

      <ListboxOptions class="app-select__panel" data-testid="app-select-panel">
        <ListboxOption
          v-for="opt in props.options"
          :key="opt.value"
          :value="opt.value"
          class="app-select__option"
          :data-value="opt.value"
        >
          {{ opt.label }}
        </ListboxOption>
      </ListboxOptions>
    </Listbox>
  </div>
</template>

<style scoped>
/* 定位父级：面板的 top/left 是相对**触发键**算出来的，所以这层必须 own 坐标系。
   `display: flex` 让原来由 Listbox 那个 div 承担的排布照旧（那颗触发键宽度不变）。 */
.app-select-wrap {
  position: relative;
  display: flex;
}

.app-select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  min-height: var(--touch);
  min-width: 8.5rem;
  padding: 0 var(--sp-3);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-card);
  background: var(--canvas);
  color: var(--ink);
  font: inherit;
  font-size: var(--text-sm);
  text-align: start;
  cursor: pointer;
}

.app-select:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--hover);
}

.app-select:disabled {
  opacity: 0.5;
  cursor: default;
}

.app-select__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-select__chevron {
  flex: 0 0 auto;
  color: var(--mute);
}

/* 面板画在我们这边：这一格就是"两端一致"的全部内容。
   z-index 90 与 base.css 里浮层那一批同档（overlay/drawer 是 100，必须盖住我们）。
   从流内 `static` 换成 `absolute` 之后它**不再顶开下面的内容**，落点由 placePanel() 说了算；
   原来那句 `margin: var(--sp-1) 0` 是"流内时代"的间隙，留着会被算进 top 里、让落点偏 4px —— 间距归 GAP 一个人管。 */
.app-select__panel {
  position: absolute;
  z-index: 90;
  min-width: 100%;
  max-height: 18rem;
  padding: var(--sp-1);
  overflow: auto;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-card);
  background: var(--canvas, var(--canvas));
  box-shadow: var(--shadow-2);
  outline: none;
}

.app-select__option {
  display: flex;
  align-items: center;
  min-height: var(--touch);
  padding: 0 var(--sp-3);
  border-radius: var(--r-row);
  color: var(--ink);
  font-size: var(--text-sm);
  cursor: pointer;
}

.app-select__option[data-active='true'] {
  background: var(--hover);
}

.app-select__option[data-selected='true'] {
  color: var(--accent);
  font-weight: 600;
}
</style>
