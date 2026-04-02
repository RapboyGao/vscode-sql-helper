mod adapters;
mod models;

use anyhow::{anyhow, Result};
use models::{NativeRequest, NativeResponse};
use serde_json::{json, Value};
use std::io::{self, Read};

#[tokio::main]
async fn main() {
    let response = match handle().await {
        Ok(response) => response,
        Err(error) => NativeResponse::error(
            "unknown".to_string(),
            "UNKNOWN",
            error.to_string(),
            None,
        ),
    };

    println!("{}", serde_json::to_string(&response).unwrap_or_else(|_| "{\"success\":false}".to_string()));
}

async fn handle() -> Result<NativeResponse> {
    let mut buffer = String::new();
    io::stdin().read_to_string(&mut buffer)?;
    let request: NativeRequest = serde_json::from_str(&buffer)?;

    let response = match request.connection.r#type.as_str() {
        "sqlite" => handle_sqlite(&request).await,
        "mysql" => handle_mysql(&request).await,
        "postgresql" => handle_postgres(&request).await,
        _ => Err(anyhow!("Unsupported database type")),
    };

    response.or_else(|error| {
        Ok(NativeResponse::error(
            request.request_id,
            "UNKNOWN",
            error.to_string(),
            None,
        ))
    })
}

async fn handle_sqlite(request: &NativeRequest) -> Result<NativeResponse> {
    use adapters::{ddl, sqlite};

    if request.operation == "validateSqliteFile" {
        let data = sqlite::validate_file(&request.connection).await?;
        return Ok(NativeResponse::success(request.request_id.clone(), data));
    }

    let pool = sqlite::connect(&request.connection, request.readonly.unwrap_or(false)).await?;
    let response = match request.operation.as_str() {
        "testConnection" => NativeResponse::success(request.request_id.clone(), json!({ "ok": true })),
        "listSchemas" => NativeResponse::success(request.request_id.clone(), sqlite::list_schemas(&pool).await?),
        "listTables" => NativeResponse::success(request.request_id.clone(), sqlite::list_tables(&pool).await?),
        "describeTable" => NativeResponse::success(
            request.request_id.clone(),
            sqlite::describe_table(
                &pool,
                request
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("table"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("table is required"))?,
            )
            .await?,
        ),
        "queryTableData" => NativeResponse::success(
            request.request_id.clone(),
            sqlite::query_table_data(&pool, request.payload.as_ref().ok_or_else(|| anyhow!("payload is required"))?).await?,
        ),
        "insertRows" => NativeResponse::success(
            request.request_id.clone(),
            sqlite::insert_rows(&pool, request.payload.as_ref().ok_or_else(|| anyhow!("payload is required"))?).await?,
        ),
        "updateRows" => NativeResponse::success(
            request.request_id.clone(),
            sqlite::update_rows(&pool, request.payload.as_ref().ok_or_else(|| anyhow!("payload is required"))?).await?,
        ),
        "deleteRows" => NativeResponse::success(
            request.request_id.clone(),
            sqlite::delete_rows(&pool, request.payload.as_ref().ok_or_else(|| anyhow!("payload is required"))?).await?,
        ),
        "previewDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            NativeResponse::success_with_preview(request.request_id.clone(), None, preview)
        }
        "applyDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            for statement in preview.statements.iter() {
                sqlx::query(statement).execute(&pool).await?;
            }
            NativeResponse::success_with_preview(request.request_id.clone(), Some(json!({ "applied": true })), preview)
        }
        _ => return Err(anyhow!("Unsupported operation")),
    };

    Ok(response)
}

async fn handle_mysql(request: &NativeRequest) -> Result<NativeResponse> {
    use adapters::{ddl, mysql};

    let pool = mysql::connect(&request.connection).await?;
    let response = match request.operation.as_str() {
        "testConnection" => NativeResponse::success(request.request_id.clone(), json!({ "ok": true })),
        "listSchemas" => NativeResponse::success(request.request_id.clone(), mysql::list_schemas(&pool).await?),
        "listTables" => NativeResponse::success(
            request.request_id.clone(),
            mysql::list_tables(
                &pool,
                request.payload.as_ref().and_then(|payload| payload.get("schema")).and_then(Value::as_str),
            )
            .await?,
        ),
        "describeTable" => NativeResponse::success(
            request.request_id.clone(),
            mysql::describe_table(
                &pool,
                request.payload.as_ref().and_then(|payload| payload.get("schema")).and_then(Value::as_str),
                request
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("table"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("table is required"))?,
            )
            .await?,
        ),
        "previewDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            NativeResponse::success_with_preview(request.request_id.clone(), None, preview)
        }
        "applyDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            for statement in preview.statements.iter() {
                sqlx::query(statement).execute(&pool).await?;
            }
            NativeResponse::success_with_preview(request.request_id.clone(), Some(json!({ "applied": true })), preview)
        }
        _ => return Err(anyhow!("This MySQL operation is not implemented in the MVP native scaffold")),
    };

    Ok(response)
}

async fn handle_postgres(request: &NativeRequest) -> Result<NativeResponse> {
    use adapters::{ddl, postgres};

    let pool = postgres::connect(&request.connection).await?;
    let response = match request.operation.as_str() {
        "testConnection" => NativeResponse::success(request.request_id.clone(), json!({ "ok": true })),
        "listSchemas" => NativeResponse::success(request.request_id.clone(), postgres::list_schemas(&pool).await?),
        "listTables" => NativeResponse::success(
            request.request_id.clone(),
            postgres::list_tables(
                &pool,
                request.payload.as_ref().and_then(|payload| payload.get("schema")).and_then(Value::as_str),
            )
            .await?,
        ),
        "describeTable" => NativeResponse::success(
            request.request_id.clone(),
            postgres::describe_table(
                &pool,
                request.payload.as_ref().and_then(|payload| payload.get("schema")).and_then(Value::as_str),
                request
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("table"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("table is required"))?,
            )
            .await?,
        ),
        "previewDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            NativeResponse::success_with_preview(request.request_id.clone(), None, preview)
        }
        "applyDDL" => {
            let ddl_payload = ddl::parse_payload(request.payload.clone())?;
            let preview = ddl::build_preview(&request.connection, &ddl_payload)?;
            for statement in preview.statements.iter() {
                sqlx::query(statement).execute(&pool).await?;
            }
            NativeResponse::success_with_preview(request.request_id.clone(), Some(json!({ "applied": true })), preview)
        }
        _ => return Err(anyhow!("This PostgreSQL operation is not implemented in the MVP native scaffold")),
    };

    Ok(response)
}
