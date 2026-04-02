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

pub async fn describe_table(pool: &MySqlPool, schema: Option<&str>, table: &str) -> Result<Value> {
    let database = schema.ok_or_else(|| anyhow!("schema is required for MySQL"))?;
    let sql = format!(
        "SELECT c.column_name, c.column_type, c.is_nullable, c.column_default, c.column_key, c.extra \
         FROM information_schema.columns c \
         WHERE c.table_schema = '{}' AND c.table_name = '{}' \
         ORDER BY c.ordinal_position",
        database.replace('\'', "''"),
        table.replace('\'', "''")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let columns = rows
        .into_iter()
        .map(|row| {
            let column_key = row.get::<String, _>("column_key");
            let extra = row.get::<String, _>("extra").to_lowercase();
            json!({
                "name": row.get::<String, _>("column_name"),
                "dataType": row.get::<String, _>("column_type"),
                "nullable": row.get::<String, _>("is_nullable") == "YES",
                "defaultValue": row.try_get::<Option<String>, _>("column_default").ok().flatten(),
                "primaryKey": column_key == "PRI",
                "unique": column_key == "UNI",
                "autoIncrement": extra.contains("auto_increment")
            })
        })
        .collect::<Vec<_>>();

    let primary_keys = columns
        .iter()
        .filter(|column| column.get("primaryKey").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|column| column.get("name").and_then(Value::as_str).map(ToString::to_string))
        .collect::<Vec<_>>();

    Ok(json!({
        "table": {
            "schema": database,
            "name": table,
            "columns": columns,
            "primaryKeys": primary_keys
        }
    }))
}
