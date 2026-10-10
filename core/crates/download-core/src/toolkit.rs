//! Toolkit paths runtime (Phase 10) — mirror of the ProxyMap pattern.
//!
//! Main pushes ONLY checksum-proven, activated executable paths here (`toolkit.setPaths`,
//! full replace). Later phases (media inspect/extract/merge) resolve external tools through
//! this map instead of ever probing `PATH` — a tool that was never verified by main is
//! invisible to the core, fail-closed.

use dc_protocol::{ContractError, ErrorCode, ToolkitPathEntry};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory toolkit map, replaced wholesale by `toolkit.setPaths`.
#[derive(Default)]
pub struct ToolkitMap {
    inner: Mutex<HashMap<String, ToolkitPathEntry>>,
}

/// `toolkit.setPaths` params as deserialized from the wire (camelCase keys are single words).
#[derive(Debug, Deserialize)]
pub struct SetToolkitPathsParams {
    pub tools: Vec<ToolkitPathEntry>,
}

impl ToolkitMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Full replace (main is the single source of truth). The whole set is staged and
    /// validated FIRST — duplicate ids or empty fields reject the push without leaving a
    /// partial replacement behind, and a rejected push never blanks the live map.
    pub fn replace(&self, tools: Vec<ToolkitPathEntry>) -> Result<(), ContractError> {
        let mut staged: HashMap<String, ToolkitPathEntry> = HashMap::with_capacity(tools.len());
        for t in tools {
            if t.id.is_empty() || t.path.is_empty() {
                return Err(ContractError::new(
                    ErrorCode::InvalidParams,
                    "toolkit path entry has an empty id or path",
                ));
            }
            if staged.contains_key(&t.id) {
                return Err(ContractError::new(
                    ErrorCode::InvalidParams,
                    format!("duplicate toolkit id: {}", t.id),
                ));
            }
            staged.insert(t.id.clone(), t);
        }
        let mut map = self.inner.lock().expect("toolkit map mutex poisoned");
        *map = staged;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<ToolkitPathEntry> {
        self.inner
            .lock()
            .expect("toolkit map mutex poisoned")
            .get(id)
            .cloned()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("toolkit map mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, path: &str) -> ToolkitPathEntry {
        ToolkitPathEntry {
            id: id.into(),
            version: "1.0.0".into(),
            path: path.into(),
        }
    }

    #[test]
    fn replaces_wholesale_and_resolves() {
        let map = ToolkitMap::new();
        assert!(map.is_empty());
        map.replace(vec![
            entry("yt-dlp", "/opt/t/yt-dlp"),
            entry("ffmpeg", "/opt/t/ffmpeg"),
        ])
        .unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("yt-dlp").unwrap().path, "/opt/t/yt-dlp");
        map.replace(vec![]).unwrap();
        assert!(map.is_empty());
        assert!(map.get("yt-dlp").is_none());
    }

    #[test]
    fn rejects_duplicates_and_empty_fields() {
        let map = ToolkitMap::new();
        let dup = map.replace(vec![entry("deno", "/a"), entry("deno", "/b")]);
        assert!(dup.is_err());
        assert!(
            map.is_empty(),
            "failed replace must not leave a partial map"
        );
        let empty_path = map.replace(vec![entry("deno", "")]);
        assert!(empty_path.is_err());
        let empty_id = map.replace(vec![entry("", "/a")]);
        assert!(empty_id.is_err());
    }
}
