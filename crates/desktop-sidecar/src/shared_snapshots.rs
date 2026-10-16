use rusqlite::Connection;
use serde_json::{json, Value};

use crate::{string_param, tags_from_json};

fn memo_json_param(memo: &Value) -> Result<String, String> {
    memo
        .get("contentJson")
        .map(|value| serde_json::to_string(value).map_err(|error| error.to_string()))
        .unwrap_or_else(|| Ok(String::from("{\"type\":\"doc\",\"content\":[]}")))
}

fn tags_param(memo: &Value) -> Result<String, String> {
    match memo.get("tags") {
        Some(Value::Array(_)) => {
            serde_json::to_string(&memo["tags"]).map_err(|error| error.to_string())
        }
        _ => Ok(String::from("[]")),
    }
}

fn display_policy_param(memo: &Value) -> Result<Option<String>, String> {
    match memo.get("displayPolicy") {
        None | Some(Value::Null) => Ok(None),
        Some(policy) => serde_json::to_string(policy)
            .map(Some)
            .map_err(|error| error.to_string()),
    }
}

fn snapshot_row_to_memo(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Value> {
    let tags: String = row.get("tags_json")?;
    let content_json: String = row.get("content_json")?;
    Ok(json!({
        "id": row.get::<_, String>("memo_id")?,
        "notebookId": row.get::<_, Option<String>>("notebook_id")?,
        "title": row.get::<_, Option<String>>("title")?,
        "excerpt": row.get::<_, String>("excerpt")?,
        "tags": tags_from_json(&tags),
        "isPinned": false,
        "isArchived": false,
        "isDeleted": false,
        "revision": row.get::<_, i64>("revision")?,
        "createdAt": row.get::<_, String>("memo_created_at")?,
        "updatedAt": row.get::<_, String>("memo_updated_at")?,
        "deletedAt": Value::Null,
        "contentJson": serde_json::from_str::<Value>(&content_json)
            .unwrap_or_else(|_| json!({"type":"doc","content":[]})),
        "contentMarkdown": row.get::<_, String>("content_markdown")?,
        "contentText": row.get::<_, String>("content_text")?,
        "contentHash": row.get::<_, String>("content_hash")?,
        "sourceMemoIds": Vec::<String>::new(),
        "mergeSourceCount": 0,
        "mergedIntoMemoId": Value::Null,
    }))
}

pub(crate) fn save_shared_snapshot(
    database: &Connection,
    params: &Value,
) -> Result<Value, String> {
    let memo = params
        .get("memo")
        .ok_or_else(|| "Missing memo snapshot payload".to_owned())?;
    let memo_id = string_param(memo, "id")?;
    let content_json = memo_json_param(memo)?;
    let tags_json = tags_param(memo)?;
    let display_policy_json = display_policy_param(memo)?;
    let memo_updated_at = memo
        .get("updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing memo updatedAt".to_owned())?;
    let memo_created_at = memo
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(memo_updated_at);
    database.execute(
        "INSERT INTO shared_memo_snapshots
           (memo_id, group_id, group_name, notebook_id, title, excerpt, tags_json,
            content_json, content_markdown, content_text, content_hash, revision,
            display_policy_json, memo_created_at, memo_updated_at, snapshot_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(memo_id) DO UPDATE SET
           group_id = excluded.group_id, group_name = excluded.group_name,
           notebook_id = excluded.notebook_id, title = excluded.title,
           excerpt = excluded.excerpt, tags_json = excluded.tags_json,
           content_json = excluded.content_json,
           content_markdown = excluded.content_markdown,
           content_text = excluded.content_text,
           content_hash = excluded.content_hash, revision = excluded.revision,
           display_policy_json = excluded.display_policy_json,
           memo_created_at = excluded.memo_created_at,
           memo_updated_at = excluded.memo_updated_at,
           snapshot_at = excluded.snapshot_at",
        rusqlite::params![
            memo_id,
            memo.get("groupId").and_then(Value::as_str),
            memo.get("groupName").and_then(Value::as_str),
            memo.get("notebookId").and_then(Value::as_str),
            memo.get("title").and_then(Value::as_str),
            memo.get("excerpt").and_then(Value::as_str).unwrap_or(""),
            tags_json,
            content_json,
            memo.get("contentMarkdown").and_then(Value::as_str).unwrap_or(""),
            memo.get("contentText").and_then(Value::as_str).unwrap_or(""),
            memo.get("contentHash").and_then(Value::as_str).unwrap_or(""),
            memo.get("revision").and_then(Value::as_i64).unwrap_or(0),
            display_policy_json,
            memo_created_at,
            memo_updated_at,
        ],
    ).map_err(|e| e.to_string())?;
    get_shared_snapshot(database, &json!({ "memoId": memo_id }))
}

pub(crate) fn get_shared_snapshot(
    database: &Connection,
    params: &Value,
) -> Result<Value, String> {
    let memo_id = string_param(params, "memoId")?;
    let mut statement = database
        .prepare(
            "SELECT memo_id, group_id, group_name, notebook_id, title, excerpt, tags_json,
                    content_json, content_markdown, content_text, content_hash, revision,
                    memo_created_at, memo_updated_at
             FROM shared_memo_snapshots WHERE memo_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let (memo, group_name) = statement
        .query_row([memo_id], |row| {
            Ok((
                snapshot_row_to_memo(row)?,
                row.get::<_, Option<String>>("group_name")?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(json!({ "memo": memo, "groupName": group_name }))
}

pub(crate) fn list_shared_snapshots(database: &Connection) -> Result<Value, String> {
    let mut statement = database
        .prepare("SELECT memo_id, group_id, memo_updated_at FROM shared_memo_snapshots ORDER BY memo_id")
        .map_err(|e| e.to_string())?;
    let snapshots = statement
        .query_map([], |row| {
            Ok(json!({
                "memoId": row.get::<_, String>("memo_id")?,
                "updatedAt": row.get::<_, String>("memo_updated_at")?,
                "groupId": row.get::<_, Option<String>>("group_id")?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({ "snapshots": snapshots }))
}

pub(crate) fn prune_shared_snapshots(
    database: &Connection,
    params: &Value,
) -> Result<Value, String> {
    let keep = params
        .get("memoIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing memoIds array".to_owned())?;
    let keep_ids: Vec<&str> = keep.iter().filter_map(Value::as_str).collect();
    let removed = if keep_ids.is_empty() {
        database
            .execute("DELETE FROM shared_memo_snapshots", [])
            .map_err(|e| e.to_string())?
    } else {
        let placeholders = keep_ids
            .iter()
            .enumerate()
            .map(|(index, _)| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("DELETE FROM shared_memo_snapshots WHERE memo_id NOT IN ({placeholders})");
        let mut statement = database.prepare(&sql).map_err(|e| e.to_string())?;
        statement
            .execute(rusqlite::params_from_iter(keep_ids.iter()))
            .map_err(|e| e.to_string())?
    };
    Ok(json!({ "removed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::ensure_sidecar_schema;

    fn test_database() -> Connection {
        let connection =
            Connection::open_in_memory().expect("open test database");
        ensure_sidecar_schema(&connection).expect("test schema");
        connection
    }

    fn sample_memo(id: &str) -> Value {
        json!({
            "id": id,
            "notebookId": "nb_author",
            "title": "Shared note",
            "excerpt": "hello",
            "tags": ["t"],
            "revision": 3,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-02-01T00:00:00.000Z",
            "contentJson": { "type": "doc", "content": [{ "type": "paragraph" }] },
            "contentMarkdown": "hello",
            "contentText": "hello",
            "contentHash": "hash-1",
            "groupId": "grp_1",
            "groupName": "研发",
            "displayPolicy": null,
        })
    }

    #[test]
    fn saves_and_reads_a_snapshot_shaped_like_a_memo_detail() {
        let database = test_database();
        let saved = save_shared_snapshot(&database, &json!({ "memo": sample_memo("memo_s1") }))
            .expect("save snapshot");
        let memo = saved.get("memo").expect("saved memo");
        assert_eq!(memo.get("id").and_then(Value::as_str), Some("memo_s1"));
        assert_eq!(memo.get("revision").and_then(Value::as_i64), Some(3));
        assert_eq!(saved.get("groupName").and_then(Value::as_str), Some("研发"));

        let loaded = get_shared_snapshot(&database, &json!({ "memoId": "memo_s1" }))
            .expect("load snapshot");
        assert_eq!(
            loaded.get("memo").and_then(|memo| memo.get("contentMarkdown")).and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn refreshing_a_snapshot_replaces_content_but_keeps_one_row() {
        let database = test_database();
        save_shared_snapshot(&database, &json!({ "memo": sample_memo("memo_s1") }))
            .expect("save snapshot");
        let mut newer = sample_memo("memo_s1");
        newer["contentMarkdown"] = json!("hello again");
        newer["updatedAt"] = json!("2026-03-01T00:00:00.000Z");
        save_shared_snapshot(&database, &json!({ "memo": newer })).expect("refresh snapshot");
        let count: i64 = database
            .query_row("SELECT COUNT(*) FROM shared_memo_snapshots", [], |row| row.get(0))
            .expect("count snapshots");
        assert_eq!(count, 1);
        let loaded = get_shared_snapshot(&database, &json!({ "memoId": "memo_s1" }))
            .expect("load snapshot");
        assert_eq!(
            loaded.get("memo").and_then(|memo| memo.get("contentMarkdown")).and_then(Value::as_str),
            Some("hello again")
        );
    }

    #[test]
    fn prune_keeps_listed_access_and_reports_the_rest() {
        let database = test_database();
        save_shared_snapshot(&database, &json!({ "memo": sample_memo("memo_keep") }))
            .expect("save kept");
        save_shared_snapshot(&database, &json!({ "memo": sample_memo("memo_drop") }))
            .expect("save dropped");
        let pruned = prune_shared_snapshots(&database, &json!({ "memoIds": ["memo_keep"] }))
            .expect("prune snapshots");
        assert_eq!(pruned.get("removed").and_then(Value::as_i64), Some(1));
        assert!(get_shared_snapshot(&database, &json!({ "memoId": "memo_drop" })).is_err());
        let listed = list_shared_snapshots(&database).expect("list snapshots");
        assert_eq!(listed.get("snapshots").and_then(Value::as_array).map(Vec::len), Some(1));
    }

    #[test]
    fn prune_with_an_empty_list_clears_every_snapshot() {
        let database = test_database();
        save_shared_snapshot(&database, &json!({ "memo": sample_memo("memo_s1") }))
            .expect("save snapshot");
        let pruned = prune_shared_snapshots(&database, &json!({ "memoIds": [] }))
            .expect("prune snapshots");
        assert_eq!(pruned.get("removed").and_then(Value::as_i64), Some(1));
    }

    #[test]
    fn missing_snapshots_and_payloads_fail_loudly() {
        let database = test_database();
        assert!(get_shared_snapshot(&database, &json!({ "memoId": "memo_missing" })).is_err());
        assert!(save_shared_snapshot(&database, &json!({})).is_err());
        assert!(save_shared_snapshot(&database, &json!({ "memo": { "id": "memo_x" } })).is_err());
        assert!(prune_shared_snapshots(&database, &json!({})).is_err());
    }
}
