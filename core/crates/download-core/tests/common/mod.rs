//! Minimal HTTP/1.1 test server (tokio TCP) that behaves like a static file server with
//! range support — enough surface to prove the engine's resume/integrity behavior.
//! Phase 6 adds fault-injection toggles: range-less servers, over-sending responses and
//! Content-Range lies, plus per-request observation for multi-connection assertions.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
pub struct ServerToggles {
    /// Ignore Range entirely and never advertise Accept-Ranges (200-only server).
    pub disable_ranges: bool,
    /// Honor the range START but stream through EOF, ignoring the requested end
    /// (the engine must cap writes at its window).
    pub over_send: bool,
    /// Report a Content-Range start shifted by +10 while sending honest bytes.
    pub lie_content_range: bool,
}

pub struct TestServer {
    pub base_url: String,
    etag: &'static str,
    body: Arc<Vec<u8>>,
    body_v2: Arc<Vec<u8>>,
    last_range: Arc<AtomicU64>,
    range_starts: Arc<StdMutex<Vec<u64>>>,
    if_range_values: Arc<StdMutex<Vec<String>>>,
    delay_per_chunk_ms: u64,
    chunk_size: usize,
    active_version: Arc<AtomicU64>,
    requests: Arc<AtomicU64>,
    toggles: ServerToggles,
    /// Runtime "source expired" toggle: when non-zero, every request answers with that
    /// HTTP status (Phase 7 fault injection). 0 = alive.
    failure_status: Arc<AtomicU64>,
}

impl TestServer {
    /// Simulate the source changing under our feet: fresh requests now return v2.
    pub fn rotate_to_v2(&self) {
        self.active_version.store(2, Ordering::SeqCst);
    }

    /// Phase 7: simulate the URL expiring/dying (404 for every request) and, later,
    /// the outage clearing (the same source serving again).
    #[allow(dead_code)] // used by the recover.rs test binary only
    pub fn set_dead(&self, dead: bool) {
        self.failure_status
            .store(if dead { 404 } else { 0 }, Ordering::SeqCst);
    }

    /// Serve a specific failure status for every request (e.g. 401/403/410).
    #[allow(dead_code)] // used by the recover.rs test binary only
    pub fn set_failure_status(&self, status: u16) {
        self.failure_status.store(status as u64, Ordering::SeqCst);
    }

    #[allow(dead_code)] // used by the recover.rs test binary only
    pub fn is_dead(&self) -> bool {
        self.failure_status.load(Ordering::SeqCst) != 0
    }

    #[allow(dead_code)] // used by the engine.rs test binary only
    pub fn etag_of_v1(&self) -> &'static str {
        self.etag
    }

    pub fn range_starts(&self) -> Vec<u64> {
        self.range_starts.lock().unwrap().clone()
    }

    #[allow(dead_code)] // used by the engine.rs test binary only
    pub fn request_count(&self) -> u64 {
        self.requests.load(Ordering::SeqCst)
    }
}

impl TestServer {
    /// Serve `body` (with If-Range semantics); when `rotate_version` is triggered, the server
    /// serves `body_v2` with a different etag — simulating a changed source.
    pub async fn start(body: Vec<u8>, body_v2: Vec<u8>, delay_per_chunk_ms: u64) -> Arc<Self> {
        Self::start_with(
            body,
            body_v2,
            delay_per_chunk_ms,
            1024,
            ServerToggles::default(),
        )
        .await
    }

    pub async fn start_with(
        body: Vec<u8>,
        body_v2: Vec<u8>,
        delay_per_chunk_ms: u64,
        chunk_size: usize,
        toggles: ServerToggles,
    ) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().unwrap().port();
        let etag = "\"test-etag-v1\"";
        let etag_v2 = "\"test-etag-v2\"";

        let state = Arc::new(Self {
            base_url: format!("http://127.0.0.1:{port}/file"),
            etag,
            body: Arc::new(body),
            body_v2: Arc::new(body_v2),
            last_range: Arc::new(AtomicU64::new(u64::MAX)),
            range_starts: Arc::new(StdMutex::new(Vec::new())),
            if_range_values: Arc::new(StdMutex::new(Vec::new())),
            delay_per_chunk_ms,
            chunk_size,
            active_version: Arc::new(AtomicU64::new(1)),
            requests: Arc::new(AtomicU64::new(0)),
            toggles,
            failure_status: Arc::new(AtomicU64::new(0)),
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

    #[allow(dead_code)] // used by the engine.rs test binary only
    pub fn last_range_start(&self) -> Option<u64> {
        let v = self.last_range.load(Ordering::SeqCst);
        if v == u64::MAX {
            None
        } else {
            Some(v)
        }
    }

    /// Every If-Range value seen by this server, in arrival order.
    pub fn if_range_seen(&self) -> Vec<String> {
        self.if_range_values.lock().unwrap().clone()
    }

    /// The most recent If-Range value, if any.
    #[allow(dead_code)]
    pub fn last_if_range(&self) -> Option<String> {
        self.if_range_seen().last().cloned()
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
    let mut range_end: Option<u64> = None;
    let mut if_range: Option<String> = None;
    for line in request.lines() {
        if let Some(v) = line.strip_prefix("range: bytes=") {
            let v = v.trim();
            let mut parts = v.split('-');
            range_start = parts.next().and_then(|s| s.parse().ok());
            range_end = parts.next().and_then(|s| s.parse().ok());
        }
        if let Some(v) = line.strip_prefix("if-range:") {
            if_range = Some(v.trim().to_string());
        }
    }
    if let Some(ir) = &if_range {
        server.if_range_values.lock().unwrap().push(ir.clone());
    }
    server
        .last_range
        .store(range_start.unwrap_or(u64::MAX), Ordering::SeqCst);
    if let Some(s) = range_start {
        server.range_starts.lock().unwrap().push(s);
    }
    server.requests.fetch_add(1, Ordering::SeqCst);

    // Phase 7 fault injection: an expired/dead URL. The error page is deliberately
    // text/html — the classic trap where a dead link serves a login page instead.
    let failure = server.failure_status.load(Ordering::SeqCst) as u16;
    if failure != 0 {
        let head = format!(
            "HTTP/1.1 {failure} Failure\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket.write_all(head.as_bytes()).await.ok();
        return;
    }

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

    // Toggled range-less behavior: a plain 200-only server.
    if server.toggles.disable_ranges {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nETag: {}\r\nConnection: close\r\n\r\n",
            body.len(),
            etag
        );
        socket.write_all(head.as_bytes()).await.ok();
        write_chunked(
            &mut socket,
            body,
            server.delay_per_chunk_ms,
            server.chunk_size,
        )
        .await;
        socket.flush().await.ok();
        return;
    }

    // RFC 7233: a Range request with If-Range that does NOT match the current representation
    // must be answered with the full 200 representation (never a 206 splice).
    let if_range_matches = match (&if_range, is_v2) {
        (Some(ir), false) => ir.eq_ignore_ascii_case(&etag),
        (Some(ir), true) => ir.eq_ignore_ascii_case(&etag),
        (None, _) => true,
    };

    let (start, end, status) = match range_start {
        Some(s) if s < body.len() as u64 && if_range_matches => {
            // `over_send` ignores the requested END and streams through EOF.
            let e = if server.toggles.over_send {
                body.len() - 1
            } else {
                range_end
                    .map(|e| (e as usize).min(body.len() - 1))
                    .unwrap_or(body.len() - 1)
            };
            (s as usize, e.max(s as usize), "206 Partial Content")
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
    let reported_start = if server.toggles.lie_content_range && status.starts_with("206") {
        start + 10
    } else {
        start
    };
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nConnection: close\r\n",
        slice.len(),
        etag
    );
    if status.starts_with("206") {
        response.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            reported_start,
            end,
            body.len()
        ));
    }
    response.push_str("\r\n");
    socket.write_all(response.as_bytes()).await.ok();

    write_chunked(
        &mut socket,
        slice,
        server.delay_per_chunk_ms,
        server.chunk_size,
    )
    .await;
    socket.flush().await.ok();
}

async fn write_chunked(
    socket: &mut TcpStream,
    slice: &[u8],
    delay_per_chunk_ms: u64,
    chunk_size: usize,
) {
    if delay_per_chunk_ms > 0 {
        for piece in slice.chunks(chunk_size) {
            socket.write_all(piece).await.ok();
            tokio::time::sleep(std::time::Duration::from_millis(delay_per_chunk_ms)).await;
        }
    } else {
        socket.write_all(slice).await.ok();
    }
}
