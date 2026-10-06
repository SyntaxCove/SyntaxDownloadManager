//! Wire envelopes — mirrors packages/contracts/src/protocol/envelope.ts exactly:
//!   request: { v, id, method, params? }
//!   success: { v, id, ok: true, result }    error: { v, id, ok: false, error }
//!   event:   { v, event, payload? }

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const V: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub v: i64,
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessEnvelope {
    pub v: i64,
    pub id: String,
    pub ok: bool, // always true; kept as a field so JSON matches the TS wire format
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub v: i64,
    pub id: String,
    pub ok: bool, // always false
    pub error: crate::ContractError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub v: i64,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseEnvelope {
    Success(SuccessEnvelope),
    Error(ErrorEnvelope),
}

pub fn make_request(
    id: impl Into<String>,
    method: impl Into<String>,
    params: Option<Value>,
) -> RequestEnvelope {
    RequestEnvelope {
        v: V,
        id: id.into(),
        method: method.into(),
        params,
    }
}

pub fn make_success(id: impl Into<String>, result: Value) -> SuccessEnvelope {
    SuccessEnvelope {
        v: V,
        id: id.into(),
        ok: true,
        result,
    }
}

pub fn make_error(id: impl Into<String>, error: crate::ContractError) -> ErrorEnvelope {
    ErrorEnvelope {
        v: V,
        id: id.into(),
        ok: false,
        error,
    }
}

pub fn make_event(event: impl Into<String>, payload: Option<Value>) -> EventEnvelope {
    EventEnvelope {
        v: V,
        event: event.into(),
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ContractError, ErrorCode};

    #[test]
    fn round_trips_all_envelopes() {
        let req = make_request("r1", "download.list", Some(serde_json::json!({})));
        let json = serde_json::to_string(&req).unwrap();
        assert_eq!(
            json,
            r#"{"v":1,"id":"r1","method":"download.list","params":{}}"#
        );
        let back: RequestEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back.method, "download.list");

        let ok = make_success("r1", serde_json::json!({"pong": true}));
        let json = serde_json::to_string(&ok).unwrap();
        assert_eq!(
            json,
            r#"{"v":1,"id":"r1","ok":true,"result":{"pong":true}}"#
        );

        let err = make_error(
            "r1",
            ContractError::new(ErrorCode::InvalidState, "job is not running"),
        );
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(
            json,
            r#"{"v":1,"id":"r1","ok":false,"error":{"code":"invalid_state","message":"job is not running"}}"#
        );

        let ev = make_event("download.progress", Some(serde_json::json!({"jobId": "x"})));
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"v":1,"event":"download.progress","payload":{"jobId":"x"}}"#
        );
    }
}
