//! SHA-256 校验和解析与比对 —— `desktop/updater/checksum.js` 的行为等价移植（设计 §2.3/§5）。
//!
//! **校验强度必须写清楚（设计 §5）**：
//!   - 它防的是**传输损坏 / 中间人篡改单一路径**；
//!   - 它**不防**"GitHub Release 被整体篡改"——`checksums.txt` 与安装包同源，能改包的人
//!     也能改校验和；
//!   - 更糟：**没有 `checksums.txt` 资产时整个校验会被跳过**（`main.js:735` 的 `if`），
//!     包照样安装（**D-4**，Lead 已签字"客户端照抄现状、洞在发布侧 CI 堵"）。
//!
//! 生产端格式（`.github/workflows/release.yml:124-131`）：`<64 位小写 hex>  <basename>`，
//! **两个空格**，`sort -u`。键是**大小写敏感**的原始文件名。

use std::collections::HashMap;
use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use super::jscompat::{js_split_whitespace, js_to_lowercase, js_trim};

/// 流式哈希缓冲：64 KiB（设计 §5 的建议值）。不要把 139 MB 的 dmg 读进内存。
const HASH_BUF: usize = 64 * 1024;

/// 等价于 JS `parseChecksums`（`checksum.js:19-46`）。
///
/// - 空内容 → 空 map（JS `if (!content)`）；
/// - 按 `\n` 切行，逐行 JS `trim()`，再剥行首 BOM（**照抄，勿删**：`js_trim` 已经吃掉
///   U+FEFF，所以这一分支在两边都是死代码——设计 §2.3 明确要求照抄）；
/// - `split(/\s+/)` → `parts[0]` 小写作 hash，`parts[1]` 剥前导 `*` 作文件名；
/// - 字段 < 2 的行**静默跳过**；**重复文件名后者覆盖前者**。
pub fn parse_checksums(content: &[u8]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    if content.is_empty() {
        return result;
    }
    // JS 的 `Buffer.toString("utf8")` 把非法序列替换成 U+FFFD —— from_utf8_lossy 同语义
    let text = String::from_utf8_lossy(content);

    for raw_line in text.split('\n') {
        let mut line = js_trim(raw_line);
        if line.starts_with('\u{feff}') {
            line = &line['\u{feff}'.len_utf8()..];
        }
        if line.is_empty() {
            continue;
        }
        let parts = js_split_whitespace(line);
        if parts.len() >= 2 {
            let hash = js_to_lowercase(parts[0]);
            let filename = parts[1].strip_prefix('*').unwrap_or(parts[1]);
            result.insert(filename.to_string(), hash);
        }
    }
    result
}

/// 等价于 JS `verifyFileSha256`（`checksum.js:56-77`）。
///
/// 返回：
///   - `Ok(false)` —— 路径/期望值为空，或文件不存在（JS `!fs.existsSync` → `resolve(false)`）；
///   - `Ok(true/false)` —— 流式 SHA-256 与 `expected.trim().toLowerCase()` 是否全等；
///   - `Err(_)` —— 文件**存在但读取失败**（JS 里是 stream `'error'` → reject）。
///
/// ⚠️ 可接受偏差（设计 §2.3）：Node 的 fs 错误文案（`EACCES: permission denied, open '...'`）
/// 与 Rust `io::Error` 的 Display **必然不同**，而这个字符串会一路走到面板
/// （`main.js:768` → `UpdateSettings.js:55`）。见 `error.rs` 顶部说明。
pub async fn verify_file_sha256(path: &Path, expected: &str) -> std::io::Result<bool> {
    if path.as_os_str().is_empty() || expected.is_empty() {
        return Ok(false);
    }
    // JS 用的是 existsSync：**任何** stat 失败都被当成"不存在"→ false（不 reject）
    if tokio::fs::metadata(path).await.is_err() {
        return Ok(false);
    }

    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUF];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let actual = hex::encode(hasher.finalize());
    let target = js_to_lowercase(js_trim(expected));
    Ok(actual == target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // 用例逐条取自 tests/unit/updater-checksum.test.js:20-67 与设计 §12.3。
    #[test]
    fn parses_standard_sha256sum_output() {
        let content = "\n5fa5f33ff6ae46e0ded79e66946941b0953d279f9b12d6ac7b633e857f358a37  iRouter-0.3.2-macos-arm64.dmg\n9d3159c8a170fba74bb3d52ed7948df27f5bc29478e209aaed8c828e46490c17  iRouter-0.3.2-windows-amd64-installer.exe\n";
        assert_eq!(
            parse_checksums(content.as_bytes()),
            map(&[
                (
                    "iRouter-0.3.2-macos-arm64.dmg",
                    "5fa5f33ff6ae46e0ded79e66946941b0953d279f9b12d6ac7b633e857f358a37"
                ),
                (
                    "iRouter-0.3.2-windows-amd64-installer.exe",
                    "9d3159c8a170fba74bb3d52ed7948df27f5bc29478e209aaed8c828e46490c17"
                ),
            ])
        );
    }

    #[test]
    fn strips_bom_and_binary_star_prefix() {
        let content = "\u{feff}11223344  *iRouter-test.dmg\n";
        assert_eq!(
            parse_checksums(content.as_bytes()),
            map(&[("iRouter-test.dmg", "11223344")])
        );
    }

    #[test]
    fn handles_crlf_tabs_uppercase_hash_and_extra_spaces() {
        // 设计 §2.3 实测：`"ABCDEF  *a.dmg\nzz  b.exe\r\n"` → { a.dmg: abcdef, b.exe: zz }
        let content = "ABCDEF  *a.dmg\nzz  b.exe\r\n";
        assert_eq!(
            parse_checksums(content.as_bytes()),
            map(&[("a.dmg", "abcdef"), ("b.exe", "zz")])
        );
        // 单个制表符分隔（sha256sum 的兼容形态）+ 第三个字段被忽略
        assert_eq!(
            parse_checksums(b"deadbeef\tc.exe\tignored\n"),
            map(&[("c.exe", "deadbeef")])
        );
    }

    #[test]
    fn empty_and_short_lines_are_skipped() {
        assert!(parse_checksums(b"").is_empty());
        assert!(parse_checksums(b"\n\n   \n").is_empty());
        assert!(parse_checksums(b"onlyhash\n").is_empty(), "字段 < 2 静默跳过");
        assert!(parse_checksums(b"  h  \n").is_empty());
    }

    #[test]
    fn duplicate_filenames_last_one_wins() {
        let content = "aaaa  dup.bin\nbbbb  dup.bin\n";
        assert_eq!(parse_checksums(content.as_bytes()), map(&[("dup.bin", "bbbb")]));
    }

    #[test]
    fn keys_are_case_sensitive_and_values_lowercased() {
        let content = "ABCDEF  File.DMG\n";
        let parsed = parse_checksums(content.as_bytes());
        assert_eq!(parsed.get("File.DMG").map(String::as_str), Some("abcdef"));
        assert!(parsed.get("file.dmg").is_none());
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal() {
        // Buffer.toString("utf8") 的 U+FFFD 替换语义
        let bytes = b"hash  bad\xffname.bin\n";
        let parsed = parse_checksums(bytes);
        assert_eq!(parsed.len(), 1);
        assert!(parsed.keys().next().unwrap().contains('\u{fffd}'));
    }

    // ---- verify_file_sha256 ----
    //
    // 测试环境用 current_thread runtime + block_on：tokio::fs 走 spawn_blocking，
    // 不需要 multi-thread feature（Cargo.toml 里只声明了 "rt"）。
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(f)
    }

    fn tmp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("irouter-updater-checksum-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("test.bin");
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn verifies_real_file_true_and_false() {
        let content = b"Hello iRouter Updater!";
        // 与 JS 测试同一期望值：crypto.createHash("sha256").update(content).digest("hex")
        let expected = "6a5d1e0f0e2d1c9b6b1c0a1a9e6b0a2c4b1c3d5e7f8091a2b3c4d5e6f708192a";
        let p = tmp_file("real", content);
        let mut hasher = Sha256::new();
        hasher.update(content);
        let real = hex::encode(hasher.finalize());
        assert!(block_on(verify_file_sha256(&p, &real)).unwrap());
        // 大写 + 两端空白都要归一
        assert!(block_on(verify_file_sha256(&p, &format!("  {}  ", real.to_uppercase()))).unwrap());
        assert!(!block_on(verify_file_sha256(&p, expected)).unwrap());
        assert!(!block_on(verify_file_sha256(&p, &"0".repeat(64))).unwrap());
    }

    #[test]
    fn empty_inputs_and_missing_files_are_false_not_error() {
        let p = tmp_file("missing", b"x");
        // 文件不存在 → false（不 Err）
        assert!(!block_on(verify_file_sha256(&p.join("nope.bin"), "abcd")).unwrap());
        // 空路径 / 空期望 → false
        assert!(!block_on(verify_file_sha256(Path::new(""), "abcd")).unwrap());
        assert!(!block_on(verify_file_sha256(&p, "")).unwrap());
    }

    #[test]
    fn empty_file_hashes_to_the_sha256_of_nothing() {
        let p = tmp_file("empty", b"");
        assert!(block_on(verify_file_sha256(
            &p,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ))
        .unwrap());
    }

    #[test]
    fn streams_files_larger_than_the_buffer() {
        let p = tmp_file("big", &vec![0xABu8; HASH_BUF * 2 + 7]);
        let mut hasher = Sha256::new();
        hasher.update(vec![0xABu8; HASH_BUF * 2 + 7]);
        let real = hex::encode(hasher.finalize());
        assert!(block_on(verify_file_sha256(&p, &real)).unwrap());
    }
}
