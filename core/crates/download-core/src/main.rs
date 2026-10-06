//! download-core entry point.
//!
//! stdin : one JSON request envelope per line (protocol v1)
//! stdout: one JSON response/event envelope per line (logs NEVER go here)
//! stderr: structured logs (tracing)
//!
//! The DB path arrives via UNIDM_DB (set by the supervising Electron main process);
//! UNIDM_MAX_CONCURRENT carries the user's parallel-downloads setting.

use std::sync::Arc;

use tokio::sync::mpsc;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let db_path = std::env::var("UNIDM_DB").unwrap_or_else(|_| "unidm-core.db".into());
    let max_concurrent = std::env::var("UNIDM_MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 8);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");
    runtime.block_on(run(db_path, max_concurrent));
}

async fn run(db_path: String, max_concurrent: usize) {
    let store = match dc_storage::JobStore::open(std::path::Path::new(&db_path)) {
        Ok(s) => Arc::new(s),
        Err(err) => {
            eprintln!("fatal: cannot open database {db_path}: {err}");
            std::process::exit(1);
        }
    };

    // Single JSONL writer owns stdout; engine events and RPC responses share it.
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<String>();
    spawn_stdout_writer(outbound_rx);

    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<dc_protocol::EventEnvelope>();
    let manager = download_core::JobManager::new(store, events_tx);
    manager.set_max_concurrent(max_concurrent);

    // Bridge engine events into the shared outbound writer.
    let bridge_tx = outbound_tx.clone();
    tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            if let Ok(mut json) = serde_json::to_string(&event) {
                json.push('\n');
                if bridge_tx.send(json).is_err() {
                    break;
                }
            }
        }
    });

    // OS signals → persist + exit (data integrity before anything else).
    {
        let manager_for_signal = manager.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
                let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
                tokio::select! {
                    _ = term.recv() => {},
                    _ = int.recv() => {},
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            tracing::info!("signal received — persisting and exiting");
            manager_for_signal.shutdown().await;
            std::process::exit(0);
        });
    }

    // Advertise readiness before serving requests.
    let ready = dc_protocol::make_event(
        "core.ready",
        Some(serde_json::json!({
            "contractVersion": dc_protocol::CONTRACT_VERSION,
            "protocolVersion": dc_protocol::PROTOCOL_VERSION,
        })),
    );
    if let Ok(mut json) = serde_json::to_string(&ready) {
        json.push('\n');
        let _ = outbound_tx.send(json);
    }

    download_core::server::serve(tokio::io::stdin(), manager, outbound_tx).await;
}

fn spawn_stdout_writer(mut rx: mpsc::UnboundedReceiver<String>) {
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break; // parent closed the pipe — nothing sane left to do
            }
            let _ = stdout.flush().await;
        }
    });
}
