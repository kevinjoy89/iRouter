//! 时间：ISO-8601（UTC）生成与解析，**不引入日期库**。
//!
//! 需要它是因为 `shell-settings.json` 的 `lastCheckAt` 是
//! `new Date().toISOString()`（`main.js:827`），而 4h 缓存判断要把它读回来
//! （`checker.js:123-124`）。两个方向都必须在 Rust 侧精确复刻：
//!   - 生成：`YYYY-MM-DDTHH:mm:ss.sssZ`（毫秒固定 3 位）；
//!   - 解析：`Date.parse` 对**非法输入返回 NaN** → 缓存判断为 false → 继续联网。
//!     我们只认 ISO 8601（写入端就是它）；认不出来一律 `None`，与 NaN 同效。
//!
//! 民用日期 ↔ Unix 天数用 Howard Hinnant 的 `days_from_civil` / `civil_from_days`，
//! 对公历全区间成立、无闰年特判。

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i64 = 86_400_000;

/// 当前 Unix 毫秒（等价 `Date.now()`）。
pub fn now_unix_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // 系统时钟早于 1970 —— 取负值而不是 panic
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// 当前 UTC 时间，格式与 `new Date().toISOString()` 逐字一致。
pub fn now_iso8601() -> String {
    iso8601_from_unix_ms(now_unix_ms())
}

/// Unix 毫秒 → `YYYY-MM-DDTHH:mm:ss.sssZ`。
pub fn iso8601_from_unix_ms(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let rem = ms.rem_euclid(MS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let hours = rem / 3_600_000;
    let minutes = (rem % 3_600_000) / 60_000;
    let seconds = (rem % 60_000) / 1000;
    let millis = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// ISO-8601 → Unix 毫秒；认不出来返回 `None`（= JS `NaN`）。
///
/// 接受：`YYYY-MM-DD`、`YYYY-MM-DDTHH:mm[:ss[.sss]]`，结尾 `Z` 或 `±HH:MM`/`±HHmm`。
/// 不接受：`Date.parse` 那些"人类可读"格式（`"Oct 8 2026"`）——写入端不会产生它们，
/// 认不出来时退回"联网检查"，与 NaN 的后果一致。
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if bytes[7] != b'-' {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut rest = &s[10..];
    let mut time_ms: i64 = 0;
    if let Some(after_t) = rest.strip_prefix(['T', 't', ' ']) {
        let (hms, tail) = split_time(after_t)?;
        time_ms = hms;
        rest = tail;
    } else if !rest.is_empty() {
        return None;
    }

    let offset_minutes = match rest {
        "" | "Z" | "z" => 0,
        other => parse_offset(other)?,
    };

    let days = days_from_civil(year, month, day);
    Some(days * MS_PER_DAY + time_ms - offset_minutes * 60_000)
}

/// 拆 `HH:mm[:ss[.fff]]`，返回 `(当日毫秒, 尾巴)`。
fn split_time(s: &str) -> Option<(i64, &str)> {
    let bytes = s.as_bytes();
    if bytes.len() < 5 {
        return None;
    }
    let hour: i64 = s.get(0..2)?.parse().ok()?;
    if bytes[2] != b':' {
        return None;
    }
    let minute: i64 = s.get(3..5)?.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    let mut ms = (hour * 3600 + minute * 60) * 1000;
    let mut rest = &s[5..];

    if let Some(after_colon) = rest.strip_prefix(':') {
        let sec_part: String = after_colon
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let (sec_str, frac) = match sec_part.split_once('.') {
            Some((a, b)) => (a.to_string(), Some(b.to_string())),
            None => (sec_part.clone(), None),
        };
        if sec_str.len() != 2 {
            return None;
        }
        let second: i64 = sec_str.parse().ok()?;
        if second > 60 {
            return None;
        }
        ms += second * 1000;
        if let Some(frac) = frac {
            // `Date.parse` 对 `.1234` 也是毫秒精度截断
            let mut digits = frac;
            digits.truncate(3);
            while digits.len() < 3 {
                digits.push('0');
            }
            ms += digits.parse::<i64>().ok()?;
        }
        rest = &after_colon[sec_part.len()..];
    }
    Some((ms, rest))
}

/// 拆 `±HH:MM` / `±HHmm` / `±HH`。
fn parse_offset(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1i64,
        b'-' => -1i64,
        _ => return None,
    };
    let digits: String = s[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    let (hours, minutes) = match digits.len() {
        2 => (digits.parse::<i64>().ok()?, 0),
        4 => (
            digits[0..2].parse::<i64>().ok()?,
            digits[2..4].parse::<i64>().ok()?,
        ),
        _ => return None,
    };
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 60 + minutes))
}

/// 民用日期 → 距 1970-01-01 的天数（Hinnant 算法）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // Mar = 0
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 距 1970-01-01 的天数 → 民用日期（Hinnant 算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_format_matches_js_toisostring() {
        // new Date(0).toISOString()
        assert_eq!(iso8601_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
        // 2026-10-08T02:14:24.123Z（= 本设计成文时的时间戳）
        assert_eq!(
            iso8601_from_unix_ms(1_791_425_664_123),
            "2026-10-08T02:14:24.123Z"
        );
        // 闰日：2024-02-29T00:00:00Z
        assert_eq!(
            iso8601_from_unix_ms(1_709_164_800_000),
            "2024-02-29T00:00:00.000Z"
        );
        // 2038 之后（i64 毫秒，不是 32 位秒）
        assert_eq!(
            iso8601_from_unix_ms(2_208_988_800_000),
            "2040-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn roundtrip_now() {
        let ms = now_unix_ms();
        let iso = now_iso8601();
        let back = parse_iso8601_ms(&iso).expect("must parse our own output");
        assert!((back - ms).abs() < 1000, "roundtrip drift too large");
    }

    #[test]
    fn parses_the_shapes_we_and_electron_write() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso8601_ms("2026-10-08T02:14:24.123Z"),
            Some(1_791_425_664_123)
        );
        assert_eq!(
            parse_iso8601_ms("2026-10-08T02:14:24Z"),
            Some(1_791_425_664_000)
        );
        assert_eq!(
            parse_iso8601_ms("2026-10-08T10:14:24+08:00"),
            Some(1_791_425_664_000)
        );
        assert_eq!(parse_iso8601_ms("2026-10-08"), Some(1_791_417_600_000));
    }

    #[test]
    fn unparsable_is_none_like_js_nan() {
        // JS: Date.parse("garbage") → NaN → 比较为 false → 继续联网
        assert_eq!(parse_iso8601_ms("garbage"), None);
        assert_eq!(parse_iso8601_ms(""), None);
        assert_eq!(parse_iso8601_ms("Oct 8 2026"), None);
        assert_eq!(parse_iso8601_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("2026-10-08T25:00:00Z"), None);
    }

    #[test]
    fn four_hour_window_arithmetic() {
        // 缓存比较用的就是这两个函数（checker.rs）
        let now = 1_791_425_664_000i64;
        let thirty_min_ago = now - 30 * 60 * 1000;
        let five_hours_ago = now - 5 * 60 * 60 * 1000;
        let iso30 = iso8601_from_unix_ms(thirty_min_ago);
        let iso5h = iso8601_from_unix_ms(five_hours_ago);
        let d30 = now - parse_iso8601_ms(&iso30).unwrap();
        let d5h = now - parse_iso8601_ms(&iso5h).unwrap();
        assert!(d30 < 4 * 60 * 60 * 1000);
        assert!(d5h >= 4 * 60 * 60 * 1000);
    }
}
