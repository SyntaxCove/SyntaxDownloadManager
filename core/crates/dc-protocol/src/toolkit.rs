//! Toolkit domain (Phase 10, v1.5) — mirrors packages/contracts/src/domain/toolkit.ts.
//!
//! The main process owns the toolkit lifecycle (fetch → verify → activate) and pushes ONLY
//! the checksum-proven executable paths into the core via `toolkit.setPaths`. The core never
//! fetches tools itself and never receives a path that did not pass main's verification.

use serde::{Deserialize, Serialize};

/// One activated tool executable as pushed by main (`toolkit.setPaths` wire shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolkitPathEntry {
    pub id: String,
    pub version: String,
    pub path: String,
}

/// `toolkit.setPaths` params: a full-replace list (main is the single source of truth).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolkitSetPathsParams {
    pub tools: Vec<ToolkitPathEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_camel_case_free_shapes() {
        let params = ToolkitSetPathsParams {
            tools: vec![ToolkitPathEntry {
                id: "yt-dlp".into(),
                version: "2025.09.26".into(),
                path: "/opt/unidm/tools/yt-dlp/2025.09.26/yt-dlp".into(),
            }],
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["tools"][0]["id"], "yt-dlp");
        assert_eq!(
            json["tools"][0]["path"],
            "/opt/unidm/tools/yt-dlp/2025.09.26/yt-dlp"
        );
        let back: ToolkitSetPathsParams = serde_json::from_value(json).unwrap();
        assert_eq!(back, params);
    }
}
