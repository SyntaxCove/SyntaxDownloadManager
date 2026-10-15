//! JSONL RPC protocol tests: drive `serve()` over an in-memory duplex pair and over the real
//! spawned binary (via CARGO_BIN_EXE_download-core) to prove the whole stdio surface.

use std::sync::Arc;

use dc_storage::JobStore;
use download_core::server::serve;
use download_core::JobManager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

fn make_manager() -> Arc<JobManager> {
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    JobManager::new(store, tokio::sync::mpsc::unbounded_channel().0)
}

/// Wire: client → serve() reads from `from_client`; responses written to `to_client`.
async fn spawn_serve() -> (DuplexStream, BufReader<DuplexStream>) {
    let (from_client, client_write) = tokio::io::duplex(64 * 1024);
    let (core_write, client_read) = tokio::io::duplex(64 * 1024);
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut sink = core_write;
        while let Some(line) = outbound_rx.recv().await {
            let _ = sink.write_all(line.as_bytes()).await;
        }
    });
    let manager = make_manager();
    tokio::spawn(serve(from_client, manager, outbound_tx));
    (client_write, BufReader::new(client_read))
}

async fn request(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    json: &str,
) -> serde_json::Value {
    writer.write_all(json.as_bytes()).await.unwrap();
    writer.write_all(b"\n").await.unwrap();
    writer.flush().await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reader.read_line(&mut line),
    )
    .await
    .expect("response within 5s")
    .expect("connection alive");
    serde_json::from_str(&line).expect("valid JSON response")
}

#[tokio::test]
async fn ping_returns_versions() {
    let (mut w, mut r) = spawn_serve().await;
    let response = request(&mut w, &mut r, r#"{"v":1,"id":"p1","method":"core.ping"}"#).await;
    assert_eq!(response["id"], "p1");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["pong"], true);
    assert_eq!(
        response["result"]["contractVersion"],
        dc_protocol::CONTRACT_VERSION
    );
}

#[tokio::test]
async fn parse_error_and_unknown_method() {
    let (mut w, mut r) = spawn_serve().await;
    let response = request(&mut w, &mut r, "this is not json").await;
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "parse_error");

    let response = request(&mut w, &mut r, r#"{"v":1,"id":"u1","method":"nope"}"#).await;
    assert_eq!(response["error"]["code"], "method_not_found");

    let response = request(&mut w, &mut r, r#"{"v":7,"id":"u2","method":"core.ping"}"#).await;
    assert_eq!(response["error"]["code"], "unsupported_version");
    assert_eq!(response["id"], "u2");
}

#[tokio::test]
async fn invalid_params_is_rejected() {
    let (mut w, mut r) = spawn_serve().await;
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"i1","method":"download.create","params":{"url":"not-a-url"}}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_params");
}

#[tokio::test]
async fn create_and_fail_against_dead_url_is_observable() {
    let (mut w, mut r) = spawn_serve().await;
    let create = serde_json::json!({
        "v": 1, "id": "c1", "method": "download.create",
        "params": {
            "url": "http://127.0.0.1:9/no-file.zip",
            "destinationDir": std::env::temp_dir().join("dc-server-test").display().to_string()
        }
    });
    let response = request(&mut w, &mut r, &create.to_string()).await;
    assert_eq!(response["ok"], true, "create must succeed: {response}");
    let job_id = response["result"]["job"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let list = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"l1","method":"download.list"}"#,
    )
    .await;
    assert_eq!(list["result"]["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(list["result"]["jobs"][0]["id"], job_id.as_str());

    let mut failed = false;
    for _ in 0..100 {
        let get = request(
            &mut w,
            &mut r,
            &serde_json::json!({"v":1,"id":"g","method":"download.get","params":{"id":job_id}})
                .to_string(),
        )
        .await;
        if get["result"]["job"]["status"] == "failed" {
            assert_eq!(get["result"]["job"]["errorCode"], "network_error");
            failed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(failed, "job against a dead URL must surface network_error");
}

/// Phase 7: the recovery methods over the JSONL surface — a failed job (dead URL) can be
/// probed via `download.recover` (staying failed with the classified code), rebound to a
/// live mirror via `download.replaceUrl` (completing with recoveryCount stamped), while
/// `download.retry`/`download.recover` reject jobs in non-eligible states.
#[tokio::test]
async fn recovery_methods_over_rpc() {
    // 64 KiB body → single window; fast local server for the mirror leg.
    let body: Vec<u8> = (0..64_000u32).map(|i| (i % 253) as u8).collect();
    let mirror = common_test_server::ShaServer::start(body.clone()).await;

    let (mut w, mut r) = spawn_serve().await;
    let create = serde_json::json!({
        "v": 1, "id": "c1", "method": "download.create",
        "params": {
            "url": "http://127.0.0.1:9/expired.zip",
            "destinationDir": std::env::temp_dir().join("dc-server-test").display().to_string()
        }
    });
    let response = request(&mut w, &mut r, &create.to_string()).await;
    assert_eq!(response["ok"], true, "create must succeed: {response}");
    let job_id = response["result"]["job"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Wait for the dead-URL failure (network_error — connect refused, not 404).
    let mut failed = false;
    for _ in 0..100 {
        let get = request(&mut w, &mut r, &get_req("g1", &job_id)).await;
        if get["result"]["job"]["status"] == "failed" {
            failed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(failed, "job against a dead URL must fail first");

    // recover() probes the still-dead URL: the call succeeds, the job stays failed.
    let response = request(
        &mut w,
        &mut r,
        &serde_json::json!({"v":1,"id":"rec1","method":"download.recover","params":{"id":job_id}})
            .to_string(),
    )
    .await;
    assert_eq!(
        response["ok"], true,
        "recover is a query over the world: {response}"
    );
    assert_eq!(response["result"]["job"]["status"], "failed");
    assert_eq!(
        response["result"]["job"]["recoveryCount"],
        serde_json::Value::Null
    );

    // replaceUrl to the live mirror rebinds and the pump completes the job.
    let response = request(
        &mut w,
        &mut r,
        &serde_json::json!({"v":1,"id":"ru1","method":"download.replaceUrl",
            "params":{"id":job_id,"url":mirror.base_url()}})
        .to_string(),
    )
    .await;
    assert_eq!(response["ok"], true, "replaceUrl must succeed: {response}");
    assert_eq!(response["result"]["job"]["recoveryCount"], 1);
    assert!(response["result"]["job"]["reboundAt"].is_i64());

    let mut completed = false;
    for _ in 0..200 {
        let get = request(&mut w, &mut r, &get_req("g2", &job_id)).await;
        let job = &get["result"]["job"];
        if job["status"] == "completed" {
            assert_eq!(job["recoveryCount"], 1);
            assert_eq!(job["url"], mirror.base_url());
            completed = true;
            break;
        }
        assert_ne!(job["status"], "failed", "mirror run must not fail: {job}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(completed, "rebound job must complete through the pump");

    // Terminal jobs reject recovery verbs with invalid_state.
    for method in ["download.recover", "download.retry"] {
        let response = request(
            &mut w,
            &mut r,
            &serde_json::json!({"v":1,"id":"bad","method":method,"params":{"id":job_id}})
                .to_string(),
        )
        .await;
        assert_eq!(response["ok"], false, "{method} must reject completed jobs");
        assert_eq!(response["error"]["code"], "invalid_state");
    }

    let _ = request(
        &mut w,
        &mut r,
        &serde_json::json!({"v":1,"id":"rm","method":"download.remove",
            "params":{"id":job_id,"deletePartialFile":true}})
        .to_string(),
    )
    .await;
}

fn get_req(id: &str, job_id: &str) -> String {
    serde_json::json!({"v":1,"id":id,"method":"download.get","params":{"id":job_id}}).to_string()
}

/// The real binary end-to-end: spawn it, expect `core.ready` on stdout, then a pong.
#[test]
fn spawned_binary_end_to_end() {
    use std::io::BufRead;
    let exe = env!("CARGO_BIN_EXE_download-core");
    let db = std::env::temp_dir().join(format!(
        "dc-bin-test-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    let _ = std::fs::remove_file(&db);

    let mut child = std::process::Command::new(exe)
        .env("SYNTAXDM_DB", &db)
        .stdout(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn download-core");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        use std::io::Write;
        let _ = stdin.write_all(br#"{"v":1,"id":"bin1","method":"core.ping"}"#);
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
        // keep stdin open for a bit so the core doesn't see EOF early
        std::thread::sleep(std::time::Duration::from_secs(8));
    });

    let reader = std::io::BufReader::new(stdout);
    let mut saw_ready = false;
    let mut saw_pong = false;
    let start = std::time::Instant::now();
    for line in reader.lines() {
        let line = line.expect("stdout readable");
        if line.contains("core.ready") {
            saw_ready = true;
        }
        if line.contains("\"id\":\"bin1\"") && line.contains("\"pong\":true") {
            saw_pong = true;
        }
        if saw_ready && saw_pong || start.elapsed() > std::time::Duration::from_secs(8) {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&db);
    assert!(saw_ready, "binary must announce core.ready");
    assert!(saw_pong, "binary must answer core.ping");
}

/// Full-surface e2e: create a job (with an expected checksum) through the JSONL protocol,
/// against a real local HTTP server, and watch it reach `completed` with a verified digest.
#[tokio::test]
async fn create_with_checksum_completes_over_rpc() {
    // 1.2 MiB deterministic body → 2 segments at 2 connections (>= 1 MiB minimum each).
    let body: Vec<u8> = (0..(1200 * 1024u32))
        .map(|i| ((i as u64 * 31 + 7) % 256) as u8)
        .collect();
    let server = common_test_server::ShaServer::start(body.clone()).await;

    let (mut w, mut r) = spawn_serve().await;
    let expected = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&body);
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let dir = std::env::temp_dir().join(format!(
        "dc-rpc-e2e-{}-{}",
        std::process::id(),
        dc_protocol::new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();

    let create = serde_json::json!({
        "v": 1, "id": "ck1", "method": "download.create",
        "params": {
            "url": server.base_url(),
            "destinationDir": dir.display().to_string(),
            "checksum": { "algorithm": "sha256", "value": expected }
        }
    });
    let response = request(&mut w, &mut r, &create.to_string()).await;
    assert_eq!(response["ok"], true, "create must succeed: {response}");
    let job_id = response["result"]["job"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        response["result"]["job"]["checksumExpected"],
        expected.as_str()
    );

    let mut completed = false;
    for _ in 0..200 {
        let get = request(
            &mut w,
            &mut r,
            &serde_json::json!({"v":1,"id":"g","method":"download.get","params":{"id":job_id}})
                .to_string(),
        )
        .await;
        if get["result"]["job"]["status"] == "completed" {
            assert_eq!(get["result"]["job"]["checksumVerified"], true);
            assert_eq!(get["result"]["job"]["checksumActual"], expected.as_str());
            assert!(get["result"]["job"]["segmentCount"].as_i64().unwrap() >= 2);
            completed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(completed, "job must complete through the RPC surface");

    // cleanup
    let _ = request(
        &mut w,
        &mut r,
        &serde_json::json!({"v":1,"id":"rm","method":"download.remove",
            "params":{"id":job_id,"deletePartialFile":true}})
        .to_string(),
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}

mod common_test_server {
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    pub struct ShaServer {
        addr: std::net::SocketAddr,
    }

    impl ShaServer {
        pub async fn start(body: Vec<u8>) -> Arc<Self> {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().unwrap();
            let body = Arc::new(body);
            let body_cl = body.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let b = body_cl.clone();
                    tokio::spawn(async move {
                        serve_file(socket, b).await;
                    });
                }
            });
            Arc::new(Self { addr })
        }

        pub fn base_url(&self) -> String {
            format!("http://{}/file", self.addr)
        }
    }

    async fn serve_file(mut socket: TcpStream, body: Arc<Vec<u8>>) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
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
        for line in request.lines() {
            if let Some(v) = line.strip_prefix("range: bytes=") {
                let mut parts = v.trim().split('-');
                range_start = parts.next().and_then(|s| s.parse().ok());
                range_end = parts.next().and_then(|s| s.parse().ok());
            }
        }
        let len = body.len();
        let head = match (range_start, range_end) {
            (Some(s), e) if s < len as u64 => {
                let end = e.map(|x| (x as usize).min(len - 1)).unwrap_or(len - 1);
                let slice_len = end - s as usize + 1;
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {slice_len}\r\nAccept-Ranges: bytes\r\nETag: \"sha-e2e\"\r\nContent-Range: bytes {s}-{end}/{len}\r\nConnection: close\r\n\r\n"
                )
            }
            _ => format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nETag: \"sha-e2e\"\r\nConnection: close\r\n\r\n"
            ),
        };
        socket.write_all(head.as_bytes()).await.ok();
        match range_start {
            Some(s) => socket.write_all(&body[s as usize..]).await.ok(),
            None => socket.write_all(&body).await.ok(),
        };
        socket.flush().await.ok();
    }
}

// ---- Phase 14: browser history + bookmarks over the wire ----

#[tokio::test]
async fn history_methods_round_trip_over_rpc() {
    let (mut w, mut r) = spawn_serve().await;

    // Record two visits (one without optional fields — nulls stay explicit).
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h1","method":"browser.history.record","params":{"url":"https://example.com/a","title":"A","visitedAt":1000}}"#,
    )
    .await;
    assert_eq!(response["result"]["recorded"], true);

    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h2","method":"browser.history.record","params":{"url":"https://example.com/b"}}"#,
    )
    .await;
    assert_eq!(response["result"]["recorded"], true);

    // List: newest first, explicit nulls preserved.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h3","method":"browser.history.list","params":{}}"#,
    )
    .await;
    let entries = response["result"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["url"], "https://example.com/b");
    assert!(entries[0]["title"].is_null());
    assert!(entries[0]["faviconUrl"].is_null());
    let id = entries[0]["id"].as_str().unwrap().to_string();

    // Query + pagination params parse.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h4","method":"browser.history.list","params":{"query":"UNI","limit":50,"offset":0}}"#,
    )
    .await;
    assert_eq!(response["result"]["entries"].as_array().unwrap().len(), 0);

    // Delete + clear.
    let response = request(
        &mut w,
        &mut r,
        &format!(
            r#"{{"v":1,"id":"h5","method":"browser.history.delete","params":{{"id":"{id}"}}}}"#
        ),
    )
    .await;
    assert_eq!(response["result"]["deleted"], true);

    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h6","method":"browser.history.clear","params":{"before":2000}}"#,
    )
    .await;
    assert_eq!(response["result"]["cleared"], 1);

    // Deleting a missing entry is invalid_state over the wire.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"h7","method":"browser.history.delete","params":{"id":"01JD8W3G5XQ9V4M2K7PZ6N8S0Z"}}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_state");
}

#[tokio::test]
async fn history_record_rejects_non_http_schemes() {
    let (mut w, mut r) = spawn_serve().await;
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s1","method":"browser.history.record","params":{"url":"file:///etc/passwd"}}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_params");
}

#[tokio::test]
async fn bookmark_methods_round_trip_over_rpc() {
    let (mut w, mut r) = spawn_serve().await;

    // Create two bookmarks; positions are assigned by the store.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b1","method":"browser.bookmark.create","params":{"url":"https://a.example/","title":"A"}}"#,
    )
    .await;
    assert_eq!(response["result"]["bookmark"]["position"], 0);
    let id_a = response["result"]["bookmark"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b2","method":"browser.bookmark.create","params":{"url":"https://b.example/","title":"B"}}"#,
    )
    .await;
    assert_eq!(response["result"]["bookmark"]["position"], 1);

    // List preserves position order.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b3","method":"browser.bookmark.list","params":{}}"#,
    )
    .await;
    let bookmarks = response["result"]["bookmarks"].as_array().unwrap();
    assert_eq!(bookmarks.len(), 2);
    assert_eq!(bookmarks[0]["title"], "A");

    // getByUrl: first match; absent URL → explicit null.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b4","method":"browser.bookmark.getByUrl","params":{"url":"https://a.example/"}}"#,
    )
    .await;
    assert_eq!(response["result"]["bookmark"]["title"], "A");
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b5","method":"browser.bookmark.getByUrl","params":{"url":"https://none.example/"}}"#,
    )
    .await;
    assert!(response["result"]["bookmark"].is_null());

    // Update: rename only.
    let response = request(
        &mut w,
        &mut r,
        &format!(
            r#"{{"v":1,"id":"b6","method":"browser.bookmark.update","params":{{"id":"{id_a}","title":"Renamed"}}}}"#
        ),
    )
    .await;
    assert_eq!(response["result"]["bookmark"]["title"], "Renamed");
    assert_eq!(response["result"]["bookmark"]["url"], "https://a.example/");

    // Remove + remove again (invalid_state).
    let response = request(
        &mut w,
        &mut r,
        &format!(
            r#"{{"v":1,"id":"b7","method":"browser.bookmark.remove","params":{{"id":"{id_a}"}}}}"#
        ),
    )
    .await;
    assert_eq!(response["result"]["removed"], true);
    let response = request(
        &mut w,
        &mut r,
        &format!(
            r#"{{"v":1,"id":"b8","method":"browser.bookmark.remove","params":{{"id":"{id_a}"}}}}"#
        ),
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_state");

    // Non-http bookmark URL rejected at the boundary.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"b9","method":"browser.bookmark.create","params":{"url":"javascript:alert(1)","title":"X"}}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_params");
}

// ---- Phase 15: scheduler jobs + automation (wire surface) ----

#[tokio::test]
async fn scheduler_arms_round_trip_and_classify() {
    let (mut w, mut r) = spawn_serve().await;

    // create: future anchor (tick-immune), daily startAll.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s1","method":"scheduler.create","params":{"kind":"download.startAll","payload":{},"startAt":9999999999999,"repeat":"daily","enabled":true}}"#,
    )
    .await;
    assert_eq!(response["ok"], true);
    let job_id = response["result"]["job"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(response["result"]["job"]["kind"], "download.startAll");
    assert_eq!(response["result"]["job"]["nextRunAt"], 9999999999999i64);
    // Always-serialized nullable outcome fields.
    assert!(response["result"]["job"]["lastFiredAt"].is_null());
    assert!(response["result"]["job"]["lastResultCode"].is_null());

    // list carries the row.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s2","method":"scheduler.list"}"#,
    )
    .await;
    assert_eq!(response["result"]["jobs"].as_array().unwrap().len(), 1);

    // update: switch repeat + disable.
    let response = request(
        &mut w,
        &mut r,
        &format!(
            r#"{{"v":1,"id":"s3","method":"scheduler.update","params":{{"id":"{job_id}","patch":{{"repeat":"weekly","enabled":false}}}}}}"#
        ),
    )
    .await;
    assert_eq!(response["result"]["job"]["repeat"], "weekly");
    assert_eq!(response["result"]["job"]["enabled"], false);

    // setClock (main → core surface): applied.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s4","method":"scheduler.setClock","params":{"tzOffsetMinutes":210}}"#,
    )
    .await;
    assert_eq!(response["result"]["applied"], true);

    // remove + remove again (invalid_state).
    let response = request(
        &mut w,
        &mut r,
        &format!(r#"{{"v":1,"id":"s5","method":"scheduler.remove","params":{{"id":"{job_id}"}}}}"#),
    )
    .await;
    assert_eq!(response["result"]["removed"], true);
    let response = request(
        &mut w,
        &mut r,
        &format!(r#"{{"v":1,"id":"s6","method":"scheduler.remove","params":{{"id":"{job_id}"}}}}"#),
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_state");

    // Unknown action → invalid_params at the boundary.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s7","method":"scheduler.create","params":{"kind":"media.inspect","payload":{},"startAt":1,"repeat":"none"}}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "invalid_params");

    // Unknown method is still method_not_found.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"s8","method":"scheduler.nope"}"#,
    )
    .await;
    assert_eq!(response["error"]["code"], "method_not_found");
}

#[tokio::test]
async fn scheduler_run_now_records_the_outcome_over_the_wire() {
    let (mut w, mut r) = spawn_serve().await;

    // Enabled one-shot with a future anchor (tick-immune) → runNow records ok and the
    // schedule stays untouched.
    let response = request(
        &mut w,
        &mut r,
        r#"{"v":1,"id":"r1","method":"scheduler.create","params":{"kind":"download.startAll","payload":{},"startAt":9999999999999,"repeat":"none","enabled":true}}"#,
    )
    .await;
    let job_id = response["result"]["job"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = request(
        &mut w,
        &mut r,
        &format!(r#"{{"v":1,"id":"r2","method":"scheduler.runNow","params":{{"id":"{job_id}"}}}}"#),
    )
    .await;
    assert_eq!(response["result"]["job"]["lastResultCode"], "ok");
    assert!(response["result"]["job"]["lastFiredAt"].is_i64());
    assert!(response["result"]["job"]["lastResultMessage"]
        .as_str()
        .unwrap()
        .starts_with("started"));
    // Manual fire leaves the schedule untouched.
    assert_eq!(response["result"]["job"]["nextRunAt"], 9999999999999i64);
}
