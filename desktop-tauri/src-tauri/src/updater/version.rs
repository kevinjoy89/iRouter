//! 版本号解析与比较 —— `desktop/updater/version.js` 的行为等价移植（设计 §2.1/§4）。
//!
//! **红线（设计 §4）**：不要用 `semver` crate 的 `Version::cmp` 替换。SemVer 规定
//! `0.3.2-beta.1 < 0.3.2`，而现实现认为二者**相等**（后缀整体丢弃）。换 semver = 行为变更。
//!
//! **红线 2**：Rust `regex` 的 `\d` 默认是 Unicode 数字，JS 的 `\d` 只匹配 ASCII。
//! 所以这里是手写 ASCII 数字扫描，不是正则。

use super::jscompat::{js_trim, strip_one_leading_v};

/// 版本三元组。对应 JS 的 `{ major, minor, patch }`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct VersionTriple {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

/// 取一段 ASCII 数字。返回 `(值, 剩余)`；一个数字都没有 → `None`。
///
/// 溢出处理：JS 走 `parseInt` → f64，超过 2^53 丢精度但**永不失败**；Rust `u64` 会溢出。
/// 这里饱和到 `u64::MAX`，保证"可解析"这一判定与 JS 一致。分歧只在 ≥20 位数字时可见
/// （`u64::MAX` vs f64 的近似值），GitHub tag 不可能出现 —— 登记为可接受偏差。
fn take_ascii_digits(s: &str) -> Option<(u64, &str)> {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let value = s[..i].parse::<u64>().unwrap_or(u64::MAX);
    Some((value, &s[i..]))
}

/// 等价于 JS `parseVersion`：`trim()` → 剥前导 `v`/`V` → `^([0-9]+)\.([0-9]+)\.([0-9]+)`。
///
/// 注意正则**没有 `$` 锚**：`.数字` 之后的一切（预发布、构建元数据、第四段）都被忽略。
/// `None` 与 `Some("")` 都返回 `None`（JS 里 `!versionStr` 覆盖空串）。
pub fn parse_version(input: Option<&str>) -> Option<VersionTriple> {
    let raw = input?;
    let clean = strip_one_leading_v(js_trim(raw));

    let (major, rest) = take_ascii_digits(clean)?;
    let rest = rest.strip_prefix('.')?;
    let (minor, rest) = take_ascii_digits(rest)?;
    let rest = rest.strip_prefix('.')?;
    let (patch, _) = take_ascii_digits(rest)?;

    Some(VersionTriple {
        major,
        minor,
        patch,
    })
}

/// 等价于 JS `compareVersions`：**任一侧不可解析也返回 0**（"不可解析 == 相等"）。
pub fn compare_versions(a: Option<&str>, b: Option<&str>) -> i8 {
    match (parse_version(a), parse_version(b)) {
        (Some(x), Some(y)) => match x.cmp(&y) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
        },
        _ => 0,
    }
}

/// 等价于 JS `hasNewVersion`。
///
/// `current` 为假值 / `"dev"` / `"local"` → **直接 false**（不看 `latest`）。
/// 早退分支只认**小写**字面量，大小写敏感（`"DEV"` 会继续走比较）。
pub fn has_new_version(current: Option<&str>, latest: Option<&str>) -> bool {
    match current {
        None => false,
        Some(c) if c.is_empty() => false, // JS `!current` 对空串为真
        Some("dev") | Some("local") => false,
        Some(c) => compare_versions(latest, Some(c)) > 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(major: u64, minor: u64, patch: u64) -> Option<VersionTriple> {
        Some(VersionTriple {
            major,
            minor,
            patch,
        })
    }

    // 用例逐条取自 tests/unit/updater-version.test.js:16-78 与设计 §4/§12.3。
    #[test]
    fn parses_standard_and_prefixed_versions() {
        assert_eq!(parse_version(Some("0.3.2")), t(0, 3, 2));
        assert_eq!(parse_version(Some("1.0.0")), t(1, 0, 0));
        assert_eq!(parse_version(Some("v0.3.2")), t(0, 3, 2));
        assert_eq!(parse_version(Some("V1.2.3")), t(1, 2, 3));
    }

    #[test]
    fn drops_prerelease_and_build_metadata() {
        assert_eq!(parse_version(Some("0.3.2-beta.1")), t(0, 3, 2));
        assert_eq!(parse_version(Some("v0.3.2+20260929")), t(0, 3, 2));
        assert_eq!(parse_version(Some("0.3.2.4")), t(0, 3, 2)); // 无 $ 锚，第四段忽略
    }

    #[test]
    fn trims_js_whitespace_including_bom() {
        assert_eq!(parse_version(Some(" 0.3.2 ")), t(0, 3, 2));
        assert_eq!(parse_version(Some("\u{feff}0.3.2")), t(0, 3, 2));
    }

    #[test]
    fn rejects_unparsable_versions() {
        assert_eq!(parse_version(Some("")), None);
        assert_eq!(parse_version(None), None);
        assert_eq!(parse_version(Some("invalid")), None);
        assert_eq!(parse_version(Some("dev")), None);
        assert_eq!(parse_version(Some("0.3")), None);
        assert_eq!(parse_version(Some("1.2.")), None);
        assert_eq!(parse_version(Some(" vv0.3.2")), None); // 只剥一个 v
        assert_eq!(parse_version(Some("   ")), None);
    }

    #[test]
    fn digits_are_ascii_only_like_js() {
        // JS 的 \d 不匹配全角/阿拉伯-印度数字；Rust regex 的 \d 会 —— 这就是不用正则的原因
        assert_eq!(parse_version(Some("０.３.２")), None);
        assert_eq!(parse_version(Some("\u{0660}.3.2")), None);
        assert_eq!(parse_version(Some("0.3.2\u{0660}")), t(0, 3, 2));
    }

    #[test]
    fn huge_components_saturate_and_the_divergence_boundary_is_2_pow_53() {
        // JS parseInt 走 f64：≥2^53 丢精度但**永不失败** → 必须也判为"可解析"（饱和，不回 None）。
        // 若这里改成 `None`，`compareVersions` 会返回 0，把"远端版本更高"误判成"相等"。
        assert_eq!(
            parse_version(Some("999999999999999999999999.0.0"))
                .unwrap()
                .major,
            u64::MAX
        );
        assert_eq!(
            parse_version(Some("18446744073709551616.0.0"))
                .unwrap()
                .major,
            u64::MAX
        );

        // ⚠️ **已登记偏差**（设计 §2.1；差分测试 5325 条断言里仅有的 9 条不一致全部在这一族）：
        //   JS  : parseVersion("18446744073709551615.0.0").major === 18446744073709552000（f64 近似）
        //   JS  : compareVersions("18446744073709551616.0.0", "999999999999999999999999.0.0") === 1
        //   Rust: 两个分量都饱和到 u64::MAX → parse 出来的数值不同、compare 判**相等**
        // 影响面：只有"两个分量都 ≥20 位"的巨大版本号之间的相对大小。GitHub tag（`v0.3.7`）
        // 不可达；设计明确接受这条偏差（并明令不要为此引入 f64 语义）。
        assert_eq!(
            compare_versions(
                Some("18446744073709551616.0.0"),
                Some("999999999999999999999999.0.0")
            ),
            0
        );

        // 边界另一侧（< 2^53）：与 JS 逐位一致，f64 也不丢精度
        assert_eq!(
            parse_version(Some("9007199254740991.0.0")).unwrap().major,
            9_007_199_254_740_991
        );
        assert_eq!(
            compare_versions(
                Some("9007199254740991.0.0"),
                Some("9007199254740990.0.0")
            ),
            1
        );
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert_eq!(compare_versions(Some("0.3.2"), Some("0.3.1")), 1);
        assert_eq!(compare_versions(Some("0.3.1"), Some("0.3.2")), -1);
        assert_eq!(compare_versions(Some("0.3.2"), Some("0.3.2")), 0);
        assert_eq!(compare_versions(Some("v0.3.2"), Some("0.3.2")), 0);
        assert_eq!(compare_versions(Some("0.3.10"), Some("0.3.9")), 1);
        assert_eq!(compare_versions(Some("1.0.0"), Some("0.9.9")), 1);
        assert_eq!(compare_versions(Some("0.4.0"), Some("0.3.9")), 1);
        assert_eq!(compare_versions(Some("0.3.0"), Some("0.3.1")), -1);
    }

    #[test]
    fn unparsable_side_compares_equal() {
        assert_eq!(compare_versions(Some("dev"), Some("0.3.2")), 0);
        assert_eq!(compare_versions(Some("0.3.2"), None), 0);
        assert_eq!(compare_versions(Some("0.3"), Some("0.3.0")), 0);
    }

    #[test]
    fn prerelease_users_never_get_the_release() {
        // 设计 §4 表格第 4 行：后缀整体丢弃 → 比较为 0
        assert_eq!(compare_versions(Some("0.3.2-beta.1"), Some("0.3.2")), 0);
        assert!(!has_new_version(Some("0.3.2-beta.1"), Some("0.3.2")));
        assert!(has_new_version(Some("0.3.1"), Some("0.3.3-beta")));
    }

    #[test]
    fn has_new_version_matches_js_truthiness() {
        assert!(has_new_version(Some("0.3.1"), Some("0.3.2")));
        assert!(has_new_version(Some("0.3.1"), Some("v0.3.2")));
        assert!(has_new_version(Some("0.3.1"), Some("1.0.0")));
        assert!(!has_new_version(Some("0.3.2"), Some("0.3.2")));
        assert!(!has_new_version(Some("0.3.2"), Some("0.3.1")));
        assert!(!has_new_version(Some("1.0.0"), Some("0.9.9")));
    }

    #[test]
    fn dev_and_local_short_circuit_before_looking_at_latest() {
        assert!(!has_new_version(Some("dev"), Some("0.3.2")));
        assert!(!has_new_version(Some("local"), Some("9.9.9")));
        assert!(!has_new_version(None, Some("9.9.9")));
        assert!(!has_new_version(Some(""), Some("9.9.9")));
        // 早退分支大小写敏感（只认小写 "dev"/"local"），但**结果不可观测**：
        // 走到 compare() 时 current 不可解析 → 0 → 同样是 false。
        // 大写形态的真实差别在 `parse_version`（"DEV" → None）。
        assert!(!has_new_version(Some("DEV"), Some("9.9.9")));
        assert_eq!(parse_version(Some("DEV")), None);
        // 反例：可解析的 current 不被早退影响
        assert!(has_new_version(Some("0.3.1"), Some("9.9.9")));
    }
}
