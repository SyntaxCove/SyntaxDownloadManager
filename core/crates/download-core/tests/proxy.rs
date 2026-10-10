//! Phase 9 integration tests: per-job proxy routing against a real local HTTP proxy
//! harness (absolute-URI forwarding, Proxy-Authorization gate with 407), fail-closed
//! behavior when the runtime map lacks a profile, bypass-list routing, proxy.test
//! classification and the setProxy state guards.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dc_protocol::job::DownloadJob;
use dc_protocol::new_ulid;
use dc_storage::JobStore;
use download_core::engine::CreateJobParams;
use download_core::manager::JobManager;
use download_core::proxy::{proxy_url, RuntimeProxy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dc-proxy-test-{}-{}",
        std::process::id(),
        new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn params(url: String, dir: &std::path::Path, proxy: Option<String>) -> CreateJobParams {
    CreateJobParams {
        url,
        destination_dir: dir.display().to_string(),
        filename: None,
        overwrite: false,
        headers: None,
        checksum: None,
        proxy_profile_id: proxy,
    }
}

fn profile(
    id: &str,
    port: u16,
    user: Option<&str>,
    pass: Option<&str>,
    bypass: Vec<&str>,
) -> RuntimeProxy {
    RuntimeProxy {
        id: id.into(),
        scheme: "http".into(),
        host: "127.0.0.1".into(),
        port,
        username: user.map(|s| s.into()),
        password: pass.map(|s| s.into()),
        bypass_list: bypass.into_iter().map(|s| s.into()).collect(),
    }
}

fn make_manager(store: Arc<JobStore>) -> Arc<JobManager> {
    let (tx, _rx) = mpsc::unbounded_channel();
    JobManager::new(store, tx)
}

async fn wait_for_status(
    store: &JobStore,
    id: &str,
    statuses: &[&str],
    timeout: Duration,
) -> DownloadJob {
    let deadline = Instant::now() + timeout;
    loop {
        let job = store.get_job(id).unwrap().expect("job exists");
        if statuses.contains(&job.status.as_str()) {
            return job;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {statuses:?} (is {})",
            job.status
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---- minimal absolute-URI HTTP/1.1 forward proxy ----

pub struct ProxyHarness {
    pub port: u16,
    forwarded: Arc<AtomicU64>,
    auth_failures: Arc<AtomicU64>,
}

impl ProxyHarness {
    /// `expected_auth`: raw Proxy-Authorization header value required when `Some`.
    pub async fn start(expected_auth: Option<&'static str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("proxy bind");
        let port = listener.local_addr().unwrap().port();
        let forwarded = Arc::new(AtomicU64::new(0));
        let auth_failures = Arc::new(AtomicU64::new(0));
        let f = forwarded.clone();
        let a = auth_failures.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let f = f.clone();
                let a = a.clone();
                tokio::spawn(async move {
                    handle_proxy(socket, expected_auth, f, a).await;
                });
            }
        });
        Self {
            port,
            forwarded,
            auth_failures,
        }
    }

    pub fn forwarded_count(&self) -> u64 {
        self.forwarded.load(Ordering::SeqCst)
    }

    #[allow(dead_code)]
    pub fn auth_failure_count(&self) -> u64 {
        self.auth_failures.load(Ordering::SeqCst)
    }

    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

async fn handle_proxy(
    mut client: TcpStream,
    expected_auth: Option<&'static str>,
    forwarded: Arc<AtomicU64>,
    auth_failures: Arc<AtomicU64>,
) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = client.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let raw = String::from_utf8_lossy(&buf).to_string();
    let mut lines = raw.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let absolute_uri = parts.next().unwrap_or_default().to_string();

    // Auth gate (Proxy-Authorization is checked before anything else).
    let mut proxy_auth: Option<String> = None;
    let mut other_headers: Vec<String> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("proxy-authorization:") {
            proxy_auth = Some(line.split_once(':').unwrap().1.trim().to_string());
        } else if !lower.starts_with("proxy-connection:") && !lower.starts_with("connection:") {
            other_headers.push(line.to_string());
        }
    }
    if let Some(expected) = expected_auth {
        if proxy_auth.as_deref() != Some(expected) {
            auth_failures.fetch_add(1, Ordering::SeqCst);
            let head = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            client.write_all(head.as_bytes()).await.ok();
            return;
        }
    }

    // Only absolute-form http URIs are proxied in these tests.
    let url = match url::Url::parse(&absolute_uri) {
        Ok(u) if u.scheme() == "http" => u,
        _ => {
            let head = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            client.write_all(head.as_bytes()).await.ok();
            return;
        }
    };
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port().unwrap_or(80);
    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };

    let Ok(mut target) = TcpStream::connect((host.as_str(), port)).await else {
        let head = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        client.write_all(head.as_bytes()).await.ok();
        return;
    };
    forwarded.fetch_add(1, Ordering::SeqCst);

    // Rebuild the request in origin-form for the target, keeping every meaningful header.
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n");
    for h in &other_headers {
        req.push_str(h);
        req.push_str("\r\n");
    }
    req.push_str("\r\n");
    target.write_all(req.as_bytes()).await.ok();

    // Pipe the response back verbatim (single direction is enough: GETs have no body).
    let mut pipe = [0u8; 8192];
    loop {
        let n = match target.read(&mut pipe).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if client.write_all(&pipe[..n]).await.is_err() {
            break;
        }
    }
    client.flush().await.ok();
}

const AUTH_OK: &str = "Basic dXNlcjpwYXNz"; // user:pass

// ---- tests ----

#[tokio::test]
async fn proxied_job_routes_through_the_proxy_and_completes() {
    let body: Vec<u8> = (0..24_576u32).map(|i| (i % 251) as u8).collect();
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let proxy = ProxyHarness::start(None).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());

    manager.set_runtime_proxies(vec![profile("01PROXYA", proxy.port, None, None, vec![])]);
    let dir = tempdir();
    let job = manager
        .create(params(
            server.base_url.clone(),
            &dir,
            Some("01PROXYA".into()),
        ))
        .await
        .unwrap();

    let done = wait_for_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(done.received_bytes, body.len() as u64);
    assert!(
        proxy.forwarded_count() >= 1,
        "the proxy must have seen the traffic"
    );
    let saved = std::fs::read(done.destination_path.unwrap()).unwrap();
    assert_eq!(saved, body);
}

#[tokio::test]
async fn direct_job_never_touches_the_proxy() {
    let body: Vec<u8> = vec![7u8; 8192];
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let proxy = ProxyHarness::start(None).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    // Runtime map has the proxy, but the job carries no profile → direct.
    manager.set_runtime_proxies(vec![profile("01PROXYB", proxy.port, None, None, vec![])]);

    let dir = tempdir();
    let job = manager
        .create(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();
    wait_for_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(
        proxy.forwarded_count(),
        0,
        "a direct job must bypass the proxy"
    );
}

#[tokio::test]
async fn bypassed_host_goes_direct() {
    let body: Vec<u8> = vec![3u8; 8192];
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let proxy = ProxyHarness::start(None).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    // The target host is on the profile's bypass list.
    let target_host = url::Url::parse(&server.base_url)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    manager.set_runtime_proxies(vec![profile(
        "01PROXYC",
        proxy.port,
        None,
        None,
        vec![&target_host],
    )]);

    let dir = tempdir();
    let job = manager
        .create(params(
            server.base_url.clone(),
            &dir,
            Some("01PROXYC".into()),
        ))
        .await
        .unwrap();
    wait_for_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(proxy.forwarded_count(), 0, "bypassed hosts must go direct");
}

#[tokio::test]
async fn wrong_proxy_credentials_fail_the_run() {
    let body: Vec<u8> = vec![5u8; 4096];
    let server = common::TestServer::start(body, vec![], 0).await;
    let proxy = ProxyHarness::start(Some(AUTH_OK)).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_runtime_proxies(vec![profile(
        "01PROXYD",
        proxy.port,
        Some("user"),
        Some("wrong"),
        vec![],
    )]);

    let dir = tempdir();
    let job = manager
        .create(params(
            server.base_url.clone(),
            &dir,
            Some("01PROXYD".into()),
        ))
        .await
        .unwrap();
    let failed = wait_for_status(
        &store,
        job.id.as_str(),
        &["failed"],
        Duration::from_secs(20),
    )
    .await;
    assert!(
        proxy.auth_failure_count() >= 1,
        "the 407 gate must have tripped"
    );
    assert_eq!(
        proxy.forwarded_count(),
        0,
        "rejected requests are never forwarded"
    );
    assert!(matches!(
        failed.error_code.as_deref(),
        Some("network_error") | Some("http_error")
    ));
}

#[tokio::test]
async fn missing_runtime_profile_pauses_then_resume_completes() {
    let body: Vec<u8> = vec![9u8; 6144];
    let server = common::TestServer::start(body.clone(), vec![], 0).await;
    let proxy = ProxyHarness::start(None).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    // Deliberately NO setRuntime push: the core boots with an empty proxy map.

    let dir = tempdir();
    let job = manager
        .create(params(
            server.base_url.clone(),
            &dir,
            Some("01MISSING".into()),
        ))
        .await
        .unwrap();
    let paused = wait_for_status(
        &store,
        job.id.as_str(),
        &["paused"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(
        paused.error_code.as_deref(),
        Some("proxy_profile_not_found"),
        "fail-closed: pause with an actionable code, never route direct"
    );
    assert_eq!(proxy.forwarded_count(), 0);
    // The part must not exist — no bytes were fetched through the wrong identity.
    assert_eq!(paused.received_bytes, 0);

    // Main re-pushes the runtime set (e.g. after app start / profile edit): resume works.
    manager.set_runtime_proxies(vec![profile("01MISSING", proxy.port, None, None, vec![])]);
    manager.resume(job.id.as_str()).await.unwrap();
    let done = wait_for_status(
        &store,
        job.id.as_str(),
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(done.received_bytes, body.len() as u64);
    assert!(proxy.forwarded_count() >= 1);
    let saved = std::fs::read(done.destination_path.unwrap()).unwrap();
    assert_eq!(saved, body);
}

#[tokio::test]
async fn set_job_proxy_guarded_by_state_and_persisted() {
    let body: Vec<u8> = (0..40_960u32).map(|i| (i % 243) as u8).collect();
    let server =
        common::TestServer::start_with(body.clone(), vec![], 8, 1024, Default::default()).await;
    let proxy = ProxyHarness::start(None).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store.clone());
    manager.set_runtime_proxies(vec![profile("01PROXYE", proxy.port, None, None, vec![])]);

    let dir = tempdir();
    let job = manager
        .create(params(server.base_url.clone(), &dir, None))
        .await
        .unwrap();

    // queued: allowed, persisted, emitted.
    let updated = manager
        .set_job_proxy(job.id.as_str(), Some("01PROXYE".into()))
        .unwrap();
    assert_eq!(updated.proxy_profile_id.as_deref(), Some("01PROXYE"));
    assert_eq!(
        store
            .get_job(job.id.as_str())
            .unwrap()
            .unwrap()
            .proxy_profile_id
            .as_deref(),
        Some("01PROXYE")
    );

    // Wait until the run is active, then refuse the change.
    wait_for_status(
        &store,
        job.id.as_str(),
        &["downloading", "probing"],
        Duration::from_secs(10),
    )
    .await;
    let err = manager
        .set_job_proxy(job.id.as_str(), None)
        .expect_err("active job must refuse proxy changes");
    assert_eq!(err.code.as_str(), "invalid_state");
}

#[tokio::test]
async fn proxy_test_classifies_ok_and_auth_failure() {
    let body: Vec<u8> = b"198.51.100.7".to_vec(); // echoes the "exit IP"
    let server = common::TestServer::start(body, vec![], 0).await;
    let proxy = ProxyHarness::start(Some(AUTH_OK)).await;
    let store = Arc::new(JobStore::open_in_memory().unwrap());
    let manager = make_manager(store);
    manager.set_runtime_proxies(vec![
        profile("01TESTOK", proxy.port, Some("user"), Some("pass"), vec![]),
        profile("01TESTBAD", proxy.port, Some("user"), Some("nope"), vec![]),
    ]);

    let ok = manager
        .test_proxy("01TESTOK", Some(server.base_url.clone()))
        .await
        .unwrap();
    assert_eq!(ok["ok"], serde_json::json!(true));
    assert!(ok["latencyMs"].as_u64().is_some());
    assert_eq!(ok["exitIp"], serde_json::json!("198.51.100.7"));
    assert_eq!(ok["status"], serde_json::json!(200));

    let bad = manager
        .test_proxy("01TESTBAD", Some(server.base_url.clone()))
        .await
        .unwrap();
    assert_eq!(bad["ok"], serde_json::json!(false));
    assert_eq!(bad["errorCode"], serde_json::json!("http_error"));
    assert_eq!(bad["status"], serde_json::json!(407));

    let missing = manager.test_proxy("01NOPE", None).await.unwrap_err();
    assert_eq!(missing.code.as_str(), "proxy_profile_not_found");
}

#[tokio::test]
async fn socks5_profile_builds_a_valid_endpoint() {
    // The sandbox has no SOCKS server; the wire shape is pinned instead (reqwest parses it).
    let p = profile("01SOCKS", 1080, Some("u"), Some("p"), vec![]);
    let mut p = p;
    p.scheme = "socks5".into();
    p.host = "proxy.example.com".into();
    assert_eq!(
        proxy_url(&p).unwrap(),
        "socks5://u:p@proxy.example.com:1080"
    );
}
