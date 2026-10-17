<script setup lang="ts">
/**
 * 标题栏：
 *  - Windows：自绘标题栏（拖拽区 + 最小/最大/关闭），保留系统贴靠（data-tauri-drag-region）
 *  - macOS：隐藏标题栏，这里只留交通灯位与拖拽区
 *  - 其它：由壳层自带，前端不画
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { inTauri } from '../api/bridge';
import { shouldHideOnClose } from '../platform/caps';
import { useSettingsStore } from '../stores/settings';
import { useShellStore } from '../stores/shell';
import { t } from '../i18n';
import AppIcon from './ui/AppIcon.vue';

const settings = useSettingsStore();
const shell = useShellStore();

const chrome = computed(() => settings.caps.windowChrome);
const visible = computed(() => chrome.value !== 'system');
const overlay = computed(() => chrome.value === 'overlay');

/**
 * 最大化的**现值**：那颗键本来就 `toggleMaximize()`（动作是真的），但图标以前恒画 `win-max`
 * ⇒ 窗口已经铺满整屏，标题栏还在说"去最大化"。
 * `@tauri-apps/api@2.12.0` 的 `window` 模块**只导出** `onResized` / `isMaximized`（没有 `onMaximized`/`onUnmaximized`），
 * 所以状态取"resize 之后重问一次 `isMaximized()`"——不猜、不在前端复刻最大化算法（那会把壳层的判断复制一份到界面里）。
 * 标签不在这一格里改：`win.maximize` 的值本来就是「最大化或还原」（`i18n.ts:406`），说谎的只有图标。
 */
const maximized = ref(false);
let unlistenResize: (() => void) | null = null;
let watching = false;

async function refreshMaximized(win: { isMaximized: () => Promise<boolean> }): Promise<void> {
  if (!watching) return;
  try {
    maximized.value = await win.isMaximized();
  } catch {
    // 问不到就留着上一次的值：这一格错了也只错一个图标，不该把异常抛到界面上。
  }
}

onMounted(() => {
  if (!inTauri()) return;
  watching = true;
  void (async () => {
    try {
      const api = await import('@tauri-apps/api/window');
      const win = api.getCurrentWindow();
      await refreshMaximized(win);
      unlistenResize = await win.onResized(() => {
        void refreshMaximized(win);
      });
    } catch {
      // 壳层未就绪：图标留在 win-max（未最大化的那一面），与接不上时的旧行为一致。
    }
  })();
});

onUnmounted(() => {
  watching = false;
  unlistenResize?.();
  unlistenResize = null;
});

async function windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  if (!inTauri()) return;
  try {
    const api = await import('@tauri-apps/api/window');
    const win = api.getCurrentWindow();
    if (action === 'minimize') await win.minimize();
    else if (action === 'maximize') await win.toggleMaximize();
    else if (shouldHideOnClose(settings.caps, settings.prefs)) await win.hide();
    else await win.close();
  } catch {
    // 壳层未就绪时什么都不做，绝不让界面报错
  }
}
</script>

<template>
  <header v-if="visible" class="titlebar" :class="{ 'titlebar--overlay': overlay }" data-testid="titlebar">
    <div class="titlebar__drag" data-tauri-drag-region>
      <button type="button" class="btn btn--quiet btn--icon" data-testid="sidebar-handle" :aria-label="t(shell.sidebarShown ? 'sidebar.collapse' : 'sidebar.expand')" @click="shell.toggleSidebar()">
        <AppIcon :size="18" name="menu" />
      </button>
      <span class="titlebar__brand" data-tauri-drag-region>{{ t('app.name') }}</span>
      <span v-if="!overlay" class="titlebar__tagline text-sm text-muted" data-tauri-drag-region>{{ t('app.tagline') }}</span>
    </div>
    <div v-if="!overlay" class="titlebar__actions">
      <button type="button" class="titlebar__button" :aria-label="t('win.minimize')" :title="t('win.minimize')" @click="windowAction('minimize')">
        <AppIcon :size="18" name="win-min" />
      </button>
      <button type="button" class="titlebar__button" :aria-label="t('win.maximize')" :title="t('win.maximize')" @click="windowAction('maximize')">
        <AppIcon :size="18" :name="maximized ? 'win-restore' : 'win-max'" />
      </button>
      <button type="button" class="titlebar__button titlebar__button--close" :aria-label="t('win.close')" :title="t('win.close')" @click="windowAction('close')">
        <AppIcon :size="18" name="close" />
      </button>
    </div>
  </header>
</template>
