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
];

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
                               speed_bps, eta_seconds, error_code, headers_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
                        headers_json=?15, updated_at=?16
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
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
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
