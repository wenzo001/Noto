//! Noto 壳共用层：**两个壳之间唯一允许存在的那一份实现**。
//!
//! 它存在的理由是可证的重复，不是"看起来更整齐"：抽取之前
//! `apps/desktop/src-tauri/src/lib.rs` 与 `apps/mobile/src-tauri/src/lib.rs`
//! 各自抄了一份壳的接线，实测
//!   · `fn reject` —— 两边**逐字节相同**（8 行）；
//!   · `async fn notera_command` —— 只差一行注释（17 行 vs 17 行）；
//!   · `fn pump_events` —— 同一套逻辑，注释与 `eprintln!` 前缀不同（24 行 vs 26 行）；
//!   · `const EVENT_NAME` / `struct Shell` —— 两边都在。
//! 那种形状下"两条壳共用一条契约"只在**注释**里成立：任何一边改了命令拒绝载荷的形状、
//! 事件名、或"哪些事件要响通知"，另一边会静默地跟它不一致，而两边的门禁都不会红。
//! 抽出来之后，**壳只留平台表面**，接线一行都不许再写第二遍。
//!
//! ## 这里放什么 / 不放什么
//!
//! 放：数据目录口径、`App::boot`、命令转发（`dispatch` 的唯一入口）、事件泵、
//! 通知判定、能力协商的调用点 —— 也就是"两端**必须**一样"的那些。
//!
//! 不放：菜单 / 托盘 / 全局快捷键 / 窗口装饰 —— 那些是**平台表面**，各端用各端的 API，
//! 由 `PlatformSurface` 的实现各自提供（桌面有、移动没有，且**不是**"移动也有但关掉"：
//! Android 上这三个面根本不存在，所以移动那份的实现是空的，也就不会上报这三个能力）。
//!
//! ## 为什么用 trait 而不是 `#[cfg]`
//!
//! `#[cfg]` 会让"移动端不注册托盘"变成编译期的**缺席**，读代码的人看不出这里本该有什么；
//! 而 trait 把"这个平台有哪些表面"变成一张**必须被显式填写的清单**：
//! 加一个平台面（比如分享入口）时，两个实现都会编译不过，逼着每个平台表态。
//! 这正是本仓要的"平台差异只经能力协商表达"（ARCHITECTURE-MAP P2）。

use notera_host::{commands, App, BusEvent};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// 总线事件推给 WebView 的事件名。
/// 前端 `apps/desktop/src/api/bridge.ts` 订阅的是同一个字面量 ——
/// 它现在**只有这一处**定义，改动只可能发生在一个地方。
pub const EVENT_NAME: &str = "notera://event";

/// 壳持有的应用句柄。两个壳与这里的命令转发都用它。
pub struct Shell {
    pub app: Arc<App>,
}

/// 命令拒绝载荷：UI 只认 `code` / `messageKey` / `retryable` / `detail`。
///
/// 形状是**跨语言契约**（前端 `api/errors.ts` 按这四个键取值），
/// 所以它必须只有一份实现 —— 此前两个壳各写一遍，正是最该合并的那一类。
pub fn reject(code: &str, retryable: bool, why: String) -> serde_json::Value {
    serde_json::json!({
        "code": code,
        "messageKey": format!("cmd.{code}"),
        "retryable": retryable,
        "detail": { "why": why },
    })
}

/// 把一条命令搬出主线程后转发给 `notera_host::commands::dispatch`。
///
/// 两个壳的 `notera_command` 都直接调它；`tauri::command` 那层薄壳留在各自的 crate 里，
/// 因为属性宏要在**每个 crate 自己的**注册表里生成（这是 tauri 的要求，不是重复）。
pub async fn dispatch_command(
    app: Arc<App>,
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    // SQLite 是同步的：绝不在主线程跑命令，否则一次列表扫描就能冻住界面。
    let joined =
        tauri::async_runtime::spawn_blocking(move || commands::dispatch(&app, &name, args)).await;
    match joined {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => {
            Err(serde_json::to_value(&err).unwrap_or_else(|_| reject("serialize", false, err.code)))
        }
        Err(e) => Err(reject("handler_panic", true, e.to_string())),
    }
}

/// 事件泵：把宿主总线上的事实推给 WebView，并在"要人裁决"的两类上响系统通知。
///
/// 通知的**判定**是纯函数 `notice_for`（在 host 里，带自己的测试），
/// 所以"哪些事件会响"这件事本身有门禁；两个壳此前各自抄了一遍这段循环。
pub fn pump_events(app: &App, handle: &tauri::AppHandle) {
    let rx = app.subscribe();
    let sink = handle.clone();
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            if sink.emit(EVENT_NAME, &event).is_err() {
                return;
            }
            // 窗口不在前台时，"要人裁决"的那两类事实只能靠系统通知递到手边。
            // 拿不到通知权限就吵一声 —— 界面里的冲突收件箱不受影响。
            if let Some(n) = notera_host::platform::notice_for(&event) {
                if let Err(e) = sink
                    .notification()
                    .builder()
                    .title(&n.title)
                    .body(&n.body)
                    .show()
                {
                    eprintln!("[notera-shell] 系统通知没送出去：{e}（界面上的冲突收件箱不受影响）");
                }
            }
        }
    });
}

/// 数据目录口径：`NOTERA_DATA_DIR` 优先，否则用系统给本应用的目录。
///
/// 留 `NOTERA_DATA_DIR` 不是为了"配置产品"，是为了**可测**：冷启动与大列表渲染的性能基线
/// （PERF-01/13）必须在真实 release 壳里量，而那需要预先装着几千条笔记的库 ——
/// 把测试库写进用户真实的 app data 目录是不可接受的。
/// 这条口径以前在两个壳里各写一遍，`notera-cli` 是第三处（它有自己的 argv 入口）。
pub fn resolve_data_dir(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    match std::env::var_os("NOTERA_DATA_DIR") {
        Some(v) if !v.is_empty() => Ok(PathBuf::from(v)),
        _ => handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法确定数据目录：{e}")),
    }
}

/// 平台表面：**每个平台必须显式表态**的那张清单。
///
/// 每个方法对应"这个平台上有没有这件事"。桌面实现里有菜单/托盘/快捷键的挂载与注册，
/// 移动实现里全是空实现 —— 但空实现是**写出来的**，不是靠 `#[cfg]` 消失的。
///
/// `attach_*` 返回 `Result` 而不是 `bool`：失败原因要能进日志与能力协商
/// （"原则上能做到"与"这次真的挂上了"是两件事 —— 本仓被这条咬过两次，见 ARCHITECTURE-MAP §8）。
pub trait PlatformSurface {
    /// 这个平台有没有原生菜单栏。
    fn has_native_menu(&self) -> bool;
    /// 这个平台有没有系统托盘。
    fn has_tray(&self) -> bool;
    /// 这个平台有没有系统级全局快捷键。
    fn has_global_shortcuts(&self) -> bool;

    /// 挂原生菜单。没有菜单的平台返回 `Ok(())`（不需要挂）。
    fn attach_menu(&self, app: &tauri::AppHandle) -> Result<(), String>;
    /// 挂托盘。返回"真的挂上了吗"。
    fn attach_tray(&self, app: &tauri::AppHandle) -> Result<(), String>;
    /// 注册全局快捷键。返回"全部注册成功了吗"（注册一半不算成功）。
    fn register_shortcuts(&self, app: &tauri::AppHandle) -> Result<(), String>;
    /// 窗口装饰等首帧前的最后调整。
    fn adjust_main_window(&self, window: &tauri::WebviewWindow);
}

/// 平台表面在 setup 阶段被调用的**唯一**顺序。
///
/// 为什么把顺序也收进共用层：菜单要**先于**窗口显示挂好（第一帧就该看到本应用的菜单），
/// 而托盘/快捷键允许失败且失败要如实写回能力协商 —— 这个"谁先谁后、谁能失败"的顺序
/// 是两个壳都必须一样的语义，抄两遍就会漂。
pub fn boot_surface<S: PlatformSurface>(
    surface: &S,
    app: &App,
    handle: &tauri::AppHandle,
) -> Result<(), String> {
    if surface.has_native_menu() {
        // 菜单挂不上要把启动顶死：没有菜单的桌面应用是残缺的，静默继续会让用户
        // 看到一个"缺了一半"的窗口却没有任何解释。
        surface.attach_menu(handle)?;
    }

    // 托盘与系统级快捷键**可以失败**（系统不让挂、键位被别的应用占了），
    // 所以它们不把启动顶死，而是把结果如实写回能力声明 ——
    // 设置页随之自己回到"这台设备不支持"，同时吵一声让用户知道刚刚没成。
    let mut degraded = false;
    if surface.has_tray() {
        match surface.attach_tray(handle) {
            Ok(()) => app.report_native_cap(notera_host::NativeCap::Tray, true),
            Err(e) => {
                eprintln!("[notera-shell] 托盘没挂上：{e}（设置页那两项会显示为不支持）");
                app.report_native_cap(notera_host::NativeCap::Tray, false);
                degraded = true;
            }
        }
    }
    if surface.has_global_shortcuts() {
        match surface.register_shortcuts(handle) {
            Ok(()) => app.report_native_cap(notera_host::NativeCap::GlobalShortcuts, true),
            Err(e) => {
                eprintln!("[notera-shell] 全局快捷键没注册上：{e}（设置页那两项会显示为不支持）");
                app.report_native_cap(notera_host::NativeCap::GlobalShortcuts, false);
                degraded = true;
            }
        }
    }
    if degraded {
        app.emit(BusEvent::Toast {
            message_key: "platform.caps_degraded".into(),
            level: "warn".into(),
        });
    }

    if let Some(w) = handle.get_webview_window("main") {
        surface.adjust_main_window(&w);
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

/// 壳启动的完整共用流程：解析数据目录 → `App::boot` → 装状态 → 起事件泵 →
/// 平台表面 → 允许碰网络。
///
/// 两个壳的 `setup` 都只调它一句（桌面那份额外把 `PlatformSurface` 实现传进来）。
/// "窗口已经出首帧之后才允许碰网络"（PLATFORM.md §3）这条顺序也在这里，
/// 所以它不可能在某一端被漏掉。
pub fn boot<S: PlatformSurface>(surface: &S, handle: &tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_data_dir(handle)?;
    let app = App::boot(&dir).map_err(|e| format!("核心启动失败：{e}"))?;
    let app = Arc::new(app);

    pump_events(&app, handle);
    handle.manage(Shell {
        app: Arc::clone(&app),
    });

    // 平台表面（菜单 / 托盘 / 快捷键 / 窗口装饰）。
    boot_surface(surface, &app, handle)?;

    // 窗口已经出首帧，**这时**才允许碰网络（PLATFORM.md §3）。
    // 引擎的生命周期交给宿主托管（缺口 G50）：以前是"开机那一刻配好才起、且只起一次"，
    // 于是全新安装填好 WebDAV 之后点同步，徽标会停在"正在同步"直到重启 ——
    // 而界面那句文案写的是"配好凭据后会自动开始同步"。
    app.enable_background_sync();
    Ok(())
}
