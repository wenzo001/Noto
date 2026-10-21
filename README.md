# Noto（工作代号 Notera）

> **Local-first, WebDAV-only, cross-platform notes.** Your data lives in your own WebDAV folder —
> no account, no cloud service, no telemetry.

Noto 是一款**本地优先**的跨平台个人笔记应用：数据默认只存在你自己的机器上，同步后端**只支持 WebDAV**
（你自己的 Nextcloud / Synology / 坚果云 / 自建服务器都行），安装包按几 MB 计量。目标只有一条动线：

```text
安装 → 打开 → 直接写 → 自动保存 →（配好同步之后才）自动同步
```

> 品牌名与域名尚未最终定案（工作代号 Notera，界面产品名 Noto）。改名只影响 brand 层，不影响架构。

---

## 它解决什么

| 常见问题 | 这里的做法 |
|---|---|
| 笔记软件的安装包动辄上百 MB | 富文本编辑器与同步引擎都是自研实现（Rust + Vue），桌面安装包 **5～8 MB**、Android APK **约 15 MB**（release 档） |
| 查看和编辑要再点一次「编辑」 | **点开就打**：列表点一篇，光标已经在正文里，没有编辑态/阅读态之分 |
| 要接一堆网盘与同步后端 | **只做 WebDAV**：一个协议、一套冲突语义，不把数据分发给多个供应商 |
| 数据锁在别人的云里 | 本地 SQLite + 你自己的 WebDAV 目录；没有账号体系、没有遥测上报 |

---

## 功能

**写**
- 三栏界面（文件夹 / 笔记列表 / 编辑器），窄屏自动收成两栏、单栏
- 富文本块编辑：段落、标题、有序/无序列表、待办、引用、代码块、图片/附件、分隔线
- 自动保存；草稿态新建（切走即软删，改过才留下）；删除可撤销提示

**组织**
- 文件夹树、标签、置顶、颜色标记、每文件夹独立的排序记忆
- 全文搜索：FTS5 trigram 与 `LIKE` 双路径（2 字中文查询不会静默返回 0 行）
- 文内查找（当前笔记内跳转）、多选批量操作（打标签 / 导出）

**安全网**
- 回收站两级删除 + **30 天自动清理**
- 备份、导出 ZIP、从 ZIP 导入
- 只读库模式：库被占用或打不开时，界面明确说"只读"，且**一支写请求都不发**

**同步（WebDAV）**
- 增量清单 + revision + 墓碑 + ETag，支持断点续传与附件同步
- 冲突按**块级三方合并**处理，删改冲突有明确语义（见 [`docs/CONFLICT-RESOLUTION.md`](docs/CONFLICT-RESOLUTION.md)）
- 同步是 **opt-in**：没配账户或关掉开关，就没有任何一轮同步在跑
- 状态只呈现六格：`✓ 已同步` `↻ 正在同步` `○ 离线` `! 同步失败` `· 未配置同步 / 已关闭`，以及带具名原因的可重试失败

**网络**
- 应用级代理（跟随系统 / 应用内配置，只作用于 WebDAV 与探针，不影响本地功能）
- TLS 可选自定义 CA 包或证书指纹

---

## 平台与安装包

| 平台 | 产物 | 体积（v1.0.0 逐件实测） | 状态 |
|---|---|---|---|
| Windows 10/11 x64 | NSIS `.exe` / MSI | 5.38 MB / 7.51 MB | 真机验证 |
| macOS（Apple Silicon） | `.dmg` / `.app.zip` | 6.47 MB / 6.42 MB | **未签名、未公证**；CI 产物，未真机验证 |
| Android arm64-v8a | `.apk`（release 档） | 14.96 MB | **CI 里没有 keystore ⇒ 未签名，Android 会拒装**，装机前需自行签名 |
| iOS / iPadOS | — | — | 架构预留，不在 1.0 范围 |

体积由 `scripts/collect-release-assets.mjs` 的上界门守着（每档留了 32%～38% 余量），1.0.0 的逐件读数见
[`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md)。

---

## 安装

1. 从 [Releases](https://github.com/wenzo001/Noto/releases) 下载对应平台的产物（`v1.0.0` 已公开发布）。
2. **Windows**：直接安装（产物没有代码签名，SmartScreen 可能提示"未知发布者"）。
3. **macOS**：`.dmg` 未签名未公证，首次打开需在「系统设置 → 隐私与安全性」里手动允许。
4. **Android**：CI 产物未签名，需用你自己的 keystore 签名后再安装：
   ```bash
   apksigner sign --ks my.keystore --out Noto-signed.apk Noto.apk
   ```

首次启动后的数据目录（可用环境变量 `NOTERA_DATA_DIR` 覆盖，主要用于测试与多库并行）：

- Windows：`%APPDATA%\app.notera`
- macOS：`~/Library/Application Support/app.notera`

---

## 配同步

1. 打开「设置 → 同步」，填入 **WebDAV 地址、用户名、口令**（支持自签 CA 包 / 证书指纹）。
2. 打开「启用同步」。在那之前不会有任何同步请求发出。
3. 远端目录布局由应用自描述（`.notes/protocol.json` + 增量清单 + 对象文件）；协议版本与产品版本**不同轴**，
   详见 [`docs/SYNC-PROTOCOL.md`](docs/SYNC-PROTOCOL.md)。

凭据优先存进系统凭据库（Windows Credential Manager / macOS Keychain）；这台设备没有可用凭据库时，口令只活在
**本次进程**里（重启需要重填，界面会明确说明，而不是假装保存了）。

---

## 数据与隐私

- 笔记存在本地 **SQLite（WAL + FTS5）**，附件单独落盘；没有遥测、没有分析上报、没有账号。
- 唯一的外部通信是**你配置的 WebDAV 服务器**（以及你手动触发的代理探针）。
- 导出 ZIP 与备份文件完全由你保管；应用不做任何自动上传。
- 删除是两级的：先进回收站（可恢复），30 天后自动清理；永久删除有独立确认。

---

---

## 从源码构建

前置：Rust（`rust-version = 1.85`）、Node.js 24、pnpm 12.5.1（用 corepack 取，版本见
`apps/desktop/package.json` 的 `packageManager`）、以及 [Tauri 2 的平台依赖](https://tauri.app/start/prerequisites/)。

```bash
# 依赖
corepack pnpm@12.5.1 --dir apps/desktop install

# 开发：先起本地核心桥（17323），再起前端（5173）
cargo build -p notera-cli
./target/debug/notera-cli.exe --data-dir ./.notera-dev serve --port 17323
corepack pnpm@12.5.1 --dir apps/desktop dev

# 打 Windows 安装包：必须显式走 GNU 工具链（本机 PATH 里的 link.exe 会顶掉 MSVC 链接器）
RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu \
  corepack pnpm@12.5.1 --dir apps/desktop tauri build \
  --target x86_64-pc-windows-gnu --bundles nsis,msi
```

测试与门禁：

```bash
cargo +stable-x86_64-pc-windows-gnu test --workspace
node apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop
node scripts/arch-check.mjs
node scripts/verify-layout.mjs     # 浏览器整跑，需要上面那座桥与 5173 一起在跑
```

---

## 架构

```text
crates/
  notera-core       笔记/文件夹/标签/回收站的领域模型与不变量
  notera-richtext   富文本块模型（doc → blocks → doc）与块级合并
  notera-crypto     加密原语（AES-256-GCM-SIV、argon2id）
  notera-store      SQLite 持久层、迁移、FTS5、outbox
  notera-config     应用配置、偏好、凭据抽象
  notera-net        HTTP/TLS/代理（reqwest + rustls）
  notera-webdav     WebDAV 客户端（PROPFIND/PUT/GET/MKCOL/MOVE，ETag）
  notera-sync       同步引擎：清单、revision、墓碑、拉/推/合并
  notera-importer   导入器（ZIP / 附件）
  notera-host       命令面：桌面、CLI 与 dev 桥共用的 dispatch 层
  notera-cli        无 GUI 入口（serve / verify / 迁移 / 导入导出）
  notera-shell      Tauri 平台表面（菜单、托盘、快捷键、能力协商）
  notera-test-webdav 测试用 WebDAV 服务器（含故障注入）
apps/
  desktop/          Vue 3 + TypeScript + Vite 前端 + Tauri 2 壳
  mobile/           Android 壳（与 iOS/iPadOS 同源，架构预留）
```

- **一条命令面**：界面只经 `notera-host` 的 `dispatch` 调核心；桌面壳、CLI 与浏览器 dev 桥共用同一份实现。
  跨语言契约（键名、枚举词汇、结构形状）有专门的判据钉着。
- **数据唯一权威**是本地 SQLite；同步只搬运"变更 + revision"，冲突在块级合并，绝不在网络上就地改库。
- 前端不引 UI 框架：设计 token + 自研组件（下拉、勾选、分隔条等都有键盘与可达性判据）。

---

## 质量与非功能约束

| 门禁 | 读数（各遍跑在哪棵树上见出处） |
|---|---|
| `cargo test --workspace` | 771 通过 / 0 失败 / 7 ignored |
| 前端单测 + 类型 | 828 通过（95 个文件）+ `vue-tsc` 0 错 |
| `arch-check`（架构与卫生） | 52/52 |
| 浏览器整跑 `verify-layout.mjs` | **898 PASS / 0 FAIL**（1.0.0 这棵树：`ee7d174`） |
| CI | `PR 门禁`（fmt / clippy / eslint / vue-tsc / 单测 / 契约）· `依赖与密钥审计` · `出包与发布` |

优先级（冲突时按此裁决）：

```text
数据安全 > 同步正确性 > 稳定性 > 用户体验 > 原生平台体验 > 性能 > 可维护性 > 新功能
```

---

## 已知限制（1.0 如实记录）

- **macOS 与 Android 没有真机读数**：只有 CI 产物与结构校验（包名 / 版本 / native 库 / 可启动入口）。
- **Android APK 未签名**：CI 没有 keystore，装机前必须自行签名。
- **第三方 WebDAV 服务器矩阵**未做完：内置测试服务器 + 真 HTTP 已覆盖协议语义，供应商差异仍标 BLOCKED。
- **键盘**：列表每行目前占 3～4 个 Tab 位，从侧栏走到编辑器需要较多次 Tab（`.skip-link` 可跳过）；
  列表的 roving tabindex 方案登记在 [`docs/NEEDS-OTHER-MACHINE-TESTING.md`](docs/NEEDS-OTHER-MACHINE-TESTING.md) 的 D27。
- **品牌与包元数据**：名称（Noto / Notera）与 `Cargo.toml` 的 `repository` 字段尚未最终对齐。

---

## 文档地图

| 文档 | 作用 |
|---|---|
| [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) | **当前**验收状态与最新读数（先读这份） |
| [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) | 1.0 发布检查单、产物读数、还欠谁什么 |
| [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md) | 长期架构记忆：模块、不变式、改动路由、禁止模式 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、依赖方向、数据流、实测结论 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | SQLite 表与字段语义、revision 模型、富文本 schema |
| [docs/SYNC-PROTOCOL.md](docs/SYNC-PROTOCOL.md) | WebDAV 布局、清单结构、同步状态机、崩溃恢复、错误分类 |
| [docs/CONFLICT-RESOLUTION.md](docs/CONFLICT-RESOLUTION.md) | 冲突检测、块级三方合并、删除与反复活语义 |
| [docs/PROXY.md](docs/PROXY.md) | 应用级代理、TLS/证书、超时退避 |
| [docs/PLATFORM.md](docs/PLATFORM.md) | 四端能力矩阵、启动时序、后台同步预算 |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | 测试分层与行为矩阵 |
| [docs/CI-CD.md](docs/CI-CD.md) | 构建矩阵、版本策略、迁移契约 |
| [docs/design/](docs/design/) | 界面规范 v2、设计 tokens、规格执行者地图 |
| [docs/ADR/](docs/ADR/) | 重大架构决策记录 |
| [docs/diagram/architecture.html](docs/diagram/architecture.html) | 可交互契约图（单文件、离线可开） |
| [CHANGELOG.md](CHANGELOG.md) | 逐批改动与每批的读数 |

---

## 参与开发

- 开工前先读 [`docs/ARCHITECTURE-MAP.md`](docs/ARCHITECTURE-MAP.md) §0 清单。
- 需求与架构冲突时**停下**，新建 ADR 写明冲突与影响，等人工决定；不自行改架构。
- 不"顺便"：不顺手重构、不顺手升依赖、不顺手换组件。
- 测试失败时定位并修复，禁止删测试、降断言、`#[ignore]`、mock 掉核心逻辑。
- 不可验证的项写 `BLOCKED` + 原因 + 影响 + 解除条件；`SKIP` / `TODO` / "理论通过" 不算通过。
- 拿到 Actions 绿灯证据前，任何提交与文档不得出现"CI 已通过"。

---

## 许可

MIT。见 [LICENSE](LICENSE)。

## English

**Noto** is a local-first, WebDAV-only note-taking app for Windows, macOS and Android, built with Rust
(Tauri 2) and Vue 3. Notes live in a local SQLite database, sync to *your own* WebDAV server, and the
desktop installers stay in the single-digit megabytes. No account, no telemetry, no vendor cloud.
See [docs/](docs/) for the architecture, the sync protocol and the conflict semantics.
