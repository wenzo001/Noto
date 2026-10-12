//! 移动壳（Android）：**平台表面全空**的那一份实现。
//!
//! 这个文件里不许出现业务规则，也不许出现存储调用（ARCHITECTURE-MAP §5）。
//! 它与桌面壳的差别现在**只有一件事**：桌面那份的 `PlatformSurface` 实现了
//! 菜单 / 托盘 / 全局快捷键，移动这份三个都是空的 —— 因为 Android 上这三个面
//! **根本不存在**（不是"有但关掉"）。所以移动壳也**不上报**那三个能力：
//! 不上报就是 false（`PlatformCaps` 的默认值），设置页不会摆出按了没反应的开关。
//!
//! 命令面、事件面（`notera://event`）、数据目录口径、`App::boot`、事件泵、
//! 通知判定、后台同步的启动 —— 这些两端**必须一样**的东西一行都不在这个文件里，
//! 它们在 `notera_shell`（两个壳共用的唯一一份实现）。
//!
//! 为什么是**另一个 crate**：桌面 crate 的 `[lib] crate-type` 只要多带 `cdylib`，
//! Windows GNU 工具链就报 `ld.exe: error: export ordinal too large`（实测），桌面产物链不出来。
//! Android 需要 `staticlib` + `cdylib` 给 JNI 入口，所以移动壳自己建 crate。

use notera_shell::{dispatch_command, PlatformSurface, Shell};
use std::sync::Arc;
use tauri::Manager;

/// 移动端的平台表面：三个面都没有。
///
/// 空实现是**写出来的**，不是靠 `#[cfg]` 消失的 —— 加一个新平台面时这个 impl 会编译不过，
/// 逼着移动端明确表态"有没有"（ARCHITECTURE-MAP P2：平台差异只经能力协商表达）。
struct MobileSurface;

impl PlatformSurface for MobileSurface {
    fn has_native_menu(&self) -> bool {
        false
    }
    fn has_tray(&self) -> bool {
        false
    }
    fn has_global_shortcuts(&self) -> bool {
        false
    }

    // 下面三个"挂载"方法在移动端**不会被调用**（上面的 `has_*` 都是 false，
    // `boot_surface` 会跳过它们），但 trait 要求显式表态，所以它们必须存在。
    // 这里刻意返回 `Err` 而不是 `Ok(())`：万一将来有人把 `has_*` 改成 true 却忘了实现，
    // 得到的是一句**说得清的话**，而不是一个静默的"挂上了其实没挂"。
    fn attach_menu(&self, _app: &tauri::AppHandle) -> Result<(), String> {
        Err("Android 没有原生菜单栏".into())
    }
    fn attach_tray(&self, _app: &tauri::AppHandle) -> Result<(), String> {
        Err("Android 没有系统托盘".into())
    }
    fn register_shortcuts(&self, _app: &tauri::AppHandle) -> Result<(), String> {
        Err("Android 没有系统级全局快捷键".into())
    }

    /// 移动端不动窗口装饰：全屏窗口由系统管，`set_decorations` 在这里没有对应概念。
    fn adjust_main_window(&self, _window: &tauri::WebviewWindow) {}
}

#[tauri::command]
async fn notera_command(
    shell: tauri::State<'_, Shell>,
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    // 转发的实现只有一份（`notera_shell::dispatch_command`）。
    // 这个薄壳留在本 crate 里是因为 `#[tauri::command]` 的属性宏必须在
    // **每个 crate 自己的**注册表里生成 —— 那是 tauri 的要求，不是重复。
    dispatch_command(Arc::clone(&shell.app), name, args).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![notera_command])
        // 与桌面壳同一句：共用流程全在 `notera_shell::boot` 里。
        // `String` → `Box<dyn Error>` 是 tauri 的 `setup` 签名要求，与共用层无关。
        .setup(|handle| {
            notera_shell::boot(&MobileSurface, handle.app_handle())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })
        })
        .run(tauri::generate_context!())
        .expect("Noto 移动壳启动失败");
}
