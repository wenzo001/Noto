//! 引擎行为测试：用内存假端口跑真实 `run_round`，断言 SYNC-PROTOCOL 的规范性质。
//!
//! 价值在于"引擎确实按协议走"，而不是"某个纯函数返回了预期值"。
//! 假端口内部状态走 Arc，因此既能把所有权交给引擎、又能在事后断言。

use async_trait::async_trait;
use notera_sync::manifest::{EntryRef, Manifest, SegmentRef, Window};
use notera_sync::plan::{Decision, LocalView, RemoteView};
use notera_sync::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn path(kind: &str, id: &str) -> String {
    format!("{kind}/{id}")
}

// ------------------------------------------------------------------ 远端 ---

#[derive(Clone, Default)]
struct FakeRemote {
    requests: Arc<AtomicU32>,
    manifest: Arc<Mutex<Option<Vec<u8>>>>,
    etag: Arc<Mutex<Option<String>>>,
    records: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// 注入用：让服务器**只对名单里那一条**回"这一份我收不下"（`Protocol` = 单条的确定性拒收）。
    /// 毒丸那一族的现场必须能按 id 造 —— 只会"所有调用都失败"的那枚开关测的是停轮，不是隔离。
    reject_ids: Arc<Mutex<Vec<String>>>,
    segments: Arc<Mutex<BTreeMap<String, Vec<EntryRef>>>>,
    cas_failures: Arc<AtomicU32>,
    corrupt_manifest: Arc<AtomicBool>,
    /// 让所有调用返回 401，用于验证"认证失败必须停轮"
    deny_auth: Arc<AtomicBool>,
    /// §11.4：pretend 别人贴着的租约
    leases: Arc<Mutex<Vec<PeerLease>>>,
    /// 本机贴出去的每一租约（token, expires_at）
    publishes: Arc<Mutex<Vec<(String, String)>>>,
    fail_publish: Arc<AtomicBool>,
    /// 读别人的租约直接报错（模拟列目录能力坏掉 / 离线）
    fail_holders: Arc<AtomicBool>,
    /// 「按停」这一位，与 `EngineConfig.cancel` 共享同一枚（测试用它做"跑到第 N 次请求时用户按了停"）
    cancel: CancelToken,
    /// 第几次远端调用之后把 `cancel` 按下去；0 = 永不（绝大多数测试）
    cancel_after: Arc<AtomicU32>,
}

#[async_trait]
impl RemotePort for FakeRemote {
    async fn fetch_manifest(
        &self,
        etag: Option<&str>,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, RemoteError> {
        self.tick()?;
        let body = self.manifest.lock().unwrap().clone();
        let cur = self.etag.lock().unwrap().clone();
        let Some(body) = body else { return Ok(None) };
        if etag.is_some() && etag == cur.as_deref() {
            return Ok(None); // 304：0 字节正文
        }
        let out = if self.corrupt_manifest.load(Ordering::SeqCst) {
            let mut bad = body.clone();
            let n = bad.len() / 2;
            bad[n] = b'X';
            bad
        } else {
            body
        };
        Ok(Some((out, cur)))
    }
    async fn fetch_segment(&self, name: &str) -> Result<Vec<EntryRef>, RemoteError> {
        self.tick()?;
        Ok(self
            .segments
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .unwrap_or_default())
    }
    async fn fetch_record(&self, kind: &str, id: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        self.tick()?;
        Ok(self.records.lock().unwrap().get(&path(kind, id)).cloned())
    }
    async fn put_record(
        &self,
        kind: &str,
        id: &str,
        wire: &[u8],
        _if_match: Option<&str>,
    ) -> Result<Commit, RemoteError> {
        self.tick()?;
        if self
            .reject_ids
            .lock()
            .unwrap()
            .iter()
            .any(|r| r == &path(kind, id))
        {
            return Err(RemoteError::Protocol("夹具：这一条服务器不收".into()));
        }
        self.records
            .lock()
            .unwrap()
            .insert(path(kind, id), wire.to_vec());
        Ok(Commit {
            etag: Some(format!("\"{id}-v1\"")),
            verified: true,
        })
    }
    async fn commit_manifest(
        &self,
        wire: &[u8],
        cas_etag: Option<&str>,
    ) -> Result<Option<String>, RemoteError> {
        self.tick()?;
        if self.cas_failures.load(Ordering::SeqCst) > 0 {
            self.cas_failures.fetch_sub(1, Ordering::SeqCst);
            return Err(RemoteError::Precondition);
        }
        let cur = self.etag.lock().unwrap().clone();
        if cur.is_some() && cas_etag != cur.as_deref() {
            return Err(RemoteError::Precondition);
        }
        *self.manifest.lock().unwrap() = Some(wire.to_vec());
        let fresh = format!("\"blob-{}\"", wire.len());
        *self.etag.lock().unwrap() = Some(fresh.clone());
        Ok(Some(fresh))
    }
    async fn put_segment(&self, name: &str, wire: &[u8]) -> Result<(), RemoteError> {
        self.tick()?;
        let entries: Vec<EntryRef> = serde_json::from_slice(wire).unwrap_or_default();
        self.segments.lock().unwrap().insert(name.into(), entries);
        Ok(())
    }
    async fn probe_record_etag(&self, kind: &str, id: &str) -> Result<Option<String>, RemoteError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .contains_key(&path(kind, id))
            .then(|| format!("\"{id}-v0\"")))
    }

    async fn lease_publish(
        &self,
        token: &str,
        expires_at: &str,
        _seq: u64,
    ) -> Result<(), RemoteError> {
        self.tick()?;
        if self.fail_publish.load(Ordering::SeqCst) {
            return Err(RemoteError::Server);
        }
        self.publishes
            .lock()
            .unwrap()
            .push((token.to_string(), expires_at.to_string()));
        Ok(())
    }

    async fn lease_holders(&self, _known: &[String]) -> Result<Vec<PeerLease>, RemoteError> {
        if self.fail_holders.load(Ordering::SeqCst) {
            return Err(RemoteError::Server);
        }
        Ok(self.leases.lock().unwrap().clone())
    }
}

impl FakeRemote {
    fn tick(&self) -> Result<(), RemoteError> {
        let n = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        // 「用户在这一轮跑到第 after 次远端调用时按了停」——取消是**外部**发生的事，
        // 所以这一位由端口按下，测试只在事后读结果。0 = 永不按下。
        let after = self.cancel_after.load(Ordering::SeqCst);
        if after > 0 && n >= after {
            self.cancel.request();
        }
        if self.deny_auth.load(Ordering::SeqCst) {
            return Err(RemoteError::Auth);
        }
        Ok(())
    }
    fn seed(&self, m: Manifest) {
        *self.manifest.lock().unwrap() = Some(m.to_wire());
        *self.etag.lock().unwrap() = Some("\"m0\"".into());
    }
    fn etag(&self) -> Option<String> {
        self.etag.lock().unwrap().clone()
    }
    fn req(&self) -> u32 {
        self.requests.load(Ordering::SeqCst)
    }
    fn manifest_bytes(&self) -> Vec<u8> {
        self.manifest.lock().unwrap().clone().unwrap_or_default()
    }
}

// ------------------------------------------------------------------ 本地 ---

#[derive(Clone, Default)]
struct FakeLocal {
    locals: Arc<Mutex<Vec<LocalView>>>,
    cached: Arc<Mutex<Vec<RemoteView>>>,
    seg_hashes: Arc<Mutex<BTreeMap<String, String>>>,
    seq: Arc<AtomicU64>,
    applied: Arc<Mutex<Vec<ApplyOp>>>,
    conflicts: Arc<Mutex<Vec<(String, String)>>>,
    envelopes: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    #[allow(dead_code)]
    outbox_states: Arc<Mutex<Vec<(String, OutboxState)>>>,
    /// 毒丸那两格的假账：`poison` = 每**一份内容**（键含 rev）连续被拒到第几次，
    /// `quarantined` = 已被隔离的那些键。故意不复用 `outbox_states`：引擎每一轮会先
    /// `outbox_settle(Failed)` 再记一次失败，两个数挤在同一张表里就会互相灌大。
    poison: Arc<Mutex<BTreeMap<String, u64>>>,
    quarantined: Arc<Mutex<Vec<String>>>,
    cached_manifest: Arc<Mutex<Option<Vec<u8>>>>,
    cached_etag: Arc<Mutex<Option<String>>>,
    /// §11.4：引擎贴完租约后有没有把状态记到本地
    leases: Arc<Mutex<Vec<(String, String)>>>,
    /// 注入用：让本机对 `Upsert` **拒收**（真实世界里对应 `apply` 的"同 rev 不同内容"/I6/I2 那道闸门）。
    /// ADR-0021 D3 要验的正是"拒绝有没有去处"，所以这里必须能造出一次真的拒绝。
    reject_upserts: Arc<AtomicBool>,
    /// 注入用：让本机对**远端删除的落库**（`Tombstone` 软删 / `Purge` 永久删）拒收。
    /// 引擎里那一处以前是 `let _ =`，这条判据钉的就是"拒绝到底有没有去处"（ADR-0021 D3 的最后一格）。
    reject_tombstones: Arc<AtomicBool>,
    /// 注入用：让本机按 host 的 `kind_slot` 同一规矩**逐条具名拒收**认不出的类型标记，
    /// 并把条数与原因写在 `ApplyReport.rejected/reason` 上。
    /// 这一格存在的唯一理由：`rejected` 自被造出来起**零读者**（ADR-0022 D7 ①），
    /// 没有读者的那个数不算账 —— 所以这里要能造出"落库拒了但整批没失败"的形状给引擎读。
    report_unknown_kinds: Arc<AtomicBool>,
    /// §4.3 / G87：宿主这一侧要不要把这一轮挡下来。
    hold: Arc<AtomicBool>,
}

impl LocalPort for FakeLocal {
    fn account_id(&self) -> String {
        "acct".into()
    }
    fn device_id(&self) -> String {
        "dev-1".into()
    }
    fn now(&self) -> String {
        "2026-09-25T00:00:00.000Z".into()
    }
    fn local_views(&self) -> Result<Vec<LocalView>, LocalError> {
        Ok(self.locals.lock().unwrap().clone())
    }
    fn cached_remote(&self) -> Result<Vec<RemoteView>, LocalError> {
        Ok(self.cached.lock().unwrap().clone())
    }
    fn cached_segment_hashes(&self) -> BTreeMap<String, String> {
        self.seg_hashes.lock().unwrap().clone()
    }
    fn seq_applied(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
    fn record_lease(&self, token: &str, expires_at: &str) -> Result<(), LocalError> {
        self.leases
            .lock()
            .unwrap()
            .push((token.to_string(), expires_at.to_string()));
        Ok(())
    }
    fn revision_json(&self, _id: &str, _rev: u64) -> Result<Option<serde_json::Value>, LocalError> {
        Ok(None)
    }
    fn envelope_wire(&self, kind: &str, id: &str) -> Result<Option<Vec<u8>>, LocalError> {
        Ok(self.envelopes.lock().unwrap().get(&path(kind, id)).cloned())
    }
    fn apply(&self, ops: Vec<ApplyOp>) -> Result<ApplyReport, LocalError> {
        let n = ops.len();
        if self.reject_upserts.load(Ordering::SeqCst)
            && ops.iter().any(|o| matches!(o, ApplyOp::Upsert { .. }))
        {
            return Err(LocalError::Storage(
                "注入：本机拒收这一版（同 rev 不同内容）".into(),
            ));
        }
        if self.reject_tombstones.load(Ordering::SeqCst)
            && ops
                .iter()
                .any(|o| matches!(o, ApplyOp::Tombstone { .. } | ApplyOp::Purge { .. }))
        {
            return Err(LocalError::Storage(
                "注入：本机不接受这条删除（那一行在删除之后又被编辑过）".into(),
            ));
        }
        // 与 host `kind_slot` 同一规矩的模拟：认不出的标记 ⇒ **逐条**具名拒收，同批其余照旧落库。
        // 注意这里返回的是 `Ok` —— 这一格要造的正是"批里一条被拒、整批没失败"的形状，
        // 因为引擎从前只在 `Err` 那条路上记账。
        let unknown: Vec<String> = if self.report_unknown_kinds.load(Ordering::SeqCst) {
            ops.iter()
                .filter_map(|o| match o {
                    ApplyOp::Purge { kind, id } | ApplyOp::Tombstone { kind, id, .. }
                        if !matches!(kind.as_str(), "n" | "f" | "a") =>
                    {
                        Some(format!("未知的实体类型标记: {kind}（{id}）"))
                    }
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        };
        for o in &ops {
            // 引擎提交成功后写回缓存清单，下一轮 304 才有的可回落
            if let ApplyOp::StoreManifest { wire, etag, .. } = o {
                *self.cached_manifest.lock().unwrap() = Some(wire.clone());
                *self.cached_etag.lock().unwrap() = etag.clone();
            }
        }
        self.applied.lock().unwrap().extend(ops);
        Ok(ApplyReport {
            applied: n - unknown.len(),
            rejected: unknown.len(),
            reason: unknown.last().cloned(),
        })
    }
    fn record_conflict(
        &self,
        d: &Decision,
        _l: &LocalView,
        _r: &RemoteView,
    ) -> Result<(), LocalError> {
        self.conflicts.lock().unwrap().push(d.key.clone());
        Ok(())
    }
    fn outbox_take(&self, _limit: usize) -> Result<Vec<OutboxItem>, LocalError> {
        Ok(Vec::new())
    }
    fn outbox_is_blocked(&self, kind: &str, id: &str, rev: u64) -> Result<bool, LocalError> {
        let key = format!("{kind}:{id}:{rev}");
        Ok(self.quarantined.lock().unwrap().iter().any(|k| k == &key))
    }
    fn outbox_note_failure(
        &self,
        kind: &str,
        id: &str,
        rev: u64,
        _reason: &str,
    ) -> Result<u64, LocalError> {
        let key = format!("{kind}:{id}:{rev}");
        let mut g = self.poison.lock().unwrap();
        let n = g.entry(key).and_modify(|v| *v += 1).or_insert(1);
        Ok(*n)
    }
    fn outbox_quarantine(&self, kind: &str, id: &str, rev: u64) -> Result<(), LocalError> {
        self.quarantined
            .lock()
            .unwrap()
            .push(format!("{kind}:{id}:{rev}"));
        Ok(())
    }
    fn outbox_settle(
        &self,
        kind: &str,
        id: &str,
        rev: u64,
        st: OutboxState,
    ) -> Result<(), LocalError> {
        self.outbox_states
            .lock()
            .unwrap()
            .push((format!("{kind}:{id}:{rev}"), st));
        Ok(())
    }
    fn holds_divergence(&self, _cached: usize, _received: usize, _etag: &str) -> bool {
        self.hold.load(Ordering::SeqCst)
    }

    fn cached_manifest(&self) -> Option<Vec<u8>> {
        self.cached_manifest.lock().unwrap().clone()
    }
}

// ----------------------------------------------------------------- 夹具 ---

fn local(id: &str, rev: u64, sync_rev: u64, hash: &str) -> LocalView {
    LocalView {
        kind: "n".into(),
        id: id.into(),
        rev,
        sync_rev,
        sync_hash: Some(format!("sha256:{hash}")),
        content_hash: format!("sha256:{hash}"),
        deleted_at: None,
        purged_at: None,
        edited_after_delete: false,
        decided_remote: None,
    }
}

fn ent(i: &str, r: u64, h: &str) -> EntryRef {
    EntryRef {
        i: i.into(),
        t: "n".into(),
        r,
        h: h.into(),
        s: 40,
        d: None,
        p: 0,
    }
}

fn base_manifest() -> Manifest {
    Manifest::initial("root", "dev-1", "2026-09-25T00:00:00.000Z", "notera test")
}

async fn run(l: FakeLocal, r: FakeRemote, etag: Option<&str>) -> (RoundStats, Vec<SyncEvent>) {
    SyncEngine::new(l, r, EngineConfig::default())
        .run_round(etag)
        .await
}
async fn run_with(
    l: FakeLocal,
    r: FakeRemote,
    etag: Option<&str>,
    cfg: EngineConfig,
) -> (RoundStats, Vec<SyncEvent>) {
    SyncEngine::new(l, r, cfg).run_round(etag).await
}

/// 毒丸隔离（采纳清单 §3 第 109 行 / SYNC-PROTOCOL §12 的"连续拒收 ⇒ 隔离"那一档）。
///
/// 这一族钉的是**发送那一侧真的停了**，不是"库里那一行改了状态"：计划器按 `dirty` 规划、
/// 完全不看 outbox 表，所以"写了 `blocked` 却在循环里没跳过"这种实现会在这里红 ——
/// 而它恰好是那种"设置页数字掉了、请求照旧每轮白烧"的坏法。
/// `poison` 那本假账就是这把尺：它只在**一发 PUT 真被拒**时才 +1。
#[tokio::test]
async fn a_record_rejected_three_times_stops_being_pushed() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.reject_ids.lock().unwrap().push("n/p1".into());
    dirty_local(&l, "p1", 3, "aaaa");

    // 第 1 轮：这一发真出门了，也真被拒了。**这条断言是前置条件**：
    // 如果夹具没让这一条进入 push（信封缺失、计划没选它），下面每一条都会"空对空绿"。
    let (st1, _) = run(l.clone(), r.clone(), None).await;
    assert_eq!(
        st1.outcome,
        RoundOutcome::Failed,
        "Protocol 照旧要停轮，这一轮不许被折成成功"
    );
    assert_eq!(
        l.poison.lock().unwrap().get("n:p1:3").copied(),
        Some(1),
        "第一轮必须真的发过那一发 PUT（没发过 = 下面全是没有靶子的判据）"
    );
    assert!(
        l.quarantined.lock().unwrap().is_empty(),
        "一发就隔离太急：抖动一次不该关掉一条改动"
    );

    run(l.clone(), r.clone(), None).await;
    assert_eq!(l.poison.lock().unwrap().get("n:p1:3").copied(), Some(2));
    assert!(
        l.quarantined.lock().unwrap().is_empty(),
        "两发就隔离仍然太早（闸门是 3）"
    );

    run(l.clone(), r.clone(), None).await;
    assert_eq!(l.poison.lock().unwrap().get("n:p1:3").copied(), Some(3));
    assert!(
        l.quarantined.lock().unwrap().iter().any(|k| k == "n:p1:3"),
        "连续第三发被拒 ⇒ 这一条必须被隔离（键是 kind:id:rev，按内容而非按实体）"
    );

    // 第 4 轮：决定性的一条 —— **没有再发**。发了就会被拒并被记成第 4 次，所以计数停在 3
    // 就是"这一发根本没出门"的读数（打在调用边上，不是打在被调方的绿上）。
    run(l.clone(), r.clone(), None).await;
    assert_eq!(
        l.poison.lock().unwrap().get("n:p1:3").copied(),
        Some(3),
        "隔离之后第四轮不许再对同一份内容发 PUT（计数还在长 = 每轮照旧白烧一发）"
    );
}

/// 一颗毒丸拖住的是**整轮**：`Protocol` 落进 `halts_round()`，于是它后面那些正常的改动
/// 一起推不出去。隔离生效之后，那些改动要照常走完 —— 这一条钉的就是"别人的活没被它带走"。
#[tokio::test]
async fn a_quarantined_record_stops_holding_up_the_rest_of_the_round() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.reject_ids.lock().unwrap().push("n/a-bad".into());
    // 键按字典序：`a-bad` 排在 `b-good` 前面，所以前三轮 good 一直在被牵连的那一侧。
    dirty_local(&l, "a-bad", 2, "cccc");
    dirty_local(&l, "b-good", 5, "dddd");

    for _ in 0..3 {
        run(l.clone(), r.clone(), None).await;
    }
    // 先钉"被牵连"这一半：闸门到第三发才落下，而那一发自己仍要停轮（§12 的 `halts_round` 没改）。
    // 少了这条，下面那条"第四轮就好了"可能一直是好的对照 —— 那就等于没有对照。
    assert!(
        !r.records.lock().unwrap().contains_key("n/b-good"),
        "对照臂：毒丸还在的时候，同一轮里排在后面的那条**就该**被拖住（这条要是绿了，下面那条就是空判据）"
    );
    assert!(
        l.quarantined
            .lock()
            .unwrap()
            .iter()
            .any(|k| k == "n:a-bad:2"),
        "靶子没立起来（bad 没被隔离）⇒ 这一条改的是没有靶子的判据"
    );

    // 第四轮：毒丸不再出门 ⇒ 同一轮里那些正常的改动要走完。这一条钉的就是台账上那句
    // "一条永久被服务器拒的记录不该拖住整条队列"。
    let (st4, _) = run(l.clone(), r.clone(), None).await;
    assert!(
        r.records.lock().unwrap().contains_key("n/b-good"),
        "隔离生效之后，同轮的另一条必须真的落上服务器（还拖着 = 只改了库里的状态，没改发送那一侧）"
    );
    assert_ne!(
        st4.outcome,
        RoundOutcome::Failed,
        "第四轮不该再被那一颗毒丸判成失败"
    );
    assert_eq!(
        l.poison.lock().unwrap().get("n:a-bad:2").copied(),
        Some(3),
        "隔离之后连那一发的失败记录都不许再加（加了 = 又发了一次）"
    );
}

/// 隔离的是"这一份内容推不出去"，不是"这篇笔记从此不许再同步"。
/// 用户之后又改了一次（新的 `payload_rev`、出箱里是另一行）⇒ 那一行照旧要能上行。
#[tokio::test]
async fn a_newer_edit_after_a_quarantine_is_pushed_again() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.reject_ids.lock().unwrap().push("n/p1".into());
    dirty_local(&l, "p1", 3, "aaaa");
    for _ in 0..3 {
        run(l.clone(), r.clone(), None).await;
    }
    assert!(l.quarantined.lock().unwrap().iter().any(|k| k == "n:p1:3"));

    // 服务器开始收这一条了（用户改了内容 ⇒ 新的 rev）；按实体问的写法会在这里把新行也关掉。
    r.reject_ids.lock().unwrap().clear();
    dirty_local(&l, "p1", 4, "eeee");
    run(l.clone(), r.clone(), None).await;
    assert!(
        r.records.lock().unwrap().contains_key("n/p1"),
        "rev 4 那一版必须能上行：旧那一版被隔离不许把用户下一次编辑一起禁死"
    );
    assert_eq!(
        l.poison.lock().unwrap().get("n:p1:4").copied(),
        None,
        "新那一行是干净的：它不许继承旧内容那 3 次失败"
    );
}

/// 取消（任务 #4 第一件）。三条各钉一件事，缺一条就留一个洞：
///  ① 停下来 ⇒ `outcome = Cancelled`，而且作为**事件**报出去（界面读的是事件流折叠的徽标）；
///  ② 不许虚报 ⇒ 只有真落到服务器上的那几件才算 `pushed`；
///  ③ 不许落账 ⇒ 索引 `seq` 一律不记"已应用"。③ 是三条里最贵的：记了之后下一轮清单一个
///     304 就判"无事可做"，没推上去的那几件**永远没人管** —— 与 `round_request_cap` 截断
///     是同一个洞的两半形状（`notera-host/tests/late_device.rs` 钉过前一半）。
#[tokio::test]
async fn a_cancel_pressed_before_the_loops_stops_the_round_and_claims_nothing() {
    let l = FakeLocal::default();
    dirty_local(&l, "p1", 3, "aaaa");
    dirty_local(&l, "p2", 4, "bbbb");
    let cancel = CancelToken::default();
    let r = FakeRemote::default();
    r.seed(base_manifest());
    cancel.request(); // 本轮一开始就已经被按停
    let cfg = EngineConfig {
        cancel: cancel.clone(),
        ..EngineConfig::default()
    };
    let (st, evs) = run_with(l.clone(), r.clone(), None, cfg).await;
    assert_eq!(
        st.outcome,
        RoundOutcome::Cancelled,
        "按停的这一轮要如实报停：{st:?}"
    );
    assert_eq!(st.pushed, 0, "按停之后一件都不许再动");
    assert!(r.records.lock().unwrap().is_empty(), "一件都不许上行");
    assert!(
        evs.contains(&SyncEvent::Completed(RoundOutcome::Cancelled)),
        "取消必须是发出去的事件，不能只藏在 stats 里：{evs:?}"
    );
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::SetRemote { kind, .. } if kind == "seq")),
        "被停的这一轮不许把索引记成已应用"
    );
}

#[tokio::test]
async fn a_cancel_pressed_mid_round_keeps_what_landed_and_stops_the_rest() {
    let l = FakeLocal::default();
    for (id, rev, h) in [("p1", 3u64, "aaaa"), ("p2", 4, "bbbb"), ("p3", 5, "cccc")] {
        dirty_local(&l, id, rev, h);
    }
    let cancel = CancelToken::default();
    let r = FakeRemote {
        cancel: cancel.clone(),
        cancel_after: Arc::new(AtomicU32::new(3)),
        ..Default::default()
    };
    r.seed(base_manifest());
    let cfg = EngineConfig {
        cancel,
        ..EngineConfig::default()
    };
    let (st, _evs) = run_with(l.clone(), r.clone(), None, cfg).await;
    assert_eq!(st.outcome, RoundOutcome::Cancelled, "{st:?}");
    assert!(
        st.pushed < 3,
        "按停之后剩下的那几件必须没做：pushed={}",
        st.pushed
    );
    assert_eq!(
        st.pushed,
        r.records.lock().unwrap().len(),
        "虚报：算成功的件数 ≠ 服务器上真有的件数"
    );
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::SetRemote { kind, .. } if kind == "seq")),
        "半轮停了也不许落 seq 账"
    );
}

/// 对照：同一份现场**没人按停** ⇒ 三件全上去、索引落账。
/// 少了这一发，上面两条的"pushed < 3"与"没有 SetRemote"可能只是夹具本身跑不动。
#[tokio::test]
async fn the_same_round_without_a_cancel_pushes_everything_and_books_the_seq() {
    let l = FakeLocal::default();
    for (id, rev, h) in [("p1", 3u64, "aaaa"), ("p2", 4, "bbbb"), ("p3", 5, "cccc")] {
        dirty_local(&l, id, rev, h);
    }
    let r = FakeRemote::default();
    r.seed(base_manifest());
    let (st, _evs) = run(l.clone(), r.clone(), None).await;
    assert_eq!(st.pushed, 3, "对照必须真的把三件都推上去：{st:?}");
    assert_eq!(r.records.lock().unwrap().len(), 3);
    assert!(
        l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::SetRemote { kind, .. } if kind == "seq")),
        "正常收敛的这一轮就该落 seq 账"
    );
}

/// §11.4 的开关。FakeLocal 的 now() 固定在 2026-09-25T00:00:00Z，
/// 所以测试里的"新鲜/过期"都以它为基准，不碰墙上时间。
fn lease_cfg() -> EngineConfig {
    EngineConfig {
        lease: LeasePolicy::On { ttl_ms: 60_000 },
        ..EngineConfig::default()
    }
}

fn dirty_local(l: &FakeLocal, id: &str, rev: u64, hash: &str) {
    l.locals.lock().unwrap().push(local(id, rev, rev - 1, hash));
    l.envelopes
        .lock()
        .unwrap()
        .insert(path("n", id), format!("{{\"rev\":{rev}}}").into_bytes());
}

// ------------------------------------------------------------------ 用例 ---

#[tokio::test]
async fn empty_round_costs_exactly_one_request_and_zero_bytes() {
    // SYNC-PROTOCOL §6.3：空轮必须是 1 请求 0 字节正文。
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    let etag = r.etag();
    let (st, ev) = run(l, r.clone(), etag.as_deref()).await;
    assert_eq!(st.requests, 1, "空轮应恰好 1 请求，实际 {}", st.requests);
    assert_eq!(st.bytes_down, 0, "304 轮不得下载正文");
    assert_eq!(st.bytes_up, 0);
    assert_eq!(st.outcome, RoundOutcome::NoOp);
    assert_eq!(r.req(), 1);
    // 或断言：空轮次允许两种等价形态 —— 要么不发事件，要么发一个 NoOp 完成事件，两种都算「什么都没发生」
    assert!(ev.is_empty() || ev.contains(&SyncEvent::Completed(RoundOutcome::NoOp)));
}

#[tokio::test]
async fn local_edit_is_pushed_then_announced_in_manifest() {
    let l = FakeLocal::default();
    l.locals.lock().unwrap().push(local("n1", 3, 2, "aaaa"));
    l.envelopes
        .lock()
        .unwrap()
        .insert(path("n", "n1"), b"{\"rev\":3}".to_vec());
    let r = FakeRemote::default();
    r.seed(base_manifest());
    let etag = r.etag();
    let (st, _) = run(l.clone(), r.clone(), etag.as_deref()).await;

    assert_eq!(st.pushed, 1, "本地脏实体必须上传");
    assert!(
        r.records.lock().unwrap().contains_key("n/n1"),
        "记录必须先于清单落远端（R2）"
    );
    let m = Manifest::parse(&r.manifest_bytes()).expect("提交后的清单必须自校验通过");
    assert!(
        m.window.entries.iter().any(|x| x.i == "n1" && x.r == 3),
        "窗口应公告该变更"
    );
    assert!(m.seq > 1, "seq 必须前进");
    assert!(
        l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::MarkSynced { rev: 3, .. })),
        "上传成功须记 synced"
    );
}

#[tokio::test]
async fn remote_new_note_is_pulled_and_applied() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![ent("remote1", 7, "bbbbbbbbbbbb")],
    };
    m.refresh_checksum();
    r.seed(m);
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "remote1"), b"{\"rev\":7}".to_vec());
    // 首轮没有已知 etag：传当前 etag 会得到 304，那是正确行为但测不到 pull。
    let (st, _) = run(l.clone(), r, None).await;
    assert_eq!(st.pulled, 1, "远端新增必须被拉取");
    assert!(
        l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::Upsert { id, .. } if id == "remote1")),
        "拉到的记录必须交给 apply"
    );
}

#[tokio::test]
async fn corrupt_manifest_never_deletes_local_data() {
    // D1/D2 底线：清单坏了要停轮，绝不能当成"远端是空的"继续。
    let l = FakeLocal::default();
    l.locals.lock().unwrap().push(local("keepme", 1, 1, "aaaa"));
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.corrupt_manifest.store(true, Ordering::SeqCst);
    let (st, ev) = run(l.clone(), r, None).await;
    assert_eq!(st.outcome, RoundOutcome::Failed, "坏清单必须终止本轮");
    assert!(st.requests <= 1, "不得继续刷后续请求，实际 {}", st.requests);
    assert!(
        ev.iter().any(|x| matches!(
            x,
            SyncEvent::Failed {
                retryable: true,
                ..
            }
        )),
        "应给出可重试失败事件"
    );
    assert!(
        l.applied.lock().unwrap().is_empty(),
        "坏清单情形下不得对本地做任何写入或删除"
    );
}

#[tokio::test]
async fn cas_conflict_is_retried_then_converges() {
    let l = FakeLocal::default();
    l.locals.lock().unwrap().push(local("n1", 4, 2, "cccc"));
    l.envelopes
        .lock()
        .unwrap()
        .insert(path("n", "n1"), b"{\"rev\":4}".to_vec());
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.cas_failures.store(2, Ordering::SeqCst); // 前两次 CAS 被别人抢了
    let etag = r.etag();
    let (st, _) = run(l, r.clone(), etag.as_deref()).await;
    assert_eq!(st.cas_retries, 2, "应重试两次后成功");
    let m = Manifest::parse(&r.manifest_bytes()).unwrap();
    assert!(
        m.window.entries.iter().any(|x| x.i == "n1"),
        "最终清单必须包含本次变更"
    );
}

#[tokio::test]
async fn remote_delete_versus_local_edit_reaches_conflict_inbox() {
    let l = FakeLocal::default();
    l.locals
        .lock()
        .unwrap()
        .push(local("n1", 8, 5, "localhash"));
    let r = FakeRemote::default();
    let mut m = base_manifest();
    let mut del = ent("n1", 9, "remotehash12");
    del.d = Some("2026-09-25T00:00:00.000Z".into());
    m.window.entries = vec![del];
    m.refresh_checksum();
    r.seed(m);
    let (st, ev) = run(l.clone(), r, None).await;
    assert_eq!(st.conflicts, 1, "删除 vs 修改必须计入冲突");
    assert!(ev.contains(&SyncEvent::NeedsConflictAttention));
    assert_eq!(l.conflicts.lock().unwrap().len(), 1);
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::Purge { .. })),
        "冲突情形不得静默永久删除本地"
    );
}

#[tokio::test]
async fn behind_beyond_window_fetches_changed_segments_only() {
    let l = FakeLocal::default();
    l.seq.store(1, Ordering::SeqCst); // 远远落后于窗口
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.segments = vec![SegmentRef {
        n: "seg-0000".into(),
        cover: ["a".into(), "z".into()],
        count: 2,
        hash12: "123456789012".into(),
        bytes: 20,
    }];
    m.window = Window {
        since_seq: 99,
        complete: true,
        entries: vec![],
    };
    m.refresh_checksum();
    r.seed(m);
    r.segments.lock().unwrap().insert(
        "seg-0000".into(),
        vec![ent("s1", 1, "aaaaaaaaaaaa"), ent("s2", 2, "bbbbbbbbbbbb")],
    );
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "s1"), b"{\"i\":\"s1\"}".to_vec());
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "s2"), b"{\"i\":\"s2\"}".to_vec());
    let (st, _) = run(l, r.clone(), None).await;
    assert!(st.requests >= 3, "清单 + 分段 + 两条记录");
    assert_eq!(st.pulled, 2, "分段揭示的两条新笔记都应拉取");
    assert_eq!(r.req(), st.requests, "统计数必须与真实请求数一致");
}

#[tokio::test]
async fn uncached_segment_hash_forces_refetch() {
    let l = FakeLocal::default();
    l.seq.store(1, Ordering::SeqCst);
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.segments = vec![SegmentRef {
        n: "seg-0000".into(),
        cover: ["a".into(), "z".into()],
        count: 1,
        hash12: "newhash12345".into(),
        bytes: 10,
    }];
    m.window = Window {
        since_seq: 99,
        complete: true,
        entries: vec![],
    };
    m.refresh_checksum();
    r.seed(m);
    r.segments
        .lock()
        .unwrap()
        .insert("seg-0000".into(), vec![ent("s9", 1, "cccccccccccc")]);
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "s9"), b"{}".to_vec());
    // 缓存里是同名的旧 hash → 必须重拉
    l.seg_hashes
        .lock()
        .unwrap()
        .insert("seg-0000".into(), "oldhash12345".into());
    let (st, _) = run(l, r.clone(), None).await;
    assert!(st.pulled >= 1, "hash 变化必须触发分段重取");
    assert!(r.req() >= 3);
}

#[tokio::test]
async fn auth_failure_halts_round_and_reports_reauth() {
    let l = FakeLocal::default();
    l.locals.lock().unwrap().push(local("n1", 2, 1, "dddd"));
    l.envelopes
        .lock()
        .unwrap()
        .insert(path("n", "n1"), b"{\"rev\":2}".to_vec());
    let r = FakeRemote::default();
    r.seed(base_manifest());
    r.deny_auth.store(true, Ordering::SeqCst);
    let (st, ev) = run(l, r.clone(), None).await;
    assert_eq!(st.outcome, RoundOutcome::Failed);
    assert_eq!(r.req(), 1, "401 必须停轮，不得继续刷请求，实际 {}", r.req());
    assert!(ev.iter().any(|x| matches!(
        x,
        SyncEvent::Failed {
            retryable: false,
            message_key: "sync.auth_required"
        }
    )));
}

#[tokio::test]
async fn no_push_means_no_manifest_commit() {
    // 纯拉取轮次不得重写清单（省一次 CAS 与一轮流量）
    let l = FakeLocal::default();
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![ent("only", 1, "dddddddddddd")],
    };
    m.refresh_checksum();
    let before = m.to_wire();
    r.seed(m);
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "only"), b"{\"i\":\"only\"}".to_vec());
    let etag = r.etag();
    let (st, _) = run(l, r.clone(), etag.as_deref()).await;
    assert_eq!(st.pushed, 0);
    assert_eq!(r.manifest_bytes(), before, "无本地写入时清单必须原样不动");
}

// ---------------------------------------------------------------- §11.4 租约 ---

#[tokio::test]
async fn an_enabled_lease_is_published_before_the_round_reads_anything() {
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    let etag = r.etag();
    let (st, _) = run_with(l.clone(), r.clone(), etag.as_deref(), lease_cfg()).await;
    assert_eq!(
        r.publishes.lock().unwrap().len(),
        1,
        "开了租约就得贴自己的，否则别人看不见我"
    );
    let (token, expires) = &r.publishes.lock().unwrap()[0];
    assert!(!token.is_empty());
    assert!(
        expires.ends_with('Z'),
        "过期时刻得是可解析的时间串：{expires}"
    );
    assert_eq!(
        l.leases.lock().unwrap().len(),
        1,
        "贴上的租约要记进本地状态（sync_state 的那两列）"
    );
    assert_eq!(
        st.outcome,
        RoundOutcome::NoOp,
        "空轮不该因为租约变成别的结论"
    );
}

#[tokio::test]
async fn a_fresh_peer_lease_defers_the_announcement_but_keeps_the_upload() {
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    dirty_local(&l, "n1", 3, "aaaa");
    // 别人（不是 dev-1）还新鲜
    r.leases.lock().unwrap().push(PeerLease {
        device: "dev-2".into(),
        expires_at: "2099-01-01T00:00:00.000Z".into(),
        seq: 1,
    });
    let etag = r.etag();
    let (st, ev) = run_with(l.clone(), r.clone(), etag.as_deref(), lease_cfg()).await;

    assert_eq!(st.pushed, 1, "记录照旧先推上去（清单才是公告板）");
    let m = Manifest::parse(&r.manifest_bytes()).expect("清单仍要可解析");
    assert!(
        !m.window.entries.iter().any(|x| x.i == "n1"),
        "让路时**不能**提交清单，否则并发公告互相覆盖"
    );
    assert_eq!(m.seq, 1, "seq 不该前进，实际 {}", m.seq);
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::MarkSynced { .. })),
        "没公告就不能把改动标成已同步 —— 那会变成静默丢失",
    );
    assert!(
        ev.contains(&SyncEvent::Deferred {
            device: "dev-2".into()
        }),
        "让路必须让用户看得见：{ev:?}"
    );
    assert_eq!(st.outcome, RoundOutcome::Partial);
}

#[tokio::test]
async fn an_expired_or_self_owned_lease_does_not_block_the_announcement() {
    for (label, lease) in [
        (
            "过期了（设备崩溃留下的那份）",
            PeerLease {
                device: "dev-2".into(),
                expires_at: "2020-01-01T00:00:00.000Z".into(),
                seq: 1,
            },
        ),
        (
            "是自己的",
            PeerLease {
                device: "dev-1".into(),
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                seq: 1,
            },
        ),
        (
            "时间读不出来",
            PeerLease {
                device: "dev-2".into(),
                expires_at: "不是时间".into(),
                seq: 1,
            },
        ),
    ] {
        let (l, r) = (FakeLocal::default(), FakeRemote::default());
        r.seed(base_manifest());
        dirty_local(&l, "n1", 3, "aaaa");
        r.leases.lock().unwrap().push(lease);
        let etag = r.etag();
        let (st, ev) = run_with(l, r.clone(), etag.as_deref(), lease_cfg()).await;
        assert_eq!(st.pushed, 1, "{label}");
        let m = Manifest::parse(&r.manifest_bytes()).expect("清单");
        assert!(
            m.window.entries.iter().any(|x| x.i == "n1"),
            "{label}：这类租约不该挡住公告"
        );
        assert!(
            !ev.iter().any(|e| matches!(e, SyncEvent::Deferred { .. })),
            "{label}"
        );
    }
}

#[tokio::test]
async fn an_unreadable_lease_directory_must_not_stop_the_announcement() {
    // §11.4：读不到别人的租约 = 当作没人持有。这一层坏了绝不能变成"永远不同步"。
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    dirty_local(&l, "n1", 3, "aaaa");
    r.fail_holders.store(true, Ordering::SeqCst);
    let etag = r.etag();
    let (st, ev) = run_with(l, r.clone(), etag.as_deref(), lease_cfg()).await;
    let m = Manifest::parse(&r.manifest_bytes()).expect("清单");
    assert!(
        m.window.entries.iter().any(|x| x.i == "n1"),
        "租约读不出来仍要公告：{st:?} {ev:?}"
    );
    assert!(!ev.iter().any(|e| matches!(e, SyncEvent::Deferred { .. })));
}

#[tokio::test]
async fn a_failed_publish_never_aborts_the_round() {
    // 贴不上自己的租约 = 别人看不见我；本轮该照做，不能因此不同步。
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    dirty_local(&l, "n1", 3, "aaaa");
    r.fail_publish.store(true, Ordering::SeqCst);
    let etag = r.etag();
    let (st, _) = run_with(l.clone(), r.clone(), etag.as_deref(), lease_cfg()).await;
    assert_eq!(st.pushed, 1, "贴不上租约也要照常上传");
    let m = Manifest::parse(&r.manifest_bytes()).expect("清单");
    assert!(
        m.window.entries.iter().any(|x| x.i == "n1"),
        "贴不上租约也要照常公告"
    );
    assert!(r.publishes.lock().unwrap().is_empty());
    assert!(
        l.leases.lock().unwrap().is_empty(),
        "没贴成功就别记本地状态"
    );
}

#[tokio::test]
async fn with_the_lease_off_the_round_touches_no_locks_at_all() {
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    dirty_local(&l, "n1", 3, "aaaa");
    r.leases.lock().unwrap().push(PeerLease {
        device: "dev-2".into(),
        expires_at: "2099-01-01T00:00:00.000Z".into(),
        seq: 1,
    });
    let etag = r.etag();
    let (_, ev) = run(l, r.clone(), etag.as_deref()).await;
    assert!(
        r.publishes.lock().unwrap().is_empty(),
        "没开就不要发任何租约请求（省请求，也省一次误判）"
    );
    let m = Manifest::parse(&r.manifest_bytes()).expect("清单");
    assert!(m.window.entries.iter().any(|x| x.i == "n1"));
    assert!(!ev.iter().any(|e| matches!(e, SyncEvent::Deferred { .. })));
}

#[tokio::test]
async fn a_failed_manifest_commit_leaves_the_edit_pending_so_the_next_round_replays_it() {
    // §11.3 C4：记录已提交、清单未提交 → 清单重放。前提是本地**还没**把自己标成已同步，
    // 否则"重放"无从发生，别的设备就永远看不见这条改动。
    let (l, r) = (FakeLocal::default(), FakeRemote::default());
    r.seed(base_manifest());
    dirty_local(&l, "n1", 3, "aaaa");
    r.cas_failures.store(99, Ordering::SeqCst);
    let etag = r.etag();
    let (st, _) = run(l.clone(), r.clone(), etag.as_deref()).await;

    assert_eq!(st.pushed, 1, "记录该推还是推了");
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::MarkSynced { .. })),
        "公告没成功就不许标 synced —— 这是这一条测试唯一真正要证的东西",
    );
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::StoreManifest { .. })),
        "公告没成功也不该缓存一份新清单"
    );
    assert_eq!(st.outcome, RoundOutcome::Partial, "本轮得如实报『没做完』");
}

/// ADR-0021 D3 的**计数那一半**：本机 apply 拒收一条远端版本时，以前这里是
/// `.unwrap_or_default()` —— 一轮跑完 `st` 全零、界面"已同步"，而库里就是没有这一条。
/// 现在拒绝要有名字：进 `rejections`、留下原因原文，而且不许算成已拉取/已同步。
#[tokio::test]
async fn a_rejected_local_apply_is_counted_and_not_claimed_as_pulled() {
    let l = FakeLocal::default();
    l.reject_upserts.store(true, Ordering::SeqCst);
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![ent("rej1", 7, "bbbbbbbbbbbb")],
    };
    m.refresh_checksum();
    r.seed(m);
    r.records
        .lock()
        .unwrap()
        .insert(path("n", "rej1"), b"{\"rev\":7}".to_vec());

    let (st, evs) = run(l.clone(), r, None).await;
    assert_eq!(st.rejections, 1, "本地拒收必须记一笔：{st:?}");
    // 光有 count 用户还是不知道少的是哪一条（任务 #4 ②）：身份要作为事件出来。
    let named: Vec<(String, String)> = evs
        .iter()
        .filter_map(|e| match e {
            SyncEvent::Rejected { kind, id, .. } => Some((kind.clone(), id.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        named,
        vec![("n".to_string(), "rej1".to_string())],
        "单条那一族要带得上是谁：{evs:?}"
    );
    assert_eq!(st.pulled, 0, "被拒收的那条不许算成已拉取");
    assert!(
        st.last_rejection
            .as_deref()
            .unwrap_or_default()
            .contains("注入"),
        "拒绝的原因要留得下来，不然红了也没地方查：{:?}",
        st.last_rejection
    );
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::MarkSynced { .. })),
        "拒收的那条不许被标成已同步"
    );
}

/// 对面那条删除被**本机**拒收时也不许无声：引擎落墓碑那一处以前是 `let _ = self.local.apply(..)`，
/// 正好把"远端说删了、本机拒收、于是两台都不知道"藏起来（ADR-0021 D3 在这一格的同款形状）。
#[tokio::test]
async fn a_rejected_remote_delete_is_counted_and_not_claimed_as_applied() {
    let l = FakeLocal::default();
    l.reject_tombstones.store(true, Ordering::SeqCst);
    l.locals.lock().unwrap().push(local("d1", 7, 7, "aaaa")); // 干净的一行：rev == sync_rev
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![EntryRef {
            i: "d1".into(),
            t: "n".into(),
            r: 9,
            h: "bbbbbbbbbbbb".into(),
            s: 40,
            d: Some("2026-09-25T00:00:00.000Z".into()),
            p: 0,
        }],
    };
    m.refresh_checksum();
    r.seed(m);

    let (st, evs) = run(l.clone(), r, None).await;
    assert_eq!(st.rejections, 1, "远端删除被本机拒收必须记一笔：{st:?}");
    // 这一族走的是**一批** `tombstone_ops`，引擎说不出批里是哪一条 ⇒ 身份必须留空。
    // 宁可"说不出是哪几条"，也不挑一条来背（指错比不指更坏）。
    let blank: Vec<(String, String)> = evs
        .iter()
        .filter_map(|e| match e {
            SyncEvent::Rejected { kind, id, .. } => Some((kind.clone(), id.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        blank,
        vec![(String::new(), String::new())],
        "批量那一族要老实承认说不出是谁：{evs:?}"
    );
    assert!(
        st.last_rejection
            .as_deref()
            .unwrap_or_default()
            .contains("注入"),
        "拒绝的原因要留得下来，不然红了也没地方查：{:?}",
        st.last_rejection
    );
    assert!(
        !l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::Tombstone { .. })),
        "被拒收的删除不许算作已经落进本机"
    );
}

/// ADR-0022 D7 ① 的引擎侧两格，缺一不可：
/// ① **可达性**：清单里一枚我还不认识的类型、且 `p`（永久删）已置位 ⇒ 引擎真的会把
///    `Purge{kind:"g"}` 交到落库这一边。墓碑这一族**不取记录**，所以 fetch 前那道
///    `kind_dir` 门（`notera-webdav/src/path.rs:181-189`）拦不住它 —— 落库这一侧必须自己表态。
///    没有这一格，"host 把陌生标记具名拒收"就是一条永远不会被走到的分支。
/// ② **读者**：落库在 `Ok` 里报的 `rejected/reason` 必须折进本轮读数。
///    `.rejected` 自被造出来起**零读者**（`grep -rn "\.rejected" crates/` 只命中构造处），
///    而引擎三条 apply 边从前只判 `Err` —— 于是"整批失败"有痕迹、"批里这一条我读不懂"没有痕迹。
#[tokio::test]
async fn an_unknown_kind_reaches_the_local_and_its_rejection_is_counted() {
    let l = FakeLocal::default();
    l.report_unknown_kinds.store(true, Ordering::SeqCst);
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![EntryRef {
            i: "g-1".into(),
            t: "g".into(),
            r: 1,
            h: "gggggggggggg".into(),
            s: 10,
            d: None,
            p: 1,
        }],
    };
    m.refresh_checksum();
    r.seed(m);

    let (st, _evs) = run(l.clone(), r, None).await;

    let got = l.applied.lock().unwrap().clone();
    assert!(
        got.iter()
            .any(|o| matches!(o, ApplyOp::Purge { kind, .. } if kind == "g")),
        "①：陌生 kind 的永久删除必须真的到达落库这一边，实际 {got:?}"
    );
    assert_eq!(
        st.rejections, 1,
        "②：落库在 Ok 里报的具名拒收必须数得出来（从前它零读者），读数 {st:?}"
    );
    assert!(
        st.last_rejection
            .as_deref()
            .unwrap_or_default()
            .contains("未知的实体类型标记: g"),
        "②：原因要点名那一枚标记本身，不然拒收了也查不到是什么：{:?}",
        st.last_rejection
    );
    assert_eq!(
        st.pulled, 0,
        "②：被拒的那一条不许同时被算成已拉下来（一台不知道少了一格的形状）"
    );
}

/// 把第一百三十批留下的那句**假说**量成读数：一台还不认识 `tag` 的设备（旧版本就是这样），
/// 清单里那颗陌生条目会不会**每轮被重新计划**。
///
/// 两件事必须分开量，混在一起就会得到"要么没事、要么炸了"这种假结论：
/// ① **重计划**：P13 每轮都再发一次 `Purge{kind:"g"}` 吗？（会 —— 因为本机那一行永远建不起来，
///    `decide(None, Some(purged))` 每轮都是 P13，与 `sync_remote_index` 有没有记住它无关）
/// ② **代价**：它每轮多花请求吗？（墓碑这一族不取记录 ⇒ 不多花，`requests` 两轮一样）
///
/// 这一格只管"墓碑/永久删"这半边。"活条目被拉"那半边**这里量不出来**：
/// `FakeRemote.fetch_record` 不按路径构造走，陌生 kind 在它那里是 `Ok(None)` → 走 §10 的
/// `MissingRemote`，不是真实适配器那句 `kind_dir` 的 `Err(BadKind)`。
/// 那一半要用 `crates/notera-webdav/tests/engine_over_webdav.rs`（真 `WebDavRemote`）去量，
/// 已登记成待办，不在这里用假remote的读数冒充真适配器的行为。
#[tokio::test]
async fn an_unknown_purged_kind_is_replanned_every_round_but_costs_no_requests() {
    let l = FakeLocal::default();
    l.report_unknown_kinds.store(true, Ordering::SeqCst);
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![EntryRef {
            i: "g-1".into(),
            t: "g".into(),
            r: 1,
            h: "gggggggggggg".into(),
            s: 10,
            d: None,
            p: 1,
        }],
    };
    m.refresh_checksum();
    r.seed(m);

    let count_g_purges = |l: &FakeLocal| -> usize {
        l.applied
            .lock()
            .unwrap()
            .iter()
            .filter(|o| matches!(o, ApplyOp::Purge { kind, .. } if kind == "g"))
            .count()
    };

    let (st1, _) = run(l.clone(), r.clone(), None).await;
    let after1 = count_g_purges(&l);
    let (st2, _) = run(l.clone(), r.clone(), None).await;
    let after2 = count_g_purges(&l);

    assert_eq!(after1, 1, "第一轮就该发一条陌生 kind 的 Purge");
    assert_eq!(
        after2, 2,
        "假说证实：陌生 kind 的墓碑**每轮重新计划**（本机永远建不起那一行，P13 每轮都成立）"
    );
    assert_eq!(st1.rejections, 1, "每轮各拒一次，读数 {st1:?}");
    assert_eq!(
        st2.rejections, 1,
        "第二遍也是每轮一次，不会累积成两次，读数 {st2:?}"
    );
    assert_eq!(
        st1.requests, 1,
        "每一轮的请求数要钉住具体值，不是只钉「两轮相等」—— 相等但都是 40 就是网络空转了，读数 {st1:?}"
    );
    assert_eq!(
        st2.requests, st1.requests,
        "②代价这一半要的是「不多花请求」：墓碑不取记录，两轮请求数必须一样（{st1:?} vs {st2:?}）"
    );
}

/// G22 的定位探针（引擎侧那一半）：本机这一行是**干净**的（`rev == sync_rev`，已经软删过），
/// 而远端视图说这一条 `purged=1` —— 引擎必须给出"永久删除"那条**独立的**落库 op（`Purge`），
/// 不能停在软删上。这一格今天真红的就是它：另一台设备上那条"永久删除"的笔记留在回收站里可恢复，
/// 而本机没有 purged 墓碑，I1/I3 那道防复活闸门因此在这台上不成立。
#[tokio::test]
async fn a_purged_remote_view_purges_a_clean_local_row() {
    let l = FakeLocal::default();
    // 本机：rev 与确认点一致（=已经追平过对面那一版），并且已经是删除态
    let mut row = local("g22", 2, 2, "aaaa");
    row.deleted_at = Some("2026-09-29T00:00:00Z".into());
    l.locals.lock().unwrap().push(row);
    let r = FakeRemote::default();
    let mut m = base_manifest();
    m.window = Window {
        since_seq: 1,
        complete: true,
        entries: vec![EntryRef {
            i: "g22".into(),
            t: "n".into(),
            r: 2,
            h: "aaaaaaaaaaaa".into(),
            s: 40,
            d: Some("2026-09-29T00:00:00Z".into()),
            p: 1,
        }],
    };
    m.refresh_checksum();
    r.seed(m);

    let (st, _evs) = run(l.clone(), r, None).await;
    let applied = l.applied.lock().unwrap().clone();
    let purged = applied
        .iter()
        .any(|o| matches!(o, ApplyOp::Purge { id, .. } if id == "g22"));
    // 另一半同样是判据：永久删除**不能顺带再落一条软删**。上一版这里看的是
    // `Tombstone{purged:true}`，而落库那一侧读的是 op 的种类、那个 bool 被 `..` 吞了 ——
    // 于是"引擎说了永久删除"这件事实实在在绿着，对端那条却进了回收站。
    let also_soft = applied
        .iter()
        .any(|o| matches!(o, ApplyOp::Tombstone { id, .. } if id == "g22"));
    println!("G22 探针：st={st:?} 落库操作={applied:?}");
    assert!(
        purged,
        "远端说 purged=1，引擎却没给出 ApplyOp::Purge：{st:?}"
    );
    assert!(
        !also_soft,
        "永久删除的那一条同时又落了软删除 op —— 对端会停在回收站里：{applied:?}"
    );
}

/// §4.3 / G87：服务器这一版只回来一小截 ⇒ **整轮停**。
///
/// 这条判据钉的是**调用边**：`divergence_is_suspicious` 有实现、有单测，绿了很久，
/// 但引擎一次都没调过它（缺口 G87 的全部形状就是这个"零生产调用者"）。
/// 所以断言不落在"函数返回什么"，而落在"这一轮到底做了什么"：
/// ① 那份可疑清单**没被存下**（存了下一轮就是 304，比的是它自己，这一格永不成立）；
/// ② 一条都没应用；③ 一个字节都没上传（本机明明有一条脏行等着走）。
#[tokio::test]
async fn a_shrunken_index_holds_the_whole_round_and_does_nothing_at_all() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();

    // 本机认账的那一份：窗口声明 300 条。
    let mut big = base_manifest();
    big.window = Window {
        since_seq: 1,
        complete: true,
        entries: (0..300)
            .map(|i| ent(&format!("n{i:04}"), 1, "aaaa"))
            .collect(),
    };
    big.refresh_checksum();
    *l.cached_manifest.lock().unwrap() = Some(big.to_wire());

    // 服务器这一版只剩 10 条：少了 290 条 = 既过 50 那条线，也过 30% 那条线。
    let mut small = base_manifest();
    small.seq = 2;
    small.window = Window {
        since_seq: 2,
        complete: true,
        entries: (0..10)
            .map(|i| ent(&format!("n{i:04}"), 2, "bbbb"))
            .collect(),
    };
    small.refresh_checksum();
    r.seed(small);

    // 本机有一条脏行 —— 没有这道闸门时它**必须**会被推出去，下面正对照就是量这个。
    l.locals.lock().unwrap().push(local("mine1", 9, 0, "cccc"));
    l.hold.store(true, Ordering::SeqCst);

    let (_, evs) = run(l.clone(), r.clone(), Some("\"old-etag\"")).await;

    assert!(
        evs.iter().any(|e| matches!(
            e,
            SyncEvent::DivergenceHeld {
                cached_records: 300,
                received_records: 10
            }
        )),
        "停下要带着**这两个数**，界面才说得出少了多少：{evs:?}"
    );
    let applied = l.applied.lock().unwrap();
    assert!(
        !applied
            .iter()
            .any(|o| matches!(o, ApplyOp::StoreManifest { .. })),
        "这份清单不许被存成新的基线：存了下一轮就再也不会问第二遍 —— {applied:?}"
    );
    assert!(applied.is_empty(), "整轮停 = 一条都不应用：{applied:?}");
    assert_eq!(
        r.req(),
        1,
        "只该有那一次清单读取；本机明明有一条脏行，一个字节都不许推出去"
    );
    assert!(
        r.records.lock().unwrap().get(&path("n", "mine1")).is_none(),
        "远端不许出现本机那条记录 —— 上传真的没发生"
    );
}

/// 正对照：同一副夹具、同一个形状，只是这一版**已被用户确认**（闸门放行）。
/// 这一条红 = 上面那条"整轮停"其实是别的东西造成的（比如这轮本来就没活）。
#[tokio::test]
async fn the_accepted_version_of_the_same_index_is_applied_and_pushed() {
    let l = FakeLocal::default();
    let r = FakeRemote::default();

    let mut big = base_manifest();
    big.window = Window {
        since_seq: 1,
        complete: true,
        entries: (0..300)
            .map(|i| ent(&format!("n{i:04}"), 1, "aaaa"))
            .collect(),
    };
    big.refresh_checksum();
    *l.cached_manifest.lock().unwrap() = Some(big.to_wire());

    let mut small = base_manifest();
    small.seq = 2;
    small.window = Window {
        since_seq: 2,
        complete: true,
        entries: (0..10)
            .map(|i| ent(&format!("n{i:04}"), 2, "bbbb"))
            .collect(),
    };
    small.refresh_checksum();
    r.seed(small);

    l.locals.lock().unwrap().push(local("mine1", 9, 0, "cccc"));
    l.envelopes.lock().unwrap().insert(
        "mine1".into(),
        br#"{"kind":"n","id":"mine1","rev":9}"#.to_vec(),
    );
    // hold 保持 false：等价于"用户已经确认过这一版"。

    let (_, evs) = run(l.clone(), r.clone(), Some("\"old-etag\"")).await;

    assert!(
        !evs.iter()
            .any(|e| matches!(e, SyncEvent::DivergenceHeld { .. })),
        "确认后不许再拦：{evs:?}"
    );
    assert!(
        l.applied
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, ApplyOp::StoreManifest { .. })),
        "放行之后这份清单要正常落账"
    );
    assert!(
        r.req() > 1,
        "放行之后该走的路要走完（公告 + 记录），实到请求 {} 次",
        r.req()
    );
}
