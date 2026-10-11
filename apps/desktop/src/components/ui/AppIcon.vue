<script setup lang="ts">
/**
 * 一枚 SVG 图标（设计稿 §2 / §2.5）。规格与形状清单在 `./icons.ts`，那里是唯一来源。
 *
 * 尺寸：20 是基准画布；§2.5 说的 28/44/52 是**触摸容器**的尺寸，不是把图标放大。
 * 可及性：旁边没有文字时必须传 `label`，否则整枚 `aria-hidden`（§5 要求每个可交互控件有可读名字，
 * 那是控件的事，不是装饰图的事 —— 装饰图进可及性树反而会被念两遍）。
 */
import { computed } from 'vue';
import { ICONS, type IconName } from './icons';

const props = withDefaults(defineProps<{
  name: IconName;
  size?: number;
  testid?: string;
  label?: string;
}>(), { size: 20 });

const spec = computed(() => ICONS[props.name] ?? { d: [] });
/**
 * §2.1 的描边是**画布的比例**（1.75 : 20 ≈ 1:11.4，`icons.ts` 头部同一句话），不是"随尺寸缩放的视觉值"：
 * viewBox 固定 20，所以描边永远写 1.75 用户单位 —— 渲染尺寸把整枚（含笔触）一起缩放，
 * 同尺寸的图标在屏幕上必然同粗细。以前这里按 `size` 反算（16 ⇒ 1.4 用户单位 = 1:14.3），
 * 于是同一屏出现 1.4 / 1.58 / 1.75 / 2.45 四种笔触 —— 恰好就是 §2.1 点名要避免的那种混用。
 */
const stroke = 1.75;
</script>

<template>
  <svg
    class="icon"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 20 20"
    :aria-label="props.label"
    :aria-hidden="props.label ? undefined : 'true'"
    :data-testid="props.testid"
    :data-icon="props.name"
    fill="none"
  >
    <g
      stroke="currentColor"
      :stroke-width="stroke"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
    >
      <path v-for="(d, i) in spec.d" :key="`p${i}`" :d="d" />
    </g>
    <!-- 虚线那一组：dash 长度写在 viewBox 单位里，所以它跟着尺寸一起缩放，不需要按 size 换算。 -->
    <g
      v-if="spec.dashed?.length"
      stroke="currentColor"
      :stroke-width="stroke"
      stroke-dasharray="1.7 1.7"
      stroke-linecap="round"
      fill="none"
    >
      <path v-for="(d, i) in spec.dashed" :key="`d${i}`" :d="d" />
    </g>
    <g fill="currentColor" stroke="none">
      <path v-for="(d, i) in spec.solid ?? []" :key="`s${i}`" :d="d" />
      <circle v-for="(c, i) in spec.dots ?? []" :key="`c${i}`" :cx="c[0]" :cy="c[1]" :r="stroke" />
    </g>
  </svg>
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: middle;
  color: inherit;
}
</style>
