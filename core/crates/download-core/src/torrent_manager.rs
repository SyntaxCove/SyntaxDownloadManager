//! Torrent engine manager (Phase 13) — persistent torrent jobs on top of the dc-bt toolbox.
//!
//! Data-integrity and failure posture (mirrors the engine hierarchy):
//! - the swarm is the job's persistent source: there is no expiring URL to rebind. Resume =
//!   re-announce + re-connect + request only the pieces the persisted have-map still lists
//!   as missing; every piece is SHA-1-verified BEFORE it is written as owned, so a crash,
//!   pause or restart can never corrupt the payload (re-verification is idempotent);
//! - a magnet's page-less source resolves through the swarm: metadata is fetched from peers
//!   (BEP 9/10) and verified against the magnet's info-hash; a swarm that cannot produce
//!   verified metadata within budget pauses the job with `torrent_metadata_timeout`
//!   (recoverable — resume retries);
//! - proxy routing is fail-closed (Phase 9 semantics): a missing profile pauses the job
//!   (`proxy_profile_not_found`), an https-hop profile pauses with
//!   `torrent_proxy_unsupported` (tunneling raw peer TCP through a TLS proxy hop is out of
//!   scope), and while ANY proxy profile is attached DHT and UDP trackers are SUSPENDED —
//!   peer TCP and HTTP(S) trackers ride the proxy, direct leakage is never an option;
//! - a piece that fails its hash after bounded retries fails the job with
//!   `checksum_mismatch` — a corrupting swarm is never silently tolerated;
//! - file paths from metainfo are sanitized at parse time (traversal/absolute/device names
//!   refused) and written only under the user-chosen destination directory;
//! - boot recovery: a fresh core never auto-starts torrent jobs (the Phase 8 baseline
//!   rule) — queued/active rows pause at startup.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dc_protocol::torrent::{
    TorrentAddParams, TorrentFileEntry, TorrentJob, TorrentProgress, TorrentSourceKind,
};
use dc_protocol::{new_ulid, ContractError, ErrorCode, EventEnvelope};
use dc_storage::{JobStore, TorrentJobRow};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::{now_ms, EventsTx};
use crate::proxy::{ProxyMap, RuntimeProxy};

/// Max concurrent active torrent sessions — each owns tracker cycles, peer connections
/// and DHT traffic, so the cap is deliberately tight.
pub const MAX_CONCURRENT_TORRENTS: usize = 3;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Metadata budget for magnets (overridable for tests).
const METADATA_BUDGET_MS: u64 = 90_000;
/// Hard cap on the decoded .torrent file (the wire schema caps base64 at ~8 MiB too).
pub const MAX_TORRENT_FILE_BYTES: usize = 8 * 1024 * 1024;
/// Blocks in flight per peer (pipelining window).
pub const PEER_PIPELINE: usize = 8;
/// Max peer connections per torrent session.
pub const MAX_PEERS_PER_TORRENT: usize = 30;
/// A piece failing its hash this many times fails the job (swarm corruption).
pub const PIECE_MAX_FAILURES: u32 = 3;
/// In-flight requests older than this are considered lost and become re-pickable.
const STALE_REQUEST: Duration = Duration::from_secs(45);
/// Read timeout on peer connections (protocol keep-alives keep real swarms alive).
const PEER_READ_TIMEOUT: Duration = Duration::from_secs(90);
/// Re-announce cap (the tracker's interval is respected but never exceeded).
const MAX_REANNOUNCE: Duration = Duration::from_secs(120);
/// Upload unchoke tick.
const UNCHOKE_TICK: Duration = Duration::from_secs(10);
/// Peers we serve concurrently while seeding/downloading.
const UNCHOKE_SLOTS: usize = 4;

pub type TorrentEvents = EventsTx;

/// Info-hash → channel delivering already-handshaked inbound connections to their session.
type InboundRegistry = Mutex<HashMap<[u8; 20], mpsc::Sender<InboundConn>>>;

/// One inbound connection routed to a session (the handshake byte is already consumed).
struct InboundConn {
    stream: tokio::net::TcpStream,
    from: SocketAddr,
}

#[derive(Debug)]
pub(crate) enum TorrentCommand {
    /// User pause / scheduler stop: keep data, persist have-map.
    Stop,
}

struct TorrentHandle {
    cmd: mpsc::Sender<TorrentCommand>,
    stop: CancellationToken,
}

pub struct TorrentManager {
    store: Arc<JobStore>,
    events: TorrentEvents,
    proxies: Arc<ProxyMap>,
    peer_id: [u8; 20],
    /// Announced peer port (the shared TCP listener; DHT binds the same UDP port number).
    listen_port: AtomicU16,
    /// Inbound connections wait for a handshake, then route here by info-hash.
    inbound: InboundRegistry,
    tasks: Mutex<HashMap<String, TorrentHandle>>,
    metadata_budget_ms: AtomicU64,
    /// Lazily-started DHT node (direct-mode sessions only; proxied sessions never touch it).
    dht: tokio::sync::OnceCell<Option<Arc<dc_bt::dht::DhtNode>>>,
    /// Test hook: DHT bootstrap addresses (empty → public resolvers).
    dht_bootstrap: Mutex<Vec<SocketAddr>>,
}

impl TorrentManager {
    pub fn new(store: Arc<JobStore>, events: TorrentEvents, proxies: Arc<ProxyMap>) -> Arc<Self> {
        // Boot recovery: a fresh core owns no swarm connections.
        match store.reset_active_torrent_jobs() {
            Ok(n) if n > 0 => {
                tracing::info!("torrent boot recovery: paused {n} interrupted job(s)");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("torrent boot recovery failed: {e}"),
        }
        Arc::new(Self {
            store,
            events,
            proxies,
            peer_id: dc_bt::new_peer_id(),
            listen_port: AtomicU16::new(0),
            inbound: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            metadata_budget_ms: AtomicU64::new(METADATA_BUDGET_MS),
            dht: tokio::sync::OnceCell::new(),
            dht_bootstrap: Mutex::new(Vec::new()),
        })
    }

    /// Test hook: shorten the magnet metadata budget (real deployments never call this).
    pub fn set_metadata_budget_ms(&self, ms: u64) {
        self.metadata_budget_ms.store(ms, Ordering::SeqCst);
    }

    /// Test hook: pin DHT bootstrap addresses (empty → the public resolver list).
    pub async fn set_dht_bootstrap(&self, addrs: Vec<SocketAddr>) {
        *self.dht_bootstrap.lock().expect("bootstrap mutex poisoned") = addrs;
    }

    /// Start (once) the DHT node on the announced UDP port. None when binding fails —
    /// tracker-backed torrents keep working without DHT. Bootstrap runs in the background
    /// (DNS for the public resolvers must never block session startup).
    async fn ensure_dht(self: &Arc<Self>) -> Option<Arc<dc_bt::dht::DhtNode>> {
        self.dht
            .get_or_init(|| async {
                let port = self.listen_port();
                let bind = SocketAddr::from(([0, 0, 0, 0], port));
                match dc_bt::dht::DhtNode::start(bind).await {
                    Ok(node) => {
                        let bootstrap = self
                            .dht_bootstrap
                            .lock()
                            .expect("bootstrap mutex poisoned")
                            .clone();
                        let node_for_bootstrap = node.clone();
                        tokio::spawn(async move {
                            if bootstrap.is_empty() {
                                // Resolve the public resolvers best-effort (offline is fine).
                                let mut addrs = Vec::new();
                                for host in [
                                    "router.bittorrent.com:6881",
                                    "dht.transmissionbt.com:6881",
                                    "router.utorrent.com:6881",
                                ] {
                                    if let Ok(c) = tokio::net::lookup_host(host).await {
                                        addrs.extend(c.take(8).collect::<Vec<_>>());
                                    }
                                }
                                node_for_bootstrap.bootstrap(addrs).await;
                            } else {
                                node_for_bootstrap.bootstrap(bootstrap).await;
                            }
                        });
                        Some(node)
                    }
                    Err(e) => {
                        tracing::warn!("DHT disabled (bind failed): {e}");
                        None
                    }
                }
            })
            .await
            .clone()
    }

    fn dht_handle(&self) -> Option<Arc<dc_bt::dht::DhtNode>> {
        self.dht.get().and_then(|o| o.clone())
    }

    /// Bind the peer listener (TCP) and start the inbound acceptor. Returns the announced
    /// port; idempotent (the second call returns the first port).
    pub async fn bind(self: &Arc<Self>) -> Result<u16, ContractError> {
        let existing = self.listen_port.load(Ordering::SeqCst);
        if existing != 0 {
            return Ok(existing);
        }
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| {
                ContractError::new(ErrorCode::NetworkError, format!("torrent listen: {e}"))
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                ContractError::new(ErrorCode::NetworkError, format!("torrent local_addr: {e}"))
            })?
            .port();
        let manager = self.clone();
        tokio::spawn(async move {
            manager.accept_loop(listener).await;
        });
        self.listen_port.store(port, Ordering::SeqCst);
        self.ensure_dht().await;
        Ok(port)
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.load(Ordering::SeqCst)
    }

    // ---- queries ----

    pub fn list(&self) -> Result<Vec<TorrentJob>, ContractError> {
        Ok(self
            .store
            .list_torrent_jobs()?
            .iter()
            .map(|row| self.row_to_wire(row))
            .collect())
    }

    pub fn get(&self, id: &str) -> Result<Option<TorrentJob>, ContractError> {
        Ok(self
            .store
            .get_torrent_job(id)?
            .map(|row| self.row_to_wire(&row)))
    }

    /// Overlay live runtime values (speeds, peers, eta) for active sessions.
    fn row_to_wire(&self, row: &TorrentJobRow) -> TorrentJob {
        // Live stats live in the session task; the wire row carries persisted truth. Active
        // sessions push throttled progress events, so this projection is the authoritative
        // snapshot for non-running fields (the renderer patches speeds from events).
        row.to_wire()
    }

    // ---- create ----

    pub async fn add(
        self: &Arc<Self>,
        params: TorrentAddParams,
    ) -> Result<TorrentJob, ContractError> {
        let has_magnet = params.magnet_uri.is_some();
        let has_file = params.torrent_file_b64.is_some();
        if has_magnet == has_file {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "exactly one of magnetUri or torrentFileB64 is required",
            ));
        }
        let ts = now_ms();
        let (source_kind, source_uri, name, info_hash_hex, trackers, metainfo_blob, totals) =
            if let Some(magnet_uri) = &params.magnet_uri {
                let magnet = dc_bt::magnet::parse(magnet_uri).map_err(ContractError::from)?;
                (
                    TorrentSourceKind::Magnet,
                    magnet_uri.trim().to_string(),
                    magnet.display_name.clone(),
                    None, // magnets identify by xt but the wire exposes it post-metadata
                    magnet.trackers.clone(),
                    None,
                    (magnet.length, None::<u64>, None::<u64>),
                )
            } else {
                let b64 = params.torrent_file_b64.as_deref().unwrap_or_default();
                let bytes = dc_bt::base64_decode(b64).ok_or_else(|| {
                    ContractError::new(
                        ErrorCode::TorrentInvalidMetainfo,
                        "torrent file is not valid base64",
                    )
                })?;
                if bytes.len() > MAX_TORRENT_FILE_BYTES {
                    return Err(ContractError::new(
                        ErrorCode::TorrentInvalidMetainfo,
                        "torrent file exceeds the 8 MiB cap",
                    ));
                }
                let meta = dc_bt::metainfo::parse(&bytes).map_err(ContractError::from)?;
                let hex = meta.info_hash_hex();
                (
                    TorrentSourceKind::Torrent,
                    String::new(),
                    Some(meta.name.clone()),
                    Some(hex),
                    meta.announce_list.clone(),
                    Some(bytes),
                    (
                        Some(meta.total_size),
                        Some(meta.num_pieces as u64),
                        Some(meta.piece_length as u64),
                    ),
                )
            };
        // files for .torrent jobs are already known; magnets resolve at metadata time
        let files: Vec<TorrentFileEntry> = match &metainfo_blob {
            Some(blob) => dc_bt::metainfo::parse(blob)
                .map_err(ContractError::from)?
                .files
                .iter()
                .map(|f| TorrentFileEntry {
                    path: f.path.clone(),
                    size: f.size,
                    offset: f.offset,
                })
                .collect(),
            None => Vec::new(),
        };
        let (total_bytes, num_pieces, piece_length) = totals;

        let row = TorrentJobRow {
            id: new_ulid(),
            source_kind,
            source_uri,
            name,
            info_hash: info_hash_hex,
            destination_dir: params.destination_dir.trim().to_string(),
            status: "queued".into(),
            total_bytes,
            received_bytes: 0,
            uploaded_bytes: 0,
            num_pieces,
            piece_length,
            have_blob: None,
            metainfo_blob,
            files,
            trackers,
            error_code: None,
            proxy_profile_id: params.proxy_profile_id.clone(),
            created_at: ts,
            updated_at: ts,
        };
        if row.destination_dir.is_empty() {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "destinationDir is required",
            ));
        }
        self.store.insert_torrent_job(&row)?;
        self.emit_updated(
            &self
                .store
                .get_torrent_job(row.id.as_str())?
                .expect("row just written"),
        );
        self.pump();
        Ok(self
            .store
            .get_torrent_job(row.id.as_str())?
            .map(|r| self.row_to_wire(&r))
            .expect("row just written"))
    }

    // ---- lifecycle ----

    pub async fn pause(&self, id: &str) -> Result<TorrentJob, ContractError> {
        let row = self.store.get_torrent_job(id)?.ok_or_else(not_found)?;
        // A fully-downloaded torrent parks as `completed`; an unfinished one as `paused`.
        let final_status = if row.status == "seeding" {
            "completed"
        } else {
            "paused"
        };
        self.send_stop(id, final_status).await?;
        self.fresh(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<TorrentJob, ContractError> {
        self.send_stop(id, "canceled").await?;
        self.fresh(id)
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<TorrentJob, ContractError> {
        let mut row = self.store.get_torrent_job(id)?.ok_or_else(not_found)?;
        if !matches!(
            row.status.as_str(),
            "paused" | "canceled" | "failed" | "completed"
        ) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("torrent in status '{}' cannot be resumed", row.status),
            ));
        }
        row.status = "queued".into();
        row.error_code = None;
        row.updated_at = now_ms();
        self.store.update_torrent_job(&row)?;
        self.emit_updated(&row);
        self.pump();
        self.fresh(id)
    }

    pub async fn remove(
        self: &Arc<Self>,
        id: &str,
        delete_files: bool,
    ) -> Result<(), ContractError> {
        let row = self.store.get_torrent_job(id)?.ok_or_else(not_found)?;
        // Stop a running session first (bounded wait like the media pipeline).
        let (cmd, stop) = {
            let tasks = self.tasks.lock().expect("tasks mutex poisoned");
            match tasks.get(id) {
                Some(h) => (Some(h.cmd.clone()), Some(h.stop.clone())),
                None => (None, None),
            }
        };
        if let Some(stop) = &stop {
            stop.cancel();
        }
        if let Some(cmd) = &cmd {
            let _ = cmd.send(TorrentCommand::Stop).await;
        }
        if stop.is_some() {
            self.wait_runner_ack(id).await;
        }
        self.tasks.lock().expect("tasks mutex poisoned").remove(id);
        self.inbound
            .lock()
            .expect("inbound mutex poisoned")
            .remove(&self.row_info_hash_bytes(&row).unwrap_or([0u8; 20]));
        self.store.delete_torrent_job(id)?;
        if delete_files {
            self.delete_payload(&row);
        }
        Ok(())
    }

    /// Graceful shutdown: stop every session (each persists its have-map first).
    pub async fn shutdown(&self) {
        eprintln!("DBG shutdown() called");
        let handles: Vec<(mpsc::Sender<TorrentCommand>, CancellationToken)> = self
            .tasks
            .lock()
            .expect("tasks mutex poisoned")
            .values()
            .map(|h| (h.cmd.clone(), h.stop.clone()))
            .collect();
        for (cmd, stop) in handles {
            let _ = cmd.send(TorrentCommand::Stop).await;
            stop.cancel();
        }
    }

    // ---- pump ----

    /// Start queued torrent jobs (FIFO by creation) while free slots exist.
    pub fn pump(self: &Arc<Self>) {
        {
            let mut tasks = self.tasks.lock().expect("tasks mutex poisoned");
            tasks.retain(|_, h| !h.stop.is_cancelled());
            if tasks.len() >= MAX_CONCURRENT_TORRENTS {
                return;
            }
        }
        let Ok(all) = self.store.list_torrent_jobs() else {
            return;
        };
        let mut queued: Vec<TorrentJobRow> =
            all.into_iter().filter(|j| j.status == "queued").collect();
        queued.sort_by(|a, b| (a.created_at, a.id.as_str()).cmp(&(b.created_at, b.id.as_str())));
        for row in queued {
            let handle = {
                let mut tasks = self.tasks.lock().expect("tasks mutex poisoned");
                if tasks.len() >= MAX_CONCURRENT_TORRENTS {
                    break;
                }
                if tasks.contains_key(row.id.as_str()) {
                    continue;
                }
                let stop = CancellationToken::new();
                let (cmd_tx, cmd_rx) = mpsc::channel::<TorrentCommand>(8);
                tasks.insert(
                    row.id.as_str().to_string(),
                    TorrentHandle {
                        cmd: cmd_tx,
                        stop: stop.clone(),
                    },
                );
                (stop, cmd_rx)
            };
            let manager = self.clone();
            let job_id = row.id.as_str().to_string();
            tokio::spawn(async move {
                manager.run_session(job_id, handle.0, handle.1).await;
            });
        }
    }

    // ---- helpers ----

    fn fresh(&self, id: &str) -> Result<TorrentJob, ContractError> {
        self.store
            .get_torrent_job(id)?
            .map(|r| self.row_to_wire(&r))
            .ok_or_else(not_found)
    }

    async fn send_stop(&self, id: &str, final_status: &str) -> Result<(), ContractError> {
        eprintln!("DBG send_stop {id} -> {final_status}");
        let row = self.store.get_torrent_job(id)?.ok_or_else(not_found)?;
        if !matches!(
            row.status.as_str(),
            "queued" | "metadata" | "downloading" | "seeding"
        ) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("torrent in status '{}' cannot be stopped", row.status),
            ));
        }
        let (cmd, stop) = {
            let tasks = self.tasks.lock().expect("tasks mutex poisoned");
            match tasks.get(id) {
                Some(h) => (Some(h.cmd.clone()), Some(h.stop.clone())),
                None => (None, None),
            }
        };
        if let Some(stop) = &stop {
            stop.cancel();
        }
        if let Some(cmd) = &cmd {
            let _ = cmd.send(TorrentCommand::Stop).await;
        }
        if stop.is_some() {
            self.wait_runner_ack(id).await;
        }
        let mut row = row;
        row.status = final_status.to_string();
        row.updated_at = now_ms();
        self.store.update_torrent_job(&row)?;
        self.emit_updated(&row);
        Ok(())
    }

    /// Bounded poll until the session task releases the row (mirrors the media pipeline's
    /// runner ack: the durable row is the truth once this returns).
    async fn wait_runner_ack(&self, id: &str) {
        for _ in 0..100 {
            match self.tasks.lock().expect("tasks mutex poisoned").get(id) {
                Some(h) if !h.stop.is_cancelled() => {}
                _ => return,
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn row_info_hash_bytes(&self, row: &TorrentJobRow) -> Option<[u8; 20]> {
        let hex = row.info_hash.as_deref()?;
        dc_bt::unhex20(hex)
    }

    fn delete_payload(&self, row: &TorrentJobRow) {
        let Some(blob) = &row.metainfo_blob else {
            return;
        };
        let Ok(meta) = dc_bt::metainfo::parse(blob) else {
            return;
        };
        // Only paths this torrent owns: <destination_dir>/<name>[/<file.path>]
        let base = std::path::Path::new(&row.destination_dir).join(&meta.name);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&base); // single-file layout
    }

    fn emit_updated(&self, row: &TorrentJobRow) {
        let _ = self.events.send(EventEnvelope {
            v: dc_protocol::PROTOCOL_VERSION,
            event: "torrent.updated".into(),
            payload: Some(
                serde_json::to_value(TorrentUpdated { job: row.to_wire() })
                    .expect("torrent job serializes"),
            ),
        });
    }

    /// Fail-closed proxy resolution (Phase 9 semantics) → tunnel decision.
    fn resolve_tunnel(
        &self,
        profile_id: Option<&str>,
    ) -> Result<dc_bt::socks::ProxyTunnel, ContractError> {
        let Some(id) = profile_id else {
            return Ok(dc_bt::socks::ProxyTunnel::Direct);
        };
        let proxy: RuntimeProxy = self
            .proxies
            .get(id)
            .ok_or_else(|| {
                ContractError::new(
                    ErrorCode::ProxyProfileNotFound,
                    format!("proxy profile {id} is not in the runtime map"),
                )
            })?
            .clone();
        match proxy.scheme.as_str() {
            "socks5" => Ok(dc_bt::socks::ProxyTunnel::Socks5 {
                host: proxy.host.clone(),
                port: proxy.port,
                username: proxy.username.clone(),
                password: proxy.password.clone(),
            }),
            "http" => Ok(dc_bt::socks::ProxyTunnel::Http {
                host: proxy.host.clone(),
                port: proxy.port,
                username: proxy.username.clone(),
                password: proxy.password.clone(),
            }),
            other => Err(ContractError::new(
                ErrorCode::TorrentProxyUnsupported,
                format!(
                    "torrent jobs cannot route through a '{other}' proxy hop (use socks5 or http)"
                ),
            )),
        }
    }
}

#[derive(serde::Serialize)]
pub struct TorrentUpdated {
    pub job: TorrentJob,
}

fn not_found() -> ContractError {
    ContractError::new(ErrorCode::InvalidState, "torrent not found")
}
// ---------------------------------------------------------------------------
// session runtime (shared between the session task and its peer tasks)
// ---------------------------------------------------------------------------

/// Live per-peer state for one connected peer.
struct PeerLive {
    mask: Option<dc_bt::picker::Bitmap>,
    peer_choking_us: bool,
    peer_interested: bool,
    unchoked_by_us: bool,
    is_seed: bool,
    /// Queue into the peer's connection task (it owns the socket half).
    outbound: mpsc::UnboundedSender<dc_bt::peer::Message>,
    /// Blocks this peer was asked for (dedup within the peer; endgame dedup across peers).
    in_flight: HashSet<dc_bt::picker::BlockReq>,
}

/// State shared between a session task and its peer connection tasks.
struct SessionShared {
    manager: Arc<TorrentManager>,
    job_id: String,
    info_hash: [u8; 20],
    peer_id: [u8; 20],
    meta: Arc<dc_bt::metainfo::Metainfo>,
    picker: Mutex<dc_bt::picker::PiecePicker>,
    writer: Mutex<FileWriter>,
    peers: Mutex<HashMap<SocketAddr, PeerLive>>,
    tunnel: dc_bt::socks::ProxyTunnel,
    stop: CancellationToken,
    piece_failures: Mutex<HashMap<u32, u32>>,
    request_times: Mutex<HashMap<dc_bt::picker::BlockReq, std::time::Instant>>,
    verified_bytes: AtomicU64,
    uploaded_bytes: AtomicU64,
    finalized: std::sync::atomic::AtomicBool,
}

impl SessionShared {
    fn broadcast(&self, make: impl Fn() -> dc_bt::peer::Message) {
        let peers = self.peers.lock().expect("peers mutex poisoned");
        for p in peers.values() {
            let _ = p.outbound.send(make());
        }
    }

    fn counts(&self) -> (u64, u64) {
        let peers = self.peers.lock().expect("peers mutex poisoned");
        let seeds = peers.values().filter(|p| p.is_seed).count() as u64;
        (peers.len() as u64, seeds)
    }

    /// Store a received block; when its piece assembles, verify + persist + broadcast.
    /// Returns Ok(true) when the torrent reached full completion.
    async fn on_block(
        self: &Arc<Self>,
        piece: u32,
        begin: u32,
        block: Vec<u8>,
    ) -> Result<bool, ContractError> {
        let complete = {
            let mut writer = self.writer.lock().expect("writer mutex poisoned");
            // The writer buffers blocks; it is authoritative for "piece assembled".
            let complete = writer.store_block(piece, begin, block.clone());
            let mut picker = self.picker.lock().expect("picker mutex poisoned");
            picker.on_block(piece, begin);
            let mut times = self.request_times.lock().expect("req times poisoned");
            times.remove(&dc_bt::picker::BlockReq {
                piece,
                offset: begin,
                len: block.len() as u32,
            });
            complete
        };
        if !complete {
            return Ok(false);
        }
        // Assemble the piece and verify its SHA-1 BEFORE it counts as owned.
        let data = {
            let mut writer = self.writer.lock().expect("writer mutex poisoned");
            writer.take_piece(piece)
        };
        let expected = self.meta.piece_hash(piece as usize);
        let actual: [u8; 20] = dc_bt_sha1(&data);
        if actual != expected {
            let failures = {
                let mut f = self.piece_failures.lock().expect("failures mutex poisoned");
                let e = f.entry(piece).or_insert(0);
                *e += 1;
                *e
            };
            self.picker
                .lock()
                .expect("picker mutex poisoned")
                .on_piece_failed(piece);
            if failures >= PIECE_MAX_FAILURES {
                return Err(ContractError::new(
                    ErrorCode::ChecksumMismatch,
                    format!(
                        "piece {piece} failed its SHA-1 {failures} times — the swarm is corrupting data"
                    ),
                ));
            }
            tracing::warn!(job = %self.job_id, piece, failures, "piece hash mismatch — re-downloading");
            return Ok(false);
        }
        // Persist to disk, then claim the piece.
        {
            let mut writer = self.writer.lock().expect("writer mutex poisoned");
            writer.write_piece(piece, &data).map_err(|e| {
                ContractError::new(ErrorCode::IoError, format!("write piece {piece}: {e}"))
            })?;
        }
        self.verified_bytes
            .fetch_add(data.len() as u64, Ordering::SeqCst);
        self.picker
            .lock()
            .expect("picker mutex poisoned")
            .on_piece_done(piece);
        self.broadcast(|| dc_bt::peer::Message::Have(piece));
        let done = self
            .picker
            .lock()
            .expect("picker mutex poisoned")
            .is_complete();
        Ok(done)
    }

    /// Serve one upload request from a remote peer (only from verified pieces).
    async fn serve_request(
        self: &Arc<Self>,
        addr: SocketAddr,
        index: u32,
        begin: u32,
        len: u32,
    ) -> Result<(), ContractError> {
        let may_serve = {
            let peers = self.peers.lock().expect("peers mutex poisoned");
            let Some(p) = peers.get(&addr) else {
                return Ok(());
            };
            p.unchoked_by_us
        };
        if !may_serve {
            return Ok(()); // choked peers get nothing (no error signal needed)
        }
        if !self
            .picker
            .lock()
            .expect("picker mutex poisoned")
            .have()
            .get(index as usize)
        {
            return Ok(()); // we do not (yet) own the piece — ignore
        }
        let len = len.min(dc_bt::picker::BLOCK_LEN.max(self.meta.piece_length));
        let data = {
            let mut writer = self.writer.lock().expect("writer mutex poisoned");
            writer
                .read_range(
                    index as u64 * self.meta.piece_length as u64 + begin as u64,
                    len as usize,
                )
                .map_err(|e| {
                    ContractError::new(ErrorCode::IoError, format!("read for upload: {e}"))
                })?
        };
        self.uploaded_bytes
            .fetch_add(data.len() as u64, Ordering::SeqCst);
        if let Some(peer) = self.peers.lock().expect("peers mutex poisoned").get(&addr) {
            let _ = peer
                .outbound
                .send(dc_bt::peer::Message::Piece(index, begin, data));
        }
        Ok(())
    }

    /// Keep the peer's request pipeline full from the shared picker.
    fn pump_requests(self: &Arc<Self>, addr: SocketAddr) {
        let reqs = {
            let mut peers = self.peers.lock().expect("peers mutex poisoned");
            let Some(peer) = peers.get_mut(&addr) else {
                return;
            };
            if peer.peer_choking_us || peer.mask.is_none() {
                return;
            }
            let mask = peer.mask.clone().expect("mask checked");
            let mut picker = self.picker.lock().expect("picker mutex poisoned");
            let want = PEER_PIPELINE.saturating_sub(peer.in_flight.len());
            if want == 0 {
                return;
            }
            let reqs = picker.pick(&mask, want, &peer.in_flight);
            for r in &reqs {
                picker.mark_requested(r);
                peer.in_flight.insert(*r);
            }
            reqs
        };
        let mut times = self.request_times.lock().expect("req times poisoned");
        let now = std::time::Instant::now();
        if let Some(peer) = self.peers.lock().expect("peers mutex poisoned").get(&addr) {
            for r in &reqs {
                times.insert(*r, now);
                let _ = peer
                    .outbound
                    .send(dc_bt::peer::Message::Request(r.piece, r.offset, r.len));
            }
        }
    }

    /// Release every request a (dis)connecting peer owned so others can re-pick.
    fn release_peer_requests(self: &Arc<Self>, addr: SocketAddr) {
        let in_flight: Vec<dc_bt::picker::BlockReq> = {
            let mut peers = self.peers.lock().expect("peers mutex poisoned");
            match peers.get_mut(&addr) {
                Some(p) => p.in_flight.drain().collect(),
                None => return,
            }
        };
        let mut picker = self.picker.lock().expect("picker mutex poisoned");
        let mut times = self.request_times.lock().expect("req times poisoned");
        for r in &in_flight {
            picker.mark_canceled(r);
            times.remove(r);
        }
    }

    /// Cancel stale in-flight requests (peers that never answered).
    fn sweep_stale_requests(self: &Arc<Self>) {
        let stale: Vec<dc_bt::picker::BlockReq> = {
            let times = self.request_times.lock().expect("req times poisoned");
            times
                .iter()
                .filter(|(_, t)| t.elapsed() > STALE_REQUEST)
                .map(|(r, _)| *r)
                .collect()
        };
        if stale.is_empty() {
            return;
        }
        {
            let mut picker = self.picker.lock().expect("picker mutex poisoned");
            let mut times = self.request_times.lock().expect("req times poisoned");
            let mut peers = self.peers.lock().expect("peers mutex poisoned");
            for r in &stale {
                picker.mark_canceled(r);
                times.remove(r);
                for p in peers.values_mut() {
                    p.in_flight.remove(r);
                }
            }
        }
        tracing::debug!(job = %self.job_id, count = stale.len(), "swept stale block requests");
    }

    /// Round-robin unchoke policy: serve a bounded set of interested peers.
    fn apply_unchoke_policy(self: &Arc<Self>) {
        let interested: Vec<SocketAddr> = {
            let peers = self.peers.lock().expect("peers mutex poisoned");
            peers
                .iter()
                .filter(|(_, p)| p.peer_interested)
                .map(|(a, _)| *a)
                .collect()
        };
        if interested.is_empty() {
            return;
        }
        let mut chosen: HashSet<SocketAddr> =
            interested.iter().take(UNCHOKE_SLOTS).copied().collect();
        chosen.insert(interested[0]); // optimistic slot is folded into the head slots
        let mut peers = self.peers.lock().expect("peers mutex poisoned");
        for (addr, peer) in peers.iter_mut() {
            let should_unchoke = chosen.contains(addr);
            if should_unchoke && !peer.unchoked_by_us {
                let _ = peer.outbound.send(dc_bt::peer::Message::Unchoke);
            } else if !should_unchoke && peer.unchoked_by_us {
                let _ = peer.outbound.send(dc_bt::peer::Message::Choke);
            }
            peer.unchoked_by_us = should_unchoke;
        }
    }

    fn drop_peer(self: &Arc<Self>, addr: SocketAddr) {
        self.release_peer_requests(addr);
        self.peers
            .lock()
            .expect("peers mutex poisoned")
            .remove(&addr);
    }
}

fn dc_bt_sha1(data: &[u8]) -> [u8; 20] {
    use sha1::{Digest, Sha1};
    Sha1::digest(data).into()
}

// ---------------------------------------------------------------------------
// file writer — block buffering, piece assembly, verified disk writes, uploads
// ---------------------------------------------------------------------------

struct FileWriter {
    /// Destination root: `<destinationDir>` (single-file) + `<name>/` for multi-file.
    root: std::path::PathBuf,
    meta: Arc<dc_bt::metainfo::Metainfo>,
    /// Cached open handles keyed by the file's absolute path (single task owns them).
    open: HashMap<std::path::PathBuf, std::fs::File>,
    /// Partial pieces: piece index → (begin → block bytes).
    pending: HashMap<u32, HashMap<u32, Vec<u8>>>,
}

impl FileWriter {
    fn new(destination_dir: &str, meta: Arc<dc_bt::metainfo::Metainfo>) -> Self {
        let root = if meta.files.len() == 1 {
            std::path::PathBuf::from(destination_dir)
        } else {
            std::path::PathBuf::from(destination_dir).join(&meta.name)
        };
        Self {
            root,
            meta,
            open: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    fn blocks_per_piece(&self, piece: u32) -> usize {
        self.meta
            .piece_len(piece as usize)
            .div_ceil(dc_bt::picker::BLOCK_LEN) as usize
    }

    fn store_block(&mut self, piece: u32, begin: u32, data: Vec<u8>) -> bool {
        let entry = self.pending.entry(piece).or_default();
        entry.insert(begin, data);
        entry.len() == self.blocks_per_piece(piece)
    }

    /// Assemble a completed piece (offset-ordered) and drop its buffer.
    fn take_piece(&mut self, piece: u32) -> Vec<u8> {
        let mut blocks = self.pending.remove(&piece).unwrap_or_default();
        let mut data = Vec::with_capacity(self.meta.piece_len(piece as usize) as usize);
        for b in 0..self.blocks_per_piece(piece) {
            let block = blocks
                .remove(&(b as u32 * dc_bt::picker::BLOCK_LEN))
                .unwrap_or_default();
            data.extend_from_slice(&block);
        }
        data
    }

    /// Final path of one metainfo file (already sanitized at parse time).
    fn file_path(&self, rel: &str) -> std::path::PathBuf {
        self.root.join(rel)
    }

    fn cached_file(&mut self, rel: &str) -> std::io::Result<&mut std::fs::File> {
        let path = self.file_path(rel);
        if !self.open.contains_key(&path) {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let f = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .read(true)
                .open(&path)?;
            self.open.insert(path.clone(), f);
        }
        Ok(self.open.get_mut(&path).expect("just inserted"))
    }

    /// Spread one verified piece across the files it overlaps.
    fn write_piece(&mut self, piece: u32, data: &[u8]) -> std::io::Result<()> {
        let meta = self.meta.clone();
        let piece_offset = piece as u64 * meta.piece_length as u64;
        let mut written = 0u64;
        for file in &meta.files {
            let file_start = file.offset;
            let file_end = file.offset + file.size;
            let piece_start = piece_offset + written;
            let piece_end = piece_offset + data.len() as u64;
            if piece_end <= file_start || piece_start >= file_end {
                continue;
            }
            let in_file_from = piece_start.max(file_start) - file_start;
            let slice_from = (piece_start.max(file_start) - piece_start) as usize;
            let slice_to = (piece_end.min(file_end) - piece_start) as usize;
            let f = self.cached_file(&file.path)?;
            use std::io::{Seek, SeekFrom, Write};
            f.seek(SeekFrom::Start(in_file_from))?;
            f.write_all(&data[slice_from..slice_to])?;
            written = piece_end - piece_offset;
            if written >= data.len() as u64 {
                break;
            }
        }
        Ok(())
    }

    /// Read a byte range from the (verified) payload for upload.
    fn read_range(&mut self, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
        let meta = self.meta.clone();
        let mut out = vec![0u8; len];
        let mut filled = 0usize;
        for file in &meta.files {
            let file_start = file.offset;
            let file_end = file.offset + file.size;
            let want_from = offset + filled as u64;
            if want_from >= file_end || want_from < file_start || filled >= len {
                continue;
            }
            let in_file_from = want_from - file_start;
            let in_file_to = ((offset + len as u64).min(file_end)) - file_start;
            if in_file_to <= in_file_from {
                continue;
            }
            let f = self.cached_file(&file.path)?;
            use std::io::{Read, Seek, SeekFrom};
            f.seek(SeekFrom::Start(in_file_from))?;
            let n = f.read(&mut out[filled..filled + (in_file_to - in_file_from) as usize])?;
            filled += n;
            if filled >= len {
                break;
            }
        }
        out.truncate(filled);
        Ok(out)
    }

    fn close_all(&mut self) {
        self.open.clear();
    }
}

// ---------------------------------------------------------------------------
// peer connection driver
// ---------------------------------------------------------------------------

/// Drive one established peer connection until stop / error / EOF. For inbound
/// connections (`we_initiated = false`) the acceptor has already consumed and validated
/// the handshake — drive_conn only answers with ours.
async fn drive_conn(
    shared: Arc<SessionShared>,
    addr: SocketAddr,
    stream: tokio::net::TcpStream,
    we_initiated: bool,
) {
    let mut conn = dc_bt::peer::PeerConn::new(stream);
    if we_initiated {
        // Outbound: we send first, then validate the reply.
        let hs = dc_bt::peer::encode_handshake(&shared.info_hash, &shared.peer_id);
        if let Err(e) = conn.get_mut().write_all(&hs).await {
            tracing::debug!(%addr, "handshake write failed: {e}");
            return;
        }
        match dc_bt::peer::read_handshake(conn.get_mut()).await {
            Ok(hs) => {
                if hs.info_hash != shared.info_hash {
                    return; // not our swarm
                }
                if hs.peer_id == shared.peer_id {
                    return; // self-connection
                }
            }
            Err(e) => {
                tracing::debug!(%addr, "handshake read failed: {e}");
                return;
            }
        }
    } else {
        // Inbound: answer the (already validated) initiator's handshake.
        let hs = dc_bt::peer::encode_handshake(&shared.info_hash, &shared.peer_id);
        if let Err(e) = conn.get_mut().write_all(&hs).await {
            tracing::debug!(%addr, "responder handshake write failed: {e}");
            return;
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<dc_bt::peer::Message>();
    {
        let mut peers = shared.peers.lock().expect("peers mutex poisoned");
        if peers.len() >= MAX_PEERS_PER_TORRENT {
            return;
        }
        peers.insert(
            addr,
            PeerLive {
                mask: None,
                peer_choking_us: true,
                peer_interested: false,
                unchoked_by_us: false,
                is_seed: false,
                outbound: tx,
                in_flight: HashSet::new(),
            },
        );
    }

    // Announce what we already own + express interest.
    {
        let have_bytes = shared
            .picker
            .lock()
            .expect("picker mutex poisoned")
            .have_bytes();
        let nonempty = have_bytes.iter().any(|&b| b != 0);
        if nonempty {
            let _ = conn.send(&dc_bt::peer::Message::Bitfield(have_bytes)).await;
        }
        let _ = conn.send(&dc_bt::peer::Message::Interested).await;
    }

    loop {
        tokio::select! {
            _ = shared.stop.cancelled() => break,
            out = rx.recv() => {
                match out {
                    Some(msg) => {
                        if conn.send(&msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = dc_bt::peer::recv_timeout(&mut conn, PEER_READ_TIMEOUT) => {
                match incoming {
                    Err(_) | Ok(None) => break,
                    Ok(Some(msg)) => {
                        let keep_going = handle_peer_message(&shared, addr, msg).await;
                        if !keep_going {
                            break;
                        }
                        shared.pump_requests(addr);
                    }
                }
            }
        }
    }
    shared.drop_peer(addr);
}

/// Handle one inbound peer message; returns false when the connection must close.
async fn handle_peer_message(
    shared: &Arc<SessionShared>,
    addr: SocketAddr,
    msg: dc_bt::peer::Message,
) -> bool {
    match msg {
        dc_bt::peer::Message::KeepAlive => true,
        dc_bt::peer::Message::Choke => {
            if let Some(p) = shared.peers.lock().expect("peers poisoned").get_mut(&addr) {
                p.peer_choking_us = true;
            }
            true
        }
        dc_bt::peer::Message::Unchoke => {
            if let Some(p) = shared.peers.lock().expect("peers poisoned").get_mut(&addr) {
                p.peer_choking_us = false;
            }
            true
        }
        dc_bt::peer::Message::Interested | dc_bt::peer::Message::NotInterested => {
            let interested = matches!(msg, dc_bt::peer::Message::Interested);
            // Decide under ONE lock pass (re-locking the same std Mutex deadlocks).
            let eager_unchoke = {
                let mut peers = shared.peers.lock().expect("peers poisoned");
                let Some(p) = peers.get_mut(&addr) else {
                    return true;
                };
                p.peer_interested = interested;
                interested
                    && !p.unchoked_by_us
                    && peers.values().filter(|p| p.unchoked_by_us).count() < UNCHOKE_SLOTS
            };
            if eager_unchoke {
                let mut peers = shared.peers.lock().expect("peers poisoned");
                if let Some(p) = peers.get_mut(&addr) {
                    let _ = p.outbound.send(dc_bt::peer::Message::Unchoke);
                    p.unchoked_by_us = true;
                }
            }
            true
        }
        dc_bt::peer::Message::Have(idx) => {
            shared
                .picker
                .lock()
                .expect("picker mutex poisoned")
                .peer_have(idx);
            if let Some(p) = shared.peers.lock().expect("peers poisoned").get_mut(&addr) {
                if let Some(mask) = &mut p.mask {
                    if (idx as usize) < mask.len() {
                        mask.set(idx as usize);
                        if mask.is_full() {
                            p.is_seed = true;
                        }
                    }
                }
            }
            true
        }
        dc_bt::peer::Message::Bitfield(bytes) => {
            let mask = shared
                .picker
                .lock()
                .expect("picker mutex poisoned")
                .peer_bitfield(&bytes);
            if mask.is_none() {
                return false; // malformed bitfield — drop the peer
            }
            let mask = mask.expect("checked");
            let is_seed = mask.is_full();
            if let Some(p) = shared.peers.lock().expect("peers poisoned").get_mut(&addr) {
                p.mask = Some(mask.clone());
                p.is_seed = is_seed;
            }
            drop(mask);
            true
        }
        dc_bt::peer::Message::Request(index, begin, len) => {
            shared.serve_request(addr, index, begin, len).await.is_ok()
        }
        dc_bt::peer::Message::Piece(index, begin, block) => {
            // Release the block from THIS peer's in-flight set (the shared picker's entry
            // is cleared inside on_block / on_piece_done).
            {
                let len = block.len() as u32;
                let mut peers = shared.peers.lock().expect("peers mutex poisoned");
                if let Some(p) = peers.get_mut(&addr) {
                    p.in_flight.remove(&dc_bt::picker::BlockReq {
                        piece: index,
                        offset: begin,
                        len,
                    });
                }
            }
            match shared.on_block(index, begin, block).await {
                Ok(true) => true, // completion transition happens in the announce loop
                Ok(false) => true,
                Err(e) => {
                    // Bounded corruption or disk failure: fail the job (classified).
                    fail_session(&shared.manager, &shared.job_id, e);
                    false
                }
            }
        }
        dc_bt::peer::Message::Cancel(..) => true,
        dc_bt::peer::Message::Extended(..) => true, // metadata phase uses its own driver
    }
}

// ---------------------------------------------------------------------------
// metadata fetch (BEP 9/10) for magnets
// ---------------------------------------------------------------------------

/// Fetch + verify the info dict from one peer. The bytes are verified against the magnet's
/// info-hash BEFORE they are trusted (a lying peer can never name our files).
async fn fetch_metadata(
    tunnel: &dc_bt::socks::ProxyTunnel,
    info_hash: [u8; 20],
    peer_id: [u8; 20],
    addr: SocketAddr,
) -> Result<Vec<u8>, dc_bt::BtError> {
    let stream = dc_bt::socks::connect(&addr.ip().to_string(), addr.port(), tunnel).await?;
    let mut conn = dc_bt::peer::PeerConn::new(stream);
    conn.get_mut()
        .write_all(&dc_bt::peer::encode_handshake(&info_hash, &peer_id))
        .await
        .map_err(|e| {
            dc_bt::BtError::new(
                ErrorCode::NetworkError,
                format!("metadata handshake write: {e}"),
            )
        })?;
    let hs = dc_bt::peer::read_handshake(conn.get_mut()).await?;
    if hs.info_hash != info_hash {
        return Err(dc_bt::BtError::new(
            ErrorCode::NetworkError,
            "metadata peer answered for a different info-hash",
        ));
    }
    conn.send(&dc_bt::peer::Message::Extended(
        0,
        dc_bt::peer::encode_extended_handshake(1, None),
    ))
    .await?;
    conn.send(&dc_bt::peer::Message::Interested).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut remote_ut_id: u8 = 0;
    let mut metadata_size: Option<usize> = None;
    let mut pieces: HashMap<usize, Vec<u8>> = HashMap::new();
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(dc_bt::BtError::new(
                ErrorCode::Timeout,
                "metadata fetch timed out",
            ));
        }
        let msg = dc_bt::peer::recv_timeout(&mut conn, Duration::from_secs(15)).await?;
        match msg {
            None => {
                return Err(dc_bt::BtError::new(
                    ErrorCode::NetworkError,
                    "metadata peer closed the connection",
                ))
            }
            Some(dc_bt::peer::Message::Extended(0, payload)) => {
                let ext = dc_bt::peer::parse_extended_handshake(&payload)?;
                remote_ut_id = ext.ut_metadata;
                metadata_size = ext.metadata_size.map(|s| s as usize);
                if remote_ut_id == 0 {
                    return Err(dc_bt::BtError::new(
                        ErrorCode::NetworkError,
                        "peer does not support ut_metadata",
                    ));
                }
                if let Some(size) = metadata_size {
                    if size == 0 || size > 16 * 1024 * 1024 {
                        return Err(dc_bt::BtError::invalid_metainfo(
                            "metadata size out of range",
                        ));
                    }
                    for p in 0..dc_bt::peer::metadata_piece_count(size) as u32 {
                        conn.send(&dc_bt::peer::Message::Extended(
                            remote_ut_id,
                            dc_bt::peer::encode_metadata_msg(&dc_bt::peer::MetadataMsg::Request(p)),
                        ))
                        .await?;
                    }
                }
            }
            Some(dc_bt::peer::Message::Extended(id, payload))
                if id == remote_ut_id && remote_ut_id != 0 =>
            {
                match dc_bt::peer::parse_metadata_msg(&payload)? {
                    dc_bt::peer::MetadataMsg::Data(piece, data) => {
                        pieces.insert(piece as usize, data);
                        if let Some(size) = metadata_size {
                            let count = dc_bt::peer::metadata_piece_count(size);
                            if pieces.len() == count {
                                let mut meta_bytes = vec![0u8; size];
                                for (i, chunk) in pieces.iter() {
                                    let start = i * 16 * 1024;
                                    let end = (start + chunk.len()).min(size);
                                    if *i >= count || start >= size {
                                        continue;
                                    }
                                    meta_bytes[start..end].copy_from_slice(&chunk[..end - start]);
                                }
                                let actual: [u8; 20] = dc_bt_sha1(&meta_bytes);
                                if actual != info_hash {
                                    return Err(dc_bt::BtError::invalid_metainfo(
                                        "fetched metadata does not match the magnet's info-hash",
                                    ));
                                }
                                return Ok(meta_bytes);
                            }
                        }
                    }
                    dc_bt::peer::MetadataMsg::Reject(_) => {
                        return Err(dc_bt::BtError::new(
                            ErrorCode::NetworkError,
                            "metadata request rejected by peer",
                        ));
                    }
                    _ => {}
                }
            }
            Some(_) => {}
        }
    }
}

// ---------------------------------------------------------------------------
// session task — metadata phase → announce/dial cycle → completion → cleanup
// ---------------------------------------------------------------------------

impl TorrentManager {
    /// Route an inbound, already-handshaked connection into its session.
    async fn accept_loop(self: Arc<Self>, listener: tokio::net::TcpListener) {
        loop {
            let (stream, peer_addr) = match listener.accept().await {
                Ok(x) => x,
                Err(e) => {
                    tracing::warn!("torrent accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            let manager = self.clone();
            tokio::spawn(async move {
                // Read the handshake to learn which swarm this connection belongs to.
                let _ = stream.set_nodelay(true);
                let mut conn = dc_bt::peer::PeerConn::new(stream);
                let hs = match tokio::time::timeout(
                    Duration::from_secs(10),
                    dc_bt::peer::read_handshake(conn.get_mut()),
                )
                .await
                {
                    Ok(Ok(hs)) => hs,
                    _ => return,
                };
                if hs.peer_id == manager.peer_id {
                    return; // self-connection
                }
                let route = manager
                    .inbound
                    .lock()
                    .expect("inbound mutex poisoned")
                    .get(&hs.info_hash)
                    .cloned();
                if let Some(tx) = route {
                    // Hand the raw stream (with the handshake already consumed) over.
                    let stream = conn.into_inner();
                    let _ = tx
                        .send(InboundConn {
                            stream,
                            from: peer_addr,
                        })
                        .await;
                }
            });
        }
    }

    async fn run_session(
        self: Arc<Self>,
        job_id: String,
        stop: CancellationToken,
        mut cmd: mpsc::Receiver<TorrentCommand>,
    ) {
        let this = self.clone();
        let (outcome, helpers) = tokio::select! {
            _ = stop.cancelled() => (SessionOutcome::Stopped, None),
            _ = cmd.recv() => (SessionOutcome::Stopped, None),
            body = this.session_body(job_id.clone(), stop.clone()) => body,
        };
        // The session body NEVER cancels its own token (that would race this select);
        // once the body returned (or an external stop won), tear the helpers down here.
        stop.cancel();
        if let Some(helpers) = helpers {
            let _ = helpers.ticker.await;
            let _ = helpers.unchoke.await;
            let _ = helpers.inbound.await;
        }
        self.cleanup_session(&job_id, outcome).await;
    }

    async fn cleanup_session(&self, job_id: &str, outcome: SessionOutcome) {
        self.tasks
            .lock()
            .expect("tasks mutex poisoned")
            .remove(job_id);
        match outcome {
            SessionOutcome::Stopped => {
                // The stopper (pause/cancel/remove) owns the final status; persist only the
                // progress if the row is still active (the runner never resurrects itself).
                if let Ok(Some(row)) = self.store.get_torrent_job(job_id) {
                    if matches!(
                        row.status.as_str(),
                        "queued" | "metadata" | "downloading" | "seeding"
                    ) {
                        let mut row = row;
                        row.status = "paused".into();
                        row.updated_at = now_ms();
                        let _ = self.store.update_torrent_job(&row);
                        self.emit_updated(&row);
                    }
                }
            }
            SessionOutcome::Classified(code, message) => {
                if let Ok(Some(mut row)) = self.store.get_torrent_job(job_id) {
                    row.status = "paused".into();
                    row.error_code = Some(code.as_str().to_string());
                    row.updated_at = now_ms();
                    let _ = self.store.update_torrent_job(&row);
                    self.emit_updated(&row);
                    tracing::warn!(job = %job_id, %code, %message, "torrent session paused");
                }
            }
            SessionOutcome::Failed(code, message) => {
                if let Ok(Some(mut row)) = self.store.get_torrent_job(job_id) {
                    row.status = "failed".into();
                    row.error_code = Some(code.as_str().to_string());
                    row.updated_at = now_ms();
                    let _ = self.store.update_torrent_job(&row);
                    self.emit_updated(&row);
                    tracing::error!(job = %job_id, %code, %message, "torrent session failed");
                }
            }
        }
    }

    async fn session_body(
        self: Arc<Self>,
        job_id: String,
        stop: CancellationToken,
    ) -> (SessionOutcome, Option<SwarmHelpers>) {
        let row = match self.store.get_torrent_job(&job_id) {
            Ok(Some(r)) => r,
            _ => return (SessionOutcome::Stopped, None),
        };
        let tunnel = match self.resolve_tunnel(row.proxy_profile_id.as_deref()) {
            Ok(t) => t,
            Err(e) => return (SessionOutcome::Classified(e.code, e.message), None),
        };

        // ---- metadata phase (magnets without a verified blob) ----
        let meta: Arc<dc_bt::metainfo::Metainfo> = match &row.metainfo_blob {
            Some(blob) => match dc_bt::metainfo::parse(blob) {
                Ok(m) => Arc::new(m),
                Err(e) => {
                    let message = format!("stored metainfo no longer parses: {e}");
                    return (SessionOutcome::Classified(e.code, message), None);
                }
            },
            None => {
                let status_row = match self.mark_metadata_phase(&job_id) {
                    Ok(r) => r,
                    Err(e) => {
                        return (
                            SessionOutcome::Failed(ErrorCode::StorageError, e.message),
                            None,
                        )
                    }
                };
                match self.fetch_metadata_phase(&status_row, &tunnel, &stop).await {
                    Ok((meta, blob)) => {
                        if stop.is_cancelled() {
                            return (SessionOutcome::Stopped, None);
                        }
                        // Persist everything the metadata establishes (name, files, totals).
                        let mut updated = status_row;
                        updated.metainfo_blob = Some(blob);
                        updated.name = Some(meta.name.clone());
                        updated.info_hash = Some(meta.info_hash_hex());
                        updated.total_bytes = Some(meta.total_size);
                        updated.num_pieces = Some(meta.num_pieces as u64);
                        updated.piece_length = Some(meta.piece_length as u64);
                        updated.files = meta
                            .files
                            .iter()
                            .map(|f| TorrentFileEntry {
                                path: f.path.clone(),
                                size: f.size,
                                offset: f.offset,
                            })
                            .collect();
                        updated.status = "downloading".into();
                        updated.updated_at = now_ms();
                        if let Err(e) = self.store.update_torrent_job(&updated) {
                            return (
                                SessionOutcome::Failed(ErrorCode::StorageError, e.message),
                                None,
                            );
                        }
                        self.emit_updated(&updated);
                        Arc::new(meta)
                    }
                    Err(e) => return (SessionOutcome::Classified(e.code, e.message), None),
                }
            }
        };

        if stop.is_cancelled() {
            return (SessionOutcome::Stopped, None);
        }

        // ---- download / seed phase ----
        self.run_swarm(&job_id, meta, tunnel, stop).await
    }

    fn mark_metadata_phase(&self, job_id: &str) -> Result<TorrentJobRow, ContractError> {
        let mut row = self.store.get_torrent_job(job_id)?.ok_or_else(not_found)?;
        if row.status == "queued" {
            row.status = "metadata".into();
            row.updated_at = now_ms();
            self.store.update_torrent_job(&row)?;
            self.emit_updated(&row);
        }
        Ok(row)
    }

    /// Magnet metadata phase: announce + DHT for peers, then fetch verified metadata from
    /// the swarm within budget. Never guesses: nothing but a hash-verified info dict wins.
    async fn fetch_metadata_phase(
        &self,
        row: &TorrentJobRow,
        tunnel: &dc_bt::socks::ProxyTunnel,
        stop: &CancellationToken,
    ) -> Result<(dc_bt::metainfo::Metainfo, Vec<u8>), ContractError> {
        let info_hash = row
            .info_hash
            .as_deref()
            .and_then(dc_bt::unhex20)
            .or_else(|| {
                // the wire keeps magnets' info_hash null until metadata; derive from the URI
                dc_bt::magnet::parse(&row.source_uri)
                    .ok()
                    .map(|m| m.info_hash)
            })
            .ok_or_else(|| {
                ContractError::new(
                    ErrorCode::TorrentInvalidMetainfo,
                    "magnet has no usable btih",
                )
            })?;
        let budget = Duration::from_millis(self.metadata_budget_ms.load(Ordering::SeqCst));
        let deadline = tokio::time::Instant::now() + budget;
        let mut announced_addrs: Vec<SocketAddr> = Vec::new();
        let mut tried: HashSet<SocketAddr> = HashSet::new();

        while tokio::time::Instant::now() < deadline && !stop.is_cancelled() {
            if announced_addrs.is_empty() {
                // The whole announce round (HTTP + UDP + DHT) stays inside the budget.
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                announced_addrs = match tokio::time::timeout(
                    remaining,
                    self.announce_for_peers(row, info_hash, tunnel, TrackerEventKind::Started),
                )
                .await
                {
                    Ok(Ok(peers)) => peers,
                    Ok(Err(_)) => Vec::new(),
                    Err(_) => Vec::new(), // budget elapsed — the loop exits below
                };
            }
            for addr in announced_addrs.iter().copied() {
                if tried.contains(&addr) {
                    continue;
                }
                tried.insert(addr);
                // Per-peer fetch never outlives the remaining budget.
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                match tokio::time::timeout(
                    remaining.min(Duration::from_secs(35)),
                    fetch_metadata(tunnel, info_hash, self.peer_id, addr),
                )
                .await
                {
                    Ok(Ok(info_dict)) => {
                        // BEP 9 transfers the bare info dict; wrap it under the canonical
                        // `4:info` key into a valid (announce-less) metainfo for parsing
                        // and persistence.
                        let mut wrapped = Vec::with_capacity(info_dict.len() + 8);
                        wrapped.extend_from_slice(b"d4:info");
                        wrapped.extend_from_slice(&info_dict);
                        wrapped.push(b'e');
                        let meta = dc_bt::metainfo::parse(&wrapped).map_err(ContractError::from)?;
                        return Ok((meta, wrapped));
                    }
                    Ok(Err(e)) => {
                        tracing::debug!(%addr, "metadata fetch failed: {e}");
                    }
                    Err(_) => {
                        tracing::debug!(%addr, "metadata fetch timed out");
                    }
                }
                if stop.is_cancelled() {
                    return Err(ContractError::new(ErrorCode::Canceled, "stopped"));
                }
            }
            // No peers or none of them served metadata: wait a beat, re-announce next round.
            announced_addrs.clear();
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(ContractError::new(
            ErrorCode::TorrentMetadataTimeout,
            "the swarm produced no verified metadata within the budget",
        ))
    }

    /// The long-running swarm phase: trackers, DHT, dialing, ticker, completion.
    /// Returns the outcome plus the helper-task handles — the CALLER cancels the token
    /// and awaits them (a session body must never cancel its own token: that would race
    /// run_session's select between the body result and the stop arm).
    async fn run_swarm(
        self: Arc<Self>,
        job_id: &str,
        meta: Arc<dc_bt::metainfo::Metainfo>,
        tunnel: dc_bt::socks::ProxyTunnel,
        stop: CancellationToken,
    ) -> (SessionOutcome, Option<SwarmHelpers>) {
        let row = match self.store.get_torrent_job(job_id) {
            Ok(Some(r)) => r,
            _ => return (SessionOutcome::Stopped, None),
        };
        // The persisted have-map is the integrity authority: verified bytes are derived
        // from it (never re-fetched), not from the possibly stale received_bytes column.
        let picker = final_picker(&row, &meta);
        let verified_at_start = {
            let mut bytes = 0u64;
            for idx in picker.have().indices() {
                bytes += meta.piece_len(idx) as u64;
            }
            bytes
        };
        let writer = FileWriter::new(&row.destination_dir, meta.clone());
        let (inbound_tx, mut inbound_rx) = mpsc::channel::<InboundConn>(16);
        self.inbound
            .lock()
            .expect("inbound mutex poisoned")
            .insert(meta.info_hash, inbound_tx);

        let shared = Arc::new(SessionShared {
            manager: self.clone(),
            job_id: job_id.to_string(),
            info_hash: meta.info_hash,
            peer_id: self.peer_id,
            meta: meta.clone(),
            picker: Mutex::new(final_picker(&row, &meta)),
            writer: Mutex::new(writer),
            peers: Mutex::new(HashMap::new()),
            tunnel: tunnel.clone(),
            stop: stop.clone(),
            piece_failures: Mutex::new(HashMap::new()),
            request_times: Mutex::new(HashMap::new()),
            verified_bytes: AtomicU64::new(verified_at_start),
            uploaded_bytes: AtomicU64::new(row.uploaded_bytes),
            finalized: std::sync::atomic::AtomicBool::new(false),
        });

        // Initial status: seeding when the have-map is already full, else downloading.
        {
            let complete = shared
                .picker
                .lock()
                .expect("picker mutex poisoned")
                .is_complete();
            let mut updated = row.clone();
            updated.status = if complete { "seeding" } else { "downloading" }.into();
            updated.updated_at = now_ms();
            let _ = self.store.update_torrent_job(&updated);
            self.emit_updated(&updated);
        }

        // Progress ticker: throttled events + durable rows + stale-request sweep.
        let ticker = self.spawn_ticker(&shared);

        // Unchoke rotation.
        let unchoke_task = {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(UNCHOKE_TICK);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        _ = shared.stop.cancelled() => break,
                        _ = tick.tick() => shared.apply_unchoke_policy(),
                    }
                }
            })
        };

        // Serve inbound peers.
        let inbound_task = {
            let shared = shared.clone();
            tokio::spawn(async move {
                while let Some(conn) = inbound_rx.recv().await {
                    let s = shared.clone();
                    tokio::spawn(async move {
                        drive_conn(s, conn.from, conn.stream, false).await;
                    });
                }
            })
        };

        // Announce + dial loop (completion transitions are tick-driven inside).
        let outcome = self.announce_and_dial_loop(&shared).await;

        // Release the inbound registration + file handles; the helper tasks stop when the
        // caller cancels the token (run_session awaits their handles afterwards).
        self.inbound
            .lock()
            .expect("inbound mutex poisoned")
            .remove(&meta.info_hash);
        {
            let mut writer = shared.writer.lock().expect("writer mutex poisoned");
            writer.close_all();
        }
        (
            outcome,
            Some(SwarmHelpers {
                ticker,
                unchoke: unchoke_task,
                inbound: inbound_task,
            }),
        )
    }

    /// Announce to every tracker (HTTP through the tunnel, UDP only direct), consult DHT,
    /// dial discovered peers, and re-announce on the trackers' interval until completion.
    async fn announce_and_dial_loop(
        self: &Arc<Self>,
        shared: &Arc<SessionShared>,
    ) -> SessionOutcome {
        let row_trackers: Vec<String> = match self.store.get_torrent_job(&shared.job_id) {
            Ok(Some(r)) => r.trackers.clone(),
            _ => Vec::new(),
        };
        let direct = matches!(shared.tunnel, dc_bt::socks::ProxyTunnel::Direct);
        let http_client = self.build_http_client(&shared.tunnel);
        let mut event = TrackerEventKind::Started;
        let mut next_interval = Duration::from_secs(30);
        let dialed: Mutex<HashSet<SocketAddr>> = Mutex::new(HashSet::new());
        // A seeding session KEEPS RUNNING after completion (it serves uploads until the
        // user pauses) — completion is a one-time transition, not a session exit.

        loop {
            if shared.stop.is_cancelled() {
                return SessionOutcome::Stopped;
            }
            if self.finalize_completion(shared).await {
                event = TrackerEventKind::Completed;
            }

            // Tracker announces (respecting the proxy policy).
            let mut discovered: Vec<SocketAddr> = Vec::new();
            for url in &row_trackers {
                if url.starts_with("http://") || url.starts_with("https://") {
                    match dc_bt::tracker::announce_http(
                        &http_client,
                        url,
                        &dc_bt::tracker::AnnounceParams::new(
                            shared.info_hash,
                            shared.peer_id,
                            self.listen_port(),
                            shared.meta.total_size - shared.verified_bytes.load(Ordering::SeqCst),
                        )
                        .with_event(event),
                    )
                    .await
                    {
                        Ok(resp) => {
                            next_interval = Duration::from_secs(resp.interval.max(5) as u64)
                                .min(MAX_REANNOUNCE);
                            discovered.extend(resp.peers);
                        }
                        Err(e) => tracing::debug!(url = %url, "http announce: {e}"),
                    }
                } else if url.starts_with("udp://") && direct {
                    if let Some(taddr) = udp_tracker_addr(url).await {
                        let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await else {
                            continue;
                        };
                        match dc_bt::tracker::announce_udp(
                            &sock,
                            taddr,
                            &dc_bt::tracker::AnnounceParams::new(
                                shared.info_hash,
                                shared.peer_id,
                                self.listen_port(),
                                shared.meta.total_size
                                    - shared.verified_bytes.load(Ordering::SeqCst),
                            )
                            .with_event(event),
                        )
                        .await
                        {
                            Ok(resp) => {
                                next_interval = Duration::from_secs(resp.interval.max(5) as u64)
                                    .min(MAX_REANNOUNCE);
                                discovered.extend(resp.peers);
                            }
                            Err(e) => tracing::debug!(url = %url, "udp announce: {e}"),
                        }
                    }
                }
            }
            // DHT (direct mode only — proxied sessions never leak DHT traffic).
            if direct {
                if let Some(dht) = self.dht_handle() {
                    let peers = dht.get_peers(shared.info_hash).await;
                    discovered.extend(peers);
                }
            }

            // Dial new peers (dedup, cap).
            {
                let mut dialed = dialed.lock().expect("dialed mutex poisoned");
                for addr in discovered {
                    if dialed.contains(&addr) || addr.port() == 0 {
                        continue;
                    }
                    if self.is_self(&addr) {
                        continue;
                    }
                    dialed.insert(addr);
                    if dialed.len() > MAX_PEERS_PER_TORRENT * 4 {
                        dialed.clear(); // allow retrying old addresses later
                        dialed.insert(addr);
                    }
                    let shared = shared.clone();
                    tokio::spawn(async move {
                        if let Ok(Ok(stream)) = tokio::time::timeout(
                            Duration::from_secs(15),
                            dc_bt::socks::connect(
                                &addr.ip().to_string(),
                                addr.port(),
                                &shared.tunnel,
                            ),
                        )
                        .await
                        {
                            let _ = stream.set_nodelay(true);
                            drive_conn(shared, addr, stream, true).await;
                        }
                    });
                }
            }

            // Sleep until the trackers' interval (or stop) elapses.
            tokio::select! {
                _ = shared.stop.cancelled() => return SessionOutcome::Stopped,
                _ = tokio::time::sleep(next_interval) => {
                    event = TrackerEventKind::None;
                }
            }
        }
    }

    /// One-time completion transition: persist the seeding state + announce to the swarm.
    /// Called from the ticker (500 ms) and the announce loop top — the first caller wins.
    async fn finalize_completion(self: &Arc<Self>, shared: &Arc<SessionShared>) -> bool {
        if shared.finalized.swap(true, Ordering::SeqCst) {
            return false;
        }
        if !shared
            .picker
            .lock()
            .expect("picker mutex poisoned")
            .is_complete()
        {
            shared.finalized.store(false, Ordering::SeqCst);
            return false;
        }
        let verified = shared.verified_bytes.load(Ordering::SeqCst);
        let have = shared
            .picker
            .lock()
            .expect("picker mutex poisoned")
            .have_bytes();
        if let Ok(Some(mut row)) = self.store.get_torrent_job(&shared.job_id) {
            row.status = "seeding".into();
            row.received_bytes = verified;
            row.uploaded_bytes = shared.uploaded_bytes.load(Ordering::SeqCst);
            row.have_blob = Some(have);
            row.error_code = None;
            row.updated_at = now_ms();
            let _ = self.store.update_torrent_job(&row);
            self.emit_updated(&row);
        }
        self.announce_completed(shared).await;
        true
    }

    /// Best-effort `event=completed` announce to every reachable tracker (proxy policy
    /// respected) once the payload is fully verified.
    async fn announce_completed(self: &Arc<Self>, shared: &Arc<SessionShared>) {
        let direct = matches!(shared.tunnel, dc_bt::socks::ProxyTunnel::Direct);
        let client = self.build_http_client(&shared.tunnel);
        let trackers: Vec<String> = match self.store.get_torrent_job(&shared.job_id) {
            Ok(Some(r)) => r.trackers.clone(),
            _ => Vec::new(),
        };
        let left = shared
            .meta
            .total_size
            .saturating_sub(shared.verified_bytes.load(Ordering::SeqCst));
        for url in trackers {
            let params = dc_bt::tracker::AnnounceParams::new(
                shared.info_hash,
                shared.peer_id,
                self.listen_port(),
                left,
            )
            .with_event(TrackerEventKind::Completed);
            if url.starts_with("http://") || url.starts_with("https://") {
                if let Err(e) = dc_bt::tracker::announce_http(&client, &url, &params).await {
                    tracing::debug!(url = %url, "completed announce: {e}");
                }
            } else if url.starts_with("udp://") && direct {
                if let Some(taddr) = udp_tracker_addr(&url).await {
                    if let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await {
                        let _ = dc_bt::tracker::announce_udp(&sock, taddr, &params).await;
                    }
                }
            }
        }
        if direct {
            if let Some(dht) = self.dht_handle() {
                dht.announce(shared.info_hash, self.listen_port()).await;
            }
        }
    }

    fn is_self(&self, addr: &SocketAddr) -> bool {
        addr.port() == self.listen_port() && (addr.ip().is_loopback() || addr.ip().is_unspecified())
    }

    fn build_http_client(&self, tunnel: &dc_bt::socks::ProxyTunnel) -> reqwest::Client {
        let mut builder = reqwest::Client::builder();
        match tunnel {
            dc_bt::socks::ProxyTunnel::Direct => {}
            dc_bt::socks::ProxyTunnel::Socks5 {
                host,
                port,
                username,
                password,
            } => {
                let url = format!("socks5://{host}:{port}");
                let mut proxy = match reqwest::Proxy::all(&url) {
                    Ok(p) => p,
                    Err(_) => return builder.build().unwrap_or_default(),
                };
                if let (Some(u), Some(pw)) = (username, password) {
                    proxy = proxy.basic_auth(u, pw);
                }
                builder = builder.proxy(proxy);
            }
            dc_bt::socks::ProxyTunnel::Http {
                host,
                port,
                username,
                password,
            } => {
                let url = format!("http://{host}:{port}");
                let mut proxy = match reqwest::Proxy::all(&url) {
                    Ok(p) => p,
                    Err(_) => return builder.build().unwrap_or_default(),
                };
                if let (Some(u), Some(pw)) = (username, password) {
                    proxy = proxy.basic_auth(u, pw);
                }
                builder = builder.proxy(proxy);
            }
        }
        builder.build().unwrap_or_default()
    }

    /// Announce (magnet metadata phase): one round across all trackers + DHT.
    async fn announce_for_peers(
        &self,
        row: &TorrentJobRow,
        info_hash: [u8; 20],
        tunnel: &dc_bt::socks::ProxyTunnel,
        event: TrackerEventKind,
    ) -> Result<Vec<SocketAddr>, ContractError> {
        let direct = matches!(tunnel, dc_bt::socks::ProxyTunnel::Direct);
        let client = self.build_http_client(tunnel);
        let mut peers = Vec::new();
        for url in &row.trackers {
            if url.starts_with("http://") || url.starts_with("https://") {
                if let Ok(resp) = dc_bt::tracker::announce_http(
                    &client,
                    url,
                    &dc_bt::tracker::AnnounceParams::new(
                        info_hash,
                        self.peer_id,
                        self.listen_port(),
                        row.total_bytes.unwrap_or(0),
                    )
                    .with_event(event),
                )
                .await
                {
                    peers.extend(resp.peers);
                }
            } else if url.starts_with("udp://") && direct {
                if let Some(taddr) = udp_tracker_addr(url).await {
                    if let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await {
                        if let Ok(resp) = dc_bt::tracker::announce_udp(
                            &sock,
                            taddr,
                            &dc_bt::tracker::AnnounceParams::new(
                                info_hash,
                                self.peer_id,
                                self.listen_port(),
                                row.total_bytes.unwrap_or(0),
                            )
                            .with_event(event),
                        )
                        .await
                        {
                            peers.extend(resp.peers);
                        }
                    }
                }
            }
        }
        if direct {
            if let Some(dht) = self.dht_handle() {
                peers.extend(dht.get_peers(info_hash).await);
            }
        }
        Ok(peers)
    }

    /// 500 ms ticker: throttled `torrent.progress` events + durable progress rows.
    fn spawn_ticker(self: &Arc<Self>, shared: &Arc<SessionShared>) -> tokio::task::JoinHandle<()> {
        let store = self.store.clone();
        let events = self.events.clone();
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PROGRESS_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_verified = 0u64;
            let mut last_uploaded = 0u64;
            loop {
                tokio::select! {
                    _ = shared.stop.cancelled() => break,
                    _ = tick.tick() => {}
                }
                shared.sweep_stale_requests();
                if shared.manager.finalize_completion(&shared).await {
                    tracing::info!(job = %shared.job_id, "torrent fully verified — seeding");
                }
                let verified = shared.verified_bytes.load(Ordering::SeqCst);
                let uploaded = shared.uploaded_bytes.load(Ordering::SeqCst);
                let (peers, seeds) = shared.counts();
                // Speed from the tick delta (b/s over the last 500 ms).
                let download_speed = verified.saturating_sub(last_verified) * 2;
                let upload_speed = uploaded.saturating_sub(last_uploaded) * 2;
                last_verified = verified;
                last_uploaded = uploaded;
                let total = shared.meta.total_size;
                let eta = if download_speed > 0 && total > verified {
                    Some((total - verified) / download_speed)
                } else {
                    None
                };
                let phase = {
                    let complete = shared
                        .picker
                        .lock()
                        .expect("picker mutex poisoned")
                        .is_complete();
                    if complete {
                        "seeding"
                    } else {
                        "downloading"
                    }
                };
                // The durable row is the truth: if a pause/cancel/remove landed, stop.
                match store.get_torrent_job(&shared.job_id) {
                    Ok(Some(row)) => {
                        if !matches!(row.status.as_str(), "metadata" | "downloading" | "seeding") {
                            break;
                        }
                        let have = shared
                            .picker
                            .lock()
                            .expect("picker mutex poisoned")
                            .have_bytes();
                        let _ = store.update_torrent_progress(
                            &shared.job_id,
                            verified,
                            uploaded,
                            Some(&have),
                        );
                    }
                    _ => break,
                }
                let _ = events.send(EventEnvelope {
                    v: dc_protocol::PROTOCOL_VERSION,
                    event: "torrent.progress".into(),
                    payload: Some(
                        serde_json::to_value(TorrentProgress {
                            job_id: shared.job_id.clone(),
                            phase: phase.to_string(),
                            received_bytes: verified,
                            total_bytes: Some(total),
                            download_speed_bps: download_speed,
                            upload_speed_bps: upload_speed,
                            peers,
                            seeds,
                            eta_seconds: eta,
                        })
                        .expect("progress serializes"),
                    ),
                });
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackerEventKind {
    Started,
    None,
    Completed,
}

impl TrackerEventKind {
    fn to_bt(self) -> dc_bt::tracker::TrackerEvent {
        match self {
            TrackerEventKind::Started => dc_bt::tracker::TrackerEvent::Started,
            TrackerEventKind::None => dc_bt::tracker::TrackerEvent::None,
            TrackerEventKind::Completed => dc_bt::tracker::TrackerEvent::Completed,
        }
    }
}

// Bridge: the dc-bt announce params use its own TrackerEvent type; map through a method.
trait WithEvent {
    fn with_event(self, kind: TrackerEventKind) -> dc_bt::tracker::AnnounceParams;
}

impl WithEvent for dc_bt::tracker::AnnounceParams {
    fn with_event(mut self, kind: TrackerEventKind) -> dc_bt::tracker::AnnounceParams {
        self.event = kind.to_bt();
        self
    }
}

#[derive(Debug)]
enum SessionOutcome {
    Stopped,
    Classified(ErrorCode, String),
    Failed(ErrorCode, String),
}

/// Background tasks of a running swarm; the session task awaits them after cancellation.
struct SwarmHelpers {
    ticker: tokio::task::JoinHandle<()>,
    unchoke: tokio::task::JoinHandle<()>,
    inbound: tokio::task::JoinHandle<()>,
}

fn fail_session(manager: &Arc<TorrentManager>, job_id: &str, err: ContractError) {
    // Peer drivers run detached; failures land on the durable row directly.
    let store = manager.store.clone();
    let events = manager.events.clone();
    let job_id = job_id.to_string();
    tokio::spawn(async move {
        if let Ok(Some(mut row)) = store.get_torrent_job(&job_id) {
            row.status = "failed".into();
            row.error_code = Some(err.code.as_str().to_string());
            row.updated_at = now_ms();
            let _ = store.update_torrent_job(&row);
            let _ = events.send(EventEnvelope {
                v: dc_protocol::PROTOCOL_VERSION,
                event: "torrent.updated".into(),
                payload: Some(
                    serde_json::to_value(TorrentUpdated { job: row.to_wire() })
                        .expect("job serializes"),
                ),
            });
        }
    });
}

async fn udp_tracker_addr(url: &str) -> Option<std::net::SocketAddrV4> {
    let rest = url.strip_prefix("udp://")?;
    let (host, port) = rest.split_once(':')?;
    let port: u16 = port.trim_end_matches('/').parse().ok()?;
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return Some(std::net::SocketAddrV4::new(ip, port));
    }
    // Hostnames resolve on demand (async; first IPv4 answer wins).
    let resolved: Vec<std::net::SocketAddr> =
        tokio::net::lookup_host((host, port)).await.ok()?.collect();
    resolved
        .into_iter()
        .filter_map(|a| match a {
            SocketAddr::V4(v4) => Some(v4),
            _ => None,
        })
        .next()
}

// Restore helper: rebuild the picker exactly as the persisted have-map says.
fn final_picker(
    row: &TorrentJobRow,
    meta: &Arc<dc_bt::metainfo::Metainfo>,
) -> dc_bt::picker::PiecePicker {
    let mut picker =
        dc_bt::picker::PiecePicker::new(meta.num_pieces, meta.piece_length, meta.total_size);
    if let Some(have) = &row.have_blob {
        picker.restore_have(have);
    }
    picker
}
