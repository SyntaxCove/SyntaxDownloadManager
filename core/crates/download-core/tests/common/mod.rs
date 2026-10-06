//! Minimal HTTP/1.1 test server (tokio TCP) that behaves like a static file server with
//! range support — enough surface to prove the engine's resume/integrity behavior.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct TestServer {
    pub base_url: String,
    etag: &'static str,
    body: Arc<Vec<u8>>,
    body_v2: Arc<Vec<u8>>,
    last_range: Arc<AtomicU64>,
    last_if_range: Arc<StdMutex<Option<String>>>,
    delay_per_chunk_ms: u64,
    active_version: Arc<AtomicU64>,
}

impl TestServer {
    /// Simulate the source changing under our feet: fresh requests now return v2.
    pub fn rotate_to_v2(&self) {
        self.active_version.store(2, Ordering::SeqCst);
    }

    pub fn etag_of_v1(&self) -> &'static str {
        self.etag
    }
}

impl TestServer {
    /// Serve `body` (with If-Range semantics); when `rotate_version` is triggered, the server
    /// serves `body_v2` with a different etag — simulating a changed source.
    pub async fn start(body: Vec<u8>, body_v2: Vec<u8>, delay_per_chunk_ms: u64) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().unwrap().port();
        let etag = "\"test-etag-v1\"";
        let etag_v2 = "\"test-etag-v2\"";

        let state = Arc::new(Self {
            base_url: format!("http://127.0.0.1:{port}/file"),
            etag: etag,
            body: Arc::new(body),
            body_v2: Arc::new(body_v2),
            last_range: Arc::new(AtomicU64::new(u64::MAX)),
            last_if_range: Arc::new(StdMutex::new(None)),
            delay_per_chunk_ms,
            active_version: Arc::new(AtomicU64::new(1)),
        });
        let etag_v2 = etag_v2.to_string();
        let server_state = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let st = server_state.clone();
                let ev2 = etag_v2.clone();
                tokio::spawn(async move {
                    handle(st, socket, ev2).await;
                });
            }
        });
        state
    }
    pub fn last_range_start(&self) -> Option<u64> {
        let v = self.last_range.load(Ordering::SeqCst);
        if v == u64::MAX {
            None
        } else {
            Some(v)
        }
    }

    pub fn last_if_range(&self) -> Option<String> {
        self.last_if_range.lock().unwrap().clone()
    }
}

async fn handle(server: Arc<TestServer>, mut socket: TcpStream, etag_v2: String) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    // read until end of headers
    loop {
        let n = socket.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buf).to_lowercase();
    let mut range_start: Option<u64> = None;
    let mut if_range: Option<String> = None;
    for line in request.lines() {
        if let Some(v) = line.strip_prefix("range: bytes=") {
            let v = v.trim();
            range_start = v.split('-').next().and_then(|s| s.parse().ok());
        }
        if let Some(v) = line.strip_prefix("if-range:") {
            if_range = Some(v.trim().to_string());
        }
    }
    if let Some(ir) = &if_range {
        *server.last_if_range.lock().unwrap() = Some(ir.clone());
    }
    server
        .last_range
        .store(range_start.unwrap_or(u64::MAX), Ordering::SeqCst);

    // Active-version model: fresh requests always return the *current* source version.
    // If-Range lets the engine prove which version its part came from; a mismatch is the
    // server answering 200 (full new content) — exactly the real-world corruption guard.
    let version = server.active_version.load(Ordering::SeqCst);
    let is_v2 = version == 2;
    let body = if is_v2 { &server.body_v2 } else { &server.body };
    let etag = if is_v2 {
        etag_v2.clone()
    } else {
        server.etag.to_string()
    };

    // RFC 7233: a Range request with If-Range that does NOT match the current representation
    // must be answered with the full 200 representation (never a 206 splice).
    let if_range_matches = match (&if_range, is_v2) {
        (Some(ir), false) => ir.eq_ignore_ascii_case(&etag),
        (Some(ir), true) => ir.eq_ignore_ascii_case(&etag),
        (None, _) => true,
    };
    let (start, end, status) = match range_start {
        Some(s) if s < body.len() as u64 && if_range_matches => {
            (s as usize, body.len() - 1, "206 Partial Content")
        }
        Some(_) if !if_range_matches => (0usize, body.len() - 1, "200 OK"),
        Some(_) => {
            // range beyond content
            let head = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\n\r\n";
            socket.write_all(head.as_bytes()).await.ok();
            return;
        }
        None => (0usize, body.len() - 1, "200 OK"),
    };

    let slice = &body[start..=end];
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nConnection: close\r\n",
        slice.len(),
        etag
    );
    if status.starts_with("206") {
        response.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            start,
            end,
            body.len()
        ));
    }
    response.push_str("\r\n");
    socket.write_all(response.as_bytes()).await.ok();

    if server.delay_per_chunk_ms > 0 {
        for piece in slice.chunks(1024) {
            socket.write_all(piece).await.ok();
            tokio::time::sleep(std::time::Duration::from_millis(server.delay_per_chunk_ms)).await;
        }
    } else {
        socket.write_all(slice).await.ok();
    }
    socket.flush().await.ok();
}

pub fn http_map(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
    if pairs.is_empty() {
        None
    } else {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }
}
