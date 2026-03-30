use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequest {
    pub request_id: String,
    pub operation: String,
    pub connection: NativeConnectionInput,
    pub readonly: Option<bool>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectionInput {
    pub kind: String,
    pub r#type: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub ssl: Option<SslOptions>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslOptions {
    pub enabled: bool,
    pub reject_unauthorized: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponse {
    pub request_id: String,
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<NativeError>,
    pub sql_preview: Option<SqlPreview>,
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlPreview {
    pub title: String,
    pub statements: Vec<String>,
}

impl NativeResponse {
    pub fn success(request_id: String, data: Value) -> Self {
        Self {
            request_id,
            success: true,
            data: Some(data),
            error: None,
            sql_preview: None,
            meta: None,
        }
    }

    pub fn success_with_preview(request_id: String, data: Option<Value>, preview: SqlPreview) -> Self {
        Self {
            request_id,
            success: true,
            data,
            error: None,
            sql_preview: Some(preview),
            meta: None,
        }
    }

    pub fn error(request_id: String, code: &str, message: String, details: Option<String>) -> Self {
        Self {
            request_id,
            success: false,
            data: None,
            error: Some(NativeError {
                code: code.to_string(),
                message,
                details,
            }),
            sql_preview: None,
            meta: None,
        }
    }
}

