use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::models::{NativeConnectionInput, SqlPreview};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlPayload {
    pub action: String,
    pub schema: Option<String>,
    pub table: String,
    pub next_table: Option<String>,
    pub column: Option<String>,
    pub next_column: Option<String>,
    pub definition: Option<TableDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDefinition {
    pub columns: Option<Vec<ColumnDefinition>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefinition {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub unique: bool,
    pub auto_increment: bool,
}

pub fn parse_payload(payload: Option<Value>) -> Result<DdlPayload> {
    serde_json::from_value(payload.ok_or_else(|| anyhow!("DDL payload is required"))?).map_err(Into::into)
}

pub fn build_preview(connection: &NativeConnectionInput, ddl: &DdlPayload) -> Result<SqlPreview> {
    let quote = quote_char(connection.r#type.as_str());
    let qualified_table = qualify(&ddl.table, ddl.schema.as_deref(), &quote);
    let statements = match ddl.action.as_str() {
        "createTable" => vec![format!(
            "CREATE TABLE {} (\n  {}\n);",
            qualified_table,
            render_columns(
                ddl.definition
                    .as_ref()
                    .and_then(|def| def.columns.as_ref())
                    .ok_or_else(|| anyhow!("Column definition is required"))?,
                &quote,
                connection.r#type.as_str()
            )?
        )],
        "renameTable" => vec![match connection.r#type.as_str() {
            "mysql" => format!(
                "RENAME TABLE {} TO {};",
                qualified_table,
                qualify(ddl.next_table.as_deref().ok_or_else(|| anyhow!("nextTable is required"))?, ddl.schema.as_deref(), &quote)
            ),
            _ => format!(
                "ALTER TABLE {} RENAME TO {};",
                qualified_table,
                quote_ident(ddl.next_table.as_deref().ok_or_else(|| anyhow!("nextTable is required"))?, &quote)
            ),
        }],
        "deleteTable" => vec![format!("DROP TABLE {};", qualified_table)],
        "addColumn" => {
            let column = ddl
                .definition
                .as_ref()
                .and_then(|def| def.columns.as_ref())
                .and_then(|columns| columns.first())
                .ok_or_else(|| anyhow!("Column definition is required"))?;
            vec![format!(
                "ALTER TABLE {} ADD COLUMN {};",
                qualified_table,
                render_column(column, &quote, connection.r#type.as_str())?
            )]
        }
        "renameColumn" => vec![format!(
            "ALTER TABLE {} RENAME COLUMN {} TO {};",
            qualified_table,
            quote_ident(ddl.column.as_deref().ok_or_else(|| anyhow!("column is required"))?, &quote),
            quote_ident(ddl.next_column.as_deref().ok_or_else(|| anyhow!("nextColumn is required"))?, &quote)
        )],
        "deleteColumn" => vec![format!(
            "ALTER TABLE {} DROP COLUMN {};",
            qualified_table,
            quote_ident(ddl.column.as_deref().ok_or_else(|| anyhow!("column is required"))?, &quote)
        )],
        "editColumn" => vec![match connection.r#type.as_str() {
            "postgresql" => format!(
                "ALTER TABLE {} ALTER COLUMN {} TYPE {};",
                qualified_table,
                quote_ident(ddl.column.as_deref().ok_or_else(|| anyhow!("column is required"))?, &quote),
                ddl.definition
                    .as_ref()
                    .and_then(|def| def.columns.as_ref())
                    .and_then(|columns| columns.first())
                    .map(|column| column.data_type.clone())
                    .ok_or_else(|| anyhow!("Column definition is required"))?
            ),
            "mysql" => format!(
                "ALTER TABLE {} MODIFY COLUMN {};",
                qualified_table,
                render_column(
                    ddl.definition
                        .as_ref()
                        .and_then(|def| def.columns.as_ref())
                        .and_then(|columns| columns.first())
                        .ok_or_else(|| anyhow!("Column definition is required"))?,
                    &quote,
                    connection.r#type.as_str()
                )?
            ),
            "sqlite" => {
                return Err(anyhow!("SQLite column edits require table rebuild and are not enabled in this MVP"));
            }
            _ => return Err(anyhow!("Unsupported DDL action")),
        }],
        _ => return Err(anyhow!("Unsupported DDL action")),
    };

    Ok(SqlPreview {
        title: format!("{} preview", ddl.action),
        statements,
    })
}

fn render_columns(columns: &[ColumnDefinition], quote: &str, db_type: &str) -> Result<String> {
    let rendered = columns
        .iter()
        .map(|column| render_column(column, quote, db_type))
        .collect::<Result<Vec<_>>>()?;
    Ok(rendered.join(",\n  "))
}

fn render_column(column: &ColumnDefinition, quote: &str, db_type: &str) -> Result<String> {
    let mut parts = vec![format!("{} {}", quote_ident(&column.name, quote), column.data_type)];

    if !column.nullable {
      parts.push("NOT NULL".to_string());
    }
    if let Some(default) = &column.default_value {
      parts.push(format!("DEFAULT {}", default));
    }
    if column.unique {
      parts.push("UNIQUE".to_string());
    }
    if column.primary_key {
      parts.push("PRIMARY KEY".to_string());
    }
    if column.auto_increment {
      parts.push(match db_type {
        "postgresql" => "GENERATED BY DEFAULT AS IDENTITY".to_string(),
        "mysql" => "AUTO_INCREMENT".to_string(),
        "sqlite" => "AUTOINCREMENT".to_string(),
        _ => return Err(anyhow!("Unsupported auto increment strategy")),
      });
    }

    Ok(parts.join(" "))
}

fn quote_char(db_type: &str) -> String {
    match db_type {
        "mysql" => "`".to_string(),
        _ => "\"".to_string(),
    }
}

fn quote_ident(value: &str, quote: &str) -> String {
    format!("{quote}{value}{quote}")
}

fn qualify(table: &str, schema: Option<&str>, quote: &str) -> String {
    match schema {
        Some(schema) if !schema.is_empty() => format!("{}.{}", quote_ident(schema, quote), quote_ident(table, quote)),
        _ => quote_ident(table, quote),
    }
}

