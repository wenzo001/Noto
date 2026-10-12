# 交付记录 · Noto 0.0.125（GitHub 三平台可装包）

日期：2026-10-12 · 仓库：`D:\code\Notes` → `https://github.com/wenzo001/Noto.git`
版本线：`0.0.125`（`Cargo.toml` 的 workspace 版本，单一版本源）

## 一句话结论

**Objective 达成**：项目认知建立、所有**本仓可完成**的功能与门禁缺口已推进到"本批能做到的状态"、
代码已推送 GitHub，并且**第一次真正出出了三平台可装包** —— Release `v0.0.125` 已发布
（`isDraft=false` / `isPrerelease=false`），6 个产物可匿名下载，SHA-256 已实测逐字节对上。

此前最后一份包停在 **v0.0.63**，而版本线已经走到 0.0.125 —— 中间 62 个补丁、133 个提交，
**一个都没出过包**。这一轮补的正是那一格。

## 1. "为什么 62 个补丁没出过包"（根因，不是疏忽）

`scripts/tag-release.mjs` 与 `.github/workflows/release.yml` 用的是**同一个判据**：
CHANGELOG 里必须恰好有一条 `- **` 开头且含「版本 … → <version>」的行。
本仓最后一条这样的条目停在 **0.0.63**；0.0.64 起改用 `###` 小节标题记批次 ⇒ 这条判据从 0.0.64
一直取不到东西。于是：

| 症状 | 机制 |
|---|---|
| 没打 tag | `tag-release.mjs --check` 在 CHANGELOG 那一条当场红 |
| 就算手打 tag | release.yml 的 awk 抽出 **0 字节** ⇒ Release 正文退化成"找不到条目"的占位 |
| 工作树判据 | untracked（`.aoci/`、`AGENTS.md`、`tmp` 之外的现场文件）一样算脏 |

这是**结构性**的：版本策略说"改了产品就升 patch"，而版本条目的记账格式在 0.0.64 换了形状，
两件事没有对到一起。已按补上 CHANGELOG 条目 + 清理工作树 + 补 `.gitignore` 解决（不改产品行为）。

## 2. 本条发布的事实（全部本机/ GitHub 实测）

### 2.1 本地门禁（本机独占机器，都跑在这一棵树上）

| 门禁 | 读数 |
|---|---|
| `cargo test --workspace -- --test-threads=1` | **716 通过 / 0 失败 / 6 ignored**（99 个 `test result` 行） |
| 前端 `vitest run` | **627 通过（72 文件）**、0 失败 |
| `vue-tsc --noEmit` | **0 错** |
| `eslint .` | **0 输出** |
| `cargo fmt --all --check` | 退出码 **0** |
| `cargo clippy --workspace --all-targets -- -D warnings` | **0 error / 0 warning** |
| `node scripts/arch-check.mjs` | **34/34** |
| `node scripts/check-versions.mjs` | 一致 |
| `node scripts/check-frontend-dist.mjs` | 全过（见 §3 G61） |

### 2.2 Windows 出货产物（本机出、本机验）

`node scripts/build-dist.mjs --bundles nsis,msi`（GNU 工具链）⇒ `BUILD_EXIT=0`：

| 产物 | 字节 | |
|---|---|---|
| `Noto_0.0.125_x64_zh-CN.msi` | **8 015 872** | |
| `Noto_0.0.125_x64-setup.exe` | **5 935 754** | |

`scripts/verify-windows-package.ps1` **13 条 PASS / PSEXIT=0**：`msiexec /a` 退 0、解出
`notera-desktop.exe` 16 709 120 B 与 `WebView2Loader.dll` 160 880 B、包内与 NSIS 的
FileVersion/ProductVersion 四个都是 `0.0.125`、三个体积都过关。

> **本机 msI 与 CI 出的 MSI 体积不同（8 015 872 vs 8 040 448）是预期的**：两边是同一份代码
> 不同的打包时刻/工具版本，本机那份已经过 13 条结构校验，"这一版是什么"没有被质疑过。

### 2.3 CI：发布链路 5 个 job 全绿

run **38234364594**（tag `v0.0.125`，工作流「出包与发布（§4 / §5）」）：

| job | 结论 | 耗时 |
|---|---|---|
| 版本与 tag 对齐 | ✓ success | 5 s |
| macOS（.dmg + .app，未签名） | ✓ success | 5 m 22 s |
| Windows（GNU 工具链：.msi + .exe） | ✓ success | 9 m 54 s |
| Android（.apk，debug 签名） | ✓ success | 3 m 38 s |
| 汇总到 GitHub Release（草稿） | ✓ success | 17 s |

### 2.4 已发布的 Release 与其产物（`gh release view v0.0.125`）

`tagName=v0.0.125`、`name=Noto 0.0.125`、**`isDraft=false`**、**`isPrerelease=false`**、
`publishedAt=2026-10-12T10:19:45Z`，同时也是 GitHub 的 `releases/latest`。

| 产物（平台 → 装什么） | 字节 |
|---|---|
| `Noto_0.0.125_x64_zh-CN.msi`（Windows 安装器） | **8 040 448** |
| `Noto_0.0.125_x64-setup.exe`（Windows NSIS） | **5 947 766** |
| `Noto_0.0.125_aarch64.dmg`（macOS 磁盘镜像） | **7 016 422** |
| `Noto_0.0.125_universal.app.zip`（macOS app 包） | **6 962 807** |
| `app-universal-debug.apk`（Android，debug 签名） | **155 301 236** |
| `SHA256SUMS.txt` | 464 |

下载实测：匿名 `HEAD` → **HTTP 200 / 5 947 766 B**；`Noto_0.0.125_x64-setup.exe`
下载后 SHA-256 = `cb1096e5…a33e`，与 `SHA256SUMS.txt` 与 API `digest` **三方一致**。

## 3. 本轮关掉的缺口（代码实测，不是文档声称）

**G61 —— 前端产物的体积第一次有上界。** `scripts/check-frontend-dist.mjs` 此前只有下界
（只回答"是不是坏构建"，不回答"是不是在变大"）；`docs/UI-REDESIGN-BRIEF.md` §4 那一格
原话是"**仓库目前没有体积门禁**" —— 现在它有上界，且**只算 `.js`/`.css`/`.html`**，
`.map` 不计（本机 dist 合计 2 199 157 B 里有 **1 807 573 B 是 sourcemap**，把它算进产品门禁
等于让"这次要不要出 map"这种调试开关影响一条产品门禁）。上界 **512 KiB**，实测进包三类
**404 601 B**（JS 354 478 + CSS 49 547）。

**门禁自己会红才收它的绿**，三臂实测：`--max-bytes 100000` ⇒ FAIL 且退出码 1；
`--min-bytes 99999999` ⇒ FAIL 且退出码 1；默认参数 ⇒ 全过、退出码 0。**上下两条都有腿**。
文档那一格已同步改成事实（含新读数与"改预算要显式改那一行"的改法）。

## 4. 还欠的（不许当成已完成）

按仓库自己的优先级梯子与 §40 纪律，这些**不是这一轮能合的**，逐条写下原因与解除条件：

| 项 | 状态 | 为什么没在这一轮做 |
|---|---|---|
| macOS / Android / iOS 真机验证 | **BLOCKED** | 本机无 macOS/Xcode/Android SDK/真机（B1/B3）。"基础功能验证"里的同步那一格在 macOS/Android 上**过不了** —— 见下 G38 |
| 代码签名与公证 | **BLOCKED**（D3） | 要证书。macOS 包未签名未公证，首次打开需在系统设置里手动允许 —— 这句已写进 Release 正文 |
| Android 安装动作 | BLOCKED（§49，归用户） | 装到真机上要用户的设备 |
| **G38：macOS/Android 配不出同步** | 待口径拍板 | `credential_store::available()` 就是 `cfg!(windows)` ⇒ 那两台口令只活一次运行、每次启动要重填。**这一句已写进对外发布说明**（三条出路 A/B/C 见 `PRODUCTION-READINESS.md` §7，属用户决定） |
| G34 退避与重试不是 PROXY.md §7 那一套 | 待 §9 级取舍 | 改它会把"一轮失败"的耗时推到十几秒，牵连界面时延与离线类测试 |
| G23 永久删除不删服务器附件字节 | 待 D8 拍板 | 远端销毁不可逆，"这个 blob 还有别人在用吗"只有服务器知道 |
| G21 服务器丢记录无人补 | 待 PERF 取舍 | 会破"空轮 1 请求 / 0 字节"（PERF-05） |
| G15 块级三方合并没有调用点 | 待 §9 架构评审 + ADR | 要同时改同步决策与 rev/hash 口径 |
| 仓库**没有任何一项** E2EE 开放入口 | 待 §7 决定 | 加密库与引擎都已通，但 `set_vault` 零生产调用点 ⇒ 加密实际从未打开 |
| G70 导出清单按深度缩进 | 待产品口径 | 两种改法都成立，属 §51，不代用户决定 |
| G31 矮窗口下侧栏滚动区被挤 | 待口径 | 同上 |
| G14 文件夹环分叉不作解释 | 待口径 | 要存"被拒的父"才说得出口 |
| G16 两个测试钩子不存在 | — | 工程效率，非产品缺口 |
| 标签/分面/正则、本地静态加密、应用锁、多窗口、移动分享、MD/PDF/HTML 导出、多账户 | 未做 | 多**属明确不做**（ADR-0018 / §1.6）；其余要独立 ADR |
| G28 CI 偶发红 | 未复现 | 未认证读不到 job 日志（403），需 GitHub token |

## 5. 一件要更正的事（按实记）

第一轮打 tag 之后，本地又提交了两笔真实改进（G61 门禁、`.gitignore` 卫生）。
**tag `v0.0.125` 仍指向 `929547c`（tag 对象 `848530f2`，未动）** —— 也就是说这两笔
**不在**这个 Release 里。CI 跑的是 tag 指向的那棵树，而不是本地 HEAD；tag 指向本地 HEAD
这个假设是错的（`git merge-base --is-ancestor df3bf85 v0.0.125` → exit 1）。
那两笔已推到 `main`（`929547c..df3bf85`），主分支现在是 `df3bf85`；
它们不改变产品行为（一个是门禁、一个是忽略规则），所以**没有重打 tag**。
下一个版本会把它们带出去。
