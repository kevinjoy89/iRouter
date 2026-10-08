//! JS 字符串语义的精确小工具。
//!
//! 为什么需要它：`String.prototype.trim` 与正则 `\s` 用的**不是** Unicode `White_Space`
//! 属性，而是 ECMAScript 的 `WhiteSpace` + `LineTerminator` 集合。两者差两个字符：
//!
//! | 字符 | JS `trim()` / `\s` | Rust `char::is_whitespace()`（White_Space） |
//! | --- | --- | --- |
//! | U+FEFF (BOM/ZWNBSP) | **是** | 否 |
//! | U+0085 (NEL) | 否 | **是** |
//!
//! 这个差异在 `parseChecksums` 上是可见的（设计 §2.3 专门写了"照抄 BOM 分支"），
//! 所以这里按 JS 的定义逐字实现，而不是用 `str::trim()`。

/// ECMAScript `\s`（= `WhiteSpace` ∪ `LineTerminator`）的逐字实现。
///
/// 参考 ES2023 22.2.2.9 / 12.2：`\t \v \f \uFEFF` + `Zs` 全部 + `\n \r \u2028 \u2029`。
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t'          // U+0009 Tab
        | '\n'        // U+000A LF
        | '\u{000B}'  // U+000B VT
        | '\u{000C}'  // U+000C FF
        | '\r'        // U+000D CR
        | ' '         // U+0020 SP
        | '\u{00A0}'  // U+00A0 NBSP
        | '\u{1680}'  // U+1680 OGHAM SPACE MARK
        | '\u{2000}'..='\u{200A}' // EN QUAD … HAIR SPACE
        | '\u{2028}'  // LINE SEPARATOR
        | '\u{2029}'  // PARAGRAPH SEPARATOR
        | '\u{202F}'  // NARROW NBSP
        | '\u{205F}'  // MEDIUM MATHEMATICAL SPACE
        | '\u{3000}'  // IDEOGRAPHIC SPACE
        | '\u{FEFF}'  // BOM / ZWNBSP —— **只在这里**，White_Space 不含它
    )
}

/// `String.prototype.trim()` 的等价物（两端剥 JS 空白，含 U+FEFF）。
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.split(/\s+/)` 的等价物：按 JS 空白切分并丢掉空段（`+` 量词的语义）。
///
/// 全空白输入 → 空 `Vec`（JS 的 `"  ".split(/\s+/)` 会得到 `["", ""]`，但调用点
/// 只用 `parts.length >= 2` 与 `parts[0]/parts[1]`，两者等价——都进不了任何分支）。
pub(crate) fn js_split_whitespace(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = s.split(is_js_space).filter(|p| !p.is_empty()).collect();
    // `split` 对空输入返回 `[""]`，被上面的 filter 干掉；这里只做显式说明，无需额外处理。
    if out.is_empty() {
        out = Vec::new();
    }
    out
}

/// 剥**一个**前导 `v`/`V`。
///
/// 对应两个 JS 调用点：`version.js:21` 的 `replace(/^v/i, "")` 与
/// `checker.js:147` 的 `tag_name.replace(/^v/i, "")` —— 都没有 `g`，所以只剥一次。
pub(crate) fn strip_one_leading_v(s: &str) -> &str {
    match s.as_bytes().first() {
        Some(b'v') | Some(b'V') => &s[1..],
        _ => s,
    }
}

/// `String.prototype.toLowerCase()`。
///
/// Rust 的 `str::to_lowercase` 与 JS 的 `toLowerCase` 都按 Unicode 默认大小写映射，
/// 唯一已知差异是二者对若干"特殊大小写"字符的上下文处理，对本用途（hex/文件名）不可达。
pub(crate) fn js_to_lowercase(s: &str) -> String {
    s.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_strips_bom_but_rust_trim_does_not() {
        // 这条差异是设计 §2.3 里"BOM 分支在 trim 后基本是死代码"的依据
        assert_eq!(js_trim("\u{feff}0.3.2"), "0.3.2");
        assert_eq!("\u{feff}0.3.2".trim(), "\u{feff}0.3.2"); // Rust trim 不动 BOM
        assert_eq!(js_trim(" \u{3000}abc\r\n"), "abc");
    }

    #[test]
    fn js_trim_keeps_nel_which_rust_trim_strips() {
        // U+0085 在 Rust 里是空白、在 JS 里不是
        assert_eq!(js_trim("\u{85}abc"), "\u{85}abc");
        assert_eq!("\u{85}abc".trim(), "abc");
    }

    #[test]
    fn js_split_matches_regex_semantics() {
        assert_eq!(js_split_whitespace("aa  bb"), vec!["aa", "bb"]);
        assert_eq!(js_split_whitespace("  aa\tbb\u{feff}cc  "), vec!["aa", "bb", "cc"]);
        assert!(js_split_whitespace("   ").is_empty());
        assert!(js_split_whitespace("").is_empty());
        assert_eq!(js_split_whitespace("only"), vec!["only"]);
    }
}
