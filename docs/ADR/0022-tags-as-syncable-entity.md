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
     ⇒ **陌生 kind 在 `SetRemote`/`MarkSynced`/`Tombstone`/`Purge` 四处被丢掉时零痕迹**
     （既不计 `st.rejections` 也没有原因）。
     ⚠️ 本节最初据此写过"旧客户端会把 tag 记录当笔记写进 `notes`、用户看见一篇打不开的假笔记"——
     **那句已于同日复核时撤回**，理由与三道真正挡住它的具名拒绝见 **D7 顶部的订正框**：
     那一版是从 `_ => UpsertNote` 这一行**反推**出的载荷形状，而我从没造出那个载荷跑过。

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

### D7 前向门槛用**既有的 `protocol` 机制**；加固那一刀照做，但它不是发版阻塞

> **本节第 2 条的范围已被 D8 缩窄**（2026-10-18 实测之后）：`protocol` 那道门读的是**记录正文**，
> 而陌生 kind 的**墓碑/永久删根本不取记录** ⇒ 它管得住"内容格式变了"，管不住"清单里多了一种条目"。
> 旧设备那半边剩下 A/B 两个选项，写在 D8，**其中 A 要用户拍**。
> 第 1 条（那四处零痕迹丢弃改成具名拒收）不受影响，已作为 0.0.142 落主干。

> **订正（写完后逐行复核时推翻，2026-10-18 当日）**：本 D7 最初写的是"0.0.141 那版代码会把 tag 记录
> **当成笔记写进 `notes`**，所以必须先堵再放"。那句**不成立**，而且它正是本仓库明令禁止的那种写法 ——
> 从 `_ => UpsertNote` 这一行**反推**出一个没复现过的载荷形状，就把它当结论落笔了。
> 复核时读到的是三道**具名拒绝**，它们在任何一处 `_ =>` 之前就把路挡了：
> ① `crates/notera-webdav/src/path.rs:181-189` `kind_dir()` 只认 `n|f|a|note|folder|attachment(s)`，
> 其它一律 `Err(PathError::BadKind)` —— **fetch 之前就拒**，陌生 kind 连记录都取不回来；
> ② `crates/notera-store/src/apply.rs:53-58` `protocol > MAX_PROTOCOL(=1)` ⇒ `不写库`（原话），
> 这条就是为"新版写、旧版读"准备的前向门槛；
> ③ `crates/notera-store/src/apply.rs:64-69` 信封 `kind` 与目标表不符 ⇒ `StoreError::Rejected`。
> 还有一层在下面：`Envelope.kind` 是**类型化** `EntityKind` 的 serde（`crates/notera-crypto/src/envelope.rs:64-65`），
> 陌生 variant 连反序列化都过不去。⇒ **旧设备不会把标签写成假笔记。** `_ => UpsertNote` 那一行
> 靠的是①③兜住，这是**运气不是设计**，所以加固那一刀仍然要做，但它的性质变了（见下）。

**这一刀真正欠的东西**，不是数据损坏，是**同一份文件里两处口径不一致**：
下行早已定死"本地 apply 的拒绝不许没有去处"（`crates/notera-sync/src/lib.rs:890-894` 那段注释 + ADR-0021 D3），
上传边也早就具名拒了（`crates/notera-host/src/lib.rs:3900-3903`，原话"认不出的类型标记：绝不当成笔记上传"）；
唯独 `SetRemote`/`MarkSynced`/`Tombstone`/`Purge` 这四处是 `if let (Some(k), Ok(i)) = …` **没有 else**
（`crates/notera-host/src/lib.rs:3990 / 4000 / 4010 / 4019`）—— 陌生 kind 在这里被丢掉时
**既不计入 `st.rejections`、也没有 `last_rejection` 原因**。⇒ 修它是把"靠运气的那条"改成"与同文件另两条同一口径"。

**还有一格必须复现才许写结论**：旧客户端对未知 kind 的 `SetRemote` 静默丢，意味着它的
`sync_remote_index` 那一行永远记不上，于是**每轮都可能重新计划同一条陌生条目**（潜在空转，不是损坏）。
这一格现在只是**假说**，落地那一批要造出载荷实测（`crates/notera-host/tests/` 里加一台"停在旧协议"的设备），
复现不出来就不许写进文档。

次序因此改为（并且比原来更省）：

1. **加固那一刀（先上，单独一版）**：上述四处 `if let` 改成显式 `match`，陌生 kind ⇒ 计入拒收 +
   留下可读原因（消息键进 i18n）；`apply.rs:503-507,551-555` 那两处 `if kind == Note {…} else {folders}`
   改成穷尽匹配（今天它靠调用方保证，改穷尽之后加第四个变体就不会静默落进 `folders`）。
   判据要证"改前静默丢弃且零痕迹 → 改后具名拒收且进报告"，两版读数都留下。
   **这一刀没有任何新 kind，对现网是纯加固。**
2. **前向门槛 = 用已有的 `protocol` 字段**：tag 记录写 `protocol = 2`，本仓库 `MAX_PROTOCOL` 抬到 2，
   `manifest.rs:9` 的 `PROTOCOL: u16 = 1` 与 `protocol.json` 的 `min_protocol`
   （协商与根不匹配的门在 `crates/notera-host/src/lib.rs:2336-2437`）随之定档。
   ⇒ 停在 0.0.141 的客户端遇到 tag 记录时**在②处具名失败**（"不写库"），而笔记/文件夹照旧同步 ——
   这比"整台设备抬 `min_protocol` 挡在门外"精确得多，也是原方案（抬 `min_protocol`）被撤下的理由。
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

### D8 量完之后：per-record 的 `protocol` 抬不过墓碑这条路，所以旧设备的门只剩两个真选项

第一百三十批之后补的实测（2026-10-18，`crates/notera-sync/tests/engine.rs::
an_unknown_purged_kind_is_replanned_every_round_but_costs_no_requests`，读数是跑出来的不是推的）：

| 量的东西 | 读数 |
|---|---|
| 陌生 kind 的墓碑会不会每轮重新计划 | **会** —— 第一轮 1 条 `Purge{kind:"g"}`，第二轮累计 2 条 |
| 每轮各拒几次 | 各 1 次（`st1.rejections == 1`、`st2.rejections == 1`，不累积） |
| 每轮花几个请求 | **1 个**（两轮一样，且就是那一次清单读；墓碑不取记录 ⇒ 没有网络空转） |

⇒ 三句结论，第一句是要紧的：

1. **D7 ② 原来那句"tag 记录带 `protocol = 2` 就当旧设备的前向门槛"对墓碑这一半无效。**
   存储层那句 `protocol > MAX_PROTOCOL ⇒ 不写库`（`apply.rs:53-58`）读的是**记录正文**，
   而 P13 这一路**根本不取记录** —— 所以旧设备永远看不到那个 `protocol` 字段，门也就永远不响。
   这一句在 D7 里写的时候我没走到这一步，是量完才发现的。**per-record 版本门管得住"内容格式变了"，
   管不住"清单里多了一种我不认识的条目"** —— 这两件事以后都要版本，但版本的是不同的东西。
2. **代价比我原来担心的小得多**：不是请求风暴，是"每轮一条白扔的 op + 一次具名拒收"。
   所以"抬 `min_protocol` 把整台旧设备挡在门外"这个原方案，**理由不再成立**（它是为一个不存在的网络风暴付代价）。
3. **但剩下一个真问题**：拒收一旦进界面（任务 #4 的逐项报告），一台旧设备会因为"对面用了标签"
   而**永远显示有一条被拒收** —— 用户看见的是"我的同步一直有错"，而真相是"这台该升级了"。
   两种都能活的解法，只能选一个：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A** | 标签第一次出现时抬 `protocol.json` 的 `min_protocol` ⇒ 旧设备直接连不上那个根，界面说"请升级" | 已发的 0.0.141 及更早**停止同步**（不是停止使用：本地照旧，只是不再对上） |
| **B** | 不动门，接受旧设备每轮一次具名拒收；等 #4 的界面那格把这种"我不认识某种记录"单独说清（消息键 + 一句"升级即可"），不混进"同步出错" | 界面上多一档状态与一条判据；旧设备在升级前看不到标签（本来也看不到） |

这一格**要用户拍**：它动的是"已经装出去的那台还能不能同步"，属于发布决策，不是实现细节。
我的建议是 **B** —— A 花掉的是真实用户的同步能力，换来的只是省掉一条本可以说明白的噪声；
而 B 的代价正好落在 #4 本来就要做的那格上（拒收可见化），不用额外立工。

**还欠半边读数**：上面这格量的是"墓碑不取记录"那一路。**活条目被拉**那一路在这里量不出来 ——
`FakeRemote.fetch_record` 不走路径构造，陌生 kind 在它那里是 `Ok(None)`（于是走 §10 的 `MissingRemote`），
而不是真适配器那句 `kind_dir` 的 `Err(BadKind)`（`path.rs:181-189`）。
那一半要用 `crates/notera-webdav/tests/engine_over_webdav.rs`（真 `WebDavRemote` 打在测试服务器上）去量，
**不许拿假 remote 的读数冒充真适配器的行为** —— 登记成待办，标签落地那一批补。

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
