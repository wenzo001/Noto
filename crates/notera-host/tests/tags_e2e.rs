//! ADR-0022 标签落地的端到端证人：**两台真设备**（两个 App + 一个测试 WebDAV）。
//!
//! 为什么必须有这一份：折叠（D4）、迟到的链接（D5）、改名传播这三格都是**分布式**语义，
//! 单进程注入造不出"另一台设备先在远端落了它那一版"。仓库的规矩是同一条。
//!
//! 逐条对着 ADR 的"验证方式"看：
//!  · 第 2 条（收敛 + 顺序无关）→ `two_devices_converge_to_the_same_winner_whatever_the_arrival_order`
//!    与 `..._with_the_arrival_order_reversed`（同一个 winner，两个到达顺序）
//!  · 第 3 条（改名）→ `a_rename_reaches_the_other_device_and_the_old_name_is_gone`
//!  · 第 4 条（删除期间迟到链接）→ `a_late_link_cannot_resurrect_a_deleted_tag`
//!  · D1 的显式代价（打标签顶属主笔记的 rev，但不动 content_hash）
//!    → `tagging_a_note_bumps_the_note_rev_but_not_its_content_hash`
//!  · 命令面契约（Rust 序列化出来的键名 ⇄ `api/types.ts` 声明）
//!    → `the_command_surface_speaks_exactly_the_declared_shape`
//!  · `head_select` 对 `tags.title` 那一格（写错列名是运行时 no such column）
//!    → `a_purged_tag_leaves_its_title_in_the_tombstone`
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use notera_core::EntityId;
use notera_host::commands::{dispatch, AccountDraftCmd};
use notera_host::App;
use notera_store::Store;
use notera_test_webdav::{Backend, TestServer};
use serde_json::{json, Value};

const SECRET: &str = "sup3r-s3cr3t";
static SEQ: AtomicUsize = AtomicUsize::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("notera-tags-{tag}-{}-{n}", std::process::id()));
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

struct Device {
    app: App,
    _dir: Tmp,
}

impl Device {
    fn boot(tag: &str, base_url: &str) -> Self {
        let dir = Tmp::new(tag);
        let app = App::boot(dir.path()).expect("核心启动");
        std::env::set_var("NOTERA_DEV_WEBDAV_SECRET", SECRET);
        let draft: AccountDraftCmd = serde_json::from_value(json!({
            "label": "标签台", "baseUrl": base_url, "username": "notera-test",
        }))
        .unwrap();
        app.configure_account(draft).expect("配置账户");
        Self { app, _dir: dir }
    }
    /// 跑到"这一轮不需要接着干"。`outbox_pending` 是全实体 kinds 的那一份账（标签的 op 也在里面），
    /// 所以这里不另立"dirty_tags" —— 界面也没有那一格。
    async fn settle(&self, cap: usize) -> Vec<String> {
        let mut trace = Vec::new();
        for _ in 0..cap {
            let stats = self.app.sync_once().await.expect("一轮同步");
            let st = self.app.store().stats().unwrap();
            trace.push(format!(
                "{stats:?} dirty={} pending={}",
                st.dirty_notes, st.outbox_pending
            ));
            if stats.outcome != notera_sync::RoundOutcome::Partial && st.outbox_pending == 0 {
                return trace;
            }
        }
        trace
    }
    /// 界面上看得见的标签 = **活的、不是别名的**那几颗，按 id 排序（比较用身份，不用位置）。
    fn live(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .app
            .store()
            .list_tags()
            .unwrap()
            .into_iter()
            .map(|t| (t.id.as_str().to_string(), t.title))
            .collect();
        v.sort();
        v
    }
    fn create_tag(&self, title: &str) -> (String, String) {
        let out = dispatch(&self.app, "create_tag", json!({ "title": title })).expect("建标签");
        (
            out["id"].as_str().expect("id").to_string(),
            out["title"].as_str().expect("title").to_string(),
        )
    }
}

fn doc(id: &str, text: &str) -> Value {
    json!({ "v": 1, "content": [{ "id": id, "type": "paragraph", "content": [{ "text": text }] }] })
}

fn new_note(dev: &Device, text: &str) -> EntityId {
    let folder = dev.app.default_folder_id().unwrap();
    let created = dev
        .app
        .create_note(&folder, doc("blk000001", text))
        .expect("建笔记");
    EntityId::parse(&created.id).expect("DTO 给的 id 要能解析回来")
}

/// 一台设备上"活的"标签里，链接解析器会给哪一颗（用来验别名改写）。
fn live_links(dev: &Device, note: &EntityId) -> Vec<String> {
    dev.app.store().live_tag_ids(note).unwrap()
}

fn set_links(dev: &Device, note: &EntityId, ids: &[&str]) {
    let v: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    dispatch(
        &dev.app,
        "set_note_tags",
        json!({ "id": note.as_str(), "tagIds": v }),
    )
    .expect("设标签");
}

// ------------------------------------------------------------------ 命令面契约 ---

/// 序列化出来的**真实键名**就是 `api/types.ts` 里声明的那三个。
/// 为什么不打在 Rust 结构体上而打在 dispatch 的 JSON 上：TS 类型与前端 mock 都拦不住
/// Rust→界面这一格的漂移（这个项目里已经栽过）。
#[test]
fn the_command_surface_speaks_exactly_the_declared_shape() {
    let dir = Tmp::new("shape");
    let app = App::boot(dir.path()).expect("核心启动");
    let one = dispatch(&app, "create_tag", json!({ "title": "工作" })).expect("建标签");
    let mut keys: Vec<&str> = one
        .as_object()
        .unwrap()
        .keys()
        .map(|s| s.as_str())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["id", "noteCount", "title"],
        "标签上线的形状只有这三格（canonical/别名/rev 是核心的派生物，递出去就是第二个执行者）"
    );
    assert_eq!(one["title"], json!("工作"));
    assert_eq!(one["noteCount"], json!(0));

    let list = dispatch(&app, "list_tags", json!({})).expect("列表");
    assert_eq!(list.as_array().unwrap().len(), 1, "刚建的那颗要在列表里");
    assert_eq!(list[0]["id"], one["id"]);

    // 同名（canonical 相等）不建第二颗：这是"两台设备各活各的"那格的本地版。
    let again = dispatch(&app, "create_tag", json!({ "title": " 工作 " })).expect("再来一次");
    assert_eq!(again["id"], one["id"], "同名必须幂等返回已有那一颗");
    assert_eq!(
        dispatch(&app, "list_tags", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1,
        "幂等不该多出一行"
    );

    // 全角/半角是同一颗（NFKC），而**大小写**对中文不影响、对拉丁字母影响。
    let full = dispatch(&app, "create_tag", json!({ "title": "ＦＵＬＬ" })).expect("全角");
    let ascii = dispatch(&app, "create_tag", json!({ "title": "full" })).expect("半角");
    assert_eq!(full["id"], ascii["id"], "全角与半角同名（NFKC 折叠）");

    // 空标题与纯空格：拒，而且**不许落一行**。这里不猜错码的名字（那是界面 i18n 的事），
    // 要钉的是"被拒的那一笔没有变成一颗看不见的标签"。
    for bad in ["", "   "] {
        let before = dispatch(&app, "list_tags", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len();
        let e = dispatch(&app, "create_tag", json!({ "title": bad })).expect_err("空标题该被拒");
        let after = dispatch(&app, "list_tags", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len();
        assert_eq!(
            after,
            before,
            "被拒的 {} 落进了库（错码 {}）",
            bad.escape_debug(),
            e.code
        );
    }
}

/// 打标签顶属主笔记的 rev，但**不动 content_hash**（这是 D1 那条取舍的代价，写进断言才不会被
/// 后来人当成"哈希没变 ⇒ 不用传"）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tagging_a_note_bumps_the_note_rev_but_not_its_content_hash() {
    let dav = Tmp::new("dav-rev");
    let srv = TestServer::start(Backend::Fs(dav.path().to_path_buf())).await;
    let url = srv.base_url();
    let a = Device::boot("rev-a", &url);
    a.app.sync_once().await.expect("A 入伙");

    let note = new_note(&a, "正文一个字都没改");
    let before = a.app.store().get_note(&note).unwrap().unwrap();
    let (id, _) = a.create_tag("读后");
    set_links(&a, &note, &[id.as_str()]);

    let after = a.app.store().get_note(&note).unwrap().unwrap();
    assert_eq!(
        after.content_hash, before.content_hash,
        "正文没动，content_hash 就不该动（标签不在正文里）"
    );
    assert!(
        after.rev.get() > before.rev.get(),
        "打标签是一次真改动：rev 不前进它就永远传不出去"
    );
    assert_eq!(a.app.store().live_tag_ids(&note).unwrap(), vec![id.clone()]);

    // 对面那台拿到的是**链接**，不是"一篇打不开的笔记"。
    // （A 必须先公告：B 拉的是服务器上有的东西，没推就等于没发生。）
    a.settle(10).await;
    let b = Device::boot("rev-b", &url);
    b.settle(10).await;
    assert_eq!(live_links(&b, &note), vec![id], "链接要跟着属主记录过去");
    assert_eq!(b.live().len(), 1, "标签实体本身也要过去");
    assert_eq!(b.live()[0].1, "读后");
    assert_eq!(
        b.app.store().get_note(&note).unwrap().unwrap().content_hash,
        before.content_hash,
        "对面不该因为收到链接就把正文算成另一份"
    );
    drop(srv);
}

/// 界面上那颗 chip 的读数：`note_tags` 给解析过的活标签 id，`notes.tag_ids` 的原样不上线。
#[test]
fn the_read_side_reports_resolved_links_not_the_raw_column() {
    let dir = Tmp::new("readside");
    let app = App::boot(dir.path()).expect("核心启动");
    let store: &Store = app.store();
    let folder = app.default_folder_id().unwrap();
    let note = store
        .create_note(&folder, doc("blk000001", "芯片"))
        .unwrap()
        .id;
    let a = dispatch(&app, "create_tag", json!({ "title": "甲" })).unwrap();
    let b = dispatch(&app, "create_tag", json!({ "title": "乙" })).unwrap();
    dispatch(
        &app,
        "set_note_tags",
        json!({ "id": note.as_str(), "tagIds": [a["id"], b["id"]] }),
    )
    .expect("设两个标签");
    let out = dispatch(&app, "note_tags", json!({ "id": note.as_str() })).unwrap();
    let mut got: Vec<&str> = out
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![a["id"].as_str().unwrap(), b["id"].as_str().unwrap()],
        "读侧要给的就是那两个活标签"
    );

    // 删掉一颗：链接还写在笔记那一列里（属主记录不改），但读侧不能再出现它。
    dispatch(&app, "delete_tag", json!({ "id": a["id"] })).expect("删标签");
    let out = dispatch(&app, "note_tags", json!({ "id": note.as_str() })).unwrap();
    assert_eq!(
        out.as_array().unwrap().len(),
        1,
        "删掉的标签必须从界面读数里消失，而这不需要任何清理任务"
    );
    assert_eq!(out[0].as_str().unwrap(), b["id"].as_str().unwrap());
    // 计数跟着走：删掉之后剩下那一颗仍然记着这一篇。
    let list = dispatch(&app, "list_tags", json!({})).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1, "列表里只剩活的那颗");
    assert_eq!(list[0]["noteCount"], json!(1));
}

/// 永久删除走的是 `head_select` 那一句 —— 列名写错（拿 `folders.name` 去查 `tags`）
/// 不是"少个字段"，是运行时 no such column，而且只有跑到永久删除这一条才炸。
/// 墓碑上的 `title_snap` 就是那一格的证人（它读的正是 `head_select` 选出来的那一列）。
#[test]
fn a_purged_tag_leaves_its_title_in_the_tombstone() {
    use notera_core::{hash_json, EntityKind};
    use notera_store::ApplyOp;

    let dir = Tmp::new("purge");
    let app = App::boot(dir.path()).expect("核心启动");
    let out = dispatch(&app, "create_tag", json!({ "title": "要永删的标签" })).unwrap();
    let id = EntityId::parse(out["id"].as_str().unwrap()).unwrap();

    // 永久删除的前提在存储层是"这一条已经确认过了"（本机还有未推的改动时它拒绝永删，
    // 交给冲突解决）。没有账户的这一台要手工把确认点抬上去，走的正是引擎 push 成功后那一条边。
    let t = app.store().read_tag(&id).unwrap().unwrap();
    app.store()
        .mark_synced(EntityKind::Tag, &id, t.rev, &t.content_hash)
        .expect("确认点抬上去");

    let rep = app
        .store()
        .apply_remote(&[ApplyOp::Purge {
            kind: EntityKind::Tag,
            id: id.clone(),
        }])
        .expect("标签的永久删除不该炸（head_select 的列名写错就是在这一格炸）");
    assert_eq!(rep.applied, 1, "永久删除要落地：{rep:?}");
    assert!(
        app.store().read_tag(&id).unwrap().is_none(),
        "行必须真的没了，只剩墓碑"
    );
    let tomb = app
        .store()
        .get_tombstone(EntityKind::Tag, &id)
        .unwrap()
        .expect("墓碑要在");
    assert!(tomb.purged, "墓碑得是『永久』那一型，不是软删");
    assert_eq!(
        tomb.title_snap.as_deref(),
        Some("要永删的标签"),
        "title_snap 读的就是 head_select 那一列 —— 空了就说明它拿的是别的表的列名"
    );
    // 复活闸门：同一个 id 再来一次 upsert 必须被具名拒绝（ADR-0006 / I1）。
    // `hash` 要算对，否则先撞上 I6 那道哈希闸门，报的就不是"拒绝复活"这一格了。
    let payload = json!({ "title": "复活尝试" });
    let e = app
        .store()
        .apply_remote(&[ApplyOp::UpsertTag {
            env: json!({
                "protocol": 1, "kind": "tag", "id": id.as_str(), "rev": tomb.rev.get() + 5,
                "hash": hash_json(&payload).as_str(),
                "updated_at": "2026-10-10T00:00:00.000Z", "device": "dev-x",
                "purged": false, "payload": payload,
            }),
        }])
        .expect_err("已永久删除的标签不许被复活");
    assert!(
        e.to_string().contains("拒绝复活"),
        "拒是拒了，但不是那一格拒的：{e}"
    );
}

/// D4 折叠：**两台设备各建同名标签**，必须收敛到同一个 winner，而且
/// **winner 与到达顺序无关**（ADR 验证第 2 条要求正反两个顺序都量）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_devices_converge_to_the_same_winner_whatever_the_arrival_order() {
    let dav = Tmp::new("dav-fold");
    let srv = TestServer::start(Backend::Fs(dav.path().to_path_buf())).await;
    let url = srv.base_url();
    let a = Device::boot("fold-a", &url);
    a.app.sync_once().await.expect("A 入伙");
    let b = Device::boot("fold-b", &url);
    // 两台都先入伙，然后**各自建一颗**：这才叫竞态。
    // （若让 A 先公告，B 入伙时就拿到了那一颗，`create_tag` 走的是幂等命中 —— 那是
    // `the_command_surface_speaks_exactly_the_declared_shape` 钉的格子，不是这里。）
    b.app.sync_once().await.expect("B 入伙");
    let (a_id, _) = a.create_tag("ＦＵＬＬ"); // 全角
    let (b_id, _) = b.create_tag("full"); // 半角小写：canonical 相同，title 不同
                                          // 到达顺序：A 先公告。
    a.settle(10).await;
    // B 在折叠之前就把链接写进一篇笔记 —— 别名改写那一格靠它才量得到（不看库里的裸行）。
    let note = new_note(&b, "挂在输的那一颗上");
    set_links(&b, &note, &[b_id.as_str()]);
    b.settle(10).await;
    a.settle(10).await;
    b.settle(10).await;

    assert_eq!(a.live(), b.live(), "两台的活标签必须一模一样");
    assert_eq!(a.live().len(), 1, "同名要折叠成一颗，不是两颗");
    let winner = a.live()[0].0.clone();
    // A 先建 ⇒ UUIDv7 的字典序在前 ⇒ winner 是 A 那一颗（`min(id)`）。
    assert_eq!(winner, a_id, "winner 该是 id 最小的那一颗");
    assert_ne!(a_id, b_id, "夹具前提：两台建的确实是两个 id");
    // 输的那颗不删行、只记别名，于是**不需要重写任何一篇笔记**（D1 买回来的东西）：
    // B 上那篇笔记的链接里还写着 b_id，读侧必须解析到 winner。
    assert_eq!(
        live_links(&b, &note),
        vec![a_id.clone()],
        "B：链接里的旧 id 要改写到 winner"
    );
    assert_eq!(
        live_links(&a, &note),
        vec![a_id.clone()],
        "A：同一篇笔记在另一台上给同一个答案"
    );
    // 按标签筛列表：那篇笔记的链接里写着的是**输的那颗 id**，按 winner 筛必须命中它
    // （`?5` 那一格同时认 `tk.id` 与 `tk.alias_of` —— 不认别名的话，折叠之后
    //  侧栏点这颗标签会少一篇，而且少的那篇正好是用户自己刚打上的）。
    let by_tag = dispatch(&b.app, "list_notes", json!({ "tagId": a_id, "limit": 500 }))
        .expect("按标签筛不该报错");
    let ids: Vec<&str> = by_tag
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![note.as_str()],
        "按 winner 筛要命中那条写着别名 id 的链接"
    );
    // 对照臂（这条筛**不许**命中）：另一颗活标签。少了这一发，"WHERE 被写成恒真"
    // 那种坏法照样是全绿 —— 同一份文件里两格互相抵消的断言不算判据。
    let (other, _) = b.create_tag("另一个");
    let not_this = dispatch(
        &b.app,
        "list_notes",
        json!({ "tagId": other, "limit": 500 }),
    )
    .unwrap();
    assert!(
        not_this.as_array().unwrap().is_empty(),
        "另一颗标签不该把这篇也筛出来：{not_this}"
    );
    drop(srv);
}

/// 上面那条的反序：B 先把自己那一颗推上去，A 后到 —— winner 不许变。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_devices_converge_to_the_same_winner_with_the_arrival_order_reversed() {
    let dav = Tmp::new("dav-rev");
    let srv = TestServer::start(Backend::Fs(dav.path().to_path_buf())).await;
    let url = srv.base_url();
    let a = Device::boot("revorder-a", &url);
    a.app.sync_once().await.expect("A 入伙");
    let (a_id, _) = a.create_tag("ＦＵＬＬ");

    let b = Device::boot("revorder-b", &url);
    b.app.sync_once().await.expect("B 入伙");
    let (b_id, _) = b.create_tag("full");
    let note = new_note(&b, "反序那台的链接");
    set_links(&b, &note, &[b_id.as_str()]);
    // 顺序反过来：先让 B 公告，再让 A 公告。
    b.settle(10).await;
    a.settle(10).await;
    b.settle(10).await;
    a.settle(10).await;

    assert_eq!(a.live(), b.live(), "两个方向到达，终态要相同");
    assert_eq!(a.live().len(), 1);
    assert_eq!(
        a.live()[0].0,
        a_id,
        "winner 只看 id（创建顺序），不许被到达顺序带跑：A={a_id} B={b_id}"
    );
    // 这一台的链接是**先公告**的那一颗 —— 它后来变成输家，读侧照样要给 winner。
    assert_eq!(live_links(&b, &note), vec![a_id], "反序到达也要改写对");
    drop(srv);
}

/// 改名传播（验证第 3 条）：对面拿到之后旧名不再出现在列表里。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rename_reaches_the_other_device_and_the_old_name_is_gone() {
    let dav = Tmp::new("dav-ren");
    let srv = TestServer::start(Backend::Fs(dav.path().to_path_buf())).await;
    let url = srv.base_url();
    let a = Device::boot("ren-a", &url);
    a.app.sync_once().await.expect("A 入伙");
    let (id, _) = a.create_tag("旧名");
    a.settle(10).await;

    let b = Device::boot("ren-b", &url);
    b.settle(10).await;
    assert_eq!(
        b.live(),
        vec![(id.clone(), "旧名".to_string())],
        "B 先要拿到旧名"
    );

    dispatch(&a.app, "rename_tag", json!({ "id": id, "title": "新名" })).expect("改名");
    a.settle(10).await;
    b.settle(10).await;
    assert_eq!(
        b.live(),
        vec![(id.clone(), "新名".to_string())],
        "改名要传播"
    );
    // id 没变 ⇒ 链接一处都不用重写，这正是 D1 买回来的东西。
    assert_eq!(a.live(), b.live());
    drop(srv);
}

/// 删除期间迟到的链接（验证第 4 条）：不许复活死标签，也不许多长出第二颗同名标签。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_link_cannot_resurrect_a_deleted_tag() {
    let dav = Tmp::new("dav-late");
    let srv = TestServer::start(Backend::Fs(dav.path().to_path_buf())).await;
    let url = srv.base_url();
    let a = Device::boot("late-a", &url);
    a.app.sync_once().await.expect("A 入伙");
    let (id, _) = a.create_tag("迟到的");
    a.settle(10).await;

    let b = Device::boot("late-b", &url);
    b.settle(10).await;
    // B 在**还不知道标签被删**的时候写下一篇带旧 id 的笔记（离线写作的形状）。
    let note = new_note(&b, "离线写的那一篇");
    set_links(&b, &note, &[id.as_str()]);

    // A 删掉那颗标签并先公告。
    dispatch(&a.app, "delete_tag", json!({ "id": id })).expect("删标签");
    a.settle(10).await;
    // B 后到：链接里写着一个已删的 id。
    b.settle(10).await;
    a.settle(10).await;
    b.settle(10).await;

    assert!(
        a.live().is_empty() && b.live().is_empty(),
        "死标签不许复活：{}/{}",
        a.live().len(),
        b.live().len()
    );
    assert_eq!(a.live(), b.live(), "两台的活标签集合要相同");
    // 那颗链接变成"看不见的引用"：读侧解析为空，而不是凭空多出一颗同名标签。
    assert!(live_links(&a, &note).is_empty(), "读侧不能再给一个死标签");
    assert!(live_links(&b, &note).is_empty(), "读侧不能再给一个死标签");
    // 而且**不许多长出第二颗同名标签**：两台上按标题都问不出新的一颗。
    for dev in [&a, &b] {
        assert!(
            dev.live().is_empty(),
            "迟到链接把死标签复活了：{}",
            dev.live().len()
        );
        let again = dispatch(&dev.app, "list_tags", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        assert!(
            again.is_empty(),
            "界面上不能因为一条迟到链接多出一颗 chip：{again:?}"
        );
    }
    drop(srv);
}
