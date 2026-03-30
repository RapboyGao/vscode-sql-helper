use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};
use sqlx::{sqlite::SqliteRow, Column, Row, SqlitePool};
use tokio::{
    fs::{self, File},
    io::AsyncReadExt,
};

use crate::models::NativeConnectionInput;

pub async fn validate_file(connection: &NativeConnectionInput) -> Result<Value> {
    let file_path = connection.file_path.as_ref().ok_or_else(|| anyhow!("SQLite file path is required"))?;
    let metadata = fs::metadata(file_path).await.map_err(|error| anyhow!("SQLite file does not exist: {error}"))?;
    if !metadata.is_file() {
        return Err(anyhow!("SQLite path is not a file"));
    }
    if metadata.len() < 16 {
        return Err(anyhow!("SQLite file is invalid or locked"));
    }
    let mut file = File::open(file_path).await?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header).await?;
    if &header != b"SQLite format 3\0" {
        return Err(anyhow!("SQLite file is invalid or locked"));
    }
    Ok(json!({ "valid": true }))
}

pub async fn connect(connection: &NativeConnectionInput, readonly: bool) -> Result<SqlitePool> {
    let file_path = connection.file_path.as_ref().ok_or_else(|| anyhow!("SQLite file path is required"))?;
    let mode = if readonly { "ro" } else { "rw" };
    let uri = format!("sqlite:{}?mode={mode}", file_path);
    SqlitePool::connect(&uri).await.map_err(Into::into)
}

pub async fn list_schemas(_pool: &SqlitePool) -> Result<Value> {
    Ok(json!({ "schemas": ["main"] }))
}

pub async fn list_tables(pool: &SqlitePool) -> Result<Value> {
    let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(pool)
        .await?;
    let tables = rows
        .into_iter()
        .map(|row| json!({ "name": row.get::<String, _>("name") }))
        .collect::<Vec<_>>();
    Ok(json!({ "tables": tables }))
}

pub async fn describe_table(pool: &SqlitePool, table: &str) -> Result<Value> {
    let pragma = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let rows = sqlx::query(&pragma).fetch_all(pool).await?;
    let columns = rows
        .into_iter()
        .map(|row| {
            json!({
                "name": row.get::<String, _>("name"),
                "dataType": row.get::<String, _>("type"),
                "nullable": row.get::<i64, _>("notnull") == 0,
                "defaultValue": row.try_get::<Option<String>, _>("dflt_value").ok().flatten(),
                "primaryKey": row.get::<i64, _>("pk") == 1,
                "unique": false,
                "autoIncrement": false
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
            "name": table,
            "columns": columns,
            "primaryKeys": primary_keys
        }
    }))
}

pub async fn query_table_data(pool: &SqlitePool, payload: &Value) -> Result<Value> {
    let table = payload.get("table").and_then(Value::as_str).ok_or_else(|| anyhow!("table is required"))?;
    let page = payload.get("page").and_then(Value::as_u64).unwrap_or(0);
    let page_size = payload.get("pageSize").and_then(Value::as_u64).unwrap_or(50);
    let keyword = payload.get("keyword").and_then(Value::as_str).unwrap_or("");
    let offset = page * page_size;

    let table_schema = describe_table(pool, table).await?;
    let columns = table_schema
        .get("table")
        .and_then(|table| table.get("columns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let column_names = columns
        .iter()
        .filter_map(|column| column.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();

    let mut where_clauses = Vec::new();

    if !keyword.is_empty() && !column_names.is_empty() {
        let filters = column_names
            .iter()
            .map(|name| format!("CAST(\"{}\" AS TEXT) LIKE '%{}%'", name.replace('"', "\"\""), keyword.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(" OR ");
        where_clauses.push(format!("({filters})"));
    }

    if let Some(filters) = payload.get("filters").and_then(Value::as_array) {
        for filter in filters {
            let column = filter.get("column").and_then(Value::as_str).ok_or_else(|| anyhow!("filter column is required"))?;
            let operator = filter.get("operator").and_then(Value::as_str).unwrap_or("contains");
            let value = filter.get("value").and_then(Value::as_str).unwrap_or("");
            let safe_column = column.replace('"', "\"\"");
            let escaped_value = value.replace('\'', "''");

            let clause = match operator {
                "=" | "!=" | ">" | "<" | ">=" | "<=" => {
                    format!("\"{}\" {} '{}'", safe_column, operator, escaped_value)
                }
                "startsWith" => format!("CAST(\"{}\" AS TEXT) LIKE '{}%'", safe_column, escaped_value),
                "endsWith" => format!("CAST(\"{}\" AS TEXT) LIKE '%{}'", safe_column, escaped_value),
                "isNull" => format!("\"{}\" IS NULL", safe_column),
                "contains" => format!("CAST(\"{}\" AS TEXT) LIKE '%{}%'", safe_column, escaped_value),
                _ => format!("CAST(\"{}\" AS TEXT) LIKE '%{}%'", safe_column, escaped_value),
            };

            where_clauses.push(clause);
        }
    }

    let search_clause = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };

    let count_sql = format!("SELECT COUNT(*) as total FROM \"{}\"{}", table.replace('"', "\"\""), search_clause);
    let total_row = sqlx::query(&count_sql).fetch_one(pool).await?;
    let total_rows = total_row.get::<i64, _>("total");

    let data_sql = format!(
        "SELECT * FROM \"{}\"{} LIMIT {} OFFSET {}",
        table.replace('"', "\"\""),
        search_clause,
        page_size,
        offset
    );
    let rows = sqlx::query(&data_sql).fetch_all(pool).await?;
    let json_rows = rows.into_iter().map(row_to_json).collect::<Vec<_>>();
    let primary_keys = table_schema["table"]["primaryKeys"].clone();

    Ok(json!({
        "table": table,
        "page": page,
        "pageSize": page_size,
        "totalRows": total_rows,
        "rows": json_rows,
        "columns": columns,
        "primaryKeys": primary_keys
    }))
}

pub async fn insert_rows(pool: &SqlitePool, payload: &Value) -> Result<Value> {
    let table = payload.get("table").and_then(Value::as_str).ok_or_else(|| anyhow!("table is required"))?;
    let rows = payload.get("rows").and_then(Value::as_array).ok_or_else(|| anyhow!("rows are required"))?;
    for row in rows {
        let object = row.as_object().ok_or_else(|| anyhow!("row must be an object"))?;
        let columns = object.keys().map(|key| format!("\"{}\"", key.replace('"', "\"\""))).collect::<Vec<_>>();
        let values = object.values().map(to_sql_literal).collect::<Vec<_>>();
        let sql = format!(
            "INSERT INTO \"{}\" ({}) VALUES ({})",
            table.replace('"', "\"\""),
            columns.join(", "),
            values.join(", ")
        );
        sqlx::query(&sql).execute(pool).await?;
    }
    Ok(json!({ "inserted": rows.len() }))
}

pub async fn update_rows(pool: &SqlitePool, payload: &Value) -> Result<Value> {
    let table = payload.get("table").and_then(Value::as_str).ok_or_else(|| anyhow!("table is required"))?;
    let key = payload.get("key").and_then(Value::as_object).ok_or_else(|| anyhow!("key is required"))?;
    let values = payload.get("values").and_then(Value::as_object).ok_or_else(|| anyhow!("values are required"))?;
    let set_clause = values
        .iter()
        .map(|(column, value)| format!("\"{}\" = {}", column.replace('"', "\"\""), to_sql_literal(value)))
        .collect::<Vec<_>>()
        .join(", ");
    let where_clause = key
        .iter()
        .map(|(column, value)| format!("\"{}\" = {}", column.replace('"', "\"\""), to_sql_literal(value)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("UPDATE \"{}\" SET {} WHERE {}", table.replace('"', "\"\""), set_clause, where_clause);
    let result = sqlx::query(&sql).execute(pool).await?;
    Ok(json!({ "updated": result.rows_affected() }))
}

pub async fn delete_rows(pool: &SqlitePool, payload: &Value) -> Result<Value> {
    let table = payload.get("table").and_then(Value::as_str).ok_or_else(|| anyhow!("table is required"))?;
    let key = payload.get("key").and_then(Value::as_object).ok_or_else(|| anyhow!("key is required"))?;
    let where_clause = key
        .iter()
        .map(|(column, value)| format!("\"{}\" = {}", column.replace('"', "\"\""), to_sql_literal(value)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("DELETE FROM \"{}\" WHERE {}", table.replace('"', "\"\""), where_clause);
    let result = sqlx::query(&sql).execute(pool).await?;
    Ok(json!({ "deleted": result.rows_affected() }))
}

fn row_to_json(row: SqliteRow) -> Value {
    let mut object = Map::new();
    for column in row.columns() {
        let name = column.name().to_string();
        let value = row
            .try_get::<Option<String>, _>(name.as_str())
            .map(|value| value.map(Value::String).unwrap_or(Value::Null))
            .or_else(|_| row.try_get::<Option<i64>, _>(name.as_str()).map(|value| value.map(Value::from).unwrap_or(Value::Null)))
            .or_else(|_| row.try_get::<Option<f64>, _>(name.as_str()).map(|value| value.map(Value::from).unwrap_or(Value::Null)))
            .or_else(|_| row.try_get::<Option<Vec<u8>>, _>(name.as_str()).map(|value| value.map(|bytes| Value::String(format!("{bytes:?}"))).unwrap_or(Value::Null)))
            .unwrap_or(Value::Null);
        object.insert(name, value);
    }
    Value::Object(object)
}

fn to_sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value { "1".to_string() } else { "0".to_string() }
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}
