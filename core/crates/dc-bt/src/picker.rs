//! Piece picker — 16 KiB blocks, rarest-first with random tiebreak, endgame dedup,
//! bitfield plumbing (BEP 3 MSB-first bit order).

use rand::seq::SliceRandom;
use rand::SeedableRng;

pub const BLOCK_LEN: u32 = 16 * 1024;

/// MSB-first bit bitmap (BEP 3 bitfield semantics): byte 0 bit 0 = piece 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    bits: Vec<u8>,
    len: usize,
}

impl Bitmap {
    pub fn new(len: usize) -> Self {
        Self {
            bits: vec![0; len.div_ceil(8)],
            len,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn get(&self, idx: usize) -> bool {
        if idx >= self.len {
            return false;
        }
        self.bits[idx / 8] & (0x80 >> (idx % 8)) != 0
    }

    pub fn set(&mut self, idx: usize) {
        if idx < self.len {
            self.bits[idx / 8] |= 0x80 >> (idx % 8);
        }
    }

    pub fn clear(&mut self, idx: usize) {
        if idx < self.len {
            self.bits[idx / 8] &= !(0x80 >> (idx % 8));
        }
    }

    pub fn count(&self) -> usize {
        self.bits.iter().map(|b| b.count_ones() as usize).sum()
    }

    pub fn is_full(&self) -> bool {
        self.count() == self.len
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bits
    }

    /// Indices of set bits, ascending.
    pub fn indices(&self) -> Vec<usize> {
        (0..self.len).filter(|&i| self.get(i)).collect()
    }

    /// Parse a wire bitfield (extra trailing bits must be zero, BEP 3).
    pub fn parse(bytes: &[u8], piece_count: usize) -> Option<Bitmap> {
        if bytes.len() != piece_count.div_ceil(8) {
            return None;
        }
        let mut bm = Bitmap::new(piece_count);
        for i in 0..piece_count {
            if bytes[i / 8] & (0x80 >> (i % 8)) != 0 {
                bm.set(i);
            }
        }
        // spare low bits of the last byte must be zero
        if !piece_count.is_multiple_of(8) {
            let spill = 8 - piece_count % 8;
            let spill_mask: u8 = ((1u16 << spill) - 1) as u8;
            if bytes[piece_count / 8] & spill_mask != 0 {
                return None;
            }
        }
        Some(bm)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BlockReq {
    pub piece: u32,
    pub offset: u32,
    pub len: u32,
}

#[derive(Debug)]
pub struct PiecePicker {
    piece_count: usize,
    piece_len: u32,
    total_size: u64,
    /// Completed (hash-verified) pieces.
    have: Bitmap,
    /// Rarity: how many connected peers have each piece.
    availability: Vec<u32>,
    /// Blocks requested but not yet received (across peers; endgame allows duplicates).
    in_flight: std::collections::HashSet<BlockReq>,
    /// Pieces whose block sets were started but are incomplete (for on_piece_failed).
    partial: std::collections::HashMap<u32, std::collections::HashSet<u32>>,
    rng: rand::rngs::StdRng,
}

impl PiecePicker {
    pub fn new(piece_count: usize, piece_len: u32, total_size: u64) -> Self {
        Self::with_seed(piece_count, piece_len, total_size, rand::random())
    }

    pub fn with_seed(piece_count: usize, piece_len: u32, total_size: u64, seed: u64) -> Self {
        Self {
            piece_count,
            piece_len,
            total_size,
            have: Bitmap::new(piece_count),
            availability: vec![0; piece_count],
            in_flight: std::collections::HashSet::new(),
            partial: std::collections::HashMap::new(),
            rng: rand::rngs::StdRng::seed_from_u64(seed),
        }
    }

    pub fn piece_len_of(&self, piece: u32) -> u32 {
        if piece as usize + 1 == self.piece_count {
            let rem = self.total_size % self.piece_len as u64;
            if rem == 0 {
                self.piece_len
            } else {
                rem as u32
            }
        } else {
            self.piece_len
        }
    }

    pub fn have(&self) -> &Bitmap {
        &self.have
    }

    pub fn have_count(&self) -> usize {
        self.have.count()
    }

    pub fn is_complete(&self) -> bool {
        self.have.is_full()
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    /// Endgame mode: every block of every missing piece is already in flight, so further
    /// progress requires re-requesting blocks from other peers. Computed on demand —
    /// never stored, so it can never go stale.
    pub fn is_endgame(&self) -> bool {
        if self.is_complete() {
            return false;
        }
        let mut missing_blocks = 0u64;
        for p in 0..self.piece_count as u32 {
            if !self.have.get(p as usize) {
                missing_blocks += self.blocks_per_piece(p) as u64;
            }
        }
        missing_blocks > 0 && self.in_flight.len() as u64 >= missing_blocks
    }

    pub fn blocks_per_piece(&self, piece: u32) -> u32 {
        self.piece_len_of(piece).div_ceil(BLOCK_LEN)
    }

    // ---- peer availability ----

    pub fn peer_bitfield(&mut self, bytes: &[u8]) -> Option<Bitmap> {
        let bm = Bitmap::parse(bytes, self.piece_count)?;
        for idx in bm.indices() {
            self.availability[idx] += 1;
        }
        Some(bm)
    }

    pub fn peer_have(&mut self, piece: u32) {
        if (piece as usize) < self.piece_count {
            self.availability[piece as usize] += 1;
        }
    }

    pub fn peer_left(&mut self, peer: &Bitmap) {
        for idx in peer.indices() {
            self.availability[idx] = self.availability[idx].saturating_sub(1);
        }
    }

    // ---- completion ----

    /// Mark a block received; returns true when the piece is fully assembled.
    pub fn on_block(&mut self, piece: u32, offset: u32) -> bool {
        if self.have.get(piece as usize) {
            return false;
        }
        let blocks = self.blocks_per_piece(piece);
        let done = {
            let entry = self.partial.entry(piece).or_default();
            entry.insert(offset);
            entry.len() as u32 == blocks
        };
        if done {
            self.partial.remove(&piece);
        }
        done
    }

    /// Piece hash failed: forget its blocks so it can be re-requested.
    pub fn on_piece_failed(&mut self, piece: u32) {
        self.partial.remove(&piece);
        let plen = self.piece_len_of(piece);
        for b in 0..plen.div_ceil(BLOCK_LEN) {
            self.in_flight.remove(&BlockReq {
                piece,
                offset: b * BLOCK_LEN,
                len: Self::block_len(plen, b * BLOCK_LEN),
            });
        }
    }

    /// Piece verified and persisted.
    pub fn on_piece_done(&mut self, piece: u32) {
        self.have.set(piece as usize);
        self.partial.remove(&piece);
        let plen = self.piece_len_of(piece);
        for b in 0..plen.div_ceil(BLOCK_LEN) {
            self.in_flight.remove(&BlockReq {
                piece,
                offset: b * BLOCK_LEN,
                len: Self::block_len(plen, b * BLOCK_LEN),
            });
        }
    }

    /// Seed the picker from a persisted have-map (resume path).
    pub fn restore_have(&mut self, bytes: &[u8]) {
        if let Some(bm) = Bitmap::parse(bytes, self.piece_count) {
            self.have = bm;
        }
    }

    pub fn have_bytes(&self) -> Vec<u8> {
        self.have.bytes().to_vec()
    }

    fn block_len(piece_len: u32, offset: u32) -> u32 {
        (piece_len - offset).min(BLOCK_LEN)
    }

    /// Pick up to `n` blocks the given peer can serve.
    ///
    /// Normal mode: never re-requests an in-flight block. Endgame: in-flight blocks from
    /// OTHER pieces may be re-requested (caller dedups/cancels on arrival); blocks already
    /// requested from this exact peer are still skipped via `peer_in_flight`.
    pub fn pick(
        &mut self,
        peer_have: &Bitmap,
        n: usize,
        peer_in_flight: &std::collections::HashSet<BlockReq>,
    ) -> Vec<BlockReq> {
        if self.is_complete() || n == 0 {
            return Vec::new();
        }
        let mut candidates: Vec<usize> = (0..self.piece_count)
            .filter(|&i| !self.have.get(i) && peer_have.get(i))
            .collect();
        // rarest-first with random tiebreak: shuffle then stable-sort by availability
        candidates.shuffle(&mut self.rng);
        candidates.sort_by_key(|&i| self.availability[i]);

        let mut out = Vec::with_capacity(n);
        // Pass 1: unrequested blocks (rarest first).
        for &piece in &candidates {
            let plen = self.piece_len_of(piece as u32);
            for b in 0..plen.div_ceil(BLOCK_LEN) {
                let offset = b * BLOCK_LEN;
                let len = Self::block_len(plen, offset);
                let req = BlockReq {
                    piece: piece as u32,
                    offset,
                    len,
                };
                if self.in_flight.contains(&req) || peer_in_flight.contains(&req) {
                    continue;
                }
                out.push(req);
                if out.len() == n {
                    return out;
                }
            }
        }
        // Pass 2 (endgame only): re-request in-flight blocks not already pending on this peer.
        if self.is_endgame() {
            for &piece in &candidates {
                let plen = self.piece_len_of(piece as u32);
                for b in 0..plen.div_ceil(BLOCK_LEN) {
                    let offset = b * BLOCK_LEN;
                    let len = Self::block_len(plen, offset);
                    let req = BlockReq {
                        piece: piece as u32,
                        offset,
                        len,
                    };
                    if peer_in_flight.contains(&req) {
                        continue;
                    }
                    if self.in_flight.contains(&req) && !out.contains(&req) {
                        out.push(req);
                        if out.len() == n {
                            return out;
                        }
                    }
                }
            }
        }
        out
    }

    /// Track a block request as outstanding (caller invokes right after sending Request).
    pub fn mark_requested(&mut self, req: &BlockReq) {
        self.in_flight.insert(*req);
    }

    /// A request was answered with a Piece (or canceled): normal mode only clears on
    /// arrival; Cancel clears immediately.
    pub fn mark_canceled(&mut self, req: &BlockReq) {
        self.in_flight.remove(req);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picker() -> PiecePicker {
        // 4 pieces × 32 KiB, last piece 32 KiB (total 128 KiB)
        PiecePicker::with_seed(4, 32 * 1024, 128 * 1024, 42)
    }

    fn full_bitfield(have: &[usize], count: usize) -> Bitmap {
        let mut bm = Bitmap::new(count);
        for &i in have {
            bm.set(i);
        }
        bm
    }

    #[test]
    fn bitmap_wire_semantics() {
        let mut bm = Bitmap::new(10);
        bm.set(0);
        bm.set(9);
        assert_eq!(bm.bytes().len(), 2);
        assert_eq!(bm.bytes()[0], 0x80);
        assert_eq!(bm.bytes()[1], 0x40);
        assert_eq!(bm.count(), 2);
        let parsed = Bitmap::parse(b"\x80\x40", 10).unwrap();
        assert_eq!(parsed, bm);
        // spare bits set → invalid
        assert!(Bitmap::parse(b"\x80\x41", 10).is_none());
        assert!(Bitmap::parse(b"\x80", 10).is_none(), "wrong length");
    }

    #[test]
    fn rarest_first_orders_by_availability_with_tiebreak() {
        let mut p = picker();
        // peer A has pieces 0,1; peer B has piece 0
        let a = full_bitfield(&[0, 1], 4);
        let b = full_bitfield(&[0], 4);
        p.peer_bitfield(a.bytes());
        p.peer_bitfield(b.bytes());
        // availability: piece0=2, piece1=1, piece2=0, piece3=0
        let peer_c = full_bitfield(&[0, 1, 2, 3], 4);
        let reqs = p.pick(&peer_c, 16, &Default::default());
        // first block must come from a rarest piece (2 or 3, tie-broken randomly)
        assert!(reqs[0].piece == 2 || reqs[0].piece == 3);
        // then piece 1, then piece 0
        let pieces: Vec<u32> = reqs.iter().map(|r| r.piece).collect();
        assert!(
            pieces.iter().filter(|&&x| x == 2).count() == 2,
            "piece 2 fully requested"
        );
        assert!(pieces.iter().filter(|&&x| x == 1).count() == 2);
        assert!(pieces.iter().filter(|&&x| x == 0).count() == 2);
        // last piece short: 4 pieces × 32 KiB → all blocks 16 KiB
        assert!(reqs.iter().all(|r| r.len == BLOCK_LEN));
    }

    #[test]
    fn blocks_do_not_duplicate_until_endgame() {
        let mut p = picker();
        let peer = full_bitfield(&[0, 1, 2, 3], 4);
        p.peer_bitfield(peer.bytes());
        let first = p.pick(&peer, 4, &Default::default());
        assert_eq!(first.len(), 4);
        for r in &first {
            p.mark_requested(r);
        }
        assert!(!p.is_endgame(), "half-requested is not endgame");
        let second = p.pick(&peer, 4, &Default::default());
        for r in &second {
            assert!(!first.contains(r), "no duplicate requests before endgame");
            p.mark_requested(r);
        }
        assert!(p.is_endgame(), "all 8 missing blocks are in flight");
        // complete pieces 0,1,2 → in_flight shrinks to the two piece-3 blocks
        for piece in 0..3u32 {
            for b in 0..2u32 {
                let r = BlockReq {
                    piece,
                    offset: b * BLOCK_LEN,
                    len: BLOCK_LEN,
                };
                let complete = p.on_block(piece, r.offset);
                p.mark_canceled(&r);
                assert_eq!(
                    complete,
                    b == 1,
                    "piece completes exactly on its last block"
                );
                if b == 1 {
                    p.on_piece_done(piece);
                }
            }
        }
        assert_eq!(p.in_flight_count(), 2);
        assert!(p.is_endgame());
        let again = p.pick(&peer, 8, &Default::default());
        assert_eq!(again.len(), 2, "endgame re-requests both piece-3 blocks");
        assert!(again.iter().all(|r| r.piece == 3));
        // a peer already serving one of them does not get it twice
        let mut pending = std::collections::HashSet::new();
        pending.insert(again[0]);
        let dedup = p.pick(&peer, 8, &pending);
        assert!(!dedup.contains(&again[0]));
    }

    #[test]
    fn on_block_detects_piece_completion() {
        let mut p = picker();
        // 32 KiB piece = 2 blocks
        assert!(!p.on_block(0, 0));
        assert!(p.on_block(0, BLOCK_LEN));
    }

    #[test]
    fn piece_failure_clears_state() {
        let mut p = picker();
        let peer = full_bitfield(&[0], 4);
        p.peer_bitfield(peer.bytes());
        let reqs = p.pick(&peer, 2, &Default::default());
        for r in &reqs {
            p.mark_requested(r);
        }
        p.on_piece_failed(0);
        assert_eq!(p.in_flight_count(), 0, "failed piece releases its requests");
        let again = p.pick(&peer, 4, &Default::default());
        assert_eq!(again.len(), 2);
    }

    #[test]
    fn last_piece_is_short() {
        let p = PiecePicker::with_seed(4, 32 * 1024, 100 * 1024, 1);
        assert_eq!(p.piece_len_of(3), 100 * 1024 - 3 * 32 * 1024);
        assert_eq!(p.piece_len_of(0), 32 * 1024);
        assert_eq!(p.blocks_per_piece(3), 1);
    }

    #[test]
    fn restore_have_resumes() {
        let mut p = picker();
        let mut bm = Bitmap::new(4);
        bm.set(0);
        bm.set(2);
        p.restore_have(bm.bytes());
        assert_eq!(p.have_count(), 2);
        assert!(!p.is_complete());
        let peer = full_bitfield(&[0, 1, 2, 3], 4);
        p.peer_bitfield(peer.bytes());
        let reqs = p.pick(&peer, 100, &Default::default());
        assert!(reqs.iter().all(|r| r.piece == 1 || r.piece == 3));
    }
}
