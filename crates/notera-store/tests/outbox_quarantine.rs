//! 毒丸隔离那几处 SQL 的真读数（SYNC-PROTOCOL §12 / DATA-MODEL 的 `sync_operations` 状态机）。
//!
//! 为什么单独立一份：引擎那一侧的判据（`notera-sync/tests/engine.rs`）打在**假端口**上，
//! 它证明的是"引擎问了、跳了、记了"，证明不了 `UPDATE` 真匹配到了行。这一仓被
//! "匹配 0 行、待办静静留着、其余一切照绿"咬过（`syncml.rs` 里那次 `op='up'`），
//! 所以这一格必须打在**真库**上：状态、计数、清单、放行后的清零，四样都读回来。
//!
//! 坐标不靠"从队列里捞一条"来猜：写侧给出的 `(种类, 实体, rev)` 才是引擎手里那三样，
//! 一次 `create_note` 会落**不止一行**（这篇笔记之外还有别的实体的动作），
//! 按行号取第一条就会捞到别人那一条 —— 那是"测试与生产说的是两件东西"的形状。
mod common;

use common::*;
use notera_store::{EntityKind, Store};

/// 账户那一格不写死字面量：出箱行落在 `all_accounts` 一定收的那颗哨兵上
/// （`enabled = 1 OR id = 哨兵`），所以从库里读出它自己用的那颗，而不是抄一份。
fn outbox_account(store: &Store) -> String {
    let mut ids = store.account_ids().unwrap_or_default();
    if ids.is_empty() {
        ids.push(notera_store::LOCAL_ACCOUNT_ID.to_string());
    }
    ids.remove(0)
}

/// 刚写完的那一篇在出箱里那一行的坐标 —— 与引擎用的那三样一字不差。
fn coords(note: &notera_store::Note) -> (EntityKind, String, i64) {
    (
        EntityKind::Note,
        note.id.as_str().to_string(),
        note.rev.0 as i64,
    )
}

#[test]
fn quarantine_takes_the_row_out_of_the_pending_count_and_names_it() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let note = create(&store, &folder, "毒丸夹具：这一条服务器一直不收");
    let acct = outbox_account(&store);
    let (kind, id, rev) = coords(&note);
    let base = store.outbox_len(&acct, &[]).unwrap();

    // 前置：靶子真的在场。少了这条，下面每一条都可能对着一个空库"绿"。
    assert!(
        base >= 1,
        "写完正文就该有待办行 —— 一条都没有 = 没有靶子，下面全是空判据"
    );

    // 连续被拒：每一次都要把同一行的计数真加上去。第二、三次落在 `failed` 行上，
    // 守卫少了那一档就在这里红 —— 而那正是"永远数不到闸门、每轮白烧一发"的真形状。
    for expect in 1..=3i64 {
        let n = store
            .outbox_note_failure(&acct, kind, &id, rev, "服务器不收这一份（夹具）")
            .unwrap();
        assert_eq!(
            n, expect,
            "第 {expect} 次拒收要加在同一行上（数不到 = 那条 UPDATE 没匹配到行）"
        );
    }
    assert_eq!(
        store.outbox_len(&acct, &[]).unwrap(),
        base,
        "被拒不等于办完：隔离之前这一条仍要算在待处理里"
    );

    assert!(
        store.outbox_quarantine(&acct, kind, &id, rev).unwrap(),
        "隔离那条 UPDATE 必须真匹配到行（匹配 0 行就是界面永远看不见它）"
    );
    assert!(
        store.outbox_is_blocked(&acct, kind, &id, rev).unwrap(),
        "状态要真落到 blocked 那一格"
    );
    // 这一条是产品可见的那一格：设置页那句"还有 N 项改动等着同步"读的就是这个数。
    assert_eq!(
        store.outbox_len(&acct, &[]).unwrap(),
        base - 1,
        "隔离之后它必须从待处理数里掉出去（不掉 = 那句话永远说不完）"
    );

    let rows = store.outbox_blocked(&acct).unwrap();
    assert_eq!(rows.len(), 1, "隔离清单要看得见这一条");
    assert_eq!(rows[0].0, kind, "清单要给出种类");
    assert_eq!(rows[0].1, id, "清单要给出是哪一条");
    assert_eq!(rows[0].2, Some(rev), "清单要带 rev：处置的是这一份内容");
    assert!(
        rows[0].3.as_deref().is_some_and(|r| r.contains("夹具")),
        "为什么被隔离要跟着这一行走（台账第 109 行那句「＋ 原因」）"
    );
}

#[test]
fn a_re_edit_makes_a_fresh_row_that_is_not_inherited_as_blocked() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let note = create(&store, &folder, "隔离之后又改了一次");
    let acct = outbox_account(&store);
    let (kind, id, rev1) = coords(&note);
    let base = store.outbox_len(&acct, &[]).unwrap();
    store
        .outbox_note_failure(&acct, kind, &id, rev1, "不收")
        .unwrap();
    assert!(store.outbox_quarantine(&acct, kind, &id, rev1).unwrap());

    // 用户又动了一次（置顶走的是同一条 `commit_edit`，会顶出新的 rev）⇒ 新的一版内容、另一行。
    // 旧那一版被隔离**不许**把这一次关掉 —— 这就是"按 (实体, rev) 问"而不是"按实体问"的理由。
    let again = store.set_note_pinned(&note.id, true).unwrap();
    let rev2 = again.rev.0 as i64;
    assert_ne!(rev2, rev1, "编辑要顶出新的一版，否则下面两条是同一行在自证");
    assert!(
        store.outbox_is_blocked(&acct, kind, &id, rev1).unwrap(),
        "旧那一版仍留在隔离区（不许被下一次编辑悄悄放出去）"
    );
    assert!(
        !store.outbox_is_blocked(&acct, kind, &id, rev2).unwrap(),
        "新那一版不许继承旧那一版的隔离（按实体问就会在这里红）"
    );
    // 相对读数：旧那一版离开待处理（-1），新那一版进待处理（+1）⇒ 回到 base 那一个数。
    // 写死 1 是错的：一次 `create_note` 本来就不止落一行（这篇之外还有别的实体的动作），
    // 把那个数抄进判据就是"仪器自己造的一个常数"。
    assert_eq!(
        store.outbox_len(&acct, &[]).unwrap(),
        base,
        "旧那一版在隔离区（-1）、新那一版该上行（+1）：数要回到 base 那一个读数"
    );
}

#[test]
fn release_lets_it_go_again_and_resets_the_streak_while_discard_does_not_reopen_it() {
    let fx = Fix::new();
    let store = fx.open();
    let folder = default_folder(&store);
    let note = create(&store, &folder, "放行与放弃那两颗按钮");
    let acct = outbox_account(&store);
    let (kind, id, rev) = coords(&note);
    let base = store.outbox_len(&acct, &[]).unwrap();
    for _ in 0..3 {
        store
            .outbox_note_failure(&acct, kind, &id, rev, "不收")
            .unwrap();
    }
    store.outbox_quarantine(&acct, kind, &id, rev).unwrap();

    // 「重试」：回到待处理，**并且连续计数要清零** —— 不清零就是下一次一发失败立刻重回隔离
    // （`attempts` 已经是 3，`>= 3` 那一判当场成立，用户点一次"重试"等于白点）。
    assert!(store.outbox_release(&acct, kind, &id, rev).unwrap());
    assert_eq!(
        store.outbox_len(&acct, &[]).unwrap(),
        base,
        "放行之后要重新算进待处理"
    );
    assert!(
        !store.outbox_is_blocked(&acct, kind, &id, rev).unwrap(),
        "放行之后不许还留在隔离区"
    );
    let after = store
        .outbox_note_failure(&acct, kind, &id, rev, "又没收")
        .unwrap();
    assert_eq!(
        after, 1,
        "放行必须把连续计数清零（读到 4 = 重试之后一发就又被隔离）"
    );

    // 「放弃」：只关这一条上写动作，本机的内容一个字不许动。
    store.outbox_quarantine(&acct, kind, &id, rev).unwrap();
    assert!(store.outbox_discard(&acct, kind, &id, rev).unwrap());
    assert!(
        store.outbox_blocked(&acct).unwrap().is_empty(),
        "放弃之后隔离区要空"
    );
    assert_eq!(
        store.outbox_len(&acct, &[]).unwrap(),
        base - 1,
        "放弃之后它也不再算待处理"
    );
    assert!(
        !store.outbox_is_blocked(&acct, kind, &id, rev).unwrap(),
        "superseded 不是 blocked：它不该还能被「重试」回来"
    );
    assert!(
        !store.outbox_release(&acct, kind, &id, rev).unwrap(),
        "已放弃的那一条不许被重试复活（回执必须说出「没这一条」）"
    );
    assert!(
        !store.outbox_discard(&acct, kind, &id, 999_999).unwrap(),
        "指向一条不存在的 rev 要答 false —— 界面拿这个回执分清「办成了」和「点了个空」"
    );
    assert_eq!(
        store.get_note(&note.id).unwrap().map(|n| n.plain_text),
        Some("放行与放弃那两颗按钮".to_string()),
        "放弃的是那条上写动作，本机的正文一个字都不许动"
    );
}
