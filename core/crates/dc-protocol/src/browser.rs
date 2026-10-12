//! Browser data domain (Phase 14, v1.9) — mirrors packages/contracts/src/domain/browser-data.ts.
//!
//! History rows and bookmarks live in the core's SQLite database (dc-storage migration v8).
//! Wire rules as in `MediaJob`: fields declared `.nullable()` in zod are ALWAYS serialized
//! (None → null); request-side `.nullish()` fields are plain `Option` and omitted when None.

use crate::ids::Ulid;
use serde::{Deserialize, Serialize};

/// One recorded visit of one page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: Ulid,
    pub url: String,
    /// Page title; null when the page did not provide one (always serialized).
    pub title: Option<String>,
    /// Page-provided favicon URL; null when none (always serialized).
    #[serde(rename = "faviconUrl")]
    pub favicon_url: Option<String>,
    /// Epoch ms of the settled visit.
    #[serde(rename = "visitedAt")]
    pub visited_at: i64,
}

/// `browser.history.record` params (fire-and-forget from main).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HistoryRecordParams {
    pub url: String,
    #[serde(rename = "title")]
    pub title: Option<String>,
    #[serde(rename = "faviconUrl", default)]
    pub favicon_url: Option<String>,
    /// Omitted = the core's clock stamps the row.
    #[serde(rename = "visitedAt", default)]
    pub visited_at: Option<i64>,
}

/// `browser.history.list` params.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HistoryListParams {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryListResult {
    pub entries: Vec<HistoryEntry>,
}

/// One bookmark — flat, position-ordered list (no folders in v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: Ulid,
    pub url: String,
    pub title: String,
    pub position: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// `browser.bookmark.create` params.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BookmarkCreateParams {
    pub url: String,
    pub title: String,
}

/// `browser.bookmark.getByUrl` result (first bookmark by position; null when absent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookmarkGetByUrlResult {
    pub bookmark: Option<Bookmark>,
}

/// `browser.bookmark.update` params — at least one of title/url (validated main-side too).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BookmarkUpdateParams {
    pub id: Ulid,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}
