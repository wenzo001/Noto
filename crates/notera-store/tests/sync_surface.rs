//! 同步协作面：脏集 / outbox / 确认点 / apply_remote 原子性 / 冲突收件箱 / 附件。
mod common;

use common::*;
use notera_core::{EntityId, EntityKind, Rev};
use notera_store::{
    ApplyOp, ConflictRecord, DirtyWhy, NoteQuery, OpKind, OpState, RemoteIndexEntry, SearchQuery,
    StoreError,
};

#[test]
fn dirty_entities_is_exactly_rev_ne_sync_rev() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let acct = notera_store::LOCAL_ACCOUNT_ID;

    // 默认本自身是新实体 → 恰好一条脏（rev 1 != sync_rev 0）
    let d = store.dirty_entities(acct).unwrap();
    assert_eq!(d.len(), 1, "初始只有默认本待上传：{d:?}");
    store
        .mark_synced(
            EntityKind::Folder,
            &folder,
            store.get_folder(&folder).unwrap().unwrap().rev,
            "sha256:x",
        )
        .unwrap();
    assert!(
        store.dirty_entities(acct).unwrap().is_empty(),
        "全部确认后脏集必须为空"
    );

    let n = create(&store, &folder, "刚建");
    let d = store.dirty_entities(acct).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].id, n.id);
    assert_eq!(d[0].why, DirtyWhy::NeverPushed, "sync_rev=0 → 从未推送");
    assert_eq!(d[0].rev, n.rev);

    store
        .mark_synced(EntityKind::Note, &n.id, n.rev, &n.content_hash)
        .unwrap();
    assert!(
        store.dirty_entities(acct).unwrap().is_empty(),
        "push 确认后必须干净"
    );

    let edited = store.edit_note(&n.id, doc_text("改过"), n.rev).unwrap();
    let d = store.dirty_entities(acct).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].why, DirtyWhy::Edited);
    assert_eq!(d[0].sync_rev, Rev(1));

    store.delete_note(&n.id).unwrap();
    let d = store.dirty_entities(acct).unwrap();
    assert_eq!(d[0].why, DirtyWhy::Deleted, "软删在脏集里必须标 Deleted");
    store.restore_note(&n.id).unwrap();
    assert_eq!(store.dirty_entities(acct).unwrap()[0].why, DirtyWhy::Edited);

    // 反向保证：rev == sync_rev 时绝不出现
    let cur = store.get_note(&n.id).unwrap().unwrap();
    store
        .mark_synced(EntityKind::Note, &n.id, cur.rev, &cur.content_hash)
        .unwrap();
    assert!(store.dirty_entities(acct).unwrap().is_empty());
    assert_eq!(
        store.get_note(&n.id).unwrap().unwrap().sync_hash.as_deref(),
        Some(cur.content_hash.as_str())
    );
    // 未知账户：实体脏集仍然可判（purg 确认信息按账户记账）
    assert!(store
        .dirty_entities("没有这个账户")
        .unwrap()
        .iter()
        .all(|e| e.why != DirtyWhy::Purged));
    let _ = edited;
}

#[test]
fn every_write_enqueues_one_outbox_row_per_enabled_account_and_supersedes_old_rev() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let acct = notera_store::LOCAL_ACCOUNT_ID;
    let n = create(&store, &folder, "第一版");

    // outbox 是"写入那一刻的队列"，不是历史重放：注册第二台服务器不倒灌旧待办。
    store
        .register_account("acct-b", "内网", "https://dav.internal/notes")
        .unwrap();
    assert_eq!(
        store.outbox_len("acct-b", &[OpState::Pending]).unwrap(),
        0,
        "注册不得凭空造出旧待办"
    );

    // 新建一条笔记在 local 名下产生 **2** 行：默认本（开库时入队）+ 笔记。
    // 默认本必须被公告，否则另一台设备会自己再造一个默认本，笔记就分家了。
    assert_eq!(
        store.outbox_len(acct, &[OpState::Pending]).unwrap() as usize,
        2,
        "本地账户：默认本 + 笔记各一行"
    );

    // ---- 扇出：注册之后的一次本地写必须给**每个**账户各一行 ----
    // `dedupe_key` 若不含 account_id，第二个账户的 INSERT 会被 `ON CONFLICT DO UPDATE`
    // 吸收成第一账户的行 —— 表现为"本地编辑只同步到其中一台服务器"，且完全静默。
    let v1 = store.get_note(&n.id).unwrap().unwrap();
    let v2 = store.edit_note(&n.id, doc_text("第二版"), v1.rev).unwrap();
    let mut note_keys: Vec<String> = Vec::new();
    // local 还带着开库时入队的默认本那一行，所以取到 2 行；acct-b 只有笔记这 1 行。
    for (a, want) in [(acct, 2usize), ("acct-b", 1usize)] {
        let taken = store.outbox_take(a, 10).unwrap();
        assert_eq!(
            taken.len(),
            want,
            "{a} 取到的行数不对（笔记那一行塌成 0 = 静默漏同步一台服务器）：{taken:?}"
        );
        let note_row = taken
            .iter()
            .find(|t| t.kind == EntityKind::Note)
            .expect("必须有笔记那一行");
        assert_eq!(note_row.payload_rev, Some(v2.rev));
        assert_eq!(note_row.op, OpKind::Upsert);
        assert_eq!(note_row.state, OpState::Inflight);
        assert_eq!(note_row.attempts, 1);
        assert!(
            note_row.dedupe_key.starts_with(&format!("{a}:")),
            "dedupe_key 必须以账户开头：{}",
            note_row.dedupe_key
        );
        note_keys.push(note_row.dedupe_key.clone());
        for op in &taken {
            store
                .outbox_state(op.id, OpState::Done, None, None)
                .unwrap();
        }
    }
    assert_eq!(
        note_keys[0].split_once(':').map(|t| t.1),
        note_keys[1].split_once(':').map(|t| t.1),
        "去掉账户前缀后键体必须一致 —— 差异只允许出现在账户段"
    );
    assert_ne!(
        note_keys[0], note_keys[1],
        "两个账户的 dedupe_key 必须不同，否则唯一索引让它们互相吸收"
    );
    assert_eq!(
        store.outbox_take(acct, 10).unwrap().len(),
        0,
        "inflight 不得重复取"
    );
    assert_eq!(
        store.outbox_len(acct, &[OpState::Done]).unwrap(),
        2,
        "默认本 + 笔记都已确认"
    );
    assert_eq!(store.outbox_len(acct, &[OpState::Pending]).unwrap(), 0);

    // ---- 再编辑：同实体更早的 pending 被 superseded（远端只需最终态）----
    let e1 = store.edit_note(&n.id, doc_text("第三版"), v2.rev).unwrap();
    let e2 = store.edit_note(&n.id, doc_text("第四版"), e1.rev).unwrap();
    assert_eq!(
        store.outbox_len(acct, &[OpState::Pending]).unwrap(),
        1,
        "只留本笔记最新的一行"
    );
    let pend = store.outbox_take(acct, 10).unwrap();
    assert_eq!(
        pend.len(),
        1,
        "同一笔记的连续编辑只留最新一条 pending：{pend:?}"
    );
    assert_eq!(pend[0].kind, EntityKind::Note);
    assert_eq!(
        pend[0].payload_rev,
        Some(e2.rev),
        "留下的必须是最新 rev，旧的应被 supersede"
    );
    assert!(pend[0].dedupe_key.contains(&n.id.to_string()));
    assert_eq!(
        store.outbox_len(acct, &[OpState::Superseded]).unwrap(),
        2,
        "被超越的行留痕不删除：rev1（被 rev2 超越）+ rev3（被 rev4 超越）"
    );

    // 失败重试：退避未到期不得取件，到期后必须可重试
    store
        .outbox_state(
            pend[0].id,
            OpState::Failed,
            Some("offline"),
            Some("2099-01-01T00:00:00.000Z"),
        )
        .unwrap();
    assert_eq!(
        store.outbox_take(acct, 10).unwrap().len(),
        0,
        "退避未到期的 failed 不得取件"
    );
    store
        .outbox_state(
            pend[0].id,
            OpState::Failed,
            Some("offline"),
            Some("2000-01-01T00:00:00.000Z"),
        )
        .unwrap();
    assert_eq!(
        store.outbox_take(acct, 10).unwrap().len(),
        1,
        "退避到期的 failed 必须可重试"
    );

    // 禁用账户不得继续排队，否则它的 outbox 会无界增长（引擎永不消费它）
    store.set_account_enabled("acct-b", false).unwrap();
    let a_before = store
        .outbox_len(
            "acct-b",
            &[OpState::Pending, OpState::Inflight, OpState::Failed],
        )
        .unwrap();
    let _ = store
        .create_note(&folder, doc_text("禁用之后的写入"))
        .unwrap();
    assert_eq!(
        store
            .outbox_len(
                "acct-b",
                &[OpState::Pending, OpState::Inflight, OpState::Failed]
            )
            .unwrap(),
        a_before,
        "已禁用账户不应再收到 outbox 行"
    );
    // 而本地哨兵账户（enabled=0）必须继续留痕：它是"本地写入不依赖网络"的记账
    assert!(
        store.outbox_len(acct, &[OpState::Pending]).unwrap() >= 1,
        "local 哨兵账户即使 enabled=0 也必须留痕"
    );
}

#[test]
fn outbox_state_rejects_unknown_id_and_take_respects_limit() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    for i in 0..4 {
        create(&store, &folder, &format!("批量 {i}"));
    }
    let acct = notera_store::LOCAL_ACCOUNT_ID;
    let two = store.outbox_take(acct, 2).unwrap();
    assert_eq!(two.len(), 2);
    assert_eq!(store.outbox_len(acct, &[OpState::Inflight]).unwrap(), 2);
    assert!(matches!(
        store.outbox_state(999999, OpState::Done, None, None),
        Err(StoreError::Constraint(_))
    ));
}

#[test]
fn set_remote_rev_and_remote_index_replace_roundtrip() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let n = create(&store, &folder, "等着被远端超越");
    store
        .set_remote_rev(EntityKind::Note, &n.id, Rev(9), "a1b2c3d4e5f6")
        .unwrap();
    let cur = store.get_note(&n.id).unwrap().unwrap();
    assert_eq!(cur.remote_rev, Rev(9));
    assert_eq!(cur.rev, Rev(1), "观测远端不推进本地 rev");
    // 下一次本地写必须取 max（I2）
    let next = store
        .edit_note(&n.id, doc_text("本地继续写"), cur.rev)
        .unwrap();
    assert_eq!(next.rev, Rev(10));
    assert!(matches!(
        store.set_remote_rev(EntityKind::Note, &missing_id(), Rev(1), "x"),
        Err(StoreError::NotFound { .. })
    ));

    let entries = vec![
        RemoteIndexEntry {
            kind: EntityKind::Note,
            id: n.id.clone(),
            rev: Rev(10),
            hash12: Some("deadbeefcafe".into()),
            size: Some(220),
            deleted: false,
            purged: false,
            seg: Some("seg-0000".into()),
            sha256: None,
            deleted_at: None,
        },
        RemoteIndexEntry {
            kind: EntityKind::Folder,
            id: folder.clone(),
            rev: Rev(3),
            hash12: None,
            size: None,
            deleted: false,
            purged: false,
            seg: None,
            sha256: None,
            deleted_at: None,
        },
    ];
    store
        .remote_index_replace(notera_store::LOCAL_ACCOUNT_ID, &entries)
        .unwrap();
    let got = store
        .remote_index_lookup(
            notera_store::LOCAL_ACCOUNT_ID,
            EntityKind::Note,
            n.id.as_str(),
        )
        .unwrap();
    assert_eq!(
        got.map(|e| (e.rev, e.seg)),
        Some((Rev(10), Some("seg-0000".to_string())))
    );
    // 整表替换：旧条目消失
    store
        .remote_index_replace(notera_store::LOCAL_ACCOUNT_ID, &entries[1..])
        .unwrap();
    assert!(store
        .remote_index_lookup(
            notera_store::LOCAL_ACCOUNT_ID,
            EntityKind::Note,
            n.id.as_str()
        )
        .unwrap()
        .is_none());

    // 0007 之后这张表才真的能当"清单的本地缓存"用：整表读回 + 带删除时间戳。
    // 没有 `deleted_at` 之前，把远端视图持久化下去是有损的（P8/P11 那类"删除先后、
    // 删后又改"的判据要读回时间戳），所以先补列，再让引擎往里写。
    let mut with_del = entries.clone();
    if let Some(note) = with_del.iter_mut().find(|e| e.kind == EntityKind::Note) {
        note.deleted = true;
        note.deleted_at = Some("2026-09-27T00:00:00Z".into());
    }
    store
        .remote_index_replace(notera_store::LOCAL_ACCOUNT_ID, &with_del)
        .unwrap();
    let list = store
        .remote_index_list(notera_store::LOCAL_ACCOUNT_ID)
        .unwrap();
    assert_eq!(
        list.len(),
        with_del.len(),
        "整表读出的条数必须与写入一致 —— 这是引擎复用视图、跳过基线下载的前提"
    );
    let note = list
        .iter()
        .find(|e| e.kind == EntityKind::Note)
        .expect("列表里要有那条笔记");
    assert_eq!(
        note.deleted_at.as_deref(),
        Some("2026-09-27T00:00:00Z"),
        "删除时间戳必须原样读回，不然持久化视图会丢判据"
    );
    assert!(note.deleted, "deleted 标志要与时间戳同步");
    assert!(
        store.remote_index_list("不存在的账户").unwrap().is_empty(),
        "读不能越过账户边界：别的账户一行都不该看到"
    );
    assert!(matches!(
        store.remote_index_replace("不存在", &entries),
        Err(StoreError::Constraint(_))
    ));
}

#[test]
fn apply_remote_writes_envelope_and_becomes_clean() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    store
        .mark_synced(
            EntityKind::Folder,
            &folder,
            store.get_folder(&folder).unwrap().unwrap().rev,
            "sha256:f",
        )
        .unwrap();
    let remote_id = EntityId::new();
    let doc = doc_heading("来自另一台设备", "同步协议在两字中文下必须走 LIKE");
    let env = note_envelope(&remote_id, 7, &doc, Some(&folder));

    let rep = store
        .apply_remote(&[ApplyOp::UpsertNote { env: env.clone() }])
        .unwrap();
    assert_eq!((rep.applied, rep.notes_written), (1, 1));
    let n = store
        .get_note(&remote_id)
        .unwrap()
        .expect("远端笔记必须落地");
    assert_eq!(n.rev, Rev(7));
    assert_eq!(n.sync_rev, Rev(7), "pull 生效 → sync_rev ← rev（§4.2）");
    assert_eq!(n.remote_rev, Rev(7));
    assert_eq!(n.title, "来自另一台设备", "派生列必须由 store 重算（I5）");
    assert_eq!(n.content_hash, hash_of(&doc));
    assert!(
        store
            .dirty_entities(notera_store::LOCAL_ACCOUNT_ID)
            .unwrap()
            .is_empty(),
        "拉回的内容不该再上行"
    );
    assert_eq!(
        store.search(&SearchQuery::new("另一台")).unwrap().len(),
        1,
        "FTS 同事务更新"
    );
    assert_eq!(
        store.revision_doc(&remote_id, Rev(7)).unwrap().unwrap(),
        n.doc
    );
    // 幂等重放
    let rep2 = store.apply_remote(&[ApplyOp::UpsertNote { env }]).unwrap();
    assert_eq!((rep2.applied, rep2.skipped), (0, 1));
    assert_eq!(store.get_note(&remote_id).unwrap().unwrap().rev, Rev(7));
    // 更新版本：rev 前进、base 仍可取（三方合并前提）
    let doc2 = doc_heading("来自另一台设备", "改过的正文内容");
    let rep3 = store
        .apply_remote(&[ApplyOp::UpsertNote {
            env: note_envelope(&remote_id, 9, &doc2, Some(&folder)),
        }])
        .unwrap();
    assert_eq!(rep3.applied, 1);
    let n2 = store.get_note(&remote_id).unwrap().unwrap();
    assert_eq!((n2.rev, n2.sync_rev), (Rev(9), Rev(9)));
    assert!(
        store.revision_doc(&remote_id, Rev(7)).unwrap().is_some(),
        "旧 revision 不能被覆盖"
    );
    assert!(store.verify().is_empty(), "{:?}", store.verify());
}

#[test]
fn apply_remote_is_one_transaction_no_partial_write() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let a = EntityId::new();
    let b = EntityId::new();
    let bad = EntityId::new();

    let ops = vec![
        ApplyOp::UpsertNote {
            env: note_envelope(&a, 2, &doc_text("第一批 A"), Some(&folder)),
        },
        ApplyOp::UpsertNote {
            env: note_envelope(&b, 2, &doc_text("第一批 B"), Some(&folder)),
        },
        // 第三条哈希对不上 → I6 必须整批回滚
        ApplyOp::UpsertNote {
            env: {
                let mut e = note_envelope(&bad, 2, &doc_text("坏数据"), Some(&folder));
                e["hash"] = serde_json::json!(
                    "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                );
                e
            },
        },
    ];
    let e = store.apply_remote(&ops).unwrap_err();
    assert!(is_rejection(&e), "实际 {e:?}");
    for id in [&a, &b, &bad] {
        assert!(
            store.get_note(id).unwrap().is_none(),
            "中途失败后不得有部分写入：{id}"
        );
    }
    assert_eq!(store.stats().unwrap().notes, 0);
    assert_eq!(
        store.stats().unwrap().revisions,
        0,
        "revision 也不能只写一半"
    );
    assert_eq!(store.stats().unwrap().fts_rows, 0, "FTS 必须一起回滚");
    assert!(store.verify().is_empty(), "{:?}", store.verify());

    // 同一批里"前面合法、后面非法"的其它形状：rev 回退
    let doc = doc_text("先落地");
    let ok = ApplyOp::UpsertNote {
        env: note_envelope(&a, 5, &doc, Some(&folder)),
    };
    let stale = ApplyOp::UpsertNote {
        env: note_envelope(&a, 3, &doc_text("更旧的远端"), Some(&folder)),
    };
    assert!(store.apply_remote(&[ok, stale]).unwrap_err().is_rejection());
    assert!(
        store.get_note(&a).unwrap().is_none(),
        "回退批必须整体不生效"
    );

    // 纯附件/加密载荷之类无法落地的形状，同样不得留下半条
    let mut encrypted = note_envelope(&b, 1, &doc, Some(&folder));
    encrypted["payload"] = serde_json::Value::Null;
    encrypted["ct"] = serde_json::json!({"nonce":"AA==","ct":"BB=="});
    encrypted["enc"] = serde_json::json!({"alg":"aes-256-gcm-siv"});
    assert!(store
        .apply_remote(&[ApplyOp::UpsertNote { env: encrypted }])
        .unwrap_err()
        .is_rejection());
    assert!(store.get_note(&b).unwrap().is_none());
    assert_eq!(store.stats().unwrap().notes, 0);
}

#[test]
fn apply_folder_tombstone_and_purge_from_remote() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    store
        .mark_synced(
            EntityKind::Folder,
            &folder,
            store.get_folder(&folder).unwrap().unwrap().rev,
            "sha256:f",
        )
        .unwrap();
    let f = store.create_folder(Some(&folder), "远端会删掉它").unwrap();
    store
        .mark_synced(EntityKind::Folder, &f.id, f.rev, "sha256:ff")
        .unwrap();
    let n = create(&store, &f.id, "夹在里面的笔记");
    store
        .mark_synced(EntityKind::Note, &n.id, n.rev, &n.content_hash)
        .unwrap();

    // 远端删除 → 本地软删 + 墓碑
    store
        .apply_remote(&[ApplyOp::Tombstone {
            kind: EntityKind::Folder,
            id: f.id.clone(),
            rev: Rev(5),
        }])
        .unwrap();
    let after = store.get_folder(&f.id).unwrap().unwrap();
    assert!(after.deleted_at.is_some());
    assert!(
        !store
            .get_tombstone(EntityKind::Folder, &f.id)
            .unwrap()
            .unwrap()
            .purged
    );
    assert!(
        store.get_note(&n.id).unwrap().is_some(),
        "远端删文件夹也不能级联删笔记"
    );
    assert!(store.verify().is_empty(), "{:?}", store.verify());

    // 远端永久删除（干净实体）→ 行消失 + purged 墓碑
    store
        .apply_remote(&[ApplyOp::Purge {
            kind: EntityKind::Note,
            id: n.id.clone(),
        }])
        .unwrap();
    assert!(store.get_note(&n.id).unwrap().is_none());
    let t = store
        .get_tombstone(EntityKind::Note, &n.id)
        .unwrap()
        .expect("墓碑");
    assert!(t.purged);
    // 墓碑被确认（remote index）后不再算脏
    let dirty = store
        .dirty_entities(notera_store::LOCAL_ACCOUNT_ID)
        .unwrap();
    assert!(dirty
        .iter()
        .any(|d| d.id == n.id && d.why == DirtyWhy::Purged));
    store
        .mark_synced(EntityKind::Note, &n.id, Rev(6), "sha256:0")
        .unwrap();
    assert!(!store
        .dirty_entities(notera_store::LOCAL_ACCOUNT_ID)
        .unwrap()
        .iter()
        .any(|d| d.id == n.id));
    // 脏实体上的远端永久删除 → 拒绝（C1/C4）
    let m = create(&store, &folder, "本地未推送的修改");
    let e = store
        .apply_remote(&[ApplyOp::Purge {
            kind: EntityKind::Note,
            id: m.id.clone(),
        }])
        .unwrap_err();
    assert!(is_rejection(&e), "实际 {e:?}");
    assert!(
        store.get_note(&m.id).unwrap().is_some(),
        "用户内容不因远端永久删除而静默消失"
    );
}

#[test]
fn mark_synced_refuses_to_lead_local_head_and_attachment_kind_is_explicit() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let n = create(&store, &folder, "确认点不能领先");
    assert!(matches!(
        store.mark_synced(EntityKind::Note, &n.id, Rev(50), "sha256:y"),
        Err(StoreError::Rejected(_))
    ));
    assert_eq!(store.get_note(&n.id).unwrap().unwrap().sync_rev, Rev(0));
    assert!(matches!(
        store.mark_synced(EntityKind::Note, &missing_id(), Rev(1), "sha256:y"),
        Err(StoreError::NotFound { .. })
    ));
}

/// `rows::table_of` 是 **kind → 实体表名** 的唯一权威。这一条就是它存在的全部理由：
/// `mark_synced` 以前写的是 `if kind == Note {"notes"} else {"folders"}` ——
/// 加第四种实体时它会**静默把标签的确认点写进 `folders`**：编得过、不红、
/// 而症状是"标签的 sync_rev 永远不动 ⇒ 每轮重传，用户只看到同步在转圈"。
/// 把它改回 `if/else` 会让这一条红（标签那一发落不到 `tags`，而"另一个本"被误确认）。
#[test]
fn mark_synced_routes_each_kind_to_its_own_table() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let note = create(&store, &folder, "笔记那一行");
    let extra = store.create_folder(None, "另一个本").unwrap();
    let tag = store.create_tag("读后").unwrap();
    assert_eq!(tag.sync_rev, Rev(0), "夹具前提：标签刚建时是脏的");

    store
        .mark_synced(EntityKind::Tag, &tag.id, tag.rev, "sha256:tag")
        .expect("标签的确认点必须走得通（`sync_hash` 那一列也在这条边上）");

    let after = store.read_tag(&tag.id).unwrap().expect("标签要在");
    assert_eq!(after.sync_rev, tag.rev, "确认点要落到 tags 自己那一行");
    // 另外两张表一个字没动
    assert_eq!(
        store.get_folder(&extra.id).unwrap().unwrap().sync_rev,
        extra.sync_rev,
        "标签那一发被写进 folders 了（`table_of` 退化成 if/else 就是这个形状）"
    );
    assert_eq!(
        store.get_note(&note.id).unwrap().unwrap().sync_rev,
        note.sync_rev
    );

    // 附件在这里仍然是**具名拒绝**，不是 `else` 的兜底目标
    let e = store
        .mark_synced(EntityKind::Attachment, &tag.id, Rev(1), "sha256:a")
        .expect_err("附件不许落进任何一张 UUID 实体表");
    assert!(e.to_string().contains("set_attachment_states"), "{e}");
}

/// 第二台设备的视角：收到一条带图片的笔记，附件必须**当场**认账。
/// 漏登记不是"图片显示不出来"这么轻：`attachments` 行是附件在库里的唯一户口 ——
/// 没有行 → 没有下载任务（图片永远占位）、引用计数恒为 0（GC 敢删还在用的 blob）、
/// 按文件夹导出的附件集合也是空的。
#[test]
fn applying_a_remote_note_registers_the_attachments_it_references() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let bytes = b"another device png";
    let sha = notera_crypto::sha256_hex(bytes);
    let doc = serde_json::json!({ "v": 1, "content": [
        { "id": "blk000001", "type": "paragraph", "content": [{ "text": "看图" }] },
        { "id": "blk000002", "type": "image",
          "attrs": { "sha256": sha, "role": "inline", "size": bytes.len(), "mediaType": "image/png", "name": "shot.png" } },
        // 畸形 sha（别的客户端拿 sha256 当普通字段名）：不能让整篇笔记因此写不进去
        { "id": "blk000003", "type": "image", "attrs": { "sha256": "not-a-sha" } }
    ] });
    let id = EntityId::new();
    store
        .apply_remote(&[ApplyOp::UpsertNote {
            env: note_envelope(&id, 1, &doc, Some(&folder)),
        }])
        .unwrap();

    assert_eq!(
        store.attachment_refs(&sha).unwrap(),
        1,
        "doc 里的引用要落到 note_attachments（外键也靠它）"
    );
    assert_eq!(
        store.attachment_for_state(&sha),
        ("missing".to_string(), "unknown".to_string()),
        "本地没有字节、远端没确认过 —— 这才是诚实的起点"
    );
    let jobs = store.attachment_downloads(5).unwrap();
    assert_eq!(
        jobs.iter().map(|j| j.sha256.as_str()).collect::<Vec<_>>(),
        vec![sha.as_str()],
        "没有下载任务 = 图片永远停在占位"
    );
    assert_eq!(
        jobs[0].media_type, "image/png",
        "媒体类型从块属性带过来（占位与上传都按它显示）"
    );
    assert_eq!(
        store.local_attachment_shas().unwrap(),
        vec![sha.clone()],
        "畸形 sha 一律不入库"
    );
    assert_eq!(store.stats().unwrap().attachments, 1);

    // 幂等：同一条记录重放不产生第二行，也不把已登记的态改回去
    store
        .apply_remote(&[ApplyOp::UpsertNote {
            env: note_envelope(&id, 1, &doc, Some(&folder)),
        }])
        .unwrap();
    assert_eq!(store.local_attachment_shas().unwrap(), vec![sha]);
}

#[test]
fn attachments_are_content_addressed_and_deduplicated() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let n = create(&store, &folder, "带附件的笔记");
    let bytes = b"\x89PNG\r\n\x1a\n fake png payload".to_vec();
    let sha = notera_crypto::sha256_hex(&bytes);

    let a1 = store
        .attach_blob(&n.id, &bytes, "image/png", Some("a.png"), "blk000001")
        .unwrap();
    assert_eq!(a1.sha256, sha);
    assert_eq!(a1.local_state, "available");
    assert_eq!(a1.remote_state, "unknown");
    assert_eq!(a1.role, "inline", "image/* → inline");
    let path = store.blob_path(&sha);
    assert_eq!(
        path,
        fx.dir.join("attachments").join(&sha[..2]).join(&sha),
        "落盘路径 = <2hex>/<sha>"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let parts: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".part"))
        .collect();
    assert!(parts.is_empty(), "临时文件必须被 rename 掉：{parts:?}");

    // 同一 blob 再挂一次：内容寻址去重，引用计数派生
    let n2 = create(&store, &folder, "第二个引用");
    let a2 = store
        .attach_blob(
            &n2.id,
            &bytes,
            "application/pdf",
            Some("a.pdf"),
            "blk000001",
        )
        .unwrap();
    assert_eq!(a2.sha256, sha);
    assert_eq!(a2.role, "file");
    assert_eq!(
        store.stats().unwrap().attachments,
        1,
        "同一 sha256 只存一行"
    );
    assert_eq!(store.attachment_refs(&sha).unwrap(), 2);

    let with = store.get_note(&n.id).unwrap().unwrap();
    assert!(
        with.has_attachment,
        "note_attachments 链接要反映到派生列（I5）"
    );
    assert!(with.rev > n.rev, "派生列变化也要推进 rev");
    assert!(store.verify().is_empty(), "{:?}", store.verify());

    // 生命周期状态迁移（§8）
    store
        .set_attachment_states(&sha, None, Some("present"))
        .unwrap();
    assert_eq!(store.stats().unwrap().attachment_bytes, bytes.len() as u64);
    assert!(matches!(
        store.set_attachment_states(&sha, Some("bogus"), None),
        Err(StoreError::Constraint(_))
    ));
    store.enqueue_download(&sha).unwrap();
    let ups = store
        .outbox_take(notera_store::LOCAL_ACCOUNT_ID, 100)
        .unwrap()
        .into_iter()
        .filter(|o| o.kind == EntityKind::Attachment)
        .collect::<Vec<_>>();
    assert!(
        ups.iter().any(|o| o.op == OpKind::Upload
            && o.sha256.as_deref() == Some(sha.as_str())
            && o.entity_key == sha),
        "附件上行待办的键必须是 sha256"
    );
    assert!(
        ups.iter()
            .any(|o| o.op == OpKind::Download && o.entity_key == sha),
        "附件的键是 sha256"
    );

    // 永久删除笔记：链接随 CASCADE 消失、blob 行仍在（回收交给引用计数）
    store.purge_note(&n.id).unwrap();
    assert_eq!(store.attachment_refs(&sha).unwrap(), 1);
    assert_eq!(store.stats().unwrap().attachments, 1);
    assert!(path.exists(), "还有 1 个引用 → blob 不能删（§8）");
    assert!(store.verify().is_empty(), "{:?}", store.verify());
}

#[test]
fn conflicts_are_recorded_and_openable_then_resolved() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let n = create(&store, &folder, "冲突的本地侧");
    let id = store
        .record_conflict(&ConflictRecord {
            account_id: "acct-a".into(),
            kind: EntityKind::Note,
            id: n.id.clone(),
            base_rev: Rev(0),
            local_rev: n.rev,
            remote_rev: Rev(4),
            local_hash: n.content_hash.clone(),
            remote_hash: "sha256:".to_string() + &"b".repeat(64),
            auto_merged: false,
            copy_note_id: None,
        })
        .unwrap();
    assert!(id > 0);
    let open = store.open_conflicts().unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, n.id);
    assert_eq!(open[0].state, notera_store::ConflictState::Open);
    assert!(!open[0].auto_merged);
    store.resolve_conflict(id, "kept_both").unwrap();
    assert!(
        store.open_conflicts().unwrap().is_empty(),
        "裁决后不再是 open"
    );
    assert!(matches!(
        store.resolve_conflict(id, "乱写"),
        Err(StoreError::Constraint(_))
    ));
    let _ = NoteQuery::all();
}

#[test]
fn probed_caps_survive_a_restart_and_null_means_never_probed() {
    // §5 的探测结果必须能存下来：否则每次启动都退回保守默认，
    // 一台真的支持条件写的服务器会被永久当成 S3 盲写。
    let fx = Fix::new();
    let store = fx.open();
    store
        .register_account("acct-c", "c", "https://dav.example/dav")
        .unwrap();

    assert_eq!(
        store.account_caps("acct-c").unwrap(),
        None,
        "新登记的账户应当是『从未探测』，而不是『零能力』"
    );
    store.set_account_caps("acct-c", 0b101).unwrap();
    assert_eq!(store.account_caps("acct-c").unwrap(), Some(0b101));

    // 0 是合法值（什么都不支持），必须与 NULL 区分开
    store.set_account_caps("acct-c", 0).unwrap();
    assert_eq!(
        store.account_caps("acct-c").unwrap(),
        Some(0),
        "全不支持被存成了从未探测"
    );

    drop(store);
    let again = fx.open();
    assert_eq!(
        again.account_caps("acct-c").unwrap(),
        Some(0),
        "重启后探测结果必须还在"
    );
    assert!(
        matches!(
            again.set_account_caps("nope", 1),
            Err(StoreError::Constraint(_))
        ),
        "不存在的账户要报错"
    );
}

#[test]
fn settle_locates_a_row_by_entity_and_rev_and_touches_nothing_else() {
    // 引擎结清待办时手里只有 (kind, id, rev)。按这三样定位必须精确：
    // 猜错行 = 把另一条还没上传的待办标成已完成，那是静默漏同步。
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let acct = notera_store::LOCAL_ACCOUNT_ID;
    let n = create(&store, &folder, "第一版");
    // 此时 local 名下有两行：默认本 + 笔记
    assert_eq!(store.outbox_len(acct, &[OpState::Pending]).unwrap(), 2);

    assert!(
        store
            .outbox_settle(
                acct,
                EntityKind::Note,
                n.id.as_str(),
                n.rev.get() as i64,
                OpState::Done
            )
            .unwrap(),
        "按实体 + rev 必须能定位到那一行"
    );
    assert_eq!(
        store.outbox_len(acct, &[OpState::Done]).unwrap(),
        1,
        "只结清指定的那一行"
    );
    assert_eq!(
        store.outbox_len(acct, &[OpState::Pending]).unwrap(),
        1,
        "默认本那行不该被顺手标掉"
    );

    // rev 对不上 = 找不到，如实返回 false（而不是"随便结一行"）
    assert!(!store
        .outbox_settle(acct, EntityKind::Note, n.id.as_str(), 999, OpState::Done)
        .unwrap());
    // 账户也在键里：别的账户没有这一行
    assert!(!store
        .outbox_settle(
            "acct-other",
            EntityKind::Note,
            n.id.as_str(),
            n.rev.get() as i64,
            OpState::Done
        )
        .unwrap());
    // 已 done 的行不会被第二次结清改写状态
    assert!(!store
        .outbox_settle(
            acct,
            EntityKind::Note,
            n.id.as_str(),
            n.rev.get() as i64,
            OpState::Failed
        )
        .unwrap());
    assert_eq!(
        store.outbox_len(acct, &[OpState::Done]).unwrap(),
        1,
        "重复结清不许把 done 改成 failed"
    );
    // kind 对不上同样不许命中：同 id/同 rev 也不会跨实体类型误结
    assert!(!store
        .outbox_settle(
            acct,
            EntityKind::Folder,
            n.id.as_str(),
            n.rev.get() as i64,
            OpState::Done
        )
        .unwrap());
}

/// SY-REV-01：远端视图落盘的同时必须把"已观测到的远端头部"写进实体行 —— I2 那条
/// `rev = max(rev, remote_rev) + 1` 才有东西可取大（ADR-0021 D1）。
/// 判据打在**调用边**上：不只是"那一列被写了"，而是"下一次本地编辑真的用了它"。
#[test]
fn remote_index_also_observes_remote_heads_for_rev_allocation() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let acct = notera_store::LOCAL_ACCOUNT_ID;
    let n = create(&store, &folder, "对面已经改到第 5 版");

    let note_view = |rev: i64| RemoteIndexEntry {
        kind: EntityKind::Note,
        id: n.id.clone(),
        rev: Rev(rev as u64),
        hash12: Some("a1b2c3d4e5f6".into()),
        size: Some(120),
        deleted: false,
        purged: false,
        seg: None,
        sha256: None,
        deleted_at: None,
    };
    let folder_view = RemoteIndexEntry {
        kind: EntityKind::Folder,
        id: folder.clone(),
        rev: Rev(4),
        hash12: Some("ffee00001111".into()),
        size: Some(64),
        deleted: false,
        purged: false,
        seg: None,
        sha256: None,
        deleted_at: None,
    };

    // ① 视图里对面是 5 → 实体行必须看得见 5（这一列此前在生产里永远是 0）
    store
        .remote_index_replace(acct, &[note_view(5), folder_view.clone()])
        .unwrap();
    let cur = store.get_note(&n.id).unwrap().unwrap();
    assert_eq!(cur.remote_rev, Rev(5), "远端视图没有喂到 notes.remote_rev");
    assert_eq!(
        store.get_folder(&folder).unwrap().unwrap().remote_rev,
        Rev(4),
        "folders.remote_rev 同样要喂"
    );
    assert_eq!(cur.rev, Rev(1), "观测远端不许推进本地头部");

    // ② 调用边：下一次本地编辑必须是 max(1, 5) + 1 = 6，而不是 local + 1 = 2。
    //    差这一格就是"编号撞在对面已占用的号上、那一行永远推不出去"（G17 的根因形状）。
    let next = store
        .edit_note(&n.id, doc_text("本机接着写"), cur.rev)
        .unwrap();
    assert_eq!(
        next.rev,
        Rev(6),
        "next_rev 没吃到观测到的远端头部：拿到了 {rev}（对面已经在 5，这个号推不上去）",
        rev = next.rev
    );

    // ③ 单调：后面到达的一份**更旧**的视图（重放 / 清单回退）不许把观测值拉回去
    store
        .remote_index_replace(acct, &[note_view(2), folder_view.clone()])
        .unwrap();
    let after = store.get_note(&n.id).unwrap().unwrap();
    assert_eq!(
        after.remote_rev,
        Rev(5),
        "旧视图把已观测头部改回了 {} —— I2 的取大者会重新失效",
        after.remote_rev
    );
    assert_eq!(after.rev, Rev(6), "观测这一列不许动本地内容或头部");

    // ④ 附件那一档没有 remote_rev 可写（sha256 寻址），整批替换不许因此报错
    let att = RemoteIndexEntry {
        kind: EntityKind::Attachment,
        id: notera_core::EntityId::parse(&n.id.to_string()).unwrap(),
        rev: Rev(1),
        hash12: None,
        size: Some(9),
        deleted: false,
        purged: false,
        seg: None,
        sha256: Some("b".repeat(64)),
        deleted_at: None,
    };
    store.remote_index_replace(acct, &[att]).unwrap();
}

/// 回收站到期候选读的是**哪一列**。这一格是被变异台下出来的：把 `deleted_at < cutoff` 改成
/// `updated_at < cutoff` 之后，`crates/notera-host/tests/trash_expiry.rs` 四条全绿 ——
/// 因为删除这一动作会把 `deleted_at` 与 `updated_at` 一起写成"现在"，两列在回收站行的整个生命期里
/// 几乎重合，所以那几臂分不出读的是哪一列（"扫到 0 项 ≠ 检查过"的另一形：**红不了 ≠ 判据在守着**）。
///
/// 于是这里直接把两列拉开差值造现场。这个现场**不是人为的**：SYNC-PROTOCOL 的 P11 就承认
/// "本地在删除后又被编辑（`updated_at > deleted_at`）"是真实形状（冲突那条路径会走到），
/// 所以"到期读哪一列"是一个会真的分叉的问题，不是一个纸上的问题。
/// 两个方向都要钉，因为它们错起来是相反的两种用户后果：
/// ① 躺了 40 天、期间被碰过 ⇒ **仍要清**（读 `updated_at` 会永远不清，回收站只涨不消）；
/// ② 只删了 1 天、但 `updated_at` 很久远 ⇒ **不许清**（读 `updated_at` 会提前销毁，反悔窗口被吃掉）。
#[test]
fn trash_expiry_candidates_key_on_the_deletion_not_on_the_last_touch() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let n = create(&store, &folder, "到期看删除那一刻");
    store
        .mark_synced(EntityKind::Note, &n.id, n.rev, "sha256:x")
        .unwrap();
    store.delete_note(&n.id).unwrap();
    let trashed = store.get_note(&n.id).unwrap().unwrap();
    store
        .mark_synced(EntityKind::Note, &trashed.id, trashed.rev, "sha256:y")
        .unwrap();

    // 现场成立：删除已确认 + 在回收站里 ⇒ 到期线放到"现在"之后就该认到这一行。
    let always = "2999-01-01T00:00:00.000Z";
    assert_eq!(
        store.trash_expiry_candidates(always, 10).unwrap(),
        vec![trashed.id.clone()],
        "候选集基础形状就不成立：后面两臂的分歧没有意义"
    );

    // 下面两臂共用这条到期线，而两列被故意摆在它的**两侧** —— 这正是"读哪一列"唯一的证人。
    let cutoff = "2026-10-01T00:00:00.000Z";

    let retouch = |deleted_at: &str, updated_at: &str| {
        let conn = rusqlite::Connection::open(fx.db_file()).unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![trashed.id.to_string(), deleted_at, updated_at],
        )
        .unwrap();
    };

    // ① 删了 40 天，行后来又被动过 ⇒ 到期判据认删除那一刻，仍要清。
    retouch("2026-09-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z");
    assert_eq!(
        store.trash_expiry_candidates(cutoff, 10).unwrap(),
        vec![trashed.id.clone()],
        "读的是 updated_at ⇒ 被碰过的回收站行永远清不掉"
    );

    // ② 删了 1 天，但 updated_at 在到期线之外 ⇒ 反悔窗口还没走完，一条都不许清。
    retouch("2026-10-17T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    assert!(
        store
            .trash_expiry_candidates(cutoff, 10)
            .unwrap()
            .is_empty(),
        "读的是 updated_at ⇒ 刚删一天的行被当成早就到期，自动销毁吃掉用户的反悔窗口"
    );
}

/// 读侧那一格的口径：**库里没有这一行 = 没有标签**，不是错误。
///
/// 逼出这条的是整跑 ㊷ 那条腿（它判"这一腿 console error 为零"）：那条腿注入一份 200 行的假清单，
/// store 自动选中 `rows[0]`，于是界面去读一篇**库里根本没有的**笔记的标签 —— 原来这里抛
/// `QueryReturnedNoRows` ⇒ 桥回 HTTP 400 ⇒ 红。真机上同一格也不是异常：对面**正在传来**的那一篇、
/// 本机刚**永久删掉**的那一篇，都会走到"没有这一行"。让一次读投影去目击同步竞态，是读侧的错。
///
/// 但这一条不许顺手长成"什么都能吞"：下面那半截对照钉的是"挂上了就必须读得回来"。
/// （坏 id 那一格在 host 层，`note_tags` 仍旧具名拒 400 —— 线上读数见台账第一百四十一批。）
#[test]
fn reading_tags_of_a_note_that_is_not_there_answers_empty() {
    let fx = Fix::new();
    let store = fx.open();

    let ids = store
        .live_tag_ids(&missing_id())
        .expect("库里没有这一篇 ⇒ 回空集，不许报错");
    assert!(ids.is_empty(), "空集才是对的读数：{ids:?}");

    // 对照：同一颗读法在"真挂着标签"的那一篇上必须读得回来（否则上面那条是恒真的空枪）
    let folder = default_folder(&store);
    let note = create(&store, &folder, "读侧对照那一篇");
    let tag = store.create_tag("对照那颗").expect("create_tag");
    store
        .set_note_tags(&note.id, &[tag.id.as_str().to_owned()])
        .expect("set_note_tags");
    assert_eq!(
        store.live_tag_ids(&note.id).expect("这一篇在库里"),
        vec![tag.id.as_str().to_owned()]
    );
}
