# 规范 → 执行者 审计（2026-10-14，静态只读一遍）

范围：`docs/design/Noto-界面设计规范.from-share.txt` §2–§8 逐句，对三条执行者通道
（`scripts/verify-layout.mjs` 的 776 条读数、`apps/desktop/src/**/*.spec.ts`、`scripts/arch-check.mjs`），
外加 `verify-app.mjs` / `verify-blackbox.mjs` / Rust `crates/**/tests`，免得把"只在别处有"的东西漏报或误报。
**这一份不是结论清单，是待办清单**：下面每一条都要自己复验一遍再动手（本仓的规矩是"根因要复现出载荷才落笔"）。

先记两条与文档本身有关的事实（不是缺口）：

- 快照到 **§9 一句话** 就结束（后面是 `100% / 重置` 的残片）——**没有 §10，也没有 §11**。
  代码里 `syncClickGate.spec.ts:193` 与 pptx 转写稿引用的 `§11.4` 指的是**另一份文档**，不是这份规范。
  ⇒ 谁按 §11 去核对会找不到主语；要么把那两处引用改成真实出处，要么在本文件里写明它引的是哪份。
- §7 那十一格里，"窗口高度让位优先级 / 彻底删除删不删服务器字节 / 本地静态加密 / 双窗口 / 64 条上限 / 快捷键表锁定"
  是**明写"先别作画"**的格子 ⇒ 按定义不算"缺执行者"，不在下面的名单里。

## 八条真缺口（按可动手的程度排序）

1. **§4.8「单文件 ≤8 MiB，超了显式失败不许静默截断」——"显式失败"那一半没人证，而且屏幕上说的是错的那句。**
   闸门在（`crates/notera-importer/src/source.rs:13,83,105,269`，有 Rust 测试），但没有任何一条腿真喂一份超限文件。
   `crates/notera-host/src/lib.rs:1626-1658` 把这种文件只塞进 `notices` ⇒ `SettingsView.vue:764` 照旧打
   「新增 / 重复 / 失败：N / N / **0**」，而实际有一份没进来；那句话还是 Rust 的 `Display` 串（带裸字节数，
   `notera-importer/src/error.rs:13`）。ZIP 那条路更糟：`import_data`/`import_files` 把所有 importer 错误折成
   `CmdError::of("save_failed")`（`lib.rs:1618,1650,1667`），前端只读 `messageKey` ⇒ 屏幕上念的是
   「设置没能保存，改动还留在这台设备上。」（`i18n.ts:481`）—— **主语错、没有限制值、也没说"什么也没进来"**。
   `verify-app.mjs:1405-1414` 只钉了 happy path 的 2/0/0。
2. **§4.3「两套库指向同一远端目录 → 停下告警，绝不合并」——§4.3 里唯一没有界面证人的一格。**
   引擎发得出（`notera-host/src/lib.rs:2401-2408` → `Badge::Failed` + `sync.root_mismatch`），文案也登记了
   （`i18n.ts:490`），但只有 `crates/notera-host/tests/crash_recovery.rs:231` 那条命令路径行为测试；
   `arch-check` 的 `hygiene:rust-message-keys-registered` 只证明**键存在**，不证明**画得出来**。
   同章其余各格都有腿：缺口令 ㉛、已关闭 ㊵、未配置 ㉔、丢记录人工确认 ㉜、百分比 ㊹、租让路 `syncClickGate.spec.ts:243`。
3. **§4.3「被预算截断的长轮次只能说"还在同步"，绝不能说"已同步"」——三条通道 + Rust 测试里零证人。**
   守卫是真的且在承重（`notera-sync/src/lib.rs:499-508,630-648`，注释自己写着"账上（脏）是干净的，界还会说'已同步'"）。
   `grep -rl capped` 只命中那一个源文件。最近的界面读数钉的是别的事（㊹ 的排队数、`syncLastSuccess.spec.ts` 的"上一次"）。
   ⇒ 注入方式可以照 ㉛/㊹ 那一族抄（把"截断"这一位打进去，看徽标说什么）。
4. **§4.9 动画参数 + §1.6 三个 token：四个数没有一个被钉住。**
   `tokens.css:113-115` 声明了 `--motion-fast:120ms`/`--motion-base:220ms`/曲线，`base.css:717`、
   `SyncBadge.vue:135`、`RichEditor.vue:1059` 写的是 `sync-spin 1.4s`；但唯一与动效有关的断言是
   `tokens.spec.ts:165-166`（reduced-motion 下 `--motion-fast: 0ms` —— **没有 `--motion-base`**，
   而 §1.6/§4.9 说的是"全部时长归零"）与 `motion.spec.ts`（只禁 property，从不读值）。
   各腿读的是 `animationName` / `getAnimations().length`，**时长与缓动一次都没读过**。
   顺带捞到一条漂移：`base.css:533-541` 还挂着第二条不合规的 `animation: spin 1.6s linear infinite`
   在 `.badge[data-badge='syncing']` 上（这个选择器没有模板在用），与 1.4s 的 `sync-spin` 并存，没人发现。
5. **§6「已声明但零消费者的能力位：生物识别 · 系统分享 · 文件选择器 · 紧凑工具条 · 安全区 · 拖放 —— 在真接上之前不许画对应控件」——整条没人证。**
   `negativePromises.spec.ts:70-90`（§2.5）只查"`:disabled` 不许带能力位、有些 `v-if` 带"——
   一个 `v-if="caps.compactToolbar"` 的控件会**同时满足它并违反 §6**。
   `arch-check` 的 `edge:caps-wire-vocabulary` / `layer:platform-surface-declared` 管的是键名、取值词表与壳声明，不管消费者。
   现状：文件选择器与拖放**已经真接上了**（`api/bridge.ts` G75、`RichEditor.vue` + 腿 ㊴），安全区走 CSS `env()`
   （`base.css:641,746`），而 `shareSheet`/`biometric`/`compactToolbar` 除了 `caps.ts` 自己没有读者 ——
   而且 `caps.ts:84-85` 在浏览器档里把 `safeArea`/`compactToolbar` 按 UA 默认成 `mobile`，正是 `commands.rs:925` 警告的"假开关"形状。
   ⇒ 这一条名单本身也过期了（六个里有三个已接），要先按事实重列再写判据（别拿旧名单当规范）。
6. **§6-7 + §7「端到端加密」——已裁定"不开放"，但没有任何东西保证它继续"没有入口"。**
   `set_vault` 在 `apps/desktop/src` 与 `notera-host/src/commands.rs` 里**零引用**（今天实测），
   而最近的判据 `negativePromises.spec.ts:105-115` 匹配的是 `/本地[^']{0,10}加密|已加密|静态加密|存储加密|at-rest/`
   —— 抓"本地已加密"这种谎，**抓不到「端到端加密」「开启加密」「恢复词」**。也就是说今天有人把那套流程接上，
   所有门禁照绿。裁定目前只在决策日志里，`SPEC-AMENDMENTS.md` 里没有它，`NEEDS-OTHER-MACHINE-TESTING.md:65` 的 D7 还挂着"待拍板"。
   （2026-10-14 用户已拍：**不开放、不画界面** ⇒ 这一条要补的是"结案 + 一条守住它的判据"，见任务列表。）
7. **§2.5「28 / 44 / 52 触摸目标容器尺寸」——28 这一档没有主人也没有证人。**
   44 有人（`tokens.spec.ts:121` + 腿 ㊲），52 由腿 ㉕ 经 §3.5 间接钉住；`28` 在应用的 token 与 CSS 里**根本不出现**，
   只在设计参考表 `docs/design/tokens.design-v2.css:213` 里有。§1.4 那六档有 A3/A3.1/A3.3/A3.5 逐档归属 +
   `controlHeights.spec.ts:62` 那颗"多一颗红、少一颗也红"的双向闸，**§2.5 没有同形的归属裁定**。
   （"不是图标本身放大"那一半已由腿 ㉕/58 观察到，不缺。）
8. **§4.9「禁用态不写『为什么不能点』：要么给原因文案，要么根本不渲染」——只执行了后半个分支。**
   "不渲染"那一臂有证人（`negativePromises.spec.ts` §2.5），"原因文案"那一臂一个都没有；
   而且**在维护的例子恰好走的是另一臂**：`verify-layout.mjs:2210`（腿 ㉒）断"空名字时「确认」是禁用的"，
   不要求屏幕说清为什么，`newFolderDialog.spec.ts:10` 钉的是同一形状。⇒ 要么给那两颗补一句原因，
   要么把这条判据写成"两臂择一但必须择一"（现在它是单向的）。

## 已经查过、**不该再报**的（避免下一个人重复劳动）

§1.4 六档（A3/A3.1/A3.3/A3.5 + `controlHeights.spec.ts` + 腿 ㊲）· §2 禁 Unicode 字形与文字类 SVG
（`iconSystem.spec.ts:56-86` + 腿 ㉟/58）· §2.1 画布/描边/端点/同屏同粗细（腿 58/61/㉟）·
§2.2 载体分组两半（`iconSystem.spec.ts:99-147`，同族共享基形 + 异族不撞脸，带可反证的豁免表）·
§2.3 五格语义与三句静止（腿 59/㉔/㉛/ + `syncBadgeCells.spec.ts`）· §2.5 禁用态不画灰图标 ·
§3.1 断点与栏宽（`layoutBreakpoints.spec.ts:45-52` + 腿 ㊱/④/④′/⑥）· §3.2 侧栏结构与底部读数 ·
§3.3 空态两句/分档/不搜回收站/四条"没有"（腿 57/㊶ + `searchTier.spec.ts` + `search_paths.rs:277` +
`negativePromises.spec.ts:294-338`）· §3.4 工具条位置（腿 70）与溢出（腿 ㉝）· §3.5 每个数 + visualViewport 避让 ·
§4.1 · §4.2 四行（含"恢复后必须能立刻打字"）· §4.4（含 32 MiB 与三种拒绝各一句话）· §4.5 · §4.6 三时点 ·
§4.7 · §4.8 的**其余**三句（导出格式 / 不覆盖 / 报告三行 / 要重启）· §4.9 按钮四变体×五态、输入框四态、
行 hover、浮层、Toast · §5 每一行 · §6 十条"明确不做"（九条 describe + A1 标签）· §8 三问。

**一条保留意见（不是缺口，是判据的射程）**：§8 第一问"只看界面就说清有没有在同步"里那两条协议词读数
（`arch-check layer:ui-protocol-vocab` 与腿 ㊿/51）是**面板级**的（附件格、版本格），不是整屏通扫。
如果哪天有别的格子把 `rev`/`op`/`tombstone` 印到屏幕上，今天没有一条判据会红。
