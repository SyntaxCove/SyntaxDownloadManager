//! JobManager — owns the engine, per-job tasks and the active-jobs queue.
//!
//! Concurrency policy: at most `max_concurrent` tasks run at once (main pushes the user's
//! parallel-downloads setting); queued jobs are pumped automatically when a slot frees.
//! Resume: paused/canceled/failed jobs flip to `queued` and the pump starts them when a
//! slot is available — the engine then continues from the persisted `.part` byte count.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use dc_protocol::job::DownloadJob;
use dc_protocol::{ContractError, ErrorCode};
use dc_storage::JobStore;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::{now_ms, CreateJobParams, Engine, EventsTx, JobCommand};

struct JobHandle {
    cmd_tx: mpsc::Sender<JobCommand>,
    stop: CancellationToken,
}

pub struct JobManager {
    store: Arc<JobStore>,
    engine: Arc<Engine>,
    jobs: Mutex<HashMap<String, JobHandle>>,
    max_concurrent: AtomicUsize,
}
impl JobManager {
    pub fn new(store: Arc<JobStore>, events: EventsTx) -> Arc<Self> {
        let engine = Arc::new(Engine::new(store.clone(), events));
        Arc::new(Self {
            store,
            engine,
            jobs: Mutex::new(HashMap::new()),
            max_concurrent: AtomicUsize::new(3),
        })
    }

    pub fn set_max_concurrent(self: &Arc<Self>, max: usize) {
        self.max_concurrent.store(max, Ordering::SeqCst);
        self.pump();
    }

    /// Connections per download (Phase 6): affects newly planned runs.
    pub fn set_max_connections(self: &Arc<Self>, max: usize) {
        self.engine.set_max_connections(max);
    }

    pub async fn create(
        self: &Arc<Self>,
        params: CreateJobParams,
    ) -> Result<DownloadJob, ContractError> {
        let job = self.engine.create_job(params).await?;
        self.pump();
        Ok(job)
    }

    pub fn list(&self) -> Result<Vec<DownloadJob>, ContractError> {
        self.store.list_jobs()
    }

    pub fn get(&self, id: &str) -> Result<Option<DownloadJob>, ContractError> {
        self.store.get_job(id)
    }

    pub async fn pause(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        self.send_command(id, JobCommand::Pause, |status| {
            matches!(status, "queued" | "probing" | "downloading")
        })
        .await
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        let mut job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !matches!(job.status.as_str(), "paused" | "canceled" | "failed") {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot resume a job in status {}", job.status),
            ));
        }
        job.status = "queued".into();
        job.error_code = None;
        job.updated_at = now_ms();
        self.store.update_job(&job)?;
        self.engine.emit_job(&job);
        self.pump();
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Result<DownloadJob, ContractError> {
        self.send_command(id, JobCommand::Cancel, |status| {
            matches!(status, "queued" | "probing" | "downloading")
        })
        .await
    }

    pub async fn remove(
        self: &Arc<Self>,
        id: &str,
        delete_partial_file: bool,
    ) -> Result<(), ContractError> {
        // Read before delete so the `.part` sidecar can be located.
        let job = self.store.get_job(id)?;
        let handle = {
            let jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.get(id).map(|h| (h.cmd_tx.clone(), h.stop.clone()))
        };
        if let Some((cmd_tx, stop)) = handle {
            let _ = cmd_tx.send(JobCommand::Cancel).await;
            stop.cancel();
            self.jobs.lock().expect("jobs mutex poisoned").remove(id);
        }
        if !self.store.delete_job(id)? {
            return Err(ContractError::new(ErrorCode::InvalidState, "job not found"));
        }
        if delete_partial_file {
            if let Some(job) = job {
                if let Some(path) = job.destination_path {
                    let part = PathBuf::from(format!("{path}.part"));
                    let _ = tokio::fs::remove_file(&part).await; // best effort
                }
            }
        }
        self.pump();
        Ok(())
    }

    /// Graceful shutdown: stop all tasks (each persists its final pre-shutdown state).
    pub async fn shutdown(&self) {
        let handles: Vec<(mpsc::Sender<JobCommand>, CancellationToken)> = self
            .jobs
            .lock()
            .expect("jobs mutex poisoned")
            .values()
            .map(|h| (h.cmd_tx.clone(), h.stop.clone()))
            .collect();
        for (cmd_tx, stop) in handles {
            let _ = cmd_tx.send(JobCommand::Pause).await;
            stop.cancel();
        }
    }

    async fn send_command(
        self: &Arc<Self>,
        id: &str,
        cmd: JobCommand,
        allowed: fn(&str) -> bool,
    ) -> Result<DownloadJob, ContractError> {
        let job = self
            .store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::InvalidState, "job not found"))?;
        if !allowed(&job.status) {
            return Err(ContractError::new(
                ErrorCode::InvalidState,
                format!("cannot {} a job in status {}", cmd_name(cmd), job.status),
            ));
        }
        let handle = {
            let jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.get(id).map(|h| (h.cmd_tx.clone(), h.stop.clone()))
        };
        match handle {
            Some((cmd_tx, _)) => {
                cmd_tx.send(cmd).await.map_err(|_| {
                    ContractError::new(ErrorCode::InternalError, "job task is not running")
                })?;
            }
            None => {
                // Task not running (e.g. queued or pump-pending): flip status directly.
                let mut job = job;
                job.status = match cmd {
                    JobCommand::Pause => "paused".to_string(),
                    JobCommand::Cancel => "canceled".to_string(),
                };
                job.updated_at = now_ms();
                self.store.update_job(&job)?;
                self.engine.emit_job(&job);
            }
        }
        self.store
            .get_job(id)?
            .ok_or_else(|| ContractError::new(ErrorCode::StorageError, "job vanished"))
    }

    /// Start queued jobs while free slots exist; prune finished tasks.
    fn pump(self: &Arc<Self>) {
        let max = self.max_concurrent.load(Ordering::SeqCst);
        let running = {
            let mut jobs = self.jobs.lock().expect("jobs mutex poisoned");
            jobs.retain(|_, h| !h.stop.is_cancelled());
            jobs.len()
        };
        if running >= max {
            return;
        }
        let Ok(all) = self.store.list_jobs() else {
            return;
        };
        let mut slots = max - running;
        for job in all {
            if slots == 0 {
                break;
            }
            if job.status == "queued" {
                let already = self
                    .jobs
                    .lock()
                    .expect("jobs mutex poisoned")
                    .contains_key(job.id.as_str());
                if !already {
                    self.spawn_task(job);
                    slots -= 1;
                }
            }
        }
    }

    /// Spawn the engine task; on completion the task removes itself and pumps the queue.
    fn spawn_task(self: &Arc<Self>, job: DownloadJob) {
        let id = job.id.as_str().to_string();
        let (cmd_tx, cmd_rx) = mpsc::channel::<JobCommand>(8);
        let stop = CancellationToken::new();
        let engine = self.engine.clone();
        let manager = self.clone();

        self.jobs.lock().expect("jobs mutex poisoned").insert(
            id.clone(),
            JobHandle {
                cmd_tx,
                stop: stop.clone(),
            },
        );

        tokio::spawn(async move {
            engine.run_job(job, cmd_rx, stop).await;
            manager
                .jobs
                .lock()
                .expect("jobs mutex poisoned")
                .remove(&id);
            manager.pump();
        });
    }
}

fn cmd_name(cmd: JobCommand) -> &'static str {
    match cmd {
        JobCommand::Pause => "pause",
        JobCommand::Cancel => "cancel",
    }
}
