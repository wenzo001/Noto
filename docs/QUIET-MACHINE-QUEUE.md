# 安静机队列（一次会话内把六件事落地）

这份只有一个用途：**当有一台机器没有并行会话、`git status` 干净、提交额度 ≥ 2 GB 时**，按顺序把这六件做完。
每一件都是"东西已经做好了，缺的只是它自己那遍证人"——不需要重新设计，不要在这里重新讨论口径。

## 开工前的三条硬前提（缺一条就别开始）

```bash
git status --porcelain --untracked-files=no    # 必须为空：共享工作树里别人的未提交改动会让读数归不了因
node scripts/verify-layout.mjs; echo $?        # 只跑预检：退出 0 才算现场够（3 = 提交额度不够，4 = 树不可归因）
nohup pnpm --dir apps/desktop dev >/dev/null 2>&1 &                                    # 5173
nohup ./target/debug/notera-cli.exe --data-dir .logs/g102-data serve --port 17323 &    # 桥；两天以上旧就先重编
```
桥若是旧的，先 `cargo +stable-x86_64-pc-windows-gnu build -p notera-cli` 再起（Rust 侧改动不在同一棵树上时，整跑读数不算同一棵树）。
跑 lane 期间**不要有任何本地负载**（自己连跑 `vitest`、开 `gh run watch` 轮询都算 —— 会把 lane 挤挂在 0 条真 FAIL 上，那种读数不是证人）。

## 顺序（每步都是一次"改前 / 改后"的整跑对读，776 条读数逐条 diff）

| 步 | 做什么 | 期望 | 出错怎么办 | 版本 |
| --- | --- | --- | --- | --- |
| 0 | **基线**：干净树上先整跑一遍 | 776 / **0 FAIL** | 不为 0 FAIL 就**停手**并报告是哪条腿红的 —— 这一遍不是走过场，本仓两次真缺陷（G102 一族、TLS 出屏）都是这么抓出来的 | — |
| 1 | `git apply .logs/icons62-folder-box-pending.patch`（#82/#62 两枚载体图标） | 只允许 §2 图标族那几条腿的读数变化（㉟/58/61 与 §2.2 载体分组那两条） | 出现别处的差异 ⇒ `git checkout --` 回干净，把差异按 §40 单独立条，不带疑落主干 | 升 patch（它改画面） |
| 2 | 上一步绿了再打 `.logs/kp86-namehint-pending.patch`（#86 新建文件夹弹窗那句原因文案） | **单独一遍**（它动布局高度）。已知代价量过：弹窗 +33 高、两颗键下移 17px，`1240×480`/`1280×620`/`390×844` 三档仍在视口内、横向溢出 0 | 44pt 通扫 ㊲ 或文本裁切 ㊻/57 有任何一条变化 ⇒ 撤补丁、把那条读数记成缺陷，不"顺手调 CSS" | 升 patch |
| 3 | #92（G129 那颗必然没用的「重试」）：`stores/sync.ts` 的 `case 'failed'` 不再无条件 `retryable: true` | 按 #92 里写好的：store 级腿 + `sync-retry` 渲染腿 + **反向对照臂**（网络类失败仍必须给重试）；三把刀各红一次 | 折叠一改，徽标族任何一条读数变化都要能指名是哪一发信号引起的；说不清就 park 成 patch 记 BLOCKED | 升 patch |
| 4 | #85：把 `.logs/motion-rendered-probe.mjs` 那三档形状**转录成整跑一条腿**（渲染后 `animation-duration` / `transition-duration`） | 新腿必须自己带牙：改 `--motion-fast` ⇒ 那条腿红；**只加腿不改产品** ⇒ 其余 776 条应 0 差异 | 转录时两个坑：期望值从规范原文抄，别由被测 CSS 反推；字面 `sync-spin 1.4s` 不许算进"token 消费者"下界 | 不升（只动门禁） |
| 5 | 收尾三件套 | `node scripts/clean-scratch.mjs --self-test && node scripts/clean-scratch.mjs --check`（`.logs` 上界 24 / 128 MB）；证据图单独一次 `docs(evidence)` 提交；`.logs/*-pending.patch` 里已落的**改名 `-applied`**，别留重复可打的残骸 | — | — |

## 这一份**不**包含的（别在这里顺手做）

- ~~**#90 剩下的 `.force-show`** 与 **D13 / D14 / D15 / D16 / #93** —— 等纸面拍板~~ ⇒ **这一族 2026-10-16 已全部拍齐**（A8–A10 + D15 已落 `e3cdbf5`），
  队列里现在剩下的是**执行**：#90 那一半已做完，#99/D17 那一半（删 `base.css:194`）还缺一遍整跑证人。
- **#83 / #89 / #88** —— 它们的修法落在 `crates/notera-host/src/lib.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/platform/caps.ts` 这一族文件上；开工前先确认并行那一批已经落地，否则树不干净、上面第 0 步就过不去。
- 任何"再跑一遍看看"的重复整跑：一遍改前一遍改后就是全部证据，多跑的是成本不是信心。

## 已知会被挡住的两种情形（今天各真发生过）

- 提交额度会在几分钟内从 5.2 GB 掉到 0 GB ⇒ 预检 `exit 3` 是常态，等到稳了再跑，别用 `LANE_FORCE=1` 硬闯。
- 共享工作树里挂着别人的未提交产品改动 ⇒ 预检 `exit 4`。真要跑就 `LANE_ALLOW_DIRTY=1`，但那份读数**不许归因到任何 commit、也不许当"回到绿"的证据引用**。

## 执行现场（2026-10-16 起）

**第 0 步基线已拿到**：干净树 @ `82a1f5e`，预检"物理 8.59 GB · 提交额度余 4.83 GB"、归因预检放行，
整跑 **776 PASS / 0 FAIL / 0 SKIP**（日志 `.logs/lane-82a1f5e.log`；开局自动收残骸 74 项，95.9 MB → 5.1 MB）。
⇒ 后面每一遍都对读这一行。

**前提更新（原第 30/31 行已被这次拍板改掉一半）**：
- D15 / D16① / #93 于 2026-10-16 拍完（见 `docs/design/SPEC-AMENDMENTS.md` A8、A9 与 `NEEDS-OTHER-MACHINE-TESTING.md` 那三行）⇒
  **`.force-show` 不再"等拍板"**，它现在就是队列里的一步（#90 剩下那一半）。
  D13、D14 与 D16 的 ②③ 也在**同一天第二批**拍完（D13=A、D14=A、D16②=把手道算版心外、D16③=搜索框外框底→第一行行顶 ±1）
  ⇒ 台账见 `SPEC-AMENDMENTS.md` **A10** 与 `NEEDS-OTHER-MACHINE-TESTING.md` 的"第二批拍板"一节；这一列现在**没有待拍的格子**了。
- 并行那一路滞留三天的 7 份未提交文件已按用户拍板**撤回主干**，快照存在 `.logs/parallel-caps-batch-20261013.patch`
  （`git apply --reverse --check` 验过可原样落回）⇒ **#83 / #89 的"缺文件所有权"这条阻塞解除**，现在只缺实现与整跑证人。

**第八十二批（图标 #62/#82）踩到的一条，记在这儿免得重演**：那份补丁把 `AppCheckbox` 的方框从"CSS 画的框 + `::after` 那颗勾"
换成 §2.2 的 SVG 载体，于是**两条 token 过渡一起没了主语** ⇒ `motion.spec.ts` 那条"§4.9 两档各有真消费者"的下界当场红
（`expected 5 >= 7`）。这不是判据坏了，是它抓到了真回归。处理：给新的 `.app-check__art` 补回 `color` / `opacity` 两条
`var(--motion-fast)` 过渡（换 path 那一笔本身不可过渡，可过渡的是选中色与禁用淡出），并把下界从 7 改成 6、理由写进注释。
**下界改完必须复验牙齿**：真删那条过渡 ⇒ `expected 5 >= 6` 红；还原后字节一致 ⇒ 绿。
⚠ 第一把刀我下错了——只把关键字 `transition:` 改名，**照样绿**：那条正则是 `/transition(?:-property)?\s*:[^;{}]*var\(--motion/`，
**没有词边界**，改名后的 `__mutated_transition:` 里的子串仍然命中 ⇒ 等价变异。计数类判据的刀**必须真删整条声明**。

**#92（G129）的修法已经读到两侧源码，范围比台账原先记的宽**：核心**本来就有** `SyncView.retryable`
（`crates/notera-host/src/lib.rs:274`，`:3297` 进 DTO），而前端 `stores/sync.ts:77-85` 把它整个忽略、硬编 `retryable: true`；
且三处**确定性失败**站点（`sync.auth_failed` :2297、`sync.root_mismatch` :2362/:2371、`sync.foreign_root` :2387）
只设 badge + message_key、**没把这个常驻字段置回 false** ⇒ 继承上一轮的值。
⇒ **已落 `e5ce64b`（0.0.134，第八十六批）**：折叠改成 `signal.retryable === true`（不带这一位一律不点亮）+
`applySignal` 在 failed 之后补问一次 `sync_status` 让权威决定；四处站点显式置 false。
**残留挂在 #96**：那四处**没有证人** —— 新加的 Rust 判据把四处全摘掉照样绿（夹具里那一位从没被置成 true），
要么造出 stale 现场当证人，要么承认它们是冗余并删掉；两种结局都算 #96 完成，只有"没量过"不算。

## 队列现状（2026-10-16 上午收盘，第八十二～八十八批之后）

**已落并推上 `origin/main`**：`50154eb`(82 图标) → `f6b5f4c`(83 尺子) → `87230f5`(拍板文档) → `5ea12d1`(证据) →
`689fcfd`(84 §4.9 文案) → `96366b5`(证据) → `e3cdbf5`(85 `.force-show`) → `e5ce64b`(86 重试权威) →
`976e0ed`(87 §1.2 ③ 测量边) → `cb96e33`(88 rustls 0.23.46) → `ff4916f`(证据)。
**整跑基线仍是 776 PASS / 0 FAIL @ `82a1f5e`**；82/84 两遍与基线**同数且腿名逐条对齐**，86/87 两遍 775（各有一条 console 判据被环境噪声名单放行：`cmd/stats ← ERR_NO_BUFFER_SPACE`）。

**下一步不是"再排一批"，是等一台安静的机器**：03:50 起提交额度从早上的 4.7–5.0 GB 掉到 **1.52 GB**，
`verify-layout` 的额度预检按设计**拒绝开跑**（闸门 2 GB 是按两个真实崩点 0.84 / 0.51 GB 留一档定的）。
⇒ 待办 `.logs/leg74-motion-rendered-pending.patch`（腿 74：§4.9/§1.6 渲染后时长转录，92 行，`apply --check` 干净）
**等额度回到 2 GB 以上**再接上跑；`LANE_PREFLIGHT_ONLY=1` 只出数不碰现场，可以先探。
**两条别再做错的事**：① 别为了跑通把闸门调低或 `LANE_FORCE=1` 硬闯 —— 那正是这道闸存在的理由；
② 判断"这一遍跑没跑"要读**日志正文里 `lane-exit=` 那一行**，不要信后台通知的 exit code ——
`… | tee -a log` 会把管道尾巴的 0 报成结果（今天就这样把一次 `exit 3` 读成了"跑完了"）。


## 04:10 补：这台机器现在连单测都跑不动 —— 今天晚些时候的"绿"要重打，别照抄

`pnpm --dir apps/desktop test` 在 04:09 起**连撞四次 V8 OOM**
（`MarkCompactCollector: young object promotion failed` / `Zone Allocation failed - process out of memory`），
把堆上限压到 768 MB、`--maxForks=1` 也一样；同一时刻提交额度 0.55 → 1.34 GB。
⇒ **这是环境，不是产品**：本仓记过同一条口径 —— worker 被挤挂时"0 条断言红"也不是读数（[[lane-hygiene-fresh-binary-and-step-interference]]）。

**因此今天这些绿的有效范围要写清**（别让下一位照抄成"HEAD 已验"）：
- **有效**：03:36 那次 **685 / 0** 与 arch-check 40/40 —— 它们跑在第八十六批**产品代码**（`stores/sync.ts` + `lib.rs` 四处）之上，
  而那之后进主干的只有文档与 `Cargo.lock`（rustls 0.23.46，只动 Rust 侧依赖版本，不碰前端一行）。
- **未重打**：`90cde92`（纯文档）之后的 HEAD 上，前端全量与 `cargo test --workspace` **没在这台机器上再跑过一遍**；
  Rust 侧那半边由 CI 覆盖（`PR 门禁` 在同一条 commit 上排队中），**但 CI 的审计步骤因 `zip` 被 yank 仍红**（见 #98），
  所以"CI 绿"这句话现在依然不许引用。
- **接手第一步**：等提交额度回到 2 GB 以上，先 `LANE_PREFLIGHT_ONLY=1` 出数，再跑
  `pnpm --dir apps/desktop test` + `node scripts/arch-check.mjs` 复绿，然后才接 `.logs/leg74-motion-rendered-pending.patch`
  （6284 字节，04:09 sweep 之后仍在、`apply --check` 干净，另存了一份在 `/tmp/leg74-motion-rendered-pending.patch.bak`）。

## 04:18 补：腿 74 第一遍证人跑被**我自己的并发**挤挂了 —— 签名留在这儿当对照

补丁已接上（`git apply` 干净、`node --check` 过），04:04 起的那一遍在 **336 PASS / 5 FAIL** 处**崩在半路**：
`lane-exit=1`（又是只读日志正文才看到的，后台通知照旧报 0 —— 见上面第二条"别再做错的事"）。
崩点是 `scripts/verify-layout.mjs:1603` 的 `waitForSelector('[data-testid^="note-row-"]')` 超时 15 s，**腿 74 根本没轮到**。

五条红的形状全是资源侧，不是产品侧：
```
FAIL 宽 1440：确认删除之后那一行真的从界面上没了 —— {"row":true,"rows":7,"before":7,"核心还认它":false}
FAIL 宽 1440：console error 为零 —— Failed to load resource: net::ERR_NO_BUFFER_SPACE
FAIL ⑫ / ⑬ / 宽 390·⑭：console error 为零 —— net::ERR_INSUFFICIENT_RESOURCES（⑬⑭ 各三次）
```
"核心还认它 = false 而界面还有 7 行"看着像产品的，但它排在三条 `ERR_INSUFFICIENT_RESOURCES` 之后 ——
请求挂掉时列表失效那条边本来就走不完，这一条**不许单独当缺陷引用**。

**根因是我自己**：`apps/desktop/node_modules/.vite/vitest/…/results.json` 落款 **12:11:27**，正在这遍的窗口（≈12:04→12:18:30）里
—— 04:09 那四次 V8 OOM 的单测尝试还没散干净，我就把 lane 挂上了后台。这正是本仓记过两次的那条
（[[lane-hygiene-fresh-binary-and-step-interference]] / 上面第 15 行"跑 lane 期间不要有任何本地负载"）。
⇒ **这一遍的数作废**，不进任何对读；04:21 在额度回到 **7.96 GB**、机器上只剩 dev(5173=200) 与桥之后重挂了一遍（`.logs/lane-91-leg74.log`）。

**同时补一条便宜的旁证（不替代整跑）**：`.logs/motion-rendered-probe.mjs` 在 04:19 用真 chromium 读了**渲染后**的 computed style，
腿 74 抄的那四个数逐条对上 —— `.btn` `0.12s × 3` + `cubic-bezier(0.2, 0, 0, 1)`、抽屉 `.pane--sidebar` `0.22s`、
`.dock__glyph[data-spin]` `sync-spin 1.4s linear infinite`；`reducedMotion:'reduce'` ⇒ 三处全 `1e-06s` 且循环变 `1`；
撤掉媒体条件反向对照 ⇒ 回到 `0.12s`。**这条只证"产品那四个数是真的"，不证"腿 74 在门禁里会红"**（牙还没下）。

## 04:35 补：安静机上这一遍跑到头了 —— 唯一那条 FAIL 是**我的仪器坏了**

04:21 重挂的那遍（无并发）跑到底：**781 PASS / 1 FAIL**，而那条红是腿 74 自己的第一条曲线判据：
```
FAIL 74 §4.9 悬停/按下那一档渲染出来就是 120ms + 规范那条曲线 —— {"时长":"0.12s","曲线":"cubic-bezier(0.2"}
```
**数是对的、串被切断了**：我写的 `first = (s) => s.split(',')[0]` 是给 `0.12s, 0.12s, 0.12s` 这种列表用的，
而 `transitionTimingFunction` 渲染出来是 `cubic-bezier(0.2, 0, 0, 1), cubic-bezier(…), cubic-bezier(…)` ——
**函数自身就带逗号**，按裸逗号切第一刀就落在 `cubic-bezier(0.2` 上，那条正则**永远不可能命中**。
⇒ 这是一条**恒红**的判据（与恒真同样没用：它抓不到任何东西，只会把每条合法曲线都判成违规）。
修法：换成**按括号深度切的顶层逗号分割** `topLevel()`，并把判据从"第一档匹配"改成"**每一档都得是规范那条曲线**"（`allCurve`）；
顺手给抽屉那一档补上规范同一条曲线那句（原文写的就是"220ms 同一条曲线"，以前只量了时长）。
**复验方式**（`.logs/leg74-predicate-check.mjs`，04:36，与门禁里那两个 helper 逐字一致）：
`btn_时长_012=true`、`btn_曲线_每一档=true`、切出来三档都是 `cubic-bezier(0.2, 0, 0, 1)`、`drawer_时长_022=true`、`drawer_曲线=true`；
**负面对照**：空串 ⇒ 时长假、曲线假；`ease` ⇒ 曲线假 ⇒ 新尺子不恒真。
⇒ 04:36 重挂 `.logs/lane-92-leg74-fixed.log`（期望 **782 PASS / 0 FAIL** = 86/87 那两遍的 775 + 腿 74 的 7 条）。

**这条要进的那条口径**：凡读 computed style 里"逗号列表"的判据，**先分清这个列表的每一项会不会自己带逗号**
（`transition-*`、`animation-*`、`background`、`box-shadow`、`grid-template-*` 全都会）。
与 [[compare-the-same-normalization-on-both-sides]] 同族但方向相反：那条是"两侧归一化要同一套"，这条是"**别用比数据本身更粗的分割符**"。

## 05:12 起**工作树上有一颗活的变异**（腿 74 的专属刀）—— 还原办法写在这儿，崩了也不许留着

变异点：`base.css:263` 的 `.btn` 那一条 `transition`，把三个 `var(--ease)` 改成 `linear`（**只动缓动、不动时长**）。
下刀前已证它**不是等价变异**：`.logs/leg74-predicate-check.mjs` 读真渲染值 ⇒ `btn_切出来=["linear","linear","linear"]`、
`btn_曲线_每一档=false` 而 `btn_时长_012` 仍 `true` ⇒ 没有更后面的规则把它盖回来，且改动是单变量。
期望：整跑 **781 PASS / 1 FAIL**，唯一那条 FAIL 必须是 `74 §4.9 悬停/按下那一档…`；其余 781 条与 04:36 那遍逐条同数。

**还原（跑完立刻做，别等下一遍）**：`base.css` 在这次变异之前相对 HEAD 是干净的 ⇒
```bash
git restore apps/desktop/src/styles/base.css     # 单路径，不碰别的未提交文件
git diff --stat HEAD -- apps/desktop/src/styles/base.css   # 必须为空
node .logs/leg74-predicate-check.mjs             # 必须回到 btn_曲线_每一档=true
```
⚠ 同族教训见 [[mutation-harness-kill-leaves-product-mutated]]：后台任务被杀不等于变异被撤销。

## 06:04 补：#96 我没做完（HEAD 保持绿），但把它量窄到"只差一块"

写了证人 ⇒ **前置断言当场把它自己否掉了**，这正是要的效果：`Injection::status("GET *", 500)` 之后
`sync_status()` 是 `{phase:"provisioning", badge:"offline", message_key:None, retryable:false}` ——
**500 不点亮「重试」**，所以"先发可重试的一发、再发确定性的一发"这个形状用网络故障造不出来。
摘掉那四处 `v.retryable = false` 的判据我上次交过一条**空转的**（夹具开局就是 false），这次没重犯：前置写成了断言。

这一位**只有三个来源**（读码 + 现成证人）：`st.rejections > 0`（`lib.rs:3358-3361`）、让路 `SyncEvent::Deferred`（`:3429-3432`，
证人现成在 `tests/sync_once.rs:767`，夹具整段在 `:700-770`：A 持租 ⇒ B 让路 ⇒ B 的 view 是 `leaseHeld` + `retryable=true`）、
以及 `SyncEvent::Failed{retryable}`（`:3462-3473`，由引擎错误类别决定）。
⇒ **只差一块**：让"撞确定性闸"发生在"让路之后"、同一台设备上。候选 (A) 让路后覆盖写远端 protocol doc 的 `root_id`
⇒ 命中 `:2380`（`manifest_sha(&srv)` 这类直接读服务器现场的助手已有，`:191`/`:919` 的 `Injection{…}` 写法可参照）；
候选 (B) 让路后用 `AccountDraftCmd`（`tests/sync_once.rs:13` 已 import）换目录 —— **动手前先量**它会不会顺带把 SyncView 那一位清掉，
不清才是证人，清了就和 ADR-0018 否证我上次那句"换账户造 stale"是同一个坑。
两种结局都算 #96 完成：**造出现场当证人**，或**证明没有任何可达状态能在撞闸前留 true** ⇒ 那四行连注释一起删成冗余。
本批一个字未提交（`git restore` 回 `a514fc3`，`sync_once` 复跑 16/0、1 ignored）。

## 07:20 补：`cargo test --workspace` 在本机跑不动 —— 是**额度**，不是代码；今天的核心改动另有读数

> ✅ **16:45 已补上（额度回到 21 GB 之后）**：`cargo +stable-x86_64-pc-windows-gnu test --workspace -- --test-threads=1` ⇒ **rc=0**，
> **99 个 `test result` 行、723 passed / 0 failed / 6 ignored**（编译的是 0.0.136 那棵树，含 `notera-mobile`）。
> ⇒ 下面那段"仍缺 workspace 全量"的欠账**已结**；这一行数是 **#102** 的结案证据（也第一次给了 CHANGELOG 基线表那条 647 之后的新数）。
> 注意口径：这一遍是 `cargo test`，**不是** `cargo clippy --workspace --all-targets -- -D warnings` —— 后者仍未在本机跑（CI 那条被 #98 卡着），所以"lint 全绿"这句仍不许引用。

07:18-07:20 想给今天那些 `lib.rs` 改动补一遍 **workspace 级 Rust 全量**，两条命令都红，但报错形状是链接器层的：
`only metadata stub found for rlib dependency core` / `found invalid metadata files for crate serde` /
`linking with x86_64-w64-mingw32-gcc failed: exit code 1`，同一时刻 `FreeVirtualMemory` = **1.98 GB**
⇒ 与今天那四次 V8 `Zone Allocation failed` 同族（薄额度），**不是 `import_files` 那批改坏了**。我第一版把它写成"混了两套 toolchain"也是**猜错**，`--lib` 那条一跑就把它否证了。

**今天的核心改动实际有的读数**（HEAD `fe501ed`）：
`cargo +stable-x86_64-pc-windows-gnu test -p notera-host --lib` ⇒ **56 passed / 0 failed / 0 ignored**
（跑到 `lib.rs` 内联 `mod tests`，含 `:4669`、`:4824-4828`、`:5151` 那几条 retryable 语义与 `every_store_error_keeps_its_own_code`）；
外加 `--test sync_once` **19/0**、`--test limits_and_overwrite` **4/0**、前端 **75 files/75 passed**、`arch-check 40/40`、整跑 **782/0**、`fmt --check` 0。

**仍缺**：其它 crate（`notera-net` / `notera-sync` / `notera-store` / `notera-webdav`）的单测与集成测试全量。
补法：额度 **≥3 GB** 时跑 `cargo +stable-x86_64-pc-windows-gnu test --workspace -- --test-threads=1`（今天稳定那两遍是 3.09 / 7.96 GB）。
⚠ **别为它 `cargo clean`** —— 这台机器的 target 重建代价今天已经把额度打到 0.51 GB 一次（见下面 06:39 那一节与 [[park-half-fixes-as-patch-and-record-blocked]]）。
CI 也覆盖这一格，但 CI 现在卡 #98 的 `zip` 审计 ⇒ **"CI 绿"这句依旧不许引用**。


## 06:39 补：我想为 0.0.135 补那遍整跑，结果**把开发桥弄没了**——接手第一件事是把桥起回来

> ⚠ **本节结论已被 07:13 的那一遍推翻，先看下面这条更正再决定要不要照这一节做**（这一节留在台上是为了记我错在哪）：
> **桥从头到尾都在** —— PID 69500、14:36:57 起在新 exe（14:36 落款，里面就是改过的 `lib.rs`）上，`/health` = 200 `{"ok":true}`。
> 我写"四次都没起来、两份日志 0 字节"是**仪器错了**：`grep "17323.*LISTENING"` 匹配不到 `netstat -ano` 那行的列宽/空格，
> 而后几次启动报的 `os error 10048 端口已被占用` 恰好证明**第一个 `nohup` 成功了**。
> **那一遍整跑也已补上**：`782 PASS / 0 FAIL`、`0` 条环境噪声放行、`>>> 布局门禁 PASS`、`lane-exit=0`，
> 归因预检"产品路径干净 ⇒ 算 HEAD `a951463` 的证人" ⇒ CHANGELOG 第九十一批那句"整跑这遍没跑**已作废**"（`b0d8690`，证据图 `7a35ff5`）。
> 真正**留下的教训**：① "端口没人听"要用两种方法各查一遍（把 `netstat` 整行打出来看 + `curl /health`），别拿一条正则的零命中当事实；
> ② 台账末行"崩之前量到 N 条"才是读数口径 —— 我 `grep -c '^PASS'` 得 605、台账打 700，差在非 TTY 块缓冲；
> ③ 额度预检拒跑是对的（1.8 GB < 2 GB），**不要用 `LANE_FORCE` 硬闯**，等回来再跑 —— 这一遍是 3.09 GB 才干净的。

**为什么欠这一遍**：第九十一批（`45c021e`，0.0.135）的 CHANGELOG 我自己写了"整跑这遍没跑"，那句到今天还没被任何全量读数证实。
**做到哪、卡在哪**：① 发现跑着的桥是 **10:51 那份旧二进制**（早于 13:43 的 `lib.rs` 改动）⇒ 那一遍跑了也是测旧代码；
② `cargo build -p notera-cli` 32.4 s ⇒ 新桥已在盘上（14:36）；③ `taskkill //PID 59048 //F` 停旧桥（**按 PID**，见 [[no-kill-by-image-name-only-by-pid]]）；
④ **起新桥四次都没起来且一行输出都没有**（`nohup &` / 后台常驻 / `cmd //c start` / 前台 `timeout 8`）：`17323` 的 `LISTENING` = **0**，`/health` 恒 `000`，
两份 `.logs/bridge-0-0-135*.log` **都是 0 字节** ⇒ 不是 panic（那会有字），是**静默不监听**。`5173` 仍是 `200`，dev server 无恙。

**下一位按这个顺序做，别先跑 lane**（没桥的 lane 会在预检或第一条浏览器腿崩，那种红不是产品）：
1. **决定性的一步**：换一份**干净 data-dir** 再前台起一次 ——
   `./target/debug/notera-cli.exe --data-dir D:/code/Notes/.logs/g102-data2 serve --port 17323 > .logs/bridge.log 2>&1`。
   干净目录能起 ⇒ 是 `taskkill` 打断 SQLite 的 WAL/锁让启动期卡住（"静默停摆"先数边界，见 [[localize-a-stall-by-counting-at-the-boundary]]），旧目录别再修、换名继续；
   干净目录也起不来 ⇒ **这才轮到怀疑 `45c021e` 的核心改动**（我只动过 `import_files` 的报告装配，理论上不碰 `serve` 启动路径 —— 而"理论上不碰"在这条流水线上从来不算证据），
   对比要用可逆方式（新 worktree / 另编一份旧 commit 到别的 target），**不要** `git checkout HEAD~1 --`。
2. 桥起来后先 `LANE_PREFLIGHT_ONLY=1 node scripts/verify-layout.mjs` 出预检数，再整跑，期望 **782 PASS / 0 FAIL** 对上第八十九批那条基线；
   跑到那一遍之**后**，才允许把"0.0.135 有全量读数"这句写进第九十一批那一格。


## 17:40 补：#94 读满了 —— 它问的是一个**不存在的主语**；真正缺的是**头**，而头里藏着一格没人守的硬约束（G130）

**这一批只动文档**（`docs/design/Noto-界面设计规范.v2.md` 新增 + 三处订正），**版本号没升、整跑没跑**：一个字节的产品代码都没改，
按既有做法（`.badge` 死块、`.force-show`、`c4294fe` 那一族）文档批次不占整跑。

**#94 的前提是假的，按 [[record-root-cause-only-after-reproducing-the-payload]] 的规矩先纠正再动手**：
- 用户 16:5x 登录后我把那份分享页**读满**了：`main` 容器可见文字 **10,164 字符**，一次读完、无分页、无折叠。
- 全文走完 §0 → §9 就以 §9「一句话」结束（最后一行「门可能关着、可能排队、可能坏了，但写字这件事不受影响。」）⇒ **这份规范压根没有 §10/§11**。
- 而我台上两份账**互相矛盾过**、我没发现：`SPEC-GAP-AUDIT-2026-10-14.md:10` 写「没有 §10，也没有 §11」（对），
  `SPEC-EXECUTOR-MAP-2026-10-14.md` 开头写「§10 往后（含 §11）在盘上根本没有文本」（错，且它把 #94 立成了"等人导出"）。
  **两份自证的账打架，本身就该在写第二份时被抓到** —— 教训已进用户侧记忆（对同一件事只留一份权威，另一份引它）。
- 于是 #94 从"等人工导出"改成"**已经导完，且上界解除**"：射程现在是 §0–§9 全文，`SPEC-EXECUTOR-MAP` 开头那一格有裁定。

**读满之后才知道：缺的不是尾，是头。** 旧快照 `Noto-界面设计规范.from-share.txt`（21,252 B）**从 §1.1 颜色表 `--ink` 那一行的中途开始**
（它第一个字是上一行"1px 分隔线、描边"的尾巴"边"）⇒ **§0 整章 + §1 那句总则 + §1.1 前五行从来没在盘上过**，也从来没进过任何一本对账的账。
导出这一份不是补档，是**新开了一段射程**（新 679 个字符）。

**新射程逐句扫完，两条我原本准备写"没人守"的，读了代码才发现有人守**（[[sweep-doc-commitments-against-code]] 反着救了我一次）：
- §1「两套主题变量集必须完全一致（键名相同、只换值）」→ `styles/tokens.spec.ts:280` + `:143` **有执行者**；
- §1「组件内禁止硬编码颜色，CSS 里出现 hex 或 `rgb()` 直接判失败」→ `tokens.spec.ts:154` **有执行者**；
  现量：`base.css` hex=0/`rgb(`=0、`editor.css` hex=0/`rgb(`=0、`.vue` 内联 hex **0 处**、`tokens.css` hex=52（**定义处**，规范禁的是组件侧）。
- §0.1（假开关那条）→ `negativePromises.spec.ts:70/:109/:211` 三族，**有执行者**，17:34 单跑该文件 **62/62 绿**。
- §0.3（不许把两种情况折成一句）→ §2.3 那三句静止话各有旧证人，**对上了**。

**只有一格真空：G130 —— §0.2「界面不许说协议话」在"用户可见文案"这一侧没有执行者，而今天有 5 句在说。**
规范那一句还自带承诺：「有 eslint + grep 门禁」。**两句都不成立**：
`arch-check.mjs:267 layer:ui-protocol-vocab` 扫的是**线协议词**（`PROPFIND/PROPPATCH/If-Match/If-None-Match/propstat/DaviCk/.notes/manifest`）落在源码里，
**与规范点名的九个字不是同一份名单**；`eslint.config.js` 全文只有 TS/Vue 风格规则，**一条词汇禁令都没有**。
现形的五句（逐条带"它凭什么到屏幕"）写在 `SPEC-EXECUTOR-MAP` 末节那张表：`settings.tlsCaPemHint`（WebDAV，`SettingsView.vue:517` 真画成 field-hint）、
`:452` 与 `:496` 两句凭据被拒（WebDAV）、`sync.cap.strongEtag`（ETag，**靠 `serverCaps.ts:37` 动态拼键** `sync.cap.${name}` ⇒ grep 键名会判成死键）、
`sync.divergence`（「远端的清单…」，**靠 `notera-core/src/error.rs:91` 错误码注册表**才到屏幕）。
⇒ 这两处是 [[sweep-doc-commitments-against-code]] 里"使用者是扫描器看不见的那一类"的**现行样本**，落刀时必须拿动态面与错误码面各当一条证人。

**「清单」不能一刀切**：这个字有三处正当用法（`template.todo` 待办清单 / `tb.checklist`+`editor.blockChecklist` 勾选块 / `settings.backupLoading` 备份清单）。
把整词禁掉会红三处合法现场 —— **扫到一片红同样不等于抓对了**。待落那把刀的口径写在台账里，并已连第六处（`tauri.conf.json` 的 `longDescription` 那句 WebDAV）一起摆到 **D19** 等人拍：
**前五句不用拍（点名禁就是合规），只有包元数据那句算不算"用户可见文案"是口径**。
**订正（第一百批）：#104 不等 D19** —— 上一行那句"#104 等 D19"说过头了：等一个包元数据的问题去挡五句屏幕上确实在说的协议话，是把不确定的那一小块扩成整批的阻塞。
D19 只决定那把刀的**扫描面要不要多包一层 `*.conf.json`**；迟迟没拍就按"应用内文案面"落刀，包元数据那一格继续留账（这不等于拍 B）。
来历：同一句"唯一阻塞"我同时写进台账与记忆 ⇒ 又造出一次"同一件事两份账"（见 `NEEDS-OTHER-MACHINE-TESTING.md` D19 那节末与 [[two-ledgers-on-one-fact-collide-check-them]]）。

**顺带发现、本批不修的一处文档伤**（写在这儿免得丢）：`python` 扫全部 `docs/**/*.md`，**有 3 处叙述插进了表格中间**
（`IMPLEMENTATION-STATUS.md:27`、`PRODUCTION-READINESS.md:58`、`NEEDS-OTHER-MACHINE-TESTING.md:72-73`）⇒ 从那一行起 GFM 表格降级成纯文本、后面那些 `|` 行也不再是表。
其中前两处那行叙述里还带着 `/拒绝|不会被保存|配不了/` 这种**裸竖线**，正是它把行拆断的。
**为什么不在这批修**：这三张表是历史台账，修要移动行、重排表头，和"导出规范 + 扫 §0"是两件不同的事（一条 commit 一个缺陷）。
**修法**：把那行叙述移到该表**末**并转成 `> ` 引用；裸竖线改成 `\|`。谁碰这三个文件时顺手带走，别再单开一批。
