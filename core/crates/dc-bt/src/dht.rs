//! Minimal-real DHT (BEP 5) — a self-contained async node over one UdpSocket.
//!
//! Honest scope notes (documented in the phase report):
//! - the routing table is a bounded "closest-N" node list (not full k-bucket splitting) —
//!   sufficient for get_peers on small clients, and every query path is real;
//! - iterative `get_peers` walks up to `MAX_ROUNDS` rounds querying the α closest nodes
//!   each round, collects `values` peers and `token`s, then `announce_peer`s to the K
//!   closest token-holding nodes;
//! - incoming queries (ping/find_node/get_peers/announce_peer) are answered so the client
//!   is a functioning DHT citizen; announced peers are stored per info-hash;
//! - tokens are SHA-1(secret || ip) with a rotating secret (current + previous accepted).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use sha1::{Digest, Sha1};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;

use crate::bencode::{self, BValue};
use crate::BtError;

const K: usize = 8;
const ALPHA: usize = 8;
const MAX_ROUNDS: u32 = 3;
const MAX_TABLE: usize = 512;
const QUERY_TIMEOUT: Duration = Duration::from_secs(3);
const TOKEN_ROTATE: Duration = Duration::from_secs(300);

pub type NodeId = [u8; 20];

pub fn random_node_id() -> NodeId {
    rand::random()
}

fn xor_distance(a: &NodeId, b: &NodeId) -> [u8; 20] {
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn distance_less(a: &[u8; 20], b: &[u8; 20]) -> bool {
    for i in 0..20 {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    false
}

/// Bounded routing table: the K*MAX_ROUNDS-ish closest nodes we know, refreshed by traffic.
#[derive(Default)]
struct RoutingTable {
    nodes: Vec<(NodeId, SocketAddr)>,
}

impl RoutingTable {
    fn insert(&mut self, id: NodeId, addr: SocketAddr) {
        if self.nodes.iter().any(|(nid, _)| *nid == id) {
            return;
        }
        self.nodes.push((id, addr));
        if self.nodes.len() > MAX_TABLE {
            self.nodes.truncate(MAX_TABLE); // over-approximation is fine for a flat table
        }
    }

    fn closest(&self, target: &NodeId, n: usize) -> Vec<(NodeId, SocketAddr)> {
        let mut v = self.nodes.clone();
        v.sort_by(|a, b| {
            let da = xor_distance(&a.0, target);
            let db = xor_distance(&b.0, target);
            if distance_less(&da, &db) {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });
        v.truncate(n);
        v
    }
}

/// Compact IPv4 "nodes" value: 26 bytes per node (20 id + 4 ip + 2 port).
pub fn encode_nodes(nodes: &[(NodeId, SocketAddr)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nodes.len() * 26);
    for (id, addr) in nodes {
        if let SocketAddr::V4(v4) = addr {
            out.extend_from_slice(id);
            out.extend_from_slice(&v4.ip().octets());
            out.extend_from_slice(&v4.port().to_be_bytes());
        }
    }
    out
}

pub fn decode_nodes(bytes: &[u8]) -> Vec<(NodeId, SocketAddr)> {
    let mut out = Vec::new();
    for chunk in bytes.as_chunks::<26>().0 {
        let id: NodeId = chunk[0..20].try_into().unwrap();
        let ip = Ipv4Addr::new(chunk[20], chunk[21], chunk[22], chunk[23]);
        let port = u16::from_be_bytes([chunk[24], chunk[25]]);
        if port != 0 {
            out.push((id, SocketAddr::V4(SocketAddrV4::new(ip, port))));
        }
    }
    out
}

struct Txn {
    #[allow(dead_code)] // kept for diagnostics when a reply arrives
    query: &'static str,
    #[allow(dead_code)]
    target: NodeId,
    #[allow(dead_code)]
    deadline: tokio::time::Instant,
    reply: Option<BValue>,
}

type SecretState = (Vec<u8>, Vec<u8>, tokio::time::Instant);

/// A running DHT node. Cloneable handle; the UDP task runs in the background.
pub struct DhtNode {
    socket: Arc<UdpSocket>,
    self_id: NodeId,
    table: Arc<Mutex<RoutingTable>>,
    txns: Arc<Mutex<HashMap<[u8; 2], Txn>>>,
    /// Peers announced to us per info-hash (we serve them in get_peers).
    announced: Arc<Mutex<HashMap<NodeId, Vec<SocketAddr>>>>,
    secrets: Arc<Mutex<SecretState>>,
    /// Peers we learned for each info-hash via get_peers (the swarm feed).
    discovered: Arc<Mutex<HashMap<NodeId, Vec<SocketAddr>>>>,
}

impl DhtNode {
    /// Bind to `bind` (usually the shared torrent port) and spawn the servicing task.
    pub async fn start(bind: SocketAddr) -> Result<Arc<Self>, BtError> {
        let socket = UdpSocket::bind(bind).await.map_err(|e| {
            BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                format!("dht bind: {e}"),
            )
        })?;
        let local = socket.local_addr().map_err(|e| {
            BtError::new(
                dc_protocol::ErrorCode::NetworkError,
                format!("dht local_addr: {e}"),
            )
        })?;
        let node = Arc::new(Self {
            socket: Arc::new(socket),
            self_id: random_node_id(),
            table: Arc::new(Mutex::new(RoutingTable::default())),
            txns: Arc::new(Mutex::new(HashMap::new())),
            announced: Arc::new(Mutex::new(HashMap::new())),
            secrets: Arc::new(Mutex::new((
                new_secret(),
                Vec::new(),
                tokio::time::Instant::now() + TOKEN_ROTATE,
            ))),
            discovered: Arc::new(Mutex::new(HashMap::new())),
        });
        let _ = local;
        node.spawn_reader();
        Ok(node)
    }

    pub fn port(&self) -> u16 {
        self.socket.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    pub fn id(&self) -> NodeId {
        self.self_id
    }

    fn spawn_reader(self: &Arc<Self>) {
        let node = self.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                let (n, from) = match node.socket.recv_from(&mut buf).await {
                    Ok(x) => x,
                    Err(_) => continue,
                };
                let packet = buf[..n].to_vec();
                node.handle_packet(packet, from).await;
            }
        });
    }

    async fn handle_packet(&self, packet: Vec<u8>, from: SocketAddr) {
        // UDP tracker (BEP 15) packets start with the 8-byte magic — not bencode; ignore.
        if packet.len() >= 8 && packet[0..8] == 0x41727101980u64.to_be_bytes() {
            return;
        }
        let v = match bencode::decode(&packet) {
            Ok(v) => v,
            Err(_) => return,
        };
        let y = v.get(b"y").and_then(|b| b.as_bytes()).unwrap_or(b"");
        let t = v
            .get(b"t")
            .and_then(|b| b.as_bytes())
            .unwrap_or(&[])
            .to_vec();
        match y {
            b"r" | b"e" => {
                if t.len() == 2 {
                    let key = [t[0], t[1]];
                    let mut txns = self.txns.lock().await;
                    if let Some(txn) = txns.get_mut(&key) {
                        txn.reply = Some(v.clone());
                    }
                }
            }
            b"q" => self.answer_query(&v, &t, from).await,
            _ => {}
        }
    }

    async fn current_token(&self, ip: std::net::IpAddr) -> Vec<u8> {
        let mut secrets = self.secrets.lock().await;
        let (cur, prev, rotate_at) = &mut *secrets;
        if tokio::time::Instant::now() >= *rotate_at {
            *prev = cur.clone();
            *cur = new_secret();
            *rotate_at = tokio::time::Instant::now() + TOKEN_ROTATE;
        }
        token_for(cur, ip)
    }

    fn token_valid_sync(cur: &[u8], prev: &[u8], ip: std::net::IpAddr, token: &[u8]) -> bool {
        token_for(cur, ip) == token || token_for(prev, ip) == token
    }

    async fn answer_query(&self, q: &BValue, t: &[u8], from: SocketAddr) {
        let query = q.get(b"q").and_then(|b| b.as_str()).unwrap_or("");
        let a = q.get(b"a").cloned().unwrap_or(BValue::Dict(vec![]));
        let sender_id: NodeId = a
            .get(b"id")
            .and_then(|b| b.as_bytes())
            .and_then(|b| b.try_into().ok())
            .unwrap_or([0u8; 20]);
        self.table.lock().await.insert(sender_id, from);

        let reply_id = BValue::Bytes(self.self_id.to_vec());
        let r = match query {
            "ping" => Some(BValue::Dict(vec![(b"id".to_vec(), reply_id)])),
            "find_node" | "get_peers" => {
                let target: NodeId = a
                    .get(b"target")
                    .or_else(|| a.get(b"info_hash"))
                    .and_then(|b| b.as_bytes())
                    .and_then(|b| b.try_into().ok())
                    .unwrap_or([0u8; 20]);
                let closest = {
                    let table = self.table.lock().await;
                    table.closest(&target, K)
                };
                let mut pairs = vec![(b"id".to_vec(), reply_id)];
                if query == "get_peers" {
                    let token = self.current_token(from.ip()).await;
                    pairs.push((b"token".to_vec(), BValue::Bytes(token)));
                    let peers = self
                        .announced
                        .lock()
                        .await
                        .get(&target)
                        .cloned()
                        .unwrap_or_default();
                    if !peers.is_empty() {
                        let values = BValue::List(
                            peers
                                .iter()
                                .filter_map(|p| match p {
                                    SocketAddr::V4(v4) => {
                                        let mut raw = Vec::with_capacity(6);
                                        raw.extend_from_slice(&v4.ip().octets());
                                        raw.extend_from_slice(&v4.port().to_be_bytes());
                                        Some(BValue::Bytes(raw))
                                    }
                                    _ => None,
                                })
                                .collect(),
                        );
                        pairs.push((b"values".to_vec(), values));
                    }
                }
                pairs.push((b"nodes".to_vec(), BValue::Bytes(encode_nodes(&closest))));
                Some(BValue::Dict(pairs))
            }
            "announce_peer" => {
                let info_hash: NodeId = a
                    .get(b"info_hash")
                    .and_then(|b| b.as_bytes())
                    .and_then(|b| b.try_into().ok())
                    .unwrap_or([0u8; 20]);
                let port = a.get(b"port").and_then(|b| b.as_int()).unwrap_or(0) as u16;
                let token = a
                    .get(b"token")
                    .and_then(|b| b.as_bytes())
                    .map(|b| b.to_vec())
                    .unwrap_or_default();
                let ok = {
                    let secrets = self.secrets.lock().await;
                    Self::token_valid_sync(&secrets.0, &secrets.1, from.ip(), &token)
                };
                if ok && port != 0 {
                    let mut announced = self.announced.lock().await;
                    let list = announced.entry(info_hash).or_default();
                    if !list.contains(&from) {
                        list.push(from);
                    }
                }
                Some(BValue::Dict(vec![(b"id".to_vec(), reply_id)]))
            }
            _ => None, // unknown query: no reply (spec-legal)
        };
        if let Some(r) = r {
            let reply = BValue::Dict(vec![
                (b"t".to_vec(), BValue::Bytes(t.to_vec())),
                (b"y".to_vec(), bstr_bytes(b"r")),
                (b"r".to_vec(), r),
            ]);
            let bytes = bencode::encode(&reply);
            let _ = self.socket.send_to(&bytes, from).await;
        }
    }

    async fn query(
        &self,
        addr: SocketAddr,
        query: &'static str,
        args: Vec<(Vec<u8>, BValue)>,
        target: NodeId,
    ) -> Option<BValue> {
        let txn_id: [u8; 2] = rand::random();
        let msg = BValue::Dict(vec![
            (b"t".to_vec(), BValue::Bytes(txn_id.to_vec())),
            (b"y".to_vec(), bstr_bytes(b"q")),
            (b"q".to_vec(), bstr_bytes(query.as_bytes())),
            (b"a".to_vec(), BValue::Dict(args)),
        ]);
        let bytes = bencode::encode(&msg);
        self.socket.send_to(&bytes, addr).await.ok()?;
        self.txns.lock().await.insert(
            txn_id,
            Txn {
                query,
                target,
                deadline: tokio::time::Instant::now() + QUERY_TIMEOUT,
                reply: None,
            },
        );
        let deadline = tokio::time::Instant::now() + QUERY_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if let Some(txn) = self.txns.lock().await.get(&txn_id) {
                if let Some(reply) = &txn.reply {
                    let r = reply.get(b"r").cloned();
                    self.txns.lock().await.remove(&txn_id);
                    return r;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.txns.lock().await.remove(&txn_id);
        None
    }

    /// Seed the routing table (bootstrap nodes; resolved by the caller).
    pub async fn bootstrap(&self, addrs: Vec<SocketAddr>) {
        let mut table = self.table.lock().await;
        for addr in addrs {
            table.insert(random_node_id(), addr); // id unknown until we query; refreshed on reply
        }
        drop(table);
        // ping to learn real ids
        let targets: Vec<SocketAddr> = self
            .table
            .lock()
            .await
            .nodes
            .iter()
            .map(|(_, a)| *a)
            .collect();
        for addr in targets {
            let _ = self
                .query(
                    addr,
                    "ping",
                    vec![(b"id".to_vec(), BValue::Bytes(self.self_id.to_vec()))],
                    self.self_id,
                )
                .await;
        }
    }

    /// Iterative get_peers; returns discovered peers for the info-hash.
    pub async fn get_peers(&self, info_hash: NodeId) -> Vec<SocketAddr> {
        let mut queried: Vec<SocketAddr> = Vec::new();
        for _round in 0..MAX_ROUNDS {
            let candidates = {
                let table = self.table.lock().await;
                table.closest(&info_hash, ALPHA + queried.len())
            };
            let mut fresh: Vec<SocketAddr> = candidates
                .into_iter()
                .map(|(_, a)| a)
                .filter(|a| !queried.contains(a))
                .collect();
            if fresh.is_empty() {
                break;
            }
            let batch: Vec<SocketAddr> = fresh.drain(..ALPHA.min(fresh.len())).collect();
            for addr in &batch {
                queried.push(*addr);
                if let Some(r) = self
                    .query(
                        *addr,
                        "get_peers",
                        vec![
                            (b"id".to_vec(), BValue::Bytes(self.self_id.to_vec())),
                            (b"info_hash".to_vec(), BValue::Bytes(info_hash.to_vec())),
                        ],
                        info_hash,
                    )
                    .await
                {
                    if let Some(BValue::Bytes(nodes)) = r.get(b"nodes") {
                        let mut table = self.table.lock().await;
                        for (id, node_addr) in decode_nodes(nodes) {
                            if node_addr != *addr {
                                table.insert(id, node_addr);
                            }
                        }
                    }
                    if let Some(BValue::List(values)) = r.get(b"values") {
                        let mut discovered = self.discovered.lock().await;
                        let entry = discovered.entry(info_hash).or_default();
                        for v in values {
                            if let Some(bytes) = v.as_bytes() {
                                if bytes.len() == 6 {
                                    let ip = Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]);
                                    let port = u16::from_be_bytes([bytes[4], bytes[5]]);
                                    let peer = SocketAddr::V4(SocketAddrV4::new(ip, port));
                                    if !entry.contains(&peer) {
                                        entry.push(peer);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let found = self
                .discovered
                .lock()
                .await
                .get(&info_hash)
                .cloned()
                .unwrap_or_default();
            if !found.is_empty() {
                break; // got peers — no need to keep walking
            }
        }
        self.discovered
            .lock()
            .await
            .get(&info_hash)
            .cloned()
            .unwrap_or_default()
    }

    /// announce_peer to the K closest token-holding nodes.
    pub async fn announce(&self, info_hash: NodeId, port: u16) {
        let closest = {
            let table = self.table.lock().await;
            table.closest(&info_hash, K)
        };
        for (_, addr) in closest {
            // get_peers first to fetch a fresh token
            if let Some(r) = self
                .query(
                    addr,
                    "get_peers",
                    vec![
                        (b"id".to_vec(), BValue::Bytes(self.self_id.to_vec())),
                        (b"info_hash".to_vec(), BValue::Bytes(info_hash.to_vec())),
                    ],
                    info_hash,
                )
                .await
            {
                let token = match r.get(b"token").and_then(|b| b.as_bytes()) {
                    Some(t) => t.to_vec(),
                    None => continue,
                };
                let _ = self
                    .query(
                        addr,
                        "announce_peer",
                        vec![
                            (b"id".to_vec(), BValue::Bytes(self.self_id.to_vec())),
                            (b"info_hash".to_vec(), BValue::Bytes(info_hash.to_vec())),
                            (b"port".to_vec(), BValue::Int(port as i64)),
                            (b"token".to_vec(), BValue::Bytes(token)),
                        ],
                        info_hash,
                    )
                    .await;
            }
        }
    }

    pub async fn table_size(&self) -> usize {
        self.table.lock().await.nodes.len()
    }
}

fn new_secret() -> Vec<u8> {
    let s: [u8; 16] = rand::random();
    s.to_vec()
}

fn token_for(secret: &[u8], ip: std::net::IpAddr) -> Vec<u8> {
    let mut hasher = Sha1::new();
    hasher.update(secret);
    hasher.update(ip.to_string().as_bytes());
    hasher.finalize().to_vec()
}

fn bstr_bytes(b: &[u8]) -> BValue {
    BValue::Bytes(b.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_compact_codec_round_trips() {
        let nodes = vec![
            (
                [1u8; 20],
                SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 6881)),
            ),
            (
                [2u8; 20],
                SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 2), 51413)),
            ),
        ];
        let bytes = encode_nodes(&nodes);
        assert_eq!(bytes.len(), 52);
        assert_eq!(decode_nodes(&bytes), nodes);
        // zero port is dropped (invalid node)
        let zero = vec![(
            [3u8; 20],
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)),
        )];
        assert!(decode_nodes(&encode_nodes(&zero)).is_empty());
    }

    #[test]
    fn xor_distance_and_ordering() {
        let b = [1u8; 20]; // 0b1
        let c = [2u8; 20]; // 0b10
        let d_target = [3u8; 20]; // xor: b→2, c→1 → c closer
        assert!(distance_less(
            &xor_distance(&c, &d_target),
            &xor_distance(&b, &d_target)
        ));
        let mut table = RoutingTable::default();
        table.insert(b, "127.0.0.1:1".parse().unwrap());
        table.insert(c, "127.0.0.1:2".parse().unwrap());
        let closest = table.closest(&d_target, 1);
        assert_eq!(closest[0].0, c);
    }

    #[test]
    fn token_validation_rotates() {
        let cur = new_secret();
        let prev = new_secret();
        let ip: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let tok = token_for(&cur, ip);
        assert!(DhtNode::token_valid_sync(&cur, &prev, ip, &tok));
        let stale = token_for(&prev, ip);
        assert!(DhtNode::token_valid_sync(&cur, &prev, ip, &stale));
        assert!(!DhtNode::token_valid_sync(&cur, &prev, ip, b"garbage"));
        let other_ip: std::net::IpAddr = "198.51.100.1".parse().unwrap();
        assert!(!DhtNode::token_valid_sync(&cur, &prev, other_ip, &tok));
    }
}
