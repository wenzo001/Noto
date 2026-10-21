# Noto / Notera — Unimplemented & Incomplete Inventory (evidence-based)

> **历史文档（冻结）**：以下是 2026-10-12 对当时那棵树（`0.0.125`）的只读盘点，**不再随代码更新**；
> 当前状态与读数以 [IMPLEMENTATION-STATUS](./IMPLEMENTATION-STATUS.md) 与 [PRODUCTION-READINESS](./PRODUCTION-READINESS.md) 为准。

**Method**: read-only analysis. Repo at `Cargo.toml:22 version = "0.0.125"`.
**Rule applied**: every claim is tagged as either **[doc]** (a document says so) or **[code]** (verified by reading/grepping source, with `file:line`). Where they disagree, both are shown.

> ⚠ **Read this first — the four named docs are stale by ~65 patch versions.**
> - `docs/PRODUCTION-READINESS.md` — dated 2026-10-02, version line **0.0.58** (`PRODUCTION-READINESS.md:3`)
> - `docs/IMPLEMENTATION-STATUS.md` — updated 2026-10-04 (`IMPLEMENTATION-STATUS.md:8`)
> - `docs/ARCHITECTURE-MAP.md §8` — baselines mixed from 0.0.46–0.0.58 (`ARCHITECTURE-MAP.md:192`)
> - `docs/UI-REDESIGN-BRIEF.md §6` — predates the entire "界面重构 v2" UI programme (第 1–51 刀 + 13–31 批)
>
> **The live gap ledger is `CHANGELOG.md`** (5859 lines): the consolidated open list is the section
> `### 已知限制（明确记为 BLOCKED / 待决，不当作已完成）` at `CHANGELOG.md:5676`–`5817`, and per-gap
> `Gxxx` bullets are scattered through the "界面重构 v2" sections. An inventory built only from the four
> named docs would report roughly **12 already-fixed items as still open** and **~11 already-exposed
> capabilities as "no UI entry point"**.

---

## 1. Open gap items (not fixed / not closed)

Legend for **Size**: S ≈ <1 day, M ≈ 1–5 days, L ≈ >1 week.
**Protocol change?** = does it alter `SYNC-PROTOCOL` / wire / rev semantics ⇒ per `ARCHITECTURE-MAP §9` requires an ADR + human review.

### 1.1 Confirmed still open — verified in code

| ID | One-line description | Doc source | Code verification | Blocked on | Size | Touches | Protocol change? |
|---|---|---|---|---|---|---|---|
| **G15** | Block-level three-way merge exists as a library but is **never called** by the product; `auto_merged` has never been true | `PRODUCTION-READINESS.md:337-345`; `CHANGELOG.md:859` | **[code] CONFIRMED.** `merge()` defined at `crates/notera-richtext/src/merge.rs:53`. Repo-wide grep for `richtext::merge` / `merge::merge` / `use notera_richtext::{…merge…}` → **zero matches**. All three production write sites pass `auto_merged: false`: `crates/notera-host/src/lib.rs:4012`, `:5573`, `:5614` | — (implementable) | **L** | `notera-sync/src/plan.rs`, `notera-sync/src/lib.rs`, `notera-host/src/lib.rs`, `notera-store` (conflict table) | **YES** — changes sync decision + rev/hash semantics; doc itself says it needs an architecture review |
| **G16** | Two test hooks named in `CONFLICT-RESOLUTION §8` do not exist | `PRODUCTION-READINESS.md:346-350` | **[code] CONFIRMED.** Grep `NOTERA_SYNC_FORCE_CONFLICT` and `--scenario` across `crates/` → **zero matches**. `notera-cli` `SyncOnce` only has `--json` | — (implementable, engineering-efficiency only) | **M** | `crates/notera-cli/src/main.rs`, `notera-host/tests/` fixtures | No |
| **G21** | Server lost a record file and **no device will ever repair it** — the "404 → re-upload" path is unreachable | `PRODUCTION-READINESS.md:431-448`; `CHANGELOG.md:5764`-area | **[code] CONFIRMED, mechanism located.** Skip guard at `crates/notera-sync/src/lib.rs:857-866`: if `held` contains the key with same rev **and** same hash → `continue` (no GET issued). `synced_heads` is the source (`lib.rs:846`, trait decl `lib.rs:58`). The P3 repair rule fires only when `remote = None` (entity absent from manifest), not when the manifest lists it but the record 404s: `crates/notera-sync/src/plan.rs:140-151`. So a 404 on a converged entity is structurally unobservable | **BLOCKED — needs a product decision on the performance tradeoff** (any per-round full verification breaks the PERF-05 "empty round = 1 request / 0 bytes" promise) | **M** (after decision) | `notera-sync/src/lib.rs`, `notera-store` (query), new two-device test | **YES** — new remote-read policy on the round budget |
| **G23** | Permanently deleting a note does **not** delete its attachment blobs from the server | `PRODUCTION-READINESS.md:1343-1362`; `CHANGELOG.md:5747` | **[code] CONFIRMED.** Grep for any remote attachment delete (`delete_attachment` / `delete_blob` / DELETE-on-attachment) in `crates/notera-webdav/src` and `crates/notera-sync/src` → **zero matches**. Local side has full GC (`App::reclaim_unreferenced_blobs` / `purge_released_blobs`); remote has none. Measurement probe still present: `crates/notera-host/tests/sync_once.rs::probe_purge_and_remote_attachment_blobs` (`#[ignore]`) | **BLOCKED — needs D8 product decision ("who has the right to delete")** + architecture review (new destructive remote write path) | **L** | `notera-sync/src/lib.rs`, `notera-webdav/src/client.rs`, `SYNC-PROTOCOL §13`, planner | **YES** — new remote DELETE path; doc explicitly says "this is a new remote write/delete path, not a few lines" |
| **G34** | Product retry/backoff is hardcoded to `deterministic(40ms, budget 1, jitter 0)` — **not** the documented `2s × 1.85ⁿ × (1±0.2)`, budget 3 | `PRODUCTION-READINESS.md:982-997`; `CHANGELOG.md:5737-5746` | **[code] CONFIRMED.** `crates/notera-webdav/src/client.rs:101`: `retry: RetryPolicy::deterministic(40, 1),` — this is the production constructor. `RetryPolicy::default()` (the documented policy) has **no production caller**; every other `deterministic(...)` hit is a test (`retry_in_round.rs:88` is a comment describing this exact defect) | **BLOCKED — needs a §9-level tradeoff decision** (switching to `default()` raises "one failed round" from 40 ms to ~10 s, which pulls in UI feedback latency, offline tests, and the 20 s round budget) | **S** (the code change) / **M** (re-baselining tests) | `notera-webdav/src/client.rs:101`, `PROXY.md §7`, `crates/notera-host/tests/retry_in_round.rs` | No (but changes documented behaviour + several gate baselines) |
| **G31** | At very small window heights the sidebar's scroll area is squeezed to uselessness by the pinned sync row / settings footer; the last folder rows can't be clicked | `PRODUCTION-READINESS.md:1051-1077` | **[code] STRUCTURE PRESENT.** `apps/desktop/src/components/SidebarPanel.vue:117` `.pane-body` (scroll area) sits above `.side-foot` (`:146`) and `.side-sync` (`:183-191`). All three footer-ish blocks are `flex: 0 0 auto` (`:190`) — they never shrink, so they consume the column and starve `.pane-body`. No `overflow-y`/`min-height` compensation exists. Doc's 2026-10-05 re-measure narrows the boundary to "below ≈430 px height" (`PRODUCTION-READINESS.md:1059-1065`) | **BLOCKED — needs a layout policy decision (who yields in short windows)** | **S–M** | `apps/desktop/src/components/SidebarPanel.vue`, `styles/base.css:152-168`, `scripts/verify-layout.mjs` allowlist | No |
| **G61** | Main bundle grew 216 kB → 281 kB (gzip +12 kB) after switching to headless components; **no size gate exists** | `CHANGELOG.md:5797` | **[code] PARTIALLY CONFIRMED.** `scripts/check-frontend-dist.mjs` checks that the dist **exists/is non-trivial** (entry present, has JS, `index.html` references a chunk, total not absurdly small — see comment at `check-frontend-dist.mjs:6`) — it asserts a **lower** bound, not an upper budget. No `size-limit`/budget check found in `scripts/`. Exact current figure **unverified** (no build run in this read-only pass) | — (implementable) | **S** | `scripts/check-frontend-dist.mjs`, `.github/workflows/ci.yml`, `apps/desktop/vite.config.ts` | No |
| **G70** | Export folder list still indents by depth while the sidebar is flat (one level only) | `CHANGELOG.md:5716-5722` | **[code] CONFIRMED.** `apps/desktop/src/views/SettingsView.vue:738`: `:style="{ paddingLeft: \`${0.5 + f.depth * 0.75}rem\` }"` — the only remaining reader of `f.depth` | **待拍板** — two legitimate options (drop the indent and put "includes N children" in the copy, vs keep it and clarify it's only an export scope) | **S** | `apps/desktop/src/views/SettingsView.vue:738`, i18n copy | No |
| **G116** | "Every control must render all five interaction states" has no executable gate (hover-state pixel comparison) | `CHANGELOG.md:4641-4712`, `:4722-4749` | **[code] CONFIRMED OPEN.** No committed script performs a hover-state pixel diff. `CHANGELOG.md` is explicit that the scan was parked in `.logs/leg63-parked-v3.mjs`; no such file exists in `scripts/` and no `.logs/leg63*` remains on disk | — (implementable, but needs the scan redesigned for ancestor visibility) | **M** | `scripts/verify-layout.mjs` or a new gate, `apps/desktop/src/components/` | No |
| **Typing-race residual** | Input can be dropped when the editor is in a blocked state (new note not yet ready / read-only); the second half — **buffering** the blocked input — was never built | `CHANGELOG.md:5764` | **[code] CONFIRMED.** `apps/desktop/src/stores/editor.ts:240-248`: `updateBlock` on `writeBlocked` sets `saveState = 'error'` + `saveErrorKey = 'save_dropped'` and **returns — the input is discarded, not buffered**. The lie ("已保存") was fixed; the data loss is not | — (implementable) | **M** | `apps/desktop/src/stores/editor.ts:240`, `stores/notes.ts` | No |
| **G14** | When two devices each make a locally-valid folder move that forms a cycle, both sides silently keep their own version and **nothing explains why** | `PRODUCTION-READINESS.md:329-336`; `CHANGELOG.md:859` | **[code] PARTIALLY CONFIRMED.** The cycle is refused rather than written, but no table/column stores "the rejected parent value" (the doc's stated prerequisite). Full confirmation of the *refusal* path not traced in this pass → treat the "no explanation" half as **[doc] confirmed, [code] unverified in detail** | — (implementable) / or a §51 decision to let it diverge silently | **M** | `notera-sync/src/lib.rs` (fold apply), `notera-store` (new column), i18n | Arguably — new persisted field |
| **G28** | `ci.yml` "frontend unit tests" step was red once and green twice on **byte-identical** frontend source; cause never located | `PRODUCTION-READINESS.md:1103-1127` | **[code] UNVERIFIED** (needs the CI job log, which requires an authenticated token — the doc records HTTP 403). Not reachable from the working tree | **BLOCKED — needs a GitHub token to read run #111 step 13 logs** | S (diagnosis) | `.github/workflows/ci.yml`, `apps/desktop` test setup | No |

### 1.2 Documented as open but **already fixed in code** (stale-doc traps)

These are the items a doc-only reading would wrongly report as open. Verified against the live ledger + code.

| ID | Doc claim | Reality | Evidence |
|---|---|---|---|
| **G38** | `CHANGELOG.md:5723` says "**未修，等口径拍板**" (unfixed, awaiting decision) | **FIXED in 0.0.52.** `PRODUCTION-READINESS.md:571-623` documents the implemented option B (in-process session credential table, `notera-host/tests/credential_session.rs` 7 tests, mutations M-G38c..g). **The two docs directly contradict each other.** Residual: real-device verification on macOS/Android | `PRODUCTION-READINESS.md:599-623`; `IMPLEMENTATION-STATUS.md:58` (marked VERIFIED) |
| **G43 / G44 / G45** | Listed as defects in places | **FIXED** (0.0.55 / 0.0.57 / 0.0.58) with mutation-sensitive lanes; `PRODUCTION-READINESS.md:898`, `:660`, `:682` | `PRODUCTION-READINESS.md:17-20` |
| **G46–G60, G62–G69, G71–G114 (most)** | Individual `Gxxx` registrations | **Closed**, each with a "第 N 刀/批" close record in `CHANGELOG.md` | `CHANGELOG.md` per-gap bullets; `CHANGELOG.md:5677` (G92 explicitly **withdrawn** — the registration itself was wrong) |
| **G63** | Folder soft-delete still shown to UI | **FIXED.** `notera-host::list_folders` filters trashed folders while `Store::list_folders` keeps them for the sync feed (two-leg test) | `ARCHITECTURE-MAP.md:233` |
| **G108** | Two `verify-app.mjs` steps' premises permanently broken by the folder-depth change (red since 0.0.107) | **FIXED.** `scripts/verify-app.mjs:785` now documents "the fixture must be flat (`parentId: null`)" and `:792` builds with `parentId: null` | `scripts/verify-app.mjs:785,792` |
| **G118** | Backup list has no loading state — renders a **false empty state** while loading | **FIXED.** `apps/desktop/src/views/SettingsView.vue:779` renders `data-testid="backup-loading"` when `!backupsLoaded` | `apps/desktop/src/views/SettingsView.vue:779` |
| **G60** | "One folder level only" was UI-only; core accepted `parentId` | **FIXED / now enforced in core.** `crates/notera-host/src/commands.rs:794-796` (`create_folder`) and `:837-838` (`move_folder`) return named code `folder_nested`; test `notera-host/tests/folder_depth.rs` | `crates/notera-host/src/commands.rs:794,837` |

---

## 2. UI-REDESIGN-BRIEF §6 — "implemented in backend but no UI entry point"

**Headline: this table is substantially obsolete.** The "界面重构 v2" programme (CHANGELOG, 第 1–51 刀 plus 批 13–31) built almost all of the ⚠️ column. Below is the verified current state.

### 2.1 ⚠️ items that are **now exposed** (doc says "no UI", code says UI exists)

| §6 item (doc claim) | Rust command / function (verified) | UI call site (verified) | Verdict |
|---|---|---|---|
| **备份列表选择器** — "user must hand-type a file path" | `"list_backups" => j(app.list_backups()?)` at `crates/notera-host/src/commands.rs:985` | `apps/desktop/src/api/types.ts:536` (`listBackups: 'list_backups'`) + `apps/desktop/src/backupPicker.spec.ts` (whole spec exists) + `SettingsView.vue:10` imports `BackupInfo` | **EXPOSED** (CHANGELOG 第 19 刀, `CHANGELOG.md:2857`) |
| **系统文件对话框** — "plugin wired, user still types path" | Tauri `dialog` plugin | `apps/desktop/src-tauri/capabilities/default.json` grants `dialog:allow-open`, `dialog:allow-save` — **the repo's first capability file**; CHANGELOG 第 47 刀 closes **G75**; `verify-tauri-window` now asserts `plugin:dialog\|save` is actually issued and ACL-permitted | **EXPOSED** (`CHANGELOG.md:4160`, `:5687-5715`) |
| **把文件拖进来** — "capability on, handler not written" | `attach_file` command | `apps/desktop/src/components/RichEditor.vue:724`: `@dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"`; handler logic at `:607-615`; gate `apps/desktop/src/fileDrop.spec.ts:37,39` | **EXPOSED** (CHANGELOG 第 20 刀, `CHANGELOG.md:2863`) |
| **同步详情** — "backend has it all, only 5 facts surfaced" | `"sync_status" => j(app.sync_status()?)` at `commands.rs:923`; DTO carries `pendingOps`/`openConflicts`/`messageKey`/`lastSuccessAt` | `apps/desktop/src/api/types.ts:525`; `stores/sync.ts:175` (last success from `sync_status.lastSuccessAt`), `:194` (`pendingOps`/`openConflicts`); specs `stores/syncBacklog.spec.ts`, `stores/syncLastSuccess.spec.ts` | **EXPOSED** (CHANGELOG 第 25 刀, `CHANGELOG.md:3342`) |
| **搜索结果分档标注** | search DTO tier fields | CHANGELOG 第 22 刀 "§3.3 搜索结果分档接到界面"; also fixed a fake 40-char-guessed title (**G93**) | **EXPOSED** |
| **偏好跨设备带走** | `"set_pref"` at `commands.rs:949`, `"get_prefs"` at `:955` | `apps/desktop/src/api/types.ts:501-502`; spec `stores/prefsBridge.spec.ts:4-5` states the commands "existed and the frontend never called them" — now it does. **Note: the cross-device half was ruled out by the user** ("跨设备那一半用户裁定不做", `CHANGELOG.md:3341`) | **EXPOSED (local) / ❌ cross-device by decision** |
| **文件夹排序 / 移动文件夹** | `"move_folder"` at `commands.rs:832` | Move is used (`notes.moveTo`); folder **reordering** collided with G60 and is **not** done (`CHANGELOG.md:3342`: "✗(撞 G60)") | **PARTIAL** — move exposed; sort absent |
| **笔记与文件夹的颜色** | `"set_note_color"` at `commands.rs:761`, `"set_folder_color"` at `:807` | `api/types.ts:486,488`; tests assert a real command is sent: `stores/folders.spec.ts:83-84` ("一次都没发命令：色点是画上去的假象"), `stores/notes.spec.ts:305-306`. Folder color → sidebar dot (第 39 刀); built-in books (第 40 刀); note color used as a list-row tag dot (第 43 刀) | **EXPOSED** |
| **"这条是哪台设备改的"** | `stats.device_id` / revision `deviceId` | `SettingsView.vue:672-673` (`data-testid="device-id"`); CHANGELOG 第 45 刀 (on screen) and **第 48 刀 closed G111** — remote edits were losing their signature (`commit_edit` hardcoded `self.device`) | **EXPOSED** |
| **版本历史** | `"note_revisions"` at `commands.rs:885`, `"note_revision"` at `:890` | `api/types.ts:518`; `stores/versions.ts` + `stores/versions.spec.ts`; CHANGELOG 第 32 刀 (list + rollback) and 第 34 刀 (**G100 closed** — block-level diff) | **EXPOSED** (list/diff/rollback all done) |
| **附件管理器** | `"attachment_inventory"` at `commands.rs:882`, `"attachment_retry"` at `:898`, `"attachment_reupload"` at `:906` | `SettingsView.vue:135,265,296,335,843-906` (per-object ledger, totals, two self-rescue actions); `api/types.ts:516`; CHANGELOG 第 31 刀 (read side), 第 35 刀 (per-object ledger, **G99 closed**), 第 36 刀 (the two rescue actions), 第 46 刀 (**G102 closed** — persistent "already reclaimed" ledger) | **EXPOSED** |
| **诊断** — "CLI only, no UI" | `notera-cli`: `Cmd::DavProbe` (`main.rs:40,256`), `Cmd::NetProbe` (`main.rs:45,284`) | Still **CLI-only** — no UI call site found for `dav-probe` / `net probe` | **BACKEND/CLI-ONLY** (doc still correct) |

### 2.2 ❌ items — verified still not implemented

| §6 item | Code verification | Verdict |
|---|---|---|
| **端到端加密** — doc: "整块能力没有任何开放入口" | **[code] WORSE THAN DOC SAYS.** The crypto crate is complete: `crates/notera-crypto/src/` has `envelope.rs` (39 kB), `vault.rs` (11.7 kB, `KeyVault`, `UnlockMethod`, `RECOVERY_WORDS = 24` at `vault.rs:29`), `recovery_wordlist.rs` (2048-word list). The sync engine is **fully plumbed**: `seal_outgoing` called at `notera-sync/src/lib.rs:779`, `open_incoming` at `:876`, `is_undecryptable` at `:875`. **But `set_vault` (`lib.rs:445`) has ZERO production callers** — grep across `crates/` and `apps/` finds only the definition and its own body; every other hit is in `notera-sync/tests/sealed_e2ee.rs`. ⇒ `vault_snapshot()` is always `None`, so `seal_outgoing` takes the plaintext bypass and **E2EE can never actually be enabled**. There is also no E2EE command in the dispatch table (grep `e2ee\|vault\|key_rotation\|recovery\|unlock` in `commands.rs` → **zero**) | **❌ NOT IMPLEMENTED (unreachable)** — the missing piece is smaller than "a whole flow": one host wiring point + the whole UI. Note **§7 lists E2EE as undecided** |
| **块级三方合并** | See **G15** above | **❌ NOT WIRED** |
| **表格块编辑** | No table editing implementation; the negative-promise gate guards only *cell-level merge*: `negativePromises.spec.ts:201-213` | **❌ NOT IMPLEMENTED** |
| **标签（tag 数据结构）** | 这一行原本写"No `tags` table/column anywhere" —— 那是 10-12 的读数，**已于 2026-10-18（第一百四十一批）作废**：`migrations/0010_tags.sql` 建 `tags` 表 + `notes.tag_ids`，`EntityKind::Tag` 是第四种可同步项，六条命令（`list_tags`/`create_tag`/`rename_tag`/`delete_tag`/`set_note_tags`/`note_tags`），界面有 chip 与侧栏那一族；`negativePromises.spec.ts` §6 那一族已经从"禁止存在"翻成"必须存在且只有这一个形状" | **✅ IMPLEMENTED (2026-10-18)** — 见 `docs/ADR/0022` 与 `SPEC-AMENDMENTS` A12。仍未落：搜索算符 `标签:`、批量加/摘（欠账逐条记在 CHANGELOG 同批） |
| **分面筛选 / 正则搜索** | 仍然不做，且由 §3.3 那面禁令守着：文案面禁 筛选/过滤/正则/facet/日期范围 等说法，控件面禁入口名里的 filter/facet/regex/scope/date-range/advanced（两面各自有对照，防"扫不到 ≠ 没有"） | **❌ NOT IMPLEMENTED**（有意为之） |
| **本地静态加密（库文件加密）** | Grep `SQLCipher\|sqlcipher\|pragma key\|encrypt` in `crates/notera-store/src/` → **zero matches**. Gate enforces the *prohibition on claiming it*: `negativePromises.spec.ts:81-88` bans "本地已加密" copy | **❌ NOT IMPLEMENTED** — and **§8 lists it as undecided**; any "local data is encrypted" wording is currently false |
| **口令/生物识别应用锁** | `biometric` cap bit declared at `apps/desktop/src/platform/caps.ts:16,63,102`; grep for `app_lock`/`appLock` → **zero**. So the bit is declared-but-unconsumed (exactly the `PLATFORM.md` anti-pattern) | **❌ NOT IMPLEMENTED**; capability bit declared with no consumer |
| **多窗口同条笔记编辑** | Grep `WebviewWindowBuilder\|new_window\|multi_window` in `apps/desktop/src-tauri/src/` and `crates/notera-host/src/` → **zero matches** | **❌ NOT IMPLEMENTED** |
| **移动端系统分享入口 / 分享出去** | `shareSheet` cap bit at `caps.ts:13,60,97`; grep for `systemShare`/`system_share` → **zero** | **❌ NOT IMPLEMENTED**; bit declared with no consumer |
| **Markdown/PDF/HTML 导出** | Export is only the self-owned ZIP bundle: `crates/notera-importer/src/bundle.rs:22` (`BUNDLE_FORMAT`). Gate enforces the prohibition: `negativePromises.spec.ts:96-104` bans Markdown/HTML/PDF/纯文本 copy on the **export** side (while allowing it on the import side) | **❌ NOT IMPLEMENTED** (and guarded) |
| **多账户（一台设备多台服务器）** | **Deliberately refused**, not merely unbuilt: ADR-0018 (Accepted). Root cause is that the convergence point `notes.sync_rev / sync_hash` is a **global column**, so a second account would silently never receive notes. Fixing it requires migrating the frozen data model (per-account association table) | **❌ BLOCKED BY DESIGN (ADR-0018)** — storage layer ready, protocol layer deliberately closed |
| **插件系统 / PAC 代理 / 实时多端光标** | Guarded as absent: `negativePromises.spec.ts:150-151,185-195` | **❌ NOT IMPLEMENTED** (explicit "不做") |

### 2.3 Capability bits declared with no consumer (the documented anti-pattern)

`apps/desktop/src/platform/caps.ts` declares 12 bits. Verified consumers:

| Bit | Declared | Consumed? |
|---|---|---|
| `tray` | `caps.ts:10` | Yes — gates the "keep in tray on close" pref via `shouldHideOnClose` (`caps.ts:122-124`) |
| `globalShortcuts` | `:11` | Yes — filters shortcut table (`caps.ts:145`) |
| `keychain` | `:14` | Yes — three credential messages (G38 option B) |
| `transparency` | `:20` | **Reported `false` deliberately** (`caps.ts:72-77`): Mica/Acrylic has zero call sites, so the switch is withheld — this is the *correct* pattern |
| `dragAndDrop`, `filePicker`, `safeArea`, `compactToolbar`, `windowChrome`, `bgTask` | `:12,15,18,19,21` | Yes (drag-drop now handled; see §2.1) |
| **`biometric`** | `:16` | **NO CONSUMER** |
| **`shareSheet`** | `:13` | **NO CONSUMER** |

`UI-REDESIGN-BRIEF.md:327-328` states the rule that matters here: bits declared-but-unused must not have controls drawn for them until they are genuinely wired.

---

## 3. Externally-blocked vs. implementable-in-repo

### 3.1 BLOCKED on external resources (cannot be closed from this repo)

| Item | Blocking resource | Source |
|---|---|---|
| macOS / Android / iOS builds + **real-device** runs | macOS hardware + Xcode; Android device; iOS certs | `PRODUCTION-READINESS.md:87` (B1); `ARCHITECTURE-MAP.md:239` |
| **Code signing / notarization** (D3) | Purchased certificates | `PRODUCTION-READINESS.md:164` |
| **The install action itself** — `.msi`/`.exe` both build, but nobody has installed one | A human installing on their own machine | `FINAL-REVIEW-2026-09-27.md:126` (G9) |
| **Real public/intranet WebDAV matrix** — Range/MOVE/conditional-request differences across Nextcloud/SeaFile/Apache mod_dav | A writable real server | `PRODUCTION-READINESS.md:88` (B2); `CHANGELOG.md:5853` (B5) |
| **Real intranet CA for `CaBundle`** — G35's fix proves rustls accepts two chain shapes, not that *any* enterprise CA works (long chains, CRL DPs, exotic key usages) | A real private-CA endpoint | `PRODUCTION-READINESS.md:561-563`, `:27` (G90) |
| **Screen-reader real-device pass** (NVDA / VoiceOver) | A human with a screen reader | `PRODUCTION-READINESS.md:128` (G11) |
| **G38 real-device grid** — the three credential sentences' actual rendering + "does the backlog resume after re-entry" on macOS/Android | A real macOS or Android device (gates use the `force_session_only()` seam and a fake `keychain:"none"` caps) | `PRODUCTION-READINESS.md:620-623` |
| **G57 real-device grid** — mobile shell background sync | An Android device (code + compile evidence only) | `PRODUCTION-READINESS.md:819-820` |
| **G58** macOS custom title bar | No Mac on hand | `CHANGELOG.md:5792` |
| **G59** iOS soft-keyboard timing / `offsetTop` | No iOS device | `CHANGELOG.md:5793` |
| **G28** `ci.yml` frontend-test flake root cause | **GitHub token** (job logs return HTTP 403 unauthenticated) + a reproducing environment | `PRODUCTION-READINESS.md:1112,1119` |
| **G13 / D5** cold-start budget wording (≤1000 ms vs tiered) | A human decision on the measurement convention; also G13 is a machine-speed artefact (WebView2 startup ≈800–1070 ms) | `PRODUCTION-READINESS.md:125` (B6), `FINAL-REVIEW-2026-09-27.md:130` |
| **G11/D8/G23/G21/G31/G34/G70 decisions** | Human product decisions (see §1.1) | scattered |

### 3.2 Implementable purely in this repo (no external resource needed)

`G15` (L, needs ADR), `G16` (M), `G21` (M **after** decision), `G23` (L, needs decision + ADR), `G31` (S–M after decision), `G34` (S–M after decision), `G61` (S), `G70` (S after decision), `G116` (M), `Typing-race residual` (M), `G14` (M), **E2EE host wiring + UI** (L — the crate exists; add a host entry point + the whole design flow), `表格块编辑` (L), `分面筛选/正则搜索` (L) —— 原来这一格写的是 `标签/分面/正则`，**标签那一半已于 2026-10-18 落地**（见上面那一行与 ADR-0022）, `本地静态加密` (L, needs decision first), `应用锁` (M), `多窗口` (M), `移动端分享` (M), `Markdown/PDF/HTML 导出` (M), `文件夹排序` (S–M), `多账户` (L, blocked by ADR-0018 design).

---

## 4. Per-implementable-gap: size, touch points, protocol impact

| Gap | Size | Crates / files touched | Protocol change (§9 ⇒ ADR)? |
|---|---|---|---|
| **G15** block merge wiring | **L** | `notera-sync/src/plan.rs` (decision), `notera-sync/src/lib.rs` (rev/hash), `notera-host/src/lib.rs` (apply + conflict record), `notera-richtext` (no change) | **YES** — changes sync decision + rev/hash semantics; doc explicitly demands an architecture review |
| **G16** test hooks | **M** | `notera-cli/src/main.rs` (add `--scenario`), `notera-host/tests/` fixtures, `CONFLICT-RESOLUTION §8` | No |
| **G21** server-record repair | **M** after decision | `notera-sync/src/lib.rs` (verification window), `notera-store` (new query), two-device test in `notera-host/tests/sync_once.rs` | **YES** — new remote-read policy interacting with the round budget |
| **G23** remote blob deletion | **L** | `notera-sync/src/lib.rs`, `notera-webdav/src/client.rs`, `SYNC-PROTOCOL §13`, planner, `notera-host/tests/sync_once.rs` (probe → assertion) | **YES** — new destructive remote write path |
| **G31** sidebar short-window layout | **S–M** | `apps/desktop/src/components/SidebarPanel.vue:117,146,183-191`, `styles/base.css:152-168`, `scripts/verify-layout.mjs` (remove G31 allowlist) | No |
| **G34** retry policy | **S** code / **M** re-baseline | `notera-webdav/src/client.rs:101`, `PROXY.md §7`, `notera-host/tests/retry_in_round.rs`, `notera-webdav/tests/retry_backoff.rs` | No (but re-baselines several gates) |
| **G61** bundle budget gate | **S** | `scripts/check-frontend-dist.mjs`, `.github/workflows/ci.yml` | No |
| **G70** export indent | **S** | `apps/desktop/src/views/SettingsView.vue:738`, i18n | No |
| **G116** hover-state gate | **M** | new/existing `scripts/verify-layout.mjs` leg, `apps/desktop/src/components/` | No |
| **Typing-race residual** (buffer blocked input) | **M** | `apps/desktop/src/stores/editor.ts:240-248`, `stores/notes.ts` | No |
| **G14** rejected-field explanation | **M** | `notera-sync/src/lib.rs` (fold apply), `notera-store` migration (new column), i18n | Arguably — new persisted field |
| **E2EE enablement** | **L** | `crates/notera-host/src/lib.rs` (call `set_vault`, the single missing wire), `commands.rs` (new commands), `apps/desktop/src/views/SettingsView.vue` + new views, `DATA-MODEL` (vault/key storage), `notera-sync/src/lib.rs:426-456` (already done) | **YES** — `enc.alg` flips from `none`; key rotation + "device has no key" is a protocol-visible transition (ADR-0002 reserved the structure, but enabling it is a decision) |
| **表格块编辑** | **L** | `notera-richtext` (table semantics), `apps/desktop/src/editor/`, `RichEditor.vue` | Arguably — table blocks already exist in the model; editing may not require wire change |
| **标签 / 分面 / 正则** | **L** | `migrations/` (new tag tables), `notera-store` (queries/FTS), `notera-host` (commands), UI, `DATA-MODEL` | **YES** — new synchronized entity kinds |
| **本地静态加密** | **L** | `notera-store` (key handling), `notera-host` (unlock flow), UI, `ADR-0016` (currently Proposed) | No (local-only) but **needs ADR-0016 to be accepted first** |
| **应用锁 (口令/生物识别)** | **M** | `crates/notera-host/src/credential_store.rs` (reuse), `apps/desktop/src-tauri/`, UI, `caps.ts:16` consumer | No |
| **多窗口同条笔记编辑** | **M** | `apps/desktop/src-tauri/src/lib.rs`, `notera-host` (multi-window state), `ADR-0017` (currently Proposed) | No, but needs ADR-0017 accepted (leaning: second window read-only) |
| **移动端分享入口** | **M** | `apps/mobile/src-tauri/`, `caps.ts:13` consumer, `PLATFORM.md` | No |
| **Markdown/PDF/HTML 导出** | **M** | `crates/notera-importer/` (new exporter), `notera-host` command, UI, remove the negative-promise gate for the chosen format | No |
| **文件夹排序** | **S–M** | `notera-store` (ordering column), `notera-host`, `SidebarPanel.vue` | Arguably — ordering must sync ⇒ new field |
| **多账户** | **L** | `notera-store` migration (`sync_rev`/`sync_hash` → per-account table), `notera-sync`, `ADR-0018` (would be superseded) | **YES** — data model + protocol |

---

## 5. Where the docs and the code disagree (documentation-discipline findings)

1. **G38 is reported open and fixed simultaneously.** `CHANGELOG.md:5723` "状态 = **未修，等口径拍板**" vs `PRODUCTION-READINESS.md:571` "**状态 = 已修（0.0.52 …）**" and the option-B implementation at `:599-623`. The stale copy sits in the *live* ledger's "known limitations" section, which is exactly where a new engineer would look first.
2. **`UI-REDESIGN-BRIEF.md:299`** asserts the ⚠️ column "is the most worthwhile place to redesign — the real thing is underneath, only the entry point is missing." As of 0.0.125 that column is largely **already built**; a designer following §6 would re-draw existing features.
3. **`CHANGELOG.md` is the only current ledger.** The four named docs have no version-line consistency: 0.0.46 / 0.0.52 / 0.0.58 baselines coexist inside a single table (`ARCHITECTURE-MAP.md:192,197,210,211`), and `ARCHITECTURE-MAP.md:192` admits it: "本表下面那几行的数多数没跟着批更新 … 这一格滞后按 §45 记着".
4. **`negativePromises.spec.ts` is the most trustworthy "not done" source.** Because absent capabilities are guarded by executable gates that ban claiming them in UI copy, they cannot silently drift. Any inventory of "what is not implemented" should be cross-checked against this file (lines 17-18, 81-88, 96-104, 150-151, 185-195, 201-213, 263-311).
5. **A withdrawn registration.** `CHANGELOG.md:5677-5686` — **G92 was withdrawn**: the "handle hit area is 24×24, below the 44 requirement" registration was **the probe's error, not the product's** (the probe measured the mouse tier instead of the touch tier, and deduced geometry from token arithmetic). A user decision was made on the basis of this wrong registration and is now unnecessary. Treat any inventory that still lists G92 as open as stale.

---

## 6. Things I could not verify (stated as required)

- **Exact current frontend bundle size** (G61) — requires running `pnpm build`; I ran no build. `check-frontend-dist.mjs` asserts a lower bound only; the upper-budget absence is verified, the "281 kB" figure is doc-claimed.
- **G28's root cause** — requires an authenticated GitHub token for job logs (documented 403). Not verifiable from the working tree.
- **G14's refusal path in full detail** — I confirmed no "rejected parent value" storage exists and confirmed the doc's account, but did not trace the fold-cycle apply code line by line.
- **Whether any build/test gate currently passes** (test counts, layout leg counts, `verify-app` counts) — running the full gates (Rust workspace ~9 min, browser lanes) was out of scope for a read-only inventory. Gate *counts* quoted here are from `CHANGELOG.md`, not re-measured. Note `arch-check` **is** reproducible cheaply and **does** pass: I ran it → `arch-check: 34/34 条通过` (this is a live measurement, and `ARCHITECTURE-MAP.md:198` records 34/34 too, so that row is current).
- **G116's parked scan** — `CHANGELOG.md` says the script lives in `.logs/leg63-parked-v3.mjs`; no such file remains on disk, so I could not inspect its shape.
