<script setup lang="ts">
import { useToastStore } from '../stores/toasts';
import { t } from '../i18n';

const toasts = useToastStore();
</script>

<template>
  <div class="toast-host" data-testid="toast-host">
    <div v-for="toast in toasts.items" :key="toast.id" class="toast" :class="`toast--${toast.level}`" role="status">
      <span>{{ toast.text }}</span>
      <span class="banner__spacer" />
      <!-- 第一百五十二批：带动作的那一条（删除之后的「撤销」）。放在「知道了」**之前**：
           右边那颗是"读过了、丢掉"，左边这颗是"对这句话做个处理"—— 撤销点完之后这条也该走，
           所以它走的是 store 的 `invoke`（先撤条再跑动作），不是自己 dismiss。 -->
      <button
        v-if="toast.action"
        type="button"
        class="btn btn--quiet toast__action"
        data-testid="toast-action"
        @click="toasts.invoke(toast.id)"
      >{{ toast.action.label }}</button>
      <!-- §4.9：Toast 要带一颗「知道了」。以前这里是一颗 `×`（U+00D7，图标门禁的枚举表没列到它）——
           既是拿符号顶图形，也少了"这条提示我读过了"那句话。文案键 `state.dismiss` 本来就是"知道了"。 -->
      <button type="button" class="btn btn--quiet toast__ack" data-testid="toast-ack" @click="toasts.dismiss(toast.id)">{{ t('state.dismiss') }}</button>
    </div>
  </div>
</template>
