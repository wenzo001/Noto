# §2.4 全量图标清单：逐名对账（2026-10-13）

> **历史文档（冻结）**：以下是 2026-10-13 的逐名对账，**不再随代码更新**；图标现状以代码与
> `scripts/arch-check.mjs` 的图标腿为准。

规范 §2.4 把图标按五组点名（同步五格 / 导航与组织 10 枚 / 编辑器工具条 13 枚 / 清单与状态 8 枚 / 窗口控制 Windows 4 · macOS 3）。
这一份是**逐名对到实现上**的台账：每一行要么给出 `icons.ts` 里的键，要么给出"它不是 SVG"的实测依据，
要么**明写未取证**。它不是判据（判据在 `iconSystem.spec.ts` / `check-icons.mjs` / 腿 ㉟/62/66），它是给设计师的交接面。

## 怎么取的数（可复现）

- 注册表：`apps/desktop/src/components/ui/icons.ts` 里 `export const ICONS` 的键 ⇒ **45 枚**：
  `alert arrow-back attach-file attach-image check chevron-down chevron-left chevron-right close drag-handle
  indent-in indent-out list mark-bold mark-code mark-color mark-highlight mark-italic mark-size mark-strike
  mark-underline menu pencil pin-off pin-on plus question redo rule save-dirty save-failed save-saved save-saving
  settings sync-failed sync-idle sync-offline sync-synced sync-syncing trash undo warn win-max win-min win-restore`
- UI 侧点名：扫 `src/**` 里的 `name="…"` / `icon="…"` / `icon: '…'` ⇒ 33 个被字面点名（其中 `glyph` 是 props 名，不是图标）。
  另有 **12 枚只走查表**（`SYNC_ICONS[badge]` / `SAVE_ICONS[state]` / 置顶那颗 `:glyph` 绑变量 / `win-restore` 是条件表达式）
  ⇒ **"没被字面点名"不等于死代码**，这一条我差点写错，故写在这儿。
- 规范原文：`docs/design/Noto-界面设计规范.from-share.txt` §2.4 那五行。

## 一、点名对得上（有 SVG 键）

| 规范那一行 | 实现键 | 备注 |
|---|---|---|
| 同步五格（已同步 / 正在同步 / 离线 / 同步失败 / 未在同步） | `sync-synced` `sync-syncing` `sync-offline` `sync-failed` `sync-idle` | 五枚共享同一片云轮廓（腿 62/§2.2 载体那条判据守着）|
| 保存三态（规范 §2.2 说"三态"，§2.4 列了三枚 + 实现有四格） | `save-saved` `save-dirty` `save-saving` `save-failed` | §4.1 那张表是**四格**，实现按四格走；差的那一格（正在保存）不是漂移，是 §2.4 少列 |
| 星标双态（置顶·已置顶 / 置顶·未置顶） | `pin-on` `pin-off` | 同族共享基形已登记在 §2.2 的台账里 |
| 菜单 / 全部笔记 / 删除 / 设置 / 返回 | `menu` `list` `trash` `settings` `arrow-back` | 侧栏 `SidebarPanel.vue` 那五排实测就是这几个名 |
| 需要处理的版本（冲突那一排） | `warn` | |
| 加粗 / 斜体 / 下划线 / 删除线 | `mark-bold` `mark-italic` `mark-underline` `mark-strike` | 第 15 刀把 B/I 字形换成 SVG 路径那一批 |
| 下拉箭头 / 缩进减 / 缩进加 / 撤销 / 重做 / 拖拽把手 | `chevron-down` `indent-in` `indent-out` `undo` `redo` `drag-handle` | |
| 搜索清除 | `close` | `SearchField.vue` 实测 `name="close"` |
| 窗口控制 Windows 自绘四枚 | `win-min` `win-max` `win-restore` `close` | macOS 那三枚是系统红绿灯，不由本表提供 |

## 二、规范点了名、**注册表里没有对应 SVG**（这才是要东西的那半张表）

| 规范那一行 | 现状 | 证据强度 |
|---|---|---|
| **文件夹（组织相关那一族的载体）** | 没有 `folder` 键。侧栏文件夹行实测是 **色点 + 文字**（0.0.108 的口径），不是图标 | **已取证**（腿 62 的 §2.2 载体台账把这一行列为"无机检对象"）|
| **方框（勾选 / 清单项）** | 没有 `unchecked` / `checked` 两枚成对的 SVG；勾选那颗是 **CSS 画的**（`AppCheckbox`）。注册表里的 `check` 是别处用的勾号，不是那一对方框 | **已取证**（同上）|
| 新建文件夹 | **已取证：不是缺图标，是复用了通用 `plus`。**`SidebarPanel.vue:120` 那颗 `data-testid="new-folder"` 里是 `<AppIcon :size="18" name="plus" />`。规范 §2.4 把"新建文件夹"单列一枚、且 §2.2 要求"文件夹族共享同一条基形" ⇒ 严格讲它该是 **文件夹 + 加号**，但**文件夹那枚载体本身还没有 SVG**（见下面 `文件夹` 那一行）⇒ 这一行**既不是"已对齐"也不算独立缺陷**，它是同一个缺口的下游 | 已取证 |
| 重命名 | **已取证：`FolderTree.vue:116` 那颗 `folder-rename`（`btn--icon`）里是 `<AppIcon :size="18" name="pencil" />`** —— 铅笔是通用"编辑"符号，规范点名的"重命名"没有独立一枚 | 已取证 |
| 今天 | **已取证：不是图标。**`NoteList.vue:230` 那颗 `daily-note` 是**纯文字按钮**（`{{ t('list.dailyNote') }}`，没有 `AppIcon`）| 已取证 |
| 链接（编辑器工具条那一枚） | **已取证：不是空白格，是文字按钮。**`toolbarItems.ts:41` 是 `{ key: 'link', kind: 'link', label: 'tb.link' }`（没有 `icon:`），而 `ToolbarItem.vue` 的最后一条分支是 `<template v-else>{{ t(item.label) }}</template>` —— `kind:'link'` 不落在 `mark / menu(type) / size / color` 任何一条里，所以走 `v-else` 画出**文字「链接」**。我上一版把它列进"待查"时写的怀疑（既无图标也无文字 = 看不见的入口）**不成立**，按实更正 | 已取证（静态分派可完整推出，不需要跑浏览器）|
| 更多·溢出 | 部分取证：溢出收纳那颗是**文字「更多 ›」**（腿 ㉝ 的判据就是那句文字 + 那颗按钮），不是规范点了名的那枚图标 | 已取证到"不是 SVG"，是否是缺陷要看 §2.4 要不要给"更多"配图标 |
| 移到 | 取证：走 `AppSelect`（文字 + `chevron-down`），规范 §2.4 给"移到"点名的那枚没有独立 SVG | 已取证 |

⇒ **能说的那句**：规范 §2.4 点名的清单里，`文件夹` 与 `方框` 两族确定没有 SVG（等设计师真源，见任务 #62）；
`今天` 实测是**纯文字按钮**（不是图标，也没有图标位）；`链接` 也**不是空白格** —— 它是文字按钮「链接」（`kind:'link'` 走 `ToolbarItem.vue` 最后那条 `v-else`，静态分派即可推出，我上一版的怀疑已按实撤回）；
`新建文件夹` 复用通用 `plus`、`重命名` 复用通用 `pencil` —— 两枚都有 SVG，只是**不是规范单列的那两枚**（它们是 `文件夹` 载体缺失的下游，不是独立缺陷）；
`更多 ›` 与 `移到` 有实测的非 SVG 形态，属"实现选了文字"，要不要补图标是**设计决定**。
这一份是台账不是判据：**没取证的那几行我不写成缺陷，也不写成"已对齐"**。

## 三、这块地已有的判据（避免下一个人重复登记）

- **画布与笔触**：`viewBox="0 0 20 20"` 固定在 `AppIcon.vue`，描边永远 1.75 用户单位，
  且有一腿扫"每一枚 svg 的可绘制子元素 `getBBox()` 落在画布内"（§2/§2.1，`verify-layout.mjs:6752` 起）。
- **同屏同粗细**：G112 那批；`stroke="none"` 那一族被显式排除（§2.1 末，6966 行的注释记录过一次假缺口）。
- **不许用 Unicode 字形 / 文字类用 SVG 路径**：§2 与 §2.4 后半句，腿 ㉟（八枚 `mark-*`）。
- **同族共享同一条基形 + 不同族不许撞脸**：`iconSystem.spec.ts` 的两条规则 + 两份可证伪的豁免台账。
