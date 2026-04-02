use anyhow::Result;
use serde_json::{json, Value};
use sqlx::{postgres::PgPool, Row};

use crate::models::NativeConnectionInput;

pub async fn connect(connection: &NativeConnectionInput) -> Result<PgPool> {
    let host = connection.host.as_deref().unwrap_or("127.0.0.1");
    let port = connection.port.unwrap_or(5432);
    let username = connection.username.as_deref().unwrap_or("postgres");
    let password = connection.password.as_deref().unwrap_or("");
    let database = connection.database.as_deref().unwrap_or("postgres");
    let url = format!("postgres://{}:{}@{}:{}/{}", username, password, host, port, database);
    PgPool::connect(&url).await.map_err(Into::into)
}

pub async fn list_schemas(pool: &PgPool) -> Result<Value> {
    let rows = sqlx::query("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name").fetch_all(pool).await?;
    let schemas = rows.into_iter().map(|row| row.get::<String, _>("schema_name")).collect::<Vec<_>>();
    Ok(json!({ "schemas": schemas }))
}

pub async fn list_tables(pool: &PgPool, schema: Option<&str>) -> Result<Value> {
    let schema = schema.unwrap_or("public");
    let sql = format!(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = '{}' ORDER BY table_name",
        schema.replace('\'', "''")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let tables = rows.into_iter().map(|row| json!({ "name": row.get::<String, _>("table_name") })).collect::<Vec<_>>();
    Ok(json!({ "tables": tables }))
}

pub async fn describe_table(pool: &PgPool, schema: Option<&str>, table: &str) -> Result<Value> {
    let schema = schema.unwrap_or("public");
    let sql = format!(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.udt_name, c.is_identity, \
         EXISTS ( \
           SELECT 1 FROM information_schema.table_constraints tc \
           JOIN information_schema.key_column_usage kcu \
             ON tc.constraint_name = kcu.constraint_name \
            AND tc.table_schema = kcu.table_schema \
          WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name \
            AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = c.column_name \
         ) AS is_primary_key, \
         EXISTS ( \
           SELECT 1 FROM information_schema.table_constraints tc \
           JOIN information_schema.key_column_usage kcu \
             ON tc.constraint_name = kcu.constraint_name \
            AND tc.table_schema = kcu.table_schema \
          WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name \
            AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = c.column_name \
         ) AS is_unique \
         FROM information_schema.columns c \
         WHERE c.table_schema = '{}' AND c.table_name = '{}' \
         ORDER BY c.ordinal_position",
        schema.replace('\'', "''"),
        table.replace('\'', "''")
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let columns = rows
        .into_iter()
        .map(|row| {
            let data_type = row.get::<String, _>("data_type");
            let udt_name = row.get::<String, _>("udt_name");
            let column_default = row.try_get::<Option<String>, _>("column_default").ok().flatten();
            let is_identity = row.get::<String, _>("is_identity") == "YES";
            let auto_increment = is_identity
                || column_default
                    .as_ref()
                    .map(|value| value.contains("nextval("))
                    .unwrap_or(false);
            json!({
                "name": row.get::<String, _>("column_name"),
                "dataType": if data_type == "USER-DEFINED" { udt_name } else { data_type },
                "nullable": row.get::<String, _>("is_nullable") == "YES",
                "defaultValue": column_default,
                "primaryKey": row.get::<bool, _>("is_primary_key"),
                "unique": row.get::<bool, _>("is_unique"),
                "autoIncrement": auto_increment
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
            "schema": schema,
            "name": table,
            "columns": columns,
            "primaryKeys": primary_keys
        }
    }))
}
