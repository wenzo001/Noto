//! 标签存储层（ADR-0022）。
//!
//! 三条与"标签是新实体"绑定的口径，都写在这里而不是散给调用方：
//!  · **相等关系只有一处**：`canonical` 由 `notera_core::canonical::canonical_tag_name` 算
//!    （NFKC + 全 Unicode 小写，两遍），界面与 SQL 都不许再算一遍 —— ADR-0022 D3，
//!    那条静态判据扫的就是"第二个执行者"。
//!  · **链接在属主记录里**（`notes.tag_ids` 那一列，见 `migrations/0010_tags.sql` 里那段为什么不是投影表），
//!    所以这里**没有** `note_tags` 的写入路径，也没有"链接比标签先到"的竞态。
//!  · **删除是软删除**（`deleted_at`），传播形态与笔记一致：带 `deleted_at` 的 upsert（ADR-0006 那条口径），
//!    不是"文件消失"；永久删除才走墓碑。

use rusqlite::{params, OptionalExtension};

use notera_core::{canonical::canonical_tag_name, hash_json, next_rev, EntityId, EntityKind, Rev};

use crate::rows;
use crate::store::{validate_name, Store};
use crate::types::{Note, OpKind};
use crate::StoreError;

/// 一颗粒标签。字段与 `tags` 表一一对应（`rev`/`sync_rev` 是 `Rev`，与 notes/folders 同构）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub id: EntityId,
    pub title: String,
    pub canonical: String,
    /// D4 折叠：非空 = 这颗已并入 winner，自己只是别名（链接里的旧 id 按它改写）。
    pub alias_of: Option<EntityId>,
    pub rev: Rev,
    pub sync_rev: Rev,
    pub remote_rev: Rev,
    pub content_hash: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

/// 标签的 content hash。**payload 键集就是这一家子 = 只有 `title`**，多一个键少一个键都会让
/// "远端 hash == 本地 hash" 判错，进而错判"要不要拉这一版"（与 `folder_hash` 同一条理由）。
///
/// 为什么 `canonical` 与 `alias_of` **不进哈希、也不上线**（写收件路径时改的图纸）：
///  · 两者都是 `title` 的**纯函数 + 本机看到的记录集合**推出来的，属于"派生的本地事实"，
///    与 `note_attachments` 那张投影表同一族（ADR-0022 D1）。
///  · 把它们塞上线会造出一个真的毒丸：`apply_tag` 折叠时给输的那颗写 `alias_of` 是**不顶 rev 的
///    本地降级**（折叠由"两边各自对同一批记录套同一条规则"得出，不需要传播）。于是一行
///    `content_hash`（按 alias 算）与 wire（按 payload 算）对不上 ⇒ I6 闸门**整批回滚**，
///    症状是"对面有一颗标签之后，本机再也同步不进来任何东西"。
///  · 少传 `canonical` 还顺手关掉跨版本耦合：两台构建的 icu 归一化表万一不同步，
///    传了就是把一次**格式分歧**烘进哈希里。本机重算，两边都会收敛到同一颗 winner。
pub(crate) fn tag_hash(title: &str) -> String {
    hash_json(&serde_json::json!({ "title": title }))
        .as_str()
        .to_string()
}

fn row_to_tag(r: &rusqlite::Row<'_>) -> rusqlite::Result<Tag> {
    let id: String = r.get(0)?;
    let parse = |s: &str| {
        EntityId::parse(s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    };
    let alias: Option<String> = r.get(3)?;
    Ok(Tag {
        id: parse(&id)?,
        title: r.get(1)?,
        canonical: r.get(2)?,
        alias_of: alias.as_deref().map(parse).transpose()?,
        rev: Rev(r.get::<_, i64>(4)? as u64),
        sync_rev: Rev(r.get::<_, i64>(5)? as u64),
        remote_rev: Rev(r.get::<_, i64>(6)? as u64),
        content_hash: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        deleted_at: r.get(10)?,
    })
}

const TAG_COLS: &str = "id, title, canonical, alias_of, rev, sync_rev, remote_rev, content_hash, created_at, updated_at, deleted_at";

impl Store {
    pub(crate) fn read_tag_tx(
        tx: &rusqlite::Connection,
        id: &EntityId,
    ) -> Result<Option<Tag>, StoreError> {
        let mut stmt = tx.prepare(&format!("SELECT {TAG_COLS} FROM tags WHERE id = ?1"))?;
        let mut rows = stmt.query_map([id.as_str()], row_to_tag)?;
        // 先取出来再返回：`by_ref()` 那类写法会让 `rows` 借着 `stmt` 活过它的生命期（E0597）。
        let found = match rows.next() {
            Some(r) => Some(r?),
            None => None,
        };
        drop(rows);
        drop(stmt);
        Ok(found)
    }

    pub fn read_tag(&self, id: &EntityId) -> Result<Option<Tag>, StoreError> {
        let conn = self.read()?;
        Self::read_tag_tx(&conn, id)
    }

    /// 侧栏/检索用的活标签表（别名与软删的都不出现）。
    pub fn list_tags(&self) -> Result<Vec<Tag>, StoreError> {
        let conn = self.read()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {TAG_COLS} FROM tags WHERE deleted_at IS NULL AND alias_of IS NULL ORDER BY title COLLATE NOCASE, id"
        ))?;
        let rows = stmt.query_map([], row_to_tag)?;
        let out = rows.collect::<Result<_, _>>()?;
        drop(stmt);
        Ok(out)
    }

    /// 新建。**同名（canonical 相等）不新建第二颗**：直接返回已有那一颗
    /// —— Joplin 的"两台设备各建一颗、之后永远不相认"就是从这一格开始的。
    ///
    /// 走 `write_tx` 而不是"先查再插"：查与插之间另一个人建了同名标签，
    /// 靠的是 `tags_canonical_live` 那个部分唯一索引兜底（撞上了整个事务回滚，调用方重试即可），
    /// 不是靠"我查过了应该没有"。
    pub fn create_tag(&self, title: &str) -> Result<Tag, StoreError> {
        let title = validate_name(title)?;
        let canonical = canonical_tag_name(&title);
        let id = EntityId::new();
        let device = self.device.to_string();
        self.write_tx(|tx, now| {
            // `.optional()` 而不是 `.ok()`：后者把**真 SQL 错误**也读成"没有同名标签"，
            // 于是那一笔会往下走去 INSERT —— 症状是错误被吞、还可能撞上唯一索引。
            let hit: Option<String> = tx
                .query_row(
                    "SELECT id FROM tags WHERE canonical = ?1 AND deleted_at IS NULL AND alias_of IS NULL LIMIT 1",
                    [&canonical],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            if let Some(hit) = hit {
                // 已有同名：幂等返回那一颗，不产生第二行也不产生第二笔 outbox。
                let existing = EntityId::parse(&hit).map_err(|e| {
                    StoreError::Constraint(format!("库里已有的标签 id 不合法: {e}"))
                })?;
                return Self::read_tag_tx(tx, &existing)?
                    .ok_or_else(|| StoreError::not_found(EntityKind::Tag, existing));
            }
            let rev = next_rev(Rev::ZERO, Rev::ZERO);
            let hash = tag_hash(&title);
            tx.execute(
                "INSERT INTO tags (id, title, canonical, alias_of, rev, sync_rev, remote_rev,
                                   content_hash, created_at, updated_at, created_device, updated_device, deleted_at)
                 VALUES (?1,?2,?3,NULL,?4,0,0,?5,?6,?6,?7,?7,NULL)",
                params![id.as_str(), title, canonical, rev.get() as i64, hash, now, device],
            )?;
            rows::enqueue(tx, now, EntityKind::Tag, &id, OpKind::Upsert, Some(rev), Some(&hash))?;
            Self::read_tag_tx(tx, &id)?.ok_or_else(|| StoreError::not_found(EntityKind::Tag, id.clone()))
        })
    }

    /// 改名。**只动这一条记录**，不去重写笔记里的链接 —— 那是 D1 那条取舍的全部意义：
    /// 改名传播 = 一颗标签记录的一次 upsert，而不是 N 篇笔记各推一次 rev。
    /// （代价反过来落在"打标签"上：那会顶属主笔记的 rev，写在 D1。）
    pub fn rename_tag(&self, id: &EntityId, title: &str) -> Result<Tag, StoreError> {
        let title = validate_name(title)?;
        let canonical = canonical_tag_name(&title);
        self.write_tx(|tx, now| {
            let cur = Self::read_tag_tx(tx, id)?.ok_or_else(|| StoreError::not_found(EntityKind::Tag, id.clone()))?;
            if cur.deleted_at.is_some() {
                return Err(StoreError::Constraint(format!("标签 {id} 已在回收站，先恢复再改名")));
            }
            if cur.title == title {
                return Ok(cur);
            }
            let clash: Option<String> = tx
                .query_row(
                    "SELECT id FROM tags WHERE canonical = ?1 AND id <> ?2 AND deleted_at IS NULL AND alias_of IS NULL LIMIT 1",
                    params![canonical, id.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .ok();
            if let Some(clash) = clash {
                let clash = EntityId::parse(&clash)
                    .map_err(|e| StoreError::Constraint(format!("库里同名标签的 id 不合法: {e}")))?;
                return Err(StoreError::Constraint(format!(
                    "已有同名标签 {clash}；要合并请先删掉一颗"
                )));
            }
            let rev = next_rev(cur.rev, cur.remote_rev);
            let hash = tag_hash(&title);
            tx.execute(
                "UPDATE tags SET title = ?2, canonical = ?3, rev = ?4, content_hash = ?5, updated_at = ?6, updated_device = ?7 WHERE id = ?1",
                params![id.as_str(), title, canonical, rev.get() as i64, hash, now, self.device.to_string()],
            )?;
            rows::enqueue(tx, now, EntityKind::Tag, id, OpKind::Upsert, Some(rev), Some(&hash))?;
            Self::read_tag_tx(tx, id)?.ok_or_else(|| StoreError::not_found(EntityKind::Tag, id.clone()))
        })
    }

    /// 软删除（进"最近删除"的语义，但标签**不进回收站界面** —— ADR 的"不做"那一节）。
    /// 传播是带 `deleted_at` 的 upsert（ADR-0006：删除是记录内容，不是文件消失）。
    pub fn delete_tag(&self, id: &EntityId) -> Result<(), StoreError> {
        self.write_tx(|tx, now| {
            let cur = Self::read_tag_tx(tx, id)?.ok_or_else(|| StoreError::not_found(EntityKind::Tag, id.clone()))?;
            if cur.deleted_at.is_some() {
                return Ok(()); // 幂等
            }
            let rev = next_rev(cur.rev, cur.remote_rev);
            let hash = tag_hash(&cur.title);
            tx.execute(
                "UPDATE tags SET deleted_at = ?2, rev = ?3, content_hash = ?4, updated_at = ?2, updated_device = ?5 WHERE id = ?1",
                params![id.as_str(), now, rev.get() as i64, hash, self.device.to_string()],
            )?;
            rows::enqueue(tx, now, EntityKind::Tag, id, OpKind::Upsert, Some(rev), Some(&hash))?;
            Ok(())
        })
    }

    /// 每颗标签被多少篇**活笔记**引用。侧栏/选择器要显示条数，而"点了删不掉"的
    /// 空标签也需要一个可见的理由。
    ///
    /// 一条扫描出全部，不是每颗标签一条 `COUNT(*)`：链接住在 `notes.tag_ids` 那一列里
    /// （ADR-0022 D1），没有反向索引可走，逐颗查会把 O(标签数 × 笔记数) 摆到首屏上。
    ///
    /// 计数**先按别名改写到 winner**再分组（与读侧 `live_tag_ids_in` 同一个口径）：
    /// 折叠之后链接里可能还写着输的那颗 id，不改写就会把"winner 0 篇 / 输家 3 篇"
    /// 这种界面读数留下来 —— 而那正是用户判断"这颗能不能删"的唯一依据。
    /// 一跳就够：`alias_of` 只指向"活的、不是别名"的那一颗（`apply_tag` 折叠时就是这么挑的）。
    pub fn tag_note_counts(&self) -> Result<std::collections::BTreeMap<String, i64>, StoreError> {
        let conn = self.read()?;
        let mut stmt = conn.prepare(
            "WITH resolved AS (
               SELECT COALESCE(NULLIF(t.alias_of, ''), j.value) AS id
               FROM notes n, json_each(n.tag_ids) j
               LEFT JOIN tags t ON t.id = j.value
               WHERE n.deleted_at IS NULL
             )
             SELECT id, COUNT(*) FROM resolved GROUP BY id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let out = rows.collect::<Result<_, _>>()?;
        drop(stmt);
        Ok(out)
    }

    /// 读一篇笔记的活标签 id（软删/别名都过滤掉）。**读侧统一走这一处**，
    /// 这样"标签删了但某篇还带着旧 id"这一格不需要任何清理任务。
    pub fn live_tag_ids(&self, note_id: &EntityId) -> Result<Vec<String>, StoreError> {
        let conn = self.read()?;
        // 没有这一行 = 没有标签，不是错误。对面正在传来的 id、以及界面里还留着
        // 但本机已彻底删掉的那篇，都会走到这一格；在这儿报错会让"读一篇笔记的标签"
        // 变成一次同步竞态的目击者（整跑 ㊷ 那条腿就是这么红的：HTTP 400 → console error）。
        let raw: Option<String> = conn
            .query_row(
                "SELECT tag_ids FROM notes WHERE id = ?1",
                [note_id.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else {
            return Ok(Vec::new());
        };
        Self::live_tag_ids_in(&conn, &raw)
    }

    pub(crate) fn live_tag_ids_in(
        conn: &rusqlite::Connection,
        raw: &str,
    ) -> Result<Vec<String>, StoreError> {
        let ids = parse_tag_ids(raw)?;
        let mut out = Vec::new();
        for id in ids {
            let live: Option<String> = conn
                .query_row(
                    "SELECT id FROM tags WHERE id = ?1 AND deleted_at IS NULL AND alias_of IS NULL",
                    [id.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .ok();
            if let Some(v) = live {
                out.push(v);
            } else {
                // 别名要改写：折叠之后链接里可能还留着输的那颗 id（D4）。
                if let Some(winner) = conn
                    .query_row(
                        "SELECT alias_of FROM tags WHERE id = ?1 AND alias_of IS NOT NULL",
                        [id.as_str()],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .ok()
                    .flatten()
                {
                    out.push(winner);
                }
            }
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// 设一篇笔记的标签集合（**幂等：集合相同就不产生第二笔 outbox**）。
    /// 走 `commit_edit` 那唯一的元数据写入收口（与 pinned/color 同一条路，见 ADR-0022 订正 ⑧）：
    /// 另写一套"标签版编辑"迟早分叉成"改标签不顶 rev"或"绕过只读拒绝"。
    pub fn set_note_tags(
        &self,
        note_id: &EntityId,
        tag_ids: &[String],
    ) -> Result<Note, StoreError> {
        let ids = normalize_tag_ids(tag_ids)?;
        self.write_tx(|tx, now| {
            let cur = Store::load_cur(tx, note_id)?;
            Store::assert_editable(&cur.note)?;
            // 只接受**活着的**标签：把软删/别名的 id 写进链接，等于给界面留一颗点不开的 chip。
            for id in &ids {
                let ok: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tags WHERE id = ?1 AND deleted_at IS NULL AND alias_of IS NULL",
                        [id.as_str()],
                        |r| r.get(0),
                    )
                    .ok();
                if ok.is_none() {
                    return Err(StoreError::Constraint(format!("标签 {id} 不存在或已删除")));
                }
            }
            if cur.note.tag_ids == ids {
                return rows::read_note(tx, note_id)?
                    .ok_or_else(|| StoreError::not_found(EntityKind::Note, note_id.clone()));
            }
            let edit = crate::store::Edit {
                tag_ids: Some(ids),
                ..Default::default()
            };
            self.commit_edit(tx, &cur, &edit, now)
        })
    }
}

/// `notes.tag_ids` 那一列的读法。**坏 JSON 不许把整篇笔记带崩**：按空集处理并留一行 warn
/// （这一列是别人写的记录，`apply_remote` 已经验过形状，这里防的是库被外部改过）。
pub(crate) fn parse_tag_ids(raw: &str) -> Result<Vec<EntityId>, StoreError> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = serde_json::from_str(raw)
        .map_err(|e| StoreError::Constraint(format!("notes.tag_ids 不是 JSON 数组: {e}")))?;
    ids.iter()
        .map(|s| {
            EntityId::parse(s).map_err(|e| {
                StoreError::Constraint(format!("notes.tag_ids 里 {s:?} 不是合法 UUID: {e}"))
            })
        })
        .collect()
}

/// 写入前的规范化：合法 UUID、去重、按 id 排序（**顺序不进契约**，见 [[assert-by-identity-not-position]]：
/// 按位置比会因两台设备各推一次而假红）。
pub(crate) fn normalize_tag_ids(raw: &[String]) -> Result<Vec<String>, StoreError> {
    let mut out = Vec::with_capacity(raw.len());
    for s in raw {
        EntityId::parse(s)
            .map_err(|e| StoreError::Constraint(format!("tag_ids 里 {s:?} 不是合法 UUID: {e}")))?;
        out.push(s.clone());
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// 标签 `canonical` 由核心算，**不许由载荷带进来**（否则"第二个执行者"从后门回来了）。
/// 载荷里出现 `canonical` 也直接忽略，重新算一遍。
pub(crate) fn canonical_of_title(title: &str) -> String {
    canonical_tag_name(title)
}
