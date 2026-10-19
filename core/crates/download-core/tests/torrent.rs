//! Phase 13 integration tests — the torrent engine against a fake swarm over real sockets:
//! fake HTTP tracker (bencode announce), fake UDP tracker (BEP 15), a fake seeder that can
//! also serve magnet metadata (BEP 9/10), and a fake leecher for the upload path.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dc_bt::bencode::{bint, bstr, encode, BValue};
use dc_bt::peer::{Message, PeerConn};
use dc_storage::JobStore;
use download_core::torrent_manager::TorrentManager;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// deterministic payload + metainfo builders
// ---------------------------------------------------------------------------

fn payload(len: usize) -> Vec<u8> {
    // xorshift for deterministic, hash-meaningful bytes
    let mut state = 0x2545F4914F6CDD1Du64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state & 0xFF) as u8
        })
        .collect()
}

fn piece_hashes(data: &[u8], piece_len: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(piece_len) {
        out.extend_from_slice(&Sha1::digest(chunk));
    }
    out
}

fn build_metainfo_bytes(name: &str, data: &[u8], piece_len: usize, announce: &str) -> Vec<u8> {
    let top = BValue::Dict(vec![
        (b"announce".to_vec(), bstr(announce)),
        (
            b"info".to_vec(),
            BValue::Dict(vec![
                (b"length".to_vec(), bint(data.len() as i64)),
                (b"name".to_vec(), bstr(name)),
                (b"piece length".to_vec(), bint(piece_len as i64)),
                (
                    b"pieces".to_vec(),
                    BValue::Bytes(piece_hashes(data, piece_len)),
                ),
            ]),
        ),
    ]);
    encode(&top)
}

fn build_v2_only_bytes() -> Vec<u8> {
    let top = BValue::Dict(vec![
        (
            b"info".to_vec(),
            BValue::Dict(vec![
                (b"name".to_vec(), bstr("v2")),
                (b"piece length".to_vec(), bint(16384)),
                (b"file tree".to_vec(), BValue::Dict(vec![])),
            ]),
        ),
        (b"meta version".to_vec(), bint(2)),
    ]);
    encode(&top)
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// fake HTTP tracker
// ---------------------------------------------------------------------------

struct FakeTracker {
    addr: std::net::SocketAddr,
    /// Info-hashes seen in announce queries (hex).
    seen: Arc<Mutex<Vec<String>>>,
}

impl FakeTracker {
    /// Serve minimal GET announce responses pointing at `seeder`.
    async fn start(seeder: std::net::SocketAddr) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let seen_task = seen_task.clone();
                let seeder = seeder;
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    // "GET /announce?info_hash=%..&... HTTP/1.1"
                    let query = req.split_whitespace().nth(1).unwrap_or_default();
                    if let Some(q) = query.split_once('?').map(|(_, q)| q) {
                        for pair in q.split('&') {
                            if let Some((k, v)) = pair.split_once('=') {
                                if k == "info_hash" {
                                    if let Some(bytes) = percent_decode(v) {
                                        seen_task.lock().unwrap().push(dc_bt::hex20(&bytes));
                                    }
                                }
                            }
                        }
                    }
                    // compact peers: exactly one (the seeder)
                    let mut peer_bytes = Vec::new();
                    match seeder.ip() {
                        std::net::IpAddr::V4(v4) => {
                            peer_bytes.extend_from_slice(&v4.octets());
                        }
                        _ => return,
                    }
                    peer_bytes.extend_from_slice(&seeder.port().to_be_bytes());
                    let body = encode(&BValue::Dict(vec![
                        (b"complete".to_vec(), bint(1)),
                        (b"incomplete".to_vec(), bint(0)),
                        (b"interval".to_vec(), bint(60)),
                        (b"peers".to_vec(), BValue::Bytes(peer_bytes)),
                    ]));
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { addr, seen }
    }
}

fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// fake UDP tracker (BEP 15)
// ---------------------------------------------------------------------------

async fn spawn_fake_udp_tracker(
    seeder: std::net::SocketAddr,
    seen: Arc<Mutex<Vec<String>>>,
) -> std::net::SocketAddr {
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = sock.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let (n, from) = match sock.recv_from(&mut buf).await {
                Ok(x) => x,
                Err(_) => break,
            };
            if n < 16 {
                eprintln!("FAKE-UDP short packet n={n} from {from}");
                continue;
            }
            // Connect packets start with the magic; announce packets with the
            // connection_id issued earlier.
            let magic = u64::from_be_bytes(buf[0..8].try_into().unwrap());
            let is_connect = magic == 0x41727101980;
            let is_announce =
                magic == 12345u64 && u32::from_be_bytes(buf[8..12].try_into().unwrap()) == 1;
            if !is_connect && !is_announce {
                eprintln!("FAKE-UDP unrecognized packet n={n} head={magic:#x}");
                continue;
            }
            let action = u32::from_be_bytes(buf[8..12].try_into().unwrap());
            let txn: [u8; 4] = buf[12..16].try_into().unwrap();
            if action == 0 {
                // connect → connection id 12345
                let mut reply = Vec::new();
                reply.extend_from_slice(&0u32.to_be_bytes());
                reply.extend_from_slice(&txn);
                reply.extend_from_slice(&12345u64.to_be_bytes());
                let _ = sock.send_to(&reply, from).await;
            } else if action == 1 && n >= 98 {
                // announce → validate info_hash echo, reply with the seeder
                let ih: [u8; 20] = buf[16..36].try_into().unwrap();
                seen.lock().unwrap().push(dc_bt::hex20(&ih));
                let mut reply = Vec::new();
                reply.extend_from_slice(&1u32.to_be_bytes());
                reply.extend_from_slice(&txn);
                reply.extend_from_slice(&60u32.to_be_bytes()); // interval
                reply.extend_from_slice(&0u32.to_be_bytes()); // leechers
                reply.extend_from_slice(&1u32.to_be_bytes()); // seeders
                if let std::net::IpAddr::V4(v4) = seeder.ip() {
                    reply.extend_from_slice(&v4.octets());
                    reply.extend_from_slice(&seeder.port().to_be_bytes());
                }
                let _ = sock.send_to(&reply, from).await;
            }
        }
    });
    addr
}

// ---------------------------------------------------------------------------
// fake seeder (payload pieces + optional magnet metadata via BEP 9/10)
// ---------------------------------------------------------------------------

struct SeederStats {
    requested: Mutex<Vec<(u32, u32)>>,
    connections: AtomicU64,
}

/// Sleep before serving each requested piece (0 = serve immediately).
async fn maybe_delay(delay_ms: u64) {
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
}

struct FakeSeeder {
    addr: std::net::SocketAddr,
    stats: Arc<SeederStats>,
    _tasks: mpsc::UnboundedSender<()>, // keeps the accept loop alive until dropped
}

impl FakeSeeder {
    /// Serve `data` pieces (and, when `metadata` is Some, magnet metadata via ut_metadata).
    /// `skip_pieces` are never served (the session must pause / eventually complete only
    /// when the test asks).
    async fn start(
        info_hash: [u8; 20],
        data: Vec<u8>,
        piece_len: usize,
        metadata: Option<Vec<u8>>,
    ) -> Self {
        Self::start_with_delay(info_hash, data, piece_len, metadata, 0).await
    }

    async fn start_with_delay(
        info_hash: [u8; 20],
        data: Vec<u8>,
        piece_len: usize,
        metadata: Option<Vec<u8>>,
        delay_ms: u64,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stats = Arc::new(SeederStats {
            requested: Mutex::new(Vec::new()),
            connections: AtomicU64::new(0),
        });
        let (tx, mut keepalive_rx) = mpsc::unbounded_channel::<()>();
        let stats_task = stats.clone();
        tokio::spawn(async move {
            let _keepalive = &mut keepalive_rx;
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let stats_task = stats_task.clone();
                let info_hash = info_hash;
                let data = data.clone();
                let piece_len = piece_len;
                let metadata = metadata.clone();
                tokio::spawn(async move {
                    serve_peer(
                        stream, info_hash, data, piece_len, metadata, stats_task, delay_ms,
                    )
                    .await;
                });
            }
        });
        Self {
            addr,
            stats,
            _tasks: tx,
        }
    }
}

async fn serve_peer(
    stream: tokio::net::TcpStream,
    info_hash: [u8; 20],
    data: Vec<u8>,
    piece_len: usize,
    metadata: Option<Vec<u8>>,
    stats: Arc<SeederStats>,
    delay_ms: u64,
) {
    stats.connections.fetch_add(1, Ordering::SeqCst);
    let mut conn = PeerConn::new(stream);
    let hs = match dc_bt::peer::read_handshake(conn.get_mut()).await {
        Ok(h) => h,
        Err(_) => return,
    };
    if hs.info_hash != info_hash {
        return;
    }
    // answer handshake + advertise extension support
    let _ = conn
        .get_mut()
        .write_all(&dc_bt::peer::encode_handshake(
            &info_hash,
            &b"-FAKE000-000000000000"[..].try_into().unwrap_or([0u8; 20]),
        ))
        .await;
    // our bitfield: all pieces
    let num_pieces = data.len().div_ceil(piece_len);
    let mut bf = vec![0u8; num_pieces.div_ceil(8)];
    for i in 0..num_pieces {
        bf[i / 8] |= 0x80 >> (i % 8);
    }
    let _ = conn.send(&Message::Bitfield(bf.clone())).await;
    let _ = conn.send(&Message::Unchoke).await;
    if let Some(meta_bytes) = &metadata {
        // extended handshake advertising ut_metadata = 1
        let _ = conn
            .send(&Message::Extended(
                0,
                dc_bt::peer::encode_extended_handshake(1, Some(meta_bytes.len() as u64)),
            ))
            .await;
    }

    let mut remote_ut_id: u8 = 0;
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(15), conn.recv()).await {
            Ok(Ok(Some(m))) => m,
            _ => return,
        };
        match msg {
            Message::Request(i, b, l) => {
                stats.requested.lock().unwrap().push((i, b));
                maybe_delay(delay_ms).await;
                let start = i as usize * piece_len + b as usize;
                let end = (start + l as usize).min(data.len());
                if start <= end && end <= data.len() {
                    let _ = conn
                        .send(&Message::Piece(i, b, data[start..end].to_vec()))
                        .await;
                }
            }
            Message::Extended(0, payload) => {
                let ext = dc_bt::peer::parse_extended_handshake(&payload).unwrap();
                remote_ut_id = ext.ut_metadata;
            }
            Message::Extended(id, payload) if id == remote_ut_id && remote_ut_id != 0 => {
                if let Some(meta_bytes) = &metadata {
                    if let Ok(dc_bt::peer::MetadataMsg::Request(piece)) =
                        dc_bt::peer::parse_metadata_msg(&payload)
                    {
                        let start = piece as usize * 16 * 1024;
                        let end = (start + 16 * 1024).min(meta_bytes.len());
                        if start < meta_bytes.len() {
                            let _ = conn
                                .send(&Message::Extended(
                                    remote_ut_id,
                                    dc_bt::peer::encode_metadata_msg(
                                        &dc_bt::peer::MetadataMsg::Data(
                                            piece,
                                            meta_bytes[start..end].to_vec(),
                                        ),
                                    ),
                                ))
                                .await;
                        }
                    }
                }
            }
            Message::Piece(..) | Message::Have(..) | Message::KeepAlive => {}
            Message::Interested | Message::NotInterested => {}
            Message::Cancel(..) => {}
            Message::Bitfield(_) | Message::Choke | Message::Unchoke => {}
            Message::Extended(..) => {}
        }
    }
}

// ---------------------------------------------------------------------------
// fake leecher (validates the upload path against our inbound acceptor)
// ---------------------------------------------------------------------------

async fn leecher_pull(
    addr: std::net::SocketAddr,
    info_hash: [u8; 20],
    expected: &[u8],
    piece_len: usize,
) -> Vec<u8> {
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut conn = PeerConn::new(stream);
    conn.get_mut()
        .write_all(&dc_bt::peer::encode_handshake(
            &info_hash,
            &b"-LEEC000-000000000000"[..].try_into().unwrap_or([0u8; 20]),
        ))
        .await
        .unwrap();
    // read the responder handshake
    let _ = dc_bt::peer::read_handshake(conn.get_mut()).await.unwrap();
    let num_pieces = expected.len().div_ceil(piece_len);
    let _ = conn
        .send(&Message::Bitfield(vec![0u8; num_pieces.div_ceil(8)]))
        .await;
    let _ = conn.send(&Message::Interested).await;
    let mut out = vec![0u8; expected.len()];
    let mut got = HashSet::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while got.len() < num_pieces && tokio::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_secs(5), conn.recv()).await {
            Ok(Ok(Some(m))) => m,
            _ => break,
        };
        match msg {
            Message::Unchoke => {
                for i in 0..num_pieces as u32 {
                    let _ = conn.send(&Message::Request(i, 0, piece_len as u32)).await;
                }
            }
            Message::Piece(i, b, block) => {
                let start = i as usize * piece_len + b as usize;
                let end = (start + block.len()).min(expected.len());
                out[start..end].copy_from_slice(&block);
                got.insert(i);
            }
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

struct TestEnv {
    manager: Arc<TorrentManager>,
    store: Arc<JobStore>,
    dest: std::path::PathBuf,
    _events_rx: mpsc::UnboundedReceiver<dc_protocol::EventEnvelope>,
}

impl TestEnv {
    async fn new(db: std::path::PathBuf) -> Self {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_test_writer()
            .try_init();
        let store = Arc::new(JobStore::open(&db).unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        let proxies = Arc::new(download_core::proxy::ProxyMap::new());
        let manager = TorrentManager::new(store.clone(), tx, proxies);
        manager.set_metadata_budget_ms(10_000);
        // Hermetic DHT: point bootstrap at a refused port so no test touches the public
        // internet (tracker/seeder behavior is fully local).
        manager
            .set_dht_bootstrap(vec!["127.0.0.1:1".parse().unwrap()])
            .await;
        manager.bind().await.unwrap();
        let dir = db.parent().unwrap().to_path_buf();
        let dest = dir.join("downloads");
        std::fs::create_dir_all(&dest).unwrap();
        Self {
            manager,
            store,
            dest,
            _events_rx: rx,
        }
    }

    async fn wait_status(&self, id: &str, want: &[&str], secs: u64) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let status = self
                .store
                .get_torrent_job(id)
                .unwrap()
                .map(|r| r.status)
                .unwrap_or_default();
            if want.contains(&status.as_str()) {
                return status;
            }
            if tokio::time::Instant::now() > deadline {
                let row = self.store.get_torrent_job(id).unwrap();
                panic!(
                    "torrent {id} did not reach {want:?} within {secs}s (last: {status}, error: {:?})",
                    row.and_then(|r| r.error_code)
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

fn tempdir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "syntaxdm-torrent-test-{tag}-{}-{}",
        std::process::id(),
        dc_protocol::new_ulid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const PIECE_LEN: usize = 16 * 1024;
const TOTAL: usize = 4 * PIECE_LEN; // 64 KiB, 4 pieces
                                    // ---------------------------------------------------------------------------
                                    // tests
                                    // ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn torrent_download_completes_with_byte_identical_output() {
    let dir = tempdir("complete");
    let env = TestEnv::new(dir.join("db.sqlite")).await;
    let data = payload(TOTAL);
    // The info dict never contains the announce URL, so the info-hash is stable across
    // rebuilds — compute it once, then point the seeder and tracker at it.
    let info_hash =
        dc_bt::metainfo::parse(&build_metainfo_bytes("sample.bin", &data, PIECE_LEN, ""))
            .unwrap()
            .info_hash;
    let seeder = FakeSeeder::start(info_hash, data.clone(), PIECE_LEN, None).await;
    let tracker = FakeTracker::start(seeder.addr).await;
    let announce = format!("http://{}/announce", tracker.addr);
    let torrent_bytes = build_metainfo_bytes("sample.bin", &data, PIECE_LEN, &announce);

    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&torrent_bytes)),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();
    assert_eq!(job.status, "queued");
    assert_eq!(
        job.info_hash.as_deref(),
        Some(dc_bt::hex20(&info_hash).as_str())
    );
    assert_eq!(job.num_pieces, Some(4));

    let status = env.wait_status(job.id.as_str(), &["seeding"], 30).await;
    assert_eq!(status, "seeding", "full download lands in seeding");

    let out = std::fs::read(env.dest.join("sample.bin")).unwrap();
    assert_eq!(out, data, "output must be byte-identical to the payload");

    let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(row.received_bytes, TOTAL as u64);
    assert!(row.metainfo_blob.is_some());
    // tracker saw our announce with the correct info-hash
    assert!(tracker
        .seen
        .lock()
        .unwrap()
        .contains(&dc_bt::hex20(&info_hash)));
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn magnet_resolves_metadata_from_swarm_then_downloads() {
    let dir = tempdir("magnet");
    let env = TestEnv::new(dir.join("db.sqlite")).await;
    let data = payload(TOTAL);
    // BEP 9 metadata = the bare INFO DICT (verified against the magnet's info-hash).
    let full = build_metainfo_bytes("from-magnet.bin", &data, PIECE_LEN, "");
    let info_dict = {
        let (_, span) = dc_bt::bencode::decode_top_with_span(&full, b"info").unwrap();
        let span = span.unwrap();
        full[span].to_vec()
    };
    let info_hash = dc_bt::metainfo::parse(&full).unwrap().info_hash;
    let seeder = FakeSeeder::start(info_hash, data.clone(), PIECE_LEN, Some(info_dict)).await;
    let tracker = FakeTracker::start(seeder.addr).await;
    let announce = format!("http://{}/announce", tracker.addr);
    let magnet = format!(
        "magnet:?xt=urn:btih:{}&dn=from-magnet.bin&tr={}",
        dc_bt::hex20(&info_hash),
        announce
    );

    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: Some(magnet),
            torrent_file_b64: None,
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();
    assert_eq!(job.source_kind, dc_protocol::TorrentSourceKind::Magnet);
    assert_eq!(job.info_hash, None, "magnets expose the hash post-metadata");

    env.wait_status(job.id.as_str(), &["seeding"], 40).await;
    let out = std::fs::read(env.dest.join("from-magnet.bin")).unwrap();
    assert_eq!(out, data);
    let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
    assert_eq!(
        row.info_hash.as_deref(),
        Some(dc_bt::hex20(&info_hash).as_str())
    );
    assert!(
        row.metainfo_blob.is_some(),
        "fetched metadata persists for resume"
    );
    assert_eq!(row.name.as_deref(), Some("from-magnet.bin"));
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_then_restart_resumes_from_persisted_have_map() {
    let dir = tempdir("resume");
    let db = dir.join("db.sqlite");
    let env = TestEnv::new(db.clone()).await;
    // Two pieces, throttled: the 500 ms ticker lands between them, so the row's
    // received_bytes visibly crosses 1 piece before the payload completes.
    let data = payload(2 * PIECE_LEN);
    let info_hash =
        dc_bt::metainfo::parse(&build_metainfo_bytes("resume.bin", &data, PIECE_LEN, ""))
            .unwrap()
            .info_hash;
    let seeder = FakeSeeder::start_with_delay(info_hash, data.clone(), PIECE_LEN, None, 800).await;
    let tracker = FakeTracker::start(seeder.addr).await;
    let announce = format!("http://{}/announce", tracker.addr);
    let torrent_bytes = build_metainfo_bytes("resume.bin", &data, PIECE_LEN, &announce);

    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&torrent_bytes)),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();

    // let at least one piece land, then pause
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
        if row.received_bytes > 0 || row.status == "seeding" {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "no progress");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let paused = env.manager.pause(job.id.as_str()).await.unwrap();
    assert_eq!(paused.status, "paused");
    let partial = paused.received_bytes;
    assert!(
        partial > 0 && partial < data.len() as u64,
        "paused mid-download at {partial}"
    );
    // The persisted have-map names the verified pieces: those (and only those) must
    // never be re-requested. Pipeline requests that were SENT but never served before
    // the pause are legitimately re-sent after the restart.
    let verified_pieces: HashSet<u32> = {
        let blob = env
            .store
            .get_torrent_job(job.id.as_str())
            .unwrap()
            .unwrap()
            .have_blob
            .unwrap_or_default();
        (0..2u32)
            .filter(|i| blob.get(*i as usize / 8).copied().unwrap_or(0) & (0x80 >> (*i % 8)) != 0)
            .collect()
    };
    assert!(
        !verified_pieces.is_empty(),
        "at least one piece verified pre-pause"
    );
    // NEW manager over the SAME database (a core restart): the persisted have-map is
    // authoritative — pieces already verified are never re-requested.
    drop(env);
    let env2 = TestEnv::new(db.clone()).await;
    let requests_at_restart = seeder.stats.requested.lock().unwrap().len();
    let resumed = env2.manager.resume(job.id.as_str()).await.unwrap();
    assert_eq!(resumed.status, "queued");
    env2.wait_status(job.id.as_str(), &["seeding"], 30).await;

    // Only requests made AFTER the restart count (phase-1 requests are history).
    let re_requested_verified: Vec<(u32, u32)> = {
        let requested_after = seeder.stats.requested.lock().unwrap();
        requested_after
            .iter()
            .skip(requests_at_restart)
            .filter(|(piece, _)| verified_pieces.contains(piece))
            .copied()
            .collect()
    };
    assert!(
        re_requested_verified.is_empty(),
        "verified pieces must never be re-requested after restart ({re_requested_verified:?})"
    );

    let out = std::fs::read(env2.dest.join("resume.bin")).unwrap();
    assert_eq!(out, data);
    let _ = env2.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn completed_torrent_seeds_to_a_leecher() {
    let dir = tempdir("seed");
    let env = TestEnv::new(dir.join("db.sqlite")).await;
    let data = payload(TOTAL);
    let info_hash = dc_bt::metainfo::parse(&build_metainfo_bytes("seed.bin", &data, PIECE_LEN, ""))
        .unwrap()
        .info_hash;
    let seeder = FakeSeeder::start(info_hash, data.clone(), PIECE_LEN, None).await;
    let tracker = FakeTracker::start(seeder.addr).await;
    let announce = format!("http://{}/announce", tracker.addr);
    let torrent_bytes = build_metainfo_bytes("seed.bin", &data, PIECE_LEN, &announce);
    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&torrent_bytes)),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();
    env.wait_status(job.id.as_str(), &["seeding"], 30).await;

    // A leecher connects to OUR listener and pulls the verified payload.
    let got = leecher_pull(
        format!("127.0.0.1:{}", env.manager.listen_port())
            .parse()
            .unwrap(),
        info_hash,
        &data,
        PIECE_LEN,
    )
    .await;
    assert_eq!(got, data, "the engine must serve verified bytes for upload");
    // Counters persist on the 500 ms ticker — poll instead of asserting immediately.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
        if row.uploaded_bytes >= TOTAL as u64 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "uploaded_bytes never reached the payload size (last: {})",
            row.uploaded_bytes
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_tracker_announce_works_and_feeds_the_swarm() {
    let dir = tempdir("udp");
    let env = TestEnv::new(dir.join("db.sqlite")).await;
    let data = payload(TOTAL);
    let info_hash = dc_bt::metainfo::parse(&build_metainfo_bytes("udp.bin", &data, PIECE_LEN, ""))
        .unwrap()
        .info_hash;
    let seeder = FakeSeeder::start(info_hash, data.clone(), PIECE_LEN, None).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let udp = spawn_fake_udp_tracker(seeder.addr, seen.clone()).await;
    let announce = format!("udp://{udp}");
    let torrent_bytes = build_metainfo_bytes("udp.bin", &data, PIECE_LEN, &announce);
    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&torrent_bytes)),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();
    env.wait_status(job.id.as_str(), &["seeding"], 30).await;
    assert!(seen.lock().unwrap().contains(&dc_bt::hex20(&info_hash)));
    let out = std::fs::read(env.dest.join("udp.bin")).unwrap();
    assert_eq!(out, data);
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn add_classification_v2_invalid_and_proxy_fail_closed() {
    let dir = tempdir("classify");
    let env = TestEnv::new(dir.join("db.sqlite")).await;

    // v2-only torrent → classified refusal
    let err = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&build_v2_only_bytes())),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, dc_protocol::ErrorCode::TorrentV2Unsupported);

    // invalid base64 → classified refusal
    let err = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some("!!!!".into()),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, dc_protocol::ErrorCode::TorrentInvalidMetainfo);

    // broken bencode → classified refusal
    let err = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(b"not-bencode")),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, dc_protocol::ErrorCode::TorrentInvalidMetainfo);

    // both sources → invalid params
    let err = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: Some("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".into()),
            torrent_file_b64: Some(b64(b"x")),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, dc_protocol::ErrorCode::InvalidParams);

    // proxy profile missing at run time → fail-closed pause (Phase 9 semantics)
    let data = payload(TOTAL);
    let torrent_bytes =
        build_metainfo_bytes("proxied.bin", &data, PIECE_LEN, "http://127.0.0.1:9/ann");
    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: None,
            torrent_file_b64: Some(b64(&torrent_bytes)),
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: Some(dc_protocol::new_ulid().as_str().to_string()), // never pushed to the runtime map
        })
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
        if row.status == "paused" && row.error_code.as_deref() == Some("proxy_profile_not_found") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "expected fail-closed pause"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn magnet_metadata_timeout_pauses_recoverable() {
    let dir = tempdir("meta-timeout");
    let env = TestEnv::new(dir.join("db.sqlite")).await;
    env.manager.set_metadata_budget_ms(1_500);
    // tracker returns NO peers (empty swarm)
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tracker_addr = listener.local_addr().unwrap();
    drop(listener); // port intentionally closed: announces fail, no peers ever arrive
    let magnet = format!(
        "magnet:?xt=urn:btih:{}&dn=lonely.bin&tr=http://{tracker_addr}/ann",
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
    );
    let job = env
        .manager
        .add(dc_protocol::TorrentAddParams {
            magnet_uri: Some(magnet),
            torrent_file_b64: None,
            destination_dir: env.dest.to_string_lossy().to_string(),
            proxy_profile_id: None,
        })
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let row = env.store.get_torrent_job(job.id.as_str()).unwrap().unwrap();
        if row.status == "paused" && row.error_code.as_deref() == Some("torrent_metadata_timeout") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "expected metadata timeout (last: {} error: {:?})",
            row.status,
            row.error_code
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // recoverable: resume re-enters the metadata phase. The returned row is sampled
    // through a race window — the ack is "queued", but on a loaded runner the engine
    // may already have advanced to "metadata" before we read it. Both mean "running
    // again with the error cleared"; asserting exactly "queued" flaked on CI (F-2,
    // phase 27: run 39291290441).
    let resumed = env.manager.resume(job.id.as_str()).await.unwrap();
    assert!(
        resumed.status == "queued" || resumed.status == "metadata",
        "resume must re-enter the metadata phase (got: {})",
        resumed.status
    );
    assert!(resumed.error_code.is_none());
    let _ = env.manager.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}
