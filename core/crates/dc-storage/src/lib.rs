//! dc-storage — the persistent layer owned exclusively by download-core.
//!
//! rusqlite (bundled SQLite) guarded by a Mutex; schema evolved through ordered migrations
//! recorded in `schema_migrations`. All times are epoch milliseconds, all IDs are ULIDs.

use dc_protocol::browser::{Bookmark, HistoryEntry};
use dc_protocol::job::DownloadJob;
use dc_protocol::media::MediaJob;
use dc_protocol::scheduler::SchedulerJob;
use dc_protocol::torrent::{TorrentFileEntry, TorrentJob, TorrentSourceKind};
use dc_protocol::{ContractError, ErrorCode};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::sync::Mutex;

pub type StorageResult<T> = Result<T, ContractError>;

const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    "CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        url             TEXT NOT NULL,
        destination_dir TEXT NOT NULL,
        destination_path TEXT,
        filename        TEXT,
        status          TEXT NOT NULL,
        total_bytes     INTEGER,
        received_bytes  INTEGER NOT NULL DEFAULT 0,
        etag            TEXT,
        last_modified   TEXT,
        content_type    TEXT,
        speed_bps       INTEGER,
        eta_seconds     INTEGER,
        error_code      TEXT,
        headers_json    TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);",
    // v2 (Phase 6): per-segment journal + integrity columns.
    "ALTER TABLE jobs ADD COLUMN checksum_algorithm TEXT;
     ALTER TABLE jobs ADD COLUMN checksum_expected TEXT;
     ALTER TABLE jobs ADD COLUMN checksum_actual TEXT;
     ALTER TABLE jobs ADD COLUMN checksum_verified INTEGER;
     ALTER TABLE jobs ADD COLUMN segment_count INTEGER;
     CREATE TABLE IF NOT EXISTS segments (
        job_id        TEXT NOT NULL,
        seg_index     INTEGER NOT NULL,
        start_offset  INTEGER NOT NULL,
        end_offset    INTEGER,
        written_bytes INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        PRIMARY KEY (job_id, seg_index)
     );
     CREATE INDEX IF NOT EXISTS idx_segments_job ON segments(job_id);",
    // v3 (Phase 7): recovery engine audit trail (rebind count + last rebind timestamp).
    "ALTER TABLE jobs ADD COLUMN recovery_count INTEGER;
     ALTER TABLE jobs ADD COLUMN rebound_at INTEGER;",
    // v4 (Phase 8): queue management + per-job bandwidth cap.
    "ALTER TABLE jobs ADD COLUMN queue_position INTEGER;
     ALTER TABLE jobs ADD COLUMN speed_limit_kbps INTEGER;",
    // v5 (Phase 9): per-job proxy routing. Only the profile ID is persisted — credentials
    // live in main's keychain-backed store and are pushed to the core's memory at runtime.
    "ALTER TABLE jobs ADD COLUMN proxy_profile_id TEXT;",
    // v6 (Phase 12): persistent media pipeline jobs (inspect → stream downloads → mux).
    // A separate table: media jobs are page-URL-sourced composite pipelines, not HTTP range
    // downloads; their lifecycle, columns and recovery semantics differ by design.
    "CREATE TABLE IF NOT EXISTS media_jobs (
        id              TEXT PRIMARY KEY,
        source_url      TEXT NOT NULL,
        title           TEXT,
        thumbnail_url   TEXT,
        video_format_id TEXT,
        audio_format_id TEXT,
        filename        TEXT,
        subtitles_json  TEXT NOT NULL DEFAULT '[]',
        container       TEXT NOT NULL,
        destination_dir TEXT NOT NULL,
        destination_path TEXT,
        work_dir        TEXT,
        status          TEXT NOT NULL,
        total_bytes     INTEGER,
        received_bytes  INTEGER NOT NULL DEFAULT 0,
        speed_bps       INTEGER,
        eta_seconds     INTEGER,
        error_code      TEXT,
        proxy_profile_id TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at DESC);",
    // v7 (Phase 13): persistent torrent engine jobs. A separate table: torrent jobs are
    // swarm-sourced (no expiring URL), verified per-piece by SHA-1, and resume from the
    // persisted have bitmap — lifecycle columns differ from HTTP jobs by design.
    "CREATE TABLE IF NOT EXISTS torrent_jobs (
        id               TEXT PRIMARY KEY,
        source_kind      TEXT NOT NULL,
        source_uri       TEXT NOT NULL,
        name             TEXT,
        info_hash        TEXT,
        destination_dir  TEXT NOT NULL,
        status           TEXT NOT NULL,
        total_bytes      INTEGER,
        received_bytes   INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes   INTEGER NOT NULL DEFAULT 0,
        num_pieces       INTEGER,
        piece_length     INTEGER,
        have_blob        BLOB,
        metainfo_blob    BLOB,
        files_json       TEXT NOT NULL DEFAULT '[]',
        trackers_json    TEXT NOT NULL DEFAULT '[]',
        error_code       TEXT,
        proxy_profile_id TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_torrent_jobs_status ON torrent_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_torrent_jobs_created_at ON torrent_jobs(created_at DESC);",
    // v8 (Phase 14): browser history + bookmarks. The core owns ALL persistent user data;
    // main records settled main-frame http(s) visits fire-and-forget. History is pruned to
    // MAX_HISTORY_ROWS at the write path, so the table stays bounded forever.
    "CREATE TABLE IF NOT EXISTS browser_history (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        title       TEXT,
        favicon_url TEXT,
        visited_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_visited ON browser_history(visited_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_url ON browser_history(url);
    CREATE TABLE IF NOT EXISTS bookmarks (
        id         TEXT PRIMARY KEY,
        url        TEXT NOT NULL,
        title      TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_position ON bookmarks(position);",
    // v9 (Phase 15): persistent scheduler jobs. The core fires them from a 1 s tick;
    // the persisted next_run_at makes catch-up-after-restart automatic. The payload is
    // the target method's params object (opaque JSON here, validated per kind upstream).
    // wall_anchor is the anchor's naive local ms (start_at + tz offset at set time) —
    // recurring slots advance in wall clock so DST/travel changes snap back to the same
    // local time when main re-pushes the offset.
    "CREATE TABLE IF NOT EXISTS scheduler_jobs (
        id                  TEXT PRIMARY KEY,
        kind                TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        start_at            INTEGER NOT NULL,
        wall_anchor         INTEGER NOT NULL,
        repeat              TEXT NOT NULL,
        enabled             INTEGER NOT NULL,
        next_run_at         INTEGER,
        last_fired_at       INTEGER,
        last_result_code    TEXT,
        last_result_message TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_due ON scheduler_jobs(enabled, next_run_at);",
];

/// History rows kept after each insert (oldest beyond the cap are pruned in the same
/// transaction — the table can never grow past this, no matter how long the app runs).
pub const MAX_HISTORY_ROWS: i64 = 50_000;

/// One journal row of the per-segment download state (Phase 6).
/// `end_offset == None` marks the append-mode single window (open-ended stream).
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentRow {
    pub seg_index: u64,
    pub start_offset: u64,
    pub end_offset: Option<u64>,
    pub written_bytes: u64,
    /// "pending" | "downloading" | "done"
    pub status: String,
}

pub struct JobStore {
    conn: Mutex<Connection>,
}

impl JobStore {
    /// Open (or create) the database and apply pending migrations.
    pub fn open(path: &Path) -> StorageResult<Self> {
        let conn = Connection::open(path).map_err(wrap_sqlite("open database"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(wrap_sqlite("set journal_mode"))?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(wrap_sqlite("set synchronous"))?; // data integrity outranks write speed
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(wrap_sqlite("set foreign_keys"))?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory().map_err(wrap_sqlite("open memory database"))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )
        .map_err(wrap_sqlite("create schema_migrations"))?;

        let current: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .map_err(wrap_sqlite("read schema version"))?;

        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            let version = (idx + 1) as i64;
            if version <= current {
                continue;
            }
            conn.execute_batch("BEGIN IMMEDIATE;")
                .and_then(|_| conn.execute_batch(sql))
                .and_then(|_| {
                    conn.execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                        params![version, now_ms()],
                    )
                })
                .and_then(|_| conn.execute_batch("COMMIT;"))
                .map_err(|e| {
                    let _ = conn.execute_batch("ROLLBACK;");
                    wrap_sqlite(format!("migration {version}"))(e)
                })?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> StorageResult<i64> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .map_err(wrap_sqlite("read schema version"))
    }

    pub fn insert_job(&self, job: &DownloadJob) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO jobs (id, url, destination_dir, destination_path, filename, status,
                               total_bytes, received_bytes, etag, last_modified, content_type,
                               speed_bps, eta_seconds, error_code, headers_json, created_at, updated_at,
                               checksum_algorithm, checksum_expected, checksum_actual, checksum_verified,
                               segment_count, recovery_count, rebound_at,
                               queue_position, speed_limit_kbps, proxy_profile_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
            params![
                job.id.as_str(),
                job.url,
                job.destination_dir,
                job.destination_path,
                job.filename,
                job.status,
                job.total_bytes.map(|v| v as i64),
                job.received_bytes as i64,
                job.etag,
                job.last_modified,
                job.content_type,
                job.speed_bps.map(|v| v as i64),
                job.eta_seconds.map(|v| v as i64),
                job.error_code,
                headers_to_json(&job.headers),
                job.created_at,
                job.updated_at,
                job.checksum_algorithm.map(|a| a.as_str().to_string()),
                job.checksum_expected,
                job.checksum_actual,
                job.checksum_verified.map(|v| v as i64),
                job.segment_count.map(|v| v as i64),
                job.recovery_count.map(|v| v as i64),
                job.rebound_at,
                job.queue_position.map(|v| v as i64),
                job.speed_limit_kbps.map(|v| v as i64),
                job.proxy_profile_id,
            ],
        )
        .map_err(wrap_sqlite("insert job"))?;
        Ok(())
    }

    pub fn get_job(&self, id: &str) -> StorageResult<Option<DownloadJob>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT * FROM jobs WHERE id = ?1",
            params![id],
            job_from_row,
        )
        .optional()
        .map_err(wrap_sqlite("get job"))
    }

    pub fn list_jobs(&self) -> StorageResult<Vec<DownloadJob>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
            .map_err(wrap_sqlite("list jobs"))?;
        let rows = stmt
            .query_map([], job_from_row)
            .map_err(wrap_sqlite("list jobs"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list jobs"))
    }

    pub fn update_job(&self, job: &DownloadJob) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE jobs SET url=?2, destination_dir=?3, destination_path=?4, filename=?5,
                        status=?6, total_bytes=?7, received_bytes=?8, etag=?9, last_modified=?10,
                        content_type=?11, speed_bps=?12, eta_seconds=?13, error_code=?14,
                        headers_json=?15, updated_at=?16,
                        checksum_algorithm=?17, checksum_expected=?18, checksum_actual=?19,
                        checksum_verified=?20, segment_count=?21,
                        recovery_count=?22, rebound_at=?23,
                        queue_position=?24, speed_limit_kbps=?25, proxy_profile_id=?26
                 WHERE id=?1",
                params![
                    job.id.as_str(),
                    job.url,
                    job.destination_dir,
                    job.destination_path,
                    job.filename,
                    job.status,
                    job.total_bytes.map(|v| v as i64),
                    job.received_bytes as i64,
                    job.etag,
                    job.last_modified,
                    job.content_type,
                    job.speed_bps.map(|v| v as i64),
                    job.eta_seconds.map(|v| v as i64),
                    job.error_code,
                    headers_to_json(&job.headers),
                    job.updated_at,
                    job.checksum_algorithm.map(|a| a.as_str().to_string()),
                    job.checksum_expected,
                    job.checksum_actual,
                    job.checksum_verified.map(|v| v as i64),
                    job.segment_count.map(|v| v as i64),
                    job.recovery_count.map(|v| v as i64),
                    job.rebound_at,
                    job.queue_position.map(|v| v as i64),
                    job.speed_limit_kbps.map(|v| v as i64),
                    job.proxy_profile_id,
                ],
            )
            .map_err(wrap_sqlite("update job"))?;
        if n == 0 {
            return Err(ContractError::new(ErrorCode::InvalidState, "job not found"));
        }
        Ok(())
    }

    /// Lightweight progress tick — avoids rewriting validator columns.
    pub fn update_progress(
        &self,
        id: &str,
        received: u64,
        speed_bps: u64,
        eta_seconds: Option<u64>,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE jobs SET received_bytes=?2, speed_bps=?3, eta_seconds=?4, updated_at=?5 WHERE id=?1",
            params![id, received as i64, speed_bps as i64, eta_seconds.map(|v| v as i64), now_ms()],
        )
        .map_err(wrap_sqlite("update progress"))?;
        Ok(())
    }

    pub fn delete_job(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM jobs WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete job"))?;
        Ok(n > 0)
    }

    // ---- per-segment journal (Phase 6) ----

    /// Atomically replace the journal with a fresh plan (all segments pending, 0 written).
    pub fn replace_segments(&self, job_id: &str, segments: &[SegmentRow]) -> StorageResult<()> {
        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction().map_err(wrap_sqlite("segment tx"))?;
        tx.execute("DELETE FROM segments WHERE job_id = ?1", params![job_id])
            .map_err(wrap_sqlite("segment reset"))?;
        for s in segments {
            tx.execute(
                "INSERT INTO segments (job_id, seg_index, start_offset, end_offset, written_bytes, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    job_id,
                    s.seg_index as i64,
                    s.start_offset as i64,
                    s.end_offset.map(|v| v as i64),
                    s.written_bytes as i64,
                    s.status,
                ],
            )
            .map_err(wrap_sqlite("segment insert"))?;
        }
        tx.commit().map_err(wrap_sqlite("segment commit"))?;
        Ok(())
    }

    /// Journal rows for a job, ordered by segment index.
    pub fn list_segments(&self, job_id: &str) -> StorageResult<Vec<SegmentRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT seg_index, start_offset, end_offset, written_bytes, status
                 FROM segments WHERE job_id = ?1 ORDER BY seg_index ASC",
            )
            .map_err(wrap_sqlite("list segments"))?;
        let rows = stmt
            .query_map(params![job_id], |row| {
                Ok(SegmentRow {
                    seg_index: row.get::<_, i64>(0)?.max(0) as u64,
                    start_offset: row.get::<_, i64>(1)?.max(0) as u64,
                    end_offset: row.get::<_, Option<i64>>(2)?.map(|v| v.max(0) as u64),
                    written_bytes: row.get::<_, i64>(3)?.max(0) as u64,
                    status: row.get(4)?,
                })
            })
            .map_err(wrap_sqlite("list segments"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list segments"))
    }

    /// Advance one segment's durable write cursor. Call AFTER the bytes are on disk
    /// (the journal must never lead the file).
    pub fn update_segment_progress(
        &self,
        job_id: &str,
        seg_index: u64,
        written_bytes: u64,
        status: &str,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE segments SET written_bytes = ?3, status = ?4
             WHERE job_id = ?1 AND seg_index = ?2",
            params![job_id, seg_index as i64, written_bytes as i64, status],
        )
        .map_err(wrap_sqlite("update segment"))?;
        Ok(())
    }

    pub fn delete_segments(&self, job_id: &str) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute("DELETE FROM segments WHERE job_id = ?1", params![job_id])
            .map_err(wrap_sqlite("delete segments"))?;
        Ok(())
    }

    // ---- media pipeline jobs (Phase 12) ----

    pub fn insert_media_job(&self, job: &MediaJob) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO media_jobs (id, source_url, title, thumbnail_url, video_format_id,
                                     audio_format_id, filename, subtitles_json, container,
                                     destination_dir, destination_path, work_dir, status,
                                     total_bytes, received_bytes, speed_bps, eta_seconds,
                                     error_code, proxy_profile_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                job.id.as_str(),
                job.source_url,
                job.title,
                job.thumbnail_url,
                job.video_format_id,
                job.audio_format_id,
                job.filename,
                subtitles_to_json(&job.subtitles),
                job.container.as_str(),
                job.destination_dir,
                job.destination_path,
                job.work_dir,
                job.status,
                job.total_bytes.map(|v| v as i64),
                job.received_bytes as i64,
                job.speed_bps.map(|v| v as i64),
                job.eta_seconds.map(|v| v as i64),
                job.error_code,
                job.proxy_profile_id,
                job.created_at,
                job.updated_at,
            ],
        )
        .map_err(wrap_sqlite("insert media job"))?;
        Ok(())
    }

    pub fn get_media_job(&self, id: &str) -> StorageResult<Option<MediaJob>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT * FROM media_jobs WHERE id = ?1",
            params![id],
            media_job_from_row,
        )
        .optional()
        .map_err(wrap_sqlite("get media job"))
    }

    pub fn list_media_jobs(&self) -> StorageResult<Vec<MediaJob>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT * FROM media_jobs ORDER BY created_at DESC")
            .map_err(wrap_sqlite("list media jobs"))?;
        let rows = stmt
            .query_map([], media_job_from_row)
            .map_err(wrap_sqlite("list media jobs"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list media jobs"))
    }

    pub fn update_media_job(&self, job: &MediaJob) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE media_jobs SET source_url=?2, title=?3, thumbnail_url=?4,
                        video_format_id=?5, audio_format_id=?6, filename=?7,
                        subtitles_json=?8, container=?9, destination_dir=?10,
                        destination_path=?11, work_dir=?12, status=?13, total_bytes=?14,
                        received_bytes=?15, speed_bps=?16, eta_seconds=?17, error_code=?18,
                        proxy_profile_id=?19, updated_at=?20
                 WHERE id=?1",
                params![
                    job.id.as_str(),
                    job.source_url,
                    job.title,
                    job.thumbnail_url,
                    job.video_format_id,
                    job.audio_format_id,
                    job.filename,
                    subtitles_to_json(&job.subtitles),
                    job.container.as_str(),
                    job.destination_dir,
                    job.destination_path,
                    job.work_dir,
                    job.status,
                    job.total_bytes.map(|v| v as i64),
                    job.received_bytes as i64,
                    job.speed_bps.map(|v| v as i64),
                    job.eta_seconds.map(|v| v as i64),
                    job.error_code,
                    job.proxy_profile_id,
                    job.updated_at,
                ],
            )
            .map_err(wrap_sqlite("update media job"))?;
        if n == 0 {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "media job not found",
            ));
        }
        Ok(())
    }

    /// Lightweight progress tick for an active media run.
    pub fn update_media_progress(
        &self,
        id: &str,
        received: u64,
        total: Option<u64>,
        speed_bps: u64,
        eta_seconds: Option<u64>,
        status: &str,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE media_jobs SET received_bytes=?2, total_bytes=?3, speed_bps=?4,
                    eta_seconds=?5, status=?6, updated_at=?7 WHERE id=?1",
            params![
                id,
                received as i64,
                total.map(|v| v as i64),
                speed_bps as i64,
                eta_seconds.map(|v| v as i64),
                status,
                now_ms(),
            ],
        )
        .map_err(wrap_sqlite("update media progress"))?;
        Ok(())
    }

    pub fn delete_media_job(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM media_jobs WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete media job"))?;
        Ok(n > 0)
    }

    /// Boot recovery: no media job may look active after a core restart (the fresh process
    /// owns no child yt-dlp/ffmpeg). Queued rows pause too — a fresh core never auto-starts
    /// media jobs (the same baseline rule the Phase 8 queue pump established). Returns the
    /// number of reset rows.
    pub fn reset_active_media_jobs(&self) -> StorageResult<usize> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE media_jobs SET status='paused', speed_bps=NULL, eta_seconds=NULL,
                        updated_at=?1
                 WHERE status IN ('queued','extracting','downloading','muxing')",
                params![now_ms()],
            )
            .map_err(wrap_sqlite("reset active media jobs"))?;
        Ok(n)
    }

    // ---- torrent engine jobs (Phase 13) ----

    pub fn insert_torrent_job(&self, job: &TorrentJobRow) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO torrent_jobs (id, source_kind, source_uri, name, info_hash,
                                       destination_dir, status, total_bytes, received_bytes,
                                       uploaded_bytes, num_pieces, piece_length, have_blob,
                                       metainfo_blob, files_json, trackers_json, error_code,
                                       proxy_profile_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                job.id.as_str(),
                job.source_kind.as_str(),
                job.source_uri,
                job.name,
                job.info_hash,
                job.destination_dir,
                job.status,
                job.total_bytes.map(|v| v as i64),
                job.received_bytes as i64,
                job.uploaded_bytes as i64,
                job.num_pieces.map(|v| v as i64),
                job.piece_length.map(|v| v as i64),
                job.have_blob,
                job.metainfo_blob,
                files_to_json(&job.files),
                trackers_to_json(&job.trackers),
                job.error_code,
                job.proxy_profile_id,
                job.created_at,
                job.updated_at,
            ],
        )
        .map_err(wrap_sqlite("insert torrent job"))?;
        Ok(())
    }

    pub fn get_torrent_job(&self, id: &str) -> StorageResult<Option<TorrentJobRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT * FROM torrent_jobs WHERE id = ?1",
            params![id],
            torrent_job_from_row,
        )
        .optional()
        .map_err(wrap_sqlite("get torrent job"))
    }

    pub fn list_torrent_jobs(&self) -> StorageResult<Vec<TorrentJobRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT * FROM torrent_jobs ORDER BY created_at DESC")
            .map_err(wrap_sqlite("list torrent jobs"))?;
        let rows = stmt
            .query_map([], torrent_job_from_row)
            .map_err(wrap_sqlite("list torrent jobs"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list torrent jobs"))
    }

    pub fn update_torrent_job(&self, job: &TorrentJobRow) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE torrent_jobs SET source_kind=?2, source_uri=?3, name=?4, info_hash=?5,
                        destination_dir=?6, status=?7, total_bytes=?8, received_bytes=?9,
                        uploaded_bytes=?10, num_pieces=?11, piece_length=?12, have_blob=?13,
                        metainfo_blob=?14, files_json=?15, trackers_json=?16, error_code=?17,
                        proxy_profile_id=?18, updated_at=?19
                 WHERE id=?1",
                params![
                    job.id.as_str(),
                    job.source_kind.as_str(),
                    job.source_uri,
                    job.name,
                    job.info_hash,
                    job.destination_dir,
                    job.status,
                    job.total_bytes.map(|v| v as i64),
                    job.received_bytes as i64,
                    job.uploaded_bytes as i64,
                    job.num_pieces.map(|v| v as i64),
                    job.piece_length.map(|v| v as i64),
                    job.have_blob,
                    job.metainfo_blob,
                    files_to_json(&job.files),
                    trackers_to_json(&job.trackers),
                    job.error_code,
                    job.proxy_profile_id,
                    job.updated_at,
                ],
            )
            .map_err(wrap_sqlite("update torrent job"))?;
        if n == 0 {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "torrent job not found",
            ));
        }
        Ok(())
    }

    /// Lightweight progress tick for an active torrent (have bitmap included so a crash
    /// costs at most the un-persisted tail of verified pieces — re-verification is
    /// idempotent, integrity is never at risk).
    pub fn update_torrent_progress(
        &self,
        id: &str,
        received_bytes: u64,
        uploaded_bytes: u64,
        have_blob: Option<&[u8]>,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE torrent_jobs SET received_bytes=?2, uploaded_bytes=?3,
                    have_blob=COALESCE(?4, have_blob), updated_at=?5 WHERE id=?1",
            params![
                id,
                received_bytes as i64,
                uploaded_bytes as i64,
                have_blob,
                now_ms()
            ],
        )
        .map_err(wrap_sqlite("update torrent progress"))?;
        Ok(())
    }

    pub fn delete_torrent_job(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM torrent_jobs WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete torrent job"))?;
        Ok(n > 0)
    }

    /// Boot recovery: a fresh core never auto-starts torrents (Phase 8 baseline rule).
    pub fn reset_active_torrent_jobs(&self) -> StorageResult<usize> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE torrent_jobs SET status='paused', updated_at=?1
                 WHERE status IN ('queued','metadata','downloading','seeding')",
                params![now_ms()],
            )
            .map_err(wrap_sqlite("reset active torrent jobs"))?;
        Ok(n)
    }

    // ---- browser history + bookmarks (Phase 14, storage v8) ----

    /// Insert one visit and prune the table back to `MAX_HISTORY_ROWS` inside the same
    /// connection scope — the cap is enforced at the write path, never best-effort.
    /// The prune keeps the most recently *recorded* 50 000 rows via an O(k) rowid range
    /// delete (an index walk per insert would make every write O(n) — worse than the cap
    /// it enforces; listing still orders by visit time, so backdated rows age out
    /// naturally as newer visits arrive).
    pub fn insert_history_entry(&self, entry: &HistoryEntry) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO browser_history (id, url, title, favicon_url, visited_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                entry.id.as_str(),
                entry.url,
                entry.title,
                entry.favicon_url,
                entry.visited_at,
            ],
        )
        .map_err(wrap_sqlite("insert history entry"))?;
        conn.execute(
            "DELETE FROM browser_history WHERE rowid <= ?1 - ?2",
            params![conn.last_insert_rowid(), MAX_HISTORY_ROWS],
        )
        .map_err(wrap_sqlite("prune history"))?;
        Ok(())
    }

    /// Newest-first page of history; `query` is a case-insensitive substring match against
    /// url and title. Rows tie-broken by rowid so same-ms visits keep insertion order.
    pub fn list_history(
        &self,
        query: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> StorageResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let pattern = query.map(|q| format!("%{}%", q.to_lowercase()));
        let sql = match pattern.is_some() {
            true => {
                "SELECT * FROM browser_history
                     WHERE lower(url) LIKE ?1 OR lower(COALESCE(title, '')) LIKE ?1
                     ORDER BY visited_at DESC, rowid DESC LIMIT ?2 OFFSET ?3"
            }
            false => {
                "SELECT * FROM browser_history
                      ORDER BY visited_at DESC, rowid DESC LIMIT ?1 OFFSET ?2"
            }
        };
        let mut stmt = conn.prepare(sql).map_err(wrap_sqlite("list history"))?;
        let map_row = |row: &Row<'_>| -> rusqlite::Result<HistoryEntry> {
            Ok(HistoryEntry {
                id: dc_protocol::Ulid(row.get::<_, String>("id")?),
                url: row.get("url")?,
                title: row.get("title")?,
                favicon_url: row.get("favicon_url")?,
                visited_at: row.get("visited_at")?,
            })
        };
        let rows = if let Some(p) = &pattern {
            stmt.query_map(params![p, limit, offset], map_row)
        } else {
            stmt.query_map(params![limit, offset], map_row)
        }
        .map_err(wrap_sqlite("list history"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list history"))
    }

    pub fn delete_history_entry(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM browser_history WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete history entry"))?;
        Ok(n > 0)
    }

    /// Clear everything, or only visits strictly before `before` (epoch ms). Returns rows removed.
    pub fn clear_history(&self, before: Option<i64>) -> StorageResult<usize> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = match before {
            Some(ts) => conn
                .execute(
                    "DELETE FROM browser_history WHERE visited_at < ?1",
                    params![ts],
                )
                .map_err(wrap_sqlite("clear history"))?,
            None => conn
                .execute("DELETE FROM browser_history", [])
                .map_err(wrap_sqlite("clear history"))?,
        };
        Ok(n)
    }

    pub fn count_history(&self) -> StorageResult<i64> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row("SELECT COUNT(*) FROM browser_history", [], |r| r.get(0))
            .map_err(wrap_sqlite("count history"))
    }

    /// Append a bookmark at the end of the flat list. The position is computed as max+1
    /// inside the same transaction — the caller's `position` field is ignored.
    pub fn insert_bookmark(&self, bookmark: &Bookmark) -> StorageResult<Bookmark> {
        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction().map_err(wrap_sqlite("bookmark tx"))?;
        let next: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks",
                [],
                |r| r.get(0),
            )
            .map_err(wrap_sqlite("next bookmark position"))?;
        tx.execute(
            "INSERT INTO bookmarks (id, url, title, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                bookmark.id.as_str(),
                bookmark.url,
                bookmark.title,
                next,
                bookmark.created_at,
                bookmark.updated_at,
            ],
        )
        .map_err(wrap_sqlite("insert bookmark"))?;
        tx.commit().map_err(wrap_sqlite("bookmark tx commit"))?;
        Ok(Bookmark {
            position: next,
            ..bookmark.clone()
        })
    }

    /// All bookmarks in list order (position ASC; ties by insertion order).
    pub fn list_bookmarks(&self) -> StorageResult<Vec<Bookmark>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT * FROM bookmarks ORDER BY position ASC, rowid ASC")
            .map_err(wrap_sqlite("list bookmarks"))?;
        let rows = stmt
            .query_map([], bookmark_from_row)
            .map_err(wrap_sqlite("list bookmarks"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list bookmarks"))
    }

    /// First bookmark (lowest position) whose URL matches exactly — the address-bar star's
    /// source of truth.
    pub fn get_bookmark_by_url(&self, url: &str) -> StorageResult<Option<Bookmark>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT * FROM bookmarks WHERE url = ?1 ORDER BY position ASC, rowid ASC LIMIT 1",
            params![url],
            bookmark_from_row,
        )
        .optional()
        .map_err(wrap_sqlite("get bookmark by url"))
    }

    /// Rename/re-URL a bookmark; at least one field must be present (enforced main-side and
    /// re-checked here). Bumps `updated_at`; returns the updated row.
    pub fn update_bookmark(
        &self,
        id: &str,
        title: Option<&str>,
        url: Option<&str>,
    ) -> StorageResult<Bookmark> {
        if title.is_none() && url.is_none() {
            return Err(ContractError::new(
                ErrorCode::InvalidParams,
                "bookmark update requires title or url",
            ));
        }
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE bookmarks SET
                    title = COALESCE(?2, title),
                    url   = COALESCE(?3, url),
                    updated_at = ?4
                 WHERE id = ?1",
                params![id, title, url, now_ms()],
            )
            .map_err(wrap_sqlite("update bookmark"))?;
        if n == 0 {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "bookmark not found",
            ));
        }
        conn.query_row(
            "SELECT * FROM bookmarks WHERE id = ?1",
            params![id],
            bookmark_from_row,
        )
        .map_err(wrap_sqlite("reload bookmark"))
    }

    pub fn delete_bookmark(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete bookmark"))?;
        Ok(n > 0)
    }

    // ---- scheduler jobs (Phase 15) ----

    pub fn insert_scheduler_job(&self, job: &SchedulerJobRow) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO scheduler_jobs (id, kind, payload_json, start_at, wall_anchor,
                                        repeat, enabled, next_run_at, last_fired_at,
                                        last_result_code, last_result_message, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                job.id.as_str(),
                job.kind,
                payload_to_json(&job.payload),
                job.start_at,
                job.wall_anchor,
                job.repeat,
                job.enabled as i64,
                job.next_run_at,
                job.last_fired_at,
                job.last_result_code,
                job.last_result_message,
                job.created_at,
                job.updated_at,
            ],
        )
        .map_err(wrap_sqlite("insert scheduler job"))?;
        Ok(())
    }

    pub fn get_scheduler_job(&self, id: &str) -> StorageResult<Option<SchedulerJobRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.query_row(
            "SELECT * FROM scheduler_jobs WHERE id = ?1",
            params![id],
            scheduler_job_from_row,
        )
        .optional()
        .map_err(wrap_sqlite("get scheduler job"))
    }

    /// All scheduler jobs, newest first (the UI list).
    pub fn list_scheduler_jobs(&self) -> StorageResult<Vec<SchedulerJobRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT * FROM scheduler_jobs ORDER BY created_at DESC, id ASC")
            .map_err(wrap_sqlite("list scheduler jobs"))?;
        let rows = stmt
            .query_map([], scheduler_job_from_row)
            .map_err(wrap_sqlite("list scheduler jobs"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list scheduler jobs"))
    }

    /// Due jobs in fire order: enabled + next_run_at <= now, oldest due first (the tick
    /// fires sequentially so a catch-up burst replays the schedule in order).
    pub fn list_due_scheduler_jobs(&self, now: i64) -> StorageResult<Vec<SchedulerJobRow>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT * FROM scheduler_jobs
                 WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
                 ORDER BY next_run_at ASC, id ASC",
            )
            .map_err(wrap_sqlite("list due scheduler jobs"))?;
        let rows = stmt
            .query_map(params![now], scheduler_job_from_row)
            .map_err(wrap_sqlite("list due scheduler jobs"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(wrap_sqlite("list due scheduler jobs"))
    }

    pub fn update_scheduler_job(&self, job: &SchedulerJobRow) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute(
                "UPDATE scheduler_jobs SET kind=?2, payload_json=?3, start_at=?4,
                        wall_anchor=?5, repeat=?6, enabled=?7, next_run_at=?8,
                        last_fired_at=?9, last_result_code=?10, last_result_message=?11,
                        updated_at=?12
                 WHERE id=?1",
                params![
                    job.id.as_str(),
                    job.kind,
                    payload_to_json(&job.payload),
                    job.start_at,
                    job.wall_anchor,
                    job.repeat,
                    job.enabled as i64,
                    job.next_run_at,
                    job.last_fired_at,
                    job.last_result_code,
                    job.last_result_message,
                    job.updated_at,
                ],
            )
            .map_err(wrap_sqlite("update scheduler job"))?;
        if n == 0 {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                "scheduler job not found",
            ));
        }
        Ok(())
    }

    pub fn delete_scheduler_job(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let n = conn
            .execute("DELETE FROM scheduler_jobs WHERE id = ?1", params![id])
            .map_err(wrap_sqlite("delete scheduler job"))?;
        Ok(n > 0)
    }
}

/// The persisted scheduler row — the wire shape plus the core-internal wall anchor.
/// `wall_anchor` is the anchor's naive local ms (start_at expressed under the tz offset
/// that was current when the anchor was set); recurring slots advance in wall clock so a
/// DST/travel change snaps future fires back to the same local time.
#[derive(Debug, Clone, PartialEq)]
pub struct SchedulerJobRow {
    pub id: dc_protocol::Ulid,
    /// Closed action set (validated by the manager before insert/dispatch).
    pub kind: String,
    /// Opaque action payload — the target method's params object.
    pub payload: serde_json::Value,
    /// Epoch ms of the schedule anchor (first occurrence).
    pub start_at: i64,
    /// Naive local ms of the same anchor (offset-free recurrence space).
    pub wall_anchor: i64,
    /// none | daily | weekly.
    pub repeat: String,
    pub enabled: bool,
    /// Epoch ms of the next due fire; null = nothing scheduled.
    pub next_run_at: Option<i64>,
    pub last_fired_at: Option<i64>,
    /// "ok" or a classified error code; null = never fired.
    pub last_result_code: Option<String>,
    pub last_result_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl SchedulerJobRow {
    /// Project onto the wire shape (wall_anchor stays core-internal).
    pub fn to_wire(&self) -> SchedulerJob {
        SchedulerJob {
            id: self.id.clone(),
            kind: self.kind.clone(),
            payload: self.payload.clone(),
            start_at: self.start_at,
            repeat: self.repeat.clone(),
            enabled: self.enabled,
            next_run_at: self.next_run_at,
            last_fired_at: self.last_fired_at,
            last_result_code: self.last_result_code.clone(),
            last_result_message: self.last_result_message.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// The persisted torrent row — everything the engine needs to reconstruct a session.
/// Runtime-only values (speeds, peer counts, eta) are derived live, never stored.
#[derive(Debug, Clone, PartialEq)]
pub struct TorrentJobRow {
    pub id: dc_protocol::Ulid,
    pub source_kind: TorrentSourceKind,
    /// Magnet URI (magnet jobs); empty for .torrent jobs (the blob is authoritative).
    pub source_uri: String,
    pub name: Option<String>,
    /// 40-char lowercase hex; null for magnets until metadata arrives.
    pub info_hash: Option<String>,
    pub destination_dir: String,
    pub status: String,
    pub total_bytes: Option<u64>,
    pub received_bytes: u64,
    pub uploaded_bytes: u64,
    pub num_pieces: Option<u64>,
    pub piece_length: Option<u64>,
    /// Persisted have bitmap (per-piece verification state).
    pub have_blob: Option<Vec<u8>>,
    /// Exact metainfo bytes (.torrent file or metadata fetched from the swarm).
    pub metainfo_blob: Option<Vec<u8>>,
    pub files: Vec<TorrentFileEntry>,
    pub trackers: Vec<String>,
    pub error_code: Option<String>,
    pub proxy_profile_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TorrentJobRow {
    /// Project onto the wire shape (runtime fields zeroed — the caller overlays live state).
    pub fn to_wire(&self) -> TorrentJob {
        TorrentJob {
            id: self.id.clone(),
            name: self.name.clone(),
            status: self.status.clone(),
            source_kind: self.source_kind,
            info_hash: self.info_hash.clone(),
            destination_dir: self.destination_dir.clone(),
            total_bytes: self.total_bytes,
            received_bytes: self.received_bytes,
            uploaded_bytes: self.uploaded_bytes,
            download_speed_bps: 0,
            upload_speed_bps: 0,
            peers: 0,
            seeds: 0,
            eta_seconds: None,
            num_pieces: self.num_pieces,
            piece_length: self.piece_length,
            files: self.files.clone(),
            error_code: self.error_code.clone(),
            proxy_profile_id: self.proxy_profile_id.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

fn files_to_json(files: &[TorrentFileEntry]) -> String {
    serde_json::to_string(files).unwrap_or_else(|_| "[]".to_string())
}

fn trackers_to_json(trackers: &[String]) -> String {
    serde_json::to_string(trackers).unwrap_or_else(|_| "[]".to_string())
}

fn parse_source_kind(s: &str) -> TorrentSourceKind {
    match s {
        "magnet" => TorrentSourceKind::Magnet,
        _ => TorrentSourceKind::Torrent,
    }
}

fn torrent_job_from_row(row: &Row<'_>) -> rusqlite::Result<TorrentJobRow> {
    let files_json: String = row.get("files_json")?;
    let files: Vec<TorrentFileEntry> = serde_json::from_str(&files_json).unwrap_or_default();
    let trackers_json: String = row.get("trackers_json")?;
    let trackers: Vec<String> = serde_json::from_str(&trackers_json).unwrap_or_default();
    Ok(TorrentJobRow {
        id: dc_protocol::Ulid(row.get::<_, String>("id")?),
        source_kind: parse_source_kind(&row.get::<_, String>("source_kind")?),
        source_uri: row.get("source_uri")?,
        name: row.get("name")?,
        info_hash: row.get("info_hash")?,
        destination_dir: row.get("destination_dir")?,
        status: row.get("status")?,
        total_bytes: row
            .get::<_, Option<i64>>("total_bytes")?
            .map(|v| v.max(0) as u64),
        received_bytes: row.get::<_, i64>("received_bytes")?.max(0) as u64,
        uploaded_bytes: row.get::<_, i64>("uploaded_bytes")?.max(0) as u64,
        num_pieces: row
            .get::<_, Option<i64>>("num_pieces")?
            .map(|v| v.max(0) as u64),
        piece_length: row
            .get::<_, Option<i64>>("piece_length")?
            .map(|v| v.max(0) as u64),
        have_blob: row.get("have_blob")?,
        metainfo_blob: row.get("metainfo_blob")?,
        files,
        trackers,
        error_code: row.get("error_code")?,
        proxy_profile_id: row.get("proxy_profile_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn subtitles_to_json(subtitles: &[dc_protocol::MediaSubtitleSelection]) -> String {
    serde_json::to_string(subtitles).unwrap_or_else(|_| "[]".to_string())
}

fn parse_container(s: &str) -> dc_protocol::MediaContainer {
    match s {
        "mp4" => dc_protocol::MediaContainer::Mp4,
        _ => dc_protocol::MediaContainer::Mkv,
    }
}

fn media_job_from_row(row: &Row<'_>) -> rusqlite::Result<MediaJob> {
    let subtitles_json: String = row.get("subtitles_json")?;
    let subtitles: Vec<dc_protocol::MediaSubtitleSelection> =
        serde_json::from_str(&subtitles_json).unwrap_or_default();
    Ok(MediaJob {
        id: dc_protocol::Ulid(row.get::<_, String>("id")?),
        source_url: row.get("source_url")?,
        title: row.get("title")?,
        thumbnail_url: row.get("thumbnail_url")?,
        video_format_id: row.get("video_format_id")?,
        audio_format_id: row.get("audio_format_id")?,
        filename: row.get("filename")?,
        subtitles,
        container: parse_container(&row.get::<_, String>("container")?),
        destination_dir: row.get("destination_dir")?,
        destination_path: row.get("destination_path")?,
        work_dir: row.get("work_dir")?,
        status: row.get("status")?,
        total_bytes: row
            .get::<_, Option<i64>>("total_bytes")?
            .map(|v| v.max(0) as u64),
        received_bytes: row.get::<_, i64>("received_bytes")?.max(0) as u64,
        speed_bps: row
            .get::<_, Option<i64>>("speed_bps")?
            .map(|v| v.max(0) as u64),
        eta_seconds: row
            .get::<_, Option<i64>>("eta_seconds")?
            .map(|v| v.max(0) as u64),
        error_code: row.get("error_code")?,
        proxy_profile_id: row.get("proxy_profile_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn job_from_row(row: &Row<'_>) -> rusqlite::Result<DownloadJob> {
    Ok(DownloadJob {
        id: dc_protocol::Ulid(row.get::<_, String>("id")?),
        url: row.get("url")?,
        destination_dir: row.get("destination_dir")?,
        destination_path: row.get("destination_path")?,
        filename: row.get("filename")?,
        status: row.get("status")?,
        total_bytes: row
            .get::<_, Option<i64>>("total_bytes")?
            .map(|v| v.max(0) as u64),
        received_bytes: row.get::<_, i64>("received_bytes")?.max(0) as u64,
        etag: row.get("etag")?,
        last_modified: row.get("last_modified")?,
        content_type: row.get("content_type")?,
        speed_bps: row
            .get::<_, Option<i64>>("speed_bps")?
            .map(|v| v.max(0) as u64),
        eta_seconds: row
            .get::<_, Option<i64>>("eta_seconds")?
            .map(|v| v.max(0) as u64),
        error_code: row.get("error_code")?,
        headers: row
            .get::<_, Option<String>>("headers_json")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok()),
        segment_count: row
            .get::<_, Option<i64>>("segment_count")
            .ok()
            .flatten()
            .map(|v| v.max(0) as u64),
        checksum_algorithm: row
            .get::<_, Option<String>>("checksum_algorithm")
            .ok()
            .flatten()
            .and_then(|s| parse_checksum_algorithm(&s)),
        checksum_expected: row
            .get::<_, Option<String>>("checksum_expected")
            .ok()
            .flatten(),
        checksum_actual: row
            .get::<_, Option<String>>("checksum_actual")
            .ok()
            .flatten(),
        checksum_verified: row
            .get::<_, Option<i64>>("checksum_verified")
            .ok()
            .flatten()
            .map(|v| v != 0),
        recovery_count: row
            .get::<_, Option<i64>>("recovery_count")
            .ok()
            .flatten()
            .map(|v| v.max(0) as u64),
        rebound_at: row.get::<_, Option<i64>>("rebound_at").ok().flatten(),
        queue_position: row
            .get::<_, Option<i64>>("queue_position")
            .ok()
            .flatten()
            .map(|v| v.max(0) as u64),
        speed_limit_kbps: row
            .get::<_, Option<i64>>("speed_limit_kbps")
            .ok()
            .flatten()
            .map(|v| v.max(0) as u64),
        proxy_profile_id: row
            .get::<_, Option<String>>("proxy_profile_id")
            .ok()
            .flatten(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn parse_checksum_algorithm(s: &str) -> Option<dc_protocol::ChecksumAlgorithm> {
    match s {
        "sha256" => Some(dc_protocol::ChecksumAlgorithm::Sha256),
        "sha1" => Some(dc_protocol::ChecksumAlgorithm::Sha1),
        "md5" => Some(dc_protocol::ChecksumAlgorithm::Md5),
        _ => None,
    }
}

fn headers_to_json(headers: &Option<std::collections::HashMap<String, String>>) -> Option<String> {
    match headers {
        Some(map) if !map.is_empty() => serde_json::to_string(map).ok(),
        _ => None,
    }
}

fn bookmark_from_row(row: &Row<'_>) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: dc_protocol::Ulid(row.get::<_, String>("id")?),
        url: row.get("url")?,
        title: row.get("title")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn payload_to_json(payload: &serde_json::Value) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string())
}

fn scheduler_job_from_row(row: &Row<'_>) -> rusqlite::Result<SchedulerJobRow> {
    let payload_json: String = row.get("payload_json")?;
    let payload: serde_json::Value =
        serde_json::from_str(&payload_json).unwrap_or(serde_json::json!({}));
    Ok(SchedulerJobRow {
        id: dc_protocol::Ulid(row.get::<_, String>("id")?),
        kind: row.get("kind")?,
        payload,
        start_at: row.get("start_at")?,
        wall_anchor: row.get("wall_anchor")?,
        repeat: row.get("repeat")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        next_run_at: row.get("next_run_at")?,
        last_fired_at: row.get("last_fired_at")?,
        last_result_code: row.get("last_result_code")?,
        last_result_message: row.get("last_result_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn wrap_sqlite(context: impl std::fmt::Display) -> impl Fn(rusqlite::Error) -> ContractError {
    move |e| ContractError::new(ErrorCode::StorageError, format!("{context}: {e}"))
}
