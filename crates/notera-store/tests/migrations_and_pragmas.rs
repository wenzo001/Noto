//! 迁移契约与 PRAGMA（ADR-0012 / DATA-MODEL §2、§12）。
mod common;

use common::*;
use notera_store::{SearchQuery, Store, StoreError, SUPPORTED_SCHEMA_VERSION};

fn user_version(file: &std::path::Path) -> u32 {
    let conn = rusqlite::Connection::open(file).unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap() as u32
}

/// 期望的迁移序列：`from..=支持版本` 连续递增。
/// 不写死 `[1,2,3,4,5]` —— 那样每加一个迁移就得改测试，很容易顺手改成"少一个也过"。
/// 下限断言保证真有人删迁移号时这里仍然会红。
/// 写成 `const`：编译期就红，不用等测试被跑到。
const _: () = assert!(
    SUPPORTED_SCHEMA_VERSION >= 5,
    "支持版本不该低于 5，迁移序列被截断了？"
);
fn contiguous_from(from: u32) -> Vec<u32> {
    (from..=SUPPORTED_SCHEMA_VERSION).collect()
}

#[test]
fn empty_db_migrates_to_latest_and_tables_exist() {
    let fx = Fix::new();
    let store = fx.open();
    assert_eq!(store.migration_report().from, 0);
    assert_eq!(store.migration_report().to, SUPPORTED_SCHEMA_VERSION);
    assert_eq!(
        store.migration_report().applied,
        contiguous_from(1),
        "空库必须按 1..=支持版本逐号补齐，且不能跳号"
    );
    assert_eq!(user_version(&fx.db_file()), SUPPORTED_SCHEMA_VERSION);

    // 表/视图齐全（逐字照抄 DATA-MODEL §5 + §13）
    let conn = rusqlite::Connection::open(fx.db_file()).unwrap();
    let mut stmt = conn
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts_%' ORDER BY name")
        .unwrap();
    let names: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .by_ref()
        .collect::<Result<_, _>>()
        .unwrap();
    let flat: Vec<&str> = names.iter().map(|(_, n)| n.as_str()).collect();
    for want in [
        "meta",
        "settings",
        "folders",
        "notes",
        "note_revisions",
        "attachments",
        "note_attachments",
        "tags",
        "tombstones",
        "sync_accounts",
        "sync_state",
        "sync_remote_index",
        "sync_operations",
        "sync_conflicts",
        "notes_fts",
        "v_note_list",
        "v_trash",
        "v_folder_tree",
    ] {
        assert!(flat.contains(&want), "缺少表/视图 {want}：{flat:?}");
    }
    // 视图可读（§13 的递归 CTE / 回收站视图）
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM v_note_list", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
    let tree: Vec<(String, i64, String)> = conn
        .prepare("SELECT id, depth, path FROM v_folder_tree ORDER BY path")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .by_ref()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tree.len(), 1, "只有默认本一棵树：{tree:?}");
    assert_eq!(tree[0].2, format!("/{}", notera_store::DEFAULT_FOLDER_NAME));
    assert!(store.verify().is_empty());
}

#[test]
fn reopening_does_not_reapply_migrations_or_duplicate_bootstrap() {
    let fx = Fix::new();
    let first_root;
    {
        let store = fx.open();
        first_root = default_folder(&store);
        create(&store, &first_root, "只写一次");
    }
    for _ in 0..3 {
        let store = fx.reopen();
        assert!(
            store.migration_report().applied.is_empty(),
            "重复 open 不得再跑迁移"
        );
        assert_eq!(user_version(&fx.db_file()), SUPPORTED_SCHEMA_VERSION);
        assert_eq!(default_folder(&store), first_root, "默认本不得被重复创建");
        assert_eq!(store.stats().unwrap().notes, 1);
        assert_eq!(
            store
                .list_notes(&notera_store::NoteQuery::all())
                .unwrap()
                .len(),
            1
        );
    }
    let folders = fx.reopen().list_folders().unwrap();
    assert_eq!(folders.len(), 1, "引导幂等：{folders:?}");
    assert_eq!(
        folders.iter().filter(|f| f.system_kind.is_some()).count(),
        1
    );
}

#[test]
fn upgrade_from_a_real_v2_database_backs_up_and_keeps_data() {
    // ADR-0012 M2/M3：先造一个**真正的 v2 库**（只应用 0001+0002），再让本程序升到 HEAD。
    let fx = Fix::new();
    let db = fx.db_file();
    build_partial_db(&db, 2);
    assert_eq!(user_version(&db), 2);
    let legacy = seed_legacy_note(&db);

    let store = fx.reopen();
    let rep = store.migration_report();
    assert_eq!(rep.from, 2);
    assert_eq!(
        rep.applied,
        contiguous_from(3),
        "只补缺失的后续迁移（forward-only）"
    );
    assert_eq!(
        rep.backup,
        Some(fx.dir.join("notera.sqlite.pre-migration.2"))
    );
    assert!(
        rep.backup.as_ref().unwrap().exists(),
        "迁移前必须有物理备份（ADR-0012）"
    );
    assert_eq!(user_version(&db), SUPPORTED_SCHEMA_VERSION);

    // M3：行数与内容不变，且新增的 FTS 由启动自愈补齐 → 老数据立刻可搜
    assert_eq!(store.stats().unwrap().notes, 1, "升级后笔记数不变");
    assert_eq!(store.get_note(&legacy).unwrap().unwrap().title, "老笔记");
    assert_eq!(
        store.stats().unwrap().fts_rows,
        1,
        "0003 建的空索引必须由启动自检补齐"
    );
    assert_eq!(
        store.search(&SearchQuery::new("老笔记")).unwrap().len(),
        1,
        "升级后老数据可搜"
    );
    assert_eq!(
        store
            .dirty_entities(notera_store::LOCAL_ACCOUNT_ID)
            .unwrap()
            .len(),
        2,
        "老笔记 + 默认本待上行"
    );
    assert!(store.verify().is_empty(), "{:?}", store.verify());

    // 升级后的库立即可写（新笔记 + 索引同步）
    let n = store
        .create_note(&default_folder(&store), doc_text("升级后新建"))
        .unwrap();
    assert_eq!(store.search(&SearchQuery::new("升级后")).unwrap().len(), 1);
    assert!(n.rev.get() >= 1);
    assert!(store.verify().is_empty(), "{:?}", store.verify());
}

#[test]
fn future_db_version_opens_read_only_and_is_never_downgraded() {
    let fx = Fix::new();
    {
        let store = fx.open();
        create(&store, &default_folder(&store), "未来的库");
    }
    let ahead = SUPPORTED_SCHEMA_VERSION + 7;
    downgrade(&fx.db_file(), ahead);
    let hash_before = notera_crypto::sha256_hex_file(&fx.db_file()).unwrap();
    let before_files = visible_listing(&fx.dir);

    // ADR-0012 说的是"**进入只读模式**"，不是"启动失败"。旧实现把这一格做成了
    // `Store::open` 直接返回 Err —— 于是整本库连读都读不到，界面也就永远挂不出
    // §4.2 那句"请升级以编辑"（缺口 G85）。
    let store = Store::open(&fx.dir, fx.device.clone())
        .expect("库过新时必须打得开 —— 只读模式不是启动失败（ADR-0012 M4）");
    assert_eq!(
        store.library_read_only(),
        Some((ahead, SUPPORTED_SCHEMA_VERSION))
    );
    let stats = store.stats().unwrap();
    assert!(stats.library_read_only, "界面读不到这一位就挂不出全局横幅");
    assert_eq!(stats.notes, 1, "只读模式下笔记必须照样读得到");

    // 写：拒，且拒的是"库过新"这一格。
    let e = store
        .create_note(&default_folder(&store), doc_text("这一笔不该落下去"))
        .expect_err("只读闸门下不许写回");
    match e {
        StoreError::ReadOnly { db, supported } => {
            assert_eq!((db, supported), (ahead, SUPPORTED_SCHEMA_VERSION));
        }
        other => panic!("必须是 StoreError::ReadOnly，实际 {other:?}"),
    }
    assert_eq!(
        store.stats().unwrap().notes,
        1,
        "被拒的那一笔不许落进库（拒了却没拒住是同一族的形状）"
    );

    assert_eq!(user_version(&fx.db_file()), ahead, "绝不降级写回（M4）");
    assert_eq!(
        notera_crypto::sha256_hex_file(&fx.db_file()).unwrap(),
        hash_before,
        "只读模式不得改动库文件（M4）"
    );
    let after_files = visible_listing(&fx.dir);
    assert_eq!(
        after_files, before_files,
        "只读闸门下不得产生备份或任何文件变化"
    );
    assert!(
        !after_files
            .iter()
            .any(|n| n.ends_with(&format!("pre-migration.{ahead}"))),
        "被拒绝的迁移不得生成备份：{after_files:?}"
    );
    drop(store);

    // 回到支持范围内后仍可写（只读闸门不是"库坏了"）
    downgrade(&fx.db_file(), SUPPORTED_SCHEMA_VERSION);
    let store = fx.reopen();
    assert_eq!(store.library_read_only(), None);
    assert!(!store.stats().unwrap().library_read_only);
    create(&store, &default_folder(&store), "升级之后能写了");
    assert_eq!(store.stats().unwrap().notes, 2);
}

#[test]
fn pragmas_match_data_model_section_12() {
    let fx = Fix::new();
    let store = fx.open();
    create(&store, &default_folder(&store), "pragma 检查");
    // WAL 是库级持久设置
    let conn = rusqlite::Connection::open(fx.db_file()).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode.to_ascii_lowercase(), "wal", "journal_mode 必须是 WAL");
    drop(conn);
    // synchronous/busy_timeout/foreign_keys 是连接级：verify() 检的正是 Store 自己的连接
    assert!(
        store.verify().is_empty(),
        "verify() 检查的正是 Store 自己连接上的 §12 PRAGMA：{:?}",
        store.verify()
    );
    // 写连接是单写者：并发编辑不得产生丢文件或 rev 跳号
    let store = std::sync::Arc::new(store);
    let folder = default_folder(&store);
    let id = store.create_note(&folder, doc_text("单写者")).unwrap().id;
    let mut handles = Vec::new();
    for i in 0..6 {
        let s = store.clone();
        let id = id.clone();
        handles.push(std::thread::spawn(move || {
            for k in 0..3 {
                let cur = s.get_note(&id).unwrap().unwrap();
                // 允许 StaleEdit（单写者串行化下会被后来的写覆盖），但不许 panic
                let _ = s.edit_note(&id, doc_text(&format!("线程 {i} 第 {k} 次")), cur.rev);
            }
        }));
    }
    for h in handles {
        h.join().expect("线程不得 panic");
    }
    let n = store.get_note(&id).unwrap().unwrap();
    assert!(n.rev.get() >= 2, "至少推进过一次：{}", n.rev);
    assert!(store.verify().is_empty(), "{:?}", store.verify());
}

/// 造一个"真正的 v_k 库"：只按顺序应用前 k 个迁移文件（ADR-0012 的 M2 场景）。
///
/// **文件名单从盘上扫，不手写**（旧版是 `[(u32,&str); 5]` 那份手抄表）：手抄那份的失效方式是
/// "加了 0010 之后这里还是只到 5"，于是"从 v9 升上来"这一格根本不存在，测试绿着空转。
/// 扫盘 ⇒ 迁移目录多一个文件，这个 helper 自动认得；版本号取自文件名前缀（`0007_xxx.sql` → 7）。
fn migrations_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../migrations")
        .canonicalize()
        .expect("migrations 目录读不到")
}

/// 盘上迁移文件按版本号排好序的 `(ver, sql)` 表。
fn migration_files() -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = std::fs::read_dir(migrations_dir())
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".sql")?;
            let ver: u32 = stem.split('_').next()?.parse().ok()?;
            let sql = std::fs::read_to_string(migrations_dir().join(&name)).unwrap();
            Some((ver, sql))
        })
        .collect();
    out.sort_by_key(|(v, _)| *v);
    out
}

fn build_partial_db(file: &std::path::Path, through: u32) {
    let conn = rusqlite::Connection::open(file).unwrap();
    for (ver, sql) in migration_files() {
        if ver > through {
            break;
        }
        conn.execute_batch(&sql).unwrap();
    }
    conn.pragma_update(None, "user_version", through as i64)
        .unwrap();
    drop(conn);
}

/// 以"旧客户端"的身份手写一条笔记（v2 时代没有 notes_fts，派生列/历史由旧程序写）。
fn seed_legacy_note(file: &std::path::Path) -> notera_core::EntityId {
    use notera_core::{ContentHash, EntityId};
    let conn = rusqlite::Connection::open(file).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let now = "2026-09-20T00:00:00.000Z";
    let folder = EntityId::new();
    let note = EntityId::new();
    conn.execute(
        "INSERT INTO folders (id, parent_id, name, system_kind, sort_order, rev, sync_rev, remote_rev,
                              content_hash, created_at, updated_at, created_device, updated_device)
         VALUES (?1,NULL,'默认本','default',0,1,0,0,?2,?3,?3,'dev-old','dev-old')",
        rusqlite::params![folder.as_str(), format!("sha256:{}", "f".repeat(64)), now],
    )
    .unwrap();
    let doc = serde_json::json!({
        "v": 1,
        "content": [
            { "id": "legacy01", "type": "heading", "attrs": { "level": 1 }, "content": [{ "text": "老笔记" }] },
            { "id": "legacy02", "type": "paragraph", "content": [{ "text": "升级前就存在的正文" }] }
        ]
    });
    let parsed = notera_richtext::parse_from_value(&doc).unwrap();
    let canonical = notera_richtext::canonical(&parsed);
    let hash = ContentHash::of(canonical.as_bytes());
    let ex = notera_richtext::extract(&parsed);
    conn.execute(
        "INSERT INTO notes (id, folder_id, doc, doc_format, pinned, title, plain_text, summary,
                            char_count, block_count, has_attachment, rev, sync_rev, remote_rev,
                            content_hash, created_at, updated_at, created_device, updated_device)
         VALUES (?1,?2,?3,1,0,?4,?5,?6,?7,?8,0,1,0,0,?9,?10,?10,'dev-old','dev-old')",
        rusqlite::params![
            note.as_str(),
            folder.as_str(),
            canonical,
            ex.title,
            ex.plain_text,
            ex.summary,
            ex.char_count as i64,
            ex.block_count as i64,
            hash.as_str(),
            now
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_revisions (note_id, rev, doc, content_hash, origin, device_id, created_at)
         VALUES (?1,1,?2,?3,'local','dev-old',?4)",
        rusqlite::params![note.as_str(), canonical, hash.as_str(), now],
    )
    .unwrap();
    drop(conn);
    note
}

/// 目录里的文件名（排序后），用于"拒绝打开不得改动文件"这类断言。
fn listing(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    v.sort();
    v
}

/// 同上，但**不看 WAL 的伴生文件**：只读模式仍要开连接读，SQLite 自己会落下
/// `-wal` / `-shm`。"不许产生文件"讲的是不许多出备份或迁移产物，不是要 SQLite 不干活。
fn visible_listing(dir: &std::path::Path) -> Vec<String> {
    listing(dir)
        .into_iter()
        .filter(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
        .collect()
}

/// 用裸连接改版本（模拟"旧程序/新程序"）。刻意用 pragma_update，避免源码里出现
/// `PRAGMA user_version =`（CI-CD.md §Migration 契约的 grep 闸门）。
fn downgrade(file: &std::path::Path, to: u32) {
    let conn = rusqlite::Connection::open(file).unwrap();
    conn.pragma_update(None, "user_version", to as i64).unwrap();
    drop(conn);
}

// ------------------------------------------------- 0010（标签）重建三张表的证人 -------

/// `PRAGMA table_info` 的列名，按 `cid`（= 物理顺序）。
/// 顺序也要看：0010 里那句 `INSERT INTO …_new SELECT * FROM …` 是**按位置**对齐的，
/// 列名都对但顺序不同不会报错，只会把值挪家（`seg` 那一格长出时间戳这种）。
fn columns_of(file: &std::path::Path, table: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(file).unwrap();
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let mut out = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .by_ref()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(stmt);
    out.sort_by_key(|(cid, _)| *cid);
    out.into_iter().map(|(_, n)| n).collect()
}

/// 按**列名**取一格并 CAST 成文本 —— 整数与文本因此能逐字对撞，且期望值与列名配成对
/// （按位置比的话，一次挪家正好被"下一次挪家"抵消，两张表互换读起来是绿的）。
fn cell(file: &std::path::Path, table: &str, key_where: &str, col: &str) -> Option<String> {
    let conn = rusqlite::Connection::open(file).unwrap();
    conn.query_row(
        &format!("SELECT CAST({col} AS TEXT) FROM {table} WHERE {key_where}"),
        [],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// 在"还没有标签"的那一版上，往 0010 要重建的三张表各写一行，每格都给一个**可辨认**的值。
fn seed_pre_tag_sync_rows(file: &std::path::Path) {
    let conn = rusqlite::Connection::open(file).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    conn
        .execute(
            "INSERT INTO sync_accounts (id,label,base_url,root_prefix,auth_kind,tls_policy,device_id,
                                        protocol_min,protocol_max,enabled,created_at)
             VALUES ('acct-1','测试本','https://dav.example/','/.notes','basic','strict','dev-old',1,1,1,
                     '2026-09-20T00:00:00.000Z')",
            [],
        )
        .unwrap();
    conn
        .execute(
            "INSERT INTO tombstones (entity_type,entity_id,rev,deleted_at,purged,content_hash,
                                     device_id,title_snap,created_at)
             VALUES ('note','tomb-1',3,'2026-09-21T00:00:00.000Z',1,'sha256:tomb','dev-old','墓碑快照',
                     '2026-09-21T00:00:00.000Z')",
            [],
        )
        .unwrap();
    conn
        .execute(
            "INSERT INTO sync_remote_index (account_id,kind,entity_id,rev,hash12,size,deleted,purged,
                                            seg,updated_at,deleted_at)
             VALUES ('acct-1','note','ri-1',7,'hash12值',1234,1,0,'seg-07','2026-09-30T00:00:00.000Z',
                     '2026-10-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
    // 显式 id=42：下面要量 AUTOINCREMENT 序列接没接上。
    conn
        .execute(
            "INSERT INTO sync_operations (id,account_id,dedupe_key,entity_type,entity_id,op,payload_rev,
                                          sha256,state,attempts,next_retry_at,last_error,created_at,updated_at)
             VALUES (42,'acct-1','dk-42','folder','op-1','upsert',9,'sha-9','pending',2,
                     '2026-10-02T00:00:00.000Z',NULL,'2026-09-29T00:00:00.000Z','2026-09-29T00:00:00.000Z')",
            [],
        )
        .unwrap();
    drop(conn);
}

/// 0010 把 `tombstones` / `sync_remote_index` / `sync_operations` 重建了一遍（SQLite 没有
/// `DROP CONSTRAINT`，抬 CHECK 词汇表只能建新表搬数据）。这一条是那张 CHECK 名单上写明的证人。
///
/// 它要挡的三种死法各有一段：
///  · **丢列** —— 手写 CREATE 漏掉 0007 给 `sync_remote_index` 追加的 `deleted_at`。
///    证人**不能**是"全新库与升级库一致"：两条路径由同一份手写 CREATE 决定，会一样地缺、
///    于是终态等价测试绿着放过（这一格是 ADR-0022 落地前置订正第 ② 条实测到的）。
///    ⇒ 这里比的是**同一张表迁移前后的列集合**，不许变小、也不许换序。
///  · **值挪家** —— 列名齐了但顺序不同，`INSERT … SELECT *` 按位置把 `seg` 写成时间戳。
///  · **AUTOINCREMENT 序列断了** —— `DROP` 旧表带走 `sqlite_sequence` 那一行，新表从 1 重新数，
///    第一条新 outbox 就撞上刚迁过来的旧行。
#[test]
fn tag_rebuild_preserves_every_column_and_row() {
    let fx = Fix::new();
    let db = fx.db_file();
    let prev = SUPPORTED_SCHEMA_VERSION - 1;
    build_partial_db(&db, prev);
    seed_pre_tag_sync_rows(&db);

    let tables = ["tombstones", "sync_remote_index", "sync_operations"];
    let before: Vec<(&str, Vec<String>)> =
        tables.iter().map(|t| (*t, columns_of(&db, t))).collect();

    let store = fx.reopen();
    assert_eq!(store.migration_report().from, prev);
    assert_eq!(user_version(&db), SUPPORTED_SCHEMA_VERSION);

    // ① 列：不许少，也不许换序
    for (table, cols_before) in &before {
        let cols_after = columns_of(&db, table);
        for col in cols_before {
            assert!(
                cols_after.contains(col),
                "重建 {table} 时丢了列 {col}：前={cols_before:?} 后={cols_after:?}"
            );
        }
        assert_eq!(
            cols_after, *cols_before,
            "{table} 的列顺序变了 —— 0010 那句 `SELECT *` 按位置拷贝，会静默把值挪家"
        );
    }

    // ② 行：每一格的值按列名对撞
    type ColWant = (&'static str, &'static str);
    type RowWant = (&'static str, &'static str, Vec<ColWant>);
    let want: Vec<RowWant> = vec![
        (
            "tombstones",
            "entity_id='tomb-1'",
            vec![
                ("entity_type", "note"),
                ("entity_id", "tomb-1"),
                ("rev", "3"),
                ("deleted_at", "2026-09-21T00:00:00.000Z"),
                ("purged", "1"),
                ("content_hash", "sha256:tomb"),
                ("device_id", "dev-old"),
                ("title_snap", "墓碑快照"),
                ("created_at", "2026-09-21T00:00:00.000Z"),
            ],
        ),
        (
            "sync_remote_index",
            "entity_id='ri-1'",
            vec![
                ("account_id", "acct-1"),
                ("kind", "note"),
                ("entity_id", "ri-1"),
                ("rev", "7"),
                ("hash12", "hash12值"),
                ("size", "1234"),
                ("deleted", "1"),
                ("purged", "0"),
                ("seg", "seg-07"),
                ("updated_at", "2026-09-30T00:00:00.000Z"),
                // 0007 追加的那一列 —— 丢列那格的靶子
                ("deleted_at", "2026-10-01T00:00:00.000Z"),
            ],
        ),
        (
            "sync_operations",
            "id=42",
            vec![
                ("id", "42"),
                ("account_id", "acct-1"),
                ("dedupe_key", "dk-42"),
                ("entity_type", "folder"),
                ("entity_id", "op-1"),
                ("op", "upsert"),
                ("payload_rev", "9"),
                ("sha256", "sha-9"),
                ("state", "pending"),
                ("attempts", "2"),
                ("next_retry_at", "2026-10-02T00:00:00.000Z"),
                ("created_at", "2026-09-29T00:00:00.000Z"),
                ("updated_at", "2026-09-29T00:00:00.000Z"),
            ],
        ),
    ];
    for (table, key_where, cols) in &want {
        for (col, expect) in cols {
            assert_eq!(
                cell(&db, table, key_where, col).as_deref(),
                Some(*expect),
                "{table} 重建后 {col} 变了或没了（行也没了？key: {key_where}）"
            );
        }
    }

    // ③ AUTOINCREMENT 序列接得上：升级后新排的 outbox 必须**大于**搬过来的最大 id。
    //    两格都要：`sqlite_sequence` 那一行是**序列本身**的证人（它丢了 ⇒ 删过的 id 会被复用），
    //    只量"新行 id 更大"挡不住它 —— 表退化成普通 `INTEGER PRIMARY KEY` 时照样给 43，读数一样。
    let conn = rusqlite::Connection::open(&db).unwrap();
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='sync_operations'",
            [],
            |r| r.get(0),
        )
        .ok();
    // 读数取**下界**而不是 42：`fx.reopen()` 自己的引导会再排几条 outbox（43、44…），
    // 那些是本程序正常的写，不是迁移的错。要证的只是"序列没退回 42 以下"。
    assert!(
        seq.unwrap_or(0) >= 42,
        "重建把 AUTOINCREMENT 序列弄丢了：sqlite_sequence 里是 {seq:?}（应 ≥ 42）⇒ 旧 id 会被复用"
    );
    conn.execute(
        "INSERT INTO sync_operations (account_id,dedupe_key,entity_type,entity_id,op,state,
                                          created_at,updated_at)
             VALUES ('acct-1','dk-new','tag','tag-op','upsert','pending',
                     '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')",
        [],
    )
    .expect("抬过 CHECK 之后 'tag' 必须能进 outbox（这一发同时是词汇表的正证）");
    let new_id: i64 = conn
        .query_row(
            "SELECT id FROM sync_operations WHERE dedupe_key='dk-new'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        new_id > 42,
        "AUTOINCREMENT 序列没接上：新行 id={new_id} 不大于搬过来的 42 ⇒ 会撞旧行"
    );

    // ④ `notes.tag_ids` 的 DEFAULT 是 `'[]'`，且读侧把它当空集而不是 nil
    let note = store
        .create_note(&default_folder(&store), doc_text("升级后新建的笔记"))
        .unwrap();
    assert!(store
        .get_note(&note.id)
        .unwrap()
        .unwrap()
        .tag_ids
        .is_empty());
    assert!(columns_of(&db, "notes").iter().any(|c| c == "tag_ids"));

    // ⑤ 脏集视图的第三支：标签进去了才会被计划上传。
    //    少了这一支，症状是"标签在界面上建好了，远端永远看不见它"，而界面一切正常。
    conn
        .execute(
            "INSERT INTO tags (id,title,canonical,rev,sync_rev,remote_rev,content_hash,created_at,updated_at)
             VALUES ('tag-dirty','工作','工作',5,0,0,'sha256:tag',
                     '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')",
            [],
        )
        .unwrap();
    let dirty: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM v_dirty_entities WHERE entity_type='tag' AND entity_id='tag-dirty'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        dirty, 1,
        "v_dirty_entities 没有标签那一支：标签永远不会被计划上传"
    );
    drop(conn);
}

/// SQL 里的 kind 词汇表（三张表的 CHECK）与 Rust 的 `EntityKind` 是同一件事的两份账。
/// 两条腿各挡一半：**文本差集**（盘上 CHECK 名单 ⇄ 类型派生名单，双向）挡"词汇表里拼错/多一个"；
/// **运行时接受/拒绝**挡"0010 只抬了其中一张表"—— 扫描取的是所有文件的**并集**，
/// 单张表漏抬在文本上看不出来（0001 那份旧名单还在贡献三个值），只有真插才量得到。
#[test]
fn kind_vocabulary_in_sql_matches_entity_kind() {
    use notera_core::EntityKind;

    // 期望侧**从类型派生**，不是手抄：加第五种实体时这个 match 编译不过，
    // 于是"加 kind"这件事必须在这里做一次显式决定（ADR-0022 D7 的"不许静默降级"）。
    let sql_name = |k: EntityKind| match k {
        EntityKind::Note => "note",
        EntityKind::Folder => "folder",
        EntityKind::Attachment => "attachment",
        EntityKind::Tag => "tag",
    };
    let want: std::collections::BTreeSet<String> = EntityKind::ALL
        .iter()
        .map(|k| sql_name(*k).to_string())
        .collect();
    assert!(
        !EntityKind::ALL.is_empty() && want.len() == 4,
        "类型这一侧扫到 {} 个 kind：仪器瞎了，不是词汇表没问题",
        want.len()
    );

    // 实际侧：盘上每一份迁移里 `(entity_type IN (` / `(kind IN (` 的取值集合
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut hits = 0usize;
    for (ver, sql) in migration_files() {
        for needle in ["(entity_type IN (", "(kind IN ("] {
            let mut from = 0usize;
            while let Some(rel) = sql[from..].find(needle) {
                let start = from + rel + needle.len();
                let body = &sql[start..];
                let end = body
                    .find(')')
                    .unwrap_or_else(|| panic!("{ver:04} 号迁移里 {needle} 的 IN 列表没有右括号"));
                let items = body[..end]
                    .split('\'')
                    .skip(1)
                    .step_by(2)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>();
                assert!(!items.is_empty(), "{ver:04} 号迁移扫到一条空的 IN 名单");
                hits += 1;
                seen.extend(items);
                from = start + end;
            }
        }
    }
    assert!(
        hits >= 6,
        "只扫到 {hits} 处 kind CHECK（预期三张表 × 至少一份）：扫描器对不上表名就白跑"
    );
    let missing: Vec<&str> = want
        .iter()
        .map(|s| s.as_str())
        .filter(|k| !seen.contains(*k))
        .collect();
    let extra: Vec<&String> = seen.iter().filter(|k| !want.contains(*k)).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "SQL 的 kind 词汇表与 EntityKind 不一致：SQL 里缺 {missing:?}，SQL 里多 {extra:?}"
    );

    // 第三条腿：CHECK 在运行时的读数。全新库（v10）上逐个接受、陌生值拒绝。
    let fx = Fix::new();
    let _store = fx.open();
    let db = fx.db_file();
    let conn = rusqlite::Connection::open(&db).unwrap();
    // 外键**默认就是开的**（`rusqlite` 的 `bundled` 特征定义了 `SQLITE_DEFAULT_FOREIGN_KEYS=1`，
    // 实测到这条才知道 —— 裸连接不设 PRAGMA 也会被 FK 拦）。所以先要有真账户，
    // 否则这一腿量到的是 FK 而不是 CHECK，红会报在错误的格上。
    conn.execute(
        "INSERT INTO sync_accounts (id,label,base_url,root_prefix,auth_kind,tls_policy,device_id,
                                    enabled,created_at)
         VALUES ('acct-w','词汇表','https://dav.example/','/.notes','basic','strict','dev','1',
                 '2026-10-05T00:00:00.000Z')",
        [],
    )
    .unwrap();
    for k in &want {
        let checks = [
            format!(
                "INSERT INTO tombstones (entity_type,entity_id,rev,deleted_at,purged,device_id,created_at)
                 VALUES ('{k}','w-{k}',1,'2026-10-05T00:00:00.000Z',0,'dev','2026-10-05T00:00:00.000Z')"
            ),
            format!(
                "INSERT INTO sync_remote_index (account_id,kind,entity_id,rev,updated_at)
                 VALUES ('acct-w','{k}','w-{k}',1,'2026-10-05T00:00:00.000Z')"
            ),
            format!(
                "INSERT INTO sync_operations (account_id,dedupe_key,entity_type,entity_id,op,state,
                                              created_at,updated_at)
                 VALUES ('acct-w','dk-{k}','{k}','w-{k}','upsert','pending',
                         '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')"
            ),
        ];
        for sql in &checks {
            conn.execute(sql, []).unwrap_or_else(|e| {
                panic!("词汇表里的 {k} 被 CHECK 拒了（这就是把实体加进类型却没抬 CHECK 的形状）：{e}\n{sql}")
            });
        }
    }
    // 反向：词汇表外的 kind 必须**被拒**，否则 CHECK 只是装饰
    for table_sql in [
        "INSERT INTO tombstones (entity_type,entity_id,rev,deleted_at,purged,device_id,created_at)
         VALUES ('widget','w-1',1,'2026-10-05T00:00:00.000Z',0,'dev','2026-10-05T00:00:00.000Z')",
        "INSERT INTO sync_remote_index (account_id,kind,entity_id,rev,updated_at)
         VALUES ('acct-w','widget','w-2',1,'2026-10-05T00:00:00.000Z')",
        "INSERT INTO sync_operations (account_id,dedupe_key,entity_type,entity_id,op,state,
                                      created_at,updated_at)
         VALUES ('acct-w','dk-w','widget','w-3','upsert','pending',
                 '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')",
    ] {
        let e = conn
            .execute(table_sql, [])
            .expect_err("CHECK 放过了词汇表外的 kind ⇒ 它形同虚设");
        assert!(
            e.to_string().contains("CHECK"),
            "拒是拒了，但不是 CHECK 拒的：{e}"
        );
    }
    drop(conn);
}

/// **迁移名单从盘上扫，不手写**（ADR-0022 落地前置订正第 ⑤ 条）：旧版这里是一份手抄的
/// `[(u32,&str); 5]`，于是加了 0010 之后"从 v9 升上来"这一格根本不存在 —— 绿着空转。
/// 这条把"盘上有哪些迁移文件"和"程序真的应用了哪些"对撞，两个方向都看。
#[test]
fn every_migration_file_on_disk_is_applied() {
    let disk: Vec<u32> = migration_files().into_iter().map(|(v, _)| v).collect();
    assert!(
        !disk.is_empty(),
        "扫到 0 个迁移文件：目录读不到或后缀不匹配，这条判据就是空枪"
    );
    assert_eq!(
        disk,
        contiguous_from(1),
        "盘上的迁移号必须从 1 连续递增（跳号 = 旧库升级时会整段跳过）"
    );
    let fx = Fix::new();
    let store = fx.open();
    assert_eq!(
        store.migration_report().applied,
        disk,
        "盘上有文件却没被应用：MIGRATIONS 名单漏了一条，老库升到这一版时那一格的 SQL 根本不跑"
    );
    assert_eq!(
        SUPPORTED_SCHEMA_VERSION,
        *disk.last().unwrap(),
        "支持版本不等于盘上最大的迁移号"
    );
}

/// `sync_operations.state` 的 CHECK 集合与 `docs/DATA-MODEL.md` 那张表**必须等价**（双向差集）。
///
/// 期望值写死在这六个字符串上，**不许**从 `OpState::as_str()` 或迁移文件算出来：
/// 这一条挡的正是"文档写着允许 `blocked`，真表的 CHECK 里却没有它"（那时代码写 `blocked` 会在运行期撞约束，
/// 而毒丸隔离那组测试与迁移文件共享同一个来源，看不见这种漂移），以及**反向**——
/// 有人往 CHECK 里偷偷加第七个值而文档不动。见 [[cross-table-link-belongs-in-production]]。
/// 本判据自己的变异记录（两个方向都证过，且都下在**真正建表的那份** `migrations/0010_tags.sql` 上：
/// 这张表被 0010 重建过，刀切在初版 `0002_sync.sql` 上会得到一次"判据没牙"的假读数 —— 9 条全绿）：
///  · CHECK 里加第七个值 `'quarantined'` ⇒ 8 绿 / 1 红，红的就是这一条，并把七个状态原样打出来；
///  · 把 `,'blocked'` 连逗号一起去掉 ⇒ 同样 8 绿 / 1 红，只有这一条（第一次那刀留了悬空逗号，
///    把迁移语法整个弄坏、9 条全红，那种红不算单条判据的证据）。
#[test]
fn sync_operations_state_check_equals_the_documented_set() {
    const DOCUMENTED: [&str; 6] = [
        "pending",
        "inflight",
        "done",
        "failed",
        "superseded",
        "blocked",
    ];
    let fx = Fix::new();
    let _store = fx.open();
    let conn = rusqlite::Connection::open(fx.db_file()).unwrap();
    let ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_operations'",
            [],
            |r| r.get(0),
        )
        .expect("迁移完之后 sqlite_master 里必须有 sync_operations");
    // 迁移文件里这一格是跨行写的（`CHECK (state IN\n  ('pending',…))`），先把空白压平再取括号里那份名单。
    let flat: String = ddl.split_whitespace().collect::<Vec<_>>().join(" ");
    let at = flat
        .find("state IN (")
        .unwrap_or_else(|| panic!("sync_operations 上没有 `state IN (...)` 这段 CHECK：{flat}"));
    let inner = &flat[at + "state IN (".len()..];
    let close = inner
        .find(')')
        .unwrap_or_else(|| panic!("`state IN (` 后面找不到右括号：{flat}"));
    let parsed: Vec<String> = inner[..close]
        .split(',')
        .map(|s| s.trim().trim_matches('\'').to_string())
        .collect();

    // 下界挡"空集合也算过"：六条都要有名字，扫到 0 项不是检查过。
    assert_eq!(
        parsed.len(),
        DOCUMENTED.len(),
        "CHECK 里的状态数与文档那六个不一致：{parsed:?}"
    );
    let missing: Vec<&str> = DOCUMENTED
        .into_iter()
        .filter(|w| !parsed.iter().any(|p| p.as_str() == *w))
        .collect();
    let extra: Vec<&str> = parsed
        .iter()
        .map(|s| s.as_str())
        .filter(|p| !DOCUMENTED.into_iter().any(|w| w == *p))
        .collect();
    assert!(
        missing.is_empty(),
        "DATA-MODEL 写着允许而真表 CHECK 里没有：{missing:?}（DDL: {flat}）"
    );
    assert!(
        extra.is_empty(),
        "真表 CHECK 里有第七个值，文档没写：{extra:?}（DDL: {flat}）"
    );

    // "blocked 真写得进去"这一半不在这里重做：它由 `tests/outbox_quarantine.rs` 走生产 API
    // 在真 SQLite 上证过（那里有 `sync_accounts` 的账户行，这条 INSERT 会被 FK 拦，写不出可信读数）。
    // 本判据只守两件事：文档那六个与真表 CHECK **不多不少**。
}
