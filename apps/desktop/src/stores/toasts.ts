/** 轻提示：文案一律来自本地文案表（messageKey），不显示原始错误码。 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { messageFor, t } from '../i18n';
import { realTimers, type Timers } from '../util/timing';

export type ToastLevel = 'info' | 'warn' | 'error';

/**
 * 一条提示上的**动作**（第一百五十二批加的这一族：删除之后的「撤销」）。
 *
 * 为什么动作会改变"自动消失"这件事：§4.9 那句「4.5s 自动消失」说的是**读完就可以丢掉**的那一类。
 * 带动作的那一条不是"读完"，是"处理完"—— 撤销那颗按钮 4.5 秒后自己溜走，等于给用户一个
 * 他来不及点的出口（删除那一刻最能救的窗口就是那几秒）。所以这一族的计时**不排**，
 * 由用户点动作或点「知道了」收尾；无动作的那一族照旧 4500ms（判据在 `deckNumbers.spec.ts` ①）。
 */
export interface ToastAction {
  /** 已经渲染成最终文字的标签（不是 i18n 键）—— 与 `text` 同一档，避免这一层再翻译一次。 */
  readonly label: string;
  readonly run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  level: ToastLevel;
  action?: ToastAction;
}

const TTL_MS = 4500;
let counter = 0;

export const useToastStore = defineStore('toast', () => {
  const items = ref<Toast[]>([]);
  let timers: Timers = realTimers;

  function dismiss(id: number): void {
    items.value = items.value.filter((item) => item.id !== id);
  }

  function pushText(text: string, level: ToastLevel = 'info', action?: ToastAction): Toast {
    counter += 1;
    const toast: Toast = action ? { id: counter, text, level, action } : { id: counter, text, level };
    items.value = [...items.value, toast];
    // **带动作的那一条不排自动消失**（见上面 `ToastAction` 那段）：出口不许自己溜走。
    // 这一句是这一族唯一的行为差别，判据在 `toastUndo.spec.ts` 与 `deckNumbers.spec.ts` ① 两边各钉一侧。
    if (!action) timers.set(() => dismiss(toast.id), TTL_MS);
    return toast;
  }

  function push(messageKey: string, level: ToastLevel = 'info', action?: ToastAction): Toast {
    return pushText(messageFor(messageKey), level, action);
  }

  /**
   * 点动作那颗。**先撤条、再跑动作**：反过来的话，动作里那句"已经撤销"的新提示
   * 会被这条的消失挤一下顺序（两条同屏时用户读到的是后推的那条在前）。
   */
  function invoke(id: number): void {
    const toast = items.value.find((item) => item.id === id);
    if (!toast?.action) return;
    dismiss(id);
    toast.action.run();
  }

  function setTimers(next: Timers): void {
    timers = next;
  }

  return { items, push, pushText, dismiss, invoke, setTimers, t };
});
