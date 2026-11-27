use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::catalog::is_inbox_notebook;
use crate::memo::{create_memo, memo_value};
use crate::{bool_param, enqueue_change, memo_remap_base_key, meta_value, set_meta, string_param};

pub(crate) fn sync_status(database: &Connection) -> Result<Value, String> {
    let count = |status: &str| -> Result<i64, String> {
        database
            .query_row(
                "SELECT COUNT(*) FROM _edgeever_sidecar_outbox WHERE status = ?1",
                [status],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    };
    Ok(json!({
        "pending": count("pending")?, "syncing": count("syncing")?, "conflict": count("conflict")?, "error": count("error")?,
        "cursor": meta_value(database, "sync.cursor").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
        "syncIdentity": meta_value(database, "sync.identity"), "lastSyncedAt": meta_value(database, "sync.last_synced_at")
    }))
}

pub(crate) const SYNC_BOOTSTRAP_RESET_KEY: &str = "sync.bootstrap.reset_pending";

fn reset_sync_mirror(database: &Connection) -> Result<(), String> {
    let tx = database
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS _edgeever_bootstrap_preserved_memos (id TEXT PRIMARY KEY);
         CREATE TEMP TABLE IF NOT EXISTS _edgeever_bootstrap_preserved_notebooks (id TEXT PRIMARY KEY);
         DELETE FROM _edgeever_bootstrap_preserved_memos;
         DELETE FROM _edgeever_bootstrap_preserved_notebooks;
         INSERT OR IGNORE INTO _edgeever_bootstrap_preserved_memos (id)
         SELECT m.id FROM memos m
         WHERE EXISTS (
           SELECT 1 FROM _edgeever_sidecar_outbox o
           WHERE o.entity_id = m.id OR instr(o.payload_json, m.id) > 0
         );
         INSERT OR IGNORE INTO _edgeever_bootstrap_preserved_notebooks (id)
         SELECT n.id FROM notebooks n
         WHERE EXISTS (
           SELECT 1 FROM _edgeever_sidecar_outbox o
           WHERE o.entity_id = n.id OR instr(o.payload_json, n.id) > 0
         );
         INSERT OR IGNORE INTO _edgeever_bootstrap_preserved_notebooks (id)
         SELECT DISTINCT m.notebook_id
         FROM memos m
         INNER JOIN _edgeever_bootstrap_preserved_memos p ON p.id = m.id;
         WITH RECURSIVE preserved_ancestors(id, parent_id) AS (
           SELECT n.id, n.parent_id
           FROM notebooks n
           INNER JOIN _edgeever_bootstrap_preserved_notebooks p ON p.id = n.id
           UNION
           SELECT parent.id, parent.parent_id
           FROM notebooks parent
           INNER JOIN preserved_ancestors child ON child.parent_id = parent.id
         )
         INSERT OR IGNORE INTO _edgeever_bootstrap_preserved_notebooks (id)
         SELECT id FROM preserved_ancestors;
         DELETE FROM resources
         WHERE memo_id NOT IN (SELECT id FROM _edgeever_bootstrap_preserved_memos);
         DELETE FROM memos
         WHERE id NOT IN (SELECT id FROM _edgeever_bootstrap_preserved_memos);
         UPDATE notebooks SET parent_id = NULL
         WHERE id NOT IN (SELECT id FROM _edgeever_bootstrap_preserved_notebooks);
         DELETE FROM notebooks
         WHERE id NOT IN (SELECT id FROM _edgeever_bootstrap_preserved_notebooks);
         DELETE FROM _edgeever_sidecar_meta
         WHERE key IN ('sync.cursor', 'sync.identity', 'sync.last_synced_at')
            OR key LIKE 'memo.remap-base:%' OR key LIKE 'memo.status-ack:%';
         INSERT INTO _edgeever_sidecar_meta (key, value, updated_at)
         VALUES ('sync.bootstrap.reset_pending', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;",
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn prepare_sync_bootstrap(
    database: &Connection,
    params: &Value,
) -> Result<Value, String> {
    let reset_requested = bool_param(params, "reset", false)
        || meta_value(database, SYNC_BOOTSTRAP_RESET_KEY).as_deref() == Some("1");
    if reset_requested {
        reset_sync_mirror(database)?;
        return Ok(json!({ "clearedSeedData": false, "rebuiltMirror": true }));
    }

    if meta_value(database, "sync.identity").is_some_and(|identity| !identity.is_empty()) {
        return Ok(json!({ "clearedSeedData": false, "rebuiltMirror": false }));
    }

    let outbox_count = database
        .query_row("SELECT COUNT(*) FROM _edgeever_sidecar_outbox", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?;
    let non_seed_memos = database
        .query_row(
            "SELECT COUNT(*) FROM memos WHERE id <> 'memo_welcome'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    let non_seed_notebooks = database
        .query_row(
            "SELECT COUNT(*) FROM notebooks
             WHERE id NOT IN ('nb_inbox', 'nb_projects', 'nb_learning', 'nb_creative', 'nb_personal')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;

    if outbox_count > 0 || non_seed_memos > 0 || non_seed_notebooks > 0 {
        return Ok(json!({ "clearedSeedData": false, "rebuiltMirror": false }));
    }

    let tx = database
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memos WHERE id = 'memo_welcome'", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM notebooks
         WHERE id IN ('nb_inbox', 'nb_projects', 'nb_learning', 'nb_creative', 'nb_personal')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "clearedSeedData": true, "rebuiltMirror": false }))
}

pub(crate) fn sync_outbox_list(database: &Connection, params: &Value) -> Result<Value, String> {
    let limit = params
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 200);
    let include_conflicts = bool_param(params, "includeConflicts", false);
    let sql = if include_conflicts {
        "SELECT id, kind, entity_id, payload_json, attempt_count, status, last_error, version, last_error_code, retryable, next_attempt_at, created_at, updated_at FROM _edgeever_sidecar_outbox WHERE status IN ('pending', 'error', 'conflict') ORDER BY id LIMIT ?1"
    } else {
        // A dependent batch must wait for the note's own create to reach the
        // server: the server would ack the delete for an id it never saw and
        // the later create retry would resurrect the note, while a move or pin
        // carrying the temporary id is rejected as `missing_memos`. Waiting
        // lets the create acknowledgement remap the batch payload first.
        "SELECT o.id, o.kind, o.entity_id, o.payload_json, o.attempt_count, o.status, o.last_error, o.version, o.last_error_code, o.retryable, o.next_attempt_at, o.created_at, o.updated_at
         FROM _edgeever_sidecar_outbox o
         WHERE (o.status = 'pending' OR (o.status = 'error' AND o.retryable = 1 AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
           AND NOT (
             o.kind IN ('memo.delete', 'memo.restore', 'memo.deleteBatch', 'memo.emptyTrash', 'memo.move', 'memo.pinBatch', 'memo.setTheme', 'memo.status')
             AND EXISTS (
               SELECT 1 FROM _edgeever_sidecar_outbox c
               WHERE c.kind = 'memo.create'
                 AND (c.entity_id = o.entity_id OR instr(o.payload_json, c.entity_id) > 0)
             )
           )
         ORDER BY o.id LIMIT ?1"
    };
    let mut statement = database.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map([limit], |row| {
        let payload: String = row.get(3)?;
        Ok(json!({ "id": row.get::<_, i64>(0)?, "kind": row.get::<_, String>(1)?, "entityId": row.get::<_, String>(2)?, "payload": serde_json::from_str::<Value>(&payload).unwrap_or_else(|_| json!({})), "attemptCount": row.get::<_, i64>(4)?, "status": row.get::<_, String>(5)?, "lastError": row.get::<_, Option<String>>(6)?, "version": row.get::<_, i64>(7)?, "lastErrorCode": row.get::<_, Option<String>>(8)?, "retryable": row.get::<_, bool>(9)?, "nextAttemptAt": row.get::<_, Option<String>>(10)?, "createdAt": row.get::<_, String>(11)?, "updatedAt": row.get::<_, String>(12)? }))
    }).map_err(|e| e.to_string())?;
    let items: Result<Vec<_>, _> = rows.collect();
    Ok(json!({ "items": items.map_err(|e| e.to_string())? }))
}

pub(crate) fn sync_outbox_claim(database: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    // Claiming marks the item as in flight so a concurrent local delete keeps
    // the note's create untouched until its acknowledgement remaps the delete.
    let eligible = "(status = 'pending' OR (status = 'error' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))))";
    let updated = if let Some(version) = params.get("version").and_then(Value::as_i64) {
        database.execute(
            &format!("UPDATE _edgeever_sidecar_outbox SET status = 'syncing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND version = ?2 AND {eligible}"),
            rusqlite::params![id, version],
        )
    } else {
        database.execute(
            &format!("UPDATE _edgeever_sidecar_outbox SET status = 'syncing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND {eligible}"),
            [id],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "claimed": updated == 1 }))
}

/// Rewrites every string value that exactly matches `from`. Batch payloads
/// (`memoIds` arrays for move/pin/merge/delete) must follow a create or merge
/// acknowledgement too, otherwise they keep referring to a dead temporary id
/// and the server rejects them forever with `missing_memos`.
fn replace_exact_string(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(text) => {
            if text == from {
                *text = to.to_owned();
            }
        }
        Value::Array(items) => {
            for item in items {
                replace_exact_string(item, from, to);
            }
        }
        Value::Object(entries) => {
            for entry in entries.values_mut() {
                replace_exact_string(entry, from, to);
            }
        }
        _ => {}
    }
}

fn memo_ack_snapshot(database: &Connection, remote: Option<Value>) -> Option<Value> {
    remote.map(|mut memo| {
        if let Some(id) = memo.get("id").and_then(Value::as_str) {
            if let Ok(local) = memo_value(database, id, true) {
                // Keep the acknowledged cloud content base, but expose the
                // protected status to renderer acknowledgement listeners.
                memo["status"] = local.get("status").cloned().unwrap_or(Value::Null);
            }
        }
        memo
    })
}

pub(crate) fn sync_outbox_ack(database: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    let (kind, entity_id, current_version): (String, String, i64) = database
        .query_row(
            "SELECT kind, entity_id, version FROM _edgeever_sidecar_outbox WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let requested_version = params.get("version").and_then(Value::as_i64);
    let superseded = requested_version.is_some_and(|version| version != current_version);
    let remote_memo = params.get("remoteMemo").cloned();
    let remote_notebook = params.get("remoteNotebook").cloned();
    let remote_template = params.get("remoteTemplate").cloned();
    let temporary_memo_base = if kind == "memo.create" {
        memo_value(database, &entity_id, true).ok().map(|memo| {
            (
                memo.get("revision").and_then(Value::as_i64).unwrap_or(0),
                memo.get("contentHash")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            )
        })
    } else {
        None
    };

    if kind == "memo.update" && superseded {
        if let Some(remote) = remote_memo.as_ref() {
            let remote_revision = remote.get("revision").and_then(Value::as_i64).unwrap_or(0);
            let remote_hash = remote
                .get("contentHash")
                .and_then(Value::as_str)
                .unwrap_or("");
            let payload_text: String = database
                .query_row(
                    "SELECT payload_json FROM _edgeever_sidecar_outbox WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let mut payload: Value =
                serde_json::from_str(&payload_text).unwrap_or_else(|_| json!({}));
            payload["expectedRevision"] = json!(remote_revision);
            payload["expectedContentHash"] = json!(remote_hash);
            let tx = database
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
            // Preserve the successor draft's content while advancing only its
            // acknowledged cloud base. The next flush will send that draft on
            // top of the response that just succeeded.
            tx.execute(
                "UPDATE memo_contents SET revision = ?1 WHERE memo_id = ?2",
                rusqlite::params![remote_revision, entity_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE _edgeever_sidecar_outbox
                 SET payload_json = ?1, status = 'pending', last_error = NULL,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id = ?2",
                rusqlite::params![payload.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        return Ok(json!({
            "ok": true,
            "superseded": true,
            "memo": memo_ack_snapshot(database, remote_memo),
            "notebook": remote_notebook,
            "template": remote_template
        }));
    }

    if let Some(remote) = remote_memo.as_ref() {
        let remote_id = string_param(remote, "id")?;
        let mut apply_params = json!({
            "changes": [{
                "entityType": "memo",
                "operation": "upsert",
                "entityId": remote_id,
                "memo": remote,
                "notebook": null
            }],
            "ignoreOutboxId": id
        });
        if kind == "memo.create" || kind == "memo.merge" {
            if let Some(object) = apply_params.as_object_mut() {
                object.insert("placeholderEntityId".to_owned(), json!(entity_id));
            }
        }
        // A coalesced successor has the same id but a newer version. Its
        // status is still pending and must participate in the override.
        if kind == "memo.status" && superseded {
            apply_params
                .as_object_mut()
                .unwrap()
                .remove("ignoreOutboxId");
        }
        apply_sync_changes(database, &apply_params)?;
        if kind == "memo.status" && !superseded {
            let previous_id = memo_status_ack(database, &remote_id)
                .and_then(|ack| ack.get("outboxId").and_then(Value::as_i64))
                .unwrap_or(0);
            if id >= previous_id {
                set_meta(
                    database,
                    &memo_status_ack_key(&remote_id),
                    &json!({
                        "outboxId": id,
                        "status": remote.get("status").cloned().unwrap_or(Value::Null),
                        "updatedAt": remote.get("updatedAt").cloned().unwrap_or(Value::Null)
                    })
                    .to_string(),
                )?;
            }
        }
    }
    if kind == "memo.create" || kind == "memo.merge" {
        if let Some(remote) = remote_memo.as_ref() {
            let remote_id = string_param(remote, "id")?;
            let remote_exists: bool = database
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM memos WHERE id = ?1)",
                    [&remote_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if remote_exists {
                // The acknowledgement caches the remote memo before reconciling
                // the local placeholder, so the remote id exists here.
                // A merged local memo can still own resources moved from its
                // sources. Deleting it directly is rejected by the resources
                // foreign key and leaves both the local placeholder and remote
                // memo visible forever. Repoint every surviving relationship
                // before removing the placeholder, and keep the reconciliation
                // atomic so a crash cannot strand a partially remapped merge.
                let tx = database
                    .unchecked_transaction()
                    .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE resources SET memo_id = ?1 WHERE memo_id = ?2",
                    rusqlite::params![remote_id, entity_id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE resources SET original_memo_id = ?1 WHERE original_memo_id = ?2",
                    rusqlite::params![remote_id, entity_id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE memos SET merged_into_memo_id = ?1 WHERE merged_into_memo_id = ?2",
                    rusqlite::params![remote_id, entity_id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM memos WHERE id = ?1", [&entity_id])
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            } else {
                database
                    .execute(
                        "UPDATE memos SET id = ?1 WHERE id = ?2",
                        rusqlite::params![remote_id, entity_id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            let mut pending = database.prepare("SELECT id, entity_id, payload_json FROM _edgeever_sidecar_outbox WHERE id <> ?1").map_err(|e| e.to_string())?;
            let rows: Vec<(i64, String, String)> = pending
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            for (outbox_id, outbox_entity, payload_text) in rows {
                if outbox_entity != entity_id && !payload_text.contains(&entity_id) {
                    continue;
                }
                let mut payload: Value =
                    serde_json::from_str(&payload_text).unwrap_or_else(|_| json!({}));
                replace_exact_string(&mut payload, &entity_id, &remote_id);
                if payload.get("memoId").and_then(Value::as_str) == Some(remote_id.as_str()) {
                    if let Some(revision) = remote.get("revision") {
                        payload["expectedRevision"] = revision.clone();
                    }
                    if let Some(hash) = remote.get("contentHash") {
                        payload["expectedContentHash"] = hash.clone();
                    }
                }
                let next_entity = if outbox_entity == entity_id {
                    remote_id.clone()
                } else {
                    outbox_entity
                };
                database.execute("UPDATE _edgeever_sidecar_outbox SET entity_id = ?1, payload_json = ?2, version = version + 1 WHERE id = ?3", rusqlite::params![next_entity, payload.to_string(), outbox_id]).map_err(|e| e.to_string())?;
            }
            if kind == "memo.create" {
                if let Some((temporary_revision, temporary_content_hash)) =
                    temporary_memo_base.as_ref()
                {
                    set_meta(
                        database,
                        &memo_remap_base_key(&remote_id),
                        &json!({
                            "temporaryRevision": temporary_revision,
                            "temporaryContentHash": temporary_content_hash,
                            "remoteRevision": remote.get("revision").and_then(Value::as_i64).unwrap_or(0),
                            "remoteContentHash": remote.get("contentHash").and_then(Value::as_str).unwrap_or("")
                        })
                        .to_string(),
                    )?;
                }
            }
        }
    }
    if kind == "notebook.create" {
        if let Some(remote) = remote_notebook.as_ref() {
            let remote_id = string_param(remote, "id")?;
            let remote_exists: bool = database
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
                    [&remote_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if remote_exists {
                database
                    .execute("DELETE FROM notebooks WHERE id = ?1", [&entity_id])
                    .map_err(|e| e.to_string())?;
            } else {
                database
                    .execute(
                        "UPDATE notebooks SET id = ?1 WHERE id = ?2",
                        rusqlite::params![remote_id, entity_id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            let mut pending = database.prepare("SELECT id, entity_id, payload_json FROM _edgeever_sidecar_outbox WHERE id <> ?1").map_err(|e| e.to_string())?;
            let rows: Vec<(i64, String, String)> = pending
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            for (outbox_id, outbox_entity, payload_text) in rows {
                if outbox_entity != entity_id && !payload_text.contains(&entity_id) {
                    continue;
                }
                let mut payload: Value =
                    serde_json::from_str(&payload_text).unwrap_or_else(|_| json!({}));
                if payload.get("notebookId").and_then(Value::as_str) == Some(entity_id.as_str()) {
                    payload["notebookId"] = json!(remote_id);
                }
                if payload.get("temporaryId").and_then(Value::as_str) == Some(entity_id.as_str()) {
                    payload["temporaryId"] = json!(remote_id);
                }
                let next_entity = if outbox_entity == entity_id {
                    remote_id.clone()
                } else {
                    outbox_entity
                };
                database.execute("UPDATE _edgeever_sidecar_outbox SET entity_id = ?1, payload_json = ?2, version = version + 1 WHERE id = ?3", rusqlite::params![next_entity, payload.to_string(), outbox_id]).map_err(|e| e.to_string())?;
            }
        }
    }
    if kind == "template.create" {
        if let Some(remote) = remote_template.as_ref() {
            let remote_id = string_param(remote, "id")?;
            let remote_exists: bool = database
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM memo_templates WHERE id = ?1)",
                    [&remote_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if remote_exists {
                database
                    .execute("DELETE FROM memo_templates WHERE id = ?1", [&entity_id])
                    .map_err(|e| e.to_string())?;
            } else {
                database
                    .execute(
                        "UPDATE memo_templates SET id = ?1 WHERE id = ?2",
                        rusqlite::params![remote_id, entity_id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            let mut pending = database.prepare("SELECT id, entity_id, payload_json FROM _edgeever_sidecar_outbox WHERE id <> ?1").map_err(|e| e.to_string())?;
            let rows: Vec<(i64, String, String)> = pending
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            for (outbox_id, outbox_entity, payload_text) in rows {
                if outbox_entity != entity_id && !payload_text.contains(&entity_id) {
                    continue;
                }
                let mut payload: Value =
                    serde_json::from_str(&payload_text).unwrap_or_else(|_| json!({}));
                if payload.get("templateId").and_then(Value::as_str) == Some(entity_id.as_str()) {
                    payload["templateId"] = json!(remote_id);
                }
                if payload.get("temporaryId").and_then(Value::as_str) == Some(entity_id.as_str()) {
                    payload["temporaryId"] = json!(remote_id);
                }
                let next_entity = if outbox_entity == entity_id {
                    remote_id.clone()
                } else {
                    outbox_entity
                };
                database.execute("UPDATE _edgeever_sidecar_outbox SET entity_id = ?1, payload_json = ?2, version = version + 1 WHERE id = ?3", rusqlite::params![next_entity, payload.to_string(), outbox_id]).map_err(|e| e.to_string())?;
            }
        }
    }
    let deleted = if let Some(version) = requested_version {
        database
            .execute(
                "DELETE FROM _edgeever_sidecar_outbox WHERE id = ?1 AND version = ?2",
                rusqlite::params![id, version],
            )
            .map_err(|e| e.to_string())?
    } else {
        database
            .execute("DELETE FROM _edgeever_sidecar_outbox WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?
    };
    Ok(
        json!({ "ok": true, "superseded": deleted == 0, "memo": memo_ack_snapshot(database, remote_memo), "notebook": remote_notebook, "template": remote_template }),
    )
}

pub(crate) fn sync_outbox_fail(database: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    let error = params
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("sync failed");
    let status = if bool_param(params, "conflict", false) {
        "conflict"
    } else {
        "error"
    };
    let error_code = params.get("errorCode").and_then(Value::as_str);
    let retryable = params
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let next_attempt_at = params.get("nextAttemptAt").and_then(Value::as_str);
    let updated = if let Some(version) = params.get("version").and_then(Value::as_i64) {
        database.execute("UPDATE _edgeever_sidecar_outbox SET status = ?1, attempt_count = attempt_count + 1, last_error = ?2, last_error_code = ?3, retryable = ?4, next_attempt_at = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6 AND version = ?7", rusqlite::params![status, error, error_code, retryable, next_attempt_at, id, version]).map_err(|e| e.to_string())?
    } else {
        database.execute("UPDATE _edgeever_sidecar_outbox SET status = ?1, attempt_count = attempt_count + 1, last_error = ?2, last_error_code = ?3, retryable = ?4, next_attempt_at = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?6", rusqlite::params![status, error, error_code, retryable, next_attempt_at, id]).map_err(|e| e.to_string())?
    };
    Ok(json!({ "ok": true, "superseded": updated == 0 }))
}

pub(crate) fn sync_outbox_retry(database: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    let version = params.get("version").and_then(Value::as_i64);
    let updated = if let Some(version) = version {
        database.execute(
            "UPDATE _edgeever_sidecar_outbox SET status = 'pending', retryable = 1, next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND version = ?2 AND status = 'error'",
            rusqlite::params![id, version],
        )
    } else {
        database.execute(
            "UPDATE _edgeever_sidecar_outbox SET status = 'pending', retryable = 1, next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND status = 'error'",
            [id],
        )
    }
    .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err("The failed sync item changed before retry".to_owned());
    }
    Ok(json!({ "ok": true }))
}

pub(crate) fn sync_outbox_recover_memo_update(
    database: &Connection,
    params: &Value,
) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    let notebook_id = string_param(params, "notebookId")?;
    let requested_version = params.get("version").and_then(Value::as_i64);
    let (kind, payload_text, version, status): (String, String, i64, String) = database
        .query_row(
            "SELECT kind, payload_json, version, status FROM _edgeever_sidecar_outbox WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    if kind != "memo.update" || status != "error" {
        return Err("Only failed memo updates can be recovered".to_owned());
    }
    if requested_version.is_some_and(|value| value != version) {
        return Err("The failed update changed before recovery".to_owned());
    }
    let notebook_exists: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1 AND is_deleted = 0)",
            [&notebook_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !notebook_exists {
        return Err("Recovery notebook not found".to_owned());
    }
    let mut payload: Value = serde_json::from_str(&payload_text).map_err(|e| e.to_string())?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "Invalid failed memo payload".to_owned())?;
    object.insert("notebookId".to_owned(), json!(notebook_id));
    let memo = create_memo(database, &payload)?;
    let recovered_id = string_param(&memo, "id")?;
    payload["memoId"] = json!(recovered_id);
    payload["expectedRevision"] = json!(0);
    payload["expectedContentHash"] = memo
        .get("contentHash")
        .cloned()
        .unwrap_or_else(|| json!(""));
    enqueue_change(database, "memo.update", &recovered_id, &payload)?;
    let removed = database
        .execute(
            "DELETE FROM _edgeever_sidecar_outbox WHERE id = ?1 AND version = ?2 AND status = 'error'",
            rusqlite::params![id, version],
        )
        .map_err(|e| e.to_string())?;
    if removed == 0 {
        database
            .execute(
                "DELETE FROM _edgeever_sidecar_outbox WHERE entity_id = ?1",
                [&recovered_id],
            )
            .ok();
        database
            .execute("DELETE FROM memos WHERE id = ?1", [&recovered_id])
            .ok();
        return Err("The failed update changed before recovery".to_owned());
    }
    Ok(json!({ "ok": true, "memo": memo }))
}

pub(crate) fn sync_outbox_discard(database: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Missing outbox id".to_owned())?;
    let removed = if let Some(version) = params.get("version").and_then(Value::as_i64) {
        database.execute(
            "DELETE FROM _edgeever_sidecar_outbox WHERE id = ?1 AND version = ?2",
            rusqlite::params![id, version],
        )
    } else {
        database.execute("DELETE FROM _edgeever_sidecar_outbox WHERE id = ?1", [id])
    }
    .map_err(|e| e.to_string())?;
    if removed == 0 {
        return Err("The sync item changed before it was discarded".to_owned());
    }
    Ok(json!({ "ok": true }))
}

fn order_sync_change_indices(changes: &[Value]) -> Vec<usize> {
    let mut notebook_upserts = Vec::new();
    let mut notebook_deletes = Vec::new();
    let mut rest = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        let entity_type = change
            .get("entityType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let operation = change
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("");
        if entity_type == "notebook" {
            if operation == "delete" {
                notebook_deletes.push(index);
            } else {
                notebook_upserts.push(index);
            }
        } else {
            rest.push(index);
        }
    }

    let mut remaining: std::collections::HashSet<usize> =
        notebook_upserts.iter().copied().collect();
    let mut ordered_upserts = Vec::new();
    while !remaining.is_empty() {
        let ready: Vec<usize> = notebook_upserts
            .iter()
            .copied()
            .filter(|index| remaining.contains(index))
            .filter(|index| {
                let parent_id = changes[*index]
                    .get("notebook")
                    .and_then(|notebook| notebook.get("parentId"))
                    .and_then(Value::as_str);
                match parent_id {
                    Some(parent_id) => !notebook_upserts.iter().copied().any(|candidate| {
                        remaining.contains(&candidate)
                            && changes[candidate].get("entityId").and_then(Value::as_str)
                                == Some(parent_id)
                    }),
                    None => true,
                }
            })
            .collect();
        if ready.is_empty() {
            ordered_upserts.extend(
                notebook_upserts
                    .iter()
                    .copied()
                    .filter(|index| remaining.contains(index)),
            );
            break;
        }
        for index in ready {
            remaining.remove(&index);
            ordered_upserts.push(index);
        }
    }

    ordered_upserts
        .into_iter()
        .chain(notebook_deletes)
        .chain(rest)
        .collect()
}

fn ensure_active_inbox(tx: &Transaction<'_>) -> Result<String, String> {
    if let Some(id) = tx
        .query_row(
            "SELECT id FROM notebooks
             WHERE is_deleted = 0
               AND (slug = 'inbox' OR id = 'nb_inbox' OR id GLOB '*_inbox')
             ORDER BY CASE WHEN slug = 'inbox' THEN 0 WHEN id = 'nb_inbox' THEN 1 ELSE 2 END, id
             LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }

    if let Some(id) = tx
        .query_row(
            "SELECT id FROM notebooks
             WHERE slug = 'inbox' OR id = 'nb_inbox' OR id GLOB '*_inbox'
             ORDER BY CASE WHEN id = 'nb_inbox' THEN 0 WHEN id GLOB '*_inbox' THEN 1 ELSE 2 END, id
             LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        tx.execute(
            "UPDATE notebooks
             SET is_deleted = 0, deleted_at = NULL, slug = 'inbox', parent_id = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(id);
    }

    tx.execute(
        "INSERT INTO notebooks (id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
         VALUES ('nb_inbox', NULL, '等待分类', 'inbox', 'notebook', '#0f766e', 10,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok("nb_inbox".to_owned())
}

fn resolve_sync_notebook_id(
    tx: &Transaction<'_>,
    requested_notebook_id: &str,
) -> Result<String, String> {
    let active = tx
        .query_row(
            "SELECT id FROM notebooks WHERE id = ?1 AND is_deleted = 0",
            [requested_notebook_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = active {
        return Ok(id);
    }
    ensure_active_inbox(tx)
}

fn active_inbox_exists_except(tx: &Transaction<'_>, notebook_id: &str) -> Result<bool, String> {
    tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM notebooks
           WHERE is_deleted = 0
             AND id <> ?1
             AND (slug = 'inbox' OR id = 'nb_inbox' OR id GLOB '*_inbox')
         )",
        [notebook_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn notebook_is_active(tx: &Transaction<'_>, notebook_id: &str) -> Result<bool, String> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1 AND is_deleted = 0)",
        [notebook_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// A locally queued theme change must win over a stale server snapshot until its
/// own acknowledgement lands; otherwise a remote upsert arriving between the
/// change and its flush would visibly revert the note's theme. The
/// acknowledgement passes the outbox id so the authoritative snapshot applies.
fn pending_memo_theme_override(
    tx: &Transaction<'_>,
    ignore_outbox_id: Option<i64>,
    entity_id: &str,
    placeholder_entity_id: Option<&str>,
) -> Result<Option<Option<String>>, String> {
    let mut statement = tx
        .prepare(
            "SELECT payload_json FROM _edgeever_sidecar_outbox
             WHERE kind = 'memo.setTheme'
               AND (?1 IS NULL OR id <> ?1)
               AND (entity_id = ?2 OR instr(payload_json, ?2) > 0
                    OR (?3 IS NOT NULL AND (entity_id = ?3 OR instr(payload_json, ?3) > 0)))
             ORDER BY id DESC
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let payload: Option<String> = statement
        .query_row(
            rusqlite::params![ignore_outbox_id, entity_id, placeholder_entity_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let theme = serde_json::from_str::<Value>(&payload)
        .ok()
        .and_then(|value| value.get("theme").cloned())
        .and_then(|value| value.as_str().map(str::to_owned));
    Ok(Some(theme))
}

fn memo_status_ack_key(memo_id: &str) -> String {
    format!("memo.status-ack:{memo_id}")
}

fn memo_status_ack(database: &Connection, memo_id: &str) -> Option<Value> {
    meta_value(database, &memo_status_ack_key(memo_id))
        .and_then(|value| serde_json::from_str(&value).ok())
}

/// The outer option distinguishes no pending override from an explicit clear.
/// Intent order follows outbox ids, not wall time (several edits may share a
/// millisecond). An ack fence also protects against older responses arriving
/// after the newer status row has already left the outbox.
fn pending_memo_status_override(
    tx: &Transaction<'_>,
    ignore_outbox_id: Option<i64>,
    entity_id: &str,
    placeholder_entity_id: Option<&str>,
    memo: &Value,
) -> Result<Option<Option<String>>, String> {
    let acknowledged = memo_status_ack(tx, entity_id);
    let acknowledged_id = acknowledged
        .as_ref()
        .and_then(|ack| ack.get("outboxId"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let status_ack_id = if let Some(id) = ignore_outbox_id {
        tx.query_row(
            "SELECT id FROM _edgeever_sidecar_outbox WHERE id = ?1 AND kind = 'memo.status'",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0)
    } else {
        0
    };
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM _edgeever_sidecar_outbox
         WHERE kind = 'memo.status' AND id > ?1
           AND (entity_id = ?2 OR (?3 IS NOT NULL AND entity_id = ?3))
         ORDER BY id DESC LIMIT 1",
            rusqlite::params![
                acknowledged_id.max(status_ack_id),
                entity_id,
                placeholder_entity_id
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(payload) = payload {
        let payload: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        return Ok(Some(
            payload
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ));
    }
    if let Some(ack) = acknowledged {
        let older_ack = ignore_outbox_id.is_some_and(|id| id < acknowledged_id);
        let older_snapshot = memo.get("updatedAt").and_then(Value::as_str).unwrap_or("")
            < ack.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        if older_ack || (status_ack_id == 0 && older_snapshot) {
            return Ok(Some(
                ack.get("status").and_then(Value::as_str).map(str::to_owned),
            ));
        }
    }
    Ok(None)
}

fn record_memo_status_snapshot(
    tx: &Transaction<'_>,
    entity_id: &str,
    memo: &Value,
    ignore_outbox_id: Option<i64>,
) -> Result<(), String> {
    let previous = memo_status_ack(tx, entity_id);
    let outbox_id = previous
        .as_ref()
        .and_then(|value| value.get("outboxId"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let updated_at = memo.get("updatedAt").and_then(Value::as_str).unwrap_or("");
    let previous_updated_at = previous
        .as_ref()
        .and_then(|value| value.get("updatedAt"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !ignore_outbox_id.is_some_and(|id| id < outbox_id) && updated_at >= previous_updated_at {
        // Remote freshness is separate from local updated_at, which can move
        // forward for unrelated offline content/theme edits or clock skew.
        set_meta(
            tx,
            &memo_status_ack_key(entity_id),
            &json!({
                "outboxId": outbox_id,
                "status": memo.get("status").cloned().unwrap_or(Value::Null),
                "updatedAt": updated_at,
            })
            .to_string(),
        )?;
    }
    Ok(())
}

fn apply_one_sync_change(
    tx: &Transaction<'_>,
    change: &Value,
    rebuilding: bool,
    ignore_outbox_id: Option<i64>,
    placeholder_entity_id: Option<&str>,
) -> Result<(), String> {
    let entity_type = string_param(change, "entityType")?;
    let operation = string_param(change, "operation")?;
    let entity_id = string_param(change, "entityId")?;
    if rebuilding {
        let preserved_table = if entity_type == "notebook" {
            "_edgeever_bootstrap_preserved_notebooks"
        } else {
            "_edgeever_bootstrap_preserved_memos"
        };
        let preserved = tx
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {preserved_table} WHERE id = ?1)"),
                [&entity_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if preserved {
            return Ok(());
        }
    }
    if entity_type == "notebook" {
        if operation == "delete" {
            if active_inbox_exists_except(tx, &entity_id)? {
                tx.execute(
                    "UPDATE notebooks
                     SET is_deleted = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = ?1",
                    [&entity_id],
                )
                .map_err(|e| e.to_string())?;
            } else {
                tx.execute("UPDATE notebooks SET is_deleted = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND slug <> 'inbox' AND id <> 'nb_inbox' AND id NOT GLOB '*_inbox'", [&entity_id]).map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        let notebook = change
            .get("notebook")
            .ok_or_else(|| "Missing notebook change payload".to_owned())?;
        let requested_slug = notebook.get("slug").and_then(Value::as_str);
        let inbox = is_inbox_notebook(&entity_id, requested_slug);
        let requested_parent = notebook
            .get("parentId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && !inbox);
        let parent_id = if let Some(parent_id) = requested_parent {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notebooks WHERE id = ?1)",
                    [parent_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            exists.then_some(parent_id)
        } else {
            None
        };
        let slug = if inbox { Some("inbox") } else { requested_slug };
        let keep_inactive = inbox
            && active_inbox_exists_except(tx, &entity_id)?
            && !notebook_is_active(tx, &entity_id)?;
        let is_deleted = i64::from(keep_inactive);
        tx.execute("INSERT INTO notebooks (id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at, is_deleted, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?10 = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name, slug=excluded.slug, icon=excluded.icon, color=excluded.color, sort_order=excluded.sort_order, updated_at=excluded.updated_at, is_deleted=excluded.is_deleted, deleted_at=excluded.deleted_at", rusqlite::params![entity_id, parent_id, string_param(notebook, "name")?, slug, notebook.get("icon").and_then(Value::as_str), notebook.get("color").and_then(Value::as_str), notebook.get("sortOrder").and_then(Value::as_i64).unwrap_or(0), string_param(notebook, "createdAt")?, string_param(notebook, "updatedAt")?, is_deleted]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if operation == "delete" {
        tx.execute("UPDATE memos SET is_deleted = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1", [&entity_id]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let memo = change
        .get("memo")
        .ok_or_else(|| "Missing memo change payload".to_owned())?;
    if !rebuilding {
        // A queued local intent must win over a stale server snapshot: a
        // pending delete/update keeps the local row (and its unsynced edit),
        // and a pending restore keeps it alive. Server-side deletions still
        // apply so a remote delete is never masked.
        let pending_kinds: Vec<String> = {
            let mut kinds = Vec::new();
            let mut statement = tx
                .prepare(
                    "SELECT kind FROM _edgeever_sidecar_outbox
                     WHERE kind IN ('memo.delete', 'memo.update', 'memo.restore', 'memo.deleteBatch', 'memo.emptyTrash')
                       AND (?1 IS NULL OR id <> ?1)
                       AND (entity_id = ?2 OR instr(payload_json, ?2) > 0)",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(rusqlite::params![ignore_outbox_id, entity_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            kinds.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            );
            if let Some(placeholder_id) = placeholder_entity_id {
                // A create acknowledgement renames the local placeholder; a
                // pending delete for that placeholder must keep the note
                // deleted instead of letting the synchronous remote snapshot
                // resurrect it before the delete reaches the server.
                let mut placeholder_statement = tx
                    .prepare(
                        "SELECT kind FROM _edgeever_sidecar_outbox
                         WHERE kind IN ('memo.delete', 'memo.deleteBatch', 'memo.emptyTrash')
                           AND (?1 IS NULL OR id <> ?1)
                           AND (entity_id = ?2 OR instr(payload_json, ?2) > 0)",
                    )
                    .map_err(|e| e.to_string())?;
                let placeholder_rows = placeholder_statement
                    .query_map(rusqlite::params![ignore_outbox_id, placeholder_id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|e| e.to_string())?;
                kinds.extend(
                    placeholder_rows
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?,
                );
            }
            kinds
        };
        if !pending_kinds.is_empty() {
            let restores_local = pending_kinds.iter().any(|kind| kind == "memo.restore");
            let incoming_deleted = memo
                .get("isDeleted")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if restores_local || !incoming_deleted {
                return Ok(());
            }
        }
    }
    let tags = memo
        .get("tags")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let theme = if rebuilding {
        memo.get("theme").and_then(Value::as_str).map(str::to_owned)
    } else {
        pending_memo_theme_override(tx, ignore_outbox_id, &entity_id, placeholder_entity_id)?
            .unwrap_or_else(|| memo.get("theme").and_then(Value::as_str).map(str::to_owned))
    };
    let status = if rebuilding {
        memo.get("status")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        pending_memo_status_override(
            tx,
            ignore_outbox_id,
            &entity_id,
            placeholder_entity_id,
            memo,
        )?
        .unwrap_or_else(|| {
            memo.get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
    };
    let source_memo_ids = memo
        .get("sourceMemoIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_ids = Value::Array(source_memo_ids.clone()).to_string();
    let requested_merge_target = memo.get("mergedIntoMemoId").and_then(Value::as_str);
    // Bootstrap pages are ordered by memo id, not by merge dependency. A
    // deleted source can therefore arrive before the merged memo it
    // references. Cache the source without the unresolved foreign key;
    // the target's sourceMemoIds backfills it when that page arrives.
    let merge_target = if let Some(target_id) = requested_merge_target {
        let target_exists = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memos WHERE id = ?1)",
                [target_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?;
        target_exists.then_some(target_id)
    } else {
        None
    };
    let content_json = memo
        .get("contentJson")
        .cloned()
        .unwrap_or_else(|| json!({"type":"doc","content":[]}));
    let requested_notebook_id = string_param(memo, "notebookId")?;
    let notebook_id = resolve_sync_notebook_id(tx, &requested_notebook_id)?;
    tx.execute("INSERT INTO memos (id, notebook_id, title, excerpt, tags_json, is_pinned, theme, is_archived, is_deleted, source_memo_ids, merge_source_count, merged_into_memo_id, created_at, updated_at, deleted_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, title=excluded.title, excerpt=excluded.excerpt, tags_json=excluded.tags_json, is_pinned=excluded.is_pinned, theme=excluded.theme, is_archived=excluded.is_archived, is_deleted=excluded.is_deleted, source_memo_ids=excluded.source_memo_ids, merge_source_count=excluded.merge_source_count, merged_into_memo_id=excluded.merged_into_memo_id, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, status=excluded.status", rusqlite::params![entity_id, notebook_id, memo.get("title").and_then(Value::as_str), string_param(memo, "excerpt")?, tags, memo.get("isPinned").and_then(Value::as_bool).unwrap_or(false) as i64, theme, memo.get("isArchived").and_then(Value::as_bool).unwrap_or(false) as i64, memo.get("isDeleted").and_then(Value::as_bool).unwrap_or(false) as i64, source_ids, memo.get("mergeSourceCount").and_then(Value::as_i64).unwrap_or(0), merge_target, string_param(memo, "createdAt")?, string_param(memo, "updatedAt")?, memo.get("deletedAt").and_then(Value::as_str), status]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(memo_id) DO UPDATE SET content_json=excluded.content_json, content_markdown=excluded.content_markdown, content_text=excluded.content_text, content_hash=excluded.content_hash, revision=excluded.revision, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", rusqlite::params![entity_id, content_json.to_string(), string_param(memo, "contentMarkdown")?, string_param(memo, "contentText")?, string_param(memo, "contentHash")?, memo.get("revision").and_then(Value::as_i64).unwrap_or(0)]).map_err(|e| e.to_string())?;
    for source_id in source_memo_ids.iter().filter_map(Value::as_str) {
        tx.execute(
            "UPDATE memos SET merged_into_memo_id = ?1 WHERE id = ?2",
            rusqlite::params![entity_id, source_id],
        )
        .map_err(|e| e.to_string())?;
    }
    record_memo_status_snapshot(tx, &entity_id, memo, ignore_outbox_id)?;
    Ok(())
}

pub(crate) fn apply_sync_changes(database: &Connection, params: &Value) -> Result<Value, String> {
    let changes = params
        .get("changes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing changes array".to_owned())?;
    let rebuilding = meta_value(database, SYNC_BOOTSTRAP_RESET_KEY).as_deref() == Some("1");
    let ignore_outbox_id = params.get("ignoreOutboxId").and_then(Value::as_i64);
    let placeholder_entity_id = params.get("placeholderEntityId").and_then(Value::as_str);
    let ordered = order_sync_change_indices(changes);
    let tx = database
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    for index in ordered {
        apply_one_sync_change(
            &tx,
            &changes[index],
            rebuilding,
            ignore_outbox_id,
            placeholder_entity_id,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "applied": changes.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{ensure_sidecar_schema, open_database};
    use crate::memo::{delete_memo, list_memos, set_memo_status, update_memo};
    use std::{fs, path::PathBuf};

    fn migrations_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../migrations")
    }

    fn test_database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        ensure_sidecar_schema(&database).unwrap();
        let mut paths: Vec<_> = fs::read_dir(migrations_path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("sql"))
            .collect();
        paths.sort();
        for path in paths {
            database
                .execute_batch(&fs::read_to_string(path).unwrap())
                .unwrap();
        }
        database
    }

    fn remote_memo(id: &str, status: Value, updated_at: &str) -> Value {
        json!({
            "id": id, "notebookId": "nb_inbox", "title": "Remote note",
            "excerpt": "body", "tags": [], "isPinned": false, "isArchived": false,
            "isDeleted": false, "revision": 0, "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": updated_at, "deletedAt": null, "contentJson": crate::markdown_doc("body"),
            "contentMarkdown": "body", "contentText": "body", "contentHash": "hash",
            "sourceMemoIds": [], "mergeSourceCount": 0, "mergedIntoMemoId": null, "status": status
        })
    }

    fn apply_remote(database: &Connection, memo: Value) {
        apply_sync_changes(
            database,
            &json!({ "changes": [{
            "entityType": "memo", "operation": "upsert", "entityId": memo["id"], "memo": memo
        }] }),
        )
        .unwrap();
    }

    fn status_items(database: &Connection, memo_id: &str) -> Vec<Value> {
        sync_outbox_list(database, &json!({ "includeConflicts": true, "limit": 200 })).unwrap()
            ["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == "memo.status" && item["entityId"] == memo_id)
            .cloned()
            .collect()
    }

    fn set_status(database: &Connection, memo_id: &str, status: Value) -> Value {
        set_memo_status(database, &json!({ "memoId": memo_id, "status": status })).unwrap()
    }

    fn ack_status(database: &Connection, item: &Value, status: Value, updated_at: &str) -> Value {
        sync_outbox_ack(
            database,
            &json!({
                "id": item["id"], "version": item["version"],
                "remoteMemo": remote_memo(item["entityId"].as_str().unwrap(), status, updated_at)
            }),
        )
        .unwrap()
    }

    #[test]
    fn memo_status_defaults_to_null_and_missing_update_is_a_noop() {
        let mut database = test_database();
        let memo = create_memo(
            &database,
            &json!({ "notebookId": "nb_inbox", "contentMarkdown": "body" }),
        )
        .unwrap();
        let id = memo["id"].as_str().unwrap();
        assert_eq!(memo["status"], Value::Null);
        set_status(&database, id, json!("completed"));
        let before = status_items(&database, id);
        assert_eq!(
            set_memo_status(&database, &json!({ "memoId": id })).unwrap()["status"],
            "completed"
        );
        assert_eq!(status_items(&database, id), before);
        for invalid in [json!("unknown"), json!(false), json!(1)] {
            assert!(
                set_memo_status(&database, &json!({ "memoId": id, "status": invalid })).is_err()
            );
        }
        let request = serde_json::from_value(json!({ "id": 1, "method": "memo.setStatus", "params": { "memoId": id, "status": null } })).unwrap();
        let result = crate::rpc::handle(
            request,
            &mut database,
            &std::env::temp_dir(),
            &migrations_path(),
        )
        .unwrap();
        assert_eq!(result["memo"]["status"], Value::Null);
        let listed = list_memos(&database, &json!({})).unwrap();
        let summary = listed["memos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|memo| memo["id"] == id)
            .unwrap();
        assert_eq!(summary.get("status"), Some(&Value::Null));
        assert_eq!(
            memo_value(&database, id, false).unwrap()["contentMarkdown"],
            "body"
        );
    }

    #[test]
    fn memo_status_coalesces_multiple_edits_and_keeps_explicit_clear() {
        let database = test_database();
        let id = "memo_status_edits";
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-01T00:00:00.000Z"),
        );
        for status in [
            json!("in_progress"),
            json!("completed"),
            json!("cancelled"),
            Value::Null,
        ] {
            set_status(&database, id, status.clone());
            apply_remote(
                &database,
                remote_memo(id, json!("in_progress"), "2026-01-02T00:00:00.000Z"),
            );
            assert_eq!(memo_value(&database, id, false).unwrap()["status"], status);
        }
        let items = status_items(&database, id);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["version"], 4);
        assert_eq!(items[0]["payload"].get("status"), Some(&Value::Null));
        let listed = list_memos(&database, &json!({})).unwrap();
        assert_eq!(
            listed["memos"]
                .as_array()
                .unwrap()
                .iter()
                .find(|memo| memo["id"] == id)
                .unwrap()["status"],
            Value::Null
        );
    }

    #[test]
    fn memo_status_old_ack_preserves_a_coalesced_successor_version() {
        let database = test_database();
        let id = "memo_status_version";
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-01T00:00:00.000Z"),
        );
        set_status(&database, id, json!("completed"));
        let old = status_items(&database, id)[0].clone();
        set_status(&database, id, Value::Null);
        assert_eq!(
            ack_status(
                &database,
                &old,
                json!("completed"),
                "2026-01-02T00:00:00.000Z"
            )["superseded"],
            true
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        let items = status_items(&database, id);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["version"], 2);
        assert_eq!(items[0]["status"], "pending");
        ack_status(
            &database,
            &items[0],
            Value::Null,
            "2026-01-03T00:00:00.000Z",
        );
        assert!(status_items(&database, id).is_empty());
        apply_remote(
            &database,
            remote_memo(id, json!("completed"), "2026-01-02T00:00:00.000Z"),
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
    }

    #[test]
    fn memo_status_inflight_ack_preserves_newer_pending_clear_and_response() {
        let database = test_database();
        let id = "memo_status_inflight";
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-01T00:00:00.000Z"),
        );
        set_status(&database, id, json!("completed"));
        let old = status_items(&database, id)[0].clone();
        sync_outbox_claim(&database, &old).unwrap();
        set_status(&database, id, Value::Null);
        let response = ack_status(
            &database,
            &old,
            json!("completed"),
            "2026-01-02T00:00:00.000Z",
        );
        assert_eq!(response["memo"]["status"], Value::Null);
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        let items = status_items(&database, id);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["payload"].get("status"), Some(&Value::Null));
        ack_status(
            &database,
            &items[0],
            Value::Null,
            "2026-01-03T00:00:00.000Z",
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
    }

    #[test]
    fn memo_status_remote_snapshots_are_monotonic_and_legacy_omission_is_null() {
        let database = test_database();
        let id = "memo_status_remote_clock";
        apply_remote(
            &database,
            remote_memo(id, json!("completed"), "2026-01-02T00:00:00.000Z"),
        );
        let mut legacy = remote_memo(id, Value::Null, "2026-01-03T00:00:00.000Z");
        legacy.as_object_mut().unwrap().remove("status");
        apply_remote(&database, legacy);
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        apply_remote(
            &database,
            remote_memo(id, json!("completed"), "2026-01-02T00:00:00.000Z"),
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        apply_remote(
            &database,
            remote_memo(id, json!("cancelled"), "2026-01-04T00:00:00.000Z"),
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            "cancelled"
        );
    }

    #[test]
    fn memo_status_inflight_older_ack_cannot_revert_a_newer_ack() {
        let database = test_database();
        let id = "memo_status_ack_order";
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-01T00:00:00.000Z"),
        );
        set_status(&database, id, json!("in_progress"));
        let old = status_items(&database, id)[0].clone();
        assert_eq!(sync_outbox_claim(&database, &old).unwrap()["claimed"], true);
        set_status(&database, id, json!("completed"));
        set_status(&database, id, Value::Null);
        let successor = status_items(&database, id)[0].clone();
        assert_ne!(old["id"], successor["id"]);
        ack_status(
            &database,
            &successor,
            Value::Null,
            "2026-01-03T00:00:00.000Z",
        );
        // A failed older request must not be reused for a new edit behind the
        // acknowledged fence; that edit needs a fresh intent id.
        sync_outbox_fail(&database, &json!({ "id": old["id"], "version": old["version"], "error": "offline" })).unwrap();
        set_status(&database, id, Value::Null);
        let latest = status_items(&database, id).last().unwrap().clone();
        assert!(latest["id"].as_i64().unwrap() > successor["id"].as_i64().unwrap());
        // Out-of-order delivery must not let the still-queued older intent win.
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-03T00:00:00.000Z"),
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        ack_status(
            &database,
            &old,
            json!("in_progress"),
            "2026-01-02T00:00:00.000Z",
        );
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            Value::Null
        );
        ack_status(&database, &latest, Value::Null, "2026-01-04T00:00:00.000Z");
        assert!(status_items(&database, id).is_empty());
    }

    #[test]
    fn memo_status_remaps_pending_clear_when_create_is_acknowledged() {
        let database = test_database();
        let local = create_memo(
            &database,
            &json!({ "notebookId": "nb_inbox", "contentMarkdown": "body" }),
        )
        .unwrap();
        let id = local["id"].as_str().unwrap();
        set_status(&database, id, json!("completed"));
        set_status(&database, id, Value::Null);
        let ready = sync_outbox_list(&database, &json!({ "limit": 200 })).unwrap();
        assert!(!ready["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "memo.status"));
        let create = ready["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == "memo.create")
            .unwrap();
        let remote_id = "memo_status_remapped";
        sync_outbox_ack(&database, &json!({ "id": create["id"], "version": create["version"], "remoteMemo": remote_memo(remote_id, json!("in_progress"), "2026-01-02T00:00:00.000Z") })).unwrap();
        assert_eq!(
            memo_value(&database, remote_id, false).unwrap()["status"],
            Value::Null
        );
        assert!(memo_value(&database, id, true).is_err());
        let item = &status_items(&database, remote_id)[0];
        assert_eq!(item["payload"]["memoId"], remote_id);
        assert_eq!(item["payload"].get("status"), Some(&Value::Null));
        assert!(sync_outbox_list(&database, &json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "memo.status"));
    }

    #[test]
    fn memo_status_content_ack_keeps_newer_status_and_unsent_delete_cancels_it() {
        let database = test_database();
        let id = "memo_status_content_ack";
        apply_remote(
            &database,
            remote_memo(id, Value::Null, "2026-01-01T00:00:00.000Z"),
        );
        update_memo(
            &database,
            &json!({ "memoId": id, "title": "Edit", "contentMarkdown": "edit", "tags": [] }),
        )
        .unwrap();
        let update = sync_outbox_list(&database, &json!({})).unwrap()["items"][0].clone();
        set_status(&database, id, json!("cancelled"));
        sync_outbox_ack(&database, &json!({ "id": update["id"], "version": update["version"], "remoteMemo": remote_memo(id, Value::Null, "2026-01-02T00:00:00.000Z") })).unwrap();
        assert_eq!(
            memo_value(&database, id, false).unwrap()["status"],
            "cancelled"
        );
        let local = create_memo(&database, &json!({ "notebookId": "nb_inbox" })).unwrap();
        let local_id = local["id"].as_str().unwrap();
        set_status(&database, local_id, json!("completed"));
        delete_memo(&database, &json!({ "memoId": local_id })).unwrap();
        assert!(status_items(&database, local_id).is_empty());
    }

    #[test]
    fn memo_status_upgrades_a_real_legacy_database_without_changing_existing_notes() {
        let temporary = std::env::temp_dir().join(crate::now_id("edgeever-status-upgrade"));
        let legacy_migrations = temporary.join("legacy-migrations");
        let data = temporary.join("data");
        fs::create_dir_all(&legacy_migrations).unwrap();
        for entry in fs::read_dir(migrations_path()).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_str().unwrap();
            if name.ends_with(".sql") && name < "0074" {
                fs::copy(&path, legacy_migrations.join(name)).unwrap();
            }
        }
        let old = open_database(&data, &legacy_migrations).unwrap();
        let has_status: bool = old
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('memos') WHERE name = 'status')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!has_status);
        old.execute("INSERT INTO memos (id, notebook_id, title, excerpt) VALUES ('memo_legacy_status', 'nb_inbox', 'Legacy note', 'body')", []).unwrap();
        old.execute("INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash) VALUES ('memo_legacy_status', '{\"type\":\"doc\",\"content\":[]}', 'legacy body', 'legacy body', 'legacy_hash')", []).unwrap();
        crate::enqueue_change(
            &old,
            "memo.update",
            "memo_legacy_status",
            &json!({ "memoId": "memo_legacy_status", "title": "Legacy queued" }),
        )
        .unwrap();
        drop(old);
        let upgraded = open_database(&data, &migrations_path()).unwrap();
        let memo = memo_value(&upgraded, "memo_legacy_status", false).unwrap();
        assert_eq!(memo.get("status"), Some(&Value::Null));
        assert_eq!(memo["title"], "Legacy note");
        assert_eq!(memo["contentMarkdown"], "legacy body");
        assert_eq!(
            sync_outbox_list(&upgraded, &json!({})).unwrap()["items"][0]["payload"]["title"],
            "Legacy queued"
        );
        let column: (i64, Option<String>) = upgraded.query_row(
            "SELECT \"notnull\", dflt_value FROM pragma_table_info('memos') WHERE name = 'status'", [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(column.0, 0);
        assert!(column.1.is_none() || column.1.as_deref() == Some("NULL"));
        set_status(&upgraded, "memo_legacy_status", json!("completed"));
        drop(upgraded);
        let reopened = open_database(&data, &migrations_path()).unwrap();
        assert_eq!(
            memo_value(&reopened, "memo_legacy_status", false).unwrap()["status"],
            "completed"
        );
        assert_eq!(status_items(&reopened, "memo_legacy_status").len(), 1);
        drop(reopened);
        fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn replaces_remapped_memo_ids_in_nested_batch_payloads() {
        let mut payload = json!({
            "memoIds": ["memo_local_1", "memo_keep"],
            "memoId": "memo_local_1",
            "temporaryId": "memo_local_1",
            "note": "memo_local_10 and memo_local_1 stay inline",
            "nested": { "memoIds": ["memo_local_1"] }
        });

        replace_exact_string(&mut payload, "memo_local_1", "memo_remote_1");

        assert_eq!(payload["memoIds"], json!(["memo_remote_1", "memo_keep"]));
        assert_eq!(payload["memoId"], json!("memo_remote_1"));
        assert_eq!(payload["temporaryId"], json!("memo_remote_1"));
        assert_eq!(
            payload["note"],
            json!("memo_local_10 and memo_local_1 stay inline")
        );
        assert_eq!(payload["nested"]["memoIds"], json!(["memo_remote_1"]));
    }
}
