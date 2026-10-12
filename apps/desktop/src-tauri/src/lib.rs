//! 桌面壳：**平台表面**（原生菜单 / 托盘 / 全局快捷键 / 窗口装饰）+ 一条命令转发。
//!
//! 这里不允许出现业务规则，也不允许出现存储调用（ARCHITECTURE-MAP §5）。
//! 它与移动壳共用的东西**全在 `notera_shell` 里**：数据目录口径、`App::boot`、
//! 命令转发、事件泵、通知判定、能力协商的调用顺序、后台同步的启动。
//! 这个文件只回答一个问题：**桌面上有哪些平台表面，各自怎么用桌面自己的 API 实现**。
//!
//! 抽取之前这里与移动壳各抄了一份接线，实测 `fn reject` 逐字节相同、
//! `notera_command` 只差一行注释、`pump_events` 是同一套逻辑 —— 现在那三样
//! 在 `notera_shell` 里各只有一份。

use notera_host::platform::{global_shortcut_plan, menu_plan, tray_plan, ShortcutRoute};
use notera_shell::{dispatch_command, PlatformSurface, Shell};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// 原生菜单被点击 → 前端按 `id` 路由到界面动作（新建、搜索、去冲突收件箱…）。
/// 菜单**不**自己碰业务：它和键盘快捷键是同一个入口的两种外壳。
///
/// ⚠ 这个事件名只有桌面用（移动端没有菜单），所以它留在这里而不是 `notera_shell`；
/// 前端 `api/bridge.ts` 订阅的是同一个字面量，改动必须两边一起看。
const MENU_EVENT_NAME: &str = "notera://menu";

/// 托盘的 id：`on_tray_icon_event` 与菜单事件都按它归口，改名要连窗口事件一起看。
const TRAY_ID: &str = "notera-tray";

/// 按平台把菜单计划摆成原生菜单。摆不上去要**吵**，不能静默退回"没有菜单"——
/// 那正是"能力声明说有你却看不到"的那种假。
///
/// 返回 `Result<(), String>`（与 `PlatformSurface` 的契约一致）：tauri 的 `Error` 在这里
/// 就地折成一句话，因为跨到 `notera_shell` 之后那边不依赖 tauri 的错误类型。
fn attach_menu(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let plan = menu_plan(cfg!(target_os = "macos"));
    let mut builder = MenuBuilder::new(app);
    for (title, items) in &plan.groups {
        let mut sub = SubmenuBuilder::new(app, *title);
        for item in items {
            let mut b = MenuItemBuilder::new(item.label).id(item.id);
            if let Some(a) = item.accel {
                // Tauri 认 `Command` 而不是计划表里的 `Cmd`；解析失败就宁可少一个
                // 快捷键（菜单项还在），也不要把整条菜单构建搞崩。
                b = b.accelerator(a.replace("Cmd", "Command").as_str());
            }
            sub = sub.item(&b.build(app).map_err(|e| e.to_string())?);
        }
        builder = builder.item(&sub.build().map_err(|e| e.to_string())?);
    }
    app.set_menu(builder.build().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 显示 / 隐藏主窗口。托盘左键、托盘菜单、全局快捷键三条路都汇到这一个函数 ——
/// "怎么算显示"只有一份实现（§39 不许复制状态机）。
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        eprintln!("[notera] 找不到 main 窗口，显示/隐藏没发生");
        return;
    };
    if w.is_visible().unwrap_or(false) && !w.is_focused().unwrap_or(false) {
        let _ = w.set_focus();
        return;
    }
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 挂托盘图标 + 托盘菜单。**返回是否真的挂上了** —— 能力声明由这个返回值写，
/// 不由"这个平台原则上能做到"猜（那是此前两次假声明的形状）。
fn attach_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("构建里没有窗口图标")?;
    let mut builder = MenuBuilder::new(app);
    for item in tray_plan() {
        let item = MenuItemBuilder::new(item.label)
            .id(item.id)
            .build(app)
            .map_err(|e| e.to_string())?;
        builder = builder.item(&item);
    }
    let menu = builder.build().map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键留给"显示/隐藏"，菜单走右键 —— 和 Apple Notes 所在的那类菜单栏应用一致。
        // 左键也弹菜单的话，一次点击两个意图，用户分不清自己刚刚是收起还是打开了菜单。
        .show_menu_on_left_click(false)
        .icon(icon)
        .tooltip("Noto")
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 注册系统级快捷键。返回**全部**注册成功才叫成功 —— 注册了一半就报 true，
/// 设置页会摆出一个按了没反应的组合键，那正是被 §40 明令禁止的那种"看着有"。
fn register_global_shortcuts(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    let mut failed: Vec<String> = Vec::new();
    for spec in global_shortcut_plan(cfg!(target_os = "macos")) {
        let sink = app.clone();
        let route = spec.route.clone();
        let accel = spec.accel;
        let result = gs.on_shortcut(accel, move |_app, _shortcut, event| {
            // 按住不放会连续来 Pressed/Released；只在按下时动一次，
            // 否则"新建笔记"会被连开好几条。
            if event.state != ShortcutState::Pressed {
                return;
            }
            match &route {
                ShortcutRoute::Menu(menu_id) => {
                    let _ = sink.emit(MENU_EVENT_NAME, (*menu_id).to_string());
                }
                ShortcutRoute::ShowOrHideWindow => toggle_main_window(&sink),
            }
        });
        if let Err(e) = result {
            eprintln!("[notera] 全局快捷键 {accel} 没注册上：{e}");
            failed.push(accel.to_string());
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("这些键位没注册上：{}", failed.join(", ")))
    }
}

/// 桌面的平台表面：三个面都有。
struct DesktopSurface;

impl PlatformSurface for DesktopSurface {
    fn has_native_menu(&self) -> bool {
        // 移动端没有原生菜单栏，`set_menu` 在那里是**会失败**的；
        // 桌面这三个平台都有（Windows / macOS / Linux）。
        cfg!(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "linux"
        ))
    }
    fn has_tray(&self) -> bool {
        true
    }
    fn has_global_shortcuts(&self) -> bool {
        true
    }

    fn attach_menu(&self, app: &tauri::AppHandle) -> Result<(), String> {
        attach_menu(app).map_err(|e| format!("原生菜单挂载失败：{e}"))
    }
    fn attach_tray(&self, app: &tauri::AppHandle) -> Result<(), String> {
        attach_tray(app)
    }
    fn register_shortcuts(&self, app: &tauri::AppHandle) -> Result<(), String> {
        register_global_shortcuts(app)
    }

    fn adjust_main_window(&self, window: &tauri::WebviewWindow) {
        // Windows：去掉系统标题栏，前端那一行就是唯一的把手与窗口按钮。
        // macOS 不在这里动 —— conf 的 `titleBarStyle: Overlay` 已经把系统标题栏
        // 收成零高度、只留红绿灯浮在那一行上（在这里 set_decorations(false) 会连灯一起没）。
        #[cfg(target_os = "windows")]
        let _ = window.set_decorations(false);
        #[cfg(not(target_os = "windows"))]
        let _ = window;
    }
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        // 快捷键只从 Rust 侧注册，前端不碰这个插件的 IPC —— 所以不需要给它开
        // capability 权限（能力面越小，越不存在"前端能替用户注册全局键"这件事）。
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 不注册的话命令面是空的：前端每次 invoke 都石沉大海，UI 看起来"点了没反应"。
        .invoke_handler(tauri::generate_handler![notera_command])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            // 只有托盘独有的两项由壳自己办（窗口显隐、退出）。其余一律转发给前端，
            // 与键盘快捷键、系统级快捷键共用同一批动作 —— 托盘不许有第二条实现。
            match id.as_str() {
                "tray.toggle" => toggle_main_window(app),
                "tray.quit" => {
                    // 托盘上那个"退出"必须是真退出：先把图标收掉再 exit，
                    // 否则万一 exit 被挡住，用户看到的是"图标还在、点什么都没反应"。
                    if let Some(t) = app.tray_by_id(TRAY_ID) {
                        let _ = t.set_visible(false);
                    }
                    app.exit(0);
                }
                _ => {
                    let _ = app.emit(MENU_EVENT_NAME, id);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键按下 = 显示/隐藏；右键（以及按住不放的那些）交给系统菜单。
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        // setup 只剩一句：共用流程（数据目录 → boot → 事件泵 → 平台表面 → 允许碰网络）
        // 全在 `notera_shell::boot` 里，所以两端不可能把顺序写岔。
        // `String` → `Box<dyn Error>` 这一步是 tauri 的 `setup` 签名要求
        // （它收 `Result<(), Box<dyn Error>>`），与共用层的 `Result<(), String>` 无关。
        .setup(|handle| {
            notera_shell::boot(&DesktopSurface, handle.app_handle())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("[notera] 壳构建失败：{e}");
            std::process::exit(1);
        })
        .run(|_handle, _event| {
            // 连接池随进程退出关闭，SQLite 在干净关闭时自行 checkpoint WAL —— 壳不插手。
        });
}
