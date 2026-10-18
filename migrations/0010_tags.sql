-- 0010_tags.sql — ADR-0022：标签成为第四种可同步实体。
--
-- 这一份做三件事，第三件最危险，先说清楚：
--  ① 建 `tags`（可同步实体，`kind='tag'`，目录 `records/tag/`）；
--  ② 把笔记↔标签的链接放进**笔记记录自己**（`ALTER TABLE notes ADD COLUMN tag_ids`），
--     不建 `note_tags` 表 —— 理由在 ② 那一段，一句话版本是"带外键的投影表会把
--     '链接比标签先到'那格竞态原样请回来，而它长在 `apply_remote` 的写事务里"；
--  ③ 把三张被 `CHECK (… IN ('note','folder','attachment'))` 锁住 kind 词汇表的表**重建**一遍，
--     因为 SQLite 没有 `DROP CONSTRAINT`。
--
-- ③ 的三个坑，每一个都必须有证人（测试 `tag_migration_preserves_every_column_and_row`）：
--  · **丢列**：`sync_remote_index` 在 0007 被 `ALTER TABLE ADD COLUMN deleted_at` 加过一列。
--    手写 CREATE 时漏掉它，全新库与升级库会**长成一样地缺那一列** ⇒ 终态等价测试照样绿，列却没了。
--    ⇒ 证人不能是"两条路径一致"，必须是"迁移前后同一张表的列集合不许变小"（见那条测试）。
--  · **AUTOINCREMENT 序列**：`sync_operations.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`。
--    带显式 id 拷贝时 SQLite 会把 `sqlite_sequence` 顶到 `MAX(id)`，`DROP` 老表删掉它那一行、
--    `RENAME` 再把新表那一行改名回去 —— 序列因此接得上。这条也要量：升级后再插一条 outbox，
--    它的 id 必须**大于**原表里最大的那个，否则就是"新行撞上刚迁过来的旧行"。
--  · **事务与外键**：这三张表都不是任何表的 `REFERENCES` 目标（仓内 grep 过），
--    所以不存在 `ALTER TABLE RENAME` 顺带改写别人 FK 定义的问题；
--    而执行器把每条迁移包在**一个事务**里（`crates/notera-store/src/migrate.rs`），
--    `PRAGMA foreign_keys` 在事务里是空操作 ⇒ 这里不许依赖它，也不写它。
--
-- 最后一件：词汇表现在有两份（Rust 的 `EntityKind::ALL` 与这里的 CHECK）。
-- 这份重复由一条**双向差集**门钉住（`crates/notera-store/tests/migrations_and_pragmas.rs` 里那条
-- `kind_vocabulary_in_sql_matches_entity_kind`），不是靠人记得 —— 与 #118 那三条豁免名单同一个做法。

PRAGMA defer_foreign_keys = ON;

-- ① 标签实体 ------------------------------------------------------------------
-- `title` 是用户看见并原样保留的那一份；`canonical` 是**唯一**的相等键，由核心算
-- （`notera_core::canonical::canonical_tag_name`：trim → NFKC → 全 Unicode 小写 → NFKC），
-- 界面与存储层都不许再算第二遍 —— 这条有静态判据（ADR-0022 D3 验证第 6 条）。
-- 列名跟着 `notes` 的既有形状（`deleted_at` 而不是 ADR 草稿里写的 `deleted_time`）：
-- 一个库里有两种"软删除"列名，迟早有人在 JOIN 上猜错。
CREATE TABLE tags (
  id              TEXT NOT NULL PRIMARY KEY,               -- UUIDv7（各设备各生成，不靠标题推导：D2）
  title           TEXT NOT NULL,
  canonical       TEXT NOT NULL,                            -- 相等键；空串被拒（拒空标题在写入侧判）
  -- 折叠时"先把输的那颗标成别名、再插入赢的那一行"是**同一个事务里的两条语句**，
  -- 而那一刻 winner 还不存在 ⇒ 普通外键会在 UPDATE 那一发就 FOREIGN KEY constraint failed，
  -- 症状是"对面那颗标签永远同步不进来"（两台真设备实测到的正是这一格 ——
  -- 引擎那边只留下一句 `rejections=1 / FOREIGN KEY constraint failed`）。
  -- ⇒ 这条外键必须是**可延迟的**：完整性照查，但查在事务结束时。
  -- `PRAGMA foreign_keys` 默认开（rusqlite 的 bundled 特征定义了 SQLITE_DEFAULT_FOREIGN_KEYS=1）。
  alias_of        TEXT REFERENCES tags(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  rev             INTEGER NOT NULL DEFAULT 0,
  sync_rev        INTEGER NOT NULL DEFAULT 0,
  sync_hash       TEXT,                                     -- 确认点上的哈希：`mark_synced` 按表名统一写这一列，
                                                            -- 少它就是一次运行时 no such column（不是"少个诊断字段"）
  remote_rev      INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_device  TEXT NOT NULL DEFAULT '',
  updated_device  TEXT NOT NULL DEFAULT '',
  deleted_at      TEXT,                                     -- D5 软删除（回收站不参与：这一族只给笔记）
  CHECK (length(trim(canonical)) > 0)
);

-- "同一时刻只许有一颗**活着的、不是别名**的同名标签"（按 canonical 谈）。
-- 部分唯一索引而不是表级 UNIQUE，两个条件各挡一种错：
--  · `deleted_at IS NULL`：删掉之后同名要能再建；
--  · `alias_of IS NULL`：**折叠之后的那颗输家必须还能留在表里**（D4 的 alias 改写要靠它解析旧 id）。
--    原来这里只写了第一个条件 —— 那是自相矛盾的：`create_tag` 允许同名折叠出别名行，
--    而索引会拒绝插入那一行，症状是"两台设备各建一颗同名标签之后，其中一台同步不进去"（写 apply 时发现）。
CREATE UNIQUE INDEX tags_canonical_live ON tags(canonical) WHERE deleted_at IS NULL AND alias_of IS NULL;
CREATE INDEX tags_dirty ON tags((rev <> sync_rev));
CREATE INDEX tags_alias ON tags(alias_of) WHERE alias_of IS NOT NULL;
CREATE INDEX tags_updated ON tags(updated_at DESC);

-- ② 笔记↔标签的链接：**就存在笔记行自己身上**（一个 JSON 数组列），不建 `note_tags` 表。
--
-- 这一条是写 CRUD 时改的图纸（原方案抄的是 `note_attachments` 那张投影表 + `REFERENCES tags(id)`）：
-- 带外键的投影表会把 Joplin 的那格竞态**原样请回来** —— 笔记记录与标签记录是**两条独立记录、
-- 分两轮到达**（清单两段式 + 每轮 200 条变更窗口），所以"链接先到、标签那行还没下载"是常态：
-- `INSERT INTO note_tags … REFERENCES tags(id)` 在那一刻必然失败，而它在 `apply_remote` 的写事务里 ⇒
-- **整批 apply 回滚**，症状是"对面有一篇带新标签的笔记，本机永远同步不下来"。
-- ADR-0022 D1 承诺的正是"没有链接比项先到的竞态、删除不需要级联"，那一格**只有把链接放进属主记录**才成立。
--
-- 于是：`tag_ids` 与 `folder_id`/`pinned`/`color` 同族 —— 顶层同步键，**不进 content_hash**
-- （`note_wire` 那段注释写死了这个性质），rev 会推进所以照旧传播。
-- 读侧统一走 `live_tag_ids`（按 `tags.deleted_at IS NULL` 过滤）⇒ 删掉的标签自动从界面消失，
-- **不需要 D5 的"宽限期剪链接"那一整段机制**（那是投影表才有的问题）。
ALTER TABLE notes ADD COLUMN tag_ids TEXT NOT NULL DEFAULT '[]';

-- ③ 重建三张 CHECK 锁住的表 ----------------------------------------------------
-- 每一张都是：建新表（列 = 现在的有效形状）→ 整表拷贝 → 删旧表 → 改名 → 重建它自己的索引。
-- `PRAGMA defer_foreign_keys` 在事务结束时会被自动关掉，不用手写 off。

-- tombstones：列集合 = 0001:125 原样（0002~0009 没有 ALTER 过它）。
CREATE TABLE tombstones_new (
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('note','folder','attachment','tag')),
  entity_id     TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  deleted_at    TEXT NOT NULL,
  purged        INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT,
  device_id     TEXT NOT NULL,
  title_snap    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) WITHOUT ROWID;
INSERT INTO tombstones_new SELECT * FROM tombstones;
DROP TABLE tombstones;
ALTER TABLE tombstones_new RENAME TO tombstones;
CREATE INDEX idx_tombstones_purged ON tombstones(entity_type, purged, rev);

-- sync_remote_index：**必须带上 0007 加的 `deleted_at`**。它在 0007 是被 `ALTER … ADD COLUMN`
-- **追加到末尾**的（在 `updated_at` 之后），这里必须排在同一位：
-- 下面那句 `INSERT INTO …_new SELECT * FROM …` 是**按位置**对齐的，列名对了但顺序错了
-- 不会报错，只会把值挪家（`seg` 里长出时间戳这种）。证人见 `tag_rebuild_preserves_every_column_and_row`。
CREATE TABLE sync_remote_index_new (
  account_id  TEXT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('note','folder','attachment','tag')),
  entity_id   TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  hash12      TEXT,
  size        INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  purged      INTEGER NOT NULL DEFAULT 0,
  seg         TEXT,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  PRIMARY KEY (account_id, kind, entity_id)
) WITHOUT ROWID;
INSERT INTO sync_remote_index_new SELECT * FROM sync_remote_index;
DROP TABLE sync_remote_index;
ALTER TABLE sync_remote_index_new RENAME TO sync_remote_index;
CREATE INDEX idx_remote_index_kind ON sync_remote_index(account_id, kind, rev);

-- sync_operations（outbox）：0002:56 原样，没有后来的 ALTER。
CREATE TABLE sync_operations_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  dedupe_key    TEXT NOT NULL UNIQUE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('note','folder','attachment','tag')),
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('upsert','delete','purge','upload','download')),
  payload_rev   INTEGER,
  sha256        TEXT,
  state         TEXT NOT NULL CHECK (state IN
                  ('pending','inflight','done','failed','superseded','blocked')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO sync_operations_new SELECT * FROM sync_operations;
DROP TABLE sync_operations;
ALTER TABLE sync_operations_new RENAME TO sync_operations;
CREATE INDEX idx_outbox_take ON sync_operations(state, next_retry_at, id);
CREATE INDEX idx_outbox_entity ON sync_operations(account_id, entity_type, entity_id, state);

-- v_dirty_entities：脏集视图以前只有 note/folder 两支 UNION，标签进来必须加第三支，
-- 否则**标签永远不会被计划上传** —— 而这件事在界面上长得和"同步好了"一模一样。
-- 列集合照 0005_views.sql 原样（`entity_type, entity_id, rev, sync_rev, remote_rev,
-- content_hash, deleted_at, purged_at`）；`tags` 没有 `purged_at` 这一列（标签不参与回收站），
-- 那一格给 `NULL` —— 视图的列名取自第一支 SELECT，所以别名不许动。
-- ⚠ 顺带量到的一条**死抽象**（本批登记、不顺手删）：`grep -rn v_dirty_entities crates/ --include=*.rs`
--   命中 **0 处** —— 这个视图今天没有任何 Rust 消费者，`0005` 那句"诊断/verify 用"是主张不是事实。
--   留着的代价是"改 kind 词汇表时要多改一处"，删掉的代价是"没人知道它是不是被哪个诊断脚本吃着"
--   ⇒ 按 ADR-0022 的规矩登记成欠账，处置要单独一批。
DROP VIEW v_dirty_entities;
CREATE VIEW v_dirty_entities AS
SELECT 'note' AS entity_type, id AS entity_id, rev, sync_rev, remote_rev, content_hash,
       deleted_at, purged_at
FROM notes WHERE rev <> sync_rev
UNION ALL
SELECT 'folder', id, rev, sync_rev, remote_rev, content_hash, deleted_at, purged_at
FROM folders WHERE rev <> sync_rev
UNION ALL
SELECT 'tag', id, rev, sync_rev, remote_rev, content_hash, deleted_at, NULL
FROM tags WHERE rev <> sync_rev;
