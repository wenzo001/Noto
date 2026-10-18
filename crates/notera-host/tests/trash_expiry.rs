//! §2.4 回收站到期（2026-10-18 用户拍板"改成 30 天自动清理"，推翻 2026-10-06 那句"永不"）。
//!
//! 这一批是**销毁**，所以判据的写法与 §8 的 GC 同一套：先证"不该删的一条都不删"，
//! 再证"该删的那条删得掉、且删除这件事传得出去"。
//!
//! 两条与手动路径不同的地方，是这一格独有的：
//! ① **只清"删除已经传给服务器"的行**（`rev = sync_rev`）—— 手动那一格是用户知情下按的，
//!    自动这一格没有人在场，所以不能替用户丢掉服务器从没见过的那份删除；
//! ② cutoff 由调用方给（与 `purge_verified_blobs` 同一做法），测试因此**不依赖墙上时钟**。
//!    生产那一头的到期线走 [`App::expire_trash_notes`] → `trash_cutoff()`，
//!    时间源读不出来时它是一个远古值 ⇒ 一条都不清（`cutoff_after` 那格单测钉的就是这个方向）。
//!
//! 跑法：`cargo test -p notera-host --test trash_expiry`

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use notera_core::EntityId;
use notera_host::commands::AccountDraftCmd;
use notera_host::App;
use notera_store::NoteQuery;
use notera_test_webdav::{Backend, TestServer};
use serde_json::json;

const SECRET: &str = "sup3r-s3cr3t";
static SEQ: AtomicUsize = AtomicUsize::new(0);

/// 一个比"现在"晚得多的到期线：任何 `deleted_at` 都比它早 ⇒ 到期判据为真。
const WHENEVER: &str = "2999-01-01T00:00:00.000Z";
/// 一个比"任何东西"都早的到期线：没有任何一行会到期。
const NEVER: &str = "0000-01-01T00:00:00.000Z";

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("notera-trash-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn doc(text: &str) -> serde_json::Value {
    json!({ "v": 1, "content": [{ "id": "blk000001", "type": "paragraph", "content": [{ "text": text }] }] })
}

/// 一台设备：数据目录 + App + 已配好的账户（目录必须比 App 活得久，所以成对持有）。
struct Device {
    app: App,
    _dir: Tmp,
}

impl Device {
    fn boot(tag: &str, base_url: &str) -> Self {
        let dir = Tmp::new(tag);
        std::env::set_var("NOTERA_DEV_WEBDAV_SECRET", SECRET);
        let app = App::boot(dir.path()).expect("核心启动");
        let draft: AccountDraftCmd = serde_json::from_value(json!({
            "label": "回收站到期", "baseUrl": base_url, "username": "notera-test",
        }))
        .expect("最小账户草案");
        app.configure_account(draft).expect("配置账户");
        Self { app, _dir: dir }
    }
    /// 建一篇笔记并**同步出去**，返回 id。同步是为了让 `rev == sync_rev`——
    /// 也就是"这条笔记的存在与删除都已经被服务器确认"，正是自动销毁的准入条件。
    async fn seeded_note(&self, text: &str) -> String {
        let folder = self.app.default_folder_id().unwrap();
        let note = self.app.create_note(&folder, doc(text)).unwrap();
        self.app.sync_once().await.expect("把这篇推上去");
        note.id
    }
    fn trash_ids(&self) -> Vec<String> {
        let rows = self
            .app
            .store()
            .list_notes(&NoteQuery::trash())
            .expect("回收站能读回来");
        rows.iter().map(|r| r.id.as_str().to_string()).collect()
    }
}

/// 判据的方向是先证"不删"。这一格挡的是三种最坏的形状：
/// 没到期的、根本没进回收站的、以及"删除还没传上去"的。
///
/// 三条臂**各自把自己需要的状态传上去**，不再共用一次 `sync_once`：上一版把臂②写成"等于 0"，
/// 而臂②自己那次同步恰好把臂①挂着的删除确认了 ⇒ 那一行当场变成合法候选，读数 1 不是产品删错了，
/// 是我的仪器把上一臂的现场吹干净了（同"探针自己会改变被测状态"那一族）。
#[tokio::test]
async fn expiry_never_touches_what_is_not_due_not_trashed_or_not_confirmed() {
    let srv = TestServer::start(Backend::Mem).await;
    let a = Device::boot("safety", &srv.base_url());

    // 臂①：删除**已确认**但到期线在远古 ⇒ 一条都不许动。
    let due = a.seeded_note("到期线之外的").await;
    a.app
        .store()
        .delete_note(&EntityId::parse(&due).unwrap())
        .unwrap();
    a.app
        .sync_once()
        .await
        .expect("把删除传上去（这一行现在是合法候选）");
    assert_eq!(
        a.app.expire_trash_notes_with(NEVER, 200),
        0,
        "到期线在远古时不许清掉任何一行"
    );
    assert!(a.trash_ids().contains(&due), "上面那条没动，回收站里还得在");

    // 臂②：活笔记不在候选集里，且**它不能被同批的销毁顺手带走**
    // （SQL 少了 `deleted_at IS NOT NULL` 就是这个形状，所以这里要真的有一条到期行在场）。
    let alive = a.seeded_note("从没删过的").await;
    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 200),
        1,
        "到期那一条该被清掉（这一格红了就是候选集本身没认删除已确认的行）"
    );
    assert!(
        a.app
            .store()
            .get_note(&EntityId::parse(&alive).unwrap())
            .unwrap()
            .is_some(),
        "活笔记被删掉了 ⇒ 自动功能在删活动笔记"
    );
    assert!(!a.trash_ids().contains(&due), "到期那条没被销毁");
    assert!(!a.trash_ids().contains(&alive), "活笔记被挪进了回收站");

    // 臂③：正文上去了、**删除还没上去**（`rev != sync_rev`）⇒ 自动这一格不收，留给下一轮。
    // 这一臂单独成立才有意义：臂②已经把"确认过的行会被清"证过一次，
    // 这里唯一变化的就是"删除没被服务器见过"，所以红只可能来自那道 `rev = sync_rev`。
    let pending = a.seeded_note("删除还没出去").await;
    a.app
        .store()
        .delete_note(&EntityId::parse(&pending).unwrap())
        .unwrap();
    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 200),
        0,
        "自动销毁不许替用户丢掉服务器从没见过的那份删除（手动那一格是用户知情按的，这一格没有人在场）"
    );
    assert!(a.trash_ids().contains(&pending), "未确认那一格被提前清掉了");
    // 反手自证：同一行只把删除传上去，它就立刻变成候选 ⇒ 上面那个 0 是闸门在挡，不是查询扫空。
    a.app.sync_once().await.expect("把这条删除传上去");
    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 200),
        1,
        "确认之后同一行仍不被清 ⇒ 臂③的 0 分不清是闸门还是空转"
    );
    srv.stop().await;
}

/// 该删的那条真删了，而且**删除这件事传得出去**：对面那台同步之后不该再看见它。
/// 走的是与手动「永久删除」完全同一条落库路径（`purge_note`），所以墓碑/outbox 的形状一致。
#[tokio::test]
async fn an_expired_trashed_note_is_purged_and_the_purge_reaches_the_other_device() {
    let srv = TestServer::start(Backend::Mem).await;
    let a = Device::boot("prop-a", &srv.base_url());
    let id = a.seeded_note("早该走的那篇").await;
    a.app
        .store()
        .delete_note(&EntityId::parse(&id).unwrap())
        .unwrap();
    a.app
        .sync_once()
        .await
        .expect("把删除传上去（这才算已确认）");

    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 200),
        1,
        "到期那篇该被清掉"
    );
    assert!(
        a.app
            .store()
            .get_note(&EntityId::parse(&id).unwrap())
            .unwrap()
            .is_none(),
        "本机这一行没被销毁"
    );
    assert!(!a.trash_ids().contains(&id), "销毁之后还留在回收站里");

    a.app.sync_once().await.expect("把 purged 墓碑传上去");

    let b = Device::boot("prop-b", &srv.base_url());
    b.app.sync_once().await.expect("第二台入伙并拉平");
    assert_eq!(
        b.trash_ids().len(),
        0,
        "对面那台的回收站里出现了这篇（墓碑没传出去）"
    );
    assert!(
        b.app
            .store()
            .list_notes(&NoteQuery::all())
            .unwrap()
            .iter()
            .all(|n| n.id.as_str() != id),
        "对面那台还留着那篇笔记 ⇒ 防复活的 I1/I3 闸门在这一格没成立"
    );
    srv.stop().await;
}

/// 一轮的上界。它挡的是"三年没开过这台设备 ⇒ 第一轮把写锁占满、用户那次保存在后面排队"，
/// 也是"候选集被 cap 截断之后不许谎报成全清完了"。
#[tokio::test]
async fn one_round_only_clears_up_to_the_cap_and_the_rest_wait() {
    let srv = TestServer::start(Backend::Mem).await;
    let a = Device::boot("cap", &srv.base_url());
    let mut ids = Vec::new();
    for i in 0..3 {
        let id = a.seeded_note(&format!("到期笔记 {i}")).await;
        a.app
            .store()
            .delete_note(&EntityId::parse(&id).unwrap())
            .unwrap();
        ids.push(id);
    }
    a.app.sync_once().await.expect("三条删除都传上去");

    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 2),
        2,
        "一轮该只做 cap 条"
    );
    assert_eq!(
        a.trash_ids().len(),
        1,
        "剩下的那一行该等着，而不是被顺手带走"
    );
    assert_eq!(
        a.app.expire_trash_notes_with(WHENEVER, 2),
        1,
        "下一轮该把剩下那条清掉"
    );
    assert_eq!(a.trash_ids().len(), 0);
    srv.stop().await;
}

/// 到期线本身。抽成纯函数就是为了这一格：**算不出来时必须往"不删"的那边倒**。
/// 反向不成立的话，一个坏掉的时间源就会把"回收站里所有东西"当成早就到期。
#[test]
fn an_unreadable_clock_yields_an_ancient_cutoff_so_nothing_is_expired() {
    assert_eq!(
        App::cutoff_after("not-a-timestamp", App::TRASH_TTL_DAYS),
        "0000-01-01T00:00:00.000Z",
        "时间源读不出来 ⇒ 远古 cutoff（方向：一条都不清）"
    );
    assert_eq!(
        App::cutoff_after("", App::QUARANTINE_GRACE_DAYS),
        "0000-01-01T00:00:00.000Z",
        "隔离区那一侧同一个方向"
    );
    let got = App::cutoff_after("2026-10-18T12:00:00.000Z", App::TRASH_TTL_DAYS);
    assert_eq!(
        got, "2026-09-18T12:00:00.000Z",
        "30 天这条尺要算得准（两格共用它）"
    );
}
