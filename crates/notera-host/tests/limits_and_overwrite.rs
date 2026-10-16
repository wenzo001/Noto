//! §4.4 / §4.8 两句**明说过的承诺**的判据（2026-10-10 完成度审计补的：实现与文案都在，判据没有）：
//!  ① 单附件 ≤32 MiB，「入口就拒并明说」—— 边界**两侧**各钉一次：限值+1 拒且什么都不落、
//!     恰限值必须收（判据是 `>` 不是 `≥`，错一格的实现要能被抓到）；
//!  ② 导出「目标位置永远不覆盖已存在的文件」—— 拒之外还要钉**原文件一个字节没动**，
//!     并配正对照（同一条导出、目标不存在时必须成功）—— 否则"永远拒绝一切导出"也能骗过它。
//!
//! 空文件拒绝（§4.4 后半句）不在这里重复：核心内联单测（`notera-host` 的 `tests` mod）与前端
//! `attachmentWire.spec` 各有一条。
//!
//! 跑法：`cargo test -p notera-host --test limits_and_overwrite`

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use notera_host::commands::dispatch;
use notera_host::App;
use serde_json::json;

static SEQ: AtomicUsize = AtomicUsize::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("notera-limits-{tag}-{}-{n}", std::process::id()));
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

fn boot() -> (App, Tmp) {
    let dir = Tmp::new("app");
    let app = App::boot(dir.path()).expect("核心启动");
    (app, dir)
}

fn new_note(app: &App) -> (String, String) {
    let folder = app.default_folder_id().unwrap();
    let doc = json!({ "v": 1, "content": [{ "id": "blk000001", "type": "paragraph", "content": [{ "text": "附件的宿主" }] }] });
    let note = app.create_note(&folder, doc).unwrap();
    (note.id, "blk000001".to_string())
}

/// 数一遍某个目录下的普通文件（用来钉"什么都没落盘"）。
fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            n += count_files(&p);
        } else {
            n += 1;
        }
    }
    n
}

#[test]
fn a_blob_over_the_limit_is_refused_at_the_door_and_nothing_lands() {
    let (app, dir) = boot();
    let (note, block) = new_note(&app);
    let big = dir.path().join("big.bin");
    std::fs::write(&big, vec![7u8; (32 * 1024 * 1024) + 1]).unwrap();

    let err = dispatch(
        &app,
        "attach_file",
        json!({
            "noteId": note, "blockId": block, "role": "file",
            "localPath": big.to_string_lossy(),
            "mediaType": "application/octet-stream", "filename": "big.bin",
        }),
    )
    .expect_err("超限必须拒");
    assert_eq!(err.code, "too_large", "码要能被界面翻译成那句话：{err:?}");

    // 「什么都不落」是这句话的另一半：账上没有那一行、盘上没有那个 blob。
    let inv = dispatch(&app, "attachment_inventory", json!({})).unwrap();
    assert_eq!(inv["totals"]["count"], json!(0), "{inv}");
    assert_eq!(
        count_files(&dir.path().join("attachments")),
        0,
        "被拒的字节不许在盘上留下任何一份"
    );
}

#[test]
fn an_oversized_import_lands_in_the_failed_slot_not_only_in_notices() {
    // §4.8「报告固定三行：新增 / 重复 / 失败」的后半个分支。2026-10-14 用真载荷量过红的那格：
    // 超限那一份是在门口就拒的（`ImportSource::read`），它当时**只被写进 `notices`**，
    // 于是屏幕打 `failed.length` 的那一行报的是"失败 0"，而实际少了一份 —— 那句话就是说谎。
    let (app, dir) = boot();
    let small = dir.path().join("small.md");
    let big = dir.path().join("big.md");
    std::fs::write(&small, "# 收得下的一份\n").unwrap();
    // 8 MiB 那道闸门是导入侧的（`MAX_SOURCE_BYTES`），与上面附件那 32 MiB 不是同一个数。
    std::fs::write(&big, vec![b'a'; (8 * 1024 * 1024) + 1]).unwrap();

    let report = app
        .import_files(&[
            small.to_string_lossy().to_string(),
            big.to_string_lossy().to_string(),
        ])
        .expect("门口拒掉一份不是整条命令失败：另一份要收下来");

    let created = report["created"].as_array().cloned().unwrap_or_default();
    let failed = report["failed"].as_array().cloned().unwrap_or_default();
    assert_eq!(created.len(), 1, "合法那一份必须真收进来 {report}");
    assert_eq!(report["duplicates"], json!(0), "{report}");
    // 这一条就是本批的牙齿：改之前 `failed` 是空的（那一份只长在 notices 上）。
    assert_eq!(
        failed.len(),
        1,
        "「失败」这一位要配平：没进来的那一份得在这里 {report}"
    );
    // 配平不变量：送进来几份，三个数加起来就得是几份 —— 谁都不许从账上消失。
    assert_eq!(
        created.len() + report["duplicates"].as_u64().unwrap_or(0) as usize + failed.len(),
        2,
        "两份都要有去处 {report}"
    );

    let why = failed[0]["why"].as_str().unwrap_or("");
    assert!(why.contains("超过导入上限"), "要说什么没进来：{why}");
    assert!(why.contains("8388608"), "§4.8 要限制值上屏：{why}");
    assert_eq!(
        failed[0]["label"].as_str().unwrap_or(""),
        big.to_string_lossy().as_ref(),
        "要指着是哪一份"
    );
    // 反向对照：同一份超限文件单独送，也不能把整条命令折成错误（门口拒 ≠ 整单失败）。
    let solo = app
        .import_files(&[big.to_string_lossy().to_string()])
        .expect("只送超限那一份也不许让整条命令失败");
    assert_eq!(
        solo["created"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .len(),
        0,
        "{solo}"
    );
    assert_eq!(
        solo["failed"].as_array().cloned().unwrap_or_default().len(),
        1,
        "{solo}"
    );
}

#[test]
fn a_blob_exactly_at_the_limit_is_accepted() {
    let (app, dir) = boot();
    let (note, block) = new_note(&app);
    // 恰 32 MiB：判据是 `>` 而不是 `≥` —— 把边界错一格（拒掉合法的一份）在这里红。
    let at_limit = dir.path().join("at-limit.bin");
    std::fs::write(&at_limit, vec![7u8; 32 * 1024 * 1024]).unwrap();

    dispatch(
        &app,
        "attach_file",
        json!({
            "noteId": note, "blockId": block, "role": "file",
            "localPath": at_limit.to_string_lossy(),
            "mediaType": "application/octet-stream", "filename": "at-limit.bin",
        }),
    )
    .expect("恰在限值上的一份必须收下");

    let inv = dispatch(&app, "attachment_inventory", json!({})).unwrap();
    assert_eq!(inv["totals"]["count"], json!(1), "{inv}");
    assert_eq!(inv["totals"]["bytes"], json!(32 * 1024 * 1024), "{inv}");
    assert_eq!(
        count_files(&dir.path().join("attachments")),
        1,
        "收下就要真落盘"
    );
}

#[test]
fn exporting_onto_an_existing_file_refuses_and_leaves_it_untouched() {
    let (app, dir) = boot();
    let _ = new_note(&app);

    // 目标已存在：放一份可辨认的"旧字节"。
    let target = dir.path().join("已有备份.zip");
    std::fs::write(&target, b"OLD-BYTES-NOT-A-ZIP").unwrap();
    let err = dispatch(
        &app,
        "export_data",
        json!({ "path": target.to_string_lossy() }),
    )
    .expect_err("目标已存在时不许覆盖");
    assert_eq!(err.code, "export_target_exists", "{err:?}");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"OLD-BYTES-NOT-A-ZIP",
        "拒了但文件被动了 —— 那是比不拒更坏的一种"
    );

    // 正对照：同一条导出、目标不存在 ⇒ 必须成功并真写出一个非空的包。
    let fresh = dir.path().join("新的备份.zip");
    let ok = dispatch(
        &app,
        "export_data",
        json!({ "path": fresh.to_string_lossy() }),
    )
    .expect("换个不存在的位置就该成功");
    assert!(fresh.exists(), "{ok}");
    assert!(std::fs::metadata(&fresh).unwrap().len() > 0, "{ok}");
}
