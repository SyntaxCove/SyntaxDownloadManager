//! dc-storage — the persistent layer owned exclusively by download-core.
//!
//! rusqlite (bundled SQLite) guarded by a Mutex; schema evolved through ordered migrations
//! recorded in `schema_migrations`. All times are epoch milliseconds, all IDs are ULIDs.

use dc_protocol::job::DownloadJob;
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
];

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
                               queue_position, speed_limit_kbps)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
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
                        queue_position=?24, speed_limit_kbps=?25
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn wrap_sqlite(context: impl std::fmt::Display) -> impl Fn(rusqlite::Error) -> ContractError {
    move |e| ContractError::new(ErrorCode::StorageError, format!("{context}: {e}"))
}
