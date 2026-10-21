<script setup lang="ts">
/**
 * 统一的复选框：**只把绘制接过来**，语义仍然交给原生 `<input type="checkbox">`。
 *
 * 为什么原生那一颗不行：`accent-color` 只能改颜色，改不了**形状与尺寸** —— Windows 画 Fluent
 * 那颗方圆角、macOS 画另一套、手机上还是系统控件，用户那句「Windows 与 Mac 的 UI 要一致」
 * 在这里就没有解。而且默认那一颗只有 13×13（本项目设置页导出那两格连 class 都没上），
 * 远低于 §6 的 44pt 触摸下限。
 *
 * 为什么不用 `role="checkbox"` 自己画一颗按钮：那样键盘（空格切换）、读屏（真 checkbox 角色
 * 与 label 关联）、表单参与都要自己再实现一遍 —— 无头库的价值在**行为**，而 checkbox 的行为
 * 浏览器已经给了，这里缺的只是外观。所以 `appearance: none` + token 画框，其余不动。
 */
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 读屏名字；同时作为可见文案（原生那颗靠旁边的 `<label>` 蹭名字，这里显式给）。 */
    label: string;
    testid?: string;
    disabled?: boolean;
  }>(),
  { testid: 'app-checkbox', disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label class="app-check" :data-testid="`${props.testid}-row`">
    <span class="app-check__box-wrap">
      <input
        type="checkbox"
        class="app-check__box"
        :checked="props.modelValue"
        :disabled="props.disabled"
        :aria-label="props.label"
        :data-testid="props.testid"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <!-- 方框与勾是 §2.2"方框"载体的两态（同一条基形，只多一笔），从图标系统的唯一来源里取。
           以前这一格是 CSS 画的：四端形状本来就一致，也不违反 §2 那句"禁 Unicode 字形"，
           但它**不在图标表里** ⇒ §2.2 的载体台账机检不到它（今天那条缺口就是这么来的）。
           那颗原生 input 还在（键盘空格、读屏角色、表单参与都靠它），只是不再自己画东西。 -->
      <span class="app-check__art" aria-hidden="true">
        <AppIcon :size="18" :name="props.modelValue ? 'checkbox-checked' : 'checkbox-unchecked'" />
      </span>
    </span>
    <span class="app-check__text">{{ props.label }}</span>
  </label>
</template>

<style scoped>
/* 整行都是命中区：`min-height` 用 --touch，所以手指点在文案上也能切换 */
.app-check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--touch);
  padding: var(--sp-1) 0;
  cursor: pointer;
}

/* 那颗 input 仍然是**行为**的载体（空格切换、真 checkbox 角色、表单参与），
   只是把绘制整层交给上面那枚 SVG —— 所以它自己不再画边框与底色。 */
.app-check__box-wrap {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 1.375rem;
  height: 1.375rem;
}

.app-check__box {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 100%;
  margin: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.app-check__art {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  /* 不吃指针：命中的仍然是那颗 input（§5 的 44 那一档由整行的 label 兜）。 */
  pointer-events: none;
  color: var(--body);
  /* 换的是那两条 path（切换本身不可过渡），可过渡的是选中色与禁用那层淡出 —— §4.9 的 fast 一档挂在这两处。 */
  transition:
    color var(--motion-fast) var(--ease),
    opacity var(--motion-fast) var(--ease);
}

/* 选中态只换颜色：方框那一条基形两态共用（§2.3 那条原则："共用同一片轮廓，只换内部徽标"）。 */
.app-check__box:checked + .app-check__art {
  color: var(--accent);
}

.app-check__box:disabled + .app-check__art {
  opacity: 0.45;
}

.app-check__box:focus-visible {
  outline: var(--focus-width) solid var(--accent);
  outline-offset: 2px;
}

.app-check__box:disabled {
  cursor: default;
  opacity: 0.45;
}

.app-check__text {
  color: var(--ink);
  font-size: var(--text-sm);
}
</style>
