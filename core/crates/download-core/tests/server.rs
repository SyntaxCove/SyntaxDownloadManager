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
        .env("UNIDM_DB", &db)
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
