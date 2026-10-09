//! 测试用极简 HTTP 夹具（**只在 `cfg(test)` 下编译**）。
//!
//! 为什么需要它：设计 §12.3 要求 `http.rs`/`download.rs` 的行为（重定向、非 200、
//! 无 `content-length` 时用 `sizeHint`、取消删 `.part`）进 `cargo test`。这些路径
//! 只有对着**真实 socket** 跑才可信——mock 掉 reqwest 就等于没测。
//!
//! 实现刻意只有 std：`TcpListener` + 一个线程，串行处理连接。测试各自随机端口，
//! 互不干扰；线程随进程结束回收。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

/// 夹具的回应方式。
pub enum Reply {
    /// 常规响应：状态码 + 额外头 + 完整 body（自动补 `Content-Length`）。
    Raw {
        status: u16,
        extra_headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// 分片慢发：用于测进度回调与"取消下载"（headers 先发，body 逐片发）。
    Drip {
        status: u16,
        extra_headers: Vec<(String, String)>,
        chunks: Vec<Vec<u8>>,
        delay: Duration,
    },
    /// 不回任何东西（测超时）。
    Hang,
}

impl Reply {
    pub fn text(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Reply::Raw {
            status,
            extra_headers: Vec::new(),
            body: body.into(),
        }
    }

    pub fn json(status: u16, body: &str) -> Self {
        Reply::Raw {
            status,
            extra_headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn redirect(location: &str) -> Self {
        Reply::Raw {
            status: 302,
            extra_headers: vec![("Location".into(), location.to_string())],
            body: Vec::new(),
        }
    }

    /// 不带 `Content-Length` 的 200（HTTP/1.0 语义：连接关闭即 body 结束）。
    pub fn no_content_length(body: impl Into<Vec<u8>>) -> Self {
        Reply::Raw {
            status: 200,
            extra_headers: vec![("__no_content_length__".into(), "1".into())],
            body: body.into(),
        }
    }

    pub fn drip(chunks: Vec<Vec<u8>>, delay: Duration) -> Self {
        Reply::Drip {
            status: 200,
            extra_headers: Vec::new(),
            chunks,
            delay,
        }
    }

    pub fn hang() -> Self {
        Reply::Hang
    }
}

/// 起一个夹具服务器，返回端口。`handler` 收到 `(path, 原始请求头文本)`。
pub fn spawn<F>(handler: F) -> u16
where
    F: Fn(&str, &str) -> Reply + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let port = listener.local_addr().expect("addr").port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = handle(&mut stream, &handler);
        }
    });
    port
}

fn handle<F>(stream: &mut TcpStream, handler: &F) -> std::io::Result<()>
where
    F: Fn(&str, &str) -> Reply,
{
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut raw = request_line.clone();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        raw.push_str(&line);
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();

    match handler(&path, &raw) {
        Reply::Hang => {
            thread::sleep(Duration::from_secs(5));
            Ok(())
        }
        Reply::Raw {
            status,
            extra_headers,
            body,
        } => {
            let no_len = extra_headers
                .iter()
                .any(|(k, _)| k == "__no_content_length__");
            let mut head = format!("HTTP/1.1 {} {}\r\n", status, reason(status));
            head.push_str("Connection: close\r\n");
            for (k, v) in &extra_headers {
                if k == "__no_content_length__" {
                    continue;
                }
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            if !no_len {
                head.push_str(&format!("Content-Length: {}\r\n", body.len()));
            }
            head.push_str("\r\n");
            stream.write_all(head.as_bytes())?;
            stream.write_all(&body)?;
            stream.flush()
        }
        Reply::Drip {
            status,
            extra_headers,
            chunks,
            delay,
        } => {
            let total: usize = chunks.iter().map(Vec::len).sum();
            let mut head = format!("HTTP/1.1 {} {}\r\n", status, reason(status));
            head.push_str("Connection: close\r\n");
            for (k, v) in &extra_headers {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str(&format!("Content-Length: {total}\r\n\r\n"));
            stream.write_all(head.as_bytes())?;
            stream.flush()?;
            for chunk in chunks {
                stream.write_all(&chunk)?;
                stream.flush()?;
                thread::sleep(delay);
            }
            Ok(())
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    }
}
