# §2.4 全量图标清单：逐名对账（2026-10-13）

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
| 新建文件夹 | 未取证：那一排现在怎么画的没查（很可能是纯文字按钮） | 待查 |
| 重命名 | **部分取证**：那一颗是 `data-testid="folder-rename"` 的 `btn btn--icon`（确实带图标位），注册表里能对上"改名"语义的只有 `pencil` —— 但**没读到那一行 `name=`**，所以不当已对齐 | 待查（一行之差）|
| 今天 | **已取证：不是图标。**`NoteList.vue:230` 那颗 `daily-note` 是**纯文字按钮**（`{{ t('list.dailyNote') }}`，没有 `AppIcon`）| 已取证 |
| 链接（编辑器工具条那一枚） | 未取证：`toolbarItems.ts` 里有 `key: 'link'` 而那一行**没有 `icon:` 字段**；`ToolbarItem.vue` 的分支是 `AppIcon v-if="item.icon"` 起步，所以这一颗到底画的是什么（文字？空白？）没读到那一条 `v-else` 为止 | **待查，且值得查**：一个没有任何可见内容的工具条格子就是"看不见的入口"（§5 可读名字那一行反着的形状）|
| 更多·溢出 | 部分取证：溢出收纳那颗是**文字「更多 ›」**（腿 ㉝ 的判据就是那句文字 + 那颗按钮），不是规范点了名的那枚图标 | 已取证到"不是 SVG"，是否是缺陷要看 §2.4 要不要给"更多"配图标 |
| 移到 | 取证：走 `AppSelect`（文字 + `chevron-down`），规范 §2.4 给"移到"点名的那枚没有独立 SVG | 已取证 |

⇒ **能说的那句**：规范 §2.4 点名的清单里，`文件夹` 与 `方框` 两族确定没有 SVG（等设计师真源，见任务 #62）；
`今天` 实测是**纯文字按钮**（不是图标，也没有图标位）；`新建文件夹 / 重命名 / 链接` 三枚**还没逐名取证**
（`链接` 那一格尤其值得查 —— 一条工具条上的格子若既没 `icon:` 也没文字，就是"看不见的入口"）；
`更多 ›` 与 `移到` 有实测的非 SVG 形态，属"实现选了文字"，要不要补图标是**设计决定**。
这一份是台账不是判据：**没取证的那几行我不写成缺陷，也不写成"已对齐"**。

## 三、这块地已有的判据（避免下一个人重复登记）

- **画布与笔触**：`viewBox="0 0 20 20"` 固定在 `AppIcon.vue`，描边永远 1.75 用户单位，
  且有一腿扫"每一枚 svg 的可绘制子元素 `getBBox()` 落在画布内"（§2/§2.1，`verify-layout.mjs:6752` 起）。
- **同屏同粗细**：G112 那批；`stroke="none"` 那一族被显式排除（§2.1 末，6966 行的注释记录过一次假缺口）。
- **不许用 Unicode 字形 / 文字类用 SVG 路径**：§2 与 §2.4 后半句，腿 ㉟（八枚 `mark-*`）。
- **同族共享同一条基形 + 不同族不许撞脸**：`iconSystem.spec.ts` 的两条规则 + 两份可证伪的豁免台账。
