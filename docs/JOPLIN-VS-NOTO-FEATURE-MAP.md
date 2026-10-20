# Joplin ⇄ Noto 功能对照与 1.0 采纳清单

> 取证边界（先说清这份文件凭什么）
> - Joplin 一侧：`.vendor/joplin`（**已浅克隆到盘上并被 `.gitignore` 挡住，不入库**），版本 **3.7.21**
>   （desktop / lib 3.7.3）。本文件的每一条都能在下列 `file:line` 读到原文。这是 ADR-0019 当年做不到的事
>   —— 那时 GitHub 在本机不可达，只能读官方规范页，凡涉及实现细节处都标了 `[未核实]`。
> - 安装包体积：`gh release view` 对 **laurent22/joplin** 与 **wenzo001/Noto v0.0.141** 的公开产物字节数，
>   实测于 2026-10-18。不是估算，不是引用他人博客。
> - Noto 一侧：从 `apps/desktop/src`、`crates/*`、`apps/mobile` 的实际代码盘点，
>   每条给出 `file:line`；"没有"这类否定结论都经过 grep 才写。
> - 本文件是**待你拍板的清单**，不是已生效的规格。判定列写"建议"的地方一律还没动手。

---

## 1. 你最关心的两件事，先把数字摆平

### 1.1 安装包：桌面端我们已经比它小两个数量级，Android 那一格在 0.0.145 翻过来了

| 产物 | Joplin 3.7.21 | Noto 0.0.141（改档位前） | **Noto 0.0.145（release 档，实测）** | 倍数（对我们最有利那一列） |
|---|---:|---:|---:|---:|
| Windows 安装器 | `Joplin-Setup-3.7.21.exe` **344.3 MiB** | `Noto_0.0.141_x64-setup.exe` **5.75 MiB** | `Noto_0.0.145_x64-setup.exe` **5.32 MiB**（5,580,477 B） | 它大 **64.7×** |
| Windows MSI | —（不发） | `..._zh-CN.msi` **7.84 MiB** | **7.41 MiB**（7,774,208 B） | — |
| macOS DMG | `Joplin-3.7.21.dmg` **197.1 MiB** | `Noto_0.0.141_aarch64.dmg` **6.80 MiB** | **6.38 MiB**（6,686,703 B） | 它大 **30.9×** |
| macOS universal zip | —（不发） | `Noto_0.0.141_universal.app.zip` **6.75 MiB** | **6.33 MiB**（6,635,987 B） | — |
| Linux AppImage | **192.1 MiB** | —（CI 不建 Linux） | — | — |
| Linux deb | **155.2 MiB** | —（不发） | — | — |
| **Android APK** | 31~48 MiB（Play/APK，本轮未取公开字节数核对） | `app-universal-debug.apk` **149.7 MiB** | `app-universal-release-unsigned.apk` **14.74 MiB**（15,460,569 B） | **我们比它小 2.1~3.3×** |

结论要分成三句说，不能混：

1. **桌面端不需要"缩小"工程。** 5.32 MiB 的 Windows 安装器已经说明 Tauri 这条路走对了；
   用户抱怨的"Electron 每个平台都上百 MB"在我们这里不成立。source map 不再随包发（0.0.143）之后又省了一截。
2. **Android 那一格以前是我们自己违反了你定的约束，0.0.145 已经修掉。** 改的是构建档位，不是砍功能：
   `tauri android build --apk --debug` → `--apk --target aarch64`（release 档）。
   debug 不做 R8/资源裁剪、不 strip native 库 —— **同一份代码，149.7 MiB → 14.74 MiB（10.1×）**，
   这个差就是"档位"两个字的全部含义。代价照实记：没有 keystore ⇒ 产物**未签名** ⇒
   Android 拒绝安装，所以"真机装得上吗"那一格（`NEEDS-OTHER-MACHINE-TESTING` C1）**仍是 BLOCKED**，
   签名是用户的决定，我没有擅自生成 keystore 或把签名塞进 CI。
3. **这条现在由机器守着，不再靠我读网页。** `scripts/collect-release-assets.mjs` 里那一档
   `CEILINGS`（exe 8 / msi 11 / dmg 10 / zip 10 / apk 24 MiB）在贴进 Release **之前**逐个断，
   而且**不在表里的新产物类型也红**（否则第一件新增产物就绕过这条门）；
   每个包的实际字节与离上界还有多少，每次发版由那一步自己印在日志里。
   口径与前端产物那条上界门同一条：**上界不是"不许变大"，是"变大的那一次必须被说出来，并在这里留下新预算的读数"**。

### 1.2 内存：这条有实测，且是我们强的一侧

`docs/PRODUCTION-READINESS.md:172` 记的本机实测：**5000 条笔记库下 RSS 31.5 → 47.4 MiB**。
Joplin 是 Electron（主进程 + 渲染进程 + GPU 进程各自一份 V8/Chromium），量级在数百 MiB；
本轮我**没有**在它机器上装 Joplin 实测内存，所以这一格只写"量级对比"，不写具体数字 ——
按仓库的规矩，没复现过的数不当证据用。

真正没达标的是**启动**，不是内存：同一行记着冷启动 best-of-3 = **1134~1184 ms**（口径 ≤1000 ms，不达标），
全新数据目录首启 **6.2~8.1 s**。缺口登记在 **G13**，等你把口径拍成"首启/日常"两档，或者要求真压进 1000 ms。

---

## 2. 采纳的总原则（为了让"安装包不大 + 内存不大"不是一句口号）

| 档 | 判定 | 例 |
|---|---|---|
| **A 纯前端可实现、零新增依赖** | 1.0 采纳 | 标签、多选批量、搜索算符、排序记忆、字数统计、快捷键补全、删除撤销 |
| **B 只加已有依赖的用法** | 1.0 采纳，但每条要先给体积读数 | 图片粘贴入库（走已有 attachment 通道） |
| **C 需要新的重依赖**（语法高亮引擎、mermaid/KaTeX、OCR、PDF 渲染、embedding/ONNX、向量库） | **推到 1.x，不进 1.0** | 这类一进来就是几百 KB～几十 MB，正撞你划的红线 |
| **D 多平台/多形态/账号体系**（10 种同步目标、Joplin Cloud、SSO/SAML、插件宿主、多 profile、Web Clipper） | **不采纳** | 见 §4 |

一句话：**1.0 只收 A/B 档。** 这条就是"参考它但不变成它"的执行边界。

---

## 3. 逐区对照

判定图例：✅ 照它做 ｜ 🔶 参考它但改形状 ｜ ❌ 不采纳 ｜ ✔ 我们已有 ｜ ◆ 我们独有如上

### 3.1 新增 / 编辑 / 查看（你的第 2 条抱怨）

| Joplin 的做法 | 出处 | Noto 现状 | 判定 |
|---|---|---|---|
| 编辑器/查看器/分栏三态切换，`Ctrl+E`/`Ctrl+L` 切外部编辑与布局 | `gui/MenuBar.tsx:578-1026`、`builtInMetadata.ts:1104-1115` | 打开笔记即 `contenteditable`，无需点编辑（`RichEditor.vue:848`） | **❌ 不抄三态**。这正是你说要避开的毛病；抄过来等于把它请回来 |
| 标题是独立输入框 | `gui/NoteTitleBar.tsx:123` | 标题即第一个标题块（`notera-richtext/src/extract.rs:92`） | ✔ 保持 |
| 新建笔记为**草稿态**（provisional），切走时自动丢弃，列表里淡化显示 | `commands/newNote.ts:34-53`、`lib/components/shared/reduxSharedMiddleware.ts:76-83`、`gui/NoteList/style.scss:51` | **已落（第一百六十二批，0.0.162）**，口径逐条照抄那三处出处：新建**当场落库**并打 provisional 标记、立刻选中；`NOTE_SELECT`（这里是 `watch(selectedId)`）时把**除目标以外**的 provisional 一律 `delete_note`（**软删**，进回收站）；用户**改过**（`applyNoteUpdate`）就摘标记、之后不再丢；列表那行 `row-item--provisional`（opacity .55，**只淡化不隐藏**）。删失败就留着——不把"没删成"说成"删了"。标记只活在进程内存（与 Joplin 的 `provisionalNoteIds` 同层），重启不追账 | ✅ **采纳并已落**（A 档最后一条） |
| 删除后弹**可撤销**的回收站通知 | `gui/TrashNotification/TrashNotification.tsx:50-57` | **已落（第一百五十二批，0.0.153）**：`moveToTrash` 推的那条 toast 带一颗「撤销」（`ToastAction`），点了走 `restore_note` 且**认的是刚删的那一篇的 id**，不是"当前选中"。两条出口各自分明：「撤销」= 撤条 + 跑动作，「知道了」= 只撤条。带动作的那一族**不自动消失**（§4.9 已补这一句），无动作那一族照旧 4500ms | ✅ **采纳** —— 已落 |
| 编辑器后端 4 套并存（CM5 / CM6 / ProseMirror / TinyMCE 遗留 / 纯文本） | `gui/NoteEditor/`、`packages/editor/ProseMirror` | 一套自有块模型（`editor/model.ts:12-22`） | ❌ 不抄（多编辑器就是体积与内存的来源） |
| 表格编辑、代码语言高亮、数学公式 | `editor.tableEditing`、markdownPlugins 23 项 | 表格在前端只是"未知块"JSON；无高亮/公式 | 🔶 **1.0 不做**（C 档）。表格可先做"只读渲染 + 逐格文本编辑"的轻版 |
| 拼写检查与语言子菜单 | `builtInMetadata.ts:1953`、`commands/showSpellCheckerOptions.ts` | 无 | ❌ 依赖 Chromium 拼写栈，收益/风险不划算，1.0 不收 |
| 字数/字符/行数/阅读时长统计 | `gui/NoteContentPropertiesDialog.tsx:38-47,112-118` | **已落（第一百五十一批，0.0.152）**：状态条那一串 `N 字 · N 段 · 约 N 分钟`（`editor/textStats.ts` 纯函数：CJK 逐字、拉丁按连续串、300 字/分 + 200 词/分向上取整）。**故意不写"行"**——一行占多宽要排版才量得到，这里给的是段（=块）数。**顺带修掉一条两本账**：核心 `char_count` 是"码点去空白"（`extract.rs`），而界面侧从前是"UTF-16 码元 + 空格照算" ⇒ 同一篇笔记侧栏与角上报两个数，现在界面侧与核心同口径，两侧各自断言同一份手算 fixture（Rust `char_count_uses_the_same_fixture_as_the_ui_side`）。**手机上只报"字数"那一句**（单栏那一档藏起"段/时长"，整句仍在 `title` 里 —— §5 不许静默裁字）；这一排的宽度预算（六颗 397 / 可用 358 ⇒ 手机上两行）登记成 **D24** | ✅ 采纳，且**必须按 CJK 正确分词**（它是英文词计数，我们要更对）—— 已落 |
| 便签内局部搜索 | `showLocalSearch`，`Ctrl+Shift+F` | **已落（第一百五十批，0.0.150）**：`editor/findInNote.ts` 纯函数算块内偏移，跳一处走 `applySelection` + `caretInView`，查找条贴在状态条那一侧（`FindBar.vue`）。**只读**：整段交互零次 `edit_note`（整跑腿 78 ③ 钉着）。**键位没有落**：`Ctrl+F` 归全局搜索、`Ctrl+Shift+F` 归附件（D21/A11 那份表是满的），所以入口是界面上那颗按钮，键位另拍（D23） | ✅ 采纳（A 档）—— 已落，键位待拍 |

### 3.2 组织能力

| Joplin | 出处 | Noto 现状 | 判定 |
|---|---|---|---|
| **标签**：chip UI、自动补全、批量增删差集 | `commands/setTags.ts:30-82`、`gui/PromptDialog.tsx`、`gui/TagList.tsx` | **完全没有**标签（`negativePromises.spec.ts:263-311` 主动守着），替代品是 8 色"颜色当标签用" | 🔶 **这是最大的功能缺口，要你拍板**：颜色能标 8 个，标签能标任意个。加标签要新表 + 迁移 + 同步项（改协议，不是纯前端） |
| 笔记本任意层级嵌套 | `Sidebar` 树 + `New sub-notebook` | 产品口径**只允许一层**，界面拍平显示 `父 / 子` | ❌ 不抄（一层是已拍板的产品决定） |
| **多选 + 批量操作条**（移动/加标签/删除/导出） | `gui/MultiNoteActions.tsx`、`useOnKeyDown.ts:100-118,188-194` | **部分已落（第一百五十七批，0.0.157）**：表头「选择」进多选模式，模式内用一颗勾**替换**行右侧那簇动作（定宽栏 ~315px + 虚拟列表行高 124 都容不下"再加一颗"），批量条同样在表头（不盖住最后一两行）；Shift = 区间扩选（按核心那份顺序、并进已有选区），全选是**按钮**（`Ctrl+A` 要重开 D21/A11 那张表，本轮不占键位）。已落的批量动作：**移到最近删除**（一条 toast + 一颗撤销，撤的是按下那一刻的快照）、**移到文件夹**（不给撤销）与**批量加标签**（第一百五十九批：核心是**全量替换** ⇒ 读—并—写；已有的不发、载荷是「原有 + 这颗」的并集、读不到就停、零篇不冒话；界面是批量条里一颗「加标签」悬浮层）。**已落第一百六十批**：**批量导出**（`ExportCmd` 多一档 `noteIds` 作用域，与 `folderIds` 互斥；文件夹只带所在本 + 祖先链；附件走 `attachment_shas_for_notes`，不按文件夹扫；界面提示带核心回传的真实路径） | ✅ 采纳（A 档，50 次点击变 3 次的就是这类）—— 移动 / 删除 / 加标签 / 导出**四件全落** |
| **排序**：字段 6 种 + 反转 + **每本单独记忆** + 列头可点 | `PerFolderSortOrderService.ts:89-141`、`NoteListHeader.tsx:22-60` | **已落（第一百五十三批，0.0.154）**：六档（最近/最早修改、最近/最早创建、标题 A→Z / Z→A）走核心 `NoteSort`（**封闭枚举 + 每档一条写死的 `ORDER BY` 常量**，列名绝不拼字符串），界面在列表头那颗**直接写着当前这一档**；每"一档列表"各记各的（`all` / `folder:<id>` / `tag:<id>` / `trash`），存在**本机**偏好里不上传（2026-10-08 那条）。`pinned DESC` 永远在最前、`n.id` 永远收尾 | ✅ 采纳"排序字段 + 每文件夹记忆"—— 已落；**列头那套仍不做**（等宽度稳定，见 D24）；**中文标题是码位序不是拼音序** ⇒ 登记成 **D25** |
| 搜索算符 `tag: notebook: title: body: created: due: iscompleted: resource:` | `lib/services/search/filterParser.ts:72-75` | 只有全库分词 + 精准/模糊两档（`notera-store/src/search.rs:4-9,203-270`） | 🔶 采纳**子集**：`标题:` `本:` `有附件` —— 日期/待办类算符跟随标签一起决定 |
| 列表行里高亮命中词 | `useRenderedNote.ts:26` | 我们已在摘要片段里 `<mark>` 高亮 | ✔ 已有（形状不同） |
| 待办（to-do、到期、完成态、过期置顶） | `Ctrl+T`、`todo_due`、`uncompletedTodosOnTop` | 只有 checklist **块**，没有"这条笔记是任务" | 🔶 待你决定：这是产品方向，不是缺陷 |
| 笔记互链 `[[ ]]` / `linkToNote` 选择器 / 反链面板 | `commands/linkToNote.ts:20-34` | 无互链、无反链（反链在 Joplin 也是插件才有，别信"它内建"） | ❌ 1.0 不收（要做就做全套，成本高） |

### 3.3 同步（你的第 3 条抱怨）

| Joplin | 出处 | Noto 现状 | 判定 |
|---|---|---|---|
| 同步目标 10 种 + 向导 + 每目标独立凭据 | `builtInMetadata.ts` 的 `sync.target`、`sync.2/5/6/8/9/11.*` | **WebDAV 唯一**：没有传输枚举，`RemotePort` 只有一个生产实现（`notera-webdav/src/client.rs:522`），装配点硬编（`notera-host/src/lib.rs:2242-2268`） | ❌ **正是你要的"少"**。已核实无半成品暗道 |
| 每轮全量目录列举比对（`basicDelta` + mtime） | `file-api.ts:496`、`file-api-driver-webdav.js:92` | 清单两段式（基线分段 ⊕ 200 条窗口），实测 7.8 KiB vs 186 KiB | ✔ 我们更好，理由见 ADR-0019 |
| 用墙上时钟 `updated_time` 判新旧 | `Synchronizer.ts:682-721` | Lamport `sync_rev` + 共同祖先，**禁止 mtime** | ✔ 我们更好（时钟偏移会静默选错边） |
| **90% 大删除熔断** | `file-api.ts:660`（`sync.wipeOutFailSafe`） | 已有同类：清单不可信绝不"以空清单继续"（`notera-sync/src/lib.rs:579`）+ 发散闸门那条判据 `divergence_gate_blocks_mass_deletion_inference`（`:819`） | ✔ 已有等价物 |
| **单项停同步 `sync_disabled` + 原因 + 通知横幅** | `BaseItem.ts:966`、`checkDisabledSyncItemsNotification.ts` | **已落（第一百五十八批，0.0.158）**：同一份内容连续 3 轮被单条拒收 ⇒ 那一行转 `blocked`（`SYNC-PROTOCOL.md` §12 那一档），引擎不再对它发 PUT、其余条目照走；设置页 `sync-blocked` 那一格说清"几条、哪几条、为什么"，给「重试这一条」与「不再上传这一条」两颗按钮。与附件那侧的 quarantine 台账同形但**不同账**：本机内容与 `dirty` 一字不动 | ✅ **已采纳**（P8 ③）；缺的证人：界面上这一格还没有整跑执行者（登记在 CHANGELOG 该批"没做、按实登记"） |
| 同步进行中可**取消** | `gui/Sidebar/Sidebar.tsx:27-106`（`QuitSyncDialog`） | **已落**：徽标上那颗 `sync-cancel`（`components/SyncBadge.vue:82`）走 `sync_cancel`（`stores/sync.ts:304`），第一百五十二批之前那一批还把它做到了"停在**一件事**的粒度"（一轮中途结清当前项再停）；判据 `stores/syncCancel.spec.ts` | ✅ 已采纳并实现（这一行的"无取消，一轮跑完才停"是旧状态，2026-10-19 按实更正） |
| 同步状态屏（逐项报告 + Retry / Retry All / Ignore） | `gui/StatusScreen`、Help ▸ Synchronisation Status | 只有徽标 + 统计行，**无逐项报告视图** | ✅ 采纳轻版（A 档，但要看并发数不炸内存） |
| 打字即同步（15 s / 移动端 1 s） | `registry.ts:72-79` | 写完立即起一轮 + 25 s tick（`notera-host/src/lib.rs:3166-3263`） | ✔ 等价 |
| 冲突：非笔记类**静默让远端覆盖**；笔记类复制本地为 `is_conflict` 笔记 + 虚拟冲突夹 | `handleConflictAction.ts:31-50,95-125,197-210` | 块级三方合并，失败保留双方 + 冲突副本，永不静默覆盖 | ✔ 我们更保守 |
| 崩溃安全的本地变更流水 `item_changes` | `models/Note.ts:1019-1021`（**提交后 fire-and-forget**） | 与内容同事务的 outbox | ✔ 我们更安全（它丢那一行就少传一次） |
| 附件按 id 平铺命名、无内容哈希 | `resourceUtils.ts:8-20` | 按内容哈希 + 引用计数 | ✔ 我们更好（可去重） |

### 3.4 设置与配置

| Joplin | 出处 | Noto 现状 | 判定 |
|---|---|---|---|
| 声明式设置元数据（type/section/appTypes/secure/min/max/storage） | `models/settings/builtInMetadata.ts`（2604 行、约 280 键、161 public） | `notera-config` 有校验但**没有 schema 驱动的 UI**，字段级校验缺失（`styles/base.css:403` 自认） | ✅ **采纳"一份声明生成一屏 UI + 字段级校验"**：这是消除"改一处设置要动三个文件"的根因，属 A 档 |
| 三模存储：DB 行 / `settings.json` / 系统钥匙串（写失败退回 DB） | `models/Setting.ts:954-964,1136-1153` | 偏好只在本机持久（已拍板不上传），凭据 Windows 钥匙串 + 会话内存退路（G38 选 B） | 🔶 参考它的"钥匙串失败退回"，其余不动 |
| **默认值迁移**：改了默认值不覆盖"从没设过"的用户 | `Setting.ts:77-120` | **已落（第一百五十五批，0.0.155）**：偏好里多一份"用户动过哪些键"的名单（`UiPrefs.explicit`，与值一起落本机库），`normalizePrefs(input, defaults)` 只把名单里的键认成他的值，其余跟随默认；老记录没名单 ⇒ 盘上有的键一律算动过（不让这次改动自己变成数据丢失） | ✅ 已采纳并实现，判据在 `defaultMigration.spec.ts`（8 把刀各自红过）——顺带抓出一条真缺陷：`theme` 以前只认 `light`/`dark`，"跟随系统"是靠它正好等于默认值才没露馅 |
| 只同步**精选** `info.json`（E2EE 开关、主密钥、`revisionService.*`），且默认值打时间戳 0 | `syncInfoUtils.ts:99-121` | 偏好明确**不同步**（2026-10-08 拍板） | ✔ 一致，无需改 |
| 16 个设置分栏 + 键盘快捷键可录 | `Setting.ts:1287-1390`、`gui/KeymapConfig/ShortcutRecorder.tsx` | 7 张卡 + **只读快捷键表** | 🔶 采纳"快捷键可改"，分栏数按我们自己的字段数定 |
| 主题 8 套 + 自定义 CSS（userchrome/userstyle）+ 字号 + 缩放 + 滚动条档 | `builtInMetadata.ts` appearance 17 键 | 浅/深/系统 + 字号 0.85~1.60（`stores/settings.ts:37-38`），无字体/宽度/自定义 CSS | 🔶 采纳**内容宽度**与**行高**两格（读长文用得上），自定义 CSS 不收（等于放弃设计系统守卫） |
| 语言 | `locale` 全量 | 仅简中，无设置项 | 🔶 取决于发布对象，等你定 |
| 回收站自动清理天数 | `trash.autoDeletionEnabled`/`trash.ttlDays` | **已落（A13，0.0.14x 一批）**：核心 `TRASH_TTL_DAYS = 30`（`crates/notera-host/src/lib.rs:1067`），到期按 `cutoff_after(now, 30)` 清；界面那句"30 天内可以恢复"由 `arch-check` 的 `edge:trash-ttl-copy-matches-core` 钉住与核心同源，不许两处各抄一个数 | ✅ 已采纳并实现（这一行从前写"回收站永不过期，值待拍"，那是被 A13 推翻的旧口径，2026-10-19 按实更正） |
| 历史版本 TTL | `revisionService.ttlDays` 默认 90 | 有历史面板，保留口径本轮未核实到具体数（标 `(?)`） | 🔶 先把我们的口径写进文档再决定 |

### 3.5 各端页面布局（你说要"完全参考"的那部分）

| 端 | Joplin 的布局事实 | 出处 | 建议 |
|---|---|---|---|
| 桌面 | **可拖拽三栏**（侧栏 / 列表 / 编辑），栏宽与可见性都有持久设置，另有布局移动模式与"重置布局" | `layout.noteList/folderList/note.factor`、`ui.layout`、`ResizableLayout`、`MainScreen.tsx:334-338` | ✅ **已落（第一百六十一批，0.0.161）**：三栏下两颗 `role=separator` 把手，拖的是 `--sidebar-w` / `--list-w`；默认值仍是 tokens 那两颗（260/340，spec 直接读原文对账）；上下界 200–420 / 240–560；`localStorage` 本机持久（松手才写）+ 双击复位 + 键盘 ±16/±64；两栏/单栏那两档由 `data-layout` 藏掉。**没做**：Joplin 的"栏宽随断点自动缩放（factor）"与"布局移动模式"——前者会跟 1180/820 的断点公式打架，先不做 |
| 桌面侧栏 | Notebooks ▸ Tags ▸ 全部笔记 ▸ 回收站 ▸ 冲突夹，各段可折叠、显示计数 | `Sidebar.tsx`、`folderHeaderIsExpanded`/`tagHeaderIsExpanded`、`showNoteCounts` | 🔶 采纳"分段可折叠 + 计数"（计数我们已有，折叠没有） |
| 列表列 | 可显示 时间/标题/是否待办/本/标签/到期/来源… 可排序、可拖宽 | `noteListType.ts:311-328` | ❌ 不收"插件可加列"；🔶 收"至少两列（标题 + 更新时间）"的固定版 |
| 顶部 | 原生菜单条 90 条命令 + 工具栏按钮 | `menuCommandNames.ts`（101 行） | 🔶 我们已有原生菜单 + 快捷表，命令数差距是**功能面**差距，见 §3.1-3.4 逐条决定 |
| 移动 | 侧滑菜单 + 底部抽屉 + 小组件；拍照/扫描/语音是它的重头 | `app-mobile` | ❌ 拍照/扫描/语音属 C 档，不进 1.0；🔶 我们的底部 TabBar 已等价它的抽屉 |
| 无 Linux 版 | 它发 AppImage/deb，我们 CI 不建 Linux | `.github/workflows/release.yml` | ❌ 1.0 不扩平台，先兑现三端 |

---

## 4. 明确**不**参考（这一节是你划红线的地方）

| Joplin 有 | 为什么不要 | 体积/内存代价（估算） |
|---|---|---|
| 10 种同步目标 + 同步向导 | 你已定 WebDAV 唯一；每加一个目标就多一份凭据 UI、兼容矩阵和错误面 | 代码面翻倍，字节数次要 |
| 插件宿主 + 第三方 webview | 一个"任何第三方 JS 都能开 webview"的口子，与设计系统守卫直接冲突 | 宿主层 + 隔离策略，且不可控 |
| AI 聊天 / 本地 embedding / ONNX / sqlite-vec / MCP | 与"本地优先的记录工具"不同轴 | **数十 MB**，直接击穿你的体积线 |
| OCR（Tesseract + 语言包）、语音输入（Whisper/Vosk）、白板、手写识别 | 同上，且每条都带原生大库 | **几十 MB 起** |
| mermaid / KaTeX / abc / fountain / 视频音频播放器 / PDF 阅读器 | 前端 bundle 会从现在的 ~390 KB 冲到 MB 级 | 单个 100 KB～1 MB+ gz |
| Web Clipper 浏览器扩展、分享/发布、Joplin Cloud、SSO/SAML、多 profile | 多账号体系与服务端，不在产品边界内 | 需要服务端 |
| 外部编辑器接管（`Ctrl+E` + 文件监听） | 与"打开即可编辑"互斥；监听外部改动会带来冲突风暴 | — |
| CM5/CM6/TinyMCE 四套编辑器并存 | 它就是靠这个把包装到 344 MiB 的 | — |

---

## 5. 顺带量出来的两处"我们自己的问题"（与参考无关，但撞你两条约束）

1. **source map 随包发布。** `apps/desktop/vite.config.ts:21` 是 `sourcemap: true`，
   `frontendDist: "../dist"`（`tauri.conf.json:10`）**整目录嵌入**、没有排除项。
   盘上实测：`dist` 2,199,157 B 里 **1,807,573 B 是 `.map`**（`index-*.js.map` 单个 1,632,844 B）。
   更难看的是：那不只是体积 —— map 里是**可读回源码**。
   而体积门禁 `scripts/check-frontend-dist.mjs:25-31` **有意不计 `.map`**，注释写的是"生产壳里不加载"——
   这句对"加载"成立，对"进包"不成立。所以这条重量门禁忌看得见。
   修法：release 构建关 map（或 `.taurignore` 排除），并把"进包字节"和"计数口径"钉成一条判据。
   ⚠️ 未实测：关 map 后安装器省多少（要跑一次 release 构建才有数，我不写估计值）。
   > **2026-10-18 这一格已可关掉（v0.0.145 的 CI 产物回来了）**：Windows 安装器
   > **5.75 MiB（0.0.141，带 map）→ 5.32 MiB（0.0.145，不带 map）= 省 0.43 MiB（约 7.4%）**，
   > MSI 7.84 → 7.41 MiB、DMG 6.80 → 6.38 MiB、app.zip 6.75 → 6.33 MiB。
   > 注意这是**整包**差分，不是 map 单独的字节 —— 中间还跨了别的批次，别把它读成"map 恰好值 450 KB"。
2. **Android 发的是 debug APK**（`release.yml:406`，任务名 `:262`）。
   149.7 MiB 的产物里大部分是"没做 R8/strip/按 ABI 拆分"造成的。
   修法要给 `--release`（+ 可选 `aab`）与签名决策 —— **签名归你**（release 草稿与发布一直由你按，2026-10-02 口径）。
   > **2026-10-18 状态更新（第一百三十四批，0.0.144）**：你拍了"先改成 release 出未签名产物"，
   > 那一行已去掉 `--debug`。**代价先说在前面**：没有 keystore 时 release 档产出的是**未签名** APK，
   > Android 直接拒装 ⇒ "装机试一遍"那一格回到 BLOCKED，要试机得先签名或临时改回 debug。
   > 体积的真实新数等这一遍 CI 的产物回来；**上限门禁故意留到下一批**，
   > 因为阈值只能落在"旧点 149.7 MiB 与新点"之间，现在拍就是拍脑袋。
   > **2026-10-18 补（第一百三十八批）**：新数到了 —— **14.74 MiB（15,460,569 B），比 debug 档小 10.1×**，
   > 所以那一行"我们比它大"整格作废（现在 31~48 MiB 的 Joplin 是我们的 2.1~3.3 倍）。
   > 上一段说"故意留到下一批"的那条**上限门禁这批立了**：`scripts/collect-release-assets.mjs` 的
   > `CEILINGS`（apk 24 MiB ≈ 新读数 ×1.6；exe 8 / msi 11 / dmg 10 / zip 10 MiB）在贴 Release 之前断，
   > 六臂演练台全过（对照 = 这五个真读数、超 1 字节就红、退回 debug 档就红、新类型不在表里也红、
   > 旧的 1 MiB 地板还在、缺一种平台包就红）。**装机那一格仍 BLOCKED**（未签名），那条不由体积数解冻。
   > 历史那份 `docs/RELEASE-RECORD-0.0.125.md` 里的 155 301 236 B 是它自己那一版的读数，不改写。

---

## 6. 需要你拍板的格子（一次问齐，不来回追）

> **2026-10-18 已拍四条，先记在这里，下面 P1/P2/P7/P10 的状态以本节为准，不再重问**：
>
> - **P1 标签 = 进 1.0**（接受"新表 + 迁移 + 标签成为可同步项"这条协议改动）。
>   与 2026-10-09「颜色即标签」那条口径的关系：颜色**保留**为视觉标记，标签补的是"任意多个 + 可筛 + 可批量"，
>   两者不是替换关系 ⇒ 已落成 `docs/design/SPEC-AMENDMENTS.md` **A12**，并在 **A1** 那一格指名标了"被 A12 推翻"
>   （两份账不许并存着各说一句话）。设计正文在 **`docs/ADR/0022-tags-as-syncable-entity.md`**，
>   **状态：已拍板、尚未落地** —— 那一版会写明落地必须先做哪一刀。
> - **P2 待办 = 只要 checklist 块**。笔记本身不做成任务，无到期、无未完成置顶 ⇒
>   这条是**负向承诺**，要像其余负向承诺一样进 `negativePromises.spec.ts` 守门，防止以后有人"顺手加 todo 形态"。
> - **P7 回收站 = 改成 30 天自动清理**。这一条**推翻** 2026-10-06 设计规范里"永不自动清理"那句（`docs/design/Noto-界面设计规范.v2.md:440,453`）；
>   按仓库规矩，被推翻的旧口径要指名作废，不许两说并存。
> - **P10 = 上面这些落完再发 1.0.0**。所以现在发版线**停在 0.0.x**，`1.0.0` 的 tag 等 §7 的收口做完再打。
>
> 其余格子（P3 三栏可拖宽 / P4 排序 UI / P5 多选批量 / P6 冷启动口径 / P8 同步可取消+报告+隔离 /
> P9 快捷键可编辑 / P11 Android 签名档位 / P12 英文界面）本轮未问齐；
> P3/P4/P5/P8/P9 已在 §3 标为"建议采纳"，无新依赖、不动协议 ⇒ 随批次推进，撞上真实取舍再单独问。
> **P6 与 P11 是要你拍的**：P6 的 6.2~8.1 s 首启那一格我不擅自改口径；P11 的 release APK 需要签名决策，按 2026-10-02 口径签名归你。

| # | 格子 | 选项 |
|---|---|---|
| P1 | **标签**要不要进 1.0 | A 要（新表 + 迁移 + 同步项，改协议）／B 不要（继续 8 色当标签） |
| P2 | **待办**（笔记可以是任务、到期、完成态）要不要进 1.0 | A 要／B 只要 checklist／C 全不要 |
| P3 | 桌面**三栏可拖宽 + 记忆**要不要 | A 要／B 保持现在的断点换栏 |
| P4 | **排序 UI + 每文件夹记忆**要不要 | A 要／B 保持固定序 |
| P5 | **多选 + 批量**（移动/删除/导出，若 P1=A 再加批量加标签）要不要 | A 要／B 不要 |
| P6 | 冷启动口径（G13） | A 首启/日常两档（如 6.2~8.1 s 与 1000 ms 分开）／B 必须真压进 1000 ms |
| P7 | **回收站自动清理** | A 要（默认天数？30？）／B 保持"永不"（与已拍板口径冲突，需你确认哪条作废） |
| P8 | **同步：可取消 + 逐项报告屏 + 毒丸项隔离** | A 三项都要／B 只要前两项／C 都不做 |
| P9 | **快捷键改成可编辑** | A 要／B 保持只读表 |
| P10 | **1.0 版本语义**：`1.0.0` 一旦发出就对外承诺数据格式与协议兼容（ADR-0014、`CI-CD.md:337`）。要按现状态发 1.0.0，还是先把上面 P1~P9 落完再发 | A 落完再发／B 现在就发 |
| P11 | **Android 发布档位**：release APK 需要签名决策 | A 我先只改成 release 并出未签名产物，签名你按／B 连 aab 一起做 |
| P12 | **语言**：要不要英文界面（它有 `locale` 全量） | A 要／B 只简中 |

---

## 7. 这份清单落成代码之后的收口（先说，免得改完忘）

- ADR-0019 里所有 `[未核实]` 的格子，按本文件的 `file:line` 逐格替换成核实结论（它当年读不到源码）。
- `docs/SYNC-PROTOCOL.md` 与 `docs/PROXY.md` 按最终实现更新（你的原始要求："改完的一定要更新同步文档"）。
- `§0.2` 的"WebDAV 唯一"承诺（**D19** 还挂着：包元数据那句算不算用户可见文案）与本文件的 §3.3 一起收。
- 体积守卫：把"进包字节上限"从只卡前端三类，扩到安装器产物本身（现在只有 1 MiB 地板、没有上限），
  并给这条判据先做变异测试再信它。
