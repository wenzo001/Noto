# ADR-0022: 标签作为可同步实体——链接嵌在笔记记录里，并先补"未知 kind 不许静默降级"

## 状态
日期：2026-10-18
状态：Accepted（P1 由用户 2026-10-18 拍板"进 1.0"，并明确接受"新表 + 迁移 + 标签成为可同步项"这条协议改动）

本 ADR 推翻 `docs/design/SPEC-AMENDMENTS.md` **A1** 里"仍然不做的是 tag 数据结构本身"那一格 ⇒
落成 **A12**（见 §改口）。A1 那条负面承诺是**十把变异刀逐条见过血**的门（`negativePromises.spec.ts:722-843`），
所以这次不是"删掉一条判据"，是**把它翻成正面承诺并重新下刀**。

## 背景
1. 用户要求参考 Joplin 补齐组织能力。Joplin 的标签是多年在跑的实物，**它的伤疤就是免费的教训**
   （ADR-0019 当年读不到源码，只能引规范页；这次 `.vendor/joplin` 3.7.21 逐条可对 `file:line`）。
2. 我们这边不只是"没有标签"：仓库**主动禁止**它（A1 + 负面承诺门），替代品是单值 `color`（2026-10-09 拍板）。
3. 设计取证量出两条决定性事实：
   - **Joplin 把 `note_tags` 做成独立同步项**（`models/BaseItem.ts:75-83` 的 `syncItemDefinitions_` 里就有
     `{TYPE_NOTE_TAG,'NoteTag'}`），代价写在它自己的注释里：
     重复链接（`JoplinDatabase.ts:60-70` 的 `note_tags` 从来没有 `UNIQUE(note_id, tag_id)`，PK 是 UUID 不是那一对）、
     链接先到、项还没下载就崩（`Tag.ts:83-91` "…the actual items might not have been downloaded yet,
     Fixes #3958"）、标签删了链接还在（`InteropService_Exporter_Md_frontmatter.ts:115-117`
     "In some cases a NoteTag can still exist, while the Tag does not"）、
     同名标签两台设备各活各的**没有任何合并**（`Tag.loadByTitle:173-189` 自认 `COLLATE NOCASE` 只管 ASCII）、
     一个功能里四套相等关系、层级标签加了又回滚（`JoplinDatabase.ts:814-822`，列留在原地当死代码）。
   - **我们这边加一种 kind 的隐藏成本不在表结构，在"静默降级"**：`EntityKind` 只有
     `Note|Folder|Attachment`（`crates/notera-core/src/lib.rs:217-221`），而下游有若干处**不是穷尽匹配**：
     `crates/notera-host/src/lib.rs:3938-3941` 是 `match kind.as_str() { "f" => UpsertFolder, _ => UpsertNote }`，
     `:3973` 只对 `kind == "n"` 采纳冲突，`:3990/4000/4010/4019` 在 `EntityKind::from_tag()` 返回 `None` 时
     把 `SetRemote`/`MarkSynced`/`Tombstone`/`Purge` **无错误地丢掉**，
     `crates/notera-store/src/apply.rs:503-507,551-562` 是 `if kind == Note {"notes"} else {"folders"}`。
     ⇒ 一个陌生的 `tag` 记录在旧版本客户端上会被**当成笔记写进 `notes` 表**：没有编译错、没有失败测试、没有日志。

## 决策

### D1 标签是新 kind；**链接不进同步协议**
- `tags`（`id, title, canonical, created_at, updated_at, deleted_time, sync_rev, sync_hash, device`）
  是**新的可同步实体**，`kind = "tag"`，目录 `records/tag/`。
- 笔记↔标签的多对多**嵌在笔记记录自己的 payload 里**（`tag_ids: [id]`），沿用 `note_attachments` 已有的形状：
  那张表（`migrations/0001_init.sql:114-122`）**不是** EntityKind，链接是在 apply 时从笔记文档本地重导出来的
  （`crates/notera-host/src/lib.rs:6204`，引用计数在 `notera-store/src/syncml.rs:926-1050`）。
  ⇒ 我们**照抄这个已验证的形状**，不新建 `note_tags` 同步项。
- 显式付的代价：改一颗标签会把**带它的每一篇笔记**的 rev 顶一次（改名只动 tag 记录，加/摘标签动那一篇）。
  换来的是：没有重复链接、没有孤儿链接、没有"链接比项先到"的竞态、删除不需要级联。
  这条代价是**有意的**，不是疏忽；Joplin 选了另一侧，把它选出来的每一格都写在上面。

### D2 身份用随机 UUIDv7，不用"标题哈希"做 id
确定性 id（`UUIDv5(namespace, canonical_title)`）能让同名标签**自动收敛**、折叠逻辑一行都不用写，
看着更省。但它让"改名"变成"换身份"：改一颗名字要重写所有笔记里的链接 ⇒ N 次 rev 涨 + N 次上传，
而且 `id` 只允许 UUIDv7 这条校验（`crates/notera-webdav/src/path.rs:199-206`、
`crates/notera-core/src/lib.rs:406-414`）要为它开例外——开门例外的门要先重新验，成本比省下的折叠逻辑大。
⇒ **id 稳定 + 折叠收敛用 D4 的规则做**。

### D3 相等关系只有一个，且在 Rust 写入时算
`canonical = casefold(NFC(trim(title)))`，存成生成列并 `UNIQUE`（未删行范围内）。
中文不需要大小写折叠，但**需要 NFC 与全角/半角归一**——Joplin 恰恰是这里漏的：它把 ASCII-only 的
`COLLATE NOCASE`、JS 的 `.toLowerCase()`、`Intl.Collator{sensitivity:'accent'}`、
以及 `setTags.ts:66-67` 的裸 `includes()` 混在一条链上，于是**同一颗标签在四个地方算不等**。
⇒ 折叠只在核心做一处，界面不许自己再算一遍（这条要进门禁，见"验证"）。
显示排序用 `Collator` + `numeric: true`（Joplin 这一格是对的，抄）。

### D4 两台设备建同名标签：折叠，winner 与到达顺序无关
规则：`winner = min(canonical 相等集合里的 (created_at, id))` ——**只用这两个字段，不用墙上时钟比大小以外的东西**，
所以任意到达顺序、任意子集重放都收敛到同一个 winner（这正是主需求"禁止以 mtime 判新旧"的那条口径的延伸）。
落败那条不删内容，而是记 alias：`tags(id, alias_of)`，apply 时把链接里的旧 id 改写到 winner。
Joplin 在这格的答案是**什么都不做**，所以它的 bug 活到今天（`Tag.ts:173-189`）。
这一条必须有**两台真设备**的证人（按仓库规矩，界面注入造不出这一格）。

### D5 标签软删除 + 宽限期剪链接
Joplin 只给 notes/folders 加了 `deleted_time`，**标签没有**（`services/database/migrations/46.ts:5-6`），
于是它靠视图过滤死链接（`:20-22`）并吞下 `deleted_items` 消费即消失那个洞（`BaseItem.ts:377-385` 自己的注释）。
⇒ 标签与我们已有的笔记 tombstone 同构：软删除 + 一段宽限期后才剪引用它的链接，
防止"迟到的链接把死标签复活"。宽限期数值与回收站 30 天那条（P7）对齐，别再造第二个数。

### D6 颜色与标签并存，不是替换
颜色 = 单值视觉标记（侧栏小色点，已落地）；标签 = 多值组织语义。
A1 那句"归类的唯一入口是单值颜色"要改成"归类的**视觉**入口是颜色，**检索与批量**入口是标签"。
**按颜色检索仍然不做**（A1 未拍板那半格不变，它撞 v2 规范 §3.3"没有筛选器/没有分面"）——
本次只开标签这一族。

### D7 **发布顺序约束**：先堵静默降级，再放新 kind 上线
这条是本 ADR 最要紧的一段。0.0.141 已经在用户手里，它的代码就是 §背景 里那些 `_ => UpsertNote`。
**如果先发带 `tag` 的版本、后补守卫，那么任何一台还停在旧版的设备拉到 tag 记录时，
会把它当笔记写进自己的 `notes` 表**——写进去的还是一行带 JSON 载荷的假笔记，用户会看见一篇打不开的笔记。
所以次序必须是：

1. **第一刀（先上，单独一个版本）**：把上述每一处静默降级改成**具名拒绝**——
   未知 kind ⇒ 不写、不吞、进 `readOnlyReason`/同步报告，消息键进 i18n；`apply.rs` 那两处
   `else {"folders"}` 改成穷尽匹配；`:3990` 一族 `if let` 丢掉的地方改成显式 `match` 带错误分支。
   这一刀**还没有任何新 kind**，所以它对现网是纯加固；它的判据要能证"改前静默成功、改后具名失败"。
2. **第二刀**：升 `PROTOCOL`（`crates/notera-sync/src/manifest.rs:9` 的 `PROTOCOL: u16 = 1`，
   对外即 `SYNC_PROTOCOL_VERSION`，`notera-sync/src/lib.rs:26`）与 `protocol.json` 的 `min_protocol`
   （协商与根不匹配的门在 `crates/notera-host/src/lib.rs:2336-2437`），
   使**旧版被门槛挡在外面**，而不是让它读到一个它会把类型读错的记录。
   `min_protocol` 抬起来意味着旧版本连不上——这是有意的破坏性变更，正是"1.0.0 之前必须做完协议改动"的理由。
3. **第三刀起**：迁移 `0010_tags.sql`、`EntityKind::Tag`、命令面、界面、文档。

三张表被 `CHECK` 锁住了 kind 词汇表，SQLite 没有 `DROP CONSTRAINT` ⇒ 需要**重建表式迁移**：
`migrations/0001_init.sql:125`（`tombstones.entity_type IN ('note','folder','attachment')`）、
`migrations/0002_sync.sql:40`（`sync_remote_index.kind`）、`:56`（`sync_operations.entity_type`）。
`sync_conflicts.entity_type`（`0002_sync.sql:73`）**没有**约束，不用动。
按仓库既有规矩：新文件只追加（`0010_*`）、已发布文件不许改（`docs/CI-CD.md:371`），
`user_version` 从 `MIGRATIONS.len()` 派生（`crates/notera-store/src/types.rs:11`），
加一条 `Migration{}` 就自动抬版本（`crates/notera-store/src/migrate.rs:23-69`）。
**全新库与 v9 老库都要走到同一终态**，这条要由既有迁移矩阵测出来（`docs/CI-CD.md:379` 的 M2 矩阵 +
`crates/notera-store/tests/migrations_and_pragmas.rs:41-69` 的表/视图名单要同步扩）。

## 拒绝的方案
| 方案 | 拒绝理由 |
|---|---|
| `note_tags` 作为独立同步项（Joplin 的做法） | 见 D1。它要动的是上面三张 CHECK 表**再加** kind 词汇表在 ~15 处的静默点，而换来的正是 Joplin 那五格伤疤 |
| 标签只作为字符串存在笔记里（不建 tag 实体） | 改名不传播（每篇各存一份）、删除不传播、跨设备无法谈"同一颗标签"。**看着最省，其实是最贵的**：它把同步语义删掉了，界面却还能用 |
| 标题哈希当 id（D2 那条） | 改名即换身份 + 要为它开 `id` 校验的例外门 |
| 把标签塞进富文本块的属性里 | 标签是**笔记级**语义，块级存它会让三方合并的块对齐承担它不该承担的东西（ADR-0005 那条不变式） |
| 顺手做"按颜色检索" | A1 明确没拍板，且撞 v2 §3.3；本次只开标签族 |

## 后果
- **正面**：标签获得跨设备一致身份；多对多的同步语义只有一种实现路径（嵌在属主记录里），
  与 `note_attachments` 共用一条已验证的路；未知 kind 从"静默写错表"变成"具名拒绝"——
  这一条即使不做标签也该修，它是本 ADR 的副产品也是前置。
- **代价**：
  - 协议版本要升，`min_protocol` 抬起来 ⇒ 旧设备连不上。现网只有一位用户（你自己）与三平台产物，
    但这是**对外兼容承诺前**唯一能做这件事的窗口，也正是 P10 选"落完再发 1.0.0"的理由。
  - 打标签会顶笔记 rev ⇒ 高频打标签在弱网下的上传量要实测，不实测不许写进文档。
  - A1 那条负面承诺门要**翻成正面**并重下十把量级的刀（见"验证"），这是本项目最贵的一类改动。
  - 界面新增一整族状态（chip、自动补全开合、折叠提示），它们与只读态/冲突态互斥 ⇒
    判定要搬进纯函数，不许留在组件里当单测盲区（ADR-0019 的同一教训）。
- **不做**：层级标签（Joplin 加了又回滚，`JoplinDatabase.ts:814-822`）、标签颜色/图标、
  标签订阅/共享、批量"重名合并"清理屏（有 D4 就不该长出需要清理的东西；真出现了再说）。

## 验证方式（每条都要能 FAIL，先变异再信）
1. **加固那一刀的牙**：在没有 `tag` 之前，喂一条 `kind = "widget"` 的记录 ⇒
   改前红在"它被写进了 `notes`"，改后红在"具名拒绝 + 同步报告里看得见"。
   两版读数都要留下，前者是"改前为什么坏"的证人。
2. **收敛**：两台设备各建同名（大小写/NFC 差异）标签 ⇒ 折叠到同一 winner；
   **重放顺序反过来还是同一个 winner**（这是顺序无关性的正证，缺它这条判据是空枪）。
3. **改名**：一台改名，另一台拿到之后旧名不再出现在检索与 chip 上，且链接改写到 winner。
4. **删除期间迟到链接**：删标签 → 宽限期内让另一台推一条仍带旧 id 的笔记 ⇒ 不许复活死标签，
   也不许把那颗链接变成第二颗标签。
5. **迁移终态等价**：全新库 v10 与 v9 老库升 v10 的表/索引/CHECK 集合逐字节对撞；
   `tombstones.entity_type` 的新 CHECK 要能**拒**一个陌生的 kind（正向 + 反向两条）。
6. **相等关系只有一处**：静态判据扫界面，不许出现 `.toLowerCase()`/`normalize('NFC')` 参与标签比较
   （这条扫的是"第二个执行者"，与本项目"两份账对同一件事要互相对撞"同源）。
7. **负面承诺翻正面的五面刀**：`negativePromises.spec.ts:802-842` 现在禁的是表名/列名/DTO 字段/控件名/文案，
   翻过来钉的是"这些必须存在且只有这一个形状"；`unknown_enml_tags`（ENEX）与 `version-now-tag`
   这两个撞名项必须**继续**被放过，否则新门是在误伤别人。
8. **协议门**：旧 `min_protocol` 的客户端要连不上并报出**能看懂的**那句（消息键进 i18n，不许只剩哈希）。

## 关联
- 推翻/改口：`SPEC-AMENDMENTS.md` **A1** → 新增 **A12**；`docs/design/Noto-界面设计规范.v2.md` §6「明确不做」那一行
- 依赖：ADR-0004（清单两段式）· ADR-0005（Lamport rev + 共同祖先）· ADR-0006（tombstone 不自动 GC）· ADR-0018（单账户）
- 参照物源码：`.vendor/joplin`（3.7.21，只读、不入库）——
  `packages/lib/JoplinDatabase.ts:50-70,814-822` · `models/BaseItem.ts:75-83,357-385` ·
  `models/Tag.ts:47-54,83-91,173-189,251-269` · `services/interop/InteropService_Exporter_Md_frontmatter.ts:115-117` ·
  `app-desktop/gui/WindowCommandsAndDialogs/commands/setTags.ts:65-76`
- 待本 ADR 落地才能做的格子：搜索算符 `标签:`、多选批量加/摘标签（清单 P5）
