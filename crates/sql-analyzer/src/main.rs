use regex::Regex;
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{self, Read};

#[derive(Serialize)]
struct Reference {
    kind: &'static str,
    value: String,
}

#[derive(Serialize)]
struct AnalysisResult {
    databases: Vec<String>,
    schemas: Vec<String>,
    references: Vec<Reference>,
    note: Option<&'static str>,
}

fn main() {
    let mut sql = String::new();
    io::stdin().read_to_string(&mut sql).unwrap();

    let three_part = Regex::new(r"(?i)\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b").unwrap();
    let two_part = Regex::new(
        r"(?i)\b(?:from|join|into|update|table|truncate\s+table|delete\s+from)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b",
    )
    .unwrap();
    let use_stmt = Regex::new(r"(?i)\buse\s+([a-z_][a-z0-9_]*)\b").unwrap();

    let mut databases = BTreeSet::new();
    let mut schemas = BTreeSet::new();
    let mut references = Vec::new();

    for caps in three_part.captures_iter(&sql) {
        let database = caps[1].to_string();
        let schema = caps[2].to_string();
        let table = caps[3].to_string();

        databases.insert(database.clone());
        schemas.insert(schema.clone());
        references.push(Reference {
            kind: "table",
            value: format!("{}.{}.{}", database, schema, table),
        });
    }

    for caps in two_part.captures_iter(&sql) {
        let left = caps[1].to_string();
        let right = caps[2].to_string();
        let combined = format!("{}.{}", left, right);

        if references.iter().any(|entry| entry.value.ends_with(&combined)) {
            continue;
        }

        schemas.insert(left.clone());
        references.push(Reference {
            kind: "qualified_name",
            value: combined,
        });
    }

    for caps in use_stmt.captures_iter(&sql) {
        let database = caps[1].to_string();
        databases.insert(database.clone());
        references.push(Reference {
            kind: "database",
            value: database,
        });
    }

    let result = AnalysisResult {
        databases: databases.into_iter().collect(),
        schemas: schemas.into_iter().collect(),
        references,
        note: Some("Current parser uses heuristic matching. Next step is replacing it with a dialect-aware SQL parser."),
    };

    println!("{}", serde_json::to_string(&result).unwrap());
}
