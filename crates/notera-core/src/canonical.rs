//! 标签名的**唯一**相等关系（ADR-0022 D3）。
//!
//! 为什么住在 core 而不是界面或存储层：Joplin 的同一颗标签在一条链上有四个执行者各算各的 ——
//! SQL 的 `COLLATE NOCASE`（只管 ASCII）、JS 的 `.toLowerCase()`、`Intl.Collator{sensitivity:'accent'}`、
//! 以及 `setTags.ts:66-67` 的裸 `includes()`。后果不是"看着不一样"，是**同一颗标签在四个地方算不等**：
//! 两台设备各建一颗、改一次名要清理、删了还留着链接。⇒ 这里只留一份算法，
//! 门禁那一批里有一条专门扫界面，不许出现第二个算 canonical 的地方。
//!
//! 顺序是 `NFKC( trim → 全 Unicode 小写 )`，**两头都做 NFKC**，两个理由各挡一种真错：
//!  · **小写会去归一化**：`İ`(U+0130) 小写下来是 `i` + U+0307 结合点。只做一遍的话
//!    "预组合形进来"与"分解形进来"可能算出两个值 ⇒ 第二遍让它成为自身的不动点
//!    （`canonical(canonical(x)) == canonical(x)`），这才是 `UNIQUE(canonical)` 能依赖的性质；
//!  · **必须是 NFKC 而不是 NFC** —— 这条是本批写测试时才发现的（ADR-0022 D3 原文写的是 NFC，
//!    而它自己点名的"全角/半角归一"NFC **根本做不到**：那是兼容性映射，只有 NFKC/NFKD 才折）。
//!    用 NFC 的话「ＦＵＬＬ」与「FULL」是两颗标签、连字 `ﬁle` 与 `file` 是两颗标签，
//!    正是我们要消灭的那类"看着不同其实相同"。订正记在 ADR-0022 与 CHANGELOG 同批那一格。
//!
//! ⚠ **这不是 Unicode casefold**，是 full case mapping 的小写一侧。差别有名字可举（见那条
//! `sharp_s…` 判据）：`ß`(U+00DF) casefold 是 `ss`，小写还是 `ß` ⇒ **"Straße" 与 "STRASSE"
//! 在这套规则下是两颗标签**。这一格是有意的取舍：换来零新依赖（`icu_casemap` 不在锁里），
//! 而中文、全半角、连字、组合变号这几类真实痛点已被 NFKC + 小写覆盖。
//! **不许在这里把它说成 casefold。**

use icu_normalizer::ComposingNormalizerBorrowed;

/// NFKC 组合归一器。`new_nfkc()` 是 `const fn`、数据表是编译进产物的（`compiled_data` 那一档），
/// 所以每次调用只是取一份静态表的引用 —— 不需要 `OnceLock`，也不额外长包。
fn nfkc() -> ComposingNormalizerBorrowed<'static> {
    ComposingNormalizerBorrowed::new_nfkc()
}

/// trim → NFKC → 全 Unicode 小写 → NFKC。空/全空白输入返回空串（拒空标题由调用方判）。
pub fn canonical_tag_name(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let folded = nfkc().normalize(trimmed).to_string();
    nfkc().normalize(&folded.to_lowercase()).to_string()
}

/// 两条已算好的 canonical 是否同一颗标签。**只许用这个比较**，别再在别处拼 `==`。
pub fn same_tag_canonical(a: &str, b: &str) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EntityKind;

    /// 先把行为**打出来**（下面每条断言都对着这一条的输出写，不是我推的）。
    #[test]
    #[ignore = "读数探针：cargo test -p notera-core -- --ignored --nocapture canonical"]
    fn print_measured_shapes() {
        for raw in [
            "İstanbul",
            "i̇stanbul",
            "café",
            "café",
            "ﬁle",
            "file",
            "ＦＵＬＬ",
            "FULL",
            "Ⅳ 阶段",
            "IV 阶段",
            "Straße",
            "STRASSE",
            "紧 急",
            "紧急",
            "  todo ",
            "TODO",
            "²",
            "Ⅷ",
        ] {
            println!("{raw:?} => {:?}", canonical_tag_name(raw));
        }
    }

    /// 幂等：这一条是 `UNIQUE(canonical)` 的地基。它红了就是"同一颗标签会算出两个值"。
    #[test]
    fn canonical_is_a_fixed_point() {
        for raw in [
            "İstanbul",
            "Ünïcödé",
            "ＦＵＬＬ",
            "  已同步  ",
            "Ⅳ 阶段",
            "ﬁle",
            "Straße",
        ] {
            let once = canonical_tag_name(raw);
            let twice = canonical_tag_name(&once);
            assert_eq!(
                once, twice,
                "{raw:?} 走两遍算出两个值 ⇒ 唯一索引看不见它们是同一颗"
            );
        }
    }

    /// 大小写 + 首尾空白（最普通的一格，也是 Joplin 用 ASCII NOCASE 时唯一勉强做到的那格）。
    #[test]
    fn case_and_edges_fold() {
        assert_eq!(canonical_tag_name("TODO"), canonical_tag_name("todo"));
        assert_eq!(canonical_tag_name("  todo "), canonical_tag_name("TODO"));
    }

    /// 中间的空格**不**折：这是有意的，"紧 急"与"紧急"是两颗标签（改名与检索都按可见文字谈）。
    #[test]
    fn inner_spaces_are_not_stripped() {
        assert_ne!(canonical_tag_name("紧 急"), canonical_tag_name("紧急"));
    }

    /// 组合变号 vs 预组合。写转义而不是两个字面串 —— 源文件里这两串长得一样，
    /// 编辑器/字体随时会把分解形"顺手改成"预组合形，那条判据就空转了。
    #[test]
    fn composed_and_decomposed_are_one() {
        assert_eq!(
            canonical_tag_name("caf\u{00E9}"),
            canonical_tag_name("caf\u{0065}\u{0301}"),
            "同一颗标签以预组合或分解形进来必须算同一个值"
        );
    }

    /// 小写去归一化那一格：少了第二遍 NFKC，这两串就不相等。
    #[test]
    fn lowering_then_denormalizing_still_folds() {
        assert_eq!(
            canonical_tag_name("\u{0130}stanbul"),
            canonical_tag_name("i\u{0307}stanbul"),
            "İ 小写 = i + 结合点 ⇒ 与直接给带结合点的 i 必须相等"
        );
    }

    /// 全角/半角 + 连字 + 上标：这一组是**把 NFC 换成 NFKC 的全部理由**（NFC 下这三条全红）。
    #[test]
    fn compatibility_folding_is_why_not_nfc() {
        assert_eq!(
            canonical_tag_name("ＦＵＬＬ"),
            canonical_tag_name("FULL"),
            "全角折到半角"
        );
        assert_eq!(
            canonical_tag_name("\u{FB01}le"),
            canonical_tag_name("file"),
            "连字 ﬁ 折成 fi"
        );
        assert_eq!(
            canonical_tag_name("\u{00B2}"),
            canonical_tag_name("2"),
            "上标 ² 折成 2"
        );
    }

    /// 已知不折的那一格：**这不是 casefold**。哪天引了 casemap，这条要**反过来**改并同步 ADR-0022 D3。
    #[test]
    fn sharp_s_is_not_casefolded_recorded_debt() {
        assert_ne!(
            canonical_tag_name("Stra\u{00DF}e"),
            canonical_tag_name("STRASSE")
        );
    }

    #[test]
    fn empty_and_whitespace_fold_to_empty() {
        assert_eq!(canonical_tag_name("   "), "");
        assert_eq!(canonical_tag_name(""), "");
    }

    /// kind 词汇表：`Tag` 加进来之后四个都要能往返，陌生标记必须 `None`
    /// （这是 ADR-0022 那一族"静默降级"的入口 —— 落到任何一个已知 kind 都是写错表）。
    #[test]
    fn kind_tag_round_trips_and_rejects_unknown() {
        for k in EntityKind::ALL {
            let s = k.tag().to_string();
            assert_eq!(
                EntityKind::from_tag(&s),
                Some(k),
                "{k:?} 的标记 {s:?} 读不回来"
            );
        }
        assert_eq!(
            EntityKind::from_tag("g"),
            None,
            "陌生标记必须 None，不许落到任何一个已知 kind"
        );
        assert_eq!(EntityKind::from_tag(""), None);
        assert_eq!(EntityKind::Tag.dir(), "tag");
        assert_eq!(
            EntityKind::ALL.len(),
            4,
            "加第五种 kind 要一起改这份名单与所有穷尽匹配"
        );
    }
}
