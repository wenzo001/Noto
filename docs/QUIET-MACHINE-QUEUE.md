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

- **#90 剩下的 `.force-show`** 与 **D13 / D14 / D15 / D16 / #93** —— 等纸面拍板，拍完的当天才动判据/CSS。
- **#83 / #89 / #88** —— 它们的修法落在 `crates/notera-host/src/lib.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/platform/caps.ts` 这一族文件上；开工前先确认并行那一批已经落地，否则树不干净、上面第 0 步就过不去。
- 任何"再跑一遍看看"的重复整跑：一遍改前一遍改后就是全部证据，多跑的是成本不是信心。

## 已知会被挡住的两种情形（今天各真发生过）

- 提交额度会在几分钟内从 5.2 GB 掉到 0 GB ⇒ 预检 `exit 3` 是常态，等到稳了再跑，别用 `LANE_FORCE=1` 硬闯。
- 共享工作树里挂着别人的未提交产品改动 ⇒ 预检 `exit 4`。真要跑就 `LANE_ALLOW_DIRTY=1`，但那份读数**不许归因到任何 commit、也不许当"回到绿"的证据引用**。
