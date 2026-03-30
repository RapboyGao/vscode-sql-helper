use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use sqlx::{mysql::MySqlPool, Row};

use crate::models::NativeConnectionInput;

pub async fn connect(connection: &NativeConnectionInput) -> Result<MySqlPool> {
    let host = connection.host.as_deref().unwrap_or("127.0.0.1");
    let port = connection.port.unwrap_or(3306);
    let username = connection.username.as_deref().unwrap_or("root");
    let password = connection.password.as_deref().unwrap_or("");
    let database = connection.database.as_deref().unwrap_or("");
    let url = if database.is_empty() {
        format!("mysql://{}:{}@{}:{}/mysql", username, password, host, port)
    } else {
        format!("mysql://{}:{}@{}:{}/{}", username, password, host, port, database)
    };
    MySqlPool::connect(&url).await.map_err(Into::into)
}

pub async fn list_schemas(pool: &MySqlPool) -> Result<Value> {
    let rows = sqlx::query("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name").fetch_all(pool).await?;
    let schemas = rows.into_iter().map(|row| row.get::<String, _>("schema_name")).collect::<Vec<_>>();
    Ok(json!({ "schemas": schemas }))
}

pub async fn list_tables(pool: &MySqlPool, schema: Option<&str>) -> Result<Value> {
    let database = schema.ok_or_else(|| anyhow!("schema is required for MySQL"))?;
    let sql = format!(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = '{}' ORDER BY table_name",
        database.replace('\'', "''")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let tables = rows.into_iter().map(|row| json!({ "name": row.get::<String, _>("table_name") })).collect::<Vec<_>>();
    Ok(json!({ "tables": tables }))
}

